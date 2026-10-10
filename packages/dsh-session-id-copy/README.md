# dsh-session-id-copy

DSH Web **会话列表每一行的「选项」（省略号）菜单**里追加一项 **「复制会话 ID」**，点一下就把该会话的 `SessionId` 写进剪贴板。

```
重命名
分叉会话
归档会话
复制会话 ID      ← 本插件追加
```

成功时该项文案短暂变「已复制」，约 0.6 秒后菜单自动关闭；失败变「复制失败」并保持可点重试。菜单语言跟着菜单自己走（中文菜单出「复制会话 ID」，英文菜单出 "Copy session ID"）。

## 为什么是 DOM 注入而不是官方 slot

官方 `SlotMap` 里没有「会话菜单项」这个空位：会话行的菜单项在 `@deepseek-ai/dsh-client-ui-workspace` 的 `SessionNodeItem` 里**写死**为 `rename / fork / archive`，没有任何注册口。

另一条路——替换 `@deepseek-ai/dsh-client-ui-primitives` 里的 `Menu`——也走不通：`@deepseek-ai/dsh-client-ui-primitives` 是 shell 用 `Object.freeze` 冻结的 seed 模块（`react` / `react/jsx-runtime` / `dsh-client-ui-slots` 等同样冻结），属性不可改写。

所以本插件只能做浏览器侧的 DOM 注入：

1. `MutationObserver` 盯 `document.body`（菜单是 portal 到 `body` 的），发现新的 `[role="menu"]`；
2. 顺着菜单 DOM 的 React fiber **祖先链**确认它是**会话菜单**（`menu.items` 同时含 `rename` + `fork` + `archive`），并读出所属 `SessionNodeItem` 的 `node.id`（会话 id）；
3. `cloneNode(true)` 一个现成的 `.itemWrap`（按钮/图标/无障碍结构/CSS-module 类名原样继承，视觉与其它项完全一致），改文案、换成官方 `IconCopyOutline16` 的图标，追加到菜单末尾，并打上 `data-dsh-session-id-copy` 标记做幂等。

工作区那一行的菜单是 `rename + delete`，不会命中；再叠一道「必须有 `node.id` 祖先」的校验，别的菜单即使 item id 撞上也不会被注入。

## 两个实测过的关键点

注入节点是「React 树外」的 DOM，直觉上会踩两个坑，实测都不会（README 记录结论，代码里另有兜底）：

- **不会被 `closeOnPointerLeave` 关掉。** 会话菜单开了 `closeOnPointerLeave: true`，指针离开菜单根 `<span>` 200ms 后自动关闭。但 React 的 `getClosestInstanceFromNode` 会沿 DOM 往上找到最近的有 fiber 的祖先 —— 注入项的父级 `.viewport` 就在菜单里 —— 于是 enter/leave 判定仍把它当「菜单内部」。用真实鼠标移到「复制会话 ID」上停 500ms，菜单保持打开。
- **不会顺带打开会话。** React 的点击冒泡按 fiber 树走，但注入项先被解析到 `.viewport`，冒泡时先撞上菜单 `.list` 自己的 `onClick`（`stopPropagation`），到不了会话行的 `onClick`。代码里再加一道 `stopPropagation` 兜底。

> 这些结论依赖 React 的私有字段与 ui-workspace 的 CSS-module 本地名后缀（`_itemWrap` / `_itemLabel` / `_itemIcon` / `_viewport`）。官方哪天改了结构，降级方式是「菜单里不出现这一项」，不会报错、不影响原有菜单。

## 它读什么

不新增数据通道、不请求 host、不碰 store：会话 id 直接来自 React 已经渲染在 fiber 上的 `SessionNodeItem.props.node.id`（与 `sidebar.workspaces` 会话行同一个字段）。写剪贴板优先用异步 `navigator.clipboard.writeText`，不可用或失败时回落到临时 `textarea` + `execCommand('copy')`。

## 安装

本包位于 `dsh-toolkits` monorepo。以 `link:` 方式挂到 DSH profile：

```json
{
  "dependencies": {
    "dsh-session-id-copy": "link:/home/misaka/git/dsh-toolkits/packages/dsh-session-id-copy"
  },
  "dsh": {
    "profile": {
      "bundles": [ "...", "dsh-session-id-copy" ]
    }
  }
}
```

`pnpm install` 后**重启 DSH host 一次**（首次加入时，profile 的 bundle 列表在启动时装配），随后刷新浏览器页面。

之后只改 `lib/client.js`（浏览器半）**不需要重启**：`dsh-client-hmr` 会按文件 mtime 重新取包并推送给已打开的页面。只有新增/移除插件本身、或改动 `lib/index.js`（host 半）时才需要重启。

本包 host 半是空 `apply`、浏览器半零 `require`，所以**不需要**包内 `node_modules` 软链（同 `dsh-turn-metrics`；只有 `dsh-cloudflare-tunnel-gateway` 那种 host 侧要 import 运行时包的才需要）。

## 测试

```bash
node test/smoke.mjs      # 或 pnpm test
```

20 项检查，零依赖、离线可跑：loader 契约（含「无顶层 import/export」）、纯逻辑（会话菜单识别 / 语言判定 / fiber 祖先链收集）、注入（文案 / 图标 / 标记 / 幂等 / 非会话菜单不注入 / 英文菜单）、点击（成功 / 失败可重试 / 无 Clipboard API 回落 / 反馈后关菜单）、生命周期（`apply` 装 observer、重复 `apply` 先拆旧的）。

DOM 用一个几十行的极简实现（只需 `[attr]` / `[attr="v"]` / `[class*="v"]` / `tag[attr]` 四种选择器、`cloneNode`、`textContent`/`innerHTML`、事件），因此仓库保持零依赖。

## 实现说明与已知取舍

- **手写 loader bundle**：`lib/client.js` 是 `window.__ModuleLoader__.load({ id, factory })` 形态，格式与官方客户端插件一致，**不需要构建链**；因此文件里不能写 `import` / `export`。
- **幂等与重注入**：以 `data-dsh-session-id-copy` 标记判断是否已注入；`MutationObserver` 用 `requestAnimationFrame` 合并同一帧的变更，React 若在重渲染里清掉注入项，下一次扫描会补回来。
- **菜单定位用 `[role="menu"]`**（不是 `body > [role="menu"]`），并跳过嵌套子菜单；这样 portal 目标换了也还认。
- **语言**按菜单里现成的一条文案判定（出现 CJK 用中文），不看 `document.lang` 或 `navigator.language` —— 实测两者的值经常不一致。
- **图标**内联官方 `IconCopyOutline16` 的 path（取自 `dsh-web-frontend`），`fill="currentColor"`，跟随菜单主题色。
- **失败不关菜单**：只有复制成功才在反馈后关闭，失败保留菜单并恢复可点，方便重试。
