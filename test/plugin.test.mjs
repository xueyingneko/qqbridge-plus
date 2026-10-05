// QQbridge plus 插件的离线/联机回归。
//
// 为什么需要一个插件级测试：这个插件的全部价值在于"**与桥接行为一致**"——
// 判定逻辑必须来自 qq-bridge 的模块，而不是自己重写一份。所以这里重点钉三件事：
//   ① 模块解析层正确（bridgeDir 归一、令牌解析、控制台可达性判定不抛错）；
//   ② 桥接纯模块能被真实加载，且关键函数签名可用；
//   ③ 工具分发在"桥接在跑"与"桥接没跑"两种情况下都给出**可读结论**而不是异常。
//
// 跑法：node scripts/... 或 node test/plugin.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_BRIDGE_DIR,
  looksLikeBridge,
  makeContext,
  readBridgeConfig,
  resolveBridgeDir,
  resolveConsoleToken,
  callConsole
} from '../lib/bridge.js';
import { ACTIONS, runAction } from '../lib/tools.js';
import {
  FEATURE_KEYS,
  normalizeFeatures,
  unknownFeatureKeys
} from '../lib/features.js';
import { Config, DEFAULTS, HAS_SCHEMASTERy } from '../lib/config-schema.js';

const BRIDGE = 'F:/router/qq-bridge';
let passed = 0;
const failures = [];
async function ok(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error?.message ?? error}`);
    console.log(`  ❌ ${name}\n     ${error?.message ?? error}`);
  }
}

console.log('== QQbridge plus · 模块解析层 ==');

await ok('默认 bridgeDir 是 qq-bridge 根目录', () => {
  assert.equal(resolveBridgeDir(undefined), path.resolve(DEFAULT_BRIDGE_DIR));
  assert.equal(resolveBridgeDir(''), path.resolve(DEFAULT_BRIDGE_DIR));
});
await ok('相对路径被归一成绝对路径', () => {
  const r = resolveBridgeDir('./qq-bridge');
  assert.ok(path.isAbsolute(r), r);
});
await ok('looksLikeBridge 认得出真桥接目录', () => {
  assert.equal(looksLikeBridge(BRIDGE), true, `期望 ${BRIDGE} 是 qq-bridge 目录`);
});
await ok('looksLikeBridge 对不存在/空目录返回 false（不抛）', () => {
  assert.equal(looksLikeBridge('F:/router/definitely-not-here'), false);
  assert.equal(looksLikeBridge(os.tmpdir()), false);
});
await ok('readBridgeConfig 能读出 config.json 且含已知键', () => {
  const cfg = readBridgeConfig(BRIDGE);
  assert.ok(cfg && typeof cfg === 'object', '读不到 config.json');
  assert.ok(cfg.dsh && typeof cfg.dsh === 'object', 'config 缺 dsh 段');
});
await ok('readBridgeConfig 对坏路径返回 null（不抛）', () => {
  assert.equal(readBridgeConfig('F:/router/definitely-not-here'), null);
});
await ok('显式 token 优先于 state 文件', () => {
  assert.equal(resolveConsoleToken(BRIDGE, 'explicit-token-123'), 'explicit-token-123');
});
await ok('未给 token 时回退到 bridgeDir/state/console-token', () => {
  const t = resolveConsoleToken(BRIDGE, '');
  // 桥接跑过就会有该文件；没有也不该抛错
  assert.equal(typeof t, 'string');
  if (fs.existsSync(path.join(BRIDGE, 'state', 'console-token'))) {
    assert.ok(t.length > 0, 'state/console-token 存在却没读到内容');
  }
});
await ok('callConsole 控制台不可达时返回 {ok:false} 而不是抛错', async () => {
  const r = await callConsole({ base: 'http://127.0.0.1:1', token: 'x', path: '/api/status', timeoutMs: 1500 });
  assert.equal(r.ok, false);
  assert.ok(typeof r.error === 'string' && r.error.length > 0, '应带可读错误');
});
await ok('makeContext 产出目录/基址/令牌三个字段', () => {
  const c = makeContext({ bridgeDir: BRIDGE, timeoutMs: 1234 });
  assert.equal(c.dir, path.resolve(BRIDGE));
  assert.equal(c.base, 'http://127.0.0.1:3100');
  assert.equal(c.timeoutMs, 1234);
  assert.equal(typeof c.token, 'string');
});

console.log('\n== 桥接纯模块：必须能真实加载（这是"不重复实现"的保证）==');

const wf = await import(new URL(`file:///${BRIDGE}/src/wake-filters.mjs`).href).catch((e) => ({ __error: e }));
const wb = await import(new URL(`file:///${BRIDGE}/src/whale-balance.js`).href).catch((e) => ({ __error: e }));

await ok('加载 src/wake-filters.mjs', () => {
  assert.ok(!wf.__error, wf.__error?.message);
});
await ok('wake-filters 导出插件依赖的全部函数', () => {
  for (const fn of ['resolveBillingPhase', 'checkHolidayTableCoverage', 'parseHolidayNotice', 'matchWakeKeyword', 'evaluateBalanceAlarm', 'formatDurationCn', 'normalizePeakWindows']) {
    assert.equal(typeof wf[fn], 'function', `缺 ${fn}`);
  }
});
await ok('加载 src/whale-balance.js', () => {
  assert.ok(!wb.__error, wb.__error?.message);
});
await ok('whale-balance 导出插件依赖的全部函数', () => {
  for (const fn of ['readBalanceObservation', 'money', 'judge', 'createBalanceWatcher', 'defaultLedgerPaths']) {
    assert.equal(typeof wb[fn], 'function', `缺 ${fn}`);
  }
});
await ok('复用桥接判定：工作日 10:00 判高峰（口径与桥接一致）', () => {
  const atBJ = (y, mo, d, h) => Date.UTC(y, mo - 1, d, h - 8, 0);
  const r = wf.resolveBillingPhase({ now: atBJ(2026, 10, 8, 10), offsetHours: 8, peakWindows: [[9, 12], [14, 18]], holidays: [], adjustedWorkdays: [] });
  assert.equal(r.peak, true);
  assert.equal(r.reason, 'window');
});

console.log('\n== 工具分发：两种环境都必须给出可读结论 ==');

const ctx = makeContext({ bridgeDir: BRIDGE });
await ok('未知 action → 明确列出可用 action（不抛）', async () => {
  const out = await runAction(ctx, 'nope', {});
  assert.match(out, /未知 action/);
  for (const a of ACTIONS) assert.ok(out.includes(a), `提示里应含 ${a}`);
});
await ok('bridgeDir 不对 → 给出"不像 qq-bridge"的可读提示', async () => {
  const bad = makeContext({ bridgeDir: os.tmpdir() });
  const out = await runAction(bad, 'status', {});
  assert.match(out, /不像 qq-bridge/);
  assert.match(out, /bridgeDir/);
});
await ok('status：无论桥接在不在跑，都返回含关键小节的可读文本', async () => {
  const out = await runAction(ctx, 'status', {});
  assert.ok(out.length > 40, '输出太短');
  assert.match(out, /QQbridge plus · 运行态/);
  assert.match(out, /余额/);
  assert.match(out, /推理档位/);
  assert.match(out, /会话/);
});
await ok('balance：读出真实账本（或明确说明读不到）', async () => {
  const out = await runAction(ctx, 'balance', {});
  if (/读不到余额账本/.test(out)) {
    assert.match(out, /挂件|候选路径/);
  } else {
    assert.match(out, /余额：¥/);
    assert.match(out, /观测：/);
  }
});
await ok('schedule：给出当前时段与档位，且 testAt 可试算', async () => {
  const out = await runAction(ctx, 'schedule', { testAt: [Date.UTC(2026, 9, 8, 2, 0)] });
  assert.match(out, /高峰窗口/);
  assert.match(out, /现在：/);
  assert.match(out, /试算：/);
  assert.match(out, /高峰|空闲/);
});
await ok('holidays：给出覆盖年份与是否缺失', async () => {
  const out = await runAction(ctx, 'holidays', {});
  assert.match(out, /已覆盖：/);
  assert.match(out, /本次检查范围：/);
  assert.match(out, /覆盖正常|缺 .* 年/);
});
await ok('greeting：列出开机/关机配置与目标', async () => {
  const out = await runAction(ctx, 'greeting', {});
  assert.match(out, /开机：/);
  assert.match(out, /关机：/);
  assert.match(out, /发送目标：/);
});
await ok('commands：列出管理命令与管理员', async () => {
  const out = await runAction(ctx, 'commands', {});
  assert.match(out, /管理员 ownerQQ/);
  assert.match(out, /余额查询触发词/);
  assert.match(out, /关机触发词/);
});
await ok('config：摘要不泄漏令牌（脱敏生效）', async () => {
  const out = await runAction(ctx, 'config', {});
  const cfg = readBridgeConfig(BRIDGE);
  const token = cfg?.snowluma?.accessToken;
  if (token && token.length > 8) {
    assert.ok(!out.includes(token), '摘要里出现了未脱敏的 accessToken！');
  }
  assert.match(out, /桥接配置摘要/);
});
await ok('config+key：可取子段', async () => {
  const out = await runAction(ctx, 'config', { key: 'role.balanceAlarm' });
  assert.match(out, /config\.json · role\.balanceAlarm/);
});
await ok('config+不存在的 key → 明确失败', async () => {
  const out = await runAction(ctx, 'config', { key: 'no.such.key' });
  assert.match(out, /没有 no\.such\.key/);
});

console.log('\n== 功能开关 ==');

await ok('FEATURE_KEYS 覆盖全部业务 action', () => {
  // features 自身是开关自查入口，不需要自己的开关
  for (const k of FEATURE_KEYS) assert.ok(ACTIONS.includes(k), `action 列表缺 ${k}`);
  assert.deepEqual(FEATURE_KEYS.filter((k) => k === 'features'), []);
});
await ok('未配置 features → 全开（与加开关前行为一致）', () => {
  const f = normalizeFeatures(undefined);
  for (const k of FEATURE_KEYS) assert.equal(f[k], true, `${k} 应为开`);
});
await ok('显式关掉单个功能', () => {
  const f = normalizeFeatures({ balance: false });
  assert.equal(f.balance, false);
  assert.equal(f.status, true, '未提及的功能应保持默认开');
});
await ok('"*" 作兜底：默认关，只开指定的', () => {
  const f = normalizeFeatures({ '*': false, status: true, balance: true });
  assert.equal(f.status, true);
  assert.equal(f.balance, true);
  assert.equal(f.schedule, false);
  assert.equal(f.holidays, false);
});
await ok('"*" 为 true 时可全开（且逐项覆盖优先于兜底）', () => {
  const f = normalizeFeatures({ '*': true, config: false });
  assert.equal(f.config, false, '逐项应覆盖兜底');
  assert.equal(f.greeting, true);
});
await ok('非法值（非布尔）被忽略，不误关功能', () => {
  const f = normalizeFeatures({ balance: 'no', schedule: 0, holidays: null });
  for (const k of FEATURE_KEYS) assert.equal(f[k], true, `${k} 不该被非布尔值关掉`);
});
await ok('拼错的键能被识别出来（否则"设了没生效"极难查）', () => {
  assert.deepEqual(unknownFeatureKeys({ scheduler: false, balanc: true }), ['scheduler', 'balanc']);
  assert.deepEqual(unknownFeatureKeys({ '*': false, balance: true }), [], '"*" 是合法键');
});

await ok('关闭后调用该 action → 明确告知已关闭（而非静默或报未知 action）', async () => {
  const off = { ...makeContext({ bridgeDir: BRIDGE }), features: normalizeFeatures({ balance: false }) };
  const out = await runAction(off, 'balance', {});
  assert.match(out, /已在插件配置里关闭/);
  assert.match(out, /features: \{ balance: true \}/, '应给出开启方式');
  assert.ok(!/余额：¥/.test(out), '关闭后不该再去取余额数据');
});
await ok('关闭 balance 不影响其它 action', async () => {
  const off = { ...makeContext({ bridgeDir: BRIDGE }), features: normalizeFeatures({ balance: false }) };
  const out = await runAction(off, 'commands', {});
  assert.ok(!/已在插件配置里关闭/.test(out), 'commands 不该被关掉');
  assert.match(out, /管理员 ownerQQ/);
});
await ok('status 在子功能关闭时明确标注，而不是静默留空', async () => {
  const off = { ...makeContext({ bridgeDir: BRIDGE }), features: normalizeFeatures({ balance: false, schedule: false }) };
  const out = await runAction(off, 'status', {});
  assert.match(out, /功能开关：/, 'status 应带开关清单');
  assert.match(out, /⛔balance/);
  assert.match(out, /⛔ 已关闭（features\.balance=false）/);
  assert.match(out, /⛔ 已关闭（features\.schedule=false）/);
});
await ok('features action 自身不受开关控制（否则关掉就再也查不到）', async () => {
  const allOff = { ...makeContext({ bridgeDir: BRIDGE }), features: normalizeFeatures({ '*': false }) };
  const out = await runAction(allOff, 'features', {});
  assert.match(out, /功能开关/);
  assert.match(out, /⛔ 关闭/);
  assert.ok(!/已在插件配置里关闭/.test(out), 'features 自身不该被门禁拦下');
});
await ok('features action 列出全部功能键', async () => {
  const out = await runAction(ctx, 'features', {});
  for (const k of FEATURE_KEYS) assert.ok(out.includes(k), `清单缺 ${k}`);
});
await ok('未挂 features 的 ctx（旧调用方）不会崩，且功能默认可用', async () => {
  const legacy = makeContext({ bridgeDir: BRIDGE }); // 故意不带 features
  const out = await runAction(legacy, 'commands', {});
  assert.match(out, /管理员 ownerQQ/);
});

console.log('\n== 首次运行引导 ==');

await ok('非首次运行：firstRun 说明状态并给出重看方法', async () => {
  const out = await runAction(ctx, 'firstRun', {});
  assert.match(out, /首次运行引导/);
  assert.match(out, /plugin-first-run\.json/, '应告知重看方式');
});
await ok('首次运行引导：指引改配置文件，并说明设置页只读', async () => {
  const first = {
    ...makeContext({ bridgeDir: BRIDGE }),
    isFirstRun: true,
    firstRunAt: '2026-10-05T10:00:00.000Z'
  };
  const out = await runAction(first, 'firstRun', {});
  assert.match(out, /cordis\.patch\.yml/, '应指引配置文件');
  assert.match(out, /只能查看、不能修改/, '必须说明设置页只读，否则用户去点了会发现改不动');
  assert.ok(!/保存即生效/.test(out), '面板已只读，不该再说"保存即生效"');
  assert.match(out, /首次装配时间：2026-10-05/);
});
await ok('首次那一轮的边界：isFirstRun=true 但 firstRunAt 为空也要显示引导', async () => {
  // 回归守护：曾经只判 firstRunAt，导致"首次"这一轮恰好不显示引导。
  const edge = { ...makeContext({ bridgeDir: BRIDGE }), isFirstRun: true, firstRunAt: null };
  const out = await runAction(edge, 'firstRun', {});
  assert.match(out, /首次运行/, 'isFirstRun 为真就该显示');
  assert.match(out, /cordis\.patch\.yml/);
  assert.ok(!/首次装配时间：null/.test(out), '不该渲染出 null');
});
await ok('之后的轮次（只有 firstRunAt）仍然显示引导', async () => {
  const later = { ...makeContext({ bridgeDir: BRIDGE }), isFirstRun: false, firstRunAt: '2026-10-05T10:00:00.000Z' };
  const out = await runAction(later, 'firstRun', {});
  assert.match(out, /cordis\.patch\.yml/);
  assert.ok(!/不是首次运行/.test(out), '有 firstRunAt 就不该说"不是首次运行"');
});
await ok('首次运行：features 输出也带引导（用户查开关时必然看到）', async () => {
  const first = {
    ...makeContext({ bridgeDir: BRIDGE }),
    features: normalizeFeatures(undefined),
    isFirstRun: true,
    firstRunAt: '2026-10-05T10:00:00.000Z'
  };
  const out = await runAction(first, 'features', {});
  assert.match(out, /首次运行/, 'features 应附引导');
  assert.match(out, /cordis\.patch\.yml/);
});
await ok('firstRun 自身不受开关控制（否则关掉就找不回引导）', async () => {
  const allOff = { ...makeContext({ bridgeDir: BRIDGE }), features: normalizeFeatures({ '*': false }) };
  const out = await runAction(allOff, 'firstRun', {});
  assert.ok(!/已在插件配置里关闭/.test(out), 'firstRun 不该被门禁拦下');
});
await ok('firstRun / features 都在 action 枚举里（工具面可发现）', () => {
  assert.ok(ACTIONS.includes('firstRun'), 'ACTIONS 缺 firstRun');
  assert.ok(ACTIONS.includes('features'), 'ACTIONS 缺 features');
});

console.log('\n== Config schema（DSH 设置页靠它开面板）==');

// 拿到 schemastery 时才校验 schema 形状；拿不到是**合法降级**（Config=undefined，
// 插件照常工作、只是设置页没有这些字段），此时不该判失败——但降级本身要有断言。
if (!HAS_SCHEMASTERy) {
  await ok('未拿到 schemastery → **优雅降级**：Config=undefined 且 DEFAULTS 仍完整可用', () => {
    assert.equal(Config, undefined, '降级时不该导出 Config（也不该在导入期抛错）');
    // 关键：降级不能连带把默认值弄坏——那会让 apply 里的兜底一起失效
    assert.equal(DEFAULTS.bridgeDir, 'F:/router/qq-bridge');
    assert.equal(DEFAULTS.sectionOrder, 7);
    for (const k of FEATURE_KEYS) assert.equal(DEFAULTS.features[k], true, `${k} 默认应开`);
  });
  console.log('  ⓘ 未解析到 schemastery，已跳过 schema 形状校验（跑 npm install 后会执行）');
} else {
await ok('Config 是 schemastery schema（普通对象会让 entry 在 apply 前就失败）', () => {
  assert.equal(typeof Config, 'function', 'schema 应可调用');
  assert.ok(Config.dict && typeof Config.dict === 'object', '应有字段字典');
});
await ok('Config 字段名覆盖全部 DEFAULTS 键（避免 loader 校验组合行时被拒）', () => {
  const schemaFields = Object.keys(Config.dict ?? {});
  for (const k of Object.keys(DEFAULTS)) assert.ok(schemaFields.includes(k), `schema 缺字段 ${k}`);
  assert.equal(schemaFields.length, Object.keys(DEFAULTS).length, '字段数应一致');
});
await ok('features 子 schema 覆盖全部功能键', () => {
  const keys = Object.keys(Config.dict.features?.dict ?? {});
  for (const k of FEATURE_KEYS) assert.ok(keys.includes(k), `features schema 缺 ${k}`);
});
await ok('**不得有任何 volatile 字段**（volatile 会让 loader 把配置求值成 {}，保存即损坏）', () => {
  // 这条是最重要的一条回归守护，依据是实测出来的 rawConfig：
  //   loader 用本 schema 求值 entry 配置后，带 volatile 的字段全变成 {}，
  //   于是 bridgeDir/consoleToken 等会被写回成 {}，插件当场坏掉。
  // "能写坏配置的 UI" 比 "只读 UI" 更糟 —— 所以这里断言一个 volatile 都不能有。
  // 真要恢复可写，必须先把嵌套摊平成顶层键，并实测"保存后 rawConfig 仍是真实值"。
  const volatileFields = Object.entries(Config.dict ?? {})
    .filter(([, f]) => f?.meta?.volatile === true).map(([k]) => k);
  assert.deepEqual(volatileFields, [],
    `不该有 volatile 字段（${volatileFields.join(',')}）——会让 loader 把配置求值成 {}`);
  const features = Config.dict?.features;
  const inner = Object.entries(features?.dict ?? {})
    .filter(([, sub]) => sub?.meta?.volatile === true).map(([k]) => k);
  assert.deepEqual(inner, [], `features 内层 ${inner.join(',')} 是 volatile`);
});
await ok('默认值必须走常量、不能靠 schema 求值（带 volatile 的字段求值会返回 {}）', () => {
  // 这条是**回归守护**：若有人把 DEFAULTS 改回"从 Config 求值"就会失败。
  for (const [k, v] of Object.entries(DEFAULTS)) {
    assert.notDeepEqual(v, {}, `${k} 变成了 {} —— 多半是改用 schema 求值了（见 config-schema.js 坑记录）`);
  }
  assert.equal(DEFAULTS.bridgeDir, 'F:/router/qq-bridge');
  assert.equal(DEFAULTS.timeoutMs, 8000);
});
await ok('DEFAULTS.features 齐全且全开', () => {
  for (const k of FEATURE_KEYS) assert.equal(DEFAULTS.features[k], true, `${k} 默认应开`);
});
} // ← HAS_SCHEMASTERy 分支结束

console.log(`\n${failures.length ? `❌ ${failures.length} 项失败\n- ${failures.join('\n- ')}` : `🎉 全部通过（${passed} 项）`}`);
process.exit(failures.length ? 1 : 0);
