/* 打飞机玩法模块冒烟 + 契约断言（本地 node，无需宿主）
 * 运行：cd tests/navsim && node build.mjs && node harness-plane.mjs
 *
 * 覆盖：
 *   A1  几何：战场 352 / 裁剪窗 61~419 / TRAVEL 164 / 编队包围盒 224 / 行程 112
 *   A2  锚定型 yaw 相机：机体恒钉 240、世界反向滑动、camCx 夹紧 [76,404]
 *   A3  pitch 直控：home 282、行程 [202,322]（上 80 / 下 40，v1.38 抬高上限）
 *   A4  编队步进：初速 8、每杀 +3%、封顶 24、触边下移 16、单程 14s
 *   A5  失守判定：底排下缘 142 起、触边 9 次越 y=276
 *   A6  自动射击：0.4s 一发、侦察 1 血 / 攻击 2 血、分值 10 / 30
 *   A7  敌弹：间隔随击落缩短（下限 800）、速度随击落提高（封顶 160）、命中损命
 *   A8  投弹：2 枚 / 同屏 1 枚 / 引爆线 y=144 / 扩散波扫过即毁
 *   A9  轰炸机：P3 入场、5 血 80 分、32px/s、撞机损 2 命、到防线失守
 *   A10 俯冲：P3 触发、直线下压、同屏 ≤2、出屏底回归空位
 *   A11 生命与无敌：3 命、2s 无敌、无敌期免疫、命尽结算
 *   A12 通关：18 + 1 全灭 → cleared
 *   A13 IMU 异常：玩法停摆、机体锁中立
 *   A14 三条红线静态检查
 *   A15 渲染：机体恒钉 240 / 墙随相机滑 / 墙外留白 / 离屏轰炸机指示器
 *   A16 result 契约 + statusText 口径
 *   A17 方向语义锁：横向必须乘 SEM_FOLLOW
 *   A18 冻结语义：不调 update 则玩法停摆
 *   P1  页面接入：B1 推进 / B2 冻结 / 四态 render 不抛错
 *   P2  提示条已撤 + 品牌胶囊仍在
 *   P3  statusText 钩子「剩余 N」
 *   P4  tapRole='fire'：单击 = 投弹（不进菜单）、滑动 = 唤出 B2
 *   P5  滑动后 300ms 内单击忽略（F-PLN-76）
 *   P6  结算幂等 + 玩法事件只播音不结算
 *   P7  源码契约：两个 fade 分开，且 MENU_FADE = 0.55 而非 1
 */
import fs from 'node:fs';

const {
  create, update, render, result, bomb, grantGrace,
  camDx, formSpeed, eGapMs, eSpeed, aliveCount, formationBottom,
  waveRadius, statusText, TRAVEL, FORM_W, FORM_TRAVEL,
} = await import('./utils/plane.js');
const { PLANE, VIEWPORT, CENTER } = await import('./utils/layout.js');
const { SEM_FOLLOW } = await import('./utils/input.js');

const R = [];
function check(name, cond, detail) {
  R.push({ name: name, ok: !!cond, detail: detail || '' });
  console.log('  [' + (cond ? 'PASS' : 'FAIL') + '] ' + name + (detail ? '  — ' + detail : ''));
}
function near(a, b, e) { return Math.abs(a - b) <= (e === undefined ? 0.001 : e); }

/* 记录型 ctx：关心 fillText 落点 + **屏幕系** fillRect / 多边形 / 圆。
 * 相机版后世界层整体走 translate，因此 mock 必须真的累加平移量，否则记
 * 下来的是世界坐标，验证不了「机体屏幕位置恒为 240」。
 * save/restore 用栈保存平移量，与真实 canvas 语义一致。 */
function makeCtx() {
  const texts = [], rects = [], circles = [], polys = [];
  let tx = 0, ty = 0;
  const stack = [];
  let cur = null;
  /* fill() / stroke() 各自落一条记录。
   * ⚠ 旧版只在 stroke 时落记录，导致"只 fill 不 stroke"的图形（离屏指示器）
   * 根本录不进来 —— A15f 曾因此把 12 架侦察机误判成指示器。 */
  const flushCur = (mode) => {
    if (cur && cur.length) polys.push({ pts: cur.slice(), mode: mode, stroke: ctx.fillStyle });
    cur = null;
  };
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'fillText') return (s, x, y) => { texts.push({ s: String(s), x: x, y: y }); };
      if (k === 'createRadialGradient') return undefined;  // 强制走同心圆降级
      if (k === 'save') return () => { stack.push([tx, ty]); };
      if (k === 'restore') return () => { const p = stack.pop(); tx = p ? p[0] : 0; ty = p ? p[1] : 0; };
      if (k === 'translate') return (dx, dy) => { tx += dx || 0; ty += dy || 0; };
      if (k === 'fillRect') return (x, y, w, h) => {
        rects.push({ x: x + tx, y: y + ty, w: w, h: h, style: t.fillStyle });
      };
      if (k === 'arc') return (cx, cy, r) => { circles.push({ cx: cx + tx, cy: cy + ty, r: r }); };
      if (k === 'beginPath') return () => { cur = []; };
      if (k === 'moveTo' || k === 'lineTo') return (x, y) => { if (cur) cur.push([x + tx, y + ty]); };
      if (k === 'closePath') return () => {};
      if (k === 'fill') return () => { flushCur('fill'); };
      if (k === 'stroke') return () => { flushCur('stroke'); };
      if (k === 'setLineDash') return () => {};
      if (k === 'drawImage') return undefined;
      return k in t ? t[k] : function () {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  return { ctx: ctx, texts: texts, rects: rects, circles: circles, polys: polys };
}

const DOWN = { ok: false, x: 0, y: 0 };
const snap = (x, y) => ({ ok: true, x: x || 0, y: y || 0 });

/* 推进 n 帧（每帧 33ms），返回累计事件。
 * sx 为对象时（如 DOWN）原样透传 —— 不能直接过 snap()，否则 ok 被强制置
 * true、x 变成整个对象，IMU 异常分支根本进不去（A13c/d/f 曾栽在这里）。 */
function run(g, frames, sx, sy) {
  const ev = [];
  const raw = (sx && typeof sx === 'object') ? sx : null;
  for (let i = 0; i < frames; i++) {
    const s = raw || ((typeof sx === 'function') ? sx(i) : snap(sx, sy));
    const e = update(g, 33, s);
    for (let k = 0; k < e.length; k++) ev.push(e[k]);
  }
  return ev;
}

/* 跳过 P1 入场淡入（800ms ≈ 25 帧） */
function toP2(g) { run(g, 26, 0, 0); }

const CT = PLANE.COURT;
const CT_R = CT.x + CT.w;            // 416
const CT_B = CT.y + CT.h;            // 336
const CLIP_L = CT.x - PLANE.CAMERA.wallBand;   // 61
const CLIP_R = CT_R + PLANE.CAMERA.wallBand;   // 419
const FORM_ = PLANE.FORM;
const PY = PLANE.PLANE_Y;

console.log('\n=== A1 几何（PRD-06 §6.1 相机版重排） ===');
check('A1a 战场 64~416（w=352，明显窄于视口 448，两侧各 48px 空白带）',
  CT.x === 64 && CT_R === 416 && CT.w === 352, 'x=' + CT.x + ' R=' + CT_R + ' w=' + CT.w);
check('A1b 战场纵向 44~336（上接画面区顶，下沿在机体最低位 322 之下）',
  CT.y === VIEWPORT.y && CT_B === 336, 'y=' + CT.y + ' B=' + CT_B);
check('A1c 裁剪窗 ' + CLIP_L + '~' + CLIP_R + ' 严格窄于视口 16~464（墙外恒为空白）',
  CLIP_L > 16 && CLIP_R < 464, 'clip=' + CLIP_L + '~' + CLIP_R);
check('A1d TRAVEL = 352/2 − 24/2 = 164（由几何算出，非硬编码）',
  TRAVEL === 164, 'TRAVEL=' + TRAVEL);
check('A1e 编队包围盒 = 5×40 + 24 = 224（列距由 r6 的 56 收到 40）',
  FORM_W === 224, 'FORM_W=' + FORM_W);
check('A1f 横移行程 = 352 − 224 − 16 = 112（r6 的 56 列距只剩 32，故作废）',
  FORM_TRAVEL === 112, 'FORM_TRAVEL=' + FORM_TRAVEL);
check('A1g 列心 = 240 + (i−2.5)×40 → 140/180/220/260/300/340',
  JSON.stringify([0, 1, 2, 3, 4, 5].map((i) => 240 + (i - 2.5) * FORM_.pitchX))
  === JSON.stringify([140, 180, 220, 260, 300, 340]),
  [0, 1, 2, 3, 4, 5].map((i) => 240 + (i - 2.5) * FORM_.pitchX).join('/'));
check('A1h 编队顶排上缘 = 64 − 10 = 54 ≥ 战场顶 44（不越界）',
  FORM_.rowY[0] - PLANE.E_BODY_H / 2 >= CT.y, 'top=' + (FORM_.rowY[0] - PLANE.E_BODY_H / 2));
check('A1i 底排下缘起点 = 132 + 10 = 142（r6 写「+半高 8」与 24×20 外接不自洽）',
  FORM_.rowY[2] + PLANE.E_BODY_H / 2 === 142, 'bottom=' + (FORM_.rowY[2] + PLANE.E_BODY_H / 2));
check('A1j 18 架 = 6 列 × 3 排（第 1 排攻击机 6 + 第 2、3 排侦察机 12）', (() => {
  const g = create();
  let atk = 0, sct = 0;
  for (const e of g.enemies) { if (e.type === 'ATTACK') atk++; else sct++; }
  return g.enemies.length === 18 && atk === 6 && sct === 12;
})(), '');
check('A1k 敌机定长池：子弹 8 / 敌弹 12 / 扩散圆 8 / 碎屑 10', (() => {
  const g = create();
  return g.shots.length === PLANE.SHOT.max && g.ebullets.length === PLANE.EBULLET.max
    && g.rings.length === 8 && g.shards.length === 10;
})(), '');

console.log('\n=== A2 锚定型 yaw 相机（用户指定改造的核心） ===');
{
  const g = create();
  run(g, 3, 0, 0);
  check('A2a 头不动 → camCx = 240（战场中心），dx = 0',
    g.camCx === 240 && camDx(g) === 0, 'camCx=' + g.camCx + ' dx=' + camDx(g));
  update(g, 33, snap(100, 0));
  check('A2b 头左转（snap.x>0）→ camCx 减小 → dx>0 → 世界右滑',
    g.camCx < 240 && camDx(g) > 0, 'camCx=' + g.camCx.toFixed(1) + ' dx=' + camDx(g).toFixed(1));
  update(g, 33, snap(999, 0));
  check('A2c 左夹紧：camCx ≥ 战场左缘 + 半宽 = 76',
    near(g.camCx, 76, 0.5), 'camCx=' + g.camCx.toFixed(2));
  update(g, 33, snap(-999, 0));
  check('A2d 右夹紧：camCx ≤ 战场右缘 − 半宽 = 404',
    near(g.camCx, 404, 0.5), 'camCx=' + g.camCx.toFixed(2));
  check('A2e 相机行程幅度 = ±TRAVEL = ±164',
    near(240 - 76, TRAVEL) && near(404 - 240, TRAVEL), 'TRAVEL=' + TRAVEL);
}

console.log('\n=== A3 pitch 直控（上行程 80 / 下行程 40 · v1.38） ===');
{
  const g = create();
  run(g, 2, 0, 0);
  check('A3a 头不动 → 机体停在中低位 home = 282（反应窗最大处）',
    near(g.planeY, PY.home), 'planeY=' + g.planeY);
  update(g, 33, snap(0, 999));
  check('A3b 抬头到底 → 夹紧在 min = 202', near(g.planeY, PY.min, 0.5), 'planeY=' + g.planeY.toFixed(2));
  update(g, 33, snap(0, -999));
  check('A3c 低头到底 → 夹紧在 max = 322', near(g.planeY, PY.max, 0.5), 'planeY=' + g.planeY.toFixed(2));
  check('A3d 纵向行程 = 120px（上 80 / 下 40；PRD r6 的 [62,322] 是 260px —— 同为眩晕源，已先收窄）',
    PY.max - PY.min === 120, 'span=' + (PY.max - PY.min));
  check('A3d2 上行程 80 / 下行程 40（不对称，home 282 未抬高 —— 反应窗 0.875s 是联立解）',
    PY.up === 80 && PY.down === 40 && PY.home - PY.min === 80 && PY.max - PY.home === 40,
    'up=' + PY.up + ' down=' + PY.down);
  check('A3d3 抬头满偏 snap.y=130 → 机身上缘 190 ≈ 画面区中线 192（"飞到屏幕一半高"）', (() => {
    const h = create(); run(h, 2, 0, 0);
    update(h, 33, snap(0, 130));
    return near(h.planeY - PLANE.HALF, 192, 2.5);
  })(), 'top=' + (PLANE.PLANE_Y.home - 80 - PLANE.HALF));
  check('A3d4 低头满偏 snap.y=−130 → 正好到底 322（下向用满行程、不过冲）', (() => {
    const h = create(); run(h, 2, 0, 0);
    update(h, 33, snap(0, -130));
    return near(h.planeY, PY.max, 0.5);
  })(), '');
  check('A3d5 下向半偏 snap.y=−65 → 未饱和（仍在中途，后半个 pitch 行程有响应）', (() => {
    const h = create(); run(h, 2, 0, 0);
    update(h, 33, snap(0, -65));
    return h.planeY > PY.home + 5 && h.planeY < PY.max - 5;
  })(), '');
  check('A3e 纵向满偏不改变 camCx（两轴无耦合）', (() => {
    const h = create(); run(h, 2, 0, 0);
    const c0 = h.camCx; update(h, 33, snap(0, 999));
    return h.camCx === c0;
  })(), '');
  check('A3f 横向满偏不改变 planeY（两轴无耦合）', (() => {
    const h = create(); run(h, 2, 0, 0);
    const y0 = h.planeY; update(h, 33, snap(999, 0));
    return h.planeY === y0;
  })(), '');
  check('A3g 反应窗：home 282 距底排下缘 142 = 140px @160px/s = 0.875s ≈ 26 帧',
    near((PY.home - 142) / PLANE.EBULLET.speedMax, 0.875, 0.001),
    ((PY.home - 142) / PLANE.EBULLET.speedMax).toFixed(3) + 's');
}

console.log('\n=== A4 编队步进（F-PLN-41 · 列距与初速联立求解） ===');
{
  const g = create();
  check('A4a 初速 = 8px/s', formSpeed(g) === 8, 'v=' + formSpeed(g));
  g.kills = 18;
  check('A4b 18 杀后 = 8 × 1.03^18 = 13.6px/s（封顶 24 不触及）',
    near(formSpeed(g), 8 * Math.pow(1.03, 18), 0.01), 'v=' + formSpeed(g).toFixed(3));
  g.kills = 60;
  check('A4c 封顶 24px/s', formSpeed(g) === 24, 'v=' + formSpeed(g));
  const h = create();
  toP2(h);
  check('A4d 单程 112px @8px/s = 14s（r6 的 32px 行程只有 4s，故列距须改）',
    near(FORM_TRAVEL / FORM_.speed0, 14, 0.001),
    (FORM_TRAVEL / FORM_.speed0).toFixed(2) + 's');
  const cx0 = h.form.cx;
  run(h, 30, 0, 0);            // 30 帧 ≈ 1s
  check('A4e 步进方向初始向右（form.cx 增大）',
    h.form.cx > cx0, 'cx ' + cx0 + ' → ' + h.form.cx.toFixed(2));
  /* 触边下移：把 cx 推到右界外，下一帧必须夹紧 + 下移 16 */
  h.form.cx = 295.9; h.form.dir = 1;
  const drop0 = h.form.drop;
  update(h, 100, snap(0, 0));
  check('A4f 触右界 → 夹紧 296 并反向，整体下移 16px',
    near(h.form.cx, 296, 0.2) && h.form.dir === -1 && h.form.drop === drop0 + FORM_.stepDown,
    'cx=' + h.form.cx.toFixed(2) + ' dir=' + h.form.dir + ' drop=' + h.form.drop);
  h.form.cx = 184.1; h.form.dir = -1;
  const d1 = h.form.drop;
  update(h, 100, snap(0, 0));
  check('A4g 触左界 → 夹紧 184 并反向，整体下移 16px',
    near(h.form.cx, 184, 0.2) && h.form.dir === 1 && h.form.drop === d1 + FORM_.stepDown,
    'cx=' + h.form.cx.toFixed(2) + ' dir=' + h.form.dir + ' drop=' + h.form.drop);
  check('A4h 横移轨道固定 [184, 296]，不随存活列收缩（否则越打越快被抵消）',
    near(184, CT.x + FORM_.margin + FORM_W / 2, 0.001)
    && near(296, CT_R - FORM_.margin - FORM_W / 2, 0.001), 'track=184~296');
}

console.log('\n=== A5 失守判定（F-PLN-52 · 防线 y=276） ===');
{
  const g = create();
  toP2(g);
  check('A5a 底排下缘起点 142（未触及 276）',
    near(formationBottom(g), 142, 0.001), 'bottom=' + formationBottom(g));
  let k = 0;
  while (formationBottom(g) < PLANE.DEFENSE_Y && k < 20) { g.form.drop += FORM_.stepDown; k++; }
  check('A5b 触边 9 次后底排下缘越线（142 + 16×9 = 286 ≥ 276）',
    k === 9, 'k=' + k + ' bottom=' + formationBottom(g));
  check('A5c 第 8 次仍安全（142 + 128 = 270 < 276）',
    142 + 8 * FORM_.stepDown < PLANE.DEFENSE_Y, '' + (142 + 8 * FORM_.stepDown));
  const h = create();
  toP2(h);
  h.form.drop = 144;                       // 人为越线
  const ev = run(h, 1, 0, 0);
  check('A5d 越线立即 over + finished（cleared=false）',
    h.over && !h.cleared && ev.indexOf('finished') >= 0, JSON.stringify(ev));
  check('A5e 满编不杀失守时长 = (56 + 8×112)/8 = 119s',
    near((56 + 8 * FORM_TRAVEL) / FORM_.speed0, 119, 0.001),
    ((56 + 8 * FORM_TRAVEL) / FORM_.speed0).toFixed(1) + 's');
  /* 俯冲中的敌机不参与失守判定 */
  const p = create();
  toP2(p);
  p.form.drop = 144;
  for (const e of p.enemies) { e.diving = true; e.y = 100; }
  check('A5f 全部俯冲中 → 不触发失守（F-PLN-52 明确不含俯冲中）',
    formationBottom(p) === -Infinity && !update(p, 33, snap(0, 0)).length, '');
}

console.log('\n=== A6 自动射击（F-PLN-24/31） ===');
{
  const g = create();
  toP2(g);
  check('A6a G0 火力：每 0.4s 一发', PLANE.SHOT.intervalMs === 400, '' + PLANE.SHOT.intervalMs);
  run(g, 13, 0, 0);                        // 13×33 = 429ms → 恰好 1 发
  const fired = g.shots.filter((s) => s.on).length;
  check('A6b 429ms 内发出 1 发', fired === 1, 'fired=' + fired);
  run(g, 12, 0, 0);
  check('A6c 再过 396ms 累计 2 发', g.shots.filter((s) => s.on).length >= 2,
    'fired=' + g.shots.filter((s) => s.on).length);
  check('A6d 己方子弹自机头发出（世界 x = camCx，屏幕恒为 240）', (() => {
    const h = create(); toP2(h); run(h, 14, 0, 0);
    const s = h.shots.find((x) => x.on);
    return s && near(s.x, h.camCx, 0.001) && near(s.x + camDx(h), 240, 0.001);
  })(), '');
  /* 分值：侦察机 10 / 攻击机 30 */
  const k = create(); toP2(k);
  const scout = k.enemies.find((e) => e.type === 'SCOUT' && e.row === 2);
  const atk = k.enemies.find((e) => e.type === 'ATTACK');
  check('A6e 侦察机 1 血 / 攻击机 2 血（F-PLN 机型表）',
    scout.hp === 1 && atk.hp === 2, 'scout=' + scout.hp + ' atk=' + atk.hp);
  /* 把一枚子弹放到侦察机**正下方**（子弹以 300px/s 上行 9.9px/帧，
   * 放在上方就永远打不到 —— A6f 曾把起点写成 rowY[2]−60 而落空）。 */
  k.shots[0] = {
    on: true,
    x: k.form.cx + (scout.col - 2.5) * FORM_.pitchX,
    y: FORM_.rowY[scout.row] + k.form.drop + 14,
  };
  const ev1 = run(k, 3, 0, 0);
  check('A6f 击落侦察机 → +10 分 / kills+1 / 事件 kill',
    k.score >= 10 && k.kills >= 1 && ev1.indexOf('kill') >= 0,
    'score=' + k.score + ' kills=' + k.kills);
  check('A6g 己方子弹不与敌弹对消（F-PLN-32：各走各的）', (() => {
    const h = create(); toP2(h);
    h.shots[0] = { on: true, x: 200, y: 200 };
    h.ebullets[0] = { on: true, x: 200, y: 200 };
    run(h, 1, 0, 0);
    return h.shots[0].on && h.ebullets[0].on;
  })(), '');
}

console.log('\n=== A7 敌弹（F-PLN-42） ===');
{
  const g = create();
  check('A7a 基础间隔 2.2s', eGapMs(g) === 2200, '' + eGapMs(g));
  g.kills = 3;
  check('A7b 每 3 杀 −0.15s', eGapMs(g) === 2050, '' + eGapMs(g));
  g.kills = 90;
  check('A7c 下限 0.8s', eGapMs(g) === 800, '' + eGapMs(g));
  g.kills = 0;
  check('A7d 初速 120px/s', eSpeed(g) === 120, '' + eSpeed(g));
  g.kills = 5;
  check('A7e 每 5 杀 +10px/s', eSpeed(g) === 130, '' + eSpeed(g));
  g.kills = 100;
  check('A7f 封顶 160px/s（保证可躲）', eSpeed(g) === 160, '' + eSpeed(g));
  /* 命中机体 → 损 1 命 + 2s 无敌 */
  const h = create(); toP2(h);
  h.ebullets[0] = { on: true, x: h.camCx, y: h.planeY };
  const ev = run(h, 1, 0, 0);
  check('A7g 敌弹命中机体 → 损 1 命 + 无敌 2s + 事件 hurt',
    h.lives === 2 && h.invT > 1900 && ev.indexOf('hurt') >= 0,
    'lives=' + h.lives + ' invT=' + h.invT);
  check('A7h 无敌期内再命中不损命（F-PLN-51）', (() => {
    const p = create(); toP2(p);
    p.invT = 2000;
    p.ebullets[0] = { on: true, x: p.camCx, y: p.planeY };
    run(p, 1, 0, 0);
    return p.lives === 3;
  })(), '');
  check('A7i 横向让位裕度：让开只需 14px @360px/s ≈ 0.04s（可躲性成立）',
    PLANE.EBULLET.r + PLANE.HIT / 2 === 14, 'need=' + (PLANE.EBULLET.r + PLANE.HIT / 2) + 'px');
}

console.log('\n=== A8 投弹（F-PLN-25/26/33） ===');
{
  const g = create();
  toP2(g);
  check('A8a 本关补给 2 枚', g.bombs === 2, 'bombs=' + g.bombs);
  check('A8b 投弹成功 → 余量 1、同屏 1 枚在飞',
    bomb(g) === true && g.bombs === 1 && g.bomb.on === true, 'bombs=' + g.bombs);
  check('A8c 同屏已有 1 枚时再投无效（D-PLN-02）',
    bomb(g) === false && g.bombs === 1, 'bombs=' + g.bombs);
  const y0 = g.bomb.y;
  run(g, 1, 0, 0);
  check('A8d 弹体以 200px/s 上行',
    near(y0 - g.bomb.y, PLANE.BOMB.speed * 33 / 1000, 0.001), 'Δy=' + (y0 - g.bomb.y).toFixed(2));
  check('A8e 引爆线 y = 144（画面区上沿 44 + 100；取屏幕 y 会落进 HUD 条）',
    PLANE.BOMB.detonateY === 144, '' + PLANE.BOMB.detonateY);
  check('A8f 扩散波上缘 144 − 90 = 54 仍 ≥ 画面区顶 44（不溢出）',
    PLANE.BOMB.detonateY - PLANE.BOMB.waveR1 >= VIEWPORT.y,
    '' + (PLANE.BOMB.detonateY - PLANE.BOMB.waveR1));
  const ev = run(g, 30, 0, 0);
  check('A8g 到引爆线自动引爆 → 事件 blast + 余波结束',
    ev.indexOf('blast') >= 0 && g.bomb.on === false, JSON.stringify(ev.slice(0, 4)));
  check('A8h 波半径：k=0 → 12，k=0.5 → 90，k=1 → 0',
    waveRadius(0) === 12 && waveRadius(0.5) === 90 && waveRadius(1) === 0,
    [0, 0.5, 1].map(waveRadius).join('/'));
  /* 扫过即毁：把编队对准弹道，投弹后存活数必须下降 */
  const p = create(); toP2(p);
  const before = aliveCount(p);
  bomb(p);
  run(p, 30, 0, 0);
  check('A8i 扩散波扫过即毁：编队存活数下降（12→90 覆盖多行多列）',
    aliveCount(p) < before, before + ' → ' + aliveCount(p));
  check('A8j 余量耗尽后 bomb() 返回 false（静默忽略）', (() => {
    const q = create(); toP2(q);
    bomb(q); run(q, 40, 0, 0);
    const ok1 = bomb(q); run(q, 40, 0, 0);
    return ok1 === true && q.bombs === 0 && bomb(q) === false;
  })(), '');
  /* 把弹体直接摆到引爆线下一帧的位置：若让它自然飞完 20 帧才起爆，
   * 起爆瞬间 4 发敌弹已下落近 80px，波还没张开就打空了。 */
  check('A8k 扩散波同时清掉路径上的敌弹（余量 20px 内 4 发全清）', (() => {
    const q = create(); toP2(q);
    bomb(q);
    q.bomb.x = 240;
    q.bomb.y = PLANE.BOMB.detonateY + PLANE.BOMB.speed * 33 / 1000 - 1;
    for (let i = 0; i < 4; i++) q.ebullets[i] = { on: true, x: 226 + i * 9, y: 150 };
    run(q, 6, 0, 0);
    return q.ebullets.filter((b) => b.on).length === 0;
  })(), '');
}

console.log('\n=== A9 轰炸机（F-PLN-22 · 速度由 50 调为 32px/s） ===');
{
  const g = create();
  toP2(g);
  check('A9a P2 期间轰炸机未入场', g.bomber.on === false, '');
  /* 打到只剩 6 架 → P3 */
  for (let i = 0; i < 12; i++) g.enemies[i].on = false;
  const ev = run(g, 1, 0, 0);
  check('A9b 编队剩 6 架 → 进入 P3，轰炸机入场 + 事件 wave',
    g.phase === 'p3' && g.bomber.on === true && ev.indexOf('wave') >= 0,
    'phase=' + g.phase);
  /* 入场与下压发生在同一帧（update 内先转 P3 再 stepBomber），
   * 故外部只能观察到"刚过顶线"的 y，不能苛求严格等于 44。 */
  check('A9c 轰炸机 5 血 / 80 分 / 自战场顶 y=44 入场（当帧即开始下压）',
    g.bomber.hp === 5 && PLANE.TYPE.BOMBER.score === 80
    && g.bomber.y >= VIEWPORT.y && g.bomber.y <= VIEWPORT.y + 2,
    'hp=' + g.bomber.hp + ' y=' + g.bomber.y);
  const y0 = g.bomber.y;
  run(g, 30, 0, 0);
  check('A9d 以 32px/s 直线下压（50px/s 只剩 4.5s，容错过窄）',
    near(g.bomber.y - y0, PLANE.BOMBER.speed * 30 * 33 / 1000, 0.5),
    'Δy=' + (g.bomber.y - y0).toFixed(1));
  check('A9e 压到防线耗时 = (276−9−44)/32 ≈ 6.97s（够「发现→对齐→5 发」）',
    near((PLANE.DEFENSE_Y - PLANE.BOMBER.bodyH / 2 - VIEWPORT.y) / PLANE.BOMBER.speed, 6.97, 0.01),
    ((PLANE.DEFENSE_Y - PLANE.BOMBER.bodyH / 2 - VIEWPORT.y) / PLANE.BOMBER.speed).toFixed(2) + 's');
  check('A9f 被撞损 2 命（D-PLN-03）', (() => {
    const p = create(); toP2(p);
    p.bomber.on = true; p.bomber.x = p.camCx; p.bomber.y = p.planeY; p.bomber.hp = 5;
    run(p, 1, 0, 0);
    return p.lives === 1;
  })(), '');
  check('A9g 击落轰炸机 → +80 分 + 事件 bomberkill', (() => {
    const p = create(); toP2(p);
    p.bomber.on = true; p.bomber.x = p.camCx; p.bomber.y = 200; p.bomber.hp = 1;
    p.shots[0] = { on: true, x: p.camCx, y: 205 };
    const e = run(p, 1, 0, 0);
    return p.bomber.on === false && p.score === 80 && e.indexOf('bomberkill') >= 0;
  })(), '');
  check('A9h 轰炸机抵达防线 → 立即失守', (() => {
    const p = create(); toP2(p);
    p.phase = 'p3';
    p.bomber.on = true; p.bomber.x = 240; p.bomber.y = PLANE.DEFENSE_Y - 5;
    const e = run(p, 5, 0, 0);
    return p.over && !p.cleared && e.indexOf('finished') >= 0;
  })(), '');
}

console.log('\n=== A10 俯冲（F-PLN-43 · MVP 直线下压） ===');
{
  const g = create();
  toP2(g);
  for (let i = 0; i < 12; i++) g.enemies[i].on = false;
  run(g, 1, 0, 0);
  g.diveT = 99999;
  run(g, 1, 0, 0);
  const diving = g.enemies.filter((e) => e.on && e.diving).length;
  check('A10a P3 到期 → 派出一架俯冲', diving === 1, 'diving=' + diving);
  g.diveT = 99999;
  run(g, 1, 0, 0);
  const diving2 = g.enemies.filter((e) => e.on && e.diving).length;
  check('A10b 同屏最多 2 架俯冲（防弹幕失控）', diving2 <= 2, 'diving=' + diving2);
  check('A10c 俯冲为直线下压（x 不变，y 增大）', (() => {
    const p = create(); toP2(p);
    for (let i = 0; i < 12; i++) p.enemies[i].on = false;
    run(p, 1, 0, 0);
    p.diveT = 99999; run(p, 1, 0, 0);
    const e = p.enemies.find((x) => x.on && x.diving);
    const x0 = e.x, y0 = e.y;
    run(p, 3, 0, 0);
    return e.x === x0 && e.y > y0;
  })(), '');
  check('A10d 出屏底后从屏顶回归空位（returning → 落回排位）', (() => {
    const p = create(); toP2(p);
    for (let i = 0; i < 12; i++) p.enemies[i].on = false;
    run(p, 1, 0, 0);
    p.diveT = 99999; run(p, 1, 0, 0);
    const e = p.enemies.find((x) => x.on && x.diving);
    e.y = VIEWPORT.y + VIEWPORT.h + PLANE.E_BODY_H;      // 推出屏底
    run(p, 1, 0, 0);
    const back = e.returning === true && e.y <= PLANE.DIVE.returnY;
    run(p, 60, 0, 0);
    return back && e.diving === false;
  })(), '');
  check('A10e 俯冲机仍可被击落（血量不变）', (() => {
    const p = create(); toP2(p);
    for (let i = 0; i < 12; i++) p.enemies[i].on = false;
    run(p, 1, 0, 0);
    p.diveT = 99999; run(p, 1, 0, 0);
    const e = p.enemies.find((x) => x.on && x.diving);
    p.shots[0] = { on: true, x: e.x, y: e.y + 40 };
    const before = aliveCount(p);
    run(p, 60, 0, 0);
    return aliveCount(p) < before;
  })(), '');
}

console.log('\n=== A11 生命与无敌（F-PLN-50/51） ===');
{
  const g = create();
  check('A11a 3 命起手', g.lives === 3, 'lives=' + g.lives);
  toP2(g);
  check('A11b 无敌时长 2s', PLANE.LIFE.invincibleMs === 2000, '');
  g.invT = -1;
  g.ebullets[0] = { on: true, x: g.camCx, y: g.planeY };
  run(g, 1, 0, 0);
  g.invT = -1;
  g.ebullets[1] = { on: true, x: g.camCx, y: g.planeY };
  run(g, 1, 0, 0);
  g.invT = -1;
  g.ebullets[2] = { on: true, x: g.camCx, y: g.planeY };
  const ev = run(g, 1, 0, 0);
  check('A11c 命尽 → over + finished（不重开，经典 Game Over 口径）',
    g.over && g.lives === 0 && ev.indexOf('finished') >= 0,
    'lives=' + g.lives + ' over=' + g.over);
  check('A11d 撞机同样损命', (() => {
    const p = create(); toP2(p);
    const e = p.enemies.find((x) => x.row === 2);
    e.y = p.planeY; e.diving = true; e.x = p.camCx;
    run(p, 1, 0, 0);
    return p.lives === 2;
  })(), '');
  check('A11e grantGrace 只延长不缩短既有无敌（F-PLN-65）', (() => {
    const p = create(); toP2(p);
    p.invT = 1500; grantGrace(p, 1000);
    const a = p.invT;
    p.invT = 200; grantGrace(p, 1000);
    return a === 1500 && p.invT === 1000;
  })(), '');
}

console.log('\n=== A12 通关（F-PLN-46） ===');
{
  const g = create();
  toP2(g);
  /* 先落到 P3 再清空：否则"全灭"会先命中 P2→P3 闸门（存活 ≤6）把轰炸机
   * 放出来，通关判定 aliveCount===0 && !bomber.on 永远不成立。 */
  g.phase = 'p3';
  for (const e of g.enemies) e.on = false;
  g.bomber.on = false;
  const ev = run(g, 1, 0, 0);
  check('A12a 编队 + 轰炸机全灭 → cleared=true + 事件 clear/finished',
    g.over && g.cleared && ev.indexOf('clear') >= 0 && ev.indexOf('finished') >= 0,
    JSON.stringify(ev));
  check('A12b 满分 = 12×10 + 6×30 + 1×80 = 380（F-PLN-53 封顶）', (() => {
    const p = create(); toP2(p);
    let s = 0;
    for (const e of p.enemies) s += PLANE.TYPE[e.type].score;
    return s + PLANE.TYPE.BOMBER.score === 380;
  })(), '');
  check('A12c over 后继续 update 直接返回空事件（幂等）',
    update(g, 33, snap(0, 0)).length === 0, '');
  check('A12d over 后 bomb() 无效', bomb(g) === false, '');
}

console.log('\n=== A13 IMU 异常（§10 · NFR-05） ===');
{
  const g = create();
  toP2(g);
  const t0 = g.t, cx0 = g.camCx, y0 = g.planeY;
  update(g, 33, DOWN);
  check('A13a IMU 异常 → imuDown 置位', g.imuDown === true, '');
  check('A13b 机体锁中立位（camCx 240 / planeY home）',
    g.camCx === 240 && g.planeY === PY.home, 'camCx=' + g.camCx + ' y=' + g.planeY);
  const shot0 = g.shots.filter((s) => s.on).length;
  const drop0 = g.form.drop, cx1 = g.form.cx;
  run(g, 60, DOWN);
  check('A13c 编队停摆（不下压、不横移）',
    g.form.drop === drop0 && g.form.cx === cx1, '');
  check('A13d 不产生新子弹', g.shots.filter((s) => s.on).length === shot0, '');
  check('A13e 游戏内时钟 g.t 仍推进（冻结靠页面不调 update，非模块内停钟）',
    g.t > t0, 'Δt=' + (g.t - t0));
  const m = makeCtx();
  render(g, m.ctx, 0);
  check('A13f 画面给出 IMU 异常提示（含「滑动唤出菜单」——本作单击已给投弹）',
    m.texts.some((t) => t.s.indexOf('IMU') >= 0 && t.s.indexOf('滑动') >= 0),
    m.texts.map((t) => t.s).join('|'));
}

console.log('\n=== A14 三条红线静态检查 ===');
{
  const src = fs.readFileSync(new URL('../../utils/plane.js', import.meta.url), 'utf8');
  /* 先剥注释再扫：红线说明本身就写在头注释里，裸扫必然命中自己写的说明文字 */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('A14a 无 Date.now（游戏内时钟唯一时间源）', code.indexOf('Date.now') < 0);
  check('A14b 无 setTimeout / setInterval', !/setTimeout|setInterval/.test(code));
  check('A14c 不 import sfx / storage（事件与落盘全归页面）',
    !/from\s+'\.\/sfx\.js'|from\s+'\.\/storage\.js'|import\s+\*\s+as\s+sfx/.test(src));
  check('A14d 不绘制黑色遮罩（无全屏深色 fillRect）',
    !/fillRect\(\s*ctx\s*,\s*0\s*,\s*0\s*,\s*480\s*,\s*352/.test(src));
  check('A14e 变暗统一走 ring.js 的 fadeTo', /fadeTo/.test(src));
  check('A14f 不 import wx（零宿主依赖，可本地仿真）',
    !/from\s+'wx'|from\s+"wx"/.test(src));
  check('A14g 玩法推进只在 update 内（render 为纯函数：不写 g.*）',
    !/function render[\s\S]*?\bg\.\w+\s*=[^=]/.test(code), '');
}

console.log('\n=== A15 渲染：机体恒钉 / 墙随相机滑 / 墙外留白 / 离屏指示器 ===');
{
  const g = create();
  toP2(g);
  const m = makeCtx();
  render(g, m.ctx, 0);
  /* 机体轮廓 = 11 顶点，首点相对中心 (0,−12) */
  const plane = m.polys.find((p) => p.pts.length === 11);
  check('A15a 机体绘于屏幕 x=240（锚定型核心承诺，任何相机位都不变）',
    !!plane && near(plane.pts[0][0], 240, 0.001),
    plane ? 'x=' + plane.pts[0][0] : 'n/a');
  check('A15b 机体纵向在 home 282（首点 y = 282 − 12 = 270）',
    !!plane && near(plane.pts[0][1], PY.home - 12, 0.001),
    plane ? 'y=' + plane.pts[0][1] : 'n/a');

  /* 头左转：世界右滑，机体仍钉 240 */
  update(g, 33, snap(120, 0));
  const m2 = makeCtx();
  render(g, m2.ctx, 0);
  const plane2 = m2.polys.find((p) => p.pts.length === 11);
  check('A15c 头左转后机体**仍在** 240（不是跟着世界滑）',
    !!plane2 && near(plane2.pts[0][0], 240, 0.001),
    plane2 ? 'x=' + plane2.pts[0][0] : 'n/a');
  const line2 = m2.polys.find((p) => p.pts.length === 2);
  check('A15d 防线（世界层横线）随相机右滑（x = 64 + dx > 64）',
    !!line2 && line2.pts[0][0] > 64, line2 ? 'x=' + line2.pts[0][0].toFixed(1) : 'n/a');

  /* 墙外留白：裁剪窗 61~419 严格窄于视口 16~464 */
  check('A15e 裁剪窗外的区域恒为空白（墙 + 战场全在窗内绘制，越窗即被裁）',
    CLIP_L > VIEWPORT.x && CLIP_R < VIEWPORT.x + VIEWPORT.w,
    'clip=' + CLIP_L + '~' + CLIP_R + ' vp=' + VIEWPORT.x + '~' + (VIEWPORT.x + VIEWPORT.w));

  /* 离屏轰炸机指示器 */
  /* ⚠ 侦察机剪影同样是 3 顶点三角形，必须先清空编队，否则指示器会被
   * 12 架侦察机的三角形淹没（A15f 曾报 tris=12）。 */
  const p = create(); toP2(p);
  p.phase = 'p3';
  for (const e of p.enemies) e.on = false;
  p.bomber.on = true; p.bomber.x = 100; p.bomber.y = 200;
  p.camCx = 404;                                   // dx = 240−404 = −164
  const m3 = makeCtx();
  render(p, m3.ctx, 0);
  /* 轰炸机屏幕 x = 100 − 164 = −64 < CLIP_L(61) → 左侧指示器（只 fill） */
  const tri = m3.polys.filter((q) => q.mode === 'fill' && q.pts.length === 3);
  check('A15f 轰炸机滑出裁剪窗 → 画离屏指示器（贴左墙内侧 x=69）',
    tri.length === 1 && near(tri[0].pts[0][0], CLIP_L + PLANE.CAMERA.markGap, 0.001),
    'tris=' + tri.length + (tri[0] ? ' x=' + tri[0].pts[0][0] : ''));
  p.bomber.x = 240;                                 // 屏幕 76，在窗内
  const m4 = makeCtx();
  render(p, m4.ctx, 0);
  check('A15g 轰炸机在裁剪窗内 → 不画指示器',
    m4.polys.filter((q) => q.mode === 'fill' && q.pts.length === 3).length === 0, '');

  check('A15h HUD 中段三段落于空档 x ∈ [92,352]（不占左右胶囊）', (() => {
    const H = PLANE.HUDX;
    return H.scoreLabelX >= 92 && H.bombNumX + 10 <= 352;
  })(), '');
}

console.log('\n=== A16 result 契约 + statusText 口径 ===');
{
  const g = create();
  g.score = 380; g.kills = 19; g.bombsUsed = 2; g.cleared = true;
  const r = result(g);
  check('A16a score / cleared / reachedLevel 齐备',
    r.score === 380 && r.cleared === true && r.reachedLevel === 1,
    'score=' + r.score + ' lv=' + r.reachedLevel);
  check('A16b extra 两项：击落 / 投弹',
    r.extra.length === 2 && r.extra[0].label === '击落' && r.extra[1].label === '投弹',
    JSON.stringify(r.extra));
  check('A16c extra label ≤ 4 字且 value 为字符串',
    r.extra.every((x) => x.label.length <= 4 && typeof x.value === 'string'), '');

  const p = create();
  check('A16d 开局 statusText = 「剩余 18」（编队 18，轰炸机未入场）',
    statusText(p) === '剩余 18', statusText(p));
  p.bomber.on = true;
  check('A16e 轰炸机入场 → 「剩余 19」（0~19 上限）',
    statusText(p) === '剩余 19', statusText(p));
  for (const e of p.enemies) e.on = false;
  p.bomber.on = false;
  check('A16f 全灭 → 「剩余 0」', statusText(p) === '剩余 0', statusText(p));
  check('A16g 文案 ≤6 字（状态胶囊可用宽 ≈7 字）', (() => {
    const q = create();
    return statusText(q).length <= 6;
  })(), '');
}

console.log('\n=== A17 方向语义锁：横向必须乘 SEM_FOLLOW ===');
{
  const src = fs.readFileSync(new URL('../../utils/plane.js', import.meta.url), 'utf8');
  check('A17a 源码锁：横向相机使用 SEM_FOLLOW', /SEM_FOLLOW/.test(src));
  check('A17b SEM_FOLLOW = −1（与打砖块 / 接鸡蛋同源，非本册自定）',
    SEM_FOLLOW === -1, 'SEM_FOLLOW=' + SEM_FOLLOW);
  /* 端到端：头左转后，世界层（底线）必须向【右】滑 */
  const g = create();
  toP2(g);
  const m0 = makeCtx(); render(g, m0.ctx, 0);
  const floor0 = m0.rects.find((r) => r.y === CT_B && r.w === 352);
  update(g, 33, snap(100, 0));
  const m1 = makeCtx(); render(g, m1.ctx, 0);
  const floor1 = m1.rects.find((r) => r.y === CT_B && r.w === 352);
  check('A17c 头左转 → 底线屏幕 x 右移（世界反向滑动成立）',
    !!floor0 && !!floor1 && floor1.x > floor0.x,
    floor0 && floor1 ? (floor0.x + ' → ' + floor1.x.toFixed(1)) : 'n/a');
  check('A17d 反向滑动量 = |dx|（dx = 240 − camCx）',
    !!floor1 && near(floor1.x - CT.x, camDx(g), 0.001),
    floor1 ? 'Δ=' + (floor1.x - CT.x).toFixed(2) + ' vs dx=' + camDx(g).toFixed(2) : 'n/a');
}

console.log('\n=== A18 冻结语义：不调 update 则玩法停摆 ===');
{
  const g = create();
  toP2(g);
  const t0 = g.t;
  const snapshot = JSON.stringify(g.form) + '|' + JSON.stringify(g.enemies);
  /* 模拟 B2/B3/B4：页面只调 render，不调 update */
  for (let i = 0; i < 30; i++) render(g, makeCtx().ctx, 0.55);
  check('A18a 冻结 30 帧后 g.t 不变（B2/B3/B4 自动停钟）',
    g.t === t0, 'Δt=' + (g.t - t0));
  check('A18b 冻结期间编队与敌机状态完全不变',
    JSON.stringify(g.form) + '|' + JSON.stringify(g.enemies) === snapshot, '');
  const before = g.t;
  update(g, 33, snap(0, 0));
  check('A18c 解冻后从冻结时刻续算（不重置段落进度）',
    g.t > before && g.phase === 'p2', 'Δt=' + (g.t - before));
}

/* ─────────────── 页面级断言（P 组） ─────────────── */

console.log('\n=== P1 页面接入（B1 推进 / 冻结契约） ===');
{
  const { default: page } = await import('./pages/plane/plane.mjs');
  const { makeItem } = await import('./utils/ring.js');
  const { GAME_MENU_IDLE } = await import('./utils/layout.js');
  const c = makeCtx();

  let redirected = 0;
  const nav = [];
  const wxMod = await import('./wx-mock.mjs');
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
    page.meta = { id: 'plane', name: '打飞机', kind: 'game', iconId: 'plane' };
    page.gameId = 'plane';
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

  /* 跳过 P1 入场 800ms。intro 期间禁止投弹是**正确的产品行为**，
   * 所以验投弹前必须先走出 intro，而不是放宽断言。 */
  function pastIntro() { for (let i = 0; i < 26; i++) update(page.pl, 33, snap(0, 0)); }

  setup();
  check('P1a initPlay 建出玩法状态（0 分 / 3 命 / 2 投弹 / intro 过场）',
    !!page.pl && page.pl.score === 0 && page.pl.lives === 3
    && page.pl.bombs === 2 && page.pl.phase === 'intro',
    page.pl ? ('score=' + page.pl.score + ' lives=' + page.pl.lives
      + ' bombs=' + page.pl.bombs + ' phase=' + page.pl.phase) : 'no pl');

  const t0 = page.pl.t;
  page._last = Date.now() - 40;    // 模拟"上一帧在 40ms 前"（首帧 dt 本就≈0）
  page.tick();
  check('P1b B1 推进玩法（g.t 随帧累加）', page.pl.t > t0, 't ' + t0 + ' → ' + page.pl.t);

  page.state = 'MENU';
  page.menuAt = 1000000;
  const t1 = page.pl.t;
  page.tick();
  check('P1c B2 菜单态不推进玩法（画面冻结，F-PLN-60）',
    page.pl.t === t1, 't ' + t1 + ' → ' + page.pl.t);

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

  console.log('\n=== P2 提示条已撤 + 品牌胶囊仍在（差异③） ===');
  page.state = 'PLAY';
  c.texts.length = 0;
  page.render(1000000, { ok: true, x: 0, y: 0 });
  const HINTS = ['单击触控唤出菜单', '单击触控确认选择', '转头选择，单击返回游戏',
    '单击触控立即继续', '正在打开…'];
  const leaked = HINTS.filter((h) => c.texts.some((t) => t.s === h));
  check('P2a 画面不含提示条五态文案中的任何一条', leaked.length === 0, leaked.join('|'));
  check('P2b 左上品牌胶囊仍由框架写入游戏名（未丢失）',
    c.texts.some((t) => t.s === '打飞机'), '');

  console.log('\n=== P3 statusText 钩子（差异④ · F-PLN-17） ===');
  setup();
  check('P3a 开局 → 「剩余 18」', page.statusText() === '剩余 18', page.statusText());
  page.pl.bomber.on = true;
  check('P3b 压轴入场 → 「剩余 19」', page.statusText() === '剩余 19', page.statusText());
  page.pl.imuDown = true;
  check('P3c IMU 异常 → 返回空串（交还框架显示「IMU状态异常」+ 空心圆点）',
    page.statusText() === '', '"' + page.statusText() + '"');
  page.pl.imuDown = false;
  const h = page._hudStatus();
  check('P3d _hudStatus 走 statusText 分支（优先级最高）',
    h.text.indexOf('剩余') === 0 && h.dot === true, h.text + ' dot=' + h.dot);
  /* 守卫：statusText 缺失时不得崩 */
  const savedST = page.statusText;
  delete page.statusText;
  let guardOk = true;
  try { page._hudStatus(); } catch (e) { guardOk = false; }
  page.statusText = savedST;
  check('P3e typeof 守卫：statusText 未挂载时 _hudStatus 不抛错（否则整帧卡死）',
    guardOk, '');

  console.log('\n=== P4 tapRole = fire：单击 = 投弹，滑动 = 唤菜单（F-PLN-75/27） ===');
  setup();
  pastIntro();
  page._swipeAt = 0;
  page.onTap();
  check('P4a PLAY 态单击 → 投弹（余量 2 → 1）',
    page.pl.bombs === 1 && page.pl.bomb.on === true, 'bombs=' + page.pl.bombs);
  check('P4b PLAY 态单击**不**进菜单（菜单入口已改道滑动）',
    page.state === 'PLAY', 'state=' + page.state);
  page.onTap();
  check('P4c 同屏已有 1 枚 → 再单击不消耗余量（D-PLN-02）',
    page.pl.bombs === 1, 'bombs=' + page.pl.bombs);

  setup();
  pastIntro();
  page._swipeAt = 0;
  page.onSwipe();
  check('P4d PLAY 态滑动 → 唤出 B2 菜单（本作菜单的唯一入口）',
    page.state === 'MENU', 'state=' + page.state);
  check('P4e 进菜单时重校准 + 冻结漂移（F-PLN-04）', (() => {
    let rb = 0, fd = null;
    page.engine.resetBase = function () { rb++; };
    page.engine.freezeDrift = function (v) { fd = v; };
    page.state = 'PLAY';
    page.onSwipe();
    return rb === 1 && fd === true;
  })(), '');

  console.log('\n=== P5 滑动后 300ms 内单击忽略（F-PLN-76） ===');
  setup();
  pastIntro();
  page._swipeAt = Date.now();
  page.onTap();
  check('P5a 滑动刚发生 → 紧随的单击被吞（防手指残留误点亮菜单）',
    page.pl.bombs === 2 && page.state === 'PLAY',
    'bombs=' + page.pl.bombs + ' state=' + page.state);
  page._swipeAt = Date.now() - 400;
  page.onTap();
  check('P5b 超过 300ms → 单击恢复语义（投弹生效）',
    page.pl.bombs === 1, 'bombs=' + page.pl.bombs);

  console.log('\n=== P6 结算幂等 + 玩法事件只播音不结算 ===');
  setup();
  redirected = 0; nav.length = 0;
  page._handleEvents(['finished']);
  page._handleEvents(['finished']);
  page._handleEvents(['finished']);
  /* v1.40：finished 不再直接 redirectTo 结算页 —— 先落成绩，再进本页的通用
   * 结束弹窗（B5 通关 / GAME OVER），由弹窗的 5s 倒计时 / 单击统一回主页。 */
  check('P6a finished 连续投递三次 → 只结算一次（幂等，落在结束弹窗）',
    page.state === 'OVER' && page._done === true && redirected === 0,
    'state=' + page.state + ' redirected=' + redirected);
  const { OVER: OVER_PL } = await import('./utils/layout.js');
  check('P6h OVER 态 render 不抛错（含 drawOver + HUD 降级分支）', (() => {
    try { page.render(Date.now(), { ok: true, x: 0, y: 0 }); return true; }
    catch (e) { return false; }
  })(), '');
  page.overAt = Date.now() - OVER_PL.ms - 1;
  page.tick();
  check('P6b 满 5 秒 → 自动进 B3 loading（kind=home）',
    page.state === 'LOADING' && page.loadingKind === 'home',
    'state=' + page.state + ' kind=' + page.loadingKind);
  setup();
  page._handleEvents(['finished']);
  page.onTap();
  check('P6g 未满 5 秒单击 → 提前回主页（与倒计时同一出口）',
    page.state === 'LOADING' && page.loadingKind === 'home',
    'state=' + page.state + ' kind=' + page.loadingKind);
  setup();
  redirected = 0; nav.length = 0;
  page._handleEvents(['kill', 'bomberkill', 'blast', 'hurt', 'wave', 'clear']);
  check('P6c 六类玩法事件均不触发结算（只播音）', redirected === 0, 'redirected=' + redirected);
  const rr = page.buildResult();
  check('P6d buildResult 补齐 durationSec + motion（用游戏内时钟 g.t）',
    typeof rr.durationSec === 'number' && !!rr.motion && typeof rr.motion.yawUtil === 'number',
    'durationSec=' + rr.durationSec);
  check('P6e 回场给 1 秒无敌保护（F-PLN-65）', (() => {
    setup();
    page.pl.invT = -1;
    page.state = 'MENU';
    page.backToPlay();
    return page.pl.invT >= 1000 && page.state === 'PLAY';
  })(), '');
}

console.log('\n=== P7 源码契约：两个 fade 分开，且 B2 用 0.55 不用 1 ===');
{
  const src0 = fs.readFileSync(new URL('../../pages/plane/plane.js', import.meta.url), 'utf8');
  const src = src0.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('P7a 定义了 contentFade 与 entryFade 两个变量',
    /const\s+contentFade\s*=/.test(src) && /const\s+entryFade\s*=/.test(src));
  check('P7b MENU 态：contentFade = MENU_FADE（次要层）且 entryFade = 0（菜单恒亮）',
    /contentFade\s*=[\s\S]{0,120}MENU_FADE/.test(src)
    && /entryFade\s*=\s*this\.state\s*===\s*S\.CONT\s*\?\s*1/.test(src));
  check('P7c MENU_FADE = 0.55（不是 1 → 不会塌到 6% 隐藏档）',
    /const\s+MENU_FADE\s*=\s*0\.55\s*;/.test(src));
  check('P7d 未调用 drawHint（提示条已撤）', !/drawHint\s*\(/.test(src));
  check('P7e 未绘制框架页占位（drawPlayfield）', !/drawPlayfield/.test(src));
  check('P7f 单击不唤菜单：onTap 的 PLAY 分支调用 planeBomb 而非 enterMenu',
    /if\s*\(this\.state === S\.PLAY\)[\s\S]{0,200}planeBomb/.test(src)
    && !/if\s*\(this\.state === S\.PLAY\)[\s\S]{0,200}enterMenu/.test(src));
  check('P7g 菜单入口绑在滑动通道（onSwipe → enterMenu）',
    /onSwipe[\s\S]{0,200}enterMenu/.test(src));
  check('P7h 滑动抑制窗用 TOUCH.swipeSuppress（300ms）',
    /TOUCH\.swipeSuppress/.test(src));
}


console.log('\n=== A19 机体内部构造线（v1.39 精修） ===');
{
  /* 背景：22~24px 的机体只有外轮廓时是一团模糊多边形 —— 分不清侦察机 /
   * 攻击机 / 轰炸机，也看不出机头朝哪。补内部构造线后才读作「飞行器」。 */
  const g = create();
  toP2(g);
  const m = makeCtx();
  render(g, m.ctx, 0);
  const segs = m.polys.filter((p) => p.pts.length === 2);
  check('A19a 敌机有 2 顶点内部构造线（剪影不再是一团模糊多边形）',
    segs.length >= 4, 'n=' + segs.length);

  const own = segs.filter((s) => s.pts.every(
    (p) => Math.abs(p[0] - CENTER.x) <= 10 && Math.abs(p[1] - PY.home) <= 11));
  check('A19b 己方机体 4 条构造线（座舱中轴 / 双翼前缘 / 尾喷口）',
    own.length === 4, 'n=' + own.length);

  check('A19c 构造线顶点数 ≠ 11（A15a 靠「11 顶点的 poly」定位机体，不得撞车）',
    segs.every((s) => s.pts.length !== 11), '');
}

const pass = R.filter((r) => r.ok).length;
console.log('\n=== 结论 ===');
console.log('  ' + pass + '/' + R.length + ' 项通过');
R.filter((r) => !r.ok).forEach((r) => console.log('  x ' + r.name + ' — ' + r.detail));
process.exit(pass === R.length ? 0 : 1);
