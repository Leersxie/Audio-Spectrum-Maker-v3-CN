/**
 * メインアプリケーションモジュール
 * UIイベントのハンドリング、高速オフライン解析、プレビュー再生の連携を担当します。
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

// DOM要素の参照
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

// ローディングオーバーレイ関連要素
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingMessage = document.getElementById('loadingMessage');
const loadingSubMessage = document.getElementById('loadingSubMessage');

// プログレスバー関連要素
const progressContainer = document.getElementById('progressContainer');
const progressStatusText = document.getElementById('progressStatusText');
const progressPercentText = document.getElementById('progressPercentText');
const progressBar = document.getElementById('progressBar');

// テーマ切り替え関連 (Google Material You / M3 仕様)
const STORAGE_KEY_THEME = 'waveform_maker_theme';
const themeToggleButton = document.getElementById('themeToggleButton');
const themeSunIcon = document.getElementById('themeSunIcon');
const themeMoonIcon = document.getElementById('themeMoonIcon');

/**
 * 指定されたテーマ ('light' | 'dark') をドキュメントおよびUIに適用します
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

  // ☀️/🌙 アイコンの切り替え (ダーク時は太陽アイコンでライトに戻せることを示唆)
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
 * テーマの初期化 (localStorage または OS 設定から反映)
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

  // OS 設定変更の監視
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

// 設定入力要素の参照
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

// アプリケーション状態
const visualizer = new AudioVisualizer();
const barEditor = new BarEditor();
let isCustomBarApplied = false;
let selectedAudioFile = null;
let decodedAudioBuffer = null;
let baseSb3Content = null;
let previewAnimationFrameId = null;

/**
 * 現在のバーエディター設定でスプライトキャッシュをベイクし、ビジュアライザーに適用します
 * @param {number} targetWidth - バーの太さ (px)
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
 * 操作ブロック用のローディングオーバーレイを表示します
 * @param {string} message - メインメッセージ
 * @param {string} subMessage - 補足メッセージ
 */
function showLoading(message, subMessage = '') {
  if (!loadingOverlay) return;
  if (loadingMessage) loadingMessage.textContent = message;
  if (loadingSubMessage) loadingSubMessage.textContent = subMessage;

  loadingOverlay.classList.remove('hidden');
  // トランジション用の遅延
  requestAnimationFrame(() => {
    loadingOverlay.classList.remove('opacity-0', 'pointer-events-none');
  });
}

/**
 * ローディングオーバーレイを非表示にし、画面操作を解除します
 */
function hideLoading() {
  if (!loadingOverlay) return;
  loadingOverlay.classList.add('opacity-0', 'pointer-events-none');
  setTimeout(() => {
    loadingOverlay.classList.add('hidden');
  }, 300);
}

/**
 * ログコンテナにメッセージを追加します（innerHTMLは使用せず安全にDOM操作を行います）
 * @param {string} message - ログ本文
 * @param {'info' | 'warning' | 'error'} type - ログ種別
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
 * 波形プレビュー形式に応じてCanvasの表示領域スタイル (正方形/横長) を切り替えます
 * CSS トランジション期間中、requestAnimationFrame で内部解像度を同期し滑らかなモーフィングを実現します
 * @param {string} previewMode - プレビュー形式
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
      // モーフィング中はスプライト再ベイクをスキップして60FPSを維持し、終了時に1回だけ実行
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
 * モーダルダイアログを滑らかなスケール＆フェードアニメーションで開きます
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
 * モーダルダイアログを滑らかなスケール＆フェードアニメーションで閉じます
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
 * 入力フォームから最新の設定値を取得し、ビジュアライザーに反映します
 * キャッシュされたデータが存在する場合は瞬時に再計算され、Canvasプレビューが更新されます
 */
function updateSettingsFromUi() {
  const previewMode = previewModeSelect ? previewModeSelect.value : DEFAULT_PREVIEW_MODE;
  updateCanvasLayoutForPreviewMode(previewMode);

  const barThickness = isCustomBarApplied
    ? (barEditor.width || DEFAULT_BAR_THICKNESS)
    : DEFAULT_BAR_THICKNESS;
  const peakBrightness = parseFloat(peakBrightnessInput.value);

  // カスタムバー適用中の場合は、ピーク輝度が変更されたら即座に再ベイクして波形に反映
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
 * Canvas の描画領域サイズを要素の表示サイズに同期します
 * @param {boolean} skipRebake - アニメーション中のスプライト再ベイクを一時抑制するか
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
 * 音声再生に合わせたプレビュー描画アニメーションループ
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
 * 高速オフライン解析の実行
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

    // 解析直後の先頭フレームをCanvasにプレビュー描画
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
 * 保存処理を実行します
 */
async function handleSave() {
  const selectedFormatElement = document.querySelector('input[name="recordFormat"]:checked');
  const selectedFormat = selectedFormatElement ? selectedFormatElement.value : 'waveform';
  // バックグラウンドで非同期再計算が実行中の場合は完了を待機
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

      // Scratch 预览开关开启时，在模态框内通过 TurboWarp Player 一键预览
      const scratchPreviewToggle = document.getElementById('scratchPreviewToggle');
      if (scratchPreviewToggle && scratchPreviewToggle.checked) {
        await openScratchPreview(newSb3Blob);
      }
    }
  } catch (error) {
    console.error('保存処理中にエラーが発生しました:', error);
    logMessage(`保存失败: ${error.message}`, 'error');
  }
}

/**
 * Scratch 预览播放: 在模态框内把生成的 .sb3 加载到 TurboWarp Player
 */
async function openScratchPreview(sb3Blob) {
  const scratchPreviewModal = document.getElementById('scratchPreviewModal');
  const scratchPreviewIframe = document.getElementById('scratchPreviewIframe');
  if (!scratchPreviewModal || !scratchPreviewIframe) {
    return;
  }

  scratchPreviewModal.classList.remove('hidden');

  try {
    const projectData = await sb3Blob.arrayBuffer();
    const sendProject = () => {
      if (!scratchPreviewIframe.contentWindow) return;
      scratchPreviewIframe.contentWindow.postMessage(
        { type: 'load', data: projectData },
        window.location.origin
      );
    };

    // iframe 尚未加载完成时，等待其 load 事件后再发送项目数据
    if (
      scratchPreviewIframe.contentDocument &&
      scratchPreviewIframe.contentDocument.readyState === 'complete'
    ) {
      sendProject();
    } else {
      scratchPreviewIframe.addEventListener('load', sendProject, { once: true });
    }
  } catch (error) {
    console.error('Scratch 预览加载失败:', error);
    logMessage(`Scratch 预览加载失败: ${error.message}`, 'error');
  }
}

function closeScratchPreview() {
  const scratchPreviewModal = document.getElementById('scratchPreviewModal');
  if (scratchPreviewModal) {
    scratchPreviewModal.classList.add('hidden');
  }
  // 停止预览 iframe 内的播放（防止关闭后仍发声）
  const scratchPreviewIframe = document.getElementById('scratchPreviewIframe');
  if (scratchPreviewIframe && scratchPreviewIframe.contentWindow) {
    try {
      scratchPreviewIframe.contentWindow.postMessage({ type: 'stop' }, window.location.origin);
    } catch (error) {
      console.warn('Scratch 预览停止失败:', error);
    }
  }
}

const INITIAL_FILE_DISPLAY_TEXT = '请选择音频文件 (.mp3, .wav, .aac, .flac ...)';

/**
 * オーディオファイル選択イベントのハンドラー
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

      // ファイル選択後に自動で高速解析を実行
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
 * バーエディターのUIおよび機能セットアップ (AviUtl風エフェクトスタック)
 */
function setupBarEditor() {
  const openBarEditorButton = document.getElementById('openBarEditorButton');
  const barEditorModal = document.getElementById('barEditorModal');
  const closeBarEditorTopButton = document.getElementById('closeBarEditorTopButton');
  const barPreviewCanvas = document.getElementById('barPreviewCanvas');
  const barPreviewWrapper = document.getElementById('barPreviewWrapper');
  const previewBgButtons = document.querySelectorAll('.preview-bg-btn');

  // 基本設定要素 (スライダー ＋ 数値入力)
  const baseBarWidthRange = document.getElementById('baseBarWidthRange');
  const baseBarWidthInput = document.getElementById('baseBarWidthInput');
  const baseBorderRadiusRange = document.getElementById('baseBorderRadiusRange');
  const baseBorderRadiusInput = document.getElementById('baseBorderRadiusInput');
  const baseColorInput = document.getElementById('baseColorInput');

  // エフェクトスタック管理要素
  const availableEffectsSelect = document.getElementById('availableEffectsSelect');
  const addEffectButton = document.getElementById('addEffectButton');
  const effectCardsContainer = document.getElementById('effectCardsContainer');

  const applyBarToVisualizerButton = document.getElementById('applyBarToVisualizerButton');
  const downloadBarPngButton = document.getElementById('downloadBarPngButton');
  const resetBarEditorButton = document.getElementById('resetBarEditorButton');
  const presetButtons = document.querySelectorAll('.preset-btn');

  // ドラッグ＆ドロップ管理用変数
  let draggedCardIndex = null;
  let draggedStopIndex = null;

  // プレビュー背景色切り替え (市松 / 黒 / 白)
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

  // プリセットのアクティブ表示管理
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

  // 基本設定の双方向バインド (太さ: スライダー ＋ 数値入力)
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

  // 基本設定の双方向バインド (丸み: スライダー ＋ 数値入力)
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
   * スライダー ＋ インライン単位付き数値入力欄のUIセットを生成します
   * @param {Object} options
   * @param {number} options.min
   * @param {number} options.max
   * @param {number} [options.step=1]
   * @param {number} options.value
   * @param {string} options.suffix - 単位文字列 ('px', '%', '°')
   * @param {Function} options.onInput - 値変更コールバック
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
   * AviUtl風エフェクトカードのDOMを生成します (No innerHTML 厳守)
   * @param {Object} effect
   * @param {number} index - スタック内の順序インデックス
   * @param {number} totalCount - エフェクトの総数
   * @returns {HTMLElement}
   */
  function createEffectCardElement(effect, index = 0, totalCount = 1) {
    const card = document.createElement('div');
    card.className = 'effect-card theme-surface-card border theme-border rounded-xl overflow-hidden shadow-sm transition-all';
    card.draggable = false; // ハンドル操作時のみ有効化

    // ドラッグ＆ドロップ並び替えイベントリスナー
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
      // カラーストップのドラッグ中、またはカードドラッグ中でない場合は完全に無視
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

    // 1. カードヘッダー
    const header = document.createElement('div');
    header.className = 'flex items-center justify-between theme-surface-container-low px-3 py-2 border-b theme-border';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'flex items-center gap-2';

    // 適用順序バッジ (#1, #2, ...)
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

    // ヘッダー右側（ドラッグマーク ＋ 削除ボタン）
    const headerRight = document.createElement('div');
    headerRight.className = 'flex items-center gap-1';

    // ドラッグマーク (⠿) - このマークをつかんだ時だけカードドラッグを有効化
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

    // 削除ボタン (✕)
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

    // 2. カードボディ (パラメータ設定群)
    const body = document.createElement('div');
    body.className = 'p-3 space-y-2.5 theme-surface-card';

    // タイプごとのパラメータUI構築
    switch (effect.type) {
      case 'border': {
        const row = document.createElement('div');
        row.className = 'grid grid-cols-1 sm:grid-cols-12 gap-4 items-center';

        // 線の太さ (スライダー ＋ 数値入力)
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

        // 枠線の色
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

        // 発光色
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

        // ぼかし幅 (スライダー ＋ 数値入力)
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

        // 強度 (Bloom)
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
        // グラデーションのstops初期化保証
        if (!Array.isArray(effect.params.stops)) {
          effect.params.stops = barEditor.getNormalizedGradientStops(effect.params);
        }
        if (typeof effect.params.opacity !== 'number') {
          effect.params.opacity = 100;
        }

        const gradContainer = document.createElement('div');
        gradContainer.className = 'space-y-2.5';

        // 1. 角度設定行 (独立した行で配置し重なりを防止)
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

        // クイック角度ボタン (0°, 90°, 45°)
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

        // 2. 不透明度設定行 (スライダー ＋ 数値入力)
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

        // 3. ミニプレビューバー ＆ ピン操作トラック (Figma/Photoshop風インタラクション)
        const previewArea = document.createElement('div');
        previewArea.className = 'w-full space-y-1';

        const barHint = document.createElement('div');
        barHint.className = 'text-[10px] theme-text-secondary flex items-center justify-between';
        barHint.textContent = '点击条柱可添加固定点，拖拽固定点可调整位置';
        previewArea.appendChild(barHint);

        // ミニプレビューバー本体 (クリックでピン追加)
        const previewBar = document.createElement('div');
        previewBar.className = 'w-full h-5 rounded-lg border theme-border shadow-inner cursor-crosshair transition-all relative overflow-hidden';
        previewBar.title = '点击添加颜色停靠点';
        previewArea.appendChild(previewBar);

        // ピントラック (ピンが左右に動くトラック)
        const pinTrack = document.createElement('div');
        pinTrack.className = 'grad-pin-track';
        previewArea.appendChild(pinTrack);

        gradContainer.appendChild(previewArea);

        let selectedStopIndex = 0;

        // ミニプレビュー更新関数
        function updateMiniPreview() {
          const stops = barEditor.getNormalizedGradientStops(effect.params);
          const stopStrs = stops.map((s) => `${s.color} ${(s.offset * 100).toFixed(1)}%`);
          previewBar.style.background = `linear-gradient(to right, ${stopStrs.join(', ')})`;
        }

        // ピントラックの全ピン位置を更新
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

        // 選択中ピンのUIハイライト更新関数（DOM再生成を行わずクラスのみ切り替え）
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

        // ピントラックのピン群を描画
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

            // ピンドラッグ操作 (Pointer Captureで滑らかに追従)
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

        // ピントラックの空き領域クリック時: 最も近いピンを選択してその位置へ移動
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

        // バー本体クリックでピン追加
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

        // 4. カラーストップ一覧コンテナ
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

        // カラーストップ行の再描画関数
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
            row.draggable = false; // ハンドル操作時のみ有効化

            // ドラッグ＆ドロップ並び替えイベントリスナー (親カードへの伝播を完全遮断)
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
              // カードドラッグ中、またはストップドラッグ中でない場合は完全に無視
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

            // 番号バッジ
            const badge = document.createElement('span');
            badge.className = 'font-mono text-[11px] font-semibold theme-accent w-6 text-center shrink-0';
            badge.textContent = `#${sIdx + 1}`;

            // カラーピッカー
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

            // 位置スライダー (0〜100%)
            const rangeInput = document.createElement('input');
            rangeInput.type = 'range';
            rangeInput.min = '0';
            rangeInput.max = '100';
            rangeInput.value = Math.round(stop.offset * 100);
            rangeInput.className = 'flex-1 min-w-[80px] accent-[#1A73E8] cursor-pointer h-1.5 bg-[var(--surface-container-high)] rounded';

            // 位置数値入力 (サフィックス付き)
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

            // スライダー操作イベント（押し出し同期）
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

            // ドラッグマーク (⠿) - このマークをつかんだ時だけストップドラッグを有効化
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

            // 削除ボタン (最低2色は保持)
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

        // 5. 下段: 「＋ 色を追加」ボタン & 「均等配置」ボタン
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

        // 要素サイズ (スライダー ＋ 数値入力)
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

        // 隙間 (スライダー ＋ 数値入力)
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

        // カスタム画像アップロード (画像選択時のみ)
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

        // シフト量 (スライダー ＋ 数値入力)
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

        // 方向角度 (スライダー ＋ 数値入力)
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

        // 画像選択
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

        // 方式と不透明度
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
   * エフェクトカード一覧を再描画します (No innerHTML 厳守)
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

  // 「＋ 追加」ボタン
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

  // プリセット選択
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

  // モーダル開閉 (滑らかなアニメーション)
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

  // モーダル背景クリック時およびEscキーでのスマートクローズ
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

  // 波形描画に適用
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

  // 透過PNG画像保存
  if (downloadBarPngButton) {
    downloadBarPngButton.addEventListener('click', () => {
      barEditor.downloadAsPng('waveform_bar.png');
      logMessage('条柱图像已下载为 waveform_bar.png。');
    });
  }

  // デフォルト単色リセット (確認ダイアログ付き)
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

  // 初期状態: 基本設定のみ（エフェクトなし）で表示
  syncBaseUi();
  renderEffectCards();
  renderPreview();
  setPresetActive('solid');

  // ドラッグマークのクリック＆キャンセル時の安全リセット
  window.addEventListener('pointerup', () => {
    document.querySelectorAll('.effect-card, .grad-stop-row').forEach((el) => {
      el.draggable = false;
    });
  });
}

/**
 * アプリケーションの初期化
 */
async function initializeApp() {
  initTheme();
  showLoading('正在初始化系统...', '正在读取基础文件');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  updateSettingsFromUi();

  // 各設定入力要素のイベントリスナー登録（入力変更時に即座に再計算・プレビュー更新）
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

  // 入力途中の連続再計算によるフリーズを防ぐため、input イベントにはデバウンスを適用
  const debouncedUpdateSettings = debounce(
    updateSettingsFromUi,
    SETTINGS_INPUT_DEBOUNCE_MS
  );

  settingInputs.forEach((input) => {
    if (!input) return;
    input.addEventListener('input', debouncedUpdateSettings);
    input.addEventListener('change', updateSettingsFromUi);
  });

  // バーエディターの初期化と連携
  setupBarEditor();

  // 音声ファイル選択
  audioFileInput.addEventListener('change', handleAudioFileChange);

  // 再生制御（プレビュー再生ループとの同期）
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

  // 高速解析開始ボタン
  recordStartButton.addEventListener('click', handleStartFastAnalysis);

  // 保存ボタン
  saveBarHeightsButton.addEventListener('click', handleSave);

  // ログ開閉ボタン
  if (logToggleButton && logContainer) {
    logToggleButton.addEventListener('click', () => {
      logContainer.classList.toggle('active');
    });
  }

  // Scratch 预览模态框关闭按钮
  const closeScratchPreviewButton = document.getElementById('closeScratchPreviewButton');
  const scratchPreviewModal = document.getElementById('scratchPreviewModal');
  if (closeScratchPreviewButton && scratchPreviewModal) {
    closeScratchPreviewButton.addEventListener('click', closeScratchPreview);
    scratchPreviewModal.addEventListener('click', (e) => {
      if (e.target === scratchPreviewModal) closeScratchPreview();
    });
  }

  // 抜け殻.sb3 の初期ロード
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

// ページのロード完了時に起動
window.addEventListener('DOMContentLoaded', initializeApp);
