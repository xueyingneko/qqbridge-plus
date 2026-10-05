# dsh-plugin-qqbridge-plus（QQbridge plus）

把 [qq-bridge](https://github.com/Derpyu520/qq-bridge) 的运维能力搬进 **DeepSeek Harness 原生工具面**的伴随型插件。

[English](README.en.md) ｜ 中文

---

## 这是什么

给 DSH 里的 AI 装上一双"看得见 QQ 机器人"的眼睛，并让管理员能直接在 QQ 里改机器人设置。

装上之后，你可以对 AI 说"查一下机器人余额""机器人现在什么状态"，也可以由管理员在 QQ 里发
`#功能 balance off` 直接关掉某个能力——**立即生效，不用改文件、不用重启**。

| 能力 | 说明 |
| --- | --- |
| **运行态一眼看全** | 模式、DSH 就绪、白名单、管理员、各会话未读与唤醒状态 |
| **余额与自动关机** | 余额、观测新鲜度、告警阈值、关机倒计时 |
| **推理档位省钱** | 按 DeepSeek 计费峰谷显示当前档位；可试算任意时刻属于高峰还是空闲 |
| **节假日表体检** | 覆盖检查；缺年份时可现场抓取国务院通知做**试算** |
| **开机/关机提示词** | 配置、发送目标、各人格卡覆盖情况 |
| **管理命令现状** | `#余额` / `#关机` / `#功能` / `#帮助` 的触发词与权限口径 |
| **配置摘要** | 桥接配置，**令牌已脱敏** |
| **功能开关（可查可改）** | 每个功能一个开关，QQ 里就能改 |

---

## 一句话定位

**它不重新实现任何判定逻辑。** 计费峰谷、节假日解析、唤醒过滤、余额告警的判定，
全部直接 `import` qq-bridge 自己的纯模块。插件只负责取数、编排、排版。

```
qqbridge-plus  ──import──▶  qq-bridge/src/wake-filters.mjs   （计费峰谷/节假日/唤醒过滤/余额决策）
               ──import──▶  qq-bridge/src/whale-balance.js    （余额账本读取）
               ──HTTP────▶  qq-bridge 控制台 127.0.0.1:3100   （运行态：模式、会话、生效档位）
               ◀──HTTP────  qq-bridge 转发来的 QQ 管理命令
```

桥接没在跑时，插件**优雅降级**：工具返回"控制台不可达 + 排查步骤"，而不是抛错。

---

## 为什么是"伴随型"而不是把功能搬进插件

qq-bridge 是 QQ 侧的**运行时权威**：SnowLuma 连接、白名单、会话映射、计时器都在它手里。
把判定逻辑复制进插件，会立刻产生"两份实现"，而它们必然漂移。

这不是理论担忧——**真实踩过一次**：余额为 `NaN` 时，一份实现判成 `recovered`、
另一份判成 `none`，而这是**不可逆的关机决策**。

所以本项目的依赖方向是单向的，且**合法功能键的单一来源也是桥接/插件各自一处**：
桥接的命令解析器刻意不抄一份功能键名（抄了就会漂移，插件加了功能而桥接先一步拒掉）。

---

## 快速开始

### 1. 前提

- 已装好 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)；
- 已装好并能运行 [qq-bridge](https://github.com/Derpyu520/qq-bridge)（本插件读它的模块与端点）。

### 2. 安装（必须两步，缺一不可）

**① 加入 profile**：把包加进 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies`
（用 `link:` 指向本仓库）与 `bundles` 数组。

**② 在 profile 的 `cordis.patch.yml` 加一条 entry**：

```yaml
- id: qqbridge-plus
  name: dsh-plugin-qqbridge-plus
  config:
    bridgeDir: 'F:/router/qq-bridge'      # ← 改成你的 qq-bridge 路径
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

> ⚠️ **第 ② 步不能省。** 包内自带的 `cordis.patch.yml` 只描述"这个 bundle 有什么行"，
> 真正让 loader 建出 entry 的是 **profile 层**的 patch。只做第 ① 步的现象是：
> 插件管理器报 `installed=true`、行配置齐全，但工具**根本不存在**，且没有任何报错。

**③ 重启 DSH。**

### 3. 让 QQ 侧也能改开关（可选）

在 qq-bridge 的 `config.json` 里加：

```json
"featureCommand": {
  "triggers": ["#功能", "#开关"],
  "baseUrl": "http://127.0.0.1:19387"
},
"helpCommand": { "triggers": ["#帮助", "#help"] }
```

`baseUrl` 指向 DSH web（插件端点挂在它上面）。然后重启 qq-bridge。

---

## 在 QQ 里使用（管理员）

```
#帮助                     列出全部管理命令（触发词按当前配置渲染）
#功能                     查看全部开关（标 * 的是 QQ 改过的值）
#功能 balance off         关闭某个功能（也接受 关/禁用/off/0）
#功能 balance 开          开启（也接受 启用/on/1）
#功能 reset               清空运行时覆盖，回到配置文件的值
```

- 触发词可配（`featureCommand.triggers` / `helpCommand.triggers`）。
- **帮助文本里的触发词是从配置读出来拼的**——你改过触发词后它也会跟着变，
  不会给你一份对不上号的说明。
- 只有管理员（qq-bridge 的 `ownerQQ`）可用；未配置 `ownerQQ` 时这两条命令对谁都不可用（fail-closed）。

---

## 工具面（给 AI 用）

一个工具 `qqbridge` + 9 个 action：

| action | 作用 |
| --- | --- |
| `status` | 总览：模式 / 就绪 / 管理员 / 白名单 / 余额 / 档位 / 各会话 |
| `balance` | 余额、观测新鲜度、阈值、自动关机倒计时 |
| `schedule` | 计费峰谷与档位；`testAt=[时间戳…]` 可试算任意时刻 |
| `holidays` | 节假日表覆盖；`fetch=true` 现场抓取解析**试算**（不落盘） |
| `greeting` | 开机/关机提示词配置、目标、各人格卡覆盖 |
| `commands` | `#余额` / `#关机` 触发词与权限口径 |
| `config` | 桥接配置摘要（**令牌已脱敏**）；`key="role.balanceAlarm"` 取子段 |
| `features` | 功能开关：查看，或 `set`/`enabled` 修改，或 `reset` |
| `firstRun` | 重看首次运行引导（开关怎么改） |

---

## 功能开关

每个功能一个布尔开关，`false` = 关闭；支持 `'*'` 兜底。默认**全开**。

生效优先级：

```
QQ/运行时覆盖文件  >  组合行配置  >  代码默认（全开）
```

"管理员在 QQ 里改过的"压过"配置里写的"，符合直觉。覆盖落在
`qq-bridge/state/plugin-features.json`（**原子写**：临时文件 + rename，
避免另一进程读到半个 JSON），DSH 重启后依然保留；`#功能 reset` 可一键清空。
状态文件损坏时**回退到"无覆盖"并记录原因**，绝不因状态文件坏掉而让插件起不来。

### 关闭后的行为（刻意如此）

- **action 仍留在枚举里**，调用时返回明确答复，而不是把 action 删掉让调用方猜：

  ```
  ⛔ 功能「余额与自动关机」已在插件配置里关闭。
  当前开启的功能：status（总览）、schedule（计费峰谷与推理档位）…
  ```

  为什么不做"从 enum 里删掉"：工具 schema 在 `defineTool()` 时就序列化好了，
  之后无法随配置增删。与其造成"配置改了但 enum 没变"的假象，不如让关闭状态**可发现**。

- **`status` 的子段落会标注原因**：`⛔ 已关闭（features.balance=false）`。
- **提示词按开关动态生成**：已关闭的功能不会出现在系统提示词里，避免浪费模型尝试。
- **拼错的开关名会告警**，并写进 `plugin-apply.json` 的 trace。这是这类开关最常见的坑——
  把 `schedule` 写成 `scheduler`，开关看起来"设了却没生效"。

---

## ⚠️ 三条硬规则（都是踩出来的，改代码前务必先读）

### 1. `inject` 必须列出**所有会被访问**的服务

Cordis 的硬规则：访问未在 `inject` 中声明的服务属性会**直接抛错**：

```
Error: cannot get property "systemPrompt" without inject
```

我最初只声明 `tools`，想用 `if (ctx.systemPrompt)` 做"可选依赖"兜底——**读取属性本身
就抛错**，兜底代码根本执行不到。而这类错误在插件管理器里只表现为 `[failed]` /
"did not activate"，不显示原因。

### 2. 不要导出 `Config`，除非它是真正的 schemastery schema

loader 若看到 `Config` 导出会拿它做校验，且期望它来自 `@deepseek-ai/schemastery`。
给普通对象会在 **apply 之前**就失败（现象：entry 建出来、apply 一行没跑）。
而 schemastery 是裸包名依赖，插件目录没有自己的 `node_modules` ⇒ 解析不到 ⇒
**导入期**整模块加载失败。

> **另一条实测边界：`volatile` 字段会让 loader 把配置求值成 `{}`。**
> DSH 设置页要可写就要求字段带 `volatile`，但实测（`lib/last-apply-config.json` 里留了原始证据）：
> loader 求值后**所有带 volatile 的字段都变成 `{}`**，于是 `sectionOrder` 不是数字 ⇒
> `order must be a finite number` ⇒ 插件完全不出现；就算绕过，点"保存"也会把配置写坏。
> **一个能把配置写坏的 UI，比没有可写 UI 更糟**——所以本插件的设置页面板**刻意只读**，
> 并把"怎么改开关"交给了 QQ 命令与配置文件。测试里有一条断言守着这条线。

### 3. `defineTool` 必须**模块顶层静态导入**

`lib/index.js` 里是写死的绝对路径静态导入（与官方插件同款做法）。
最初用运行时动态 `import()` + 7 条回退路径"更稳妥"，结果出现最难查的失败——
某条途径报了 import 成功，但链上的 `.then` **永不执行**（不报错、不进 catch），
工具永远不注册。

> 纯 node 子进程读不到 `app.asar` 内部，所以本模块无法在普通 node 里被导入。
> 这是 Electron 的 asar 特性，不是缺陷；测试请用 `test/` 下不导入本文件的用例。

**排查用自检**：装配过程会写 `qq-bridge/state/plugin-apply.json`（`trace` 数组）。
宿主 console 在 GUI 下看不到，loader 的启动失败又不给原因——这个文件是唯一不用猜的判据。

---

## 版本配套

插件与 qq-bridge 是跨仓库硬依赖。qq-bridge 启动时会报出**两边版本**：

```
[bridge] 版本：qq-bridge 0.2.0
[bridge]       插件：dsh-plugin-qqbridge-plus 1.0.0
```

两边版本都**以各自 `package.json` 的 `version` 为唯一来源**，不维护第二份。
（这条也是踩出来的：曾在一个模块里硬写版本常量，与 `package.json` 矛盾 ⇒ 等于没有可信版本号。）

---

## 测试

```bash
npm test                    # 插件侧：52 + 21 项
node ../qq-bridge/scripts/test-feature-command.mjs   # 桥接侧纯函数：28 项
node ../qq-bridge/scripts/e2e-feature-command.mjs    # 端到端：10 项（需两端都在运行）
```

几条关键的安全/正确性断言：

| 断言 | 为什么重要 |
| --- | --- |
| `config` 摘要不得含未脱敏 `accessToken` | 模型上下文会长期保存 |
| 拼错的开关键不得关掉任何功能 | "设了没生效"最难查 |
| **任何字段都不得带 `volatile`** | 会让 loader 把配置求值成 `{}`，保存即损坏 |
| **端点无令牌时必须拒绝/不注册** | 它能放宽整个工具面 |
| **`#功能xyz` 不得被当成命令** | 误判会吞掉普通发言（表现为"机器人忽然不理人"） |

---

## 许可

[MIT](LICENSE)。第三方组件与合规边界（含 SnowLuma 许可说明、数据出机清单）见 LICENSE 后半部分。
