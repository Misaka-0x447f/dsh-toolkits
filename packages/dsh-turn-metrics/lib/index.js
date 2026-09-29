/**
 * dsh-turn-metrics —— 纯 UI 插件的 host 半。
 *
 * 本身不做任何 host 侧的事：这个空的 apply 只是为了让包出现在 host 的装配树里，
 * 从而被 dsh-client-modules 扫描到 package.json 的 `dsh.client` 声明，
 * 把 lib/client.js 投递给浏览器。同 @deepseek-ai/dsh-client-ui-goal。
 */
export function apply() {}
