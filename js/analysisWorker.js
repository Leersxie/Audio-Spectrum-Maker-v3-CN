/**
 * 离线解析 Web Worker 模块
 * 在多线程环境中，对分配给各线程的帧范围并行执行 FFT 解析。
 */

import { DEFAULT_FFT_SIZE } from './constants.js';
import { FastFFT } from './fft.js';

const fastFft = new FastFFT(DEFAULT_FFT_SIZE);
const halfFftSize = DEFAULT_FFT_SIZE / 2;
const realInput = new Float32Array(DEFAULT_FFT_SIZE);
const realOut = new Float32Array(DEFAULT_FFT_SIZE);
const imagOut = new Float32Array(DEFAULT_FFT_SIZE);

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'ANALYZE') {
    return;
  }

  const {
    taskId,
    pcmData,
    sampleRate,
    targetFps,
    startFrame,
    endFrame,
    totalSamples
  } = data;

  const frameCount = endFrame - startFrame + 1;
  const outputBytes = new Uint8Array(frameCount * halfFftSize);

  for (let f = 0; f < frameCount; f++) {
    const frameIdx = startFrame + f;
    const centerSample = Math.round((frameIdx * sampleRate) / targetFps);
    const startSample = centerSample - halfFftSize;

    for (let i = 0; i < DEFAULT_FFT_SIZE; i++) {
      const sampleIdx = startSample + i;
      realInput[i] = sampleIdx >= 0 && sampleIdx < totalSamples ? pcmData[sampleIdx] : 0;
    }

    fastFft.realTransform(realInput, realOut, imagOut);
    fastFft.getByteFrequencyData(realOut, imagOut, outputBytes, f * halfFftSize);

    // 每 100 帧通知一次进度
    if (f > 0 && f % 100 === 0) {
      self.postMessage({
        type: 'PROGRESS',
        taskId,
        framesDone: f
      });
    }
  }

  // 通过 Transferable Object 进行零拷贝传输，返回结果
  self.postMessage(
    {
      type: 'COMPLETE',
      taskId,
      startFrame,
      endFrame,
      outputBytes
    },
    [outputBytes.buffer]
  );
});
