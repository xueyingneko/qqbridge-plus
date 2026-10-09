// 曲库缓存与搜索的测试。
//
// 搜索是玩家实际最先碰到的东西（打错一个字就搜不到），所以这里主要锁住
// 匹配的**宽容度与排序**：简写要能命中、完全相等要排最前、太短的查询不能乱命中。
// 缓存部分锁住三件事：过期会失效、损坏不被当成数据、原子写不留半个文件。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  subsequenceMatch, matchScore, searchMusic, readCache, writeCache,
  cachePath, loadMusicData, findById, chartOf, CACHE_FILENAME, DEFAULT_TTL_MS,
} from '../lib/maimai/music.js';

let passed = 0;
const failures = [];
const ok = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failures.push(`${name}: ${e?.message ?? e}`); console.log(`  ❌ ${name}\n     ${e?.message ?? e}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maimai-music-test-'));

const song = (over = {}) => ({
  id: '11823', title: 'Zitronectar', type: 'DX',
  ds: [4, 7, 10.5, 13.5, 14.3], level: ['4', '7', '10+', '13+', '14'],
  basic_info: { artist: 'Kai', genre: '舞萌', bpm: 150 }, ...over,
});
const LIB = [
  song(),
  song({ id: '8', title: 'True Love Song', basic_info: { artist: 'クラシック', genre: '舞萌', bpm: 130 } }),
  song({ id: '99', title: '終焰', type: 'SD', basic_info: { artist: '削除', genre: 'niconico', bpm: 200 } }),
  song({ id: '100', title: "Love's Theme of BADASS", basic_info: { artist: 'xi', genre: '舞萌', bpm: 180 } }),
];

console.log('== 子序列匹配 ==');

await ok('顺序出现的字符算命中', async () => {
  assert.equal(subsequenceMatch('Zitronectar', 'ztn'), true);
  assert.equal(subsequenceMatch('Zitronectar', 'zitrone'), true);
});
await ok('顺序不对不算命中', async () => {
  assert.equal(subsequenceMatch('Zitronectar', 'nrt'), false);
});
await ok('忽略大小写与空格', async () => {
  assert.equal(subsequenceMatch('True Love Song', 't r u e'), true);
  assert.equal(subsequenceMatch('True Love Song', 'TRUELOVE'), true);
});
await ok('空查询视为命中（调用方负责过滤）', async () => {
  assert.equal(subsequenceMatch('Anything', ''), true);
});

console.log('\n== 排序 ==');

await ok('标题完全相等排最前', async () => {
  const r = searchMusic(LIB, 'Zitronectar');
  assert.equal(r[0].id, '11823');
});
await ok('前缀命中优先于子序列命中', async () => {
  // "love" 是 "Love's Theme..." 的前缀，也是 "True Love Song" 的子串
  const r = searchMusic(LIB, 'love');
  assert.ok(r.length >= 2);
  assert.equal(r[0].id, '100', `前缀应排前，实际首位是 ${r[0].title}`);
});
await ok('简写能搜到（子序列）', async () => {
  const r = searchMusic(LIB, 'ztn');
  assert.ok(r.some((m) => m.title === 'Zitronectar'), '简写 ztn 该能命中 Zitronectar');
});
await ok('中文曲名能搜到', async () => {
  const r = searchMusic(LIB, '終焰');
  assert.equal(r[0].title, '終焰');
});
await ok('艺人名也能搜（权重低于标题）', async () => {
  const r = searchMusic(LIB, '削除');
  assert.ok(r.some((m) => m.title === '終焰'));
});
await ok('太短的查询不乱命中（防误报）', async () => {
  // "zz" 只有 2 个字符，不该走子序列兜底把一大堆歌捞出来
  const r = searchMusic(LIB, 'zz');
  assert.equal(r.length, 0);
});
await ok('搜不到时返回空数组而不是全部', async () => {
  assert.deepEqual(searchMusic(LIB, 'qqqqqqqq'), []);
});
await ok('limit 生效', async () => {
  assert.equal(searchMusic(LIB, 'e', 2).length, 2);
});
await ok('非数组输入不崩', async () => {
  assert.deepEqual(searchMusic(null, 'x'), []);
  assert.deepEqual(searchMusic(undefined, 'x'), []);
});

console.log('\n== 缓存 ==');

await ok('写入后能读回，且形状一致', async () => {
  const w = writeCache(tmp, LIB);
  assert.equal(w.ok, true);
  assert.equal(w.count, LIB.length);
  const back = readCache(tmp);
  assert.equal(back.length, LIB.length);
  assert.equal(back[0].title, 'Zitronectar');
});
await ok('缓存文件放在 stateDir 下、文件名固定', async () => {
  assert.equal(cachePath(tmp), path.join(tmp, CACHE_FILENAME));
  assert.ok(fs.existsSync(path.join(tmp, CACHE_FILENAME)));
});
await ok('过期后返回 null（让调用方重拉）', async () => {
  writeCache(tmp, LIB);
  assert.equal(readCache(tmp, { ttlMs: 0, now: Date.now() + 1000 }), null);
});
await ok('文件损坏时返回 null，不抛错', async () => {
  fs.writeFileSync(path.join(tmp, CACHE_FILENAME), '{ 这不是 JSON', 'utf8');
  assert.equal(readCache(tmp), null);
});
await ok('结构不对（不是数组）也返回 null，不把脏数据当曲库', async () => {
  fs.writeFileSync(path.join(tmp, CACHE_FILENAME), JSON.stringify({ music: 'not-an-array' }), 'utf8');
  assert.equal(readCache(tmp), null);
});
await ok('原子写：不留 tmp 残留', async () => {
  writeCache(tmp, LIB);
  const leftovers = fs.readdirSync(tmp).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, [], `残留了临时文件：${leftovers.join(', ')}`);
});
await ok('目录不存在时会自动建', async () => {
  const deeper = path.join(tmp, 'a', 'b');
  const w = writeCache(deeper, LIB);
  assert.equal(w.ok, true);
  assert.ok(fs.existsSync(path.join(deeper, CACHE_FILENAME)));
});
await ok('无效入参不崩', async () => {
  assert.equal(writeCache(null, LIB).ok, false);
  assert.equal(writeCache(tmp, null).ok, false);
  assert.equal(readCache(null), null);
});

console.log('\n== 取曲库（缓存优先、失败退旧）==');

await ok('有缓存时不打接口', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maimai-music-c2-'));
  writeCache(dir, LIB);
  let called = 0;
  const client = { musicData: async () => { called++; return { ok: true, data: [] }; } };
  const r = await loadMusicData(client, { stateDir: dir });
  assert.equal(called, 0, '命中缓存时不该再请求');
  assert.equal(r.fromCache, true);
  assert.equal(r.music.length, LIB.length);
});
await ok('无缓存时拉取并写回', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maimai-music-c3-'));
  let called = 0;
  const client = { musicData: async () => { called++; return { ok: true, data: LIB }; } };
  const r = await loadMusicData(client, { stateDir: dir });
  assert.equal(called, 1);
  assert.equal(r.fromCache, false);
  assert.ok(fs.existsSync(path.join(dir, CACHE_FILENAME)), '应写回缓存');
});
await ok('拉取失败时退回过期缓存，并如实标记 stale', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maimai-music-c4-'));
  writeCache(dir, LIB);
  // 把缓存改成"过期"
  const f = path.join(dir, CACHE_FILENAME);
  const old = Date.now() - DEFAULT_TTL_MS - 60000;
  fs.utimesSync(f, new Date(old), new Date(old));
  const client = { musicData: async () => ({ ok: false, error: '网络挂了' }) };
  const r = await loadMusicData(client, { stateDir: dir });
  assert.equal(r.ok, true, '有旧缓存时不该彻底失败');
  assert.equal(r.stale, true);
  assert.match(r.error, /网络挂了/);
});
await ok('拉取失败且无任何缓存时如实失败', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maimai-music-c5-'));
  const client = { musicData: async () => ({ ok: false, error: '网络挂了' }) };
  const r = await loadMusicData(client, { stateDir: dir });
  assert.equal(r.ok, false);
  assert.match(r.error, /网络挂了/);
});
await ok('force 会忽略缓存', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maimai-music-c6-'));
  writeCache(dir, LIB);
  let called = 0;
  const client = { musicData: async () => { called++; return { ok: true, data: [song({ id: '999' })] }; } };
  const r = await loadMusicData(client, { stateDir: dir, force: true });
  assert.equal(called, 1);
  assert.equal(r.music[0].id, '999');
});

console.log('\n== 按 id / 定数 ==');

await ok('按 id 找歌（id 是字符串，比较时归一）', async () => {
  assert.equal(findById(LIB, '11823').title, 'Zitronectar');
  assert.equal(findById(LIB, 11823).title, 'Zitronectar', '数字 id 也该能找');
  assert.equal(findById(LIB, '不存在'), null);
  assert.equal(findById(null, '1'), null);
});
await ok('默认取最高难度，也可指定下标', async () => {
  const top = chartOf(LIB[0]);
  assert.equal(top.index, 4);
  assert.equal(top.ds, 14.3);
  assert.equal(top.level, '14');
  const basic = chartOf(LIB[0], 0);
  assert.equal(basic.ds, 4);
  assert.equal(basic.level, '4');
});
await ok('越界下标钳制到有效范围，不返回空卡', async () => {
  assert.equal(chartOf(LIB[0], 99).ds, 14.3, '99 应钳到最高档');
  assert.equal(chartOf(LIB[0], 99).index, 4);
  assert.equal(chartOf(LIB[0], -5).ds, 4, '负数应钳到最低档');
  assert.equal(chartOf(LIB[0], -5).index, 0);
  assert.equal(chartOf(null), null);
});
await ok('没有定数数据时返回 null，而不是返回全是 null 的对象', async () => {
  assert.equal(chartOf({ title: 'x' }), null);
  assert.equal(chartOf({ title: 'x', ds: [] }), null);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures.length ? `❌ ${failures.length} 项失败\n- ${failures.join('\n- ')}` : `🎉 全部通过（${passed} 项）`}`);
process.exit(failures.length ? 1 : 0);
