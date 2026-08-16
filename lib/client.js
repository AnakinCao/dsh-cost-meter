window.__ModuleLoader__.load({
	id: "dsh-cost-meter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		// ─────────────────────────────────────────────────────────────
		//  参数区 —— 费用按 DeepSeek 官方公开单价（USD / 每 100 万 token）估算，
		//  实际账单可能因活动/渠道不同有差异，可在此调整。
		//    deepseek-chat: 输入(缓存未命中) $0.27/M，输入(缓存命中) $0.07/M，输出 $1.10/M
		// ─────────────────────────────────────────────────────────────
		const PRICES = {
			inputPerM: 0.27,
			cachedInputPerM: 0.07,
			outputPerM: 1.1
		};
		/** 余额刷新间隔（毫秒），与宿主路由缓存一致。 */
		const REFRESH_MS = 60000;

		/** 由会话 token 用量估算费用（USD）。 */
		function costOf(usage) {
			if (usage === null || typeof usage !== "object") return null;
			const uncached = Number(usage.uncachedInputTokens ?? 0);
			const cached = Number(usage.cacheReadTokens ?? 0);
			const output = Number(usage.outputTokens ?? 0);
			return (uncached * PRICES.inputPerM + cached * PRICES.cachedInputPerM + output * PRICES.outputPerM) / 1e6;
		}

		/** 格式化余额（优先显示 CNY）。 */
		function formatBalance(balance) {
			if (balance === null || typeof balance !== "object" || !Array.isArray(balance.balance_infos) || balance.balance_infos.length === 0) return "—";
			const info = balance.balance_infos.find((item) => item.currency === "CNY") ?? balance.balance_infos[0];
			const symbol = info.currency === "CNY" ? "¥" : "$";
			return symbol + Number(info.total_balance ?? 0).toFixed(2);
		}

		function CostMeter(props) {
			const useProjection = props.useProjection;
			const usage = useProjection("tokenUsage");
			const [balance, setBalance] = react.useState(null);
			const [balanceError, setBalanceError] = react.useState(null);
			react.useEffect(() => {
				let alive = true;
				const load = () => {
					fetch("/dsh-cost-meter/api/balance")
						.then((r) => r.json())
						.then((d) => {
							if (!alive) return;
							if (d.ok === true) {
								setBalance(d.balance);
								setBalanceError(null);
							} else {
								setBalance(null);
								setBalanceError(d.error ?? "unknown");
							}
						})
						.catch((e) => {
							if (alive) {
								setBalance(null);
								setBalanceError(e instanceof Error ? e.message : String(e));
							}
						});
				};
				load();
				const timer = setInterval(load, REFRESH_MS);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, []);

			const cost = costOf(usage);
			const balanceText = balance !== null ? formatBalance(balance) : (balanceError !== null ? "获取失败" : "…");
			return react_jsx_runtime.jsx("div", {
				"data-dsh-cost-meter": "",
				title: "DeepSeek 费用为会话 token 用量估算；余额来自官方 API",
				children: [
					react_jsx_runtime.jsx("span", { children: "费用 " + (cost === null ? "—" : "$" + cost.toFixed(4)) }),
					react_jsx_runtime.jsx("span", { className: "dshCostSep", children: "·" }),
					react_jsx_runtime.jsx("span", { children: "余额 " + balanceText })
				]
			});
		}

		function CostMeterDockEntry(props) {
			return react_jsx_runtime.jsx(CostMeter, { useProjection: props.useProjection });
		}

		// 样式注入（与官方插件一致：<style data-plugin="dsh-cost-meter">）
		const CSS = [
			"/* dsh-cost-meter: 底部状态栏费用/余额 */",
			"[data-dsh-cost-meter]{margin:0 auto;width:fit-content;display:flex;gap:10px;align-items:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap}",
			"[data-dsh-cost-meter] .dshCostSep{color:var(--dsw-alias-separator-primary)}"
		].join("\n");
		const tagId = "dsh-cost-meter";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = tagId;
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** 挂载到输入框下方的底部状态栏（conversation.composer.dock 槽位）。 */
		function apply(ctx) {
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "dsh-cost-meter",
				order: 120,
				inject: () => ({})
			}, CostMeterDockEntry));
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	}
});
