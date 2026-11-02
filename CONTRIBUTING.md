# 贡献指南

这个项目是单人维护的，但欢迎 issue 与 PR。为了让改动可被复核，请先对齐下面几条。

## 1. 先确认改的是哪一层

| 层 | 位置 | 说明 |
|---|---|---|
| 运行时页面 | `pages/` | 每页四件套 `.json + .js + .wxml + .wxss` |
| 运行时模块 | `utils/` | 玩法、绘制、几何、输入、存储、音效 |
| 回归 | `tests/navsim/` | 14 套 harness + 1 套冒烟，1300+ 断言 |
| 工具 | `tools/` | 打包、验证、音效生成、静态站预览 |
| 文档 | `docs/` | 总章 + 6 册 PRD + 设计说明 |

**几何与视觉令牌是单点真相**：`utils/layout.js`（坐标）与 `utils/theme.js`（颜色/字号）。
改它们之前先想清楚影响面 —— 五款游戏和所有二级页都从这里取数，改一个常量可能同时动 11 个页面。

## 2. 本地跑通再提

```bash
node tools/verify.mjs      # 或 npm test：语法检查 + 产物化 + 全部 harness
```

提 PR 前这条命令必须是全绿。**新增交互页 ⇒ 必须同时新增一个 harness**（≥100 项，
含页面级断言），否则这类改动不会被任何回归覆盖。

## 3. 提交信息

采用 Conventional Commits 的结构，摘要用中文，动词开头，不加句号：

```
<type>(<scope>): <中文摘要>

<正文：为什么这么改，而不是改了什么>
```

`type` 取 `feat` `fix` `docs` `style` `refactor` `perf` `test` `build` `ci` `chore` `revert`。
一次提交只做一件事，不夹带无关的格式化。

## 4. 分支

`main` 始终可交付。改动走短生命周期分支，命名 `<type>/<kebab-case>`，
例如 `fix/imu-drift-warmup`、`feat/game-snake`。合并后删除分支。

## 5. 代码红线（这几条踩过坑，别回退）

- **定时器不是契约 API**：`setInterval` / `setTimeout` / `requestAnimationFrame`
  都不在 AIUI 的 Confirmed API Scope 里。渲染循环必须走 `utils/boot.js` 的降级链，
  且**保底首帧**无条件先画一帧 —— 最坏是静态画面，不能是黑屏。
- **`import 'audio'` 只允许出现在 `utils/audio-host.js`**，且用 `import * as ns`。
  其它位置一律不得 import，动态 `import()` 任何位置都禁用（解析期失败会炸整条 import 链）。
- **透明屏不得用黑色遮罩压暗**：变暗只能降元素自身 alpha。大面积填充 ≤12%，同屏 ≤3 个字级。
- **每个有头控的页面都要做 IMU 预热三件套**：进页起采 `PRIME_MS` → 预热窗口内不得 `stop()`
  → `tick()` 到期收口。缺一条就是「进页就漂」。
- **`wx.navigateBack()` 必须走对象形态 + 落地判定 + 有限重试**，裸调用在真机等于没反应。
- **调试信息不上屏**：取证走 `console.log` / `_diagMsg`，不要画进 `render`。

## 6. 测试怎么写

harness 是普通的 node 脚本，不依赖测试框架：

```js
import { create, update } from './utils/mygame.js';

function check(name, cond, detail) {
  R.push({ name, ok: !!cond, detail: detail || '' });
  console.log('  [' + (cond ? 'PASS' : 'FAIL') + '] ' + name);
}

check('G1 初始状态为 ready', g.state === 'ready');
```

结尾按 `process.exit(pass === total ? 0 : 1)` 退出，`tools/verify.mjs` 与 CI 靠退出码判定。
断言要能区分「真过了」和「没崩所以没报错」，别写 `check('能跑', true)`。

## 7. 不要提交

`dist/`、`node_modules/`、`.env`、任何密钥或令牌、`tests/navsim/utils/`（build 产物）。
`.gitignore` 已覆盖，提交前扫一眼 `git status`。
