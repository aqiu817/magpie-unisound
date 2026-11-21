// magpie-unisound：把云知声 Token Hub（maas.unisound.com）的 U Plan 接入 magpie。
//
// 入口导出一个插件函数——magpie 会把入口文件的每个导出函数都当成插件调用，
// 辅助函数全部放在 lib/ 里：
//   UnisoundPlugin() → 供应商 `unisound`（chat completions 主车道）
//
// 2026-11-21 灰宝定版：只保留 OpenAI chat 渠道，不做 Anthropic/Responses 车道
//（magpie 网关用 @ai-sdk/openai-compatible 统一转发，一个车道覆盖所有 agent）。
//
// 目标用户是 U Plan（Token Plan key）持有者：
//   - 模型目录是 U Plan 白名单（u2-flash / u2-med / u2-radimed），不包含旗舰 u2
//     和第三方 PAYG 模型——Token Plan key 调它们会失败，按量 key 调它们是真金白银。
//     服务端同样按 key 隔离目录（tp- key 的 /v1/models 只返回 U Plan 三模型），
//     白名单是拉不到目录时的兜底。
//   - cost 字段用积分口径（每百万 token 的积分数，由官方系数表换算），
//     magpie 用量统计里的 cost 就是 U Plan 积分消耗。
//   - u2-radimed 走独立赠送池（不消耗积分），视觉请求路由到它是免费额度套利。

import { CHAT_BASE, USER_AGENT, fetchJSON } from "./lib/platform.mjs"
import { UPLAN_CHAT_MODELS, PAYG_CHAT_MODELS } from "./lib/models.mjs"
import { catalogToModels } from "./lib/catalog.mjs"
import { COEFFS } from "./lib/points.mjs"
import {
  setLedgerDir,
  recordUsage,
  windowsFor,
  usageOfResponse,
  usageOfChatStreamText,
} from "./lib/points.mjs"

// 平台未公布限流参数，先沿用 amd-cloud 的保守口径，真机校正后调整。
const MAX_CONCURRENCY = 8

// PAYG 目录的合并哨兵：任选一个只存在于 PAYG 表的模型 id 判断是否已合并过。
const PAYG_SENTINEL = "kimi-k3"

function parseBody(body) {
  try {
    return JSON.parse(String(body))
  } catch {
    return null
  }
}

// chat 流式请求幂等注入 stream_options.include_usage：平台默认不给 usage chunk
//（2026-11-21 真机实锤），没有它流式积分记账抓瞎。include_usage=true 只会在流末尾
// 多一个空 choices 的 usage chunk（OpenAI 标准，@ai-sdk 客户端内置处理）。
function ensureIncludeUsage(body) {
  const b = parseBody(body)
  if (b?.stream === true && !b.stream_options?.include_usage) {
    b.stream_options = { ...(b.stream_options ?? {}), include_usage: true }
    return JSON.stringify(b)
  }
  return body
}

// 流式响应：clone 给后台 reader 扫描（不碰返回给 magpie 的那条流），
// usage 在流末尾——只保留尾部缓冲控内存。抓到后异步记账。
function scanStream(res, onUsage) {
  ;(async () => {
    const reader = res.clone().body?.getReader?.()
    if (!reader) return
    const dec = new TextDecoder()
    let buf = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      if (buf.length > 8000) buf = buf.slice(-4000)
    }
    buf += dec.decode()
    const usage = usageOfChatStreamText(buf)
    if (usage) onUsage(usage)
  })().catch(() => {})
}

// 记账 fetch：透传请求，从响应 usage 精算积分入账本（供 auth.usage 的双池窗口
// 显示——magpie 网关不认识积分口径）。注意必须用 globalThis.fetch——loader
// 返回的 fetch 会替换宿主同名引用，直接写 fetch() 会递归调用自己（真机实测栈溢出）。
function makeFetch(key) {
  return async function fetch(input, init) {
    const headers = new Headers(init?.headers)
    headers.set("user-agent", USER_AGENT)
    const res = await globalThis.fetch(input, { ...init, body: ensureIncludeUsage(init?.body), headers })
    try {
      const url = String(input)
      if (res.ok && url.includes("/chat/completions")) {
        const model = parseBody(init?.body)?.model
        const ct = res.headers.get("content-type") ?? ""
        if (ct.includes("text/event-stream")) {
          scanStream(res, (usage) => recordUsage(key, model, usage))
        } else {
          const json = await res.clone().json().catch(() => null)
          const usage = usageOfResponse(json)
          if (usage) recordUsage(key, model, usage)
        }
      }
    } catch {
      // 记账失败不影响请求本身
    }
    return res
  }
}

function makePlugin() {
  // exposePayg（PAYG 目录开关）按约定从插件参数 magpie.options 读。2026-11-21 沙箱
  // 实测当前宿主对 provider 插件尚未实装 options 传递（插件参数恒为 { magpie: {} }、
  // config 钩子也无第二参；中间件的 ctx.options 已实装）——开关保留为前向兼容层，
  // 宿主实装后即生效；服务端也按 key 类型隔离目录，此开关仅在按量 key 下有意义。
  return async function plugin({ magpie, directory } = {}) {
  const exposePayg = magpie?.options?.exposePayg === true
  // 积分账本位置：宿主给的配置目录；拿不到时 points.mjs 有固定路径兜底
  if (directory) setLedgerDir(directory)
  return {
    // 用 ??= 以免覆盖用户在 plugins.json 里的同名配置；exposePayg 时把 PAYG
    // 目录合并进白名单（已合并过则不动），重启宿主生效。
    config: async (cfg) => {
      cfg.provider ??= {}
      const existing = cfg.provider["unisound"]
      if (!existing) {
        cfg.provider["unisound"] = {
          name: "Unisound U Plan",
          npm: "@ai-sdk/openai-compatible", // chat completions
          api: CHAT_BASE,
          models: exposePayg ? { ...UPLAN_CHAT_MODELS, ...PAYG_CHAT_MODELS } : UPLAN_CHAT_MODELS,
        }
        return
      }
      if (exposePayg && existing.models && !existing.models[PAYG_SENTINEL]) {
        existing.models = { ...existing.models, ...PAYG_CHAT_MODELS }
      }
    },

    auth: {
      provider: "unisound",
      maxConcurrency: MAX_CONCURRENCY,
      methods: [{ type: "api", label: "Unisound U Plan API Key", placeholder: "sk-…" }],
      // key 原样保存（不做 authorize）：无效 key 由首个请求的 401 触发 magpie 的账号标记。
      // 鉴权头由 magpie 按 API key 登录自动补上；我们改写 UA 并做积分记账。
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api") return {}
        return { baseURL: CHAT_BASE, fetch: makeFetch(auth.key ?? auth.accountId) }
      },
      // 本地积分双池窗口（5h 突发池 / 周池，滚动近似）。服务端真值 M3 接入。
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api") {
          return { plan: "Unisound U Plan", error: "尚未登录 Unisound U Plan", windows: [] }
        }
        const windows = windowsFor(auth.key ?? auth.accountId ?? "default")
        return {
          plan: "Unisound U Plan",
          note: "本地积分估算：插件自响应 usage 按官方系数精算，自装插件起算；窗口为滚动近似，实际余量以控制台为准",
          windows,
        }
      },
    },

    // 每账号动态模型表：GET /v1/models（Token Plan key 的目录由服务端隔离成
    // U Plan 三模型），limit 以目录为准；拉不到兜底静态白名单。
    // ⚠️ 不透传宿主参数：2026-11-21 沙箱实锤，部分宿主路径调 provider.models 时
    // 传入的 providerModels 是 provider 配置对象本身（含 id/name/source/env/options/
    // npm/api/decide/searches/models 等字段）——原样返回会把配置键全部变成"模型"。
    // 一律显式构造返回，未登录也给静态白名单。
    provider: {
      id: "unisound",
      async models(_providerModels, { auth } = {}) {
        try {
          if (auth?.type === "api") {
            const res = await fetchJSON(`${CHAT_BASE}/models`, auth.key)
            if (res.ok) return catalogToModels(res.data, UPLAN_CHAT_MODELS)
          }
        } catch {
          // 拉取失败走静态白名单
        }
        return UPLAN_CHAT_MODELS
      },
    },
  }
}
}

export const UnisoundPlugin = makePlugin()

// 诊断辅助（非函数导出，宿主不会被当插件调用）：模型表与积分系数的可测试出口。
export const _internal = { UPLAN_CHAT_MODELS, PAYG_CHAT_MODELS, COEFFS }
