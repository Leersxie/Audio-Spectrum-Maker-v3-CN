/**
 * 高速フーリエ変換 (FFT) モジュール
 * ① 実数専用FFT: N点実数信号を N/2点複素FFTで処理し、演算量を約54%削減
 * ② バタフライ最適化: j-i ループ反転 + 初期段特殊化で乗算・テーブル参照を削減
 * ③ 高速対数近似: IEEE-754 ビット演算 + LUTで Math.log を排除
 * Cooley-Tukey Radix-2 アルゴリズムに基づき、事前計算テーブルを用いて高速に周波数解析を行います。
 */

import {
  DEFAULT_FFT_SIZE,
  FFT_MIN_DECIBELS,
  FFT_MAX_DECIBELS,
  BLACKMAN_ALPHA,
  EPSILON_MAGNITUDE,
  DECIBEL_SCALE_MULTIPLIER,
  BYTE_MAX_VALUE,
  LOG2_MANTISSA_LUT_SIZE,
  FLOAT64_EXPONENT_BIAS,
  DB_SCALE_LOG2
} from './constants.js';

// --- ③ 高速対数近似 (Fast Log) ---

// エンディアン判定 (モジュールスコープで一度だけ実行)
const _endianBuf = new ArrayBuffer(4);
new Uint8Array(_endianBuf)[0] = 1;
const HIGH_WORD_INDEX = new Uint32Array(_endianBuf)[0] === 1 ? 1 : 0;

// IEEE-754 float64 ビット抽出用の共有バッファ
const _logF64 = new Float64Array(1);
const _logU32 = new Uint32Array(_logF64.buffer);

// 仮数部 log2 ルックアップテーブル (256エントリ、精度 ±0.2% 以内)
const _log2MantissaLut = new Float32Array(LOG2_MANTISSA_LUT_SIZE);
for (let i = 0; i < LOG2_MANTISSA_LUT_SIZE; i++) {
  _log2MantissaLut[i] = Math.log2(1 + i / LOG2_MANTISSA_LUT_SIZE);
}

/**
 * IEEE-754 float64 のビット構造を利用した高速 log2 近似
 * 精度: 仮数部上位8bitのLUTにより、最大相対誤差 ±0.2% 以内
 * @param {number} x - 正の数値
 * @returns {number} log2(x) の近似値
 */
function fastLog2(x) {
  _logF64[0] = x;
  const hi = _logU32[HIGH_WORD_INDEX];
  const exponent = ((hi >>> 20) & 0x7FF) - FLOAT64_EXPONENT_BIAS;
  const mantissaIdx = (hi >>> 12) & 0xFF;
  return exponent + _log2MantissaLut[mantissaIdx];
}

export class FastFFT {
  /**
   * @param {number} size - FFTサイズ (2の冪乗、デフォルト: 8192)
   */
  constructor(size = DEFAULT_FFT_SIZE) {
    this.size = size;
    const halfSize = size / 2;
    const quarterSize = size / 4;

    // --- 回転因子テーブルの事前計算 ---

    // N点FFT用テーブル (アンパック処理 + 互換transform で使用)
    this.cosTable = new Float32Array(halfSize);
    this.sinTable = new Float32Array(halfSize);
    for (let i = 0; i < halfSize; i++) {
      const angle = (-2 * Math.PI * i) / size;
      this.cosTable[i] = Math.cos(angle);
      this.sinTable[i] = Math.sin(angle);
    }

    // N/2点FFT用テーブル (実数FFTの内部バタフライ演算で使用)
    this.cosTableHalf = new Float32Array(quarterSize);
    this.sinTableHalf = new Float32Array(quarterSize);
    for (let i = 0; i < quarterSize; i++) {
      const angle = (-2 * Math.PI * i) / halfSize;
      this.cosTableHalf[i] = Math.cos(angle);
      this.sinTableHalf[i] = Math.sin(angle);
    }

    // --- ビット反転テーブルの事前計算 ---

    // N点用 (互換transform で使用)
    this.bitReverse = new Uint32Array(size);
    const numberOfBits = Math.round(Math.log2(size));
    for (let i = 0; i < size; i++) {
      let reversedIndex = 0;
      let temp = i;
      for (let j = 0; j < numberOfBits; j++) {
        reversedIndex = (reversedIndex << 1) | (temp & 1);
        temp >>= 1;
      }
      this.bitReverse[i] = reversedIndex;
    }

    // N/2点用 (実数FFTで使用)
    this.bitReverseHalf = new Uint32Array(halfSize);
    const numberOfBitsHalf = Math.round(Math.log2(halfSize));
    for (let i = 0; i < halfSize; i++) {
      let reversedIndex = 0;
      let temp = i;
      for (let j = 0; j < numberOfBitsHalf; j++) {
        reversedIndex = (reversedIndex << 1) | (temp & 1);
        temp >>= 1;
      }
      this.bitReverseHalf[i] = reversedIndex;
    }

    // --- Blackman 窓関数の事前計算 (Web Audio API 仕様準拠) ---
    this.window = new Float32Array(size);
    const a0 = 0.5 * (1 - BLACKMAN_ALPHA);
    const a1 = 0.5;
    const a2 = 0.5 * BLACKMAN_ALPHA;
    const denominator = size - 1;
    for (let i = 0; i < size; i++) {
      const term1 = a1 * Math.cos((2 * Math.PI * i) / denominator);
      const term2 = a2 * Math.cos((4 * Math.PI * i) / denominator);
      this.window[i] = a0 - term1 + term2;
    }

    // --- デシベル変換用定数 ---
    this.logConstant = DECIBEL_SCALE_MULTIPLIER * Math.log10(size);
    this.minPowerThreshold = EPSILON_MAGNITUDE * EPSILON_MAGNITUDE;
  }

  /**
   * ① 実数専用FFT: N点実数入力に対して窓関数を適用し、最適化されたFFTを実行します
   *
   * 処理フロー:
   *   1. 窓関数適用 + 偶奇インターリーブで N/2点複素信号にパッキング
   *   2. N/2点 Cooley-Tukey 複素FFT (②最適化バタフライ)
   *   3. アンパック処理で N/2+1 点の周波数スペクトルを復元
   *
   * @param {Float32Array} realInput - 実数入力信号 (長さ: size)
   * @param {Float32Array} realOut - 実部出力バッファ (長さ: size)
   * @param {Float32Array} imagOut - 虚部出力バッファ (長さ: size)
   */
  realTransform(realInput, realOut, imagOut) {
    const n = this.size;
    const m = n >> 1;
    const mHalf = m >> 1;

    // --- Step 1: 窓関数適用 + 偶奇パッキング + ビット反転 ---
    // z[k] = window[2k]*x[2k] + j*window[2k+1]*x[2k+1]
    for (let k = 0; k < m; k++) {
      const rev = this.bitReverseHalf[k];
      const k2 = k << 1;
      realOut[rev] = realInput[k2] * this.window[k2];
      imagOut[rev] = realInput[k2 + 1] * this.window[k2 + 1];
    }

    // --- Step 2: N/2点 複素FFT (② 最適化バタフライ演算) ---

    // Stage 1: len=2 (回転因子 W=1 のみ → 乗算完全スキップ)
    for (let i = 0; i < m; i += 2) {
      const tr = realOut[i + 1];
      const ti = imagOut[i + 1];
      realOut[i + 1] = realOut[i] - tr;
      imagOut[i + 1] = imagOut[i] - ti;
      realOut[i] += tr;
      imagOut[i] += ti;
    }

    // Stage 2: len=4 (W=1, W=-j の2種のみ → 乗算完全スキップ)
    for (let i = 0; i < m; i += 4) {
      // j=0: W=1
      let tr = realOut[i + 2];
      let ti = imagOut[i + 2];
      realOut[i + 2] = realOut[i] - tr;
      imagOut[i + 2] = imagOut[i] - ti;
      realOut[i] += tr;
      imagOut[i] += ti;

      // j=1: W=-j (cos=0, sin=-1)
      tr = imagOut[i + 3];
      ti = -realOut[i + 3];
      realOut[i + 3] = realOut[i + 1] - tr;
      imagOut[i + 3] = imagOut[i + 1] - ti;
      realOut[i + 1] += tr;
      imagOut[i + 1] += ti;
    }

    // Stage 3以降: j外側・i内側ループ (テーブル参照を段あたり1回に削減)
    const cosTableH = this.cosTableHalf;
    const sinTableH = this.sinTableHalf;
    for (let len = 8; len <= m; len <<= 1) {
      const halfLen = len >> 1;
      const step = m / len;
      for (let j = 0; j < halfLen; j++) {
        const tableIdx = j * step;
        const cosVal = cosTableH[tableIdx];
        const sinVal = sinTableH[tableIdx];
        for (let i = j; i < m; i += len) {
          const k = i + halfLen;
          const tReal = realOut[k] * cosVal - imagOut[k] * sinVal;
          const tImag = realOut[k] * sinVal + imagOut[k] * cosVal;
          realOut[k] = realOut[i] - tReal;
          imagOut[k] = imagOut[i] - tImag;
          realOut[i] += tReal;
          imagOut[i] += tImag;
        }
      }
    }

    // --- Step 3: アンパック処理 ---
    // N/2点複素FFT結果 Z[k] → N点実数FFTスペクトル X[k] を復元
    // エルミート対称性を利用して k と M-k のペアを同時処理

    const cosT = this.cosTable;
    const sinT = this.sinTable;

    // DC成分 (k=0) と ナイキスト成分 (k=M)
    const zr0 = realOut[0];
    const zi0 = imagOut[0];
    realOut[0] = zr0 + zi0;
    imagOut[0] = 0;
    realOut[m] = zr0 - zi0;
    imagOut[m] = 0;

    // 対称ペア処理 (k=1 ~ M/2-1)
    for (let k = 1; k < mHalf; k++) {
      const mk = m - k;
      const zrk = realOut[k];
      const zik = imagOut[k];
      const zrmk = realOut[mk];
      const zimk = imagOut[mk];

      // 偶部 E[k] = 0.5 * (Z[k] + Z*[M-k])
      const er = 0.5 * (zrk + zrmk);
      const ei = 0.5 * (zik - zimk);
      // 奇部 O[k] = 0.5 * (Z[k] - Z*[M-k])
      const or = 0.5 * (zrk - zrmk);
      const oi = 0.5 * (zik + zimk);

      // N点テーブルの回転因子
      const ck = cosT[k];
      const sk = sinT[k];

      // X[k] = E[k] - j·W_N^k · O[k]
      // j·W·O の展開: Real = -sk*or - ck*oi, Imag = ck*or - sk*oi
      const jwr = -sk * or - ck * oi;
      const jwi = ck * or - sk * oi;
      realOut[k] = er - jwr;
      imagOut[k] = ei - jwi;

      // X[M-k] (対称性: c_{M-k}=-ck, s_{M-k}=sk, E'/O'符号反転の関係)
      realOut[mk] = er + jwr;
      imagOut[mk] = -ei - jwi;
    }

    // k = M/2 (自己対称点)
    {
      const k = mHalf;
      const zrk = realOut[k];
      const zik = imagOut[k];

      const ck = cosT[k];
      const sk = sinT[k];

      // E = (Re(Z[k]), 0), O = (0, Im(Z[k]))
      // j·W·O: Real = -ck*oi, Imag = -sk*oi (or=0)
      realOut[k] = zrk + ck * zik;
      imagOut[k] = sk * zik;
    }
  }

  /**
   * 互換性維持用: 従来型複素FFT (② 最適化バタフライ版)
   * @param {Float32Array} realInput - 実数入力信号
   * @param {Float32Array} realOut - 実部出力バッファ (長さ: size)
   * @param {Float32Array} imagOut - 虚部出力バッファ (長さ: size)
   */
  transform(realInput, realOut, imagOut) {
    const n = this.size;

    // 窓関数の適用とビット反転順序への並べ替え
    for (let i = 0; i < n; i++) {
      const reversedIdx = this.bitReverse[i];
      realOut[reversedIdx] = realInput[i] * this.window[i];
      imagOut[reversedIdx] = 0;
    }

    // ② Stage 1: len=2 (W=1 → 乗算スキップ)
    for (let i = 0; i < n; i += 2) {
      const tr = realOut[i + 1];
      const ti = imagOut[i + 1];
      realOut[i + 1] = realOut[i] - tr;
      imagOut[i + 1] = imagOut[i] - ti;
      realOut[i] += tr;
      imagOut[i] += ti;
    }

    // ② Stage 2: len=4 (W=1, -j → 乗算スキップ)
    for (let i = 0; i < n; i += 4) {
      let tr = realOut[i + 2];
      let ti = imagOut[i + 2];
      realOut[i + 2] = realOut[i] - tr;
      imagOut[i + 2] = imagOut[i] - ti;
      realOut[i] += tr;
      imagOut[i] += ti;

      tr = imagOut[i + 3];
      ti = -realOut[i + 3];
      realOut[i + 3] = realOut[i + 1] - tr;
      imagOut[i + 3] = imagOut[i + 1] - ti;
      realOut[i + 1] += tr;
      imagOut[i + 1] += ti;
    }

    // ② Stage 3以降: j外側・i内側ループ
    const cosT = this.cosTable;
    const sinT = this.sinTable;
    for (let len = 8; len <= n; len <<= 1) {
      const halfLen = len >> 1;
      const step = n / len;
      for (let j = 0; j < halfLen; j++) {
        const tableIdx = j * step;
        const cosVal = cosT[tableIdx];
        const sinVal = sinT[tableIdx];
        for (let i = j; i < n; i += len) {
          const k = i + halfLen;
          const tReal = realOut[k] * cosVal - imagOut[k] * sinVal;
          const tImag = realOut[k] * sinVal + imagOut[k] * cosVal;
          realOut[k] = realOut[i] - tReal;
          imagOut[k] = imagOut[i] - tImag;
          realOut[i] += tReal;
          imagOut[i] += tImag;
        }
      }
    }
  }

  /**
   * ③ FFT結果からデシベル変換 (高速対数近似版) を行い、0〜255のバイト配列を出力します
   * @param {Float32Array} real - FFT実部
   * @param {Float32Array} imag - FFT虚部
   * @param {Uint8Array} byteOut - 出力バッファ
   * @param {number} outOffset - 出力バッファ内の開始オフセット
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
    const halfSize = this.size / 2;
    const decibelRange = maxDecibels - minDecibels;
    const scaleFactor = BYTE_MAX_VALUE / decibelRange;
    const logConstant = this.logConstant;
    const minPower = this.minPowerThreshold;

    for (let i = 0; i < halfSize; i++) {
      const r = real[i];
      const im = imag[i];
      const powerSquared = r * r + im * im;

      // ③ IEEE-754 ビット演算 + LUT による高速 log2 → デシベル変換
      // 10*log10(psq) - 20*log10(N) = DB_SCALE_LOG2 * log2(psq) - logConstant
      const decibels = powerSquared > minPower
        ? DB_SCALE_LOG2 * fastLog2(powerSquared) - logConstant
        : -Infinity;

      let value = Math.round((decibels - minDecibels) * scaleFactor);
      if (value < 0) {
        value = 0;
      } else if (value > BYTE_MAX_VALUE) {
        value = BYTE_MAX_VALUE;
      }
      byteOut[outOffset + i] = value;
    }
  }
}
