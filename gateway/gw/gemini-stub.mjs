// E13 最小验证 (c)：本机 Gemini 桩端点 —— magpie 接法的 transport 验证用。
//
// 背景（见 round2/magpie-evaluation.md §2(c)）：agy（Gemini Key 模式）→
// GOOGLE_GEMINI_BASE_URL → 本机网关（Gemini API）→ 翻译 → 上游 OpenAI。
// 在写真正的 Gemini↔OpenAI 翻译（b）之前，先证实 agy 1.5.13 是否认
// GOOGLE_GEMINI_BASE_URL：桩只回固定 Gemini 形状响应，看请求到不到得了。
// 判定：桩收到符合 Gemini 格式的请求 → transport 证实，进入 (b)；
// 桩收不到 / agy 报错走 Google 登录 / agy 拒绝启动 → transport 不成立，
// 直接回方案 A（删接线），不要写翻译代码。
//
// 桩是验证用的，不是产品功能：
//   - 门默认关（SETTINGS.geminiStub，见 settings-store.mjs）。门关着时这两个端点
//     不存在（返回 NEXT，落到静态 404），连 401 都不回；
//   - 门只在“Gemini API Key 接口 + 显式开了门”的轮次里由 agyEnv 接上（见 stubEnv）；
//     Google 登录路径（p.id === "google"）永远走不到这里；
//   - 认证只认网关自己的令牌（TOKEN，0600 存 ~/.gateway-token），经 x-goog-api-key
//     或 ?key= 送来 —— 和 magpie 的 agentKey("agy") 同一个分界：agy 环境里的
//     GEMINI_API_KEY 是网关令牌，不是用户的 OpenAI key，也不是用户的 Gemini key；
//   - 每次请求都记一行日志（gemini-stub-requests.jsonl，见 stubLogFile）：
//     只记方法、模型、认证方式、状态与截断后的请求体，令牌值本身绝不进日志
//     （连 ?key= 的查询串也不记），供真机验证时确认请求是否到达；
//   - 验证通过、OpenAI 兼容上游 provider 类型落地后，这个文件由真正的翻译端点
//     接管（删旧桥时连同这份桩一起处理，见 E13-fix.md 后续路线）。
import fs from "node:fs";
import path from "node:path";
import { CFG, log } from "./config.mjs";
import { SETTINGS, saveSettings } from "./settings-store.mjs";
import { TOKEN, tokenOk } from "./access.mjs";
import { NEXT, dec, readBody, sendJson, writePaced } from "./http.mjs";

// ── 门与接线 ──────────────────────────────────────────────────────────
/** 桩端点的请求日志：网关 home（应用私有目录）里的 JSONL，一行一条。 */
export const stubLogFile = () => path.join(CFG.home, "gemini-stub-requests.jsonl");
/** 门：只认严格 true，设置文件里别的形状（字符串 "true" 之类）一律按关处理。 */
export const stubEnabled = () => SETTINGS.geminiStub === true;
/** agy 的 GOOGLE_GEMINI_BASE_URL 指到本机网关：SDK 会在后面拼 /v1beta/models/…，
 *  所以这里不带 /v1beta 后缀（和 magpie 把网关地址原样交过去的做法一致）。 */
export const stubBaseUrl = () => `http://127.0.0.1:${CFG.port}`;
/** 这一轮要不要走桩：只在“Gemini API Key 接口 + 显式开了门”时。
 *  返回要注入 agy 环境的变量；不走返回 null。调用方（agy.mjs agyEnv）在门关着时
 *  还要把继承来的 GOOGLE_GEMINI_BASE_URL 删掉，见那边的注释。 */
export function stubEnv(p) {
  if (!stubEnabled() || !p || p.id !== "gemini") return null;
  return { GOOGLE_GEMINI_BASE_URL: stubBaseUrl(), GEMINI_API_KEY: TOKEN };
}

// ── 固定响应（Gemini API 形状，内容固定为 "ok"）──────────────────────
const fixedResponse = (model) => ({
  candidates: [{ content: { parts: [{ text: "ok" }], role: "model" }, finishReason: "STOP", index: 0 }],
  usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 1, totalTokenCount: 1 },
  modelVersion: model,
});
// 流式的一块：内容块不带 finishReason，收尾块带 STOP + usage（和真 Gemini 的 SSE 一致）
const chunkResponse = (model, text, finish) => {
  const c = { content: { parts: [{ text }], role: "model" }, index: 0 };
  if (finish) c.finishReason = finish;
  const out = { candidates: [c], modelVersion: model };
  if (finish) out.usageMetadata = { promptTokenCount: 0, candidatesTokenCount: 1, totalTokenCount: 1 };
  return out;
};

// ── 请求日志 ──────────────────────────────────────────────────────────
const LOG_MAX_LINES = 200, LOG_MAX_BYTES = 256 * 1024;
function logStub(e) {
  try {
    // body 只记截断后的 JSON（agy 发来的 contents/tools，不含令牌；令牌走头/查询串，本来就不进这里）
    const body = e.body == null ? null : JSON.stringify(e.body).slice(0, 2000);
    fs.appendFileSync(stubLogFile(), JSON.stringify({ at: new Date().toISOString(), ...e, body }) + "\n");
    if (fs.statSync(stubLogFile()).size > LOG_MAX_BYTES) {
      const lines = fs.readFileSync(stubLogFile(), "utf8").trimEnd().split("\n");
      fs.writeFileSync(stubLogFile(), lines.slice(-LOG_MAX_LINES).join("\n") + "\n");
    }
  } catch (err) { log(`[gemini-stub] 记请求日志失败: ${err.message}`); }
}

// ── 认证：只认网关令牌，经 x-goog-api-key 或 ?key= ───────────────────
function authVia(req, u) {
  const h = String(req.headers["x-goog-api-key"] || "");
  if (h) return tokenOk(h) ? "x-goog-api-key" : "bad-key";
  const q = u.searchParams.get("key") || "";
  if (q) return tokenOk(q) ? "key" : "bad-key";
  return "none";
}

const GEMINI_RE = /^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent)$/;

// ── 路由 ──────────────────────────────────────────────────────────────
// 认领：POST /v1beta/models/{model}:generateContent 与 :streamGenerateContent（门开着时），
// 以及开关本身 GET/POST /api/gemini-stub（走 /api/* 的鉴权，见 server.mjs denyReason）。
// 其余一律返回 NEXT：门关着时桩端点不存在（落到静态 404）；:countTokens 等不在验证范围内。
export async function routeGeminiStub(req, res, u, p) {
  if (p === "/api/gemini-stub") {
    if (req.method === "GET") return sendJson(res, 200, { ok: true, enabled: stubEnabled(), baseUrl: stubBaseUrl(), logFile: stubLogFile() });
    if (req.method === "POST") {
      let b; try { b = JSON.parse((await readBody(req)) || "{}"); } catch { return sendJson(res, 400, { error: "bad json" }); }
      SETTINGS.geminiStub = b.enabled === true;
      saveSettings();
      return sendJson(res, 200, { ok: true, enabled: stubEnabled() });
    }
    return NEXT;
  }
  if (req.method !== "POST") return NEXT;
  const m = GEMINI_RE.exec(p);
  if (!m) return NEXT;
  if (!stubEnabled()) return NEXT;
  const model = dec(m[1]) || m[1], stream = m[2] === "streamGenerateContent";
  const auth = authVia(req, u);
  // 桩的任务是证明请求到达：体读坏了也不 500，记一笔、照常回固定响应
  const raw = await readBody(req).catch(() => "");
  let body = null, bodyParse = "ok";
  try { body = raw ? JSON.parse(raw) : null; } catch { bodyParse = "invalid"; }
  if (auth !== "x-goog-api-key" && auth !== "key") {
    logStub({ model, stream, auth, status: 401, bodyBytes: Buffer.byteLength(raw), bodyParse, body });
    return sendJson(res, 401, { error: { code: 401, message: "API key not valid. Please pass a valid API key.", status: "UNAUTHENTICATED" } });
  }
  logStub({ model, stream, auth, status: 200, bodyBytes: Buffer.byteLength(raw), bodyParse, body });
  if (!stream) return sendJson(res, 200, fixedResponse(model));
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
  await writePaced(res, Buffer.from(`data: ${JSON.stringify(chunkResponse(model, "ok", null))}\n\n`));
  await writePaced(res, Buffer.from(`data: ${JSON.stringify(chunkResponse(model, "", "STOP"))}\n\n`));
  return res.end();
}
