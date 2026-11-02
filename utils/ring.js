/* ring.js —— 环形入口绘制层（PRD-01 §02/§03/§14）
 * 主页八向与 B2 二向共用同一套绘制与判定（v1.19 起半径统一 R=114）：
 * 圆环形状、点亮阈值、锚定公式、亮度映射、光晕面点亮、标签外浮全部同参。
 */

import {
  CENTER, RING_POS, RING_ANGLE, LIT_DIST, SAFE,
  LIT_GLOW, GLOW, CORE_COUNT, IDLE_CROSSHAIR, ACTIVE_CORE,
  PULSE, LOADING_CORE, LAUNCH_FADE,
  ENTRY_R, LABEL_GAP, LABEL_SIZE, LABEL_WEIGHT, LABEL_H,
} from './layout.js';
import { L, C, g, frameAlpha, iconAlpha } from './theme.js';
import {
  dist, strokeRoundRect, fillRoundRect, strokeCircle, fillCircle, fillGlow, fillRipple, text, textWidth, clamp,
} from './draw.js';
import { drawIcon } from './icons.js';
import { ENTRIES } from './games.js';

/* 构造入口项：radius>0 时以屏心 + RING_ANGLE 重算坐标（服务 B2）；
 * radius=0 时使用 RING_POS 既有坐标（主页）。RING_R = GAME_MENU_R = 114。 */
export function makeItem(pos, base, meta, radius) {
  let bx = base.x, by = base.y;
  if (radius > 0) {
    const a = (RING_ANGLE[pos] || 0) * Math.PI / 180;
    bx = CENTER.x + radius * Math.cos(a);
    by = CENTER.y + radius * Math.sin(a);
  }
  return { pos: pos, baseX: bx, baseY: by, meta: meta };
}

export function buildItems(positions, radius) {
  const items = [];
  for (let i = 0; i < positions.length; i++) {
    let meta = null;
    for (let j = 0; j < ENTRIES.length; j++) {
      if (ENTRIES[j].ringPos === positions[i]) { meta = ENTRIES[j]; break; }
    }
    if (!meta) continue;
    items.push(makeItem(positions[i], RING_POS[positions[i]], meta, radius || 0));
  }
  return items;
}

/* 淡出进度（v1.18 · §14.6）：确认后先在 delayMs 内保持原样（让"已确认"
 * 有一个可见节拍），随后在 durMs 内线性收束到 1。A6/A7 与 B3 共用，
 * 保证主页与游戏页的节拍严格一致。t0 为进入各自 loading 态的时刻。 */
export function launchFade(now, t0) {
  if (!t0) return 0;
  const e = now - t0 - LAUNCH_FADE.delayMs;
  if (e <= 0) return 0;
  return clamp(e / LAUNCH_FADE.durMs, 0, 1);
}

/* 中心交叉淡入进度：0 = 仍是激活中心，1 = 已是 loading 核心，中间两者同场 */
export function coreFade(now, t0) {
  if (!t0) return 0;
  return clamp((now - t0) / LAUNCH_FADE.coreXMs, 0, 1);
}

/* 亮度收束插值（交互 v1.18）：把任意档位 a 沿 fade 拉向 6% 隐藏档。
 * fade=0 保持原档，fade=1 恰好等于 P06 —— 故 A6 末帧与 A7 首帧逐像素相同。 */
export function fadeTo(a, fade) {
  const f = fade > 0 ? (fade > 1 ? 1 : fade) : 0;
  /* fade=1 直接取常量而非插值：浮点误差会让 1 + (0.06-1)*1 = 0.06000000000000005，
   * 与「6% 隐藏档」差了一丝，破坏了「A6 末帧 == A7 首帧逐像素相同」的契约。 */
  if (f >= 1) return L.P06;
  return a + (L.P06 - a) * f;
}

/* 布局：ox/oy 为世界锚定位移；fade 为入口淡出进度 0~1（原布尔 dim 的推广，
 * dim=true 等价于 fade=1，dim=false 等价于 fade=0，旧调用点传布尔仍成立）。
 * 【v1.18】淡出不再瞬变：所有通道（框 / 图标 / 装饰 / 点亮三件套）统一沿
 * fade 收束至 P06；lit 拆成两个语义：
 *   lit = 视觉点亮（绘制用，不受 fade 影响，保证点亮项也是"渐隐"而非"消失"）
 *   sel = 语义点亮（pickLit / 状态判定用，fade 过半即失效，故 A7 仍判无选中） */
export function layoutEntries(items, ox, oy, fade) {
  const f = fade > 0 ? (fade > 1 ? 1 : fade) : 0;
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const x = it.baseX + ox, y = it.baseY + oy;
    const d = dist(x, y, CENTER.x, CENTER.y);
    const lit = d < LIT_DIST;
    let frameA = frameAlpha(d);
    let iconA = iconAlpha(d);
    if (lit) { frameA = L.P100; iconA = L.P100; }
    out.push({
      pos: it.pos, baseX: it.baseX, baseY: it.baseY, meta: it.meta,
      x: x, y: y, d: d,
      lit: lit,
      sel: lit && f < 0.5,
      fade: f,
      frameA: fadeTo(frameA, f),
      iconA: fadeTo(iconA, f),
    });
  }
  return out;
}

export function pickLit(laid) {
  let best = null;
  for (let i = 0; i < laid.length; i++) {
    const it = laid[i];
    if (!it.sel) continue;
    if (!best || it.d < best.d) best = it;
  }
  return best;
}

/* 点亮项专属通道的收束系数（v1.18）：这些通道在 fade=1 时会退到 6%，
 * 与"未点亮项收束后的样子"同档，视觉上即统一隐藏；标签另乘 labK 提前隐去，
 * 避免 A7 中心已有功能名时外圈再挂一个 6% 的重复名字。 */
function labK(fade) {
  const t = clamp((fade - LAUNCH_FADE.labelFrom) / (LAUNCH_FADE.labelTo - LAUNCH_FADE.labelFrom), 0, 1);
  return 1 - t;
}

/* 【v1.19】入口装饰层（原 §14.2 内衬环 r19 + 四方位刻度 r27~31）已整体删除：
 * 用户反馈"圆圈太多、放射性标线太杂"。入口现在只有**一个圈**（48×48 圆角 24），
 * 选中与否由「光晕面 + 底纹 + 描边亮度」区分，不再需要内衬环做层次。 */

/* 点亮标签（v1.20 · **近端对齐**）：文字的近端边缘落在「圆环外缘 + LABEL_GAP」
 * 处，再背向入口向外生长；水平越界镜像，垂直夹回安全区。
 * alpha 随淡出收束（v1.18：标签比其他通道更早隐去，见 labK）。
 *
 * 【v1.20 为什么改】旧实现把文字**居中**于 x + dx*LABEL_OFFSET，而 text()
 * 默认 textAlign='center'，锚点是墨盒中心而非近端。于是近端位置 = 36 − 字宽/2：
 *   3 字「打飞机」w≈33 → 近端 19.5（**已在 r24 圆环内**，压住圆环描边）
 *   4 字「重新游戏」w≈44 → 近端 14（压到图标上）
 *   5 字「导弹指挥部」w≈55 → 近端 8.5（几乎盖住 24px 图标）
 * 即"紧贴功能图标、被遮挡"——字数越多越严重。改为按近端对齐后，近端恒在
 * ENTRY_R + LABEL_GAP = 32，与字数彻底解耦。
 * 注：画布此前一直是左对齐（近端贴环），是**代码**居中导致画布与真机不一致。 */
export function drawEntryLabel(ctx, x, y, str, alpha) {
  let dx = x - CENTER.x, dy = y - CENTER.y;
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  let ux = dx / d;
  const uy = dy / d;
  const opt = { size: LABEL_SIZE, weight: LABEL_WEIGHT };
  const w = textWidth(ctx, str, opt);
  const h = LABEL_H;
  const sx = ux > 0.01 ? 1 : (ux < -0.01 ? -1 : 0);
  const sy = uy > 0.01 ? 1 : (uy < -0.01 ? -1 : 0);
  const off = ENTRY_R + LABEL_GAP;
  let ax = x + ux * off + sx * (w / 2);
  let ay = y + uy * off + sy * (h / 2);
  /* 水平越界 → 镜像到圆环另一侧（v1.18 起的判据保留，改为按墨盒判定） */
  if (sx !== 0 && (ax - w / 2 < SAFE.x || ax + w / 2 > SAFE.x + SAFE.w)) {
    ux = -ux;
    ax = x + ux * off - sx * (w / 2);
  }
  ay = clamp(ay, SAFE.y + h / 2, SAFE.y + SAFE.h - h / 2);
  text(ctx, str, ax, ay, { size: LABEL_SIZE, weight: LABEL_WEIGHT, color: g(alpha) });
}

/* 单个入口本体（v1.19 · §14.3）：
 *   点亮 = 光晕面 r40 + 12% 底纹 + 100% 描边 2px + 图标 + 背向屏心的标签；
 *   未点亮 = 分档描边 1px + 分档图标（无底纹、无光晕）。
 * 【v1.19】删掉 72% 强调环（56×56）与 8 条放射线 —— 选中语义改由光晕面承载。
 * 【v1.18 保留】点亮通道仍沿 it.fade 收束到 6%（fadeTo），是**连续渐隐**而非
 * 瞬间掉档；光晕面同理按 fade 整体衰减，故 A6 → A7 切换点零跳变。 */
export function drawEntry(ctx, it) {
  if (it.frameA < 0) return;
  const f = it.fade || 0;
  if (it.lit) {
    fillGlow(ctx, it.x, it.y, LIT_GLOW, GLOW.lit, 1 - f);
    fillRoundRect(ctx, it.x - 24, it.y - 24, 48, 48, 24, g(fadeTo(0.12, f)));
    strokeRoundRect(ctx, it.x - 24, it.y - 24, 48, 48, 24, g(fadeTo(L.P100, f)), 2);
    drawIcon(ctx, it.meta.iconId, it.x, it.y, g(it.iconA), 24);
    if (it.meta.name) {
      const la = fadeTo(L.P100, f) * labK(f);
      if (la > 0.02) drawEntryLabel(ctx, it.x, it.y, it.meta.name, la);
    }
  } else {
    strokeRoundRect(ctx, it.x - 24, it.y - 24, 48, 48, 24, g(it.frameA), 1);
    drawIcon(ctx, it.meta.iconId, it.x, it.y, g(it.iconA), 24);
  }
}

export function drawEntries(ctx, laid) {
  for (let i = 0; i < laid.length; i++) drawEntry(ctx, laid[i]);
}

/* 待机准星（A1 · v1.19）：光晕面 r70 + 圈 r18 @48% + 中心点 r2.5 @48%。
 * 原「四正向刻度 r26~30 @24%」已删（用户反馈放射性标线太多）。 */
export function drawIdleCrosshair(ctx, cx, cy) {
  fillGlow(ctx, cx, cy, IDLE_CROSSHAIR.glowR, GLOW.core, 1);
  strokeCircle(ctx, cx, cy, IDLE_CROSSHAIR.ringR, C.p48, 1.5);
  fillCircle(ctx, cx, cy, IDLE_CROSSHAIR.dotR, C.p48);
}

/* 激活中心（A3/A4/B2 · v1.19）：**一个圈 + 一片光晕**。
 * 原「三通道 outer34/mid26/inner18 + 四斜向 45° 刻度」已删——三圈叠在一起
 * 在透明屏上糊成一团，且刻度与点亮项挤在同一半径带。现仅 r18 @100%（2px
 * 焦点线）+ r80 光晕，圈内留白给选择态倒计时（drawCoreCountdown）。
 * k = 整体不透明度系数（v1.18 交叉淡入用）：A6 头 coreXMs 内本态以 (1-k)
 * 淡出、loading 核心以 k 淡入，两者同时在场，中心不再硬切。 */
export function drawActiveCore(ctx, cx, cy, k) {
  const a = k === undefined ? 1 : clamp(k, 0, 1);
  if (a <= 0.01) return;
  fillGlow(ctx, cx, cy, ACTIVE_CORE.glowR, GLOW.core, a);
  strokeCircle(ctx, cx, cy, ACTIVE_CORE.ringR, g(L.P100 * a), ACTIVE_CORE.lw);
}

/* 中心倒计时（v1.19 · §14.1）：画在中心圈内部，仅选择中 / 已选中显示。
 * 字级 14/500 等宽（秒数跳动不左右晃），墨中心 = 屏心，压在光晕之上。
 * sec 由调用方按 ceil(剩余 ms / 1000) 给出——与面板倒计时同一取数规则。 */
export function drawCoreCountdown(ctx, cx, cy, sec, alpha) {
  const a = alpha === undefined ? 1 : clamp(alpha, 0, 1);
  if (a <= 0.01) return;
  text(ctx, String(sec), cx, cy, {
    size: CORE_COUNT.size, weight: CORE_COUNT.weight, mono: CORE_COUNT.mono, color: g(a),
  });
}

/* 【v1.19】判定虚线圈（48px 阈值可视化）已删除：它是调试期辅助线，
 * 在成品里与入口圈、中心圈抢视觉重量，且用户从未把它当作有用信息。 */

/* 脉冲环（§14.5 · v1.17）：环自 r0 向 rMax 循环扩散，alpha 随半径由 48%
 * 渐隐至 6%。t01 为 0~1 循环相位（调用方按 cycleMs 取模）。
 * A6 = rMax r1（脉冲初起）；A7 / B3 = rMax r2（持续扩散）。
 * 【v1.17】已移除 96 方框四角锁定角标（用户反馈多余）。
 * 【v1.18】n 支持**小数**，且相位槽位固定为 PULSE.ringSlots(3)：
 * 旧实现用 i/n 分配相位，n 从 2 跳到 3 时所有环相位集体重排（一帧内全环
 * 跳位，这是"跳跃感"的来源之一）。现改为固定槽位 + 末环按小数渐入，
 * A6 → A7 只是在既有两环之外"淡入"第三环，前两环纹丝不动；rMax 亦由调用
 * 方沿淡出进度插值（50 → 62），故环数、半径、亮度三条曲线全部连续。
 * 【v1.19】**光晕波纹**：脉冲不再是描边环，而是径向渐变面（双停 0/1）。
 * alpha 随半径线性插值 —— r38→0.30、r50→0.20、r62→0.12（PULSE.ripple）。
 * 故静止帧截取时恰好等于设计稿那三片同心光晕；描边环版本在透明屏上像
 * "水圈线框"，光晕面才是"能量扩散"。
 * 【v1.18 保留】n 支持**小数**，相位槽位固定为 PULSE.ringSlots(3)：
 * 旧实现用 i/n 分配相位，n 从 2 跳到 3 时所有环相位集体重排（一帧内全环
 * 跳位，这是"跳跃感"的来源之一）。现改为固定槽位 + 末环按小数渐入，
 * A6 → A7 只是在既有两环之外"淡入"第三环，前两环纹丝不动；rMax 亦由调用
 * 方沿淡出进度插值（50 → 62），故环数、半径、亮度三条曲线全部连续。
 * alpha = 整体不透明度（交叉淡入期用）。 */
export function drawPulseRings(ctx, cx, cy, t01, n, rMax, alpha) {
  const cnt = n || 3;
  const ka = alpha === undefined ? 1 : clamp(alpha, 0, 1);
  if (ka <= 0.01) return;
  const top = rMax || PULSE.r2;
  const slots = PULSE.ringSlots || 3;
  const full = Math.floor(cnt + 1e-6);
  const frac = cnt - full;
  const rp = PULSE.ripple || [0.30, 0.20, 0.12];
  for (let i = 0; i < slots; i++) {
    if (i >= full && frac <= 0.001) continue;   // 该槽位尚未启用
    const p = (t01 + i / slots) % 1;
    const r = PULSE.r0 + (top - PULSE.r0) * p;
    /* 半径 → alpha：在 r0(38) / r1(50) / r2(62) 三点间线性插值 */
    let a = r <= PULSE.r1
      ? rp[0] + (rp[1] - rp[0]) * ((r - PULSE.r0) / (PULSE.r1 - PULSE.r0))
      : rp[1] + (rp[2] - rp[1]) * ((r - PULSE.r1) / (PULSE.r2 - PULSE.r1));
    if (i >= full) a *= frac;                   // 末环按小数渐入（0 → 1）
    fillRipple(ctx, cx, cy, r, a, ka);
  }
}

/* 中心 loading 核心（§14.5）：A6 / A7 / B3 共用，保证主页与游戏页
 * 的「已确认 → 等待」视觉严格对称（设计稿同规格，仅图标与标签不同）。
 * o = { iconId, label, t, rings, rMax, alpha, labelA }
 *   alpha  整体不透明度（v1.18：A6 头 coreXMs 与激活中心交叉淡入）
 *   labelA 功能名标签的额外渐入系数（0 则完全不画，A6 前期即如此）
 * 【v1.18】rings / rMax 由调用方沿淡出进度插值，本函数只负责忠实绘制。 */
export function drawLoadingCore(ctx, cx, cy, o) {
  const opt = o || {};
  const a = opt.alpha === undefined ? 1 : clamp(opt.alpha, 0, 1);
  if (a <= 0.01) return;
  drawPulseRings(ctx, cx, cy, opt.t || 0, opt.rings || 3, opt.rMax || PULSE.r2, a);
  /* v1.19：中心 = 光晕面 r90 + r19 底圆（12% 底 + 100% 描边 2px）。
   * 原 r26 的 72% 强调环已删——它和底圆构成"两圈"，与主屏幕其它中心态
   * （单圈 + 光晕）语言不一致，用户明确要求统一。 */
  fillGlow(ctx, cx, cy, LOADING_CORE.glowR, GLOW.core, a);
  fillCircle(ctx, cx, cy, LOADING_CORE.discR, g(L.P12 * a));
  strokeCircle(ctx, cx, cy, LOADING_CORE.discR, g(L.P100 * a), 2);
  if (opt.iconId) drawIcon(ctx, opt.iconId, cx, cy, g(a), LOADING_CORE.iconSize);
  if (opt.label && opt.labelA !== 0) {
    const la = a * (opt.labelA === undefined ? 1 : clamp(opt.labelA, 0, 1));
    if (la > 0.02) {
      text(ctx, opt.label, cx, cy + LOADING_CORE.labelDy, {
        size: LOADING_CORE.labelSize, weight: LOADING_CORE.labelWeight, color: g(la),
      });
    }
  }
}
