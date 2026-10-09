/**
 * 插件配置 schema。
 *
 * 这个导出**不只是**给人看的文档——它决定 DSH 设置页能不能打开这个插件的配置面板。
 * DSH（`dsh-settings`）按三条定位设置命名空间：
 *
 *   ① 存在一个 loader entry，其 **id 恰好等于命名空间名**（`qqbridge-plus`）；
 *   ② 该 entry 的插件模块导出 `Config`（读 `entry.fiber.runtime.Config`）；
 *   ③ `Config` 里**至少一个字段带 `volatile` 标记**，否则抛
 *      "Plugin entry ... has no volatile fields"。
 *
 * ⚠️ 三个踩过的坑，别改回去：
 *
 *   · `Config` **不能是普通对象**。loader 会拿它当 schema 用，普通对象会让 entry 在
 *     **apply 之前**就失败（现象：entry 建出来了、apply 一行没跑，且不给原因）。
 *   · 不能用 `.volatile()` 这个语法糖——它只存在于 DSH 自带的那份 schemastery，
 *     裸包名解析到的那份**没有**该方法。用 `.extra('volatile', true)`。
 *   · **不要用 schema 求值来算默认值**：实测 schemastery 3.18.4 里，
 *     字段一旦带 `.extra('volatile', true)`，`Config({})` 求值会给该字段返回 `{}`
 *     而不是它的 default（`meta.default` 仍在，只是求值时没被应用）。
 *     所以默认值走下面的 `DEFAULTS` 常量，schema **只**负责设置页的表单形状。
 *     （`qq-mode-console` 同样用 schema 求值拿默认值，因此它的默认值实际上也没生效过；
 *     只是 DSH settings 读 schema 生成表单、不做求值，所以一直没人发现。）
 *
 * `volatile` 的语义是「可热改、不重挂载」。所有面向用户的字段都标它，
 * 这样设置页里改完立即写回 entry config，不用重装插件。
 *
 * @module dsh-plugin-qqbridge-plus/config-schema
 */
// 只依赖同目录的 features.js（本地文件，必然可解析）。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { FEATURE_DEFAULTS, FEATURE_KEYS, FEATURE_LABELS } from './features.js';
// 零依赖的常量模块：让它挂进入口依赖链是安全的（它没有 import，也没有 schemastery）。
// 刻意**不**从 divingfish.js 引——那会把整个客户端模块挂上入口，一旦它加载失败，
// 插件在导入期就没了（见文件末尾关于硬规则 2 的说明）。
import { DEFAULT_SCOPE, DF_BASE_URL, DF_AUTH_URL, DF_PROXY_URL } from './maimai/constants.js';

/**
 * 解析 schemastery，返回可直接用的 `z`。
 *
 * 坑记录（两条都是实测出来的，别改回去）：
 *
 * ① **必须给具体入口文件，不能给包目录**。`createRequire(dir)` 按 CJS 规则找
 *    `package.json` 的 `main`，而 schemastery 的入口只写在 `exports` 的 `import`
 *    条件里 ⇒ 传目录会 MODULE_NOT_FOUND。
 *
 * ② **拿到的可能是模块命名空间而不是 `z` 本身**。`lib/index.mjs` 是 ESM，
 *    用 `createRequire`（CJS）加载它会得到 `{ default: z, ... }`，于是
 *    `z.string` 不是函数 ⇒ 整个模块导入失败、插件完全不出现。
 *    所以下面统一用 `unwrap()` 取到真正的 `z`，并且加载这一步改成**先 resolve 入口，
 *    再动态 import**（import 对 ESM/CJS 都能给出正确的默认导出）。
 *
 * 任一条路径都拿不到时返回 `null` ⇒ 不导出 `Config`（合法降级，见文件头）。
 */
function resolveSchemasteryEntry() {
  // ① 常规：插件目录有自己的 node_modules（走 exports 的 import 条件）
  try {
    return createRequire(import.meta.url).resolve('@deepseek-ai/schemastery');
  } catch { /* 继续试候选路径 */ }
  // ② 兜底：宿主 profile 的 node_modules（link/junction 装配时的常见位置）
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) {
    const entries = ['lib/index.mjs', 'lib/index.cjs', 'lib/index.js', 'index.js'];
    for (const profile of ['desktop', 'web']) {
      const base = path.join(home, '.dsh', 'profiles', profile, 'node_modules', '@deepseek-ai', 'schemastery');
      for (const rel of entries) {
        const p = path.join(base, rel);
        try {
          if (fs.existsSync(p)) return p;
        } catch { /* 试下一个 */ }
      }
    }
  }
  return null;
}

/** 从"可能是命名空间"的加载结果里取出真正的 schemastery。 */
function unwrapSchemastery(mod) {
  if (mod && typeof mod.object === 'function') return mod;          // 已经是 z
  const d = mod?.default;
  if (d && typeof d.object === 'function') return d;                // ESM 命名空间
  return null;
}

/** 同步加载（裸包名解析成功且是 CJS 时可用）。 */
function loadSchemasterySync() {
  try {
    const p = createRequire(import.meta.url).resolve('@deepseek-ai/schemastery');
    return unwrapSchemastery(createRequire(import.meta.url)(p));
  } catch { return null; }
}

/**
 * 最终取到的 schemastery（拿不到就是 null）。
 *
 * 这里用**顶层 await**：ESM 模块支持，而 `Config` 必须在模块求值时就构建好——
 * 导出 Promise 是不行的（loader 读 `entry.fiber.runtime.Config` 时拿到的会是 Promise）。
 * 顶层 await 只在这里用一次，且解析失败会落到 null 分支，不会阻塞或抛错。
 */
const z = loadSchemasterySync() ?? unwrapSchemastery(await import(pathToFileURL(resolveSchemasteryEntry() ?? '').href).catch(() => null));

/**
 * 配置默认值（**单一来源**，普通常量）。
 * 不写成两份：schema 的 default 文案与这里的值必须一致，测试会校验这一点。
 *
 * ⚠️ 这两个常量刻意放在 schemastery 的 import **之前**，且不依赖任何外部模块
 * （除了同目录的 features.js）。原因：`Config` 需要 schemastery 才能构建，
 * 而 schemastery 是裸包名依赖；万一它在某个环境下解析不到，**常量必须仍然可用**——
 * 否则 DEFAULTS 变空，apply 里的兜底也一起失效（表现为 sectionOrder undefined
 * ⇒ `order must be a finite number` ⇒ entry 装配失败）。常量与 schema 的失败域要分开。
 */
export const DEFAULTS = {
  bridgeDir: 'F:/router/qq-bridge',
  consoleBase: 'http://127.0.0.1:3100',
  consoleToken: '',
  timeoutMs: 8000,
  personaSection: true,
  sectionOrder: 7,
  features: { ...FEATURE_DEFAULTS },
  maimai: {
    baseUrl: DF_BASE_URL,
    authUrl: DF_AUTH_URL,
    // OAuth 应用凭据：向水鱼申请后填这里。留空时只能走公开查询，
    // 「查自己的成绩」不可用——插件会明确说明，而不是发一个必然失败的请求。
    clientId: '',
    clientSecret: '',
    // 权限范围引用 constants.js 的单一来源，避免"配置写一套、文档写另一套"
    scope: DEFAULT_SCOPE,
    proxy: false,
    proxyUrl: DF_PROXY_URL,
  },
};

/** 字段说明（供设置页显示）。 */
export const FIELD_DESCRIPTIONS = {
  bridgeDir: 'qq-bridge 根目录（含 config.json 与 src/）',
  consoleBase: '桥接控制台基址',
  consoleToken: '控制台令牌；留空则自动读 bridgeDir/state/console-token',
  timeoutMs: '单次控制台请求超时（毫秒）',
  personaSection: '是否注册"何时用本工具"的提示词段',
  sectionOrder: '提示词段顺序（升序，persona 为 0）',
  features: '功能开关：关掉的功能调用时会明确提示，而不是静默失败',
  maimai: '舞萌DX 查分（水鱼查分器）：接口地址与 OAuth 应用凭据',
};

/**
 * 是否成功拿到了 schemastery。
 * `false` 时本模块**不导出 `Config`**——那是个合法状态：插件照常工作，
 * 只是 DSH 设置页没有这些字段可显示。**不要**在 z 缺失时去构建 schema（会在导入期抛错，
 * 那样整个插件都不出现，比"少一个设置页字段"糟得多）。
 */
export const HAS_SCHEMASTERy = z !== null;

/** 功能开关的子 schema（每个功能一个布尔，附中文说明）。 */
function buildFeaturesSchema() {
  return z.object(
    Object.fromEntries(
      FEATURE_KEYS.map((k) => [
        k,
        z.boolean().default(DEFAULTS.features[k])
          .description(`${FEATURE_LABELS[k]}（关闭后调用会明确提示已关闭）`),
      ]),
    ),
  );
}

/**
 * 舞萌查分的子 schema。
 *
 * 为什么要单独建：`Config` 是 schemastery schema，**没声明的键可能让组合行配置被拒**。
 * 用户要把水鱼的 client_id / client_secret 写进 patch，就必须在这里有对应字段，
 * 否则"配置写了但被校验挡掉"，而且不会给出好懂的错。
 */
function buildMaimaiSchema() {
  const d = DEFAULTS.maimai;
  return z.object({
    baseUrl: z.string().default(d.baseUrl)
      .description('水鱼查分器接口地址（境外服务器可开 proxy）'),
    authUrl: z.string().default(d.authUrl)
      .description('水鱼账号服务地址（OAuth 授权与令牌，不要指向中转）'),
    clientId: z.string().default(d.clientId)
      .description('OAuth 应用 ID：在 https://auth.diving-fish.com/apps 申请'),
    clientSecret: z.string().default(d.clientSecret)
      .description('OAuth 应用密钥；只用于换取用户令牌，插件不保存用户凭据'),
    scope: z.string().default(d.scope)
      .description('OAuth 权限范围，空格分隔；默认只读资料，不要加 write'),
    proxy: z.boolean().default(d.proxy)
      .description('是否经中转访问查分接口（境外服务器适用）'),
    proxyUrl: z.string().default(d.proxyUrl)
      .description('中转基址，proxy=true 时生效'),
  });
}

/**
 * 面向用户的配置 schema。
 * 字段名必须**覆盖 profile patch 里写的所有键**，否则组合行配置可能被拒。
 *
 * ⚠️ 当前**没有任何 volatile 标记**——这是"先让插件能加载"的最小安全形态。
 * cordis 对 volatile 的校验比想象中严格：实测不论标在叶子(features.status)还是
 * 标在嵌套对象(features)上，都会抛
 *   `$.features.status volatile fields require a fixed object path
 *     without an enclosing volatile field`
 * 一旦抛错，entry 在 apply **之前**就失败：插件 installed=true、工具却不存在，
 * 日志只有一句 "1 entry did not activate"。
 *
 * ⚠️⚠️ **本插件刻意不给任何字段标 `volatile`**，这是权衡后的结论，别改回去：
 *
 * 触发这件事的实测证据（plugin-apply.json / last-apply-config.json 里那份 rawConfig）：
 *   loader 拿本 schema 去求值 entry 配置后，传给 apply 的是
 *     { bridgeDir: {}, consoleBase: {}, consoleToken: {}, timeoutMs: {},
 *       personaSection: {}, sectionOrder: {} }        ← volatile 字段全成了 {}
 * 也就是说：如果用户在设置页点了"保存"，这些字段会被**写回成 `{}`**，
 * 插件的 bridgeDir/consoleToken 等配置当场损坏——**一个能把配置写坏的 UI，
 * 比没有可写 UI 更糟**。所以宁可让设置页只读。
 *
 * 需要"可写 + 热改"时，正确做法不是加 volatile，而是先把嵌套摊平成顶层键
 * 再逐字段评估；在验证过"保存后 rawConfig 仍为真实值"之前，不要开这个口子。
 *
 * 另注：嵌套对象(features)标 volatile 还会直接让 entry 被 cordis 拒：
 *   `volatile fields require a fixed object path without an enclosing volatile field`
 *
 * 目前设置页能**显示**这些字段（有 description、有默认值），但不可写；
 * 改配置请用 profile 的 cordis.patch.yml，或 qqbridge 工具的 features/firstRun action。
 *
 * 拿不到 schemastery 时为 `undefined`（见 HAS_SCHEMASTERy）。loader 见到 `Config`
 * 是 undefined 会跳过校验——这正是我们要的降级，而不是抛错。
 */
export const Config = HAS_SCHEMASTERy ? z.object({
  bridgeDir: z.string().default(DEFAULTS.bridgeDir)
    .description(FIELD_DESCRIPTIONS.bridgeDir),
  consoleBase: z.string().default(DEFAULTS.consoleBase)
    .description(FIELD_DESCRIPTIONS.consoleBase),
  consoleToken: z.string().default(DEFAULTS.consoleToken)
    .description(FIELD_DESCRIPTIONS.consoleToken),
  timeoutMs: z.number().default(DEFAULTS.timeoutMs)
    .description(FIELD_DESCRIPTIONS.timeoutMs),
  personaSection: z.boolean().default(DEFAULTS.personaSection)
    .description(FIELD_DESCRIPTIONS.personaSection),
  sectionOrder: z.number().default(DEFAULTS.sectionOrder)
    .description(FIELD_DESCRIPTIONS.sectionOrder),
  features: buildFeaturesSchema()
    .description(FIELD_DESCRIPTIONS.features),
  maimai: buildMaimaiSchema()
    .description(FIELD_DESCRIPTIONS.maimai),
}) : undefined;
