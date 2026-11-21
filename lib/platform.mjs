// Unisound Token Hub API 地址与常量。
//
// 平台另有 Anthropic（/anthropic/v1/messages）与 Responses（/v1/responses）兼容
// 端点，2026-11-21 灰宝定版只接 OpenAI chat 渠道，其余端点不在本插件范围内。
// Responses 协议是无状态的：不支持 previous_response_id / store / background /
// context_management——若未来要接 Codex 直连需剥状态字段。

export const CHAT_BASE = "https://maas-api.unisound.com/v1"

export const CONSOLE_URL = "https://maas.unisound.com"
// 两种 key 的签发入口不同，U Plan 用户务必用 Token Plan 的那把：
//   按量付费 key：控制台 > 按量计费&资源包 > API Key 管理
//   Token Plan key：控制台 > 订阅管理 > Token Plan
export const APIKEY_PAYG_URL = "https://maas.unisound.com/admin/project/api-key"
export const TOKEN_PLAN_DOCS_URL = "https://maas.unisound.com/docs/token-plan/overview"

export const PLUGIN_VERSION = "0.1.0"
export const USER_AGENT = `magpie-unisound/${PLUGIN_VERSION}`

// GET 一个 JSON 端点。不抛异常：网络失败返回
// { ok: false, status: 0, error }，HTTP 错误也原样带回状态码和响应体。
export async function fetchJSON(url, key, init = {}) {
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${key}`,
        "user-agent": USER_AGENT,
        ...(init.headers ?? {}),
      },
    })
    let data = null
    try {
      data = await res.json()
    } catch {
      // 非 JSON 响应保持 null，让调用方按状态码处理
    }
    return { ok: res.ok, status: res.status, data }
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.message ?? err) }
  }
}
