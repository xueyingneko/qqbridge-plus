/**
 * 曲绘批量同步器（后台跑，带限速自愈）。
 *
 * ── 为什么需要它 ──
 *
 * 曲数据库有 1293 首曲绘，而 GitHub **未认证接口每小时只有 60 次请求**——
 * 一轮能下 50 多张，全部下完要跑二十几轮、跨一整天。手动反复执行不现实，
 * 所以做成常驻进程：下到额度耗尽就睡到额度重置，再继续，直到下完为止。
 *
 * ── 用法 ──
 *
 *   node scripts/sync-jackets.mjs --dir E:/qqbridge-plus/jackets [--interval-min 10] [--once]
 *
 * 输出写 stdout（含进度），出错写 stderr。Ctrl+C 可随时中断——
 * 已下载的不会重下（增量），下次接着来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncJackets, jacketStats } from '../lib/maimai/sync-jackets.js';

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);

const dir = arg('dir');
const intervalMin = Number(arg('interval-min', '10'));
const once = has('once');
const quiet = has('quiet');

if (!dir) {
  console.error('用法: node scripts/sync-jackets.mjs --dir <曲绘目录> [--interval-min 10] [--once]');
  process.exit(1);
}

const log = (...a) => { if (!quiet) console.log(new Date().toISOString().slice(11, 19), ...a); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 已连跑多少轮（用于日志，不落盘——进程重启后重新计数即可）。 */
let round = 0;
let totalDownloaded = 0;

for (;;) {
  round++;
  log(`── 第 ${round} 轮 ──`);
  let r;
  try {
    r = await syncJackets({
      dir,
      onProgress: (p) => {
        if (p.phase === 'index-ready') log(`曲数据库 ${p.total} 首`);
        if (p.phase === 'plan') log(`本地已有 ${p.alreadyHad} 张，待下 ${p.missing} 张`);
        if (p.phase === 'budget') log(`GitHub 额度 ${p.remaining}/${p.limitPerHour} → 本轮下 ${p.thisRun} 张`);
        if (p.phase === 'downloading') log(`  下载 ${p.done}/${p.total}（${(p.bytes / 1048576).toFixed(1)} MB）`);
      },
    });
  } catch (e) {
    // syncJackets 已把预期的失败转成返回值，这里只兜住真正的意外
    console.error(new Date().toISOString().slice(11, 19), '意外错误：', e?.message ?? e);
    if (once) process.exit(1);
    await sleep(intervalMin * 60 * 1000);
    continue;
  }

  if (!r.ok) {
    console.error(new Date().toISOString().slice(11, 19), '同步失败：', (r.error ?? '').split('\n')[0]);
    if (once) process.exit(1);
    log(`${intervalMin} 分钟后再试`);
    await sleep(intervalMin * 60 * 1000);
    continue;
  }

  totalDownloaded += r.downloaded;
  const st = jacketStats(dir);
  log(`本轮下载 ${r.downloaded} 张（失败 ${r.failed}）| 累计本轮进程 ${totalDownloaded} | 本地共 ${st.byTitle} 张 | 还差 ${r.remaining}`);

  if (r.remaining <= 0) {
    log(`✅ 全部完成：${st.byTitle} 张曲绘就绪（共 ${round} 轮，本进程下载 ${totalDownloaded} 张）`);
    process.exit(0);
  }
  if (once) {
    log(`（--once：退出。还差 ${r.remaining} 张，再跑一次继续）`);
    process.exit(0);
  }

  // 额度耗尽 → 睡到重置时刻（多等 60 秒，避免卡在临界点上又白跑一轮）
  const rl = r.rateLimit;
  let waitMs = intervalMin * 60 * 1000;
  if (rl && rl.remaining <= 2 && rl.resetAt) {
    waitMs = Math.max(waitMs, rl.resetAt - Date.now() + 60_000);
    log(`额度已用尽，等到 ${new Date(rl.resetAt + 60_000).toISOString().slice(11, 19)} 再继续（约 ${Math.round(waitMs / 60000)} 分钟）`);
  } else {
    log(`${Math.round(waitMs / 60000)} 分钟后继续`);
  }
  await sleep(waitMs);
}
