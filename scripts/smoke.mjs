// 真机冒烟：Token Plan key → /v1/models 目录探测（不耗积分）→ chat 车道 u2-flash
// 最小请求（非流式 + 流式各一）→ 本地积分估算与账本对账。
// 用法：TP_KEY=tp-… [LEDGER_DIR=目录] bun scripts/smoke.mjs
import { CHAT_BASE, USER_AGENT } from "../lib/platform.mjs";
import { UnisoundPlugin } from "../index.mjs";

const KEY = process.env.TP_KEY;
if (!KEY) {
  console.error("用法: TP_KEY=tp-… bun scripts/smoke.mjs");
  process.exit(1);
}
console.log("key 前缀:", KEY.slice(0, 5) + "…", "（tp- = Token Plan key）");
const auth = { type: "api", key: KEY };
// LEDGER_DIR 指定时注入 directory，账本落盘可对账
const pluginOpts = {
  magpie: { options: {} },
  ...(process.env.LEDGER_DIR ? { directory: process.env.LEDGER_DIR } : {}),
};

// === 1. /v1/models 目录端点探测（GET，不耗积分） ===
console.log("\n=== 1. GET /v1/models（目录端点探测） ===");
{
  const res = await fetch(`${CHAT_BASE}/models`, {
    headers: { authorization: `Bearer ${KEY}`, "user-agent": USER_AGENT },
  }).catch((e) => ({ status: 0, error: String(e) }));
  if (res.status === 200) {
    const d = await res.json().catch(() => null);
    const ids = Array.isArray(d?.data) ? d.data.map((m) => m.id) : [];
    console.log("  200 ✓，目录条目", ids.length, "个:", ids.slice(0, 25).join(", "));
  } else {
    console.log("  状态:", res.status, res.error ?? "");
  }
}

// === 2. chat 车道：u2-flash 非流式最小请求 ===
console.log("\n=== 2. chat completions：u2-flash（stream:false） ===");
{
  const plugin = await UnisoundPlugin(pluginOpts);
  const hooks = await plugin;
  const loader = await hooks.auth.loader(async () => auth);
  const t0 = Date.now();
  const res = await loader.fetch(`${CHAT_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "u2-flash",
      messages: [{ role: "user", content: "Reply with exactly: SMOKE_OK" }],
      stream: false,
    }),
  });
  const data = await res.json().catch(() => null);
  console.log("  status:", res.status, "| elapsed:", Date.now() - t0 + "ms");
  if (res.status !== 200) {
    console.error("  error:", JSON.stringify(data)?.slice(0, 600));
  } else {
    console.log("  content:", JSON.stringify(data.choices?.[0]?.message?.content));
    console.log("  usage:", JSON.stringify(data.usage));
    const u = data.usage;
    if (u) {
      const pts = ((u.prompt_tokens * 1 + (u.prompt_tokens_details?.cached_tokens ?? 0) * 0.2 + u.completion_tokens * 2) / 10000).toFixed(4);
      console.log("  [积分估算]", pts, "积分");
    }
  }
}

// === 3. chat 车道：u2-flash 流式（验证 include_usage 注入 + 流式记账） ===
console.log("\n=== 3. chat completions：u2-flash（stream:true，include_usage 注入） ===");
{
  const plugin = await UnisoundPlugin(pluginOpts);
  const hooks = await plugin;
  const loader = await hooks.auth.loader(async () => auth);
  const t0 = Date.now();
  const res = await loader.fetch(`${CHAT_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "u2-flash",
      messages: [{ role: "user", content: "Reply with exactly: STREAM_OK" }],
      stream: true,
    }),
  });
  console.log("  status:", res.status, "| elapsed:", Date.now() - t0 + "ms");
  const text = await res.text();
  const usageChunk = text.split("\n").reverse().find((l) => l.includes('"usage"'));
  console.log("  usage chunk:", usageChunk ? "有 ✓" : "无 ✗", "| SSE 总长:", text.length);
  if (usageChunk) {
    const u = JSON.parse(usageChunk.replace(/^data:\s*/, "")).usage;
    const pts = ((u.prompt_tokens * 1 + (u.prompt_tokens_details?.cached_tokens ?? 0) * 0.2 + u.completion_tokens * 2) / 10000).toFixed(4);
    console.log("  [流式积分估算]", pts, "积分（后台 reader 会异步入账本）");
    await new Promise((r) => setTimeout(r, 300));
  }
}

console.log("\n=== SMOKE DONE ===");
