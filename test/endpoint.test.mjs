// HTTP 端点的测试：通用 action 转发 + 出图下载。
//
// 这两条路由是"在 QQ 里发命令就能查分"的通路，所以重点是**边界**：
//   · 没鉴权 / 非回环 → 必须拒（它能触发任意 action，裸奔等于把工具面交出去）
//   · /action 的 action 名缺失 → 明确报错，而不是跑一个空 action
//   · /image 只能取本插件生成的图 → ../ 穿越、子路径、非 png 都要挡掉
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerFeatureApi, ROUTE_PREFIX } from '../lib/http-api.js';
import { createFeatureStore } from '../lib/feature-store.js';
import { FEATURE_DEFAULTS } from '../lib/features.js';
import { runAction } from '../lib/tools.js';
import { imageDir, saveImage } from '../lib/maimai/action.js';

let passed = 0;
const failures = [];
const ok = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failures.push(`${name}: ${e?.message ?? e}`); console.log(`  ❌ ${name}\n     ${e?.message ?? e}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qbp-endpoint-test-'));

function harness({ token = 'good-token', remote = '127.0.0.1', ctx = {}, withRunAction = true } = {}) {
  const store = createFeatureStore({ stateDir: tmp, fromConfig: { ...FEATURE_DEFAULTS } });
  const routes = [];
  const webServer = { register: (route) => { routes.push(route); return () => {}; } };
  registerFeatureApi({
    webServer, store, token, log: () => {},
    ctx: { maimai: {}, stateDir: tmp, features: store.effective, ...ctx },
    runAction: withRunAction ? runAction : null,
  });

  const call = async ({ method = 'GET', url = `${ROUTE_PREFIX}/features`, headers = {}, body, remoteAddress = remote } = {}) => {
    const req = {
      method, url, headers,
      socket: { remoteAddress },
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8'); },
    };
    const res = {
      statusCode: 0, headers: null, chunks: [],
      writeHead(code, h) { this.statusCode = code; this.headers = h; },
      end(chunk) { if (chunk) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); },
    };
    // 用**按 pathname 找路由**的方式派发，而不是"记住最后一次注册的那条"。
    // 这不是模拟细节：真实 webServer 就是按具体路径键匹配的，而这正是
    // /action 当初不可达的原因——测试若只记住最后一条路由，就永远发现不了。
    const pathname = String(url).split('?')[0];
    const hit = routes.find((r) => r.kind === 'exact' && r.path === pathname)
      ?? routes.find((r) => r.kind === 'prefix' && pathname.startsWith(r.path));
    assert.ok(hit, `没有路由匹配 ${method} ${pathname}`);
    await hit.handler(req, res);
    const buf = Buffer.concat(res.chunks);
    let json = null;
    try { json = JSON.parse(buf.toString('utf8')); } catch { /* 二进制响应不是 JSON */ }
    return { status: res.statusCode, headers: res.headers, json, buf };
  };
  return { call, store, routes: () => routes };
}

const auth = { 'x-qqbridge-token': 'good-token' };

console.log('== 路由注册形状（这条曾让新端点完全走不到）==');

await ok('每条用到的子路径都被显式登记', async () => {
  const { routes } = harness();
  const paths = routes().map((r) => r.path);
  // 实测结论：注册的 `path` 是**具体路由键**，前缀语义并不会把子路径一起带进来。
  // 只登记 /features 时，/action 与 /image 会落到 fallback，表现为 405/404——
  // 而 /features 一切正常，极具误导性。
  for (const need of [
    `${ROUTE_PREFIX}/features`,
    `${ROUTE_PREFIX}/features/set`,
    `${ROUTE_PREFIX}/features/reset`,
    `${ROUTE_PREFIX}/action`,
    `${ROUTE_PREFIX}/image`,
  ]) {
    assert.ok(paths.includes(need), `缺少路由 ${need}，该端点将不可达（会落到 fallback）`);
  }
});
await ok('还登记了前缀路由兜住尾斜杠等变体', async () => {
  const { routes } = harness();
  const prefix = routes().filter((r) => r.kind === 'prefix');
  assert.ok(prefix.length >= 1, '需要一条 prefix 兜住 /qqbridge-plus/xxx/ 这类变体');
  assert.ok(prefix.some((r) => `${ROUTE_PREFIX}/features/`.startsWith(r.path)), 'prefix 应能覆盖尾斜杠形式');
});
await ok('所有路由共用同一个 handler（分发在内部按 pathname 做）', async () => {
  const { routes } = harness();
  const hs = new Set(routes().map((r) => r.handler));
  assert.equal(hs.size, 1, '应该是同一个 handler，否则维护两份分发逻辑必然漂移');
});
await ok('返回的注销函数能撤掉全部路由', async () => {
  // ctx.effect 卸载时会调用它；漏撤会残留路由，热重载后表现为重复注册或走错 handler。
  // 这里给每条注册发一个**只属于它自己**的注销函数，就能精确核对"是不是每条都撤了"，
  // 而不是数一个全局计数（那种写法会被"每次注册都新建闭包"带偏）。
  const disposes = [];
  const store = createFeatureStore({ stateDir: tmp, fromConfig: { ...FEATURE_DEFAULTS } });
  const dispose = registerFeatureApi({
    webServer: { register: () => { const d = () => { d.called = true; }; disposes.push(d); return d; } },
    store, token: 't', log: () => {}, ctx: { maimai: {}, stateDir: tmp }, runAction,
  });
  assert.ok(disposes.length >= 5, `应登记多条路由，实际 ${disposes.length}`);
  assert.ok(disposes.every((d) => !d.called), '注销前不该被调用');
  dispose();
  assert.ok(disposes.every((d) => d.called === true), `每条路由都应被撤销，未撤：${disposes.filter((d) => !d.called).length} 条`);
});

console.log('== /qqbridge-plus/action ==');

await ok('无令牌 → 401（它能触发任意 action，绝不能裸奔）', async () => {
  const { call } = harness();
  const r = await call({ method: 'POST', url: `${ROUTE_PREFIX}/action`, body: { action: 'status' } });
  assert.equal(r.status, 401);
});
await ok('非回环地址 → 403', async () => {
  const { call } = harness({ remote: '10.0.0.5' });
  const r = await call({ method: 'POST', url: `${ROUTE_PREFIX}/action`, headers: auth, body: { action: 'status' } });
  assert.equal(r.status, 403);
});
await ok('令牌不符 → 401', async () => {
  const { call } = harness();
  const r = await call({ method: 'POST', url: `${ROUTE_PREFIX}/action`, headers: { 'x-qqbridge-token': 'wrong' }, body: { action: 'status' } });
  assert.equal(r.status, 401);
});
await ok('缺 action → 400（而不是跑一个空 action）', async () => {
  const { call } = harness();
  const r = await call({ method: 'POST', url: `${ROUTE_PREFIX}/action`, headers: auth, body: {} });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /缺少 action/);
});
await ok('未知 action → 200 但文本里明确说未知（工具层自己的口径）', async () => {
  const { call } = harness();
  const r = await call({ method: 'POST', url: `${ROUTE_PREFIX}/action`, headers: auth, body: { action: 'nope' } });
  assert.equal(r.status, 200);
  assert.match(r.json.text, /未知 action/);
});
await ok('真的能跑通 action：maimai status（不联网、不依赖桥接）', async () => {
  const { call } = harness();
  const r = await call({ method: 'POST', url: `${ROUTE_PREFIX}/action`, headers: auth, body: { action: 'maimai', args: { sub: 'status' } } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.match(r.json.text, /舞萌DX 查分/);
  assert.match(r.json.text, /OAuth/, '应报告 OAuth 是否配置');
});
await ok('maimai 不受"桥接不可用"影响（与 qq-bridge 解耦）', async () => {
  // ctx 里**故意**不放 bridgeDir —— 若 maimai 被桥接探测拦住，这里会得到错误
  const { call } = harness({ ctx: { maimai: {}, stateDir: tmp } });
  const r = await call({ method: 'POST', url: `${ROUTE_PREFIX}/action`, headers: auth, body: { action: 'maimai', args: { sub: 'status' } } });
  assert.match(r.json.text, /舞萌DX 查分/);
  assert.ok(!/bridgeDir/.test(r.json.text), '不该被桥接目录问题挡住');
});
await ok('未提供 runAction 时 → 501，而不是静默 404', async () => {
  const { call } = harness({ withRunAction: false });
  const r = await call({ method: 'POST', url: `${ROUTE_PREFIX}/action`, headers: auth, body: { action: 'status' } });
  assert.equal(r.status, 501);
  assert.match(r.json.error, /未提供 action 端点/);
});
await ok('args 缺省时把整个 body 当 args（容忍扁平写法）', async () => {
  const { call } = harness();
  const r = await call({ method: 'POST', url: `${ROUTE_PREFIX}/action`, headers: auth, body: { action: 'maimai', sub: 'status' } });
  assert.equal(r.status, 200);
  assert.match(r.json.text, /舞萌DX 查分/);
});

console.log('\n== /qqbridge-plus/image ==');

await ok('能取回真实生成的图，且 content-type 是 image/png', async () => {
  // 造一个真 PNG（8 字节魔数就够 readFileSync 与 content-type 判定）
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const saved = saveImage(png, 'b50');
  assert.equal(saved.ok, true, saved.error);
  const { call } = harness();
  const r = await call({ url: `${ROUTE_PREFIX}/image?file=${encodeURIComponent(path.basename(saved.file))}`, headers: auth });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'image/png');
  assert.deepEqual(r.buf, png);
});
await ok('无令牌 → 401', async () => {
  const { call } = harness();
  const r = await call({ url: `${ROUTE_PREFIX}/image?file=x.png` });
  assert.equal(r.status, 401);
});
await ok('拒绝路径穿越（../）', async () => {
  const { call } = harness();
  for (const bad of ['../secret.png', '..%2Fsecret.png', 'a/b.png', '/etc/passwd.png', 'C:\\x.png']) {
    const r = await call({ url: `${ROUTE_PREFIX}/image?file=${encodeURIComponent(bad)}`, headers: auth });
    assert.ok(r.status === 400 || r.status === 404, `${bad} 应被拒，实际 ${r.status}`);
    assert.notEqual(r.headers?.['content-type'], 'image/png', `${bad} 不该返回图片`);
  }
});
await ok('拒绝非 .png 后缀', async () => {
  const { call } = harness();
  for (const bad of ['x.txt', 'x.exe', 'x.js', '.png']) {
    const r = await call({ url: `${ROUTE_PREFIX}/image?file=${encodeURIComponent(bad)}`, headers: auth });
    assert.equal(r.status, 400, `${bad} 应 400，实际 ${r.status}`);
  }
});
await ok('文件不存在 → 404', async () => {
  const { call } = harness();
  const r = await call({ url: `${ROUTE_PREFIX}/image?file=nonexistent-abc123.png`, headers: auth });
  assert.equal(r.status, 404);
});
await ok('缺 file 参数 → 400', async () => {
  const { call } = harness();
  const r = await call({ url: `${ROUTE_PREFIX}/image`, headers: auth });
  assert.equal(r.status, 400);
});
await ok('取到的文件确实在出图目录下（不是任意路径）', async () => {
  const png = Buffer.from('89504e470d0a1a0affff', 'hex');
  const saved = saveImage(png, 'b50');
  assert.ok(path.resolve(saved.file).startsWith(path.resolve(imageDir())));
});

console.log('\n== 既有路由未被改动破坏 ==');

await ok('GET /features 仍然可用', async () => {
  const { call } = harness();
  const r = await call({ url: `${ROUTE_PREFIX}/features`, headers: auth });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.ok(r.json.text);
});
await ok('未知路由仍是 404', async () => {
  const { call } = harness();
  const r = await call({ url: `${ROUTE_PREFIX}/nope`, headers: auth });
  assert.equal(r.status, 404);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures.length ? `❌ ${failures.length} 项失败\n- ${failures.join('\n- ')}` : `🎉 全部通过（${passed} 项）`}`);
process.exit(failures.length ? 1 : 0);
