/**
 * `maimai` action：舞萌DX 查分。
 *
 * 三层分离，各自可单独测试：
 *   divingfish.js  接口与 OAuth
 *   music.js       曲库缓存与搜索
 *   render.js      出图
 * 这一层只做**取数 + 组织人话 + 可选出图**，不碰网络细节也不画像素。
 *
 * ── 关于"出图"在工具侧怎么交付 ──
 *
 * 工具返回值是文本，图给不进去。所以出图时把 PNG 写到临时文件，并在文本里给出
 * 绝对路径 + 一句"把它发到群里"的提示——模型手上本来就有 QQ 发图工具
 * （mcp__snowluma__qq_*），把路径交出去比硬塞二进制更稳。
 * 文件名带内容哈希，同一个人重复查同一份成绩不会堆一堆重复文件。
 *
 * @module dsh-plugin-qqbridge-plus/maimai/action
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createClient, oauthConfigured, bindingLabel, normalizeConfig } from './divingfish.js';
import { loadMusicData, searchMusic, findById, chartOf, cachePath } from './music.js';
import { renderB50, canvasStatus, b50Height, CANVAS_HINT } from './render.js';
import { syncJackets, jacketStats } from './sync-jackets.js';

/** maimai 的子操作。 */
export const MAIMAI_ACTIONS = ['status', 'b50', 'song', 'search', 'bind', 'confirm', 'sync'];

const DIFF_LABEL = ['BAS', 'ADV', 'EXP', 'MAS', 'ReM'];
const RATE_LABEL = {
  sssp: 'SSS+', sss: 'SSS', 'ss+': 'SS+', ss: 'SS', 's+': 'S+', s: 'S',
  aaa: 'AAA', aa: 'AA', a: 'A', bbb: 'BBB', bb: 'BB', b: 'B', c: 'C', d: 'D', f: 'F',
};

/**
 * 出图目录的兜底位置：系统临时目录下的固定子目录。
 *
 * 之所以做成可配（`maimai.imageDir`）：成绩图按内容哈希命名、**不自动清理**，
 * 长期跑会一直堆。而临时目录在系统盘，有些机器系统盘余量很小——实测本机 C 盘
 * 只剩 3.8GB，而其它盘各有 100GB+。让使用者能指定到大盘上，比事后清理更省事。
 */
export function imageDir(override = null) {
  const o = String(override ?? '').trim();
  return o || path.join(os.tmpdir(), 'qqbridge-plus-maimai');
}

/**
 * 把 PNG 落到文件，返回路径。文件名含内容哈希 → 同样内容重复渲染不产生新文件。
 * @param {Buffer} buf
 * @param {string} [prefix]
 * @param {string|null} [dirOverride] 出图目录（来自配置）；空则用系统临时目录
 * @returns {{ok: true, file: string, bytes: number} | {ok: false, error: string}}
 */
export function saveImage(buf, prefix = 'b50', dirOverride = null) {
  try {
    const dir = imageDir(dirOverride);
    fs.mkdirSync(dir, { recursive: true });
    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 12);
    const file = path.join(dir, `${prefix}-${hash}.png`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
    return { ok: true, file, bytes: buf.length };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** 数字或问号。 */
const n = (v) => (v === null || v === undefined || v === '' ? '?' : v);

/** 把客户端的失败结果转成人话（已经翻译过，这里只补上下文）。 */
function fail(message) {
  return `⛔ ${message}`;
}

/**
 * 执行一个 maimai 子操作。
 *
 * @param {object} ctx 需要 `{ maimai }` 配置段与可选的 `stateDir`
 * @param {object} args `{ sub, username, qq, songId, query, code, image, force, limit }`
 * @param {object} [deps] 依赖注入，仅测试用：`{ createClient?, loadMusicData?, renderB50?, canvasStatus? }`
 * @returns {Promise<string>}
 */
export async function actionMaimai(ctx, args = {}, deps = {}) {
  const sub = String(args.sub ?? 'status').trim() || 'status';
  const cfg = normalizeConfig(ctx.maimai ?? {});
  // 允许注入，是为了让测试能拦住网络：这一层本身不该成为"必须联网才能测"的代码。
  const mkClient = deps.createClient ?? createClient;
  const client = mkClient(cfg);
  const stateDir = ctx.stateDir ?? null;

  switch (sub) {
    case 'status': return await subStatus(cfg, stateDir, deps);
    case 'b50': return await subB50(client, cfg, args, deps);
    case 'song': return await subSong(client, cfg, args, stateDir, deps);
    case 'search': return await subSearch(client, stateDir, args, deps);
    case 'bind': return await subBind(client, cfg, args);
    case 'confirm': return await subConfirm(client, cfg, args);
    case 'sync': return await subSync(cfg, args);
    default:
      return fail(`未知子操作「${sub}」。可用：${MAIMAI_ACTIONS.join(' / ')}`);
  }
}

/** sync：把曲绘同步到本机（素材由使用者自行下载，本插件不随包分发）。 */
async function subSync(cfg, args) {
  const dir = String(cfg.jacketDir ?? '').trim();
  if (!dir) {
    return fail('还没配置曲绘目录。请在 profile 的 cordis.patch.yml 里给 maimai 加一行：\n'
      + '  jacketDir: \'你想放曲绘的目录\'\n'
      + '然后重跑本命令，它会把曲绘下载到那里。');
  }
  const limit = Number(args.limit) > 0 ? Number(args.limit) : 0;
  const r = await syncJackets({ dir, limit, force: args.force === true });
  if (!r.ok) return fail(r.error);

  const lines = [
    '=== 曲绘同步 ===',
    `目录：${r.dir}`,
    `曲数据库共 ${r.total} 首，本地已有 ${r.alreadyHad} 张`,
    `本轮下载 ${r.downloaded} 张${r.failed ? `，失败 ${r.failed} 张` : ''}（${(r.bytes / 1048576).toFixed(1)} MB）`,
  ];
  if (r.failures?.length) {
    lines.push('', '失败样例：');
    for (const f of r.failures.slice(0, 5)) lines.push(`  ${f}`);
  }
  const st = jacketStats(dir);
  lines.push('', `本机现有曲绘：${st.byTitle} 张`);
  lines.push('', r.hint);
  if (r.rateLimit) {
    lines.push(`（GitHub 接口额度 ${r.rateLimit.remaining}/${r.rateLimit.limit}，每小时重置）`);
  }
  return lines.join('\n');
}

/** status：这台机器上查分功能到底能不能用。 */
async function subStatus(cfg, stateDir, deps = {}) {
  const lines = ['=== 舞萌DX 查分 · 状态 ===', ''];
  lines.push(`接口地址：${cfg.baseUrl}`);
  lines.push(`账号服务：${cfg.authUrl}`);
  lines.push(`代理模式：${cfg.proxy ? `开（${cfg.proxyUrl}）` : '关'}`);
  lines.push('');

  // OAuth 配置
  if (oauthConfigured(cfg)) {
    lines.push(`✅ OAuth 已配置（client_id ${String(cfg.clientId).slice(0, 6)}…，scope ${cfg.scope}）`);
    lines.push('   用户可以发「绑定水鱼」走授权；令牌只在内存里，不落盘。');
  } else {
    lines.push('⛔ OAuth 未配置：缺 client_id / client_secret。');
    lines.push('   查自己的成绩需要它。申请地址：https://auth.diving-fish.com/apps');
    lines.push('   拿到后写进 profile 的 cordis.patch.yml：maimai.clientId / maimai.clientSecret。');
  }
  lines.push('');

  // 画图库
  const checkCanvas = deps.canvasStatus ?? canvasStatus;
  const cv = await checkCanvas();
  if (cv.ok) {
    lines.push('✅ 成绩图可用（@napi-rs/canvas 已装）');
  } else {
    lines.push(`⛔ 成绩图不可用：${cv.error}`);
    lines.push(`   ${CANVAS_HINT}`);
  }
  lines.push('');

  // 曲库缓存
  const cp = cachePath(stateDir);
  if (!cp) {
    lines.push('· 曲库缓存目录未提供（不影响查询，只是每次都要拉曲库）。');
  } else if (fs.existsSync(cp)) {
    const st = fs.statSync(cp);
    const ageH = ((Date.now() - st.mtimeMs) / 3600000).toFixed(1);
    lines.push(`· 曲库缓存：${cp}`);
    lines.push(`  ${(st.size / 1048576).toFixed(2)} MB，${ageH} 小时前更新（超过 24 小时会自动重拉）`);
  } else {
    lines.push(`· 曲库缓存：尚未生成（首次查歌时会拉取并写 ${cp}）`);
  }
  lines.push('');
  lines.push('可用子操作：' + MAIMAI_ACTIONS.join(' / '));
  return lines.join('\n');
}

/** b50：查 B50，可出图。 */
async function subB50(client, cfg, args, deps = {}) {
  const qq = args.qq ?? null;
  const username = args.username ? String(args.username).trim() : '';

  // 走哪条路：有 qq 且 OAuth 配好 → 授权查询；否则按用户名走公开查询。
  let r;
  let how;
  if (qq && oauthConfigured(cfg)) {
    how = `授权查询（QQ ${bindingLabel(qq).replace('QQ ', '')}）`;
    r = await client.userB50(qq);
  } else if (qq && !oauthConfigured(cfg)) {
    return fail('按 QQ 号查自己的成绩需要 OAuth，但当前没配 client_id / client_secret。\n'
      + '要么去 https://auth.diving-fish.com/apps 申请应用并写进插件配置，要么改用 username 走公开查询（需要对方公开了成绩）。');
  } else if (username) {
    how = `公开查询（用户名 ${username}）`;
    r = await client.publicB50(username);
  } else {
    return fail('要查谁？给 username（公开查询）或 qq（需要 OAuth 授权）。');
  }

  if (!r.ok) return fail(r.error);
  const data = r.data;
  const sd = data?.charts?.sd ?? [];
  const dx = data?.charts?.dx ?? [];

  const lines = [
    `=== ${data?.nickname || data?.username || '(未知玩家)'} · B50 ===`,
    `${how}`,
    `Rating ${n(data?.rating)}　段位/评级 ${n(data?.additional_rating)}`,
    `旧曲 ${sd.length} 首 / 新曲 ${dx.length} 首`,
  ];

  // 文字摘要：给出各段最高 ra 的几首，没有图时也能看
  const top = (list, k = 3) => list.slice().sort((a, b) => (b.ra ?? 0) - (a.ra ?? 0)).slice(0, k);
  if (sd.length) {
    lines.push('', `旧曲最高：`);
    for (const p of top(sd)) {
      lines.push(`  ${Number(p.achievements ?? 0).toFixed(4)}%  ${RATE_LABEL[String(p.rate ?? '').toLowerCase()] ?? p.rate ?? ''}  ${p.title}  [${DIFF_LABEL[p.level_index] ?? '?'} ${p.level}]  ra ${p.ra ?? 0}`);
    }
  }
  if (dx.length) {
    lines.push('', `新曲最高：`);
    for (const p of top(dx)) {
      lines.push(`  ${Number(p.achievements ?? 0).toFixed(4)}%  ${RATE_LABEL[String(p.rate ?? '').toLowerCase()] ?? p.rate ?? ''}  ${p.title}  [${DIFF_LABEL[p.level_index] ?? '?'} ${p.level}]  ra ${p.ra ?? 0}`);
    }
  }

  // 出图（默认出；args.image === false 时只给文字）
  if (args.image !== false) {
    try {
      const doRender = deps.renderB50 ?? renderB50;
      // 曲绘目录来自配置；没配就没有曲绘（退回色条），不是错误
      const png = await doRender(data, { jacketDir: cfg.jacketDir || null });
      const saved = saveImage(png, 'b50', cfg.imageDir || null);
      if (saved.ok) {
        lines.push('', `成绩图已生成（${(saved.bytes / 1024).toFixed(0)} KB，${b50Height(sd.length, dx.length)}px 高）：`);
        lines.push(saved.file);
        // 这句是给**工具面**看的（模型需要路径才能自己发图）。
        // QQ 侧桥接会自动发图并在转发前把路径剥掉，所以别指望用户在聊天里看到路径。
        lines.push('（QQ 命令回复时，桥接会直接发送这张图，无需手动处理；上面路径供工具面使用）');
      } else {
        lines.push('', `⚠️ 成绩图写入失败：${saved.error}`);
      }
    } catch (e) {
      lines.push('', `⚠️ 成绩图渲染失败：${e?.message ?? e}`);
    }
  }
  return lines.join('\n');
}

/** song：按 id 或精确曲名查一首歌的定数。 */
async function subSong(client, cfg, args, stateDir, deps = {}) {
  const doLoad = deps.loadMusicData ?? loadMusicData;
  const loaded = await doLoad(client, { stateDir, force: args.force === true });
  if (!loaded.ok) return fail(`取曲库失败：${loaded.error}`);
  const music = args.songId ? findById(loaded.music, args.songId) : searchMusic(loaded.music, args.query ?? '', 1)[0];
  if (!music) {
    return fail(args.songId ? `曲库里没有 id=${args.songId} 的歌。` : `没找到「${args.query}」。可以先用 sub=search 搜一下。`);
  }
  const lines = [
    `=== ${music.title} ===`,
    `id ${music.id}　类型 ${music.type}　分类 ${music.basic_info?.genre ?? '?'}`,
    `艺人 ${music.basic_info?.artist ?? '?'}　BPM ${n(music.basic_info?.bpm)}`,
  ];
  const ds = Array.isArray(music.ds) ? music.ds : [];
  const lv = Array.isArray(music.level) ? music.level : [];
  lines.push('', '难度定数：');
  for (let i = 0; i < Math.max(ds.length, lv.length); i++) {
    lines.push(`  ${(DIFF_LABEL[i] ?? `#${i}`).padEnd(4)} ${String(lv[i] ?? '?').padEnd(5)} 定数 ${n(ds[i])}`);
  }
  if (loaded.fromCache) lines.push('', loaded.stale ? '（曲库来自过期缓存，刚才重拉失败了）' : '（曲库来自本机缓存）');
  return lines.join('\n');
}

/** search：模糊搜曲，返回候选。 */
async function subSearch(client, stateDir, args, deps = {}) {
  const q = String(args.query ?? '').trim();
  if (!q) return fail('要给 query，比如 query="终焰"。');
  const doLoad = deps.loadMusicData ?? loadMusicData;
  const loaded = await doLoad(client, { stateDir, force: args.force === true });
  if (!loaded.ok) return fail(`取曲库失败：${loaded.error}`);
  const hits = searchMusic(loaded.music, q, Number(args.limit) > 0 ? Number(args.limit) : 8);
  if (!hits.length) return `没搜到「${q}」相关的曲目（共 ${loaded.music.length} 首）。换个关键词，或用更短的前缀。`;
  const lines = [`=== 搜「${q}」· ${hits.length} 个结果（曲库 ${loaded.music.length} 首）===`];
  for (const m of hits) {
    const top = chartOf(m);
    lines.push(`  ${String(m.title).padEnd(28)} ${String(m.type ?? '').padEnd(3)} id ${String(m.id).padEnd(6)} 最高 ${top?.level ?? '?'}（定数 ${n(top?.ds)}）`);
  }
  lines.push('', '看某个的详情：sub=song, songId=<id>');
  return lines.join('\n');
}

/** bind：发起绑定，返回给用户点开的授权链接。 */
async function subBind(client, cfg, args) {
  if (!oauthConfigured(cfg)) {
    return fail('还没配置 OAuth 应用凭据（client_id / client_secret），无法发起绑定。\n'
      + '申请地址：https://auth.diving-fish.com/apps\n'
      + '拿到后写进 profile 的 cordis.patch.yml 的 maimai 段。');
  }
  const qq = args.qq;
  if (!qq) return fail('绑定需要知道是哪个 QQ 在绑：给 qq 参数。');

  const r = await client.deviceAuthorization(qq);
  if (!r.ok) return fail(r.error);

  const d = r.data ?? {};
  const link = d.verification_uri_complete || d.verification_uri || '';
  return [
    '=== 绑定水鱼查分器 ===',
    `这个链接是发给 ${bindingLabel(qq)} 的，请**本人**打开（别转发给别人）：`,
    link,
    '',
    '在水鱼页面上确认显示的身份就是你自己，然后点「同意授权」。',
    `页面会给出一串一次性确认码，把它发回来完成绑定（${n(d.expires_in)} 秒内有效）。`,
    '',
    '为什么要多这一步：绑定链接谁都能转发，确认码只出现在点同意那个人的浏览器里——',
    '所以它能验出「点同意的人」和「发起绑定的人」是不是同一个，防止有人把链接发给别人骗授权。',
    '',
    '机器人这边不保存你的任何令牌；授权关系存在水鱼，随时可在 https://auth.diving-fish.com/apps 撤销。',
  ].join('\n');
}

/** confirm：用确认码收尾绑定。 */
async function subConfirm(client, cfg, args) {
  if (!oauthConfigured(cfg)) return fail('还没配置 OAuth 应用凭据，无法完成绑定。');
  const qq = args.qq;
  const code = String(args.code ?? '').trim();
  if (!qq) return fail('给 qq 参数（哪个 QQ 在绑定）。');
  if (!code) return fail('给 code 参数（水鱼页面给出的那串一次性确认码）。');

  const r = await client.redeem(qq, code);
  if (!r.ok) return fail(r.error);

  // 兑换成功后立刻验一次：确认这个码真的能换到该用户的成绩
  const check = await client.userB50(qq);
  const lines = ['✅ 绑定完成。'];
  if (check.ok) {
    lines.push(`已能查到该账号成绩：${check.data?.nickname ?? '(未命名)'}（Rating ${n(check.data?.rating)}）`);
    lines.push('之后直接查 B50 即可，令牌只在内存里保存，5 分钟过期后自动重换。');
  } else {
    lines.push(`⚠️ 绑定已建立，但随后试查失败：${check.error}`);
    lines.push('这通常说明授权范围（scope）不足，或用户刚在水鱼那边撤销了。');
  }
  return lines.join('\n');
}
