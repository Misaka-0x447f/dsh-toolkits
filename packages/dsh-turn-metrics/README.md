# dsh-turn-metrics

DSH Web 的**运行状态行**：每轮运行期间，在 composer 卡片正上方显示该轮的

```
● 5 次工具调用（1 执行中） · 2 个子代理 · 1分24秒
```

并**隐藏** DSH 自带的 `深度求索中…`（transcript 末尾那行，15 秒后才附带计时）。没有运行中的轮次时整行不渲染。

## 它读什么

全部来自 Chat 目标已经发布的客户端快照，不新增数据通道、不轮询：

| 显示项 | 来源 |
| --- | --- |
| 本轮号 / 起始时间 | `snapshot.timeline.turns` 中 `status === 'open'` 的最新一轮 |
| 工具调用次数 | 该轮 `turn-process` 控制节点的 `data.toolCallCount`（与 transcript 里「N 次工具调用」同一个字段） |
| 子代理数 | 同节点的 `data.subagentCount`（`toolCallCount` 不含委派） |
| 执行中的工具数 | `snapshot.legacy.runningCalls` 里 `turn` 相同的条目 |
| 本轮已用时 | 起始时间 → 现在，本地每秒 tick |

渲染位置是官方 list slot **`conversation.input.dock`**（"full-width entries above the composer card"，`@deepseek-ai/dsh-client-ui-goal` 的 GoalBar 用的是同一个席位），所以它**始终可见**，不像 transcript 里的状态行会随滚动移出视口。

## 安装

本包位于 `dsh-toolkits` monorepo。以 `link:` 方式挂到 DSH profile：

```json
{
  "dependencies": {
    "dsh-turn-metrics": "link:/home/misaka/git/dsh-toolkits/packages/dsh-turn-metrics"
  },
  "dsh": {
    "profile": {
      "bundles": [ "...", "dsh-turn-metrics" ]
    }
  }
}
```

`pnpm install` 后**重启 DSH host**（客户端 bundle 在启动时装配），再刷新浏览器页面。

## 测试

```bash
node test/smoke.mjs      # 或 pnpm test
```

13 项检查：loader 契约、slot 注册、纯逻辑（时长/轮次识别/计数折叠/文案）、组件渲染（运行中/空闲/缺 `useChat`）、hook 顺序稳定性。渲染优先用真实的 `react` + `react-dom/server`；本机两者版本错配时退回内置 shim（并仍然校验 hook 顺序），所以这个仓库保持零依赖、离线可测。

## 实现说明与已知取舍

- **手写 loader bundle**：`lib/client.js` 是 `window.__ModuleLoader__.load({ id, factory })` 形态，格式与官方客户端插件一致，**不需要构建链**（这是它现在还不引入 tsdown 的原因）。因此文件里不能写 `import` / `export`；重复的样式/工具函数请放回 factory 内部。
- **隐藏自带状态行**用 `[class*="_turnStatus"]` 这条 CSS 选择器：官方类名是 CSS-module 生成名 `<hash>_turnStatus`，hash 随构建变化、本地名后缀稳定。若将来官方改了本地名，自带那行会重新出现（降级，不会报错）；把 `lib/client.js` 里 `HIDE_BUILTIN_STATUS` 改成 `false` 就是「两行并存」。
- **工具计数的回落路径**：极少数情况下（该轮还没有 `turn-process` 控制节点）改用该轮 `kind === 'tool-call'` 的节点数，此时 subagent 委派会被算进工具数。
- **不显示 token**：下行 token 只有 provider 在流末尾上报一次（`dsh-llm-deepseek` 的 translate 把 usage 延迟到 `[DONE]`），流中无法得到增量值，因此这一行刻意不做 token 计数。本轮工具计数与用时都不需要 provider 数据，天然实时。
- 计时取的是 **host 事件时间**（`turn/start` 的 `time`）与浏览器当前时间之差；两侧时钟偏差很大时会不准（负数已 clamp 到 0）。
