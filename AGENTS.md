# 摇头晃脑 · 头控体感游戏集合（Rokid Glasses · AIUI）

- **Name**: 摇头晃脑 · 头控体感游戏集合
- **Version**: 0.1.0
- **Permissions**: audio（音效）；network（预留，当前未使用）
- **Design source of truth**: `docs/prd/PRD-01-设计说明-主页头控交互.md`（§01~§14）

## Runtime Notes

- 目标设备：Rokid Glasses，单绿透明显示，画布固定 **480 × 352**（不可变）
- 渲染：页面 `<canvas>` + `wx.createCanvasContext(id)`，Canvas 2D，`setInterval` 33ms 节拍（≥30fps），每帧 `flush()`
- 传感器：`AbsoluteOrientationSensor` 60Hz，四元数 `[x,y,z,w]` 顺序；`stop()` 保留末次读数
- 触控板：页面级 `onKeyDown` / `onKeyUp`；**仅 `onKeyUp` 中的 `event.preventDefault()` 能拦截宿主默认行为**
- 音频：**无振荡器 API**，音效即 `assets/sfx/*.wav`（**16kHz / 16bit / 单声道**，8 个共 65KB）。
  ⚠ **不得用 8-bit PCM**：v1.43 用 8kHz/8bit 出包，真机**完全无声**——多数嵌入式／
  移动端解码器已不吃 8-bit PCM。改音色改 `tools/gen-sfx.py` 的 `SPECS` 后重跑即可。
  `utils/sfx.js` 以 `audio()` 探测一次拿全 Sound + AudioPlayer：注入值 →
  `globalThis.audio` → `globalThis.Sound` → 运行时 `require('audio')`
  （**不是 import**，失败可 catch，无解析期崩溃面）。
  **import 红线（v1.47 收窄）**：`import 'audio'` **只允许出现在
  `utils/audio-host.js` 一个文件**（`import * as ns`，兼容 ESM/CJS）。
  v1.48 起注入点为**三处**：主页 `onLoad`、游戏底座 `utils/gamepage.js`、
  设置页 `onLoad`（都在 `readSettings()` 之前 ⇒ 开机即有声），由 harness-sfx
  L4 静态白名单钉死；白名单之外任何位置不得 import，动态 `import()`
  任何位置都不得用：静态 import 解析失败会炸整条 import 链、动态 `import()`
  部分运行时解析期即失败（try-catch 救不了），两者都曾造成整页黑屏。
  拿不到构造器时静默 no-op，交互链路零感知

## 工程约定

- 视觉令牌唯一来源：`utils/theme.js`（单绿 6 级亮度、字号 6 级、两套距离分档函数）
- 几何唯一来源：`utils/layout.js`（与设计稿 / PRD-01 逐项对齐；改坐标必须三处同步）
- **IMU 冷启动预热是每页的必需项，不是主页专属**：每个页面各有自己的 `InputEngine`
  ⇒ 各自的传感器实例，而官方契约只描述**单实例**语义 ⇒ **二级页永远是一次冷启动**。
  凡有头控选择的页面（含二级页）都必须照抄主页三件套：进页起采跑满 `PRIME_MS`
（`utils/layout.js` 共享常量，2500ms）→ 预热窗口内 `resetToIdle()` **不得** `stop()`
→ `tick()` 到期收口。缺任一条都表现为「进页后 IMU 漂移且反复出现」（v1.49 修复）。
- **`wx.navigateBack()` 是宿主请求型 API**：success 是无条件回调（只承诺已发出），
  必须走对象形态 `{ delta: 1, success, fail, complete }` + **落地判定**（本页出栈后宿主
  回调 `onHide`） + **有限重试**。裸调用在真机即「单击无反应」（v1.49 修复）。
- **游戏页六态（v1.52 起）**：`S.READY` 是**开局 / 重开的第一个状态**——
  `initPlay()` 末尾挂 `_beginReady()`，弹窗**不自动关闭**，单击才 `resetBase()`
  （以当前头部姿态重建 IMU 基准）+ 3s 倒计时 → `S.PLAY`。新增/改动游戏页时，
  三处接入一个都不能少：`onTap` 首分支 `S.READY → _readyTap()`、`tick` 调
  `_tickReady(now)`、`render` 调 `drawReady(ctx, now)` 且 HUD 走 `_hudAlpha()`。
  ⚠ **弹窗期不要停传感器**：宿主可能没有定时器，渲染时钟由传感器读数驱动。
  ⚠ 玩法说明文案在 `utils/games.js` 的 `brief` / `ops`，**改玩法必须同步改**。
- **调试信息不得上屏（v1.51）**：首页原品牌胶囊下方的 11px 诊断行（跳转 url、
  IMU/音效自检）会在选择态与跳转期间把路径信息暴露给用户，已移除绘制。
  取证走 `console.log` / `_diag()` 写入的 `_diagMsg`（Craft 控制台 + harness
  断言入口），**不要再把任何调试文字画进 render**。
- **二级页右上胶囊可承载非状态口径**：`drawHud(ctx, brand, { text, dot })`
  的 `dot: null` = 不画状态圆点（圆点是状态灯，与口径类文案语义冲突），
  文字起点回落 `HUD.noDotTextX`；`true`/`false` 行为不变（v1.51）。
- **页面一律多文件模式**：`page.json` + `page.js` + `page.wxml` + `page.wxss`
  （Craft 预览器对单文件 `.ink` SFC 的模板解析静默失败，v1.0 起已全部改四件套；
  页面级 `schema` 契约也已移除——真机渲染引擎严格校验会直接闪退）
- WXML 指令：`ink:if / ink:elif / ink:else / ink:for + ink:key`
- **页面底座（v1.33 收敛，勿再复制粘贴页面骨架）**：
  - `utils/gamepage.js` → `gameBase(cfg)`：五款游戏页共用的 onLoad 护栏链、
    生命周期、B2/B3/B4 状态机、返回握手、HUD 状态、结算落盘。
    ⚠ 各页的 `tick` / `render` / `onTap` / `statusText` **故意留在页面里**——
    harness 的源码契约锁（P5/P7/P8 组）直接扫页面源码，锁死分册差异
    （双 fade、MENU_FADE 取值、`update()` 在 `rel()` 之前、有无 grantGrace）。
  - `utils/pagebase.js` → `bootStandard()` + `lifecycle()`：战绩 / 设置 /
    结算 / 校准四个二级页共用的启动链与生命周期。
