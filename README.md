# dsh-toolkits

Misaka 的个人 DSH（DeepSeek Harness）插件集合。每个插件是 `packages/` 下的一个独立 npm 包，可以单独挂到任意 DSH profile。

## 插件

| 包 | 形态 | 说明 |
| --- | --- | --- |
| [`dsh-peak-timer`](packages/dsh-peak-timer) | host 注入（注入前端 widget JS） | Web 侧边栏峰谷定价倒计时小字块，跟踪 OpenRouter 实时定价 |
| [`dsh-turn-metrics`](packages/dsh-turn-metrics) | 客户端插件（占用 `conversation.input.dock`） | composer 上方的运行状态行：本轮工具调用计数 + 本轮已用时，并隐藏自带的「深度求索中…」 |
| [`dsh-session-id-copy`](packages/dsh-session-id-copy) | 客户端插件（DOM 注入，无 slot 可用） | 会话列表每行的「选项」菜单里追加「复制会话 ID」，点了把该会话的 SessionId 写进剪贴板 |
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

## 用户脚本（Tampermonkey）

不是 DSH 插件，放 `userscripts/`，装到浏览器即可。

| 脚本 | 说明 |
| --- | --- |
| [`openrouter-mod.user.js`](userscripts/openrouter-mod.user.js) | OpenRouter 增强：模型页 Providers 表格加一列「回测价格」（点表头可排序），并在「Providers」标题旁加一个「TPS」过滤器开关；充值页的 Purchase Credits 弹窗在服务费金额左边显示它占充值额的百分比 |

计费口径写在脚本顶部的 `CONFIG` 里，改完保存刷新页面即生效：

```js
const CONFIG = {
  inputTokens: 5.8e9,        // 输入总 tokens（OpenRouter 语义下已包含缓存命中部分）
  outputTokens: [26.5e6, 14.1e6],
  cacheReadTokens: 5.6e9,    // 其中缓存命中读取的 tokens
  cacheReadIncludedInInput: true, // 5.6B 是否已含在 5.8B 里（默认 true，避免重复计费）
  tpsThreshold: 70,           // 「TPS > N」按钮的阈值
  useDiscountedPrice: true,   // 折扣行用绿色折后价（false 则用被划掉的原价）
  cacheReadFallbackToInput: true, // 没给缓存价时按输入价计
  insertAfterHeader: /cache\s*read/i, // 新列插到哪一列后面
};
```

所有价格单位都是 **USD / 每 100 万 tokens**（站点列头 `/M` = per million）。

OpenRouter 的 usage 里 `prompt_tokens` 已经包含 `cached_tokens`，所以默认口径会先把缓存那部分从输入里扣掉，避免同一批 token 既按输入价又按缓存价计一遍：

| 口径 | 算式（乘数 × `$/M` 单价） | DeepSeek（$0.15 / $0.60 / $0.003） |
| --- | --- | --- |
| `cacheReadIncludedInInput: true`（默认） | `200 × 输入价 + 40.6 × 输出价 + 5600 × 缓存价` | `$71.16` |
| `cacheReadIncludedInInput: false` | `5800 × 输入价 + 40.6 × 输出价 + 5600 × 缓存价` | `$911.16` |

鼠标悬停单元格可看到逐项拆分（含「输入 5.8B − 缓存命中 5.6B = 200M」这一步）。

### 充值页：服务费占充值额的百分比

在 `https://openrouter.ai/settings/credits` 点「Add Credits」打开 Purchase Credits 弹窗后，脚本会在「Service fees」那一行的金额**左边**补一个百分比，例如 `5.53% $0.83`：

- **分母是充值额**，即 Amount 里输入的那个数（真正买到的 credits），不是含服务费的 Total due。
- 站点实测的服务费口径是 `max($0.80, 5.5%)`：$100 以上基本都是 5.5%，而 $5 会被 $0.80 的地板顶到 16%。所以这个百分比不是恒定值，值得看一眼。
- 百分比随 Amount 实时更新，鼠标悬停能看到算式（服务费 ÷ 充值额）。
- 显示的服务费本身已经四舍五入到分（$15 的服务费真值 $0.825、页面显示 $0.83），所以 $15 会显示 `5.53%` 而不是 `5.5%`。
