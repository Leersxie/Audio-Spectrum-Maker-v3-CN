/**
 * 条柱编辑器模块 (AviUtl 风格特效堆栈系统)
 * 提供生成・编辑・下载波形绘制用条柱图像（纹理）的功能。
 */

import {
  BASE_LIGHTNESS,
  MIN_LIGHTNESS_LIMIT,
  MAX_LIGHTNESS_LIMIT
} from './constants.js';

// 基本默认常量
const DEFAULT_BAR_WIDTH = 24;
const DEFAULT_BAR_HEIGHT = 240;
const DEFAULT_BORDER_RADIUS = 100; // 0% (矩形) 〜 100% (圆角边缘的条柱)
const DEFAULT_BASE_COLOR = '#38bdf8';

const HEX_COLOR_COMPONENT_MAX = 255;
const HEX_RADIX = 16;
const HEX_PAD_LENGTH = 2;

/**
 * 将 HEX 颜色字符串转换为 RGB 分量数值元组的纯函数
 * @param {string} hex
 * @returns {[number, number, number]}
 */
export function hexToRgbComponents(hex) {
  let cleaned = hex.replace('#', '');
  if (cleaned.length === 3) {
    cleaned = cleaned[0] + cleaned[0] + cleaned[1] + cleaned[1] + cleaned[2] + cleaned[2];
  }
  const num = parseInt(cleaned, HEX_RADIX);
  return [
    (num >> 16) & HEX_COLOR_COMPONENT_MAX,
    (num >> 8) & HEX_COLOR_COMPONENT_MAX,
    num & HEX_COLOR_COMPONENT_MAX
  ];
}

/**
 * 由 RGB 分量生成 HEX 颜色字符串的纯函数
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {string}
 */
export function rgbToHex(r, g, b) {
  const toHex = (c) =>
    Math.max(0, Math.min(HEX_COLOR_COMPONENT_MAX, Math.round(c)))
      .toString(HEX_RADIX)
      .padStart(HEX_PAD_LENGTH, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * 按比率(0〜1)对两个 HEX 颜色进行线性插值的纯函数
 * @param {string} color1
 * @param {string} color2
 * @param {number} ratio
 * @returns {string}
 */
export function interpolateHexColors(color1, color2, ratio) {
  const [r1, g1, b1] = hexToRgbComponents(color1);
  const [r2, g2, b2] = hexToRgbComponents(color2);
  const clampedRatio = Math.max(0, Math.min(1, ratio));
  const r = r1 + (r2 - r1) * clampedRatio;
  const g = g1 + (g2 - g1) * clampedRatio;
  const b = b1 + (b2 - b1) * clampedRatio;
  return rgbToHex(r, g, b);
}

/**
 * 可用特效的元数据定义
 */
export const EFFECT_DEFINITIONS = {
  border: {
    type: 'border',
    name: '描边',
    description: '绘制条柱的外框与轮廓线',
    defaultParams: {
      width: 2,
      color: '#ffffff'
    }
  },
  glow: {
    type: 'glow',
    name: '发光 / Bloom',
    description: '赋予发光与光晕扩散（Bloom）效果',
    defaultParams: {
      color: '#38bdf8',
      blur: 10,
      intensity: 2
    }
  },
  gradient: {
    type: 'gradient',
    name: '渐变',
    description: '应用支持多级颜色停靠点与角度调整的高自由度渐变',
    defaultParams: {
      stops: [
        { offset: 0, color: '#38bdf8' },
        { offset: 1, color: '#ec4899' }
      ],
      color1: '#38bdf8',
      color2: '#ec4899',
      color3: '#a855f7',
      useThreeColors: false,
      angle: 0, // 0: 从上到下, 90: 从左到右
      opacity: 100
    }
  },
  shapeArray: {
    type: 'shapeArray',
    name: '图形·图像集合 (数组)',
    description: '绘制圆形、方形、菱形或小图像连续堆叠而成的阵列',
    defaultParams: {
      shapeType: 'rectangle', // 'rectangle' | 'circle' | 'diamond' | 'image'
      size: 8,
      gap: 3,
      customImage: null
    }
  },
  rgbShift: {
    type: 'rgbShift',
    name: 'RGB 偏移 (色彩错位)',
    description: '偏移红·绿·蓝颜色通道，营造赛博朋克·复古风格效果',
    defaultParams: {
      shift: 3,
      angle: 0 // 0: 水平, 90: 垂直
    }
  },
  texture: {
    type: 'texture',
    name: '纹理贴图',
    description: '将上传的图片用作条柱的填充或叠加层',
    defaultParams: {
      image: null,
      mode: '3-slice', // '3-slice' | 'stretch' | 'tile'
      opacity: 100
    }
  }
};

export class BarEditor {
  constructor() {
    // 基本設定 (常時表示・初期状態)
    this.width = DEFAULT_BAR_WIDTH;
    this.height = DEFAULT_BAR_HEIGHT;
    this.borderRadius = DEFAULT_BORDER_RADIUS;
    this.baseColor = DEFAULT_BASE_COLOR;

    // AviUtl 风格特效堆栈
    // 各元素: { id, type, name, enabled, params }
    this.effects = [];

    // 用于 ID 自增
    this._nextEffectId = 1;
  }

  /**
   * 向堆栈添加特效
   * @param {'border' | 'glow' | 'gradient' | 'shapeArray' | 'rgbShift' | 'texture'} type
   * @returns {Object} 已添加的特效实例
   */
  addEffect(type) {
    const def = EFFECT_DEFINITIONS[type];
    if (!def) {
      throw new Error(`未知的特效类型: ${type}`);
    }

    const effectInstance = {
      id: `effect_${this._nextEffectId++}`,
      type: def.type,
      name: def.name,
      enabled: true,
      params: JSON.parse(JSON.stringify(def.defaultParams))
    };

    if (type === 'texture' || type === 'shapeArray') {
      effectInstance.params.image = null;
      effectInstance.params.customImage = null;
    }

    this.effects.push(effectInstance);
    return effectInstance;
  }

  /**
   * 从堆栈中删除特效
   * @param {string} effectId
   */
  removeEffect(effectId) {
    const index = this.effects.findIndex((e) => e.id === effectId);
    if (index !== -1) {
      this.effects.splice(index, 1);
    }
  }

  /**
   * 更改特效的顺序
   * @param {number} fromIndex - 移动源索引
   * @param {number} toIndex - 移动目标索引
   * @returns {boolean} 是否已执行移动
   */
  moveEffect(fromIndex, toIndex) {
    if (
      fromIndex < 0 ||
      fromIndex >= this.effects.length ||
      toIndex < 0 ||
      toIndex >= this.effects.length ||
      fromIndex === toIndex
    ) {
      return false;
    }
    const [target] = this.effects.splice(fromIndex, 1);
    this.effects.splice(toIndex, 0, target);
    return true;
  }

  /**
   * 将指定 ID 的特效向上移动一位（使应用顺序更早）
   * @param {string} effectId
   * @returns {boolean}
   */
  moveEffectUp(effectId) {
    const index = this.effects.findIndex((e) => e.id === effectId);
    if (index > 0) {
      return this.moveEffect(index, index - 1);
    }
    return false;
  }

  /**
   * 将指定 ID 的特效向下移动一位（使应用顺序更晚）
   * @param {string} effectId
   * @returns {boolean}
   */
  moveEffectDown(effectId) {
    const index = this.effects.findIndex((e) => e.id === effectId);
    if (index !== -1 && index < this.effects.length - 1) {
      return this.moveEffect(index, index + 1);
    }
    return false;
  }

  /**
   * 切换特效的启用/禁用
   * @param {string} effectId
   * @param {boolean} enabled
   */
  setEffectEnabled(effectId, enabled) {
    const effect = this.effects.find((e) => e.id === effectId);
    if (effect) {
      effect.enabled = !!enabled;
    }
  }

  /**
   * 更新特效的参数
   * @param {string} effectId
   * @param {string} paramKey
   * @param {*} value
   */
  setEffectParam(effectId, paramKey, value) {
    const effect = this.effects.find((e) => e.id === effectId);
    if (effect && effect.params.hasOwnProperty(paramKey)) {
      effect.params[paramKey] = value;
    }
  }

  /**
   * 安全地规范化获取渐变的颜色停靠点数组
   * @param {Object} params
   * @returns {Array<{ offset: number, color: string }>}
   */
  getNormalizedGradientStops(params) {
    if (Array.isArray(params.stops) && params.stops.length >= 2) {
      return [...params.stops].sort((a, b) => a.offset - b.offset);
    }
    // 从旧属性进行的安全回退
    const fallbackStops = [
      { offset: 0, color: params.color1 || '#38bdf8' }
    ];
    if (params.useThreeColors) {
      fallbackStops.push({ offset: 0.5, color: params.color2 || '#ec4899' });
      fallbackStops.push({ offset: 1, color: params.color3 || '#a855f7' });
    } else {
      fallbackStops.push({ offset: 1, color: params.color2 || '#ec4899' });
    }
    return fallbackStops;
  }

  /**
   * 向指定渐变特效添加新的颜色停靠点
   * @param {string} effectId
   * @param {number} [offset=0.5]
   * @param {string} [color='#a855f7']
   * @returns {boolean}
   */
  addGradientStop(effectId, offset = 0.5, color = '#a855f7') {
    const effect = this.effects.find((e) => e.id === effectId);
    if (!effect || effect.type !== 'gradient') return false;

    if (!Array.isArray(effect.params.stops)) {
      effect.params.stops = this.getNormalizedGradientStops(effect.params);
    }

    const clampedOffset = Math.max(0, Math.min(1, offset));
    effect.params.stops.push({ offset: clampedOffset, color });
    effect.params.stops.sort((a, b) => a.offset - b.offset);
    return true;
  }

  /**
   * 从指定渐变特效删除颜色停靠点（至少保留 2 种颜色）
   * @param {string} effectId
   * @param {number} stopIndex
   * @returns {boolean}
   */
  removeGradientStop(effectId, stopIndex) {
    const effect = this.effects.find((e) => e.id === effectId);
    if (!effect || effect.type !== 'gradient') return false;

    if (!Array.isArray(effect.params.stops)) {
      effect.params.stops = this.getNormalizedGradientStops(effect.params);
    }

    const MIN_STOPS = 2;
    if (effect.params.stops.length <= MIN_STOPS) return false;
    if (stopIndex < 0 || stopIndex >= effect.params.stops.length) return false;

    effect.params.stops.splice(stopIndex, 1);
    return true;
  }

  /**
   * 更新指定渐变特效的颜色停靠点
   * 防止某个停靠点越过其他停靠点导致颜色急剧反转・断裂，
   * 通过平滑地推动相邻停靠点，保证「任何情况下都能平滑地变化颜色」
   * @param {string} effectId
   * @param {number} stopIndex
   * @param {Partial<{ offset: number, color: string }>} updates
   * @returns {boolean}
   */
  updateGradientStop(effectId, stopIndex, updates) {
    const effect = this.effects.find((e) => e.id === effectId);
    if (!effect || effect.type !== 'gradient') return false;

    if (!Array.isArray(effect.params.stops)) {
      effect.params.stops = this.getNormalizedGradientStops(effect.params);
    }

    const stops = effect.params.stops;
    const stop = stops[stopIndex];
    if (!stop) return false;

    if (typeof updates.color === 'string') {
      stop.color = updates.color;
    }

    if (typeof updates.offset === 'number') {
      const MIN_GAP = 0.01; // 1% 的最小间距（防止急剧的硬边缘・反转冲击）
      const count = stops.length;

      // 根据前后停靠点数量计算有效的可移动范围
      const minOffset = stopIndex * MIN_GAP;
      const maxOffset = 1 - (count - 1 - stopIndex) * MIN_GAP;
      const targetOffset = Math.max(minOffset, Math.min(maxOffset, updates.offset));
      stop.offset = targetOffset;

      // 右侧停靠点的连锁推动（Push）
      for (let i = stopIndex + 1; i < count; i++) {
        if (stops[i].offset < stops[i - 1].offset + MIN_GAP) {
          stops[i].offset = stops[i - 1].offset + MIN_GAP;
        }
      }

      // 左侧停靠点的连锁推动（Push）
      for (let i = stopIndex - 1; i >= 0; i--) {
        if (stops[i].offset > stops[i + 1].offset - MIN_GAP) {
          stops[i].offset = stops[i + 1].offset - MIN_GAP;
        }
      }
    }

    return true;
  }

  /**
   * 安全地交换（swap）两个颜色停靠点的颜色顺序
   * 由于位置偏移保持不变，可以平滑地更改颜色的排列顺序
   * @param {string} effectId
   * @param {number} indexA
   * @param {number} indexB
   * @returns {boolean}
   */
  swapGradientStops(effectId, indexA, indexB) {
    const effect = this.effects.find((e) => e.id === effectId);
    if (!effect || effect.type !== 'gradient') return false;

    if (!Array.isArray(effect.params.stops)) {
      effect.params.stops = this.getNormalizedGradientStops(effect.params);
    }

    const stops = effect.params.stops;
    if (indexA < 0 || indexA >= stops.length || indexB < 0 || indexB >= stops.length || indexA === indexB) {
      return false;
    }

    const tempColor = stops[indexA].color;
    stops[indexA].color = stops[indexB].color;
    stops[indexB].color = tempColor;
    return true;
  }

  /**
   * 将颜色停靠点的颜色顺序移动到任意位置 (各槽位的位置偏移保持不变)
   * @param {string} effectId
   * @param {number} fromIndex
   * @param {number} toIndex
   * @returns {boolean}
   */
  moveGradientStop(effectId, fromIndex, toIndex) {
    const effect = this.effects.find((e) => e.id === effectId);
    if (!effect || effect.type !== 'gradient') return false;

    if (!Array.isArray(effect.params.stops)) {
      effect.params.stops = this.getNormalizedGradientStops(effect.params);
    }

    const stops = effect.params.stops;
    if (
      fromIndex < 0 ||
      fromIndex >= stops.length ||
      toIndex < 0 ||
      toIndex >= stops.length ||
      fromIndex === toIndex
    ) {
      return false;
    }

    // 备份各槽位的当前偏移
    const originalOffsets = stops.map((s) => s.offset);

    // 移动数组内的元素
    const [movedStop] = stops.splice(fromIndex, 1);
    stops.splice(toIndex, 0, movedStop);

    // 重新应用各槽位的偏移（保持位置关系，移动颜色顺序）
    stops.forEach((s, idx) => {
      s.offset = originalOffsets[idx];
    });

    return true;
  }

  /**
   * 将所有颜色停靠点均匀分布于 0〜1 之间
   * @param {string} effectId
   * @returns {boolean}
   */
  distributeGradientStops(effectId) {
    const effect = this.effects.find((e) => e.id === effectId);
    if (!effect || effect.type !== 'gradient') return false;

    if (!Array.isArray(effect.params.stops)) {
      effect.params.stops = this.getNormalizedGradientStops(effect.params);
    }

    const stops = effect.params.stops;
    if (stops.length < 2) return false;

    stops.sort((a, b) => a.offset - b.offset);
    const count = stops.length;
    for (let i = 0; i < count; i++) {
      stops[i].offset = i / (count - 1);
    }
    return true;
  }

  /**
   * 插值获取指定渐变特效在特定偏移位置（0〜1）的颜色
   * @param {string} effectId
   * @param {number} offset - 0〜1
   * @returns {string} HEX 颜色代码
   */
  getInterpolatedColorAt(effectId, offset) {
    const effect = this.effects.find((e) => e.id === effectId);
    if (!effect || effect.type !== 'gradient') return '#38bdf8';
    const stops = this.getNormalizedGradientStops(effect.params);
    if (stops.length === 0) return '#38bdf8';
    if (offset <= stops[0].offset) return stops[0].color;
    if (offset >= stops[stops.length - 1].offset) return stops[stops.length - 1].color;

    for (let i = 0; i < stops.length - 1; i++) {
      const left = stops[i];
      const right = stops[i + 1];
      if (offset >= left.offset && offset <= right.offset) {
        const range = right.offset - left.offset;
        const ratio = range === 0 ? 0 : (offset - left.offset) / range;
        return interpolateHexColors(left.color, right.color, ratio);
      }
    }
    return stops[0].color;
  }

  /**
   * 获取指定类型的特效（返回最先找到的）
   * @param {string} type
   * @returns {Object|null}
   */
  getEffect(type) {
    return this.effects.find((e) => e.type === type && e.enabled) || null;
  }

  /**
   * 根据当前特效堆栈计算所需的填充（留白）
   * （由发光、描边、RGB 偏移在条柱周围扩展出的尺寸）
   * @param {number} barWidth
   * @returns {{ top: number, bottom: number, left: number, right: number }}
   */
  calculatePaddings(barWidth = this.width) {
    let padTop = 0;
    let padBottom = 0;
    let padLeft = 0;
    let padRight = 0;

    for (const effect of this.effects) {
      if (!effect.enabled) continue;

      if (effect.type === 'glow') {
        const blur = effect.params.blur || 10;
        const intensity = effect.params.intensity || 1;
        const glowPad = Math.ceil(blur * 1.5) + (intensity - 1) * 3;
        padTop = Math.max(padTop, glowPad);
        padBottom = Math.max(padBottom, glowPad);
        padLeft = Math.max(padLeft, glowPad);
        padRight = Math.max(padRight, glowPad);
      } else if (effect.type === 'border') {
        const strokeW = effect.params.width || 2;
        const borderPad = Math.ceil(strokeW / 2);
        padTop = Math.max(padTop, borderPad);
        padBottom = Math.max(padBottom, borderPad);
        padLeft = Math.max(padLeft, borderPad);
        padRight = Math.max(padRight, borderPad);
      } else if (effect.type === 'rgbShift') {
        const shift = effect.params.shift || 3;
        const shiftPad = Math.ceil(shift);
        padTop = Math.max(padTop, shiftPad);
        padBottom = Math.max(padBottom, shiftPad);
        padLeft = Math.max(padLeft, shiftPad);
        padRight = Math.max(padRight, shiftPad);
      }
    }

    return {
      top: padTop,
      bottom: padBottom,
      left: padLeft,
      right: padRight
    };
  }

  /**
   * 绘制圆角矩形的路径
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @param {number} r
   */
  drawRoundedRectPath(ctx, x, y, w, h, r) {
    const safeRadius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + safeRadius, y);
    ctx.lineTo(x + w - safeRadius, y);
    ctx.arcTo(x + w, y, x + w, y + safeRadius, safeRadius);
    ctx.lineTo(x + w, y + h - safeRadius);
    ctx.arcTo(x + w, y + h, x + w - safeRadius, y + h, safeRadius);
    ctx.lineTo(x + safeRadius, y + h);
    ctx.arcTo(x, y + h, x, y + h - safeRadius, safeRadius);
    ctx.lineTo(x, y + safeRadius);
    ctx.arcTo(x, y, x + safeRadius, y, safeRadius);
    ctx.closePath();
  }

  /**
   * 绘制图形集合（Shape Array）各元素的填充几何形状
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @param {Object} effect
   * @param {number} safeRadius
   */
  drawShapeArrayGeometry(ctx, x, y, w, h, effect, safeRadius) {
    const elemSize = Math.max(2, effect.params.size || 8);
    const gap = Math.max(1, effect.params.gap || 3);
    const step = elemSize + gap;
    const totalElements = Math.floor((h + gap) / step);
    const shapeType = effect.params.shapeType || 'rectangle';

    for (let s = 0; s < totalElements; s++) {
      const elemY = y + h - (s + 1) * step + gap;
      if (elemY < y) break;

      if (shapeType === 'circle') {
        const radius = Math.min(w, elemSize) / 2;
        ctx.beginPath();
        ctx.arc(x + w / 2, elemY + elemSize / 2, radius, 0, Math.PI * 2);
        ctx.fill();
      } else if (shapeType === 'diamond') {
        ctx.beginPath();
        ctx.moveTo(x + w / 2, elemY);
        ctx.lineTo(x + w, elemY + elemSize / 2);
        ctx.lineTo(x + w / 2, elemY + elemSize);
        ctx.lineTo(x, elemY + elemSize / 2);
        ctx.closePath();
        ctx.fill();
      } else if (shapeType === 'image' && effect.params.customImage) {
        ctx.drawImage(effect.params.customImage, x, elemY, w, elemSize);
      } else {
        const elemMaxRadius = Math.min(w / 2, elemSize / 2);
        const radiusPercent = Math.max(0, Math.min(100, Number(this.borderRadius) || 0));
        const elemRadius = (elemMaxRadius * radiusPercent) / 100;
        this.drawRoundedRectPath(ctx, x, elemY, w, elemSize, elemRadius);
        ctx.fill();
      }
    }
  }

  /**
   * 绘制图形集合（Shape Array）各元素的边框
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @param {Object} effect
   * @param {number} safeRadius
   */
  strokeShapeArrayGeometry(ctx, x, y, w, h, effect, safeRadius) {
    const elemSize = Math.max(2, effect.params.size || 8);
    const gap = Math.max(1, effect.params.gap || 3);
    const step = elemSize + gap;
    const totalElements = Math.floor((h + gap) / step);
    const shapeType = effect.params.shapeType || 'rectangle';

    for (let s = 0; s < totalElements; s++) {
      const elemY = y + h - (s + 1) * step + gap;
      if (elemY < y) break;

      if (shapeType === 'circle') {
        const radius = Math.min(w, elemSize) / 2;
        ctx.beginPath();
        ctx.arc(x + w / 2, elemY + elemSize / 2, radius, 0, Math.PI * 2);
        ctx.stroke();
      } else if (shapeType === 'diamond') {
        ctx.beginPath();
        ctx.moveTo(x + w / 2, elemY);
        ctx.lineTo(x + w, elemY + elemSize / 2);
        ctx.lineTo(x + w / 2, elemY + elemSize);
        ctx.lineTo(x, elemY + elemSize / 2);
        ctx.closePath();
        ctx.stroke();
      } else if (shapeType !== 'image') {
        const elemMaxRadius = Math.min(w / 2, elemSize / 2);
        const radiusPercent = Math.max(0, Math.min(100, Number(this.borderRadius) || 0));
        const elemRadius = (elemMaxRadius * radiusPercent) / 100;
        this.drawRoundedRectPath(ctx, x, elemY, w, elemSize, elemRadius);
        ctx.stroke();
      }
    }
  }

  /**
   * 以指定模式绘制纹理图像
   * @param {CanvasRenderingContext2D} ctx
   * @param {HTMLImageElement} img
   * @param {string} mode - 'stretch' | 'tile' | '3-slice'
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @param {number} safeRadius
   */
  drawTexture(ctx, img, mode, x, y, w, h, safeRadius) {
    if (mode === 'stretch') {
      ctx.drawImage(img, x, y, w, h);
    } else if (mode === 'tile') {
      const pattern = ctx.createPattern(img, 'repeat');
      if (pattern) {
        ctx.fillStyle = pattern;
        ctx.fillRect(x, y, w, h);
      }
    } else {
      // 3 切片伸缩 (保持上下两端的形状比例)
      const imgW = img.width;
      const imgH = img.height;
      const sliceTop = Math.min(safeRadius * 2, imgH * 0.3);
      const sliceBottom = Math.min(safeRadius * 2, imgH * 0.3);
      const sliceMid = Math.max(1, imgH - sliceTop - sliceBottom);

      if (h <= sliceTop + sliceBottom) {
        ctx.drawImage(img, 0, 0, imgW, sliceTop, x, y, w, h / 2);
        ctx.drawImage(img, 0, imgH - sliceBottom, imgW, sliceBottom, x, y + h / 2, w, h / 2);
      } else {
        ctx.drawImage(img, 0, 0, imgW, sliceTop, x, y, w, sliceTop);
        ctx.drawImage(img, 0, sliceTop, imgW, sliceMid, x, y + sliceTop, w, h - sliceTop - sliceBottom);
        ctx.drawImage(img, 0, imgH - sliceBottom, imgW, sliceBottom, x, y + h - sliceBottom, w, sliceBottom);
      }
    }
  }

  /**
   * 在指定坐标绘制条柱本体 (用于单独调用)
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   */
  drawBarContent(ctx, x, y, w, h) {
    if (w <= 0 || h <= 0) return;
    const paddings = { top: y, bottom: 0, left: x, right: 0 };
    this.renderFullSprite(ctx, w, h, paddings);
  }

  /**
   * 基于当前设置，绘制一张已应用留白・堆栈顺序中所有特效的完整精灵
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} barWidth
   * @param {number} barHeight
   * @param {{ top: number, bottom: number, left: number, right: number }} paddings
   */
  renderFullSprite(ctx, barWidth, barHeight, paddings) {
    const totalW = barWidth + paddings.left + paddings.right;
    const totalH = barHeight + paddings.top + paddings.bottom;
    const barX = paddings.left;
    const barY = paddings.top;

    // 圆角计算 (0%〜100%)
    const radiusPercent = Math.max(0, Math.min(100, Number(this.borderRadius) || 0));
    const maxRadius = Math.min(barWidth / 2, barHeight / 2);
    const safeRadius = (maxRadius * radiusPercent) / 100;

    // 没有已启用的特效时直接绘制（高速路径）
    const hasActiveEffects = this.effects.some((e) => e.enabled);
    if (!hasActiveEffects) {
      ctx.save();
      this.drawRoundedRectPath(ctx, barX, barY, barWidth, barHeight, safeRadius);
      ctx.fillStyle = this.baseColor;
      ctx.fill();
      ctx.restore();
      return;
    }

    // 工作用离屏 Canvas
    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = totalW;
    layerCanvas.height = totalH;
    const lCtx = layerCanvas.getContext('2d');

    // 0. 基础条柱的初始绘制 (以基本色填充)
    lCtx.save();
    this.drawRoundedRectPath(lCtx, barX, barY, barWidth, barHeight, safeRadius);
    lCtx.fillStyle = this.baseColor;
    lCtx.fill();
    lCtx.restore();

    // 1. 按堆栈顺序应用各特效
    for (let i = 0; i < this.effects.length; i++) {
      const effect = this.effects[i];
      if (!effect.enabled) continue;

      switch (effect.type) {
        case 'shapeArray': {
          if (effect.params.shapeType === 'image' && effect.params.customImage) {
            // 自定义小图集合: 清除现有区域并放置图像
            lCtx.clearRect(0, 0, totalW, totalH);
            this.drawShapeArrayGeometry(lCtx, barX, barY, barWidth, barHeight, effect, safeRadius);
          } else {
            // 图形集合（矩形、圆、菱形）: 以分段形状挖空当前的填充
            const maskCanvas = document.createElement('canvas');
            maskCanvas.width = totalW;
            maskCanvas.height = totalH;
            const mCtx = maskCanvas.getContext('2d');
            mCtx.fillStyle = '#ffffff';
            this.drawShapeArrayGeometry(mCtx, barX, barY, barWidth, barHeight, effect, safeRadius);

            lCtx.save();
            lCtx.globalCompositeOperation = 'destination-in';
            lCtx.drawImage(maskCanvas, 0, 0);
            lCtx.restore();
          }
          break;
        }

        case 'gradient': {
          lCtx.save();
          // 判断此特效之前是否存在已启用的渐变
          const priorGradient = this.effects
            .slice(0, i)
            .some((e) => e.enabled && e.type === 'gradient');

          const opacity = (effect.params.opacity ?? 100) / 100;
          lCtx.globalAlpha = opacity;
          // 首次用 source-in 替换基础色，第二次及以后用 source-atop 在下方渐变之上混合
          lCtx.globalCompositeOperation = priorGradient ? 'source-atop' : 'source-in';

          const angle = (effect.params.angle || 0) * (Math.PI / 180);
          const cx = barX + barWidth / 2;
          const cy = barY + barHeight / 2;
          const length = Math.max(barWidth, barHeight);
          const x0 = cx - (Math.sin(angle) * length) / 2;
          const y0 = cy - (Math.cos(angle) * length) / 2;
          const x1 = cx + (Math.sin(angle) * length) / 2;
          const y1 = cy + (Math.cos(angle) * length) / 2;

          const grad = lCtx.createLinearGradient(x0, y0, x1, y1);
          const stops = this.getNormalizedGradientStops(effect.params);

          // 端点插值: 即使首尾未贴到端点，也让颜色平滑连续
          if (stops.length > 0) {
            if (stops[0].offset > 0) {
              grad.addColorStop(0, stops[0].color || '#ffffff');
            }
            for (const stop of stops) {
              const clampedOffset = Math.max(0, Math.min(1, Number(stop.offset) || 0));
              grad.addColorStop(clampedOffset, stop.color || '#ffffff');
            }
            if (stops[stops.length - 1].offset < 1) {
              grad.addColorStop(1, stops[stops.length - 1].color || '#ffffff');
            }
          }

          lCtx.fillStyle = grad;
          lCtx.fillRect(0, 0, totalW, totalH);
          lCtx.restore();
          break;
        }

        case 'texture': {
          if (effect.params.image) {
            lCtx.save();
            lCtx.globalCompositeOperation = 'source-atop';
            lCtx.globalAlpha = (effect.params.opacity || 100) / 100;
            this.drawTexture(lCtx, effect.params.image, effect.params.mode, barX, barY, barWidth, barHeight, safeRadius);
            lCtx.restore();
          }
          break;
        }

        case 'border': {
          const strokeW = Math.max(1, effect.params.width || 2);
          lCtx.save();
          lCtx.lineWidth = strokeW;
          lCtx.strokeStyle = effect.params.color || '#ffffff';

          // 判断此特效之前是否存在已启用的 shapeArray
          const priorShapeArray = this.effects
            .slice(0, i)
            .reverse()
            .find((e) => e.enabled && e.type === 'shapeArray');

          if (priorShapeArray && priorShapeArray.params.shapeType !== 'image') {
            this.strokeShapeArrayGeometry(lCtx, barX, barY, barWidth, barHeight, priorShapeArray, safeRadius);
          } else {
            this.drawRoundedRectPath(lCtx, barX, barY, barWidth, barHeight, safeRadius);
            lCtx.stroke();
          }
          lCtx.restore();
          break;
        }

        case 'glow': {
          const blur = effect.params.blur || 10;
          const intensity = Math.min(3, Math.max(1, effect.params.intensity || 1));
          const glowColor = effect.params.color || '#38bdf8';

          // 备份当前内容
          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = totalW;
          tempCanvas.height = totalH;
          const tCtx = tempCanvas.getContext('2d');
          tCtx.drawImage(layerCanvas, 0, 0);

          // 绘制发光
          lCtx.clearRect(0, 0, totalW, totalH);
          lCtx.save();
          lCtx.shadowColor = glowColor;
          lCtx.shadowBlur = blur;
          for (let k = 0; k < intensity; k++) {
            lCtx.drawImage(tempCanvas, 0, 0);
          }
          lCtx.restore();

          // 在发光之上叠加备份的原图像 (保持本体轮廓清晰)
          lCtx.drawImage(tempCanvas, 0, 0);
          break;
        }

        case 'rgbShift': {
          const shift = effect.params.shift || 3;
          const angle = (effect.params.angle || 0) * (Math.PI / 180);
          const dx = Math.cos(angle) * shift;
          const dy = Math.sin(angle) * shift;

          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = totalW;
          tempCanvas.height = totalH;
          const tCtx = tempCanvas.getContext('2d');
          tCtx.drawImage(layerCanvas, 0, 0);

          lCtx.clearRect(0, 0, totalW, totalH);
          lCtx.save();
          lCtx.globalCompositeOperation = 'screen';
          lCtx.drawImage(tempCanvas, -dx, -dy);
          lCtx.drawImage(tempCanvas, 0, 0);
          lCtx.drawImage(tempCanvas, dx, dy);
          lCtx.restore();
          break;
        }
      }
    }

    // 将最终结果转写到输出目标 ctx
    ctx.drawImage(layerCanvas, 0, 0);
  }

  /**
   * 在指定画布上绘制单一条柱 (用于预览)
   * @param {HTMLCanvasElement} targetCanvas
   * @param {number} drawWidth
   * @param {number} drawHeight
   */
  renderToCanvas(targetCanvas, drawWidth = this.width, drawHeight = this.height) {
    if (!targetCanvas) return;
    const paddings = this.calculatePaddings(drawWidth);
    const canvasW = drawWidth + paddings.left + paddings.right;
    const canvasH = drawHeight + paddings.top + paddings.bottom;

    targetCanvas.width = canvasW;
    targetCanvas.height = canvasH;

    const ctx = targetCanvas.getContext('2d');
    ctx.clearRect(0, 0, canvasW, canvasH);
    this.renderFullSprite(ctx, drawWidth, drawHeight, paddings);
  }

  /**
   * 根据当前设置，对所有高度 1〜maxHeight 的条柱图像进行预渲染（预烘焙）
   * 为避免发光等留白在下侧产生空隙，以旋转中心（底面中央锚点）进行修正
   * 根据峰值辉度比例，预先生成按条柱高度调整明度的精灵
   * @param {number} maxHeight - 最大高度
   * @param {number} barWidth - 条柱宽度
   * @param {number} peakBrightnessScale - 峰值辉度比例
   * @param {number} canvasHeight - 作为辉度计算基准的画布高度
   * @returns {{ paddings: Object, rotationCenter: Object, sprites: HTMLCanvasElement[], draw: Function }}
   */
  bakeSpriteCache(
    maxHeight = 350,
    barWidth = this.width,
    peakBrightnessScale = 1.0,
    canvasHeight = maxHeight
  ) {
    const paddings = this.calculatePaddings(barWidth);
    const sprites = new Array(maxHeight + 1);
    const spriteWidth = barWidth + paddings.left + paddings.right;
    const safeCanvasHeight = Math.max(1, canvasHeight);

    for (let h = 1; h <= maxHeight; h++) {
      const offscreen = document.createElement('canvas');
      offscreen.width = spriteWidth;
      offscreen.height = h + paddings.top + paddings.bottom;
      const offCtx = offscreen.getContext('2d');

      const normalizedHeight = Math.min(1, h / safeCanvasHeight);
      const minLightness = Math.max(
        MIN_LIGHTNESS_LIMIT,
        BASE_LIGHTNESS * (1 - peakBrightnessScale / 2)
      );
      const lightness = Math.max(
        MIN_LIGHTNESS_LIMIT,
        Math.min(
          MAX_LIGHTNESS_LIMIT,
          minLightness + (BASE_LIGHTNESS - minLightness) * normalizedHeight
        )
      );
      const brightnessFactor = lightness / BASE_LIGHTNESS;

      if (Math.abs(brightnessFactor - 1.0) > 0.001) {
        offCtx.filter = `brightness(${brightnessFactor.toFixed(3)})`;
      }

      this.renderFullSprite(offCtx, barWidth, h, paddings);
      sprites[h] = offscreen;
    }

    // 旋转中心（回转中心 / 锚点）:
    // 以条柱本来的「底边中央」为原点！
    const rotationCenter = {
      x: paddings.left + barWidth / 2,
      getY: (h) => paddings.top + h
    };

    return {
      paddings,
      rotationCenter,
      sprites,
      /**
       * 从预渲染的缓存高速绘制
       * 为了精确对齐底边，进行锚点修正后绘制
       * @param {CanvasRenderingContext2D} targetCtx
       * @param {number} x - 条柱本来的左端 X 坐标
       * @param {number} y - 条柱本来的顶端 Y 坐标
       * @param {number} w - 条柱宽度
       * @param {number} h - 条柱高度
       */
      draw(targetCtx, x, y, w, h) {
        if (h <= 0) return;
        const targetH = Math.min(maxHeight, Math.max(1, Math.round(h)));
        const sprite = sprites[targetH];
        if (sprite) {
          // 偏移左端填充量和顶端填充量后绘制
          // 这样无论下侧的 paddings.bottom 有多大，底边都能与波形的基准线完全一致
          targetCtx.drawImage(sprite, x - paddings.left, y - paddings.top);
        }
      }
    };
  }

  /**
   * 依据当前设置生成独立的纹理 Canvas
   * @returns {HTMLCanvasElement}
   */
  createTextureCanvas() {
    const offscreen = document.createElement('canvas');
    this.renderToCanvas(offscreen, this.width, this.height);
    return offscreen;
  }

  /**
   * 将当前条柱图像下载为透明 PNG 文件
   * @param {string} filename - 保存文件名
   */
  downloadAsPng(filename = 'waveform_bar.png') {
    const exportCanvas = this.createTextureCanvas();
    exportCanvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 'image/png');
  }

  /**
   * 应用预设
   * @param {'neon' | 'led' | 'cyberpunk' | 'fire' | 'solid'} presetName
   */
  applyPreset(presetName) {
    this.effects = [];

    switch (presetName) {
      case 'neon':
        this.baseColor = '#ff007f';
        this.borderRadius = 100;
        {
          const glow = this.addEffect('glow');
          glow.params.color = '#00f5ff';
          glow.params.blur = 14;
          glow.params.intensity = 2;

          const grad = this.addEffect('gradient');
          grad.params.stops = [
            { offset: 0, color: '#00f5ff' },
            { offset: 1, color: '#ff007f' }
          ];
          grad.params.color1 = '#00f5ff';
          grad.params.color2 = '#ff007f';
        }
        break;

      case 'led':
        this.baseColor = '#22c55e';
        this.borderRadius = 0;
        {
          const glow = this.addEffect('glow');
          glow.params.color = '#22c55e';
          glow.params.blur = 6;
          glow.params.intensity = 1;

          const shapes = this.addEffect('shapeArray');
          shapes.params.shapeType = 'rectangle';
          shapes.params.size = 8;
          shapes.params.gap = 3;

          const grad = this.addEffect('gradient');
          grad.params.stops = [
            { offset: 0, color: '#ef4444' },
            { offset: 1, color: '#22c55e' }
          ];
          grad.params.color1 = '#ef4444';
          grad.params.color2 = '#22c55e';
        }
        break;

      case 'cyberpunk':
        this.baseColor = '#06b6d4';
        this.borderRadius = 0;
        {
          const shift = this.addEffect('rgbShift');
          shift.params.shift = 4;
          shift.params.angle = 0;

          const glow = this.addEffect('glow');
          glow.params.color = '#f43f5e';
          glow.params.blur = 8;

          const border = this.addEffect('border');
          border.params.color = '#38bdf8';
          border.params.width = 1;
        }
        break;

      case 'fire':
        this.baseColor = '#ef4444';
        this.borderRadius = 100;
        {
          const glow = this.addEffect('glow');
          glow.params.color = '#f97316';
          glow.params.blur = 12;
          glow.params.intensity = 2;

          const grad = this.addEffect('gradient');
          grad.params.stops = [
            { offset: 0, color: '#fef08a' },
            { offset: 1, color: '#ef4444' }
          ];
          grad.params.color1 = '#fef08a';
          grad.params.color2 = '#ef4444';
        }
        break;

      case 'solid':
      default:
        this.baseColor = '#ff3165';
        this.borderRadius = 100;
        break;
    }
  }
}
