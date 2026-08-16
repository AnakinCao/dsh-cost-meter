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
			flash: {
				legacy: { inputPerM: 1.0, cachedInputPerM: 0.02, outputPerM: 2.0 },
				offpeak: { inputPerM: 1.5, cachedInputPerM: 0.05, outputPerM: 4.5 },
				peak: { inputPerM: 3.0, cachedInputPerM: 0.1, outputPerM: 9.0 }
			},
			pro: {
				legacy: { inputPerM: 3.0, cachedInputPerM: 0.025, outputPerM: 6.0 },
				offpeak: { inputPerM: 4.5, cachedInputPerM: 0.15, outputPerM: 13.5 },
				peak: { inputPerM: 9.0, cachedInputPerM: 0.3, outputPerM: 27.0 }
			}
		};
		/** 默认模型（未知模型/回退时按 flash 计价）。 */
		const DEFAULT_MODEL = "deepseek-v4-flash";
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

		/** 按模型取价格表（flash/pro）。 */
		function tableFor(model, official) {
			const table = official !== null && typeof official === "object" && official.flash !== undefined && official.pro !== undefined
				? official
				: FALLBACK_PRICES;
			return model === "deepseek-v4-pro" ? table.pro : table.flash;
		}

		/** 解析生效单价：官方抓取优先，回退内置；按模型、生效日期与峰谷自动选择。 */
		function resolvePrices(official, now, model) {
			const set = tableFor(model, official);
			if (now < PRICE_CHANGE_EPOCH_UTC) return set.legacy;
			return isPeakNow(now) ? set.peak : set.offpeak;
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

		/** 价格段展示（当前模型 + 时段 + 单价），如 "v4-flash 空闲 1.5/0.05/4.5"。 */
		function priceSegment(official, now, model) {
			const p = resolvePrices(official, now, model);
			if (p === null) return null;
			const period = now < PRICE_CHANGE_EPOCH_UTC ? "旧价" : (isPeakNow(now) ? "高峰" : "空闲");
			return modelLabel(model) + " " + period + " " + p.inputPerM + "/" + p.cachedInputPerM + "/" + p.outputPerM;
		}

		/** 模型名缩写（tooltip 展示）。 */
		function modelLabel(model) {
			if (model === "deepseek-v4-pro") return "v4-pro";
			if (model === "deepseek-v4-flash") return "v4-flash";
			return model;
		}

		/** 单个会话费用：按 byModel 分桶 × 对应模型单价求和；无分桶时按默认模型。 */
		function sessionCostCny(session, official, now) {
			let total = 0;
			if (session !== null && typeof session === "object" && session.byModel !== undefined) {
				for (const [model, t] of Object.entries(session.byModel)) {
					const c = costCny(t, resolvePrices(official, now, model));
					if (c !== null) total += c;
				}
			} else if (session !== null && typeof session === "object" && session.totals !== undefined) {
				const c = costCny(session.totals, resolvePrices(official, now, DEFAULT_MODEL));
				if (c !== null) total += c;
			}
			return total;
		}

		/** 今日各会话费用明细（tooltip 用，含模型标注）。 */
		function sessionBreakdown(today, official, now) {
			if (today === null || !Array.isArray(today.sessions)) return null;
			const rows = today.sessions
				.map((s) => ({ id: s.id, cny: sessionCostCny(s, official, now), model: (s.models !== undefined && s.models.length === 1) ? s.models[0] : null }))
				.filter((r) => r.cny > 0)
				.sort((a, b) => b.cny - a.cny);
			if (rows.length === 0) return null;
			return "今日各会话费用（估算）:\n" + rows.map((r) => "  " + r.id + (r.model !== null ? " (" + modelLabel(r.model) + ")" : "") + ": " + formatYuan(r.cny)).join("\n");
		}

		/** 当前使用的价格表（tooltip 展示，便于与官方平台核查）。 */
		function pricingText(official, error) {
			const table = official !== null && typeof official === "object" && official.flash !== undefined && official.pro !== undefined
				? official
				: FALLBACK_PRICES;
			const source = official !== null && official.source === "official"
				? "官方平台实时抓取" + (official.refreshedAt !== undefined ? " @" + new Date(official.refreshedAt).toLocaleString("zh-CN", { hour12: false }) : "")
				: (error !== null ? "官方抓取失败，回退内置价" : "内置价格（回退）");
			const f = (p) => "命中 " + p.cachedInputPerM + " · 未命中 " + p.inputPerM + " · 输出 " + p.outputPerM;
			const row = (name, set) => "  " + name + ": 当前 " + f(set.legacy) + " | 空闲 " + f(set.offpeak) + " | 高峰 " + f(set.peak);
			return "价格(元/百万token) — " + source + "\n" + row("v4-flash", table.flash) + "\n" + row("v4-pro  ", table.pro);
		}

		function CostMeter(props) {
			const useProjection = props.useProjection;
			const sessionId = props.sessionId;
			const usage = useProjection("tokenUsage");
			const [balance, setBalance] = react.useState(null);
			const [balanceError, setBalanceError] = react.useState(null);
			const [today, setToday] = react.useState(null);
			const [todayError, setTodayError] = react.useState(null);
			const [officialPricing, setOfficialPricing] = react.useState(null);
			const [pricingError, setPricingError] = react.useState(null);
			const [currentModel, setCurrentModel] = react.useState(null);
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
					// 当前会话选择的模型（session.models RPC）
					if (typeof props.readCurrentModel === "function") {
						props.readCurrentModel()
							.then((value) => {
								if (!alive) return;
								const model = value !== null && typeof value === "object" && value.current !== null && typeof value.current === "object"
									? (value.current.model ?? null)
									: null;
								setCurrentModel(model);
							})
							.catch(() => {});
					}
				};
				load();
				const timer = setInterval(load, REFRESH_MS);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, []);

			const now = Date.now();
			// 当前会话费用：优先用 /today 中匹配 sessionId 的按模型分桶，回退投影 × 默认模型价
			const currentSession = today !== null && Array.isArray(today.sessions) && sessionId !== undefined
				? today.sessions.find((s) => s.id === sessionId) ?? null
				: null;
			const sessionCost = currentSession !== null
				? sessionCostCny(currentSession, officialPricing, now)
				: costCny(usage, resolvePrices(officialPricing, now, DEFAULT_MODEL));
			const todayCost = costCny(today !== null ? today.totals : null, resolvePrices(officialPricing, now, DEFAULT_MODEL));
			const sessionCount = today !== null && Array.isArray(today.sessions) ? today.sessions.length : 0;
			// 当前模型：RPC 选择优先 → /today 会话检测 → 默认模型
			const detectedModel = currentSession !== null && currentSession.models !== undefined && currentSession.models.length === 1
				? currentSession.models[0]
				: null;
			const effectiveModel = currentModel ?? detectedModel ?? DEFAULT_MODEL;
			const info = balanceInfo(balance);
			const balanceText = info !== null ? info.text : (balanceError !== null ? "获取失败" : "…");
			const todayText = todayCost !== null ? formatYuan(todayCost) + (sessionCount > 0 ? " (" + sessionCount + "会话)" : "") : (todayError !== null ? "—" : "…");
			const breakdown = sessionBreakdown(today, officialPricing, now);
			const priceInfo = pricingText(officialPricing, pricingError);
			const priceSeg = priceSegment(officialPricing, now, effectiveModel);
			const titleExtra = "当前模型: " + effectiveModel + "（实时单价，元/百万token: 未命中/缓存命中/输出）";
			return react_jsx_runtime.jsx("div", {
				"data-dsh-cost-meter": "",
				...(info !== null && info.low ? { "data-warn": "" } : {}),
				title: (breakdown !== null ? breakdown + "\n\n" : "") + priceInfo + "\n\n" + titleExtra,
				children: [
					react_jsx_runtime.jsx("span", { children: "今日 " + todayText }),
					react_jsx_runtime.jsx("span", { className: "dshCostSep", children: "·" }),
					react_jsx_runtime.jsx("span", { children: "会话 " + formatYuan(sessionCost) }),
					react_jsx_runtime.jsx("span", { className: "dshCostSep", children: "·" }),
					react_jsx_runtime.jsx("span", { children: priceSeg !== null ? priceSeg : "模型 " + modelLabel(effectiveModel) }),
					react_jsx_runtime.jsx("span", { className: "dshCostSep", children: "·" }),
					react_jsx_runtime.jsx("span", { children: "余额 " + balanceText })
				]
			});
		}

		function CostMeterDockEntry(props) {
			return react_jsx_runtime.jsx(CostMeter, {
				useProjection: props.useProjection,
				sessionId: props.sessionId,
				readCurrentModel: props.readCurrentModel
			});
		}

		// 样式注入（与官方插件一致：<style data-plugin="dsh-cost-meter">）
		// 间距：与 live-stats 的合并行同款——dock 槽位为居中 flex 行，项目之间用 "·" 分隔；
		// 不依赖 margin:0 auto（flex 下 auto 边距会把项目撑开）。
		const CSS = [
			"/* dsh-cost-meter: 底部状态栏费用/余额 */",
			"[data-dsh-cost-meter]{display:flex;gap:10px;align-items:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap;flex:0 0 auto}",
			"[data-dsh-cost-meter] .dshCostSep{color:var(--dsw-alias-separator-primary)}",
			"[data-dsh-cost-meter][data-warn]{color:var(--dsw-alias-state-error-primary)}",
			"/* dock 槽位：含本插件时整体为居中 flex 行（与 live-stats 合并行一致） */",
			"div[data-slot=\"conversation.composer.dock\"]:has(> [data-dsh-cost-meter]){display:flex;flex-direction:row;align-items:center;justify-content:center;width:100%;box-sizing:border-box}",
			"div[data-slot=\"conversation.composer.dock\"]:has(> [data-dsh-cost-meter]) > *{margin:0}",
			"div[data-slot=\"conversation.composer.dock\"]:has(> [data-dsh-cost-meter]) > *:not([data-dsh-cost-meter]):not([role=\"tooltip\"]){width:auto;min-width:0;max-width:var(--dsh-chat-content-width);flex:0 1 auto}",
			"/* 与其他项目之间的分隔点（参照原状态栏 “·” 分隔样式） */",
			"div[data-slot=\"conversation.composer.dock\"] > * + [data-dsh-cost-meter]::before{content:\"\\B7\";color:var(--dsw-alias-separator-primary);margin:0 10px}"
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
				inject: (sessionId) => ({
					sessionId,
					readCurrentModel: () => ctx.connection.api.sessions.models({ sessionId })
						.then((r) => (r !== null && typeof r === "object" && r.result !== undefined ? r.result : r))
						.then((result) => (result !== null && result.ok === true ? result.value : null))
						.catch(() => null)
				})
			}, CostMeterDockEntry));
		}

		exports.apply = apply;
		exports.inject = ["slots", "connection"];
		return module.exports;
	}
});
