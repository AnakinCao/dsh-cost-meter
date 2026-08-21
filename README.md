# dsh-cost-meter

> 简体中文: [README.zh.md](README.zh.md)

A DSH Web GUI plugin that shows **DeepSeek session cost estimates** and **account balance** in the bottom status bar.

## Features

In the bottom status bar below the input box (the `conversation.composer.dock` slot, same row as the live-stats stats line; actual labels follow the UI locale):

```
stats row · TPS Flash off-peak 0.05/1.5/4.5 · Today ¥11.52 (5 sessions) · Session ¥0.08 · Balance ¥365.36
```

- **Current model live price**: reads the current session's selected model via the `session.models` RPC and shows its live unit price (order: cache hit / cache miss / output, CNY per 1M tokens, model name bold); peak/off-peak pricing switches automatically; updates within ~2.5s after switching the model in the composer.
- **Themed tooltip**: hover/focus shows a bubble matching the current theme (`--dsw-alias-tooltip-bg`) with a per-session cost breakdown, an aligned Flash/Pro price table (bold model names), and the price source with fetch time.
- **Today / session cost**: prices are fetched live from the official DeepSeek pricing page (`api-docs.deepseek.com/zh-cn/quick_start/pricing`, CNY per 1M tokens, 1h cache) and auto-follow official changes, covering both deepseek-v4-flash and deepseek-v4-pro; falls back to built-in constants (kept in sync with the official page) when the fetch fails. Pricing auto-selects by effective date (2026-08-17 00:00 Beijing) and peak/off-peak hours (Beijing 9-12, 14-18 peak).
- **Per-model billing**: the host detects each session's model from session records (`request/header` events) and computes cost with the matching price set.
- **Per-session aggregation**: today's cost is aggregated per session (the host scans the zstd multi-frame session files under `~/.dsh/sessions`); hover to inspect each session's breakdown.
- **Balance**: queried every 60s from the official `GET https://api.deepseek.com/user/balance` (cached), CNY preferred.
- **Balance warning**: turns the whole row red when the CNY balance drops below `BALANCE_WARN_CNY` (default 50).

## Install

```bash
dsh plugin --profile web add https://github.com/AnakinCao/dsh-cost-meter.git
# restart dsh web
```

Or no-restart manual mount: put `lib` + `cordis.patch.yml` into `~/.dsh/profiles/web/node_modules/dsh-cost-meter/`, then append to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-cost-meter
      name: 'dsh-cost-meter'
```

Refresh the page once.

> Pick ONE method — never mount twice.

## API key (required for balance)

Resolved in order (any one suffices):

1. Plugin config `config.apiKey` (loader entry config);
2. Environment variable `DEEPSEEK_API_KEY`;
3. `DEEPSEEK_API_KEY` in `~/.dsh/.credentials.yaml` (the DSH official credentials file — matched by default).

Without a key the status bar shows "balance fetch failed"; costs still display normally.

## Tuning

Constants at the top of `lib/client.js` (changes hot-apply via HMR in ~0.5s):

- `FALLBACK_PRICES` — built-in fallback prices when the official fetch fails (flash/pro × legacy/off-peak/peak)
- `BALANCE_WARN_CNY` (default `50`) — balance warning threshold
- `MODEL_REFRESH_MS` (default `2500`) — model polling interval (local RPC, negligible cost)
- `REFRESH_MS` (default `60000`) — balance/today/pricing refresh interval

Host cache: env `DSH_COST_METER_REFRESH_MS` or `config.refreshMs` (default 60000ms).

## Notes

- Costs are estimates (official unit prices × usage); the authoritative bill is the DeepSeek platform.
- Balance/pricing calls run in the host process (the API key never leaves the browser); routes: `/dsh-cost-meter/api/balance`, `/today`, `/pricing`.
- No token consumption: cost reads local session logs; balance/pricing use account/docs endpoints — no model inference, no billing.
- Uninstall: remove the profile patch insert + delete `node_modules/dsh-cost-meter`.

## License

MIT
