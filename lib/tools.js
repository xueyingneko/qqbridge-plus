/**
 * QQbridge plus — 工具实现。
 *
 * 一个工具 + action 分发，而不是 9 个独立工具：
 * 工具面每多一个工具，每次请求都要多带一份 schema（本环境的模型上下文是稀缺资源）。
 *
 * 所有"判定"都调用 qq-bridge 自己的纯模块，本文件只负责取数、编排与排版。
 *
 * @module dsh-plugin-qqbridge-plus/tools
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  loadBridgeModule,
  callConsole,
  readBridgeConfig,
  looksLikeBridge
} from './bridge.js';
import {
  FEATURE_KEYS,
  FEATURE_LABELS,
  disabledMessage,
  isFeatureOn
} from './features.js';

/** 统一的失败返回（工具返回字符串，宿主会把它作为工具结果交给模型）。 */
function fail(msg) {
  return `❌ ${msg}`;
}

/** 一句话打印键值对。 */
function kv(label, value) {
  return `${label}：${value === undefined || value === null || value === '' ? '(空)' : value}`;
}

/** 把控制台不可达的情形说清楚（含排查建议），而不是只报“失败”。 */
function offlineHint(ctx, extra) {
  return [
    `桥接控制台不可达：${ctx.base}`,
    extra ? `原因：${extra}` : '',
    '排查：① 桥接是否在跑（桥接目录下双击 start.bat）；② 控制台端口是否与 config.consoleBase 一致；',
    `③ 令牌是否正确（可用 ${ctx.dir}\\state\\console-token，或在插件配置里填 consoleToken）。`
  ].filter(Boolean).join('\n');
}

/** 取一次控制台 + 桥接模块，供各 action 复用（任一失败都在返回值里说明）。 */
async function gather(ctx) {
  const out = { config: readBridgeConfig(ctx.dir), console: {}, modules: {} };
  const [status, balance, states, model] = await Promise.all([
    callConsole({ ...ctx, path: '/api/status' }),
    callConsole({ ...ctx, path: '/api/balance' }),
    callConsole({ ...ctx, path: '/api/socialV2/states' }),
    callConsole({ ...ctx, path: '/api/dsh/model' })
  ]);
  out.console = { status, balance, states, model };
  out.consoleReachable = status.ok;
  for (const [key, rel] of [['wakeFilters', 'wake-filters.mjs'], ['whaleBalance', 'whale-balance.js']]) {
    try {
      out.modules[key] = await loadBridgeModule(ctx.dir, rel);
    } catch (error) {
      out.modules[key] = null;
      out.moduleError = out.moduleError || (error?.message ?? String(error));
    }
  }
  return out;
}

// ── action 实现 ───────────────────────────────────────────────────────────────

/** status：一次看全桥接运行态（健康 + 余额 + 计费时段 + 会话）。 */
async function actionStatus(ctx) {
  const g = await gather(ctx);
  const lines = [];
  const cfg = g.config;
  const features = ctx.features ?? {};
  lines.push('=== QQbridge plus · 运行态 ===');
  // 开关清单放最前面：关掉的段落会明确说明，先给读者一个"为什么这里少了一段"的答案。
  if (Object.keys(features).length) {
    lines.push('功能开关：' + FEATURE_KEYS.map((k) => `${isFeatureOn(features, k) ? '✅' : '⛔'}${k}`).join(' '));
  }
  lines.push(kv('桥接目录', ctx.dir));
  if (!looksLikeBridge(ctx.dir)) {
    lines.push('⚠️ 该目录不像 qq-bridge（缺少 config.json / src/bridge.js / src/wake-filters.mjs）');
  }
  if (!g.consoleReachable) {
    lines.push(offlineHint(ctx, g.console.status.error));
  } else {
    const s = g.console.status.data ?? {};
    lines.push(kv('模式', s.mode));
    lines.push(kv('DSH 就绪', s.dshReady));
    lines.push(kv('管理员 QQ', s.ownerQQ));
    lines.push(kv('二代 AI 暂停', s.socialV2Paused));
    lines.push(kv('白名单（群）', Array.isArray(s.allowGroups) ? s.allowGroups.join(', ') : ''));
    lines.push(kv('白名单（私聊）', Array.isArray(s.allowPrivate) ? s.allowPrivate.join(', ') : ''));
  }

  // 余额段：受 balance 开关控制（关掉就说明原因，而不是静默消失或白跑一次取数）
  lines.push('');
  if (!isFeatureOn(features, 'balance')) {
    lines.push('--- 余额 ---');
    lines.push('  ⛔ 已关闭（features.balance=false）');
  } else {
    // 余额：优先用桥接控制台的判定（它带告警状态）；模块只用来补"观测新鲜度"
    const bal = g.console.balance.ok ? g.console.balance.data : null;
    lines.push('--- 余额 ---');
    if (bal?.text) lines.push(String(bal.text).split('\n').map((l) => `  ${l}`).join('\n'));
    else lines.push('  (控制台不可达，无法读取余额)');
    if (bal?.alarm) {
      const a = bal.alarm;
      lines.push(`  告警：${a.enabled ? (a.active ? '已启用' : '已启用但缺 ownerQQ ⇒ 自动关机被禁用') : '未启用'}｜阈值 ¥${a.alarmAt}｜宽限 ${Math.round(Number(a.graceMs) / 60000)} 分钟｜群内@ ${(a.alertGroups || []).join(',') || '无'}`);
      const st = a.state || {};
      lines.push(`  倒计时：${st.shutdownDueAt ? new Date(Number(st.shutdownDueAt)).toLocaleString() : '无'}`);
    }
  }

  // 推理档位段：受 schedule 开关控制
  lines.push('');
  if (!isFeatureOn(features, 'schedule')) {
    lines.push('--- 推理档位（按 DeepSeek 计费峰谷）---');
    lines.push('  ⛔ 已关闭（features.schedule=false）');
  } else {
    const m = g.console.model.ok ? g.console.model.data : null;
    lines.push('--- 推理档位（按 DeepSeek 计费峰谷）---');
    if (m) {
      lines.push(`  当前生效：${m.activeReasoningEffort ?? '(未知)'}｜时段：${m.reasoningPhase ?? '(未知)'}｜手动基准值：${m.reasoningEffort ?? '(未知)'}`);
      const rs = m.reasoningSchedule || {};
      lines.push(`  分时段：${rs.enabled ? '已启用' : '未启用'}｜高峰窗口 ${(rs.peakWindows || []).map(([a, b]) => `${a}:00-${b}:00`).join('、') || '(无)'}｜高峰档 ${rs.peakEffort}／空闲档 ${rs.offPeakEffort}`);
    } else {
      lines.push(`  (控制台不可达；来自 config.json：${cfg?.dsh?.reasoningSchedule?.enabled ? '已启用' : '未启用'}，手动值 ${cfg?.dsh?.reasoningEffort ?? '(未知)'})`);
    }
  }

  // 会话
  const st = g.console.states.ok ? (g.console.states.data?.conversations ?? []) : [];
  lines.push('');
  lines.push('--- 会话 ---');
  if (!st.length) lines.push('  (无会话或控制台不可达)');
  for (const c of st) {
    const wc = c.wakeConfig || {};
    const last = c.lastAiReplyAt ? new Date(Number(c.lastAiReplyAt)).toLocaleString() : '从未';
    lines.push(`  ${c.key}：未读 ${c.unreadCount}｜上次发言 ${last}｜模式 ${wc.mode}｜anyMessage ${wc.triggers?.anyMessage ? 'on' : 'off'}`);
  }
  return lines.join('\n');
}

/** balance：余额 + 观测新鲜度 + 告警决策（不推进桥接的角色相位）。 */
async function actionBalance(ctx, args) {
  const mod = await loadBridgeModule(ctx.dir, 'whale-balance.js').catch((error) => ({ __error: error?.message ?? String(error) }));
  if (mod.__error) return fail(`无法加载桥接的 whale-balance.js：${mod.__error}`);
  const obs = mod.readBalanceObservation();
  const cfg = readBridgeConfig(ctx.dir);
  const rb = cfg?.role?.balance ?? {};
  const hungryAt = Number.isFinite(Number(rb.hungryAt)) ? Number(rb.hungryAt) : 7;
  const fullAt = Number.isFinite(Number(rb.fullAt)) ? Number(rb.fullAt) : 20;
  const maxStaleMs = Number.isFinite(Number(rb.maxStaleMs)) ? Number(rb.maxStaleMs) : 30 * 60 * 1000;
  if (!obs.ok) {
    return [
      fail(`读不到余额账本（${obs.reason}）`),
      '账本由 DSH 小鲸鱼挂件写入（$DSH_HOME/.dshw-usage.json）。挂件没跑就不会有数据。',
      `候选路径：${mod.defaultLedgerPaths().join(' ｜ ')}`
    ].join('\n');
  }
  const ageMin = Math.round((Date.now() - Number(obs.at)) / 60000);
  const stale = (Date.now() - Number(obs.at)) > maxStaleMs;
  const out = [
    kv('余额', `¥${mod.money(obs.balance)}`),
    kv('观测', `${ageMin} 分钟前${stale ? '（已过期，不可作为自动关机依据）' : ''}`),
    kv('阈值（角色"饿了喵"）', `饿 ≤ ¥${hungryAt} / 饱 ≥ ¥${fullAt}`),
    kv('账本', obs.path)
  ];
  if (args?.alarm !== false) {
    const ba = cfg?.role?.balanceAlarm ?? {};
    if (ba.enabled === true) {
      const alarmAt = Number.isFinite(Number(ba.alarmAt)) ? Number(ba.alarmAt) : 3;
      const graceMin = Math.round((Number.isFinite(Number(ba.graceMs)) ? Number(ba.graceMs) : 180000) / 60000);
      out.push(kv('自动关机', `低于 ¥${alarmAt} 告警，${graceMin} 分钟内未充值即关机${cfg?.ownerQQ ? '' : '（未配 ownerQQ ⇒ 实际被禁用，避免静默自杀）'}`));
      out.push(kv('距阈值', obs.balance < alarmAt ? `已跌破 ${mod.money(alarmAt - obs.balance)} 元` : `还差 ${mod.money(obs.balance - alarmAt)} 元`));
    } else {
      out.push(kv('自动关机', '未启用（role.balanceAlarm.enabled=false）'));
    }
  }
  return out.join('\n');
}

/** schedule：计费峰谷判定（可用 testAt 试算任意时刻），含节假日/调休口径。 */
async function actionSchedule(ctx, args) {
  const mod = await loadBridgeModule(ctx.dir, 'wake-filters.mjs').catch((error) => ({ __error: error?.message ?? String(error) }));
  if (mod.__error) return fail(`无法加载桥接的 wake-filters.mjs：${mod.__error}`);
  const cfg = readBridgeConfig(ctx.dir);
  const rs = cfg?.dsh?.reasoningSchedule;
  if (!rs) return fail('config.json 里没有 dsh.reasoningSchedule 配置');

  const call = (now) => mod.resolveBillingPhase({
    now,
    offsetHours: Number.isFinite(Number(rs.offsetHours)) ? Number(rs.offsetHours) : 8,
    peakWindows: rs.peakWindows ?? [],
    holidays: rs.holidays ?? [],
    adjustedWorkdays: rs.adjustedWorkdays ?? [],
    treatAdjustedWorkdaysAsPeak: rs.treatAdjustedWorkdaysAsPeak === true
  });

  const lines = ['=== 推理档位时段（DeepSeek 计费峰谷）==='];
  lines.push(`分时段：${rs.enabled ? '已启用' : '未启用'}｜时区 UTC+${rs.offsetHours ?? 8}`);
  lines.push(`高峰窗口：${(rs.peakWindows ?? []).map(([a, b]) => `${a}:00-${b}:00`).join('、') || '(无)'}（仅工作日）`);
  lines.push(`档位：高峰 → ${rs.peakEffort}（省钱）／空闲 → ${rs.offPeakEffort}（保质量）`);
  lines.push(`节假日表 ${(rs.holidays ?? []).length} 天｜调休表 ${(rs.adjustedWorkdays ?? []).length} 天｜调休按 ${rs.treatAdjustedWorkdaysAsPeak ? '工作日（官方字面）' : '空闲（默认口径）'}`);

  const now = Date.now();
  const cur = call(now);
  lines.push('');
  lines.push(`现在：${cur.date} 周${'日一二三四五六'[cur.weekday]} ${cur.hour.toFixed(2)} 时 → ${cur.peak ? '高峰' : '空闲'}（${cur.reason}）⇒ 档位 ${cur.peak ? rs.peakEffort : rs.offPeakEffort}`);

  if (args?.testAt) {
    const times = Array.isArray(args.testAt) ? args.testAt : [args.testAt];
    lines.push('');
    lines.push('试算：');
    for (const t of times) {
      const ts = Number(t);
      if (!Number.isFinite(ts)) { lines.push(`  ${t} → 不是合法时间戳`); continue; }
      const r = call(ts);
      lines.push(`  ${new Date(ts).toLocaleString()} → ${r.peak ? '高峰' : '空闲'}（${r.reason}）`);
    }
  }
  return lines.join('\n');
}

/** holidays：节假日表覆盖检查（可选：现场抓取，解析失败绝不覆盖）。 */
async function actionHolidays(ctx, args) {
  const mod = await loadBridgeModule(ctx.dir, 'wake-filters.mjs').catch((error) => ({ __error: error?.message ?? String(error) }));
  if (mod.__error) return fail(`无法加载桥接的 wake-filters.mjs：${mod.__error}`);
  const cfg = readBridgeConfig(ctx.dir);
  const rs = cfg?.dsh?.reasoningSchedule;
  if (!rs) return fail('config.json 里没有 dsh.reasoningSchedule 配置');
  const ha = rs.holidayAuto ?? {};

  const off = Number.isFinite(Number(rs.offsetHours)) ? Number(rs.offsetHours) : 8;
  const d = new Date(Date.now() + off * 3600000);
  const today = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const cov = mod.checkHolidayTableCoverage({
    holidays: rs.holidays ?? [],
    today,
    warnWithinDays: Number.isFinite(Number(ha.warnWithinDays)) ? Number(ha.warnWithinDays) : 60
  });

  const lines = ['=== 节假日表 ==='];
  lines.push(`今天（UTC+${off}）：${today}`);
  lines.push(`已覆盖：${cov.yearsCovered.map((y) => `${y}年(${cov.byYear[String(y)] ?? cov.byYear[y]}天)`).join('、') || '(无)'}`);
  lines.push(`本次检查范围：${cov.yearsWanted.join('、')}`);
  lines.push(cov.stale ? `⚠️ 缺 ${cov.yearsMissing.join('、')} 年 —— 这些天会被当成普通工作日（按高峰计价、用低档推理）` : '✅ 覆盖正常');
  lines.push(`自动维护：${ha.enabled ? '开启' : '关闭'}｜自动抓取 ${ha.autoFetch ? '开启' : '关闭'}｜提前提醒 ${ha.warnWithinDays ?? 60} 天`);
  if (ha.sourceUrl) lines.push(`数据源：${ha.sourceUrl}`);

  if (args?.fetch) {
    const year = Number(args.year) || cov.yearsMissing[0] || (Number(today.slice(0, 4)) + 1);
    lines.push('');
    if (!ha.sourceUrl || !/^https?:\/\//i.test(String(ha.sourceUrl))) return [...lines, fail('未配置可用的 sourceUrl，无法抓取')].join('\n');
    try {
      const res = await fetch(String(ha.sourceUrl), { headers: { 'user-agent': 'dsh-qqbridge-plus' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) return [...lines, fail(`抓取失败：HTTP ${res.status}`)].join('\n');
      const html = await res.text();
      const parsed = mod.parseHolidayNotice(html, year);
      if (!parsed.ok) {
        lines.push(`⛔ ${year} 年解析失败：${parsed.reason}`);
        lines.push('（按设计**不做任何覆盖**——保留现有表比写入可疑数据安全）');
      } else {
        lines.push(`✅ ${year} 年解析成功：${parsed.dates.length} 天假期（${parsed.dates[0]} ~ ${parsed.dates[parsed.dates.length - 1]}）`);
        lines.push(`   ${parsed.holidays.map((h) => `${h.name} ${h.from}~${h.to}`).join('；')}`);
        lines.push('   注意：本工具只做“试算”，不写回配置。要落盘请在 QQ 里等桥接自动维护，或手工把上述日期填进 config.json。');
      }
    } catch (error) {
      lines.push(fail(`抓取异常：${error?.message ?? error}`));
    }
  }
  return lines.join('\n');
}

/** greeting：开机/关机提示词现状（含“睡了多久”的基准时刻）。 */
async function actionGreeting(ctx) {
  const cfg = readBridgeConfig(ctx.dir);
  if (!cfg) return fail(`读不到 ${ctx.dir}/config.json`);
  const lines = ['=== 开机 / 关机提示词 ==='];
  for (const [label, key] of [['开机', 'startupGreeting'], ['关机', 'shutdownGreeting']]) {
    const g = cfg[key] ?? {};
    lines.push(`${label}：${g.enabled ? '已启用' : '未启用'}｜小节「${g.section ?? '(未设)'}」｜默认人格 ${g.defaultRole || '(空)'}`);
    lines.push(`   发送目标：${(g.sendTo ?? []).length ? g.sendTo.join('、') : '(空 = 管理员私聊)'}`);
    if (key === 'startupGreeting') lines.push(`   去重窗口：${Math.round((Number(g.minIntervalMs) ?? 600000) / 60000)} 分钟（防崩溃重启刷屏）`);
  }
  // 状态文件里记着上次发送时刻与时长基准
  try {
    const st = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'state', 'startup-greeting.json'), 'utf8'));
    lines.push('');
    lines.push('--- 状态文件 state/startup-greeting.json ---');
    for (const k of ['lastAt', 'startedAt', 'shutdownAt', 'shutdownLastAt']) {
      if (st[k]) lines.push(`  ${k}：${new Date(Number(st[k])).toLocaleString()}`);
    }
    if (st.startedAt && st.shutdownAt) {
      lines.push(`  ⇒ 上次在线时长约 ${Math.round((Number(st.shutdownAt) - Number(st.startedAt)) / 60000)} 分钟`);
    }
  } catch {
    lines.push('');
    lines.push('（还没有 state/startup-greeting.json —— 尚未发送过开机/关机提示词）');
  }
  // 人格卡里配了哪些提示词
  try {
    const rolesDir = path.join(ctx.dir, 'roles');
    const names = fs.readdirSync(rolesDir).filter((f) => f.endsWith('.md') && f !== 'README.md');
    lines.push('');
    lines.push('--- 人格卡覆盖情况 ---');
    for (const f of names) {
      const txt = fs.readFileSync(path.join(rolesDir, f), 'utf8');
      const has = (sec) => new RegExp(`^#{2,4}\\s*${sec}`, 'm').test(txt);
      lines.push(`  ${f.replace(/\.md$/, '')}：开机 ${has('开机提示') ? '✅' : '—'}｜关机 ${has('关机提示') ? '✅' : '—'}`);
    }
  } catch {}
  return lines.join('\n');
}

/**
 * commands：管理命令（余额/关机）现状与权限口径。
 *
 * ⚠️ 这里体现了本插件的一条重要原则：**运行态以桥接为准，不能拿 config.json 当真相**。
 * 实测踩到过：`balanceCommand` 根本没写进 config.json，命令却完全生效——
 * 因为桥接用的是**代码默认值**（config.json 只保存"被显式改过"的键）。
 * 若按 config.json 判断，会报出"已关闭"这种**错误结论**。
 * 所以余额触发词一律取自控制台的运行时返回（/api/balance 的 triggers）。
 */
async function actionCommands(ctx) {
  const cfg = readBridgeConfig(ctx.dir);
  if (!cfg) return fail(`读不到 ${ctx.dir}/config.json`);
  const lines = ['=== 管理命令（仅管理员可用）==='];
  lines.push(kv('管理员 ownerQQ', cfg.ownerQQ ?? '(未配置 ⇒ 两条命令对谁都不可用)'));

  // 余额：优先取运行时真值
  const bal = await callConsole({ ...ctx, path: '/api/balance' });
  if (bal.ok && bal.data) {
    const tr = Array.isArray(bal.data.triggers) ? bal.data.triggers : [];
    lines.push(kv('余额查询触发词（运行时）', tr.length ? tr.join('、') : '(空 = 已关闭)'));
  } else {
    const fileTriggers = Array.isArray(cfg.balanceCommand?.triggers) ? cfg.balanceCommand.triggers : [];
    lines.push(kv('余额查询触发词', fileTriggers.length
      ? fileTriggers.join('、')
      : '(文件里没有；控制台不可达，无法确认运行时真值 —— config.json 只存显式改过的键，实际很可能在用代码默认值)'));
  }

  // 关机：桥接没有对外暴露它的运行时 triggers，只能给文件值并明确标注不确定性
  const fileSc = Array.isArray(cfg.shutdownCommand?.triggers) ? cfg.shutdownCommand.triggers : [];
  lines.push(kv('关机触发词', fileSc.length
    ? fileSc.join('、')
    : '(config.json 未设 ⇒ 用代码默认 #关机/#shutdown；桥接未暴露该项运行时值，请以实测为准)'));

  lines.push('');
  lines.push('关机行为：退出码 3 → start.bat 看门狗停止自愈；同时写 state/shutdown.flag 作痕迹。');
  lines.push('恢复方式：在机器上重新双击 start.bat（它会清掉痕迹）。');
  return lines.join('\n');
}

/** config：按需回显桥接配置（默认脱敏，避免把令牌带进模型上下文）。 */
async function actionConfig(ctx, args) {
  const cfg = readBridgeConfig(ctx.dir);
  if (!cfg) return fail(`读不到 ${ctx.dir}/config.json`);
  const SENSITIVE = new Set(['authToken', 'accessToken', 'consoleToken', 'agentToken']);
  const redact = (node, depth = 0) => {
    if (Array.isArray(node)) return node.map((x) => redact(x, depth + 1));
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (SENSITIVE.has(k) && typeof v === 'string' && v) out[k] = `***(${v.length}字符)`;
        else out[k] = depth > 4 ? '(太深，截断)' : redact(v, depth + 1);
      }
      return out;
    }
    return node;
  };
  const key = String(args?.key ?? '').trim();
  if (!key) {
    // 不带 key：只给顶层结构 + 几个关键子段，避免整份配置灌进上下文
    const summary = {
      顶层键: Object.keys(cfg),
      dsh: redact(cfg.dsh),
      role: redact(cfg.role),
      startupGreeting: cfg.startupGreeting,
      shutdownGreeting: cfg.shutdownGreeting,
      balanceCommand: cfg.balanceCommand,
      shutdownCommand: cfg.shutdownCommand
    };
    return `=== 桥接配置摘要（脱敏）===\n${JSON.stringify(summary, null, 2)}\n\n提示：用 key 参数取某一子段，例如 key="role.balanceAlarm"。`;
  }
  const seg = key.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), cfg);
  if (seg === undefined) return fail(`配置里没有 ${key}`);
  return `=== config.json · ${key} ===\n${JSON.stringify(redact(seg), null, 2)}`;
}

/**
 * features：功能开关的查看与运行时修改（自身不受开关控制，否则关掉就再也查不到了）。
 *
 * 支持 set / reset：管理员在 QQ 里能开关功能，模型侧却只能看就没有道理。
 * 修改走 featureStore（落盘 + 就地生效），所以**不需要重启 DSH**。
 */
async function actionFeatures(ctx, args = {}) {
  const store = ctx.featureStore;
  const features = ctx.features ?? {};
  const setKey = args.set ? String(args.set).trim() : '';
  const doReset = args.reset === true;

  // ── 修改路径 ──
  if (setKey || doReset) {
    if (!store) {
      return fail('本插件的开关存储不可用（未装配 featureStore），无法在运行时修改。请改 profile 的 cordis.patch.yml。');
    }
    if (doReset) {
      const r = store.reset();
      if (!r.ok) return fail(`重置失败：${r.error}`);
      return `已重置所有运行时覆盖（回到配置文件/默认值）。\n\n${store.render()}`;
    }
    if (!FEATURE_KEYS.includes(setKey)) {
      return fail(`未知功能键「${setKey}」。可用：${FEATURE_KEYS.join(' / ')}`);
    }
    if (typeof args.enabled !== 'boolean') {
      return fail('修改开关需要同时给出 enabled（true=开启 / false=关闭）。');
    }
    const r = store.set(setKey, args.enabled);
    if (!r.ok) return fail(`修改失败：${r.error}`);
    return `已${args.enabled ? '开启' : '关闭'}「${FEATURE_LABELS[setKey]}」（${setKey}）。立即生效，已落盘。\n\n${store.render()}`;
  }

  // ── 查看路径 ──
  if (store) {
    const lines = [store.render()];
    lines.push('');
    lines.push('修改方式（立即生效，无需重启 DSH）：');
    lines.push('  · QQ（管理员）：#功能 查看｜#功能 <键> on/off 修改｜#功能 reset 重置');
    lines.push('  · 本工具：action=features, set="balance", enabled=false');
    lines.push(`  · 运行时覆盖文件：${store.file}`);
    const notice = firstRunNotice(ctx);
    if (notice) lines.push('', notice);
    return lines.join('\n');
  }

  // 兜底：没有 store（极端情况）时仍给出只读清单
  const lines = ['=== QQbridge plus · 功能开关 ==='];
  for (const k of FEATURE_KEYS) {
    lines.push(`${isFeatureOn(features, k) ? '✅ 开启' : '⛔ 关闭'}  ${k.padEnd(9)} ${FEATURE_LABELS[k]}`);
  }
  lines.push('');
  const off = FEATURE_KEYS.filter((k) => !isFeatureOn(features, k));
  lines.push(off.length ? `已关闭：${off.join('、')}` : '全部功能已开启。');
  lines.push('（开关存储不可用，只能查看；请改 profile 的 cordis.patch.yml）');
  // 首次运行的引导在**任何**分支都要给：这是最需要被看到的时刻。
  const notice = firstRunNotice(ctx);
  if (notice) lines.push('', notice);
  return lines.join('\n');
}

/**
 * 首次运行引导文案。
 *
 * 为什么是文案而不是弹窗：DSH 的配置面板由设置页按 `entry id + Config + volatile`
 * 推导，**纯 host 插件无法命令前端弹窗**（本项目没有 client 半部）。
 * 所以"跳出菜单"落地成：
 *   · 首次装配时**自动**把引导挂在 features 输出里（用户查开关时必然看到）；
 *   · 之后可用 `firstRun` action 随时重看——否则为了看说明还得去删状态文件。
 * @param {object} ctx
 * @returns {string} 非首次运行返回空串
 */
function firstRunNotice(ctx) {
  // 注意判据要同时看 isFirstRun 与 firstRunAt：
  // 首次那一轮 isFirstRun=true，但 firstRunAt 是本次才写入的；
  // 之后的轮次反过来只有 firstRunAt。只看其中一个都会漏掉该显示的时刻。
  if (!ctx.isFirstRun && !ctx.firstRunAt) return '';
  return [
    '🎉 首次运行 · 功能开关这样改：',
    '  ① 改配置（推荐）：profile 的 cordis.patch.yml → 该 entry 的 config.features',
    '  ② 看开关：本页（action=features）',
    '',
    '  注意：DSH 设置页里的 qqbridge-plus 面板**只能查看、不能修改**——',
    '  原因见 lib/config-schema.js（volatile 会让 loader 把配置求值成 {}，保存即损坏）。',
    '  关掉的功能调用时会明确回答"已关闭"，不会静默失败；留空 = 全开。',
    ctx.firstRunAt ? `  首次装配时间：${ctx.firstRunAt}` : '',
    '  重看这份引导：action=firstRun',
  ].filter(Boolean).join('\n');
}

/** firstRun：随时重看首次运行引导（引导自身不该有开关，否则关掉就找不回来了）。 */
async function actionFirstRun(ctx) {
  const notice = firstRunNotice(ctx);
  // 首次那一轮 isFirstRun=true、firstRunAt 有值；之后只有 firstRunAt。
  if (notice) return `=== QQbridge plus · 首次运行引导 ===\n${notice}`;
  return [
    '=== QQbridge plus · 首次运行引导 ===',
    '本插件不是首次运行（未记录到首次装配时间）。',
    '确实需要重看引导时，可删除状态文件后重启 DSH：',
    `  ${path.join(ctx.stateDir ?? '(bridgeDir)/state', 'plugin-first-run.json')}`,
    '',
    '当前开关状态：action=features',
  ].join('\n');
}

// ── 分发 ─────────────────────────────────────────────────────────────────────

export const ACTIONS = ['status', 'balance', 'schedule', 'holidays', 'greeting', 'commands', 'config', 'features', 'firstRun'];

/**
 * 执行一个 action。
 * @param {object} ctx  makeContext() 的结果
 * @param {string} action
 * @param {object} [args]
 * @returns {Promise<string>}
 */
export async function runAction(ctx, action, args = {}) {
  // 功能开关门禁：**在分发之前**拦截，而不是每个 action 内部各判一次——
  // 集中一处才能保证"新增 action 时不会忘记加开关"。
  // 注意 ctx.features 是可变对象：重载配置后无需重启即可生效。
  const features = ctx.features ?? {};
  if (typeof action === 'string' && action in features && features[action] === false) {
    return disabledMessage(action, features);
  }
  if (!looksLikeBridge(ctx.dir)) {
    return fail(`bridgeDir 不像 qq-bridge 目录：${ctx.dir}\n请把插件配置 bridgeDir 指向 qq-bridge 根目录（含 config.json 与 src/bridge.js）。`);
  }
  try {
    switch (action) {
      case 'status': return await actionStatus(ctx);
      case 'balance': return await actionBalance(ctx, args);
      case 'schedule': return await actionSchedule(ctx, args);
      case 'holidays': return await actionHolidays(ctx, args);
      case 'greeting': return await actionGreeting(ctx, args);
      case 'commands': return await actionCommands(ctx, args);
      case 'config': return await actionConfig(ctx, args);
      case 'features': return await actionFeatures(ctx, args);
      case 'firstRun': return await actionFirstRun(ctx);
      default: return fail(`未知 action「${action}」。可用：${ACTIONS.join(' / ')}`);
    }
  } catch (error) {
    // 工具绝不让宿主因为桥接侧问题抛异常
    return fail(`执行 ${action} 失败：${error?.message ?? error}`);
  }
}
