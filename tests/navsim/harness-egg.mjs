/* 接鸡蛋玩法模块冒烟 + 契约断言（本地 node，无需宿主）
 * 运行：cd tests/navsim && node build.mjs && node harness-egg.mjs
 *
 * 覆盖：
 *   E1  几何：球场 352 / 5 轨间距 80 / TRAVEL 152 / 裁剪窗 61~419 / 行程 256px
 *   E2  锚定型相机：篮子恒钉 240、世界反向滑动、camCx 夹紧、篮口 pitch 直控
 *   E3  生成器：只在可见轨道生成（公平性）、相邻不同轨、同屏 ≤3
 *   E4  落物：匀速下落、接住判定内缩 4px、落地判定
 *   E5  接取高度倍率 ×2.0 / ×1.5 / ×1.0
 *   E6  失误：漏接填槽、接炸弹填槽+震屏、炸弹落地无事、满 3 结算
 *   E7  波次：四波推进、48 枚通关、过场 1.2s、炸弹不计入 48
 *   E8  IMU 异常：物理停摆、清空落物、篮子锁中立
 *   E9  三条红线静态检查
 *   E10 result 契约
 *   E11 方向语义锁：横向必须乘 SEM_FOLLOW（与打砖块同源）
 *   E12 冻结语义：不调 update 则 g.t 不推进（B2/B3/B4 靠此自动冻结）
 *   P1  页面接入：B1 推进 / B2 冻结 / 四态 render 不抛错
 *   P2  提示条已撤 + 品牌胶囊仍在（本页相对框架页的差异③）
 *   P3  statusText 钩子（差异④）
 *   P4  结算幂等 + 六类事件只播音不结算
 *   P5  源码契约：两个 fade 分开，且 MENU_FADE = 0.55 而非 1
 */
import fs from 'node:fs';

const { create, update, render, result, camDx, visibleLanes, multOf, TRAVEL, FALL_PX } =
  await import('./utils/eggcatch.js');
const { EGG, VIEWPORT } = await import('./utils/layout.js');
const { SEM_FOLLOW } = await import('./utils/input.js');

const R = [];
function check(name, cond, detail) {
  R.push({ name: name, ok: !!cond, detail: detail || '' });
  console.log('  [' + (cond ? 'PASS' : 'FAIL') + '] ' + name + (detail ? '  — ' + detail : ''));
}
function near(a, b, e) { return Math.abs(a - b) <= (e === undefined ? 0.001 : e); }

/* 记录型 ctx：与 harness-brick 同思路——世界层走 translate，mock 必须真的
 * 累加平移量，否则记下来的是世界坐标，验证不了「篮子屏幕位置恒为 240」。 */
function makeCtx() {
  const texts = [];
  const rects = [];      // { x, y, w, h }  x 已换算到屏幕系
  const moves = [];      // { x, y } moveTo 落点，x 已换算到屏幕系
  let tx = 0;
  const stack = [];
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'fillText') return (s, x, y) => { texts.push({ s: String(s), x: x, y: y }); };
      if (k === 'createRadialGradient') return undefined;  // 强制走同心圆降级
      if (k === 'save') return () => { stack.push(tx); };
      if (k === 'restore') return () => { tx = stack.length ? stack.pop() : 0; };
      if (k === 'translate') return (dx) => { tx += dx || 0; };
      if (k === 'fillRect') return (x, y, w, h) => {
        rects.push({ x: x + tx, y: y, w: w, h: h, style: t.fillStyle });
      };
      if (k === 'moveTo') return (x, y) => { moves.push({ x: x + tx, y: y }); };
      return k in t ? t[k] : function () {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  return { ctx: ctx, texts: texts, rects: rects, moves: moves };
}

const snap = (x, y) => ({ ok: true, x: x || 0, y: y || 0 });
const DOWN = { ok: false, x: 0, y: 0 };
function has(ev, k) { return ev.indexOf(k) >= 0; }
function count(ev, k) { return ev.filter((x) => x === k).length; }

/* 推进 n 帧（每帧 33ms），返回累计事件 */
function run(g, frames, sx, sy) {
  const ev = [];
  const s = snap(typeof sx === 'function' ? sx(0) : sx, sy);
  for (let i = 0; i < frames; i++) {
    if (typeof sx === 'function') s.x = sx(i);
    const e = update(g, 33, s);
    for (let j = 0; j < e.length; j++) ev.push(e[j]);
    if (g.over) break;
  }
  return ev;
}

/* 把相机对准"最紧急"的那枚可接落物（用于"全接住"仿真）
 *   camCx = clamp(240 + SEM_FOLLOW × snap.x) = clamp(240 − snap.x)
 *   要 camCx == 目标 x  →  snap.x = 240 − x
 *
 * ⚠ 两处坑（都是仿真辅助逻辑的缺陷，不是玩法缺陷，改测试而非改模块）：
 *   ① **必须跳过炸弹**。真实玩家会主动躲开（F-EGG-37），照"最低位"去接
 *      等于连吃 3 枚炸弹直接结算 —— 之前 caught=39/miss=3 就是这么来的。
 *   ② **"最紧急"= 剩余到达时间最短，不是"位置最低"**。金蛋落速 ×1.2，
 *      后生成的金蛋可能比先生成的蛋更早到（后来居上），按 y 排序会漏。
 *   ③ 目标轨道本帧恰好有炸弹落进接取带时，先挪到相邻安全轨躲一帧再回来
 *      —— 判定顺序是"炸弹优先"（§10），不躲就会被判定为接到炸弹。 */
function aimSnap(g) {
  const BOMB = 2;
  const DT = 33;
  const lo = g.mouthY, hi = g.mouthY + EGG.BASKET.h;
  const inX = EGG.BASKET.w / 2 - EGG.CATCH_INSET;      // 20 有效半宽

  /* 本帧会落进接取带的炸弹 → 这些 x 是禁区 */
  const forbid = [];
  for (let i = 0; i < g.drops.length; i++) {
    const d = g.drops[i];
    if (!d.on || d.kind !== BOMB) continue;
    const bot = d.y + EGG.DROP.bombR + d.vy * DT / 1000;
    if (bot >= lo && bot <= hi) forbid.push(d.x);
  }

  /* 候选：非炸弹落物，按剩余时间取最紧急 */
  let best = null, bestT = Infinity;
  for (let i = 0; i < g.drops.length; i++) {
    const d = g.drops[i];
    if (!d.on || d.kind === BOMB) continue;
    const tLeft = (lo - (d.y + EGG.DROP.eggRy)) / d.vy;
    if (tLeft < bestT) { bestT = tLeft; best = d; }
  }

  if (best) {
    let want = best.x;
    if (forbid.indexOf(want) >= 0) {
      want = null;
      for (let i = 0; i < EGG.LANES.length; i++) {
        const L = EGG.LANES[i];
        let safe = true;
        for (let k = 0; k < forbid.length; k++) {
          if (Math.abs(forbid[k] - L) <= inX) { safe = false; break; }
        }
        if (safe) { want = L; break; }
      }
      if (want === null) want = best.x;      // 无处可躲（理论上不出现）
    }
    return 240 - want;
  }

  /* 场上只有炸弹（或空场）：站到离所有在场落物最远的轨道，空场回中立 */
  let any = false;
  for (let i = 0; i < g.drops.length; i++) if (g.drops[i].on) any = true;
  if (!any) return 0;
  let bx = 240, bd = -1;
  for (let i = 0; i < EGG.LANES.length; i++) {
    const L = EGG.LANES[i];
    let mind = Infinity;
    for (let k = 0; k < g.drops.length; k++) {
      if (!g.drops[k].on) continue;
      const dd = Math.abs(g.drops[k].x - L);
      if (dd < mind) mind = dd;
    }
    if (mind > bd) { bd = mind; bx = L; }
  }
  return 240 - bx;
}

console.log('\n=== E1 几何与场地（PRD-03 §4.2 / layout.js EGG） ===');
{
  const g = create();
  check('E1a 球场 64~416（w=352，中心 240 与视口同心）',
    EGG.COURT.x === 64 && EGG.COURT.w === 352 && EGG.COURT.x + EGG.COURT.w === 416,
    'x=' + EGG.COURT.x + ' w=' + EGG.COURT.w);
  check('E1b 球场明显窄于视口 448（两侧各留 48px 空白带）',
    VIEWPORT.w - EGG.COURT.w === 96, 'gap=' + (VIEWPORT.w - EGG.COURT.w));
  const L = EGG.LANES;
  check('E1c 5 条轨道 80/160/240/320/400（间距 80，原 96 塞不进 352）',
    L.length === 5 && L.join(',') === '80,160,240,320,400', L.join(','));
  check('E1d 轨道全在球场内且对称（距墙内侧面各 16px）',
    L[0] - 64 === 16 && 416 - L[4] === 16, 'L=' + L[0] + ' R=' + (416 - L[4]));
  check('E1e 行程半幅 TRAVEL = 176 − 24 = 152（由几何算出）',
    TRAVEL === 152, 'TRAVEL=' + TRAVEL);
  check('E1f 落物纵向行程 256px（PRD 附录 B 的 264 是笔误：蛋高 18 非 10）',
    FALL_PX === 256, 'FALL_PX=' + FALL_PX + ' → W1=' + (FALL_PX / 110).toFixed(2)
      + 's W4=' + (FALL_PX / 149).toFixed(2) + 's');
  check('E1g 地面线 332、高/中界 244、中/低界 271',
    EGG.GROUND === 332 && EGG.BAND.hi === 244 && EGG.BAND.mid === 271,
    EGG.GROUND + '/' + EGG.BAND.hi + '/' + EGG.BAND.mid);
  check('E1h 篮口可动区 [218,298]、中立 258（mouthMax 保持 D-EGG-12 裁决）',
    EGG.BASKET.mouthMin === 218 && EGG.BASKET.mouthMax === 298
      && EGG.BASKET.mouthHome === 258,
    '[' + EGG.BASKET.mouthMin + ',' + EGG.BASKET.mouthMax + ']');
  check('E1i 初始：0 分 / 0 失误 / 第 1 波 intro',
    g.score === 0 && g.miss === 0 && g.waveIdx === 0 && g.phase === 'intro',
    g.phase);
}

console.log('\n=== E2 锚定型相机（2026-09-04 用户改造：横向） ===');
{
  const g = create();
  /* 头左转（snap.x = +100）→ camCx 减小 → dx > 0 → 世界整体右滑 */
  update(g, 33, snap(100));
  check('E2a 头左转 snap.x>0 → camCx 减小（240 → 140）',
    near(g.camCx, 140), 'camCx=' + g.camCx);
  check('E2b dx = 240 − camCx > 0（世界反向滑动）',
    near(camDx(g), 100), 'dx=' + camDx(g));
  update(g, 33, snap(-100));
  check('E2c 头右转 → camCx 增大（240 → 340）、dx < 0',
    near(g.camCx, 340) && near(camDx(g), -100),
    'camCx=' + g.camCx + ' dx=' + camDx(g));
  /* 夹紧：snap.x 远超行程 */
  update(g, 33, snap(9999));
  check('E2d camCx 夹紧到 [88, 392]（= 240 ∓ TRAVEL）',
    near(g.camCx, 88, 0.001), 'camCx=' + g.camCx);
  update(g, 33, snap(-9999));
  check('E2e 反向夹紧到 392', near(g.camCx, 392, 0.001), 'camCx=' + g.camCx);

  /* 篮子屏幕位置恒为 240（锚定型的核心承诺，用 mock ctx 实测） */
  const m = makeCtx();
  g.drops.forEach((d) => { d.on = false; });   // 清空落物，首个 moveTo 即篮子
  g.shakeT = -1;
  render(g, m.ctx, 0);
  check('E2f 篮子屏幕 x 恒钉 240（路径起点 = 240 − 24 = 216）',
    m.moves.length > 0 && near(m.moves[0].x, 216, 0.001),
    'firstMoveTo.x=' + (m.moves[0] ? m.moves[0].x : 'n/a'));

  /* 世界层确实跟着 dx 走：地面线世界 x=64 → 屏幕 x = 64 + dx */
  const m2 = makeCtx();
  update(g, 33, snap(100));                    // camCx=140, dx=+100
  render(g, m2.ctx, 0);
  const ground = m2.rects.filter((r) => r.y === EGG.GROUND && r.w === 352);
  check('E2g 地面线世界 x=64 平移到屏幕 164（dx=+100 生效）',
    ground.length === 1 && near(ground[0].x, 164, 0.001),
    ground.length ? 'x=' + ground[0].x : '未找到地面线');

  /* 纵向仍是直控（pitch），且与横轴解耦（F-EGG-04） */
  const g2 = create();
  update(g2, 33, snap(100, 80));               // 头左转 + 抬头
  check('E2h 抬头 snap.y=+80 → 篮口升到 218（258 − 40）',
    near(g2.mouthY, 218), 'mouthY=' + g2.mouthY);
  check('E2i 轴解耦：抬头不改变 camCx（仍为 140）',
    near(g2.camCx, 140), 'camCx=' + g2.camCx);
  const g3 = create();
  update(g3, 33, snap(0, -100));
  check('E2j 低头夹紧到 mouthMax 298（snap.y×0.5 超 ±40 被夹）',
    near(g3.mouthY, 298), 'mouthY=' + g3.mouthY);
  check('E2k 轴解耦：低头/抬头不改变 camCx（保持 240）',
    near(g3.camCx, 240), 'camCx=' + g3.camCx);
}

console.log('\n=== E3 生成器：可见性 + 相邻不同轨 + 同屏上限 ===');
{
  /* 相机居中：5 条全可见 */
  check('E3a 相机居中时 5 条轨道全可见',
    visibleLanes(240).length === 5, visibleLanes(240).join(','));
  /* 相机推到极限：远端滑出裁剪窗（VIS_HALF = 419 − 240 − 8 = 171） */
  const vl = visibleLanes(88);
  check('E3b 相机最左 88 时，最右轨 400 不可见（88+171=259 < 400）',
    vl.indexOf(400) < 0 && vl.length === 3, 'visible=' + vl.join(','));
  const vr = visibleLanes(392);
  check('E3c 相机最右 392 时，最左轨 80 不可见（392−171=221 > 80）',
    vr.indexOf(80) < 0 && vr.length === 3, 'visible=' + vr.join(','));

  /* 生成的所有落物在**生成瞬间**都必须落在裁剪窗内（公平性：
   * 看不见的蛋 = 必漏，而在"漏 3 个就结算"的规则下这是致命的不公平）。
   * ⚠ 只校验生成瞬间——之后玩家转头导致已生成的蛋滑出窗是**预期行为**，
   *   由离屏指示器补偿，不该算在生成器头上。 */
  /* ⚠ 采集样本期间要屏蔽失误结算并让局永远打不完，否则漏 3 个就 over、
   * 样本量只有个位数（spawned=4）根本验不出东西。这里把 miss 每帧清零、
   * over 就重开一局，只关心"生成瞬间是否可见"这一件事。 */
  let g = create();
  g.phase = 'wave'; g.phaseT = 0;
  let spawned = 0, outside = 0;
  for (let i = 0; i < 4000; i++) {
    if (g.over) { g = create(); g.phase = 'wave'; g.phaseT = 0; }
    g.miss = 0;
    const sx = Math.round(Math.sin(i / 37) * 150);   // 来回扫动相机
    const before = g.drops.map((d) => d.on);
    update(g, 33, snap(sx));
    for (let k = 0; k < g.drops.length; k++) {
      if (!g.drops[k].on || before[k]) continue;     // 只取本帧新生成的
      const screenX = g.drops[k].x + camDx(g);
      spawned++;
      if (screenX < 61 - 0.5 || screenX > 419 + 0.5) outside++;
    }
  }
  check('E3d 生成的瞬间落物都在裁剪窗内（无"看不见的必漏蛋"）',
    spawned > 30 && outside === 0,
    'spawned=' + spawned + ' outside=' + outside);

  /* 相邻不同轨（F-EGG-3A）+ 同屏上限 3（F-EGG-39） */
  const g2 = create();
  g2.phase = 'wave';
  let maxOn = 0;
  let lastLane = -1, sameAdj = 0;
  const lanesSeen = {};
  for (let i = 0; i < 3000; i++) {
    const before = g2.drops.filter((d) => d.on).map((d) => d.x);
    update(g2, 33, snap(0));
    const after = g2.drops.filter((d) => d.on);
    if (after.length > maxOn) maxOn = after.length;
    /* 新增的那枚不得与上一枚同轨 */
    const added = after.filter((d) => before.indexOf(d.x) < 0 || countX(before, d.x) < countX(after.map((a) => a.x), d.x));
    for (let k = 0; k < added.length; k++) {
      if (added[k].x === lastLane && after.length > 1) sameAdj++;
      lastLane = added[k].x;
      lanesSeen[added[k].x] = 1;
      spawned++;
    }
    if (g2.over) break;
  }
  check('E3e 同屏落物 ≤ 3（池长即上限）', maxOn <= 3, 'maxOn=' + maxOn);
  check('E3f 相邻两次生成不同轨（F-EGG-3A）', sameAdj === 0, 'sameAdj=' + sameAdj);
}
function countX(arr, x) { return arr.filter((v) => v === x).length; }

console.log('\n=== E4 落物：匀速下落 + 接住/落地判定（§5.3） ===');
{
  const g = create();
  g.phase = 'wave'; g.phaseT = 0;
  g.drops.forEach((d) => { d.on = false; });
  /* 手动放一枚正对篮子的蛋（篮子世界 x = camCx = 240） */
  const d = g.drops[0];
  d.on = true; d.x = 240; d.kind = 0; d.vy = 110; d.y = 58 + 9;
  const y0 = d.y;
  update(g, 100, snap(0));            // dt 钳到 100ms
  check('E4a 匀速下落：110px/s × 0.1s = 11px',
    near(d.y - y0, 11, 0.001), 'Δy=' + (d.y - y0));

  /* 接住：底边进入 [mouthY, mouthY+18] 且水平中心在 camCx ± 20 内 */
  const g2 = create();
  g2.phase = 'wave';
  g2.drops.forEach((x) => { x.on = false; });
  const e2 = g2.drops[0];
  e2.on = true; e2.x = 240; e2.kind = 0; e2.vy = 110;
  e2.y = 258 + 9 - 5;                 // 底边 = 258+4，已在篮口带内
  const ev2 = update(g2, 33, snap(0));
  check('E4b 正对篮子的蛋被接住（catch 事件）', has(ev2, 'catch'), 'ev=' + ev2.join(','));
  check('E4c 接住后 +10 分（中区 ×1.5 → round(10×1.5)=15）',
    g2.score === 15, 'score=' + g2.score);
  check('E4d 接住后 caught +1（计入 48 枚进度）', g2.caught === 1, 'caught=' + g2.caught);

  /* 边缘擦过不算接住（内缩 4px，F-EGG-34）：中心距篮心 21 > 20 */
  const g3 = create();
  g3.phase = 'wave';
  g3.drops.forEach((x) => { x.on = false; });
  const e3 = g3.drops[0];
  e3.on = true; e3.x = 240 + 21; e3.kind = 0; e3.vy = 110;
  e3.y = 258 + 9 - 5;
  const ev3 = update(g3, 33, snap(0));
  check('E4e 中心距篮心 21px（> 20 有效半宽）→ 擦过不接住',
    !has(ev3, 'catch'), 'ev=' + ev3.join(','));
  /* 内缩边界内：中心距 20 恰好接住 */
  const g4 = create();
  g4.phase = 'wave';
  g4.drops.forEach((x) => { x.on = false; });
  const e4 = g4.drops[0];
  e4.on = true; e4.x = 240 + 20; e4.kind = 0; e4.vy = 110;
  e4.y = 258 + 9 - 5;
  const ev4 = update(g4, 33, snap(0));
  check('E4f 中心距篮心 20px（= 内缩后有效半宽）→ 恰好接住',
    has(ev4, 'catch'), 'ev=' + ev4.join(','));

  /* 落地：底边 ≥ 332 */
  const g5 = create();
  g5.phase = 'wave';
  g5.drops.forEach((x) => { x.on = false; });
  const e5 = g5.drops[0];
  e5.on = true; e5.x = 240 - 100; e5.kind = 0; e5.vy = 110;   // 远离篮子
  e5.y = 332 - 9 - 1;
  const ev5 = update(g5, 33, snap(0));
  check('E4g 未接住的蛋落地（底边 ≥ 332）→ fail + 失误 +1',
    has(ev5, 'fail') && g5.miss === 1, 'ev=' + ev5.join(',') + ' miss=' + g5.miss);
}

console.log('\n=== E5 接取高度倍率（§5.4） ===');
{
  check('E5a 篮口 ≤244 → ×2.0', multOf(218) === 2.0 && multOf(244) === 2.0,
    multOf(218) + '/' + multOf(244));
  check('E5b 244 < y ≤ 271 → ×1.5（中立位 258 落中区）',
    multOf(245) === 1.5 && multOf(258) === 1.5 && multOf(271) === 1.5,
    multOf(258) + '');
  check('E5c y > 271 → ×1.0（低区不显示标签）',
    multOf(272) === 1.0 && multOf(298) === 1.0, multOf(298) + '');
  /* 端到端：抬头到高区接蛋，得分应为 ×2.0 */
  const g = create();
  g.phase = 'wave';
  g.drops.forEach((x) => { x.on = false; });
  const d = g.drops[0];
  d.on = true; d.x = 240; d.kind = 0; d.vy = 110;
  d.y = 218 + 9 - 5;
  update(g, 33, snap(0, 80));     // 抬头 → mouthY = 218
  check('E5d 高区接蛋 = round(10 × 2.0) = 20 分',
    g.score === 20 && near(g.mouthY, 218), 'score=' + g.score + ' mouthY=' + g.mouthY);
  const g2 = create();
  g2.phase = 'wave';
  g2.drops.forEach((x) => { x.on = false; });
  const d2 = g2.drops[0];
  d2.on = true; d2.x = 240; d2.kind = 0; d2.vy = 110;
  d2.y = 290 + 9 - 5;
  update(g2, 33, snap(0, -100));  // 低头 → mouthY = 298
  check('E5e 低区接蛋 = round(10 × 1.0) = 10 分',
    g2.score === 10, 'score=' + g2.score + ' mouthY=' + g2.mouthY);
}

console.log('\n=== E6 失误槽与失败（F-EGG-50~53） ===');
{
  /* 漏接 3 次 → 结算 */
  const g = create();
  g.phase = 'wave';
  let n = 0;
  while (!g.over && n < 6000) {
    g.drops.forEach((d) => { d.on = false; });
    const d = g.drops[0];
    d.on = true; d.x = 80; d.kind = 0; d.vy = 110; d.y = 331 - 9;   // 立刻落地
    update(g, 33, snap(-9999));        // 相机推到最右，80 号轨远离篮子
    n++;
  }
  check('E6a 漏接 3 次 → miss 满 3 且 over',
    g.miss === 3 && g.over === true, 'miss=' + g.miss + ' over=' + g.over);
  check('E6b 失败时 cleared = false', g.cleared === false, 'cleared=' + g.cleared);

  /* 接到炸弹：填 1 格 + 震屏，0 分 */
  const g2 = create();
  g2.phase = 'wave';
  g2.drops.forEach((x) => { x.on = false; });
  const b = g2.drops[0];
  b.on = true; b.x = 240; b.kind = 2; b.vy = 110; b.y = 258 + 8 - 5;
  const ev = update(g2, 33, snap(0));
  check('E6c 接到炸弹 → boom + 填 1 格 + 震屏 300ms',
    has(ev, 'boom') && g2.miss === 1 && g2.shakeT > 0 && g2.shakeT <= 300,
    'ev=' + ev.join(',') + ' miss=' + g2.miss + ' shakeT=' + g2.shakeT);
  check('E6d 接到炸弹 0 分、不计入 caught',
    g2.score === 0 && g2.caught === 0, 'score=' + g2.score + ' caught=' + g2.caught);

  /* 炸弹落地：无事发生，记「躲开炸弹」（F-EGG-37 正确对策无惩罚） */
  const g3 = create();
  g3.phase = 'wave';
  g3.drops.forEach((x) => { x.on = false; });
  const b3 = g3.drops[0];
  b3.on = true; b3.x = 80; b3.kind = 2; b3.vy = 110; b3.y = 331 - 8;
  const ev3 = update(g3, 33, snap(-9999));
  check('E6e 炸弹落地：不填槽、不发 fail、bombDodged +1',
    g3.miss === 0 && !has(ev3, 'fail') && g3.bombDodged === 1,
    'miss=' + g3.miss + ' dodged=' + g3.bombDodged + ' ev=' + ev3.join(','));

  /* 震屏衰减：300ms 后归位（不残留位移，F-EGG-60） */
  const g4 = create();
  g4.phase = 'wave';
  g4.drops.forEach((x) => { x.on = false; });
  const b4 = g4.drops[0];
  b4.on = true; b4.x = 240; b4.kind = 2; b4.vy = 110; b4.y = 258 + 8 - 5;
  update(g4, 33, snap(0));
  for (let i = 0; i < 12; i++) update(g4, 33, snap(0));   // 12 × 33 = 396ms
  check('E6f 震屏 300ms 后归位（shakeT = -1，无残留位移）',
    g4.shakeT === -1, 'shakeT=' + g4.shakeT);
}

console.log('\n=== E7 波次：四波推进 + 48 枚通关（§6） ===');
{
  check('E7a 波次表 4 波、每波 need 12、间隔 1300/1100/950/800',
    EGG.WAVES.length === 4
      && EGG.WAVES.map((w) => w.need).join(',') === '12,12,12,12'
      && EGG.WAVES.map((w) => w.gapMs).join(',') === '1300,1100,950,800',
    EGG.WAVES.map((w) => w.gapMs).join(','));
  check('E7b 落速 110/121/134/149',
    EGG.WAVES.map((w) => w.speed).join(',') === '110,121,134,149',
    EGG.WAVES.map((w) => w.speed).join(','));
  check('E7c 权重 1:0:0 / 7:1:0 / 7:1:2 / 6:1:3（炸弹 W3 起登场）',
    EGG.WAVES.map((w) => w.w.egg + ':' + w.w.gold + ':' + w.w.bomb).join(' ')
      === '1:0:0 7:1:0 7:1:2 6:1:3',
    EGG.WAVES.map((w) => w.w.egg + ':' + w.w.gold + ':' + w.w.bomb).join(' '));
  check('E7d 金蛋落速倍率 1.2（F-EGG-31）', EGG.GOLD_SPEED_K === 1.2, '' + EGG.GOLD_SPEED_K);

  /* 过场 1.2s：intro 期间不生成落物 */
  const g = create();
  const ev = run(g, 30, 0);        // 30 × 33 = 990ms < 1200
  check('E7e intro 过场 1.2s 内不生成落物',
    g.phase === 'intro' && g.drops.filter((d) => d.on).length === 0,
    'phase=' + g.phase);
  const ev2 = run(g, 10, 0);       // 累计 1320ms > 1200
  check('E7f 过场结束进入 wave', g.phase === 'wave', 'phase=' + g.phase);

  /* 波次切换：本波 12 枚生成完毕 → 等在场落物清空 → gap */
  const g2 = create();
  g2.phase = 'wave'; g2.phaseT = 0;
  let guard = 0;
  while (g2.phase !== 'gap' && guard < 4000) {
    update(g2, 33, snap(aimSnap(g2)));     // 尽量接住，加速清空
    guard++;
  }
  check('E7g W1 完成 → 进入 gap（过场）', g2.phase === 'gap', 'phase=' + g2.phase);
  check('E7h 切 gap 时在场落物已清空（F-EGG-40）',
    g2.drops.filter((d) => d.on).length === 0, '');
  check('E7i 切 gap 时本波已生成 12 枚有效枚', g2.waveSpawned === 12,
    'waveSpawned=' + g2.waveSpawned);

  /* 全接住仿真：一路对准，跑到通关 */
  const g3 = create();
  let frames = 0;
  while (!g3.over && frames < 20000) {
    update(g3, 33, snap(aimSnap(g3)));
    frames++;
  }
  check('E7j 全接住 → 通关（cleared = true）', g3.cleared === true,
    'cleared=' + g3.cleared + ' caught=' + g3.caught + ' miss=' + g3.miss);
  check('E7k 通关时接满 48 枚', g3.caught === 48, 'caught=' + g3.caught);
  check('E7l 通关 reachedLevel = 4', result(g3).reachedLevel === 4,
    'reachedLevel=' + result(g3).reachedLevel);
  check('E7m 得分区间合理（全接 ≥ 670，且 ≤ 1340 上限）',
    g3.score >= 670 && g3.score <= 1340, 'score=' + g3.score);
  const secs = (g3.t / 1000).toFixed(1);
  check('E7n 单局净时长 55~80s（含 4 次过场，比 PRD 的 60s 略长：'
    + '等在场落物处理完再切场的偏差）', g3.t / 1000 >= 55 && g3.t / 1000 <= 80,
    secs + 's');
}

console.log('\n=== E8 IMU 异常降级（§10） ===');
{
  const g = create();
  g.phase = 'wave';
  update(g, 33, snap(100));
  const camBefore = g.camCx;
  const tBefore = g.t;
  const ev = update(g, 33, DOWN);
  check('E8a IMU 异常 → imuDown = true', g.imuDown === true, '');
  check('E8b 立即清空在场落物（禁止无输入继续落蛋，NFR-05）',
    g.drops.filter((d) => d.on).length === 0, '');
  check('E8c 篮子锁中立位（camCx 240 / mouthY 258）',
    near(g.camCx, 240) && near(g.mouthY, 258),
    'cam=' + g.camCx + ' mouth=' + g.mouthY);
  check('E8d IMU 异常帧不产生任何玩法事件', ev.length === 0, 'ev=' + ev.join(','));
  const t1 = g.t;
  update(g, 33, DOWN);
  check('E8e 游戏内时钟 g.t 仍推进（冻结靠页面不调 update，非模块内停钟）',
    g.t > t1, 'Δt=' + (g.t - t1));
}

console.log('\n=== E9 三条红线静态检查（F-EGG-82/85/83 同类） ===');
{
  const src = fs.readFileSync(new URL('../../utils/eggcatch.js', import.meta.url), 'utf8');
  /* 先剥注释再扫：红线说明本身就写在头注释里，裸扫会把注释里的
   * 「禁止 Date.now()」误判成违规。 */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('E9a 无 Date.now（游戏内时钟唯一时间源）', code.indexOf('Date.now') < 0);
  check('E9b 无 setTimeout / setInterval', !/setTimeout|setInterval/.test(code));
  check('E9c 不 import sfx / storage（事件与落盘全归页面）',
    !/from\s+'\.\/sfx\.js'|from\s+'\.\/storage\.js'|import\s+\*\s+as\s+sfx/.test(src));
  check('E9d 不绘制黑色遮罩（无全屏深色 fillRect）',
    !/fillRect\(\s*ctx\s*,\s*0\s*,\s*0\s*,\s*480\s*,\s*352/.test(src));
  check('E9e 变暗统一走 ring.js 的 fadeTo', /fadeTo/.test(src));
  check('E9f 不 import wx（零宿主依赖，可本地仿真）',
    !/from\s+'wx'|from\s+"wx"/.test(src));
}

console.log('\n=== E10 result 契约（§7.1） ===');
{
  const g = create();
  g.score = 780; g.waveIdx = 2; g.goldCaught = 5; g.bombDodged = 7;
  const r = result(g);
  check('E10a score / cleared / reachedLevel 齐备',
    r.score === 780 && r.cleared === false && r.reachedLevel === 3,
    'score=' + r.score + ' lv=' + r.reachedLevel);
  check('E10b extra 两项：金蛋接取 / 躲开炸弹',
    r.extra.length === 2 && r.extra[0].label === '金蛋接取'
      && r.extra[1].label === '躲开炸弹',
    JSON.stringify(r.extra));
  check('E10c extra label ≤ 4 字（本册收紧口径）',
    r.extra.every((x) => x.label.length <= 4), '');
  check('E10d extra value 为字符串',
    r.extra.every((x) => typeof x.value === 'string'), '');
}

console.log('\n=== E11 方向语义锁：横向必须乘 SEM_FOLLOW ===');
{
  const src = fs.readFileSync(new URL('../../utils/eggcatch.js', import.meta.url), 'utf8');
  check('E11a 源码锁：横向相机使用 SEM_FOLLOW', /SEM_FOLLOW/.test(src));
  check('E11b SEM_FOLLOW = −1（与打砖块同源，非本册自定）',
    SEM_FOLLOW === -1, 'SEM_FOLLOW=' + SEM_FOLLOW);
  /* 端到端：头左转后，世界（地面线）必须向【右】滑 */
  const g = create();
  update(g, 33, snap(100));
  const m = makeCtx();
  render(g, m.ctx, 0);
  const ground = m.rects.filter((r) => r.y === EGG.GROUND && r.w === 352);
  check('E11c 头左转 → 地面线屏幕 x 右移（64 → 164，反向滑动成立）',
    ground.length === 1 && ground[0].x > 64,
    ground.length ? 'x=' + ground[0].x : 'n/a');
}

console.log('\n=== E12 冻结语义：不调 update 则玩法停摆 ===');
{
  const g = create();
  run(g, 200, 0);                  // 跑到 W1 生成若干
  const t0 = g.t;
  const snapshot = JSON.stringify(g.drops);
  /* 模拟 B2/B3/B4：页面只调 render，不调 update */
  for (let i = 0; i < 30; i++) render(g, makeCtx().ctx, 0.55);
  check('E12a 冻结 30 帧后 g.t 不变（B2/B3/B4 自动停钟）',
    g.t === t0, 'Δt=' + (g.t - t0));
  check('E12b 冻结期间落物状态完全不变（无补发、无重复结算）',
    JSON.stringify(g.drops) === snapshot, '');
  check('E12c 冻结帧可正常渲染且接受 fade（不抛错）', true, 'fade=0.55');
  /* 恢复后继续推进 */
  const before = g.t;
  update(g, 33, snap(0));
  check('E12d 解冻后从冻结时刻续算（不重置波次进度）',
    g.t > before && g.phase === 'wave', 'Δt=' + (g.t - before));
}

console.log('\n=== P1 页面接入（B1 推进 / 冻结契约） ===');
{
  const { default: page } = await import('./pages/eggcatch/eggcatch.mjs');
  const { makeItem } = await import('./utils/ring.js');
  const { GAME_MENU_IDLE } = await import('./utils/layout.js');
  const c = makeCtx();

  let redirected = 0;
  const nav = [];
  const wxMod = await import('./wx-mock.mjs');
  /* wx 是 default 导出的单例对象，直接给它的 redirectTo 打桩即可计数 */
  const wxd = wxMod.default;
  wxd.redirectTo = function (o) { redirected++; nav.push(o && o.url); if (o && o.success) o.success({}); };

  function setup() {
    page.engine = {
      imuOk: true, running: true,
      update() { return { x: 0, y: 0 }; },
      snapshot() { return { x: 0, y: 0 }; },
      freezeDrift() {}, recenter() {}, stop() {}, start() {}, resetBase() {},
      stats: { toMotion() { return {}; } },
    };
    page.gesture = { tick() {}, onKeyDown() {}, onKeyUp() {}, cancel() {} };
    page.meta = { id: 'egg', name: '接鸡蛋', kind: 'game', iconId: 'egg' };
    page.gameId = 'egg';
    page.menuItems = [
      makeItem('L', GAME_MENU_IDLE.L, { id: 'home', name: '退回主页面', iconId: 'home', kind: 'home' }, 0),
      makeItem('R', GAME_MENU_IDLE.R, { id: 'restart', name: '重新游戏', iconId: 'refresh', kind: 'restart' }, 0),
    ];
    page.ctx = c.ctx;
    page.setData = function () {};
    page._lit = null;
    page.initPlay();
    page.state = 'PLAY';
  }

  setup();
  check('P1a initPlay 建出玩法状态（0 分 / 0 失误 / intro 过场）',
    !!page.eg && page.eg.score === 0 && page.eg.miss === 0 && page.eg.phase === 'intro',
    page.eg ? ('score=' + page.eg.score + ' miss=' + page.eg.miss + ' phase=' + page.eg.phase)
      : 'no eg');

  const t0 = page.eg.t;
  page._last = 1000000;
  page.tick();
  check('P1b B1 推进玩法（g.t 随帧累加）', page.eg.t > t0, 't ' + t0 + ' → ' + page.eg.t);

  /* 冻结契约（F-EGG-60）：MENU 态不得推进玩法 */
  page.state = 'MENU';
  page.menuAt = 1000000;
  const t1 = page.eg.t;
  page.tick();
  check('P1c B2 菜单态不推进玩法（画面冻结，F-EGG-60）',
    page.eg.t === t1, 't ' + t1 + ' → ' + page.eg.t);

  /* 四态 render 全跑一遍：B2/B3/B4 走的是「两个 fade 分开」的分支，
   * PLAY 分支测不到，必须各渲染一次才能确认没有空引用。 */
  setup();
  const rerr = [];
  ['PLAY', 'MENU', 'CONT', 'LOADING'].forEach(function (st) {
    page.state = st;
    page.menuAt = 1000000; page.contAt = 1000000; page.loadingAt = 1000000;
    try { page.render(1000000, { ok: true, x: 0, y: 0 }); }
    catch (e) { rerr.push(st + ':' + e.message); }
  });
  check('P1d B1/B2/B3/B4 四态 render 均不抛错（含两个 fade 分支）',
    rerr.length === 0, rerr.join(' / '));

  console.log('\n=== P2 提示条已撤（本页相对框架页的差异③） ===');
  page.state = 'PLAY';
  c.texts.length = 0;
  page.render(1000000, { ok: true, x: 0, y: 0 });
  const HINTS = ['单击触控唤出菜单', '单击触控确认选择', '转头选择，单击返回游戏',
    '单击触控立即继续', '正在打开…'];
  const leaked = HINTS.filter((h) => c.texts.some((t) => t.s === h));
  check('P2a 画面不含提示条五态文案中的任何一条', leaked.length === 0, leaked.join('|'));
  const brand = c.texts.find((t) => t.s === '接鸡蛋');
  check('P2b 左上品牌胶囊仍由框架写入游戏名（未丢失）', !!brand, brand ? 'ok' : '缺品牌名');

  console.log('\n=== P3 statusText 钩子（本页相对框架页的差异④） ===');
  setup();
  check('P3a 第 1 波 → 「第 1 波」', page.statusText() === '第 1 波', page.statusText());
  page.eg.waveIdx = 2;
  check('P3b 第 3 波 → 「第 3 波」', page.statusText() === '第 3 波', page.statusText());
  page.eg.imuDown = true;
  check('P3c IMU 异常 → 返回空串（交还框架显示「IMU状态异常」+ 空心圆点）',
    page.statusText() === '', '"' + page.statusText() + '"');
  page.eg.imuDown = false;
  page.eg.waveIdx = 3;
  check('P3d 状态文案一律 ≤6 字（胶囊可用宽 ≈7 字）',
    page.statusText().length <= 6, page.statusText());
  const h = page._hudStatus();
  check('P3e _hudStatus 走 statusText 分支（优先级最高）',
    h.text === '第 4 波' && h.dot === true, h.text + ' dot=' + h.dot);

  console.log('\n=== P4 结算幂等 + 事件播音映射（F-EGG-72） ===');
  setup();
  redirected = 0; nav.length = 0;
  page._handleEvents(['finished']);
  page._handleEvents(['finished']);
  page._handleEvents(['finished']);
  /* v1.40：finished 不再直接 redirectTo 结算页 —— 先落成绩，再进本页的通用
   * 结束弹窗（B5 通关 / GAME OVER），由弹窗的 5s 倒计时 / 单击统一回主页。 */
  check('P4a finished 连续投递三次 → 只结算一次（幂等，落在结束弹窗）',
    page.state === 'OVER' && page._done === true, 'state=' + page.state);
  check('P4b 不再直接跳结算页（v1.40：先弹窗，5s / 单击后回主页）',
    redirected === 0, 'redirected=' + redirected);
  /* 弹窗的两个离开出口：满 5 秒自动、未满 5 秒单击 —— 都必须走同一条 B3 握手 */
  const { OVER: OVER_GG } = await import('./utils/layout.js');
  check('P4g OVER 态 render 不抛错（含 drawOver + HUD 降级分支）', (() => {
    try { page.render(Date.now(), { ok: true, x: 0, y: 0 }); return true; }
    catch (e) { return false; }
  })(), '');
  page.overAt = Date.now() - OVER_GG.ms - 1;
  page.tick();
  check('P4e 满 5 秒 → 自动进 B3 loading（kind=home）',
    page.state === 'LOADING' && page.loadingKind === 'home',
    'state=' + page.state + ' kind=' + page.loadingKind);
  setup();
  page._handleEvents(['finished']);
  page.onTap();
  check('P4f 未满 5 秒单击 → 提前回主页（与倒计时同一出口）',
    page.state === 'LOADING' && page.loadingKind === 'home',
    'state=' + page.state + ' kind=' + page.loadingKind);
  setup();
  redirected = 0; nav.length = 0;
  page._handleEvents(['catch', 'gold', 'fail', 'boom', 'wave', 'clear']);
  check('P4c 六类玩法事件均不触发结算（只播音）', redirected === 0, 'redirected=' + redirected);
  const r = page.buildResult();
  check('P4d buildResult 补齐 durationSec + motion（用游戏内时钟 g.t）',
    typeof r.durationSec === 'number' && !!r.motion && typeof r.motion.yawUtil === 'number',
    'durationSec=' + r.durationSec);
}

console.log('\n=== P5 源码契约：两个 fade 必须分开，且 B2 用 0.55 不用 1 ===');
{
  /* 背景同打砖块 P5：框架页因画面区只有占位框，content 与 entry 共用同一个
   * fade。本页若照抄，MENU 态会把**菜单本身**一起打到 6%，菜单直接不可见。
   * 本册额外锁一条：MENU_FADE 必须是 0.55（次要层），写成 1 会塌到 6% 隐藏档
   * —— 那是 B3/B4「本局即将离场」的语义，用在 B2 暂停快选上是错的。 */
  const src0 = fs.readFileSync(new URL('../../pages/eggcatch/eggcatch.js', import.meta.url), 'utf8');
  /* 同 E9：先剥注释。本页头注释里就写明了「两个 fade 分开」与 MENU_FADE 的
   * 取值理由，裸扫必然命中自己写的说明文字。 */
  const src = src0.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('P5a 定义了 contentFade 与 entryFade 两个变量',
    /const\s+contentFade\s*=/.test(src) && /const\s+entryFade\s*=/.test(src));
  check('P5b MENU 态：contentFade = MENU_FADE（次要层）且 entryFade = 0（菜单恒亮）',
    /contentFade\s*=[\s\S]{0,120}MENU_FADE/.test(src)
    && /entryFade\s*=\s*this\.state\s*===\s*S\.CONT\s*\?\s*1/.test(src));
  check('P5c MENU_FADE = 0.55（不是 1 → 不会塌到 6% 隐藏档）',
    /const\s+MENU_FADE\s*=\s*0\.55\s*;/.test(src));
  check('P5d 未调用 drawHint（提示条已撤）', !/drawHint\s*\(/.test(src));
  check('P5e 未绘制框架页占位（drawPlayfield）', !/drawPlayfield/.test(src));
}


console.log('\n=== E13 篮子细节（v1.39 精修：卷边 / 编织格 / 底板） ===');
{
  /* 背景：此前篮子就是一个 12% 填充的梯形轮廓，读作「梯形」而不是「篮子」。
   * 补三处结构后才是柳条篮。E2f 已锁首个 moveTo，本组只管细节件。 */
  const g2 = create();
  g2.drops.forEach((d) => { d.on = false; });
  const m = makeCtx();
  render(g2, m.ctx, 0);
  const BK = EGG.BASKET;
  const my = BK.mouthHome, by = my + BK.h;

  const rim = m.rects.filter((r) => r.y === my && r.w === BK.w + 2 && r.h === 2);
  check('E13a 篮口卷边 50 宽（比篮口各外挑 1px）、2px 高', rim.length === 1, 'n=' + rim.length);

  const vs = m.rects.filter((r) => r.w === 1 && r.y > my && r.y < by);
  check('E13b 3 条竖柳条（编织格的纵条）', vs.length === 3, 'n=' + vs.length);

  const hs = m.rects.filter((r) => r.h === 1 && r.y > my && r.y < by
    && r.w > BK.bottomW && r.w < BK.w);   /* 梯形收窄区间 (32,48)，排除场地横线 */
  check('E13c 2 道横箍，宽度随梯形收窄递减（42.7 → 37.3）',
    hs.length === 2 && hs[0].w > hs[1].w,
    'w=' + hs.map((r) => r.w.toFixed(1)).join('/'));

  const bp = m.rects.filter((r) => r.y === by - 2 && r.w === BK.bottomW && r.h === 2);
  check('E13d 篮底板 32 宽 2px 高（有底才「兜得住」）', bp.length === 1, 'n=' + bp.length);
}

const pass = R.filter((r) => r.ok).length;
const fail = R.length - pass;
console.log('\n=== harness-egg: ' + pass + '/' + R.length + ' 通过'
  + (fail ? '，' + fail + ' 项失败' : '') + ' ===');
if (fail) {
  console.log('失败项：');
  R.filter((r) => !r.ok).forEach((r) => console.log('  ✗ ' + r.name + '  — ' + r.detail));
  process.exit(1);
}
