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
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { FEATURE_KEYS } from './features.js';
import { imageDir } from './maimai/action.js';

/**
 * HTTP 路由前缀。
 *
 * 收敛成一个常量而不是散落的字面量：改前缀时要一处改全，漏一处就会出现
 * "某条路径没登记"——而那种失效的表现是端点 405/404，极难从现象反推。
 *
 * 为什么从 `/qqbridge-plus` 换到 `/qqbx`：旧前缀下实测怎么登记都拿不到
 * `/action`（一直落到 fallback 回 405），而全新前缀是空的、没有任何占位。
 * 桥接侧的对应常量在 config.json 的 featureCommand.baseUrl + 代码里的路径，
 * 两边必须一起改。
 */
export const ROUTE_PREFIX = '/qqbx';

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
 *   POST /qqbridge-plus/action            { action, args } 执行任意 action（桥接转发用）
 *   GET  /qqbridge-plus/image?file=<名>   取本插件生成的图片（舞萌成绩图）
 *
 * @param {object} opts
 * @param {object} opts.webServer ctx.webServer（必须已 inject）
 * @param {object} opts.store     createFeatureStore() 的结果
 * @param {string} opts.token     期望的令牌（来自 state/console-token）
 * @param {(msg: string) => void} [opts.log]
 * @param {object} [opts.ctx]     传给 runAction 的上下文（提供 /action 路由）
 * @param {Function} [opts.runAction] 执行 action；缺省则 /action 返回 501
 * @returns {() => void} 注销函数
 */
export function registerFeatureApi({ webServer, store, token, log = () => {}, ctx = null, runAction = null, imageDirOverride = null }) {
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

      // 诊断：报告本 handler 登记了哪些路由。
      // 存在的理由：端点在 handler 里明明写了却"走不到"（落到 fallback 回 405/404）时，
      // 唯一能定位的办法就是看注册环节到底成了几条——这条曾经耗掉很久，别再靠猜。
      if (req.method === 'GET' && url.searchParams.get('diag') === '1') {
        json(res, 200, {
          ok: true,
          file: import.meta.url,
          registered: handler.routeReport?.ok ?? [],
          failed: handler.routeReport?.failed ?? [],
        });
        return;
      }

      if (req.method === 'GET' && route === `${ROUTE_PREFIX}/features`) {
        json(res, 200, { ok: true, text: store.render(), features: { ...store.effective }, overrides: store.currentOverrides() });
        return;
      }
      if (req.method === 'POST' && route === `${ROUTE_PREFIX}/features/set`) {
        const body = await readJsonBody(req);
        const r = store.set(String(body.key ?? ''), body.value);
        if (!r.ok) { json(res, 400, { ok: false, error: r.error }); return; }
        json(res, 200, { ok: true, text: store.render(), features: { ...store.effective } });
        return;
      }
      if (req.method === 'POST' && route === `${ROUTE_PREFIX}/features/reset`) {
        const r = store.reset();
        if (!r.ok) { json(res, 400, { ok: false, error: r.error }); return; }
        json(res, 200, { ok: true, text: store.render(), features: { ...store.effective } });
        return;
      }

      // ── 通用 action 端点 ────────────────────────────────────────────────
      // 存在的理由：让**桥接能把任意 action 转发进来**，从而"在 QQ 里发一条命令就能查分"。
      // 没有它的话，只有 features 系列能被 QQ 调用，别的 action 只能在 DSH 里让模型调。
      if (req.method === 'POST' && route === `${ROUTE_PREFIX}/action`) {
        if (typeof runAction !== 'function') { json(res, 501, { ok: false, error: '本插件未提供 action 端点' }); return; }
        // 上限给 64KB：action 参数都很小（maimai 的 code/qq/query 之类），
        // 出图走的是文件路径而不是把 PNG 塞进请求体。
        const body = await readJsonBody(req, 65536);
        const action = String(body.action ?? '').trim();
        if (!action) { json(res, 400, { ok: false, error: '缺少 action' }); return; }
        const result = await runAction(ctx, action, body.args ?? body);
        const text = typeof result === 'string' ? result : (result?.text ?? '');
        json(res, 200, { ok: true, text });
        return;
      }

      // ── 出图下载 ────────────────────────────────────────────────────────
      // 只允许读**本插件自己生成的图**（舞萌成绩图目录下的文件），
      // 用 basename 归一化挡掉 ../ 穿越；不做通用文件服务。
      if (req.method === 'GET' && route === `${ROUTE_PREFIX}/image`) {
        const raw = String(url.searchParams.get('file') ?? '').trim();
        const base = path.basename(raw);
        if (!base || base !== raw || !/^[\w.-]+\.png$/i.test(base)) {
          json(res, 400, { ok: false, error: 'file 必须是本插件生成的图片文件名（不含路径）' });
          return;
        }
        // 用**配置里的**出图目录：图可能落在别处（例如系统盘不够、挪到了别的盘），
        // 这里若硬编码默认临时目录就会取不到图——而现象是"文本发了、图没有"。
        const dir = imageDir(imageDirOverride);
        const full = path.join(dir, base);
        // 再确认一次解析结果没跑出目录（防符号链接/特殊名）
        if (path.dirname(path.resolve(full)) !== path.resolve(dir)) {
          json(res, 400, { ok: false, error: '路径越界' });
          return;
        }
        let buf;
        try { buf = fs.readFileSync(full); } catch {
          json(res, 404, { ok: false, error: `找不到图片：${base}` });
          return;
        }
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length, 'cache-control': 'no-store' });
        res.end(buf);
        return;
      }

      json(res, 404, { ok: false, error: `未知路由：${req.method} ${route}`, keys: FEATURE_KEYS });
    } catch (error) {
      json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  };

  // webServer.register 返回注销函数；交给 ctx.effect 管理生命周期。
  //
  // ⚠️ **每条子路径都要单独登记**，一条前缀兜不住全部。
  // 实测（探针直接看响应体是不是本 handler 的"未知路由"文案）：
  //     GET /qqbridge-plus/features/anything → 命中本 handler
  //     POST /qqbridge-plus/action           → 未命中（405，来自 fallback）
  //     GET  /qqbridge-plus/image            → 未命中（404）
  // 注册的 `path` 是**具体路由键**，前缀语义并没有把子路径都带进来。
  // 只登记某一条的现象极具误导性：`/features` 一切正常，新端点却像"不存在"。
  //
  // 每条**独立 try/catch**：一次注册失败（比如与残留路由撞名）不该让后面的路径
  // 全部登记不上——那种"静默少登记几条"正是最难查的形态。失败会记进 routeReport，
  // 并由 `?diag=1` 回报出来。
  const wanted = [
    ['exact', `${ROUTE_PREFIX}/features`],
    ['exact', `${ROUTE_PREFIX}/features/`],
    ['exact', `${ROUTE_PREFIX}/features/set`],
    ['exact', `${ROUTE_PREFIX}/features/reset`],
    ['exact', `${ROUTE_PREFIX}/action`],
    ['exact', `${ROUTE_PREFIX}/image`],
    ['prefix', `${ROUTE_PREFIX}/`],
  ];
  const routeReport = { ok: [], failed: [] };
  const disposes = [];
  for (const [kind, path] of wanted) {
    try {
      disposes.push(webServer.register({ kind, path, handler }));
      routeReport.ok.push(`${kind}:${path}`);
    } catch (error) {
      routeReport.failed.push(`${kind}:${path} → ${error?.message ?? error}`);
      log(`路由注册失败 ${kind}:${path}：${error?.message ?? error}`);
    }
  }
  if (routeReport.failed.length) {
    log(`共 ${routeReport.failed.length} 条路由未登记，相关端点将不可达：${routeReport.failed.join(' | ')}`);
  }

  // 把注册结果挂在 handler 上，供 ?diag=1 查询（排查"端点明明写了却走不到"）。
  handler.routeReport = routeReport;

  // 返回一个注销函数，把已登记的路由全部撤掉。
  return () => { for (const d of disposes) { try { d(); } catch { /* 单个取消失败不影响其余 */ } } };
}
