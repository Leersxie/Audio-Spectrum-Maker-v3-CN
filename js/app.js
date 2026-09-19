/**
 * 主应用程序模块
 * 负责 UI 事件处理、高速离线分析、预览播放的联动。
 */

import { hexToHsl, debounce } from './utils.js';
import {
  SETTINGS_INPUT_DEBOUNCE_MS,
  DEFAULT_BAR_COLOR,
  DEFAULT_BAR_THICKNESS,
  DEFAULT_PREVIEW_MODE,
  PREVIEW_MODE_CLASS_MAP
} from './constants.js';
import { processRecordedBarHeights } from './encoder.js';
import { AudioVisualizer } from './audioVisualizer.js';
import { loadBaseSb3, exportAsWaveformTxt, exportAsScratchSb3 } from './exporter.js';
import { BarEditor } from './barEditor.js';

// DOM 元素的引用
const audioFileInput = document.getElementById('audioFile');
const selectedFileNameDisplay = document.getElementById('selectedFileNameDisplay');
const audioPlayer = document.getElementById('audioPlayer');
const canvas = document.getElementById('audioSpectrum');
const ctx = canvas.getContext('2d');
const saveBarHeightsButton = document.getElementById('saveBarHeightsButton');
const recordStartButton = document.getElementById('recordStartButton');
const recordStartButtonText = document.getElementById('recordStartButtonText');
const recordFormatSb3Radio = document.querySelector('input[name="recordFormat"][value="sb3"]');
const logToggleButton = document.getElementById('logToggleButton');
const logContainer = document.getElementById('logContainer');
const logMessages = document.getElementById('logMessages');

// 加载遮罩层相关元素
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingMessage = document.getElementById('loadingMessage');
const loadingSubMessage = document.getElementById('loadingSubMessage');

// 进度条相关元素
const progressContainer = document.getElementById('progressContainer');
const progressStatusText = document.getElementById('progressStatusText');
const progressPercentText = document.getElementById('progressPercentText');
const progressBar = document.getElementById('progressBar');

// 主题切换相关 (Google Material You / M3 规范)
const STORAGE_KEY_THEME = 'waveform_maker_theme';
const themeToggleButton = document.getElementById('themeToggleButton');
const themeSunIcon = document.getElementById('themeSunIcon');
const themeMoonIcon = document.getElementById('themeMoonIcon');

/**
 * 将指定的主题 ('light' | 'dark') 应用到文档及 UI
 * @param {'light' | 'dark'} theme
 */
function applyTheme(theme) {
  const isDark = theme === 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  if (isDark) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }

  // ☀️/🌙 图标的切换 (深色时用太阳图标暗示可切回浅色)
  if (themeSunIcon && themeMoonIcon) {
    if (isDark) {
      themeSunIcon.classList.remove('hidden');
      themeMoonIcon.classList.add('hidden');
    } else {
      themeSunIcon.classList.add('hidden');
      themeMoonIcon.classList.remove('hidden');
    }
  }

  try {
    localStorage.setItem(STORAGE_KEY_THEME, theme);
  } catch (error) {
    console.warn('localStorage へのテーマ保存に失敗しました:', error);
  }
}

/**
 * 主题的初始化 (从 localStorage 或 OS 设置反映)
 */
function initTheme() {
  let savedTheme = null;
  try {
    savedTheme = localStorage.getItem(STORAGE_KEY_THEME);
  } catch (error) {
    console.warn('localStorage からのテーマ読み込みに失敗しました:', error);
  }

  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initialTheme = savedTheme === 'dark' || savedTheme === 'light'
    ? savedTheme
    : (prefersDark ? 'dark' : 'light');

  applyTheme(initialTheme);

  if (themeToggleButton) {
    themeToggleButton.addEventListener('click', () => {
      const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
      const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
      applyTheme(nextTheme);
    });
  }

  // 监控 OS 设置变更
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    let currentSaved = null;
    try {
      currentSaved = localStorage.getItem(STORAGE_KEY_THEME);
    } catch (_) {}
    if (!currentSaved) {
      applyTheme(e.matches ? 'dark' : 'light');
    }
  });
}

// 设置输入元素的引用
const previewModeSelect = document.getElementById('previewModeSelect');
const minFreqInput = document.getElementById('minFreqInput');
const maxFreqInput = document.getElementById('maxFreqInput');
const numBarsInput = document.getElementById('numBarsInput');
const samplingMethodSelect = document.getElementById('samplingMethodSelect');
const barHeightScaleInput = document.getElementById('barHeightScaleInput');
const attackInput = document.getElementById('attackInput');
const decayInput = document.getElementById('decayInput');
const peakBrightnessInput = document.getElementById('peakBrightnessInput');
const smoothCurveInput = document.getElementById('smoothCurveInput');
const freqCompensationInput = document.getElementById('freqCompensationInput');
const fpsInput = document.getElementById('fpsInput');
const intervalInput = document.getElementById('intervalInput');

// 应用程序状态
const visualizer = new AudioVisualizer();
const barEditor = new BarEditor();
let isCustomBarApplied = false;
let selectedAudioFile = null;
let decodedAudioBuffer = null;
let baseSb3Content = null;
let previewAnimationFrameId = null;

/**
 * 使用当前的条柱编辑器设置预烘焙精灵缓存，并应用到可视化器
 * @param {number} targetWidth - 条柱的粗细 (px)
 */
function applyBarEditorToVisualizer(targetWidth, targetBrightness) {
  const width = Math.max(1, targetWidth || barEditor.width || DEFAULT_BAR_THICKNESS);
  barEditor.width = width;
  const maxHeight = Math.max(350, Math.ceil(canvas.height || 240));
  const peakBrightness = targetBrightness !== undefined
    ? targetBrightness
    : parseFloat(peakBrightnessInput.value);

  barEditor.lastBakedBrightness = peakBrightness;
  const bakedCache = barEditor.bakeSpriteCache(
    maxHeight,
    width,
    peakBrightness,
    canvas.height || maxHeight
  );

  visualizer.setCustomBarDrawer((targetCtx, x, y, w, h) => {
    bakedCache.draw(targetCtx, x, y, w, h);
  });
  isCustomBarApplied = true;
}

/**
 * 显示用于阻塞操作的加载遮罩层
 * @param {string} message - 主消息
 * @param {string} subMessage - 补充消息
 */
function showLoading(message, subMessage = '') {
  if (!loadingOverlay) return;
  if (loadingMessage) loadingMessage.textContent = message;
  if (loadingSubMessage) loadingSubMessage.textContent = subMessage;

  loadingOverlay.classList.remove('hidden');
  // 用于过渡的延迟
  requestAnimationFrame(() => {
    loadingOverlay.classList.remove('opacity-0', 'pointer-events-none');
  });
}

/**
 * 隐藏加载遮罩层并解除界面操作锁定
 */
function hideLoading() {
  if (!loadingOverlay) return;
  loadingOverlay.classList.add('opacity-0', 'pointer-events-none');
  setTimeout(() => {
    loadingOverlay.classList.add('hidden');
  }, 300);
}

/**
 * 向日志容器添加消息 (不使用 innerHTML，安全地进行 DOM 操作)
 * @param {string} message - 日志正文
 * @param {'info' | 'warning' | 'error'} type - 日志类型
 */
function logMessage(message, type = 'info') {
  const messageElement = document.createElement('div');
  messageElement.className = 'log-message';

  if (type === 'error') {
    messageElement.classList.add('error');
  } else if (type === 'warning') {
    messageElement.classList.add('warning');
  }

  messageElement.textContent = message;
  logMessages.prepend(messageElement);
}

let canvasMorphRafId = null;

/**
 * 根据波形预览形式切换 Canvas 的显示区域样式 (正方形/横向)
 * 在 CSS 过渡期间，通过 requestAnimationFrame 同步内部分辨率，实现平滑的变形效果
 * @param {string} previewMode - 预览形式
 */
function updateCanvasLayoutForPreviewMode(previewMode) {
  const targetClass = PREVIEW_MODE_CLASS_MAP[previewMode] || PREVIEW_MODE_CLASS_MAP[DEFAULT_PREVIEW_MODE];
  if (!canvas.classList.contains(targetClass)) {
    Object.values(PREVIEW_MODE_CLASS_MAP).forEach((cls) => canvas.classList.remove(cls));
    canvas.classList.add(targetClass);

    if (canvasMorphRafId) {
      cancelAnimationFrame(canvasMorphRafId);
    }
    const startTime = performance.now();
    const morphDurationMs = 390;

    function stepMorph(currentTime) {
      const elapsed = currentTime - startTime;
      const isDone = elapsed >= morphDurationMs;
      // 变形过程中跳过精灵重新预烘焙以维持 60FPS，并在结束时仅执行一次
      resizeCanvas(!isDone);
      if (!isDone) {
        canvasMorphRafId = requestAnimationFrame(stepMorph);
      } else {
        canvasMorphRafId = null;
      }
    }
    canvasMorphRafId = requestAnimationFrame(stepMorph);
  }
}

/**
 * 通过平滑的缩放＆淡入淡出动画打开模态对话框
 * @param {HTMLElement} modalElement
 */
function openModalSmooth(modalElement) {
  if (!modalElement) return;
  modalElement.classList.remove('hidden');
  requestAnimationFrame(() => {
    modalElement.classList.add('is-open');
  });
}

/**
 * 通过平滑的缩放＆淡入淡出动画关闭模态对话框
 * @param {HTMLElement} modalElement
 */
function closeModalSmooth(modalElement) {
  if (!modalElement) return;
  modalElement.classList.remove('is-open');
  setTimeout(() => {
    modalElement.classList.add('hidden');
  }, 280);
}

/**
 * 从输入表单获取最新设置值并反映到可视化器
 * 若存在缓存数据，则立即重新计算并更新 Canvas 预览
 */
function updateSettingsFromUi() {
  const previewMode = previewModeSelect ? previewModeSelect.value : DEFAULT_PREVIEW_MODE;
  updateCanvasLayoutForPreviewMode(previewMode);

  const barThickness = isCustomBarApplied
    ? (barEditor.width || DEFAULT_BAR_THICKNESS)
    : DEFAULT_BAR_THICKNESS;
  const peakBrightness = parseFloat(peakBrightnessInput.value);

  // 应用自定义条柱时，若峰值辉度发生变更则立即重新预烘焙并反映到波形
  if (isCustomBarApplied && barEditor.lastBakedBrightness !== peakBrightness) {
    applyBarEditorToVisualizer(barThickness, peakBrightness);
  }

  const hsl = hexToHsl(DEFAULT_BAR_COLOR);
  const currentHue = hsl[0];

  visualizer.updateSettings(
    {
      minFrequency: parseFloat(minFreqInput.value),
      maxFrequency: parseFloat(maxFreqInput.value),
      numBars: parseInt(numBarsInput.value, 10),
      barThickness,
      barHeightScale: parseFloat(barHeightScaleInput.value),
      attackTimeConstant: parseFloat(attackInput.value),
      decayTimeConstant: parseFloat(decayInput.value),
      peakBrightnessScale: peakBrightness,
      smoothCurve: parseFloat(smoothCurveInput.value),
      freqCompensation: parseFloat(freqCompensationInput.value),
      targetFPS: parseInt(fpsInput.value, 10),
      currentHue,
      samplingMethod: samplingMethodSelect ? samplingMethodSelect.value : 'peak',
      previewMode
    },
    audioPlayer.currentTime,
    canvas,
    ctx
  );
}

/**
 * 将 Canvas 的绘制区域大小同步为元素的显示大小
 * @param {boolean} skipRebake - 是否暂时抑制动画期间的精灵重新预烘焙
 */
function resizeCanvas(skipRebake = false) {
  const newWidth = canvas.offsetWidth;
  const newHeight = canvas.offsetHeight;
  if (newWidth <= 0 || newHeight <= 0) {
    return;
  }
  const isSizeChanged = canvas.width !== newWidth || canvas.height !== newHeight;
  canvas.width = newWidth;
  canvas.height = newHeight;

  if (isCustomBarApplied && isSizeChanged && !skipRebake) {
    applyBarEditorToVisualizer();
  }
  if (visualizer.hasAnalyzedData()) {
    visualizer.drawAtTime(audioPlayer.currentTime, canvas, ctx);
  }
}

/**
 * 与音频播放同步的预览绘制动画循环
 */
function startPreviewLoop() {
  if (previewAnimationFrameId) {
    cancelAnimationFrame(previewAnimationFrameId);
  }

  function loop() {
    if (visualizer.hasAnalyzedData()) {
      visualizer.drawAtTime(audioPlayer.currentTime, canvas, ctx);
    }
    if (!audioPlayer.paused && !audioPlayer.ended) {
      previewAnimationFrameId = requestAnimationFrame(loop);
    }
  }

  previewAnimationFrameId = requestAnimationFrame(loop);
}

/**
 * 执行高速离线分析
 */
async function handleStartFastAnalysis() {
  if (!decodedAudioBuffer) {
    logMessage('尚未载入要解析的音频数据。', 'error');
    return;
  }

  recordStartButton.disabled = true;
  saveBarHeightsButton.disabled = true;
  progressContainer.classList.remove('hidden');
  progressBar.style.width = '0%';
  progressPercentText.textContent = '0%';
  progressStatusText.textContent = '正在高速解析频率...';
  showLoading('正在高速解析频率...', '正在提取所有帧的频谱');

  const startTime = performance.now();

  try {
    await visualizer.analyzeOffline(decodedAudioBuffer, (progress) => {
      const percent = Math.round(progress * 100);
      progressBar.style.width = `${percent}%`;
      progressPercentText.textContent = `${percent}%`;
    });

    const elapsedSeconds = ((performance.now() - startTime) / 1000).toFixed(2);
    progressStatusText.textContent = `解析完成 (${elapsedSeconds}秒)`;
    logMessage(
      `高速解析完成 (耗时: ${elapsedSeconds}秒, 共 ${visualizer.getRecordedBarHeights().length} 帧)。`
    );

    saveBarHeightsButton.disabled = false;
    recordStartButton.disabled = false;
    if (recordStartButtonText) {
      recordStartButtonText.textContent = '重新解析';
    }

    // 将分析完成后的首帧在 Canvas 上预览绘制
    visualizer.drawAtTime(audioPlayer.currentTime, canvas, ctx);
    hideLoading();
  } catch (error) {
    console.error('高速解析中にエラーが発生しました:', error);
    logMessage(`高速解析失败: ${error.message}`, 'error');
    progressStatusText.textContent = '解析出错';
    recordStartButton.disabled = false;
    hideLoading();
  }
}

/**
 * 执行保存处理
 */
async function handleSave() {
  const selectedFormatElement = document.querySelector('input[name="recordFormat"]:checked');
  const selectedFormat = selectedFormatElement ? selectedFormatElement.value : 'waveform';
  // 若后台正在进行异步重算，则等待其完成
  if (visualizer.isRecomputing) {
    showLoading('正在生成波形数据...', '正在用最新参数计算所有帧');
    try {
      await visualizer.waitForRecomputation();
    } finally {
      hideLoading();
    }
  }

  const recordedHeights = visualizer.getRecordedBarHeights();

  if (recordedHeights.length === 0) {
    logMessage('没有要保存的波形数据，请先执行「开始高速解析」。', 'warning');
    return;
  }

  const samplingInterval = parseInt(intervalInput.value, 10) || 1;
  const processedDataArray = processRecordedBarHeights(recordedHeights, samplingInterval);

  const numBars = numBarsInput.value;
  const barThickness = isCustomBarApplied
    ? (barEditor.width || DEFAULT_BAR_THICKNESS)
    : DEFAULT_BAR_THICKNESS;
  const barHeightScale = barHeightScaleInput.value;
  const targetFps = fpsInput.value;
  const barColor = DEFAULT_BAR_COLOR;
  const settingsHeader = `?,${numBars},${barThickness},${barHeightScale},${targetFps},${barColor}`;

  try {
    if (selectedFormat === 'waveform') {
      exportAsWaveformTxt(processedDataArray, settingsHeader);
      logMessage('波形数据已保存为 spectrum_data.txt。');
    } else if (selectedFormat === 'sb3') {
      if (!baseSb3Content) {
        logMessage('尚未载入用作基底的 .sb3 文件。', 'error');
        return;
      }
      if (!selectedAudioFile) {
        logMessage('尚未选择音频源文件。', 'error');
        return;
      }

      const newSb3Blob = await exportAsScratchSb3(
        baseSb3Content,
        selectedAudioFile,
        processedDataArray,
        settingsHeader
      );
      logMessage('波形数据已保存为 audio_spectrum.sb3。');
    }
  } catch (error) {
    console.error('保存処理中にエラーが発生しました:', error);
    logMessage(`保存失败: ${error.message}`, 'error');
  }
}

const INITIAL_FILE_DISPLAY_TEXT = '请选择音频文件 (.mp3, .wav, .aac, .flac ...)';

/**
 * 音频文件选择事件的处理函数
 */
async function handleAudioFileChange(event) {
  const file = event.target.files[0];
  if (file) {
    selectedAudioFile = file;
    if (selectedFileNameDisplay) {
      selectedFileNameDisplay.textContent = file.name;
    }
    const fileUrl = URL.createObjectURL(file);
    audioPlayer.src = fileUrl;
    audioPlayer.load();

    recordStartButton.disabled = true;
    saveBarHeightsButton.disabled = true;
    progressContainer.classList.add('hidden');

    logMessage(`正在解码音频源文件「${file.name}」...`);
    showLoading('正在载入音频源...', '正在解码音频数据');

    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioCtx = visualizer.ensureAudioContext();
      decodedAudioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

      logMessage(
        `解码完成 (播放时长: ${Math.round(decodedAudioBuffer.duration)}秒)。将自动开始高速解析...`
      );

      // 选择文件后自动执行高速分析
      await handleStartFastAnalysis();
    } catch (decodeError) {
      console.error('オーディオデコードエラー:', decodeError);
      logMessage(`音频源解码失败: ${decodeError.message}`, 'error');
      hideLoading();
    }
  } else {
    selectedAudioFile = null;
    decodedAudioBuffer = null;
    if (selectedFileNameDisplay) {
      selectedFileNameDisplay.textContent = INITIAL_FILE_DISPLAY_TEXT;
    }
    recordStartButton.disabled = true;
    saveBarHeightsButton.disabled = true;
    audioPlayer.src = '';
    hideLoading();
  }
}

/**
 * 条柱编辑器的 UI 及功能设置 (AviUtl 风格特效堆栈)
 */
function setupBarEditor() {
  const openBarEditorButton = document.getElementById('openBarEditorButton');
  const barEditorModal = document.getElementById('barEditorModal');
  const closeBarEditorTopButton = document.getElementById('closeBarEditorTopButton');
  const barPreviewCanvas = document.getElementById('barPreviewCanvas');
  const barPreviewWrapper = document.getElementById('barPreviewWrapper');
  const previewBgButtons = document.querySelectorAll('.preview-bg-btn');

  // 基本设置元素 (滑杆 ＋ 数值输入)
  const baseBarWidthRange = document.getElementById('baseBarWidthRange');
  const baseBarWidthInput = document.getElementById('baseBarWidthInput');
  const baseBorderRadiusRange = document.getElementById('baseBorderRadiusRange');
  const baseBorderRadiusInput = document.getElementById('baseBorderRadiusInput');
  const baseColorInput = document.getElementById('baseColorInput');

  // 特效堆栈管理元素
  const availableEffectsSelect = document.getElementById('availableEffectsSelect');
  const addEffectButton = document.getElementById('addEffectButton');
  const effectCardsContainer = document.getElementById('effectCardsContainer');

  const applyBarToVisualizerButton = document.getElementById('applyBarToVisualizerButton');
  const downloadBarPngButton = document.getElementById('downloadBarPngButton');
  const resetBarEditorButton = document.getElementById('resetBarEditorButton');
  const presetButtons = document.querySelectorAll('.preset-btn');

  // 拖放管理用变量
  let draggedCardIndex = null;
  let draggedStopIndex = null;

  // 预览背景色切换 (棋盘格 / 黑 / 白)
  previewBgButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const bgType = btn.getAttribute('data-bg');
      previewBgButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      if (barPreviewWrapper) {
        barPreviewWrapper.classList.remove('checkerboard-bg', 'preview-black-bg', 'preview-white-bg');
        if (bgType === 'black') {
          barPreviewWrapper.classList.add('preview-black-bg');
        } else if (bgType === 'white') {
          barPreviewWrapper.classList.add('preview-white-bg');
        } else {
          barPreviewWrapper.classList.add('checkerboard-bg');
        }
      }
    });
  });

  // 预设的激活显示管理
  function setPresetActive(presetName) {
    presetButtons.forEach((btn) => {
      if (btn.getAttribute('data-preset') === presetName) {
        btn.classList.add('preset-active');
      } else {
        btn.classList.remove('preset-active');
      }
    });
  }

  function markPresetCustom() {
    presetButtons.forEach((btn) => btn.classList.remove('preset-active'));
  }

  function renderPreview() {
    if (barPreviewCanvas) {
      barEditor.renderToCanvas(barPreviewCanvas, barEditor.width, barEditor.height);
    }
  }

  function syncBaseUi() {
    if (baseBarWidthRange) baseBarWidthRange.value = barEditor.width;
    if (baseBarWidthInput) baseBarWidthInput.value = barEditor.width;
    if (baseBorderRadiusRange) baseBorderRadiusRange.value = barEditor.borderRadius;
    if (baseBorderRadiusInput) baseBorderRadiusInput.value = barEditor.borderRadius;
    if (baseColorInput) baseColorInput.value = barEditor.baseColor;
  }

  // 基本设置的双向绑定 (粗细: 滑杆 ＋ 数值输入)
  if (baseBarWidthRange && baseBarWidthInput) {
    baseBarWidthRange.addEventListener('input', () => {
      const val = parseInt(baseBarWidthRange.value, 10) || 24;
      baseBarWidthInput.value = val;
      barEditor.width = val;
      markPresetCustom();
      renderPreview();
    });
    baseBarWidthInput.addEventListener('input', () => {
      const val = parseInt(baseBarWidthInput.value, 10) || 24;
      baseBarWidthRange.value = val;
      barEditor.width = val;
      markPresetCustom();
      renderPreview();
    });
  }

  // 基本设置的双向绑定 (圆角: 滑杆 ＋ 数值输入)
  if (baseBorderRadiusRange && baseBorderRadiusInput) {
    baseBorderRadiusRange.addEventListener('input', () => {
      const val = parseInt(baseBorderRadiusRange.value, 10);
      const clamped = isNaN(val) ? 0 : Math.max(0, Math.min(100, val));
      baseBorderRadiusInput.value = clamped;
      barEditor.borderRadius = clamped;
      markPresetCustom();
      renderPreview();
    });
    baseBorderRadiusInput.addEventListener('input', () => {
      const val = parseInt(baseBorderRadiusInput.value, 10);
      const clamped = isNaN(val) ? 0 : Math.max(0, Math.min(100, val));
      baseBorderRadiusRange.value = clamped;
      barEditor.borderRadius = clamped;
      markPresetCustom();
      renderPreview();
    });
  }

  if (baseColorInput) {
    baseColorInput.addEventListener('input', () => {
      barEditor.baseColor = baseColorInput.value;
      markPresetCustom();
      renderPreview();
    });
  }

  /**
   * 生成滑杆 ＋ 内联单位数值输入栏的 UI 组合
   * @param {Object} options
   * @param {number} options.min
   * @param {number} options.max
   * @param {number} [options.step=1]
   * @param {number} options.value
   * @param {string} options.suffix - 单位字符串 ('px', '%', '°')
   * @param {Function} options.onInput - 值变更回调
   * @returns {HTMLElement}
   */
  function createSliderWithNumberInput({ min, max, step = 1, value, suffix, onInput }) {
    const container = document.createElement('div');
    container.className = 'flex items-center gap-2 w-full min-w-0';

    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    range.value = String(value);
    range.className = 'flex-1 min-w-[60px] accent-[#1A73E8] cursor-pointer h-1.5 bg-[#E8EAED] rounded';

    const suffixGroup = document.createElement('div');
    suffixGroup.className = 'input-suffix-group w-16 shrink-0';

    const num = document.createElement('input');
    num.type = 'number';
    num.min = String(min);
    num.max = String(max);
    num.step = String(step);
    num.value = String(value);
    num.className = 'text-center';

    const suffixSpan = document.createElement('span');
    suffixSpan.className = 'suffix-text';
    suffixSpan.textContent = suffix;

    suffixGroup.appendChild(num);
    suffixGroup.appendChild(suffixSpan);

    range.addEventListener('input', () => {
      const val = parseFloat(range.value);
      num.value = range.value;
      markPresetCustom();
      onInput(val);
    });

    num.addEventListener('input', () => {
      const val = parseFloat(num.value);
      if (!isNaN(val)) {
        range.value = String(val);
        markPresetCustom();
        onInput(val);
      }
    });

    container.appendChild(range);
    container.appendChild(suffixGroup);
    return container;
  }

  /**
   * 生成 AviUtl 风格特效卡片的 DOM (严格不使用 innerHTML)
   * @param {Object} effect
   * @param {number} index - 堆栈内的顺序索引
   * @param {number} totalCount - 特效的总数
   * @returns {HTMLElement}
   */
  function createEffectCardElement(effect, index = 0, totalCount = 1) {
    const card = document.createElement('div');
    card.className = 'effect-card theme-surface-card border theme-border rounded-xl overflow-hidden shadow-sm transition-all';
    card.draggable = false; // 仅在操作手柄时启用

    // 拖放排序事件监听器
    card.addEventListener('dragstart', (e) => {
      if (draggedStopIndex !== null) {
        e.preventDefault();
        return;
      }
      draggedCardIndex = index;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('type', 'effect-card');
      e.dataTransfer.setData('text/plain', String(index));
    });

    card.addEventListener('dragend', () => {
      card.draggable = false;
      draggedCardIndex = null;
      card.classList.remove('dragging');
      document.querySelectorAll('.effect-card').forEach((el) => {
        el.classList.remove('drag-over-top', 'drag-over-bottom', 'dragging');
      });
    });

    card.addEventListener('dragover', (e) => {
      // 颜色停靠点拖动中，或非卡片拖动时完全忽略
      if (draggedCardIndex === null || draggedStopIndex !== null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = card.getBoundingClientRect();
      const relY = e.clientY - rect.top;
      if (relY < rect.height / 2) {
        card.classList.add('drag-over-top');
        card.classList.remove('drag-over-bottom');
      } else {
        card.classList.add('drag-over-bottom');
        card.classList.remove('drag-over-top');
      }
    });

    card.addEventListener('dragleave', () => {
      if (draggedCardIndex === null || draggedStopIndex !== null) return;
      card.classList.remove('drag-over-top', 'drag-over-bottom');
    });

    card.addEventListener('drop', (e) => {
      if (draggedCardIndex === null || draggedStopIndex !== null) return;
      e.preventDefault();
      card.classList.remove('drag-over-top', 'drag-over-bottom');
      if (draggedCardIndex === index) {
        card.draggable = false;
        draggedCardIndex = null;
        return;
      }
      
      const rect = card.getBoundingClientRect();
      const relY = e.clientY - rect.top;
      let targetIndex = index;
      if (relY >= rect.height / 2 && draggedCardIndex < index) {
        targetIndex = index;
      } else if (relY < rect.height / 2 && draggedCardIndex > index) {
        targetIndex = index;
      }
      
      const fromIdx = draggedCardIndex;
      card.draggable = false;
      draggedCardIndex = null;

      barEditor.moveEffect(fromIdx, targetIndex);
      markPresetCustom();
      renderEffectCards();
      renderPreview();
    });

    // 1. 卡片头部
    const header = document.createElement('div');
    header.className = 'flex items-center justify-between theme-surface-container-low px-3 py-2 border-b theme-border';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'flex items-center gap-2';

    // 应用顺序徽标 (#1, #2, ...)
    const orderBadge = document.createElement('span');
    orderBadge.className = 'text-[10px] font-mono font-semibold theme-accent theme-surface-card border theme-border px-2 py-0.5 rounded-full shrink-0';
    orderBadge.textContent = `#${index + 1}`;

    const enableCheckbox = document.createElement('input');
    enableCheckbox.type = 'checkbox';
    enableCheckbox.checked = effect.enabled;
    enableCheckbox.className = 'rounded text-[#1A73E8] focus:ring-0 cursor-pointer accent-[#1A73E8] shrink-0';
    enableCheckbox.addEventListener('change', () => {
      barEditor.setEffectEnabled(effect.id, enableCheckbox.checked);
      markPresetCustom();
      renderPreview();
    });

    const titleSpan = document.createElement('span');
    titleSpan.className = 'text-xs font-medium theme-text-primary';
    titleSpan.textContent = effect.name;

    headerLeft.appendChild(orderBadge);
    headerLeft.appendChild(enableCheckbox);
    headerLeft.appendChild(titleSpan);

    // 头部右侧 (拖动标记 ＋ 删除按钮)
    const headerRight = document.createElement('div');
    headerRight.className = 'flex items-center gap-1';

    // 拖动标记 (⠿) - 仅当抓住这个标记时才启用卡片拖拽
    const dragHandle = document.createElement('span');
    dragHandle.className = 'drag-handle cursor-grab active:cursor-grabbing px-1.5 py-0.5 rounded text-xs select-none theme-text-secondary hover:text-[var(--color-google-blue)] hover:bg-[var(--surface-container-high)] transition-colors';
    dragHandle.title = '拖拽以调整应用顺序';
    dragHandle.textContent = '⠿';

    dragHandle.addEventListener('pointerdown', () => {
      card.draggable = true;
    });
    dragHandle.addEventListener('pointerup', () => {
      card.draggable = false;
    });

    // 删除按钮 (✕)
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'theme-text-secondary hover:text-[var(--color-google-red)] hover:bg-[var(--surface-container-high)] px-1.5 py-0.5 rounded transition-colors text-xs ml-0.5';
    deleteBtn.title = '删除该特效';
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', () => {
      barEditor.removeEffect(effect.id);
      markPresetCustom();
      renderEffectCards();
      renderPreview();
    });

    headerRight.appendChild(dragHandle);
    headerRight.appendChild(deleteBtn);

    header.appendChild(headerLeft);
    header.appendChild(headerRight);
    card.appendChild(header);

    // 2. 卡片主体 (参数设置组)
    const body = document.createElement('div');
    body.className = 'p-3 space-y-2.5 theme-surface-card';

    // 按类型构建参数 UI
    switch (effect.type) {
      case 'border': {
        const row = document.createElement('div');
        row.className = 'grid grid-cols-1 sm:grid-cols-12 gap-4 items-center';

        // 线条粗细 (滑杆 ＋ 数值输入)
        const widthCol = document.createElement('div');
        widthCol.className = 'sm:col-span-8 min-w-0';
        const widthLabel = document.createElement('label');
        widthLabel.className = 'text-xs theme-text-secondary block mb-1 font-medium';
        widthLabel.textContent = '粗细:';

        const widthSliderUi = createSliderWithNumberInput({
          min: 1,
          max: 50,
          value: effect.params.width,
          suffix: 'px',
          onInput: (val) => {
            barEditor.setEffectParam(effect.id, 'width', parseInt(val, 10) || 1);
            renderPreview();
          }
        });
        widthCol.appendChild(widthLabel);
        widthCol.appendChild(widthSliderUi);

        // 边框颜色
        const colorCol = document.createElement('div');
        colorCol.className = 'sm:col-span-4 min-w-0';
        const colorLabel = document.createElement('label');
        colorLabel.className = 'text-xs theme-text-secondary block mb-1 font-medium';
        colorLabel.textContent = '描边颜色:';
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.value = effect.params.color;
        colorInput.className = 'w-full h-7 p-0.5 theme-surface-base rounded-lg border theme-border cursor-pointer';
        colorInput.addEventListener('input', () => {
          barEditor.setEffectParam(effect.id, 'color', colorInput.value);
          markPresetCustom();
          renderPreview();
        });
        colorCol.appendChild(colorLabel);
        colorCol.appendChild(colorInput);

        row.appendChild(widthCol);
        row.appendChild(colorCol);
        body.appendChild(row);
        break;
      }

      case 'glow': {
        const row = document.createElement('div');
        row.className = 'grid grid-cols-1 sm:grid-cols-12 gap-4 items-center';

        // 发光颜色
        const colorCol = document.createElement('div');
        colorCol.className = 'sm:col-span-3 min-w-0';
        const colorLabel = document.createElement('label');
        colorLabel.className = 'text-xs theme-text-secondary block mb-1 font-medium';
        colorLabel.textContent = '発光色:';
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.value = effect.params.color;
        colorInput.className = 'w-full h-7 p-0.5 theme-surface-base rounded-lg border theme-border cursor-pointer';
        colorInput.addEventListener('input', () => {
          barEditor.setEffectParam(effect.id, 'color', colorInput.value);
          markPresetCustom();
          renderPreview();
        });
        colorCol.appendChild(colorLabel);
        colorCol.appendChild(colorInput);

        // 模糊宽度 (滑杆 ＋ 数值输入)
        const blurCol = document.createElement('div');
        blurCol.className = 'sm:col-span-6 min-w-0';
        const blurLabel = document.createElement('label');
        blurLabel.className = 'text-xs theme-text-secondary block mb-1 font-medium';
        blurLabel.textContent = '模糊:';

        const blurSliderUi = createSliderWithNumberInput({
          min: 0,
          max: 60,
          value: effect.params.blur,
          suffix: 'px',
          onInput: (val) => {
            barEditor.setEffectParam(effect.id, 'blur', parseInt(val, 10) || 0);
            renderPreview();
          }
        });
        blurCol.appendChild(blurLabel);
        blurCol.appendChild(blurSliderUi);

        // 强度 (Bloom)
        const intensityCol = document.createElement('div');
        intensityCol.className = 'sm:col-span-3 min-w-0';
        const intensityLabel = document.createElement('label');
        intensityLabel.className = 'text-xs theme-text-secondary block mb-1 font-medium';
        intensityLabel.textContent = '強度 (Bloom):';
        const intensitySelect = document.createElement('select');
        intensitySelect.className = 'w-full theme-surface-base theme-text-primary p-1.5 rounded-lg border theme-border text-xs focus:border-[var(--color-google-blue)] outline-none';
        const options = [
          { val: 1, text: '通常 (1x)' },
          { val: 2, text: '強 (2x)' },
          { val: 3, text: '極強 (3x)' }
        ];
        options.forEach((opt) => {
          const o = document.createElement('option');
          o.value = opt.val;
          o.textContent = opt.text;
          if (effect.params.intensity === opt.val) o.selected = true;
          intensitySelect.appendChild(o);
        });
        intensitySelect.addEventListener('change', () => {
          barEditor.setEffectParam(effect.id, 'intensity', parseInt(intensitySelect.value, 10) || 1);
          markPresetCustom();
          renderPreview();
        });
        intensityCol.appendChild(intensityLabel);
        intensityCol.appendChild(intensitySelect);

        row.appendChild(colorCol);
        row.appendChild(blurCol);
        row.appendChild(intensityCol);
        body.appendChild(row);
        break;
      }

      case 'gradient': {
        // 确保渐变停下点数组初始化
        if (!Array.isArray(effect.params.stops)) {
          effect.params.stops = barEditor.getNormalizedGradientStops(effect.params);
        }
        if (typeof effect.params.opacity !== 'number') {
          effect.params.opacity = 100;
        }

        const gradContainer = document.createElement('div');
        gradContainer.className = 'space-y-2.5';

        // 1. 角度设置行 (独立成行以避免重叠)
        const angleRow = document.createElement('div');
        angleRow.className = 'flex items-center justify-between gap-4 pb-2.5 border-b theme-border';

        const angleLeft = document.createElement('div');
        angleLeft.className = 'flex items-center gap-2 shrink-0';
        const angleLabel = document.createElement('label');
        angleLabel.className = 'text-xs theme-text-secondary whitespace-nowrap font-medium';
        angleLabel.textContent = '角度:';

        const angleSuffixGroup = document.createElement('div');
        angleSuffixGroup.className = 'input-suffix-group w-16';
        const angleInput = document.createElement('input');
        angleInput.type = 'number';
        angleInput.value = effect.params.angle || 0;
        angleInput.min = '0';
        angleInput.max = '360';
        angleInput.step = '15';
        angleInput.className = 'text-center';
        const degSpan = document.createElement('span');
        degSpan.className = 'suffix-text';
        degSpan.textContent = '°';
        angleSuffixGroup.appendChild(angleInput);
        angleSuffixGroup.appendChild(degSpan);

        angleLeft.appendChild(angleLabel);
        angleLeft.appendChild(angleSuffixGroup);
        angleRow.appendChild(angleLeft);

        angleInput.addEventListener('input', () => {
          barEditor.setEffectParam(effect.id, 'angle', parseInt(angleInput.value, 10) || 0);
          markPresetCustom();
          updateMiniPreview();
          renderPreview();
        });

        // 快捷角度按钮 (0°, 90°, 45°)
        const quickAngles = [
          { label: '↓ 0°', val: 0 },
          { label: '→ 90°', val: 90 },
          { label: '↘ 45°', val: 45 }
        ];
        const quickBtns = document.createElement('div');
        quickBtns.className = 'flex items-center gap-1.5 shrink-0';
        quickAngles.forEach((qa) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'text-[11px] px-2.5 py-1 theme-surface-container-low hover:bg-[var(--surface-container-high)] theme-text-primary border theme-border rounded-full transition-colors font-medium';
          btn.textContent = qa.label;
          btn.addEventListener('click', () => {
            angleInput.value = qa.val;
            barEditor.setEffectParam(effect.id, 'angle', qa.val);
            markPresetCustom();
            updateMiniPreview();
            renderPreview();
          });
          quickBtns.appendChild(btn);
        });
        angleRow.appendChild(quickBtns);
        gradContainer.appendChild(angleRow);

        // 2. 不透明度设置行 (滑杆 ＋ 数值输入)
        const opacityRow = document.createElement('div');
        opacityRow.className = 'flex items-center gap-3 pb-2.5 border-b theme-border';

        const opLabel = document.createElement('label');
        opLabel.className = 'text-xs theme-text-secondary whitespace-nowrap font-medium shrink-0';
        opLabel.textContent = '不透明度:';

        const opSliderUi = createSliderWithNumberInput({
          min: 10,
          max: 100,
          value: effect.params.opacity,
          suffix: '%',
          onInput: (val) => {
            barEditor.setEffectParam(effect.id, 'opacity', val);
            renderPreview();
          }
        });

        opacityRow.appendChild(opLabel);
        opacityRow.appendChild(opSliderUi);
        gradContainer.appendChild(opacityRow);

        // 3. 迷你预览条＆固定点操作轨道 (Figma/Photoshop 风格交互)
        const previewArea = document.createElement('div');
        previewArea.className = 'w-full space-y-1';

        const barHint = document.createElement('div');
        barHint.className = 'text-[10px] theme-text-secondary flex items-center justify-between';
        barHint.textContent = '点击条柱可添加固定点，拖拽固定点可调整位置';
        previewArea.appendChild(barHint);

        // 迷你预览条本体 (点击添加固定点)
        const previewBar = document.createElement('div');
        previewBar.className = 'w-full h-5 rounded-lg border theme-border shadow-inner cursor-crosshair transition-all relative overflow-hidden';
        previewBar.title = '点击添加颜色停靠点';
        previewArea.appendChild(previewBar);

        // 固定点轨道 (固定点左右移动的轨道)
        const pinTrack = document.createElement('div');
        pinTrack.className = 'grad-pin-track';
        previewArea.appendChild(pinTrack);

        gradContainer.appendChild(previewArea);

        let selectedStopIndex = 0;

        // 迷你预览更新函数
        function updateMiniPreview() {
          const stops = barEditor.getNormalizedGradientStops(effect.params);
          const stopStrs = stops.map((s) => `${s.color} ${(s.offset * 100).toFixed(1)}%`);
          previewBar.style.background = `linear-gradient(to right, ${stopStrs.join(', ')})`;
        }

        // 更新固定点轨道上所有固定点的位置
        function updateAllPinPositions() {
          const pins = pinTrack.querySelectorAll('.grad-pin');
          effect.params.stops.forEach((stop, i) => {
            if (pins[i]) {
              pins[i].style.left = `${stop.offset * 100}%`;
              const pinBody = pins[i].querySelector('.grad-pin-body');
              if (pinBody) pinBody.style.backgroundColor = stop.color;
            }
          });
        }

        // 选中固定点的 UI 高亮更新函数 (不重建 DOM，仅切换类名)
        function selectPin(indexToSelect) {
          selectedStopIndex = indexToSelect;
          const pins = pinTrack.querySelectorAll('.grad-pin');
          pins.forEach((p, idx) => {
            if (idx === indexToSelect) {
              p.classList.add('selected');
            } else {
              p.classList.remove('selected');
            }
          });
          highlightStopRow(indexToSelect);
        }

        // 绘制固定点轨道上的固定点集合
        function renderPins() {
          pinTrack.replaceChildren();
          const stops = effect.params.stops;

          stops.forEach((stop, sIdx) => {
            const pin = document.createElement('div');
            pin.className = `grad-pin ${sIdx === selectedStopIndex ? 'selected' : ''}`;
            pin.style.left = `${stop.offset * 100}%`;
            pin.title = `停靠点 #${sIdx + 1} (${Math.round(stop.offset * 100)}%): 拖拽以移动`;

            const arrow = document.createElement('div');
            arrow.className = 'grad-pin-arrow';

            const pinBody = document.createElement('div');
            pinBody.className = 'grad-pin-body';
            pinBody.style.backgroundColor = stop.color;

            pin.appendChild(arrow);
            pin.appendChild(pinBody);

            // 固定点拖动操作 (通过 Pointer Capture 平滑跟随)
            pin.addEventListener('pointerdown', (e) => {
              e.stopPropagation();
              e.preventDefault();
              selectPin(sIdx);

              try {
                pin.setPointerCapture(e.pointerId);
              } catch (_) {}

              const onPointerMove = (moveEvt) => {
                const trackRect = pinTrack.getBoundingClientRect();
                if (trackRect.width <= 0) return;
                const relX = moveEvt.clientX - trackRect.left;
                const ratio = Math.max(0, Math.min(1, relX / trackRect.width));
                barEditor.updateGradientStop(effect.id, sIdx, { offset: ratio });
                markPresetCustom();
                syncAllStopInputs();
                updateMiniPreview();
                renderPreview();
                updateAllPinPositions();
              };

              const onPointerUp = (upEvt) => {
                pin.removeEventListener('pointermove', onPointerMove);
                pin.removeEventListener('pointerup', onPointerUp);
                pin.removeEventListener('pointercancel', onPointerUp);
                try {
                  pin.releasePointerCapture(upEvt.pointerId);
                } catch (_) {}
                renderStopsList();
                updateAllPinPositions();
              };

              pin.addEventListener('pointermove', onPointerMove);
              pin.addEventListener('pointerup', onPointerUp);
              pin.addEventListener('pointercancel', onPointerUp);
            });

            pinTrack.appendChild(pin);
          });
        }

        // 点击固定点轨道空白区域时: 选中最近的固定点并移动到该位置
        pinTrack.addEventListener('pointerdown', (e) => {
          if (e.target.closest('.grad-pin')) return;
          const trackRect = pinTrack.getBoundingClientRect();
          if (trackRect.width <= 0) return;
          const clickRatio = Math.max(0, Math.min(1, (e.clientX - trackRect.left) / trackRect.width));

          const stops = effect.params.stops;
          let nearestIdx = 0;
          let minDiff = 1.0;
          stops.forEach((s, idx) => {
            const diff = Math.abs(s.offset - clickRatio);
            if (diff < minDiff) {
              minDiff = diff;
              nearestIdx = idx;
            }
          });

          selectPin(nearestIdx);
          barEditor.updateGradientStop(effect.id, nearestIdx, { offset: clickRatio });
          markPresetCustom();
          syncAllStopInputs();
          updateMiniPreview();
          renderPreview();
          updateAllPinPositions();
          renderStopsList();
        });

        // 点击条柱本体以添加固定点
        previewBar.addEventListener('click', (e) => {
          const rect = previewBar.getBoundingClientRect();
          const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          const color = barEditor.getInterpolatedColorAt(effect.id, ratio);
          barEditor.addGradientStop(effect.id, ratio, color);
          markPresetCustom();
          selectedStopIndex = effect.params.stops.findIndex((s) => Math.abs(s.offset - ratio) < 0.005);
          renderStopsList();
          renderPins();
          updateMiniPreview();
          renderPreview();
        });

        // 4. 颜色停靠点列表容器
        const stopsContainer = document.createElement('div');
        stopsContainer.className = 'space-y-1.5 max-h-56 overflow-y-auto no-scrollbar pr-1';
        gradContainer.appendChild(stopsContainer);

        let stopInputs = [];

        function syncAllStopInputs() {
          effect.params.stops.forEach((stop, i) => {
            if (stopInputs[i]) {
              const pct = Math.round(stop.offset * 100);
              stopInputs[i].range.value = pct;
              stopInputs[i].num.value = pct;
            }
          });
        }

        function highlightStopRow(indexToHighlight) {
          const rows = stopsContainer.querySelectorAll('.grad-stop-row');
          rows.forEach((r, idx) => {
            if (idx === indexToHighlight) {
              r.classList.add('ring-1', 'ring-[var(--color-google-blue)]', 'bg-[var(--color-google-blue-light)]');
            } else {
              r.classList.remove('ring-1', 'ring-[var(--color-google-blue)]', 'bg-[var(--color-google-blue-light)]');
            }
          });
        }

        let draggedStopIndex = null;

        // 颜色停靠点行的重绘函数
        function renderStopsList() {
          stopsContainer.replaceChildren();
          stopInputs = [];
          const stops = effect.params.stops;
          const MIN_STOPS = 2;

          stops.forEach((stop, sIdx) => {
            const row = document.createElement('div');
            row.className = `grad-stop-row flex items-center gap-2.5 theme-surface-container-low px-3 py-2 rounded-lg border theme-border text-xs transition-all ${
              sIdx === selectedStopIndex ? 'ring-1 ring-[var(--color-google-blue)] bg-[var(--color-google-blue-light)]' : ''
            }`;
            row.draggable = false; // 仅在操作手柄时启用

            // 拖放排序事件监听器 (完全阻断向父卡片的传播)
            row.addEventListener('dragstart', (e) => {
              e.stopPropagation();
              if (draggedCardIndex !== null) {
                e.preventDefault();
                return;
              }
              draggedStopIndex = sIdx;
              row.classList.add('dragging');
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('type', 'gradient-stop');
              e.dataTransfer.setData('text/plain', String(sIdx));
            });

            row.addEventListener('dragend', (e) => {
              e.stopPropagation();
              row.draggable = false;
              draggedStopIndex = null;
              row.classList.remove('dragging');
              stopsContainer.querySelectorAll('.grad-stop-row').forEach((el) => {
                el.classList.remove('drag-over-top', 'drag-over-bottom', 'dragging');
              });
            });

            row.addEventListener('dragover', (e) => {
              e.stopPropagation();
              // 卡片拖动中，或非停靠点拖动时完全忽略
              if (draggedStopIndex === null || draggedCardIndex !== null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              const rect = row.getBoundingClientRect();
              const relY = e.clientY - rect.top;
              if (relY < rect.height / 2) {
                row.classList.add('drag-over-top');
                row.classList.remove('drag-over-bottom');
              } else {
                row.classList.add('drag-over-bottom');
                row.classList.remove('drag-over-top');
              }
            });

            row.addEventListener('dragleave', (e) => {
              e.stopPropagation();
              if (draggedStopIndex === null || draggedCardIndex !== null) return;
              row.classList.remove('drag-over-top', 'drag-over-bottom');
            });

            row.addEventListener('drop', (e) => {
              e.stopPropagation();
              if (draggedStopIndex === null || draggedCardIndex !== null) return;
              e.preventDefault();
              row.classList.remove('drag-over-top', 'drag-over-bottom');
              if (draggedStopIndex === sIdx) {
                row.draggable = false;
                draggedStopIndex = null;
                return;
              }

              const rect = row.getBoundingClientRect();
              const relY = e.clientY - rect.top;
              let targetIndex = sIdx;
              if (relY >= rect.height / 2 && draggedStopIndex < sIdx) {
                targetIndex = sIdx;
              } else if (relY < rect.height / 2 && draggedStopIndex > sIdx) {
                targetIndex = sIdx;
              }

              const fromIdx = draggedStopIndex;
              row.draggable = false;
              draggedStopIndex = null;

              barEditor.moveGradientStop(effect.id, fromIdx, targetIndex);
              markPresetCustom();
              selectedStopIndex = targetIndex;
              renderStopsList();
              renderPins();
              updateMiniPreview();
              renderPreview();
            });

            row.addEventListener('click', () => {
              selectedStopIndex = sIdx;
              renderPins();
              highlightStopRow(sIdx);
            });

            // 编号徽标
            const badge = document.createElement('span');
            badge.className = 'font-mono text-[11px] font-semibold theme-accent w-6 text-center shrink-0';
            badge.textContent = `#${sIdx + 1}`;

            // 颜色选择器
            const colorInput = document.createElement('input');
            colorInput.type = 'color';
            colorInput.value = stop.color;
            colorInput.className = 'w-8 h-7 p-0.5 theme-surface-base rounded border theme-border cursor-pointer shrink-0';
            colorInput.addEventListener('input', () => {
              barEditor.updateGradientStop(effect.id, sIdx, { color: colorInput.value });
              markPresetCustom();
              updateMiniPreview();
              updateAllPinPositions();
              renderPreview();
            });

            // 位置滑杆 (0〜100%)
            const rangeInput = document.createElement('input');
            rangeInput.type = 'range';
            rangeInput.min = '0';
            rangeInput.max = '100';
            rangeInput.value = Math.round(stop.offset * 100);
            rangeInput.className = 'flex-1 min-w-[80px] accent-[#1A73E8] cursor-pointer h-1.5 bg-[var(--surface-container-high)] rounded';

            // 位置数值输入 (带后缀)
            const numSuffixGroup = document.createElement('div');
            numSuffixGroup.className = 'input-suffix-group w-16 shrink-0';
            const numInput = document.createElement('input');
            numInput.type = 'number';
            numInput.min = '0';
            numInput.max = '100';
            numInput.value = Math.round(stop.offset * 100);
            numInput.className = 'text-center';
            const pctLabel = document.createElement('span');
            pctLabel.className = 'suffix-text';
            pctLabel.textContent = '%';
            numSuffixGroup.appendChild(numInput);
            numSuffixGroup.appendChild(pctLabel);

            stopInputs.push({ range: rangeInput, num: numInput });

            // 滑杆操作事件 (推进同步)
            rangeInput.addEventListener('input', () => {
              const val = parseInt(rangeInput.value, 10) || 0;
              barEditor.updateGradientStop(effect.id, sIdx, { offset: val / 100 });
              markPresetCustom();
              syncAllStopInputs();
              updateMiniPreview();
              updateAllPinPositions();
              renderPreview();
            });

            numInput.addEventListener('input', () => {
              const val = Math.max(0, Math.min(100, parseInt(numInput.value, 10) || 0));
              barEditor.updateGradientStop(effect.id, sIdx, { offset: val / 100 });
              markPresetCustom();
              syncAllStopInputs();
              updateMiniPreview();
              updateAllPinPositions();
              renderPreview();
            });

            // 拖动标记 (⠿) - 仅当抓住这个标记时才启用停靠点拖拽
            const stopDragHandle = document.createElement('span');
            stopDragHandle.className = 'drag-handle cursor-grab active:cursor-grabbing px-1.5 py-0.5 rounded text-xs select-none theme-text-secondary hover:text-[var(--color-google-blue)] hover:bg-[var(--surface-container-high)] transition-colors shrink-0';
            stopDragHandle.title = '拖拽以更改颜色顺序';
            stopDragHandle.textContent = '⠿';

            stopDragHandle.addEventListener('pointerdown', (e) => {
              e.stopPropagation();
              row.draggable = true;
            });
            stopDragHandle.addEventListener('pointerup', () => {
              row.draggable = false;
            });

            // 删除按钮 (至少保留 2 个颜色)
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.title = stops.length <= MIN_STOPS ? '至少需要保留 2 个颜色停靠点' : '删除此停靠点';
            delBtn.textContent = '✕';
            if (stops.length <= MIN_STOPS) {
              delBtn.disabled = true;
              delBtn.className = 'theme-text-disabled px-1 py-0.5 rounded cursor-not-allowed text-xs shrink-0';
            } else {
              delBtn.className = 'theme-text-secondary hover:text-[var(--color-google-red)] hover:bg-[var(--surface-container-high)] px-1 py-0.5 rounded transition-colors text-xs shrink-0';
              delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                barEditor.removeGradientStop(effect.id, sIdx);
                markPresetCustom();
                if (selectedStopIndex >= effect.params.stops.length) {
                  selectedStopIndex = effect.params.stops.length - 1;
                }
                renderStopsList();
                renderPins();
                updateMiniPreview();
                renderPreview();
              });
            }

            row.appendChild(badge);
            row.appendChild(colorInput);
            row.appendChild(rangeInput);
            row.appendChild(numSuffixGroup);
            row.appendChild(stopDragHandle);
            row.appendChild(delBtn);
            stopsContainer.appendChild(row);
          });
        }

        renderStopsList();
        renderPins();
        updateMiniPreview();

        // 5. 下方:「＋ 添加颜色」按钮 &「均等分布」按钮
        const actionsRow = document.createElement('div');
        actionsRow.className = 'flex items-center justify-between gap-2 pt-2 border-t theme-border';

        const addStopBtn = document.createElement('button');
        addStopBtn.type = 'button';
        addStopBtn.className = 'flex items-center gap-1 px-3 py-1.5 text-xs bg-[var(--color-google-blue-light)] hover:opacity-90 text-[var(--color-google-blue)] font-medium border theme-border rounded-full transition-colors shadow-sm';
        addStopBtn.textContent = '＋ 添加颜色';
        addStopBtn.addEventListener('click', () => {
          const DEFAULT_ADD_COLOR = '#a855f7';
          barEditor.addGradientStop(effect.id, 0.5, DEFAULT_ADD_COLOR);
          markPresetCustom();
          selectedStopIndex = effect.params.stops.length - 1;
          renderStopsList();
          renderPins();
          updateMiniPreview();
          renderPreview();
        });

        const distributeBtn = document.createElement('button');
        distributeBtn.type = 'button';
        distributeBtn.className = 'text-xs theme-text-secondary hover:theme-text-primary hover:bg-[var(--surface-container-high)] px-2.5 py-1.5 rounded-full transition-colors border theme-border font-medium';
        distributeBtn.title = '将所有颜色停靠点按 0%~100% 平均分布';
        distributeBtn.textContent = '均等配置';
        distributeBtn.addEventListener('click', () => {
          barEditor.distributeGradientStops(effect.id);
          markPresetCustom();
          renderStopsList();
          renderPins();
          updateMiniPreview();
          renderPreview();
        });

        actionsRow.appendChild(addStopBtn);
        actionsRow.appendChild(distributeBtn);
        gradContainer.appendChild(actionsRow);

        body.appendChild(gradContainer);
        break;
      }

      case 'shapeArray': {
        const row = document.createElement('div');
        row.className = 'grid grid-cols-1 sm:grid-cols-12 gap-4 items-center';

        // 図形種別
        const typeCol = document.createElement('div');
        typeCol.className = 'sm:col-span-4 min-w-0';
        const typeLabel = document.createElement('label');
        typeLabel.className = 'text-xs theme-text-secondary block mb-1 font-medium';
        typeLabel.textContent = '图形类型:';
        const typeSelect = document.createElement('select');
        typeSelect.className = 'w-full theme-surface-base theme-text-primary p-1.5 rounded-lg border theme-border text-xs focus:border-[var(--color-google-blue)] outline-none';
        const shapeOptions = [
          { val: 'rectangle', text: '矩形 (LED)' },
          { val: 'circle', text: '圆形 (圆点)' },
          { val: 'diamond', text: '菱形' },
          { val: 'image', text: '自定义图片' }
        ];
        shapeOptions.forEach((opt) => {
          const o = document.createElement('option');
          o.value = opt.val;
          o.textContent = opt.text;
          if (effect.params.shapeType === opt.val) o.selected = true;
          typeSelect.appendChild(o);
        });
        typeCol.appendChild(typeLabel);
        typeCol.appendChild(typeSelect);

        // 元素尺寸 (滑杆 ＋ 数值输入)
        const sizeCol = document.createElement('div');
        sizeCol.className = 'sm:col-span-4 min-w-0';
        const sizeLabel = document.createElement('label');
        sizeLabel.className = 'text-xs theme-text-secondary block mb-1 font-medium';
        sizeLabel.textContent = '尺寸:';

        const sizeSliderUi = createSliderWithNumberInput({
          min: 2,
          max: 50,
          value: effect.params.size,
          suffix: 'px',
          onInput: (val) => {
            barEditor.setEffectParam(effect.id, 'size', parseInt(val, 10) || 4);
            renderPreview();
          }
        });
        sizeCol.appendChild(sizeLabel);
        sizeCol.appendChild(sizeSliderUi);

        // 间隙 (滑杆 ＋ 数值输入)
        const gapCol = document.createElement('div');
        gapCol.className = 'sm:col-span-4 min-w-0';
        const gapLabel = document.createElement('label');
        gapLabel.className = 'text-xs theme-text-secondary block mb-1 font-medium';
        gapLabel.textContent = '隙間:';

        const gapSliderUi = createSliderWithNumberInput({
          min: 1,
          max: 30,
          value: effect.params.gap,
          suffix: 'px',
          onInput: (val) => {
            barEditor.setEffectParam(effect.id, 'gap', parseInt(val, 10) || 1);
            renderPreview();
          }
        });
        gapCol.appendChild(gapLabel);
        gapCol.appendChild(gapSliderUi);

        row.appendChild(typeCol);
        row.appendChild(sizeCol);
        row.appendChild(gapCol);
        body.appendChild(row);

        // 自定义图片上传 (仅在选择图片时)
        const imgRow = document.createElement('div');
        imgRow.className = effect.params.shapeType === 'image' ? 'pt-1' : 'pt-1 hidden';
        const imgInput = document.createElement('input');
        imgInput.type = 'file';
        imgInput.accept = 'image/*';
        imgInput.className = 'text-xs theme-text-secondary file:mr-2 file:py-1 file:px-3 file:rounded-full file:border-0 file:text-xs file:theme-surface-container-low file:theme-text-primary hover:file:bg-[var(--surface-container-high)] cursor-pointer font-medium';
        imgInput.addEventListener('change', (e) => {
          const file = e.target.files[0];
          if (file) {
            const img = new Image();
            img.onload = () => {
              effect.params.customImage = img;
              markPresetCustom();
              renderPreview();
            };
            img.src = URL.createObjectURL(file);
          }
        });
        imgRow.appendChild(imgInput);
        body.appendChild(imgRow);

        typeSelect.addEventListener('change', () => {
          barEditor.setEffectParam(effect.id, 'shapeType', typeSelect.value);
          imgRow.className = typeSelect.value === 'image' ? 'pt-1' : 'pt-1 hidden';
          markPresetCustom();
          renderPreview();
        });
        break;
      }

      case 'rgbShift': {
        const row = document.createElement('div');
        row.className = 'grid grid-cols-1 sm:grid-cols-2 gap-4 items-center';

        // 错位量 (滑杆 ＋ 数值输入)
        const shiftCol = document.createElement('div');
        shiftCol.className = 'min-w-0';
        const shiftLabel = document.createElement('label');
        shiftLabel.className = 'text-xs theme-text-secondary block mb-1 font-medium';
        shiftLabel.textContent = '错位量:';

        const shiftSliderUi = createSliderWithNumberInput({
          min: 1,
          max: 30,
          value: effect.params.shift,
          suffix: 'px',
          onInput: (val) => {
            barEditor.setEffectParam(effect.id, 'shift', parseInt(val, 10) || 1);
            renderPreview();
          }
        });
        shiftCol.appendChild(shiftLabel);
        shiftCol.appendChild(shiftSliderUi);

        // 方向角度 (滑杆 ＋ 数值输入)
        const angleCol = document.createElement('div');
        angleCol.className = 'min-w-0';
        const angleLabel = document.createElement('label');
        angleLabel.className = 'text-xs theme-text-secondary block mb-1 font-medium';
        angleLabel.textContent = '错位方向:';

        const angleSliderUi = createSliderWithNumberInput({
          min: 0,
          max: 360,
          step: 15,
          value: effect.params.angle || 0,
          suffix: '°',
          onInput: (val) => {
            barEditor.setEffectParam(effect.id, 'angle', parseInt(val, 10) || 0);
            renderPreview();
          }
        });
        angleCol.appendChild(angleLabel);
        angleCol.appendChild(angleSliderUi);

        row.appendChild(shiftCol);
        row.appendChild(angleCol);
        body.appendChild(row);
        break;
      }

      case 'texture': {
        const row = document.createElement('div');
        row.className = 'space-y-3';

        // 图片选择
        const fileRow = document.createElement('div');
        const fileLabel = document.createElement('label');
        fileLabel.className = 'text-xs theme-text-secondary block mb-1 font-medium';
        fileLabel.textContent = '纹理贴图:';
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.className = 'text-xs theme-text-secondary file:mr-2 file:py-1 file:px-3 file:rounded-full file:border-0 file:text-xs file:theme-surface-container-low file:theme-text-primary hover:file:bg-[var(--surface-container-high)] cursor-pointer font-medium';
        fileInput.addEventListener('change', (e) => {
          const file = e.target.files[0];
          if (file) {
            const img = new Image();
            img.onload = () => {
              effect.params.image = img;
              markPresetCustom();
              renderPreview();
            };
            img.src = URL.createObjectURL(file);
          }
        });
        fileRow.appendChild(fileLabel);
        fileRow.appendChild(fileInput);

        // 方式与不透明度
        const optRow = document.createElement('div');
        optRow.className = 'grid grid-cols-1 sm:grid-cols-2 gap-3 items-center pt-1';

        const modeCol = document.createElement('div');
        const modeLabel = document.createElement('label');
        modeLabel.className = 'text-xs theme-text-secondary block mb-1 font-medium';
        modeLabel.textContent = '铺贴方式:';
        const modeSelect = document.createElement('select');
        modeSelect.className = 'w-full theme-surface-base theme-text-primary p-1.5 rounded-lg border theme-border text-xs focus:border-[var(--color-google-blue)] outline-none';
        const modes = [
          { val: '3-slice', text: '3 切片 (保持圆角)' },
          { val: 'stretch', text: '拉伸 (整体伸缩)' },
          { val: 'tile', text: '平铺 (重复)' }
        ];
        modes.forEach((m) => {
          const o = document.createElement('option');
          o.value = m.val;
          o.textContent = m.text;
          if (effect.params.mode === m.val) o.selected = true;
          modeSelect.appendChild(o);
        });
        modeSelect.addEventListener('change', () => {
          barEditor.setEffectParam(effect.id, 'mode', modeSelect.value);
          markPresetCustom();
          renderPreview();
        });
        modeCol.appendChild(modeLabel);
        modeCol.appendChild(modeSelect);

        const opCol = document.createElement('div');
        const opLabel = document.createElement('label');
        opLabel.className = 'text-xs theme-text-secondary block mb-1 font-medium';
        opLabel.textContent = '不透明度:';

        const opSliderUi = createSliderWithNumberInput({
          min: 10,
          max: 100,
          value: effect.params.opacity || 100,
          suffix: '%',
          onInput: (val) => {
            barEditor.setEffectParam(effect.id, 'opacity', parseInt(val, 10) || 100);
            renderPreview();
          }
        });
        opCol.appendChild(opLabel);
        opCol.appendChild(opSliderUi);

        optRow.appendChild(modeCol);
        optRow.appendChild(opCol);

        row.appendChild(fileRow);
        row.appendChild(optRow);
        body.appendChild(row);
        break;
      }
    }

    card.appendChild(body);
    return card;
  }

  /**
   * 重绘特效卡片列表 (严格不使用 innerHTML)
   */
  function renderEffectCards() {
    if (!effectCardsContainer) return;
    effectCardsContainer.replaceChildren();

    if (barEditor.effects.length === 0) {
      const emptyBox = document.createElement('div');
      emptyBox.className = 'p-6 text-center border border-dashed theme-border rounded-2xl theme-text-secondary text-xs theme-surface-container-low';
      emptyBox.textContent = '暂无特效。可通过右上角的「＋ 添加」自由添加特效。';
      effectCardsContainer.appendChild(emptyBox);
      return;
    }

    const totalCount = barEditor.effects.length;
    barEditor.effects.forEach((effect, index) => {
      const cardEl = createEffectCardElement(effect, index, totalCount);
      effectCardsContainer.appendChild(cardEl);
    });
  }

  // 「＋ 添加」按钮
  if (addEffectButton && availableEffectsSelect) {
    addEffectButton.addEventListener('click', () => {
      const type = availableEffectsSelect.value;
      if (type) {
        barEditor.addEffect(type);
        markPresetCustom();
        renderEffectCards();
        renderPreview();
      }
    });
  }

  // 预设选择
  presetButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.getAttribute('data-preset');
      if (preset) {
        barEditor.applyPreset(preset);
        setPresetActive(preset);
        syncBaseUi();
        renderEffectCards();
        renderPreview();
      }
    });
  });

  // 模态框开合 (平滑动画)
  if (openBarEditorButton && barEditorModal) {
    openBarEditorButton.addEventListener('click', () => {
      openModalSmooth(barEditorModal);
      syncBaseUi();
      renderEffectCards();
      renderPreview();
    });
  }

  if (closeBarEditorTopButton && barEditorModal) {
    closeBarEditorTopButton.addEventListener('click', () => {
      closeModalSmooth(barEditorModal);
    });
  }

  // 点击模态框背景及按 Esc 键时的智能关闭
  if (barEditorModal) {
    barEditorModal.addEventListener('click', (e) => {
      if (e.target === barEditorModal) {
        closeModalSmooth(barEditorModal);
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && barEditorModal.classList.contains('is-open')) {
        closeModalSmooth(barEditorModal);
      }
    });
  }

  // 应用到波形绘制
  if (applyBarToVisualizerButton && barEditorModal) {
    applyBarToVisualizerButton.addEventListener('click', () => {
      showLoading('正在预烘焙条柱图像...', '正在生成各高度的精灵缓存');

      setTimeout(() => {
        try {
          const chosenWidth = barEditor.width;
          const currentBrightness = parseFloat(peakBrightnessInput.value);

          applyBarEditorToVisualizer(chosenWidth, currentBrightness);
          updateSettingsFromUi();

          const maxHeight = Math.max(350, Math.ceil(canvas.height));
          logMessage(`1~${maxHeight}px 的条柱图像 (粗细: ${chosenWidth}px) 已预烘焙并应用。`);
        } finally {
          hideLoading();
          closeModalSmooth(barEditorModal);
        }
      }, 10);
    });
  }

  // 保存透明 PNG 图片
  if (downloadBarPngButton) {
    downloadBarPngButton.addEventListener('click', () => {
      barEditor.downloadAsPng('waveform_bar.png');
      logMessage('条柱图像已下载为 waveform_bar.png。');
    });
  }

  // 默认单色重置 (带确认对话框)
  if (resetBarEditorButton) {
    resetBarEditorButton.addEventListener('click', () => {
      const confirmed = window.confirm(
        '是否初始化条柱编辑器的设置并恢复为单色设置？\n（已添加的特效都会被删除）'
      );
      if (!confirmed) return;

      isCustomBarApplied = false;
      visualizer.setCustomBarDrawer(null);
      barEditor.applyPreset('solid');
      setPresetActive('solid');
      syncBaseUi();
      renderEffectCards();
      renderPreview();
      updateSettingsFromUi();
      logMessage('条柱绘制已恢复为默认单色设置。');
    });
  }

  // 初始状态: 仅显示基本设置 (无特效)
  syncBaseUi();
  renderEffectCards();
  renderPreview();
  setPresetActive('solid');

  // 拖动标记的点击＆取消时的安全重置
  window.addEventListener('pointerup', () => {
    document.querySelectorAll('.effect-card, .grad-stop-row').forEach((el) => {
      el.draggable = false;
    });
  });
}

/**
 * 应用程序的初始化
 */
async function initializeApp() {
  initTheme();
  showLoading('正在初始化系统...', '正在读取基础文件');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  updateSettingsFromUi();

  // 注册各设置输入元素的事件监听器 (输入变更时立即重新计算・更新预览)
  const settingInputs = [
    previewModeSelect,
    minFreqInput,
    maxFreqInput,
    numBarsInput,
    samplingMethodSelect,
    barHeightScaleInput,
    attackInput,
    decayInput,
    peakBrightnessInput,
    smoothCurveInput,
    freqCompensationInput,
    fpsInput,
    intervalInput
  ];

  // 为防止输入过程中连续重算导致卡顿，对 input 事件应用防抖
  const debouncedUpdateSettings = debounce(
    updateSettingsFromUi,
    SETTINGS_INPUT_DEBOUNCE_MS
  );

  settingInputs.forEach((input) => {
    if (!input) return;
    input.addEventListener('input', debouncedUpdateSettings);
    input.addEventListener('change', updateSettingsFromUi);
  });

  // 条柱编辑器的初始化与联动
  setupBarEditor();

  // 音频文件选择
  audioFileInput.addEventListener('change', handleAudioFileChange);

  // 播放控制 (与预览播放循环同步)
  audioPlayer.addEventListener('play', async () => {
    await visualizer.resumeContext();
    startPreviewLoop();
  });

  audioPlayer.addEventListener('pause', () => {
    if (previewAnimationFrameId) {
      cancelAnimationFrame(previewAnimationFrameId);
      previewAnimationFrameId = null;
    }
    if (visualizer.hasAnalyzedData()) {
      visualizer.drawAtTime(audioPlayer.currentTime, canvas, ctx);
    }
  });

  audioPlayer.addEventListener('ended', () => {
    if (previewAnimationFrameId) {
      cancelAnimationFrame(previewAnimationFrameId);
      previewAnimationFrameId = null;
    }
  });

  audioPlayer.addEventListener('seeked', () => {
    if (visualizer.hasAnalyzedData()) {
      visualizer.drawAtTime(audioPlayer.currentTime, canvas, ctx);
    }
  });

  audioPlayer.addEventListener('timeupdate', () => {
    if (audioPlayer.paused && visualizer.hasAnalyzedData()) {
      visualizer.drawAtTime(audioPlayer.currentTime, canvas, ctx);
    }
  });

  // 高速分析开始按钮
  recordStartButton.addEventListener('click', handleStartFastAnalysis);

  // 保存按钮
  saveBarHeightsButton.addEventListener('click', handleSave);

  // 日志开合按钮
  if (logToggleButton && logContainer) {
    logToggleButton.addEventListener('click', () => {
      logContainer.classList.toggle('active');
    });
  }

  // 模板 .sb3 的初始加载
  try {
    baseSb3Content = await loadBaseSb3();
    logMessage('.sb3 文件加载完成。');
  } catch (error) {
    console.error('抜け殻.sb3の読み込みエラー:', error);
    logMessage(
      '加载用作基底的 .sb3 文件失败，将禁用 sb3 格式的保存。',
      'error'
    );
    if (recordFormatSb3Radio) {
      recordFormatSb3Radio.disabled = true;
      if (recordFormatSb3Radio.nextElementSibling) {
        recordFormatSb3Radio.nextElementSibling.classList.add('text-gray-400');
      }
    }
  } finally {
    hideLoading();
  }
}

// 页面加载完成时启动
window.addEventListener('DOMContentLoaded', initializeApp);
