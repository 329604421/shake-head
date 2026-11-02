/* harness-ready.mjs —— 游玩提示弹窗（S.READY · v1.52）行为回归
 *
 * 为什么单独一套：这是**跨五款游戏的第六个页面状态**，由 utils/gamepage.js
 * 统一实现、五个页面各接三行。它同时踩三条既有红线：
 *   ① 状态机（新增态不能破坏 MENU/CONT/LOADING/OVER 的既有出入边）；
 *   ② 渲染分层（模态弹窗 ⇒ 内容 6% 隐藏档 + HUD 48%）；
 *   ③ IMU 基准时机（"启动监控"必须落在 resetBase，而不是 start）。
 * 任一游戏页的 harness 都只覆盖自己那款的玩法，谁也不会管这个公共态。
 *
 * 覆盖：
 *   A 组 源码静态：gamepage 五件套 + 五页各三处接入（onTap/tick/render）
 *   B 组 文案：games.js 五款 brief / ops（字数、行数、折行后不溢出）
 *   C 组 状态机：建局即弹 / 不推进玩法 / 不自动关 / 单击武装 / 3s 开跑
 *   D 组 重开：LOADING restart 之后同样落 READY
 *   E 组 渲染：三块内容 + 底部倒计时 + HUD 降级 + 入场淡入
 *   F 组 wrapText 纯函数：折行宽度、标点不落行首、不丢字
 *   G 组 不回归：PLAY/OVER 态的单击分流未被 READY 分支吃掉
 *
 * 运行：cd tests/navsim && node build.mjs && node harness-ready.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

let pass = 0;
let fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name + (detail ? '  — ' + detail : '')); }
  else { fail += 1; console.log('  [FAIL] ' + name + (detail ? '  — ' + detail : '')); }
}
function eq(a, b, name) {
  ok(a === b, name, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));
}
function strip(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}
function srcOf(rel) {
  return strip(fs.readFileSync(path.join(root, rel), 'utf8'));
}

const GP = srcOf('utils/gamepage.js');
const LAY = srcOf('utils/layout.js');
const OVL = srcOf('utils/overlay.js');
const DRW = srcOf('utils/draw.js');
const GAMES = srcOf('utils/games.js');

const PAGES = [
  { id: 'bricks', dir: 'brick', file: 'brick', field: 'bk' },
  { id: 'egg', dir: 'eggcatch', file: 'eggcatch', field: 'eg' },
  { id: 'marble', dir: 'marble', file: 'marble', field: 'mb' },
  { id: 'missile', dir: 'missile', file: 'missile', field: 'ms' },
  { id: 'plane', dir: 'plane', file: 'plane', field: 'pl' },
];

/* ───────────────────── A 组：源码静态（底座 + 五页接入） ───────────────────── */
console.log('\n=== A 组：S.READY 在底座与五页的接入 ===');

ok(/READY:\s*'READY'/.test(GP), 'A1 S 枚举含 READY');
ok(/_\s*beginReady\s*\(/.test(GP) || /_beginReady\s*\(/.test(GP), 'A2 底座实现 _beginReady');
ok(/_readyTap\s*\(/.test(GP), 'A3 底座实现 _readyTap（单击武装）');
ok(/_tickReady\s*\(/.test(GP), 'A4 底座实现 _tickReady（倒计时到点）');
ok(/drawReady\s*\(ctx,\s*now\)/.test(GP), 'A5 底座实现 drawReady(ctx, now)');
ok(/_hudAlpha\s*\(/.test(GP), 'A6 底座实现 _hudAlpha');
ok(/initPlay\(\)\s*\{[\s\S]{0,400}this\._beginReady\(\)/.test(GP),
  'A7 initPlay 末尾调 _beginReady（开局/重开都弹，唯一出口）');
ok(/S\.OVER\s*\|\|\s*this\.state\s*===\s*S\.READY/.test(GP),
  'A8 _hudAlpha 同时覆盖 OVER 与 READY');
ok(/this\.engine\.resetBase\(\)/.test(GP),
  'A9 单击重建 IMU 基准走 resetBase（不是 start）');
ok(/this\.engine\.start\(\)/.test(GP),
  'A10 兜底：未起采时补 start（防宿主无定时器场景）');

for (let i = 0; i < PAGES.length; i += 1) {
  const p = PAGES[i];
  const s = srcOf('pages/' + p.dir + '/' + p.file + '.js');
  const tag = 'A1' + i + ' ' + p.id;
  ok(/this\.state === S\.READY\) \{ this\._readyTap\(\); return; \}/.test(s),
    tag + 'a onTap 首分支为 S.READY → _readyTap');
  ok(/this\._tickReady\(now\);/.test(s), tag + 'b tick 调 _tickReady');
  ok(/this\.drawReady\(ctx, now\);/.test(s), tag + 'c render 调 drawReady');
  ok(/this\._hudAlpha\(\)/.test(s), tag + 'd HUD 亮度走 _hudAlpha');
  ok(/this\.state === S\.READY \? 1/.test(s), tag + 'e contentFade 在 READY 取 1（6% 隐藏档）');
}

ok(/export function drawReady\(/.test(OVL), 'A20 overlay 导出 drawReady');
ok(/wrapText\(/.test(OVL), 'A21 弹窗用 wrapText 折行（长说明不溢出）');
ok(/export function wrapText\(/.test(DRW), 'A22 draw 导出 wrapText');

const mPanel = LAY.match(/READY = \{[\s\S]*?panel: \{ x: (\d+), y: (\d+), w: (\d+), h: (\d+) \}/);
ok(!!mPanel, 'A23 layout 定义 READY.panel');
if (mPanel) {
  const x = +mPanel[1], y = +mPanel[2], w = +mPanel[3], h = +mPanel[4];
  ok(x >= 16 && x + w <= 464, 'A24 面板横向不越安全区', x + '~' + (x + w));
  ok(y >= 44 && y + h <= 340, 'A25 面板纵向落在画面区内', y + '~' + (y + h));
  ok(w > 288 && h > 144, 'A26 比结束弹窗（288×144）更大', w + '×' + h);
}
const mMs = LAY.match(/READY = \{[\s\S]*?ms: (\d+)/);
eq(mMs ? +mMs[1] : -1, 3000, 'A27 倒计时 3000ms');
ok(LAY.indexOf('调整好头部位置，单击触控开始') >= 0, 'A28 未单击文案');
ok(LAY.indexOf('准备开始 · ') >= 0, 'A29 单击后文案前缀（倒计时接在其后）');

/* ───────────────────── B 组：五款文案 ───────────────────── */
console.log('\n=== B 组：games.js 五款 brief / ops ===');

const { ENTRIES, getEntry } = await import('./utils/games.js');
const { READY } = await import('./utils/layout.js');
const { wrapText } = await import('./utils/draw.js');
const GAME_IDS = ['bricks', 'egg', 'marble', 'missile', 'plane'];
const measureCtx = { measureText: function () { return { width: 0 }; } };

for (let i = 0; i < GAME_IDS.length; i += 1) {
  const e = getEntry(GAME_IDS[i]);
  const tag = 'B' + i + ' ' + GAME_IDS[i];
  ok(!!e && !!e.brief, tag + 'a 有 brief');
  ok(!!e && e.brief.length <= 50, tag + 'b brief ≤50 字', e ? e.brief.length + ' 字' : '');
  ok(!!e && Array.isArray(e.ops) && e.ops.length > 0, tag + 'c 有 ops');
  ok(!!e && e.ops.length <= READY.opsMax, tag + 'd ops ≤' + READY.opsMax + ' 行',
    e ? e.ops.length + ' 行' : '');
  let over = 0;
  for (let j = 0; j < (e ? e.ops.length : 0); j += 1) {
    if (e.ops[j].length > 29) over += 1;
  }
  ok(over === 0, tag + 'e 每行 ≤29 字（弹窗一行放得下）', 'over=' + over);
  ok(!!e && e.brief.indexOf('。') > 0, tag + 'f brief 是完整句（以句号收束）');
  /* 折行后不超过 3 行：用与真机同一套字宽估算（measureText 不可用时取估值） */
  const lines = wrapText(measureCtx, e.brief, { size: 12, weight: 400 },
    READY.panel.w - READY.padX * 2);
  ok(lines.length <= READY.briefMax, tag + 'g brief 折行 ≤' + READY.briefMax + ' 行',
    lines.length + ' 行');
  ok(lines.join('') === e.brief, tag + 'h 折行不丢字/不加字');
}

/* ───────────────────── C 组：状态机 ───────────────────── */
console.log('\n=== C 组：建局即弹 / 不推进 / 不自动关 / 单击 3s 开跑 ===');

function makeCtx() {
  const texts = [];
  const stack = [];
  let tx = 0;
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'fillText') return (s, x, y) => {
        texts.push({ s: String(s), x: x, y: y, style: t.fillStyle });
      };
      if (k === 'save') return () => { stack.push(tx); };
      if (k === 'restore') return () => { tx = stack.length ? stack.pop() : 0; };
      if (k === 'translate') return (dx) => { tx += dx || 0; };
      return k in t ? t[k] : function () {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  return { ctx: ctx, texts: texts };
}

function mkEngine() {
  const log = { freeze: [], resetBase: 0, recenter: 0, start: 0, stop: 0 };
  return {
    imuOk: true, running: true, log: log,
    update() { return { x: 0, y: 0 }; },
    snapshot() { return { x: 0, y: 0 }; },
    freezeDrift(f) { log.freeze.push(!!f); },
    recenter() { log.recenter += 1; },
    resetBase() { log.resetBase += 1; },
    start() { log.start += 1; this.running = true; },
    stop() { log.stop += 1; this.running = false; },
    stats: { toMotion() { return {}; } },
  };
}

async function setupPage(p) {
  const mod = await import('./pages/' + p.dir + '/' + p.file + '.mjs');
  const page = mod.default;
  const c = makeCtx();
  page.engine = mkEngine();
  page.gesture = { tick() {}, onKeyDown() {}, onKeyUp() {}, cancel() {} };
  page.meta = getEntry(p.id);
  page.gameId = p.id;
  page.menuItems = [];
  page.ctx = c.ctx;
  page.setData = function () {};
  page._lit = null;
  page._hidden = false;
  page._done = false;
  page.initPlay();
  return { page: page, c: c };
}

const EGG = PAGES[1];
const { page: pg, c: ec } = await setupPage(EGG);

eq(pg.state, 'READY', 'C1 建局后落在 READY（不是直接开跑）');
ok(pg.readyAt > 0, 'C2 记录进弹窗时刻（入场淡入用）');
eq(pg.armAt, 0, 'C3 未单击时 armAt=0');
ok(pg.engine.log.freeze.indexOf(true) >= 0, 'C4 进弹窗即冻结漂移（摆头不喂玩法）');
ok(pg.engine.log.recenter > 0, 'C5 进弹窗即 recenter（输出归零）');

const t0 = pg.eg.t;
pg._last = Date.now();
pg.tick(); pg.tick(); pg.tick();
eq(pg.eg.t, t0, 'C6 弹窗期不推进玩法（g.t 冻结，与 B2/B3/B4 同契约）');
eq(pg.state, 'READY', 'C7 弹窗不会自动关闭（无超时分支）');

/* 停留 10 秒仍不关：把 readyAt 往前拨 */
pg.readyAt = Date.now() - 10000;
pg._last = Date.now();
pg.tick();
eq(pg.state, 'READY', 'C8 停留 10s 仍不自动关闭（只有单击能武装）');
eq(pg.eg.t, t0, 'C9 长时间停留也不推进玩法');

const before = pg.engine.log.resetBase;
pg.onTap(0);
ok(pg.armAt > 0, 'C10 单击武装倒计时（armAt 落定）');
eq(pg.state, 'READY', 'C11 单击后仍在 READY（不是立刻开跑）');
eq(pg.engine.log.resetBase, before + 1, 'C12 单击以当前姿态重建 IMU 基准（resetBase）');
ok(pg.engine.log.freeze.indexOf(false) >= 0, 'C13 单击后解冻漂移');

const arm = pg.armAt;
pg._last = Date.now();
pg.tick();
eq(pg.state, 'READY', 'C14 未满 3s 不开跑');
pg.armAt = Date.now() - 2990;
pg._last = Date.now();
pg.tick();
eq(pg.state, 'READY', 'C15 2.99s 仍不开跑（边界）');
pg.armAt = Date.now() - 3000;
pg._last = Date.now();
pg.tick();
eq(pg.state, 'PLAY', 'C16 满 3s 开跑');

const t1 = pg.eg.t;
pg._last = Date.now() - 33;
pg.tick();
ok(pg.eg.t > t1, 'C17 进入 PLAY 后玩法恢复推进', t1 + ' → ' + pg.eg.t);

/* 连点不得把倒计时拉长 */
const pg2 = (await setupPage(EGG)).page;
pg2.onTap(0);
const a1 = pg2.armAt;
const rb1 = pg2.engine.log.resetBase;
pg2.onTap(0); pg2.onTap(0);
eq(pg2.armAt, a1, 'C18 倒计时期间连点不重置（不把 3s 无限拉长）');
eq(pg2.engine.log.resetBase, rb1, 'C19 连点不重复 resetBase');

/* 五款都要弹 */
for (let i = 0; i < PAGES.length; i += 1) {
  const r = await setupPage(PAGES[i]);
  ok(r.page.state === 'READY', 'C2' + i + ' ' + PAGES[i].id + ' 建局同样落 READY', r.page.state);
}

/* ───────────────────── D 组：重开也要弹 ───────────────────── */
console.log('\n=== D 组：重开（LOADING restart）同样落 READY ===');

{
  const r = await setupPage(EGG);
  const page = r.page;
  page.state = 'PLAY';
  page._beginLoading('restart', 'refresh', '重新游戏');
  page.loadingAt = Date.now() - 100000;   /* 已过 LOADING_MIN_MS */
  page._loadingDone = false;
  page._last = Date.now();
  page.tick();
  eq(page.state, 'READY', 'D1 重开后落 READY（不是直接开跑）');
  eq(page.eg.t, 0, 'D2 重开已重建玩法状态（g.t 归零）');
  ok(page.armAt === 0, 'D3 重开的弹窗同样要单击才启动');
}

/* ───────────────────── E 组：渲染 ───────────────────── */
console.log('\n=== E 组：三块内容 + 倒计时 + HUD 降级 ===');

{
  const r = await setupPage(EGG);
  const page = r.page;
  const c = r.c;
  const meta = getEntry('egg');
  const now = Date.now();
  page.readyAt = now - 500;               /* 已淡入完成 */

  c.texts.length = 0;
  page.render(now, { x: 0, y: 0 });
  const s = c.texts.map(function (t) { return t.s; });
  const has = function (str) { return s.indexOf(str) >= 0; };

  ok(has(READY.title), 'E1 绘制标题「游玩提示」');
  const bl = wrapText(c.ctx, meta.brief, { size: 12, weight: 400 },
    READY.panel.w - READY.padX * 2);
  ok(has(bl[0]), 'E2 绘制简要说明首行', bl[0]);
  ok(bl.length < 2 || has(bl[1]), 'E3 绘制简要说明第二行');
  ok(has(READY.opsLabel), 'E4 绘制「操作说明」小标签');
  let opsAll = true;
  for (let i = 0; i < meta.ops.length; i += 1) if (!has(meta.ops[i])) opsAll = false;
  ok(opsAll, 'E5 操作说明每行都上屏', meta.ops.length + ' 行');
  ok(has(READY.hint), 'E6 底部提示「' + READY.hint + '」');
  ok(!s.some(function (x) { return x.indexOf(READY.hintArmed) === 0; }),
    'E7 未单击时不显示倒计时');

  /* 单击后：底部文案换成带倒计时的版本 */
  page.armAt = now;
  c.texts.length = 0;
  page.render(now, { x: 0, y: 0 });
  let s2 = c.texts.map(function (t) { return t.s; });
  eq(s2.indexOf(READY.hintArmed + '3') >= 0, true, 'E8 单击后底部显示「准备开始 · 3」');
  eq(s2.indexOf(READY.hint) >= 0, false, 'E9 单击后不再显示「单击触控开始」');
  c.texts.length = 0;
  page.render(now + 1000, { x: 0, y: 0 });
  eq(c.texts.map(function (t) { return t.s; }).indexOf(READY.hintArmed + '2') >= 0, true,
    'E10 1s 后倒计时变 2');
  c.texts.length = 0;
  page.render(now + 2500, { x: 0, y: 0 });
  eq(c.texts.map(function (t) { return t.s; }).indexOf(READY.hintArmed + '1') >= 0, true,
    'E11 2.5s 后倒计时变 1（不会显示 0）');

  /* HUD 降级 + 弹窗开关 */
  const brand = function () {
    return c.texts.filter(function (t) { return t.s === meta.name; })[0];
  };
  c.texts.length = 0;
  page.render(now, { x: 0, y: 0 });
  ok(!!brand() && brand().style === 'rgba(64,255,94,0.48)',
    'E12 READY 期间 HUD 降到 48%（弹窗是模态的）', brand() ? brand().style : '?');
  page.state = 'PLAY';
  c.texts.length = 0;
  page.render(now, { x: 0, y: 0 });
  ok(!!brand() && brand().style === 'rgba(64,255,94,1)',
    'E13 PLAY 期间 HUD 恒亮', brand() ? brand().style : '?');

  /* 入场淡入：t=120ms → alpha 0.5 */
  page.state = 'READY';
  page.armAt = 0;
  page.readyAt = now - 120;
  c.texts.length = 0;
  page.render(now, { x: 0, y: 0 });
  const tt = c.texts.filter(function (t) { return t.s === READY.title; })[0];
  ok(!!tt && tt.style === 'rgba(64,255,94,0.5)', 'E14 入场淡入 120ms → alpha 0.5',
    tt ? tt.style : '?');
  page.readyAt = now;
  c.texts.length = 0;
  page.render(now, { x: 0, y: 0 });
  eq(c.texts.filter(function (t) { return t.s === READY.title; }).length, 0,
    'E15 t=0（alpha 0）不绘制（避免首帧闪一下满亮度）');

  /* 两个弹窗互斥 */
  page.readyAt = now - 500;
  ok(page.drawReady(c.ctx, now) === true, 'E16 READY 时 drawReady 返回 true');
  ok(page.drawOver(c.ctx, now) === false, 'E17 READY 时 drawOver 不画');
  page.state = 'OVER';
  page.overAt = now - 500;
  ok(page.drawReady(c.ctx, now) === false, 'E18 OVER 时 drawReady 不画');
  ok(page.drawOver(c.ctx, now) === true, 'E19 OVER 时 drawOver 返回 true');
}

/* ───────────────────── F 组：wrapText ───────────────────── */
console.log('\n=== F 组：wrapText 折行 ===');

{
  const o = { size: 12, weight: 400 };
  const w = wrapText(measureCtx, '左右转头', o, 356);
  eq(w.length, 1, 'F1 短串一行');
  const long = '球自动发射，挡板恒钉屏幕中央。左右转头平移画面去接球，击碎全部砖块即通关；漏球扣一条命，三条命用尽结束。';
  const wl = wrapText(measureCtx, long, o, 356);
  ok(wl.length > 1, 'F2 长串折成多行', wl.length + ' 行');
  let wide = 0;
  for (let i = 0; i < wl.length; i += 1) {
    if (wl[i].length * 12 * 0.99 > 356 + 12) wide += 1;   /* 允许收尾标点溢出 1 字 */
  }
  eq(wide, 0, 'F3 每行不超可用宽（收尾标点除外）');
  eq(wl.join(''), long, 'F4 折行不丢字');
  let head = 0;
  for (let i = 1; i < wl.length; i += 1) {
    if ('，。、；：？！'.indexOf(wl[i].charAt(0)) >= 0) head += 1;
  }
  eq(head, 0, 'F5 收尾标点不落行首');
  const we = wrapText(measureCtx, '', o, 356);
  eq(we.length, 1, 'F6 空串回落一行（不返回空数组）');
  const wr = wrapText(measureCtx, 'aaaaaaaaaa', o, 20);
  ok(wr.length > 1, 'F7 半角串同样折行（按估算宽 0.52×size）', wr.length + ' 行');
}

/* ───────────────────── G 组：不回归 ───────────────────── */
console.log('\n=== G 组：既有状态未被 READY 分支吃掉 ===');

{
  const r = await setupPage(EGG);
  const page = r.page;
  page.state = 'PLAY';
  page.onTap(0);
  eq(page.state, 'MENU', 'G1 PLAY 态单击仍唤出 B2 菜单');
  page.state = 'OVER';
  page.overAt = Date.now();
  page.onTap(0);
  eq(page.state, 'LOADING', 'G2 OVER 态单击仍走返回主页握手');
  page.state = 'MENU';
  eq(page._hudAlpha(), 1, 'G3 MENU 态 HUD 恒亮（只有模态弹窗降级）');
  page.state = 'CONT';
  eq(page._hudAlpha(), 1, 'G4 CONT 态 HUD 恒亮');
  page.state = 'OVER';
  eq(page._hudAlpha(), 0.48, 'G5 OVER 态 HUD 48%');
  page.state = 'READY';
  eq(page._hudAlpha(), 0.48, 'G6 READY 态 HUD 48%');
  page.state = 'READY';
  page.armAt = 0;
  page.onSwipe();
  eq(page.state, 'READY', 'G7 READY 期间滑动不唤菜单（onSwipe 只认 PLAY）');
}

console.log('\n========================================================');
console.log('harness-ready：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项');
process.exit(fail ? 1 : 0);
