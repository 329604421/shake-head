/* audio-host.js —— 全项目唯一允许 import 'audio' 的位置（v1.47）
 *
 * 【为什么这个文件存在】v1.46 真机诊断 `NO-CTOR`：四级探测
 * （注入 → globalThis.Sound → globalThis.audio → require('audio')）全失败，
 * 宿主只可能经官方文档的具名导出暴露音频 ⇒ 只剩静态 import 一条路。
 *
 * 【崩溃面隔离】静态 import 解析失败会炸整条 import 链（v1.41 前黑屏教训）。
 * 本模块把这条链隔离到**只有 settings 页**：解析失败最多设置页黑屏（可立刻
 * 定性），主页与五款游戏零牵连。**禁止**从页面或 utils 其它文件直接
 * `import 'audio'`，也**禁止**把本模块引入除 settings 之外的页面——
 * 待真机确认可解析后，再逐步下放到 index / gamepage（届时更新本注释）。
 *
 * 【为什么用 import * as ns】`import { Sound } from 'audio'` 在具名导出
 * 缺失时是**链接期**错误，模块直接崩；`ns.Sound` 取不到只是 undefined。
 * 兼容两种形态：ESM 具名导出 / CJS（module.exports 挂在 ns.default）。
 */
import * as ns from 'audio';

function fn(v) { return typeof v === 'function' ? v : null; }
const d = ns && ns.default;

const host = {
  Sound: fn(ns && ns.Sound) || fn(d && d.Sound),
  AudioPlayer: fn(ns && ns.AudioPlayer) || fn(d && d.AudioPlayer),
};

export default host;
