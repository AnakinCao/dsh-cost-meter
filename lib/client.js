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
		/** 周末低谷新规：2026-08-22 官方公告，自北京时间 2026-08-23（周日）00:00 起，
		 *  周末（周六/周日）全天不再区分峰谷时段，统一按低谷（空闲）时段价格计费。 */
		const WEEKEND_OFFPEAK_EPOCH_UTC = Date.UTC(2026, 7, 22, 16, 0, 0);
		/** 高峰时段（北京时间工作日小时区间；周末全天为低谷时段，见 isPeakNow）。 */
		const PEAK_HOURS = [[9, 12], [14, 18]];
		/** 余额告警阈值（CNY）：余额低于该值时状态栏变红。 */
		const BALANCE_WARN_CNY = 50;
		/** 刷新间隔（毫秒），与宿主路由缓存一致。 */
		const REFRESH_MS = 60000;
		/** 当前会话模型的轮询间隔（毫秒）——本地 RPC，开销极小，用于切换模型后价格近实时更新。 */
		const MODEL_REFRESH_MS = 2500;

		/** 北京时间小时（按给定时间戳）。 */
		function beijingHour(now) {
			return (new Date(now).getUTCHours() + 8) % 24;
		}

		/** 北京时间是否周六/周日（周末）。 */
		function isWeekendBeijing(now) {
			const day = new Date(now + 8 * 3600 * 1000).getUTCDay();
			return day === 0 || day === 6;
		}

		/** 当前是否处于高峰时段（按北京时间判断）：自 2026-08-23 起周末全天为低谷（空闲）时段。 */
		function isPeakNow(now) {
			if (now >= WEEKEND_OFFPEAK_EPOCH_UTC && isWeekendBeijing(now)) return false;
			const h = beijingHour(now);
			return PEAK_HOURS.some(([start, end]) => h >= start && h < end);
		}

		/** 按模型取价格表（flash/pro）：官方抓取优先，缺失字段（如已从官方页面下架的 legacy 旧价）回退内置。 */
		function tableFor(model, official) {
			const fallback = model === "deepseek-v4-pro" ? FALLBACK_PRICES.pro : FALLBACK_PRICES.flash;
			if (official !== null && typeof official === "object") {
				const entry = official[model === "deepseek-v4-pro" ? "pro" : "flash"];
				if (entry !== undefined && typeof entry === "object") {
					return { legacy: fallback.legacy, offpeak: fallback.offpeak, peak: fallback.peak, ...entry };
				}
			}
			return fallback;
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

		/** 价格段数据（当前模型 + 时段 + 单价，顺序：命中/未命中/输出）。 */
		function priceSegmentParts(official, now, model) {
			const p = resolvePrices(official, now, model);
			if (p === null) return null;
			const period = now >= PRICE_CHANGE_EPOCH_UTC ? (isPeakNow(now) ? "高峰" : "空闲") : "";
			return { model: modelLabel(model), period, hit: p.cachedInputPerM, miss: p.inputPerM, output: p.outputPerM };
		}

		/** 模型名缩写（tooltip 展示）。 */
		function modelLabel(model) {
			if (model === "deepseek-v4-pro") return "Pro";
			if (model === "deepseek-v4-flash") return "Flash";
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

		/** 会话显示名：宿主提供的 label（工作目录名，与 GUI 侧边栏一致）→ id 兜底；长标题截断。 */
		function sessionLabel(id, label) {
			if (id === undefined || id === null) return "";
			if (label === undefined || label === "") return id;
			return label.length > 48 ? label.slice(0, 48) + "…" : label;
		}

		/** 今日各会话费用明细（tooltip 用，含模型标注；子代理已合并进主会话，count>1 标注子任务数）。 */
		function sessionBreakdown(today, official, now) {
			if (today === null || !Array.isArray(today.sessions)) return null;
			// 会话总数与状态栏一致（全部根会话）；明细只列有费用的
			const totalRoots = today.sessions.length;
			const rows = today.sessions
				.map((s) => ({ id: s.id, label: s.label, count: s.count ?? 1, cny: sessionCostCny(s, official, now), model: (s.models !== undefined && s.models.length === 1) ? s.models[0] : null }))
				.filter((r) => r.cny > 0)
				.sort((a, b) => b.cny - a.cny);
			if (rows.length === 0) return null;
			const totalFiles = typeof today.files === "number" ? today.files : 0;
			let head = "今日各会话费用（估算，子任务已合并）:";
			if (totalFiles > totalRoots) {
				head += "（共" + totalFiles + "会话文件→" + totalRoots + "会话" + (rows.length < totalRoots ? "，" + rows.length + "有费用" : "") + "）";
			} else if (rows.length < totalRoots) {
				head += "（" + rows.length + "/" + totalRoots + "有费用）";
			}
			return head + "\n" + rows.map((r) => "  " + sessionLabel(r.id, r.label) + (r.count > 1 ? " (含" + (r.count - 1) + "子任务)" : "") + (r.model !== null ? " (" + modelLabel(r.model) + ")" : "") + ": " + formatYuan(r.cny)).join("\n");
		}

		/** 历史会话 token 构成展示文本（tooltip 用）：消耗占比 + 按项目。 */
		function tokenTypesText(d) {
			if (d === null || typeof d !== "object" || !Array.isArray(d.consumption) || d.consumption.length === 0) return null;
			const fmtNum = (n) => (n >= 10000 ? (n / 10000).toFixed(1) + "万" : String(Math.round(n)));
			const line1 = "历史 Token 构成（估算, " + d.scannedFiles + "会话文件, 输入≈" + fmtNum(d.realInputTokens) + "）:";
			const line2 = d.consumption.filter((x) => x.pct >= 0.1).map((x) => x.name + " " + x.pct.toFixed(1) + "%").join(" · ");
			const projs = Array.isArray(d.projects) ? d.projects.slice(0, 4) : [];
			const line3 = projs.length > 0 ? "按项目: " + projs.map((p) => p.name + " " + fmtNum(p.tokens)).join(" · ") : null;
			return [line1, line2, line3].filter(Boolean).join("\n");
		}

		/** 价格表（tooltip 展示）：官方抓取优先（缺失字段回退内置），否则内置。 */
		function priceTableOf(official) {
			if (official === null || typeof official !== "object" || official.flash === undefined || official.pro === undefined) return FALLBACK_PRICES;
			return {
				flash: tableFor("deepseek-v4-flash", official),
				pro: tableFor("deepseek-v4-pro", official)
			};
		}

		/** 价格来源文本（tooltip 首行）。 */
		function priceSourceText(official, error) {
			return official !== null && official.source === "official"
				? "价格(元/百万token) — 官方平台实时抓取" + (official.refreshedAt !== undefined ? " @" + new Date(official.refreshedAt).toLocaleString("zh-CN", { hour12: false }) : "")
				: "价格(元/百万token) — " + (error !== null ? "官方抓取失败，回退内置价" : "内置价格（回退）");
		}

		/** 一组价格的展示文本（顺序：命中/未命中/输出）。 */
		function priceCellsText(p) {
			return "命中" + p.cachedInputPerM + " · 未命中" + p.inputPerM + " · 输出" + p.outputPerM;
		}

		/** 价格对照表格（模型名加粗，列对齐）。"当前"列显示此刻实际生效的单价：生效日期前为旧价，之后按峰谷时段（周末全天为低谷）。 */
		function PriceTable({ table, now }) {
			const cell = (label, p) => react_jsx_runtime.jsx("span", { children: label + " " + priceCellsText(p) });
			const currentOf = (entry) => now < PRICE_CHANGE_EPOCH_UTC ? entry.legacy : (isPeakNow(now) ? entry.peak : entry.offpeak);
			return react_jsx_runtime.jsx("div", {
				className: "dshCostPrice",
				children: [
					react_jsx_runtime.jsx("span", { className: "dshCostPriceHdr", children: "模型" }),
					react_jsx_runtime.jsx("span", { className: "dshCostPriceHdr", children: "当前" }),
					react_jsx_runtime.jsx("span", { className: "dshCostPriceHdr", children: "空闲" }),
					react_jsx_runtime.jsx("span", { className: "dshCostPriceHdr", children: "高峰" }),
					react_jsx_runtime.jsx("b", { children: "Flash" }),
					cell("", currentOf(table.flash)),
					cell("", table.flash.offpeak),
					cell("", table.flash.peak),
					react_jsx_runtime.jsx("b", { children: "Pro" }),
					cell("", currentOf(table.pro)),
					cell("", table.pro.offpeak),
					cell("", table.pro.peak)
				]
			});
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
			const [tokenTypes, setTokenTypes] = react.useState(null);
			react.useEffect(() => {
				let alive = true;
				const readModel = () => {
					if (typeof props.readCurrentModel !== "function") return;
					props.readCurrentModel()
						.then((value) => {
							if (!alive) return;
							const model = value !== null && typeof value === "object" && value.current !== null && typeof value.current === "object"
								? (value.current.model ?? null)
								: null;
							setCurrentModel(model);
						})
						.catch(() => {});
				};
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
					fetch("/dsh-cost-meter/api/token-types")
						.then((r) => r.json())
						.then((d) => {
							if (!alive) return;
							if (d.ok === true) setTokenTypes(d);
						})
						.catch(() => {});
					// 当前会话选择的模型（session.models RPC）
					readModel();
				};
				load();
				const timer = setInterval(load, REFRESH_MS);
				// 模型切换近实时更新：独立快速轮询（本地 RPC，开销极小）
				const modelTimer = setInterval(readModel, MODEL_REFRESH_MS);
				return () => {
					alive = false;
					clearInterval(timer);
					clearInterval(modelTimer);
				};
			}, []);

			const now = Date.now();
			// 当前会话费用：优先用 /today 中匹配 sessionId（或其合并的子任务）的按模型分桶，回退投影 × 默认模型价
			const currentSession = today !== null && Array.isArray(today.sessions) && sessionId !== undefined
				? today.sessions.find((s) => s.id === sessionId || (Array.isArray(s.children) && s.children.includes(sessionId))) ?? null
				: null;
			const sessionCost = currentSession !== null
				? sessionCostCny(currentSession, officialPricing, now)
				: costCny(usage, resolvePrices(officialPricing, now, DEFAULT_MODEL));
			// 今日总费用：按会话 byModel 分桶 × 各自模型单价求和（避免混合模型时统一按 flash 价失真）
			let todayCost = null;
			if (today !== null && Array.isArray(today.sessions) && today.sessions.length > 0) {
				let total = 0;
				for (const s of today.sessions) {
					const c = sessionCostCny(s, officialPricing, now);
					if (c !== null) total += c;
				}
				todayCost = total;
			} else {
				todayCost = costCny(today !== null ? today.totals : null, resolvePrices(officialPricing, now, DEFAULT_MODEL));
			}
			// 会话计数：合并子任务后显示根会话数；文件数多于根数时在 tooltip 里标注（共N文件→M会话）
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
			const source = priceSourceText(officialPricing, pricingError);
			const priceTable = priceTableOf(officialPricing);
			const seg = priceSegmentParts(officialPricing, now, effectiveModel);
			const weekendNote = now >= WEEKEND_OFFPEAK_EPOCH_UTC && isWeekendBeijing(now) ? " · 周末全天按低谷(空闲)价计费" : "";
			const tipContentTitle = "当前模型: " + effectiveModel + "（实时单价，元/百万token: 命中/未命中/输出）" + weekendNote;
			// 主题化 tooltip（复刻官方 Tooltip 外观，替代原生 title）
			const [tipPos, setTipPos] = react.useState(null);
			const bubbleRef = react.useRef(null);
			const showTip = (e) => {
				const r = e.currentTarget.getBoundingClientRect();
				setTipPos({ top: r.top, bottom: r.bottom, x: r.left + r.width / 2 });
			};
			const hideTip = () => setTipPos(null);
			// 绝对定位：气泡锚定在状态栏元素上（不受祖先 transform 引起的坐标空间偏差影响）；
			// 仅当气泡超出视口顶部时翻转到下方
			react.useLayoutEffect(() => {
				if (tipPos === null || bubbleRef.current === null) return;
				const el = bubbleRef.current;
				el.dataset.side = "top";
				const r = el.getBoundingClientRect();
				if (r.top < 0) el.dataset.side = "bottom";
			}, [tipPos]);
			return react_jsx_runtime.jsx("div", {
				"data-dsh-cost-meter": "",
				...(info !== null && info.low ? { "data-warn": "" } : {}),
				onMouseEnter: showTip,
				onMouseLeave: hideTip,
				onFocus: showTip,
				onBlur: hideTip,
				tabIndex: 0,
				children: [
					react_jsx_runtime.jsx("span", { className: "dshCostModel", children: seg !== null ? [
						react_jsx_runtime.jsx("b", { children: seg.model }),
						" " + (seg.period !== "" ? seg.period + " " : "") + seg.hit + "/" + seg.miss + "/" + seg.output
					] : "模型 " + modelLabel(effectiveModel) }),
					react_jsx_runtime.jsx("span", { className: "dshCostSep", children: "·" }),
					react_jsx_runtime.jsx("span", { children: "今日 " + todayText }),
					react_jsx_runtime.jsx("span", { className: "dshCostSep", children: "·" }),
					react_jsx_runtime.jsx("span", { children: "会话 " + formatYuan(sessionCost) }),
					react_jsx_runtime.jsx("span", { className: "dshCostSep", children: "·" }),
					react_jsx_runtime.jsx("span", { children: "余额 " + balanceText }),
					tipPos !== null && react_jsx_runtime.jsx("span", {
						ref: bubbleRef,
						className: "dshCostTip",
						"data-side": "top",
						role: "tooltip",
						children: [
							breakdown !== null && react_jsx_runtime.jsx("div", { className: "dshCostTipPre", children: breakdown }),
							tokenTypesText(tokenTypes) !== null && react_jsx_runtime.jsx("div", { className: "dshCostTipSection dshCostTipPre", children: tokenTypesText(tokenTypes) }),
							react_jsx_runtime.jsx("div", { className: "dshCostTipSection", children: [
								react_jsx_runtime.jsx("div", { className: "dshCostTipPre", children: source }),
								react_jsx_runtime.jsx(PriceTable, { table: priceTable, now })
							] }),
							react_jsx_runtime.jsx("div", { className: "dshCostTipPre", children: tipContentTitle })
						]
					})
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
			"[data-dsh-cost-meter]{position:relative;display:flex;gap:10px;align-items:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;padding:4px 0 0;white-space:nowrap;flex:0 0 auto}",
			"[data-dsh-cost-meter] .dshCostSep{color:var(--dsw-alias-separator-primary)}",
			"[data-dsh-cost-meter][data-warn]{color:var(--dsw-alias-state-error-primary)}",
			"/* dock 槽位：含本插件时整体为居中 flex 行（与 live-stats 合并行一致） */",
			"div[data-slot=\"conversation.composer.dock\"]:has(> [data-dsh-cost-meter]){display:flex;flex-direction:row;align-items:center;justify-content:center;width:100%;box-sizing:border-box}",
			"div[data-slot=\"conversation.composer.dock\"]:has(> [data-dsh-cost-meter]) > *{margin:0}",
			"div[data-slot=\"conversation.composer.dock\"]:has(> [data-dsh-cost-meter]) > *:not([data-dsh-cost-meter]):not([role=\"tooltip\"]){width:auto;min-width:0;max-width:var(--dsh-chat-content-width);flex:0 1 auto}",
			"/* 与原有状态栏直接衔接：不再使用前置分隔符，行首即为模型名 */",
			"/* 主题化 tooltip 气泡（复刻官方 Tooltip 外观，随主题变量变化） */",
			".dshCostTip{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translate(-50%,0);z-index:100;width:max-content;max-width:50vw;padding:3px 7px;border-radius:8px;background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-bluish-00);font-size:13px;line-height:20px;overflow-wrap:break-word;pointer-events:none;animation:dshCostTipIn .15s var(--ds-ease-in-out)}",
			".dshCostTip[data-side=bottom]{bottom:auto;top:calc(100% + 8px)}",
			".dshCostTipPre{white-space:pre-line}",
			".dshCostTipSection{margin-top:4px}",
			".dshCostPrice{display:grid;grid-template-columns:auto auto auto auto;gap:2px 14px;align-items:baseline;margin-top:2px}",
			".dshCostPrice span{white-space:nowrap}",
			".dshCostPrice b{font-weight:700}",
			".dshCostPriceHdr{font-weight:500;opacity:.65}",
			".dshCostModel b{font-weight:700}",
			"@keyframes dshCostTipIn{from{opacity:0}}",
			"@media (prefers-reduced-motion:reduce){.dshCostTip{animation:none}}"
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
					readCurrentModel: () => {
						// DSH 0.1.2+：sessions.models RPC 已移除，当前模型改由 modelSelection 投影提供。
						// 投影值形如 { lastUsed: {provider,model,...}|null, next: {provider,model,...}|null }，
						// next 优先（挂起的模型选择），否则取 lastUsed。
						try {
							const binding = ctx.sessions?.binding?.(sessionId);
							const value = binding?.session?.projections?.get?.("modelSelection");
							if (value !== null && typeof value === "object") {
								const model = value.next?.model ?? value.lastUsed?.model ?? null;
								if (model !== null) return Promise.resolve({ current: { model } });
							}
						} catch { /* 投影不可用时回退旧 RPC / null */ }
						// DSH 0.1.1-：sessions.models RPC
						if (ctx.connection?.api?.sessions?.models !== undefined) {
							return ctx.connection.api.sessions.models({ sessionId })
								.then((r) => (r !== null && typeof r === "object" && r.result !== undefined ? r.result : r))
								.then((result) => (result !== null && result.ok === true ? result.value : null))
								.catch(() => null);
						}
						return Promise.resolve(null);
					}
				})
			}, CostMeterDockEntry));
		}

		exports.apply = apply;
		exports.inject = ["slots", "connection", "sessions"];
		return module.exports;
	}
});
