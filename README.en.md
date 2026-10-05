# dsh-plugin-qqbridge-plus (QQbridge plus)

A companion plugin that brings [qq-bridge](https://github.com/Derpyu520/qq-bridge)'s operational
capabilities into the **native DeepSeek Harness tool surface**.

English ｜ [中文](README.md)

---

## What it is

It gives the AI inside DSH eyes on your QQ bot, and lets the admin change bot settings
**straight from QQ**.

Once installed you can ask the AI "what's the bot's balance?" or "what state is it in?", and the
admin can send `#功能 balance off` in QQ to disable a capability — **effective immediately, no file
editing, no restart**.

| Capability | Description |
| --- | --- |
| **Runtime at a glance** | mode, DSH readiness, allowlist, owner, per-conversation unread & wake state |
| **Balance & auto-shutdown** | balance, observation freshness, alert threshold, shutdown countdown |
| **Reasoning-tier cost saving** | current tier per DeepSeek billing peak/off-peak; test any timestamp |
| **Holiday table health** | coverage check; on-demand fetch of the official notice for a dry run |
| **Startup/shutdown greetings** | configuration, targets, per-persona coverage |
| **Admin command status** | triggers and permission rules for `#余额` / `#关机` / `#功能` / `#帮助` |
| **Config summary** | bridge config, **tokens redacted** |
| **Feature toggles (read + write)** | one switch per feature, changeable from QQ |

---

## The one-line positioning

**It re-implements no decision logic.** Billing peak/off-peak, holiday parsing, wake filtering and
balance-alert decisions are all `import`ed directly from qq-bridge's own pure modules. The plugin
only fetches, orchestrates and formats.

```
qqbridge-plus  ──import──▶  qq-bridge/src/wake-filters.mjs   (billing/holidays/wake/balance)
               ──import──▶  qq-bridge/src/whale-balance.js    (balance ledger)
               ──HTTP────▶  qq-bridge console 127.0.0.1:3100  (runtime: mode, sessions, tier)
               ◀──HTTP────  QQ admin commands forwarded by qq-bridge
```

When the bridge is not running the plugin **degrades gracefully**: the tool reports
"console unreachable" plus troubleshooting steps instead of throwing.

---

## Why "companion" instead of moving features into the plugin

qq-bridge is the **runtime authority** on the QQ side: the SnowLuma connection, allowlists, session
mapping and timers all live there. Copying decision logic into the plugin would immediately create
"two implementations", and they inevitably drift.

This is not a theoretical concern — **it actually happened**: with a `NaN` balance, one
implementation judged `recovered` and the other `none`, and that was an **irreversible shutdown
decision**.

So the dependency direction is one-way, and **single-source-of-truth is enforced**: the bridge's
command parser deliberately does **not** keep its own copy of the feature key list (a copy would
drift, and the bridge would start rejecting valid commands after the plugin adds a feature).

---

## Quick start

### 1. Prerequisites

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) installed;
- [qq-bridge](https://github.com/Derpyu520/qq-bridge) installed and runnable (the plugin reads its
  modules and endpoints).

### 2. Install (both steps required)

**① Register in the profile**: add the package to `~/.dsh/profiles/<profile>/package.json` under
`dependencies` (with `link:` pointing at this repo) and to the `bundles` array.

**② Add an entry to the profile's `cordis.patch.yml`**:

```yaml
- id: qqbridge-plus
  name: dsh-plugin-qqbridge-plus
  config:
    bridgeDir: 'F:/router/qq-bridge'      # ← point at your qq-bridge checkout
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

> ⚠️ **Step ② is not optional.** A bundle's own `cordis.patch.yml` only *describes* the rows it
> carries; it is the **profile-level** patch that makes the loader create the entry. With only
> step ①, the plugin manager reports `installed=true` and lists the row, yet the tool **does not
> exist** — with no error at all.

**③ Restart DSH.**

### 3. Enable QQ-side toggling (optional)

In qq-bridge's `config.json`:

```json
"featureCommand": {
  "triggers": ["#功能", "#开关"],
  "baseUrl": "http://127.0.0.1:19387"
},
"helpCommand": { "triggers": ["#帮助", "#help"] }
```

`baseUrl` points at the DSH web server (the plugin endpoint is mounted on it). Then restart
qq-bridge.

---

## Usage in QQ (admin only)

```
#帮助                     list all admin commands (triggers rendered from current config)
#功能                     show all toggles (values set from QQ are marked *)
#功能 balance off         disable a feature (also 关/禁用/off/0)
#功能 balance 开          enable (also 启用/on/1)
#功能 reset               clear runtime overrides, back to the config file values
```

- Triggers are configurable (`featureCommand.triggers` / `helpCommand.triggers`).
- **The help text is assembled from the configured triggers** — change a trigger and the help
  follows, so it can never contradict your setup.
- Admin only (qq-bridge's `ownerQQ`); with no `ownerQQ` configured these commands are unusable for
  everyone (fail-closed).

---

## Tool surface (for the AI)

One tool `qqbridge` with 9 actions:

| action | Purpose |
| --- | --- |
| `status` | Overview: mode / readiness / owner / allowlist / balance / tier / sessions |
| `balance` | Balance, observation freshness, thresholds, auto-shutdown countdown |
| `schedule` | Billing peak/off-peak and tier; `testAt=[ts…]` evaluates any moment |
| `holidays` | Holiday table coverage; `fetch=true` performs a live dry-run parse |
| `greeting` | Startup/shutdown greeting config, targets, per-persona coverage |
| `commands` | `#余额` / `#关机` triggers and permission rules |
| `config` | Bridge config summary (**tokens redacted**); `key="role.balanceAlarm"` for a subtree |
| `features` | Feature toggles: view, or `set`/`enabled`, or `reset` |
| `firstRun` | Re-read the first-run guidance |

---

## Feature toggles

One boolean per feature, `false` = off, with `'*'` as a fallback. All on by default.

Precedence:

```
QQ / runtime override file  >  composition config  >  code default (all on)
```

"What the admin changed in QQ" beats "what's written in the config", which matches intuition.
Overrides live in `qq-bridge/state/plugin-features.json` (**atomic write**: temp file + rename, so
another process can never read half a JSON), survive a DSH restart, and `#功能 reset` clears them.
A corrupt state file **falls back to "no overrides" and records why** — it never prevents the
plugin from starting.

### Deliberate behaviour when a feature is off

- **The action stays in the enum** and answers clearly instead of being removed:

  ```
  ⛔ 功能「余额与自动关机」已在插件配置里关闭。
  当前开启的功能：status（总览）、schedule（计费峰谷与推理档位）…
  ```

  Why not remove it from the enum: the tool schema is serialized at `defineTool()` time and cannot
  be added to or removed from later. Rather than fake "config changed but the enum didn't", the
  off state is made **discoverable**.

- **`status` annotates the reason** instead of silently leaving a gap:
  `⛔ 已关闭（features.balance=false）`.
- **The system prompt is generated from the toggles**, so disabled features are not advertised.
- **Misspelled toggle names are reported**, and recorded in `plugin-apply.json`'s trace — the most
  common trap with this kind of switch (`scheduler` instead of `schedule` looks like "set but not
  working").

---

## ⚠️ Three hard rules (all learned the hard way)

### 1. `inject` must list **every service you will touch**

Cordis hard rule: accessing a service not declared in `inject` **throws**:

```
Error: cannot get property "systemPrompt" without inject
```

I initially declared only `tools` and tried `if (ctx.systemPrompt)` as an "optional dependency"
fallback — but **reading the property itself throws**, so the fallback never runs. And in the
plugin manager this only shows up as `[failed]` / "did not activate", with no reason given.

### 2. Do not export `Config` unless it is a real schemastery schema

If the loader sees a `Config` export it validates against it, expecting `@deepseek-ai/schemastery`.
A plain object fails **before `apply`** (the entry is created, `apply` never runs). And schemastery
is a bare specifier the plugin directory may not resolve ⇒ the whole module fails at **import** time.

> **Another measured boundary: `volatile` fields make the loader evaluate config into `{}`.**
> A writable DSH settings panel requires `volatile`, but testing showed (raw evidence preserved in
> `lib/last-apply-config.json`) that after evaluation **every volatile field becomes `{}`** — so
> `sectionOrder` is no longer a number ⇒ `order must be a finite number` ⇒ the plugin never appears.
> Even bypassing that, hitting "Save" would corrupt the config.
> **A UI that can corrupt your config is worse than no writable UI** — so this plugin's settings
> panel is **intentionally read-only**, and changing switches is done via QQ commands or the config
> file. A test asserts this stays true.

### 3. `defineTool` must be a **top-level static import**

`lib/index.js` uses a static import of the absolute path (the same approach official plugins take).
I first used a runtime dynamic `import()` with 7 fallback paths as the "safer" option, and hit the
hardest failure of all: one path reported import success, yet the `.then()` on the chain **never
ran** (no throw, no catch) and the tool was never registered.

> A plain node subprocess cannot read inside `app.asar`, so this module cannot be imported by plain
> node. That is an Electron asar property, not a defect; use the tests under `test/`, which do not
> import that file.

**Self-check for troubleshooting**: assembly writes `qq-bridge/state/plugin-apply.json` (a `trace`
array). The host console is invisible in the GUI and loader startup failures give no reason — this
file is the only judge that requires no guessing.

---

## Version pairing

The plugin and qq-bridge are a cross-repo hard dependency. qq-bridge reports **both versions** at
startup:

```
[bridge] 版本：qq-bridge 0.2.0
[bridge]       插件：dsh-plugin-qqbridge-plus 1.0.0
```

Both sides take their version **solely from their own `package.json` `version`** — no second copy.
(Also learned the hard way: a hard-coded version constant once contradicted `package.json`, which
amounts to having no trustworthy version at all.)

---

## Tests

```bash
npm test                                             # plugin side: 52 + 21
node ../qq-bridge/scripts/test-feature-command.mjs   # bridge pure functions: 28
node ../qq-bridge/scripts/e2e-feature-command.mjs    # end-to-end: 10 (both sides running)
```

Key safety/correctness assertions:

| Assertion | Why it matters |
| --- | --- |
| `config` summary must not contain an unredacted `accessToken` | model context is retained long-term |
| A misspelled toggle must not disable any feature | "set but not working" is the hardest to diagnose |
| **No field may carry `volatile`** | it makes the loader evaluate config into `{}`, corrupting it on save |
| **The endpoint must reject / not register without a token** | it can widen the entire tool surface |
| **`#功能xyz` must not be treated as a command** | a false positive swallows ordinary chat |

---

## License

[MIT](LICENSE). Third-party components and compliance boundaries (including the SnowLuma license
discussion and the data-egress list) are in the second half of LICENSE.
