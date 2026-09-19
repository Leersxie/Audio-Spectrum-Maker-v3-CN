/**
 * 波形数据编码模块
 * 将各条柱的高度数据转换为可用 Scratch 列表形式处理的字符串的一批纯函数。
 */

import {
  MAX_RECORDED_BAR_HEIGHT,
  HEIGHT_SCALE_FIRST_DIVISOR,
  HEIGHT_SCALE_SECOND_DIVISOR,
  ENCODING_MAX_VALUE,
  SPECIAL_CHAR_MAP,
  ENCODING_LOWER_CASE_MIN,
  ENCODING_LOWER_CASE_MAX,
  ENCODING_LOWER_CASE_SUBTRACT,
  ASCII_OFFSET_LOWER_CASE,
  ENCODING_UPPER_CASE_MIN,
  ENCODING_UPPER_CASE_MAX,
  ENCODING_UPPER_CASE_SUBTRACT,
  ASCII_OFFSET_UPPER_CASE
} from './constants.js';

/**
 * 将 1 根条柱的高度转换为 1 个编码字符的纯函数
 * @param {number} height - 条柱的高度 (0〜)
 * @returns {string} 编码后的 1 个字符
 */
export function encodeBarValue(height) {
  const cappedHeight = Math.min(height, MAX_RECORDED_BAR_HEIGHT);
  const halved = Math.floor(cappedHeight / HEIGHT_SCALE_FIRST_DIVISOR);
  const result = Math.min(
    Math.round(halved / HEIGHT_SCALE_SECOND_DIVISOR),
    ENCODING_MAX_VALUE
  );

  if (result >= 0 && result < SPECIAL_CHAR_MAP.length) {
    return SPECIAL_CHAR_MAP[result];
  }

  if (result >= ENCODING_LOWER_CASE_MIN && result <= ENCODING_LOWER_CASE_MAX) {
    return String.fromCharCode(
      ASCII_OFFSET_LOWER_CASE + result - ENCODING_LOWER_CASE_SUBTRACT
    );
  }

  if (result >= ENCODING_UPPER_CASE_MIN && result <= ENCODING_UPPER_CASE_MAX) {
    return String.fromCharCode(
      ASCII_OFFSET_UPPER_CASE + result - ENCODING_UPPER_CASE_SUBTRACT
    );
  }

  return SPECIAL_CHAR_MAP[0];
}

/**
 * 将记录的所有帧的条柱高度编码，转换为 Scratch 列表用字符串数组的纯函数
 * @param {number[][]} heights - 各帧的条柱高度数组
 * @param {number} interval - 采样间隔 (取 n 分之一)
 * @returns {string[]} 每帧对应的编码字符串数组
 */
export function processRecordedBarHeights(heights, interval = 1) {
  const safeInterval = Math.max(1, interval);
  const processedFrames = [];

  for (const frame of heights) {
    const processedBarValues = [];
    for (let i = 0; i < frame.length; i += safeInterval) {
      processedBarValues.push(encodeBarValue(frame[i]));
    }
    processedFrames.push(processedBarValues.join(''));
  }

  // 将完全无声（仅由双引号构成的行）转换为空字符串，并保留空行
  return processedFrames.map((line) => {
    return /^"+$/.test(line.trim()) ? '' : line;
  });
}
