/* sfx.js —— 音效中心（F-Sys-05）
 * 运行时只有 Sound / AudioPlayer（文件音效），无振荡器 API：
 * 合成音由 assets/sfx/*.wav 承载（v1.44 起 16kHz / 16-bit 单声道，共 65KB）；
 * 文件或音频模块异常时静默降级为 no-op，不影响任何交互链路。
 *
 * 【为何不 import 'audio'】（v3 黑屏三轮排查定案；v1.47 起收窄为"唯一例外"）：
 * 无论是顶部静态 import 还是惰性动态 import()，都存在崩溃面：
 *   - 静态 import：模块解析失败 → 整条 import 链加载期崩溃 → 黑屏；
 *   - 动态 import()：部分运行时不支持该语法（解析期失败，try-catch 都救不了）。
 * v1.46 真机诊断 `NO-CTOR`（四级探测全灭）⇒ v1.47 起新增 **utils/audio-host.js**
 * 作为全项目唯一允许 `import 'audio'` 的位置（namespace 导入，兼容 ESM/CJS），
 * 目前仅 settings 页引用 —— 解析失败最多设置页黑屏，主页/游戏页零牵连。
 * 待真机确认可解析后再逐步下放；**其它任何文件仍然禁止直接 import 'audio'**
 * （harness-sfx L1 静态红线钉死）。
 *
 * 【v1.43 事故一：8-bit PCM 真机无声】
 * 首发 8kHz / 8-bit（16.5KB），真机一声不出 ⇒ v1.44 改 16kHz / 16-bit。
 * ⚠ 「没声音」优先怀疑**音频规格**，别一上来怀疑代码链路。
 *
 * 【v1.45 事故二：换 16bit 后仍无声 —— 两条通道 + 五个路径候选】
 * 规格改对后依旧无声 ⇒ 说明问题在"通道"或"路径基准"，本轮一次堵死：
 *   ① **双通道**：Sound 不行就用 AudioPlayer（后者是官方通用播放 API，
 *      支持本地文件与流式）。Sound 构造失败即自动切 AudioPlayer。
 *   ② **五路径候选**：官方两种示例（'/assets/x.wav' 与 './x.wav'）暗示
 *      不同运行时基准目录不同，故连同 ../ 与 ../../ 一起试，成功即记住。
 *   ③ **探测一次拿全模块**：注入值 → globalThis.audio → globalThis.Sound
 *      → 运行时 require('audio')（**不是 import**，失败可 catch，无解析期崩溃面）。
 *
 * 【诊断入口】设置页「音效」行常驻显示 sfx.brief()（不用抢 6s 窗口）。
 */

/* 'bounce' 为 PRD-02 F-BRK-92 新增（挡板反弹）；其余沿用既有 key */
const KEYS = ['select', 'confirm', 'launch', 'bounce', 'boom', 'catch', 'clear', 'fail'];

/* 路径候选（v1.45 五个）：官方两种示例都给过，不同运行时基准目录不同；
 * 后两个覆盖"相对调用方文件解析"的情况（utils/ 与 pages/<game>/）。 */
const PATHS = [
  '/assets/sfx/',
  'assets/sfx/',
  './assets/sfx/',
  '../assets/sfx/',
  '../../assets/sfx/',
];

const cache = {};        /* key → Sound 实例（构造开销大，必须复用） */
const pcache = {};       /* key → AudioPlayer 实例（Sound 通道失败时的兜底） */
const missing = {};      /* Sound 构造失败过的 key */
const pmiss = {};        /* AudioPlayer 也失败的 key */
let injected = null;     /* injectSound / injectAudio 注入值 */
let mod = null;          /* { Sound, AudioPlayer } 探测结果 */
let modSrc = 'none';     /* 来源，诊断用 */
let enabled = true;
let playCount = 0;       /* 实际调用宿主 play() 的次数 */
let lastErr = '';        /* 最后一次异常消息（截断） */
let sIdx = 0;            /* Sound 通道成功的路径下标 */
let pIdx = 0;            /* AudioPlayer 通道成功的路径下标 */

/* 探测音频模块：一次拿全 Sound + AudioPlayer。
 * ⚠ 失败**不缓存**——运行时可能较晚才挂载全局，下次还能再试；
 *   但失败后 **2s 内不重试**：设置页每帧渲染都会调 brief()，
 *   若每帧都走 require 并抛异常，性能与日志都会被拖垮。
 * force=true 绕过节流：probe() / ready() 这类低频显式调用应当即时反映。 */
let probeFailAt = 0;

function audio(force) {
  if (mod) return mod;
  const now = Date.now ? Date.now() : 0;
  if (!force && probeFailAt && now - probeFailAt < 2000) return null;
  const got = { Sound: null, AudioPlayer: null };
  function pick(o) {
    if (!o) return;
    if (!got.Sound && typeof o.Sound === 'function') got.Sound = o.Sound;
    if (!got.AudioPlayer && typeof o.AudioPlayer === 'function') got.AudioPlayer = o.AudioPlayer;
  }
  try {
    const g = typeof globalThis !== 'undefined' ? globalThis : null;
    pick(injected);
    if (g) {
      pick(g.audio);
      pick({ Sound: g.Sound, AudioPlayer: g.AudioPlayer });
    }
    /* 运行时 require —— 不是 import，解析期不会炸；拿不到就 catch 掉 */
    if (typeof require === 'function') pick(require('audio'));
  } catch (e) {
    if (!lastErr) lastErr = 'probe:' + String(e && e.message || e).slice(0, 24);
  }
  if (got.Sound || got.AudioPlayer) {
    mod = got;
    modSrc = got.Sound ? 'sound' : 'player';
    if (injected) modSrc = 'inject';
    return mod;
  }
  probeFailAt = now;
  return null;
}

/* 注入宿主构造器（页面级可选兜底，见文件头注释） */
export function injectSound(Sound) {
  injected = Object.assign({}, injected || {}, { Sound: (typeof Sound === 'function') ? Sound : null });
  mod = null;
}
export function injectAudio(obj) {
  injectSound(obj && obj.Sound);
  if (obj && typeof obj.AudioPlayer === 'function') {
    injected = Object.assign({}, injected || {}, { AudioPlayer: obj.AudioPlayer });
  }
  mod = null;
}

export function setEnabled(v) { enabled = !!v; }
export function isEnabled() { return enabled; }

/* 从设置恢复音效开关（启动 / 回前台调用） */
export function applySettings(s) {
  enabled = !(s && s.sfxOn === false);
}

/* 按路径候选构造；成功即记住下标（下次优先试它） */
function tryPaths(C, key, startIdx, onErr) {
  const order = [startIdx];
  for (let i = 0; i < PATHS.length; i += 1) {
    if (i !== startIdx) order.push(i);
  }
  for (let k = 0; k < order.length; k += 1) {
    const idx = order[k];
    try {
      const inst = new C(PATHS[idx] + key + '.wav');
      if (inst) return { inst: inst, idx: idx };
    } catch (e) {
      lastErr = key + '@' + idx + ':' + String(e && e.message || e).slice(0, 24);
    }
  }
  return null;
}

/* 音量：仅在宿主默认值明显为 0 时纠正——绝不主动改小
 * （宿主 volume 量程可能是 0~1 也可能是 0~100，乱设会几乎无声） */
function fixVolume(inst) {
  try {
    const v = inst.volume;
    if (typeof v === 'number' && v <= 0) inst.volume = 1;
  } catch (e) { /* volume 不可读就不管 */ }
}

function playSound(inst) {
  try {
    if (typeof inst.play !== 'function') return false;
    inst.play();
    playCount += 1;
    return true;
  } catch (e) {
    lastErr = 'play:' + String(e && e.message || e).slice(0, 24);
    return false;
  }
}

/* AudioPlayer 不像 Sound 那样"play 即重头"，先 seek(0) 再播；
 * seek 不可用则退回重设 src（重设 src 会让部分实现重新加载，但至少能响）。 */
function playPlayer(p) {
  try {
    if (typeof p.seek === 'function') p.seek(0);
    p.play();
    playCount += 1;
    return true;
  } catch (e) {
    try {
      p.src = p._src;
      p.play();
      playCount += 1;
      return true;
    } catch (e2) {
      lastErr = 'pplay:' + String(e2 && e2.message || e2).slice(0, 24);
      return false;
    }
  }
}

export function play(key) {
  if (!enabled || !key || KEYS.indexOf(key) < 0) return;
  if (pcache[key]) { playPlayer(pcache[key]); return; }
  if (cache[key]) { playSound(cache[key]); return; }

  const M = audio();
  if (!M) return;

  /* 通道一：Sound */
  if (M.Sound && !missing[key]) {
    const got = tryPaths(M.Sound, key, sIdx);
    if (got) {
      sIdx = got.idx;
      fixVolume(got.inst);
      cache[key] = got.inst;
      playSound(got.inst);
      return;
    }
    missing[key] = true;
  }

  /* 通道二：AudioPlayer（Sound 不可用或构造失败） */
  if (M.AudioPlayer && !pmiss[key]) {
    const got = tryPaths(M.AudioPlayer, key, pIdx);
    if (got) {
      pIdx = got.idx;
      fixVolume(got.inst);
      got.inst._src = PATHS[got.idx] + key + '.wav';
      pcache[key] = got.inst;
      playPlayer(got.inst);
      return;
    }
    pmiss[key] = true;
  }
}

/* 启动自检：逐个构造（不发声），把结果写进 diag。 */
export function probe() {
  const M = audio(true);
  if (!M) return 0;
  let n = 0;
  for (let i = 0; i < KEYS.length; i += 1) {
    const k = KEYS[i];
    if (cache[k] || pcache[k]) { n += 1; continue; }
    if (M.Sound && !missing[k]) {
      const got = tryPaths(M.Sound, k, sIdx);
      if (got) { sIdx = got.idx; fixVolume(got.inst); cache[k] = got.inst; n += 1; continue; }
      missing[k] = true;
    }
    if (M.AudioPlayer && !pmiss[k]) {
      const got = tryPaths(M.AudioPlayer, k, pIdx);
      if (got) {
        pIdx = got.idx;
        fixVolume(got.inst);
        got.inst._src = PATHS[got.idx] + k + '.wav';
        pcache[k] = got.inst;
        n += 1;
      } else {
        pmiss[k] = true;
      }
    }
  }
  return n;
}

/* 详细诊断串 */
export function diag() {
  const M = audio(true);
  let sr = 0;
  let pr = 0;
  for (let i = 0; i < KEYS.length; i += 1) {
    if (cache[KEYS[i]]) sr += 1;
    if (pcache[KEYS[i]]) pr += 1;
  }
  return 'sfx mod=' + (M ? modSrc : 'none')
    + ' S=' + (M && M.Sound ? 'y' : 'n') + ' A=' + (M && M.AudioPlayer ? 'y' : 'n')
    + ' on=' + (enabled ? '1' : '0')
    + ' snd=' + sr + '/' + KEYS.length
    + ' ply=' + pr + '/' + KEYS.length
    + ' plays=' + playCount
    + ' miss=' + Object.keys(missing).length + '/' + Object.keys(pmiss).length
    + ' sp=' + sIdx + ' pp=' + pIdx
    + (lastErr ? ' err=' + lastErr : '');
}

/* 精简状态：宿主音频构造器是否可得（低频显式调用，绕过节流） */
export function ready() {
  const M = audio(true);
  return !!(M && (M.Sound || M.AudioPlayer));
}

/* 超短诊断（设置页「音效」行常驻显示）：
 *   NO-CTOR  四级探测全失败，宿主没露出任何音频 API
 *   S8/8x3   Sound 通道，8 个就绪，已播 3 次
 *   A8/8x3   AudioPlayer 兜底通道（Sound 不可用）
 *   0/8x0    拿到了 API 但一个实例都构造不出来（路径 / 格式问题） */
export function brief() {
  const M = audio();
  if (!M || (!M.Sound && !M.AudioPlayer)) return 'NO-CTOR';
  let sr = 0;
  let pr = 0;
  for (let i = 0; i < KEYS.length; i += 1) {
    if (cache[KEYS[i]]) sr += 1;
    if (pcache[KEYS[i]]) pr += 1;
  }
  const ch = sr >= pr ? 'S' : 'A';
  return ch + Math.max(sr, pr) + '/' + KEYS.length + 'x' + playCount;
}
