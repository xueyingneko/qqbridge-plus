/**
 * 功能开关的运行时存储。
 *
 * 为什么需要它（两点，都是"从 QQ 开关"这个需求逼出来的）：
 *
 * 1) **免重启生效**。功能开关原先只是 loader entry 配置的一部分，改完必须重启 DSH。
 *    管理员在 QQ 里说一句就要等 DSH 重启是不可接受的。这里把"生效值"放在运行时
 *    对象里，改完立刻作用于 `runAction` 的门禁。
 *
 * 2) **落盘持久**。运行时（DSH）重启后要保留管理员的选择。所以写到
 *    `<bridgeDir>/state/plugin-features.json`——与 qq-bridge 的其它状态文件同处，
 *    且**不回写 profile 配置**（那是 DSH 的组合层，程序化改它风险高、
 *    还容易和用户手写的内容打架）。
 *
 * 优先级：运行时覆盖文件 > 组合行配置 > 代码默认（全开）。
 * 也就是"管理员在 QQ 里改过的"压过"配置里写的"，符合直觉。
 *
 * 写入用 **临时文件 + rename**（原子替换）：这是被另一进程读的文件，
 * 直接覆写会出现"读到半个 JSON"的窗口。损坏时回退到"无覆盖"，绝不因状态文件坏掉而
 * 让插件起不来。
 *
 * @module dsh-plugin-qqbridge-plus/feature-store
 */
import fs from 'node:fs';
import path from 'node:path';
import { FEATURE_KEYS, FEATURE_DEFAULTS, FEATURE_LABELS } from './features.js';

/** 覆盖文件名（放在 bridgeDir/state 下）。 */
export const OVERRIDE_FILENAME = 'plugin-features.json';

/**
 * 读覆盖文件。
 * @param {string} stateDir
 * @returns {{ ok: boolean, overrides: Record<string, boolean>, error?: string }}
 */
export function readOverrides(stateDir) {
  const file = path.join(stateDir, OVERRIDE_FILENAME);
  try {
    if (!fs.existsSync(file)) return { ok: true, overrides: {} };
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const overrides = {};
    for (const k of FEATURE_KEYS) {
      if (typeof raw?.[k] === 'boolean') overrides[k] = raw[k];
    }
    return { ok: true, overrides };
  } catch (error) {
    // 状态文件坏了不能拖垮插件：当作"没有覆盖"，并把原因带出去供上层记录。
    return { ok: false, overrides: {}, error: String(error?.message ?? error) };
  }
}

/**
 * 原子写覆盖文件。
 * @param {string} stateDir
 * @param {Record<string, boolean>} overrides
 * @returns {{ ok: boolean, error?: string }}
 */
export function writeOverrides(stateDir, overrides) {
  const file = path.join(stateDir, OVERRIDE_FILENAME);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const payload = { updatedAt: new Date().toISOString(), ...overrides };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, file); // 同分区 rename 是原子的
    return { ok: true };
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * 生成一个开关控制器：持有"生效值"（可变对象，直接挂在 ctx 上供门禁读取）。
 *
 * @param {object} opts
 * @param {string} opts.stateDir  状态目录（bridgeDir/state）
 * @param {Record<string, boolean>} opts.fromConfig 组合行配置归一化后的结果
 * @returns {object} 控制器
 */
export function createFeatureStore({ stateDir, fromConfig }) {
  const initial = readOverrides(stateDir);
  /** 生效值：**同一个对象引用**必须一直挂在 ctx.features 上，改它就地生效。 */
  const effective = { ...FEATURE_DEFAULTS, ...fromConfig, ...initial.overrides };
  const notes = [];
  if (!initial.ok) notes.push(`覆盖文件读取失败（已按默认处理）：${initial.error}`);

  return {
    effective,
    notes,
    /** 覆盖文件的绝对路径（给管理员看，便于手工编辑）。 */
    file: path.join(stateDir, OVERRIDE_FILENAME),
    readError: initial.ok ? null : initial.error,

    /** 当前是否有来自运行时的覆盖（用于提示"QQ 改过的"）。 */
    currentOverrides() {
      const now = readOverrides(stateDir);
      return now.overrides;
    },

    /**
     * 设置某个开关。就地改 effective，再落盘。
     * @param {string} key
     * @param {boolean} value
     * @returns {{ ok: boolean, error?: string }}
     */
    set(key, value) {
      if (!FEATURE_KEYS.includes(key)) return { ok: false, error: `未知功能键：${key}` };
      if (typeof value !== 'boolean') return { ok: false, error: '值必须是布尔' };
      const overrides = { ...this.currentOverrides(), [key]: value };
      const w = writeOverrides(stateDir, overrides);
      // 先落盘成功再改内存值：避免"显示已改但重启后丢失"的不一致。
      if (!w.ok) return { ok: false, error: w.error };
      effective[key] = value;
      return { ok: true };
    },

    /** 清空全部覆盖（回到组合行配置/默认值）。 */
    reset() {
      const w = writeOverrides(stateDir, {});
      if (!w.ok) return { ok: false, error: w.error };
      for (const k of FEATURE_KEYS) effective[k] = fromConfig[k] === false ? false : FEATURE_DEFAULTS[k];
      return { ok: true };
    },

    /** 渲染成人可读的多行文本（供 QQ 回复与工具输出复用）。 */
    render(title = '=== QQbridge plus · 功能开关 ===') {
      const ov = this.currentOverrides();
      const lines = [title];
      for (const k of FEATURE_KEYS) {
        const on = effective[k] !== false;
        const mark = ov[k] === undefined ? '  ' : ' *'; // * = 来自 QQ/运行时覆盖
        lines.push(`${on ? '✅ 开启' : '⛔ 关闭'}  ${k.padEnd(9)} ${FEATURE_LABELS[k]}${mark}`);
      }
      const offs = FEATURE_KEYS.filter((k) => effective[k] === false);
      lines.push('');
      lines.push(offs.length ? `已关闭：${offs.join('、')}` : '全部功能已开启。');
      if (Object.keys(ov).length) lines.push('（标 * 的是通过 QQ 命令设置的值，优先于配置文件）');
      return lines.join('\n');
    },
  };
}
