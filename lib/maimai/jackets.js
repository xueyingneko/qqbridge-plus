/**
 * 曲绘（歌曲封面）加载——**素材由使用者自备**。
 *
 * ── 为什么不内置素材 ──
 *
 * 曲绘是 SEGA 的游戏版权素材。本仓库是 MIT，不能把别人的版权物打包进来；
 * 而水鱼的接口**不提供曲绘地址**（`basic_info` 只有 title/artist/genre/bpm），
 * 也没找到许可清楚的公开来源（实测 dxrating 与官网静态路径均 404）。
 * 所以这里只做"用你自己已有的素材"——找到就画，找不到退回色条。
 *
 * ── 目录布局 ──
 *
 * 指向一个目录，文件名里含**曲目 id** 即可，扩展名随意（png/jpg/jpeg/webp）：
 *
 *   jackets/
 *     11576.png          ← 推荐：文件名 = song_id
 *     11576_icon.png     ← 也认：id 作为开头片段
 *     8.jpg
 *
 * 也支持用曲名匹配（文件名里含曲名，去掉不能做文件名的字符），放在 `by-title/` 子目录里：
 *
 *   jackets/by-title/Zitronectar.png
 *
 * 为什么两种都认：不同来源的资源包命名习惯差别很大。id 最可靠（曲名会变、会有
 * 全角与符号差异），所以优先 id。
 *
 * @module dsh-plugin-qqbridge-plus/maimai/jackets
 */
import fs from 'node:fs';
import path from 'node:path';

/** 认的图片扩展名（按优先级）。 */
const EXTS = ['.png', '.jpg', '.jpeg', '.webp'];

/** 把曲名规整成可做文件名的形式（与常见资源包的习惯一致）。 */
export function titleToFilename(title) {
  return String(title ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')   // Windows 非法字符
    .trim();
}

/**
 * 扫描曲绘目录，建立 id → 文件路径 的索引。
 *
 * 一次性扫描而不是每个 id 都去试文件：一张 B50 有 50 首歌，而目录里可能有上千个文件。
 * 同步 IO 做 50×4 次探测虽然也能跑，但那是没必要的开销，而且错误更难解释。
 *
 * @param {string} dir 曲绘目录
 * @returns {{byId: Map<string,string>, byTitle: Map<string,string>, count: number, dir: string|null}}
 */
export function scanJackets(dir) {
  const empty = { byId: new Map(), byTitle: new Map(), count: 0, dir: null };
  const root = String(dir ?? '').trim();
  if (!root) return empty;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // 目录不存在/不可读：不是错误，只是没有曲绘可用（会退回色条）
    return { ...empty, dir: root };
  }

  const byId = new Map();
  const byTitle = new Map();
  let count = 0;

  const put = (map, key, full) => {
    const k = String(key);
    if (!k) return;
    // 先到先得：同一 id 有多个扩展名时，按 EXTS 的优先级已由下面的排序保证
    if (!map.has(k)) map.set(k, full);
  };

  for (const e of entries.sort((a, b) => EXTS.indexOf(path.extname(a.name).toLowerCase()) - EXTS.indexOf(path.extname(b.name).toLowerCase()))) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      // by-title 子目录：文件名（去扩展名）= 曲名
      if (/^by-?title$/i.test(e.name)) {
        try {
          for (const t of fs.readdirSync(full, { withFileTypes: true })) {
            if (!t.isFile() || !EXTS.includes(path.extname(t.name).toLowerCase())) continue;
            put(byTitle, path.basename(t.name, path.extname(t.name)), path.join(full, t.name));
          }
        } catch { /* 跳过不可读的子目录 */ }
      }
      continue;
    }
    if (!EXTS.includes(path.extname(e.name).toLowerCase())) continue;

    // 从文件名里抽 id：纯数字，或数字作为开头片段（11576_icon / 11576-icon）
    const stem = path.basename(e.name, path.extname(e.name));
    const m = stem.match(/^(\d+)(?:[^\d]|$)/);
    if (m) put(byId, m[1], full);
    // 同时按曲名登记一份（用文件名词干）——id 匹配失败时还有一次机会
    put(byTitle, stem, full);
    count++;
  }

  return { byId, byTitle, count, dir: root };
}

/**
 * 为一条成绩找曲绘。
 * @param {{byId: Map, byTitle: Map}} index scanJackets() 的结果
 * @param {object} p 成绩对象（需 song_id / title）
 * @returns {string|null}
 */
export function findJacket(index, p) {
  if (!index) return null;
  const id = p?.song_id ?? p?.id;
  if (id != null && index.byId.has(String(id))) return index.byId.get(String(id));
  const title = titleToFilename(p?.title);
  if (title && index.byTitle.has(title)) return index.byTitle.get(title);
  return null;
}

/**
 * 加载并缓存图片。
 *
 * 缓存是必需的：一张 B50 里同一首歌只出现一次，但**反复查同一个人**时会重复读同一批
 * 文件。缓存按文件路径存已解码的图片对象，渲染时直接用。
 *
 * @param {Function} loadImage @napi-rs/canvas 的 loadImage
 * @param {Array<string>} files 要预加载的文件
 * @returns {Promise<{images: Map<string,any>, failed: number, bytes: number}>}
 */
export async function preloadJackets(loadImage, files) {
  const images = new Map();
  let failed = 0;
  let bytes = 0;
  for (const f of [...new Set(files.filter(Boolean))]) {
    try {
      const buf = fs.readFileSync(f);
      bytes += buf.length;
      images.set(f, await loadImage(buf));
    } catch {
      failed++;
    }
  }
  return { images, failed, bytes };
}

/**
 * 把曲绘画进卡片的封面区（上 34px 之外的部分），保持比例裁切填充。
 *
 * 用"覆盖并裁切"而不是"完整塞入"：曲绘是正方形，而卡片封面区是 168×114 的横条；
 * 完整塞入会留大片空白，看起来像图没加载出来。
 */
export function drawJacket(ctx, img, x, y, w, h) {
  if (!img) return false;
  const iw = img.width || 1;
  const ih = img.height || 1;
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
  return true;
}
