# magpie-unisound

OpenCode provider plugin that brings **Unisound Token Hub** ([maas.unisound.com](https://maas.unisound.com)) **U Plan** models into [magpie](https://usemagpie.ai). Built for U Plan (Token Plan) users: point-based costs, dual-pool quota windows, and gift-quota vision.

> 中文说明：[README.md](./README.md)

## Features

- **API key sign-in**: one Token Plan key (`tp-…`, issued at Console › Subscription › U Plan)
- **U Plan whitelist**: only U Plan chat models are exposed. The flagship `u2` and third-party models (DeepSeek / Kimi / GLM / Qwen…) are pay-as-you-go and stay out of the catalog — a Token Plan key cannot call them, and a metered key calling them spends real money
- **Live catalog**: fetches `GET /v1/models` at runtime (the server isolates the catalog by key type); limits come from the catalog, with a static fallback
- **Point-based cost**: official point coefficients converted to "points per million tokens", so magpie's usage cost equals U Plan points spent
- **Local point ledger**: every response's usage is priced with the official formula (`points = (input×coeff + cached×coeff + output×coeff) / 10000`) and persisted in magpie's config directory, shared across host processes
- **Dual-pool windows**: the `usage` hook reports a 5-hour burst pool and a 7-day weekly pool (Free-tier sizes: 500 / 2500 points)
- **Streaming aware**: adds `stream_options.include_usage` to streaming requests so the trailing usage chunk is captured too

## U Plan models (Free tier, verified 2026-11)

| Model | Type | Billing pool | context / output |
|---|---|---|---|
| `u2-flash` | General text | points (coeff 1 / 0.2 / 2) | 1M / 256K |
| `u2-med` | Medical text | points (coeff 2 / 0.5 / 7) | 256K / — |
| `u2-radimed` | Medical vision (image+text) | **separate gift pool** (475K tokens/week, no points) | 40K / — |

Gift pools also include `u2-asr` (8 h/week), `u2-tts` (40k chars/week), `u2-ocr` / `u2-ocr-med` (7.375M tokens/week each); MCP tools for speech and documents are planned.

**Quota arbitrage**: route vision requests to `u2-radimed` — it draws from its gift pool, leaving your point pools untouched.

## Install

```bash
magpie plugin add github:aqiu817/magpie-unisound
# or a local directory
magpie plugin add ./magpie-unisound

magpie plugin login unisound
```

Models appear as `unisound/u2-flash`, `unisound/u2-med`, `unisound/u2-radimed`.

## Known limits

- **Point balances are local estimates**: counted since plugin installation, rolling windows approximate the official reset rules and err conservative. Verified against the console: the local ledger matches the server-side `points used` exactly. Authoritative balances live in the [console](https://maas.unisound.com/admin/subscription) (the server quota endpoint only accepts browser sessions, not API keys).
- **Windows show Free-tier sizes** (Standard / Plus users still get correct ratios).
- **No point cost for `u2-radimed`**: its gift-pool coefficients are unpublished, so magpie shows zero cost (token stats are unaffected).

## Privacy

The API key stays on your machine (magpie's local credential store). The point ledger (`magpie-unisound-points.json`) holds token counts and points only — never message content.

## Development

```bash
node --test test/unisound.test.mjs   # or bun test
TP_KEY=tp-… bun scripts/smoke.mjs    # live smoke (catalog + streaming)
```

## License

MIT
