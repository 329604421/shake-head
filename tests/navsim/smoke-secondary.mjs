/* 二级页回归冒烟：records / settings / result / calibrate 四页没有对应的
 * harness-* 覆盖（八套里只有 index / game / 五款游戏页有），v1.33 把它们改成
 * 走 utils/pagebase.js 后必须有一道回归网。
 * 覆盖：模块可加载 / onLoad 不抛错 / 三件套建立 / tick / render / onUnload，
 *      外加两处导航死链回归（结算「再来一局」、校准完成后的去向）。
 * 运行：cd tests/navsim && node build.mjs && node smoke-secondary.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const PAGES = ['records', 'settings', 'result', 'calibrate'];
const built = [];
for (const p of PAGES) {
  const src = fs.readFileSync(path.join(root, 'pages', p, p + '.js'), 'utf8');
  const out = src.replace(/from\s+'wx'/g, "from '../../wx-mock.mjs'");
  fs.mkdirSync(path.join(here, 'pages', p), { recursive: true });
  fs.writeFileSync(path.join(here, 'pages', p, p + '.mjs'), out);
  built.push([p, out !== src]);
}

const R = [];
function check(name, cond, detail) {
  R.push({ name, ok: !!cond, detail: detail || '' });
  console.log('  [' + (cond ? 'PASS' : 'FAIL') + '] ' + name + (detail ? '  — ' + detail : ''));
}

const wxMod = await import('./wx-mock.mjs');
const wxd = wxMod.default;
const wlog = wxMod.log;

for (const [p, rewrote] of built) {
  console.log('\n=== ' + p + '（wx 改写=' + rewrote + '） ===');
  let page;
  try {
    const m = await import('./pages/' + p + '/' + p + '.mjs');
    page = m.default;
  } catch (e) {
    check(p + ' 模块可加载', false, e.message);
    continue;
  }
  check(p + ' 模块可加载', !!page);

  const errs = [];
  try {
    page.setData = function () {};
    page.onLoad({ gameId: p === 'calibrate' ? 'plane' : 'bricks' });
  } catch (e) { errs.push('onLoad:' + e.message); }
  check(p + ' onLoad 不抛错', errs.length === 0, errs.join(' / '));
  check(p + ' engine/ctx/gesture 均已建立',
    !!(page.engine && page.ctx && page.gesture),
    'engine=' + !!page.engine + ' ctx=' + !!page.ctx + ' gesture=' + !!page.gesture);

  const terr = [];
  try { page._last = Date.now() - 33; page.tick(); } catch (e) { terr.push(e.message); }
  check(p + ' tick 不抛错', terr.length === 0, terr.join(' / '));

  const rerr = [];
  try { page.render(page.engine ? Date.now() : 0, { ok: true, x: 0, y: 0 }); } catch (e) { rerr.push(e.message); }
  check(p + ' render 不抛错', rerr.length === 0, rerr.join(' / '));

  /* 结算页「再来一局」必须跳到真实游戏页，不能是已废弃的框架占位页 */
  if (p === 'result') {
    wlog.calls.length = 0;
    page.gameId = 'bricks';
    page.focus = 0;
    try { page.onTap(); } catch (e) { rerr.push(e.message); }
    const to = wlog.calls.map((c) => c.url || c.api).join(',');
    check(p + ' 「再来一局」跳真实游戏页（非 pages/game/game）',
      to.indexOf('pages/brick/brick') >= 0 && to.indexOf('pages/game/game') < 0, to);
  }
  /* 校准完成必须跳真实游戏页；系统来源（settings）走 navigateBack */
  if (p === 'calibrate') {
    wlog.calls.length = 0;
    page.gameId = 'plane';
    try { page.enterGame(); } catch (e) { rerr.push(e.message); }
    const to = wlog.calls.map((c) => c.url || c.api).join(',');
    check(p + ' 游戏来源校准后跳真实页（非 pages/game/game）',
      to.indexOf('pages/plane/plane') >= 0 && to.indexOf('pages/game/game') < 0, to);

    wlog.calls.length = 0;
    page.gameId = 'settings';
    try { page.enterGame(); } catch (e) { rerr.push(e.message); }
    const to2 = wlog.calls.map((c) => c.url || c.api).join(',');
    check(p + ' 系统来源校准后返回来处（navigateBack）', to2 === 'navigateBack', to2);
  }

  let uerr = '';
  try { page.onUnload(); } catch (e) { uerr = e.message; }
  check(p + ' onUnload 不抛错', !uerr, uerr);
}

const pass = R.filter((r) => r.ok).length;
console.log('\n=== smoke-secondary: ' + pass + '/' + R.length + ' 通过 ===');
if (pass !== R.length) {
  R.filter((r) => !r.ok).forEach((r) => console.log('  x ' + r.name + ' — ' + r.detail));
  process.exit(1);
}
process.exit(0);
