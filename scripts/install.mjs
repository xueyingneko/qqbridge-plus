#!/usr/bin/env node
/**
 * dsh-plugin-qqbridge-plus 安装器。
 *
 * 它做的事（每一步都幂等，重复跑不会重复写入）：
 *   1. 克隆 / 更新仓库
 *   2. 装上唯一的 npm 依赖（@deepseek-ai/schemastery）
 *   3. 把包注册进 DSH profile 的 package.json（dependencies + dsh.profile.bundles）
 *   4. 在 profile 的 cordis.patch.yml 里加插件 entry（缺了就加，有了就跳过）
 *   5. 让包管理器建好 profile 里的 node_modules 链接
 *   6. 检查跨仓库依赖：qq-bridge
 *
 * ⚠️ 两条安全约定：
 *   · 改 profile 的 package.json / cordis.patch.yml **之前先备份**（带时间戳）。
 *   · 默认**干跑**？不。但提供 --dry-run，建议第一次先跑它看一眼会改什么。
 *
 * 为什么第 4 步不能省：包内自带的 cordis.patch.yml 只描述"这个 bundle 有哪些行"，
 * 真正让 loader 建出 entry 的是 profile 层的 patch。只做第 3 步的现象是
 * 插件管理器报 installed=true、行配置齐全，但工具根本不存在，且没有任何报错。
 *
 * 用法：
 *   node install.mjs --repo <git url> [--dir <克隆目录>] [--profile desktop|web]
 *                    [--bridge-dir <qq-bridge 路径>] [--dry-run] [--no-install]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PKG_NAME = 'dsh-plugin-qqbridge-plus';
// 克隆目录名与**仓库名**保持一致（仓库叫 qqbridge-plus）。
// 包名（PKG_NAME）是另一回事：它出现在 profile 的 dependencies / bundles / patch 的 name 字段里，
// 改名会连锁破坏安装，所以只对齐目录、不动包名。
const REPO_DIR_NAME = 'qqbridge-plus';
const PATCH_MARKER = `# === ${PKG_NAME} (managed by install.mjs) ===`;

// ── 参数 ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const opts = {
  repo: arg('repo'),
  dir: path.resolve(arg('dir', path.join(os.homedir(), 'dsh-plugins', REPO_DIR_NAME))),
  profile: arg('profile'),
  bridgeDir: arg('bridge-dir'),
  dryRun: has('dry-run'),
  noInstall: has('no-install'),
  help: has('help') || argv.includes('-h'),
};

if (opts.help) {
  console.log(`用法: node install.mjs --repo <git url> [选项]

选项：
  --repo <url>         插件仓库地址（必填，除了已经克隆好的情况）
  --dir <path>         克隆到哪（默认 ~/dsh-plugins/${REPO_DIR_NAME}）
  --profile <name>     目标 DSH profile（默认自动探测，取 desktop）
  --bridge-dir <path>  qq-bridge 路径（会写进插件配置；留空则用默认值）
  --dry-run            只打印将要做的改动，不写任何文件
  --no-install         跳过包管理器安装（只改配置文件）
  -h, --help           显示本帮助
`);
  process.exit(0);
}

const log = (m) => console.log(m);
const step = (n, m) => console.log(`\n[${n}] ${m}`);
const warn = (m) => console.log(`  ⚠️  ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);

/** 备份文件（带时间戳），返回备份路径。 */
function backup(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, dest);
  return dest;
}

/** 原子写文本：临时文件 + rename，避免写一半被别的进程读到。 */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/** 跑一个命令，返回 {ok, out}。 */
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), status: r.status };
}

// ── 0. 环境检查 ───────────────────────────────────────────────────────────────
step(0, '环境检查');
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 18) {
  console.error(`  ✗ Node 版本过低：${process.versions.node}，需要 ≥ 18`);
  process.exit(1);
}
ok(`Node ${process.versions.node}`);

const dshHome = path.join(os.homedir(), '.dsh');
const profilesDir = path.join(dshHome, 'profiles');
if (!fs.existsSync(profilesDir)) {
  console.error(`  ✗ 找不到 DSH profiles 目录：${profilesDir}`);
  console.error('    请先安装并至少启动一次 DeepSeek Harness。');
  process.exit(1);
}
const profiles = fs.readdirSync(profilesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);
ok(`DSH profiles: ${profiles.join(', ') || '(无)'}`);

// profile 选择：显式 > 默认 desktop > 唯一可用的那个
let profile = opts.profile;
if (!profile) {
  profile = profiles.includes('desktop') ? 'desktop' : profiles[0];
}
if (!profile || !profiles.includes(profile)) {
  console.error(`  ✗ profile「${profile ?? '(空)'}」不存在。可用：${profiles.join(', ')}`);
  process.exit(1);
}
const profileDir = path.join(profilesDir, profile);
const profilePkgPath = path.join(profileDir, 'package.json');
const profilePatchPath = path.join(profileDir, 'cordis.patch.yml');
ok(`目标 profile: ${profile}`);
if (!fs.existsSync(profilePkgPath)) {
  console.error(`  ✗ 该 profile 没有 package.json：${profilePkgPath}`);
  process.exit(1);
}

// 跨仓库依赖：qq-bridge
const bridgeDir = opts.bridgeDir || path.join(path.dirname(opts.dir), 'qq-bridge');
const bridgeLooksOk = fs.existsSync(path.join(bridgeDir, 'config.json'))
  && fs.existsSync(path.join(bridgeDir, 'src', 'bridge.js'));
if (bridgeLooksOk) ok(`qq-bridge: ${bridgeDir}`);
else warn(`没在 ${bridgeDir} 找到 qq-bridge（缺 config.json 或 src/bridge.js）`);
log('     本插件直接 import qq-bridge 的模块，所以它必须先装好；稍后可用 --bridge-dir 指定。');

// ── 1. 取到插件代码 ───────────────────────────────────────────────────────────
step(1, '获取插件代码');
const alreadyHere = fs.existsSync(path.join(opts.dir, 'lib', 'index.js'));
if (alreadyHere) {
  ok(`已存在：${opts.dir}`);
  if (fs.existsSync(path.join(opts.dir, '.git')) && !opts.dryRun) {
    const r = run('git', ['pull', '--ff-only'], opts.dir);
    r.ok ? ok('git pull 完成') : warn(`git pull 未成功（不影响继续）：${r.out.split('\n')[0]}`);
  }
} else if (opts.repo) {
  if (opts.dryRun) {
    log(`  [dry-run] 会执行：git clone ${opts.repo} ${opts.dir}`);
    // 干跑时也要能继续检查后面的步骤，所以这里不退出，只标记
  } else {
    fs.mkdirSync(path.dirname(opts.dir), { recursive: true });
    const r = run('git', ['clone', '--depth', '1', opts.repo, opts.dir]);
    if (!r.ok) {
      console.error(`  ✗ git clone 失败：\n${r.out}`);
      process.exit(1);
    }
    ok(`已克隆到 ${opts.dir}`);
  }
} else {
  console.error(`  ✗ ${opts.dir} 里没有插件代码，且没给 --repo`);
  process.exit(1);
}

// ── 2. 插件自身的依赖 ─────────────────────────────────────────────────────────
step(2, '安装插件依赖（@napi-rs/canvas——成绩图要用）');
if (opts.noInstall) {
  warn('--no-install：跳过');
} else if (opts.dryRun) {
  log(`  [dry-run] 会在 ${opts.dir} 执行包管理器 install`);
} else if (alreadyHere || fs.existsSync(path.join(opts.dir, 'package.json'))) {
  // 优先 pnpm（DSH profile 用 pnpm，插件本身用哪个都行）
  const pm = run('pnpm', ['--version']).ok ? 'pnpm' : (run('npm', ['--version']).ok ? 'npm' : null);
  if (!pm) {
    warn('找不到 pnpm 或 npm，请自行在插件目录执行 install');
  } else {
    const r = run(pm, ['install', '--no-audit', '--no-fund'], opts.dir);
    r.ok ? ok(`${pm} install 完成`) : warn(`${pm} install 失败：${r.out.split('\n').slice(-3).join(' / ')}`);

    // 装完必须**实测能渲染**，而不是只看"命令返回 0"。
    // 理由：@napi-rs/canvas 是原生模块（N-API 预编译），在少数平台/架构上可能装到却加载失败。
    // 只报"install 成功"会让人以为出图可用，直到用户真的查分时才发现——那种失败很晚才暴露。
    const probe = path.join(opts.dir, '.canvas-probe.mjs');
    try {
      fs.writeFileSync(probe, [
        "import { createCanvas } from '@napi-rs/canvas';",
        "const c = createCanvas(16, 16);",
        "c.getContext('2d').fillRect(0, 0, 8, 8);",
        "const b = c.toBuffer('image/png');",
        "if (!b || b.length < 50) throw new Error('渲染输出异常');",
        "console.log('ok:' + b.length);",
      ].join('\n'), 'utf8');
      const p = run('node', [probe], opts.dir);
      if (p.ok && /ok:\d+/.test(p.out)) {
        ok('成绩图可用（已实测渲染出一张 PNG）');
      } else {
        warn(`画图库装了但无法渲染（成绩图会不可用，查分与搜曲不受影响）：${p.out.split('\n').slice(-2).join(' / ')}`);
      }
    } catch (e) {
      warn(`渲染自检失败（不影响查分）：${e?.message ?? e}`);
    } finally {
      try { fs.rmSync(probe, { force: true }); } catch { /* 清理失败不影响流程 */ }
    }
  }
}

// ── 3. 注册进 profile ────────────────────────────────────────────────────────
step(3, `注册进 profile「${profile}」`);
const profilePkg = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'));
profilePkg.dependencies ??= {};
profilePkg.dsh ??= {};
profilePkg.dsh.profile ??= {};
profilePkg.dsh.profile.bundles ??= [];

const wantDep = `link:${opts.dir.replace(/\\/g, '/')}`;
const changes = [];
if (profilePkg.dependencies[PKG_NAME] !== wantDep) {
  changes.push(`dependencies["${PKG_NAME}"]: ${profilePkg.dependencies[PKG_NAME] ?? '(无)'} → ${wantDep}`);
  profilePkg.dependencies[PKG_NAME] = wantDep;
}
if (!profilePkg.dsh.profile.bundles.includes(PKG_NAME)) {
  changes.push(`dsh.profile.bundles: 追加 "${PKG_NAME}"`);
  profilePkg.dsh.profile.bundles.push(PKG_NAME);
}

if (!changes.length) {
  ok('package.json 已是最新，无需改动');
} else {
  for (const c of changes) log(`  · ${c}`);
  if (opts.dryRun) {
    log('  [dry-run] 未写入');
  } else {
    const bak = backup(profilePkgPath);
    writeAtomic(profilePkgPath, JSON.stringify(profilePkg, null, 2) + '\n');
    ok(`已写入（备份：${path.basename(bak)}）`);
  }
}

// ── 4. 加 profile 层的 cordis.patch.yml entry ────────────────────────────────
step(4, '加 cordis.patch.yml entry（少了这步工具不会出现）');
const patchEntry = [
  PATCH_MARKER,
  `- id: qqbridge-plus`,
  `  name: '${PKG_NAME}'`,
  `  config:`,
  `    bridgeDir: '${(opts.bridgeDir || bridgeDir).replace(/\\/g, '/')}'`,
  `    consoleBase: 'http://127.0.0.1:3100'`,
  `    personaSection: true`,
  `    sectionOrder: 7`,
  ``,
].join('\n');

let patchText = fs.existsSync(profilePatchPath) ? fs.readFileSync(profilePatchPath, 'utf8') : '';
// 两种"已经装了"的判据都要认：我们自己的 marker，或已有同 id 的 entry
const alreadyPatch = patchText.includes(PATCH_MARKER)
  || /^- id:\s*qqbridge-plus\s*$/m.test(patchText);

if (alreadyPatch) {
  ok('cordis.patch.yml 里已有 qqbridge-plus，跳过');
} else {
  log(`  · 会往 ${path.basename(profilePatchPath)} 追加一条 entry`);
  if (opts.dryRun) {
    log('  [dry-run] 未写入');
  } else {
    if (fs.existsSync(profilePatchPath)) backup(profilePatchPath);
    const sep = patchText && !patchText.endsWith('\n') ? '\n' : '';
    writeAtomic(profilePatchPath, `${patchText}${sep}\n${patchEntry}`);
    ok('已追加');
  }
}

// ── 5. 让包管理器建好链接 ────────────────────────────────────────────────────
step(5, '在 profile 里建立 node_modules 链接');
if (opts.noInstall) {
  warn('--no-install：跳过');
} else if (opts.dryRun) {
  log(`  [dry-run] 会在 ${profileDir} 执行包管理器 install`);
} else {
  const pm = run('pnpm', ['--version']).ok ? 'pnpm' : (run('npm', ['--version']).ok ? 'npm' : null);
  if (!pm) {
    warn('找不到包管理器，请自行在 profile 目录执行 install');
  } else {
    // pnpm 会按 profile 自己的 lockfile 装；插件是 link: 依赖，建的是符号链接
    const r = run(pm, ['install', '--prefer-offline'], profileDir);
    r.ok ? ok(`${pm} install 完成`) : warn(`${pm} install 返回非零：${r.out.split('\n').slice(-3).join(' / ')}`);
    const linkPath = path.join(profileDir, 'node_modules', PKG_NAME, 'lib', 'index.js');
    fs.existsSync(linkPath)
      ? ok(`链接就绪：node_modules/${PKG_NAME}`)
      : warn(`链接没建出来（${linkPath} 不存在），插件可能无法装配`);
  }
}

// ── 6. 收尾 ──────────────────────────────────────────────────────────────────
step(6, '收尾');
if (opts.dryRun) {
  log('\n这是干跑，什么都没改。去掉 --dry-run 就会真正执行。');
} else {
  log('\n安装完成。接下来：');
  log(`  1. 重启 DSH（改 profile 配置后必须重启才会装配）`);
  log(`     确认插件进来了：查看 DSH 日志，或问 AI 跑 qqbridge 工具的 features action`);
  log(`  2. 想让管理员在 QQ 里改开关，在 qq-bridge 的 config.json 加：`);
  log(`       "featureCommand": { "triggers": ["#功能","#开关"], "baseUrl": "http://127.0.0.1:19387" },`);
  log(`       "helpCommand": { "triggers": ["#帮助","#help"] }`);
  log(`     然后重启 qq-bridge。`);
  log(`\n  若要卸载：从 profile 的 package.json 删掉 dependencies 与 bundles 里的 ${PKG_NAME}，`);
  log(`  再删掉 cordis.patch.yml 里带 "${PATCH_MARKER.trim()}" 标记的那条 entry。`);
  log(`\n  排查：插件写 ${path.join(bridgeDir, 'state', 'plugin-apply.json')} 记录装配过程。`);
}
