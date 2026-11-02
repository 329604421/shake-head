/* harness-sfx.mjs —— 音效中心实证（F-Sys-05 / v1.44）
 *
 * 为什么单独一套：sfx 是唯一"拿不到宿主能力就整体静默"的模块，
 * 静默得对了（不炸交互）还是错了（根本没声音）从外面看不出来。
 * 本套用 mock 构造器 + 真实文件系统双向钉死：
 *   ① 无宿主 Sound 时必须是纯 no-op（不得抛、不得影响调用方）
 *   ② 有宿主时必须按 assets/sfx/<key>.wav 构造、复用实例、可关可开
 *   ③ assets/sfx/ 下 8 个 wav 必须真实存在、格式合规（16kHz/16bit/单声道）
 *      且**确实有波形**（v1.44 新增：文件在 ≠ 有声音）
 *   ④ 四级探测（注入 / globalThis.Sound / globalThis.audio.Sound / require）
 *      ——v1.43 真机无声事故后的加固，任何一级能拿到就算通
 *
 * 运行：cd tests/navsim && node build.mjs && node harness-sfx.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

let pass = 0;
let fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name + (detail ? '  — ' + detail : '')); }
  else { fail += 1; console.log('  [FAIL] ' + name + (detail ? '  — ' + detail : '')); }
}

/* ---------- mock Sound ---------- */
const made = [];
class MockSound {
  constructor(src) {
    if (src.indexOf('__boom') >= 0) throw new Error('mock ctor fail');
    this.src = src;
    this.played = 0;
    made.push(this);
  }
  play() { this.played += 1; }
  stop() { this.stopped = true; }
}

/* ---------- 载入被测模块（此时 globalThis 上还没有 Sound） ---------- */
const sfx = await import('./utils/sfx.js');

console.log('\n=== A 组：无宿主 Sound 时必须纯 no-op（黑屏防线的另一半）===');
ok(sfx.ready() === false, 'A1 未注入且无全局 Sound → ready() 为 false');
let threw = null;
try { sfx.play('boom'); sfx.play('clear'); } catch (e) { threw = e; }
ok(threw === null, 'A2 无构造器时 play() 不抛（调用方零感知）');
ok(made.length === 0, 'A3 无构造器时不产生任何实例', 'made=' + made.length);
ok(sfx.diag().indexOf('mod=none') >= 0, 'A4 diag 报 mod=none（探测全失败）', sfx.diag());

console.log('\n=== B 组：注入后按约定路径构造并复用 ===');
sfx.injectSound(MockSound);
ok(sfx.ready() === true, 'B1 注入构造器后 ready() 为 true');
sfx.play('boom');
ok(made.length === 1, 'B2 首次播放构造 1 个实例', 'made=' + made.length);
ok(made[0].src === '/assets/sfx/boom.wav', 'B3 路径为包内绝对 /assets/sfx/boom.wav', made[0].src);
ok(made[0].played === 1, 'B4 构造后立即 play 一次', 'played=' + made[0].played);
sfx.play('boom');
ok(made.length === 1, 'B5 同 key 二次播放复用实例（不重复 new）', 'made=' + made.length);
ok(made[0].played === 2, 'B6 复用实例上 play 次数累加', 'played=' + made[0].played);
sfx.play('nonexistentkey');
ok(made.length === 1, 'B7 未登记 key 一律不构造（白名单拦截）', 'made=' + made.length);
sfx.play('');
ok(made.length === 1, 'B8 空 key 不构造', 'made=' + made.length);

console.log('\n=== C 组：开关语义 ===');
sfx.setEnabled(false);
const n0 = made.length;
sfx.play('clear');
ok(made.length === n0, 'C1 setEnabled(false) 后不播放也不新建实例', 'made=' + made.length);
ok(sfx.isEnabled() === false, 'C2 isEnabled 反映关闭态');
sfx.setEnabled(true);
sfx.play('clear');
ok(made.length === n0 + 1, 'C3 重新开启后恢复播放', 'made=' + made.length);
sfx.applySettings({ sfxOn: false });
ok(sfx.isEnabled() === false, 'C4 applySettings({sfxOn:false}) 关闭');
sfx.applySettings({ sensitivity: 'high' });
ok(sfx.isEnabled() === true, 'C5 设置项缺 sfxOn 时默认开启（向后兼容旧存档）');

console.log('\n=== D 组：8 个 key 全覆盖 ===');
const KEYS = ['select', 'confirm', 'launch', 'bounce', 'boom', 'catch', 'clear', 'fail'];
const before = made.length;
KEYS.forEach((k) => sfx.play(k));
const have = {};
made.forEach((s) => { have[s.src] = true; });
const lacking = KEYS.filter((k) => !have['/assets/sfx/' + k + '.wav']);
ok(lacking.length === 0, 'D1 八个 key 全部可构造', lacking.length ? '缺 ' + lacking.join(',') : '8/8');
const srcs = made.slice(before).map((s) => s.src);
ok(srcs.every((s) => s.indexOf('/assets/sfx/') === 0), 'D2 全部走包内绝对路径');
ok(sfx.diag().indexOf('snd=8/8') >= 0, 'D3 diag 报 8/8 就绪', sfx.diag());

console.log('\n=== E 组：构造失败不得反复抛（高频事件的坑）===');
let err1 = null;
try { sfx.play('__badkey'); } catch (e) { err1 = e; }
ok(err1 === null, 'E1 非法 key 不抛（白名单先拦）');
/* 干净实例：主实例的 8 个 key 在 D 组已全部构造成功，无法再触发"构造失败"，
 * 故用带 query 的 import 强制拿到全新模块实例（cache / missing 都是空的）。 */
let badN = 0;
class BadSound { constructor() { badN += 1; throw new Error('always fail'); } }
const sfx2 = await import('./utils/sfx.js?case=E');
sfx2.injectSound(BadSound);
let err2 = null;
try { sfx2.play('boom'); } catch (e) { err2 = e; }
ok(err2 === null, 'E2 构造抛异常被吞掉，不上抛给玩法链路');
let err3 = null;
try { sfx2.play('boom'); sfx2.play('boom'); } catch (e) { err3 = e; }
ok(err3 === null, 'E3 后续播放同样不抛');
/* v1.44：构造失败会依次试 3 个路径候选（/assets/sfx/ · assets/sfx/ · ./assets/sfx/），
 * 故首次 play 尝试 3 次；标记 missing 后必须**不再**重试——否则高频事件（如
 * 连击爆炸）会每秒构造几十次失败实例。 */
/* v1.45：路径候选 3 → 5 个（/ · 裸 · ./ · ../ · ../../），
 * 首次 play 失败要试满 5 个才标 missing；之后不得再试。 */
ok(badN === 5, 'E4 五个路径候选各试一次后标记 missing', 'badN=' + badN);
sfx2.play('boom');
sfx2.play('boom');
ok(badN === 5, 'E4b 已标记 missing 后不再重复构造（高频事件保护）', 'badN=' + badN);
ok(sfx2.diag().indexOf('miss=1') >= 0, 'E5 diag 的 miss 只统计真失败过的', sfx2.diag());

console.log('\n=== F 组：注入非法值 ===');
sfx.injectSound(null);
ok(sfx.ready() === false, 'F1 注入 null → 视为未注入');
sfx.injectSound('not a function');
ok(sfx.ready() === false, 'F2 注入非函数 → 忽略');

console.log('\n=== H 组：全局探测（v1.43 核心机制——零 import 拿到宿主 Sound）===');
const sfx3 = await import('./utils/sfx.js?case=H');
ok(sfx3.ready() === false, 'H1 干净实例、全局无 Sound → ready=false');
globalThis.Sound = MockSound;
ok(sfx3.ready() === true, 'H2 挂上 globalThis.Sound 后自动探测到（全程无 import）');
const before5 = made.length;
sfx3.play('fail');
ok(made.length === before5 + 1, 'H3 播放确实走全局构造器', '新增 ' + (made.length - before5) + ' 个');
ok(made[made.length - 1].src === '/assets/sfx/fail.wav', 'H4 路径仍为 /assets/sfx/fail.wav', made[made.length - 1].src);
delete globalThis.Sound;
const sfx4 = await import('./utils/sfx.js?case=H2');
ok(sfx4.ready() === false, 'H5 全局移除后新实例回到 no-op（不得残留旧引用）');

console.log('\n=== G 组：assets/sfx 资源文件实证（不是"应该存在"，是真的在）===');
const dir = path.join(root, 'assets', 'sfx');
ok(fs.existsSync(dir), 'G1 assets/sfx 目录存在', dir);
let sizeSum = 0;
KEYS.forEach((k) => {
  const p = path.join(dir, k + '.wav');
  if (!fs.existsSync(p)) { ok(false, 'G2 ' + k + '.wav 存在'); return; }
  const b = fs.readFileSync(p);
  sizeSum += b.length;
  const isRiff = b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE';
  const ch = b.readUInt16LE(22);
  const rate = b.readUInt32LE(24);
  const bits = b.readUInt16LE(34);
  /* v1.44 规格：16kHz / 16-bit / 单声道（8-bit 真机无声，见 sfx.js 文件头） */
  ok(isRiff && ch === 1 && rate === 16000 && bits === 16,
    'G2 ' + k + '.wav 16kHz/16bit/单声道',
    'ch=' + ch + ' rate=' + rate + ' bits=' + bits + ' ' + b.length + 'B');
});
ok(sizeSum < 128 * 1024, 'G3 八个体积合计 < 128KB（不得撑包）', (sizeSum / 1024).toFixed(1) + ' KB');
/* G4：样本不得全部静音——文件在≠有声音。峰值过低等于没生成波形。 */
let silent = [];
KEYS.forEach((k) => {
  const b = fs.readFileSync(path.join(dir, k + '.wav'));
  let peak = 0;
  for (let i = 44; i + 1 < b.length; i += 2) {
    const v = Math.abs(b.readInt16LE(i));
    if (v > peak) peak = v;
  }
  if (peak < 8000) silent.push(k + '(' + peak + ')');
});
ok(silent.length === 0, 'G4 每个音效都有实际波形（峰值 >8000）',
  silent.length ? '近静音: ' + silent.join(',') : '全部有声');

console.log('\n=== I 组：四级探测与路径回退（v1.44 真机无声后的加固）===');

/* I1：第二级 —— 命名空间对象 globalThis.audio.Sound（有些运行时不挂裸构造器） */
delete globalThis.Sound;
const sfxI1 = await import('./utils/sfx.js?case=I1');
ok(sfxI1.ready() === false, 'I1a 干净实例仍无构造器');
globalThis.audio = { Sound: MockSound };
ok(sfxI1.ready() === true, 'I1b globalThis.audio.Sound 也能被探测到');
const nI1 = made.length;
sfxI1.play('catch');
ok(made.length === nI1 + 1, 'I1c 播放确实走命名空间构造器', '新增 ' + (made.length - nI1));
delete globalThis.audio;

/* I2：第三级 —— 运行时 require('audio')（不是 import，失败可 catch） */
const sfxI2 = await import('./utils/sfx.js?case=I2');
ok(sfxI2.ready() === false, 'I2a 无 require 时仍为 false');
globalThis.require = (id) => (id === 'audio' ? { Sound: MockSound } : null);
ok(sfxI2.ready() === true, 'I2b require("audio").Sound 被探测到');
delete globalThis.require;
globalThis.require = () => { throw new Error('no module audio'); };
const sfxI2b = await import('./utils/sfx.js?case=I2b');
let errI2 = null;
try { sfxI2b.play('boom'); } catch (e) { errI2 = e; }
ok(errI2 === null, 'I2c require 抛异常被吞掉，不上抛给玩法链路');
ok(sfxI2b.diag().indexOf('mod=none') >= 0, 'I2d require 失败后 diag 报 mod=none', sfxI2b.diag());
delete globalThis.require;

/* I3：路径候选回退 —— 只有无前导斜杠的前缀能构造成功时，必须自动切过去 */
class NoSlashSound {
  constructor(src) {
    if (src.charAt(0) === '/') throw new Error('bad path');
    this.src = src;
    this.played = 0;
    made.push(this);
  }
  play() { this.played += 1; }
}
const sfxI3 = await import('./utils/sfx.js?case=I3');
sfxI3.injectSound(NoSlashSound);
sfxI3.play('select');
ok(sfxI3.diag().indexOf('sp=1') >= 0, 'I3a 首候选失败后回退到 assets/sfx/', sfxI3.diag());
ok(sfxI3.brief().indexOf('1/8') >= 0, 'I3b brief 显示 1/8 就绪', sfxI3.brief());

/* I4：probe() 逐个构造（只构造、不发声），以及播放计数 */
const sfxI4 = await import('./utils/sfx.js?case=I4');
sfxI4.injectSound(MockSound);
const nProbe = sfxI4.probe();
ok(nProbe === 8, 'I4a probe() 构造全部 8 个', 'n=' + nProbe);
ok(sfxI4.brief() === 'S8/8x0', 'I4b probe 只构造不发声 → plays=0（S=Sound 通道）', sfxI4.brief());
sfxI4.play('select');
sfxI4.play('boom');
ok(sfxI4.brief() === 'S8/8x2', 'I4c 播放后 plays 计数递增', sfxI4.brief());
ok(sfxI4.diag().indexOf('plays=2') >= 0, 'I4d diag 同步播放次数', sfxI4.diag());

/* I5：无构造器时 brief 必须给可判读的定论 */
const sfxI5 = await import('./utils/sfx.js?case=I5');
ok(sfxI5.brief() === 'NO-CTOR', 'I5 无构造器时 brief 为 NO-CTOR', sfxI5.brief());

console.log('\n=== J 组：AudioPlayer 兜底通道（v1.45 核心新增——Sound 不行就用它）===');
const players = [];
class MockPlayer {
  constructor(src) {
    this.src = src;
    this.played = 0;
    this.sought = 0;
    players.push(this);
  }
  seek(pos) { this.sought += 1; this.pos = pos; }
  play() { this.played += 1; }
}

const sfxJ = await import('./utils/sfx.js?case=J');
sfxJ.injectAudio({ AudioPlayer: MockPlayer });   /* 只注入 Player，不给 Sound */
ok(sfxJ.ready() === true, 'J1 只有 AudioPlayer 也算宿主可用');
sfxJ.play('confirm');
ok(players.length === 1, 'J2 Sound 缺席时自动切 AudioPlayer 通道', 'players=' + players.length);
ok(players[0].played === 1, 'J3 AudioPlayer.play 被调用');
ok(players[0].sought === 1 && players[0].pos === 0, 'J4 播放前先 seek(0)（AudioPlayer 不自动重头）');
sfxJ.play('confirm');
ok(players.length === 1 && players[0].played === 2, 'J5 同 key 实例复用（不重复构造）');
ok(sfxJ.probe() === 8, 'J6 probe 经 AudioPlayer 通道构造全部 8 个');
ok(sfxJ.brief() === 'A8/8x2', 'J7 brief 报 A 通道（A=AudioPlayer）', sfxJ.brief());
ok(sfxJ.diag().indexOf('ply=8/8') >= 0, 'J8 diag 报 ply=8/8', sfxJ.diag());

/* J9：两通道并存时必须优先 Sound（AudioPlayer 只是兜底） */
const sfxJ2 = await import('./utils/sfx.js?case=J2');
sfxJ2.injectAudio({ Sound: MockSound, AudioPlayer: MockPlayer });
const nSnd = made.length;
const nPly = players.length;
sfxJ2.play('launch');
ok(made.length === nSnd + 1 && players.length === nPly,
  'J9 双通道并存时优先 Sound（AudioPlayer 零调用）',
  'made+' + (made.length - nSnd) + ' players+' + (players.length - nPly));

console.log('\n=== K 组：设置页诊断可见性（v1.46 渲染 bug 回归）===');
/* v1.45 事故：诊断 brief 被插在 `if (row.sub)` 块内，而「音效」toggle 行
 * push 时**没有 sub 字段** → 右侧文字（含"已开启/已关闭"）从未渲染过，
 * 诊断等于没加。此组用源码静态检查钉死这个结构。 */
const stSrc = fs.readFileSync(path.join(root, 'pages', 'settings', 'settings.js'), 'utf8');
ok(stSrc.indexOf('sfx.brief()') >= 0, 'K1 设置页调用 sfx.brief()');
ok(stSrc.indexOf('if (row.sub) {') < 0,
  'K2 渲染不再以 row.sub 存在为前提（toggle 行自产 sub）');
/* v1.48：设置页改为环形头控页，诊断不再单独成行，而是并入「游戏音效」项的
 * 状态文案；取值的 try-catch 语义不变（诊断绝不可拖垮渲染循环）。 */
ok(/try\s*\{\s*ok = sfx\.brief\(\)/.test(stSrc),
  'K3 brief 调用有 try-catch（诊断绝不可拖垮渲染循环）');

console.log('\n=== L 组：import \'audio\' 隔离红线（v1.47 NO-CTOR 兜底试验）===');
/* v1.46 真机 `NO-CTOR` ⇒ 四级探测全灭，只剩静态 import 'audio' 一条路。
 * 静态 import 解析失败会炸整条 import 链（黑屏教训），所以红线是：
 *   ① 全项目只有 utils/audio-host.js 允许出现 from 'audio'；
 *   ② audio-host 必须用 `import * as ns`（具名 import 缺失是链接期错误）；
 *   ③ 只许 settings 页引用 audio-host（主页/游戏页零牵连）；
 *   ④ settings 在注入 host 之后再 probe（否则白测）。 */
const ALL_JS = [];
(function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    /* tests/ 是回归夹具目录（build.mjs 会把 utils/*.js 复制成 mock 版），
     * 不是产品源码，扫进去会把同一份代码算两次。 */
    if (fs.statSync(p).isDirectory()) {
      if (f !== '.cache' && f !== 'node_modules' && f !== 'tests') walk(p);
    }
    else if (f.endsWith('.js')) ALL_JS.push(p);
  }
}(root));
const importers = ALL_JS.filter(function (p) {
  return fs.readFileSync(p, 'utf8').indexOf("from 'audio'") >= 0;
});
ok(importers.length === 1 && importers[0].replace(/\\/g, '/').indexOf('utils/audio-host.js') >= 0,
  'L1 全项目只有 utils/audio-host.js import \'audio\'',
  importers.map(function (p) { return path.relative(root, p); }).join(', ') || '(无)');
const ahSrc = fs.readFileSync(path.join(root, 'utils', 'audio-host.js'), 'utf8');
ok(ahSrc.indexOf('import * as ns from \'audio\'') >= 0
  && !/^import\s*\{/m.test(ahSrc),
  'L2 audio-host 用 namespace 导入（具名导入缺失会链接期崩溃）');
ok(stSrc.indexOf("audio-host.js") >= 0
  && stSrc.indexOf('sfx.injectAudio(host)') >= 0
  && stSrc.indexOf('sfx.injectAudio(host)') < stSrc.indexOf('sfx.probe()'),
  'L3 settings 引入 audio-host 并在 probe 之前注入');
/* v1.48 白名单：主页（开机即注入）+ 游戏底座（五款游戏页）+ 设置页（诊断）。 */
const HOST_OK = ['pages/index/index.js', 'pages/settings/settings.js', 'utils/gamepage.js'];
const ALLOWED = ALL_JS.filter(function (p) {
  /* 只认真实 import 语句：sfx.js / audio-host.js 的注释里也会提到 audio-host */
  return /from\s+'[^']*audio-host\.js'/.test(fs.readFileSync(p, 'utf8'));
}).map(function (p) { return path.relative(root, p).replace(/\\/g, '/'); });
const strays = ALLOWED.filter(function (r) { return HOST_OK.indexOf(r) < 0; });
ok(strays.length === 0 && ALLOWED.length === 3,
  'L4 仅 index / settings / gamepage 引用 audio-host（崩溃面已控）',
  ALLOWED.join(', ') || '(无)');
/* L6：v1.48「开机默认有声」——主页与游戏底座必须在读设置**之前**注入，
 * 否则又回到「进过设置页才有声」。 */
const idxSrc = fs.readFileSync(path.join(root, 'pages/index/index.js'), 'utf8');
const gpSrc = fs.readFileSync(path.join(root, 'utils/gamepage.js'), 'utf8');
ok(idxSrc.indexOf('sfx.injectAudio(host)') >= 0
  && idxSrc.indexOf('sfx.injectAudio(host)') < idxSrc.indexOf('readSettings()'),
  'L6a 主页在 readSettings 之前注入 host');
ok(gpSrc.indexOf('sfx.injectAudio(host)') >= 0
  && gpSrc.indexOf('sfx.injectAudio(host)') < gpSrc.indexOf('readSettings()'),
  'L6b 游戏底座在 readSettings 之前注入 host');

/* L5：真实代码路径——audio-host pick（ns.Sound 与 ns.default.Sound 双形态）
 * + 注入后 probe/brief 全链路。audio-host 在 navsim 里被重写为 audio-mock，
 * 其 default 含两个类 ⇒ brief 应从 NO-CTOR 变 S8/8x0。 */
const hostMod = await import('./utils/audio-host.js');
ok(typeof hostMod.default.Sound === 'function'
  && typeof hostMod.default.AudioPlayer === 'function',
  'L5a audio-host 双形态 pick 命中 mock 的类');
const sfxL = await import('./utils/sfx.js?case=L5');
ok(sfxL.brief() === 'NO-CTOR', 'L5b 注入前 NO-CTOR', sfxL.brief());
sfxL.injectAudio(hostMod.default);
sfxL.probe();
ok(sfxL.brief() === 'S8/8x0', 'L5c 注入+probe 后 S8/8x0（settings 真机预期值）', sfxL.brief());

console.log('\n========================================================');
console.log('harness-sfx：' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + (pass + fail) + ' 项');
console.log('========================================================');
process.exit(fail ? 1 : 0);
