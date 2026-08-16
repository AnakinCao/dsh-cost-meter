/**
 * dsh-cost-meter — host half。
 *
 * 提供 DeepSeek 账户余额查询路由（/dsh-cost-meter/api/balance）：
 * - API key 解析顺序：插件 config.apiKey → 环境变量 DEEPSEEK_API_KEY
 *   → ~/.dsh/.credentials.yaml 中的 DEEPSEEK_API_KEY；
 * - 结果按 refreshMs（默认 60s）缓存，避免频繁请求官方 API；
 * - 余额接口：GET https://api.deepseek.com/user/balance。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "dsh-cost-meter";
export const inject = ["webServer"];

const BALANCE_ENDPOINT = "https://api.deepseek.com/user/balance";
const DEFAULT_REFRESH_MS = 60000;
const TIMEOUT_MS = 10000;
const ROUTE_PREFIX = "/dsh-cost-meter/api";

/** 解析 DeepSeek API key（config → 环境变量 → ~/.dsh/.credentials.yaml）。 */
function resolveApiKey(config) {
	if (typeof config?.apiKey === "string" && config.apiKey.length > 0) return config.apiKey;
	if (typeof process.env.DEEPSEEK_API_KEY === "string" && process.env.DEEPSEEK_API_KEY.length > 0) return process.env.DEEPSEEK_API_KEY;
	try {
		const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
		const raw = readFileSync(join(home, ".credentials.yaml"), "utf8");
		const match = raw.match(/^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^"'\s]+)["']?\s*$/m);
		if (match !== null && match[1].length > 0) return match[1];
	} catch {
		// 凭据文件不存在或不可读时忽略，返回 null
	}
	return null;
}

export function apply(ctx, config = {}) {
	const apiKey = resolveApiKey(config);
	const refreshMs = Number(config.refreshMs ?? process.env.DSH_COST_METER_REFRESH_MS ?? DEFAULT_REFRESH_MS) || DEFAULT_REFRESH_MS;
	let cache = { at: 0, payload: null };

	const readBalance = async () => {
		if (cache.payload !== null && Date.now() - cache.at < refreshMs) return cache.payload;
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
			cache = { at: Date.now(), payload: { ok: true, balance: data } };
			return cache.payload;
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
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
			if (sub === "/balance") {
				const payload = await readBalance();
				const body = JSON.stringify({ ...payload, refreshedAt: new Date().toISOString() });
				res.writeHead(200, {
					"content-type": "application/json; charset=utf-8",
					"cache-control": "no-store"
				});
				res.end(body);
				return;
			}
			res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ ok: false, error: "not-found" }));
		}
	}), "dsh-cost-meter: api routes");
}
