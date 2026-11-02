/* 本地模拟：把所有 'wx' 导入换成可观测的 mock，其余依赖保持真实 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

/* utils/*.js 位于 navsim/utils/ → mock 在 navsim/wx-mock.mjs → '../wx-mock.mjs'
 *
 * ⚠ v1.41：原实现**只就地改写 navsim/utils 里的旧副本**，从不从源目录同步
 * —— 于是改完 utils/*.js 直接跑 harness 会拿到上一版产物（"utils 改写 0 个"
 * 就是这个坑的伪装：它只统计 wx 替换数，不代表副本是最新的）。v1.41 的
 * IMU 预热改动因此先报了 16 条假失败。
 * 现改为：先从源目录同步（顺带统一 CRLF→LF，源目录是 CRLF），再做 wx 替换。 */
const utilsDir = path.join(here, 'utils');
const srcUtils = path.join(root, 'utils');
fs.mkdirSync(utilsDir, { recursive: true });
let n = 0, synced = 0;
for (const f of fs.readdirSync(srcUtils)) {
  if (!f.endsWith('.js')) continue;
  const s = fs.readFileSync(path.join(srcUtils, f), 'utf8').replace(/\r\n?/g, '\n');
  const o = s
    .replace(/from\s+'wx'/g, "from '../wx-mock.mjs'")
    /* v1.47：audio-host.js 的 import 'audio' 在 navsim 里换成 mock
     * （真机黑屏风险面只许在真机上验，本地回归必须可加载）。 */
    .replace(/from\s+'audio'/g, "from '../audio-mock.mjs'");
  const p = path.join(utilsDir, f);
  const old = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  if (old !== o) { fs.writeFileSync(p, o, 'utf8'); synced++; }
  if (o !== s) n++;
}

/* pages/index/index.mjs 位于 navsim/pages/index/ → '../../wx-mock.mjs' */
const src = fs.readFileSync(path.join(root, 'pages/index/index.js'), 'utf8');
const out = src.replace(/from\s+'wx'/g, "from '../../wx-mock.mjs'");
fs.mkdirSync(path.join(here, 'pages/index'), { recursive: true });
fs.writeFileSync(path.join(here, 'pages/index/index.mjs'), out, 'utf8');

/* v1.21：game 页同样产物化。B4 状态机此前**零测试覆盖**（harness.mjs 只测
 * index 页），S.CONT 没有入边这件事因此藏了三个版本。harness-game.mjs 依赖
 * 真实的 pages/game/game.js 模块，故这里一并改写 wx 导入。 */
const srcG = fs.readFileSync(path.join(root, 'pages/game/game.js'), 'utf8');
const outG = srcG.replace(/from\s+'wx'/g, "from '../../wx-mock.mjs'");
fs.mkdirSync(path.join(here, 'pages/game'), { recursive: true });
fs.writeFileSync(path.join(here, 'pages/game/game.mjs'), outG, 'utf8');

/* v1.23：brick 页（第一款落地的游戏）同样产物化。它与 game 页同深度，
 * 故 wx mock 的相对路径一致。harness-brick.mjs 依赖本产物做页面级断言。 */
const srcB = fs.readFileSync(path.join(root, 'pages/brick/brick.js'), 'utf8');
const outB = srcB.replace(/from\s+'wx'/g, "from '../../wx-mock.mjs'");
fs.mkdirSync(path.join(here, 'pages/brick'), { recursive: true });
fs.writeFileSync(path.join(here, 'pages/brick/brick.mjs'), outB, 'utf8');

/* v1.29：eggcatch 页（第二款落地的游戏，PRD-03）同规格产物化。
 * harness-egg.mjs 依赖本产物做页面级断言（状态机 / statusText / 事件播音）。 */
const srcE = fs.readFileSync(path.join(root, 'pages/eggcatch/eggcatch.js'), 'utf8');
const outE = srcE.replace(/from\s+'wx'/g, "from '../../wx-mock.mjs'");
fs.mkdirSync(path.join(here, 'pages/eggcatch'), { recursive: true });
fs.writeFileSync(path.join(here, 'pages/eggcatch/eggcatch.mjs'), outE, 'utf8');

/* v1.30：plane 页（第三款落地的游戏，PRD-06 相机版）同规格产物化。
 * harness-plane.mjs 依赖本产物做页面级断言（tapRole='fire' 分流 / 冻结）。 */
const srcP = fs.readFileSync(path.join(root, 'pages/plane/plane.js'), 'utf8');
const outP = srcP.replace(/from\s+'wx'/g, "from '../../wx-mock.mjs'");
fs.mkdirSync(path.join(here, 'pages/plane'), { recursive: true });
fs.writeFileSync(path.join(here, 'pages/plane/plane.mjs'), outP, 'utf8');

/* v1.31：marble 页（第四款落地的游戏，PRD-04 增量位移型）同规格产物化。
 * harness-marble.mjs 依赖本产物做页面级断言（单击按 phase 分流 / rel 顺序 /
 * statusText 三态）。 */
const srcM = fs.readFileSync(path.join(root, 'pages/marble/marble.js'), 'utf8');
const outM = srcM.replace(/from\s+'wx'/g, "from '../../wx-mock.mjs'");
fs.mkdirSync(path.join(here, 'pages/marble'), { recursive: true });
fs.writeFileSync(path.join(here, 'pages/marble/marble.mjs'), outM);

/* v1.32：missile 页（第五款落地的游戏，PRD-05 相机版）同规格产物化。
 * harness-missile.mjs 依赖本产物做页面级断言（tapRole='fire' 分流 /
 * IMU 异常时单击 = 结束游戏 / statusText「城市 N/6」）。 */
const srcS = fs.readFileSync(path.join(root, 'pages/missile/missile.js'), 'utf8');
const outS = srcS.replace(/from\s+'wx'/g, "from '../../wx-mock.mjs'");
fs.mkdirSync(path.join(here, 'pages/missile'), { recursive: true });
fs.writeFileSync(path.join(here, 'pages/missile/missile.mjs'), outS);

console.log('build ok: utils 同步 ' + synced + ' 个 / wx 替换 ' + n + ' 个, index 改写 ' + (out !== src)
  + ', game 改写 ' + (outG !== srcG) + ', brick 改写 ' + (outB !== srcB)
  + ', eggcatch 改写 ' + (outE !== srcE) + ', plane 改写 ' + (outP !== srcP)
  + ', marble 改写 ' + (outM !== srcM) + ', missile 改写 ' + (outS !== srcS));
