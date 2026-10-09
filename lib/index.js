/**
 * QQbridge plus — DeepSeek Harness 插件入口。
 *
 * 与 qq-bridge 的伴随关系：判定逻辑一律 import qq-bridge 自己的纯模块
 * （src/wake-filters.mjs / src/whale-balance.js），本插件只做取数、编排与排版。
 *
 * ⚠️ 关于 `defineTool` 的导入方式——这里有一段很贵的踩坑史，务必别改回去：
 *
 *   最初用运行时动态 `import()` + 多路径回退来"稳妥地"拿 defineTool。结果在宿主里
 *   出现了最难查的一类失败：`loadHostTools()` 里那条 app.asar 途径**明明报了 import 成功**，
 *   但链上的 `.then` 回调**从未执行**（既不进 `.catch`，也没有任何报错），
 *   表现是"插件 entry 建出来了、apply 也进了，但工具永远不注册"。
 *
 *   而 dsh-plugin-academic-writing 在本环境**正常工作**，它的做法是**模块顶层静态导入**
 *   写死的 app.asar 路径。改为同款静态导入后，导入期即可确定成败（失败会直接是
 *   模块加载错误，而不是静默挂起），与已验证可行的官方插件保持同一形态。
 *
 *   （纯 node 子进程看不到 asar 内部，所以本模块无法在普通 node 里被导入——
 *     这是 Electron 的 asar 特性，不是缺陷；测试请走 test/ 下不导入本文件的用例。）
 *
 * @module dsh-plugin-qqbridge-plus
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from 'file:///E:/deepseek%20haedness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
import { makeContext } from './bridge.js';
import { ACTIONS, runAction } from './tools.js';
import { MAIMAI_ACTIONS } from './maimai/action.js';
import {
  FEATURE_DEFAULTS,
  FEATURE_KEYS,
  FEATURE_LABELS,
  isFeatureOn,
  normalizeFeatures,
  unknownFeatureKeys
} from './features.js';
// 必须导出 Config：DSH 设置页靠它打开本插件的配置面板（机制见 config-schema.js）。
// DEFAULTS 用那边的普通常量——**不要**改用 schema 求值（带 volatile 的字段求值会返回 {}）。
import { Config, DEFAULTS } from './config-schema.js';
import { createFeatureStore } from './feature-store.js';
import { registerFeatureApi } from './http-api.js';

/** Cordis 插件名（注册到 loader）。 */
const name = 'qqbridge-plus';

/**
 * 需要先解析的服务。
 *
 * ⚠️ 必须把**所有会被访问**的服务都列上。Cordis 有一条硬规则：
 * 访问未在 inject 中声明的服务属性会直接抛错——
 * `Error: cannot get property "systemPrompt" without inject`。
 *
 * 我最初只声明了 tools，想用 `if (ctx.systemPrompt)` 做"可选依赖"兜底，
 * 结果**读取这个属性本身就抛错**。而这个错在插件管理器里只表现为
 * `[failed]` / "did not activate"，看不到原因（注入器热注入路径更只报 host ✗）。
 * 本环境 systemPrompt 确实存在，所以直接声明它，不再做运行时试探。
 *
 * `webServer` 是给"管理员在 QQ 里开关功能"用的：桥接进程通过它调本插件的端点。
 */
const inject = ['tools', 'systemPrompt', 'webServer'];

// DEFAULTS 直接从 config-schema.js 引入（那边是普通常量，单一来源）。
// 曾经写成"从 Config schema 求值"，但 schemastery 3.18.4 对带 volatile 的字段
// 求值会返回 {}，拿来做默认值会把配置全变成空对象——详见 config-schema.js 的坑记录。

/**
 * 每个功能对应的一句说明（用于动态拼提示词）。
 * 只描述**开启**的功能——向模型宣传一个已被关掉的 action 会浪费它的尝试。
 */
const FEATURE_BLURBS = {
  status: '`status`（一次看全：模式/就绪/管理员/白名单/余额/档位/各会话）',
  balance: '`balance`（余额、观测新鲜度、自动关机阈值与倒计时）',
  schedule: '`schedule`（计费峰谷与推理档位；`testAt=[时间戳]` 可试算任意时刻）',
  holidays: '`holidays`（节假日表覆盖；`fetch=true` 可现场抓取试算）',
  greeting: '`greeting`（开机/关机提示词配置、目标与各人格卡覆盖）',
  commands: '`commands`（#余额 / #关机 触发词与权限口径）',
  config: '`config`（桥接配置摘要，已脱敏；`key="role.balanceAlarm"` 取子段）',
  features: '`features`（查看本插件的功能开关清单）',
  // 漏了这条的后果：模型不知道有哪些子操作，只能去翻工具 schema 才不会瞎试。
  // 提示词里说清"能用它做什么"比只列出 action 名有用得多。
  maimai: '`maimai`（舞萌DX 查分：`sub=status|b50|song|search|bind|confirm`；'
    + '`b50` 可出成绩图、`search` 支持简写如 ztn；查自己的成绩需本人先完成水鱼授权）',
  firstRun: '`firstRun`（重看首次运行引导：开关改法）',
};

/**
 * 按开关动态生成提示词段。
 * 关闭的功能不会出现在这里，`features` 与 `status` 则始终提及
 * （前者是开关自查入口，后者是总览）。
 * @param {Record<string, boolean>} features
 * @returns {string}
 */
function buildSectionText(features, options = {}) {
  // status / features 始终提及：总览与开关自查——"工具本身怎么用"不该被功能开关影响。
  const always = ['status', 'features'];
  const toggled = FEATURE_KEYS.filter((k) => k !== 'status' && isFeatureOn(features, k));
  const enabled = [...always, ...toggled];
  const lines = ['QQ 机器人（qq-bridge）运维指引：'];
  lines.push('- 需要查看 QQ 机器人的运行状态、余额、推理档位、节假日表或开机/关机提示词时，用 `qqbridge` 工具。');
  lines.push(`- 可用 action：${enabled.map((k) => FEATURE_BLURBS[k] ?? k).join('、')}。`);
  // 只有**首次装配那一轮**才提示配置入口。之后每轮都提示会变成噪音
  // （而且它是靠状态文件判定的，不是"用户还没配过"，反复提示并不准确）。
  if (options.isFirstRun) {
    lines.push('- 本插件为首次装配：功能开关在 DSH 设置页的 qqbridge-plus 面板，或 profile 的 cordis.patch.yml 里改。');
  }
  if (toggled.length === 0) {
    lines.push('- 注意：各功能详查当前均被关闭（可用 `features` 查看开关状态）。');
  }
  lines.push('- 该工具以查询为主：它不修改桥接配置（holidays 的 fetch 也只试算不落盘）。要改配置请改 qq-bridge/config.json 或走桥接控制台。');
  lines.push('- 桥接没在运行时，工具会明确说明"控制台不可达"并给出排查步骤，而不是报错。');
  return lines.join('\n');
}

/**
 * 插件装配。
 * @param {object} ctx Cordis 上下文
 * @param {object} config 组合行配置
 */
function apply(ctx, config) {
  // 防御性兜底：逐字段**按类型**回落默认值。
  //
  // 为什么不能只用 `{...DEFAULTS, ...config}`，也不能只判 undefined/null：
  // loader 会拿导出的 `Config` schema 去求值 entry 配置，而 schemastery（3.18.4）
  // 对**带 volatile 的字段求值会返回 `{}`**（实测；`meta.default` 仍在但没被应用）。
  // 于是传进 apply 的 `sectionOrder` 是个**对象**而不是数字，`systemPrompt.section`
  // 直接抛 `order must be a finite number` ⇒ 整个 entry 装配失败。
  // 而现象只是插件"不存在"，日志只有一句 "1 entry did not activate"——极难定位。
  //
  // 所以兜底规则是：值与兜底值**类型不符**就视为无效，回落到兜底值。
  // 这样无论 loader 传来 undefined、null、`{}` 还是错误类型，装配都不会崩。
  const raw = config ?? {};
  const pick = (key, fallback) => {
    const v = raw[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== typeof fallback) return fallback;          // 类型不符（如 {} / "7"）
    if (typeof v === 'number' && !Number.isFinite(v)) return fallback; // NaN / Infinity
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return fallback;
    return v;
  };
  const cfg = {
    ...DEFAULTS,
    bridgeDir: pick('bridgeDir', DEFAULTS.bridgeDir),
    consoleBase: pick('consoleBase', DEFAULTS.consoleBase),
    consoleToken: pick('consoleToken', DEFAULTS.consoleToken),
    timeoutMs: pick('timeoutMs', DEFAULTS.timeoutMs),
    personaSection: pick('personaSection', DEFAULTS.personaSection),
    sectionOrder: pick('sectionOrder', DEFAULTS.sectionOrder),
    features: pick('features', DEFAULTS.features),
    maimai: pick('maimai', DEFAULTS.maimai),
  };
  const bridgeCtx = makeContext(cfg);
  // 舞萌查分用的是水鱼查分器，与 qq-bridge 无关，所以它的配置也挂在 ctx 上
  // （tools.js 的 maimai 分支会读，且**不受桥接目录探测的拦截**）。
  bridgeCtx.maimai = cfg.maimai;
  // 功能开关：归一化后挂到 ctx 上（tools.js 的 runAction 在分发前据此门禁）。
  // 功能开关：用运行时存储，而不是启动时快照。
  // 关键区别：store.effective 是**同一个对象引用**，管理员从 QQ 改开关时
  // 就地改它 → runAction 的门禁立刻按新值工作，**无需重启 DSH**。
  // 启动时快照会让"QQ 里改了但没生效"变成必然，这是本需求的核心约束。
  const featureStore = createFeatureStore({
    stateDir: bridgeCtx.stateDir,
    fromConfig: normalizeFeatures(cfg.features),
  });
  bridgeCtx.features = featureStore.effective;
  bridgeCtx.featureStore = featureStore;
  const typoKeys = unknownFeatureKeys(cfg.features);

  // 落盘自检：GUI 下看不到宿主 console，而 loader 的启动失败往往只表现为
  // `[failed]` / "did not activate"，不给原因。把装配过程写成**历史数组**落盘，
  // 是这类问题唯一不用猜的判据——本次就是靠它从"看起来注册成功了"
  // 一路定位到"访问未 inject 的 systemPrompt 直接抛错"的真实原因。
  // 记历史数组而非单个 phase：曾因"覆盖写"误判成卡在某一步。
  const trace = [];
  const stamp = (phase, extra = {}) => {
    trace.push({ t: new Date().toISOString(), phase, ...extra });
    try {
      fs.mkdirSync(bridgeCtx.stateDir, { recursive: true });
      fs.writeFileSync(path.join(bridgeCtx.stateDir, 'plugin-apply.json'), JSON.stringify({
        at: new Date().toISOString(), pid: process.pid, bridgeDir: bridgeCtx.dir, trace
      }, null, 2), 'utf8');
    } catch { /* 自检失败绝不能影响装配 */ }
  };
  stamp('apply-called', { resolvedConfig: cfg, rawConfig: raw });

  // 诊断：把 loader 实际传进来的 config 原样写到**插件自己目录**（一定可写，
  // 不依赖 bridgeDir/state 是否存在）。sectionOrder 这类值必须是有限数字，
  // 一旦不是，systemPrompt.section 会抛错、整个 entry 装配失败，
  // 而日志只说 "1 entry did not activate"——没有这份原始数据就只能猜。
  // 用 fileURLToPath 解析自身路径（Windows 上 pathname 带前导斜杠，手工截容易出错）。
  try {
    const pluginDir = path.dirname(fileURLToPath(import.meta.url));
    fs.writeFileSync(path.join(pluginDir, 'last-apply-config.json'),
      JSON.stringify({
        at: new Date().toISOString(),
        rawConfig: raw,
        rawSectionOrder: { value: raw.sectionOrder, type: typeof raw.sectionOrder },
        resolvedConfig: cfg,
        resolvedSectionOrderType: typeof cfg.sectionOrder,
      }, null, 2), 'utf8');
  } catch { /* 诊断失败不影响装配 */ }

  // ── 首次运行检测 ──
  // 判据用**状态文件**而不是"配置是否为空"：配置为空也可能是用户把开关全删了、
  // 或 DSH 还没把设置写回 entry。状态文件一旦存在就说明本插件装配过，语义明确。
  //
  // 刻意**不改用户的 profile patch**：那是永久性副作用（重复 key、写坏 profile 都是
  // 真实风险），而且配置本来就该在设置页里改。首次运行只做「检测 + 落标记 + 给指引」。
  const firstRunFile = path.join(bridgeCtx.stateDir, 'plugin-first-run.json');
  let firstRunAt = null;
  // 本次是不是**首次**装配，必须单独记一个布尔。
  // 踩过的坑：原先只传 firstRunAt，而首次运行时它是 null（文件正是本次才创建的），
  // 于是"首次"这一轮反而不显示引导、下一轮才显示——恰好把最该看到的那一刻漏掉了。
  let isFirstRun = false;
  try {
    if (fs.existsSync(firstRunFile)) {
      firstRunAt = JSON.parse(fs.readFileSync(firstRunFile, 'utf8')).firstRunAt ?? null;
    } else {
      const now = new Date().toISOString();
      isFirstRun = true;
      firstRunAt = now;
      fs.mkdirSync(bridgeCtx.stateDir, { recursive: true });
      fs.writeFileSync(firstRunFile, JSON.stringify({
        firstRunAt: now,
        hint: '本插件首次装配。功能开关可在 DSH 设置页的 qqbridge-plus 面板里改，或用 qqbridge 工具的 features action 查看。',
      }, null, 2), 'utf8');
      stamp('first-run-detected', { firstRunAt: now });
    }
  } catch (error) {
    stamp('first-run-check-failed', { error: String(error?.message ?? error) });
  }
  bridgeCtx.firstRunAt = firstRunAt;
  bridgeCtx.isFirstRun = isFirstRun;

  // 拼错的开关名单独告警：否则「设了却没生效」会像功能失灵一样难查。
  // 落盘（不只在 console）——GUI 下看不到 console，这正是之前反复猜原因的坑。
  if (typoKeys.length) {
    const msg = `features 里有无法识别的键：${typoKeys.join(', ')}（合法键：${FEATURE_KEYS.join(', ')}, *）——这些键不会生效`;
    console.warn(`[qqbridge-plus] ${msg}`);
    stamp('features-unknown-keys', { keys: typoKeys });
  }

  ctx.effect(() => {
    const tool = defineTool({
      name: 'qqbridge',
      description: [
        'QQ 机器人（qq-bridge）运维查询：余额与自动关机、推理档位按时段（DeepSeek 计费峰谷）、',
        '节假日表覆盖、开机/关机提示词、管理命令现状、桥接配置摘要、功能开关清单。',
        `action 取值：${ACTIONS.join(' / ')}。`,
        '部分 action 可能被插件配置里的 features 开关关闭，此时会明确说明。',
        '判定逻辑直接复用 qq-bridge 的模块，保证与此前在桥接里生效的行为一致。'
      ].join(''),
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ACTIONS,
          description: '要查询的方面：status（总览）/ balance（余额与自动关机）/ schedule（计费峰谷与档位）/ holidays（节假日表）/ greeting（开机关机提示词）/ commands（管理命令）/ config（配置摘要）/ features（功能开关，可查可改）/ firstRun（首次引导）',
        },
        testAt: {
          type: 'array',
          items: { type: 'number' },
          description: 'schedule 专用：额外试算这些毫秒时间戳各属于高峰还是空闲（不传则只看当前）',
        },
        fetch: {
          type: 'boolean',
          description: 'holidays 专用：现场抓取并解析通知做试算（只读，不写回配置）',
        },
        year: {
          type: 'number',
          description: 'holidays+fetch 专用：要解析的年份，缺省取缺失年份或次年',
        },
        key: {
          type: 'string',
          description: 'config 专用：取某个子段，如 "role.balanceAlarm"；不传则给顶层摘要',
        },
        alarm: {
          type: 'boolean',
          description: 'balance 专用：是否附带自动关机阈值信息（默认附带）',
        },
        set: {
          type: 'string',
          enum: FEATURE_KEYS,
          description: 'features 专用：要修改的功能键（配合 enabled 使用），如 "balance"',
        },
        enabled: {
          type: 'boolean',
          description: 'features+set 专用：true=开启该功能，false=关闭',
        },
        reset: {
          type: 'boolean',
          description: 'features 专用：true=清空全部运行时覆盖，回到配置文件/默认值',
        },
        sub: {
          type: 'string',
          enum: MAIMAI_ACTIONS,
          description: 'maimai 专用：子操作。status（这台机器能不能用）/ b50（查 B50，可出成绩图）/ song（按 id 或曲名查定数）/ search（模糊搜曲）/ bind（发起水鱼授权）/ confirm（用确认码收尾绑定）',
        },
        username: {
          type: 'string',
          description: 'maimai+b50 专用：按用户名走公开查询（对方需已在水鱼公开成绩），无需 OAuth',
        },
        qq: {
          type: 'string',
          description: 'maimai 专用：要查/绑定哪个 QQ。按 QQ 查自己的成绩需要先完成 OAuth 绑定',
        },
        songId: {
          type: 'string',
          description: 'maimai+song 专用：曲目 id（从 sub=search 的结果里拿）',
        },
        query: {
          type: 'string',
          description: 'maimai+song/search 专用：曲名关键词，支持简写（如 "ztn" 能命中 Zitronectar）',
        },
        code: {
          type: 'string',
          description: 'maimai+confirm 专用：水鱼授权页面给出的一次性确认码',
        },
        image: {
          type: 'boolean',
          description: 'maimai+b50 专用：是否生成成绩图（默认生成；false 只要文字）',
        },
        force: {
          type: 'boolean',
          description: 'maimai+song/search 专用：忽略曲库缓存，强制重新拉取',
        },
        limit: {
          type: 'number',
          description: 'maimai+search 专用：返回多少个候选（默认 8）',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            action: { type: 'string', required: true },
            text: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text ?? '' }],
      },
      execute: async (args) => {
        const result = await runAction(bridgeCtx, args.action, args);
        // action 可以返回 string（多数）或 { text }（需要额外信息的）。
        // 统一成字符串交给 output.render，避免调用方要判两种形状。
        const text = typeof result === 'string' ? result : (result?.text ?? '');
        return { action: args.action, text };
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `QQbridge plus: ${args.action}`,
        kind: 'other',
        rawInput: args,
      }),
    });
    // 注册必须 try/catch：register() 若直接抛错会被 loader 吞掉，
    // 表现就是"trace 说注册了、但工具面里没有"，且没有任何错误可见。
    try {
      ctx.tools.register(tool);
      stamp('tool-registered');
    } catch (error) {
      stamp('tool-register-threw', { error: String(error?.stack ?? error?.message ?? error) });
      throw error;
    }
  }, 'qqbridge-plus.tools()');

  // ── QQ 内开关：注册 HTTP 端点供桥接调用 ──
  // 令牌与桥接控制台同源（bridgeDir/state/console-token），桥接本来就读得到，
  // 不需要再引入新的共享秘密。没有令牌时 registerFeatureApi 会**不注册**（fail-closed），
  // 而不是注册一个无鉴权的端点——那个端点能放宽整个工具面，绝不能裸奔。
  ctx.effect(() => {
    try {
      const dispose = registerFeatureApi({
        webServer: ctx.webServer,
        store: featureStore,
        token: bridgeCtx.token,
        log: (m) => console.warn(`[qqbridge-plus] ${m}`),
        // 把 ctx 与 runAction 交出去，让 /qqbridge-plus/action 能转发**任意** action——
        // 桥接 QQ 命令靠它把「#功能 maimai …」这类请求打进来。
        ctx: bridgeCtx,
        runAction,
        // 出图目录也交给端点：图落在配置指定的位置时，/image 才取得到
        imageDirOverride: cfg.maimai?.imageDir || null,
      });
      stamp('http-api-registered', { tokenProvided: !!bridgeCtx.token });
      return dispose;
    } catch (error) {
      // 端点注册失败不该拖垮插件：工具本身仍然可用，只是 QQ 内不能改开关。
      stamp('http-api-failed', { error: String(error?.message ?? error) });
      console.error(`[qqbridge-plus] HTTP 开关接口注册失败：${error?.message ?? error}`);
      return () => {};
    }
  }, 'qqbridge-plus.httpApi()');

  if (cfg.personaSection) {
    // 直接访问：systemPrompt 已在 inject 里声明，所以这是允许的（见 inject 上方的说明）。
    // 文案按开关动态生成：不向模型宣传已被关掉的 action。
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'qqbridge-plus:instructions',
      order: cfg.sectionOrder,
      text: buildSectionText(bridgeCtx.features, { isFirstRun: bridgeCtx.isFirstRun }),
    }), 'qqbridge-plus.section()');
  }
  stamp('apply-returned', { features: bridgeCtx.features, firstRunAt: bridgeCtx.firstRunAt ?? 'not-first-run' });
}

// 必须导出 Config：DSH 设置页靠它（entry id + Config + volatile 字段）打开本插件的
// 配置面板。导出普通对象会让 entry 在 apply 之前就失败，详见 config-schema.js。
export { Config, DEFAULTS, FEATURE_KEYS, apply, buildSectionText, inject, name };
