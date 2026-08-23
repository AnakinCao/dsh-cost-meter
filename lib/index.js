/**
 * dsh-cost-meter — host half。
 *
 * 提供两个路由（前缀 /dsh-cost-meter/api）：
 *  - GET /balance — DeepSeek 账户余额（官方 API，带缓存）；
 *  - GET /today   — 今日（本地时间 0 点起）全部会话的 token 用量聚合
 *    （扫描 ~/.dsh/sessions 下 zstd 分帧压缩的 session.jsonl.zstd）。
 *
 * API key 解析顺序：插件 config.apiKey → 环境变量 DEEPSEEK_API_KEY
 * → ~/.dsh/.credentials.yaml 中的 DEEPSEEK_API_KEY。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

export const name = "dsh-cost-meter";
export const inject = ["webServer"];

const BALANCE_ENDPOINT = "https://api.deepseek.com/user/balance";
const DEFAULT_REFRESH_MS = 60000;
const TIMEOUT_MS = 10000;
const ROUTE_PREFIX = "/dsh-cost-meter/api";
/** 官方定价页（中文站，价格单位为元/百万 token）。 */
const OFFICIAL_PRICING_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing";
/** 定价抓取刷新间隔（官方改价不频繁，1 小时足够）。 */
const PRICING_REFRESH_MS = 3600000;
/** zstd 帧魔数（会话文件为多个 zstd 帧拼接而成）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 解析 DeepSeek API key（config → 环境变量 → ~/.dsh/.credentials.yaml）。 */
function resolveApiKey(config, home) {
	if (typeof config?.apiKey === "string" && config.apiKey.length > 0) return config.apiKey;
	if (typeof process.env.DEEPSEEK_API_KEY === "string" && process.env.DEEPSEEK_API_KEY.length > 0) return process.env.DEEPSEEK_API_KEY;
	try {
		const raw = readFileSync(join(home, ".credentials.yaml"), "utf8");
		const match = raw.match(/^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^"'\s]+)["']?\s*$/m);
		if (match !== null && match[1].length > 0) return match[1];
	} catch {
		// 凭据文件不存在或不可读时忽略，返回 null
	}
	return null;
}

/** 本地时区今天 0 点的时间戳（ms）。 */
function startOfToday() {
	const d = new Date();
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/** 递归收集所有 session.jsonl.zstd 文件。 */
function collectZstdFiles(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...collectZstdFiles(p));
		} else if (entry.isFile() && entry.name === "session.jsonl.zstd") {
			out.push(p);
		}
	}
	return out;
}

/** 逐帧解压（每个帧内是一段 JSONL 文本）。 */
function decompressFrames(buf) {
	const out = [];
	const pos = [];
	let p = 0;
	while ((p = buf.indexOf(ZSTD_MAGIC, p)) !== -1) {
		pos.push(p);
		p += 4;
	}
	pos.push(buf.length);
	for (let i = 0; i < pos.length - 1; i++) {
		try {
			out.push(zstdDecompressSync(buf.subarray(pos[i], pos[i + 1])));
		} catch {
			// 跳过坏帧
		}
	}
	return out;
}

/** 与客户端同源的 usage 采样提取（assistant/chunk 的 usage chunk 或 assistant/message 的 usage）。 */
function usageSampleOf(event) {
	const item = event;
	const usage = item.type === "assistant/chunk" && item.data.chunk?.type === "usage"
		? item.data.chunk.usage
		: item.type === "assistant/message"
			? item.data.usage
			: undefined;
	return usage === undefined || item.data.turn === undefined || item.data.step === undefined
		? undefined
		: { turn: item.data.turn, step: item.data.step, usage };
}

/**
 * 聚合今日（本地 0 点起）每个会话的 token 用量。
 * 与官方 tokenUsage 投影同款去重逻辑：同一 (turn, step) 的后续采样是累计值，
 * 只累计增量（last 在零点前也持续维护，避免跨零点 step 的用量被整段计入今日）。
 * 按 request/header 事件识别每个会话使用的模型（byModel 分桶）。
 * 仅扫描 mtime 在今天之后的文件（旧文件不可能含今日事件）。
 * 子代理会话按 parentSession 合并进根主会话（见 mergeSubagentSessions）。
 * @returns { sessions: [{id, label, count, children, models, byModel, totals}], totals, since, files }
 */
function sumTodayTokens(sessionsDir) {
	const since = startOfToday();
	const empty = () => ({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
	const grand = empty();
	let files = [];
	try {
		files = collectZstdFiles(sessionsDir);
	} catch {
		return { sessions: [], totals: grand, since, files: 0 };
	}
	const sessions = [];
	let scanned = 0;
	// 跨会话去重：DSH 子代理会话文件会携带父会话的完整事件副本，
	// 同一批 API 请求会出现在父会话与多个子代理会话文件中（时间戳/用量完全相同）。
	// 以 (time, turn, step, 三项用量) 为指纹，全局只计一次，避免重复计费。
	const seen = new Set();
	for (const file of files) {
		let st;
		try {
			st = statSync(file);
		} catch {
			continue;
		}
		if (st.mtimeMs < since) continue;
		scanned += 1;
		let buf;
		try {
			buf = readFileSync(file);
		} catch {
			continue;
		}
		const sessionTotals = empty();
		const byModel = Object.create(null);
		let currentModel = null;
		let last = null;
		let meta = null;
		for (const frame of decompressFrames(buf)) {
			for (const line of frame.toString("utf8").split("\n")) {
				if (line === "") continue;
				let event;
				try {
					event = JSON.parse(line);
				} catch {
					continue;
				}
				// 会话元数据（首事件）：记录 id、父会话与工作目录，用于合并子任务与派生显示名
				if (meta === null && event.type === "session") {
					meta = {
						id: event.id ?? event.data?.id ?? null,
						parent: event.parentSession ?? event.data?.parentSession ?? null,
						cwd: event.cwd ?? event.data?.cwd ?? null
					};
					continue;
				}
				// 识别当前使用的模型（request/header 携带 config.model）
				if (event.type === "request/header" && event.data?.header?.config?.model !== undefined) {
					currentModel = event.data.header.config.model;
					continue;
				}
				const sample = usageSampleOf(event);
				if (sample === undefined) continue;
				const inWindow = typeof event.time === "number" && event.time >= since;
				const buckets = {
					uncachedInputTokens: sample.usage.inputTokens,
					outputTokens: sample.usage.outputTokens,
					cacheReadTokens: sample.usage.cacheReadTokens ?? 0,
					cacheWriteTokens: sample.usage.cacheWriteTokens ?? 0
				};
				// 跨文件去重：同一请求（相同时间/轮次/步骤/用量）已在其他会话文件中统计过则跳过
				if (inWindow) {
					const fp = event.time + "|" + sample.turn + "." + sample.step
						+ "|" + buckets.uncachedInputTokens + "|" + buckets.cacheReadTokens + "|" + buckets.outputTokens;
					if (seen.has(fp)) continue;
					seen.add(fp);
				}
				const previous = last !== null && last.turn === sample.turn && last.step === sample.step ? last.buckets : null;
				if (inWindow) {
					const delta = {
						uncachedInputTokens: buckets.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0),
						outputTokens: buckets.outputTokens - (previous?.outputTokens ?? 0),
						cacheReadTokens: buckets.cacheReadTokens - (previous?.cacheReadTokens ?? 0),
						cacheWriteTokens: buckets.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0)
					};
					const model = currentModel ?? "unknown";
					if (byModel[model] === undefined) byModel[model] = empty();
					for (const key of Object.keys(delta)) {
						sessionTotals[key] += delta[key];
						byModel[model][key] += delta[key];
					}
				}
				last = { turn: sample.turn, step: sample.step, buckets };
			}
		}
		sessions.push({ id: file.split(/[\\/]/).slice(-2)[0], meta, models: Object.keys(byModel), byModel, totals: sessionTotals });
		for (const key of Object.keys(grand)) grand[key] += sessionTotals[key];
	}
	// 把子代理（subagent）会话合并进其根主会话：按 parentSession 向上找根，
	// 合并后的条目包含 count（合并了几个文件）与 children（子会话 id 列表）。
	// 去重后的各文件 totals 互不重叠，直接求和即为该组全部唯一请求的用量。
	const merged = mergeSubagentSessions(sessions, empty);
	return { sessions: merged, totals: grand, since, files: scanned };
}

/**
 * 将子代理会话合并到根主会话（返回新的合并数组，不改动入参）。
 * @param sessions 原始会话条目（含 meta.parent / meta.cwd）
 * @param empty 空桶工厂
 * @returns [{id, label, count, children, models, byModel, totals}]
 */
function mergeSubagentSessions(sessions, empty) {
	const bySessionId = new Map();
	for (const s of sessions) {
		if (s.meta !== null && s.meta !== undefined && s.meta.id !== null) bySessionId.set(s.meta.id, s);
	}
	const roots = [];
	const byRootId = new Map();
	for (const s of sessions) {
		// 向上追溯根主会话（子代理的 parent 可能也是子代理，最多 10 层防环）
		let root = s;
		let guard = 0;
		while (root.meta !== null && root.meta !== undefined && root.meta.parent !== null && bySessionId.has(root.meta.parent) && guard++ < 10) {
			root = bySessionId.get(root.meta.parent);
		}
		const rootId = root.meta !== null && root.meta !== undefined && root.meta.id !== null ? root.meta.id : s.id;
		let m = byRootId.get(rootId);
		if (m === undefined) {
			// 显示名：工作目录名（与 GUI 侧边栏同款）→ id 兜底；DSH 会话无持久化 title
			let label = "";
			const cwd = root.meta !== null && root.meta !== undefined ? root.meta.cwd : null;
			if (typeof cwd === "string" && cwd !== "") {
				label = cwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "";
			}
			if (label === "") label = rootId;
			m = { id: rootId, label, count: 0, children: [], models: [], byModel: Object.create(null), totals: empty() };
			byRootId.set(rootId, m);
			roots.push(m);
		}
		m.count += 1;
		if (s !== root) m.children.push(s.id);
		for (const model of s.models) {
			if (!m.models.includes(model)) m.models.push(model);
		}
		if (s.byModel !== null && s.byModel !== undefined) {
			for (const [model, t] of Object.entries(s.byModel)) {
				if (m.byModel[model] === undefined) m.byModel[model] = empty();
				for (const key of Object.keys(t)) m.byModel[model][key] += t[key];
			}
		}
		for (const key of Object.keys(m.totals)) m.totals[key] += s.totals[key];
	}
	return roots;
}

/** 从官方定价页 HTML 解析 deepseek-v4-flash / v4-pro 价格（元/百万 token）。解析失败返回 null。
 *  当前页面结构：单张价格表，3 个模型列（Flash-0731 / Pro-0813 / Flash-Vision-Exp），
 *  行序为 缓存命中 → 缓存未命中 → 输出，每行含「空闲时段 n元 n元 n元」与「高峰时段 n元 n元 n元」。
 *  仅取前两列（flash/pro；vision 与 flash 同价，忽略）。legacy 旧价已从官方页面移除，不再返回。 */
function parseOfficialPricing(html) {
	const text = html
		.replace(/<script[\s\S]*?<\/script>/g, " ")
		.replace(/<style[\s\S]*?<\/style>/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;|&#160;/g, " ")
		.replace(/\s+/g, " ");
	const cell = (matches, row, col) => {
		const m = matches[row];
		if (m === undefined) return null;
		const v = Number(m[col]);
		return Number.isFinite(v) ? v : null;
	};
	const valid = (p) => p !== null
		&& p.cachedInputPerM !== null && p.cachedInputPerM > 0
		&& p.inputPerM !== null && p.inputPerM > p.cachedInputPerM
		&& p.outputPerM !== null && p.outputPerM > p.inputPerM
		&& p.outputPerM < 100;
	// 每行 3 个数字 = [flash, pro, vision]；行序 0=缓存命中 1=缓存未命中 2=输出
	const offpeakMatches = [...text.matchAll(/空闲时段\s*([\d.]+)元\s*([\d.]+)元\s*([\d.]+)元/g)];
	const peakMatches = [...text.matchAll(/高峰时段\s*([\d.]+)元\s*([\d.]+)元\s*([\d.]+)元/g)];
	if (offpeakMatches.length < 3 || peakMatches.length < 3) return null;
	const offpeak = {
		flash: { cachedInputPerM: cell(offpeakMatches, 0, 1), inputPerM: cell(offpeakMatches, 1, 1), outputPerM: cell(offpeakMatches, 2, 1) },
		pro: { cachedInputPerM: cell(offpeakMatches, 0, 2), inputPerM: cell(offpeakMatches, 1, 2), outputPerM: cell(offpeakMatches, 2, 2) }
	};
	const peak = {
		flash: { cachedInputPerM: cell(peakMatches, 0, 1), inputPerM: cell(peakMatches, 1, 1), outputPerM: cell(peakMatches, 2, 1) },
		pro: { cachedInputPerM: cell(peakMatches, 0, 2), inputPerM: cell(peakMatches, 1, 2), outputPerM: cell(peakMatches, 2, 2) }
	};
	return valid(offpeak.flash) && valid(offpeak.pro) && valid(peak.flash) && valid(peak.pro)
		? { flash: { offpeak: offpeak.flash, peak: peak.flash }, pro: { offpeak: offpeak.pro, peak: peak.pro } }
		: null;
}

/** 抓取官方定价（失败返回 null，调用方回退内置常量）。 */
async function fetchOfficialPricing() {
	try {
		const res = await fetch(OFFICIAL_PRICING_URL, { signal: AbortSignal.timeout(15000) });
		if (!res.ok) return null;
		return parseOfficialPricing(await res.text());
	} catch {
		return null;
	}
}

export function apply(ctx, config = {}) {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const apiKey = resolveApiKey(config, home);
	const refreshMs = Number(config.refreshMs ?? process.env.DSH_COST_METER_REFRESH_MS ?? DEFAULT_REFRESH_MS) || DEFAULT_REFRESH_MS;
	let cacheBalance = { at: 0, payload: null };
	let cacheToday = { at: 0, payload: null };
	let cachePricing = { at: 0, payload: null };

	const readPricing = async () => {
		if (cachePricing.payload !== null && Date.now() - cachePricing.at < PRICING_REFRESH_MS) return cachePricing.payload;
		const parsed = await fetchOfficialPricing();
		cachePricing = { at: Date.now(), payload: parsed };
		return parsed;
	};

	const readBalance = async () => {
		if (cacheBalance.payload !== null && Date.now() - cacheBalance.at < refreshMs) return cacheBalance.payload;
		if (apiKey === null) return { ok: false, error: "no-api-key" };
		try {
			const res = await fetch(BALANCE_ENDPOINT, {
				headers: {
					Authorization: `Bearer ${apiKey}`,
					Accept: "application/json"
				},
				signal: AbortSignal.timeout(TIMEOUT_MS)
			});
			const text = await res.text();
			let data;
			try {
				data = JSON.parse(text);
			} catch {
				data = { raw: text.slice(0, 200) };
			}
			if (!res.ok) return { ok: false, error: `http-${res.status}`, detail: data };
			cacheBalance = { at: Date.now(), payload: { ok: true, balance: data } };
			return cacheBalance.payload;
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	};

	const readToday = () => {
		if (cacheToday.payload !== null && Date.now() - cacheToday.at < refreshMs) return cacheToday.payload;
		const result = sumTodayTokens(join(home, "sessions"));
		cacheToday = { at: Date.now(), payload: { ok: true, ...result } };
		return cacheToday.payload;
	};

	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			if (req.method !== "GET" && req.method !== "HEAD") {
				res.writeHead(405);
				res.end();
				return;
			}
			const url = new URL(req.url ?? "/", "http://x");
			const sub = url.pathname.slice(ROUTE_PREFIX.length);
			let payload;
			if (sub === "/balance") {
				payload = await readBalance();
			} else if (sub === "/today") {
				payload = readToday();
			} else if (sub === "/pricing") {
				const parsed = await readPricing();
				payload = parsed !== null
					? { ok: true, ...parsed, source: "official" }
					: { ok: false, error: "pricing-fetch-failed", fallback: true };
			} else {
				res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ ok: false, error: "not-found" }));
				return;
			}
			const body = JSON.stringify({ ...payload, refreshedAt: new Date().toISOString() });
			res.writeHead(200, {
				"content-type": "application/json; charset=utf-8",
				"cache-control": "no-store"
			});
			res.end(body);
		}
	}), "dsh-cost-meter: api routes");
}
