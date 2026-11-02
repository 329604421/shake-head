/* scroll.js —— 二级页滚动列表范式（PRD-01 §08 · 裁决 D-02）
 * 单轴 pitch 直控：±18° 覆盖全程、每帧限幅 ≤12px、抬头=上滚、无惯性、头停即停。
 * 滚动与确认解耦：滚动只改变焦点，任何跳转由单击显式触发（交互 v1.2 全单击语义）。
 */

import { SCROLL } from './layout.js';
import { clamp } from './draw.js';

/* rowCount：内容行数；viewH：视口高度（默认 SCROLL.h） */
export function ScrollList(rowCount, viewH) {
  this.n = rowCount;
  this.rowH = SCROLL.rowH;
  this.viewH = viewH || SCROLL.h;
  this.total = Math.max(0, rowCount * this.rowH - this.viewH);
  this.y = 0;
  this.focus = 0;
  this.atTop = true;
  this.atBottom = this.total <= 0;
}

/* pitchDeg：引擎输出的相对俯仰角（抬头为正）；dtMs：本帧耗时 */
ScrollList.prototype.update = function (pitchDeg, dtMs) {
  const p = 0.5 - clamp(pitchDeg / SCROLL.spanDeg, -1, 1) / 2; // 抬头(+18°)→0(顶部)
  const target = p * this.total;
  const frames = Math.max(1, Math.round((dtMs || 33) / 33));
  const step = SCROLL.maxStep * frames;
  if (this.y < target) this.y = Math.min(target, this.y + step);
  else if (this.y > target) this.y = Math.max(target, this.y - step);
  this.focus = clamp(Math.round((this.y + this.viewH / 2) / this.rowH - 0.5), 0, this.n - 1);
  this.atTop = this.y <= 0.5;
  this.atBottom = this.y >= this.total - 0.5;
  return { y: this.y, focus: this.focus };
};

/* 单行内容 y 坐标（内容坐标系 → 屏幕 y） */
ScrollList.prototype.rowY = function (index, contentTop) {
  return contentTop + index * this.rowH - this.y;
};
