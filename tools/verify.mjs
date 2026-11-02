/* verify.mjs —— 一键跑完全部本地验证
 *
 * 为什么要有：本项目的回归是 14 套 harness + 1 套二级页冒烟，共 1300+ 条断言，
 * 逐条手敲既慢又容易漏。CI 与本地都只认这一条命令：
 *
 *   node tools/verify.mjs        （或 npm test）
 *
 * 顺序不能换：先语法检查（快、定位准），再 build 产物化（把 utils/*.js 复制成
 * mock 版），最后才跑 harness —— harness 依赖 build 产物，跳步会拿到上一版。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAVSIM = path.join(ROOT, 'tests', 'navsim');

const SUITES = [
  ['harness.mjs', '主页状态机 / 环形导航 / 跳转握手'],
  ['harness-game.mjs', '游戏框架页六态 + 品牌墙'],
  ['harness-brick.mjs', '打砖块'],
  ['harness-egg.mjs', '接鸡蛋'],
  ['harness-marble.mjs', '滚球迷宫'],
  ['harness-missile.mjs', '导弹指挥部'],
  ['harness-plane.mjs', '打飞机'],
  ['harness-ready.mjs', '游玩提示弹窗（S.READY）'],
  ['harness-imu-warm.mjs', 'IMU 冷启动预热'],
  ['harness-imu-latency.mjs', '头控延迟 / 漂移 / 幅度'],
  ['harness-records.mjs', '战绩页'],
  ['harness-settings.mjs', '设置页'],
  ['harness-sfx.mjs', '音效双通道 + import 红线'],
  ['harness-nosto.mjs', '存储完全不可用'],
  ['smoke-secondary.mjs', '二级页冒烟（另起进程）'],
];

function node(args, cwd) {
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
}

/* ---------- 1. 语法检查 ---------- */
function collectJs(dir, out) {
  for (const name of fs.readdirSync(dir).sort()) {
    if (name === 'node_modules' || name === '.git' || name === 'site') continue;
    const abs = path.join(dir, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) collectJs(abs, out);
    else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(abs);
  }
  return out;
}

const files = collectJs(ROOT, []).filter(function (p) {
  const rel = path.relative(ROOT, p).replace(/\\/g, '/');
  /* tests/navsim/utils 与 pages 下是 build 产物，语法由 build 过程保证 */
  return !rel.startsWith('tests/navsim/utils/') && !/^tests\/navsim\/pages\/.*\.mjs$/.test(rel)
    && !rel.startsWith('tests/navsim/pages/');
});

let syntaxBad = 0;
for (const file of files) {
  const r = node(['--check', file], ROOT);
  if (r.status !== 0) {
    syntaxBad += 1;
    console.error('  [语法] ' + path.relative(ROOT, file).replace(/\\/g, '/'));
    console.error((r.stderr || '').split('\n').slice(0, 4).join('\n'));
  }
}
console.log('语法检查：' + (files.length - syntaxBad) + '/' + files.length + ' 通过');

/* ---------- 2. 产物化 ---------- */
console.log('\n产物化（把 utils/*.js 换成 wx mock 版）：');
const build = node(['build.mjs'], NAVSIM);
if (build.status !== 0) {
  console.error(build.stdout || '');
  console.error(build.stderr || '');
  console.error('build 失败，后续 harness 不跑（否则会拿到上一版产物）。');
  process.exit(1);
}
console.log('  ' + (build.stdout || '').trim());

/* ---------- 3. harness ---------- */
console.log('\n回归：');
let failed = 0;
let total = 0;
const rows = [];

for (const [file, label] of SUITES) {
  const r = node([file], NAVSIM);
  const out = (r.stdout || '') + (r.stderr || '');
  /* 各 harness 的汇总行有三种写法，按优先级解析，别用「第二个数字当总数」的偷懒写法
   * —— 「155 通过 / 0 失败 / 共 155 项」会把总数读成 0。 */
  let pass = 0;
  let all = 0;
  let m = out.match(/(\d+)\s*\/\s*(\d+)\s*项?通过/);
  if (m) {
    pass = Number(m[1]);
    all = Number(m[2]);
  } else {
    m = out.match(/(\d+)\s*通过\s*\/\s*(\d+)\s*失败/);
    const total = out.match(/共\s*(\d+)\s*项/);
    if (m) {
      pass = Number(m[1]);
      all = total ? Number(total[1]) : Number(m[1]) + Number(m[2]);
    }
  }
  const ok = r.status === 0;
  total += all;
  if (!ok) failed += 1;
  rows.push({ file, label, ok, pass, all });

  const mark = ok ? 'PASS' : 'FAIL';
  console.log('  [' + mark + '] ' + file.padEnd(24) + ' ' + pass + '/' + all + '  ' + label);
  if (!ok) {
    const bad = out.split('\n').filter(function (line) { return line.indexOf('[FAIL]') >= 0; });
    bad.slice(0, 10).forEach(function (line) { console.log('        ' + line.trim()); });
  }
}

console.log('\n合计：' + (SUITES.length - failed) + '/' + SUITES.length + ' 套全绿，' + total + ' 条断言');
if (failed || syntaxBad) {
  console.log('结论：有失败项，提交前必须修好。');
  process.exit(1);
}
console.log('结论：全部通过。');
