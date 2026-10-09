// B50 渲染器的测试。
//
// 这里不比对像素（那是脆的），而是锁住几件**出过错或会出丑**的事：
//   · 输出是合法 PNG、尺寸随内容变化，且高度公式只有一处
//   · 缺字段/空数据/超长曲名不得抛错（数据源给什么都要能画）
//   · **画图库缺失时必须能降级**，并给出装什么的指引——查分/开关/状态
//     不该因为"没装画图库"一起挂掉
// 另外把两处真实版面 bug 作为回归守住：评级与达成率重叠、页脚署名被截断。
import assert from 'node:assert/strict';
import {
  renderB50, renderNotice, hasCJKFont, fontInfo, b50Height, layoutSize,
  canvasStatus, CANVAS_PACKAGE, CANVAS_HINT, LAYOUT,
} from '../lib/maimai/render.js';

let passed = 0;
const failures = [];
const ok = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failures.push(`${name}: ${e?.message ?? e}`); console.log(`  ❌ ${name}\n     ${e?.message ?? e}`); }
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (buf) => Buffer.isBuffer(buf) && buf.length > 8 && buf.subarray(0, 8).equals(PNG_MAGIC);
const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

const chart = (over = {}) => ({
  title: 'Zitronectar', level: '14', level_index: 3,
  achievements: 100.5754, rate: 'sssp', dxScore: 2029, ra: 321, ds: 14.3, ...over,
});

const status = await canvasStatus();
const hasCanvas = status.ok;
console.log(`画图库 ${CANVAS_PACKAGE}: ${hasCanvas ? '可用' : '不可用（跳过出图断言，只测降级）'}\n`);

// ── 与画图库无关的：必须永远成立 ─────────────────────────────────────────────
console.log('== 版面计算（不依赖画图库）==');

await ok('高度公式自洽：空 / 只有旧曲 / 只有新曲', async () => {
  assert.equal(b50Height(0, 0), LAYOUT.headerH + LAYOUT.footerH, '空数据不该多留 gap');
  assert.ok(b50Height(1, 0) > b50Height(0, 0));
  assert.ok(b50Height(0, 1) > b50Height(0, 0));
  // 只在**跨行**时高度才变：4→5 首仍是 1 行（高度相同），5→6 首才多一行。
  // 早先这里写成"多一首必定变高"，而 34→35 首都在第 7 行内，断言必然失败。
  assert.equal(b50Height(4, 0), b50Height(5, 0), '4 和 5 首都占 1 行，高度应相同');
  assert.ok(b50Height(6, 0) > b50Height(5, 0), '第 6 首要另起一行，高度应变高');
  assert.ok(b50Height(35, 15) > b50Height(6, 0));
});
await ok('35+15 的行数 = 7 + 3', async () => {
  const rows = Math.ceil(35 / LAYOUT.cols) + Math.ceil(15 / LAYOUT.cols);
  assert.equal(rows, 10);
  const expect = LAYOUT.headerH + 2 * LAYOUT.sectionTitleH + rows * (LAYOUT.cardH + LAYOUT.gap) + LAYOUT.gap + LAYOUT.footerH;
  assert.equal(b50Height(35, 15), expect);
});
await ok('layoutSize() 与 b50Height() 一致（避免两处公式漂移）', async () => {
  const s = layoutSize({ charts: { sd: Array(35).fill(chart()), dx: Array(15).fill(chart()) } });
  assert.equal(s.height, b50Height(35, 15));
  assert.equal(s.width, LAYOUT.width);
});

// ── 降级路径：这是刚发现的真缺陷 ─────────────────────────────────────────────
console.log('\n== 画图库缺失时的降级 ==');

await ok('canvasStatus() 返回结构化结果，不抛错', async () => {
  assert.equal(typeof status.ok, 'boolean');
  if (!status.ok) assert.ok(status.error, '不可用时必须给出原因');
});
await ok('安装指引里包含包名与具体命令', async () => {
  assert.ok(CANVAS_HINT.includes(CANVAS_PACKAGE));
  assert.match(CANVAS_HINT, /npm install/);
  assert.match(CANVAS_HINT, /不需要编译工具链/, '要告诉用户它不需要编译，否则会被劝退');
});

if (!hasCanvas) {
  await ok('画图库不可用时，渲染抛的是带指引的错误而不是原始 ERR_MODULE_NOT_FOUND', async () => {
    await assert.rejects(() => renderB50({ nickname: 'x' }), (e) => {
      assert.ok(e.message.includes('npm install'), '错误信息没告诉用户怎么装');
      return true;
    });
    await assert.rejects(() => renderNotice(['x']), (e) => e.message.includes('npm install'));
  });
  await ok('字体探测在无画图库时不抛错（返回空而不是崩）', async () => {
    const info = fontInfo();
    assert.equal(info.count, 0);
    assert.equal(info.hasCJK, false);
  });
  console.log(`\n${failures.length ? `❌ ${failures.length} 项失败\n- ${failures.join('\n- ')}` : `🎉 全部通过（${passed} 项）`}—— 当前为无画图库的降级路径`);
  process.exit(failures.length > 0 ? 1 : 0);
}

// ── 有画图库时的完整断言 ─────────────────────────────────────────────────────
console.log('== 输出格式 ==');

await ok('渲染出的是合法 PNG', async () => {
  const png = await renderB50({ nickname: '测试', rating: 12345, additional_rating: 5, charts: { sd: [chart()], dx: [chart()] } });
  assert.ok(isPng(png), 'PNG 魔数不对');
});
await ok('宽度固定 1080，高度随内容增长', async () => {
  const few = pngSize(await renderB50({ nickname: 'a', charts: { sd: [chart()], dx: [] } }));
  const many = pngSize(await renderB50({ nickname: 'a', charts: { sd: Array.from({ length: 35 }, () => chart()), dx: Array.from({ length: 15 }, () => chart()) } }));
  assert.equal(few.width, LAYOUT.width);
  assert.equal(many.width, LAYOUT.width);
  assert.ok(many.height > few.height, `内容多了高度该变高：${few.height} vs ${many.height}`);
});
await ok('实际渲染高度 == b50Height()（公式只有一处）', async () => {
  const png = pngSize(await renderB50({ nickname: 'x', charts: { sd: Array.from({ length: 35 }, () => chart()), dx: Array.from({ length: 15 }, () => chart()) } }));
  assert.equal(png.height, b50Height(35, 15), '渲染高度与高度函数不一致（曾经差一个 gap）');
});
await ok('空数据的实际高度也吻合', async () => {
  assert.equal(pngSize(await renderB50({ charts: {} })).height, b50Height(0, 0));
});

console.log('\n== 健壮性（数据源给什么都得能画）==');

await ok('空数据不崩，且仍是一张可看的图', async () => { assert.ok(isPng(await renderB50({ nickname: '空', charts: { sd: [], dx: [] } }))); });
await ok('完全没有 charts 字段不崩', async () => { assert.ok(isPng(await renderB50({ nickname: 'x' }))); });
await ok('传 undefined / null 不崩', async () => {
  assert.ok(isPng(await renderB50(undefined)));
  assert.ok(isPng(await renderB50(null)));
});
await ok('缺 nickname/rating 时用占位而不是 undefined', async () => { assert.ok(isPng(await renderB50({ charts: { sd: [chart()] } }))); });
await ok('超长曲名不崩（内部做截断）', async () => {
  assert.ok(isPng(await renderB50({ nickname: 'x', charts: { sd: [chart({ title: 'あ'.repeat(200) })] } })));
});
await ok('字段类型异常（字符串数字、null）不崩', async () => {
  const weird = [
    chart({ achievements: '100.5', level_index: '3', dxScore: '2000', ra: null, ds: null }),
    chart({ achievements: null, level_index: 99, rate: null, title: null }),
    chart({ achievements: 0, level_index: -1, title: '' }),
  ];
  assert.ok(isPng(await renderB50({ nickname: 'x', charts: { sd: weird, dx: weird } })));
});
await ok('未知 rate 值也能显示（回退成大写文本）', async () => {
  assert.ok(isPng(await renderB50({ nickname: 'x', charts: { sd: [chart({ rate: 'weird_rate' })] } })));
});

console.log('\n== 版面回归（两处真出过的问题）==');

await ok('回归：评级不再与达成率同行重叠——rate 徽标移到顶部色条', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/maimai/render.js', import.meta.url), 'utf8');
  const line = src.split('\n').findIndex((l) => l.includes('toFixed(4)'));
  assert.ok(line > 0, '找不到达成率绘制行');
  const nearby = src.split('\n').slice(line, line + 8).join('\n');
  assert.ok(!/RATE_LABEL/.test(nearby), '评级绘制又回到了达成率附近，会重叠');
});
await ok('回归：页脚宽度按实测分配，右侧署名不被截断', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/maimai/render.js', import.meta.url), 'utf8');
  assert.ok(!/padX \* 2 - 200/.test(src), '页脚又用回了固定 200px 预留（会截断右侧署名）');
  assert.match(src, /measureText\(right\)/, '页脚应实测右侧宽度');
});

console.log('\n== 字体与提示图 ==');

await ok('能探测本机中文字体（否则图里中文会变方框）', async () => {
  const info = fontInfo();
  assert.ok(info.count > 0, '一个字体都没探测到，渲染必然异常');
  console.log(`     本机字体 ${info.count} 个，中文字体：${info.hasCJK ? info.cjkSample.join(' / ') || '(有)' : '❌ 无'}`);
});
await ok('提示图也能渲染（未绑定/查不到这类场景要出图）', async () => {
  const png = await renderNotice(['还没绑定水鱼查分器', '在群里发「绑定水鱼」走一次授权即可'], { tone: 'error' });
  assert.ok(isPng(png));
  assert.ok(pngSize(png).width > 0);
});
await ok('提示图空行/多行不崩', async () => {
  assert.ok(isPng(await renderNotice([])));
  assert.ok(isPng(await renderNotice(['一', '二', '三', '四', '五'])));
  assert.ok(isPng(await renderNotice('单行字符串')));
});

console.log(`\n${failures.length ? `❌ ${failures.length} 项失败\n- ${failures.join('\n- ')}` : `🎉 全部通过（${passed} 项）`}`);
process.exit(failures.length ? 1 : 0);
