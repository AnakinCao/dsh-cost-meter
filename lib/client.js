window.__ModuleLoader__.load({
	id: "dsh-cost-meter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		// ─────────────────────────────────────────────────────────────
		//  价格 —— 优先使用宿主从官方平台（api-docs.deepseek.com）抓取的价格，
		//  以下为内置回退值（与官方页面当前一致，元/百万 token）。
		// ─────────────────────────────────────────────────────────────
		const FALLBACK_PRICES = {
			/** 2026-08-16 前的旧价（v4-flash）：缓存命中 0.02 / 未命中 1 / 输出 2 元。 */
			legacy: { inputPerM: 1.0, cachedInputPerM: 0.02, outputPerM: 2.0 },
			/** 新价空闲时段（8/17 起）。 */
			offpeak: { inputPerM: 1.5, cachedInputPerM: 0.05, outputPerM: 4.5 },
			/** 新价高峰时段。 */
			peak: { inputPerM: 3.0, cachedInputPerM: 0.1, outputPerM: 9.0 }
		};
		/** 峰谷新价生效时刻 = 北京时间 2026-08-17 00:00 = UTC 2026-08-16 16:00。 */
		const PRICE_CHANGE_EPOCH_UTC = Date.UTC(2026, 7, 16, 16, 0, 0);
		/** 高峰时段（北京时间小时区间）。 */
		const PEAK_HOURS = [[9, 12], [14, 18]];
		/** 余额告警阈值（CNY）：余额低于该值时状态栏变红。 */
		const BALANCE_WARN_CNY = 50;
		/** 刷新间隔（毫秒），与宿主路由缓存一致。 */
		const REFRESH_MS = 60000;

		/** 北京时间小时（按给定时间戳）。 */
		function beijingHour(now) {
			return (new Date(now).getUTCHours() + 8) % 24;
		}

		/** 当前是否处于高峰时段（按北京时间判断）。 */
		function isPeakNow(now) {
			const h = beijingHour(now);
			return PEAK_HOURS.some(([start, end]) => h >= start && h < end);
		}

		/** 解析生效单价：官方抓取优先，回退内置；按生效日期与峰谷自动选择。 */
		function resolvePrices(official, now) {
			const table = official !== null && typeof official === "object" && official.legacy !== undefined && official.offpeak !== undefined && official.peak !== undefined
				? official
				: FALLBACK_PRICES;
			if (now < PRICE_CHANGE_EPOCH_UTC) return table.legacy;
			return isPeakNow(now) ? table.peak : table.offpeak;
		}

		/** token 用量 → 费用（人民币）。 */
		function costCny(totals, prices) {
			if (totals === null || typeof totals !== "object" || prices === null || typeof prices !== "object") return null;
			const uncached = Number(totals.uncachedInputTokens ?? 0);
			const cached = Number(totals.cacheReadTokens ?? 0);
			const output = Number(totals.outputTokens ?? 0);
			return (uncached * prices.inputPerM + cached * prices.cachedInputPerM + output * prices.outputPerM) / 1e6;
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
		function sessionBreakdown(today, prices) {
			if (today === null || !Array.isArray(today.sessions)) return null;
			const rows = today.sessions
				.map((s) => ({ id: s.id, cny: costCny(s.totals, prices) }))
				.filter((r) => r.cny !== null && r.cny > 0)
				.sort((a, b) => b.cny - a.cny);
			if (rows.length === 0) return null;
			return "今日各会话费用（估算）:\n" + rows.map((r) => "  " + r.id + ": " + formatYuan(r.cny)).join("\n");
		}

		/** 当前使用的价格表（tooltip 展示，便于与官方平台核查）。 */
		function pricingText(official, error) {
			const table = official !== null && typeof official === "object" && official.legacy !== undefined && official.offpeak !== undefined && official.peak !== undefined
				? official
				: FALLBACK_PRICES;
			const source = official !== null && official.source === "official"
				? "官方平台实时抓取" + (official.refreshedAt !== undefined ? " @" + new Date(official.refreshedAt).toLocaleString("zh-CN", { hour12: false }) : "")
				: (error !== null ? "官方抓取失败，回退内置价" : "内置价格（回退）");
			const f = (p) => "命中 " + p.cachedInputPerM + " · 未命中 " + p.inputPerM + " · 输出 " + p.outputPerM;
			return "价格(元/百万token) — " + source + "\n"
				+ "  当前(8/16前): " + f(table.legacy) + "\n"
				+ "  空闲(8/17起): " + f(table.offpeak) + "\n"
				+ "  高峰(8/17起): " + f(table.peak);
		}

		function CostMeter(props) {
			const useProjection = props.useProjection;
			const usage = useProjection("tokenUsage");
			const [balance, setBalance] = react.useState(null);
			const [balanceError, setBalanceError] = react.useState(null);
			const [today, setToday] = react.useState(null);
			const [todayError, setTodayError] = react.useState(null);
			const [officialPricing, setOfficialPricing] = react.useState(null);
			const [pricingError, setPricingError] = react.useState(null);
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
					fetch("/dsh-cost-meter/api/pricing")
						.then((r) => r.json())
						.then((d) => {
							if (!alive) return;
							if (d.ok === true) {
								setOfficialPricing(d);
								setPricingError(null);
							} else {
								setPricingError(d.error ?? "unknown");
							}
						})
						.catch((e) => {
							if (alive) {
								setPricingError(e instanceof Error ? e.message : String(e));
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

			const now = Date.now();
			const prices = resolvePrices(officialPricing, now);
			const sessionCost = costCny(usage, prices);
			const todayCost = costCny(today !== null ? today.totals : null, prices);
			const sessionCount = today !== null && Array.isArray(today.sessions) ? today.sessions.length : 0;
			const info = balanceInfo(balance);
			const balanceText = info !== null ? info.text : (balanceError !== null ? "获取失败" : "…");
			const todayText = todayCost !== null ? formatYuan(todayCost) + (sessionCount > 0 ? " (" + sessionCount + "会话)" : "") : (todayError !== null ? "—" : "…");
			const breakdown = sessionBreakdown(today, prices);
			const priceInfo = pricingText(officialPricing, pricingError);
			return react_jsx_runtime.jsx("div", {
				"data-dsh-cost-meter": "",
				...(info !== null && info.low ? { "data-warn": "" } : {}),
				title: (breakdown !== null ? breakdown + "\n\n" : "") + priceInfo,
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
