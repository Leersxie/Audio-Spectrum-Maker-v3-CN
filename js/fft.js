/**
 * 高速傅里叶变换 (FFT) 模块
 * ① 实数专用FFT: 将 N 点实数信号按 N/2 点复数FFT处理，运算量约减少 54%
 * ② 蝶形优化: 通过 j-i 循环反转 + 初始阶段特化，减少乘法・查表操作
 * ③ 高速对数近似: 通过 IEEE-754 位运算 + LUT 去除 Math.log
 * 基于 Cooley-Tukey Radix-2 算法，利用预计算表进行高速频率分析。
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

// --- ③ 高速对数近似 (Fast Log) ---

// 字节序判定 (仅在模块作用域执行一次)
const _endianBuf = new ArrayBuffer(4);
new Uint8Array(_endianBuf)[0] = 1;
const HIGH_WORD_INDEX = new Uint32Array(_endianBuf)[0] === 1 ? 1 : 0;

// 用于提取 IEEE-754 float64 位结构的共享缓冲区
const _logF64 = new Float64Array(1);
const _logU32 = new Uint32Array(_logF64.buffer);

// 尾数部分 log2 查找表 (256 个条目，精度在 ±0.2% 以内)
const _log2MantissaLut = new Float32Array(LOG2_MANTISSA_LUT_SIZE);
for (let i = 0; i < LOG2_MANTISSA_LUT_SIZE; i++) {
  _log2MantissaLut[i] = Math.log2(1 + i / LOG2_MANTISSA_LUT_SIZE);
}

/**
 * 利用 IEEE-754 float64 位结构的高速 log2 近似
 * 精度: 通过尾数部分高 8 位的 LUT，最大相对误差在 ±0.2% 以内
 * @param {number} x - 正数
 * @returns {number} log2(x) 的近似值
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
   * @param {number} size - FFT 大小 (2 的幂，默认: 8192)
   */
  constructor(size = DEFAULT_FFT_SIZE) {
    this.size = size;
    const halfSize = size / 2;
    const quarterSize = size / 4;

    // --- 旋转因子表的预计算 ---

    // N 点 FFT 用表 (用于解包处理 + 兼容 transform)
    this.cosTable = new Float32Array(halfSize);
    this.sinTable = new Float32Array(halfSize);
    for (let i = 0; i < halfSize; i++) {
      const angle = (-2 * Math.PI * i) / size;
      this.cosTable[i] = Math.cos(angle);
      this.sinTable[i] = Math.sin(angle);
    }

    // N/2 点 FFT 用表 (用于实数 FFT 的内部蝶形运算)
    this.cosTableHalf = new Float32Array(quarterSize);
    this.sinTableHalf = new Float32Array(quarterSize);
    for (let i = 0; i < quarterSize; i++) {
      const angle = (-2 * Math.PI * i) / halfSize;
      this.cosTableHalf[i] = Math.cos(angle);
      this.sinTableHalf[i] = Math.sin(angle);
    }

    // --- 位反转表的预计算 ---

    // 用于 N 点 (兼容 transform)
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

    // 用于 N/2 点 (实数 FFT 使用)
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

    // --- Blackman 窗函数的预计算 (遵循 Web Audio API 规范) ---
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

    // --- 分贝转换用常量 ---
    this.logConstant = DECIBEL_SCALE_MULTIPLIER * Math.log10(size);
    this.minPowerThreshold = EPSILON_MAGNITUDE * EPSILON_MAGNITUDE;
  }

  /**
   * ① 实数专用FFT: 对 N 点实数输入应用窗函数，执行优化后的 FFT
   *
   * 处理流程:
   *   1. 应用窗函数 + 偶奇交织，打包为 N/2 点复数信号
   *   2. N/2 点 Cooley-Tukey 复数FFT (②优化蝶形)
   *   3. 通过解包处理还原 N/2+1 点的频率频谱
   *
   * @param {Float32Array} realInput - 实数输入信号 (长度: size)
   * @param {Float32Array} realOut - 实部输出缓冲区 (长度: size)
   * @param {Float32Array} imagOut - 虚部输出缓冲区 (长度: size)
   */
  realTransform(realInput, realOut, imagOut) {
    const n = this.size;
    const m = n >> 1;
    const mHalf = m >> 1;

    // --- Step 1: 应用窗函数 + 偶奇打包 + 位反转 ---
    // z[k] = window[2k]*x[2k] + j*window[2k+1]*x[2k+1]
    for (let k = 0; k < m; k++) {
      const rev = this.bitReverseHalf[k];
      const k2 = k << 1;
      realOut[rev] = realInput[k2] * this.window[k2];
      imagOut[rev] = realInput[k2 + 1] * this.window[k2 + 1];
    }

    // --- Step 2: N/2 点 复数FFT (② 优化蝶形运算) ---

    // Stage 1: len=2 (仅旋转因子 W=1 → 完全跳过乘法)
    for (let i = 0; i < m; i += 2) {
      const tr = realOut[i + 1];
      const ti = imagOut[i + 1];
      realOut[i + 1] = realOut[i] - tr;
      imagOut[i + 1] = imagOut[i] - ti;
      realOut[i] += tr;
      imagOut[i] += ti;
    }

    // Stage 2: len=4 (仅 W=1, W=-j 两种 → 完全跳过乘法)
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

    // Stage 3 之后: 外层 j・内层 i 循环 (将每个阶段的查表减少到 1 次)
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

    // --- Step 3: 解包处理 ---
    // 将 N/2 点复数FFT结果 Z[k] → 还原为 N 点实数FFT频谱 X[k]
    // 利用厄米对称性，同时处理 k 与 M-k 的配对

    const cosT = this.cosTable;
    const sinT = this.sinTable;

    // DC 分量 (k=0) 与 奈奎斯特分量 (k=M)
    const zr0 = realOut[0];
    const zi0 = imagOut[0];
    realOut[0] = zr0 + zi0;
    imagOut[0] = 0;
    realOut[m] = zr0 - zi0;
    imagOut[m] = 0;

    // 对称配对处理 (k=1 ~ M/2-1)
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

      // N 点表的旋转因子
      const ck = cosT[k];
      const sk = sinT[k];

      // X[k] = E[k] - j·W_N^k · O[k]
      // j·W·O 的展开: Real = -sk*or - ck*oi, Imag = ck*or - sk*oi
      const jwr = -sk * or - ck * oi;
      const jwi = ck * or - sk * oi;
      realOut[k] = er - jwr;
      imagOut[k] = ei - jwi;

      // X[M-k] (对称性: c_{M-k}=-ck, s_{M-k}=sk, E'/O' 符号反转关系)
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
   * 为维持兼容性: 传统型复数FFT (② 优化蝶形版)
   * @param {Float32Array} realInput - 实数输入信号
   * @param {Float32Array} realOut - 实部输出缓冲区 (长度: size)
   * @param {Float32Array} imagOut - 虚部输出缓冲区 (长度: size)
   */
  transform(realInput, realOut, imagOut) {
    const n = this.size;

    // 应用窗函数并按位反转顺序重排
    for (let i = 0; i < n; i++) {
      const reversedIdx = this.bitReverse[i];
      realOut[reversedIdx] = realInput[i] * this.window[i];
      imagOut[reversedIdx] = 0;
    }

    // ② Stage 1: len=2 (W=1 → 跳过乘法)
    for (let i = 0; i < n; i += 2) {
      const tr = realOut[i + 1];
      const ti = imagOut[i + 1];
      realOut[i + 1] = realOut[i] - tr;
      imagOut[i + 1] = imagOut[i] - ti;
      realOut[i] += tr;
      imagOut[i] += ti;
    }

    // ② Stage 2: len=4 (W=1, -j → 跳过乘法)
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

    // ② Stage 3 之后: 外层 j・内层 i 循环
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
   * ③ 对 FFT 结果进行分贝转换 (高速对数近似版)，输出 0〜255 的字节数组
   * @param {Float32Array} real - FFT 实部
   * @param {Float32Array} imag - FFT 虚部
   * @param {Uint8Array} byteOut - 输出缓冲区
   * @param {number} outOffset - 输出缓冲区内的起始偏移
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
    const halfSize = this.size / 2;
    const decibelRange = maxDecibels - minDecibels;
    const scaleFactor = BYTE_MAX_VALUE / decibelRange;
    const logConstant = this.logConstant;
    const minPower = this.minPowerThreshold;

    for (let i = 0; i < halfSize; i++) {
      const r = real[i];
      const im = imag[i];
      const powerSquared = r * r + im * im;

      // ③ 通过 IEEE-754 位运算 + LUT 的高速 log2 → 分贝转换
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
