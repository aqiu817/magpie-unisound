# Changelog

## 0.2.0 (2026-11-21)

- **实时用量（可选）**：登录表单新增「网页端 Session Cookie」输入（auth prompts → `metadata.cookie`）。粘贴后 `usage` 显示服务端真值——周池/5h 突发池余量与官方重置倒计时、全部赠送池余量（OCR / RadiMed / ASR / TTS / OCR-Med），并按 `planCode` 自动识别档位（Free / Standard / Plus 通吃）
- Cookie 失效或查询失败时自动回落本地积分账本估算，usage 备注给出重新粘贴提示；请求链路完全不受影响
- Cookie 粘贴格式兼容 `Cookie: name=v; …` 请求头整行与 cURL `-b '…'` 引号内两种形态
- 安全边界：Cookie 只存本机凭据 metadata，仅向 `maas.unisound.com` 发一个只读 GET；不进日志/账本/发布物
- 新模块 `lib/server-quota.mjs`（解析 / 拉取 / 窗口映射，全部不抛错）；31 项单测 node+bun 双绿，真机端到端验证与服务端对账一致

## 0.1.0 (2026-11-21)

- 供应商 `unisound`：云知声 Token Hub U Plan 接入（chat completions 车道）
- U Plan 白名单目录 + `GET /v1/models` 动态模型表（limit 以目录为准）
- 积分口径 cost（官方系数表 → 每百万 token 积分数）
- 本地积分账本 + `usage` 双池窗口（5h 突发池 / 周池，Free 档口径，与服务端对账一致）
- 流式 `stream_options.include_usage` 幂等注入 + SSE 尾部 usage 记账
- `exposePayg` 开关（前向兼容层：当前宿主未向 provider 插件传 options，按量 key 用户待宿主实装后启用第三方目录）
