# 需要打到 qq-bridge 的另一处补丁：出图通路

本插件的舞萌成绩图需要 qq-bridge 帮忙**把本机图片发到 QQ**。这段代码不在本仓库里，
和「绑定类强制私聊」一样属于 `src/bridge.js` 的本地改动。两份都要打，插件才完整。

> 安装 qq-bridge 的官方版本时，这些函数**不存在**，插件的出图与私发都会失效
> （报"action 端点不可用"或直接抛 `sendSegmentsV2 is not defined`）。

## 改动一：抽出 `sendSegmentsV2`

原 `sendStickerV2` 里内联了一整套发送逻辑：`sendChain` 串行化、发送前置校验
（`captureSendGuard`）、真人化停顿、SnowLuma 的错误翻译。**这套逻辑不能复制**——
尤其 `sendChain` 的串行语义，它保证"先文字后图"的顺序不被并发调用打乱。

所以在 `sendStickerV2` **之前**插入：

```js
  /**
   * 把一个 segments 数组发给 QQ（V2 通道）。
   *
   * 抽出来的原因：这段逻辑原本内联在 sendStickerV2 里，而"发本地图片"需要一模一样的
   * sendChain 串行化 + 发送前置校验 + 真人化停顿 + SnowLuma 错误翻译。复制一份出来
   * 必然漂移（尤其是 sendChain 的串行语义——它保证"先文字后图"的顺序不打乱）。
   */
  async function sendSegmentsV2(key, segments, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private'
      ? { user_id: Number(id), message: segments }
      : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const delayMs = options.delayMs ?? randInt(800, 2000);

    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    sendChain = sendChain.then(async () => {
      try {
        await sleep(delayMs);
        assertSendAllowed();
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(15000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    return await sendResult;
  }
```

然后把 `sendStickerV2` 里那段内联的 `sendChain = sendChain.then(...)` 整块删掉，改成：

```js
    // 与文本发送共用 sendChain，保证“先文字后表情”的真人顺序不被并发工具调用打乱。
    const data = await sendSegmentsV2(key, segments);
```

## 改动二：新增 `sendImageV2`

紧接在 `sendSegmentsV2` 之后：

```js
  /**
   * 发一张本机图片到 QQ。
   *
   * 走 base64 而不是把路径交给网关：网关可能在不同用户/容器下运行，本地路径不保证可达。
   * 刻意**不接受 http(s) URL**：那会让这里变成任意 URL 的外发口子
   * （与 sendVoiceV2 的既有口径一致——语音也只收本地文件）。
   */
  async function sendImageV2(key, filePath, options = {}) {
    const p = String(filePath ?? '').trim();
    if (!p) throw new Error('sendImageV2：文件路径为空');
    if (/^(https?:|data:|base64:\/\/)/i.test(p)) {
      throw new Error('发图只接受本机文件路径；不接受 http(s)、data: 或 base64:// 来源');
    }
    let buf;
    try {
      buf = fs.readFileSync(p);
    } catch (error) {
      throw new Error(`读不到图片文件 ${p}：${error?.message ?? error}`);
    }
    if (buf.length === 0) throw new Error(`图片文件是空的：${p}`);
    if (buf.length > MAX_MEDIA_BYTES) {
      throw new Error(`图片 ${(buf.length / 1048576).toFixed(2)}MB 超过单张上限 ${(MAX_MEDIA_BYTES / 1048576).toFixed(1)}MB`);
    }
    if (!looksLikeImageBuffer(buf)) {
      throw new Error(`文件不像图片（魔数不匹配），已拒绝发送：${p}`);
    }

    const segments = [];
    if (options.replyToMessageId !== undefined && options.replyToMessageId !== null && String(options.replyToMessageId).trim() !== '') {
      const rid = String(options.replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (options.atUserId !== undefined && options.atUserId !== null && String(options.atUserId).trim() !== '') {
      const at = String(options.atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    segments.push({ type: 'image', data: { file: 'base64://' + buf.toString('base64') } });
    const data = await sendSegmentsV2(key, segments, options);
    return { bytes: buf.length, messageId: data?.message_id ?? null };
  }
```

`looksLikeImageBuffer` 与 `MAX_MEDIA_BYTES` 都是桥接里已有的（前者从 `./safe-fetch.js` 导入，
后者是模块级常量），**无需新增**。

## 改动三：`featureCommandReply` 返回形状改为 `{ text, imageFile }`

查分要出图，而图给不进文本里。插件把 PNG 落在本机并回报路径，桥接据此补发一条图片消息。

- 该函数的每个 `return` 都要从 `return '...'` 改成 `return { text: '...', imageFile: null }`；
- 成功分支改成 `return { text: String(data.text ?? '(无内容)'), imageFile: data.imageFile ? String(data.imageFile) : null }`；
- 调用处从 `const text = await featureCommandReply(...)` 改为取 `reply.text` 发送。

## 改动四：新增 `actionReply`（转发任意 action）

`maimai` 不是"功能开关"，需要另一个端点。新增一个与 `featureCommandReply` 同构的函数，
打 `POST <base>/qqbx/action`，body 为 `{ action, args }`，**同样必须带 `x-qqbridge-token`**。
超时给 20s（查分要拉水鱼接口 + 渲染图，比改开关慢得多）。

> 路径前缀 `/qqbx` 由插件的 `ROUTE_PREFIX` 决定，两边必须一致。

## 完整的本地改动清单

如果你要一次性核对，`src/bridge.js` 里与查分相关的改动共五处：

| # | 内容 | 服务于 |
| --- | --- | --- |
| 1 | `sendSegmentsV2`（抽出） | 出图 + 私发投递 |
| 2 | `sendImageV2`（新增） | 出图 |
| 3 | `sendReplyWithImage`（新增小助手） | 文本 + 图分两条发 |
| 4 | `actionReply`（新增） | 转发 `maimai` action |
| 5 | `maimaiCommand` 分支 + 绑定类强制私聊 | QQ 命令入口 + **安全** |

另有 `src/feature-command.mjs` 的两处：

1. `parseMaimaiArgs`（把命令参数转成插件 action 参数）与 `matchAdminCommand` 里对
   `maimaiCommand` 的支持；
2. **`normalizeCommandText`**（见下节）——这一处是真事故换来的。

## 改动六：归一化命令文本的首尾空白与零宽字符

### 为什么

中文输入法很容易在句首带出**全角空格**（`U+3000`）或零宽字符（`U+200B` / `U+FEFF`）。
这类字符**肉眼看不出**，却会让 `#查分` 匹配失败——而失败是**完全静默的**：消息被当成
普通发言丢给 AI，用户只会看到机器人答非所问，根本猜不到"我多打了个看不见的空格"。

真实事故：管理员在私聊里发 `#查分 bind qq <号>`，句首带了个全角空格，命令始终没被接住。
排查时一度误判成"桥接没加载新代码"——因为日志里连一条"命令被拒"都没有（匹配根本没触发，
自然什么也不记录）。**这种静默失败比报错难查得多。**

原来的实现只处理了"触发词**之后**的全角空格"（`content.startsWith(t + '\u3000')`），
没处理触发词**之前**的。

### 加什么

在 `src/feature-command.mjs` 里新增并导出：

```js
/**
 * 归一化命令文本：去掉首尾的空白与零宽字符。
 * 只归一化**首尾**：中间的空白有语义（分隔触发词与参数），不能动。
 */
export function normalizeCommandText(text) {
  return String(text ?? '')
    .replace(/^[\s\u3000\u200b-\u200d\ufeff]+/, '')
    .replace(/[\s\u3000\u200b-\u200d\ufeff]+$/, '');
}
```

然后：

- `matchAdminCommand` 的首行由 `const content = String(text ?? '');` 改为
  `const content = normalizeCommandText(text);`
- `parseMaimaiArgs` 里 `String(argText ?? '').trim().split(/\s+/)` 改为
  `normalizeCommandText(argText).split(/[\s\u3000]+/)`——`.trim()` 不去全角空格，
  于是 `bind　qq　123`（全角分隔）会被当成一个整体 token 而解析失败。

### 刻意**不**做的模糊匹配

全角井号 `＃` 与形近字（`査`）**不做**归一化。它们是真正不同的字符，模糊匹配会带来误判风险
（例如普通发言里出现 `＃` 就被当命令）。测试里钉住了这一点。

