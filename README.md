# dsh-plugin-qqbridge-plus（QQbridge plus）

> 本代码由 AI 生成。非常感谢 [Derpyu520](https://github.com/Derpyu520) 开发了
> [qq-bridge](https://github.com/Derpyu520/qq-bridge)，没有它这个插件没有任何意义。
> 它只是在 qq-bridge 旁边加的一个小配件。

[English](README.en.md) ｜ 中文

---

## 装它能得到什么

装好以后，你可以直接问 AI"机器人余额多少""现在什么状态"，不用再去翻日志。
管理员在 QQ 里发一句 `#功能 balance off` 就能关掉某项查询能力，改完立刻生效，
不用编辑文件也不用重启。

具体包括：

| 查询 | 内容 |
| --- | --- |
| 运行状态 | 当前模式、DSH 是否就绪、白名单、管理员、每个会话的未读和唤醒情况 |
| 余额 | 余额多少、数据多久前更新的、告警阈值、真要关机还有多久 |
| 推理档位 | 现在用的是哪一档。分时段功能会在计费高峰切到便宜档、空闲切回好档，省点钱 |
| 节假日表 | 表还够不够用；缺年份的时候可以顺手去国务院通知里抓一份来试算 |
| 开机 / 关机提示词 | 哪些人格配了、会发到哪里 |
| 管理命令 | `#余额` `#关机` `#功能` `#帮助` 的触发词和权限规则 |
| 桥接配置 | 配置内容，令牌已经打码 |

---

## 插件内部是怎么走的

计费峰谷、节假日解析、唤醒过滤、余额告警这些判定，插件里一个都没有重写，
全是直接 `import` qq-bridge 自己的纯模块。插件只负责取数、拼文本。

```
qqbridge-plus  ──import──▶  qq-bridge/src/wake-filters.mjs   （计费峰谷 / 节假日 / 唤醒过滤 / 余额决策）
               ──import──▶  qq-bridge/src/whale-balance.js    （余额账本读取）
               ──HTTP────▶  qq-bridge 控制台 127.0.0.1:3100   （运行态：模式、会话、生效档位）
               ◀──HTTP────  qq-bridge 转发来的 QQ 管理命令
```

这么做是因为 qq-bridge 才是 QQ 侧的权威：SnowLuma 连接、白名单、会话映射、计时器
都在它进程里。判定逻辑再写一份出来，两份迟早会对不上。开发时真撞上过一次：
余额读到 `NaN` 的时候，一边判成 `recovered`、另一边判成 `none`，
而这一步会直接决定要不要关机。功能键的清单同理，桥接那边不另存一份，
否则插件加了功能、桥接反而先把合法命令拒掉。

桥接没在跑的时候插件不会报错，工具会告诉你"控制台不可达"以及怎么排查。

---

## 怎么装

### 1. 前提

| 需要 | 说明 |
| --- | --- |
| Node.js ≥ 18 | DSH 与 qq-bridge 都要求它 |
| git | 用于克隆本仓库（手动安装可以不装，直接下 zip 也行） |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | 插件宿主。**必须先启动过一次**，否则 profile 目录还不存在 |
| [qq-bridge](https://github.com/Derpyu520/qq-bridge) | 本插件直接 `import` 它的纯模块并调它的端点，**必须先装好** |

> qq-bridge 的位置不用提前告诉安装器：它默认去插件目录的隔壁找 `qq-bridge`，
> 找不到时用 `--bridge-dir` 指定。

### 2. 安装

#### 方式 A：自动安装（推荐）

**先干跑看一眼它要改什么**（第一次建议这么做）：

```bat
node "%USERPROFILE%\dsh-plugins\qqbridge-plus\scripts\install.mjs" ^
     --dir "%USERPROFILE%\dsh-plugins\qqbridge-plus" --dry-run
```

确认没问题就去掉 `--dry-run`。完整流程（克隆 + 安装）：

**Windows（cmd 或 PowerShell）**

```bat
git clone https://github.com/xueyingneko/qqbridge-plus.git "%USERPROFILE%\dsh-plugins\qqbridge-plus"
node "%USERPROFILE%\dsh-plugins\qqbridge-plus\scripts\install.mjs" --dir "%USERPROFILE%\dsh-plugins\qqbridge-plus"
```

**Linux / macOS / Git Bash**

```bash
git clone https://github.com/xueyingneko/qqbridge-plus.git ~/dsh-plugins/qqbridge-plus
node ~/dsh-plugins/qqbridge-plus/scripts/install.mjs --dir ~/dsh-plugins/qqbridge-plus
```

**qq-bridge 不在隔壁**时：

```bat
node "...\scripts\install.mjs" --dir "...\qqbridge-plus" --bridge-dir "D:\path\to\qq-bridge"
```

**要装进 web profile 而不是 desktop**：加 `--profile web`。

**已经在仓库目录里**，也可以直接用包装脚本（它会自动认出当前目录）：

```bat
scripts\install.cmd --dry-run
```

安装器做的事，每一步都幂等，重复跑不会重复写入：

1. 克隆仓库，或对已有仓库执行 `git pull`；
2. 在插件目录装唯一的 npm 依赖 `@deepseek-ai/schemastery`；
3. 把包注册进 profile 的 `package.json`：`dependencies` 加 `link:` 项，`dsh.profile.bundles` 加包名；
4. 往 profile 的 `cordis.patch.yml` 追加插件 entry（已经存在就跳过）；
5. 让包管理器在 profile 里建好 `node_modules` 链接（优先 pnpm，以匹配 profile 自己的 lockfile）；
6. 检查 qq-bridge 是否就位，并打印后续步骤。

改 profile 文件之前会先备份成 `package.json.bak-<时间戳>`，写入用临时文件加 rename，
避免写一半被别的进程读到。

**卸载**：从 profile 的 `package.json` 里删掉 `dependencies` 与 `dsh.profile.bundles` 中的
`dsh-plugin-qqbridge-plus`，再删掉 `cordis.patch.yml` 里带
`# === dsh-plugin-qqbridge-plus (managed by install.mjs) ===` 标记的那条 entry，重启 DSH。

#### 方式 B：手动安装

要做精细控制（例如自己管软链接、或多 profile 同时装）就手动来。

**第一步，加入 profile**：把包加进 `~/.dsh/profiles/<profile>/package.json` 的
`dependencies`（用 `link:` 指向本仓库），同时加进 `dsh.profile.bundles`：

```json
{
  "dependencies": {
    "dsh-plugin-qqbridge-plus": "link:/abs/path/to/qqbridge-plus"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-plugin-qqbridge-plus"]
    }
  }
}
```

然后在 profile 目录跑一次 `pnpm install`（或 `npm install`）把链接建出来。

**第二步，在 profile 的 `cordis.patch.yml` 加一条 entry**：

```yaml
- id: qqbridge-plus
  name: dsh-plugin-qqbridge-plus
  config:
    bridgeDir: '/abs/path/to/qq-bridge'   # ← 改成你的 qq-bridge 路径
    consoleBase: 'http://127.0.0.1:3100'
    personaSection: true
    sectionOrder: 7
    features:
      status: true
      balance: true
      schedule: true
      holidays: true
      greeting: true
      commands: true
      config: true
```

`id` 必须写 `qqbridge-plus`（DSH 用 entry id 定位设置的命名空间），`name` 必须写包名。

第二步不能省。包内自带的 `cordis.patch.yml` 只描述"这个 bundle 有哪些行"，
真正让 loader 建出 entry 的是 profile 层的 patch。只做第一步的话，
插件管理器会报 `installed=true`、行配置也齐全，但工具根本不存在，而且没有任何报错。

**第三步，重启 DSH。**

### 3. 验证装上了

重启 DSH 之后，任选一种确认：

- 问 AI"机器人状态"，它应该能调到 `qqbridge` 工具；
- 或看桥接目录下的 `state/plugin-apply.json`，里面有本次装配的 `trace`：

  ```json
  { "trace": [ { "phase": "apply-called" }, { "phase": "tool-registered" },
               { "phase": "http-api-registered" }, { "phase": "apply-returned" } ] }
  ```

  只到 `apply-called` 就没了，说明装配中途失败；完全没有这个文件，说明插件没被加载。

### 4. 让 QQ 侧也能改开关（可选）

在 qq-bridge 的 `config.json` 里加：

```json
"featureCommand": {
  "triggers": ["#功能", "#开关"],
  "baseUrl": "http://127.0.0.1:19387"
},
"helpCommand": { "triggers": ["#帮助", "#help"] }
```

`baseUrl` 指向 DSH web，插件端点挂在它上面。改完重启 qq-bridge。

---

## 在 QQ 里使用（仅管理员）

```
#帮助                     列出全部管理命令（触发词按当前配置渲染）
#功能                     查看全部开关（标 * 的是在 QQ 里改过的）
#功能 balance off         关闭某个功能（也接受 关 / 禁用 / off / 0）
#功能 balance 开          开启（也接受 启用 / on / 1）
#功能 reset               清空运行时覆盖，回到配置文件的值
```

- 触发词可配（`featureCommand.triggers` / `helpCommand.triggers`）。
- 帮助文本里的触发词是从配置读出来拼的，所以改过触发词之后它也会跟着变，
  不会给你一份对不上号的说明。
- 只有管理员（qq-bridge 的 `ownerQQ`）能用；没配 `ownerQQ` 时这些命令对谁都不可用。

---

## AI 能调什么

一个工具 `qqbridge`，10 个 action：

| action | 作用 |
| --- | --- |
| `status` | 总览：模式 / 就绪 / 管理员 / 白名单 / 余额 / 档位 / 各会话 |
| `balance` | 余额、观测新鲜度、阈值、自动关机倒计时 |
| `schedule` | 计费峰谷与档位；`testAt=[时间戳…]` 可试算任意时刻 |
| `holidays` | 节假日表覆盖；`fetch=true` 现场抓取解析试算（不落盘） |
| `greeting` | 开机 / 关机提示词配置、目标、各人格卡覆盖 |
| `commands` | `#余额` `#关机` 触发词与权限口径 |
| `config` | 桥接配置摘要（令牌已脱敏）；`key="role.balanceAlarm"` 取子段 |
| `features` | 功能开关：查看，或用 `set`/`enabled` 修改，或 `reset` |
| `maimai` | 舞萌DX 查分（见下一节） |
| `firstRun` | 重看首次运行引导 |

---

## 舞萌DX 查分

接入[水鱼查分器](https://diving-fish.com)。这部分**与 qq-bridge 无关**——桥接没装好也能用。

```
qqbridge  action=maimai, sub=status                    这台机器上查分能不能用
qqbridge  action=maimai, sub=b50, username=某人        公开查询（对方需自行公开成绩）
qqbridge  action=maimai, sub=b50, qq=<QQ号>            查自己的（需先完成 OAuth 绑定）
qqbridge  action=maimai, sub=song, songId=11823        查某首歌的定数
qqbridge  action=maimai, sub=search, query=ztn         模糊搜曲（支持简写）
qqbridge  action=maimai, sub=bind, qq=<QQ号>           发起绑定，拿到授权链接
qqbridge  action=maimai, sub=confirm, qq=<QQ号>, code=<确认码>   用确认码收尾绑定
```

`sub=b50` 默认会**出一张成绩图**（1080 宽 PNG），写在系统临时目录下并把路径交给你；
不想要图就加 `image=false`。

### 为什么不支持"按 QQ 号随便查"

水鱼已经弃用开发者 token（`DIVINGFISH_TOKEN`）。原因是它**能按 QQ 号读取任意用户的成绩**，
而那些用户从未对机器人授权、也无法撤销——用它做出来的"查分"，本质是一个无需同意就能
窥探他人成绩的工具。所以本插件**只实现 OAuth**：

| 环节 | 做法 |
| --- | --- |
| 机器人持有的凭据 | 只有你自己申请的应用 `clientId` / `clientSecret` |
| QQ 号 | 只以 `sha256("<clientId>:<QQ号>")` 摘要外发，**号码本身不离开机器人** |
| 用户令牌 | 只在**内存**缓存（5 分钟，提前 30 秒失效），**不落盘** |
| 绑定 | 用户发 `bind` 拿到链接 → 本人点「同意授权」→ 把页面给的**一次性确认码**发回来 |
| 撤销 | 用户随时可在 https://auth.diving-fish.com/apps 撤销 |
| 未绑定用户 | 仍可用公开查询（按用户名） |

那个确认码不是多余的手续：绑定链接谁都能转发，而确认码只出现在**点同意那个人的浏览器**里。
少了它，别人可以拿你的 `clientId` 造一条链接发给受害者、骗对方授权从而绑上别人的账号。

### 配置

```yaml
maimai:
  clientId: '你的应用 ID'          # https://auth.diving-fish.com/apps 申请
  clientSecret: '你的应用密钥'
  proxy: false                     # 境外服务器可开
```

留空时插件不会静默失败，而是明确告诉你去申请（`sub=status` 会报告当前状态）。

### 成绩图需要额外装一个包

成绩图用 `@napi-rs/canvas`（N-API 预编译，**不需要**编译工具链）：

```bash
cd <插件目录> && npm install @napi-rs/canvas
```

没装也能用——查分、搜曲、开关全部照常，只是不出图，并且会告诉你装什么。
这是刻意的：**画图是附加价值，不该让主功能一起挂掉**。

### 关于曲绘

原项目的成绩图带歌曲封面，那是 **SEGA 的游戏素材**，不能打包进 MIT 仓库，所以卡片用
曲名推导出的稳定色条作视觉标识。曲库（1404 首）会缓存在 `qq-bridge/state/` 下 24 小时。

### 曲库搜索

搜索用子序列匹配，所以简写也能命中：`ztn` → `Zitronectar`。排序按匹配质量
（完全相等 > 前缀 > 包含 > 艺人 > 子序列），查询短于 3 个字符时不走子序列兜底，避免误报。

---

## 开关

每个功能一个布尔开关，`false` 表示关闭，支持 `'*'` 兜底，默认全开。

生效优先级：

```
QQ / 运行时覆盖文件  >  组合行配置  >  代码默认（全开）
```

也就是"在 QQ 里改过的"压过"配置里写的"。覆盖写在 `qq-bridge/state/plugin-features.json`，
用临时文件加 rename 的方式原子写入，避免另一个进程读到半个 JSON；DSH 重启后仍然保留，
`#功能 reset` 可以清空。状态文件损坏时按"没有覆盖"处理并记录原因，不会让插件起不来。

### 关闭之后的表现

- action 仍然留在枚举里，调用时返回一句明确的话，而不是把 action 删掉让人猜：

  ```
  ⛔ 功能「余额与自动关机」已在插件配置里关闭。
  当前开启的功能：status（总览）、schedule（计费峰谷与推理档位）…
  ```

  不从枚举里删掉的原因：工具 schema 在 `defineTool()` 时就序列化好了，之后无法随配置增删。
  与其造成"配置改了但枚举没变"的假象，不如让关闭状态看得出来。

- `status` 里对应的段落会写明原因：`⛔ 已关闭（features.balance=false）`。
- 系统提示词按开关生成，已关闭的功能不会出现在里面，免得模型白白尝试。
- 开关名拼错会告警，并写进 `plugin-apply.json` 的 trace。这类开关最容易出的问题就是
  把 `schedule` 写成 `scheduler`，看起来"设了却没生效"。

---

## 三条硬规则

都是开发时踩出来的，改代码前建议先读一遍。

### 1. `inject` 里要列出所有会被访问的服务

Cordis 规定访问未在 `inject` 中声明的服务属性会直接抛错：

```
Error: cannot get property "systemPrompt" without inject
```

最初只声明了 `tools`，想用 `if (ctx.systemPrompt)` 做可选依赖兜底，
结果读取属性这一步就抛错了，兜底代码根本执行不到。而这类错误在插件管理器里
只表现为 `[failed]` 或 "did not activate"，不显示原因。

### 2. 不要导出 `Config`，除非它是真正的 schemastery schema

loader 看到 `Config` 导出会拿它做校验，并且期望它来自 `@deepseek-ai/schemastery`。
给一个普通对象会在 apply 之前就失败（现象是 entry 建出来了、apply 一行没跑）。
而 schemastery 是裸包名依赖，插件目录如果没自己的 `node_modules` 就解析不到，
整个模块会在导入期加载失败。

还有一条实测出来的边界：`volatile` 字段会让 loader 把配置求值成 `{}`。
DSH 设置页要可写就要求字段带 `volatile`，但实测（原始证据留在 `lib/last-apply-config.json`）
loader 求值后所有带 volatile 的字段都变成了 `{}`，于是 `sectionOrder` 不再是数字，
`order must be a finite number` 直接让插件不出现；就算绕过这一点，
在设置页点"保存"也会把配置写坏。所以本插件的设置面板做成只读，
改开关交给 QQ 命令和配置文件。测试里有一条断言守着这件事。

### 3. `defineTool` 要用模块顶层的静态导入

`lib/index.js` 里用的是写死绝对路径的静态导入，和官方插件同一种做法。
最初为了"稳妥"改成运行时动态 `import()` 加 7 条回退路径，结果出现了最难查的一种失败：
某条路径报了 import 成功，但链上的 `.then` 永远不执行——不报错也不进 catch——
工具就这么一直没注册上。

纯 node 子进程读不到 `app.asar` 内部，所以这个模块没法在普通 node 里导入。
这是 Electron 的 asar 特性，不是缺陷；测试请用 `test/` 下不导入该文件的用例。

**排查用的自检**：装配过程会写 `qq-bridge/state/plugin-apply.json`，里面的 `trace` 数组
记录了走到哪一步。宿主 console 在 GUI 里看不到，loader 启动失败又不给原因，
这个文件是唯一不用猜的判据。

---

## 版本配套

插件和 qq-bridge 属于跨仓库依赖。qq-bridge 启动时会报出两边的版本：

```
[bridge] 版本：qq-bridge 0.2.0
[bridge]       插件：dsh-plugin-qqbridge-plus 1.0.0
```

两边都只以各自 `package.json` 的 `version` 为准，不另外维护一份。
这条也是踩出来的：曾在一个模块里硬写了版本常量，和 `package.json` 对不上，
等于没有可信的版本号。

---

## 测试

```bash
npm test                                             # 插件侧全部 7 套：190 项
npm run test:maimai                                   # 只跑舞萌查分的 4 套：99 项
node ../qq-bridge/scripts/test-feature-command.mjs   # 桥接侧纯函数：28 项
node ../qq-bridge/scripts/e2e-feature-command.mjs    # 端到端：10 项（需两端都在运行）
```

CI 只跑不依赖 qq-bridge 的那几套，需要桥接在跑的两套留在本地跑——
写一个必然失败的 CI 不如没有 CI。

舞萌查分的测试用**依赖注入**拦住了网络，所以不需要任何凭据就能跑；
成绩图那套还会在"没装画图库"时自动改测降级路径（7 项），装了就测完整路径（21 项）。

几条关键的安全与正确性断言：

| 断言 | 为什么重要 |
| --- | --- |
| `config` 摘要不得含未脱敏的 `accessToken` | 模型上下文会长期保存 |
| 拼错的开关键不得关掉任何功能 | "设了没生效"最难查 |
| 任何字段都不得带 `volatile` | 会让 loader 把配置求值成 `{}`，保存即损坏 |
| 端点无令牌时必须拒绝或不注册 | 它能放宽整个工具面 |
| `#功能xyz` 不得被当成命令 | 误判会吞掉普通发言，表现为"机器人忽然不理人" |
| 源码里不得出现 `developer-token` | 它能按 QQ 号读任意人成绩，用户无法撤销 |
| 绑定请求必须带 `handoff=code`，且请求体不含明文 QQ 号 | 少了确认码就能被转发链接骗授权 |
| 展示打码、`client_secret` 不得出现在任何输出里 | 输出会进模型上下文与 QQ 聊天记录 |
| 出图路由必须挡掉 `../` 与非 `.png` | 否则变成任意文件读取 |
| 出图失败不得让查分本身失败 | 图是附加价值 |

---

## 许可

[MIT](LICENSE)。第三方组件与合规边界（含 SnowLuma 许可说明、数据出机清单）见 LICENSE 后半部分。
