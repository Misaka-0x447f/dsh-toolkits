/**
 * dsh-session-id-copy —— 浏览器半（手写 bundle，格式与官方客户端插件一致）。
 *
 * 需求：会话列表每一行的「选项」（省略号）菜单里追加一项「复制会话 ID」，点了把该
 * 会话的 SessionId 写进剪贴板。
 *
 * 为什么走 DOM 而不是 slot：ui-workspace 的 SessionNodeItem 把菜单项写死成
 * rename / fork / archive（见 @deepseek-ai/dsh-client-ui-workspace/lib/client.js），
 * 官方 SlotMap 里没有任何「会话菜单项」空位；而 @deepseek-ai/dsh-client-ui-primitives
 * 是 shell 用 Object.freeze 冻结的 seed 模块，Menu 也替换不了。所以只能：
 *   1. MutationObserver 盯 body，发现 [role="menu"] 弹出；
 *   2. 顺着 React fiber 祖先链确认这是会话菜单（menu.items 含 rename+fork+archive）、
 *      并读出所属 SessionNodeItem 的 node.id；
 *   3. cloneNode 一个现成的 .itemWrap（样式/图标/无障碍结构原样继承）改成复制项追加。
 *
 * 两个实测过的关键点（见 test/smoke.mjs 的说明与 README）：
 *   - 注入节点是「React 树外」的，但 React 的 getClosestInstanceFromNode 会沿 DOM
 *     往上找到最近的有 fiber 的祖先（.viewport，就在菜单里），所以 enter/leave 判定
 *     不把它当「离开菜单」——菜单不会因 hover 到这一项而被 closeOnPointerLeave 关掉。
 *   - 点击同理被解析到 .viewport，冒泡时先撞上 .list 自己的 onClick(stopPropagation)，
 *     所以不会触发会话行的 onClick（不会顺带打开该会话）；再加一道 stopPropagation 兜底。
 *
 * 本文件是手写 loader bundle，不能写 import/export；模块解析由宿主的 require 注册表
 * 提供（本插件一个运行时依赖都不需要）。改完 dsh-client-hmr 会推送新字节，刷新页面即生效。
 */
window.__ModuleLoader__.load({
	id: "dsh-session-id-copy",
	factory: function () {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region 常量
		/** 只扫菜单本身；不是会话菜单的话注入函数会在 fiber 校验处直接放弃。 */
		var MENU_SELECTOR = '[role="menu"]';
		/** Menu 内部结构（CSS-module 生成名的稳定本地名后缀）。 */
		var VIEWPORT_SELECTOR = '[class*="_viewport"]';
		var ITEM_WRAP_SELECTOR = '[class*="_itemWrap"]';
		var ITEM_LABEL_SELECTOR = '[class*="_itemLabel"]';
		var ITEM_ICON_SELECTOR = '[class*="_itemIcon"]';
		var MENUITEM_SELECTOR = 'button[role="menuitem"]';
		/** 注入项的幂等标记（重扫时据此跳过，也用于判断 React 是否把它清掉了）。 */
		var MARK_ATTR = "data-dsh-session-id-copy";
		/** 会话菜单的 item id 三件套：工作区菜单是 rename+delete，不会命中。 */
		var SESSION_MENU_IDS = ["rename", "fork", "archive"];
		/** 「已复制」停留多久再把菜单关掉。 */
		var FEEDBACK_MS = 620;
		/** fiber 祖先链最多走多少层，防御异常树。 */
		var MAX_FIBER_DEPTH = 64;
		/** 官方 IconCopyOutline16 的 path（从 dsh-web-frontend 里取的，保证和别处图标同形）。 */
		var COPY_ICON_PATH = "M6.14929 4.02032C7.11197 4.02032 7.87983 4.02016 8.49597 4.07598C9.12128 4.13269 9.65792 4.25188 10.1415 4.53106C10.7202 4.8653 11.2008 5.3459 11.535 5.92462C11.8142 6.40818 11.9334 6.94481 11.9901 7.57012C12.0459 8.18625 12.0458 8.95419 12.0458 9.9168C12.0458 10.8795 12.0459 11.6473 11.9901 12.2635C11.9334 12.8888 11.8142 13.4254 11.535 13.909C11.2008 14.4877 10.7202 14.9683 10.1415 15.3025C9.65792 15.5817 9.12128 15.7009 8.49597 15.7576C7.87984 15.8134 7.11196 15.8133 6.14929 15.8133C5.18667 15.8133 4.41874 15.8134 3.80261 15.7576C3.1773 15.7009 2.64067 15.5817 2.1571 15.3025C1.5784 14.9683 1.09778 14.4877 0.76355 13.909C0.484366 13.4254 0.365184 12.8888 0.308472 12.2635C0.252649 11.6473 0.252808 10.8795 0.252808 9.9168C0.252808 8.95418 0.252664 8.18625 0.308472 7.57012C0.365184 6.94481 0.484366 6.40818 0.76355 5.92462C1.09777 5.34589 1.57839 4.86529 2.1571 4.53106C2.64067 4.25188 3.1773 4.13269 3.80261 4.07598C4.41874 4.02017 5.18666 4.02032 6.14929 4.02032ZM6.14929 5.37774C5.16181 5.37774 4.46634 5.37761 3.92566 5.42657C3.39434 5.47472 3.07859 5.56574 2.83582 5.70587C2.4632 5.92106 2.15354 6.2307 1.93835 6.60333C1.79823 6.8461 1.70721 7.16185 1.65906 7.69317C1.6101 8.23385 1.61023 8.92933 1.61023 9.9168C1.61023 10.9043 1.61009 11.5998 1.65906 12.1404C1.70721 12.6717 1.79823 12.9875 1.93835 13.2303C2.15356 13.6029 2.46321 13.9126 2.83582 14.1277C3.07859 14.2679 3.39434 14.3589 3.92566 14.407C4.46634 14.456 5.16182 14.4559 6.14929 14.4559C7.13682 14.4559 7.83224 14.456 8.37292 14.407C8.90425 14.3589 9.21999 14.2679 9.46277 14.1277C9.83535 13.9126 10.145 13.6029 10.3602 13.2303C10.5004 12.9875 10.5914 12.6717 10.6395 12.1404C10.6885 11.5998 10.6884 10.9043 10.6884 9.9168C10.6884 8.92934 10.6885 8.23384 10.6395 7.69317C10.5914 7.16185 10.5004 6.8461 10.3602 6.60333C10.1451 6.23071 9.83536 5.92107 9.46277 5.70587C9.21999 5.56574 8.90424 5.47472 8.37292 5.42657C7.83224 5.3776 7.13682 5.37774 6.14929 5.37774ZM9.80164 0.367975C10.7638 0.367975 11.5314 0.36788 12.1473 0.423639C12.7726 0.480307 13.3093 0.598759 13.7928 0.877741C14.3717 1.21192 14.8521 1.69355 15.1864 2.27227C15.4655 2.75574 15.5857 3.29164 15.6425 3.9168C15.6983 4.53301 15.6971 5.3016 15.6971 6.26446V7.82989C15.6971 8.29264 15.6989 8.58993 15.6649 8.84844C15.4668 10.3525 14.401 11.5738 12.9833 11.9988V10.5467C13.6973 10.1903 14.2105 9.49662 14.3192 8.67169C14.3387 8.52347 14.3407 8.3358 14.3407 7.82989V6.26446C14.3407 5.27706 14.3398 4.58149 14.2909 4.04083C14.2428 3.50968 14.1526 3.19372 14.0126 2.95098C13.7974 2.57849 13.4876 2.26869 13.1151 2.05352C12.8724 1.91347 12.5564 1.82237 12.0253 1.77423C11.4847 1.72528 10.7888 1.7254 9.80164 1.7254H7.71472C6.7562 1.72558 5.92665 2.27697 5.52332 3.07891H4.07019C4.54221 1.51132 5.9932 0.368186 7.71472 0.367975H9.80164Z";
		var COPY_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="' + COPY_ICON_PATH + '" fill="currentColor"></path></svg>';
		/** 语言按菜单已有文案判定（文档 lang 和 navigator.language 经常不一致，不如看菜单自己）。 */
		var LABELS = {
			zh: { copy: "复制会话 ID", copied: "已复制", failed: "复制失败" },
			en: { copy: "Copy session ID", copied: "Copied", failed: "Copy failed" }
		};
		//#endregion

		//#region 纯逻辑（无 DOM 依赖，test/smoke.mjs 直接测）
		/**
		 * 判定一组菜单项是不是会话列表那一组。
		 * rename + fork + archive 三者齐全才算，避免误伤工作区菜单（rename + delete）。
		 * @param items - Menu 的 `items`。
		 * @returns 是会话菜单项时为 true。
		 */
		function isSessionMenuItems(items) {
			if (!Array.isArray(items)) return false;
			var seen = {};
			var matched = 0;
			for (var index = 0; index < items.length; index++) {
				var item = items[index];
				if (item === null || item === undefined || typeof item.id !== "string") continue;
				if (SESSION_MENU_IDS.indexOf(item.id) === -1) continue;
				if (seen[item.id] === true) continue;
				seen[item.id] = true;
				matched += 1;
			}
			return matched === SESSION_MENU_IDS.length;
		}
		/**
		 * 按菜单里现成的一条文案判定用哪种语言。
		 * @param sampleText - 任一条菜单项文案。
		 * @returns 该语言对应的三条文案。
		 */
		function pickLabels(sampleText) {
			return /[\u3400-\u9fff]/.test(typeof sampleText === "string" ? sampleText : "") ? LABELS.zh : LABELS.en;
		}
		/**
		 * 取 DOM 节点上的 React fiber（React 18/19 的私有键；前缀稳定，后缀是随机串）。
		 * @param node - DOM 节点。
		 * @returns fiber，取不到时为 null。
		 */
		function reactFiber(node) {
			if (node === null || node === undefined) return null;
			var keys;
			try {
				keys = Object.keys(node);
			} catch (error) {
				return null;
			}
			for (var index = 0; index < keys.length; index++) {
				if (keys[index].indexOf("__reactFiber$") === 0) return node[keys[index]];
			}
			return null;
		}
		/**
		 * 从任一 fiber 沿祖先链收集会话菜单信息：Menu 的 props（onClose/items）与所属会话 id。
		 * @param startFiber - 起点 fiber（一般是菜单 DOM 的 fiber）。
		 * @returns `{ menu, sessionId }`；不是会话菜单时为 `{ menu: null, sessionId: null }`。
		 */
		function inspectFiber(startFiber) {
			var found = { menu: null, sessionId: null };
			var fiber = startFiber;
			var depth = 0;
			while (fiber !== null && fiber !== undefined && depth < MAX_FIBER_DEPTH) {
				var props = fiber.memoizedProps;
				if (props !== null && typeof props === "object") {
					if (found.menu === null && isSessionMenuItems(props.items)) found.menu = props;
					if (found.sessionId === null && props.node !== null && typeof props.node === "object" && typeof props.node.id === "string" && props.node.id !== "") {
						found.sessionId = props.node.id;
					}
				}
				if (found.menu !== null && found.sessionId !== null) break;
				fiber = fiber.return;
				depth += 1;
			}
			return found;
		}
		//#endregion

		//#region 剪贴板
		/**
		 * 写剪贴板：优先异步 Clipboard API，失败或不可用时退回 execCommand 的老办法。
		 * @param text - 要复制的文本。
		 * @returns 成功 resolve，失败 reject。
		 */
		function copyText(text) {
			var clipboard = typeof navigator !== "undefined" && navigator !== null ? navigator.clipboard : undefined;
			if (clipboard !== undefined && clipboard !== null && typeof clipboard.writeText === "function") {
				try {
					return Promise.resolve(clipboard.writeText(text)).catch(function () {
						return legacyCopy(text);
					});
				} catch (error) {
					return legacyCopy(text);
				}
			}
			return legacyCopy(text);
		}
		/**
		 * 非安全上下文 / 旧浏览器的回落：临时 textarea + execCommand('copy')。
		 * @param text - 要复制的文本。
		 * @returns 成功 resolve，失败 reject。
		 */
		function legacyCopy(text) {
			if (typeof document === "undefined") return Promise.reject(new Error("no document"));
			try {
				var area = document.createElement("textarea");
				area.value = text;
				area.setAttribute("readonly", "");
				area.style.position = "fixed";
				area.style.top = "-1000px";
				area.style.left = "-1000px";
				area.style.opacity = "0";
				document.body.appendChild(area);
				area.select();
				if (typeof area.setSelectionRange === "function") area.setSelectionRange(0, area.value.length);
				var ok = document.execCommand("copy");
				document.body.removeChild(area);
				return ok ? Promise.resolve() : Promise.reject(new Error("copy command rejected"));
			} catch (error) {
				return Promise.reject(error);
			}
		}
		//#endregion

		//#region 菜单注入
		/** 改写复制项自己的文案（成功/失败反馈）。 */
		function flash(button, text) {
			var labelEl = button.querySelector(ITEM_LABEL_SELECTOR);
			if (labelEl !== null) labelEl.textContent = text;
		}
		/**
		 * 复制项被点击：现取一次会话 id（以最新的 fiber 为准）→ 写剪贴板 → 反馈 → 关菜单。
		 * @param menuEl - 菜单根节点。
		 * @param button - 复制项的按钮。
		 * @param labels - 当前语言的文案。
		 */
		function clickCopyItem(menuEl, button, labels) {
			if (button.getAttribute("disabled") !== null) return;
			var info = inspectFiber(reactFiber(menuEl));
			if (info.sessionId === null) {
				flash(button, labels.failed);
				return;
			}
			button.setAttribute("disabled", "");
			var closeMenu = info.menu !== null && typeof info.menu.onClose === "function" ? info.menu.onClose : null;
			copyText(info.sessionId).then(function () {
				flash(button, labels.copied);
				if (closeMenu !== null) {
					setTimeout(function () {
						closeMenu();
					}, FEEDBACK_MS);
				}
			}, function () {
				button.removeAttribute("disabled");
				flash(button, labels.failed);
			});
		}
		/**
		 * 给一个已渲染的会话菜单追加「复制会话 ID」。
		 * 幂等：已注入 / 不是会话菜单 / 拿不到会话 id 时都直接返回 null。
		 * @param menuEl - `[role="menu"]` 节点。
		 * @returns 注入的行元素；未注入时为 null。
		 */
		function injectIntoMenu(menuEl) {
			if (menuEl === null || menuEl === undefined || typeof menuEl.querySelector !== "function") return null;
			// 只处理最外层菜单：子菜单（role=menu）不注入。
			var parent = menuEl.parentElement;
			if (parent !== null && parent !== undefined && typeof parent.closest === "function" && parent.closest(MENU_SELECTOR) !== null) return null;
			if (menuEl.querySelector("[" + MARK_ATTR + "]") !== null) return null;
			var info = inspectFiber(reactFiber(menuEl));
			if (info.menu === null || info.sessionId === null) return null;
			var viewport = menuEl.querySelector(VIEWPORT_SELECTOR);
			if (viewport === null) viewport = menuEl;
			var proto = viewport.querySelector(ITEM_WRAP_SELECTOR);
			if (proto === null) {
				var protoButton = viewport.querySelector(MENUITEM_SELECTOR);
				if (protoButton === null) return null;
				proto = protoButton.parentElement;
			}
			if (proto === null || typeof proto.cloneNode !== "function") return null;
			var labelEl0 = viewport.querySelector(ITEM_LABEL_SELECTOR);
			var labels = pickLabels(labelEl0 === null ? "" : labelEl0.textContent);
			var row = proto.cloneNode(true);
			var button = row.querySelector(MENUITEM_SELECTOR);
			if (button === null) button = row;
			var labelEl = row.querySelector(ITEM_LABEL_SELECTOR);
			if (labelEl !== null) labelEl.textContent = labels.copy;
			var iconEl = row.querySelector(ITEM_ICON_SELECTOR);
			if (iconEl !== null) iconEl.innerHTML = COPY_ICON_SVG;
			row.setAttribute(MARK_ATTR, "true");
			button.removeAttribute("aria-haspopup");
			button.removeAttribute("aria-expanded");
			button.removeAttribute("disabled");
			button.addEventListener("click", function (event) {
				event.preventDefault();
				event.stopPropagation();
				clickCopyItem(menuEl, button, labels);
			});
			viewport.appendChild(row);
			return row;
		}
		/** 扫一遍当前所有打开的菜单。 */
		function scanMenus() {
			if (typeof document === "undefined") return 0;
			var menus = document.querySelectorAll(MENU_SELECTOR);
			var injected = 0;
			for (var index = 0; index < menus.length; index++) {
				if (injectIntoMenu(menus[index]) !== null) injected += 1;
			}
			return injected;
		}
		//#endregion

		//#region 生命周期
		var observer = null;
		var scheduled = false;
		/** 合并同一帧里的多次 DOM 变更，只扫一次。 */
		function scheduleScan() {
			if (scheduled) return;
			scheduled = true;
			var run = function () {
				scheduled = false;
				scanMenus();
			};
			if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
			else setTimeout(run, 16);
		}
		/**
		 * 开始监听。
		 * @returns 停止函数（断开 observer）。
		 */
		function start() {
			if (typeof document === "undefined" || typeof MutationObserver === "undefined") return function () {};
			scanMenus();
			observer = new MutationObserver(scheduleScan);
			observer.observe(document.body, { childList: true, subtree: true });
			return function stop() {
				if (observer !== null) {
					observer.disconnect();
					observer = null;
				}
			};
		}
		/**
		 * 插件入口：安装监听。重复 apply（HMR）时先拆掉上一次的 observer，避免叠加。
		 */
		function apply() {
			var host = typeof window === "object" && window !== null ? window : null;
			if (host !== null && typeof host.__dshSessionIdCopyDispose === "function") {
				try {
					host.__dshSessionIdCopyDispose();
				} catch (error) {
					/* 上一次的清理失败不影响本次安装 */
				}
			}
			var stop = start();
			if (host !== null) host.__dshSessionIdCopyDispose = stop;
		}
		var inject = [];
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		/** 仅供 test/smoke.mjs 使用的出口。 */
		exports.__internals = {
			isSessionMenuItems: isSessionMenuItems,
			pickLabels: pickLabels,
			reactFiber: reactFiber,
			inspectFiber: inspectFiber,
			copyText: copyText,
			legacyCopy: legacyCopy,
			flash: flash,
			clickCopyItem: clickCopyItem,
			injectIntoMenu: injectIntoMenu,
			scanMenus: scanMenus,
			start: start,
			apply: apply,
			MENU_SELECTOR: MENU_SELECTOR,
			MARK_ATTR: MARK_ATTR,
			SESSION_MENU_IDS: SESSION_MENU_IDS,
			FEEDBACK_MS: FEEDBACK_MS,
			LABELS: LABELS,
			COPY_ICON_SVG: COPY_ICON_SVG
		};
		return module.exports;
	}
});
