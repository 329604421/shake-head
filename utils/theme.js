/* theme.js —— 单绿视觉令牌唯一来源（PRD-01 §01）
 * 任何页面禁止就地写死色值 / 字号，一律 import 本文件。
 * 单绿单色透明显示：纯黑即透出现实，禁止黑色遮罩；变暗只能降低元素自身 alpha。
 */

export const GREEN_RGB = '64,255,94'; // #40FF5E
export const BG = '#080A09';          // 近黑基底（画布背景，非遮罩）

/* 亮度阶梯 6 级 */
export const L = { P100: 1.0, P72: 0.72, P48: 0.48, P24: 0.24, P12: 0.12, P06: 0.06 };

export function g(a) { return 'rgba(' + GREEN_RGB + ',' + a + ')'; }

export const C = {
  p100: g(L.P100), p72: g(L.P72), p48: g(L.P48),
  p24: g(L.P24), p12: g(L.P12), p06: g(L.P06),
};

/* 字号阶梯（官方 6 级；同屏最多 3 个字级） */
export const FS = { title: 22, block: 16, body: 14, dense: 12, label: 11, mono: 13 };

export function font(size, weight, mono) {
  return weight + ' ' + size + 'px ' + (mono ? 'monospace' : 'sans-serif');
}

/* 图标亮度分档（6 档）：
 * 48/78/110/146/195/210 → 100/72/48/24/12/6%，>210 不绘制（返回 -1）。
 * 注意：iconAlpha 与 frameAlpha 是两套规则，不可混用！ */
export function iconAlpha(d) {
  if (d <= 48) return L.P100;
  if (d <= 78) return L.P72;
  if (d <= 110) return L.P48;
  if (d <= 146) return L.P24;
  if (d <= 195) return L.P12;
  if (d <= 210) return L.P06;
  return -1;
}

/* 圆环框亮度分档（2 档）：d≤195 → 24%，195<d≤210 → 6%，>210 不绘制 */
export function frameAlpha(d) {
  if (d <= 195) return L.P24;
  if (d <= 210) return L.P06;
  return -1;
}

/* 动效时长官方三档 */
export const DUR = { fast: 120, normal: 200, struct: 320 };
export const FRAME_MS = 33; // 30fps 渲染节拍
