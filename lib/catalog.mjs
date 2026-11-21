// GET /v1/models 目录条目 → magpie/OpenCode Model 的映射。纯函数，便于单测。
//
// 2026-11-21 真机实测：Token Plan key 的目录只返回 U Plan 的三个聊天模型
// （u2-flash / u2-med / u2-radimed）——服务端已按 key 类型隔离目录，直接以
// 目录为准做动态模型表；拉不到目录时由调用方兜底回静态表。
// 条目形态（实测）：
//   { id, object:"model", created, owned_by:"unisound",
//     max_input, context_window, max_output }
// reasoning / tool_call / variants / modalities / cost 目录都不给，沿用静态表。

import { UPLAN_CHAT_MODELS } from "./models.mjs"

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

// 单个目录条目 → Model。base 是静态表同名模型；目录给的 limit 以目录为准，
// 目录没给的（max_output 为 null）沿用 base。
export function entryToModel(entry, base) {
  const model = {
    ...(base ?? {}),
    id: entry.id,
    name: base?.name ?? entry.id,
    limit: {
      context: num(entry?.context_window) ?? base?.limit?.context ?? 131072,
      output: num(entry?.max_output) ?? base?.limit?.output ?? 65536,
    },
  }
  return model
}

// 整个 /v1/models 响应 → { id: Model }。目录必须非空，空则抛错由调用方兜底。
export function catalogToModels(payload, providerModels = UPLAN_CHAT_MODELS) {
  const list = Array.isArray(payload?.data) ? payload.data : []
  if (!list.length) throw new Error("catalog is empty")
  const out = {}
  for (const entry of list) {
    if (entry?.id) out[entry.id] = entryToModel(entry, providerModels[entry.id])
  }
  if (!Object.keys(out).length) throw new Error("catalog has no models")
  return out
}
