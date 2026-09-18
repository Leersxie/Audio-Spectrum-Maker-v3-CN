/**
 * ⑤ WebAssembly FFT アダプタモジュール
 * Wasm+SIMD 版FFTの動的ロードと、FastFFT 互換APIの提供を行います。
 * Wasm/SIMD 非対応ブラウザでは Pure JS 版 (fft.js) へ自動フォールバックします。
 */

import { DEFAULT_FFT_SIZE, FFT_MIN_DECIBELS, FFT_MAX_DECIBELS } from './constants.js';
import { FastFFT } from './fft.js';

/**
 * Wasm SIMD の実行サポートを検出します
 * @returns {boolean} SIMD対応の場合 true
 */
function detectWasmSimdSupport() {
  try {
    // Wasmの基本サポート確認
    if (typeof WebAssembly !== 'object') {
      return false;
    }
    // SIMD命令を含む最小Wasmバイナリのバリデーション
    // (v128.const 命令を含むモジュール)
    const simdTestBytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, // マジックナンバー
      0x01, 0x00, 0x00, 0x00, // バージョン
      0x01, 0x05, 0x01,       // typeセクション
      0x60, 0x00, 0x01, 0x7b, // func () -> v128
      0x03, 0x02, 0x01, 0x00, // functionセクション
      0x0a, 0x0a, 0x01,       // codeセクション
      0x08, 0x00,             // body size, locals
      0xfd, 0x0c,             // v128.const
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x0b                    // end
    ]);
    return WebAssembly.validate(simdTestBytes);
  } catch (e) {
    return false;
  }
}

/**
 * Wasm FFT ラッパークラス (FastFFT 互換API)
 */
class WasmFFT {
  constructor(wasmModule, size) {
    this.module = wasmModule;
    this.size = size;

    // Wasm関数のバインド
    this._init = wasmModule.cwrap('fft_init', null, ['number']);
    this._realTransform = wasmModule.cwrap('fft_real_transform', null, []);
    this._getByteFreqData = wasmModule.cwrap('fft_get_byte_frequency_data', null, ['number', 'number']);
    this._getInputPtr = wasmModule.cwrap('fft_get_input_ptr', 'number', []);
    this._getRealOutPtr = wasmModule.cwrap('fft_get_real_out_ptr', 'number', []);
    this._getImagOutPtr = wasmModule.cwrap('fft_get_imag_out_ptr', 'number', []);
    this._getByteOutPtr = wasmModule.cwrap('fft_get_byte_out_ptr', 'number', []);

    // FFTエンジン初期化
    this._init(size);

    // ゼロコピー用バッファビューの作成
    const heap = wasmModule.HEAPF32.buffer;
    const heapU8 = wasmModule.HEAPU8;
    const halfSize = size / 2;

    this._inputPtr = this._getInputPtr();
    this._realOutPtr = this._getRealOutPtr();
    this._imagOutPtr = this._getImagOutPtr();
    this._byteOutPtr = this._getByteOutPtr();

    this.inputView = new Float32Array(heap, this._inputPtr, size);
    this.realOutView = new Float32Array(heap, this._realOutPtr, size);
    this.imagOutView = new Float32Array(heap, this._imagOutPtr, size);
    this.byteOutView = new Uint8Array(heap, this._byteOutPtr, halfSize);
  }

  /**
   * 実数専用FFT (FastFFT互換API)
   * @param {Float32Array} realInput - 実数入力信号
   * @param {Float32Array} realOut - 実部出力バッファ
   * @param {Float32Array} imagOut - 虚部出力バッファ
   */
  realTransform(realInput, realOut, imagOut) {
    // 入力データをWasmメモリにコピー
    this.inputView.set(realInput);
    // Wasm側でFFT実行
    this._realTransform();
    // 結果をJS側バッファにコピー
    realOut.set(this.realOutView);
    imagOut.set(this.imagOutView);
  }

  /**
   * デシベル変換 + バイト量子化 (FastFFT互換API)
   * @param {Float32Array} real - FFT実部
   * @param {Float32Array} imag - FFT虚部
   * @param {Uint8Array} byteOut - 出力バッファ
   * @param {number} outOffset - 出力オフセット
   * @param {number} minDecibels - 最小デシベル
   * @param {number} maxDecibels - 最大デシベル
   */
  getByteFrequencyData(
    real,
    imag,
    byteOut,
    outOffset = 0,
    minDecibels = FFT_MIN_DECIBELS,
    maxDecibels = FFT_MAX_DECIBELS
  ) {
    // 入力をWasmメモリにコピー (直前の realTransform の結果がまだ残っている場合はスキップ可能)
    this.realOutView.set(real);
    this.imagOutView.set(imag);
    // Wasm側でデシベル変換
    this._getByteFreqData(minDecibels, maxDecibels);
    // 結果をJS側バッファにコピー
    const halfSize = this.size / 2;
    for (let i = 0; i < halfSize; i++) {
      byteOut[outOffset + i] = this.byteOutView[i];
    }
  }

  /**
   * ゼロコピー版: 入力バッファに直接書き込み → 変換 → 結果をゼロコピーで出力
   * Worker内の高速パイプライン用
   * @param {Uint8Array} byteOut - 出力バッファ
   * @param {number} outOffset - 出力オフセット
   * @param {number} minDecibels - 最小デシベル
   * @param {number} maxDecibels - 最大デシベル
   */
  zeroCopyTransformAndQuantize(byteOut, outOffset, minDecibels, maxDecibels) {
    this._realTransform();
    this._getByteFreqData(minDecibels, maxDecibels);
    const halfSize = this.size / 2;
    for (let i = 0; i < halfSize; i++) {
      byteOut[outOffset + i] = this.byteOutView[i];
    }
  }
}

/**
 * 最適なFFTエンジンを生成します (Wasm優先、フォールバック付き)
 * @param {number} size - FFTサイズ
 * @returns {Promise<FastFFT | WasmFFT>} FFTエンジンインスタンス
 */
export async function createOptimalFFT(size = DEFAULT_FFT_SIZE) {
  // Wasm+SIMD サポートチェック
  if (!detectWasmSimdSupport()) {
    console.warn('[WasmFFTAdapter] SIMD非対応: Pure JS (FastFFT) を使用します');
    return new FastFFT(size);
  }

  try {
    // Wasmモジュールの動的ロード
    const wasmUrl = new URL('./wasm/fftSIMD.js', import.meta.url);
    const wasmModule = await import(wasmUrl.href);
    const createModule = wasmModule.default || wasmModule.createFFTModule;

    if (typeof createModule !== 'function') {
      throw new Error('Wasmモジュールのエクスポートが不正です');
    }

    const instance = await createModule();
    const wasmFft = new WasmFFT(instance, size);
    console.info('[WasmFFTAdapter] Wasm+SIMD エンジンのロードに成功しました');
    return wasmFft;
  } catch (err) {
    console.warn(
      '[WasmFFTAdapter] Wasm ロード失敗: Pure JS (FastFFT) へフォールバックします:',
      err.message
    );
    return new FastFFT(size);
  }
}
