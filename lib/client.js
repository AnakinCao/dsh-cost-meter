window.__ModuleLoader__.load({
	id: "dsh-cost-meter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		// ─────────────────────────────────────────────────────────────
		//  参数区
		// ─────────────────────────────────────────────────────────────
		// 费用按 DeepSeek 官方公开单价（USD / 每 100 万 token）估算，
		// 实际账单可能因活动/渠道不同有差异，可在此调整。
		const PRICES = {
			inputPerM: 0.27,
			cachedInputPerM: 0.07,
			outputPerM: 1.1
		};
		/** 汇率（USD → CNY），费用显示为人民币时使用。 */
		const CNY_PER_USD = 7.2;
		/** 余额告警阈值（CNY）：余额低于该值时状态栏变红。 */
		const BALANCE_WARN_CNY = 50;
		/** 刷新间隔（毫秒），与宿主路由缓存一致。 */
		const REFRESH_MS = 60000;

		/** token 用量 → 费用（USD）。totals 可为会话级或今日聚合级。 */
		function costUsd(totals) {
			if (totals === null || typeof totals !== "object") return null;
			const uncached = Number(totals.uncachedInputTokens ?? 0);
			const cached = Number(totals.cacheReadTokens ?? 0);
			const output = Number(totals.outputTokens ?? 0);
			return (uncached * PRICES.inputPerM + cached * PRICES.cachedInputPerM + output * PRICES.outputPerM) / 1e6;
		}

		/** 费用显示：人民币，小额时保留更多小数位。 */
		function formatYuan(usd) {
			if (usd === null) return "—";
			const cny = usd * CNY_PER_USD;
			return "¥" + (cny >= 0.01 ? cny.toFixed(2) : cny.toFixed(4));
		}

		/** 余额（优先 CNY）与告警判定。 */
		function balanceInfo(balance) {
			if (balance === null || typeof balance !== "object" || !Array.isArray(balance.balance_infos) || balance.balance_infos.length === 0) return null;
			const info = balance.balance_infos.find((item) => item.currency === "CNY") ?? balance.balance_infos[0];
			const total = Number(info.total_balance ?? 0);
			return {
				text: (info.currency === "CNY" ? "¥" : "$") + total.toFixed(2),
				low: info.currency === "CNY" && total < BALANCE_WARN_CNY
			};
		}

		function CostMeter(props) {
			const useProjection = props.useProjection;
			const usage = useProjection("tokenUsage");
			const [balance, setBalance] = react.useState(null);
			const [balanceError, setBalanceError] = react.useState(null);
			const [today, setToday] = react.useState(null);
			const [todayError, setTodayError] = react.useState(null);
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
					fetch("/dsh-cost-meter/api/today")
						.then((r) => r.json())
						.then((d) => {
							if (!alive) return;
							if (d.ok === true) {
								setToday(d.totals);
								setTodayError(null);
							} else {
								setToday(null);
								setTodayError(d.error ?? "unknown");
							}
						})
						.catch((e) => {
							if (alive) {
								setToday(null);
								setTodayError(e instanceof Error ? e.message : String(e));
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

			const sessionCost = costUsd(usage);
			const todayCost = costUsd(today);
			const info = balanceInfo(balance);
			const balanceText = info !== null ? info.text : (balanceError !== null ? "获取失败" : "…");
			const todayText = todayCost !== null ? formatYuan(todayCost) : (todayError !== null ? "—" : "…");
			return react_jsx_runtime.jsx("div", {
				"data-dsh-cost-meter": "",
				...(info !== null && info.low ? { "data-warn": "" } : {}),
				title: "今日费用/会话费用为 token 用量 × 单价估算（USD→CNY）；余额来自 DeepSeek 官方 API，低于 ¥" + BALANCE_WARN_CNY + " 变红",
				children: [
					react_jsx_runtime.jsx("span", { children: "今日 " + todayText }),
					react_jsx_runtime.jsx("span", { className: "dshCostSep", children: "·" }),
					react_jsx_runtime.jsx("span", { children: "会话 " + formatYuan(sessionCost) }),
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
			"[data-dsh-cost-meter] .dshCostSep{color:var(--dsw-alias-separator-primary)}",
			"[data-dsh-cost-meter][data-warn]{color:var(--dsw-alias-state-error-primary)}"
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
