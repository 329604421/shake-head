# 回归测试

14 套 harness + 1 套二级页冒烟，共 **1378 条断言**，纯 node 运行，不依赖测试框架。

```bash
node tools/verify.mjs      # 推荐：语法检查 + 产物化 + 全部套件，一条命令
```

单独跑某一套：

```bash
node tests/navsim/build.mjs          # 必先产物化
node tests/navsim/harness-brick.mjs  # 再跑指定套件
```

## 为什么不用 Jest / Vitest

- **要跑的是宿主代码本身**。页面模块 `import wx from 'wx'`，这个模块在 node 里不存在；
  `build.mjs` 会把 `from 'wx'` 改写成 `../wx-mock.mjs`，得到一份可加载的副本。
  这一步是产物的生成过程，不是简单的模块替换，框架反而碍事。
- **断言要能读**。项目里很多规则是"数值落在某个区间"或"源码里不许出现某个字符串"，
  自己写 8 行 `check()` 比配一堆 matcher 更直白。
- 零依赖 ⇒ CI 不用装包，30 秒出结果。

## 目录

```
tests/navsim/
├── build.mjs              # 产物化：同步 utils/*.js → wx mock 版，改写页面导入
├── wx-mock.mjs            # wx API 替身（存储 / 导航 / 画布上下文记录）
├── audio-mock.mjs         # audio 模块替身（Sound / AudioPlayer）
├── harness.mjs            # 主页
├── harness-game.mjs       # 游戏框架页
├── harness-{brick,egg,marble,missile,plane}.mjs   # 五款游戏
├── harness-{ready,records,settings,sfx}.mjs       # 交互页与音效
├── harness-{imu-warm,imu-latency}.mjs             # 头控手感
├── harness-nosto.mjs      # 存储完全不可用（独立进程，避免污染同进程状态）
├── smoke-secondary.mjs    # 四个二级页启动链 + 导航死链
├── utils/ pages/          # ← build 产物，已被 .gitignore 忽略
```

`wx-mock.mjs` 会记录每一次绘制调用（矩形、文字、透明度），所以"画面画对了没有"
可以断言，而不只是"函数没抛错"——例如"砖块内部有 4 处砖面细节"这种就是数矩形。

## 写新断言的三条经验

1. **成对测**。只测一个方向会误判：延迟优化可能把幅度吃掉，灵敏度提高可能放大零漂。
2. **别让判据依赖"用户不动"**。任何以"信号平稳"为前提的收敛判断，都会和真实操作互斥。
3. **能静态检查的也进回归**。`import 'audio'` 白名单、页面 `export default`、
   几何常量不重复定义——这些读源码 + 正则钉死，比人工 review 可靠。

新增交互页时，**必须同时新增一套 harness**（≥100 项，含页面级断言），
否则 CI 绿了也不代表这个页面是对的。
