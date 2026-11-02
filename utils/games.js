/* games.js —— GameManifest 清单（PRD-01 §11）
 * F-HOME-01：ringPos 与 difficultyRank 必须与需求表逐项一致，主页不做容错映射。
 *
 * 【交互 v1.9 · 主页框架阶段】除退出外 7 个入口统一指向 pages/game/game
 * （A7 游戏&功能框架页），由 gameId 参数区分功能；框架页内完成菜单选择
 * （A8 二向菜单：退回主页 / 重新进入）。records/settings 各自二级页暂不
 * 从主页直达（页面文件与路由保留，后续功能开发阶段再启用）。
 *
 * 【游戏逐个落地 · page 字段分流】游戏一款一款开发，为免每落地一款就要
 * 改动共用的框架页，**已落地的游戏改指自己的页面**，未落地的仍指框架页。
 *   bricks   → pages/brick/brick（PRD-02 已落地，框架页复刻 + 玩法模块）
 *   egg      → pages/eggcatch/eggcatch（PRD-03 已落地 · 相机版 v1.29）
 *   plane    → pages/plane/plane（PRD-06 已落地 · 相机版 v1.30）
 *   marble   → pages/marble/marble（PRD-04 已落地 · 增量位移型 v1.31）
 *   missile  → pages/missile/missile（PRD-05 已落地 · 相机版 v1.32）
 *
 * ⚠ marble 与另四款是**同一相机模型、不同驱动方式**：横向都是「元素恒钉
 *   屏幕中心 + 画面反向平移」，但 marble 走增量位移棘轮（rel 通道），另四款
 *   走偏角直控（snap 通道）。改任一款的横向逻辑时**不要**顺手改另一款。
 * 后续每款照此办理：复制框架页 → 换玩法模块 → 改本文件该条的 page。
 *
 * 【tapRole 字段（PRD-05 §8 引入，F-MSL-72）】声明该游戏 PLAY 态单击的
 *   语义：'menu' = 单击唤菜单（缺省）；'fire' = 单击是游戏动作、菜单改用
 *   滑动唤出。**已落地的 fire 游戏（missile / plane）在自己页面内分流**
 *   （页面里 onTap 给动作、onSwipe 给菜单），本字段是**声明性**的 ——
 *   供框架页未来接入与后续维护者识别。删掉它不会让游戏失效，但会让
 *   「这款游戏单击是干什么的」从 manifest 里再也看不出来。
 *
 * 【v1.52 · brief / ops 字段】五款游戏的**游玩提示弹窗**（进游戏 / 重开时
 *   模态显示，见 layout.READY）文案：
 *     brief  简要说明，≤50 字（弹窗内自动折行，最多 3 行）
 *     ops    操作说明，≤3 行（每行 ≤29 字，否则会被 READY.opsMax 截断）
 *   文案放在 manifest 而不是各页面：弹窗由 `utils/gamepage.js` 统一绘制，
 *   五个页面零重复；且与 `tutorialLine` / `axisLabel` 同处一份清单，改玩法
 *   时不会漏改某一处说明。⚠ 改玩法必须同步这里，否则提示会教错操作。
 */

export const ENTRIES = [
  {
    id: 'bricks', name: '打砖块', ringPos: 'LT', difficultyRank: 1,
    /* F-BRK-91：教学文案以本册为准（球自动发射，无需任何手部操作）。
     * 相机版 v1.26：挡板恒钉屏幕中心，转头平移的是画面而非挡板 —— 文案
     * 必须说清这一点，否则用户会去找「挡板在哪」。 */
    axisLabel: '单轴 · 左右转头', tutorialLine: '转头平移画面，挡板恒在中央',
    iconId: 'bricks', kind: 'game', page: 'pages/brick/brick',
    /* v1.52 游玩提示：brief ≤50 字（弹窗自动折行），ops ≤3 行。 */
    brief: '球自动发射，挡板恒钉屏幕中央。左右转头平移画面接球，击碎全部砖块即通关；漏球扣命，三条命用尽结束。',
    ops: ['左右转头 = 平移画面，挡板恒在中央', '单击触控 = 唤出暂停菜单'],
  },
  {
    id: 'egg', name: '接鸡蛋', ringPos: 'T', difficultyRank: 2,
    /* 相机版 v1.29（2026-09-04）：与打砖块同一改造——碗恒钉屏幕中心，
     * 转头平移的是画面而非蛋篮。文案必须说清这一点，否则用户会去找
     * 「碗在哪」。抬头仍是直控（接取高度 → 得分倍率）。 */
    axisLabel: '双轴 · 转头平移 + 抬头接高',
    tutorialLine: '转头平移画面，抬头接得更高分',
    iconId: 'egg', kind: 'game', page: 'pages/eggcatch/eggcatch',
    brief: '篮子恒钉屏幕中央，鸡蛋从上落下。转头平移画面接球，抬头接得越高倍率越高；接到炸弹扣分，漏接三次结束。',
    ops: ['左右转头 = 平移画面，篮子恒在中央', '抬头 = 抬高接取点，越高倍率越高', '单击触控 = 唤出暂停菜单'],
  },
  {
    id: 'marble', name: '滚球迷宫', ringPos: 'RT', difficultyRank: 3,
    /* 相机版 v1.31（2026-09-05，PRD-04 V1.0-r6 落地）：与另三款**同源但不同
     * 型** —— 横向同样是「球恒钉屏幕中心、转头平移的是画面」，但驱动方式是
     * **增量位移棘轮**（另三款是偏角直控）。手感差别必须说清：
     *   本作头停即停、回摆不回退，可像「划船」一样来回摆动无限推进，
     *   **无需维持静态偏转**（其余四款需要）。文案若不提「划船式」，用户
     *   会按直控的习惯去"保持转头角度"，然后发现球不动。
     * 另需点明 AIM 前置阶段：**先转头把准星对准小球，单击才开跑**。 */
    axisLabel: '双轴 · 转头平移（划船式）',
    tutorialLine: '对准小球单击开始 · 转头平移画面',
    iconId: 'marble', kind: 'game', page: 'pages/marble/marble',
    brief: '小球恒钉屏幕中央，转头以划船式平移迷宫：头停即停、回摆不回退。先对准小球单击开跑，滚到终点即通关。',
    ops: ['左右转头 = 平移画面（划船式，回摆不回退）', '开局先对准小球，单击开跑', '单击触控 = 唤出暂停菜单'],
  },
  {
    id: 'missile', name: '导弹指挥部', ringPos: 'L', difficultyRank: 4,
    /* 相机版 v1.32（2026-09-05，PRD-05 V1.0-r6 落地）：与打砖块 / 接鸡蛋 /
     * 打飞机**同一套**「横向锚定相机 + 纵向直控」，推翻 r5 的双轴 1:1 直控。
     *   横向（yaw）：十字光标**恒钉屏幕中心 x=240**，转头平移的是**画面**。
     *   纵向（pitch）：光标高度直控（行程 ±80），抬头 = 抬高拦截高度。
     * 文案必须说清「光标恒在中央」——否则用户会去找「准星在哪」。
     * 触控：单击 = 引爆拦截雷、滑动 = 唤出 B2 菜单（tapRole='fire'）。 */
    axisLabel: '双轴 · 转头平移 + 抬头瞄准',
    tutorialLine: '转头平移画面，抬头调高度，单击引爆',
    iconId: 'missile', kind: 'game', page: 'pages/missile/missile',
    tapRole: 'fire',
    brief: '准星恒钉屏幕中央，敌弹从上方来袭。转头平移画面对准，抬头抬高拦截高度，单击引爆拦截雷守住六座城市。',
    ops: ['左右转头 = 平移画面，准星恒在中央', '抬头 / 低头 = 调节拦截高度', '单击 = 引爆拦截雷；滑动 = 唤出菜单'],
  },
  {
    id: 'plane', name: '打飞机', ringPos: 'R', difficultyRank: 5,
    /* 相机版 v1.30（2026-09-05）：与打砖块 / 接鸡蛋同一改造 —— 机体恒钉
     * 屏幕中心，转头平移的是**画面**而非机体。文案必须说清这一点，否则
     * 用户会去找「飞机在哪」。抬头低头仍直控（纵向机动 / 拉开与编队距离），
     * 但行程已由 260px 收窄到 80px（同样是防眩晕）。
     * 触控：单击 = 投弹、滑动 = 唤出 B2 菜单（tapRole='fire'，PRD-06 §8.1）。 */
    axisLabel: '双轴 · 转头平移 + 抬头机动',
    tutorialLine: '转头平移画面，单击投弹，滑动唤菜单',
    iconId: 'plane', kind: 'game', page: 'pages/plane/plane',
    tapRole: 'fire',
    brief: '机体恒钉屏幕中央，敌机成波次来袭。转头平移画面走位，抬头低头机动躲弹，单击投弹清场，被击中三次结束。',
    ops: ['左右转头 = 平移画面，机体恒在中央', '抬头 / 低头 = 纵向机动', '单击 = 投弹；滑动 = 唤出菜单'],
  },
  {
    /* v1.33：二级页文件一直都在，但 page 字段还指着框架占位页 —— 主页选中
     * 「战绩」实际进的是画占位框的 game.js，本页永远不可达。改指真实页面。 */
    /* v1.50：战绩页由「五款 × Top3 滚动列表」精简为「每款最近一局、五款五行
     * 一屏放下」，只读无滚动，单击返回主页 —— 文案同步改写。 */
    id: 'records', name: '战绩', ringPos: 'LB', difficultyRank: 0,
    axisLabel: '只读 · 一屏五行', tutorialLine: '查看五款游戏最近一局成绩',
    iconId: 'ranking', kind: 'system', page: 'pages/records/records',
  },
  {
    id: 'settings', name: '设置', ringPos: 'RB', difficultyRank: 0,
    /* v1.48：本页由「教学/校准/设置」长列表改为环形头控设置页，只保留
     * 灵敏度与游戏音效两项 + 返回，故轴标签与引导文案同步改写。 */
    axisLabel: '环形选择 · 灵敏度 / 音效', tutorialLine: '转头选择设置项，单击切换',
    iconId: 'settings', kind: 'system', page: 'pages/settings/settings',
  },
  {
    id: 'exit', name: '退出应用', ringPos: 'B', difficultyRank: 0,
    axisLabel: '销毁性', tutorialLine: '正下位刻意低头对准，防误触',
    iconId: 'logout', kind: 'exit', page: '',
  },
];

export const BY_RING_POS = {};
for (let i = 0; i < ENTRIES.length; i++) BY_RING_POS[ENTRIES[i].ringPos] = ENTRIES[i];

export const BY_ID = {};
for (let i = 0; i < ENTRIES.length; i++) BY_ID[ENTRIES[i].id] = ENTRIES[i];

export const GAME_IDS = ['bricks', 'egg', 'marble', 'missile', 'plane'];

export function getEntry(id) { return BY_ID[id] || null; }
