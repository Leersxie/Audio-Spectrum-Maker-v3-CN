/**
 * ユーティリティモジュール
 * 色変換やID生成などの共通処理を提供する純粋関数群です。
 */

const HEX_COLOR_SHORT_LENGTH = 4;
const HEX_COLOR_LONG_LENGTH = 7;
const RGB_MAX_VALUE = 255;
const HUE_CIRCLE_DEGREES = 360;
const PERCENT_SCALE = 100;

/**
 * 16進数カラーコードを HSL 配列 [h (0-360), s (0-100), l (0-100)] に変換する純粋関数
 * @param {string} hex - 16進数カラーコード (例: #ff3165, #f00)
 * @returns {[number, number, number]} [h, s, l]
 */
export function hexToHsl(hex) {
  let red = 0;
  let green = 0;
  let blue = 0;

  if (hex.length === HEX_COLOR_SHORT_LENGTH) {
    red = parseInt(hex[1] + hex[1], 16);
    green = parseInt(hex[2] + hex[2], 16);
    blue = parseInt(hex[3] + hex[3], 16);
  } else if (hex.length === HEX_COLOR_LONG_LENGTH) {
    red = parseInt(hex.substring(1, 3), 16);
    green = parseInt(hex.substring(3, 5), 16);
    blue = parseInt(hex.substring(5, 7), 16);
  }

  red /= RGB_MAX_VALUE;
  green /= RGB_MAX_VALUE;
  blue /= RGB_MAX_VALUE;

  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  let hue = 0;
  let saturation = 0;
  const lightness = (max + min) / 2;

  if (max !== min) {
    const diff = max - min;
    saturation = lightness > 0.5 ? diff / (2 - max - min) : diff / (max + min);
    switch (max) {
      case red:
        hue = (green - blue) / diff + (green < blue ? 6 : 0);
        break;
      case green:
        hue = (blue - red) / diff + 2;
        break;
      case blue:
        hue = (red - green) / diff + 4;
        break;
      default:
        break;
    }
    hue /= 6;
  }

  return [
    hue * HUE_CIRCLE_DEGREES,
    saturation * PERCENT_SCALE,
    lightness * PERCENT_SCALE
  ];
}

/**
 * UUID v4 形式のランダム文字列を生成します
 * @returns {string} UUID文字列
 */
export function generateUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

/**
 * 指定時間内の連続呼び出しを抑制し、最後の呼び出しから指定時間経過後に実行するデバウンス関数
 * @param {Function} func - 実行対象の関数
 * @param {number} waitMs - 待機時間（ミリ秒）
 * @returns {Function} デバウンス化された関数
 */
export function debounce(func, waitMs) {
  let timeoutId = null;
  return function (...args) {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      timeoutId = null;
      func.apply(this, args);
    }, waitMs);
  };
}
