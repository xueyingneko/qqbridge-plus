/**
 * 舞萌查分的常量（**零依赖**）。
 *
 * 为什么单独一个文件：这些值要被 `config-schema.js`（插件配置）与 `divingfish.js`
 * （客户端）同时引用。如果让 config-schema 去 import divingfish，就把客户端模块
 * 挂进了插件入口的依赖链——一旦它加载失败，整个插件都不出现（见 README 硬规则 2
 * 里那类"导入期失败"）。这个模块只导出字面量，没有 import，所以挂上它是安全的。
 *
 * @module dsh-plugin-qqbridge-plus/maimai/constants
 */

/** 水鱼资源服务器（查成绩）。 */
export const DF_BASE_URL = 'https://maimai.diving-fish.com/api/maimaidxprober';

/** 水鱼账号服务（OAuth 授权与换票）。 */
export const DF_AUTH_URL = 'https://auth.diving-fish.com';

/** 境外服务器用的中转基址。 */
export const DF_PROXY_URL = 'https://proxy.yuzuchan.site';

/**
 * 需要的 OAuth 权限范围（空格分隔）。
 *
 * 这三项必须与**应用实际获批的权限**一致，否则换票时请求的 scope 与实际授权对不上。
 * 逐项对应的端点：
 *   profile              → 账号基本信息
 *   prober.profile.read  → /query/player（Rating、姓名框等汇总资料）
 *   prober.records.read  → /player/records（B50 的逐条成绩记录）
 *
 * ⚠️ **不要加任何 write 权限**。本插件没有任何写入路径，多申请只会让授权页多出
 * 一条用户不该被要求同意的权利；而且含 write 的申请会被转人工审核。测试里有断言守着。
 */
export const DEFAULT_SCOPE = 'profile prober.profile.read prober.records.read';
