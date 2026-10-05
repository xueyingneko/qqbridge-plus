// 「管理员在 QQ 内开关功能」的插件侧测试：运行时存储 + HTTP 端点。
//
// 最要紧的是**鉴权**：这个端点能让工具面变宽（config 摘要、余额、会话列表都在里面）。
// 一旦无鉴权可达，本机任意进程都能把它全打开，所以下面每条拒绝路径都要有断言。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFeatureStore, readOverrides, writeOverrides } from '../lib/feature-store.js';
import { registerFeatureApi } from '../lib/http-api.js';
import { FEATURE_DEFAULTS, FEATURE_KEYS } from '../lib/features.js';

let passed = 0;
const failures = [];
const ok = (name, fn) => {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (error) { failures.push(`${name}: ${error?.message ?? error}`); console.log(`  ❌ ${name}\n     ${error?.message ?? error}`); }
};
const tmpStateDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qqbp-state-'));

console.log('== 运行时开关存储 ==');

ok('初始：无覆盖文件时按配置/默认全开', () => {
  const dir = tmpStateDir();
  const s = createFeatureStore({ stateDir: dir, fromConfig: { ...FEATURE_DEFAULTS } });
  for (const k of FEATURE_KEYS) assert.equal(s.effective[k], true, `${k} 应开`);
  fs.rmSync(dir, { recursive: true, force: true });
});
ok('set 会就地改生效值并落盘', () => {
  const dir = tmpStateDir();
  const s = createFeatureStore({ stateDir: dir, fromConfig: { ...FEATURE_DEFAULTS } });
  assert.deepEqual(s.set('balance', false), { ok: true });
  assert.equal(s.effective.balance, false, '生效值必须就地改变（门禁读的就是它）');
  assert.deepEqual(readOverrides(dir).overrides, { balance: false }, '必须落盘');
  fs.rmSync(dir, { recursive: true, force: true });
});
ok('重新装配后覆盖仍然生效（持久性）', () => {
  const dir = tmpStateDir();
  const a = createFeatureStore({ stateDir: dir, fromConfig: { ...FEATURE_DEFAULTS } });
  a.set('holidays', false);
  const b = createFeatureStore({ stateDir: dir, fromConfig: { ...FEATURE_DEFAULTS } });
  assert.equal(b.effective.holidays, false, '重启后应保留管理员的选择');
  fs.rmSync(dir, { recursive: true, force: true });
});
ok('运行时覆盖优先于组合行配置', () => {
  const dir = tmpStateDir();
  writeOverrides(dir, { schedule: false });
  // 配置说开、覆盖说关 ⇒ 覆盖赢（"管理员在 QQ 里改过的"压过"配置里写的"）
  const s = createFeatureStore({ stateDir: dir, fromConfig: { ...FEATURE_DEFAULTS, schedule: true } });
  assert.equal(s.effective.schedule, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
ok('未知键被拒（不写入垃圾键）', () => {
  const dir = tmpStateDir();
  const s = createFeatureStore({ stateDir: dir, fromConfig: { ...FEATURE_DEFAULTS } });
  assert.equal(s.set('nope', false).ok, false);
  assert.deepEqual(readOverrides(dir).overrides, {}, '不该落盘任何东西');
  fs.rmSync(dir, { recursive: true, force: true });
});
ok('非布尔值被拒（避免 "no"/0 之类被当真）', () => {
  const dir = tmpStateDir();
  const s = createFeatureStore({ stateDir: dir, fromConfig: { ...FEATURE_DEFAULTS } });
  assert.equal(s.set('balance', 'no').ok, false);
  assert.equal(s.effective.balance, true, '不该被改动');
  fs.rmSync(dir, { recursive: true, force: true });
});
ok('reset 清空覆盖并回到配置值', () => {
  const dir = tmpStateDir();
  const s = createFeatureStore({ stateDir: dir, fromConfig: { ...FEATURE_DEFAULTS } });
  s.set('balance', false);
  assert.deepEqual(s.reset(), { ok: true });
  assert.equal(s.effective.balance, true);
  assert.deepEqual(readOverrides(dir).overrides, {});
  fs.rmSync(dir, { recursive: true, force: true });
});
ok('**覆盖文件损坏时不能拖垮插件**（按无覆盖处理并记录原因）', () => {
  const dir = tmpStateDir();
  fs.writeFileSync(path.join(dir, 'plugin-features.json'), '{ 这不是 JSON', 'utf8');
  const s = createFeatureStore({ stateDir: dir, fromConfig: { ...FEATURE_DEFAULTS } });
  for (const k of FEATURE_KEYS) assert.equal(s.effective[k], true, '损坏时应回退到默认，而不是崩');
  assert.ok(s.readError, '应把读取失败的原因带出来');
  fs.rmSync(dir, { recursive: true, force: true });
});
ok('render 标出哪些值来自运行时覆盖', () => {
  const dir = tmpStateDir();
  const s = createFeatureStore({ stateDir: dir, fromConfig: { ...FEATURE_DEFAULTS } });
  s.set('balance', false);
  const text = s.render();
  assert.match(text, /⛔ 关闭\s+balance/);
  assert.match(text, /\*/, '来自覆盖的行应带标记');
  assert.match(text, /已关闭：balance/);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('\n== HTTP 端点 ==');

/** 构造一个假的 webServer + 一对 req/res，跑一次请求。 */
function harness({ token = 'good-token', remoteAddress = '127.0.0.1' } = {}) {
  const dir = tmpStateDir();
  const store = createFeatureStore({ stateDir: dir, fromConfig: { ...FEATURE_DEFAULTS } });
  let captured = null;
  const webServer = { register: (route) => { captured = route; return () => {}; } };
  registerFeatureApi({ webServer, store, token, log: () => {} });

  const call = async ({ method = 'GET', url = '/qqbridge-plus/features', headers = {}, body, remote = remoteAddress }) => {
    const req = {
      method,
      url,
      headers,
      socket: { remoteAddress: remote },
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8');
      }
    };
    const res = {
      statusCode: 0, headers: null, payload: '',
      writeHead(code, h) { this.statusCode = code; this.headers = h; },
      end(chunk) { this.payload += chunk ? String(chunk) : ''; }
    };
    await captured.handler(req, res);
    let json = null;
    try { json = JSON.parse(res.payload); } catch {}
    return { status: res.statusCode, json, raw: res.payload };
  };
  return { call, store, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const h = harness();

await ok('无令牌 → 401（端点绝不能裸奔）', async () => {
  const r = await h.call({ method: 'GET' });
  assert.equal(r.status, 401);
  assert.match(r.json.error, /令牌/);
});
await ok('错误令牌 → 401', async () => {
  const r = await h.call({ method: 'GET', headers: { 'x-qqbridge-token': 'wrong' } });
  assert.equal(r.status, 401);
});
await ok('长度相同但内容不同的令牌 → 401（定长比较不放水）', async () => {
  const r = await h.call({ method: 'GET', headers: { 'x-qqbridge-token': 'good-tokeX' } });
  assert.equal(r.status, 401);
});
await ok('非回环来源 → 403（即便令牌正确）', async () => {
  const r = await h.call({ method: 'GET', headers: { 'x-qqbridge-token': 'good-token' }, remote: '192.168.1.50' });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /本机/);
});
await ok('正确令牌 + 本机 → 200 并返回开关清单', async () => {
  const r = await h.call({ method: 'GET', headers: { 'x-qqbridge-token': 'good-token' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.match(r.json.text, /功能开关/);
  assert.equal(r.json.features.balance, true);
});
await ok('也可经 query 传令牌（便于手工 curl 排查）', async () => {
  const r = await h.call({ method: 'GET', url: '/qqbridge-plus/features?token=good-token' });
  assert.equal(r.status, 200);
});
await ok('POST set 关闭某功能 → 生效值改变', async () => {
  const r = await h.call({
    method: 'POST', url: '/qqbridge-plus/features/set',
    headers: { 'x-qqbridge-token': 'good-token' }, body: { key: 'balance', value: false }
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.features.balance, false);
  assert.equal(h.store.effective.balance, false, '插件的生效值必须同步改变');
});
await ok('POST set 未知键 → 400（不静默成功）', async () => {
  const r = await h.call({
    method: 'POST', url: '/qqbridge-plus/features/set',
    headers: { 'x-qqbridge-token': 'good-token' }, body: { key: 'nope', value: false }
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /未知功能键/);
});
await ok('POST reset → 覆盖被清空', async () => {
  const r = await h.call({ method: 'POST', url: '/qqbridge-plus/features/reset', headers: { 'x-qqbridge-token': 'good-token' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.features.balance, true);
});
await ok('尾斜杠容忍', async () => {
  const r = await h.call({ method: 'GET', url: '/qqbridge-plus/features/', headers: { 'x-qqbridge-token': 'good-token' } });
  assert.equal(r.status, 200);
});
await ok('未知路由 → 404 且带上可用键提示', async () => {
  const r = await h.call({ method: 'GET', url: '/qqbridge-plus/nope', headers: { 'x-qqbridge-token': 'good-token' } });
  assert.equal(r.status, 404);
  assert.ok(Array.isArray(r.json.keys));
});
await ok('无令牌时**不注册端点**（fail-closed，而不是注册无鉴权端点）', () => {
  let registered = false;
  const dispose = registerFeatureApi({
    webServer: { register: () => { registered = true; return () => {}; } },
    store: createFeatureStore({ stateDir: tmpStateDir(), fromConfig: { ...FEATURE_DEFAULTS } }),
    token: '',
    log: () => {}
  });
  assert.equal(registered, false, '没有令牌就不该注册');
  assert.equal(typeof dispose, 'function');
});

h.cleanup();

console.log(`\n${failures.length ? `❌ ${failures.length} 项失败\n- ${failures.join('\n- ')}` : `🎉 全部通过（${passed} 项）`}`);
process.exit(failures.length ? 1 : 0);
