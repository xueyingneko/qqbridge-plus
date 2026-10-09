/**
 * 曲绘同步：从公开的**国服曲数据库**下载曲绘到本机。
 *
 * ── 为什么是"同步"而不是"内置" ──
 *
 * 曲绘是 SEGA 的游戏版权素材，本仓库是 MIT，不能打包别人的版权物。而这个曲数据库
 * 仓库（CrazyKidCN/maimaiDX-CN-songs-database）**未声明任何许可**——未声明即保留所有
 * 权利，所以我既不能把它打包进本插件，也不能替使用者分发。
 *
 * 能做且合适的只有一件事：**提供一个下载器，让使用者自己把素材取到本机**。
 * 素材落在使用者自己的磁盘上，本插件只是读取方。这样责任边界是清楚的。
 *
 * ── 数据来源与格式 ──
 *
 *   仓库：https://github.com/CrazyKidCN/maimaiDX-CN-songs-database
 *   maidata.json：`[{ title, artist, category, image_file, dx_lev_*, version }, …]`
 *   cover/      ：`<image_file>` 命名的 PNG
 *
 * 映射关系是 **title → image_file**。实测对真实 B50 的命中率 **49/50（98%）**，
 * 唯一未命中是数据库缺少那首歌（ATLAS RUSH），不是匹配逻辑的问题。
 *
 * ── 下载策略 ──
 *
 * 走 `raw.githubusercontent.com`（单文件直链，无需 API、不受 1000 条列表上限影响）。
 * 只下**本地没有的**，所以重复执行是增量的；同时限并发，避免把对方站点打疼。
 *
 * @module dsh-plugin-qqbridge-plus/maimai/sync-jackets
 */
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';

/** 曲数据库仓库（API 直链基址）。 */
export const SONGS_DB = {
  /**
   * 数据文件与曲绘都走 **GitHub API**，不走 raw.githubusercontent.com。
   *
   * 为什么：本机实测 raw 域名恒返回 **502**（HEAD 与 GET 都是），而 API 通道正常
   * （HTTP 200，取到真 PNG）。这不是推测，是两条路都试过后的结论。
   */
  apiBase: 'https://api.github.com/repos/CrazyKidCN/maimaiDX-CN-songs-database/contents/',
  maidataPath: 'maidata.json',
  coverDir: 'cover',
  /** 供 README 与错误信息引用。 */
  repoUrl: 'https://github.com/CrazyKidCN/maimaiDX-CN-songs-database',
};

/**
 * 让 Node 信任本机证书库。
 *
 * ── 为什么需要 ──
 *
 * 本机实测：Node 直连 GitHub 报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`，而同一个 Node 连
 * 水鱼接口却正常——说明这台机器所处网络里有一层 Node 自带 CA 集不认的证书链。
 * 操作系统是认的（582 张系统根 vs Node 自带 121 张），所以把两者合并设为默认即可。
 *
 * 之所以要**合并**而不是只用 system：不丢掉 Node 自带的那批根，避免某些站点反而失联。
 * 只在 sync 模块做这件事，不全局改插件行为——影响面越小越好。
 *
 * 失败不抛错：拿不到系统证书时仍按 Node 默认走（最坏情况就是连不上 GitHub，
 * 那时会给出可操作的报错，而不是崩掉）。
 *
 * @returns {{applied: boolean, count?: number, reason?: string}}
 */
export function trustSystemCAs() {
  try {
    if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') {
      return { applied: false, reason: 'Node 版本不支持 getCACertificates' };
    }
    const def = tls.getCACertificates('default');
    const sys = tls.getCACertificates('system');
    const merged = [...new Set([...def, ...sys])];
    if (!merged.length) return { applied: false, reason: '证书集为空' };
    tls.setDefaultCACertificates(merged);
    return { applied: true, count: merged.length };
  } catch (e) {
    return { applied: false, reason: e?.message ?? String(e) };
  }
}

/** 文件名安全化，与 jackets.js 的 titleToFilename 保持一致。 */
function safeName(title) {
  return String(title ?? '').replace(/[\\/:*?"<>|]/g, '_').trim();
}

/** 带 UA 的 API 请求（GitHub 要求提供 UA）。 */
async function apiGet(url, { fetchImpl, timeoutMs = 30000 } = {}) {
  const res = await fetchImpl(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-plugin-qqbridge-plus' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res;
}

/** 读 GitHub 的限速信息（用于把"下不完"讲清楚，而不是含糊失败）。 */
async function rateLimitLeft(fetchImpl) {
  try {
    const r = await apiGet('https://api.github.com/rate_limit', { fetchImpl, timeoutMs: 15000 });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.resources?.core ?? null;
  } catch {
    return null;
  }
}

/** 默认并发（对 GitHub API 友好；太高更容易撞限速）。 */
const DEFAULT_CONCURRENCY = 4;

/** 带并发的批量执行（不引依赖，几十行够用）。 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 同步曲绘到本机。
 *
 * @param {object} opts
 * @param {string} opts.dir 目标目录（会建 <dir>/by-title/ 与 <dir>/cover/）
 * @param {boolean} [opts.force] 已存在的也重下
 * @param {number} [opts.limit] 最多下载多少张（试跑用）
 * @param {(info: object) => void} [opts.onProgress]
 * @param {Function} [opts.fetchImpl] 注入用（测试）
 * @returns {Promise<object>} 统计
 */
export async function syncJackets({
  dir,
  force = false,
  limit = 0,
  onProgress = () => {},
  fetchImpl = globalThis.fetch,
  concurrency = DEFAULT_CONCURRENCY,
} = {}) {
  const root = String(dir ?? '').trim();
  if (!root) return { ok: false, error: '未指定曲绘目录（maimai.jacketDir）' };

  const prog = (phase, extra = {}) => { try { onProgress({ phase, ...extra }); } catch { /* 进度回调不该影响主流程 */ } };

  // ⓪ 先把本机证书补齐（否则连不上 GitHub，见 trustSystemCAs 的说明）
  const ca = trustSystemCAs();
  prog('ca', ca);

  // ① 取映射表（走 API contents，base64）
  prog('fetch-index');
  let index;
  try {
    const res = await apiGet(SONGS_DB.apiBase + SONGS_DB.maidataPath, { fetchImpl });
    if (!res.ok) {
      const rl = await rateLimitLeft(fetchImpl);
      const hint = rl ? `\nGitHub API 剩余额度：${rl.remaining}/${rl.limit}` : '';
      throw new Error(`HTTP ${res.status}${hint}`);
    }
    const j = await res.json();
    index = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
  } catch (e) {
    const rl = await rateLimitLeft(fetchImpl);
    const extra = rl && rl.remaining === 0
      ? `\nGitHub 未认证接口每小时 60 次请求，当前已用尽，请约 ${Math.ceil((rl.reset * 1000 - Date.now()) / 60000)} 分钟后再试。`
      : '';
    return { ok: false, error: `取曲数据库失败：${e?.cause?.code ?? e?.message ?? e}\n来源：${SONGS_DB.repoUrl}${extra}` };
  }
  if (!Array.isArray(index)) return { ok: false, error: '曲数据库格式不符（期望数组）' };

  const wanted = index.filter((x) => x && x.title && x.image_file);
  prog('index-ready', { total: wanted.length });

  // ② 只下本地缺的。文件落在 by-title/<曲名>.<ext>——渲染器按曲名找（见 jackets.js）
  const byTitleDir = path.join(root, 'by-title');
  fs.mkdirSync(byTitleDir, { recursive: true });

  const plan = [];
  for (const row of wanted) {
    const ext = path.extname(row.image_file) || '.png';
    const dest = path.join(byTitleDir, safeName(row.title) + ext);
    if (!force && fs.existsSync(dest)) continue;
    plan.push({ row, dest });
  }
  prog('plan', { missing: plan.length, alreadyHad: wanted.length - plan.length });

  // ③ 先问额度：**限速感知**是这里的核心。
  //    GitHub 未认证接口每小时 60 次，而曲绘有 1300+ 张——一次绝对下不完。
  //    所以按剩余额度规划本轮能下多少，并把"还差多少、下次继续"讲清楚，
  //    而不是下到一半突然全线 403 让人以为坏了。
  const rl = await rateLimitLeft(fetchImpl);
  const budget = rl ? Math.max(0, Math.min(rl.remaining - 2, limit > 0 ? limit : Infinity)) : (limit > 0 ? limit : plan.length);
  const toFetch = plan.slice(0, Number.isFinite(budget) ? budget : plan.length);
  prog('budget', { remaining: rl?.remaining ?? null, limitPerHour: rl?.limit ?? null, thisRun: toFetch.length });

  let done = 0;
  let bytes = 0;
  const failures = [];
  let rateLimited = false;
  await mapLimit(toFetch, concurrency, async (item) => {
    if (rateLimited) return;                     // 撞上限速就不再徒劳重试
    try {
      const res = await apiGet(`${SONGS_DB.apiBase}${SONGS_DB.coverDir}/${encodeURIComponent(item.row.image_file)}`, { fetchImpl });
      if (res.status === 403 || res.status === 429) { rateLimited = true; failures.push(`${item.row.title}：触到 GitHub 限速`); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      bytes += await writeImage(Buffer.from(j.content, 'base64'), item.dest);
    } catch (e) {
      failures.push(`${item.row.title}（${item.row.image_file}）：${e?.cause?.code ?? e?.message ?? e}`);
    }
    done++;
    if (done % 10 === 0 || done === toFetch.length) prog('downloading', { done, total: toFetch.length, bytes });
  });

  const stats = jacketStats(root);
  const remaining = Math.max(0, wanted.length - stats.byTitle);
  return {
    ok: true,
    dir: root,
    total: wanted.length,
    alreadyHad: wanted.length - plan.length,
    downloaded: toFetch.length - failures.length,
    failed: failures.length,
    failures: failures.slice(0, 10),
    bytes,
    // 明确交代"还没完"以及为什么——否则使用者会以为同步失败了
    remaining,
    rateLimit: rl ? { remaining: rl.remaining, limit: rl.limit, resetAt: rl.reset * 1000 } : null,
    hint: remaining > 0
      ? (rateLimited || (rl && rl.remaining <= 2)
        ? `GitHub 未认证接口每小时仅 ${rl?.limit ?? 60} 次请求，本轮已用完额度。还差 ${remaining} 张，请过约一小时再执行一次（会自动接着下，已下载的不会重下）。`
        : `还差 ${remaining} 张，再执行一次即可继续（增量，已下载的不会重下）。`)
      : '全部曲绘已就绪。',
  };
}

/** 校验魔数后原子落盘，返回字节数。 */
async function writeImage(buf, dest) {
  if (buf.length === 0) throw new Error('空文件');
  const isImg = buf.length > 8 && (
    (buf[0] === 0x89 && buf[1] === 0x50) ||
    (buf[0] === 0xff && buf[1] === 0xd8) ||
    (buf.subarray(0, 4).toString('ascii') === 'RIFF')
  );
  if (!isImg) throw new Error('返回的不是图片（可能取到了错误页）');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
  return buf.length;
}

/** 统计本机现有曲绘（不联网）。 */
export function jacketStats(dir) {
  const root = String(dir ?? '').trim();
  if (!root) return { dir: null, byTitle: 0, cover: 0, total: 0 };
  const count = (p) => {
    try { return fs.readdirSync(p).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).length; } catch { return 0; }
  };
  const byTitle = count(path.join(root, 'by-title'));
  const cover = count(path.join(root, 'cover'));
  return { dir: root, byTitle, cover, total: byTitle + cover };
}
