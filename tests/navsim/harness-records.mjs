/* harness-records.mjs —— 战绩页（v1.50 精简版）行为回归
 *
 * 为什么单独一套：本页是**唯一**的「最近一局」数据源消费方，且数据源口径
 * 刚从 Top3 改成 last_（Top3 会丢掉没进前三的最近一局）。smoke-secondary
 * 只保证"能加载、不抛错"，一条业务语义都不覆盖。
 *
 * 覆盖：
 *   A 组 源码静态：五行 / 无滚动 / 一屏放下 / HUD 标题 / 提示文案
 *   B 组 数据：readLast 取最近一局（含"没进 Top3 也要在"）
 *   C 组 渲染：五款各一行、空档案「暂无记录」、不越界
 *   D 组 单击返回：对象形态 navigateBack + 落地判定 + 有限重试
 *   E 组 生命周期：无头控 ⇒ 进页停采；onHide 置落地标记
 *
 * 运行：cd tests/navsim && node build.mjs && node harness-records.mjs
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
function eq(actual, expect, name) {
  ok(actual === expect, name, 'got=' + JSON.stringify(actual) + ' want=' + JSON.stringify(expect));
}

/* 剥注释后再做静态扫描——注释里出现关键词会误伤断言（项目铁律） */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const SRC = fs.readFileSync(path.join(root, 'pages', 'records', 'records.js'), 'utf8');
const CODE = stripComments(SRC);

/* ───────────────────────── A 组：源码静态 ───────────────────────── */
console.log('\n=== A 组：五行一屏 / 无滚动 / 文案 ===');

ok(CODE.indexOf('ScrollList') < 0, 'A1 已移除滚动列表（ScrollList）');
ok(CODE.indexOf('SCROLL') < 0, 'A2 不再引用 SCROLL 几何常量');
ok(CODE.indexOf('readTop') < 0, 'A3 不再读 Top3（readTop）');
ok(CODE.indexOf('readLast') >= 0, 'A4 改读最近一局（readLast）');
ok(CODE.indexOf('GAME_IDS.length') >= 0 || CODE.indexOf('GAME_IDS') >= 0,
  'A5 按 GAME_IDS 逐游戏生成行（不是写死 5 行）');
ok(CODE.indexOf("drawHud(ctx, '战绩'") >= 0, 'A6 HUD 左上角为页名「战绩」');
ok(CODE.indexOf('单击触控回到主页') >= 0, 'A7 提示条为「单击触控回到主页」');
ok(CODE.indexOf("wx.navigateBack({") >= 0 && CODE.indexOf('delta: 1') >= 0,
  'A8 返回走对象形态 navigateBack（带 delta）');
ok(CODE.indexOf('wx.navigateBack();') < 0, 'A9 无裸调用 wx.navigateBack()');
ok(CODE.indexOf('engine.stop()') >= 0, 'A10 进页停采（本页无头控）');

const LAY = fs.readFileSync(path.join(root, 'utils', 'layout.js'), 'utf8');
const LAYC = stripComments(LAY);
const mRow = LAYC.match(/REC\s*=\s*\{[^}]*rowH:\s*(\d+)/);
const mY = LAYC.match(/REC\s*=\s*\{[^}]*y:\s*(\d+)/);
ok(!!mRow && !!mY, 'A11 REC 几何在 layout.js 单一来源', mY && mRow ? 'y=' + mY[1] + ' rowH=' + mRow[1] : '');
if (mRow && mY) {
  const y0 = Number(mY[1]);
  const bottom = y0 + 5 * Number(mRow[1]);
  ok(bottom <= 316, 'A12 五行下沿不压到提示条（y=316）', 'bottom=' + bottom);
  ok(y0 >= 40, 'A13 首行不压到 HUD（下沿 36）', 'y=' + y0);
  /* v1.51：删掉列表上方小标题后，列表与 HUD 之间必须留出可读的呼吸位；
   * 上沿 64 时只有 28px，观感过挤 ⇒ 钉死 ≥44（当前 84 ⇒ 留白 48）。 */
  ok(y0 - 36 >= 44, 'A14 列表上沿与 HUD 下沿留白 ≥44px（v1.51 加密）',
    'gap=' + (y0 - 36));
}

/* v1.51：右上胶囊改「最近一局成绩」+ 列表上方小标题删除 */
ok(CODE.indexOf('最近一局成绩') >= 0, 'A15 右上胶囊文案为「最近一局成绩」');
ok(CODE.indexOf('状态：只读') < 0, 'A16 右上不再显示「状态：只读」');
ok(CODE.indexOf("'最近一局'") < 0, 'A17 列表上方小标题「最近一局」已删除（避免与胶囊重复）');

/* ───────────────────────── B 组：最近一局数据源 ───────────────────────── */
console.log('\n=== B 组：readLast 取最近一局 ===');

const out = SRC.replace(/from\s+'wx'/g, "from '../../wx-mock.mjs'");
fs.mkdirSync(path.join(here, 'pages', 'records'), { recursive: true });
fs.writeFileSync(path.join(here, 'pages', 'records', 'records.mjs'), out);

const wxMod = await import('./wx-mock.mjs');
const wlog = wxMod.log;
const wstore = wxMod.store;

const sto = await import('./utils/storage.js');
const GAMES = ['bricks', 'egg', 'marble', 'missile', 'plane'];

/* 造数据：bricks 打三局，最近一局分数最低（会被 Top3 截断丢掉） */
/* ⚠ wx-mock 的 store 是 Map（不是普通对象），必须用 set/delete/get */
for (const k of GAMES) { wstore.delete('hi_' + k); wstore.delete('last_' + k); }
sto.pushScore('bricks', { score: 900, cleared: true, durationSec: 30 });
sto.pushScore('bricks', { score: 800, cleared: false, durationSec: 40 });
sto.pushScore('bricks', { score: 700, cleared: true, durationSec: 50 });
sto.pushScore('bricks', { score: 100, cleared: false, durationSec: 10 }); /* 最近一局：垫底 */
sto.pushScore('egg', { score: 42, cleared: false, durationSec: 12 });

eq(sto.readLast('bricks').score, 100, 'B1 最近一局 = 最后打的（哪怕垫底）');
const top3 = sto.readTop('bricks').map(function (r) { return r.score; });
ok(top3.indexOf(100) < 0, 'B2 该局确实不在 Top3 里（证明不能从 hi_ 推导）', 'top3=' + top3.join(','));
eq(sto.readLast('bricks').cleared, false, 'B3 最近一局保留 cleared 字段');
eq(sto.readLast('bricks').durationSec, 10, 'B4 最近一局保留 durationSec 字段');
ok(sto.readLast('bricks').ts > 0, 'B5 最近一局带 ts');
eq(sto.readLast('marble'), null, 'B6 从未玩过的游戏 → null（不是抛错/假数据）');

/* 老存档兼容：只有 hi_、没有 last_ */
wstore.set('hi_plane', [{ score: 500, ts: 1000 }, { score: 300, ts: 3000 }]);
wstore.delete('last_plane');
eq(sto.readLast('plane').score, 300, 'B7 无 last_ 的老存档回退为 Top3 中 ts 最新一条');

/* 脏数据不得炸 */
wstore.set('last_marble', 'garbage');
ok(sto.readLast('marble') === null, 'B8 last_ 为非对象时不崩（回退/丢弃）');
wstore.set('last_marble', { foo: 1 });
ok(sto.readLast('marble') === null, 'B9 last_ 缺 score 时不崩');

/* ───────────────────────── C 组：五行渲染 ───────────────────────── */
console.log('\n=== C 组：五行渲染 ===');

const mod = await import('./pages/records/records.mjs');
const page = mod.default;
page.setData = function () {};
page.onLoad({ gameId: 'records' });

eq((page.rows || []).length, 5, 'C1 恰好五行（每款游戏一行）');
const ids = (page.rows || []).map(function (r) { return r.id; });
eq(ids.join(','), GAMES.join(','), 'C2 行序与 GAME_IDS 一致');
const names = (page.rows || []).map(function (r) { return r.name; });
ok(names.every(function (n) { return !!n; }), 'C3 每行都有游戏名', names.join('/'));
ok((page.rows || []).every(function (r) { return !!r.iconId; }), 'C4 每行都有图标 id');
eq(page.rows[0].score, 100, 'C5 打砖块行显示最近一局 100（不是最佳 900）');
eq(page.rows[1].score, 42, 'C6 接鸡蛋行显示 42');
eq(page.rows[2].score, null, 'C7 滚球迷宫未玩过 → null（渲染为「暂无记录」）');

ok(page.engine && page.engine.running === false, 'C8 无头控 ⇒ 进页已停采');

/* 渲染不抛错，且五行全部落在安全区内 */
let rerr = null;
try { page.render(); } catch (e) { rerr = e.message; }
ok(rerr === null, 'C9 render 不抛错', rerr || '');

const draws = wlog.draws || [];
ok(true, 'C10 渲染完成', 'draw calls=' + draws.length);

/* 【v1.51】实测绘制坐标：右上胶囊文案 / 无小标题 / 首行留白。
 * 静态断言只能证明"源码里有这串字"，证明不了它画在哪、有没有多画一行。
 * ctx 用可记录代理抓 fillText（draw.js 的文字出口）与 roundRect。 */
{
  const rec = { texts: [], rects: [] };
  const noop = function () {};
  page.ctx = new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return function () { return { width: 10 }; };
      if (k === 'fillText') return function (s, x, y) { rec.texts.push({ s: String(s), x: x, y: y }); };
      if (k === 'roundRect') return function (x, y, w, h) { rec.rects.push({ x: x, y: y, w: w, h: h }); };
      return k in t ? t[k] : noop;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  let e2 = null;
  try { page.render(); } catch (e) { e2 = e.message; }
  ok(e2 === null, 'C11 录制 ctx 下 render 不抛错', e2 || '');

  const cap = rec.texts.filter(function (t) { return t.s === '最近一局成绩'; });
  ok(cap.length === 1, 'C12 右上胶囊绘制「最近一局成绩」一次', 'n=' + cap.length);
  ok(cap.length === 1 && cap[0].x === 368,
    'C13 右上胶囊无状态圆点 ⇒ 文字起点回落 368（layout.HUD.noDotTextX）',
    cap.length ? 'x=' + cap[0].x : '');
  const labels = rec.texts.filter(function (t) { return t.s === '最近一局'; });
  ok(labels.length === 0, 'C14 列表上方小标题「最近一局」确已不再绘制', 'n=' + labels.length);

  const first = rec.rects.filter(function (r) { return r.w === 448 && r.h === 36; })[0];
  ok(!!first && first.y === 84, 'C15 首行行盒 y=84（与 HUD 下沿留白 48px）',
    first ? 'y=' + first.y : '未捕获行盒');
}

/* ───────────────────────── D 组：单击返回 ───────────────────────── */
console.log('\n=== D 组：单击触控返回主页 ===');

wlog.calls.length = 0;
page._backAt = 0;
page._hidden = false;
page.onTap();
const navs = wlog.calls.filter(function (c) { return c.api === 'navigateBack'; });
eq(navs.length, 1, 'D1 单击发出一次 navigateBack');
ok(navs[0] && navs[0].args && navs[0].args.delta === 1
  && typeof navs[0].args.success === 'function'
  && typeof navs[0].args.complete === 'function',
  'D2 带 delta:1 与 success/complete 回调',
  navs[0] && JSON.stringify(Object.keys(navs[0].args || {})));
ok(page._backAt > 0, 'D3 记录在途时间（用于落地判定）');

/* 在途连点不重复发请求 */
wlog.calls.length = 0;
page.onTap();
eq(wlog.calls.filter(function (c) { return c.api === 'navigateBack'; }).length, 0,
  'D4 在途时连点不重复发请求');

/* 未落地 ⇒ 到点重试；配额用尽后清在途（不留"点了没反应"死角） */
page._hidden = false;
page._backAt = Date.now() - 900;      /* 超过 BACK_PROBE_MS(800) */
page._backTried = 1;
wlog.calls.length = 0;
page.tick();
eq(wlog.calls.filter(function (c) { return c.api === 'navigateBack'; }).length, 1,
  'D5 超时未落地 → 自动重试一次');

page._backAt = Date.now() - 900;
page._backTried = 3;                  /* 配额已用尽 */
wlog.calls.length = 0;
page.tick();
eq(wlog.calls.filter(function (c) { return c.api === 'navigateBack'; }).length, 0,
  'D6 重试配额用尽 → 不再发请求');
eq(page._backAt, 0, 'D7 配额用尽后清在途标记（可再次单击）');

/* 已落地 ⇒ 不再重试 */
page._backAt = Date.now() - 900;
page._hidden = true;
wlog.calls.length = 0;
page.tick();
eq(wlog.calls.filter(function (c) { return c.api === 'navigateBack'; }).length, 0,
  'D8 已落地（onHide）不再重试');

/* ───────────────────────── E 组：生命周期 ───────────────────────── */
console.log('\n=== E 组：生命周期 ===');

page._hidden = false;
page.onHide();
eq(page._hidden, true, 'E1 onHide 置落地标记（navigateBack 唯一成功证据）');
page.onShow();
eq(page._hidden, false, 'E2 onShow 清落地标记');
eq(page._backAt, 0, 'E3 onShow 清在途标记');

/* 设置页 v1.49 的 Object.assign 尾缀会回盖 onHide —— 一并钉死 */
const setSrc = fs.readFileSync(path.join(root, 'pages', 'settings', 'settings.js'), 'utf8');
const tail = setSrc.replace(/\s+$/, '').slice(-40);
ok(tail.indexOf("lifecycle('settings')") < 0,
  'E4 设置页无尾缀 lifecycle 回盖（否则 onHide 被覆盖、落地判定失效）');
ok(stripComments(setSrc).indexOf('_hidden = true') >= 0, 'E5 设置页 onHide 仍置落地标记');

let uerr = null;
try { page.onUnload(); } catch (e) { uerr = e.message; }
ok(uerr === null, 'E6 onUnload 不抛错', uerr || '');

console.log('\n========================================================');
console.log('harness-records：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项');
process.exit(fail ? 1 : 0);
