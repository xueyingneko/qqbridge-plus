# 需要打到 qq-bridge 的一处安全补丁

本插件有一部分能力必须在 qq-bridge 侧配合，**那段代码不在本仓库里**。这份文档把它记下来，
这样你（或任何人）升级 qq-bridge 时不会丢掉它。

## 为什么需要

舞萌查分的 `bind` / `confirm` 两个子操作会产生**授权链接**与**一次性确认码**。

授权链接的语义是"**为你自己的账号授权**"。如果它被发到群里：

1. 群里任何人点开链接，页面上会显示绑定身份（例如 `QQ 27****24`）；
2. 他若点「同意授权」，就把**他自己的**成绩账号绑到了发起者名下；
3. 而确认码机制本来就是为了防这种"转发链接骗授权"——**机器人自己把链接放进群里，
   等于绕过了自己设计的防线**。

水鱼侧对此的保护是确认码（只出现在点同意那个人的浏览器里），但那是最后一道。机器人在
**投递环节**就不该把链接放进多人可见的地方。确认码同属一次性凭据，同理。

## 打在哪

文件：`src/bridge.js`
位置：`adminCommand.command === 'maimaiCommand'` 那个分支里，**取回 reply 之后、普通发送之前**。

## 改动内容

把原本的

```js
        const reply = await actionReply('maimai', parsed.args);
        await sendReplyWithImage(key, reply, '查分命令');
        log(`查分命令：${key} 管理员 ${cmd} ${adminCommand.arg || '(status)'} → ${reply.text.split('\n')[0]}`);
        return;
```

替换为

```js
        const reply = await actionReply('maimai', parsed.args);

        // 绑定类子操作（bind / confirm）**强制走私聊**，不回群。
        //
        // 为什么必须这样：授权链接的语义是"为你自己的账号授权"。若发到群里，
        // 任何人点开、看到页面上的绑定身份、再点同意，就把**他自己的**成绩账号
        // 绑到了发起者名下——正是确认码机制要防的转发攻击，只不过这次是机器人
        // 自己把链接放进了群里。confirm 的确认码同理：它是一次性凭据。
        if (parsed.args.sub === 'bind' || parsed.args.sub === 'confirm') {
          const [kind] = key.split(':');
          const ownerQQ = String(cfg.ownerQQ ?? '').trim();
          if (!ownerQQ) {
            await sendToQQ(key, '绑定相关操作需要私聊发送，但桥接没配置 ownerQQ，无法定位私聊对象。\n请在 config.json 里配置 ownerQQ 后重试。');
            log(`查分命令：${key} 绑定类操作被拒（未配置 ownerQQ）`);
            return;
          }
          const privateKey = `private:${ownerQQ}`;
          try {
            // 刻意用 sendSegmentsV2 而不是 sendToQQ：后者失败时只记录到 lastSendFailed
            // **不抛错**（函数体里没有 throw），而且是同步返回、不等发送完成。
            // 用它的话，私聊失败时我抓不到异常，反而会去群里说"已私发"——那是谎报。
            // sendSegmentsV2 会 await 结果并在失败时 reject，所以 catch 才真的有效。
            await sendSegmentsV2(privateKey, [{ type: 'text', data: { text: String(reply.text ?? '') } }], { delayMs: 0 });
            if (reply.imageFile) {
              try { await sendImageV2(privateKey, reply.imageFile, { delayMs: 0 }); } catch { /* 图是附加的，私聊文本已送达 */ }
            }
            // 群里只留一句"已私发"，不带任何凭据或链接
            if (kind === 'group') {
              await sendToQQ(key, `绑定相关的链接与确认码已私发给你（${privateKey.replace('private:', 'QQ ')}），请到私聊查看。\n不在这里发，是为了避免群里其他人点开链接把自己的账号绑到你名下。`);
            }
            log(`查分命令：${key} 管理员 ${cmd} ${parsed.args.sub} → 已私发 ${privateKey}`);
          } catch (error) {
            // 私聊失败（最常见：机器人还不是对方好友）——**绝不退回群发**，
            // 宁可让操作失败也不能把授权链接放进群里。
            await sendToQQ(key, `绑定链接私发失败：${error?.message ?? error}\n请确认你的 QQ 已添加机器人为好友，然后重新发起。\n（为安全起见，不会把链接发到群聊）`);
            log(`查分命令：${key} 私发失败：${error?.message ?? error}`);
          }
          return;
        }

        await sendReplyWithImage(key, reply, '查分命令');
        log(`查分命令：${key} 管理员 ${cmd} ${adminCommand.arg || '(status)'} → ${reply.text.split('\n')[0]}`);
        return;
```

## 依赖的既有函数

这段代码用到三个 qq-bridge 里已有的函数，**无需另外添加**：

| 函数 | 来源 | 说明 |
| --- | --- | --- |
| `sendSegmentsV2(key, segments, opts)` | 为查分出图而新增 | 会 `await` 结果并在失败时 reject；`delayMs: 0` 跳过真人化停顿 |
| `sendImageV2(key, filePath, opts)` | 同上 | 发本机图片（成绩图） |
| `sendToQQ(key, msg)` | 桥接原有 | ⚠️ **失败不抛错**，只记 `lastSendFailed`；所以不能靠它做私聊投递的成功判断 |

`<插件仓库>/docs/` 下另有一份 `qq-bridge-patch.md` 记录"为支持查分出图而给桥接加的两个函数"。

## 验证方式

打完后，管理员在**群里**发 `#查分 bind qq <自己的QQ>`：

- 群里应只出现一句"已私发给你…"，**不含链接**；
- 私聊里收到完整授权链接；
- 若机器人还不是管理员好友，群里应出现"私发失败"提示，**且仍然没有链接**。

把这条当作回归用例——**群里出现链接就是没打上**。
