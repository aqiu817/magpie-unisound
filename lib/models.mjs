// Unisound Token Hub 模型表与积分换算。纯数据 + 纯函数，便于单测。
//
// 数据来源（官方文档，核对于 2026-11-21）：
//   - OpenAI Compatible - Chat 的模型清单与 reasoning_effort 支持表
//     https://maas.unisound.com/docs/api/text/openai-compatible
//   - U Plan 订阅概要（可用模型清单、积分系数、赠送池）
//     https://maas.unisound.com/docs/token-plan/overview
//   - 模型价格（按量人民币价，仅 U 系公开）
//     https://maas.unisound.com/docs/price/overview
//
// cost 字段用「积分口径」：magpie 把 cost 当每百万 token 的 credits 数值累计，
// 对 U Plan 用户 credits = 积分，正好直接换算——官方积分公式
//   points = (input×coeff + cached×coeff + output×coeff) / 10000
// 即每百万 token 消耗 coeff×100 积分。Radimed 走独立赠送池（积分系数未公布），
// 不放 cost，避免伪装出精确数字。
//
// variants（effort 档位）只放文档各模型支持表里的原生档位——平台对不支持且
// 无映射关系的档位直接报错，宁可少给不让客户端踩雷；档位映射（如 minimal→low）
// 属于 M4 参数消毒的活。文档未给各模型 context/output 上限，limit 取保守假设，
// 真机校正后更新。

// 官方积分系数表 → magpie cost（每百万 token 的积分数）。
export function pointsCost({ input, cached, output }) {
  const cost = {}
  if (Number.isFinite(input)) cost.input = input * 100
  if (Number.isFinite(cached)) cost.cache_read = cached * 100
  if (Number.isFinite(output)) cost.output = output * 100
  return Object.keys(cost).length ? cost : undefined
}

// U Plan 聊天白名单：Token Plan key 只能调 U-Model 系，其中能当聊天模型用的
// 就是这三个（ASR/TTS/OCR 是语音与文档接口，M5 以 MCP 工具形式接入）。
// 旗舰 u2 与全部第三方模型（DeepSeek/Kimi/GLM/Qwen…）不在 U Plan 内，
// 不进默认目录——按量 key 误调是真实扣费。
//
// limit 是 2026-11-21 真机 GET /v1/models 目录实测值（服务端隔离的 Token Plan
// 目录就返回这三个）。max_output 只在 flash 上给出（262144），med/radimed 为
// null → 沿用旗舰口径的保守值 65536。
export const UPLAN_CHAT_MODELS = {
  "u2-flash": {
    name: "U2-Flash",
    limit: { context: 1048576, output: 262144 },
    reasoning: true,
    tool_call: true,
    variants: { none: {}, minimal: {}, low: {}, medium: {}, high: {}, xhigh: {}, max: {} },
    // 按量价 0.6 / 0.02 / 1.2 元每百万（缓存命中 0.02 是人民币口径的 cache 价，
    // 积分口径的 cached 系数是 0.2）；cost 用积分系数表。
    cost: pointsCost({ input: 1, cached: 0.2, output: 2 }),
  },
  "u2-med": {
    name: "U2-Med",
    limit: { context: 262144, output: 65536 },
    reasoning: true,
    tool_call: true,
    // 支持表：none, low, medium, high（minimal→low，xhigh/max→high）
    variants: { none: {}, low: {}, medium: {}, high: {} },
    cost: pointsCost({ input: 2, cached: 0.5, output: 7 }),
  },
  "u2-radimed": {
    name: "U2-RadiMed",
    limit: { context: 40960, output: 65536 },
    // thinking 默认关闭且不可开启；effort 支持表虽有 none/low/medium/high，
    // 但与 thinking 开关语义纠缠，M4 消毒前先不给 effort 选择器。
    reasoning: false,
    tool_call: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    // 走独立赠送池（Free 档 47.5 万 tokens/周），不消耗积分，无公开积分系数。
    cost: undefined,
  },
}

// 按量付费（PAYG）目录：Token Plan key 调这些会失败，按量 key 调这些是真实扣费。
// 默认不进目录；用户在 provider options 里显式开 exposePayg 才合并进来。
// 平台未公开这些模型的价目，不放 cost；effort 档位照官方支持表。
export const PAYG_CHAT_MODELS = {
  "u2": {
    name: "Unisound U2",
    reasoning: true,
    tool_call: true,
    variants: { none: {}, minimal: {}, low: {}, medium: {}, high: {}, xhigh: {}, max: {} },
  },
  "deepseek-v4-flash-0731": { name: "DeepSeek V4 Flash", reasoning: true, tool_call: true, variants: { low: {}, high: {}, max: {} } },
  "deepseek-v4-pro": { name: "DeepSeek V4 Pro", reasoning: true, tool_call: true, variants: { high: {}, max: {} } },
  "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", reasoning: true, tool_call: true, variants: { low: {}, high: {}, max: {} } },
  "doubao-seed-2.1-pro": { name: "Doubao Seed 2.1 Pro", reasoning: true, tool_call: true, variants: { minimal: {}, low: {}, medium: {}, high: {}, xhigh: {}, max: {} } },
  "doubao-seed-2.1-turbo": { name: "Doubao Seed 2.1 Turbo", reasoning: true, tool_call: true, variants: { minimal: {}, low: {}, medium: {}, high: {}, xhigh: {}, max: {} } },
  "hy4-preview": { name: "Hunyuan hy4 Preview", reasoning: true, tool_call: true, variants: { none: {}, high: {} } },
  "hy3": { name: "Hunyuan hy3", reasoning: true, tool_call: true, variants: { none: {}, low: {}, high: {} } },
  "mimo-v2.6-pro": { name: "MiMo 2.6 Pro", reasoning: true, tool_call: true, variants: { none: {} } },
  "mimo-v2.6-flash": { name: "MiMo 2.6 Flash", reasoning: true, tool_call: true, variants: { none: {} } },
  // kimi-k3 永远开思考（传 disabled 直接报错），effort 只收三档。
  "kimi-k2.5": { name: "Kimi K2.5", reasoning: true, tool_call: true },
  "kimi-k2.6": { name: "Kimi K2.6", reasoning: true, tool_call: true },
  "kimi-k3": { name: "Kimi K3", reasoning: true, tool_call: true, variants: { low: {}, high: {}, max: {} } },
  "glm-5.3": { name: "GLM 5.3", reasoning: true, tool_call: true, variants: { low: {}, high: {}, max: {} } },
  "glm-5.2": { name: "GLM 5.2", reasoning: true, tool_call: true, variants: { high: {}, max: {} } },
  "glm-5.1": { name: "GLM 5.1", reasoning: true, tool_call: true, variants: { high: {}, max: {} } },
  "glm-5": { name: "GLM 5", reasoning: true, tool_call: true, variants: { high: {}, max: {} } },
  "MiniMax-M3": { name: "MiniMax M3", reasoning: true, tool_call: true },
  "MiniMax-M2.5": { name: "MiniMax M2.5", reasoning: true, tool_call: true },
  "qwen3.8-max": { name: "Qwen3.8 Max", reasoning: true, tool_call: true, variants: { low: {}, medium: {}, xhigh: {} } },
  "qwen3.8-flash": { name: "Qwen3.8 Flash", reasoning: true, tool_call: true, variants: { low: {}, medium: {}, xhigh: {} } },
  "qwen3.7-max": { name: "Qwen3.7 Max", reasoning: true, tool_call: true },
  "qwen3.7-plus": { name: "Qwen3.7 Plus", reasoning: true, tool_call: true },
  "qwen3.6-plus": { name: "Qwen3.6 Plus", reasoning: true, tool_call: true },
  "qwen3.6-flash": { name: "Qwen3.6 Flash", reasoning: true, tool_call: true },
  "qwen3.6-35b-a3b": { name: "Qwen3.6 35B A3B", reasoning: true, tool_call: true },
}
