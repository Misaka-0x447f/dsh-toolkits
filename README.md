# dsh-toolkits

Misaka 的个人 DSH（DeepSeek Harness）插件集合。每个插件是 `packages/` 下的一个独立 npm 包，可以单独挂到任意 DSH profile。

## 插件

| 包 | 形态 | 说明 |
| --- | --- | --- |
| [`dsh-peak-timer`](packages/dsh-peak-timer) | host 注入（注入前端 widget JS） | Web 侧边栏峰谷定价倒计时小字块，跟踪 OpenRouter 实时定价 |
| [`dsh-turn-metrics`](packages/dsh-turn-metrics) | 客户端插件（占用 `conversation.input.dock`） | composer 上方的运行状态行：本轮工具调用计数 + 本轮已用时，并隐藏自带的「深度求索中…」 |
| [`dsh-cloudflare-tunnel-gateway`](packages/dsh-cloudflare-tunnel-gateway) | host 插件 | 为 DSH Web 指定固定 launch token，供既有 Cloudflare Tunnel 使用（仅当 webServer 绑定 127.0.0.1 时生效） |

## 挂载到 DSH profile

在 profile（例如 `~/.dsh/profiles/web`）的 `package.json` 里用 `link:` 指向包目录，并把**包名**加进 `dsh.profile.bundles`：

```json
{
  "dependencies": {
    "dsh-peak-timer": "link:/home/misaka/git/dsh-toolkits/packages/dsh-peak-timer"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-peak-timer"]
    }
  }
}
```

> `link:` 的路径按本机实际位置替换。改完插件代码**不必** push / `pnpm update`，但 host 端插件在 DSH 启动时装配，需要重启 DSH host 并刷新浏览器。

## 仓库约定

- 包名 = 目录名，统一 `dsh-` 前缀。
- 每个包自包含：`package.json`（带 `dsh.bundle.patch`）、`lib/`、`cordis.patch.yml`、自己的 `README.md`。
- **若 host 半要 `import` 运行时包**（如 `@deepseek-ai/schemastery`），包目录内需要一条指向共享依赖树的软链：
  `ln -sfn ~/.dsh/profiles/node_modules packages/<name>/node_modules`。
  因为 `link:` 走 realpath，Node 会把包当成位于 `packages/` 下，不建就 `ERR_MODULE_NOT_FOUND`（当前 `dsh-cloudflare-tunnel-gateway` 需要；只依赖 node 内置模块的包不需要）。软链被 gitignore，重新 clone 后要重建。
- 目前各包都是纯 JS、无构建步骤。`dsh-turn-metrics` 的 `lib/client.js` 是手写 loader bundle（`window.__ModuleLoader__.load`），改浏览器半不需要重启 host（`dsh-client-hmr` 会推送）；host 半改动才需要重启。
