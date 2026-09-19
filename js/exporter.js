/**
 * 导出模块
 * 负责生成、保存波形数据（.txt）以及 Scratch 项目（.sb3）。
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
 * 读取模板 .sb3 文件（优先本地，失败时回退到远程）
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
 * 让浏览器将 Blob 作为文件下载
 * @param {Blob} blob - 要保存的 Blob
 * @param {string} filename - 保存文件名
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
 * 将波形数据保存为纯文本（.txt）
 * @param {string[]} processedDataArray - 各帧的编码字符串数组
 * @param {string} settingsHeader - 头部信息字符串
 */
export function exportAsWaveformTxt(processedDataArray, settingsHeader) {
  const finalOutput = settingsHeader + '\n' + processedDataArray.join('\n');
  const blob = new Blob([finalOutput], { type: 'text/plain;charset=utf-8' });
  triggerDownload(blob, 'spectrum_data.txt');
}

/**
 * 生成、保存嵌入波形数据与所选音频文件后的 Scratch (.sb3)
 * @param {ArrayBuffer} baseSb3Content - 模板 .sb3 的二进制数据
 * @param {File} selectedAudioFile - 用户选择的音频源文件
 * @param {string[]} processedDataArray - 各帧的编码字符串数组
 * @param {string} settingsHeader - 头部信息字符串
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

  // 动态加载 JSZip
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

  // 在数组开头附加设置头部信息后，代入列表数据
  const fullListData = [settingsHeader, ...processedDataArray];
  stageTarget.lists[spectrumListId][1] = fullListData;

  // 将 project.json 重新配置到 zip 中
  zip.file('project.json', JSON.stringify(projectJson));

  // 将所选的音频源文件以规定哈希名添加
  const audioBuffer = await selectedAudioFile.arrayBuffer();
  zip.file(SB3_AUDIO_INTERNAL_FILENAME, audioBuffer);

  // 生成新的 SB3 文件并下载
  const newSb3Blob = await zip.generateAsync({ type: 'blob' });
  triggerDownload(newSb3Blob, 'audio_spectrum.sb3');
  return newSb3Blob;
}
