/**
 * B50 成绩图渲染（@napi-rs/canvas）。
 *
 * 渲染风格参照 [maimaiDX](https://github.com/Yuri-YuzuChaN/maimaiDX)（MIT）的
 * core/image/best50.py，但**没有移植它的图像资源**——那套曲绘是 SEGA 的游戏素材，
 * 既不能打包，也没有可靠的下载链路。所以本渲染器：
 *   · 不依赖任何外部图片，卡片用曲名推导出的稳定色条作视觉标识；
 *   · 只用系统字体（Windows 上有微软雅黑），中文不会乱码；
 *   · 版面尺寸由常量算出，可离线断言。
 *
 * 选用 @napi-rs/canvas 而不是 node-canvas：它是 N-API 预编译包，
 * 不需要 node-gyp / VS Build Tools，装上就能用（Node 24 + Windows 实测通过）。
 *
 * ── 关于这个依赖为什么是"可选的" ──
 *
 * 本插件刻意不在自己目录里放 `node_modules`（见 README 硬规则 2：裸包名解析不到会
 * 导致整模块在导入期失败，插件直接不出现）。所以 `@napi-rs/canvas` 走**动态导入**，
 * 而且失败要能被捕获——查分、开关、状态这些功能不该因为"没装画图库"而一起挂掉。
 * 缺失时明确告诉用户装什么，而不是抛一个 ERR_MODULE_NOT_FOUND 上去。
 *
 * @module dsh-plugin-qqbridge-plus/maimai/render
 */
import { createRequire } from 'node:module';

/** 渲染依赖的包名与安装指引（报错信息里要用到）。 */
export const CANVAS_PACKAGE = '@napi-rs/canvas';
export const CANVAS_HINT = `要出成绩图需要装 ${CANVAS_PACKAGE}：在插件目录执行 npm install ${CANVAS_PACKAGE}（它是 N-API 预编译包，不需要编译工具链）。装好后重启 DSH 生效。`;

let canvasMod = null;
let loadError = null;

/**
 * 加载画图库（只试一次，结果缓存）。
 * @returns {{ok: true, mod: object} | {ok: false, error: string}}
 */
export async function loadCanvas() {
  if (canvasMod) return { ok: true, mod: canvasMod };
  if (loadError) return { ok: false, error: loadError };
  try {
    canvasMod = await import(CANVAS_PACKAGE);
    return { ok: true, mod: canvasMod };
  } catch (e) {
    // 退回按路径解析一次：插件被 link 进 profile 时，裸包名可能解析到 profile 的
    // node_modules，而那里未必装了这个包，此时用宿主 profile 的路径再试一次。
    try {
      const req = createRequire(import.meta.url);
      const resolved = req.resolve(CANVAS_PACKAGE);
      canvasMod = await import(resolved);
      return { ok: true, mod: canvasMod };
    } catch {
      loadError = `${CANVAS_HINT}（原始错误：${e?.code ?? e?.message ?? e}）`;
      return { ok: false, error: loadError };
    }
  }
}

/** 画图库是否可用（同步判断，用于决定要不要给出图相关的 action）。 */
export function canvasAvailable() {
  return canvasMod !== null;
}

/** 取画图库的可用状态与原因，供工具/命令层组织人话提示。 */
export async function canvasStatus() {
  const r = await loadCanvas();
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

// ── 版面常量（集中在这里，便于测试与调版）────────────────────────────────────
export const LAYOUT = {
  width: 1080,
  headerH: 150,
  cardW: 168,
  cardH: 148,
  gap: 12,
  cols: 5,
  padX: 28,
  sectionTitleH: 44,
  footerH: 56,
};

// ── 配色 ─────────────────────────────────────────────────────────────────────
const C = {
  bg: '#14161c',
  bgAlt: '#1b1e26',
  panel: '#20242e',
  panelEdge: '#2c313d',
  text: '#e6edf3',
  dim: '#8b949e',
  accent: '#f0883e',
  sd: '#4aa3ff',
  dx: '#f0883e',
};

/**
 * 评级配色。按原项目惯例：成绩达到该评级时用对应颜色。
 * 这里按 rate 字段（sssp/sss/ss/...）给色，而不是自己重新判档——
 * 判定口径以数据源为准，渲染层不该有第二套标准。
 */
const RATE_COLOR = {
  sssp: '#ffd700', sss: '#ffcc33', 'ss+': '#ffb347', ss: '#ffa500',
  's+': '#7ee787', s: '#5fdc7a',
  aaa: '#4aa3ff', aa: '#5aa9e6', a: '#7fb3d5',
  bbb: '#a0a0a0', bb: '#909090', b: '#808080',
  c: '#707070', d: '#606060', f: '#505050',
};
const RATE_LABEL = {
  sssp: 'SSS+', sss: 'SSS', 'ss+': 'SS+', ss: 'SS', 's+': 'S+', s: 'S',
  aaa: 'AAA', aa: 'AA', a: 'A', bbb: 'BBB', bb: 'BB', b: 'B', c: 'C', d: 'D', f: 'F',
};

// 难度索引 → 标签（0=BASIC … 4=Re:MASTER），与原项目一致
const DIFF_LABEL = ['BAS', 'ADV', 'EXP', 'MAS', 'ReM'];
const DIFF_COLOR = ['#7ee787', '#ffd75f', '#ff6b6b', '#c77dff', '#b39ddb'];

/** 字体：优先微软雅黑（Windows），退回系统无衬线。 */
function fontSpec(weight, size) {
  return `${weight} ${size}px "Microsoft YaHei", "Noto Sans CJK SC", "PingFang SC", sans-serif`;
}

/** 由字符串稳定地得到一个色相（同一首歌每次渲染颜色一致）。 */
function hashHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/** 圆角矩形路径。 */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 超宽文本截断加省略号。 */
function fitText(ctx, text, maxW) {
  const s = String(text ?? '');
  if (ctx.measureText(s).width <= maxW) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(s.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1;
  }
  return s.slice(0, lo) + '…';
}

/**
 * 把一条成绩画成卡片。
 * 字段名沿用数据源（achievements / level / level_index / title / dxScore / ra / rate / ds）。
 */
function drawCard(ctx, x, y, p, variant) {
  const { cardW: w, cardH: h } = LAYOUT;
  roundRect(ctx, x, y, w, h, 8);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = C.panelEdge;
  ctx.lineWidth = 1;
  ctx.stroke();

  // 顶部色条：颜色由曲名稳定推导（同一首歌每次渲染都一样）。
  // 卡片上本该有曲绘，此处用它作为"这首歌"的视觉标识。
  const hue = hashHue(p.title ?? '');
  ctx.save();
  roundRect(ctx, x, y, w, h, 8);
  ctx.clip();
  ctx.fillStyle = `hsl(${hue}, 32%, 26%)`;
  ctx.fillRect(x, y, w, 34);
  ctx.restore();

  // 这里本该是曲绘，但那套素材是 SEGA 的游戏资源，不能打包进仓库。
  // 试过用曲名首字当占位，但 52px 的大字在 168px 宽的卡片里会压到难度和达成率，
  // 读起来像乱码——占位不如克制：只保留曲名推导出的色条（见上），不加大字。

  // 评级徽标放在顶部色条右侧。
  // 早先把它和达成率并排放在同一行，结果 21px 的"100.6102%"约 100px 宽，
  // 加上徽标超过卡片内宽 152px，两者叠在一起（渲染出来是"100.6102%S+"）。
  // 色条这行本来就是空的，移到这里既解决重叠，也和下方类型色呼应。
  const rate = String(p.rate ?? '').toLowerCase();
  const rateText = RATE_LABEL[rate] ?? (rate ? rate.toUpperCase() : '—');
  ctx.font = fontSpec('bold', 15);
  const rateW = ctx.measureText(rateText).width;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(12,14,18,0.55)';
  roundRect(ctx, x + w - rateW - 14, y + 6, rateW + 10, 22, 5);
  ctx.fill();
  ctx.fillStyle = RATE_COLOR[rate] ?? C.dim;
  ctx.fillText(rateText, x + w - 9, y + 17);

  // 标题
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C.text;
  ctx.font = fontSpec('bold', 13);
  // 标题要避开右上角的评级徽标，所以可用宽度扣掉徽标宽度
  const title = fitText(ctx, p.title, w - 16 - (rateW + 12));
  ctx.fillText(title, x + 8, y + 22);

  // 难度徽标：类型色 + 等级
  const idx = Number.isInteger(p.level_index) ? p.level_index : 3;
  ctx.fillStyle = DIFF_COLOR[idx] ?? C.dim;
  ctx.font = fontSpec('bold', 12);
  ctx.fillText(`${DIFF_LABEL[idx] ?? '?'} ${p.level ?? ''}`, x + 8, y + 60);

  // 达成率（评级已在顶部，这里独占一行，不会再撞）
  ctx.fillStyle = C.text;
  ctx.font = fontSpec('bold', 21);
  ctx.fillText(`${Number(p.achievements ?? 0).toFixed(4)}%`, x + 8, y + 88);

  // 底部两行：定数 / DX 分 / ra
  ctx.fillStyle = C.dim;
  ctx.font = fontSpec('normal', 11);
  const ds = p.ds != null && p.ds !== 0 ? `定数 ${Number(p.ds).toFixed(1)}` : '';
  const dx = p.dxScore ? `DX ${p.dxScore}` : '';
  ctx.fillText([ds, dx].filter(Boolean).join('  '), x + 8, y + 110);

  // ra 用类型色，和标题栏呼应
  ctx.fillStyle = variant === 'dx' ? C.dx : C.sd;
  ctx.font = fontSpec('bold', 13);
  ctx.fillText(`ra ${p.ra ?? 0}`, x + 8, y + 132);
}

/**
 * 算出一张 B50 图的高度。
 *
 * 导出它是有原因的：一开始渲染器和测试各写了一遍这个公式，结果两边差了一个 gap
 * （1906 vs 1918）。所以公式**只留这一处**，测试直接调用它比对实际输出尺寸。
 */
export function b50Height(sdCount, dxCount) {
  const rowsOf = (n) => (n === 0 ? 0 : Math.ceil(n / LAYOUT.cols));
  const sectionH = (n) => (n === 0 ? 0 : LAYOUT.sectionTitleH + rowsOf(n) * (LAYOUT.cardH + LAYOUT.gap));
  // 两段各占一块，段与段之间留一个 gap，两段都为空时不留
  const anySection = sdCount > 0 || dxCount > 0;
  return LAYOUT.headerH + sectionH(sdCount) + sectionH(dxCount) + (anySection ? LAYOUT.gap : 0) + LAYOUT.footerH;
}

/** 从数据源响应算出画布尺寸。渲染与测试都走这一处。 */
export function layoutSize(data) {
  const charts = data?.charts ?? {};
  const sd = Array.isArray(charts.sd) ? charts.sd : [];
  const dx = Array.isArray(charts.dx) ? charts.dx : [];
  return { width: LAYOUT.width, height: b50Height(sd.length, dx.length) };
}

/**
 * 渲染一张 B50 图。
 * @param {object} data 数据源响应（nickname / rating / additional_rating / charts{sd,dx}）
 * @param {object} [opts]
 * @param {string} [opts.title] 页脚文字
 * @returns {Promise<Buffer>} PNG
 * @throws {Error} 画图库不可用时抛出带安装指引的错误
 */
export async function renderB50(data, opts = {}) {
  const loaded = await loadCanvas();
  if (!loaded.ok) throw new Error(loaded.error);
  const { createCanvas } = loaded.mod;

  const charts = data?.charts ?? {};
  const sd = Array.isArray(charts.sd) ? charts.sd : [];
  const dx = Array.isArray(charts.dx) ? charts.dx : [];
  const rowsOf = (n) => (n === 0 ? 0 : Math.ceil(n / LAYOUT.cols));
  const height = b50Height(sd.length, dx.length);

  const canvas = createCanvas(LAYOUT.width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, LAYOUT.width, height);

  // ── 头部 ──
  ctx.fillStyle = C.bgAlt;
  ctx.fillRect(0, 0, LAYOUT.width, LAYOUT.headerH);
  ctx.fillStyle = C.accent;
  ctx.fillRect(0, LAYOUT.headerH - 3, LAYOUT.width, 3);

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C.text;
  ctx.font = fontSpec('bold', 40);
  ctx.fillText(fitText(ctx, data?.nickname || data?.username || '(未知玩家)', 620), LAYOUT.padX, 66);

  ctx.fillStyle = C.dim;
  ctx.font = fontSpec('normal', 16);
  // additional_rating 是水鱼的"段位"（1-10 之类的档），不是单曲评级；
  // 标成"段位/评级"避免和卡片上的 SSS+ 混淆。
  ctx.fillText(`Rating ${data?.rating ?? '?'}　·　段位/评级 ${data?.additional_rating ?? '?'}`, LAYOUT.padX, 98);
  if (data?.plate) ctx.fillText(`牌子 ${data.plate}`, LAYOUT.padX, 122);

  // 右上角大字 rating
  ctx.textAlign = 'right';
  ctx.fillStyle = C.accent;
  ctx.font = fontSpec('bold', 54);
  ctx.fillText(String(data?.rating ?? '—'), LAYOUT.width - LAYOUT.padX, 70);
  ctx.fillStyle = C.dim;
  ctx.font = fontSpec('normal', 15);
  ctx.fillText('B50', LAYOUT.width - LAYOUT.padX, 98);
  ctx.textAlign = 'left';

  // ── 两段成绩 ──
  let y = LAYOUT.headerH + LAYOUT.gap;
  const drawSection = (label, list, variant, color) => {
    if (!list.length) return;
    ctx.fillStyle = color;
    ctx.font = fontSpec('bold', 22);
    ctx.fillText(`${label}　${list.length}`, LAYOUT.padX, y + 30);
    ctx.fillStyle = C.panelEdge;
    ctx.fillRect(LAYOUT.padX, y + 38, LAYOUT.width - LAYOUT.padX * 2, 1);
    y += LAYOUT.sectionTitleH;

    list.forEach((p, i) => {
      const col = i % LAYOUT.cols;
      const row = Math.floor(i / LAYOUT.cols);
      drawCard(ctx, LAYOUT.padX + col * (LAYOUT.cardW + LAYOUT.gap), y + row * (LAYOUT.cardH + LAYOUT.gap), p, variant);
    });
    y += rowsOf(list.length) * (LAYOUT.cardH + LAYOUT.gap) + LAYOUT.gap;
  };

  // 旧曲在前、新曲在后，和原项目一致
  drawSection('旧曲 Best 35', sd, 'sd', C.sd);
  drawSection('新曲 Best 15', dx, 'dx', C.dx);

  // ── 页脚 ──
  // 宽度按两侧实测分配：早先给左侧留了固定 200px，右侧署名就被截成
  // "dsh-plugin-qqbridge-plu"。现在先量右侧，再让左侧用它剩下多少。
  ctx.font = fontSpec('normal', 13);
  const right = 'dsh-plugin-qqbridge-plus';
  const rightW = ctx.measureText(right).width;
  const avail = LAYOUT.width - LAYOUT.padX * 2 - rightW - 24;
  ctx.fillStyle = C.dim;
  const footLeft = fitText(ctx, opts.title ?? '数据来源：水鱼查分器 diving-fish.com', avail);
  ctx.fillText(footLeft, LAYOUT.padX, height - 24);
  ctx.textAlign = 'right';
  ctx.fillText(right, LAYOUT.width - LAYOUT.padX, height - 24);
  ctx.textAlign = 'left';

  return canvas.toBuffer('image/png');
}

/** 渲染一张纯文字提示图（用于"未绑定""查不到"这类需要出图的场景）。 */
export async function renderNotice(lines, { tone = 'info' } = {}) {
  const loaded = await loadCanvas();
  if (!loaded.ok) throw new Error(loaded.error);
  const { createCanvas } = loaded.mod;

  const arr = (Array.isArray(lines) ? lines : [lines]).map(String);
  const width = 760;
  const height = 90 + arr.length * 34 + 50;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = tone === 'error' ? '#f85149' : C.accent;
  ctx.fillRect(0, 0, width, 4);
  ctx.fillStyle = C.text;
  ctx.font = fontSpec('bold', 24);
  ctx.fillText(arr[0] ?? '', 30, 62);
  ctx.fillStyle = C.dim;
  ctx.font = fontSpec('normal', 16);
  arr.slice(1).forEach((l, i) => ctx.fillText(fitText(ctx, l, width - 60), 30, 104 + i * 34));
  return canvas.toBuffer('image/png');
}

/** 本机是否有可用的中文字体（没有的话中文会画成方框）。需要画图库已加载。 */
export function hasCJKFont() {
  const families = canvasMod?.GlobalFonts?.families ?? [];
  return families.some((f) => /YaHei|SimSun|SimHei|SimKai|Noto Sans CJK|PingFang|Source Han|Microsoft JhengHei/i.test(f?.family ?? ''));
}

/** 报告本机字体情况，便于排查中文渲染问题。 */
export function fontInfo() {
  const families = canvasMod?.GlobalFonts?.families ?? [];
  return {
    count: families.length,
    hasCJK: hasCJKFont(),
    cjkSample: families
      .map((f) => f?.family)
      .filter((n) => n && /YaHei|SimSun|SimHei|Noto Sans CJK|PingFang|Source Han/i.test(n))
      .slice(0, 6),
  };
}
