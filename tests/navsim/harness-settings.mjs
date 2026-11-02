/* harness-settings.mjs —— 设置页（环形头控版 v1.48）行为回归
 *
 * 为什么单独一套：本页是新交互的**唯一**载体，且有一条与主页刻意不同的
 * 规则（单击切换后**停留在选择态**）。smoke-secondary 只保证"能加载、不抛错"，
 * 交互语义一条都不覆盖；而主页 harness 覆盖的是"确认即跳转"，恰好是相反
 * 的语义 —— 两边都不能替对方作证。
 *
 * 覆盖：
 *   A 组 三项布局（灵敏度 LT / 音效 RT / 返回 B）与图标
 *   B 组 状态机：待机停采 → 滑动进选择 → 未点亮单击回待机
 *   C 组 点亮判定（转头把项拉到屏心）与状态文案（图标外侧）
 *   D 组 单击切换：灵敏度循环、音效开关，**且都不退出选择态**（与主页差异）
 *   E 组 返回项单击 → navigateBack
 *   F 组 15s 无操作自动回待机
 *   G 组 HUD 状态与左下角提示条文案
 *
 * 运行：cd tests/navsim && node build.mjs && node harness-settings.mjs
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

/* 与 smoke-secondary 同规格产物化：重写 'wx' 导入为本目录的 mock */
const src = fs.readFileSync(path.join(root, 'pages', 'settings', 'settings.js'), 'utf8');
const out = src.replace(/from\s+'wx'/g, "from '../../wx-mock.mjs'");
fs.mkdirSync(path.join(here, 'pages', 'settings'), { recursive: true });
fs.writeFileSync(path.join(here, 'pages', 'settings', 'settings.mjs'), out);

const wxMod = await import('./wx-mock.mjs');
const wlog = wxMod.log;
const wstore = wxMod.store;

const mod = await import('./pages/settings/settings.mjs');
const page = mod.default;
page.setData = function () {};
page.onLoad({ gameId: 'settings' });

/* 让引擎输出可控：直接改 snapshot 的源头（_px/_py），模拟转头偏移 */
function look(x, y) {
  page.engine._px = x;
  page.engine._py = y;
  page.render(Date.now());
}
/* 真实用户滑动到单击必然超过 swipeSuppress(300ms)；测试里直接把守卫清零，
 * 等价于"手已经离开触控板"。不清零则单击会被守卫吞掉，测的是守卫不是业务。 */
function tap() {
  page._swipeGuard = 0;
  page.onTap();
}
function saved() {
  return JSON.parse(JSON.stringify(wstore.get('settings') || {}));
}

console.log('\n=== A 组：三项布局与图标（需求 1/3）===');
eq(page.items.length, 3, 'A1 只有三项设置/返回');
const byId = {};
(page.items || []).forEach(function (it) { byId[it.meta.id] = it; });
ok(!!byId.sens && byId.sens.pos === 'LT', 'A2 灵敏度在左上方（LT）', byId.sens && byId.sens.pos);
ok(!!byId.sfx && byId.sfx.pos === 'RT', 'A3 游戏音效在右上方（RT）', byId.sfx && byId.sfx.pos);
ok(!!byId.back && byId.back.pos === 'B', 'A4 返回在下方（B）', byId.back && byId.back.pos);
eq(byId.sens.meta.iconId, 'sensitivity', 'A5 灵敏度用滑杆图标');
eq(byId.back.meta.iconId, 'home', 'A6 返回用主页图标');
/* 旧版长列表信息必须彻底移除（需求 1）。
 * ⚠ 静态扫描**先剥注释**：本页头注里会解释"移出了什么"，直接 indexOf
 * 会被注释误伤（项目铁律：静态红线检查先剥注释再扫）。 */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok(code.indexOf('教学引导') < 0 && code.indexOf('重新校准基准') < 0
  && code.indexOf('ScrollList') < 0 && code.indexOf('SCROLL') < 0,
  'A7 教学引导 / 重新校准 / 滚动列表已移出本页（已剥注释扫描）');

console.log('\n=== B 组：状态机（需求 2/6）===');
eq(page.state, 'IDLE', 'B1 初始为待机态');
ok(page.engine && page.engine.running === false, 'B2 待机态真·停采（与主页同口径）');
tap();
eq(page.state, 'IDLE', 'B3 待机单击无语义（与主页一致，滑动才进选择态）');
page.onSwipe();
eq(page.state, 'SELECT', 'B4 滑动触控进入选择态');
/* navsim 无 AbsoluteOrientationSensor，engine.running 恒 false（真机才有），
 * 故改验「进入选择态即冻结漂移基准」——这是选择态的语义性标志。 */
eq(page.engine.frozen, true, 'B5 进入选择态后冻结漂移基准（freezeDrift true）');
/* 未点亮（偏移为 0，屏心附近无项）→ 单击回待机 */
look(0, 0);
ok(!page._lit, 'B6 未转头时无任何点亮项');
tap();
eq(page.state, 'IDLE', 'B7 未点亮时单击退回待机（需求 6）');

console.log('\n=== C 组：转头点亮 + 图标外侧状态（需求 4）===');
page.onSwipe();
/* 音效项在 RT：(321,95)，屏心 (240,176) → 偏移 (-81,81) 把它拉到屏心 */
look(-81, 81);
ok(page._lit && page._lit.meta.id === 'sfx', 'C1 右上转头点亮音效项',
  page._lit && page._lit.meta.id);
eq(page._lit.meta.name, '游戏音效 · 开启', 'C2 音效项外侧显示当前状态「开启」');
eq(page._lit.meta.iconId, 'volumeOn', 'C3 开启态用 volumeOn 图标');
/* 灵敏度项在 LT：(159,95) → 偏移 (+81,81) */
look(81, 81);
ok(page._lit && page._lit.meta.id === 'sens', 'C4 左上转头点亮灵敏度项',
  page._lit && page._lit.meta.id);
eq(page._lit.meta.name, '灵敏度 · 标准', 'C5 灵敏度项外侧显示当前档位「标准」');

console.log('\n=== D 组：单击切换且不退出选择态（需求 5，与主页的关键差异）===');
tap();                                          /* 标准 → 高 */
eq(page.state, 'SELECT', 'D1 切换灵敏度后**仍在选择态**');
look(81, 81);
eq(page._lit.meta.name, '灵敏度 · 高', 'D2 档位已切到「高」');
tap();                                          /* 高 → 低 */
look(81, 81);
eq(page._lit.meta.name, '灵敏度 · 低', 'D3 再切到「低」');
tap();                                          /* 低 → 标准 */
look(81, 81);
eq(page._lit.meta.name, '灵敏度 · 标准', 'D4 三档循环回到「标准」');
eq(page.state, 'SELECT', 'D5 连续三次切换后仍在选择态');
/* 设置必须真的落盘（不落盘 = 下次进游戏又回默认） */
const wroteSens = saved().sensitivity;
eq(wroteSens, 'standard', 'D6 灵敏度已写入 storage');

look(-81, 81);                                  /* 转回音效项 */
const before = page._lit.meta.name;
tap();                                          /* 开启 → 关闭 */
eq(page.state, 'SELECT', 'D7 切换音效后仍在选择态');
look(-81, 81);
eq(page._lit.meta.name, '游戏音效 · 关闭', 'D8 音效状态翻转为「关闭」');
eq(page._lit.meta.iconId, 'volumeOff', 'D9 关闭态用 volumeOff 图标');
ok(before === '游戏音效 · 开启', 'D10 切换前确为开启态', before);
const wroteSfx = saved().sfxOn;
eq(wroteSfx, false, 'D11 音效开关已写入 storage');
tap();                                          /* 关闭 → 开启 */
look(-81, 81);
eq(page._lit.meta.name, '游戏音效 · 开启', 'D12 可再次开启');

console.log('\n=== E 组：返回项（需求 3）===');
wlog.calls.length = 0;
look(0, -114);                                  /* 返回项在 B：(240,290) → 偏移 (0,-114) */
ok(page._lit && page._lit.meta.id === 'back', 'E1 低头点亮返回项',
  page._lit && page._lit.meta.id);
tap();
const navs = wlog.calls.map(function (c) { return c.url || c.api; });
eq(navs.join(','), 'navigateBack', 'E2 单击返回项 → navigateBack');

console.log('\n=== F 组：15s 无操作自动回待机（与主页同参）===');
page.onSwipe();
eq(page.state, 'SELECT', 'F1 重新进入选择态');
page.selectAt = Date.now() - 16000;             /* 伪造超时 */
page._last = Date.now() - 33;
page.tick();
eq(page.state, 'IDLE', 'F2 超时后自动回待机');

console.log('\n=== G 组：HUD 与提示条（需求 7）===');
eq(page._hintText(), '滑动触控进入选择状态', 'G1 待机提示与主页同文案');
page.onSwipe();
eq(page._hintText(), '转头选择，单击触控返回待机', 'G2 选择中未点亮提示');
look(-81, 81);
eq(page._hintText(), '单击触控开关音效', 'G3 点亮音效项给出动作语义');
look(81, 81);
eq(page._hintText(), '单击触控切换灵敏度', 'G4 点亮灵敏度项给出动作语义');
look(0, -114);
eq(page._hintText(), '单击触控返回主页', 'G5 点亮返回项给出动作语义');
/* 提示条与主页同源（utils/hud.js 的 drawHint），不是本页手绘第二套 */
ok(src.indexOf('drawHint(ctx,') >= 0 && src.indexOf('fillRoundRect') < 0,
  'G6 提示条走 hud.js 公共出口（未私绘第二套）');
/* v1.49：标题改为「设置」—— 此前沿用应用名「摇头晃脑」，与"本页只承载
 * 设置项"的定位不符。断言同时钉死 HUD 仍走 hud.js 公共出口。 */
ok(src.indexOf("drawHud(ctx, '设置'") >= 0, 'G7 HUD 走公共出口且左上角标题为「设置」');

console.log('\n=== M 组：v1.49 三处修复（IMU 预热 / 标题 / 返回落地）===');
/* M1：预热时长必须是共享常量，不能在本页另写魔法数 */
ok(src.indexOf('PRIME_MS') >= 0 && /PRIME_MS\s*=\s*\d/.test(src) === false,
  'M1 PRIME_MS 由 layout.js 共享引入（本页不另立数值）');

/* 用带 query 的 import 拿一个全新页面实例，避免复用已被前面各组改写的状态 */
const modM = await import('./pages/settings/settings.mjs?case=M');
const pm = modM.default;
pm.setData = function () {};
pm.onLoad({ gameId: 'settings' });
ok(pm._primeUntil > Date.now(), 'M2 onLoad 起冷启动预热（_primeUntil 落在未来）',
  'remain=' + (pm._primeUntil - Date.now()) + 'ms');

/* 预热窗口内复位**不得**停采——否则冷启动收敛被反复打断，正是「漂移反复
 * 出现」的成因。这里直接检验 stop 的调用前提。 */
ok(src.indexOf('if (!this._primeUntil) this.engine.stop();') >= 0,
  'M3 resetToIdle 在预热窗口内不停采（不打断收敛）');
ok(src.indexOf('this._primeUntil && (this.state !== S.IDLE || now >= this._primeUntil)') >= 0,
  'M4 tick 有预热到期收口（到期或进选择态即作废）');

/* 返回：必须是 gamepage 同口径的对象形态 + 落地重试，不能是裸调用 */
ok(src.indexOf('wx.navigateBack({') >= 0 && src.indexOf('delta: 1') >= 0,
  'M5 navigateBack 走对象形态且带 delta:1（与 gamepage 同口径）');
ok(src.indexOf('now - this._backAt > BACK_PROBE_MS') >= 0
  && src.indexOf('_backFailed') >= 0 && /BACK_MAX_TRY\s*=\s*3/.test(src),
  'M6 返回有落地探测 + 有限重试（BACK_PROBE_MS / BACK_MAX_TRY）');
ok(src.indexOf('this._hidden = true;') >= 0,
  'M7 以 onHide 落地标记为唯一成功证据（success 是无条件回调）');
/* 功能：在途期间不再受理单击（防连点把状态机打乱） */
pm.onSwipe();
look(0, -114);
pm._lit = { meta: { id: 'back' } };
wlog.calls.length = 0;
pm._swipeGuard = 0;                 /* 清掉进选择态带的伪单击守卫（同上 tap()） */
pm.onTap();
const n1 = wlog.calls.filter(function (c) { return c.api === 'navigateBack'; }).length;
pm.onTap();
const n2 = wlog.calls.filter(function (c) { return c.api === 'navigateBack'; }).length;
ok(n1 === 1 && n2 === 1, 'M8 返回请求在途时重复单击不重复发请求', 'first=' + n1 + ' again=' + n2);
/* 未落地 ⇒ 到点重试；配额用尽 ⇒ 回待机且清在途（不留"点了没反应"的死角） */
pm._backAt = Date.now() - 900;
pm._hidden = false;
pm.tick();
ok(pm._backTried >= 2, 'M9 未落地到点自动重试', 'tried=' + pm._backTried);
pm._backTried = 3;
pm._backAt = Date.now() - 900;
pm._hidden = false;
pm.tick();
ok(pm._backAt === 0 && pm.state === 'IDLE',
  'M10 重试配额用尽后回待机并清在途（不留死局）',
  'backAt=' + pm._backAt + ' state=' + pm.state);

console.log('\n=== H 组：页面自身健壮性 ===');
eq(typeof page.onKeyDown, 'function', 'H1 生命周期五件套齐全（lifecycle 展开）');
eq(typeof page.onKeyUp, 'function', 'H2 onKeyUp 存在');
let uerr = '';
try { page.onUnload(); } catch (e) { uerr = e.message; }
ok(!uerr, 'H3 onUnload 不抛错', uerr);
/* prepare 内落定 settings（startLoop 同步首帧会先跑一次 render） */
ok(src.indexOf('page.settings = settings;') >= 0,
  'H4 settings 在 prepare 内落定（防 startLoop 同步首帧读空）');

console.log('\n========================================================');
console.log('harness-settings：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项');
console.log('========================================================');
process.exit(fail ? 1 : 0);
