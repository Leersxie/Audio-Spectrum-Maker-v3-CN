/**
 * 定数定義モジュール
 * アプリケーション全体で使用する定数およびマジックナンバーを管理します。
 */

// Web Audio API 関連
export const DEFAULT_FFT_SIZE = 8192;
export const SMOOTHING_POINTS_PER_BAR = 4;

// バー帯域のサンプリング方式（参照方法）
export const SAMPLING_METHOD = {
  PEAK: 'peak',
  AVERAGE: 'average',
  RMS: 'rms',
  BLEND: 'blend'
};
export const DEFAULT_SAMPLING_METHOD = SAMPLING_METHOD.AVERAGE;
export const BLEND_PEAK_RATIO = 0.7;
export const BLEND_AVERAGE_RATIO = 0.3;

// オフライン FFT 解析関連の定数
export const FFT_MIN_DECIBELS = -100;
export const FFT_MAX_DECIBELS = -30;
export const BLACKMAN_ALPHA = 0.16;
export const OFFLINE_ANALYSIS_CHUNK_SIZE = 150;
export const EPSILON_MAGNITUDE = 1e-10;
export const DECIBEL_SCALE_MULTIPLIER = 20;
export const BYTE_MAX_VALUE = 255;

// 高速対数近似 (Fast Log) 関連
export const LOG2_MANTISSA_LUT_SIZE = 256;
export const FLOAT64_EXPONENT_BIAS = 1023;
export const DB_SCALE_LOG2 = 3.0102999566398; // 10 * Math.log10(2)

// 波形エンコード関連の定数
export const MAX_RECORDED_BAR_HEIGHT = 315;
export const HEIGHT_SCALE_FIRST_DIVISOR = 2;
export const HEIGHT_SCALE_SECOND_DIVISOR = 3;
export const ENCODING_MAX_VALUE = 52;

// 文字エンコード時のインデックス・オフセット値
export const ENCODING_LOWER_CASE_MIN = 11;
export const ENCODING_LOWER_CASE_MAX = 36;
export const ENCODING_LOWER_CASE_SUBTRACT = 10;
export const ASCII_OFFSET_LOWER_CASE = 96;

export const ENCODING_UPPER_CASE_MIN = 37;
export const ENCODING_UPPER_CASE_MAX = 52;
export const ENCODING_UPPER_CASE_SUBTRACT = 36;
export const ASCII_OFFSET_UPPER_CASE = 64;

// 0〜10に対応する特殊文字テーブル
export const SPECIAL_CHAR_MAP = [
  '"', '#', '$', '%', '&', "'", '(', ')', '=', '^', '!'
];

// Canvas描画・色彩関連の定数
export const DEFAULT_BAR_COLOR = '#ff3165';
export const DEFAULT_BAR_THICKNESS = 5;
export const BASE_LIGHTNESS = 50;
export const MIN_LIGHTNESS_LIMIT = 0;
export const MAX_LIGHTNESS_LIMIT = 100;
export const SMOOTH_CURVE_WINDOW_FACTOR = 10;
export const SMOOTH_CURVE_BLEND_DIVISOR = 3;

// ログ記録・FPS計測間隔 (ミリ秒)
export const LOG_FPS_INTERVAL_MS = 1000;

// UI 設定入力デバウンス間隔 (ミリ秒)
export const SETTINGS_INPUT_DEBOUNCE_MS = 120;

// 非同期再計算・分割処理関連の定数
export const RECOMPUTE_CHUNK_SIZE = 250;
export const PREVIEW_LOOKBACK_FRAMES = 15;

// Scratch .sb3 ファイル操作関連
export const STAGE_TARGET_LIST_NAME = '#频谱数据';
export const SB3_REPLACE_TARGET_AUDIO_NAME = '音源';
export const SB3_AUDIO_INTERNAL_FILENAME = '663a96719183b9aa6e9c010d161487c5.mp3';
export const BASE_SB3_LOCAL_URL = './模板.sb3';
export const BASE_SB3_REMOTE_URL = 'https://raw.githubusercontent.com/Leersxie/Audio-Spectrum-Maker-v3-CN/main/%E6%A8%A1%E6%9D%BF.sb3';

// 波形プレビュー表示形式
export const PREVIEW_MODE = {
  WAVE_1: 'wave1',
  WAVE_2: 'wave2',
  CIRCLE_1: 'circle1',
  CIRCLE_2: 'circle2',
  CIRCLE_3: 'circle3'
};
export const DEFAULT_PREVIEW_MODE = PREVIEW_MODE.WAVE_1;

// プレビュー形式に応じたCanvasレイアウト用CSSクラスマップ
export const PREVIEW_MODE_CLASS_MAP = {
  [PREVIEW_MODE.WAVE_1]: 'preview-mode-wave1',
  [PREVIEW_MODE.WAVE_2]: 'preview-mode-wave2',
  [PREVIEW_MODE.CIRCLE_1]: 'preview-mode-circle1',
  [PREVIEW_MODE.CIRCLE_2]: 'preview-mode-circle2',
  [PREVIEW_MODE.CIRCLE_3]: 'preview-mode-circle3'
};

// 円形・上下対称プレビュー描画関連の定数
export const CIRCLE_RADIUS_RATIO_OUT = 0.40;
export const CIRCLE_BAR_SCALE_OUT = 0.45;
export const CIRCLE_RADIUS_RATIO_BOTH = 0.50;
export const CIRCLE_BAR_SCALE_BOTH = 0.40;
export const CIRCLE_RADIUS_RATIO_IN = 0.85;
export const CIRCLE_BAR_SCALE_IN = 0.50;
export const ANGLE_OFFSET_TOP = -Math.PI / 2;
export const FULL_CIRCLE_RADIAN = Math.PI * 2;
export const HALF_DIVISOR = 2;

