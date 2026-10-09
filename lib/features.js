/**
 * 功能开关。
 *
 * 设计取舍（两条，都有理由）：
 *
 * 1) **关掉的功能仍留在 action 枚举里**，只是调用时返回"该功能已关闭"。
 *    原因：action 的 enum 在 `defineTool()` 时就序列化进工具 schema 了，之后无法随配置增删。
 *    与其做一个"配置改了但 enum 不变"的假象，不如让关闭状态**可发现**——
 *    调用方得到一句明确的话，而不是一个"这个 action 不存在"的谜题。
 *
 * 2) `*` 作为**兜底**：未在 features 里显式列出的功能，用 `features['*']`；
 *    连 `*` 也没有才用代码默认（全开）。这样可以写成"默认关、只开两个"：
 *      { "*": false, status: true, balance: true }
 *
 * 配置写错名字（比如把 `schedule` 拼成 `scheduler`）是这类开关最常见的坑：
 * 开关看起来"设了却没生效"。所以 `unknownFeatureKeys()` 会把这类键单独挑出来供上层告警。
 *
 * @module dsh-plugin-qqbridge-plus/features
 */

/** 全部功能键（与工具 action 一一对应）。 */
export const FEATURE_KEYS = ['status', 'balance', 'schedule', 'holidays', 'greeting', 'commands', 'config', 'maimai'];

/** 功能的人类可读名（用于提示语与清单）。 */
export const FEATURE_LABELS = {
  status: '总览',
  balance: '余额与自动关机',
  schedule: '计费峰谷与推理档位',
  holidays: '节假日表',
  greeting: '开机/关机提示词',
  commands: '管理命令现状',
  config: '桥接配置摘要',
  maimai: '舞萌DX 查分',
};

/** 代码默认：全开（行为与加开关之前一致）。 */
export const FEATURE_DEFAULTS = Object.fromEntries(FEATURE_KEYS.map((k) => [k, true]));

/**
 * 归一化 features 配置。
 * @param {object} [raw] 组合行里的 features
 * @returns {Record<string, boolean>} 每个功能键 → 是否启用（只含合法键）
 */
export function normalizeFeatures(raw) {
  const out = { ...FEATURE_DEFAULTS };
  if (raw === null || typeof raw !== 'object') return out;
  const fallback = typeof raw['*'] === 'boolean' ? raw['*'] : undefined;
  if (fallback !== undefined) for (const k of FEATURE_KEYS) out[k] = fallback;
  for (const k of FEATURE_KEYS) {
    if (typeof raw[k] === 'boolean') out[k] = raw[k];
  }
  return out;
}

/**
 * features 里出现的、不是合法功能键的键（拼错时能立刻发现）。
 * 特意排除 `*`，它是合法的兜底键。
 * @param {object} [raw]
 * @returns {string[]}
 */
export function unknownFeatureKeys(raw) {
  if (raw === null || typeof raw !== 'object') return [];
  const known = new Set([...FEATURE_KEYS, '*']);
  return Object.keys(raw).filter((k) => !known.has(k));
}

/**
 * 某功能是否启用。
 * @param {Record<string, boolean>} features 已归一化的结果
 * @param {string} key
 */
export function isFeatureOn(features, key) {
  return features?.[key] !== false;
}

/**
 * 关闭时的回复文案。
 * @param {string} key
 * @param {Record<string, boolean>} features
 * @returns {string}
 */
export function disabledMessage(key, features) {
  const on = FEATURE_KEYS.filter((k) => isFeatureOn(features, k));
  return [
    `⛔ 功能「${FEATURE_LABELS[key] ?? key}」已在插件配置里关闭。`,
    `当前开启的功能：${on.length ? on.map((k) => `${k}（${FEATURE_LABELS[k]}）`).join('、') : '（全部关闭）'}`,
    '开启方式：在 profile 的 cordis.patch.yml 里改该 entry 的 config.features，例如',
    `  features: { ${key}: true }`,
    '改完重启 DSH 生效。',
  ].join('\n');
}

/**
 * 渲染一份开关清单（给 `status` 用，便于一眼看出哪些功能被关了）。
 * @param {Record<string, boolean>} features
 * @returns {string}
 */
export function renderFeatureList(features) {
  return FEATURE_KEYS
    .map((k) => `${isFeatureOn(features, k) ? '✅' : '⛔'} ${k}（${FEATURE_LABELS[k]}）`)
    .join('｜');
}
