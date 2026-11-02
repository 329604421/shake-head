/* overlay.js —— 确认浮层（A5/B4 同规格）与休息关怀提示（F-Sys-09）
 * 面板规格：12% 底纹 + 100% 描边 + 内嵌四角角标 48%
 *          + 倒计时环（r44 光晕面 + 72% 底环 + 100% 进度弧）。
 * 禁止在面板内加分隔线（会横穿标题墨迹）。
 * 【v1.19】倒计时环的 12 细刻度 + 4 主刻度已删（用户反馈"圆形放射性标线
 * 太多"），聚焦语义改由 r44 光晕面承载——与主屏幕中心同一语言。
 */

import { C, g } from './theme.js';
import { PANEL, COUNTDOWN, CONFIRM_MS, GLOW, OVER, READY } from './layout.js';
import {
  panel, text, strokeCircle, strokeArc, innerCorners, fillGlow,
  fillRoundRect, strokeRoundRect, clamp, wrapText,
} from './draw.js';

/* 标题 16/500 墨中心距**面板顶**的偏移。
 * 【v1.21】基准是 A5 的 140 高面板；面板高度不为 140 时按 (h - 140) / 2 补偿。
 * 依据（画布实测）：A5 面板 288×140 @(96,106)、B4 面板 288×152 @(96,100)，
 * 两者倒计时环心同为 (240,202) 不动；面板变高 12px 时画布把上半部分的
 * 标题 / 副标题整体下移 6px。旧实现用固定偏移 → B4 标题比画布高 6px。
 * （B4 在 v1.21 之前没有入边、从未真机显示，故该偏差一直未暴露。）
 * 校验：B4 副标题墨中心 = 100 + 53.5 + 6 = 159.5，画布实测 152 + 15 / 2 = 159.5 ✅ */
const TITLE_DY = 27.5; // 标题 16/500
const SUB_DY = 53.5;   // 副标题 12/400
const PANEL_BASE_H = 140; // 基准面板高（A5 · PANEL.exit.h）

/* 倒计时环：进度弧从正上方顺时针收缩；sweepDeg 为初始弧度（A5=360 / B4=270）
 * alpha 为整体可见度（1 = 常亮）；通关弹窗入场淡入时按 alpha 等比缩放。 */
export function drawCountdown(ctx, remainMs, totalMs, sweepDeg, alpha) {
  const cd = COUNTDOWN;
  const k = alpha === undefined ? 1 : clamp(alpha, 0, 1);
  const total = totalMs || CONFIRM_MS;
  const frac = clamp(remainMs / total, 0, 1);
  const sweep = (sweepDeg === undefined ? 360 : sweepDeg) * frac;

  /* v1.19：光晕面取代 12 细刻度 + 4 主刻度。峰值压到 20%（GLOW.panel）——
   * 面板本身已有 12% 实底，光晕若用 30% 会把倒计时数字糊掉。 */
  fillGlow(ctx, cd.cx, cd.cy, cd.glowR, GLOW.panel, k);
  strokeCircle(ctx, cd.cx, cd.cy, cd.r, g(0.72 * k), 1);                  // 底环 72%
  if (sweep > 0.5) {
    const a0 = -Math.PI / 2;
    strokeArc(ctx, cd.cx, cd.cy, cd.r, a0, a0 + sweep * Math.PI / 180, g(k), 2);
  }
  /* 设计稿定稿字重 Regular（400）——22px 已足够重，500 会与光晕抢视觉 */
  text(ctx, String(Math.max(1, Math.ceil(remainMs / 1000))), cd.cx, cd.cy,
    { size: 22, weight: 400, color: g(k) });
}

/* 确认浮层：opt = { kind:'exit'|'cont', title, subtitle, remainMs, totalMs, sweepDeg } */
export function drawConfirm(ctx, opt) {
  const p = opt.kind === 'cont' ? PANEL.cont : PANEL.exit;
  /* v1.21：面板高度补偿（见 TITLE_DY 注释）。A5 h=140 → dy=0，B4 h=152 → dy=6 */
  const dy = (p.h - PANEL_BASE_H) / 2;
  panel(ctx, p.x, p.y, p.w, p.h);
  innerCorners(ctx, p.x, p.y, p.w, p.h, 8, 10, C.p48);
  text(ctx, opt.title, 240, p.y + TITLE_DY + dy, { size: 16, weight: 500, color: C.p100 });
  text(ctx, opt.subtitle, 240, p.y + SUB_DY + dy, { size: 12, weight: 400, color: C.p72 });
  drawCountdown(ctx, opt.remainMs, opt.totalMs, opt.sweepDeg);
}

/* ─────────── 通关 / 失败弹窗（v1.40 · 五款通用） ───────────
 * 画在最上层（HUD 之后）；其余元素由页面侧先行压暗（游戏内容 6% 隐藏档、
 * HUD 48%），故本弹窗是画面上唯一的高对比信息。
 *
 * 规格沿用 A5/B4 面板语言：12% 底 + 100% 描边 + 内嵌四角角标 48%，
 * 只把「标题 / 倒计时环 / 小字提示」换成结束态三件套。
 *   cleared=true  → 16/500「恭喜，您已通关」+ 全画面撒花
 *   cleared=false → 22/500「GAME OVER」（经典失败文案，不撒花）
 */

/* 撒花粒子：**一次性**随机生成（进入弹窗那一刻），之后每帧按 t 确定性推进。
 * ⚠ 绝不可每帧 Math.random() —— 粒子会在每帧跳到新位置，观感是雪花噪点
 *   而不是"纸片飘落"。 */
export function makeConfetti() {
  const cf = OVER.confetti;
  const list = [];
  for (let i = 0; i < cf.n; i += 1) {
    list.push({
      x: 20 + Math.random() * 440,
      y: cf.top + Math.random() * (cf.bottom - cf.top),
      v: cf.vMin + Math.random() * (cf.vMax - cf.vMin),
      amp: cf.amp * (0.5 + Math.random()),
      ph: Math.random() * Math.PI * 2,
      vert: (i % 3) === 0,     // 1/3 竖条、2/3 横条 —— 交替出"翻转"感
      hi: (i % 2) === 0,       // 亮度两档交替
    });
  }
  return list;
}

/* 撒花推进：匀速下落 + 正弦横摆，落到画面区底部后从顶部循环（无缝） */
function drawConfetti(ctx, list, tMs, alpha) {
  const cf = OVER.confetti;
  const span = cf.bottom - cf.top;
  const t = tMs / 1000;
  for (let i = 0; i < list.length; i += 1) {
    const p = list[i];
    let y = p.y + p.v * t;
    y = ((y - cf.top) % span + span) % span + cf.top;
    const x = p.x + p.amp * Math.sin(2 * Math.PI * cf.hz * t + p.ph);
    const w = p.vert ? cf.thin : cf.bar;
    const h = p.vert ? cf.bar : cf.thin;
    ctx.fillStyle = g((p.hi ? cf.aHi : cf.aLo) * alpha);
    ctx.fillRect(x - w / 2, y - h / 2, w, h);
  }
}

/* opt = { cleared, confetti, t, remainMs, totalMs, alpha } */
export function drawTerminal(ctx, opt) {
  const p = OVER.panel;
  const a = clamp(opt.alpha === undefined ? 1 : opt.alpha, 0, 1);
  if (a <= 0) return;

  /* 撒花画在面板**下层**：先落纸片再铺面板，文案永远压在最上面 */
  if (opt.cleared && opt.confetti) drawConfetti(ctx, opt.confetti, opt.t || 0, a);

  fillRoundRect(ctx, p.x, p.y, p.w, p.h, 6, g(0.12 * a));
  strokeRoundRect(ctx, p.x, p.y, p.w, p.h, 6, g(a), 1.5);
  innerCorners(ctx, p.x, p.y, p.w, p.h, 8, 10, g(0.48 * a));
  /* 通关 16px（7 字 + 逗号 ≈128px）/ 失败 22px「GAME OVER」（≈108px），
   * 两者都远小于面板内宽 288 − 2×16 = 256px。 */
  text(ctx, opt.cleared ? OVER.clearTitle : OVER.failTitle, 240, OVER.titleY,
    { size: opt.cleared ? 16 : 22, weight: 500, color: g(a) });
  drawCountdown(ctx, opt.remainMs, opt.totalMs, 360, a);
  text(ctx, OVER.hint, 240, OVER.hintY, { size: 11, weight: 400, color: g(0.48 * a) });
}

/* ─────────── 游玩提示弹窗（v1.52 · 五款通用，S.READY 态） ───────────
 * 画在最上层（HUD 之后）；游戏内容由页面侧收到 6% 隐藏档、HUD 降到 48%，
 * 与结束弹窗同一套模态语言（12% 底 + 100% 描边 + 内嵌四角角标 48%）。
 *
 * 三块内容（自上而下）：
 *   ① 简要说明   ≤50 字，12/400 @72%，自动折行（≤3 行）
 *   ② 操作说明   小标签 11/500 @48% + 若干行 12/400 @72%（≤3 行）
 *   ③ 底部提示   12/500 @100%；单击后追加倒计时（"准备开始 · 3"）
 *
 * opt = { brief, ops, armed, remainMs, alpha }
 *   armed=false → 底部显示 READY.hint，等用户单击；
 *   armed=true  → 底部显示 READY.hintArmed + 倒计时秒数。
 */
export function drawReady(ctx, opt) {
  const p = READY.panel;
  const a = clamp(opt.alpha === undefined ? 1 : opt.alpha, 0, 1);
  if (a <= 0) return;

  fillRoundRect(ctx, p.x, p.y, p.w, p.h, 6, g(0.12 * a));
  strokeRoundRect(ctx, p.x, p.y, p.w, p.h, 6, g(a), 1.5);
  innerCorners(ctx, p.x, p.y, p.w, p.h, 8, 10, g(0.48 * a));

  const cx = 240;
  const maxW = p.w - READY.padX * 2;
  const briefOpt = { size: 12, weight: 400, color: g(0.72 * a) };
  const opsOpt = { size: 12, weight: 400, color: g(0.72 * a) };

  text(ctx, READY.title, cx, READY.titleY, { size: 16, weight: 500, color: g(a) });

  /* ① 简要说明：折行后逐行居中（与面板语言一致，本屏所有文字都居中） */
  const brief = wrapText(ctx, opt.brief, { size: 12, weight: 400 }, maxW);
  const nB = Math.min(brief.length, READY.briefMax);
  for (let i = 0; i < nB; i += 1) {
    text(ctx, brief[i], cx, READY.briefY + i * READY.briefGap, briefOpt);
  }

  /* ② 操作说明 */
  text(ctx, READY.opsLabel, cx, READY.opsLabelY, { size: 11, weight: 500, color: g(0.48 * a) });
  const ops = opt.ops || [];
  const nO = Math.min(ops.length, READY.opsMax);
  for (let i = 0; i < nO; i += 1) {
    text(ctx, String(ops[i]), cx, READY.opsY + i * READY.opsGap, opsOpt);
  }

  /* ③ 底部提示（+ 倒计时） */
  let hint = READY.hint;
  if (opt.armed) {
    const sec = Math.max(1, Math.ceil((opt.remainMs || 0) / 1000));
    hint = READY.hintArmed + sec;
  }
  text(ctx, hint, cx, READY.hintY, { size: 12, weight: 500, color: g(a) });
}

/* F-Sys-09 休息关怀：非模态浮层，屏幕下方 1/3，12% 底 + 72% 边，可跳过 */
export function drawRestHint(ctx) {
  fillRoundRect(ctx, 110, 270, 260, 40, 6, C.p12);
  strokeRoundRect(ctx, 110, 270, 260, 40, 6, C.p72, 1);
  text(ctx, '晃得有点久了，休息一下眼睛和脖子～', 240, 290, { size: 12, weight: 400, color: C.p72 });
}
