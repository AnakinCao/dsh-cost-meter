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
 * 聚合今日（本地 0 点起）所有会话的 token 用量。
 * 与官方 tokenUsage 投影同款去重逻辑：同一 (turn, step) 的后续采样是累计值，
 * 只累计增量。仅扫描 mtime 在今天之后的文件（旧文件不可能含今日事件）。
 */
function sumTodayTokens(sessionsDir) {
	const since = startOfToday();
	const totals = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
	let files = [];
	try {
		files = collectZstdFiles(sessionsDir);
	} catch {
		return { totals, since, files: 0 };
	}
	let scanned = 0;
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
		let last = null;
		for (const frame of decompressFrames(buf)) {
			for (const line of frame.toString("utf8").split("\n")) {
				if (line === "") continue;
				let event;
				try {
					event = JSON.parse(line);
				} catch {
					continue;
				}
				const sample = usageSampleOf(event);
				if (sample === undefined) continue;
				if (typeof event.time !== "number" || event.time < since) continue;
				const buckets = {
					uncachedInputTokens: sample.usage.inputTokens,
					outputTokens: sample.usage.outputTokens,
					cacheReadTokens: sample.usage.cacheReadTokens ?? 0,
					cacheWriteTokens: sample.usage.cacheWriteTokens ?? 0
				};
				const previous = last !== null && last.turn === sample.turn && last.step === sample.step ? last.buckets : null;
				totals.uncachedInputTokens += buckets.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0);
				totals.outputTokens += buckets.outputTokens - (previous?.outputTokens ?? 0);
				totals.cacheReadTokens += buckets.cacheReadTokens - (previous?.cacheReadTokens ?? 0);
				totals.cacheWriteTokens += buckets.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0);
				last = { turn: sample.turn, step: sample.step, buckets };
			}
		}
	}
	return { totals, since, files: scanned };
}

export function apply(ctx, config = {}) {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const apiKey = resolveApiKey(config, home);
	const refreshMs = Number(config.refreshMs ?? process.env.DSH_COST_METER_REFRESH_MS ?? DEFAULT_REFRESH_MS) || DEFAULT_REFRESH_MS;
	let cacheBalance = { at: 0, payload: null };
	let cacheToday = { at: 0, payload: null };

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
