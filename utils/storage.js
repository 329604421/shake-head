/* storage.js —— 存储层（PRD-01 §10 / §11）
 * 全部走同步读写；写入失败静默（最多提示一次由调用方决定）；
 * 读档失败 / JSON 解析失败静默重置，绝不崩溃（NFR-06）。
 */

import wx from 'wx';

const K_SETTINGS = 'settings';
const K_HI = 'hi_';
const K_LAST = 'last_';
const K_TUT = 'tutorial_seen';
const K_PENDING = 'pendingResult';
const K_BASE = 'gameBase';

export function safeGet(key, fallback) {
  try {
    const v = wx.getStorageSync(key);
    return v === undefined ? fallback : v;
  } catch (e) { return fallback; }
}

export function safeSet(key, data) {
  try { wx.setStorageSync(key, data); return true; } catch (e) { return false; }
}

/* 设置：{ sensitivity:'low'|'standard'|'high', sfxOn:boolean } */
export function readSettings() {
  const s = safeGet(K_SETTINGS, null);
  if (!s || typeof s !== 'object') return { sensitivity: 'standard', sfxOn: true };
  return {
    sensitivity: (s.sensitivity === 'low' || s.sensitivity === 'high') ? s.sensitivity : 'standard',
    sfxOn: s.sfxOn !== false,
  };
}

export function writeSettings(s) { return safeSet(K_SETTINGS, s); }

/* 战绩 Top3（F-Sys-01）：hi_{gameId}，降序取前 3 */
export function readTop(gameId) {
  const a = safeGet(K_HI + gameId, []);
  if (!Array.isArray(a)) return [];
  return a
    .filter(function (x) { return x && typeof x.score === 'number'; })
    .sort(function (p, q) { return q.score - p.score; })
    .slice(0, 3);
}

/* 最近一局（F-Sys-01 增补，v1.50）：`last_{gameId}`，只存一条。
 * ⚠ 不能从 hi_ 推导：hi_ 按分数降序截断 Top3，**最近一局若没进前三会被丢掉**
 * → 「最近一次战绩」必须单独落盘。 */
export function readLast(gameId) {
  const r = safeGet(K_LAST + gameId, null);
  if (r && typeof r.score === 'number') return r;
  /* 兼容 v1.50 之前的老存档（只有 hi_）：退化为 Top3 里时间戳最新的一条 */
  const top = readTop(gameId);
  let best = null;
  for (let i = 0; i < top.length; i += 1) {
    if (!best || (top[i].ts || 0) > (best.ts || 0)) best = top[i];
  }
  return best;
}

/* 成绩进入即落盘；返回是否新纪录 */
export function pushScore(gameId, result) {
  const top = readTop(gameId);
  const isRecord = top.length === 0 || result.score > top[0].score;
  const rec = {
    score: result.score,
    cleared: !!result.cleared,
    reachedLevel: result.reachedLevel || 0,
    durationSec: result.durationSec || 0,
    ts: Date.now(),
  };
  /* 最近一局独立落盘（不参与 Top3 截断，见 readLast 注释） */
  safeSet(K_LAST + gameId, rec);
  top.push(rec);
  top.sort(function (a, b) { return b.score - a.score; });
  safeSet(K_HI + gameId, top.slice(0, 3));
  return isRecord;
}

/* 首次引导（F-Sys-04）：tutorial_seen 按 gameId 记录 */
export function tutorialSeen(gameId) {
  const t = safeGet(K_TUT, {});
  return !!(t && t[gameId]);
}

export function markTutorialSeen(gameId) {
  const t = safeGet(K_TUT, {});
  t[gameId] = true;
  safeSet(K_TUT, t);
}

/* 游戏基准姿态（校准产物，跨页传递）：{ yaw0, pitch0, uncalibrated? } */
export function setGameBase(base) { return safeSet(K_BASE, base); }
export function getGameBase() { return safeGet(K_BASE, null); }

/* 结算数据（GameResult，随用随取） */
export function setPendingResult(r) { return safeSet(K_PENDING, r); }
export function takePendingResult() {
  const r = safeGet(K_PENDING, null);
  if (r) safeSet(K_PENDING, null);
  return r;
}

/* ── v1.16 storage 可用性探测 ──
 * 官方契约（apis-wx.md Storage methods · Error behavior）原文：
 *   "Sync storage methods throw when storage support is unavailable
 *    in the current context."
 * 而 safeGet / safeSet 为「绝不强崩」（NFR-06）把异常全部 try/catch 吞掉，
 * 于是出现**静默假阴性**：storage 不可用时写入无效、读取恒为 fallback，
 * 落地握手于是永远判定"未跳转"——即使页面真的跳过去了也会误报失败。
 * 因此显式探测一次并缓存，让调用方能区分「没跳」与「跳了但没证据」。 */
let _stoState = 0;   // 0=未探测 1=可用 -1=不可用

export function storageOk() {
  if (_stoState !== 0) return _stoState === 1;
  try {
    wx.setStorageSync('__stoProbe', 1);
    _stoState = (wx.getStorageSync('__stoProbe') === 1) ? 1 : -1;
  } catch (e) {
    _stoState = -1;
  }
  return _stoState === 1;
}

/* ── v1.13 导航落地探针 + 入口 gameId 跨页传递 ──
 * 官方契约（apis-wx.md Router methods）：navigateTo / redirectTo 只承诺
 * "requests page navigation"，且只回调 success() / complete()——**没有 fail 路径**，
 * success 是无条件回调，等于"请求已发出"，不能作为页面真的切换了的证据。
 * （真机实证：回调 nav:ok，但屏幕仍停在主页。）
 *
 * 因此改用落地握手：跳转前置 req → 目标页 onLoad 置 landed → 主页轮询
 * navLanded() 判定。gameId 同步改走 storage，不再拼在 url 的 ?query 上——
 * 宿主路由可能对带 query 的 url 做精确字符串匹配而失败。
 *
 * v1.16 双通道：storage 通道在跨页/跨 bundle 时可靠，但在 storage 不可用
 * 的上下文里彻底失效（见上）；内存通道依赖模块单例共享，若宿主把每个页面
 * 打成独立 bundle 则不共享。两通道取「或」——任一命中即认为已落地，
 * 避免单一通道失效造成假阴性。 */
const K_NAV = '__navProbe';
const K_ENTRY = '__entryGameId';
let _navMem = '';    // 内存通道

export function armNavProbe() {
  _navMem = 'req';
  return safeSet(K_NAV, 'req');
}
export function markNavLanded() {
  _navMem = 'landed';
  return safeSet(K_NAV, 'landed');
}
export function navLanded() {
  if (_navMem === 'landed') return true;
  return safeGet(K_NAV, '') === 'landed';
}
export function setEntryGameId(id) {
  return safeSet(K_ENTRY, id);
}
export function takeEntryGameId() {
  const v = safeGet(K_ENTRY, '');
  safeSet(K_ENTRY, '');
  return v || '';
}
