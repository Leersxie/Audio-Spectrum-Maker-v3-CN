/**
 * 波形データエンコードモジュール
 * 各バーの高さデータをScratchのリスト形式で扱える文字列へ変換する純粋関数群です。
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
 * 1本のバーの高さを1文字のエンコード文字に変換する純粋関数
 * @param {number} height - バーの高さ (0〜)
 * @returns {string} エンコードされた1文字
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
 * 記録されたすべてのフレームのバー高さをエンコードし、Scratchリスト用文字列配列に変換する純粋関数
 * @param {number[][]} heights - 各フレームのバーの高さ配列
 * @param {number} interval - サンプリング間隔 (n分の1)
 * @returns {string[]} フレームごとのエンコード文字列配列
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

  // 完全無音（ダブルクォートのみで構成される行）は空文字列に変換し、空行を残す
  return processedFrames.map((line) => {
    return /^"+$/.test(line.trim()) ? '' : line;
  });
}
