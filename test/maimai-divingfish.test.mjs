// 水鱼查分器客户端的离线测试。
//
// 重点不在"能发请求"，而在几条**安全不变量**——它们是这套授权模型能成立的前提，
// 一旦被改坏，插件就会变成"无需同意即可拉取他人成绩"的工具：
//   ① 绝不使用已弃用的开发者 token（它按 QQ 号读任意人成绩，用户无法撤销）
//   ② QQ 号只以 sha256("<client_id>:<QQ>") 摘要离开机器人
//   ③ 用户令牌只在内存缓存，不落盘；重新绑定时必须丢弃旧令牌
// 另外覆盖 OAuth 错误码的翻译（用户要能照着提示自己解决）。
import assert from 'node:assert/strict';

// 测试用的虚构 QQ 号。
// 刻意不使用真实号码：这个文件会提交进仓库，真实号码属于隐私。
// 集中定义在这里，避免散落到各条断言里——曾经就漏改过一处。
const TEST_QQ = 1234567890; // 一眼可辨的假号
const TEST_QQ_STR = String(TEST_QQ);
import {
  DEFAULTS,
  subjectRef,
  bindingLabel,
  tokenSubject,
  createTokenCache,
  normalizeConfig,
  oauthConfigured,
  createClient,
} from '../lib/maimai/divingfish.js';
import { createHash } from 'node:crypto';

let passed = 0;
const failures = [];
const ok = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failures.push(`${name}: ${e?.message ?? e}`); console.log(`  ❌ ${name}\n     ${e?.message ?? e}`); }
};

console.log('== 安全不变量 ==');

await ok('① 源码里不得出现 developer-token（已弃用、可读任意人成绩）', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../lib/maimai/divingfish.js', import.meta.url), 'utf8'));
  // 允许在注释里解释"为什么不用它"，但不允许真的拼进请求头
  const codeOnly = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  assert.ok(!/developer-token/i.test(codeOnly), '代码里出现了 developer-token');
  assert.ok(!/divingfish_token/i.test(codeOnly), '代码里出现了 divingfish_token');
});

await ok('② QQ 号只以 sha256("<client_id>:<QQ>") 形式外发', async () => {
  const ref = subjectRef(TEST_QQ, 'cid-abc');
  const expect = createHash('sha256').update(`cid-abc:${TEST_QQ}`).digest('hex');
  assert.equal(ref, expect);
  assert.equal(ref.length, 64);
  assert.ok(!ref.includes(TEST_QQ_STR), '摘要里不该出现原始 QQ 号');
});

await ok('② 换个 client_id 得到完全不同的摘要（不能跨应用关联）', async () => {
  assert.notEqual(subjectRef(12345, 'appA'), subjectRef(12345, 'appB'));
});

await ok('③ 令牌缓存不落盘、可过期、可丢弃', async () => {
  const cache = createTokenCache();
  cache.set('r1', 'tok-1', 300);
  assert.equal(cache.get('r1'), 'tok-1');
  assert.equal(cache.size(), 1);
  cache.discard('r1');
  assert.equal(cache.get('r1'), null, '丢弃后不该再取到');
  // 过期：expires_in 小于提前量时立刻视为过期
  cache.set('r2', 'tok-2', 10);
  assert.equal(cache.get('r2'), null, '扣掉 30s 提前量后应立即过期');
});

await ok('③ 重新绑定（deviceAuthorization）必须丢弃旧令牌', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init?.body });
    return { ok: true, status: 200, text: async () => JSON.stringify({ device_code: 'd', user_code: 'U', verification_uri: 'v', verification_uri_complete: 'vc', expires_in: 600 }) };
  };
  const c = createClient({ clientId: 'cid', clientSecret: 'sec' }, { fetchImpl });
  const ref = subjectRef(999, 'cid');
  c.tokenCache.set(ref, 'stale-token', 300);
  assert.equal(c.tokenCache.get(ref), 'stale-token');
  await c.deviceAuthorization(999);
  assert.equal(c.tokenCache.get(ref), null, '重新绑定后旧令牌必须被丢弃（否则会查到上一个账号）');
});

console.log('\n== 绑定身份展示 ==');

await ok('授权页展示的 QQ 做中间打码（页面可能被别人看到）', async () => {
  assert.equal(bindingLabel(TEST_QQ), 'QQ 12******90');
  assert.equal(bindingLabel(1234), 'QQ 1234');
  assert.equal(bindingLabel(123), 'QQ 123');
});
await ok('打码后不泄漏中间数字', async () => {
  const label = bindingLabel(TEST_QQ);
  // 从常量推导中间段，而不是写死旧号码的数字——改测试数据时断言会自动跟上
  const middle = TEST_QQ_STR.slice(2, -2);
  assert.ok(middle.length > 0);
  assert.ok(!label.includes(middle), `中间数字 ${middle} 不该出现`);
  assert.equal(label, `QQ ${TEST_QQ_STR.slice(0, 2)}${'*'.repeat(TEST_QQ_STR.length - 4)}${TEST_QQ_STR.slice(-2)}`);
});

console.log('\n== access token 的 sub ==');

await ok('能解出 sub（用于自洽性比对）', async () => {
  const payload = Buffer.from(JSON.stringify({ sub: 'df-user-1' }), 'utf8').toString('base64url');
  assert.equal(tokenSubject(`h.${payload}.s`), 'df-user-1');
});
await ok('回归：任意长度都要能解——填充写成 -len%4 会得到负数并抛 RangeError，被 catch 吞成 null', async () => {
  // 逐个长度试，覆盖 4 种填充余数；这是当初静默失败的藏身处
  for (let n = 0; n < 12; n++) {
    const payload = Buffer.from(JSON.stringify({ sub: `u${'x'.repeat(n)}` }), 'utf8').toString('base64url');
    assert.equal(
      tokenSubject(`h.${payload}.s`), `u${'x'.repeat(n)}`,
      `payload 长度 ${payload.length}（sub 长 ${n}）解析失败`,
    );
  }
});
await ok('回归：带 - _ 的 base64url 字符（含中文内容）能解', async () => {
  const payload = Buffer.from(JSON.stringify({ sub: '用户>?~é' }), 'utf8').toString('base64url');
  assert.ok(payload.length > 0);
  assert.equal(tokenSubject(`h.${payload}.s`), '用户>?~é');
});
await ok('畸形 token 返回 null 而不是抛错', async () => {
  assert.equal(tokenSubject(''), null);
  assert.equal(tokenSubject('not-a-jwt'), null);
  assert.equal(tokenSubject('a.!!!.c'), null);
  assert.equal(tokenSubject('a..c'), null);
  assert.equal(tokenSubject(null), null);
});

console.log('\n== 配置与降级 ==');

await ok('缺凭据时明确判定"未配置"（不发必然失败的请求）', async () => {
  assert.equal(oauthConfigured(normalizeConfig({})), false);
  assert.equal(oauthConfigured(normalizeConfig({ clientId: 'a' })), false, '只有 id 不算配置好');
  assert.equal(oauthConfigured(normalizeConfig({ clientId: 'a', clientSecret: 'b' })), true);
});
await ok('默认地址与权限范围符合原项目契约', async () => {
  assert.match(DEFAULTS.baseUrl, /^https:\/\/maimai\.diving-fish\.com\/api\/maimaidxprober$/);
  assert.match(DEFAULTS.authUrl, /^https:\/\/auth\.diving-fish\.com$/);
  assert.equal(DEFAULTS.scope, 'prober.profile.read', '默认只读资料，不含写权限');
  assert.ok(!/write/.test(DEFAULTS.scope), '默认权限里不得含 write');
});
await ok('proxy 开启时 baseUrl 走中转，authUrl 不受影响', async () => {
  const c = normalizeConfig({ proxy: true });
  assert.match(c.baseUrl, /^https:\/\/proxy\.yuzuchan\.site\/maimaidxprober$/);
  assert.match(c.authUrl, /^https:\/\/auth\.diving-fish\.com$/, '账号服务不该被中转（涉及凭据）');
});
await ok('地址末尾斜杠被归一（避免拼出 //oauth）', async () => {
  const c = normalizeConfig({ baseUrl: 'https://x.test/api///', authUrl: 'https://y.test/' });
  assert.equal(c.baseUrl, 'https://x.test/api');
  assert.equal(c.authUrl, 'https://y.test');
});

console.log('\n== OAuth 请求形状 ==');

await ok('device_authorization 带 handoff=code 与摘要，且不含明文 QQ', async () => {
  let captured = null;
  const fetchImpl = async (url, init) => { captured = { url, body: init.body }; return { ok: true, status: 200, text: async () => '{}' }; };
  const c = createClient({ clientId: 'cid', clientSecret: 'sec' }, { fetchImpl });
  await c.deviceAuthorization(TEST_QQ);
  const params = new URLSearchParams(captured.body);
  assert.equal(captured.url, 'https://auth.diving-fish.com/oauth/device_authorization');
  assert.equal(params.get('handoff'), 'code', '必须要求回填确认码，否则绑定会被转发攻击');
  assert.equal(params.get('subject_ref'), subjectRef(TEST_QQ, 'cid'));
  assert.ok(!captured.body.includes(TEST_QQ_STR), '请求体里不得出现明文 QQ 号');
  assert.equal(params.get('client_secret'), 'sec');
});

await ok('on-behalf-of 换取令牌时 subject 用 ref: 前缀', async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = init.body;
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'T', token_type: 'Bearer', expires_in: 300 }) };
  };
  const c = createClient({ clientId: 'cid', clientSecret: 'sec' }, { fetchImpl });
  const r = await c.accessToken(999);
  assert.equal(r.ok, true);
  const params = new URLSearchParams(captured);
  assert.equal(params.get('grant_type'), 'urn:diving-fish:params:oauth:grant-type:on-behalf-of');
  assert.equal(params.get('subject'), `ref:${subjectRef(999, 'cid')}`);
});
await ok('第二次取令牌命中缓存，不再发请求', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'T', token_type: 'Bearer', expires_in: 300 }) }; };
  const c = createClient({ clientId: 'cid', clientSecret: 'sec' }, { fetchImpl });
  await c.accessToken(1);
  const second = await c.accessToken(1);
  assert.equal(calls, 1, '应复用缓存');
  assert.equal(second.cached, true);
});

console.log('\n== 错误翻译（用户要能照着做）==');

const errCase = (code) => async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: code }) });
  const c = createClient({ clientId: 'cid', clientSecret: 'sec' }, { fetchImpl });
  return c.accessToken(1);
};
await ok('consent_required → 提示先去绑定', async () => {
  const r = await errCase('consent_required')();
  assert.equal(r.ok, false);
  assert.match(r.error, /绑定水鱼|授权/);
});
await ok('subject_mismatch → 提示可能是转发来的码', async () => {
  const r = await errCase('subject_mismatch')();
  assert.match(r.error, /转发/);
});
await ok('invalid_grant → 提示重新发起绑定（不区分具体原因）', async () => {
  const r = await errCase('invalid_grant')();
  assert.match(r.error, /重新发起绑定/);
});
await ok('未知错误也给出状态码，不吞掉', async () => {
  const r = await errCase('weird_error')();
  assert.match(r.error, /400/);
});
await ok('403 时提示先去绑定（自己的成绩却无权限）', async () => {
  const fetchImpl = async (url) => {
    if (/oauth\/token/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'T', expires_in: 300 }) };
    return { ok: false, status: 403, text: async () => '{}' };
  };
  const c = createClient({ clientId: 'cid', clientSecret: 'sec' }, { fetchImpl });
  const r = await c.userB50(1);
  assert.equal(r.ok, false);
  assert.match(r.error, /绑定水鱼/);
});
await ok('429 提示限流稍后再试', async () => {
  const fetchImpl = async (url) => {
    if (/oauth\/token/.test(url)) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'T', expires_in: 300 }) };
    return { ok: false, status: 429, text: async () => '{}' };
  };
  const c = createClient({ clientId: 'cid', clientSecret: 'sec' }, { fetchImpl });
  const r = await c.userB50(1);
  assert.match(r.error, /限流|稍等/);
});

console.log('\n== 公开查询（无需授权）==');

await ok('publicB50 只发 username 与 b50，不带任何令牌', async () => {
  let captured = null;
  const fetchImpl = async (url, init) => { captured = { url, body: init.body, headers: init.headers }; return { ok: true, status: 200, text: async () => JSON.stringify({ rating: 12345 }) }; };
  const c = createClient({ clientId: 'cid', clientSecret: 'sec' }, { fetchImpl });
  const r = await c.publicB50('someone');
  assert.equal(r.ok, true);
  assert.equal(captured.url, 'https://maimai.diving-fish.com/api/maimaidxprober/query/player');
  assert.deepEqual(JSON.parse(captured.body), { username: 'someone', b50: true });
  assert.equal(captured.headers.authorization, undefined, '公开查询不该带令牌');
});

console.log(`\n${failures.length ? `❌ ${failures.length} 项失败\n- ${failures.join('\n- ')}` : `🎉 全部通过（${passed} 项）`}`);
process.exit(failures.length ? 1 : 0);
