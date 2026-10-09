// maimai action 层的测试。
//
// 这一层只做"取数 + 组织人话 + 可选出图"，所以测试重点不是网络，而是：
//   · 路由与参数校验（缺参数要给出可操作的话，而不是发一个必然失败的请求）
//   · OAuth 未配置时**明确拒绝**按 QQ 查自己的成绩（而不是退回开发者 token）
//   · 出图失败不得让整个查询失败（图是附加价值，不是主功能）
//   · 与 qq-bridge 解耦：桥接不可用也不该影响查分
// 全部依赖注入，不碰网络。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { actionMaimai, saveImage, imageDir, MAIMAI_ACTIONS } from '../lib/maimai/action.js';

let passed = 0;
const failures = [];
const ok = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failures.push(`${name}: ${e?.message ?? e}`); console.log(`  ❌ ${name}\n     ${e?.message ?? e}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maimai-action-test-'));

const B50 = {
  nickname: '测试玩家', rating: 15702, additional_rating: 10,
  charts: {
    sd: [
      { title: 'A', level: '14', level_index: 3, achievements: 100.5, rate: 'sssp', dxScore: 2000, ra: 320 },
      { title: 'B', level: '13', level_index: 3, achievements: 99.1, rate: 'sss', dxScore: 1800, ra: 300 },
    ],
    dx: [{ title: 'C', level: '14', level_index: 3, achievements: 100.2, rate: 'sssp', dxScore: 2100, ra: 325 }],
  },
};
const MUSIC = [
  { id: '11823', title: 'Zitronectar', type: 'DX', ds: [4, 7, 10.5, 13.5, 14.3], level: ['4', '7', '10+', '13+', '14'], basic_info: { artist: 'Kai', genre: '舞萌', bpm: 150 } },
  { id: '99', title: '終焰', type: 'SD', ds: [3, 6, 9.5, 12.5, 14.0], level: ['3', '6', '9+', '12+', '14'], basic_info: { artist: '削除', genre: 'niconico', bpm: 200 } },
];

/** 造一个假客户端，记录被调用的方法。 */
function fakeClient(over = {}) {
  const calls = [];
  const rec = (name, ret) => async (...a) => { calls.push({ name, args: a }); return typeof ret === 'function' ? ret(...a) : ret; };
  return {
    calls,
    userB50: rec('userB50', over.userB50 ?? { ok: true, data: B50 }),
    publicB50: rec('publicB50', over.publicB50 ?? { ok: true, data: B50 }),
    musicData: rec('musicData', over.musicData ?? { ok: true, data: MUSIC }),
    deviceAuthorization: rec('deviceAuthorization', over.deviceAuthorization ?? { ok: true, data: { verification_uri_complete: 'https://auth.diving-fish.com/device?code=XYZ', user_code: 'XYZ', expires_in: 600 } }),
    redeem: rec('redeem', over.redeem ?? { ok: true, data: { access_token: 'T', expires_in: 300 } }),
  };
}
const mkDeps = (client, extra = {}) => ({
  createClient: () => client,
  loadMusicData: async () => ({ ok: true, music: MUSIC, fromCache: false }),
  renderB50: async () => Buffer.from('89504e470d0a1a0a', 'hex'),
  canvasStatus: async () => ({ ok: true }),
  ...extra,
});

const CFG_ON = { clientId: 'cid', clientSecret: 'sec' };
const CFG_OFF = { clientId: '', clientSecret: '' };

console.log('== 路由 ==');

await ok('未知子操作给出可用清单', async () => {
  const t = await actionMaimai({ maimai: CFG_OFF }, { sub: 'nope' }, mkDeps(fakeClient()));
  assert.match(t, /未知子操作/);
  for (const s of MAIMAI_ACTIONS) assert.ok(t.includes(s), `清单里应有 ${s}`);
});
await ok('sub 缺省走 status', async () => {
  const t = await actionMaimai({ maimai: CFG_OFF }, {}, mkDeps(fakeClient()));
  assert.match(t, /状态/);
});

console.log('\n== status ==');

await ok('没配 OAuth 时明确说要申请应用，并给地址', async () => {
  const t = await actionMaimai({ maimai: CFG_OFF }, { sub: 'status' }, mkDeps(fakeClient()));
  assert.match(t, /OAuth 未配置/);
  assert.match(t, /auth\.diving-fish\.com\/apps/);
});
await ok('配了 OAuth 时报已配置，且只显示 id 前几位', async () => {
  const t = await actionMaimai({ maimai: { ...CFG_ON, clientId: 'abcdef123456' } }, { sub: 'status' }, mkDeps(fakeClient()));
  assert.match(t, /OAuth 已配置/);
  assert.ok(t.includes('abcdef'), '应显示前 6 位');
  assert.ok(!t.includes('abcdef123456'), '不该完整显示 client_id');
});
await ok('绝不显示 client_secret', async () => {
  const t = await actionMaimai({ maimai: { ...CFG_ON, clientSecret: 'SUPER_SECRET_VALUE' } }, { sub: 'status' }, mkDeps(fakeClient()));
  assert.ok(!t.includes('SUPER_SECRET_VALUE'), 'client_secret 不能出现在输出里');
});
await ok('画图库缺失时给出安装指引', async () => {
  const t = await actionMaimai({ maimai: CFG_OFF }, { sub: 'status' }, mkDeps(fakeClient(), { canvasStatus: async () => ({ ok: false, error: '没装 @napi-rs/canvas' }) }));
  assert.match(t, /成绩图不可用/);
  assert.match(t, /npm install/);
});
await ok('曲库缓存状态会报告（存在时给出大小与新鲜度）', async () => {
  fs.writeFileSync(path.join(tmp, 'maimai-music-cache.json'), JSON.stringify({ music: MUSIC }), 'utf8');
  const t = await actionMaimai({ maimai: CFG_OFF, stateDir: tmp }, { sub: 'status' }, mkDeps(fakeClient()));
  assert.match(t, /曲库缓存/);
  assert.match(t, /小时前更新/);
});

console.log('\n== b50 ==');

await ok('没给 username/qq 时说要给哪个', async () => {
  const t = await actionMaimai({ maimai: CFG_ON }, { sub: 'b50' }, mkDeps(fakeClient()));
  assert.match(t, /要查谁/);
});
await ok('按 QQ 查但没配 OAuth → 明确拒绝，并说明替代方案', async () => {
  const c = fakeClient();
  const t = await actionMaimai({ maimai: CFG_OFF }, { sub: 'b50', qq: '1234567890' }, mkDeps(c));
  assert.match(t, /需要 OAuth/);
  assert.match(t, /username/, '应告诉用户可以改用 username');
  assert.equal(c.calls.length, 0, '拒绝时不该发出任何请求');
});
await ok('按用户名走公开查询', async () => {
  const c = fakeClient();
  const t = await actionMaimai({ maimai: CFG_OFF }, { sub: 'b50', username: 'someone' }, mkDeps(c));
  assert.equal(c.calls[0].name, 'publicB50');
  assert.equal(c.calls[0].args[0], 'someone');
  assert.match(t, /测试玩家/);
  assert.match(t, /Rating 15702/);
});
await ok('配了 OAuth 且给 qq → 走授权查询', async () => {
  const c = fakeClient();
  await actionMaimai({ maimai: CFG_ON }, { sub: 'b50', qq: '1234567890' }, mkDeps(c));
  assert.equal(c.calls[0].name, 'userB50');
});
await ok('查询失败时如实转达错误', async () => {
  const c = fakeClient({ publicB50: { ok: false, error: '查不到这个用户。' } });
  const t = await actionMaimai({ maimai: CFG_OFF }, { sub: 'b50', username: 'nobody' }, mkDeps(c));
  assert.match(t, /⛔/);
  assert.match(t, /查不到这个用户/);
});
await ok('文字摘要包含最高 ra 的曲目', async () => {
  const t = await actionMaimai({ maimai: CFG_OFF }, { sub: 'b50', username: 'x' }, mkDeps(fakeClient()));
  assert.match(t, /旧曲最高/);
  assert.match(t, /新曲最高/);
  assert.match(t, /ra 325/);
});
await ok('image=false 时只给文字、不出图', async () => {
  let rendered = 0;
  const t = await actionMaimai({ maimai: CFG_OFF }, { sub: 'b50', username: 'x', image: false },
    mkDeps(fakeClient(), { renderB50: async () => { rendered++; return Buffer.from('x'); } }));
  assert.equal(rendered, 0, '不该调用渲染');
  assert.ok(!t.includes('成绩图'), '不该提成绩图');
});
await ok('出图成功时给出可用的绝对路径', async () => {
  const t = await actionMaimai({ maimai: CFG_OFF }, { sub: 'b50', username: 'x' }, mkDeps(fakeClient()));
  assert.match(t, /成绩图已生成/);
  const m = t.match(/([A-Za-z]:\\[^\n]+\.png)/);
  assert.ok(m, '输出里应有绝对路径');
  assert.ok(fs.existsSync(m[1]), `路径应真实存在：${m[1]}`);
});
await ok('出图抛错时查询结果仍然返回（图是附加价值）', async () => {
  const t = await actionMaimai({ maimai: CFG_OFF }, { sub: 'b50', username: 'x' },
    mkDeps(fakeClient(), { renderB50: async () => { throw new Error('渲染炸了'); } }));
  assert.match(t, /渲染失败/);
  assert.match(t, /测试玩家/, '主体信息仍要在');
});
await ok('名字全空时用占位，不显示 undefined', async () => {
  const c = fakeClient({ publicB50: { ok: true, data: { charts: { sd: [], dx: [] } } } });
  const t = await actionMaimai({ maimai: CFG_OFF }, { sub: 'b50', username: 'x' }, mkDeps(c));
  assert.ok(!t.includes('undefined'), '不该出现 undefined');
});

console.log('\n== song / search ==');

await ok('按 id 查歌，列出全部难度定数', async () => {
  const t = await actionMaimai({ maimai: CFG_OFF }, { sub: 'song', songId: '11823' }, mkDeps(fakeClient()));
  assert.match(t, /Zitronectar/);
  assert.match(t, /MAS/);
  assert.match(t, /14\.3/);
});
await ok('按曲名查歌（取最佳匹配）', async () => {
  const t = await actionMaimai({ maimai: CFG_OFF }, { sub: 'song', query: '終焰' }, mkDeps(fakeClient()));
  assert.match(t, /終焰/);
});
await ok('id 不存在时提示改用 search', async () => {
  const t = await actionMaimai({ maimai: CFG_OFF }, { sub: 'song', songId: '999999' }, mkDeps(fakeClient()));
  assert.match(t, /没有 id=999999/);
});
await ok('search 需要 query', async () => {
  const t = await actionMaimai({ maimai: CFG_OFF }, { sub: 'search' }, mkDeps(fakeClient()));
  assert.match(t, /要给 query/);
});
await ok('search 给出候选与详情入口', async () => {
  const t = await actionMaimai({ maimai: CFG_OFF }, { sub: 'search', query: 'zitrone' }, mkDeps(fakeClient()));
  assert.match(t, /Zitronectar/);
  assert.match(t, /sub=song, songId=/);
});
await ok('search 无结果时说明曲库总量', async () => {
  const t = await actionMaimai({ maimai: CFG_OFF }, { sub: 'search', query: 'qqqqqqq' }, mkDeps(fakeClient()));
  assert.match(t, /没搜到/);
  assert.match(t, /2 首/, '应报出曲库总量');
});
await ok('取曲库失败时如实报错', async () => {
  const t = await actionMaimai({ maimai: CFG_OFF }, { sub: 'search', query: 'x' },
    mkDeps(fakeClient(), { loadMusicData: async () => ({ ok: false, error: '网络挂了' }) }));
  assert.match(t, /取曲库失败/);
  assert.match(t, /网络挂了/);
});

console.log('\n== bind / confirm（安全路径）==');

await ok('没配 OAuth 时 bind 明确拒绝并给申请地址', async () => {
  const c = fakeClient();
  const t = await actionMaimai({ maimai: CFG_OFF }, { sub: 'bind', qq: '1234567890' }, mkDeps(c));
  assert.match(t, /无法发起绑定/);
  assert.match(t, /auth\.diving-fish\.com\/apps/);
  assert.equal(c.calls.length, 0, '不该发请求');
});
await ok('bind 必须给 qq', async () => {
  const t = await actionMaimai({ maimai: CFG_ON }, { sub: 'bind' }, mkDeps(fakeClient()));
  assert.match(t, /给 qq 参数/);
});
await ok('bind 给出授权链接，且提醒不要转发 + 说明确认码的作用', async () => {
  const t = await actionMaimai({ maimai: CFG_ON }, { sub: 'bind', qq: '1234567890' }, mkDeps(fakeClient()));
  assert.match(t, /auth\.diving-fish\.com\/device/);
  assert.match(t, /别转发/);
  assert.match(t, /一次性确认码/);
  assert.match(t, /点同意/, '要说明确认码验的是什么');
  assert.match(t, /撤销/, '要告诉用户可撤销');
});
await ok('bind 输出对 QQ 打码（授权页可能被别人看到）', async () => {
  const t = await actionMaimai({ maimai: CFG_ON }, { sub: 'bind', qq: '1234567890' }, mkDeps(fakeClient()));
  assert.ok(!t.includes('1234567890'), '不该出现完整 QQ 号');
  assert.match(t, /QQ 12\*+90/);
});
await ok('confirm 缺 code 时提示', async () => {
  const t = await actionMaimai({ maimai: CFG_ON }, { sub: 'confirm', qq: '123' }, mkDeps(fakeClient()));
  assert.match(t, /给 code 参数/);
});
await ok('confirm 成功后主动验一次能否查到成绩', async () => {
  const c = fakeClient();
  const t = await actionMaimai({ maimai: CFG_ON }, { sub: 'confirm', qq: '1234567890', code: 'CODE' }, mkDeps(c));
  assert.match(t, /绑定完成/);
  assert.equal(c.calls[0].name, 'redeem');
  assert.equal(c.calls[1].name, 'userB50', '兑换后应立刻试查一次');
  assert.match(t, /测试玩家/);
});
await ok('confirm 兑换失败时转达原因', async () => {
  const c = fakeClient({ redeem: { ok: false, error: '确认码无效：可能不存在、已过期、已用过，或出自别的应用。' } });
  const t = await actionMaimai({ maimai: CFG_ON }, { sub: 'confirm', qq: '1', code: 'X' }, mkDeps(c));
  assert.match(t, /⛔/);
  assert.match(t, /确认码无效/);
});
await ok('绑定成功但试查失败时如实说明（不谎报成功）', async () => {
  const c = fakeClient({ userB50: { ok: false, error: '查询被拒（403）。' } });
  const t = await actionMaimai({ maimai: CFG_ON }, { sub: 'confirm', qq: '1', code: 'X' }, mkDeps(c));
  assert.match(t, /绑定完成/);
  assert.match(t, /试查失败/);
  assert.match(t, /scope/, '应提示可能是权限范围不足');
});

console.log('\n== saveImage ==');

await ok('写出 PNG，文件名含内容哈希', async () => {
  const buf = Buffer.from('89504e470d0a1a0a0000', 'hex');
  const r = saveImage(buf, 'b50');
  assert.equal(r.ok, true);
  assert.ok(r.file.endsWith('.png'));
  assert.ok(fs.existsSync(r.file));
  assert.match(path.basename(r.file), /^b50-[0-9a-f]{12}\.png$/);
});
await ok('同内容重复保存不产生新文件（幂等）', async () => {
  const buf = Buffer.from('89504e470d0a1a0a1111', 'hex');
  const a = saveImage(buf, 'b50');
  const b = saveImage(buf, 'b50');
  assert.equal(a.file, b.file, '同内容应复用同一路径');
});
await ok('不同内容产生不同文件', async () => {
  const a = saveImage(Buffer.from('89504e470d0a1a0a2222', 'hex'), 'b50');
  const b = saveImage(Buffer.from('89504e470d0a1a0a3333', 'hex'), 'b50');
  assert.notEqual(a.file, b.file);
});
await ok('出图目录在系统临时目录下（便于用户清理）', async () => {
  assert.ok(imageDir().startsWith(os.tmpdir()));
});
await ok('无效入参不抛错', async () => {
  const r = saveImage(null);
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures.length ? `❌ ${failures.length} 项失败\n- ${failures.join('\n- ')}` : `🎉 全部通过（${passed} 项）`}`);
process.exit(failures.length ? 1 : 0);
