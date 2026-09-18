/**
 * オーディオ解析および波形描画クラスモジュール
 * Web Workers によるマルチスレッド並列解析と、キャッシュされた周波数データによる即時再計算・プレビュー描画を提供します。
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
 * 帯域内の最大値（ピーク）を取得します（最も強い音に敏感に反応）
 * @param {Float32Array} data - 周波数データ配列
 * @param {number} start - 開始インデックス（クランプ済み）
 * @param {number} end - 終了インデックス（クランプ済み）
 * @returns {number} 最大値
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
 * 帯域内の算術平均値を取得します（全体を滑らかに均す従来の方式）
 * @param {Float32Array} data - 周波数データ配列
 * @param {number} start - 開始インデックス（クランプ済み）
 * @param {number} end - 終了インデックス（クランプ済み）
 * @returns {number} 平均値
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
 * 帯域内の実効値 (RMS: Root Mean Square) を取得します（聴感上の音量感に近い指標）
 * @param {Float32Array} data - 周波数データ配列
 * @param {number} start - 開始インデックス（クランプ済み）
 * @param {number} end - 終了インデックス（クランプ済み）
 * @returns {number} RMS値
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
 * 帯域内のピークと平均の加重ブレンド値を取得します
 * @param {Float32Array} data - 周波数データ配列
 * @param {number} start - 開始インデックス（クランプ済み）
 * @param {number} end - 終了インデックス（クランプ済み）
 * @returns {number} ブレンド値
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
 * ブラウザの描画やUIイベント処理にメインスレッドの制御を一時的に譲渡します
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
 * 設定値から対数補間・サンプリング範囲などの計算コンテキストを事前計算する純粋関数
 * @param {object} settings - 波形パラメータ設定
 * @param {number} sampleRate - サンプリング周波数
 * @returns {object} 計算コンテキスト
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
 * 単一フレームの周波数データを対数補間・スムージングし、バー高さ配列を算出する純粋関数
 * @param {Uint8Array} dataArray - 生周波数データ
 * @param {boolean} isFirstFrame - 先頭フレームか否か
 * @param {Float32Array} smoothedDisplayData - 前フレームからのアタック/ディケイ累積配列
 * @param {Float32Array} currentFrameInterpolatedData - 補間データ用作業バッファ
 * @param {Float32Array} tempSmoothedData - スムージング用作業バッファ
 * @param {Float32Array | null} prefixSum - 累積和用作業バッファ
 * @param {object} calcCtx - 事前計算コンテキスト
 * @returns {Uint16Array} バー高さ配列
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

  // 1. 対数補間
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

  // 2. アタック / ディケイ
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

  // 3. スムースカーブ
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

  // 4. 各バーの高さ計算
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
 * バーの高さとキャンバス基準長からHSLカラー文字列を計算する純粋関数
 * @param {number} barHeight - バーの高さ
 * @param {number} referenceLength - 基準長さ（キャンバス高さまたは半径）
 * @param {number} peakBrightnessScale - ピーク輝度スケール
 * @param {number} currentHue - 色相
 * @returns {string} HSLカラー文字列
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

    // 第1層キャッシュ: 全フレームの生周波数ビンデータ (連続バッファおよびビュー配列)
    this.rawFrequencyBuffer = null;
    this.cachedRawFrequencyFrames = [];

    // 第2層キャッシュ: 現在の設定に基づいて計算された各フレームのバー高さ配列
    this.recordedBarHeights = [];

    // カスタムバー描画関数 (バーエディター連動用・引き伸ばし歪み防止)
    this.customBarDrawer = null;

    // 解析状態フラグ
    this.isAnalyzing = false;
    this.audioDuration = 0;
    this.sampleRate = 44100;

    // 非同期再計算および即時プレビュー用状態
    this.recomputeTaskId = 0;
    this.isRecomputing = false;
    this.recomputePromise = null;
    this.previewBarHeights = null;
    this.previewFrameIndex = -1;

    // 設定値
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
   * 設定値を更新し、即時1フレームプレビューの描画と全フレームのバックグラウンド非同期再計算を開始します
   * @param {object} newSettings - 新しい設定オブジェクト
   * @param {number | null} currentTimeSeconds - 現在の再生位置（秒）
   * @param {HTMLCanvasElement | null} canvas - 描画先Canvas
   * @param {CanvasRenderingContext2D | null} ctx - 2D描画コンテキスト
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
      // 1. 現在再生位置の1フレームのみを0.05msで即座に計算してCanvasに即反映（遅延0msの即時プレビュー）
      if (currentTimeSeconds !== null && canvas && ctx) {
        this.renderInstantPreview(currentTimeSeconds, canvas, ctx);
      }

      // 2. 全フレームの再計算をバックグラウンドで非同期分割実行（メインスレッドをブロックせず60FPS維持）
      this.recomputePromise = this.recomputeBarHeightsAsync();
    } else if (currentTimeSeconds !== null && canvas && ctx) {
      // 周波数の再計算が不要な表示設定変更（プレビュー形式・色・ピーク輝度など）の場合、瞬時に描画を更新 (遅延0ms)
      this.drawAtTime(currentTimeSeconds, canvas, ctx);
    }
  }

  /**
   * AudioContext を初期化します
   */
  ensureAudioContext() {
    if (!this.audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioContextClass();
    }
    return this.audioContext;
  }

  /**
   * AudioContext のサスペンドを解除します
   */
  async resumeContext() {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  /**
   * 記録済みの波形高さデータを取得します
   * @returns {number[][]}
   */
  getRecordedBarHeights() {
    return this.recordedBarHeights;
  }

  /**
   * データが解析済みかどうかを判定します
   * @returns {boolean}
   */
  hasAnalyzedData() {
    return (
      this.recordedBarHeights.length > 0 ||
      (this.cachedRawFrequencyFrames && this.cachedRawFrequencyFrames.length > 0)
    );
  }

  /**
   * AudioBuffer から PCM データを抽出してモノラル化します
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
   * オフライン解析を実行します（マルチスレッド並列処理を優先、非対応時はシングルスレッドへ自動フォールバック）
   * @param {AudioBuffer} audioBuffer - デコード済みのAudioBuffer
   * @param {Function} onProgress - 進捗コールバック (0.0 〜 1.0)
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

    // フォールバック: メインスレッド非同期処理
    await this.analyzeOfflineSingleThread(audioBuffer, onProgress);
    this.isAnalyzing = false;
  }

  /**
   * Web Workers によるマルチスレッド並列オフライン解析
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

    // 連続メモリバッファの確保
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
            // 連続メモリ領域へ直接配置
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

        // Workerへタスク送信
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

    // フレーム参照配列の構築（ゼロコピー・subarray参照）
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
   * メインスレッド非同期オフライン解析（フォールバック用）
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
   * 現在の再生位置に対応する1フレームのみを即座に計算し、Canvasに描画します（遅延0msの即時プレビュー）
   * @param {number} currentTimeSeconds - 再生位置（秒）
   * @param {HTMLCanvasElement} canvas - 描画先Canvas
   * @param {CanvasRenderingContext2D} ctx - 2D描画コンテキスト
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
   * 指定したフレーム番号のバー高さをアタック・ディケイの収束を考慮して高速に局所計算します (約0.05ms)
   * @param {number} targetFrameIndex - 算出対象のフレームインデックス
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
   * 全フレームのバー高さをバックグラウンドで非同期分割計算します (タイムスライス & キャンセル対応)
   * メインスレッドを占有せず、各チャンク間でブラウザの画面描画・イベント処理へ制御を戻します
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
        // チャンク境界ごとにメインスレッドへ制御を一時譲渡（UIブロックを防止し60FPS維持）
        if (frameIdx > 0 && frameIdx % RECOMPUTE_CHUNK_SIZE === 0) {
          await yieldToMainThread();
          // 他のパラメータ操作で新しいタスクが開始された場合は即座にアボート（キャンセル）
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

      // 完了時にアトミックにデータを差し替え
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
   * キャッシュされた生周波数データから、現在の設定に基づいてバー高さを同期再計算します (初期化・テスト用)
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
   * 実行中の非同期再計算が完了するまで待機します (保存処理用)
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
   * 指定した再生時刻（秒）に対応するフレームの波形をプレビュー描画します
   * @param {number} currentTimeSeconds - 再生位置（秒）
   * @param {HTMLCanvasElement} canvas - 描画先Canvas
   * @param {CanvasRenderingContext2D} ctx - 2D描画コンテキスト
   */
  drawAtTime(currentTimeSeconds, canvas, ctx) {
    const frameIndex = Math.floor(currentTimeSeconds * this.settings.targetFPS);
    this.drawFrame(frameIndex, canvas, ctx);
  }

  /**
   * カスタムバー描画関数を設定します（引き伸ばしによる角丸等の歪みを防ぐ処理用）
   * @param {Function | null} drawerFunc - (ctx, x, y, width, height) => void
   */
  setCustomBarDrawer(drawerFunc) {
    this.customBarDrawer = drawerFunc;
  }

  /**
   * 波型1 (通常波形・下端基準) の描画を行います
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
   * 波型2 (上下対称・垂直中央基準) の描画を行います
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
        // 上半分 (通常向き)
        this.customBarDrawer(ctx, posX, centerY - halfH, barThickness, halfH);
        // 下半分 (上下反転)
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
   * 円型1 (円形・外側伸長) の描画を行います
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
   * 円型2 (円形・内外両方伸長) の描画を行います
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
        // 外側へ伸長
        this.customBarDrawer(ctx, -halfThickness, -halfH, barThickness, halfH);
        // 内側へ伸長 (反転)
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
   * 円型3 (円形・内側伸長) の描画を行います
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
   * 指定したインデックスのフレームをCanvasに描画します
   * @param {number} frameIndex - フレーム番号
   * @param {HTMLCanvasElement} canvas - 描画先Canvas
   * @param {CanvasRenderingContext2D} ctx - 2D描画コンテキスト
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
