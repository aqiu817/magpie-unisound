# Changelog

## 0.1.0 (2026-11-21)

- 供应商 `unisound`：云知声 Token Hub U Plan 接入（chat completions 车道）
- U Plan 白名单目录 + `GET /v1/models` 动态模型表（limit 以目录为准）
- 积分口径 cost（官方系数表 → 每百万 token 积分数）
- 本地积分账本 + `usage` 双池窗口（5h 突发池 / 周池，Free 档口径，与服务端对账一致）
- 流式 `stream_options.include_usage` 幂等注入 + SSE 尾部 usage 记账
- `exposePayg` 开关（前向兼容层：当前宿主未向 provider 插件传 options，按量 key 用户待宿主实装后启用第三方目录）
