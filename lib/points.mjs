// 本地积分账本：从响应 usage 精算每笔积分消耗，按 key 持久化，聚合出
// 5 小时滚动窗口与 7 天滚动窗口两个口径的「已用」估算。
//
// 官方积分公式（U Plan 文档）：points = (input×coeff + cached×coeff + output×coeff) / 10000。
// usage 取 chat completions 形态：prompt_tokens / prompt_tokens_details.cached_tokens /
// completion_tokens。
//
// 这是本地估算：服务端真值（周积分重置起点、5h 窗口精确边界）抓包侦察后接入；
// 窗口用滚动近似，已用值只会偏保守（低估余量）。radimed 走独立赠送池不耗积分，
// 记 token 但 points 记 0。

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"

// Free 档额度常量（U Plan 文档）。Standard/Plus 档位不同，窗口名里标注口径。
export const FREE_WEEKLY_POINTS = 2500
export const FREE_WINDOW_POINTS = 500
// 账本保留期：覆盖 7 天周窗口再多留一天。
const RETAIN_MS = 8 * 24 * 3600 * 1000

// 积分系数表（U Plan 文档只给了这两个文本模型的系数；radimed 赠送池不算积分）。
export const COEFFS = {
  "u2-flash": { input: 1, cached: 0.2, output: 2 },
  "u2-med": { input: 2, cached: 0.5, output: 7 },
}

// 宿主启动时由插件函数把配置目录注入进来（见 index.mjs）。
let ledgerPath = null

function defaultMagpieDir() {
  return process.env.MAGPIE_CONFIG_DIR || join(process.env.USERPROFILE || process.env.HOME || "", ".config", "magpie")
}

export function setLedgerDir(dir) {
  if (dir) ledgerPath = join(dir, "magpie-unisound-points.json")
}

function ensureLedgerPath() {
  if (!ledgerPath) ledgerPath = join(defaultMagpieDir(), "magpie-unisound-points.json")
  return ledgerPath
}

function readLedger() {
  try {
    if (!existsSync(ensureLedgerPath())) return { accounts: {} }
    const j = JSON.parse(readFileSync(ledgerPath, "utf8"))
    if (j && typeof j === "object" && j.accounts) return j
    return { accounts: {} }
  } catch {
    // 损坏/半写的账本：从空开始（估算口径，宁少勿多）
    return { accounts: {} }
  }
}

function writeLedger(data) {
  try {
    const p = ensureLedgerPath()
    mkdirSync(dirname(p), { recursive: true }) // 兜底路径的父目录可能不存在
    const tmp = `${p}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, p) // 原子替换，避免半写
  } catch {
    // 写失败不阻塞请求；下次请求再试
  }
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// chat completions 响应的 usage → { input, cached, output } | null。
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null
  const input = num(usage.prompt_tokens)
  const output = num(usage.completion_tokens)
  if (input == null || output == null) return null
  const cached = num(usage.prompt_tokens_details?.cached_tokens) ?? 0
  return { input, cached, output }
}

// 归一化 usage + 模型 → 积分数（系数未知/赠送池模型返回 0，token 仍记账）。
export function pointsOf(model, usage) {
  const coeff = COEFFS[model]
  if (!coeff) return 0
  return Math.round(((usage.input * coeff.input + usage.cached * coeff.cached + usage.output * coeff.output) / 10000) * 1e6) / 1e6
}

// 记一笔。usage 是 chat completions 形态；返回 { points, recorded }。
export function recordUsage(accountKey, model, usage, now = Date.now()) {
  const u = normalizeUsage(usage)
  if (!accountKey || !u) return { points: null, recorded: false }
  const points = pointsOf(model, u)
  const data = readLedger()
  const a = (data.accounts[accountKey] ??= { entries: [], startedAt: new Date(now).toISOString() })
  a.entries.push({ at: now, model: model ?? null, ...u, points })
  // 顺手清过期条目（覆盖周窗口即可）
  if (a.entries.length > 4096) a.entries = a.entries.filter((e) => now - e.at < RETAIN_MS)
  a.lastAt = new Date(now).toISOString()
  writeLedger(data)
  return { points, recorded: true }
}

function sumSince(a, from) {
  let points = 0
  let tokens = { input: 0, cached: 0, output: 0 }
  let calls = 0
  for (const e of a.entries) {
    if (e.at < from) continue
    calls += 1
    tokens.input += e.input
    tokens.cached += e.cached
    tokens.output += e.output
    if (Number.isFinite(e.points)) points += e.points
  }
  return { calls, tokens, points: Math.round(points * 1e4) / 1e4 }
}

// 聚合两个滚动窗口（5h 突发池 / 7 天周池，滚动近似）。
export function windowsFor(accountKey, now = Date.now()) {
  const a = readLedger().accounts[accountKey]
  if (!a || !a.entries?.length) return []
  // 过期清理落到读路径：写路径只在记账时触发
  const w5h = sumSince(a, now - 5 * 3600 * 1000)
  const week = sumSince(a, now - 7 * 24 * 3600 * 1000)
  const out = []
  if (w5h.calls) {
    out.push({
      name: "5h 窗口积分（Free 档 500）",
      used: Math.min(100, Math.round((w5h.points / FREE_WINDOW_POINTS) * 1000) / 10),
      span: 5 * 3600,
      display: `${w5h.points} / ${FREE_WINDOW_POINTS} pts`,
      amount: w5h.points,
      limit: FREE_WINDOW_POINTS,
      unit: "pts",
    })
  }
  if (week.calls) {
    out.push({
      name: "周积分（Free 档 2500，7 天滚动）",
      used: Math.min(100, Math.round((week.points / FREE_WEEKLY_POINTS) * 1000) / 10),
      span: 7 * 24 * 3600,
      display: `${week.points} / ${FREE_WEEKLY_POINTS} pts`,
      amount: week.points,
      limit: FREE_WEEKLY_POINTS,
      unit: "pts",
    })
  }
  return out
}

// ---------- 响应抓取 ----------

// 非 SSE 响应体（JSON 已解析）→ usage（两种形态都试）。
export function usageOfResponse(body) {
  return body?.usage ?? null
}

// chat SSE 全文 → 最后一个 usage（usage 在末尾 chunk；include_usage 开启才有）。
export function usageOfChatStreamText(text) {
  if (!text) return null
  const prompt = lastNum(text, /"prompt_tokens"\s*:\s*([0-9]+)/g)
  const completion = lastNum(text, /"completion_tokens"\s*:\s*([0-9]+)/g)
  const cached = lastNum(text, /"cached_tokens"\s*:\s*([0-9]+)/g)
  if (prompt == null || completion == null) return null
  return { prompt_tokens: prompt, completion_tokens: completion, prompt_tokens_details: { cached_tokens: cached ?? 0 } }
}

function lastNum(text, re) {
  let last = null
  let m
  while ((m = re.exec(text))) last = m
  return last ? Number(last[1]) : null
}
