// 服务端真值额度：用网页会话 Cookie 调控制台端点 /manager/u-plan/subscription/current。
//
// 该端点只认浏览器 cookie 会话（API key 直调 401/404 —— M3 实锤），所以 cookie 由用户
// 从浏览器抓来粘进 magpie 的登录表单（prompts），存进 auth.metadata.cookie。
// 2026-11-21 真机验证：整行 Cookie 头直调 200；maasToken 单发不够（JSESSIONID 参与
// 会话），因此粘贴格式要求整行。
//
// 全部函数不抛错：真值查询失败一律让调用方回落本地账本估算。

export const MANAGER_QUOTA_URL = "https://maas.unisound.com/manager/u-plan/subscription/current"
// usage 钩子会被 magpie UI 频繁调，不能挂太久。
const TIMEOUT_MS = 6000

// 用户粘贴的 Cookie 行 → 规范化 cookie 串 | null。
// 兼容两种格式：带 "Cookie:" 前缀（DevTools 复制请求头）与裸 "name=v; …"（cURL -b）。
// 空段/无 "=" 的段丢弃；至少剩一对才有效。
export function parseCookieLine(input) {
  if (typeof input !== "string") return null
  let s = input.trim()
  if (!s) return null
  s = s.replace(/^cookie\s*:\s*/i, "")
  const pairs = s
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.includes("=") && p.split("=")[0].trim())
  if (!pairs.length) return null
  return pairs.join("; ")
}

// 拉服务端订阅真值。返回 { ok, status, data }：
//   ok=true → data 是响应的 result 对象（errorCode=0 且 result 存在）
//   ok=false → status 非 200 / 会话失效（错误壳）/ 网络/超时
// fetchImpl 参数供测试注入；传非字符串 cookie 直接 fail。
export async function fetchServerQuota(cookie, fetchImpl = globalThis.fetch) {
  try {
    if (typeof cookie !== "string" || !cookie) return { ok: false, status: 0, data: null }
    const res = await fetchImpl(MANAGER_QUOTA_URL, {
      headers: { cookie, accept: "application/json, text/plain, */*" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, status: res.status, data: null }
    const j = await res.json().catch(() => null)
    // 会话失效时服务端也可能回 200 错误壳（无 result）
    if (!j || typeof j !== "object" || !j.result || typeof j.result !== "object") {
      return { ok: false, status: res.status, data: null }
    }
    return { ok: true, status: res.status, data: j.result }
  } catch {
    return { ok: false, status: 0, data: null }
  }
}

function pct(used, total) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0
  return Math.min(100, Math.round((used / total) * 1000) / 10)
}

function finite(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// 重置倒计时文案：优先天+小时，其次不足一小时。
function resetLabel(days, hours, lessThanOneHour) {
  if (lessThanOneHour === true) return "不足 1 小时后重置"
  const d = finite(days)
  const h = finite(hours)
  if (d != null && h != null) {
    if (d <= 0 && h <= 0) return null
    return `${d > 0 ? `${d} 天` : ""}${h > 0 ? `${h} 小时` : ""}后重置`.trim()
  }
  return null
}

// 服务端 result → magpie usage windows[]。字段缺失的池直接跳过，绝不炸。
// 周池/5h 窗口的 amount=已用积分、limit=池上限；赠送池 amount=已用量、display 给剩余。
export function quotaToWindows(result, now = new Date()) {
  if (!result || typeof result !== "object") return []
  const out = []
  const planName = typeof result.planName === "string" && result.planName ? result.planName : null

  const weeklyUsed = finite(result.weeklyPointsUsed)
  const weeklyTotal = finite(result.weeklyPointsTotal)
  if (weeklyUsed != null && weeklyTotal != null && weeklyTotal > 0) {
    const reset = resetLabel(result.weeklyResetInDays, result.weeklyResetInHours, result.weeklyResetInLessThanOneHour)
    out.push({
      name: `周积分${planName ? `（${planName}）` : ""}·服务端真值`,
      used: pct(weeklyUsed, weeklyTotal),
      span: 7 * 24 * 3600,
      display: reset
        ? `${weeklyUsed} / ${weeklyTotal} pts · ${reset}`
        : `${weeklyUsed} / ${weeklyTotal} pts`,
      amount: weeklyUsed,
      limit: weeklyTotal,
      unit: "pts",
    })
  }

  const w5hUsed = finite(result.window5hUsed)
  const w5hTotal = finite(result.window5hLimit)
  if (w5hUsed != null && w5hTotal != null && w5hTotal > 0) {
    const mins = finite(result.window5hResetInMinutes)
    const reset = mins != null && mins > 0 ? ` · ${Math.round(mins / 60) || "<1"} 小时后重置` : ""
    out.push({
      name: "5h 突发池·服务端真值",
      used: pct(w5hUsed, w5hTotal),
      span: 5 * 3600,
      display: `${w5hUsed} / ${w5hTotal} pts${reset}`,
      amount: w5hUsed,
      limit: w5hTotal,
      unit: "pts",
    })
  }

  if (Array.isArray(result.giftQuotas)) {
    for (const g of result.giftQuotas) {
      if (!g || typeof g !== "object") continue
      const total = finite(g.totalAmount)
      const remain = finite(g.remainAmount)
      const used = finite(g.usedAmount)
      const model = typeof g.modelId === "string" ? g.modelId : null
      const unit = typeof g.displayUnit === "string" && g.displayUnit ? g.displayUnit : (typeof g.unit === "string" ? g.unit : "")
      if (!model || total == null) continue
      out.push({
        name: `赠送池 ${model}${g.available === false ? "（不可用）" : ""}`,
        used: pct(used ?? 0, total),
        span: 7 * 24 * 3600,
        display: remain != null ? `剩余 ${remain} / ${total} ${unit}`.trim() : `${used ?? 0} / ${total} ${unit}`.trim(),
        amount: used ?? 0,
        limit: total,
        unit,
      })
    }
  }
  return out
}

// usage 钩子返回值的 note 文案：标明数据来源与档位。
export function quotaNote(result) {
  const planCode = typeof result?.planCode === "string" ? result.planCode : null
  const base = "服务端实时用量：控制台订阅数据，含赠送池；"
  return planCode ? `${base}档位 ${planCode}` : base
}
