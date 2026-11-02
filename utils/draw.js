/* draw.js —— Canvas 2D 绘制原语（AIUI 画布契约，见 aiui-dev/apis-canvas.md）
 * 与 Ardot 画布的差异提示：Canvas 原生支持 textAlign:center / textBaseline:middle，
 * 故本文件 text() 默认以 (x,y) 为「墨中心」；Ardot 则忽略 text-anchor，须按字宽反推。
 * 刻度 / 角标一律用填充四边形表达（沿用画布端验证过的退化几何规避经验）。
 */
import { GREEN_RGB } from './theme.js';

export function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function easeOut(t) { const u = 1 - t; return 1 - u * u; }
export function dist(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

/* 清屏：纯 clearRect 全透明（真机光学透视屏，禁止任何背景实底填充；
 * Craft 模拟器看不出差异，透明背景在模拟器显示为画布默认色属正常） */
export function clear(ctx) {
  ctx.clearRect(0, 0, 480, 352);
}

export function flush(ctx) { if (ctx && ctx.flush) ctx.flush(); }

/* ----------------------------- 圆角矩形 ----------------------------- */

export function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
  } else {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
}

export function fillRoundRect(ctx, x, y, w, h, r, color) {
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = color;
  ctx.fill();
}

export function strokeRoundRect(ctx, x, y, w, h, r, color, width) {
  roundRectPath(ctx, x, y, w, h, r);
  ctx.strokeStyle = color;
  ctx.lineWidth = width || 1;
  ctx.stroke();
}

/* 确认面板标准画法：12% 底纹 + 100% 描边（A5/B4 同规格，禁黑色遮罩） */
export function panel(ctx, x, y, w, h) {
  fillRoundRect(ctx, x, y, w, h, 6, 'rgba(64,255,94,0.12)');
  strokeRoundRect(ctx, x, y, w, h, 6, 'rgba(64,255,94,1)', 1.5);
}

/* ----------------------------- 圆 ----------------------------- */

export function circlePath(ctx, cx, cy, r) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2, false);
}

export function fillCircle(ctx, cx, cy, r, color) {
  circlePath(ctx, cx, cy, r);
  ctx.fillStyle = color;
  ctx.fill();
}

export function strokeCircle(ctx, cx, cy, r, color, width) {
  circlePath(ctx, cx, cy, r);
  ctx.strokeStyle = color;
  ctx.lineWidth = width || 1;
  ctx.stroke();
}

/* 弧段（弧度制，0 = 正右方，顺时针为正） */
export function strokeArc(ctx, cx, cy, r, a0, a1, color, width) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, a0, a1, false);
  ctx.strokeStyle = color;
  ctx.lineWidth = width || 1;
  ctx.stroke();
}

export function dashCircle(ctx, cx, cy, r, color, width, dash) {
  ctx.setLineDash(dash || [4, 4]);
  strokeCircle(ctx, cx, cy, r, color, width);
  ctx.setLineDash([]);
}

export function dashRect(ctx, x, y, w, h, color, width, dash) {
  ctx.setLineDash(dash || [4, 4]);
  ctx.strokeStyle = color;
  ctx.lineWidth = width || 1;
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
}

/* ----------------------------- 羽化收边带（交互 v1.34） -----------------------------
 * 【为什么】旧版场地边界是「3px 底纹 + 内侧面 1px @72% 亮线」。真机反馈：
 *   ① 一根 72% 的实线在单绿透明屏上非常抢眼，比玩法元素还亮 → 眩晕源之一；
 *   ② 一根 1px 细线"单薄、粗糙"，看着像随手画的辅助线，不像设计过的边框。
 * 改为 **band 宽的阶梯衰减带**：贴场地那一面（= 球的物理反弹面）最亮，
 * 向屏幕外侧逐级淡出到近乎全透明 —— 读起来是"羽化收边"而不是"一条线"。
 *
 * 【画法】先铺一层整带 @ 最外级 alpha（兼作打底，杜绝分级之间出现透明缝），
 *   再由内向外叠前 n−1 级。叠加后实际观感 = 1−(1−底)(1−分级)，峰值约 0.40。
 *
 * axis   'v' 竖带（沿 y 铺满、沿 x 衰减） | 'h' 横带（沿 x 铺满、沿 y 衰减）
 * inner  内侧面坐标（'v' 传 x，'h' 传 y）—— 必须落在**场地内侧**那一面
 * ext    { a, len }：'v' 传 { y, h }，'h' 传 { x, w }
 * dir    +1 向外为坐标增大方向；−1 向外为坐标减小方向
 * steps  由内向外等分 band 的 alpha 数组；colorOf(a) 把 alpha 转成颜色
 */
export function fadeBand(ctx, axis, inner, ext, band, dir, steps, colorOf) {
  const n = steps ? steps.length : 0;
  if (!n || !(band > 0)) return;
  const base = steps[n - 1];
  const b0 = dir > 0 ? inner : inner - band;
  if (base > 0.002) {
    ctx.fillStyle = colorOf(base);
    if (axis === 'v') ctx.fillRect(b0, ext.a, band, ext.len);
    else ctx.fillRect(ext.a, b0, ext.len, band);
  }
  const w = band / n;
  for (let i = 0; i < n - 1; i += 1) {
    const a = steps[i];
    if (a <= 0.002) continue;
    const d0 = w * i;
    const q = dir > 0 ? inner + d0 : inner - d0 - w;
    ctx.fillStyle = colorOf(a);
    if (axis === 'v') ctx.fillRect(q, ext.a, w, ext.len);
    else ctx.fillRect(ext.a, q, ext.len, w);
  }
}

/* ----------------------------- 径向光晕面（交互 v1.19） -----------------------------
 * 设计稿定稿：中心 / 选中项 / 面板倒计时不再是「描边圆圈」，而是**光晕面**
 * ——中心最亮、向外径向衰减至全透明。单绿透明屏上这是唯一能表达"聚焦"
 * 又不产生实底的方式（规范禁大面实底，光晕峰值仅 30%，且径向归零）。
 *
 * stops = [[pos, alpha], ...]，pos 为归一化半径 0~1，必须升序。两套形状：
 *   三停 [[0,0.30],[0.55,0.10],[1,0]]  中心 / 选中项 / 面板（见 layout.GLOW）
 *   两停 [[0,a],[1,0]]                  loading 波纹（a 随半径衰减）
 *
 * ⚠ AIUI 红线：createRadialGradient 不在契约确认范围内，真机可能缺失或抛错。
 * 故走「有则用、无则降级」——降级为同心圆由外向内叠加（12 层取样同一条
 * 衰减曲线），观感接近且绝不崩。绝不可裸调 API。 */
export function sampleStops(stops, t) {
  const n = stops.length;
  if (!n) return 0;
  const u = t < 0 ? 0 : (t > 1 ? 1 : t);
  if (u <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < n; i++) {
    if (u <= stops[i][0]) {
      const p0 = stops[i - 1][0], p1 = stops[i][0];
      const a0 = stops[i - 1][1], a1 = stops[i][1];
      const k = p1 === p0 ? 0 : (u - p0) / (p1 - p0);
      return a0 + (a1 - a0) * k;
    }
  }
  return stops[n - 1][1];
}

export function fillGlow(ctx, cx, cy, r, stops, alpha) {
  const k = alpha === undefined ? 1 : clamp(alpha, 0, 1);
  if (k <= 0.01 || r <= 0 || !stops || !stops.length) return;
  if (typeof ctx.createRadialGradient === 'function') {
    try {
      const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      if (gr && typeof gr.addColorStop === 'function') {
        for (let i = 0; i < stops.length; i++) {
          gr.addColorStop(stops[i][0], 'rgba(' + GREEN_RGB + ',' + (stops[i][1] * k) + ')');
        }
        circlePath(ctx, cx, cy, r);
        ctx.fillStyle = gr;
        ctx.fill();
        return;
      }
    } catch (e) { /* 落到降级分支 */ }
  }
  /* 降级：由外向内叠 12 层同心圆，alpha 取该层外缘的衰减值。
   * 后画的较小圆叠在较大圆之上，合成后中心最亮、边缘趋零——与渐变同形。 */
  const N = 12;
  for (let i = N; i >= 1; i--) {
    const a = sampleStops(stops, i / N) * k;
    if (a <= 0.002) continue;
    fillCircle(ctx, cx, cy, r * (i / N), 'rgba(' + GREEN_RGB + ',' + a + ')');
  }
}

/* 两停波纹快捷入口：中心 alpha = a，边缘归零（loading 脉冲用） */
export function fillRipple(ctx, cx, cy, r, a, alpha) {
  fillGlow(ctx, cx, cy, r, [[0, a], [1, 0]], alpha);
}

/* ----------------------------- 径向刻度（填充四边形） ----------------------------- */

/* 单枚径向刻度：以 (cx,cy) 为心，degDeg 角度方向上 r0~r1 的楔形四边形 */
export function tickQuad(ctx, cx, cy, r0, r1, degDeg, w, color) {
  const a = degDeg * Math.PI / 180;
  const dx = Math.cos(a), dy = Math.sin(a);
  const px = -dy, py = dx, hw = w / 2;
  ctx.beginPath();
  ctx.moveTo(cx + dx * r0 + px * hw, cy + dy * r0 + py * hw);
  ctx.lineTo(cx + dx * r0 - px * hw, cy + dy * r0 - py * hw);
  ctx.lineTo(cx + dx * r1 - px * hw, cy + dy * r1 - py * hw);
  ctx.lineTo(cx + dx * r1 + px * hw, cy + dy * r1 + py * hw);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/* n 枚均分刻度（offDeg 为整体相位角，度） */
export function ticks(ctx, cx, cy, r0, r1, n, w, color, offDeg) {
  const off = offDeg || 0;
  for (let i = 0; i < n; i++) tickQuad(ctx, cx, cy, r0, r1, off + i * 360 / n, w, color);
}

/* 指定角度组刻度 */
export function ticksAt(ctx, cx, cy, r0, r1, degs, w, color) {
  for (let i = 0; i < degs.length; i++) tickQuad(ctx, cx, cy, r0, r1, degs[i], w, color);
}

/* ----------------------------- 角标 ----------------------------- */

/* L 形角标（两条短线） */
function cornerL(ctx, x, y, dx, dy, len, color, w) {
  ctx.strokeStyle = color;
  ctx.lineWidth = w || 1;
  ctx.beginPath();
  ctx.moveTo(x + dx * len, y);
  ctx.lineTo(x, y);
  ctx.lineTo(x, y + dy * len);
  ctx.stroke();
}

/* 矩形四角外角标（B1 视口角标）
 * 注：A6 曾用同款 96 方框作「锁定角标」，交互 v1.17 已移除（用户反馈多余）。 */
export function outerCorners(ctx, x, y, w, h, len, color, lw) {
  cornerL(ctx, x, y, 1, 1, len, color, lw);
  cornerL(ctx, x + w, y, -1, 1, len, color, lw);
  cornerL(ctx, x, y + h, 1, -1, len, color, lw);
  cornerL(ctx, x + w, y + h, -1, -1, len, color, lw);
}

/* 面板内嵌四角角标（A5/B4，内缩 inset，§14.4；禁止面板内加分隔线） */
export function innerCorners(ctx, x, y, w, h, inset, len, color) {
  const i = inset;
  cornerL(ctx, x + i, y + i, 1, 1, len, color, 1);
  cornerL(ctx, x + w - i, y + i, -1, 1, len, color, 1);
  cornerL(ctx, x + i, y + h - i, 1, -1, len, color, 1);
  cornerL(ctx, x + w - i, y + h - i, -1, -1, len, color, 1);
}

/* ----------------------------- 文字 ----------------------------- */

/* 默认以 (x,y) 为墨中心（textAlign center + textBaseline middle）。
 * opt: { size, weight, color, mono, align, baseline } */
export function text(ctx, str, x, y, opt) {
  const o = opt || {};
  ctx.font = (o.weight || 400) + ' ' + (o.size || 14) + 'px ' + (o.mono ? 'monospace' : 'sans-serif');
  ctx.fillStyle = o.color || 'rgba(64,255,94,0.72)';
  ctx.textAlign = o.align || 'center';
  ctx.textBaseline = o.baseline || 'middle';
  ctx.fillText(str, x, y);
}

export function measure(ctx, str, opt) {
  const o = opt || {};
  ctx.font = (o.weight || 400) + ' ' + (o.size || 14) + 'px ' + (o.mono ? 'monospace' : 'sans-serif');
  const m = ctx.measureText(str);
  return m && m.width ? m.width : 0;
}

/* 安全测宽（交互 v1.14）：measureText 不在 AIUI 确认 API 范围内，真机可能
 * 返回 0/undefined。故与「字宽估算」取大值——估算按 CJK≈0.99×size、
 * 拉丁/半角≈0.52×size（工程实测值）。取大而非取小，确保底框永不裁切文字。 */
export function textWidth(ctx, str, opt) {
  const o = opt || {};
  const size = o.size || 14;
  let est = 0;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    est += (s.charCodeAt(i) < 0x2e80) ? size * 0.52 : size * 0.99;
  }
  const m = measure(ctx, s, o);
  return Math.max(m, est);
}

/* 折行（v1.52 游玩提示弹窗引入）：按可用宽 maxW 把长串切成多行。
 * 中文没有词边界，逐字累计即可；`textWidth` 已内含「measureText 与字宽估算
 * 取大」，故真机测宽不可用时也不会切出超宽行。
 * ⚠ 收尾标点（，。、；：？！）**不另起一行**——宁可让该行溢出半个字，
 *   也不能把标点顶到行首（中文排版硬伤）。 */
const NO_LINE_HEAD = '，。、；：？！）」』】》%';
export function wrapText(ctx, str, opt, maxW) {
  const s = String(str || '');
  const o = opt || {};
  const lines = [];
  let cur = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s.charAt(i);
    if (cur && textWidth(ctx, cur + ch, o) > maxW && NO_LINE_HEAD.indexOf(ch) < 0) {
      lines.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}
