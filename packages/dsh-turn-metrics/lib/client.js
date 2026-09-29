/**
 * dsh-turn-metrics —— 浏览器半（手写 bundle，格式与官方客户端插件一致）。
 *
 * 占用 `conversation.input.dock`（官方 list slot：composer 卡片上方的整行席位），
 * 在每轮运行期间显示：本轮工具调用计数 + 本轮已用时。
 *
 * 数据全部来自 Chat 目标已经发布的快照，不新增任何数据通道：
 *   - 本轮号与起始时间：`snapshot.timeline.turns` 里 status === 'open' 的那一轮
 *   - 工具计数：该轮 `turn-process` 控制节点的 toolCallCount / subagentCount
 *     （与 transcript 里「N 次工具调用」用的是同一个字段）
 *   - 正在执行的工具数：`snapshot.legacy.runningCalls` 里 turn 相同的条目
 *
 * 注意：本文件是**手写**的 loader bundle，不能写 import/export —— 模块解析由宿主的
 * require 注册表提供（react 由宿主注入）。改完必须重启 DSH host（客户端 bundle 的
 * 内容哈希会变，浏览器页刷新即可拿到新字节）。
 */
window.__ModuleLoader__.load({
	id: "dsh-turn-metrics",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");

		//#region 样式
		/**
		 * 是否隐藏 DSH 自带的运行状态行（transcript 末尾的「深度求索中…」+ 15s 后出现的计时）。
		 * 换成 false 就是「两行并存」，不再注入隐藏规则。
		 */
		var HIDE_BUILTIN_STATUS = true;
		/** 自带的类名是 CSS-module 生成名 `<hash>_turnStatus`；hash 随构建变化，本地名后缀稳定。 */
		var BUILTIN_STATUS_SELECTOR = '[class*="_turnStatus"]';
		var STYLE_TAG_ID = "dsh-turn-metrics";
		var CSS = [
			// 与 composer 卡片同宽：几何照抄同一席位上已验证的 GoalBar dock
			// （宽 = 面板宽 − 两侧 clearance − 4×dock inset；再按 composer 卡片最大宽收窄并居中）
			".dtm-root{box-sizing:border-box;display:flex;align-items:center;gap:0;",
			"width:calc(100% - 2 * var(--dsh-composer-side-clearance, 0px) - 4 * var(--dsh-composer-dock-inset, 0px));",
			"max-width:calc(var(--dsh-composer-card-max-width, var(--dsh-chat-content-width, 100%)) - 4 * var(--dsh-composer-dock-inset, 0px));",
			"margin:0 auto;padding:0 0 12px 0;",
			"font-size:var(--dsh-content-font-size-secondary,13px);",
			"line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px));",
			"color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;",
			"white-space:nowrap;overflow:hidden;",
			"user-select:none;-webkit-user-select:none;pointer-events:none}",
			// 活着信号：呼吸点。
			// 盒子固定 16×16（对齐官方图标尺寸）且**永不变换**——动效只加在内部的 6px 圆上，
			// 用 flex 居中，所以盒子体积是绝对不变量，不会每帧重栅格化导致漂移。
			// 有工具在执行时由蓝转黄。
			".dtm-dot{flex:none;width:16px;height:16px;margin-right:6px;",
			"display:inline-flex;align-items:center;justify-content:center}",
			".dtm-dot::before{content:\"\";width:6px;height:6px;border-radius:50%;",
			"background:var(--dsw-static-deepseek-500,#4d6bfe);",
			"animation:dtm-breathe 1.6s ease-in-out infinite}",
			'.dtm-dot[data-running="true"]::before{background:var(--dsw-alias-state-warn-primary,#f59e0b)}',
			"@keyframes dtm-breathe{0%,100%{opacity:.25;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}",
			"@media (prefers-reduced-motion:reduce){.dtm-dot::before{animation:none;opacity:.75}}",
			// 视觉隐藏的静态标签：读屏器播报一次「本轮运行中」，而每秒 tick 的计时被 aria-hidden 排除
			".dtm-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;",
			"clip:rect(0 0 0 0);white-space:nowrap;border:0}",
			// 窄窗口下让「事实」先省略，计时始终可见
			".dtm-facts{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dtm-time{flex:none}"
		].join("");
		function ensureStyle() {
			if (typeof document === "undefined") return;
			if (document.querySelector('style[data-plugin-css="' + STYLE_TAG_ID + '"]') !== null) return;
			var tag = document.createElement("style");
			tag.dataset.plugin = STYLE_TAG_ID;
			tag.dataset.pluginCss = STYLE_TAG_ID;
			tag.textContent = HIDE_BUILTIN_STATUS ? BUILTIN_STATUS_SELECTOR + "{display:none!important}" + CSS : CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region 纯逻辑（无 React 依赖，test/smoke.mjs 直接测这些）
		/** 两位补零。 */
		function pad2(value) {
			return value < 10 ? "0" + value : String(value);
		}
		/**
		 * 时长文案：`42秒` / `2分42秒` / `1时02分`。
		 * @param ms - 毫秒。
		 * @returns 展示用文案。
		 */
		function formatDuration(ms) {
			var total = Math.max(0, Math.floor(ms / 1000));
			var hours = Math.floor(total / 3600);
			var minutes = Math.floor(total % 3600 / 60);
			var seconds = total % 60;
			if (hours > 0) return hours + "时" + pad2(minutes) + "分";
			if (minutes > 0) return minutes + "分" + pad2(seconds) + "秒";
			return seconds + "秒";
		}
		/**
		 * 取最新一个未关闭的轮次。
		 * @param timeline - Chat 快照的 timeline（`{ turnOrder, turns }`）。
		 * @returns `{ turn, startMs }`；没有运行中的轮次时为 null。
		 */
		function openTurn(timeline) {
			if (timeline === undefined || timeline === null) return null;
			var turns = timeline.turns;
			if (turns === undefined || turns === null || typeof turns.forEach !== "function") return null;
			var latest = null;
			turns.forEach(function (location) {
				if (location === undefined || location === null || location.status !== "open") return;
				if (latest === null || location.turn > latest.turn) latest = location;
			});
			if (latest === null) return null;
			var start = latest.start;
			var startMs = start !== undefined && start !== null && typeof start.time === "number" ? start.time : 0;
			return { turn: latest.turn, startMs: startMs };
		}
		/**
		 * 折叠一轮的工具事实。
		 * @param snapshot - Chat 快照。
		 * @param turn - 轮次号。
		 * @returns `{ toolCalls, subagents, running }`。
		 */
		function deriveStats(snapshot, turn) {
			var stats = { toolCalls: 0, subagents: 0, running: 0 };
			if (snapshot === undefined || snapshot === null) return stats;
			var locations = snapshot.locations;
			var nodes = snapshot.nodes;
			var sawProcess = false;
			if (locations !== undefined && nodes !== undefined && typeof locations.getTurn === "function" && typeof nodes.get === "function") {
				var keys = locations.getTurn(turn);
				if (keys !== undefined && keys !== null) {
					var fallbackTools = 0;
					for (var index = 0; index < keys.length; index++) {
						var node = nodes.get(keys[index]);
						if (node === undefined || node === null) continue;
						if (node.kind === "tool-call") fallbackTools += 1;
						if (node.kind !== "turn-process" || node.data === undefined || node.data === null) continue;
						sawProcess = true;
						if (typeof node.data.toolCallCount === "number") stats.toolCalls = node.data.toolCallCount;
						if (typeof node.data.subagentCount === "number") stats.subagents = node.data.subagentCount;
					}
					if (!sawProcess) stats.toolCalls = fallbackTools;
				}
			}
			var runningCalls = snapshot.legacy === undefined || snapshot.legacy === null ? undefined : snapshot.legacy.runningCalls;
			if (runningCalls !== undefined && runningCalls !== null && typeof runningCalls.length === "number") {
				for (var at = 0; at < runningCalls.length; at++) {
					var call = runningCalls[at];
					if (call !== undefined && call !== null && call.turn === turn) stats.running += 1;
				}
			}
			return stats;
		}
		/**
		 * 拼「事实」部分（工具计数与子代理），不含计时；是否有工具在执行只由点的颜色表达。
		 * @param stats - `deriveStats` 的结果。
		 * @returns 形如 `5 次工具调用 · 2 个子代理`；没有事实时为空串。
		 */
		function composeFacts(stats) {
			var parts = [];
			if (stats.toolCalls > 0) parts.push(stats.toolCalls + " 次工具调用");
			if (stats.subagents > 0) parts.push(stats.subagents + " 个子代理");
			return parts.join(" · ");
		}
		/**
		 * 拼整行文案。
		 * @param stats - `deriveStats` 的结果。
		 * @param elapsedMs - 本轮已用时（毫秒）。
		 * @returns 单行文案，如 `5 次工具调用 · 1分24秒`。
		 */
		function composeLabel(stats, elapsedMs) {
			var facts = composeFacts(stats);
			var time = formatDuration(elapsedMs);
			return facts === "" ? time : facts + " · " + time;
		}
		/**
		 * store 选择器：把整行所需事实压成一个原始字符串，靠 Object.is 抑制无谓重渲染。
		 * 每次流式 delta 也只会得到同一个字符串，因此组件不会跟着 delta 重渲染。
		 */
		function selectKey(snapshot) {
			var current = openTurn(snapshot === undefined || snapshot === null ? undefined : snapshot.timeline);
			if (current === null) return "";
			var stats = deriveStats(snapshot, current.turn);
			return current.turn + ":" + current.startMs + ":" + stats.toolCalls + ":" + stats.subagents + ":" + stats.running;
		}
		//#endregion

		//#region 组件
		/** 运行期间每秒自增，只为驱动计时文本。 */
		function useTicker(enabled) {
			var state = react.useState(0);
			var setTick = state[1];
			react.useEffect(function () {
				if (!enabled) return undefined;
				var id = setInterval(function () {
					setTick(function (value) {
						return value + 1;
					});
				}, 1000);
				return function () {
					clearInterval(id);
				};
			}, [enabled]);
		}
		/** 有快照可读时才挂载，保证 hook 顺序稳定。 */
		function TurnMetricsLive(props) {
			var key = props.useChat(selectKey);
			useTicker(key !== "");
			if (key === "") return null;
			var fields = key.split(":");
			var startMs = Number(fields[1]);
			var stats = { toolCalls: Number(fields[2]), subagents: Number(fields[3]), running: Number(fields[4]) };
			var anchor = startMs > 0 ? startMs : props.mountedAt;
			var facts = composeFacts(stats);
			var time = formatDuration(Date.now() - anchor);
			return react.createElement(
				"div",
				{ className: "dtm-root", role: "status", "aria-live": "polite" },
				react.createElement("span", {
					className: "dtm-dot",
					"data-running": stats.running > 0 ? "true" : "false",
					"aria-hidden": true
				}),
				react.createElement("span", { className: "dtm-sr" }, "本轮运行中"),
				facts === "" ? null : react.createElement("span", { className: "dtm-facts" }, facts),
				react.createElement("span", { className: "dtm-time", "aria-hidden": true }, facts === "" ? time : " · " + time)
			);
		}
		/**
		 * `conversation.input.dock` 的占位组件。
		 * @param props - 框架注入的 session 标准 props（这里只用到 useChat）。
		 * @returns 运行中渲染一行状态，否则 null。
		 */
		function TurnMetrics(props) {
			var mountedAt = react.useState(function () {
				return Date.now();
			})[0];
			if (typeof props.useChat !== "function") return null;
			return react.createElement(TurnMetricsLive, { useChat: props.useChat, mountedAt: mountedAt });
		}
		//#endregion

		function apply(ctx) {
			ensureStyle();
			ctx.slots.inject("conversation.input.dock", function () {
				return ctx.slots.register({
					name: "conversation.input.dock",
					id: "turn-metrics",
					order: 30
				}, TurnMetrics);
			});
		}
		var inject = ["slots"];

		exports.apply = apply;
		exports.inject = inject;
		/** 仅供 test/smoke.mjs 使用的纯逻辑出口。 */
		exports.__internals = {
			formatDuration: formatDuration,
			openTurn: openTurn,
			deriveStats: deriveStats,
			composeFacts: composeFacts,
			composeLabel: composeLabel,
			selectKey: selectKey,
			TurnMetrics: TurnMetrics,
			css: CSS,
			builtinStatusSelector: BUILTIN_STATUS_SELECTOR,
			hideBuiltinStatus: HIDE_BUILTIN_STATUS
		};
		exports.TurnMetrics = TurnMetrics;
		return module.exports;
	}
});
