/**
 * エクスポートモジュール
 * 波形データ（.txt）および Scratch プロジェクト（.sb3）の生成・保存を行います。
 */

import {
  STAGE_TARGET_LIST_NAME,
  SB3_REPLACE_TARGET_AUDIO_NAME,
  SB3_AUDIO_INTERNAL_FILENAME,
  BASE_SB3_LOCAL_URL,
  BASE_SB3_REMOTE_URL
} from './constants.js';
import { generateUuid } from './utils.js';

/**
 * 抜け殻.sb3 ファイルを読み込みます（ローカル優先、失敗時はリモートにフォールバック）
 * @returns {Promise<ArrayBuffer>}
 */
export async function loadBaseSb3() {
  try {
    const localResponse = await fetch(BASE_SB3_LOCAL_URL);
    if (localResponse.ok) {
      return await localResponse.arrayBuffer();
    }
  } catch (localError) {
    console.warn('ローカルの抜け殻.sb3の読み込みに失敗しました。リモートから取得を試行します:', localError);
  }

  const remoteResponse = await fetch(BASE_SB3_REMOTE_URL);
  if (!remoteResponse.ok) {
    throw new Error(`抜け殻.sb3の読み込みに失敗しました (ステータス: ${remoteResponse.status})`);
  }
  return await remoteResponse.arrayBuffer();
}

/**
 * Blobをファイルとしてブラウザでダウンロードさせます
 * @param {Blob} blob - 保存対象のBlob
 * @param {string} filename - 保存ファイル名
 */
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * 波形データをプレーンテキスト (.txt) として保存します
 * @param {string[]} processedDataArray - 各フレームのエンコード文字列配列
 * @param {string} settingsHeader - ヘッダー情報文字列
 */
export function exportAsWaveformTxt(processedDataArray, settingsHeader) {
  const finalOutput = settingsHeader + '\n' + processedDataArray.join('\n');
  const blob = new Blob([finalOutput], { type: 'text/plain;charset=utf-8' });
  triggerDownload(blob, 'spectrum_data.txt');
}

/**
 * 波形データと選択されたオーディオファイルを埋め込んだ Scratch (.sb3) を生成・保存します
 * @param {ArrayBuffer} baseSb3Content - 抜け殻.sb3 のバイナリデータ
 * @param {File} selectedAudioFile - ユーザーが選択した音源ファイル
 * @param {string[]} processedDataArray - 各フレームのエンコード文字列配列
 * @param {string} settingsHeader - ヘッダー情報文字列
 */
export async function exportAsScratchSb3(
  baseSb3Content,
  selectedAudioFile,
  processedDataArray,
  settingsHeader
) {
  if (!baseSb3Content) {
    throw new Error('基础 .sb3 模板文件尚未加载。');
  }
  if (!selectedAudioFile) {
    throw new Error('尚未选择音频源文件。');
  }

  // JSZip を動的に読み込み
  const jszipModule = await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
  const JSZip = jszipModule.default || jszipModule.JSZip || window.JSZip;

  if (!JSZip || typeof JSZip.loadAsync !== 'function') {
    throw new Error('JSZip 库加载失败。');
  }

  const baseSb3Blob = new Blob([baseSb3Content], { type: 'application/x.scratch.sb3' });
  const zip = await JSZip.loadAsync(baseSb3Blob);

  let projectJsonString = await zip.file('project.json').async('text');
  const audioNameRegex = new RegExp(SB3_REPLACE_TARGET_AUDIO_NAME, 'g');
  projectJsonString = projectJsonString.replace(audioNameRegex, selectedAudioFile.name);

  const projectJson = JSON.parse(projectJsonString);
  const stageTarget = projectJson.targets.find((target) => target.isStage === true);

  if (!stageTarget) {
    throw new Error('未找到 Scratch 项目的舞台目标。');
  }

  if (!stageTarget.lists) {
    stageTarget.lists = {};
  }

  let spectrumListId = Object.keys(stageTarget.lists).find(
    (key) => stageTarget.lists[key][0] === STAGE_TARGET_LIST_NAME
  );

  if (!spectrumListId) {
    spectrumListId = generateUuid();
    stageTarget.lists[spectrumListId] = [STAGE_TARGET_LIST_NAME, []];
  }

  // 設定ヘッダーを配列先頭に付加したリストデータを代入
  const fullListData = [settingsHeader, ...processedDataArray];
  stageTarget.lists[spectrumListId][1] = fullListData;

  // project.json をzipに再配置
  zip.file('project.json', JSON.stringify(projectJson));

  // 選択された音源ファイルを所定のハッシュ名で追加
  const audioBuffer = await selectedAudioFile.arrayBuffer();
  zip.file(SB3_AUDIO_INTERNAL_FILENAME, audioBuffer);

  // 新規SB3ファイルを生成してダウンロード
  const newSb3Blob = await zip.generateAsync({ type: 'blob' });
  triggerDownload(newSb3Blob, 'audio_spectrum.sb3');
  return newSb3Blob;
}
