window.__ModuleLoader__.load({
	id: "dsh-cost-meter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		// ─────────────────────────────────────────────────────────────
		//  参数区 —— deepseek-v4-flash 官方定价（元 / 每 100 万 token）
		//  峰谷计价（北京时间 9-12、14-18 为高峰，其余空闲；2026-08-17 起生效）。
		//  2026-08-16 前的旧价：缓存命中 0.02 / 未命中 1 / 输出 2 元。
		// ─────────────────────────────────────────────────────────────
		const PRICES_OFFPEAK = { inputPerM: 1.5, cachedInputPerM: 0.05, outputPerM: 4.5 };
		const PRICES_PEAK = { inputPerM: 3.0, cachedInputPerM: 0.1, outputPerM: 9.0 };
		/** 2026-08-16 前的旧价（v4-flash）：缓存命中 0.02 / 未命中 1 / 输出 2 元。 */
		const PRICES_LEGACY = { inputPerM: 1.0, cachedInputPerM: 0.02, outputPerM: 2.0 };
		/** 峰谷新价生效时刻 = 北京时间 2026-08-17 00:00 = UTC 2026-08-16 16:00。 */
		const PRICE_CHANGE_EPOCH_UTC = Date.UTC(2026, 7, 16, 16, 0, 0);
		/** 高峰时段（北京时间小时区间）。 */
		const PEAK_HOURS = [[9, 12], [14, 18]];
		/** 余额告警阈值（CNY）：余额低于该值时状态栏变红。 */
		const BALANCE_WARN_CNY = 50;
		/** 刷新间隔（毫秒），与宿主路由缓存一致。 */
		const REFRESH_MS = 60000;

		/** 当前是否处于高峰时段（按北京时间判断）。 */
		function isPeakNow() {
			const h = (new Date().getUTCHours() + 8) % 24;
			return PEAK_HOURS.some(([start, end]) => h >= start && h < end);
		}

		/** 当前生效单价：新价 2026-08-17 00:00（北京时间）起按峰谷计价，之前用旧价。 */
		function currentPrices() {
			if (Date.now() < PRICE_CHANGE_EPOCH_UTC) return PRICES_LEGACY;
			return isPeakNow() ? PRICES_PEAK : PRICES_OFFPEAK;
		}

		/** token 用量 → 费用（人民币）。 */
		function costCny(totals) {
			if (totals === null || typeof totals !== "object") return null;
			const p = currentPrices();
			const uncached = Number(totals.uncachedInputTokens ?? 0);
			const cached = Number(totals.cacheReadTokens ?? 0);
			const output = Number(totals.outputTokens ?? 0);
			return (uncached * p.inputPerM + cached * p.cachedInputPerM + output * p.outputPerM) / 1e6;
		}

		/** 费用显示：人民币，小额时保留更多小数位。 */
		function formatYuan(cny) {
			if (cny === null) return "—";
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

		/** 今日各会话费用明细（tooltip 用）。 */
		function sessionBreakdown(today) {
			if (today === null || !Array.isArray(today.sessions)) return null;
			const rows = today.sessions
				.map((s) => ({ id: s.id, cny: costCny(s.totals) }))
				.filter((r) => r.cny !== null && r.cny > 0)
				.sort((a, b) => b.cny - a.cny);
			if (rows.length === 0) return null;
			return "今日各会话费用（估算，峰/闲自动计价）:\n" + rows.map((r) => "  " + r.id + ": " + formatYuan(r.cny)).join("\n");
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
								setToday(d);
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

			const sessionCost = costCny(usage);
			const todayCost = costCny(today !== null ? today.totals : null);
			const sessionCount = today !== null && Array.isArray(today.sessions) ? today.sessions.length : 0;
			const info = balanceInfo(balance);
			const balanceText = info !== null ? info.text : (balanceError !== null ? "获取失败" : "…");
			const todayText = todayCost !== null ? formatYuan(todayCost) + (sessionCount > 0 ? " (" + sessionCount + "会话)" : "") : (todayError !== null ? "—" : "…");
			const breakdown = sessionBreakdown(today);
			return react_jsx_runtime.jsx("div", {
				"data-dsh-cost-meter": "",
				...(info !== null && info.low ? { "data-warn": "" } : {}),
				...(breakdown !== null ? { title: breakdown } : {}),
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
