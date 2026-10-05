/**
 * 给 qq-bridge 用的 HTTP 开关接口。
 *
 * 为什么走 HTTP：管理命令在**桥接进程**里执行，而开关状态在**插件进程**里（同一
 * DSH 宿主）。两个进程之间现成的通道就是本机的 web server，所以插件注册一个端点、
 * 桥接调它。这样避免了两边各存一份状态（那必然漂移）。
 *
 * ⚠️ 鉴权是必须的，不是可选的：
 *   `features` 决定工具面的宽窄。放宽意味着模型能读到桥接配置摘要、余额、会话列表——
 *   如果端点无鉴权，**本机任意进程**都能把它全打开。所以：
 *     · 仅绑定回环地址（下面显式校验 remote 地址）；
 *     · 每次请求都必须带令牌，令牌与桥接控制台令牌同源
 *       （`bridgeDir/state/console-token`，已是本机文件权限保护的秘密）；
 *     · 令牌比较用定长比较，避免时序侧信道。
 *   桥接本来就读得到那个令牌文件，所以不需要再引入新的共享秘密。
 *
 * @module dsh-plugin-qqbridge-plus/http-api
 */
import { timingSafeEqual } from 'node:crypto';
import { FEATURE_KEYS } from './features.js';

/** 令牌定长比较（长度不同直接判否，不泄露前缀）。 */
function tokenEquals(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (x.length === 0 || x.length !== y.length) return false;
  try { return timingSafeEqual(x, y); } catch { return false; }
}

/** 是否来自本机回环（只允许本机调用）。 */
function isLoopback(req) {
  const addr = req?.socket?.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** 读请求体（有上限，防止被塞爆内存）。 */
async function readJsonBody(req, limit = 8192) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** 统一 JSON 回复。 */
function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * 注册端点。
 *
 * 路由：
 *   GET  /qqbridge-plus/features          列出开关（含覆盖标记）
 *   POST /qqbridge-plus/features/set      { key, value } 设置单个开关
 *   POST /qqbridge-plus/features/reset    清空运行时覆盖
 *
 * @param {object} opts
 * @param {object} opts.webServer ctx.webServer（必须已 inject）
 * @param {object} opts.store     createFeatureStore() 的结果
 * @param {string} opts.token     期望的令牌（来自 state/console-token）
 * @param {(msg: string) => void} [opts.log]
 * @returns {() => void} 注销函数
 */
export function registerFeatureApi({ webServer, store, token, log = () => {} }) {
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('webServer 不可用（需在 inject 中声明 webServer）');
  }
  if (!token) {
    // fail-closed：没有令牌就不注册端点，而不是注册一个无鉴权的端点。
    log('未取得控制台令牌，已跳过 HTTP 开关接口注册（QQ 内开关将不可用）');
    return () => {};
  }

  /** 鉴权 + 回环校验；返回 null 表示已放行，否则返回错误响应。 */
  const guard = (req, res) => {
    if (!isLoopback(req)) {
      json(res, 403, { ok: false, error: '仅允许本机调用' });
      return false;
    }
    // 令牌可经 query 或 header 传；桥接用 header。
    let provided = req.headers['x-qqbridge-token'];
    if (!provided) {
      try { provided = new URL(req.url, 'http://127.0.0.1').searchParams.get('token'); } catch {}
    }
    if (!tokenEquals(provided, token)) {
      json(res, 401, { ok: false, error: '令牌无效' });
      return false;
    }
    return true;
  };

  const handler = async (req, res) => {
    try {
      if (!guard(req, res)) return;
      const url = new URL(req.url, 'http://127.0.0.1');
      const route = url.pathname.replace(/\/+$/, ''); // 容忍尾斜杠

      if (req.method === 'GET' && route === '/qqbridge-plus/features') {
        json(res, 200, { ok: true, text: store.render(), features: { ...store.effective }, overrides: store.currentOverrides() });
        return;
      }
      if (req.method === 'POST' && route === '/qqbridge-plus/features/set') {
        const body = await readJsonBody(req);
        const r = store.set(String(body.key ?? ''), body.value);
        if (!r.ok) { json(res, 400, { ok: false, error: r.error }); return; }
        json(res, 200, { ok: true, text: store.render(), features: { ...store.effective } });
        return;
      }
      if (req.method === 'POST' && route === '/qqbridge-plus/features/reset') {
        const r = store.reset();
        if (!r.ok) { json(res, 400, { ok: false, error: r.error }); return; }
        json(res, 200, { ok: true, text: store.render(), features: { ...store.effective } });
        return;
      }
      json(res, 404, { ok: false, error: `未知路由：${req.method} ${route}`, keys: FEATURE_KEYS });
    } catch (error) {
      json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  };

  // webServer.register 返回注销函数；交给 ctx.effect 管理生命周期。
  return webServer.register({ path: '/qqbridge-plus/features', handler });
}
