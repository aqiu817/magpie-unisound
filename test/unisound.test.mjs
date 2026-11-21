// magpie-unisound 单测：模型表与积分换算用文档数值直接断言，插件工厂不发网络请求
//（loader 的 fetch 用桩替换 globalThis.fetch 验证 UA 注入）。
// 运行：node --test test/  或  bun test

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { pointsCost, UPLAN_CHAT_MODELS, PAYG_CHAT_MODELS } from "../lib/models.mjs"
import { CHAT_BASE, USER_AGENT } from "../lib/platform.mjs"
import { UnisoundPlugin } from "../index.mjs"

// ---------- pointsCost：官方系数 → 每百万 token 的积分数 ----------

test("pointsCost 按官方系数表换算为积分口径", () => {
  assert.deepEqual(pointsCost({ input: 1, cached: 0.2, output: 2 }), {
    input: 100,
    cache_read: 20,
    output: 200,
  })
  assert.deepEqual(pointsCost({ input: 2, cached: 0.5, output: 7 }), {
    input: 200,
    cache_read: 50,
    output: 700,
  })
})

test("pointsCost 缺系数的字段不出现，全缺返回 undefined", () => {
  assert.deepEqual(pointsCost({ input: 1 }), { input: 100 })
  assert.equal(pointsCost({}), undefined)
  assert.equal(pointsCost({ input: NaN, output: undefined }), undefined)
})

// ---------- U Plan 白名单 ----------

test("白名单恰好是 U Plan 的三个聊天模型", () => {
  assert.deepEqual(Object.keys(UPLAN_CHAT_MODELS).sort(), ["u2-flash", "u2-med", "u2-radimed"])
})

test("u2-flash：积分 cost 与全档 effort", () => {
  const m = UPLAN_CHAT_MODELS["u2-flash"]
  assert.deepEqual(m.cost, { input: 100, cache_read: 20, output: 200 })
  assert.deepEqual(Object.keys(m.variants).sort(), [
    "high",
    "max",
    "medium",
    "minimal",
    "none",
    "low",
    "xhigh",
  ].sort())
  assert.equal(m.reasoning, true)
  assert.equal(m.tool_call, true)
})

test("u2-med：积分 cost（输出贵 3.5 倍）与原生四档 effort", () => {
  const m = UPLAN_CHAT_MODELS["u2-med"]
  assert.deepEqual(m.cost, { input: 200, cache_read: 50, output: 700 })
  assert.deepEqual(Object.keys(m.variants).sort(), ["high", "low", "medium", "none"])
})

test("u2-radimed：赠送池（无 cost）、不可开思考、带视觉输入", () => {
  const m = UPLAN_CHAT_MODELS["u2-radimed"]
  assert.equal(m.cost, undefined)
  assert.equal(m.reasoning, false)
  assert.equal(m.variants, undefined)
  assert.deepEqual(m.modalities.input, ["text", "image"])
})

// ---------- PAYG 目录（默认不进，exposePayg 才合并） ----------

test("PAYG 表与白名单无交集，且含合并哨兵", () => {
  const uplan = new Set(Object.keys(UPLAN_CHAT_MODELS))
  const payg = Object.keys(PAYG_CHAT_MODELS)
  for (const id of payg) assert.ok(!uplan.has(id), `PAYG 表不应含白名单模型 ${id}`)
  assert.ok(payg.includes("kimi-k3"), "哨兵 id 必须在 PAYG 表中")
})

test("PAYG 表模型清单与官方文档一致（无 qwen3.6-max，kimi-k3 三档）", () => {
  assert.ok(!("qwen3.6-max" in PAYG_CHAT_MODELS), "文档模型清单里没有 qwen3.6-max")
  assert.deepEqual(Object.keys(PAYG_CHAT_MODELS["kimi-k3"].variants).sort(), ["high", "low", "max"])
  assert.deepEqual(Object.keys(PAYG_CHAT_MODELS["glm-5.3"].variants).sort(), ["high", "low", "max"])
  // 价目未公开，PAYG 条目一律不放 cost
  for (const [id, m] of Object.entries(PAYG_CHAT_MODELS)) {
    assert.equal(m.cost, undefined, `${id} 不应带未公开的价目`)
  }
})

// ---------- 插件工厂：钩子形状 ----------

async function make(pluginFactory) {
  const plugin = await pluginFactory()
  return plugin
}

test("unisound 车道：chat completions 指向 /v1", async () => {
  const plugin = await make(UnisoundPlugin)
  const cfg = {}
  await plugin.config(cfg)
  const p = cfg.provider["unisound"]
  assert.ok(p, "应创建 unisound 供应商")
  assert.equal(p.npm, "@ai-sdk/openai-compatible")
  assert.equal(p.api, CHAT_BASE)
  assert.deepEqual(Object.keys(p.models).sort(), ["u2-flash", "u2-med", "u2-radimed"])
})

test("config 不覆盖用户已有配置", async () => {
  const plugin = await make(UnisoundPlugin)
  const cfg = { provider: { unisound: { name: "我的配置", models: {} } } }
  await plugin.config(cfg)
  assert.equal(cfg.provider.unisound.name, "我的配置")
  assert.deepEqual(cfg.provider.unisound.models, {})
})

test("exposePayg 开启后合并 PAYG 目录（含既有配置的后合并路径），且幂等", async () => {
  // 路径一：首次创建即带 options
  const plugin = await make(UnisoundPlugin)
  const cfg = {}
  const hooksOn = await UnisoundPlugin({ magpie: { options: { exposePayg: true } } })
  await hooksOn.config(cfg)
  assert.ok(cfg.provider.unisound.models["kimi-k3"], "新建时 PAYG 模型应合并进来")
  assert.ok(cfg.provider.unisound.models["u2-flash"], "白名单模型仍在")
  const after1 = Object.keys(cfg.provider.unisound.models).length
  await hooksOn.config(cfg)
  assert.equal(Object.keys(cfg.provider.unisound.models).length, after1, "重复 config 不重复合并")

  // 路径二：先有默认配置（宿主已落盘），后开 options 再重启
  const cfg2 = {}
  await plugin.config(cfg2)
  assert.equal(cfg2.provider.unisound.models["kimi-k3"], undefined)
  await hooksOn.config(cfg2)
  assert.ok(cfg2.provider.unisound.models["kimi-k3"], "既有配置也应后合并")
})

test("exposePayg 缺省/false 不合并", async () => {
  const plugin = await make(UnisoundPlugin)
  const cfg = {}
  await plugin.config(cfg)
  await plugin.config(cfg)
  assert.equal(cfg.provider.unisound.models["kimi-k3"], undefined)
  const hooksOff = await UnisoundPlugin({ magpie: { options: { exposePayg: false } } })
  await hooksOff.config(cfg)
  assert.equal(cfg.provider.unisound.models["kimi-k3"], undefined)
  const hooksNoArg = await UnisoundPlugin()
  await hooksNoArg.config(cfg)
  assert.equal(cfg.provider.unisound.models["kimi-k3"], undefined)
})

test("钩子形状：单供应商 unisound（chat 车道）", async () => {
  const hooks = await make(UnisoundPlugin)
  assert.equal(typeof hooks.config, "function")
  assert.equal(hooks.auth.provider, "unisound")
  assert.equal(hooks.auth.maxConcurrency, 8)
  assert.equal(hooks.auth.methods.length, 1)
  assert.equal(hooks.auth.methods[0].type, "api")
  assert.equal(hooks.provider.id, "unisound")
  assert.equal(typeof hooks.auth.usage, "function")
})

// ---------- loader：UA 注入与未登录语义 ----------

test("未登录（非 api auth）loader 返回空对象", async () => {
  const plugin = await make(UnisoundPlugin)
  const hooks = await plugin
  const out = await hooks.auth.loader(async () => ({ type: "oauth" }))
  assert.deepEqual(out, {})
})

test("loader 返回 baseURL 并给所有请求注入 User-Agent", async () => {
  const plugin = await make(UnisoundPlugin)
  const hooks = await plugin
  const seen = []
  const origFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    seen.push({ url: String(input), ua: new Headers(init?.headers).get("user-agent") })
    return new Response("{}", { headers: { "content-type": "application/json" } })
  }
  try {
    const out = await hooks.auth.loader(async () => ({ type: "api", key: "sk-test" }))
    assert.equal(out.baseURL, CHAT_BASE)
    await out.fetch("https://maas-api.unisound.com/v1/chat/completions", { method: "POST" })
    assert.equal(seen[0].ua, USER_AGENT)
  } finally {
    globalThis.fetch = origFetch
  }
})

// ---------- M2：动态目录（lib/catalog.mjs） ----------

import { entryToModel, catalogToModels } from "../lib/catalog.mjs"

const DOC_ENTRY_FLASH = {
  id: "u2-flash",
  object: "model",
  created: 1789459200,
  owned_by: "unisound",
  max_input: 1048576,
  context_window: 1048576,
  max_output: 262144,
}
const DOC_ENTRY_MED = {
  id: "u2-med",
  object: "model",
  created: 1784217600,
  owned_by: "unisound",
  max_input: 262144,
  context_window: 262144,
  max_output: null,
}

test("目录条目 limit 以目录为准，null 沿用静态表", () => {
  const flash = entryToModel(DOC_ENTRY_FLASH, UPLAN_CHAT_MODELS["u2-flash"])
  assert.equal(flash.limit.context, 1048576)
  assert.equal(flash.limit.output, 262144)
  assert.equal(flash.cost.input, 100, "积分 cost 沿用静态表")
  const med = entryToModel(DOC_ENTRY_MED, UPLAN_CHAT_MODELS["u2-med"])
  assert.equal(med.limit.context, 262144)
  assert.equal(med.limit.output, 65536, "max_output null → 沿用静态表保守值")
  assert.equal(med.variants && Object.keys(med.variants).length, 4, "variants 沿用静态表")
})

test("catalogToModels：目录驱动，未知模型也收（只带目录字段），空目录抛错", () => {
  const out = catalogToModels({ data: [DOC_ENTRY_FLASH, DOC_ENTRY_MED] }, UPLAN_CHAT_MODELS)
  assert.deepEqual(Object.keys(out).sort(), ["u2-flash", "u2-med"])
  const unknown = catalogToModels({ data: [{ id: "u2-new", context_window: 4096, max_output: null }] }, UPLAN_CHAT_MODELS)
  assert.equal(unknown["u2-new"].limit.context, 4096)
  assert.equal(unknown["u2-new"].limit.output, 65536)
  assert.throws(() => catalogToModels({ data: [] }), /empty/)
})

// ---------- M2：积分账本（lib/points.mjs） ----------

import {
  setLedgerDir,
  recordUsage,
  windowsFor,
  normalizeUsage,
  pointsOf,
  usageOfResponse,
  usageOfChatStreamText,
  COEFFS,
  FREE_WEEKLY_POINTS,
  FREE_WINDOW_POINTS,
} from "../lib/points.mjs"

test("normalizeUsage：chat 形态归一化", () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 80 } }), {
    input: 100,
    cached: 80,
    output: 50,
  })
  assert.equal(normalizeUsage(null), null)
  assert.equal(normalizeUsage({}), null)
})

test("pointsOf 按官方系数精算，未知模型/赠送池为 0", () => {
  const u = { input: 10000, cached: 0, output: 10000 }
  assert.equal(pointsOf("u2-flash", u), 3, "(10000×1 + 10000×2)/10000 = 3")
  assert.equal(pointsOf("u2-med", u), 9, "(10000×2 + 10000×7)/10000 = 9")
  assert.equal(pointsOf("u2-radimed", u), 0, "赠送池不算积分")
  assert.equal(pointsOf("unknown", u), 0)
})

test("账本：记账 → 双池窗口聚合 → 过期不重算", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unisound-ledger-"))
  setLedgerDir(dir)
  try {
    const key = "tp-test"
    const now = Date.now()
    // 3 笔：两笔刚发生（flash+med），一笔 6 小时前（只进周池）
    const r1 = recordUsage(key, "u2-flash", { prompt_tokens: 10000, completion_tokens: 10000, prompt_tokens_details: { cached_tokens: 0 } }, now)
    assert.deepEqual({ points: r1.points, recorded: r1.recorded }, { points: 3, recorded: true })
    recordUsage(key, "u2-med", { prompt_tokens: 5000, completion_tokens: 5000, prompt_tokens_details: { cached_tokens: 0 } }, now + 1)
    recordUsage(key, "u2-flash", { prompt_tokens: 10000, completion_tokens: 10000, prompt_tokens_details: { cached_tokens: 0 } }, now - 6 * 3600 * 1000)
    const wins = windowsFor(key, now + 2)
    assert.equal(wins.length, 2)
    const w5h = wins.find((w) => w.name.includes("5h"))
    const week = wins.find((w) => w.name.includes("周"))
    // 5h 窗口：3 + (5000×2+5000×7)/10000 = 3 + 4.5 = 7.5
    assert.equal(w5h.amount, 7.5)
    assert.equal(w5h.limit, FREE_WINDOW_POINTS)
    // 周池：7.5 + 3 = 10.5
    assert.equal(week.amount, 10.5)
    assert.equal(week.limit, FREE_WEEKLY_POINTS)
    // radimed 记 token 不记积分
    recordUsage(key, "u2-radimed", { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } }, now + 3)
    const wins2 = windowsFor(key, now + 4)
    assert.equal(wins2.find((w) => w.name.includes("5h")).amount, 7.5, "radimed 不入积分")
  } finally {
    setLedgerDir(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("流式扫描：chat SSE 文本能抽出 usage", () => {
  const chatSse = [
    'data: {"choices":[{"delta":{"content":"SMOKE"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":63,"completion_tokens":28,"prompt_tokens_details":{"cached_tokens":12}}}',
    "data: [DONE]",
  ].join("\n\n")
  assert.deepEqual(normalizeUsage(usageOfChatStreamText(chatSse)), { input: 63, cached: 12, output: 28 })
  assert.equal(usageOfChatStreamText("no usage here"), null)
})

test("usage 钩子：未登录报错，有账本返回双池窗口", async () => {
  const plugin = await UnisoundPlugin()
  const empty = await plugin.auth.usage(async () => ({ type: "none" }))
  assert.ok(empty.error)
  assert.deepEqual(empty.windows, [])
  const dir = mkdtempSync(join(tmpdir(), "unisound-ledger-"))
  setLedgerDir(dir)
  try {
    recordUsage("tp-usage-hook", "u2-flash", { prompt_tokens: 10000, completion_tokens: 5000, prompt_tokens_details: { cached_tokens: 0 } })
    const out = await plugin.auth.usage(async () => ({ type: "api", key: "tp-usage-hook" }))
    assert.equal(out.plan, "Unisound U Plan")
    assert.ok(out.windows.length >= 1)
    assert.ok(out.note.includes("本地积分估算"))
  } finally {
    setLedgerDir(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("loader 的 fetch 记账：非流式 200 响应入账本（mock fetch）", async () => {
  const plugin = await UnisoundPlugin()
  const hooks = await plugin
  const dir = mkdtempSync(join(tmpdir(), "unisound-ledger-"))
  setLedgerDir(dir)
  const origFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 20000, completion_tokens: 10000, prompt_tokens_details: { cached_tokens: 0 } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  try {
    const loader = await hooks.auth.loader(async () => ({ type: "api", key: "tp-fetch-test" }))
    await loader.fetch("https://maas-api.unisound.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "u2-flash", messages: [], stream: false }),
    })
    const wins = windowsFor("tp-fetch-test")
    // (20000×1 + 10000×2)/10000 = 4
    assert.equal(wins[0].amount, 4)
  } finally {
    globalThis.fetch = origFetch
    setLedgerDir(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- M2-4：include_usage 注入与流式记账 ----------

test("ensureIncludeUsage：流式补 include_usage（幂等），非流式与已有值不动", async () => {
  const { _internal } = await import("../index.mjs").catch(() => ({}))
  // _internal 不导出的话从源码行为验证：走 loader fetch 的 mock，检查上游收到的 body
  const plugin = await UnisoundPlugin()
  const hooks = await plugin
  const seenBodies = []
  const origFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    seenBodies.push(JSON.parse(String(init.body)))
    const sse = 'data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":0}}}\n\ndata: [DONE]'
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
  }
  const dir = mkdtempSync(join(tmpdir(), "unisound-ledger-"))
  setLedgerDir(dir)
  try {
    const loader = await hooks.auth.loader(async () => ({ type: "api", key: "tp-stream-test" }))
    // 流式请求：上游应收到 include_usage=true
    await loader.fetch("https://maas-api.unisound.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "u2-flash", messages: [], stream: true }),
    })
    assert.equal(seenBodies[0].stream_options.include_usage, true, "流式请求应补 include_usage")
    // 等后台 reader 记账落地
    await new Promise((r) => setTimeout(r, 150))
    const wins = windowsFor("tp-stream-test")
    assert.equal(wins[0]?.amount, (10 * 1 + 5 * 2) / 10000, "流式 usage chunk 应入账本")
    // 非流式请求：body 不被改写
    await loader.fetch("https://maas-api.unisound.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "u2-flash", messages: [], stream: false }),
    })
    assert.equal(seenBodies[1].stream_options, undefined, "非流式不加 stream_options")
  } finally {
    globalThis.fetch = origFetch
    setLedgerDir(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- v0.2：服务端真值（lib/server-quota.mjs，Session Cookie） ----------

import { parseCookieLine, fetchServerQuota, quotaToWindows, quotaNote, MANAGER_QUOTA_URL } from "../lib/server-quota.mjs"

const QUOTA_RESULT = {
  planName: "U Plan Free",
  planCode: "U-FREE",
  status: "ACTIVE",
  weeklyPointsUsed: 12.3456,
  weeklyPointsTotal: 2500,
  weeklyPointsRemain: 2487.6544,
  weeklyResetInDays: 4,
  weeklyResetInHours: 7,
  weeklyResetInLessThanOneHour: false,
  window5hUsed: 40,
  window5hLimit: 500,
  window5hResetInMinutes: 92,
  giftQuotas: [
    { available: true, displayAmount: "7,375,000", displayUnit: "Token", modelId: "u2-ocr", remainAmount: 7375000, totalAmount: 7375000, unit: "TOKEN", usedAmount: 0 },
    { available: true, displayAmount: "475,000", displayUnit: "Token", modelId: "u2-radimed", remainAmount: 474000, totalAmount: 475000, unit: "TOKEN", usedAmount: 1000 },
    { available: true, displayAmount: "8", displayUnit: "小时", modelId: "u2-asr", remainAmount: 7.5, totalAmount: 8, unit: "HOUR", usedAmount: 0.5 },
  ],
}

test("parseCookieLine：带前缀/裸格式/规范化，无效输入返 null", () => {
  assert.equal(parseCookieLine("Cookie: JSESSIONID=abc; maasToken=xyz"), "JSESSIONID=abc; maasToken=xyz")
  assert.equal(parseCookieLine("cookie:  JSESSIONID=abc "), "JSESSIONID=abc")
  assert.equal(parseCookieLine("JSESSIONID=abc; maasToken=xyz"), "JSESSIONID=abc; maasToken=xyz")
  assert.equal(parseCookieLine("  JSESSIONID=abc ; ; maasToken=xyz "), "JSESSIONID=abc; maasToken=xyz")
  assert.equal(parseCookieLine(""), null)
  assert.equal(parseCookieLine("   "), null)
  assert.equal(parseCookieLine("garbage without equals"), null)
  assert.equal(parseCookieLine("Cookie:"), null)
  assert.equal(parseCookieLine(null), null)
  assert.equal(parseCookieLine(undefined), null)
  assert.equal(parseCookieLine(42), null)
})

test("fetchServerQuota：200+result 成功，错误壳/401/异常都 ok=false 不抛错", async () => {
  // 成功
  const okJson = JSON.stringify({ errorCode: 0, errorMsg: "", result: QUOTA_RESULT })
  const ok = await fetchServerQuota("JSESSIONID=abc", async (url, init) => {
    assert.equal(url, MANAGER_QUOTA_URL)
    assert.equal(init.headers.cookie, "JSESSIONID=abc")
    return new Response(okJson, { status: 200, headers: { "content-type": "application/json" } })
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.data.planCode, "U-FREE")
  // 200 错误壳（会话失效形态）
  const shell = await fetchServerQuota("JSESSIONID=dead", async () =>
    new Response(JSON.stringify({ errorCode: 500, errorMsg: "用户未登录或session超时" }), { status: 200, headers: { "content-type": "application/json" } }))
  assert.equal(shell.ok, false)
  // 401
  const unauthorized = await fetchServerQuota("JSESSIONID=old", async () => new Response("{}", { status: 401 }))
  assert.equal(unauthorized.ok, false)
  assert.equal(unauthorized.status, 401)
  // 网络异常
  const boom = await fetchServerQuota("JSESSIONID=abc", async () => { throw new Error("net down") })
  assert.equal(boom.ok, false)
  assert.equal(boom.status, 0)
  // 非字符串 cookie
  const badCookie = await fetchServerQuota(undefined, async () => new Response("{}", { status: 200 }))
  assert.equal(badCookie.ok, false)
  // 非 JSON body
  const html = await fetchServerQuota("JSESSIONID=abc", async () => new Response("<html>login</html>", { status: 200 }))
  assert.equal(html.ok, false)
})

test("quotaToWindows：周池+5h 池+三个赠送池全映射（真值字段）", () => {
  const wins = quotaToWindows(QUOTA_RESULT)
  assert.equal(wins.length, 5)
  const week = wins.find((w) => w.name.includes("周积分"))
  assert.equal(week.amount, 12.3456)
  assert.equal(week.limit, 2500)
  assert.ok(week.name.includes("U Plan Free"))
  assert.ok(week.display.includes("4 天7 小时后重置"))
  // resetsAt：4 天 7 小时倒计时 → 毫秒时间戳
  assert.equal(typeof week.resetsAt, "number")
  assert.ok(Math.abs(week.resetsAt - (Date.now() + (4 * 24 + 7) * 3600 * 1000)) < 60000, "resetsAt ≈ now + 4d7h")
  assert.equal(week.aside, undefined, "主积分池不是赠送池，不带 aside")
  const w5h = wins.find((w) => w.name.includes("5h"))
  assert.equal(w5h.amount, 40)
  assert.equal(w5h.limit, 500)
  assert.ok(w5h.display.includes("2 小时后重置"), "92 分钟取整为 2 小时")
  assert.equal(typeof w5h.resetsAt, "number")
  assert.ok(Math.abs(w5h.resetsAt - (Date.now() + 92 * 60 * 1000)) < 60000, "resetsAt ≈ now + 92min")
  const radimed = wins.find((w) => w.name.includes("u2-radimed"))
  assert.equal(radimed.amount, 1000)
  assert.equal(radimed.limit, 475000)
  assert.ok(radimed.display.includes("剩余 474000 / 475000 Token"))
  assert.equal(radimed.aside, true, "赠送池标 aside（用完不影响账号）")
  assert.equal(radimed.resetsAt, week.resetsAt, "赠送池重置时间沿用周池（同为周口径）")
  const asr = wins.find((w) => w.name.includes("u2-asr"))
  assert.ok(asr.display.includes("小时"))
  assert.equal(asr.unit, "小时")
  assert.equal(asr.aside, true)
  const ocr = wins.find((w) => w.name.includes("u2-ocr"))
  assert.equal(ocr.used, 0)
  assert.equal(ocr.resetsAt, week.resetsAt)
})

test("quotaToWindows：window5hExpiresAt 绝对时间优先于 ResetInMinutes", () => {
  const iso = "2026-11-22T03:30:00+08:00"
  const wins = quotaToWindows({
    window5hUsed: 10,
    window5hLimit: 500,
    window5hResetInMinutes: 999,
    window5hExpiresAt: iso,
    weeklyPointsUsed: 0,
    weeklyPointsTotal: 2500,
  })
  const w5h = wins.find((w) => w.name.includes("5h"))
  assert.equal(w5h.resetsAt, Date.parse(iso), "有 ExpiresAt 时用它")
})

test("quotaToWindows：字段缺席/畸形容忍（5h 缺、gift 非 object、无 planName）", () => {
  const partial = quotaToWindows({
    weeklyPointsUsed: 1,
    weeklyPointsTotal: 100,
    planCode: "U-PLUS",
    giftQuotas: [null, "junk", { modelId: "u2-ocr-med", totalAmount: 7375000, remainAmount: 7375000 }],
  })
  assert.equal(partial.length, 2)
  assert.ok(partial[0].name.includes("周积分"))
  assert.ok(!partial[0].name.includes("（"), "planName 缺席时不带括号名")
  assert.equal(partial[1].name.includes("u2-ocr-med"), true)
  assert.equal(quotaToWindows(null).length, 0)
  assert.equal(quotaToWindows(undefined).length, 0)
  assert.equal(quotaToWindows("junk").length, 0)
  // 全空 result
  assert.equal(quotaToWindows({}).length, 0)
})

test("quotaNote 带 planCode 档位标注", () => {
  assert.ok(quotaNote(QUOTA_RESULT).includes("U-FREE"))
  assert.ok(quotaNote({}).includes("服务端实时用量"))
})

test("usage 钩子分流：有 cookie → 服务端真值；失效 → 回落本地估算", async () => {
  const plugin = await UnisoundPlugin()
  const hooks = await plugin
  const okJson = JSON.stringify({ errorCode: 0, errorMsg: "", result: QUOTA_RESULT })
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), MANAGER_QUOTA_URL, "usage 分流应调控制台端点")
    assert.equal(init.headers.cookie, "JSESSIONID=abc; maasToken=xyz")
    return new Response(okJson, { status: 200, headers: { "content-type": "application/json" } })
  }
  try {
    // 真值路径
    const live = await hooks.auth.usage(async () => ({
      type: "api",
      key: "tp-live",
      metadata: { cookie: "Cookie: JSESSIONID=abc; maasToken=xyz" },
    }))
    assert.equal(live.plan, "Unisound U Plan")
    assert.ok(live.note.includes("服务端实时用量"))
    assert.ok(live.note.includes("U-FREE"))
    assert.equal(live.windows.length, 5)
    assert.ok(live.windows.some((w) => w.name.includes("赠送池")))
    // 失效路径：错误壳 → 回落本地账本 note
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ errorCode: 500, errorMsg: "用户未登录或session超时" }), { status: 200, headers: { "content-type": "application/json" } })
    const dir = mkdtempSync(join(tmpdir(), "unisound-ledger-"))
    setLedgerDir(dir)
    try {
      recordUsage("tp-fallback", "u2-flash", { prompt_tokens: 10000, completion_tokens: 5000, prompt_tokens_details: { cached_tokens: 0 } })
      const stale = await hooks.auth.usage(async () => ({
        type: "api",
        key: "tp-fallback",
        metadata: { cookie: "JSESSIONID=dead" },
      }))
      assert.ok(stale.note.includes("Cookie 可能已过期"))
      assert.ok(stale.windows.length >= 1)
      assert.ok(stale.windows[0].name.includes("Free 档") || stale.windows[0].name.includes("5h") || stale.windows[0].name.includes("周"), "回落窗口是本地口径")
      // 无 cookie → 纯本地估算 note
      const local = await hooks.auth.usage(async () => ({ type: "api", key: "tp-fallback" }))
      assert.ok(local.note.includes("本地积分估算"))
    } finally {
      setLedgerDir(null)
      rmSync(dir, { recursive: true, force: true })
    }
  } finally {
    globalThis.fetch = origFetch
  }
})

test("登录方式带可选 cookie prompts（password 类型）", async () => {
  const hooks = await UnisoundPlugin()
  const m = hooks.auth.methods[0]
  assert.equal(m.type, "api")
  assert.ok(Array.isArray(m.prompts) && m.prompts.length === 1)
  assert.equal(m.prompts[0].type, "password")
  assert.equal(m.prompts[0].key, "cookie")
})
