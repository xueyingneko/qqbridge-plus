/**
 * 曲库缓存与搜索。
 *
 * 水鱼的 `/music_data` 有 1404 首（约 1MB JSON），而曲库变化很慢，所以缓存到本机，
 * 默认 24 小时过期。缓存文件放在 qq-bridge 的 `state/` 下——那里本来就是运行期状态
 * 目录（插件已在那里写 plugin-apply.json / plugin-features.json），且已被 .gitignore 排除。
 *
 * 搜索是**本地**做的：拿到曲库后在内存里匹配标题/艺人，不额外打接口。
 * 用子序列匹配（subsequence）而不是 substring，因为玩家习惯打简写：
 * "zitrone" 能命中 "Zitronectar"，"终焰" 也能命中中间夹了符号的曲名。
 *
 * @module dsh-plugin-qqbridge-plus/maimai/music
 */
import fs from 'node:fs';
import path from 'node:path';

export const CACHE_FILENAME = 'maimai-music-cache.json';
/** 默认缓存有效期：24 小时。 */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 子序列匹配：pattern 的字符按序出现在 text 中即算命中（忽略大小写与空白）。
 * 比 substring 宽松，所以"简写也能搜到"；代价是需要长度下限防误报，
 * 见 `score`。
 */
export function subsequenceMatch(text, pattern) {
  const t = String(text ?? '').toLowerCase();
  const p = String(pattern ?? '').toLowerCase().replace(/\s+/g, '');
  if (!p) return true;
  let i = 0;
  for (const ch of t) {
    if (ch === p[i]) i++;
    if (i === p.length) return true;
  }
  return false;
}

/**
 * 匹配得分，越大越靠前。0 表示不匹配。
 * 打分而不是单纯过滤，是为了让"标题完全相等"排在"子序列碰巧命中"前面。
 */
export function matchScore(music, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return 0;
  const title = String(music?.title ?? '').toLowerCase();
  const artist = String(music?.basic_info?.artist ?? '').toLowerCase();

  if (title === q) return 1000;
  if (title.startsWith(q)) return 900 - title.length;
  if (title.includes(q)) return 800 - title.length;

  // 艺人命中：权重低于标题
  if (artist.includes(q)) return 500;

  // 子序列：要求查询词至少 3 个字符，否则太容易误命中
  const compact = q.replace(/\s+/g, '');
  if (compact.length >= 3 && subsequenceMatch(title, compact)) return 300 - title.length;
  return 0;
}

/** 在曲库里搜索，按得分降序。 */
export function searchMusic(list, query, limit = 5) {
  if (!Array.isArray(list)) return [];
  return list
    .map((m) => ({ music: m, score: matchScore(m, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))
    .map((x) => x.music);
}

/** 读出缓存的曲库；过期、缺失、损坏都返回 null（让调用方去重新拉）。 */
export function readCache(stateDir, { ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  if (!stateDir) return null;
  const file = path.join(stateDir, CACHE_FILENAME);
  try {
    const stat = fs.statSync(file);
    if (now - stat.mtimeMs > ttlMs) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 只认数组形状；水鱼换返回结构时宁可重拉，也不要把脏数据当成曲库用
    return Array.isArray(parsed?.music) ? parsed.music : null;
  } catch {
    return null;
  }
}

/** 写缓存（原子写：临时文件 + rename，避免另一个进程读到半个 JSON）。 */
export function writeCache(stateDir, music) {
  if (!stateDir || !Array.isArray(music)) return { ok: false, error: '无效入参' };
  const file = path.join(stateDir, CACHE_FILENAME);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), music }), 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, file, count: music.length };
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败不影响主流程 */ }
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** 缓存文件路径（供工具层报给用户看）。 */
export function cachePath(stateDir) {
  return stateDir ? path.join(stateDir, CACHE_FILENAME) : null;
}

/**
 * 取曲库：先看缓存，没有再拉取并写回。
 * @param {object} client divingfish 客户端（需有 musicData()）
 * @param {object} opts
 * @param {string} opts.stateDir 缓存目录
 * @param {boolean} [opts.force] 忽略缓存强制拉取
 */
export async function loadMusicData(client, { stateDir, force = false, ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!force) {
    const cached = readCache(stateDir, { ttlMs });
    if (cached) return { ok: true, music: cached, fromCache: true };
  }
  const r = await client.musicData();
  if (!r.ok) {
    // 拉取失败时退回过期缓存也比彻底不可用强——但要如实告诉调用方数据是旧的
    const stale = readCache(stateDir, { ttlMs: Number.MAX_SAFE_INTEGER });
    if (stale) return { ok: true, music: stale, fromCache: true, stale: true, error: r.error };
    return { ok: false, error: r.error };
  }
  writeCache(stateDir, r.data);
  return { ok: true, music: r.data, fromCache: false };
}

/** 按 id 找一首（id 在水鱼里是字符串，比较时统一成字符串）。 */
export function findById(list, id) {
  const want = String(id ?? '').trim();
  if (!want || !Array.isArray(list)) return null;
  return list.find((m) => String(m.id) === want) ?? null;
}

/**
 * 取某首歌的音档信息。
 * @param {object} music 曲库条目
 * @param {number} [levelIndex] 难度下标 0..4；缺省取最高的那个，越界则钳制到有效范围
 * @returns {{index:number, ds:number|string|null, level:string|null, dsDetail:object|null}|null}
 */
export function chartOf(music, levelIndex) {
  if (!music) return null;
  const ds = Array.isArray(music.ds) ? music.ds : [];
  const level = Array.isArray(music.level) ? music.level : [];
  const max = ds.length - 1;
  if (max < 0) return null; // 这首歌没有定数数据

  // 越界要钳制：早先直接拿 levelIndex 当下标，传 99 会得到 ds=null，
  // 调用方看到的是一张"有歌名却没有定数"的空卡，而不是一个明确的错误。
  let idx = Number.isInteger(levelIndex) ? levelIndex : max;
  if (idx < 0) idx = 0;
  if (idx > max) idx = max;

  return {
    index: idx,
    ds: ds[idx] ?? null,
    level: level[idx] ?? null,
    // charts 是可选的更详细定数表（新曲才有），没有就退回 ds
    dsDetail: Array.isArray(music.charts) ? (music.charts[idx]?.notes ?? null) : null,
  };
}
