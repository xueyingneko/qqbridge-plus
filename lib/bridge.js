/**
 * QQbridge plus — 与 qq-bridge 通信的底层适配层。
 *
 * 设计要点（为什么这么做）：
 *
 * 1) **判定逻辑只有一份**。本插件不重新实现"计费峰谷 / 唤醒过滤 / 余额告警"，
 *    而是直接 import qq-bridge 自己的纯逻辑模块（src/wake-filters.mjs、
 *    src/whale-balance.js）。两份实现必然漂移——上一轮真实踩过：余额为 NaN 时
 *    一份实现判成 recovered、另一份判成 none，而那是不可逆的关机决策。
 *
 * 2) **运行态从桥接控制台 HTTP 取**，不从 state/*.json 猜。桥接是运行态的唯一权威
 *    （比如"当前生效的推理等级"取决于它内存里的时段状态）。控制台不可达时优雅降级
 *    成 { ok:false }，而不是抛错——本插件不该让宿主因为桥接没开就报错。
 *
 * @module dsh-plugin-qqbridge-plus/bridge
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 默认桥接目录（可在插件 config 里改）。 */
export const DEFAULT_BRIDGE_DIR = 'F:/router/qq-bridge';

/**
 * 把可能是相对路径的 bridgeDir 归一成绝对路径。
 * @param {string} [dir]
 * @returns {string}
 */
export function resolveBridgeDir(dir) {
  const d = String(dir ?? '').trim() || DEFAULT_BRIDGE_DIR;
  return path.resolve(d);
}

/** 桥接是否像一个 qq-bridge 目录（用几个必须存在的文件判断）。 */
export function looksLikeBridge(dir) {
  try {
    return fs.existsSync(path.join(dir, 'config.json'))
      && fs.existsSync(path.join(dir, 'src', 'bridge.js'))
      && fs.existsSync(path.join(dir, 'src', 'wake-filters.mjs'));
  } catch {
    return false;
  }
}

/**
 * 动态 import 桥接里的模块。
 *
 * 为什么必须动态：bridgeDir 来自插件配置，import 路径在运行期才知道；
 * 而且用 file:// URL 才能保证 Windows 盘符路径（F:\...）被正确解析。
 *
 * @param {string} dir 桥接根目录
 * @param {string} rel 相对 src 的模块文件名
 * @returns {Promise<object>}
 */
export async function loadBridgeModule(dir, rel) {
  const abs = path.join(dir, 'src', rel);
  if (!fs.existsSync(abs)) {
    throw new Error(`找不到桥接模块 ${abs}（请检查插件配置 bridgeDir 是否指向 qq-bridge 根目录）`);
  }
  return import(pathToFileURL(abs).href);
}

/**
 * 读桥接的控制台令牌。
 *
 * 顺序：显式配置 → 环境变量 → 桥接 state/console-token（qq-bridge 未在 config 里
 * 配 consoleToken 时会把自动生成的令牌持久化到这里）。
 *
 * @param {string} dir 桥接根目录
 * @param {string} [explicit]
 * @returns {string}
 */
export function resolveConsoleToken(dir, explicit) {
  const fromCfg = String(explicit ?? '').trim();
  if (fromCfg) return fromCfg;
  const fromEnv = String(process.env.QQBRIDGE_CONSOLE_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    const p = path.join(dir, 'state', 'console-token');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  } catch {}
  return '';
}

/** 读桥接的 config.json（读不到返回 null，不抛）。 */
export function readBridgeConfig(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 调桥接控制台的一个接口。
 *
 * 失败一律转成 { ok:false, error } —— 调用方（工具）据此给出可读提示，
 * 而不是把网络异常抛到宿主里。
 *
 * @param {object} opts
 * @param {string} opts.base  控制台基址，如 http://127.0.0.1:3100
 * @param {string} opts.token 控制台令牌
 * @param {string} opts.path  形如 /api/status
 * @param {'GET'|'POST'} [opts.method]
 * @param {object} [opts.body]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok:boolean, status?:number, data?:any, error?:string}>}
 */
export async function callConsole({ base, token, path: apiPath, method = 'GET', body, timeoutMs = 8000 }) {
  const url = new URL(apiPath, base);
  if (token) url.searchParams.set('token', token);
  const init = {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {}
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (token) init.headers['x-console-token'] = token;
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text.slice(0, 2000); }
    if (!res.ok) {
      const msg = (data && typeof data === 'object' && (data.error || data.message)) || `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: String(msg), data };
    }
    return { ok: true, status: res.status, data };
  } catch (error) {
    const msg = error?.name === 'TimeoutError' ? `控制台无响应（超时 ${timeoutMs}ms）` : (error?.message ?? String(error));
    return { ok: false, error: msg };
  }
}

/** 拼出插件运行所需的上下文（目录、令牌、基址、插件自检目录）。 */
export function makeContext(config = {}) {
  const dir = resolveBridgeDir(config.bridgeDir);
  const token = resolveConsoleToken(dir, config.consoleToken);
  const base = String(config.consoleBase ?? '').trim() || 'http://127.0.0.1:3100';
  return {
    dir,
    token,
    base,
    timeoutMs: Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 8000,
    // 插件自检/状态落盘目录：放桥接自己的 state 下（同一个 .dsh 生态里最省事，
    // 且桥接的 state/ 已存在、已有 ACL 加固）。
    stateDir: path.join(dir, 'state')
  };
}
