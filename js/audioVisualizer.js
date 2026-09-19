/**
 * 音频解析及波形绘制类模块
 * 提供 Web Workers 多线程并行解析，以及基于已缓存频率数据的即时重算・预览绘制。
 */

import {
  DEFAULT_FFT_SIZE,
  SMOOTHING_POINTS_PER_BAR,
  BASE_LIGHTNESS,
  MIN_LIGHTNESS_LIMIT,
  MAX_LIGHTNESS_LIMIT,
  SMOOTH_CURVE_WINDOW_FACTOR,
  SMOOTH_CURVE_BLEND_DIVISOR,
  OFFLINE_ANALYSIS_CHUNK_SIZE,
  SAMPLING_METHOD,
  DEFAULT_SAMPLING_METHOD,
  BLEND_PEAK_RATIO,
  BLEND_AVERAGE_RATIO,
  RECOMPUTE_CHUNK_SIZE,
  PREVIEW_LOOKBACK_FRAMES,
  PREVIEW_MODE,
  DEFAULT_PREVIEW_MODE,
  CIRCLE_RADIUS_RATIO_OUT,
  CIRCLE_BAR_SCALE_OUT,
  CIRCLE_RADIUS_RATIO_BOTH,
  CIRCLE_BAR_SCALE_BOTH,
  CIRCLE_RADIUS_RATIO_IN,
  CIRCLE_BAR_SCALE_IN,
  ANGLE_OFFSET_TOP,
  FULL_CIRCLE_RADIAN,
  HALF_DIVISOR
} from './constants.js';
import { FastFFT } from './fft.js';

/**
 * 获取频带内的最大值（峰值）(对最强的声音敏感反应)
 * @param {Float32Array} data - 频率数据数组
 * @param {number} start - 起始索引（已钳制）
 * @param {number} end - 结束索引（已钳制）
 * @returns {number} 最大值
 */
function samplePeak(data, start, end) {
  let maxVal = 0;
  for (let j = start; j < end; j++) {
    const val = data[j];
    if (val > maxVal) {
      maxVal = val;
    }
  }
  return maxVal;
}

/**
 * 获取频带内的算术平均值（将整体平滑均摊的传统方式）
 * @param {Float32Array} data - 频率数据数组
 * @param {number} start - 起始索引（已钳制）
 * @param {number} end - 结束索引（已钳制）
 * @returns {number} 平均值
 */
function sampleAverage(data, start, end) {
  let sum = 0;
  for (let j = start; j < end; j++) {
    sum += data[j];
  }
  const count = end - start;
  return count > 0 ? sum / count : 0;
}

/**
 * 获取频带内的有效值 (RMS: Root Mean Square)（接近听觉上的音量感指标）
 * @param {Float32Array} data - 频率数据数组
 * @param {number} start - 起始索引（已钳制）
 * @param {number} end - 结束索引（已钳制）
 * @returns {number} RMS 值
 */
function sampleRms(data, start, end) {
  let sumSq = 0;
  for (let j = start; j < end; j++) {
    const val = data[j];
    sumSq += val * val;
  }
  const count = end - start;
  return count > 0 ? Math.sqrt(sumSq / count) : 0;
}

/**
 * 获取频带内峰值与平均的加权混合值
 * @param {Float32Array} data - 频率数据数组
 * @param {number} start - 起始索引（已钳制）
 * @param {number} end - 结束索引（已钳制）
 * @returns {number} 混合值
 */
function sampleBlend(data, start, end) {
  let sum = 0;
  let maxVal = 0;
  for (let j = start; j < end; j++) {
    const val = data[j];
    sum += val;
    if (val > maxVal) {
      maxVal = val;
    }
  }
  const count = end - start;
  const avg = count > 0 ? sum / count : 0;
  return maxVal * BLEND_PEAK_RATIO + avg * BLEND_AVERAGE_RATIO;
}

/**
 * 临时将主线程的控制权让渡给浏览器的绘制或 UI 事件处理
 * @returns {Promise<void>}
 */
function yieldToMainThread() {
  if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
    return scheduler.yield();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * 根据设置值预计算对数插值・采样范围等计算上下文的纯函数
 * @param {object} settings - 波形参数设置
 * @param {number} sampleRate - 采样频率
 * @returns {object} 计算上下文
 */
function prepareCalculationContext(settings, sampleRate) {
  const {
    minFrequency,
    maxFrequency,
    numBars,
    barHeightScale,
    attackTimeConstant,
    decayTimeConstant,
    smoothCurve,
    freqCompensation,
    samplingMethod = DEFAULT_SAMPLING_METHOD
  } = settings;

  const fftSize = DEFAULT_FFT_SIZE;
  const bufferLength = fftSize / 2;
  const numSmoothingPoints = numBars * SMOOTHING_POINTS_PER_BAR;

  const logMinFreq = Math.log(minFrequency);
  const logMaxFreq = Math.log(maxFrequency);
  const logRange = logMaxFreq - logMinFreq;

  const virtualIndicesFloor = new Int32Array(numSmoothingPoints);
  const virtualIndicesCeil = new Int32Array(numSmoothingPoints);
  const virtualFractions = new Float32Array(numSmoothingPoints);

  for (let i = 0; i < numSmoothingPoints; i++) {
    const logRatio = i / (numSmoothingPoints - 1);
    const virtualFreq = Math.exp(logMinFreq + logRatio * logRange);
    const dataIndexFloat = (virtualFreq * fftSize) / sampleRate;

    const floorIdx = Math.floor(dataIndexFloat);
    const ceilIdx = Math.ceil(dataIndexFloat);

    virtualIndicesFloor[i] = floorIdx;
    virtualIndicesCeil[i] = ceilIdx;
    virtualFractions[i] = dataIndexFloat - floorIdx;
  }

  const barRangeStarts = new Int32Array(numBars);
  const barRangeEnds = new Int32Array(numBars);
  for (let i = 0; i < numBars; i++) {
    const rawStart = Math.floor((i / numBars) * numSmoothingPoints);
    const rawEnd = Math.ceil(((i + 1) / numBars) * numSmoothingPoints);
    barRangeStarts[i] = Math.max(0, Math.min(numSmoothingPoints, rawStart));
    barRangeEnds[i] = Math.max(0, Math.min(numSmoothingPoints, rawEnd));
  }

  const compensationFactors = new Float32Array(numBars);
  for (let i = 0; i < numBars; i++) {
    compensationFactors[i] =
      freqCompensation > 0 ? 1 + (i / (numBars - 1)) * freqCompensation : 1;
  }

  const smoothingWindow = Math.min(
    Math.round(smoothCurve * SMOOTH_CURVE_WINDOW_FACTOR),
    Math.floor(numSmoothingPoints / 2)
  );
  const halfWindow = Math.floor(smoothingWindow / 2);
  const blendFactor = Math.min(1, smoothCurve / SMOOTH_CURVE_BLEND_DIVISOR);

  let computeRangeValue = sampleAverage;
  if (samplingMethod === SAMPLING_METHOD.PEAK) {
    computeRangeValue = samplePeak;
  } else if (samplingMethod === SAMPLING_METHOD.RMS) {
    computeRangeValue = sampleRms;
  } else if (samplingMethod === SAMPLING_METHOD.BLEND) {
    computeRangeValue = sampleBlend;
  }

  return {
    numBars,
    numSmoothingPoints,
    bufferLength,
    attackTimeConstant,
    decayTimeConstant,
    smoothCurve,
    halfWindow,
    blendFactor,
    barHeightScale,
    virtualIndicesFloor,
    virtualIndicesCeil,
    virtualFractions,
    barRangeStarts,
    barRangeEnds,
    compensationFactors,
    computeRangeValue
  };
}

/**
 * 对单帧频率数据进行对数插值・平滑处理，计算条柱高度数组的纯函数
 * @param {Uint8Array} dataArray - 原始频率数据
 * @param {boolean} isFirstFrame - 是否为第一帧
 * @param {Float32Array} smoothedDisplayData - 来自上一帧的起音/衰减累积数组
 * @param {Float32Array} currentFrameInterpolatedData - 插值数据用工作缓冲区
 * @param {Float32Array} tempSmoothedData - 平滑处理用工作缓冲区
 * @param {Float32Array | null} prefixSum - 累加和用工作缓冲区
 * @param {object} calcCtx - 预计算上下文
 * @returns {Uint16Array} 条柱高度数组
 */
function processFrameData(
  dataArray,
  isFirstFrame,
  smoothedDisplayData,
  currentFrameInterpolatedData,
  tempSmoothedData,
  prefixSum,
  calcCtx
) {
  const {
    numBars,
    numSmoothingPoints,
    bufferLength,
    attackTimeConstant,
    decayTimeConstant,
    smoothCurve,
    halfWindow,
    blendFactor,
    barHeightScale,
    virtualIndicesFloor,
    virtualIndicesCeil,
    virtualFractions,
    barRangeStarts,
    barRangeEnds,
    compensationFactors,
    computeRangeValue
  } = calcCtx;

  // 1. 对数插值
  for (let i = 0; i < numSmoothingPoints; i++) {
    const floorIdx = virtualIndicesFloor[i];
    const ceilIdx = virtualIndicesCeil[i];

    if (floorIdx < 0 || ceilIdx >= bufferLength) {
      currentFrameInterpolatedData[i] = 0;
    } else if (floorIdx === ceilIdx) {
      currentFrameInterpolatedData[i] = dataArray[floorIdx];
    } else {
      const val1 = dataArray[floorIdx];
      const val2 = dataArray[ceilIdx];
      currentFrameInterpolatedData[i] =
        val1 + (val2 - val1) * virtualFractions[i];
    }
  }

  // 2. 起音 / 衰减
  if (isFirstFrame) {
    for (let i = 0; i < numSmoothingPoints; i++) {
      smoothedDisplayData[i] = currentFrameInterpolatedData[i];
    }
  } else {
    for (let i = 0; i < numSmoothingPoints; i++) {
      const target = currentFrameInterpolatedData[i];
      const current = smoothedDisplayData[i];
      if (target > current) {
        smoothedDisplayData[i] =
          current * attackTimeConstant + target * (1 - attackTimeConstant);
      } else {
        smoothedDisplayData[i] =
          current * decayTimeConstant + target * (1 - decayTimeConstant);
      }
    }
  }

  // 3. 平滑曲线
  if (smoothCurve > 0 && prefixSum) {
    prefixSum[0] = 0;
    for (let i = 0; i < numSmoothingPoints; i++) {
      prefixSum[i + 1] = prefixSum[i] + smoothedDisplayData[i];
    }

    for (let i = 0; i < numSmoothingPoints; i++) {
      const left = i - halfWindow;
      const right = i + halfWindow;
      const clampedLeft = left < 0 ? 0 : left;
      const clampedRight = right >= numSmoothingPoints ? numSmoothingPoints - 1 : right;
      const count = clampedRight - clampedLeft + 1;
      tempSmoothedData[i] = (prefixSum[clampedRight + 1] - prefixSum[clampedLeft]) / count;
    }

    for (let i = 0; i < numSmoothingPoints; i++) {
      smoothedDisplayData[i] =
        smoothedDisplayData[i] * (1 - blendFactor) +
        tempSmoothedData[i] * blendFactor;
    }
  }

  // 4. 计算各条柱的高度
  const frameBarHeights = new Uint16Array(numBars);
  for (let i = 0; i < numBars; i++) {
    const start = barRangeStarts[i];
    const end = barRangeEnds[i];
    const value = computeRangeValue(smoothedDisplayData, start, end);
    const barHeight = value * barHeightScale * compensationFactors[i];
    frameBarHeights[i] = Math.floor(barHeight);
  }

  return frameBarHeights;
}

/**
 * 根据条柱高度与画布基准长度计算 HSL 颜色字符串的纯函数
 * @param {number} barHeight - 条柱的高度
 * @param {number} referenceLength - 基准长度（画布高度或半径）
 * @param {number} peakBrightnessScale - 峰值辉度比例
 * @param {number} currentHue - 色相
 * @returns {string} HSL 颜色字符串
 */
function computeBarLightnessColor(barHeight, referenceLength, peakBrightnessScale, currentHue) {
  const normalizedHeight = referenceLength > 0 ? Math.min(1.0, barHeight / referenceLength) : 0;
  const minLightness = Math.max(
    MIN_LIGHTNESS_LIMIT,
    BASE_LIGHTNESS * (1 - peakBrightnessScale / HALF_DIVISOR)
  );
  let lightness = minLightness + (BASE_LIGHTNESS - minLightness) * normalizedHeight;
  lightness = Math.max(MIN_LIGHTNESS_LIMIT, Math.min(MAX_LIGHTNESS_LIMIT, lightness));
  return `hsl(${currentHue}, 100%, ${lightness}%)`;
}

export class AudioVisualizer {

  constructor() {
    this.audioContext = null;
    this.fastFft = new FastFFT(DEFAULT_FFT_SIZE);

    // 第一层缓存: 所有帧的原始频率数据 (连续缓冲区以及视图数组)
    this.rawFrequencyBuffer = null;
    this.cachedRawFrequencyFrames = [];

    // 第二层缓存: 根据当前设置计算出的各帧条柱高度数组
    this.recordedBarHeights = [];

    // 自定义条柱绘制函数 (与条柱编辑器联动・防止拉伸变形)
    this.customBarDrawer = null;

    // 解析状态标志
    this.isAnalyzing = false;
    this.audioDuration = 0;
    this.sampleRate = 44100;

    // 异步重算以及即时预览用状态
    this.recomputeTaskId = 0;
    this.isRecomputing = false;
    this.recomputePromise = null;
    this.previewBarHeights = null;
    this.previewFrameIndex = -1;

    // 设置值
    this.settings = {
      minFrequency: 20,
      maxFrequency: 24000,
      numBars: 480,
      barThickness: 5,
      barHeightScale: 0.5,
      attackTimeConstant: 0.6,
      decayTimeConstant: 0.6,
      peakBrightnessScale: 1.0,
      smoothCurve: 2.5,
      freqCompensation: 2.0,
      targetFPS: 60,
      currentHue: 345,
      samplingMethod: DEFAULT_SAMPLING_METHOD,
      previewMode: DEFAULT_PREVIEW_MODE
    };
  }

  /**
   * 更新设置值，并开始即时 1 帧预览绘制以及全帧的后台异步重算
   * @param {object} newSettings - 新的设置对象
   * @param {number | null} currentTimeSeconds - 当前的播放位置（秒）
   * @param {HTMLCanvasElement | null} canvas - 绘制目标 Canvas
   * @param {CanvasRenderingContext2D | null} ctx - 2D 绘制上下文
   */
  updateSettings(newSettings, currentTimeSeconds = null, canvas = null, ctx = null) {
    const oldSettings = { ...this.settings };
    this.settings = { ...this.settings, ...newSettings };

    const requiresRecalculation =
      oldSettings.minFrequency !== this.settings.minFrequency ||
      oldSettings.maxFrequency !== this.settings.maxFrequency ||
      oldSettings.numBars !== this.settings.numBars ||
      oldSettings.barHeightScale !== this.settings.barHeightScale ||
      oldSettings.attackTimeConstant !== this.settings.attackTimeConstant ||
      oldSettings.decayTimeConstant !== this.settings.decayTimeConstant ||
      oldSettings.smoothCurve !== this.settings.smoothCurve ||
      oldSettings.freqCompensation !== this.settings.freqCompensation ||
      oldSettings.targetFPS !== this.settings.targetFPS ||
      oldSettings.samplingMethod !== this.settings.samplingMethod;

    if (requiresRecalculation && this.cachedRawFrequencyFrames.length > 0) {
      // 1. 仅以约 0.05ms 立即计算当前播放位置的一帧并即时反映到 Canvas（延迟 0ms 的即时预览）
      if (currentTimeSeconds !== null && canvas && ctx) {
        this.renderInstantPreview(currentTimeSeconds, canvas, ctx);
      }

      // 2. 在后台对全帧重算进行异步分块执行（不阻塞主线程，维持 60FPS）
      this.recomputePromise = this.recomputeBarHeightsAsync();
    } else if (currentTimeSeconds !== null && canvas && ctx) {
      // 对于无需重算频率的显示设置变更（预览形式・颜色・峰值辉度等），瞬时更新绘制 (延迟 0ms)
      this.drawAtTime(currentTimeSeconds, canvas, ctx);
    }
  }

  /**
   * 初始化 AudioContext
   */
  ensureAudioContext() {
    if (!this.audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioContextClass();
    }
    return this.audioContext;
  }

  /**
   * 解除 AudioContext 的挂起状态
   */
  async resumeContext() {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  /**
   * 获取已记录的波形高度数据
   * @returns {number[][]}
   */
  getRecordedBarHeights() {
    return this.recordedBarHeights;
  }

  /**
   * 判断数据是否已完成解析
   * @returns {boolean}
   */
  hasAnalyzedData() {
    return (
      this.recordedBarHeights.length > 0 ||
      (this.cachedRawFrequencyFrames && this.cachedRawFrequencyFrames.length > 0)
    );
  }

  /**
   * 从 AudioBuffer 提取 PCM 数据并转换为单声道
   * @param {AudioBuffer} audioBuffer
   * @returns {Float32Array}
   */
  extractPcmData(audioBuffer) {
    const numberOfChannels = audioBuffer.numberOfChannels;
    const totalSamples = audioBuffer.length;

    if (numberOfChannels === 1) {
      return audioBuffer.getChannelData(0);
    }

    const leftChannel = audioBuffer.getChannelData(0);
    const rightChannel = audioBuffer.getChannelData(1);
    const monoPcm = new Float32Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) {
      monoPcm[i] = (leftChannel[i] + rightChannel[i]) * 0.5;
    }
    return monoPcm;
  }

  /**
   * 执行离线解析（优先多线程并行处理，不支持时自动回退到单线程）
   * @param {AudioBuffer} audioBuffer - 已解码的 AudioBuffer
   * @param {Function} onProgress - 进度回调 (0.0 〜 1.0)
   */
  async analyzeOffline(audioBuffer, onProgress) {
    this.isAnalyzing = true;
    this.sampleRate = audioBuffer.sampleRate;
    this.audioDuration = audioBuffer.duration;

    const supportsWorker = typeof window !== 'undefined' && typeof window.Worker !== 'undefined';

    if (supportsWorker) {
      try {
        await this.analyzeOfflineParallel(audioBuffer, onProgress);
        this.isAnalyzing = false;
        return;
      } catch (workerError) {
        console.warn(
          'Web Worker 並列解析の初期化に失敗しました。シングルスレッド処理へフォールバックします:',
          workerError
        );
      }
    }

    // 回退: 主线程异步处理
    await this.analyzeOfflineSingleThread(audioBuffer, onProgress);
    this.isAnalyzing = false;
  }

  /**
   * 通过 Web Workers 进行的多线程并行离线解析
   * @param {AudioBuffer} audioBuffer
   * @param {Function} onProgress
   */
  async analyzeOfflineParallel(audioBuffer, onProgress) {
    const targetFps = this.settings.targetFPS;
    const totalFrames = Math.ceil(this.audioDuration * targetFps);
    const halfFftSize = DEFAULT_FFT_SIZE / 2;

    const concurrency = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency)
      ? navigator.hardwareConcurrency
      : 4;
    const workerCount = Math.max(1, Math.min(concurrency, totalFrames));

    const pcmData = this.extractPcmData(audioBuffer);
    const totalSamples = pcmData.length;

    // 预留连续内存缓冲区
    this.rawFrequencyBuffer = new Uint8Array(totalFrames * halfFftSize);
    this.cachedRawFrequencyFrames = new Array(totalFrames);

    const framesPerWorker = Math.ceil(totalFrames / workerCount);
    const workerPromises = [];
    const workerProgressList = new Array(workerCount).fill(0);

    const updateOverallProgress = () => {
      if (typeof onProgress === 'function') {
        const sumDone = workerProgressList.reduce((acc, val) => acc + val, 0);
        onProgress(Math.min(1.0, sumDone / totalFrames));
      }
    };

    for (let w = 0; w < workerCount; w++) {
      const startFrame = w * framesPerWorker;
      const endFrame = Math.min(totalFrames - 1, (w + 1) * framesPerWorker - 1);
      if (startFrame > endFrame) {
        break;
      }

      const workerPromise = new Promise((resolve, reject) => {
        let worker;
        try {
          const workerUrl = new URL('./analysisWorker.js', import.meta.url);
          worker = new Worker(workerUrl, { type: 'module' });
        } catch (err) {
          reject(err);
          return;
        }

        worker.onmessage = (e) => {
          const msg = e.data;
          if (msg.type === 'PROGRESS') {
            workerProgressList[w] = msg.framesDone;
            updateOverallProgress();
          } else if (msg.type === 'COMPLETE') {
            const { startFrame: resStart, endFrame: resEnd, outputBytes } = msg;
            // 直接写入连续内存区域
            const byteOffset = resStart * halfFftSize;
            this.rawFrequencyBuffer.set(outputBytes, byteOffset);

            const frameCount = resEnd - resStart + 1;
            workerProgressList[w] = frameCount;
            updateOverallProgress();

            worker.terminate();
            resolve();
          }
        };

        worker.onerror = (err) => {
          worker.terminate();
          reject(err);
        };

        // 向 Worker 发送任务
        worker.postMessage({
          type: 'ANALYZE',
          taskId: w,
          pcmData,
          sampleRate: this.sampleRate,
          targetFps,
          startFrame,
          endFrame,
          totalSamples
        });
      });

      workerPromises.push(workerPromise);
    }

    await Promise.all(workerPromises);

    // 构建帧引用数组（零拷贝・subarray 引用）
    for (let f = 0; f < totalFrames; f++) {
      const offset = f * halfFftSize;
      this.cachedRawFrequencyFrames[f] = this.rawFrequencyBuffer.subarray(
        offset,
        offset + halfFftSize
      );
    }

    if (typeof onProgress === 'function') {
      onProgress(1.0);
    }

    this.recomputeBarHeights();
  }

  /**
   * 主线程异步离线解析（用于回退）
   * @param {AudioBuffer} audioBuffer
   * @param {Function} onProgress
   */
  async analyzeOfflineSingleThread(audioBuffer, onProgress) {
    const targetFps = this.settings.targetFPS;
    const totalFrames = Math.ceil(this.audioDuration * targetFps);
    const halfFftSize = DEFAULT_FFT_SIZE / 2;

    const pcmData = this.extractPcmData(audioBuffer);
    const totalSamples = pcmData.length;

    this.rawFrequencyBuffer = new Uint8Array(totalFrames * halfFftSize);
    this.cachedRawFrequencyFrames = new Array(totalFrames);

    const realInput = new Float32Array(DEFAULT_FFT_SIZE);
    const realOut = new Float32Array(DEFAULT_FFT_SIZE);
    const imagOut = new Float32Array(DEFAULT_FFT_SIZE);

    for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
      const centerSample = Math.round((frameIdx * this.sampleRate) / targetFps);
      const startSample = centerSample - halfFftSize;

      for (let i = 0; i < DEFAULT_FFT_SIZE; i++) {
        const sampleIdx = startSample + i;
        realInput[i] = sampleIdx >= 0 && sampleIdx < totalSamples ? pcmData[sampleIdx] : 0;
      }

      this.fastFft.realTransform(realInput, realOut, imagOut);
      const byteOffset = frameIdx * halfFftSize;
      this.fastFft.getByteFrequencyData(
        realOut,
        imagOut,
        this.rawFrequencyBuffer,
        byteOffset
      );
      this.cachedRawFrequencyFrames[frameIdx] = this.rawFrequencyBuffer.subarray(
        byteOffset,
        byteOffset + halfFftSize
      );

      if (frameIdx % OFFLINE_ANALYSIS_CHUNK_SIZE === 0) {
        if (typeof onProgress === 'function') {
          onProgress(frameIdx / totalFrames);
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    if (typeof onProgress === 'function') {
      onProgress(1.0);
    }

    this.recomputeBarHeights();
  }

  /**
   * 仅立即计算当前播放位置对应的 1 帧并绘制到 Canvas（延迟 0ms 的即时预览）
   * @param {number} currentTimeSeconds - 播放位置（秒）
   * @param {HTMLCanvasElement} canvas - 绘制目标 Canvas
   * @param {CanvasRenderingContext2D} ctx - 2D 绘制上下文
   */
  renderInstantPreview(currentTimeSeconds, canvas, ctx) {
    if (!this.cachedRawFrequencyFrames || this.cachedRawFrequencyFrames.length === 0) {
      return;
    }
    const targetFps = this.settings.targetFPS || 60;
    const frameIndex = Math.floor(currentTimeSeconds * targetFps);
    const instantHeights = this.computeInstantPreviewHeights(frameIndex);
    if (instantHeights) {
      this.previewBarHeights = instantHeights;
      this.previewFrameIndex = frameIndex;
      this.drawFrame(frameIndex, canvas, ctx);
    }
  }

  /**
   * 考虑起音・衰减的收敛，高速局部计算指定帧号的条柱高度 (约 0.05ms)
   * @param {number} targetFrameIndex - 计算目标的帧索引
   * @returns {Uint16Array | null}
   */
  computeInstantPreviewHeights(targetFrameIndex) {
    if (!this.cachedRawFrequencyFrames || this.cachedRawFrequencyFrames.length === 0) {
      return null;
    }
    const totalFrames = this.cachedRawFrequencyFrames.length;
    const safeTargetIndex = Math.max(0, Math.min(totalFrames - 1, targetFrameIndex));
    const startFrame = Math.max(0, safeTargetIndex - PREVIEW_LOOKBACK_FRAMES);

    const calcCtx = prepareCalculationContext(this.settings, this.sampleRate);
    const smoothedDisplayData = new Float32Array(calcCtx.numSmoothingPoints);
    const currentFrameInterpolatedData = new Float32Array(calcCtx.numSmoothingPoints);
    const tempSmoothedData = new Float32Array(calcCtx.numSmoothingPoints);
    const prefixSum = calcCtx.smoothCurve > 0 ? new Float32Array(calcCtx.numSmoothingPoints + 1) : null;

    let resultHeights = null;
    for (let f = startFrame; f <= safeTargetIndex; f++) {
      const dataArray = this.cachedRawFrequencyFrames[f];
      resultHeights = processFrameData(
        dataArray,
        f === startFrame,
        smoothedDisplayData,
        currentFrameInterpolatedData,
        tempSmoothedData,
        prefixSum,
        calcCtx
      );
    }
    return resultHeights;
  }

  /**
   * 在后台对全帧条柱高度进行异步分块计算 (支持时间片 & 取消)
   * 不占用主线程，在各分块之间把控制权交还给浏览器的画面绘制・事件处理
   * @returns {Promise<void>}
   */
  async recomputeBarHeightsAsync() {
    if (!this.cachedRawFrequencyFrames || this.cachedRawFrequencyFrames.length === 0) {
      return;
    }

    this.recomputeTaskId++;
    const currentTaskId = this.recomputeTaskId;
    this.isRecomputing = true;

    const totalFrames = this.cachedRawFrequencyFrames.length;
    const nextBarHeights = new Array(totalFrames);

    const calcCtx = prepareCalculationContext(this.settings, this.sampleRate);
    const smoothedDisplayData = new Float32Array(calcCtx.numSmoothingPoints);
    const currentFrameInterpolatedData = new Float32Array(calcCtx.numSmoothingPoints);
    const tempSmoothedData = new Float32Array(calcCtx.numSmoothingPoints);
    const prefixSum = calcCtx.smoothCurve > 0 ? new Float32Array(calcCtx.numSmoothingPoints + 1) : null;

    try {
      for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
        // 在每个分块边界临时让渡主线程控制权（防止 UI 阻塞并维持 60FPS）
        if (frameIdx > 0 && frameIdx % RECOMPUTE_CHUNK_SIZE === 0) {
          await yieldToMainThread();
          // 若其他参数操作导致新任务开始，则立即中止（取消）
          if (this.recomputeTaskId !== currentTaskId) {
            return;
          }
        }

        const dataArray = this.cachedRawFrequencyFrames[frameIdx];
        nextBarHeights[frameIdx] = processFrameData(
          dataArray,
          frameIdx === 0,
          smoothedDisplayData,
          currentFrameInterpolatedData,
          tempSmoothedData,
          prefixSum,
          calcCtx
        );
      }

      // 完成时原子性地替换数据
      if (this.recomputeTaskId === currentTaskId) {
        this.recordedBarHeights = nextBarHeights;
        this.isRecomputing = false;
        this.previewBarHeights = null;
        this.previewFrameIndex = -1;
      }
    } catch (error) {
      console.warn('非同期波形再計算中にエラーが発生しました:', error);
      this.isRecomputing = false;
      throw error;
    }
  }

  /**
   * 根据已缓存的原始频率数据，基于当前设置同步重算条柱高度 (用于初始化・测试)
   */
  recomputeBarHeights() {
    if (!this.cachedRawFrequencyFrames || this.cachedRawFrequencyFrames.length === 0) {
      return;
    }

    const totalFrames = this.cachedRawFrequencyFrames.length;
    this.recordedBarHeights = new Array(totalFrames);

    const calcCtx = prepareCalculationContext(this.settings, this.sampleRate);
    const smoothedDisplayData = new Float32Array(calcCtx.numSmoothingPoints);
    const currentFrameInterpolatedData = new Float32Array(calcCtx.numSmoothingPoints);
    const tempSmoothedData = new Float32Array(calcCtx.numSmoothingPoints);
    const prefixSum = calcCtx.smoothCurve > 0 ? new Float32Array(calcCtx.numSmoothingPoints + 1) : null;

    for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
      const dataArray = this.cachedRawFrequencyFrames[frameIdx];
      this.recordedBarHeights[frameIdx] = processFrameData(
        dataArray,
        frameIdx === 0,
        smoothedDisplayData,
        currentFrameInterpolatedData,
        tempSmoothedData,
        prefixSum,
        calcCtx
      );
    }
  }

  /**
   * 等待正在执行的异步重算完成 (用于保存处理)
   * @returns {Promise<void>}
   */
  async waitForRecomputation() {
    if (this.recomputePromise) {
      await this.recomputePromise;
    }
    while (this.isRecomputing) {
      await yieldToMainThread();
    }
  }

  /**
   * 预览绘制指定播放时间（秒）对应帧的波形
   * @param {number} currentTimeSeconds - 播放位置（秒）
   * @param {HTMLCanvasElement} canvas - 绘制目标 Canvas
   * @param {CanvasRenderingContext2D} ctx - 2D 绘制上下文
   */
  drawAtTime(currentTimeSeconds, canvas, ctx) {
    const frameIndex = Math.floor(currentTimeSeconds * this.settings.targetFPS);
    this.drawFrame(frameIndex, canvas, ctx);
  }

  /**
   * 设置自定义条柱绘制函数 (用于防止拉伸导致的圆角等变形)
   * @param {Function | null} drawerFunc - (ctx, x, y, width, height) => void
   */
  setCustomBarDrawer(drawerFunc) {
    this.customBarDrawer = drawerFunc;
  }

  /**
   * 进行波型1 (通常波形・下边界为基准) 的绘制
   * @param {CanvasRenderingContext2D} ctx
   * @param {HTMLCanvasElement} canvas
   * @param {Uint16Array} barHeights
   * @param {number} numBars
   * @param {number} barThickness
   * @param {number} peakBrightnessScale
   * @param {number} currentHue
   */
  drawWave1(ctx, canvas, barHeights, numBars, barThickness, peakBrightnessScale, currentHue) {
    const spacingPerBar = canvas.width / numBars;
    for (let i = 0; i < numBars; i++) {
      const barHeight = barHeights[i] || 0;
      if (barHeight <= 0) continue;
      const posX = i * spacingPerBar + (spacingPerBar - barThickness) / HALF_DIVISOR;
      const posY = canvas.height - barHeight;
      if (this.customBarDrawer) {
        this.customBarDrawer(ctx, posX, posY, barThickness, barHeight);
      } else {
        ctx.fillStyle = computeBarLightnessColor(barHeight, canvas.height, peakBrightnessScale, currentHue);
        ctx.fillRect(posX, posY, barThickness, barHeight);
      }
    }
  }

  /**
   * 进行波型2 (上下对称・垂直中央为基准) 的绘制
   * @param {CanvasRenderingContext2D} ctx
   * @param {HTMLCanvasElement} canvas
   * @param {Uint16Array} barHeights
   * @param {number} numBars
   * @param {number} barThickness
   * @param {number} peakBrightnessScale
   * @param {number} currentHue
   */
  drawWave2(ctx, canvas, barHeights, numBars, barThickness, peakBrightnessScale, currentHue) {
    const spacingPerBar = canvas.width / numBars;
    const centerY = canvas.height / HALF_DIVISOR;

    for (let i = 0; i < numBars; i++) {
      const barHeight = barHeights[i] || 0;
      if (barHeight <= 0) continue;
      const posX = i * spacingPerBar + (spacingPerBar - barThickness) / HALF_DIVISOR;
      const halfH = Math.max(1, Math.round(barHeight / HALF_DIVISOR));

      if (this.customBarDrawer) {
        // 上半部分 (常规方向)
        this.customBarDrawer(ctx, posX, centerY - halfH, barThickness, halfH);
        // 下半部分 (上下翻转)
        ctx.save();
        ctx.translate(0, centerY);
        ctx.scale(1, -1);
        this.customBarDrawer(ctx, posX, -halfH, barThickness, halfH);
        ctx.restore();
      } else {
        ctx.fillStyle = computeBarLightnessColor(barHeight, canvas.height, peakBrightnessScale, currentHue);
        ctx.fillRect(posX, centerY - halfH, barThickness, halfH * HALF_DIVISOR);
      }
    }
  }

  /**
   * 进行圆型1 (圆形・向外延伸) 的绘制
   * @param {CanvasRenderingContext2D} ctx
   * @param {HTMLCanvasElement} canvas
   * @param {Uint16Array} barHeights
   * @param {number} numBars
   * @param {number} barThickness
   * @param {number} peakBrightnessScale
   * @param {number} currentHue
   */
  drawCircle1(ctx, canvas, barHeights, numBars, barThickness, peakBrightnessScale, currentHue) {
    const centerX = canvas.width / HALF_DIVISOR;
    const centerY = canvas.height / HALF_DIVISOR;
    const baseRadius = Math.min(centerX, centerY) * CIRCLE_RADIUS_RATIO_OUT;
    const halfThickness = barThickness / HALF_DIVISOR;

    for (let i = 0; i < numBars; i++) {
      const barHeight = barHeights[i] || 0;
      if (barHeight <= 0) continue;
      const scaledH = Math.max(1, Math.round(barHeight * CIRCLE_BAR_SCALE_OUT));
      const theta = ANGLE_OFFSET_TOP + (i / numBars) * FULL_CIRCLE_RADIAN;

      ctx.save();
      ctx.translate(centerX, centerY);
      ctx.rotate(theta + Math.PI / HALF_DIVISOR);
      ctx.translate(0, -baseRadius);

      if (this.customBarDrawer) {
        this.customBarDrawer(ctx, -halfThickness, -scaledH, barThickness, scaledH);
      } else {
        ctx.fillStyle = computeBarLightnessColor(barHeight, canvas.height, peakBrightnessScale, currentHue);
        ctx.fillRect(-halfThickness, -scaledH, barThickness, scaledH);
      }
      ctx.restore();
    }
  }

  /**
   * 进行圆型2 (圆形・内外双向延伸) 的绘制
   * @param {CanvasRenderingContext2D} ctx
   * @param {HTMLCanvasElement} canvas
   * @param {Uint16Array} barHeights
   * @param {number} numBars
   * @param {number} barThickness
   * @param {number} peakBrightnessScale
   * @param {number} currentHue
   */
  drawCircle2(ctx, canvas, barHeights, numBars, barThickness, peakBrightnessScale, currentHue) {
    const centerX = canvas.width / HALF_DIVISOR;
    const centerY = canvas.height / HALF_DIVISOR;
    const baseRadius = Math.min(centerX, centerY) * CIRCLE_RADIUS_RATIO_BOTH;
    const halfThickness = barThickness / HALF_DIVISOR;

    for (let i = 0; i < numBars; i++) {
      const barHeight = barHeights[i] || 0;
      if (barHeight <= 0) continue;
      const halfH = Math.max(1, Math.round((barHeight * CIRCLE_BAR_SCALE_BOTH) / HALF_DIVISOR));
      const theta = ANGLE_OFFSET_TOP + (i / numBars) * FULL_CIRCLE_RADIAN;

      ctx.save();
      ctx.translate(centerX, centerY);
      ctx.rotate(theta + Math.PI / HALF_DIVISOR);
      ctx.translate(0, -baseRadius);

      if (this.customBarDrawer) {
        // 向外侧延伸
        this.customBarDrawer(ctx, -halfThickness, -halfH, barThickness, halfH);
        // 向内侧延伸 (翻转)
        ctx.save();
        ctx.scale(1, -1);
        this.customBarDrawer(ctx, -halfThickness, -halfH, barThickness, halfH);
        ctx.restore();
      } else {
        ctx.fillStyle = computeBarLightnessColor(barHeight, canvas.height, peakBrightnessScale, currentHue);
        ctx.fillRect(-halfThickness, -halfH, barThickness, halfH * HALF_DIVISOR);
      }
      ctx.restore();
    }
  }

  /**
   * 进行圆型3 (圆形・向内延伸) 的绘制
   * @param {CanvasRenderingContext2D} ctx
   * @param {HTMLCanvasElement} canvas
   * @param {Uint16Array} barHeights
   * @param {number} numBars
   * @param {number} barThickness
   * @param {number} peakBrightnessScale
   * @param {number} currentHue
   */
  drawCircle3(ctx, canvas, barHeights, numBars, barThickness, peakBrightnessScale, currentHue) {
    const centerX = canvas.width / HALF_DIVISOR;
    const centerY = canvas.height / HALF_DIVISOR;
    const baseRadius = Math.min(centerX, centerY) * CIRCLE_RADIUS_RATIO_IN;
    const halfThickness = barThickness / HALF_DIVISOR;

    for (let i = 0; i < numBars; i++) {
      const barHeight = barHeights[i] || 0;
      if (barHeight <= 0) continue;
      const scaledH = Math.max(1, Math.round(barHeight * CIRCLE_BAR_SCALE_IN));
      const theta = ANGLE_OFFSET_TOP + (i / numBars) * FULL_CIRCLE_RADIAN;

      ctx.save();
      ctx.translate(centerX, centerY);
      ctx.rotate(theta - Math.PI / HALF_DIVISOR);
      ctx.translate(0, -baseRadius);

      if (this.customBarDrawer) {
        this.customBarDrawer(ctx, -halfThickness, -scaledH, barThickness, scaledH);
      } else {
        ctx.fillStyle = computeBarLightnessColor(barHeight, canvas.height, peakBrightnessScale, currentHue);
        ctx.fillRect(-halfThickness, -scaledH, barThickness, scaledH);
      }
      ctx.restore();
    }
  }

  /**
   * 将指定索引的帧绘制到 Canvas
   * @param {number} frameIndex - 帧编号
   * @param {HTMLCanvasElement} canvas - 绘制目标 Canvas
   * @param {CanvasRenderingContext2D} ctx - 2D 绘制上下文
   */
  drawFrame(frameIndex, canvas, ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let barHeights = null;
    if (this.previewBarHeights && this.previewFrameIndex === frameIndex) {
      barHeights = this.previewBarHeights;
    } else if (this.recordedBarHeights && this.recordedBarHeights.length > 0) {
      const safeIndex = Math.max(0, Math.min(this.recordedBarHeights.length - 1, frameIndex));
      barHeights = this.recordedBarHeights[safeIndex];
    }

    if (!barHeights) {
      return;
    }

    const {
      numBars,
      barThickness,
      peakBrightnessScale,
      currentHue,
      previewMode
    } = this.settings;

    switch (previewMode) {
      case PREVIEW_MODE.WAVE_2:
        this.drawWave2(ctx, canvas, barHeights, numBars, barThickness, peakBrightnessScale, currentHue);
        break;
      case PREVIEW_MODE.CIRCLE_1:
        this.drawCircle1(ctx, canvas, barHeights, numBars, barThickness, peakBrightnessScale, currentHue);
        break;
      case PREVIEW_MODE.CIRCLE_2:
        this.drawCircle2(ctx, canvas, barHeights, numBars, barThickness, peakBrightnessScale, currentHue);
        break;
      case PREVIEW_MODE.CIRCLE_3:
        this.drawCircle3(ctx, canvas, barHeights, numBars, barThickness, peakBrightnessScale, currentHue);
        break;
      case PREVIEW_MODE.WAVE_1:
      default:
        this.drawWave1(ctx, canvas, barHeights, numBars, barThickness, peakBrightnessScale, currentHue);
        break;
    }
  }
}
