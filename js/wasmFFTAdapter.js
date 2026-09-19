/**
 * ⑤ WebAssembly FFT 适配器模块
 * 提供 Wasm+SIMD 版 FFT 的动态加载，以及与 FastFFT 兼容的 API。
 * 在不支持 Wasm/SIMD 的浏览器中，将自动回退到 Pure JS 版 (fft.js)。
 */

import { DEFAULT_FFT_SIZE, FFT_MIN_DECIBELS, FFT_MAX_DECIBELS } from './constants.js';
import { FastFFT } from './fft.js';

/**
 * 检测 Wasm SIMD 的执行支持情况
 * @returns {boolean} 支持 SIMD 时返回 true
 */
function detectWasmSimdSupport() {
  try {
    // 确认 Wasm 的基本支持
    if (typeof WebAssembly !== 'object') {
      return false;
    }
    // 包含 SIMD 指令的最小 Wasm 二进制校验
    // (包含 v128.const 指令的模块)
    const simdTestBytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, // 魔法数字
      0x01, 0x00, 0x00, 0x00, // 版本
      0x01, 0x05, 0x01,       // type 段
      0x60, 0x00, 0x01, 0x7b, // func () -> v128
      0x03, 0x02, 0x01, 0x00, // function 段
      0x0a, 0x0a, 0x01,       // code 段
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
 * Wasm FFT 包装类 (FastFFT 兼容API)
 */
class WasmFFT {
  constructor(wasmModule, size) {
    this.module = wasmModule;
    this.size = size;

    // 绑定 Wasm 函数
    this._init = wasmModule.cwrap('fft_init', null, ['number']);
    this._realTransform = wasmModule.cwrap('fft_real_transform', null, []);
    this._getByteFreqData = wasmModule.cwrap('fft_get_byte_frequency_data', null, ['number', 'number']);
    this._getInputPtr = wasmModule.cwrap('fft_get_input_ptr', 'number', []);
    this._getRealOutPtr = wasmModule.cwrap('fft_get_real_out_ptr', 'number', []);
    this._getImagOutPtr = wasmModule.cwrap('fft_get_imag_out_ptr', 'number', []);
    this._getByteOutPtr = wasmModule.cwrap('fft_get_byte_out_ptr', 'number', []);

    // 初始化 FFT 引擎
    this._init(size);

    // 创建用于零拷贝的缓冲区视图
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
   * 实数专用 FFT (FastFFT 兼容API)
   * @param {Float32Array} realInput - 实数输入信号
   * @param {Float32Array} realOut - 实部输出缓冲区
   * @param {Float32Array} imagOut - 虚部输出缓冲区
   */
  realTransform(realInput, realOut, imagOut) {
    // 将输入数据复制到 Wasm 内存
    this.inputView.set(realInput);
    // 在 Wasm 侧执行 FFT
    this._realTransform();
    // 将结果复制到 JS 侧缓冲区
    realOut.set(this.realOutView);
    imagOut.set(this.imagOutView);
  }

  /**
   * 分贝转换 + 字节量化 (FastFFT 兼容API)
   * @param {Float32Array} real - FFT 实部
   * @param {Float32Array} imag - FFT 虚部
   * @param {Uint8Array} byteOut - 输出缓冲区
   * @param {number} outOffset - 输出偏移
   * @param {number} minDecibels - 最小分贝
   * @param {number} maxDecibels - 最大分贝
   */
  getByteFrequencyData(
    real,
    imag,
    byteOut,
    outOffset = 0,
    minDecibels = FFT_MIN_DECIBELS,
    maxDecibels = FFT_MAX_DECIBELS
  ) {
    // 将输入复制到 Wasm 内存 (如果上一次 realTransform 的结果仍然存在，则可能跳过)
    this.realOutView.set(real);
    this.imagOutView.set(imag);
    // 在 Wasm 侧进行分贝转换
    this._getByteFreqData(minDecibels, maxDecibels);
    // 将结果复制到 JS 侧缓冲区
    const halfSize = this.size / 2;
    for (let i = 0; i < halfSize; i++) {
      byteOut[outOffset + i] = this.byteOutView[i];
    }
  }

  /**
   * 零拷贝版: 直接写入输入缓冲区 → 转换 → 以零拷贝输出结果
   * 用于 Worker 内的高速流水线
   * @param {Uint8Array} byteOut - 输出缓冲区
   * @param {number} outOffset - 输出偏移
   * @param {number} minDecibels - 最小分贝
   * @param {number} maxDecibels - 最大分贝
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
 * 生成最优 FFT 引擎 (优先 Wasm，含回退机制)
 * @param {number} size - FFT 大小
 * @returns {Promise<FastFFT | WasmFFT>} FFT 引擎实例
 */
export async function createOptimalFFT(size = DEFAULT_FFT_SIZE) {
  // 检查 Wasm+SIMD 支持
  if (!detectWasmSimdSupport()) {
    console.warn('[WasmFFTAdapter] SIMD非対応: Pure JS (FastFFT) を使用します');
    return new FastFFT(size);
  }

  try {
    // 动态加载 Wasm 模块
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
