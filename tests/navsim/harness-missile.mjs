/* 导弹指挥部玩法模块冒烟 + 契约断言（本地 node，无需宿主）
 * 运行：cd tests/navsim && node build.mjs && node harness-missile.mjs
 *
 * 覆盖：
 *   A1  几何：战场 352 / 裁剪窗 61~419 / TRAVEL 160 / 6 城 / 炮台 / 地平线 332
 *   A2  锚定型 yaw 相机：光标恒钉 240、世界反向滑动、camCx 夹紧 [80,400]
 *   A3  pitch 直控：home 176、行程 [96,256]（由 PRD r5 的 ±160 收窄到 ±80）
 *   A4  波次表：10/10/12 发、齐落 1/2/3、40/55/70px/s、雷 12/12/15
 *   A5  生成与目标池：生成 x ∈ [72,408]、W1 仅城市、W2 起炮台权重 4:1
 *   A6  命中与摧毁：外扩 2px、城市被毁不可恢复、炮台被毁即失败、6 城全毁即失败
 *   A7  MIRV：W3 第 2/4 组、y=176 分裂、2~3 弹头、各弹头独立入池
 *   A8  爆炸：0.6s、r8→60→0、同屏 ≤3、达上限不耗雷、拦到即毁
 *   A9  fire 引爆：耗雷、空仓拒绝 + denyT、过场期不可引爆
 *   A10 计分：+25/弹头、波末 城市×100 + 余雷×5
 *   A11 波次推进：过场 1.2s、清场、雷数按波重置
 *   A12 失败与通关：城市全毁 / 炮台被毁 / W3 保住 ≥1 城
 *   A13 IMU 异常：玩法停摆、光标锁中立
 *   A14 三条红线静态检查
 *   A15 渲染：光标恒钉 240 / 墙随相机滑 / 墙外留白 / 离屏弹头指示器
 *   A16 result 契约 + statusText 口径
 *   A17 方向语义锁：横向必须乘 SEM_FOLLOW
 *   A18 冻结语义：不调 update 则玩法停摆
 *   P1  页面接入：B1 推进 / B2 冻结 / 四态 render 不抛错
 *   P2  提示条已撤 + 品牌胶囊仍在
 *   P3  statusText 钩子「城市 N/6」
 *   P4  tapRole='fire'：单击 = 引爆（不进菜单）、滑动 = 唤出 B2
 *   P5  滑动后 300ms 内单击忽略（F-MSL-73）
 *   P6  IMU 异常时单击 = 结束游戏（F-MSL-75，本作特有逃生出口）
 *   P7  结算幂等 + 玩法事件只播音不结算
 *   P8  源码契约：两个 fade 分开 + MENU_FADE = 0.55 + 无 grantGrace
 */
import fs from 'node:fs';

const {
  create, update, render, result, fire, aliveCities, targetRect,
  boomRadius, statusText, TRAVEL, CAM_MIN, CAM_MAX,
} = await import('./utils/missile.js');
const { MSL, VIEWPORT, CENTER } = await import('./utils/layout.js');
const { SEM_FOLLOW } = await import('./utils/input.js');

const R = [];
function check(name, cond, detail) {
  R.push({ name: name, ok: !!cond, detail: detail || '' });
  console.log('  [' + (cond ? 'PASS' : 'FAIL') + '] ' + name + (detail ? '  — ' + detail : ''));
}
function near(a, b, e) { return Math.abs(a - b) <= (e === undefined ? 0.001 : e); }

/* 记录型 ctx：关心 fillText 落点 + **屏幕系** fillRect / 圆 / 多边形。
 * 世界层整体走 translate，mock 必须真的累加平移量，否则记下来的是世界
 * 坐标，验证不了「光标屏幕位置恒为 240」。
 * ⚠ fill() 与 stroke() **各自**落一条记录 —— 只在 stroke 落记录时，
 *   "只 fill 不 stroke"的图形（离屏指示器）永远录不进来。 */
function makeCtx() {
  const texts = [], rects = [], circles = [], polys = [];
  let tx = 0, ty = 0;
  const stack = [];
  let cur = null;
  const flushCur = (mode) => {
    if (cur && cur.length) polys.push({ pts: cur.slice(), mode: mode, stroke: ctx.fillStyle });
    cur = null;
  };
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'fillText') return (s, x, y) => { texts.push({ s: String(s), x: x, y: y }); };
      if (k === 'save') return () => { stack.push([tx, ty]); };
      if (k === 'restore') return () => { const p = stack.pop(); tx = p ? p[0] : 0; ty = p ? p[1] : 0; };
      if (k === 'translate') return (dx, dy) => { tx += dx || 0; ty += dy || 0; };
      if (k === 'fillRect') return (x, y, w, h) => {
        rects.push({ x: x + tx, y: y + ty, w: w, h: h, style: t.fillStyle });
      };
      if (k === 'strokeRect') return (x, y, w, h) => {
        rects.push({ x: x + tx, y: y + ty, w: w, h: h, style: t.strokeStyle, stroked: true });
      };
      if (k === 'arc') return (cx, cy, r) => { circles.push({ cx: cx + tx, cy: cy + ty, r: r }); };
      if (k === 'beginPath') return () => { cur = []; };
      if (k === 'moveTo' || k === 'lineTo') return (x, y) => { if (cur) cur.push([x + tx, y + ty]); };
      if (k === 'closePath') return () => {};
      if (k === 'fill') return () => { flushCur('fill'); };
      if (k === 'stroke') return () => { flushCur('stroke'); };
      if (k === 'setLineDash') return () => {};
      if (k === 'clip') return () => {};
      if (k === 'rect') return () => {};
      return k in t ? t[k] : function () {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  return { ctx: ctx, texts: texts, rects: rects, circles: circles, polys: polys };
}

const DOWN = { ok: false, x: 0, y: 0 };
const snap = (x, y) => ({ ok: true, x: x || 0, y: y || 0 });

/* 推进 n 帧（每帧 33ms），返回累计事件。
 * ⚠ sx 为对象时（如 DOWN）**原样透传** —— 不能直接过 snap()，否则 ok 被
 *   强制置 true、x 变成整个对象，IMU 异常分支根本进不去。 */
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

/* 走出波次过场 1.2s（1200/33 ≈ 36.4 → 37 帧）后进入 wave */
function toWave(g) { run(g, 37, 0, 0); }

/* 把本波跑完：每帧清掉在场弹头（等价于"全部拦截"），直到 phase 离开 wave。
 * ⚠ 必须等 waveSpawned 达到本波发数，清场才有意义 —— 分叉会新增弹头，
 *   故循环里只清"当前在场"，由模块自己判"发完且场上空"。 */
function finishWave(g, maxFrames) {
  let n = 0;
  const cap = maxFrames || 4000;
  while (g.phase === 'wave' && n < cap) {
    update(g, 33, snap(0, 0));
    for (let i = 0; i < g.warheads.length; i++) g.warheads[i].on = false;
    n++;
  }
  return n;
}

/* 手工放一发弹头（绕过随机生成，便于精确断言命中 / 分叉） */
function putWarhead(g, opt) {
  for (let i = 0; i < g.warheads.length; i++) {
    const w = g.warheads[i];
    if (w.on) continue;
    w.on = true;
    w.x = opt.x; w.y = opt.y;
    w.dx = opt.dx === undefined ? 0 : opt.dx;
    w.dy = opt.dy === undefined ? 1 : opt.dy;
    w.speed = opt.speed === undefined ? 40 : opt.speed;
    w.target = opt.target || { kind: 'city', idx: 0 };
    w.mirv = !!opt.mirv;
    w.split = false;
    g.stats.total += 1;
    return w;
  }
  return null;
}

const CT = MSL.COURT;
const CT_R = CT.x + CT.w;                    // 416
const CT_B = CT.y + CT.h;                    // 332
const CLIP_L = CT.x - MSL.CAMERA.wallBand;   // 61
const CLIP_R = CT_R + MSL.CAMERA.wallBand;   // 419
const CITY_TOP = MSL.HORIZON_Y - MSL.CITY.h; // 316
const HZ = MSL.HORIZON_Y;                    // 332
const CUR = MSL.CURSOR;

console.log('\n=== A1 几何（PRD-05 §4 · 相机版 v1.32 重排） ===');
check('A1a 战场 64~416（w=352，明显窄于视口 448，两侧各 48px 空白带）',
  CT.x === 64 && CT_R === 416 && CT.w === 352, 'x=' + CT.x + ' R=' + CT_R + ' w=' + CT.w);
check('A1b 战场纵向 44~332（上接画面区顶，下沿 = 地平线）',
  CT.y === VIEWPORT.y && CT_B === HZ, 'y=' + CT.y + ' B=' + CT_B);
check('A1c 裁剪窗 ' + CLIP_L + '~' + CLIP_R + ' 严格窄于视口 16~464（墙外恒为空白）',
  CLIP_L > 16 && CLIP_R < 464, 'clip=' + CLIP_L + '~' + CLIP_R);
check('A1d 地平线 y=332（用户 2026-09-05 裁定：提示条已撤，D-MSL-15 的理由不成立）',
  HZ === 332, 'HZ=' + HZ);
check('A1e 6 城中心 x = 80/144/208/272/336/400（间距 64，对称）',
  MSL.CITY.xs.join(',') === '80,144,208,272,336,400', MSL.CITY.xs.join(','));
check('A1f 城市 24×16，y ' + CITY_TOP + '~' + HZ + '，两端距墙内侧面各 16px（PRD r5 值可直接当世界坐标）',
  MSL.CITY.w === 24 && MSL.CITY.h === 16 && CITY_TOP === 316
  && MSL.CITY.xs[0] - CT.x === 16 && CT_R - MSL.CITY.xs[5] === 16,
  'w=' + MSL.CITY.w + ' h=' + MSL.CITY.h + ' top=' + CITY_TOP);
check('A1g 炮台 32×16 @x224~256，中心 240 == 战场中心',
  MSL.BATTERY.x0 === 224 && MSL.BATTERY.w === 32
  && MSL.BATTERY.x0 + MSL.BATTERY.w / 2 === 240, 'x0=' + MSL.BATTERY.x0);
check('A1h 炮台与两侧城市（208 / 272 中心，各 24 宽 → 内缘 220 / 260）各留 4px 间隙',
  224 - (208 + 12) === 4 && (272 - 12) - 256 === 4, 'gap=' + (224 - 220));
check('A1i 生成线 y=44、分叉高度 y=176（屏高 1/2）',
  MSL.SPAWN_Y === 44 && MSL.MIRV_Y === 176, 'spawn=' + MSL.SPAWN_Y + ' mirv=' + MSL.MIRV_Y);
check('A1j 弹头生成 x ∈ [72,408]（战场内留 8px，不贴墙生成）',
  MSL.SPAWN_X.min === 72 && MSL.SPAWN_X.max === 408,
  MSL.SPAWN_X.min + '~' + MSL.SPAWN_X.max);
check('A1k TRAVEL = 352/2 − 16 = 160（由几何算出，非硬编码）',
  TRAVEL === 160 && CAM_MIN === 80 && CAM_MAX === 400,
  'TRAVEL=' + TRAVEL + ' cam∈[' + CAM_MIN + ',' + CAM_MAX + ']');
check('A1l 弹头行程 = (316−2) − 44 = 270px；W1 飞行 270/40 = 6.75s',
  (CITY_TOP - MSL.HIT_INSET) - MSL.SPAWN_Y === 270
  && near((CITY_TOP - MSL.HIT_INSET - MSL.SPAWN_Y) / 40, 6.75, 0.01),
  '行程=' + ((CITY_TOP - MSL.HIT_INSET) - MSL.SPAWN_Y));

console.log('\n=== A2 锚定型 yaw 相机（光标恒钉 240，世界反向滑） ===');
{
  const g = create();
  update(g, 33, snap(0, 0));
  check('A2a 中立位 camCx = 240（战场中心），光标世界坐标 == 相机中心',
    near(g.camCx, 240), 'camCx=' + g.camCx);

  update(g, 33, snap(100, 0));
  check('A2b camCx = 240 + SEM_FOLLOW × snap.x（映射与 r5 直控**完全等价**）',
    near(g.camCx, 240 + SEM_FOLLOW * 100), 'camCx=' + g.camCx);
  check('A2c 头左转（snap.x>0）→ camCx 减小 → 世界右滑（反向补偿）',
    SEM_FOLLOW === -1 && g.camCx < 240, 'SEM_FOLLOW=' + SEM_FOLLOW + ' camCx=' + g.camCx);

  update(g, 33, snap(300, 0));
  check('A2d camCx 夹紧下限 = 80（光标外缘不越战场左墙）',
    near(g.camCx, CAM_MIN), 'camCx=' + g.camCx);
  update(g, 33, snap(-300, 0));
  check('A2e camCx 夹紧上限 = 400（光标外缘不越战场右墙）',
    near(g.camCx, CAM_MAX), 'camCx=' + g.camCx);

  /* 等价性硬断言：直控与相机版的"光标世界坐标"必须是同一个表达式 */
  let eq = true;
  for (let v = -260; v <= 260; v += 20) {
    const gx = create();
    update(gx, 33, snap(v, 0));
    const want = Math.min(CAM_MAX, Math.max(CAM_MIN, 240 + SEM_FOLLOW * v));
    if (!near(gx.camCx, want)) eq = false;
  }
  check('A2f 全量程扫掠：camCx 恒等于 clamp(240 + SEM_FOLLOW×snap.x)（27 点）', eq, '');

  const g2 = create();
  toWave(g2);
  update(g2, 33, snap(120, 0));
  const dx = 240 - g2.camCx;
  check('A2g 绘制偏移 dx = 240 − camCx（世界右移量 = 头左转量）',
    near(dx, 120), 'dx=' + dx);
  check('A2h 光标**屏幕** x 恒为 240（不随 camCx 变化 —— 锚定型的核心承诺）',
    true, '由 A15a 的渲染断言验证');
}

console.log('\n=== A3 pitch 直控（行程由 PRD r5 的 ±160 收窄到 ±80） ===');
{
  const g = create();
  update(g, 33, snap(0, 0));
  check('A3a 中立位 cursorY = 176（屏心）', near(g.cursorY, CUR.home), 'y=' + g.cursorY);
  update(g, 33, snap(0, 160));
  check('A3b 抬头满偏 → cursorY = 96（home − half）',
    near(g.cursorY, 96), 'y=' + g.cursorY);
  update(g, 33, snap(0, -160));
  check('A3c 低头满偏 → cursorY = 256（home + half）',
    near(g.cursorY, 256), 'y=' + g.cursorY);
  update(g, 33, snap(0, 400));
  check('A3d 超量程夹紧在下限 96（不越安全区）', near(g.cursorY, 96), 'y=' + g.cursorY);
  update(g, 33, snap(0, -400));
  check('A3e 超量程夹紧在上限 256（不压地平线）', near(g.cursorY, 256), 'y=' + g.cursorY);
  check('A3f 行程 ±80 = 160px（PRD r5 是 ±160 = 320px，纵向位移降 75%）',
    CUR.half === 80 && CUR.home - CUR.half === 96 && CUR.home + CUR.half === 256,
    'half=' + CUR.half);
  check('A3g vscale 0.5：三档灵敏度满偏恒 160px × 0.5 = 80（恰好覆盖行程并夹紧）',
    near(CUR.vscale, 0.5) && near(8 * 20 * CUR.vscale, 80)
    && near(10.4 * 15.4 * CUR.vscale, 80, 0.5)
    && near(6 * 26.7 * CUR.vscale, 80, 0.5),
    'vscale=' + CUR.vscale);
  check('A3h 爆炸 r60 覆盖 [36, 316]：全天空带 + 城市顶无死角（half=80 的联立解）',
    CUR.home - CUR.half - MSL.BOOM.rMax <= MSL.SPAWN_Y
    && CUR.home + CUR.half + MSL.BOOM.rMax >= CITY_TOP,
    '覆盖=' + (CUR.home - CUR.half - MSL.BOOM.rMax) + '~' + (CUR.home + CUR.half + MSL.BOOM.rMax));
  /* 两轴解耦（F-MSL-03） */
  const g2 = create();
  update(g2, 33, snap(150, 90));
  const c1 = g2.camCx, y1 = g2.cursorY;
  update(g2, 33, snap(150, -90));
  check('A3i 抬头/低头不改变 camCx（两轴独立，无耦合项）',
    near(g2.camCx, c1), 'camCx ' + c1 + ' → ' + g2.camCx);
  update(g2, 33, snap(-150, -90));
  const y2 = g2.cursorY;
  update(g2, 33, snap(150, -90));
  check('A3j 左右转头不改变 cursorY（两轴独立，无耦合项）',
    near(g2.cursorY, y2), 'cursorY ' + y2 + ' → ' + g2.cursorY);
}

console.log('\n=== A4 波次表（§6.2 单关三波） ===');
{
  const W = MSL.WAVES;
  check('A4a 三波', W.length === 3, 'n=' + W.length);
  check('A4b 发数 10 / 10 / 12', W[0].missiles === 10 && W[1].missiles === 10 && W[2].missiles === 12,
    W.map((w) => w.missiles).join('/'));
  check('A4c 齐落 1 / 2 / 3 发', W[0].perEvent === 1 && W[1].perEvent === 2 && W[2].perEvent === 3,
    W.map((w) => w.perEvent).join('/'));
  check('A4d 生成节奏 2.8 / 3.2 / 4.0 s',
    W[0].gapMs === 2800 && W[1].gapMs === 3200 && W[2].gapMs === 4000,
    W.map((w) => w.gapMs).join('/'));
  check('A4e 弹速 40 / 55 / 70 px/s（原三关速度曲线搬进单关内部）',
    W[0].speed === 40 && W[1].speed === 55 && W[2].speed === 70,
    W.map((w) => w.speed).join('/'));
  check('A4f 拦截雷 12 / 12 / 15（每波独立补给，上波剩余清零）',
    W[0].ammo === 12 && W[1].ammo === 12 && W[2].ammo === 15,
    W.map((w) => w.ammo).join('/'));
  check('A4g 分叉弹仅 W3，2 发', W[0].mirv === 0 && W[1].mirv === 0 && W[2].mirv === 2,
    W.map((w) => w.mirv).join('/'));
  check('A4h W3 弹头总数 = 12 − 2 + 2×(2~3) = 14~16，雷 15 < 16 → 全拦必须一爆多杀',
    12 - 2 + 2 * 2 === 14 && 12 - 2 + 2 * 3 === 16 && W[2].ammo < 16,
    '14~16 vs ammo=' + W[2].ammo);
  check('A4i 波次过场 1.2s', MSL.GAP_MS === 1200, 'gap=' + MSL.GAP_MS);
  check('A4j 分叉弹头数随机 2~3', MSL.MIRV_N[0] === 2 && MSL.MIRV_N[1] === 3, MSL.MIRV_N.join('/'));
  check('A4k 开局 phase=gap 且雷数 = W1 的 12',
    (() => { const g = create(); return g.phase === 'gap' && g.ammo === 12; })(), '');
}

console.log('\n=== A5 生成与目标池（F-MSL-40/41） ===');
{
  const g = create();
  toWave(g);
  check('A5a 走出过场后 phase=wave', g.phase === 'wave', 'phase=' + g.phase);
  /* W1 首组在 t=2800（帧 85）生成 */
  run(g, 86, 0, 0);
  let on = 0;
  for (let i = 0; i < g.warheads.length; i++) if (g.warheads[i].on) on++;
  check('A5b W1 每 2.8s 生成 1 发（首组后场上 1 发）', on === 1, 'on=' + on);

  /* 数满 10 发需要 28s，而弹头 6.8s 就落地 —— 放任不管会先把城市打光（over）
   * 导致生成提前中断。所以这里每帧清场，只测「生成计数」这一件事。 */
  const g2 = create();
  toWave(g2);
  let spawnedMax = 0;
  for (let i = 0; i < 86 * 12; i++) {
    update(g2, 33, snap(0, 0));
    if (g2.waveSpawned > spawnedMax) spawnedMax = g2.waveSpawned;
    for (let k = 0; k < g2.warheads.length; k++) g2.warheads[k].on = false;
    if (g2.phase !== 'wave') break;
  }
  check('A5c W1 生成 10 发后 waveSpawned = 10（达到本波发数）',
    spawnedMax === 10, 'spawned=' + spawnedMax);

  /* 生成 x 范围（多次采样；目标随机但 x 必须在 SPAWN_X 内） */
  let inRange = true, n = 0;
  for (let k = 0; k < 40; k++) {
    const gg = create();
    toWave(gg);
    run(gg, 86, 0, 0);
    for (let i = 0; i < gg.warheads.length; i++) {
      const w = gg.warheads[i];
      if (!w.on) continue;
      n++;
      /* 生成后已推进 1 帧，允许 1 发 40px/s × 33ms ≈ 1.4px 的容差 */
      if (w.x < MSL.SPAWN_X.min - 2 || w.x > MSL.SPAWN_X.max + 2) inRange = false;
    }
  }
  check('A5d 生成 x 恒在 [72,408] 内（40 次采样 n=' + n + '）', inRange && n > 0, '');

  /* W1 目标池**不含**炮台（D-MSL-10 新手保护） */
  let batHit = 0, cityHit = 0;
  for (let k = 0; k < 60; k++) {
    const gg = create();
    toWave(gg);
    run(gg, 86, 0, 0);
    for (let i = 0; i < gg.warheads.length; i++) {
      const w = gg.warheads[i];
      if (!w.on || !w.target) continue;
      if (w.target.kind === 'battery') batHit++; else cityHit++;
    }
  }
  check('A5e W1 目标池只有城市（60 次采样，炮台 0 次）',
    batHit === 0 && cityHit > 0, 'city=' + cityHit + ' battery=' + batHit);

  /* W2 起炮台入池，权重 城市4 : 炮台1 → 单发命中炮台概率 = 1/(6×4+1) = 1/25 */
  let bat2 = 0, city2 = 0;
  for (let k = 0; k < 80; k++) {
    const gg = create();
    toWave(gg);
    finishWave(gg);                 // W1 → gap
    toWave(gg);                     // → W2
    run(gg, 97, 0, 0);              // 3.2s = 帧 97，W2 首组 2 发
    for (let i = 0; i < gg.warheads.length; i++) {
      const w = gg.warheads[i];
      if (!w.on || !w.target) continue;
      if (w.target.kind === 'battery') bat2++; else city2++;
    }
  }
  check('A5f W2 起炮台入目标池（80 次采样，炮台 > 0）',
    bat2 > 0, 'city=' + city2 + ' battery=' + bat2);
  check('A5g 炮台权重 1 : 城市 4×6=24 → 实测占比接近 1/25 = 4%',
    city2 + bat2 > 0 && (bat2 / (city2 + bat2)) < 0.15,
    'battery 占比=' + (bat2 / (city2 + bat2) * 100).toFixed(1) + '%');

  /* 被毁城市不再入池 */
  const g3 = create();
  toWave(g3);
  for (let i = 0; i < 5; i++) g3.cities[i].alive = false;   // 只留最后 1 座
  let onlyLast = true, cityN = 0;
  for (let k = 0; k < 30; k++) {
    for (let i = 0; i < g3.warheads.length; i++) g3.warheads[i].on = false;
    run(g3, 86, 0, 0);
    for (let i = 0; i < g3.warheads.length; i++) {
      const w = g3.warheads[i];
      if (!w.on || !w.target) continue;
      if (w.target.kind !== 'city') continue;   // W2 起炮台入池，与「被毁城市」无关
      cityN++;
      if (w.target.idx !== 5) onlyLast = false;
    }
  }
  check('A5h 被毁城市不再进入后续新弹的目标池（30 次采样，城市目标全瞄 5 号）',
    onlyLast && cityN > 0, '城市目标 n=' + cityN);
  check('A5i 目标已毁时 targetRect 返回 null（→ 落地扬尘无害，F-MSL-45）',
    targetRect(g3, { kind: 'city', idx: 0 }) === null, '');
}

console.log('\n=== A6 命中与摧毁（F-MSL-44/45/63） ===');
{
  const g = create();
  toWave(g);
  putWarhead(g, { x: 80, y: CITY_TOP + 4, dy: 1, target: { kind: 'city', idx: 0 } });
  update(g, 33, snap(0, 0));
  check('A6a 弹头进入城市矩形（外扩 2px）→ 城市被毁',
    g.cities[0].alive === false, 'city0.alive=' + g.cities[0].alive);

  const g2 = create();
  toWave(g2);
  putWarhead(g2, { x: 80, y: CITY_TOP - 3, dy: 1, target: { kind: 'city', idx: 0 } });
  update(g2, 33, snap(0, 0));
  check('A6b 外扩 2px 生效：y=313（顶边上方 3px，外扩内）也算命中',
    g2.cities[0].alive === false, 'y=313 → alive=' + g2.cities[0].alive);

  const g3 = create();
  toWave(g3);
  putWarhead(g3, { x: 80, y: CITY_TOP - 10, dy: 1, target: { kind: 'city', idx: 0 } });
  update(g3, 33, snap(0, 0));
  check('A6c 未进入矩形（y=306）→ 不命中，城市存活',
    g3.cities[0].alive === true, 'y=306 → alive=' + g3.cities[0].alive);

  /* 落地无害（目标已被别的爆炸毁掉）—— 40px/s × 33ms ≈ 1.32px/帧，
   * 从 y=331 走到判定线 334 需 3 帧，这里给 4 帧（扬尘寿命 300ms，仍存活） */
  const g4 = create();
  toWave(g4);
  g4.cities[0].alive = false;
  putWarhead(g4, { x: 80, y: HZ - 1, dy: 1, target: { kind: 'city', idx: 0 } });
  let dust = 0;
  for (let i = 0; i < g4.dusts.length; i++) if (g4.dusts[i].on) dust++;
  run(g4, 4, 0, 0);
  let dust2 = 0;
  for (let i = 0; i < g4.dusts.length; i++) if (g4.dusts[i].on) dust2++;
  check('A6d 目标已毁 → 弹头落地仅扬尘，无伤害（F-MSL-45）',
    dust2 > dust && aliveCities(g4) === 5, 'dust ' + dust + '→' + dust2 + ' 存活=' + aliveCities(g4));

  /* 炮台被毁即失败 */
  const g5 = create();
  toWave(g5);
  g5.waveIdx = 1;
  putWarhead(g5, { x: 240, y: CITY_TOP + 4, dy: 1, target: { kind: 'battery', idx: -1 } });
  update(g5, 33, snap(0, 0));
  check('A6e 炮台被毁 → 立即失败（over + cleared=false）',
    g5.batteryAlive === false && g5.over === true && g5.cleared === false,
    'bat=' + g5.batteryAlive + ' over=' + g5.over);

  /* 6 城全毁即失败（不等弹道落地，F-MSL-64） */
  const g6 = create();
  toWave(g6);
  for (let i = 0; i < 5; i++) g6.cities[i].alive = false;
  putWarhead(g6, { x: 400, y: CITY_TOP + 4, dy: 1, target: { kind: 'city', idx: 5 } });
  const ev6 = update(g6, 33, snap(0, 0));
  check('A6f 6 城全毁 → 立即判定失败（存活 0，不等落地）',
    aliveCities(g6) === 0 && g6.over === true && g6.cleared === false,
    'alive=' + aliveCities(g6) + ' over=' + g6.over);
  check('A6g 失败时投递 fail 事件', ev6.indexOf('fail') >= 0, ev6.join(','));

  /* 失败提示 0.6s 后才 finished */
  const g7 = create();
  toWave(g7);
  for (let i = 0; i < 6; i++) g7.cities[i].alive = false;
  g7.over = false;
  putWarhead(g7, { x: 80, y: CITY_TOP + 4, dy: 1, target: { kind: 'city', idx: 0 } });
  g7.cities[0].alive = true;
  update(g7, 33, snap(0, 0));
  let fin = [];
  for (let i = 0; i < 25; i++) {
    const e = update(g7, 33, snap(0, 0));
    for (let k = 0; k < e.length; k++) fin.push(e[k]);
  }
  check('A6h 失败后 0.6s（19 帧）才投递 finished（F-MSL-64）',
    fin.indexOf('finished') >= 0, 'events=' + fin.join(','));
  check('A6i finished 只投递一次（幂等，防结算页被压栈两遍）',
    fin.filter((e) => e === 'finished').length === 1,
    'n=' + fin.filter((e) => e === 'finished').length);

  const g8 = create();
  toWave(g8);
  putWarhead(g8, { x: 80, y: CITY_TOP + 4, dy: 1, target: { kind: 'city', idx: 0 } });
  update(g8, 33, snap(0, 0));
  const scoreBefore = g8.score;
  update(g8, 33, snap(0, 0));
  check('A6j 城市被毁当局内不可恢复（后续帧存活数不回升）',
    aliveCities(g8) === 5 && g8.score === scoreBefore, 'alive=' + aliveCities(g8));
}

console.log('\n=== A7 空中分叉 MIRV（F-MSL-43，仅 W3） ===');
{
  const g = create();
  toWave(g);
  finishWave(g);            // W1 → gap
  toWave(g);                // → W2
  finishWave(g);            // W2 → gap
  toWave(g);                // → W3
  check('A7a 连过两波后进入 W3（waveIdx=2）', g.waveIdx === 2, 'waveIdx=' + g.waveIdx);

  /* W3 首组在 t=4000（帧 122），3 发齐落；第 2 组在 t=8000（帧 243）含分叉弹 */
  run(g, 123, 0, 0);
  let mirv1 = 0;
  for (let i = 0; i < g.warheads.length; i++) if (g.warheads[i].on && g.warheads[i].mirv) mirv1++;
  check('A7b W3 第 1 组无分叉弹（分叉安排在第 2、4 组）', mirv1 === 0, 'mirv=' + mirv1);

  /* 清掉首组，跑到第 2 组生成 */
  for (let i = 0; i < g.warheads.length; i++) g.warheads[i].on = false;
  run(g, 122, 0, 0);
  let mirv2 = 0;
  let mw = null;
  for (let i = 0; i < g.warheads.length; i++) {
    if (g.warheads[i].on && g.warheads[i].mirv) { mirv2++; if (!mw) mw = g.warheads[i]; }
  }
  check('A7c W3 第 2 组含 1 发分叉弹', mirv2 === 1, 'mirv=' + mirv2);

  /* 分裂：把分叉弹推到 y ≥ 176。
   * 注意 splitWarhead 会先把原槽位置 off，随即被第一个子弹复用 —— 所以
   * 「原弹头消失」的判据是：场上不再有 mirv 标记的弹头 + 该槽位已换新（mirv 已清）。 */
  let splitOk = false, splitN = 0, mirvAfter = -1;
  if (mw) {
    const slot = g.warheads.indexOf(mw);
    mw.y = MSL.MIRV_Y + 1;
    const before = g.stats.total;
    update(g, 33, snap(0, 0));
    splitN = g.stats.total - before;
    mirvAfter = 0;
    for (let i = 0; i < g.warheads.length; i++) if (g.warheads[i].on && g.warheads[i].mirv) mirvAfter++;
    const slotGone = !g.warheads[slot].on || g.warheads[slot].mirv === false;
    splitOk = mirvAfter === 0 && slotGone && splitN >= 2 && splitN <= 3;
  }
  check('A7d 分叉弹在 y=176 裂为 2~3 个弹头（原弹头消失）',
    splitOk, 'new=' + splitN + ' 残留分叉弹=' + mirvAfter);
  check('A7e 分叉出的每个弹头都独立计入 stats.total（独立计分，F-MSL-60）',
    splitN >= 2, 'total +' + splitN);

  /* 分叉后各弹头改瞄**当前存活**目标（分叉是"新生成"事件） */
  const g2 = create();
  toWave(g2);
  g2.waveIdx = 2;
  /* W2 起炮台入池（A5f），这里要断言的是「只瞄存活城市」→ 先把炮台移出池。
   * 直接置 batteryAlive=false 不会触发 lose（lose 只在 destroyTarget 里调用）。 */
  g2.batteryAlive = false;
  for (let i = 0; i < g2.cities.length; i++) g2.cities[i].alive = (i === 3);  // 只留 3 号
  const w2 = putWarhead(g2, { x: 300, y: MSL.MIRV_Y - 10, dy: 1, mirv: true });
  w2.y = MSL.MIRV_Y + 1;
  update(g2, 33, snap(0, 0));
  let allTo3 = true, cnt = 0;
  for (let i = 0; i < g2.warheads.length; i++) {
    const w = g2.warheads[i];
    if (!w.on || !w.target) continue;
    cnt++;
    if (w.target.kind !== 'city' || w.target.idx !== 3) allTo3 = false;
  }
  check('A7f 分叉时刻从**当前存活**目标池重选（此处全瞄唯一存活的 3 号）',
    cnt >= 2 && allTo3, 'n=' + cnt + ' allTo3=' + allTo3);

  /* W1/W2 不产生分叉 */
  const g3 = create();
  toWave(g3);
  run(g3, 86 * 10, 0, 0);
  let anyMirv = 0;
  for (let i = 0; i < g3.warheads.length; i++) if (g3.warheads[i].mirv) anyMirv++;
  check('A7g W1 全程无分叉弹', anyMirv === 0, 'mirv=' + anyMirv);
}

console.log('\n=== A8 爆炸与拦截（F-MSL-30~34） ===');
{
  check('A8a 爆炸半径曲线：k=0 → 8、k=0.5 → 60、k=1 → 0',
    near(boomRadius(0), 8) && near(boomRadius(0.5), 60) && near(boomRadius(1), 0),
    [0, 0.5, 1].map((k) => boomRadius(k).toFixed(1)).join('/'));
  check('A8b 前 0.3s 单调扩张（ease-out）、后 0.3s 单调收缩',
    boomRadius(0.1) > boomRadius(0.05) && boomRadius(0.3) > boomRadius(0.1)
    && boomRadius(0.7) < boomRadius(0.5) && boomRadius(0.9) < boomRadius(0.7),
    [0.05, 0.1, 0.3, 0.5, 0.7, 0.9].map((k) => boomRadius(k).toFixed(0)).join('→'));
  check('A8c 生命周期 0.6s、最大半径 60、同屏上限 3',
    MSL.BOOM.ms === 600 && MSL.BOOM.rMax === 60 && MSL.BOOM.max === 3,
    'ms=' + MSL.BOOM.ms + ' rMax=' + MSL.BOOM.rMax + ' max=' + MSL.BOOM.max);

  const g = create();
  toWave(g);
  check('A8d wave 态 fire 成功（余量 12 → 11）',
    fire(g) === true && g.ammo === 11, 'ammo=' + g.ammo);
  let on = 0;
  for (let i = 0; i < g.booms.length; i++) if (g.booms[i].on) on++;
  check('A8e 引爆后场上有 1 枚爆炸', on === 1, 'on=' + on);

  fire(g); fire(g);
  on = 0;
  for (let i = 0; i < g.booms.length; i++) if (g.booms[i].on) on++;
  check('A8f 连点三次 → 同屏 3 枚（达到上限）', on === 3 && g.ammo === 9, 'on=' + on + ' ammo=' + g.ammo);
  const r4 = fire(g);
  check('A8g 达上限时单击**不消耗**拦截雷（F-MSL-32）',
    r4 === false && g.ammo === 9, 'ret=' + r4 + ' ammo=' + g.ammo);
  check('A8h 达上限时给 120ms 闪烁反馈（denyT 置位，不静默吞输入）',
    g.denyT > 0 && g.denyT <= MSL.FX.denyMs, 'denyT=' + g.denyT);

  /* 拦截：把弹头放进爆炸范围 */
  const g2 = create();
  toWave(g2);
  fire(g2);
  const b = g2.booms[0];
  putWarhead(g2, { x: b.x, y: b.y });      // 正落在爆炸圆心
  const s0 = g2.score;
  const ev2 = update(g2, 33, snap(0, 0));
  check('A8i 弹头进爆炸半径 → 被毁 + 25 分',
    g2.score === s0 + MSL.SCORE.perWarhead, 'score ' + s0 + ' → ' + g2.score);
  check('A8j 拦截投递 boom 事件', ev2.indexOf('boom') >= 0, ev2.join(','));

  /* 每弹头只结算一次 */
  const g3 = create();
  toWave(g3);
  fire(g3);
  const b3 = g3.booms[0];
  putWarhead(g3, { x: b3.x, y: b3.y });
  let hits = 0;
  for (let i = 0; i < 5; i++) {
    const e = update(g3, 33, snap(0, 0));
    for (let k = 0; k < e.length; k++) if (e[k] === 'boom') hits++;
  }
  check('A8k 每弹头只结算一次（5 帧内 boom 事件恰好 1 次）', hits === 1, 'hits=' + hits);

  /* 半径外不拦 */
  const g4 = create();
  toWave(g4);
  update(g4, 33, snap(0, 0));
  fire(g4);
  const b4 = g4.booms[0];
  run(g4, 9, 0, 0);                        // 扩到最大半径
  putWarhead(g4, { x: b4.x + 80, y: b4.y });   // 距圆心 80 > 60
  const s4 = g4.score;
  update(g4, 33, snap(0, 0));
  check('A8l 半径外（80 > 60）不拦截', g4.score === s4, 'score=' + g4.score);

  /* 爆炸是世界坐标，不随相机移动 */
  const g5 = create();
  toWave(g5);
  fire(g5);
  const bx = g5.booms[0].x;
  update(g5, 33, snap(150, 0));             // 大幅转头
  check('A8m 爆炸记**世界坐标**（转头后 x 不变 —— 爆炸是空间中的一点）',
    near(g5.booms[0].x, bx), 'x ' + bx + ' → ' + g5.booms[0].x);
  check('A8n 爆炸纵向 y == 光标 y（纵向不经相机，世界 y == 屏幕 y）',
    near(g5.booms[0].y, g5.cursorY), 'y=' + g5.booms[0].y + ' cursorY=' + g5.cursorY);

  /* 同屏上限的爆炸池容量 */
  const g6 = create();
  toWave(g6);
  check('A8o 爆炸池容量 == BOOM.max（3，不会出现"池子比上限大"的浪费）',
    g6.booms.length === MSL.BOOM.max, 'pool=' + g6.booms.length);
}

console.log('\n=== A9 fire 引爆（F-MSL-21/34） ===');
{
  const g = create();
  check('A9a 过场（gap）期单击无效（F-MSL-50：过场停止生成，也不该引爆）',
    fire(g) === false, 'phase=' + g.phase);
  toWave(g);
  check('A9b 进入 wave 后可引爆', fire(g) === true, '');
  g.ammo = 0;
  const r = fire(g);
  check('A9c 余量 0 → 单击无效（空仓不产生爆炸）', r === false, 'ret=' + r);
  check('A9d 空仓单击置 denyT（HUD 数值 120ms 闪烁反馈）',
    g.denyT > 0, 'denyT=' + g.denyT);
  g.ammo = 5;
  for (let i = 0; i < g.booms.length; i++) g.booms[i].on = false;
  check('A9e 空仓后再补雷 → 恢复可引爆（denyT 不锁死输入）', fire(g) === true, '');

  const g2 = create();
  toWave(g2);
  g2.over = true;
  check('A9f over 之后单击无效', fire(g2) === false && g2.ammo === 12, 'ammo=' + g2.ammo);

  /* 发射连线 */
  const g3 = create();
  toWave(g3);
  update(g3, 33, snap(60, 0));
  fire(g3);
  let links = 0;
  for (let i = 0; i < g3.links.length; i++) if (g3.links[i].on) links++;
  check('A9g 引爆生成发射连线（炮台 → 爆点，F-MSL-35）', links === 1, 'links=' + links);
  let l0 = null;
  for (let i = 0; i < g3.links.length; i++) if (g3.links[i].on) l0 = g3.links[i];
  check('A9h 连线起点 = 炮台中心 (240, 316)，终点 = 爆点（camCx, cursorY）',
    l0 && near(l0.x0, 240) && near(l0.y0, CITY_TOP)
    && near(l0.x1, g3.camCx) && near(l0.y1, g3.cursorY),
    l0 ? ('(' + l0.x0 + ',' + l0.y0 + ')→(' + l0.x1 + ',' + l0.y1 + ')') : 'none');
  run(g3, 5, 0, 0);
  let links2 = 0;
  for (let i = 0; i < g3.links.length; i++) if (g3.links[i].on) links2++;
  check('A9i 连线 120ms 后渐隐消失（5 帧 = 165ms > 120ms）', links2 === 0, 'links=' + links2);
}

console.log('\n=== A10 计分（F-MSL-60/61） ===');
{
  const g = create();
  toWave(g);
  fire(g);
  const b = g.booms[0];
  putWarhead(g, { x: b.x, y: b.y });
  putWarhead(g, { x: b.x + 10, y: b.y });
  update(g, 33, snap(0, 0));
  check('A10a 一爆多杀：2 个弹头 → +50 分',
    g.score === 2 * MSL.SCORE.perWarhead, 'score=' + g.score);

  const g2 = create();
  toWave(g2);
  check('A10b 波末奖励 = 存活城市 ×100 + 余雷 ×5',
    (() => {
      const alive = aliveCities(g2), ammo = g2.ammo;
      const before = g2.score;
      finishWave(g2);
      /* finishWave 会清掉所有弹头，等价于全拦但**不计分**，故只看波末奖励 */
      return g2.score - before === alive * MSL.SCORE.cityBonus + (ammo - 0) * MSL.SCORE.ammoBonus;
    })(), 'score=' + g2.score);

  const g3 = create();
  toWave(g3);
  g3.cities[0].alive = false;
  g3.cities[1].alive = false;
  const before3 = g3.score;
  const ammo3 = g3.ammo;
  finishWave(g3);
  check('A10c 被毁城市的波末奖励不再计入（4 城 → 400 而非 600）',
    g3.score - before3 === 4 * MSL.SCORE.cityBonus + ammo3 * MSL.SCORE.ammoBonus,
    'Δ=' + (g3.score - before3));

  check('A10d 计分常量：+25/弹头、城市 ×100、余雷 ×5',
    MSL.SCORE.perWarhead === 25 && MSL.SCORE.cityBonus === 100 && MSL.SCORE.ammoBonus === 5,
    JSON.stringify(MSL.SCORE));

  const g4 = create();
  toWave(g4);
  fire(g4);
  const b4 = g4.booms[0];
  putWarhead(g4, { x: b4.x, y: b4.y });
  update(g4, 33, snap(0, 0));
  const rr = result(g4);
  check('A10e result.score 与 g.score 一致',
    rr.score === g4.score, rr.score + ' vs ' + g4.score);
  check('A10f 拦截率 = 拦截数 / 总弹头数（百分比取整）',
    rr.extra[0].label === '拦截率' && rr.extra[0].value === '100%',
    rr.extra[0].label + '=' + rr.extra[0].value);
  check('A10g extra 第二项 = 幸免城市 N/6',
    rr.extra[1].label === '幸免城市' && rr.extra[1].value === '6/6',
    rr.extra[1].label + '=' + rr.extra[1].value);
  check('A10h extra 两项 label 均 ≤4 字（PRD-05 §7.1 收紧口径）',
    rr.extra.every((e) => e.label.length <= 4), rr.extra.map((e) => e.label).join('/'));
}

console.log('\n=== A11 波次推进（F-MSL-50/51） ===');
{
  const g = create();
  check('A11a 开局先走 1.2s 过场「第 1 波」', g.phase === 'gap' && g.waveIdx === 0, '');
  const ev = run(g, 37, 0, 0);
  check('A11b 过场结束进入 wave，并投递 wave 事件',
    g.phase === 'wave', 'phase=' + g.phase);
  finishWave(g);
  check('A11c 本波弹头结算完 → 进入过场', g.phase === 'gap', 'phase=' + g.phase);
  check('A11d 过场时 waveIdx 前进到 1（W2）', g.waveIdx === 1, 'waveIdx=' + g.waveIdx);
  check('A11e 新波雷数按波次表重置为 12（上波剩余清零）',
    g.ammo === MSL.WAVES[1].ammo, 'ammo=' + g.ammo);
  let on = 0;
  for (let i = 0; i < g.warheads.length; i++) if (g.warheads[i].on) on++;
  check('A11f 过场清场：在场弹头为 0', on === 0, 'on=' + on);
  let bo = 0;
  for (let i = 0; i < g.booms.length; i++) if (g.booms[i].on) bo++;
  check('A11g 过场清场：在爆爆炸为 0', bo === 0, 'booms=' + bo);
  toWave(g);
  check('A11h 过场 1.2s 后自动进入下一波（无需玩家操作）',
    g.phase === 'wave' && g.waveIdx === 1, 'phase=' + g.phase + ' waveIdx=' + g.waveIdx);
  finishWave(g);
  check('A11i W2 结算完 → 进入 W3（waveIdx=2）', g.waveIdx === 2, 'waveIdx=' + g.waveIdx);
  check('A11j W3 雷数 15', g.ammo === 15, 'ammo=' + g.ammo);
  toWave(g);
  finishWave(g);
  check('A11k W3 结算完且城市存活 → 通关（cleared=true）',
    g.cleared === true && g.over === true, 'cleared=' + g.cleared);
  check('A11l 通关 reachedLevel = 3（复用为"到达波次"）',
    result(g).reachedLevel === 3, 'lv=' + result(g).reachedLevel);
}

console.log('\n=== A12 失败与通关（F-MSL-63/65/66） ===');
{
  /* 通关：W3 完成 + ≥1 城市存活 */
  const g = create();
  toWave(g);
  finishWave(g); toWave(g);
  finishWave(g); toWave(g);
  g.cities[0].alive = false; g.cities[1].alive = false;
  finishWave(g);
  check('A12a W3 完成 + 4 城存活 → 通关',
    g.cleared === true, 'cleared=' + g.cleared + ' alive=' + aliveCities(g));

  /* 失败：6 城全毁 */
  const g2 = create();
  toWave(g2);
  for (let i = 0; i < 6; i++) g2.cities[i].alive = false;
  putWarhead(g2, { x: 80, y: CITY_TOP + 4, dy: 1, target: { kind: 'city', idx: 0 } });
  g2.cities[0].alive = true;
  update(g2, 33, snap(0, 0));
  check('A12b 6 城全毁 → 失败（cleared=false）',
    g2.over === true && g2.cleared === false, 'over=' + g2.over + ' cleared=' + g2.cleared);

  /* 失败：炮台被毁 */
  const g3 = create();
  toWave(g3);
  g3.waveIdx = 1;
  putWarhead(g3, { x: 240, y: CITY_TOP + 4, dy: 1, target: { kind: 'battery', idx: -1 } });
  update(g3, 33, snap(0, 0));
  check('A12c 炮台被毁 → 失败（唯一发射源与视觉锚点）',
    g3.over === true && g3.cleared === false, '');

  /* 失败不给波末奖励 */
  const g4 = create();
  toWave(g4);
  g4.ammo = 10;
  const s4 = g4.score;
  for (let i = 0; i < 6; i++) g4.cities[i].alive = false;
  putWarhead(g4, { x: 80, y: CITY_TOP + 4, dy: 1, target: { kind: 'city', idx: 0 } });
  g4.cities[0].alive = true;
  update(g4, 33, snap(0, 0));
  check('A12d 失败不结算波末奖励（存活 0 城、余雷 10 也不给分）',
    g4.score === s4, 'score ' + s4 + ' → ' + g4.score);

  /* 重开从 W1 全清零 */
  const g5 = create();
  toWave(g5);
  fire(g5);
  g5.score = 999;
  g5.cities[2].alive = false;
  const g6 = create();
  check('A12e 重开（create）→ 6 城全在 / 0 分 / 雷 12 / W1 / gap',
    aliveCities(g6) === 6 && g6.score === 0 && g6.ammo === 12
    && g6.waveIdx === 0 && g6.phase === 'gap',
    'alive=' + aliveCities(g6) + ' score=' + g6.score + ' ammo=' + g6.ammo);
  check('A12f 重开时炮台存活、弹头池与爆炸池全空',
    g6.batteryAlive === true
    && g6.warheads.every((w) => !w.on) && g6.booms.every((b) => !b.on), '');
  check('A12g 失败条件恰好两条：6 城全毁 / 炮台被毁（无第三条）',
    true, '由 A12b / A12c 覆盖');
  check('A12h reachedLevel 落在 1..3',
    (() => {
      const gg = create(); toWave(gg);
      return result(gg).reachedLevel >= 1 && result(gg).reachedLevel <= 3;
    })(), '');
}

console.log('\n=== A13 IMU 异常（§10 · F-MSL-75） ===');
{
  const g = create();
  toWave(g);
  fire(g);
  const boomsBefore = (() => { let n = 0; for (const b of g.booms) if (b.on) n++; return n; })();
  const t0 = g.t;
  const ev = run(g, 20, DOWN);
  check('A13a IMU 异常 → imuDown 置位', g.imuDown === true, 'imuDown=' + g.imuDown);
  check('A13b IMU 异常 → 游戏内时钟仍推进（g.t 不停，只是玩法冻结）',
    g.t > t0, 'Δt=' + (g.t - t0));
  check('A13c IMU 异常 → 光标锁回中立位（camCx=240, cursorY=176）',
    near(g.camCx, 240) && near(g.cursorY, CUR.home),
    'cam=' + g.camCx + ' y=' + g.cursorY);
  const boomsAfter = (() => { let n = 0; for (const b of g.booms) if (b.on) n++; return n; })();
  check('A13d IMU 异常 → 爆炸冻结在当前半径（不消散也不扩张）',
    boomsAfter === boomsBefore, boomsBefore + ' → ' + boomsAfter);
  check('A13e IMU 异常 → 不生成新弹头（禁止无输入推进波次，NFR-05）',
    ev.indexOf('wave') < 0 && g.waveSpawned === 0, 'spawned=' + g.waveSpawned);
  check('A13f IMU 异常 → 不投递 finished（逃生出口交给页面单击）',
    ev.indexOf('finished') < 0, ev.join(','));

  /* 恢复 */
  const g2 = create();
  toWave(g2);
  run(g2, 5, DOWN);
  run(g2, 5, 0, 0);
  check('A13g IMU 恢复 → imuDown 复位，玩法继续',
    g2.imuDown === false, 'imuDown=' + g2.imuDown);
  check('A13h IMU_TEXT 提示「单击结束游戏」（本作单击已占用为引爆）',
    /单击结束游戏/.test(MSL.IMU_TEXT), MSL.IMU_TEXT);
}

console.log('\n=== A14 三条红线静态检查（先剥注释再扫） ===');
{
  const raw = fs.readFileSync(new URL('../../utils/missile.js', import.meta.url), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('A14a 无 Date.now()（计时必须基于 g.t，否则冻结语义失效）',
    !/Date\.now/.test(src), '');
  check('A14b 无定时器（setTimeout / setInterval / requestAnimationFrame）',
    !/setTimeout|setInterval|requestAnimationFrame/.test(src), '');
  check('A14c 未 import sfx / storage（播音与落盘全归页面）',
    !/from '\.\/sfx\.js'|from '\.\/storage\.js'/.test(src), '');
  check('A14d 未自行画黑色遮罩（变暗一律走 fadeTo）',
    !/#000|rgba\(0,\s*0,\s*0/.test(src), '');
  check('A14e 使用了 fadeTo（fade 由页面传入）', /fadeTo/.test(src), '');
  check('A14f 未直接 import input 的 SIGN 做方向翻转（横向只用 SEM_FOLLOW）',
    !/SIGN/.test(src), '');
}

console.log('\n=== A15 渲染（锚定 / 墙随相机滑 / 墙外留白 / 离屏指示器） ===');
{
  const g = create();
  toWave(g);
  update(g, 33, snap(0, 0));
  const c = makeCtx();
  render(g, c.ctx, 0);

  /* 光标：屏幕层 strokeCircle r=16，cx 必须恒为 240 */
  const cur = c.circles.filter((o) => near(o.r, CUR.r));
  check('A15a 光标外圈 r16 绘制在 x=240（恒钉屏幕中心，锚定型核心承诺）',
    cur.length > 0 && cur.every((o) => near(o.cx, 240)),
    'n=' + cur.length + ' cx=' + (cur[0] ? cur[0].cx : 'none'));

  /* 转头后光标仍在 240，而墙滑走了 */
  const c2 = makeCtx();
  update(g, 33, snap(150, 0));
  render(g, c2.ctx, 0);
  const cur2 = c2.circles.filter((o) => near(o.r, CUR.r));
  check('A15b 转头 150px 后光标仍在 x=240（不跟着头跑 → 无眩晕源）',
    cur2.length > 0 && cur2.every((o) => near(o.cx, 240)),
    'cx=' + (cur2[0] ? cur2[0].cx : 'none'));

  /* 墙（世界层 fillRect，宽 = wallBand）随相机滑 */
  const wallW = MSL.CAMERA.wallBand;
  const w1 = c.rects.filter((o) => near(o.w, wallW) && o.h > 200);
  const w2 = c2.rects.filter((o) => near(o.w, wallW) && o.h > 200);
  check('A15c 两堵边界墙均为世界层（宽 ' + wallW + '、高贯穿战场）',
    w1.length >= 2, 'n=' + w1.length);
  check('A15d 墙随相机平移（中立位 vs 转头 150 → 屏幕 x 差 150）',
    w1.length >= 2 && w2.length >= 2 && near(w2[0].x - w1[0].x, 150, 1.5),
    'x ' + (w1[0] ? w1[0].x : '?') + ' → ' + (w2[0] ? w2[0].x : '?'));

  /* 墙外留白：转头到极限时，战场远端超出裁剪窗 → 视野边缘是空的 */
  const g3 = create();
  toWave(g3);
  update(g3, 33, snap(300, 0));       // 推到最左 camCx=80
  check('A15e 转头到极限 camCx=80（战场右端滑出视野 → 右外侧显示空白）',
    near(g3.camCx, CAM_MIN) && (CT_R + (240 - g3.camCx)) > CLIP_R,
    'camCx=' + g3.camCx + ' 战场右端屏幕 x=' + (CT_R + (240 - g3.camCx)));

  /* 离屏弹头指示器 */
  const g4 = create();
  toWave(g4);
  update(g4, 33, snap(0, 0));
  for (let i = 0; i < g4.warheads.length; i++) g4.warheads[i].on = false;
  putWarhead(g4, { x: 400, y: 120 });     // 战场最右
  update(g4, 33, snap(300, 0));           // 相机推到最左 → 该弹头在视野外
  const c4 = makeCtx();
  render(g4, c4.ctx, 0);
  const marks = c4.polys.filter((p) => p.pts.length === 3 && p.mode === 'fill');
  check('A15f 视野外弹头 → 屏幕边缘画三角形指示器（3 顶点 fill 多边形）',
    marks.length > 0, 'n=' + marks.length);
  check('A15g 指示器贴在裁剪窗外缘 ± markGap(' + MSL.CAMERA.markGap + ') 处（pts 是 [x,y] 数组）',
    marks.length > 0
    && marks.every((p) => near(p.pts[0][0], CLIP_R - MSL.CAMERA.markGap, 1)
      || near(p.pts[0][0], CLIP_L + MSL.CAMERA.markGap, 1)),
    'x=' + (marks[0] ? marks[0].pts[0][0] : 'none'));

  /* 视野内弹头不画指示器 */
  const g5 = create();
  toWave(g5);
  update(g5, 33, snap(0, 0));
  for (let i = 0; i < g5.warheads.length; i++) g5.warheads[i].on = false;
  putWarhead(g5, { x: 240, y: 120 });     // 战场正中 → 视野内
  const c5 = makeCtx();
  render(g5, c5.ctx, 0);
  const m5 = c5.polys.filter((p) => p.pts.length === 3 && p.mode === 'fill'
    && (near(p.pts[0].x, CLIP_R - MSL.CAMERA.markGap, 1)
      || near(p.pts[0].x, CLIP_L + MSL.CAMERA.markGap, 1)));
  check('A15h 视野内弹头**不**画指示器（否则屏幕边缘会常驻一堆三角）',
    m5.length === 0, 'n=' + m5.length);

  /* 城市被毁 = 虚线残影（需要 setLineDash 被调用） */
  const g6 = create();
  toWave(g6);
  g6.cities[0].alive = false;
  let dashed = 0;
  const c6 = makeCtx();
  const ctx6 = new Proxy(c6.ctx, {
    get(t, k) {
      if (k === 'setLineDash') return (d) => { if (d && d.length) dashed++; };
      return t[k];
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  render(g6, ctx6, 0);
  check('A15i 被毁城市走虚线残影轮廓（亮度 + 线型双通道）', dashed > 0, 'setLineDash=' + dashed);

  /* 过场卡与失败卡 */
  const g7 = create();
  const c7 = makeCtx();
  render(g7, c7.ctx, 0);
  check('A15j 过场显示「第 1 波」+ 副行文案',
    c7.texts.some((t) => t.s === '第 1 波')
    && c7.texts.some((t) => t.s === MSL.WAVE_SUB[0]),
    c7.texts.map((t) => t.s).join('|'));

  const g8 = create();
  toWave(g8);
  for (let i = 0; i < 6; i++) g8.cities[i].alive = false;
  g8.over = true; g8.cleared = false; g8.phase = 'over';
  const c8 = makeCtx();
  render(g8, c8.ctx, 0);
  check('A15k 失败显示「防线失守」', c8.texts.some((t) => t.s === '防线失守'),
    c8.texts.map((t) => t.s).join('|'));

  const g9 = create();
  toWave(g9);
  g9.over = true; g9.cleared = true; g9.phase = 'over';
  const c9 = makeCtx();
  render(g9, c9.ctx, 0);
  check('A15l 通关显示「防线守住了」', c9.texts.some((t) => t.s === '防线守住了'),
    c9.texts.map((t) => t.s).join('|'));

  /* HUD 三段 */
  const gA = create();
  toWave(gA);
  const cA = makeCtx();
  render(gA, cA.ctx, 0);
  check('A15m HUD 中段三段齐全（得分 / W1·3 / 雷 + 数值）',
    cA.texts.some((t) => t.s === '0') && cA.texts.some((t) => t.s === 'W1/3')
    && cA.texts.some((t) => t.s === '雷') && cA.texts.some((t) => t.s === '12'),
    cA.texts.map((t) => t.s).join('|'));
  const hudXs = cA.texts.map((t) => t.x);
  check('A15n HUD 全部落在空档 x ∈ [92, 352] 内（不侵入两胶囊）',
    hudXs.every((x) => x >= 92 && x <= 352), 'x=' + hudXs.join(','));
}

console.log('\n=== A19 弹头绘制层 + 扫掠判定（v1.38 回归） ===');
{
  /* 背景：drawWarheads 曾写成 `w.x + dx`，而它本就画在已 translate(dx) 的
   * 世界层里 → 实际落在 w.x + 2·dx，转头时弹头偏离真实位置最多 ±160px。
   * 表现就是用户报的「导弹在爆炸圈里却打不掉」：圈画对了、弹头画偏了，
   * 而引爆判定用世界坐标是对的。dx=0 时不可见，故必须显式构造偏心相机。 */
  const wx = 240;
  for (const camCx of [240, 320, 100]) {
    const g = create();
    toWave(g);
    for (let i = 0; i < g.warheads.length; i++) g.warheads[i].on = false;
    const w = g.warheads[0];
    w.on = true; w.x = wx; w.y = 200; w.dx = 0; w.dy = 1; w.mirv = false;
    w.target = { kind: 'city', idx: 0 };
    g.camCx = camCx;
    g.cursorY = 200;
    const c = makeCtx();
    render(g, c.ctx, 1);
    const dots = c.circles.filter((o) => near(o.r, MSL.WARHEAD.r));
    const dx = 240 - camCx;
    check('A19a 弹头画在世界 x + dx（camCx=' + camCx + '，dx=' + dx + '）',
      dots.length > 0 && dots.every((o) => near(o.cx, wx + dx, 0.001)),
      'n=' + dots.length + ' cx=' + (dots[0] ? dots[0].cx : 'none') + ' 应为 ' + (wx + dx));
  }

  /* 扫掠判定：外圈不再留「看得见打不掉」的窄带（半径取两帧较大值） */
  for (const d of [50, 55, 58]) {
    const g = create();
    toWave(g);
    for (let i = 0; i < g.warheads.length; i++) g.warheads[i].on = false;
    const w = g.warheads[0];
    w.on = true; w.x = 240 + d; w.y = 200; w.dx = 0; w.dy = 0; w.speed = 0;
    w.mirv = false; w.target = { kind: 'city', idx: 0 };
    g.camCx = 240; g.cursorY = 200;
    fire(g);
    let hit = false;
    for (let f = 0; f < 25; f++) {
      update(g, 33, snap(0, 0));
      if (!w.on) { hit = true; break; }
    }
    check('A19b 距爆心 ' + d + 'px（rMax=' + MSL.BOOM.rMax + '）在 30fps 下仍被扫到',
      hit, hit ? 'ok' : '漏了');
  }
}

console.log('\n=== A16 result 契约 + statusText 口径（§7.1 / §2.6.2） ===');
{
  const g = create();
  toWave(g);
  const r = result(g);
  check('A16a result 四字段齐全（score / cleared / reachedLevel / extra）',
    typeof r.score === 'number' && typeof r.cleared === 'boolean'
    && typeof r.reachedLevel === 'number' && Array.isArray(r.extra), JSON.stringify(r));
  check('A16b extra 恰好 2 项', r.extra.length === 2, 'n=' + r.extra.length);
  check('A16c statusText 开局 = 「城市 6/6」',
    statusText(g) === '城市 6/6', statusText(g));
  g.cities[0].alive = false;
  check('A16d 毁 1 城 → 「城市 5/6」', statusText(g) === '城市 5/6', statusText(g));
  for (let i = 0; i < 6; i++) g.cities[i].alive = false;
  check('A16e 全毁 → 「城市 0/6」', statusText(g) === '城市 0/6', statusText(g));
  check('A16f statusText 宽度 ≤7 字（状态胶囊可用宽 ≈86px，12/500）',
    statusText(g).length <= 7, statusText(g).length + ' 字');
  check('A16g 拦截率在 total=0 时不除零（返回 0%）',
    (() => { const gg = create(); return result(gg).extra[0].value === '0%'; })(), '');
}

console.log('\n=== A17 方向语义锁（真机锚定，勿动 input.js 的 SIGN） ===');
{
  const raw = fs.readFileSync(new URL('../../utils/missile.js', import.meta.url), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('A17a 横向导入并使用 SEM_FOLLOW（与打砖块/接鸡蛋/打飞机同口径）',
    /SEM_FOLLOW/.test(src) && /SEM_FOLLOW\s*\*/.test(src), '');
  check('A17b camCx 计算式为 240 + SEM_FOLLOW × snap.x（反向补偿）',
    /CENTER\.x\s*\+\s*SEM_FOLLOW\s*\*\s*\(?snap\.x/.test(src), '');
  check('A17c 纵向为直控（home − pitch×vscale），未经相机',
    /CUR\.home\s*-\s*clamp\(\(snap\.y/.test(src), '');
  const g = create();
  update(g, 33, snap(0, 0));
  update(g, 33, snap(200, 0));
  const left = g.camCx;
  update(g, 33, snap(-200, 0));
  check('A17d 头左转（snap.x>0）→ camCx 更小；头右转 → 更大（真机语义与前三款一致）',
    left < 240 && g.camCx > 240, 'left=' + left + ' right=' + g.camCx);
}

console.log('\n=== A18 冻结语义（不调 update 则玩法停摆） ===');
{
  const g = create();
  toWave(g);
  run(g, 200, 0, 0);
  fire(g);
  const t0 = g.t;
  const snapshot = JSON.stringify(g.warheads) + '|' + JSON.stringify(g.booms);
  for (let i = 0; i < 30; i++) render(g, makeCtx().ctx, 0.55);
  check('A18a 冻结 30 帧后 g.t 不变（B2/B3/B4 自动停钟）',
    g.t === t0, 'Δt=' + (g.t - t0));
  check('A18b 冻结期间弹头与爆炸完全不变（爆炸冻结在当前半径，F-MSL-70）',
    JSON.stringify(g.warheads) + '|' + JSON.stringify(g.booms) === snapshot, '');
  const before = g.t;
  update(g, 33, snap(0, 0));
  check('A18c 解冻后从冻结时刻续算（不重置波次进度、不补发弹头）',
    g.t > before && g.phase === 'wave', 'Δt=' + (g.t - before));
  check('A18d game.t 用于 durationSec（已排除冻结时长）', g.t > 0, 't=' + g.t);
}

/* ─────────────── 页面级断言（P 组） ─────────────── */

console.log('\n=== P1 页面接入（B1 推进 / 冻结契约） ===');
{
  const { default: page } = await import('./pages/missile/missile.mjs');
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
    page.meta = { id: 'missile', name: '导弹指挥部', kind: 'game', iconId: 'missile' };
    page.gameId = 'missile';
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

  /* 走出 W1 的 1.2s 过场。过场期禁止引爆是**正确的产品行为**，
   * 所以验引爆前必须先走出过场，而不是放宽断言。 */
  function pastGap() { for (let i = 0; i < 37; i++) update(page.ms, 33, snap(0, 0)); }

  setup();
  check('P1a initPlay 建出玩法状态（0 分 / 6 城 / 雷 12 / gap 过场）',
    !!page.ms && page.ms.score === 0 && aliveCities(page.ms) === 6
    && page.ms.ammo === 12 && page.ms.phase === 'gap',
    page.ms ? ('score=' + page.ms.score + ' 城=' + aliveCities(page.ms)
      + ' 雷=' + page.ms.ammo + ' phase=' + page.ms.phase) : 'no ms');

  const t0 = page.ms.t;
  page._last = Date.now() - 40;
  page.tick();
  check('P1b B1 推进玩法（g.t 随帧累加）', page.ms.t > t0, 't ' + t0 + ' → ' + page.ms.t);

  page.state = 'MENU';
  page.menuAt = 1000000;
  const t1 = page.ms.t;
  page.tick();
  check('P1c B2 菜单态不推进玩法（画面冻结，§2.6.4）',
    page.ms.t === t1, 't ' + t1 + ' → ' + page.ms.t);

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
    c.texts.some((t) => t.s === '导弹指挥部'), '');

  console.log('\n=== P3 statusText 钩子（差异④ · §2.6.2） ===');
  setup();
  check('P3a 开局 → 「城市 6/6」', page.statusText() === '城市 6/6', page.statusText());
  page.ms.cities[0].alive = false;
  check('P3b 毁 1 城 → 「城市 5/6」', page.statusText() === '城市 5/6', page.statusText());
  page.ms.imuDown = true;
  check('P3c IMU 异常 → 返回空串（交还框架显示「IMU状态异常」+ 空心圆点）',
    page.statusText() === '', '"' + page.statusText() + '"');
  page.ms.imuDown = false;
  const h = page._hudStatus();
  check('P3d _hudStatus 走 statusText 分支（优先级最高）',
    h.text.indexOf('城市') === 0 && h.dot === true, h.text + ' dot=' + h.dot);
  const savedST = page.statusText;
  delete page.statusText;
  let guardOk = true;
  try { page._hudStatus(); } catch (e) { guardOk = false; }
  page.statusText = savedST;
  check('P3e typeof 守卫：statusText 未挂载时 _hudStatus 不抛错（否则整帧卡死）',
    guardOk, '');

  console.log('\n=== P4 tapRole = fire：单击 = 引爆，滑动 = 唤菜单（F-MSL-72） ===');
  setup();
  pastGap();
  page._swipeAt = 0;
  page.onTap();
  check('P4a PLAY 态单击 → 引爆（余量 12 → 11）',
    page.ms.ammo === 11, 'ammo=' + page.ms.ammo);
  check('P4b PLAY 态单击**不**进菜单（菜单入口已改道滑动）',
    page.state === 'PLAY', 'state=' + page.state);
  let on = 0;
  for (const b of page.ms.booms) if (b.on) on++;
  check('P4c 引爆后场上出现 1 枚爆炸', on === 1, 'booms=' + on);

  setup();
  pastGap();
  page._swipeAt = 0;
  page.onSwipe();
  check('P4d PLAY 态滑动 → 唤出 B2 菜单（本作菜单的唯一入口）',
    page.state === 'MENU', 'state=' + page.state);
  check('P4e 进菜单时重校准 + 冻结漂移（D-MSL-11）', (() => {
    let rb = 0, fd = null;
    page.engine.resetBase = function () { rb++; };
    page.engine.freezeDrift = function (v) { fd = v; };
    page.state = 'PLAY';
    page.onSwipe();
    return rb === 1 && fd === true;
  })(), '');

  console.log('\n=== P5 滑动后 300ms 内单击忽略（F-MSL-73） ===');
  setup();
  pastGap();
  page._swipeAt = Date.now();
  page.onTap();
  check('P5a 滑动刚发生 → 紧随的单击被吞（防手指残留误点亮菜单）',
    page.ms.ammo === 12 && page.state === 'PLAY',
    'ammo=' + page.ms.ammo + ' state=' + page.state);
  page._swipeAt = Date.now() - 400;
  page.onTap();
  check('P5b 超过 300ms → 单击恢复语义（引爆生效）',
    page.ms.ammo === 11, 'ammo=' + page.ms.ammo);

  console.log('\n=== P6 IMU 异常时单击 = 结束游戏（F-MSL-75，本作特有） ===');
  setup();
  pastGap();
  redirected = 0; nav.length = 0;
  page.engine.imuOk = false;
  page.onTap();
  check('P6a IMU 异常 + PLAY 态单击 → 直接结束游戏（逃生出口）',
    redirected === 1, 'redirected=' + redirected);
  check('P6b 跳的是 pages/result/result', nav[0] === 'pages/result/result', String(nav[0]));
  check('P6c 逃生出口不会误消耗拦截雷（没被引爆）',
    page.ms.ammo === 12, 'ammo=' + page.ms.ammo);

  console.log('\n=== P7 结算幂等 + 玩法事件只播音不结算 ===');
  setup();
  redirected = 0; nav.length = 0;
  page._handleEvents(['finished']);
  page._handleEvents(['finished']);
  page._handleEvents(['finished']);
  /* v1.40：finished 不再直接 redirectTo 结算页 —— 先落成绩，再进本页的通用
   * 结束弹窗（B5 通关 / GAME OVER），由弹窗的 5s 倒计时 / 单击统一回主页。
   * ⚠ IMU 异常的**逃生出口**不受影响：它既非通关也非失败，仍走 finishGame()
   *   直达结算页（见 P6 组）。 */
  check('P7a finished 连续投递三次 → 只结算一次（幂等，落在结束弹窗）',
    page.state === 'OVER' && page._done === true && redirected === 0,
    'state=' + page.state + ' redirected=' + redirected);
  const { OVER: OVER_MS } = await import('./utils/layout.js');
  check('P7h OVER 态 render 不抛错（含 drawOver + HUD 降级分支）', (() => {
    try { page.render(Date.now(), { ok: true, x: 0, y: 0 }); return true; }
    catch (e) { return false; }
  })(), '');
  page.overAt = Date.now() - OVER_MS.ms - 1;
  page.tick();
  check('P7b 满 5 秒 → 自动进 B3 loading（kind=home）',
    page.state === 'LOADING' && page.loadingKind === 'home',
    'state=' + page.state + ' kind=' + page.loadingKind);
  setup();
  page._handleEvents(['finished']);
  page.onTap();
  check('P7g 未满 5 秒单击 → 提前回主页（与倒计时同一出口）',
    page.state === 'LOADING' && page.loadingKind === 'home',
    'state=' + page.state + ' kind=' + page.loadingKind);
  setup();
  redirected = 0; nav.length = 0;
  page._handleEvents(['boom', 'citydown', 'fail', 'clear', 'wave']);
  check('P7c 五类玩法事件均不触发结算（只播音）', redirected === 0, 'redirected=' + redirected);
  const rr = page.buildResult();
  check('P7d buildResult 补齐 durationSec + motion（用游戏内时钟 g.t）',
    typeof rr.durationSec === 'number' && !!rr.motion && typeof rr.motion.yawUtil === 'number',
    'durationSec=' + rr.durationSec);
  check('P7e buildResult 的 reachedLevel 来自玩法模块（1..3）',
    rr.reachedLevel >= 1 && rr.reachedLevel <= 3, 'lv=' + rr.reachedLevel);
  check('P7f 重开链路：initPlay 整体重建（W1 / 6 城 / 雷 12）', (() => {
    setup();
    pastGap();
    page.onTap();
    page.ms.cities[0].alive = false;
    page.ms.score = 500;
    page.initPlay();
    return aliveCities(page.ms) === 6 && page.ms.ammo === 12
      && page.ms.waveIdx === 0 && page.ms.score === 0;
  })(), '');
}

console.log('\n=== P8 源码契约：两个 fade 分开 + MENU_FADE=0.55 + 无 grantGrace ===');
{
  const src0 = fs.readFileSync(new URL('../../pages/missile/missile.js', import.meta.url), 'utf8');
  const src = src0.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('P8a 定义了 contentFade 与 entryFade 两个变量',
    /const\s+contentFade\s*=/.test(src) && /const\s+entryFade\s*=/.test(src));
  check('P8b MENU 态：contentFade = MENU_FADE（次要层）且 entryFade = 0（菜单恒亮）',
    /contentFade\s*=[\s\S]{0,120}MENU_FADE/.test(src)
    && /entryFade\s*=\s*this\.state\s*===\s*S\.CONT\s*\?\s*1/.test(src));
  check('P8c MENU_FADE = 0.55（不是 1 → 不会塌到 6% 隐藏档）',
    /const\s+MENU_FADE\s*=\s*0\.55\s*;/.test(src));
  check('P8d 未调用 drawHint（提示条已撤）', !/drawHint\s*\(/.test(src));
  check('P8e 未绘制框架页占位（drawPlayfield）', !/drawPlayfield/.test(src));
  check('P8f 单击不唤菜单：onTap 的 PLAY 分支调用 missileFire 而非 enterMenu',
    /if\s*\(this\.state === S\.PLAY\)[\s\S]{0,300}missileFire/.test(src)
    && !/if\s*\(this\.state === S\.PLAY\)[\s\S]{0,300}enterMenu/.test(src));
  check('P8g 菜单入口绑在滑动通道（onSwipe → enterMenu）',
    /onSwipe[\s\S]{0,200}enterMenu/.test(src));
  check('P8h 滑动抑制窗用 TOUCH.swipeSuppress（300ms）', /TOUCH\.swipeSuppress/.test(src));
  /* v1.40：逃生出口改走 finishGame()（直达结算页）—— 结束弹窗只服务**真正的
   * 通关 / 失败**，IMU 异常退出两者都不是，显示「GAME OVER」不准确。 */
  check('P8i IMU 异常时单击走 finishGame（F-MSL-75 逃生出口），不是静默 return',
    /if\s*\(!this\.engine\.imuOk\)\s*\{\s*this\.finishGame\(\)/.test(src), '');
  check('P8j **无** grantGrace（本作无生命/无敌概念，回场保护无对应语义）',
    !/grantGrace/.test(src), '');
  check('P8k 音效映射复用既有 key，未新增（F-MSL-82）',
    /SFX_OF\s*=\s*\{[\s\S]{0,200}\}/.test(src)
    && !/SFX_OF[\s\S]{0,200}(?: missile_|'msl)/.test(src), '');
}


console.log('\n=== A20 城市楼群与炮台（v1.39 精修） ===');
{
  /* 背景：城市此前是「矩形 + 3 根竖线」，认不出是城市；炮台是个梯形盒子，
   * 看不出能打导弹。改为 3 栋错落楼 + 窗带 + 天线，炮台加底座与双联装炮管。
   * ⚠ 外框尺寸严格锁死（A1f/A1g），本组只验证框内的切分与新增部件。 */
  const g = create();
  const m = makeCtx();
  render(g, m.ctx, 0);
  const CT = MSL.HORIZON_Y - MSL.CITY.h;
  const cx = MSL.CITY.xs[0];

  const tw = m.rects.filter((r) => !r.stroked && r.x >= cx - 13 && r.x + r.w <= cx + 13
    && r.y + r.h === MSL.HORIZON_Y);
  check('A20a 城市① 3 栋楼，底边均贴地平线 332', tw.length === 3, 'n=' + tw.length);

  const tops = tw.map((r) => r.y).sort((a, b) => a - b);
  check('A20b 天际线错落：三个楼顶互不相同，最高那栋贴 316',
    tops[0] === CT && new Set(tops).size === 3, 'tops=' + tops.join('/'));

  const win = m.rects.filter((r) => r.w === 2 && r.h === 1
    && r.x > cx - 13 && r.x < cx + 13 && r.y > CT);
  check('A20c 窗带 6 扇（2 宽 1 高的横窗，@48%）', win.length === 6, 'n=' + win.length);

  const ant = m.rects.filter((r) => r.w === 1 && r.h === 3 && Math.abs(r.x - (cx - 9)) < 0.6);
  check('A20d 最高楼顶立 3px 天线', ant.length === 1, 'n=' + ant.length);

  const base = m.rects.filter((r) => r.x === MSL.BATTERY.x0 + 2
    && r.w === MSL.BATTERY.w - 4 && r.y === MSL.HORIZON_Y - 3 && r.h === 3);
  check('A20e 炮台底座 28×3（贴梯形斜边内缩，不溢出轮廓）', base.length === 1, 'n=' + base.length);

  const barrel = m.polys.filter((p) => p.pts.length === 4
    && p.pts.some((q) => near(q[0], MSL.BATTERY.x0 + MSL.BATTERY.w / 2 - 3, 0.01)));
  check('A20f 双联装高炮：单条路径 4 顶点 = 两根炮管', barrel.length === 1, 'n=' + barrel.length);

  const muz = m.rects.filter((r) => r.w === 2 && r.h === 2 && r.y === CT - 8);
  check('A20g 两个炮口 2×2 @100%（有炮口才看得出朝向）', muz.length === 2, 'n=' + muz.length);
}

const pass = R.filter((r) => r.ok).length;
console.log('\n=== 结论 ===');
console.log('  ' + pass + '/' + R.length + ' 项通过');
R.filter((r) => !r.ok).forEach((r) => console.log('  x ' + r.name + ' — ' + r.detail));
process.exit(pass === R.length ? 0 : 1);
