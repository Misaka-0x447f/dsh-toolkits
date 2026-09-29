# dsh-toolkits

Misaka 的个人 DSH（DeepSeek Harness）插件集合。每个插件是 `packages/` 下的一个独立 npm 包，可以单独挂到任意 DSH profile。

## 插件

| 包 | 形态 | 说明 |
| --- | --- | --- |
| [`dsh-peak-timer`](packages/dsh-peak-timer) | host 注入（注入前端 widget JS） | Web 侧边栏峰谷定价倒计时小字块，跟踪 OpenRouter 实时定价 |

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
- 目前各包都是纯 JS、零运行时依赖、无构建步骤。等到引入需要预构建 `lib/client.js` 的 client 插件时，再在根级加构建链（pnpm workspace + tsdown）。
