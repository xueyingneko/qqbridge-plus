/**
 * 水鱼查分器（Diving-Fish）客户端。
 *
 * 接口契约来自 [Yuri-YuzuChaN/maimaiDX](https://github.com/Yuri-YuzuChaN/maimaiDX)（MIT），
 * 特别是 core/clients/divingfish/ 下的 client.py 与 oauth.py。移植时保留了原作者在
 * 注释里写下的安全推理，因为那几条不是可选的谨慎，而是这套授权模型能成立的前提。
 *
 * ── 为什么必须是 OAuth，而不是开发者 token ──
 *
 * 水鱼已弃用 `DIVINGFISH_TOKEN`（开发者 token）。原因是它能**按 QQ 号读取任意用户的
 * 成绩**，而那些用户从未对机器人做过授权、也无法撤销。用它做出来的"查分"功能，
 * 本质是一个无需同意即可拉取他人成绩的工具。所以本模块**不实现**那条路径，
 * 即使它写起来更短（原项目也把 `developer-token` 只留在 `not oauth` 的兼容分支里）。
 *
 * ── 授权模型（三个不变量）──
 *
 * 1. **机器人不持有用户凭据**。只保管应用自己的 `client_id` / `client_secret`；
 *    用户与水鱼之间的授权关系存在水鱼服务端，用户可随时在 auth.diving-fish.com/apps 撤销。
 * 2. **QQ 号不离开机器人**。发给水鱼的是 `sha256("<client_id>:<QQ号>")` 摘要
 *    （`subjectRef`），水鱼存的也是这个摘要。
 * 3. **令牌只在内存里**。`on-behalf-of` 换来的 access_token 5 分钟有效、无 refresh，
 *    放在进程内缓存即可；**不写盘**，避免多一份可被读取的凭据副本。
 *
 * ── 关于那个"确认码" —— 它不是多余的手续 ──
 *
 * 发起绑定不需要任何凭据，所以谁都能拿本机器人的 `client_id` 造一条绑定链接、
 * 填上自己的标识转发给别人；受害者点完"同意"，造链接的人就绑上了对方的账号。
 * 确认码只出现在**点同意那个人的浏览器**里，未经他发回来绑定就完不成——
 * 这一步验的是"点同意的人"和"发起绑定的人"是不是同一个。
 * 所以 `handoff=code` 之后 `device_code` 换不到令牌：**这正是它的意义**。
 *
 * @module dsh-plugin-qqbridge-plus/maimai/divingfish
 */
import { createHash } from 'node:crypto';
import { DF_BASE_URL, DF_AUTH_URL, DF_PROXY_URL, DEFAULT_SCOPE } from './constants.js';

export { DEFAULT_SCOPE };

/** 带默认值的配置（由调用方从插件 config 传入）。 */
export const DEFAULTS = {
  /** 资源服务器：成绩查询 */
  baseUrl: DF_BASE_URL,
  /** 账号服务：OAuth 授权与令牌 */
  authUrl: DF_AUTH_URL,
  /** OAuth 应用凭据（向水鱼申请获得） */
  clientId: '',
  clientSecret: '',
  /** 权限范围（单一来源见 constants.js；默认不含任何 write） */
  scope: DEFAULT_SCOPE,
  /** 单次请求超时 */
  timeoutMs: 15000,
  /** 是否走中转（境外服务器用） */
  proxy: false,
  proxyUrl: DF_PROXY_URL,
};

/** 令牌缓存提前量：避免令牌在请求途中失效。 */
const EXPIRES_MARGIN_SEC = 30;

/** 用户标识摘要。QQ 号只以这个形式离开机器人。 */
export function subjectRef(qqid, clientId) {
  return createHash('sha256').update(`${clientId}:${qqid}`).digest('hex');
}

/**
 * 展示在授权页面上的绑定身份，用户凭它确认自己不是在给别人授权。
 * 中间打码：授权页面可能被别人看到，不该完整暴露 QQ 号。
 */
export function bindingLabel(qqid) {
  const qq = String(qqid);
  if (qq.length <= 4) return `QQ ${qq}`;
  return `QQ ${qq.slice(0, 2)}${'*'.repeat(qq.length - 4)}${qq.slice(-2)}`;
}

/**
 * 读出 access token 里的 `sub`（水鱼用户 ID）。
 *
 * **只解不验**。这串令牌是机器人刚从水鱼账号服务取回来的，用它比对
 * "兑换出的账号"与"换票换到的账号"是否同一个，属于自洽性检查，不是安全校验——
 * 真正的验签由资源服务器做。
 *
 * 实现上注意两点（都踩过）：
 * - 填充数量要写成 `(4 - (len % 4)) % 4`。写成 `-len % 4` 会得到**负数**
 *   （JS 的 `%` 跟随被除数符号），`'='.repeat(负数)` 抛 RangeError，
 *   而这个异常会被下面的 catch 吃掉，表现为"某些 token 静默解析不出 sub"。
 * - `Buffer.from(str, 'base64url')` 不接受已经带 `=` 的字符串，会静默解出空内容。
 *   所以先去掉原有填充、补到 4 的倍数，再按 base64 解（base64url 只是 `-_` 替 `+/`）。
 * @returns {string|null}
 */
export function tokenSubject(accessToken) {
  try {
    const raw = String(accessToken).split('.')[1];
    if (!raw) return null;
    const b64 = raw.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')).sub ?? null;
  } catch {
    return null;
  }
}

/** 进程内令牌缓存（**不落盘**，见文件头不变量 3）。 */
export function createTokenCache() {
  const map = new Map();
  return {
    get(ref) {
      const hit = map.get(ref);
      if (!hit) return null;
      if (hit.expiresAt <= Date.now()) { map.delete(ref); return null; }
      return hit.token;
    },
    set(ref, token, expiresInSec) {
      map.set(ref, { token, expiresAt: Date.now() + Math.max(Number(expiresInSec) - EXPIRES_MARGIN_SEC, 0) * 1000 });
    },
    discard(ref) { map.delete(ref); },
    size() { return map.size; },
  };
}

/** 把配置补全成一份可用的设置。 */
export function normalizeConfig(raw = {}) {
  const cfg = { ...DEFAULTS, ...(raw ?? {}) };
  cfg.baseUrl = String(cfg.baseUrl).replace(/\/+$/, '');
  cfg.authUrl = String(cfg.authUrl).replace(/\/+$/, '');
  if (cfg.proxy) cfg.baseUrl = `${String(cfg.proxyUrl).replace(/\/+$/, '')}/maimaidxprober`;
  return cfg;
}

/** OAuth 是否已配置（缺凭据时相关功能应明确报"未配置"，而不是发一个必然失败的请求）。 */
export function oauthConfigured(cfg) {
  return Boolean(cfg?.clientId && cfg?.clientSecret);
}

/** 构造客户端。`fetchImpl` 可注入，便于离线测试。 */
export function createClient(rawConfig = {}, { fetchImpl = globalThis.fetch, tokenCache = createTokenCache() } = {}) {
  const cfg = normalizeConfig(rawConfig);

  /** 发一次表单请求（OAuth 端点用的是 application/x-www-form-urlencoded）。 */
  async function postForm(url, data) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(data).toString(),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 时下面按文本处理 */ }
    return { ok: res.ok, status: res.status, json, text };
  }

  /** 发一次 JSON 请求。 */
  async function request(method, url, { json, token, headers = {} } = {}) {
    const h = { ...headers };
    if (json !== undefined) h['content-type'] = 'application/json';
    if (token) h.authorization = `Bearer ${token}`;
    const res = await fetchImpl(url, {
      method,
      headers: h,
      body: json === undefined ? undefined : JSON.stringify(json),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* 保留 text */ }
    return { ok: res.ok, status: res.status, body, text };
  }

  return {
    cfg,
    tokenCache,

    // ── OAuth ────────────────────────────────────────────────────────────────

    /**
     * 发起绑定：返回给用户点开的授权链接。
     * 顺带丢弃缓存令牌——绑到另一个账号后旧令牌仍会存活到过期，
     * 那段时间查出来的还是上一个账号的成绩。
     */
    async deviceAuthorization(qqid) {
      const ref = subjectRef(qqid, cfg.clientId);
      tokenCache.discard(ref);
      const r = await postForm(`${cfg.authUrl}/oauth/device_authorization`, {
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        scope: cfg.scope,
        subject_ref: ref,
        binding_label: bindingLabel(qqid),
        // 改由用户回填确认码收尾；带上它之后 device_code 换不到令牌——这正是它的意义
        handoff: 'code',
      });
      if (!r.ok) return { ok: false, error: oauthError(r) };
      return { ok: true, data: r.json };
    },

    /**
     * 用用户发回来的确认码兑换一次令牌，完成绑定。
     * 一并送 subject_ref，让水鱼比对"回填这串码的人"与"发起绑定的人"是否同一个。
     */
    async redeem(qqid, confirmationCode) {
      const r = await postForm(`${cfg.authUrl}/oauth/token`, {
        grant_type: 'urn:diving-fish:params:oauth:grant-type:confirmation-code',
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        confirmation_code: String(confirmationCode ?? '').trim(),
        subject_ref: subjectRef(qqid, cfg.clientId),
      });
      if (!r.ok) return { ok: false, error: oauthError(r) };
      return { ok: true, data: r.json };
    },

    /** 换取代该用户访问的令牌（命中缓存则复用）。 */
    async accessToken(qqid, { refresh = false } = {}) {
      const ref = subjectRef(qqid, cfg.clientId);
      if (refresh) tokenCache.discard(ref);
      else {
        const cached = tokenCache.get(ref);
        if (cached) return { ok: true, token: cached, cached: true };
      }
      const r = await postForm(`${cfg.authUrl}/oauth/token`, {
        grant_type: 'urn:diving-fish:params:oauth:grant-type:on-behalf-of',
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        subject: `ref:${ref}`,
        scope: cfg.scope,
      });
      if (!r.ok) return { ok: false, error: oauthError(r) };
      tokenCache.set(ref, r.json.access_token, r.json.expires_in);
      return { ok: true, token: r.json.access_token, cached: false };
    },

    // ── 查询（需要授权）────────────────────────────────────────────────────

    /** 查该用户的 B50（best 50）。 */
    async userB50(qqid) {
      const t = await this.accessToken(qqid);
      if (!t.ok) return t;
      const r = await request('GET', `${cfg.baseUrl}/player/records`, { token: t.token });
      if (!r.ok) return { ok: false, error: apiError(r) };
      return { ok: true, data: r.body };
    },

    /** 查该用户某首歌的成绩。 */
    async userRecord(qqid, musicId) {
      const t = await this.accessToken(qqid);
      if (!t.ok) return t;
      const r = await request('POST', `${cfg.baseUrl}/player/record`, { token: t.token, json: { music_id: Number(musicId) } });
      if (!r.ok) return { ok: false, error: apiError(r) };
      return { ok: true, data: r.body };
    },

    // ── 查询（公开，无需授权）──────────────────────────────────────────────

    /**
     * 公开 B50：按用户名查，**无需授权**。
     *
     * 这条路径之所以可用，是因为数据是用户自己在水鱼上选择公开的；
     * 未绑定的用户也能用它——这正是原项目保留它的理由。
     */
    async publicB50(username) {
      const r = await request('POST', `${cfg.baseUrl}/query/player`, { json: { username: String(username ?? '').trim(), b50: true } });
      if (!r.ok) return { ok: false, error: apiError(r) };
      return { ok: true, data: r.body };
    },

    /** 曲库（公开）。 */
    async musicData() {
      const r = await request('GET', `${cfg.baseUrl}/music_data`);
      if (!r.ok) return { ok: false, error: apiError(r) };
      return { ok: true, data: r.body };
    },

    /** 按 QQ 号查（公开）——**仅用于用户自己公开过资料的场景**。 */
    async publicByQQ(qqid) {
      const r = await request('POST', `${cfg.baseUrl}/query/player`, { json: { qq: String(qqid), b50: true } });
      if (!r.ok) return { ok: false, error: apiError(r) };
      return { ok: true, data: r.body };
    },
  };
}

/** 把 OAuth 端点的错误翻成用户能照着做的话。 */
function oauthError(r) {
  const code = r.json?.error ?? '';
  if (code === 'consent_required') return '这个 QQ 还没授权（或已在水鱼那边撤销）。先发「绑定水鱼」走一次授权。';
  if (code === 'subject_mismatch') return '确认码是真的，但不是发给这个 QQ 的——多半是把别人转发来的码当成了自己的。请自己重新发起绑定。';
  if (code === 'invalid_grant') return '确认码无效：可能不存在、已过期、已用过，或出自别的应用。请重新发起绑定。';
  return `水鱼账号服务返回 ${r.status}${code ? `（${code}）` : ''}。`;
}

/** 把资源服务器的错误翻成人话。 */
function apiError(r) {
  const body = r.body;
  if (r.status === 400 && body) {
    const msg = body.message || body.msg;
    if (msg) return `查询被拒：${msg}`;
  }
  if (r.status === 403) return '查询被拒（403）。若是自己的成绩，请先发「绑定水鱼」完成授权。';
  if (r.status === 404) return '查不到这个用户。请确认用户名写对了，或先用「绑定水鱼」绑定。';
  if (r.status === 429) return '请求太频繁，水鱼那边限流了，稍等一会儿再试。';
  return `查询失败：HTTP ${r.status}`;
}
