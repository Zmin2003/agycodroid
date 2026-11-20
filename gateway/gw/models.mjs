import { SETTINGS } from "./settings-store.mjs";
import { PROVIDER, keyOf, providerBrief, providerById } from "./providers.mjs";
import { NEXT, sendJson } from "./http.mjs";
import { effectiveModel } from "./sessmodel.mjs";
import { effectiveAutoCompact } from "./stream.mjs";

// ── 模型清单：`agy models` 是第一来源，静态清单只作离线兜底 ─────────
// agy 有公开的模型列表子命令 `agy models`（TSV，每行 `<slug>\t<人类可读名>`，
// 需登录、按账户权限返回；1.1.12 实测不支持 `--output-format json`，1.5.13 是否支持
// 未经证实——先按 TSV 解析，JSON 只在 `--help` 里看到该 flag 时才试，失败回落 TSV）。
// agy 不公布上下文窗口：清单里的窗口一律是“不知道（0）”，除非用户手填或某轮 result
// 里真的带回了 modelUsage.contextWindow（见 learnWindow）。不要在这里编一串模型名、
// 也不要编一张窗口表：用户想用什么 slug 直接填，agy 不认识的会在 headless 下直接报错退出，
// 不会静默换一个（见 README）。
export let MODELS = null, MODELS_AT = 0, MODELS_FOR = null;
const CACHE = new Map();   // 接口 id → { list, at, source, note, defaultId }
const CACHE_TTL_MS = 10 * 60e3;   // 缓存 10 分钟
const EXAMPLE_MODELS = [
  { id: "gemini-3.8-flash-medium", name: "gemini-3.8-flash-medium", context_window: 0, max_output_tokens: 0, input_modalities: ["text"], effort: { supported_levels: ["low", "medium", "high", "xhigh", "max"], default_level: null } },
];

// ── 输入栏模型选单列哪几家 ──
// 以前「走登录」「本机」一律算能用：没登录的官方账户、没下过模型的端侧也挂在选单里，点了用不了（群友 10-31）。
// Google 账户：login.mjs 每次探过登录态都报到这里；网关刚起还没问过，就当没登录（不再读 ~/.claude/.credentials.json——
// agy 的凭据不在那里）。用户还能在设置里把某家从选单里藏起来（hidden），配置照留
let LOGGED_IN = null;
export function noteLoggedIn(v) { LOGGED_IN = v == null ? null : !!v; }   // null = 当没问过（测试复位用）
// 发送前预检（LG-15）只读这个值：true = 探过，已登录；false = 探过，明确没登录；
// null = 还没问过，不能当没登录（网关刚起、用户又确实登着时拦了就是误拦）。
export const loginState = () => LOGGED_IN;
/** models.mjs 正在借 authStatus 探登录态（见 fetchModels）：login.mjs 的“登录后刷新模型”
// 钩子在这期间不要再触发一次 fetchModels，否则同一轮里 agy models 会跑两遍。 */
let PROBE_ACTIVE = false;
export const modelsProbeActive = () => PROBE_ACTIVE;
const loginReady = () => LOGGED_IN === true;
export function providerList() {
  const hide = new Set(Array.isArray(SETTINGS.hiddenProviders) ? SETTINGS.hiddenProviders : []);
  return providerBrief().map((p) => ({
    ...p,
    usable: p.keyMode === "key" ? p.usable : p.login ? loginReady() : p.usable,
    hidden: hide.has(p.id),
  }));
}

export function isLoginMode(p = PROVIDER) { return !!(p && p.login && !keyOf(p)); }

// agy 的 --effort 认的全部档位（官方文档：low, medium, high, xhigh, max）。
// 官方没有公布哪个模型支持哪几档，所以全部五档都给，CLI 自己校验（不认识的组合会在 headless 下报错退出）。
const AGY_EFFORT = ["low", "medium", "high", "xhigh", "max"];
export function effortLevelsOf(model, p = PROVIDER) {
  const lv = model && model.effort && model.effort.supported_levels;
  return Array.isArray(lv) ? lv : AGY_EFFORT;
}

/** 事后学习上下文窗口：`result.modelUsage[k].contextWindow` 是目前唯一“可能”带窗口的来源，
 *  但未经证实（真机还没抓到过带该字段的 result 事件）。读到了才学，读不到就什么都不做——
 *  绝不编默认值。只学清单里已有的 slug（没见过的名字不写进配置）；学到的窗口写进内存缓存，
 *  再持久化到该接口配置的 extraModels（复用手填结构，不新造存储），下一轮 /api/models 就带上。
 *  调用方：stream.mjs 的 translate 在 result 事件里调；run.mjs 也可以在轮后调。 */
export async function learnWindow(result, p = PROVIDER) {
  try {
    const mu = result && result.modelUsage;
    if (!mu || typeof mu !== "object") return false;
    const pid = p && p.id;
    if (!pid) return false;
    const known = new Map(cachedModels(p).map((m) => [m.id, m]));
    const learned = [];
    for (const [id, st] of Object.entries(mu)) {
      const win = st && Number(st.contextWindow);
      if (!okWindow(win)) continue;
      if (!known.has(id)) continue;
      if (Number(known.get(id).context_window) === win) continue;
      learned.push({ id, contextWindow: win });
    }
    if (!learned.length) return false;
    // 先写内存缓存（下面持久化那步会清缓存，事后按这份快照放回去）
    const before = CACHE.get(pid);
    const list = (before && before.list ? before.list : staticList(p)).map((m) => {
      const hit = learned.find((e) => e.id === m.id);
      return hit ? { ...m, context_window: hit.contextWindow } : m;
    });
    CACHE.set(pid, { list, at: Date.now(), source: (before && before.source) || "static", note: before ? before.note : null, defaultId: before ? before.defaultId : null });
    if (pid === PROVIDER.id) { MODELS = list; MODELS_AT = Date.now(); MODELS_FOR = pid; }
    // 再持久化：extraModels 是手填结构，学到的窗口按同一形状写进去
    const { upsertProvider, providerById } = await import("./providers.mjs");
    const fresh = providerById(pid) || p;
    const merged = extraModelsOf(fresh);
    for (const e of learned) {
      const ex = merged.find((x) => x.id === e.id);
      if (ex) ex.contextWindow = e.contextWindow; else merged.push({ ...e });
    }
    const r = upsertProvider(pid, { extraModels: merged });
    if (r && r.error) return false;   // 持久化失败：内存里那份还在，下一轮照旧能用
    // upsertProvider 清了 CACHE：把学到的这份放回去（live 清单不能丢成静态清单）
    const after = CACHE.get(pid);
    if (!after || !after.list) CACHE.set(pid, { list, at: Date.now(), source: (before && before.source) || "static", note: before ? before.note : null, defaultId: before ? before.defaultId : null });
    return true;
  } catch { return false; }
}
/** 别名（init 里报的实际模型名） */
export const ALIAS_SEEN = {};
function withWindows(list) { return list; }   // 没有窗口可补，原样返回

// 模型名由用户决定：除了英文，也有中文、方括号标价格的。
// 只挡空白、逗号和控制 / 格式字符（换行、零宽、双向覆盖），其余交给 agy；长度仍限 128。
export const MODEL_ID_RE = /^[^\s,\p{Cc}\p{Cf}]{1,128}$/u;
/** 接口卡里另加的型号：[{ id, contextWindow }]。配置能分享导入、也能手改，按形状过一遍，最多 64 个 */
export function extraModelsOf(p) {
  const seen = new Set(), out = [];
  for (const e of Array.isArray(p && p.extraModels) ? p.extraModels : []) {
    const id = e && typeof e.id === "string" ? e.id.trim() : "";
    if (!MODEL_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, contextWindow: okWindow(Number(e.contextWindow)) ? Number(e.contextWindow) : 0 });
    if (out.length >= 64) break;
  }
  return out;
}
const okWindow = (n) => Number.isInteger(n) && n >= 1024 && n <= 16777216;

// 清空 / 让它过期：别的模块改不了这几个变量（ES 模块的导入是只读的），走这两个函数
export function dropModelCache() { MODELS = null; MODELS_AT = 0; MODELS_FOR = null; CACHE.clear(); }
export function expireModelCache() { MODELS_AT = 0; for (const c of CACHE.values()) c.at = 0; }

/** 静态清单（离线兜底）：文档示例 + 这家接口卡里用户自己加的 slug。 */
function staticList(p) {
  const one = (e) => ({ id: e.id, name: e.id, context_window: e.contextWindow || 0, max_output_tokens: 0, input_modalities: ["text"], effort: { supported_levels: AGY_EFFORT, default_level: null } });
  const out = [...EXAMPLE_MODELS];
  for (const e of extraModelsOf(p)) if (!out.some((m) => m.id === e.id)) out.push(one(e));
  return out;
}

/** 解析 `agy models` 的输出。TSV：每行第一个 tab 字段是 slug，第二字段是人类可读名；
 *  兼容 1.1.12 之前的裸 slug 行。JSON（`--output-format json`，1.5.13 是否支持未经证实）：
 *  数组或 `{ models: [...] }`，每项取 model/id/slug，name/label 作显示名，default/is_default
 *  标默认项。脏行（空行、带空白、进度行）一律丢弃，只认 MODEL_ID_RE。JSON 解析不出有效项时
 *  回空——调用方再按 TSV 试一遍，不要因 JSON 不可用而整体失败。 */
export function parseAgyModels(text) {
  const out = [], seen = new Set();
  const push = (id, name, isDefault) => {
    id = typeof id === "string" ? id.trim() : "";
    if (!MODEL_ID_RE.test(id) || seen.has(id)) return null;
    seen.add(id);
    const m = { id, name: (typeof name === "string" && name.trim()) || id, context_window: 0, max_output_tokens: 0, input_modalities: ["text"], effort: { supported_levels: AGY_EFFORT, default_level: null } };
    out.push(m);
    return isDefault ? id : null;
  };
  let defaultId = null;
  const s = String(text || "").trim();
  if (s.startsWith("{") || s.startsWith("[")) {
    try {
      const j = JSON.parse(s);
      const arr = Array.isArray(j) ? j : Array.isArray(j.models) ? j.models : Array.isArray(j.data) ? j.data : null;
      if (arr) for (const it of arr) {
        if (typeof it === "string") { const d = push(it); if (d) defaultId = d; continue; }
        if (it && typeof it === "object") {
          const d = push(it.model || it.id || it.slug, it.name || it.label, it.default === true || it.is_default === true);
          if (d) defaultId = d;
        }
      }
    } catch { /* JSON 不可用：下面按 TSV 再试 */ }
    if (out.length) return { list: out, defaultId };
    if (s.startsWith("{") || s.startsWith("[")) {
      // 看着像 JSON 但一项都没解析出来：别再把它当 TSV 逐行啃（大括号行只会全被当脏行丢掉，
      // 结果一样是空——直接回空，让调用方按“空输出”走 stale 分级）
      return { list: [], defaultId: null };
    }
  }
  for (const line of String(text || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const [slug, label] = t.split("\t");
    const s = (slug || "").trim();
    // 表头行（MODEL / Model / Slug / Name / Label）不是模型；只有单词的脏行
    // （Loading / Fetching... / Downloading 这类进度输出）也不是模型：真实的 agy slug
    // 都带 - 或数字（如 gemini-3.8-flash-medium）。JSON 路径不受这条影响（结构化数据）。
    if (/^(model|models|slug|name|label)$/i.test(s)) continue;
    if (!/[-0-9]/.test(s)) continue;
    const d = push(slug, label);
    if (d) defaultId = d;
  }
  return { list: out, defaultId };
}

/** 这家清单的来源：`live`（刚从 agy 拉到）/ `static`（离线兜底或未登录）/ `stale`（拉取失败，旧缓存）。
 *  note：`not_logged_in` / `no_models_for_account` / `fetch_failed` / null。 */
export function modelsMeta(p = PROVIDER) {
  const c = p && CACHE.get(p.id);
  if (c) return { source: c.source || "static", note: c.note || null, defaultId: c.defaultId || null, at: c.at || 0 };
  return { source: "static", note: null, defaultId: null, at: 0 };
}
function storeList(p, list, source, note, defaultId) {
  CACHE.set(p.id, { list, at: Date.now(), source, note: note || null, defaultId: defaultId || null });
  if (p.id === PROVIDER.id) { MODELS = list; MODELS_AT = Date.now(); MODELS_FOR = p.id; }
  return list;
}
/** live 清单 + 手填 extraModels 合并：live 里的 slug 以 live 为准（窗口用手填的补），
 *  live 里没有的手填项追加在后面——手填的模型不能因为拉到了 live 清单就消失。 */
function mergeExtra(live, p) {
  const out = live.map((m) => {
    const ex = extraModelsOf(p).find((e) => e.id === m.id);
    return ex && ex.contextWindow ? { ...m, context_window: ex.contextWindow } : m;
  });
  for (const e of extraModelsOf(p)) if (!out.some((m) => m.id === e.id)) out.push({ id: e.id, name: e.id, context_window: e.contextWindow || 0, max_output_tokens: 0, input_modalities: ["text"], effort: { supported_levels: AGY_EFFORT, default_level: null } });
  return out;
}

/** p：哪家（缺省 = 全局生效的）。force=true 或缓存超 10 分钟才重跑；否则用缓存。
 *  live 拉取只在界面驱动的调用上做（opts.guess=true：/api/models 与 /model 命令）——
 *  网关启动预热（server.mjs 的 fetchModels(true)）不走 live：探登录态是一次真实模型调用，
 *  启动时探成本过高，留到用户第一次打开模型面板 / 设置页时再探。
 *  live 只认 google（OAuth 登录态）与 gemini（存了 Key 才试；Key 模式下 agy models 是否
 *  可用未经证实，失败按 stale 分级，不静默编清单）。
 *  失败分级：stdout 含 authentication required → 未登录（回静态，标 static/not_logged_in）；
 *  含 no model configuration is available for this account → 该账户无可用模型（回空——
 *  只留手填 extraModels——标 live/no_models_for_account，不回落静态示例）；
 *  超时 / 非 0 / 空输出 → 保留旧缓存标 stale，没缓存就回静态标 stale/fetch_failed。 */
export async function fetchModels(force, p = PROVIDER, { guess = false, runner, timeoutMs = 15000 } = {}) {
  const cached = CACHE.get(p.id);
  if (!force && cached && cached.list && Date.now() - cached.at < CACHE_TTL_MS) return cached.list;
  const run = runner || (async (args, o) => {
    const { runAntigravity } = await import("./agy.mjs");
    return runAntigravity(args, o);
  });
  const canLive = async () => {
    if (!guess) return false;
    if (p.id === "google") {
      if (LOGGED_IN === true) return true;
      if (LOGGED_IN === false) return false;
      // 还没问过登录态：只探一次（authStatus 本身就是一次真实模型调用，缓存 30 秒）。
      // 探针成功时 login.mjs 的钩子会直接调 fetchModels(true) 刷新，这里不再重复跑。
      PROBE_ACTIVE = true;
      try {
        const { authStatus } = await import("./login.mjs");
        const st = await authStatus(false, "google");
        return st && st.loggedIn === true;
      } catch { return false; } finally { PROBE_ACTIVE = false; }
    }
    if (p.id === "gemini") return !!keyOf(p);
    return false;
  };
  if (await canLive()) {
    // 先试 JSON：只在 `agy models --help` 里看到 --output-format 这个 flag 时才试；
    // 1.1.12 实测不支持，失败（或解析不出）就回落 TSV，不要因 JSON 不可用而整体失败。
    try {
      const help = await run(["models", "--help"], { timeoutMs: 10000, provider: p });
      if (help && help.code === 0 && /--output-format/.test((help.out || "") + "\n" + (help.err || ""))) {
        const jr = await run(["models", "--output-format", "json"], { timeoutMs, provider: p });
        if (jr && jr.code === 0 && !jr.timeout) {
          const parsed = parseAgyModels(jr.out || "");
          if (parsed.list.length) return storeList(p, mergeExtra(parsed.list, p), "live", null, parsed.defaultId);
        }
      }
    } catch { /* JSON 探测失败：回落 TSV */ }
    const r = await run(["models"], { timeoutMs, provider: p }).catch((e) => ({ out: "", err: String(e && e.message || e), code: -1 }));
    const combined = (r.out || "") + "\n" + (r.err || "");
    if (/authentication required/i.test(combined)) {
      if (p.id === "google") noteLoggedIn(false);
      return storeList(p, staticList(p), "static", "not_logged_in", null);
    }
    if (/no model configuration is available for this account/i.test(combined)) {
      // 该账户无可用模型：回空（只留手填的 extraModels），不要把静态示例冒充成拉到的清单
      const onlyExtra = mergeExtra([], p);
      return storeList(p, onlyExtra, "live", "no_models_for_account", null);
    }
    const parsed = (!r.timeout && r.code === 0) ? parseAgyModels(r.out || "") : { list: [], defaultId: null };
    if (parsed.list.length) return storeList(p, mergeExtra(parsed.list, p), "live", null, parsed.defaultId);
    // 超时 / 非 0 / 空输出 / 解析不出：保留旧缓存标 stale；没缓存就回静态标 stale
    if (cached && cached.list) {
      CACHE.set(p.id, { ...cached, source: "stale", note: "fetch_failed" });
      return cached.list;
    }
    return storeList(p, staticList(p), "stale", "fetch_failed", null);
  }
  // 不走 live：未登录回静态（标 static/not_logged_in），其余回静态兜底；
  // 但缓存里若已有 live/stale 的清单且没过期，上面已经直接返回了，不会走到这里。
  const note = p.id === "google" && LOGGED_IN === false ? "not_logged_in" : null;
  return storeList(p, staticList(p), "static", note, null);
}
/** 已缓存的那家清单（不发请求）；没拉过就现算一份静态清单 */
export function cachedModels(p = PROVIDER) {
  const c = CACHE.get(p.id);
  if (c && c.list) return c.list;
  return staticList(p);
}
/** agy 的 --effort 档位收敛到该模型真正支持的档位。
 *  没设过（want 为空）就保持不设 —— 由模型自己决定，别替用户做主。 */
export function normEffort(model, want, p = PROVIDER) {
  if (!want) return null;
  const ok = effortLevelsOf(model, p);
  if (ok.includes(want)) return want;
  return (model && model.effort && model.effort.default_level) || null;
}

/** agy 没有 /compact、也不报窗口：压缩线恒为 null（保留导出名，调用方照调）。 */
export function defaultCompactLine(win, p) { return null; }
export function compactLineOf(set, win, p) { return null; }

// ── 路由：/api/models ──
export async function routeModels(req, res, u, p) {
  if (req.method === "GET" && p === "/api/models") {
    // ?sid=：按这个会话记下的接口 / 模型 / 档位回（0.3.16 起每个会话各用各的）；不给就是全局默认
    // ?model= / ?effort= / ?provider=：还没会话号的新会话在面板里先选了（前端暂存，随第一条消息带走），按选的回
    // ?browse=接口：面板里点开别的接口看它的模型（只换清单，current 仍是这个会话的）
    const sid = u.searchParams.get("sid") || "", q = (k) => (u.searchParams.has(k) ? u.searchParams.get(k) : null);
    const now = effectiveModel(sid, q("project"), { provider: q("provider"), model: q("model"), effort: q("effort") });
    const pp = providerById(now.provider) || PROVIDER;
    const bp = (u.searchParams.get("browse") && providerById(u.searchParams.get("browse"))) || pp;
    const ms = withWindows(await fetchModels(u.searchParams.get("refresh") === "1", bp, { guess: true }));
    const own = withWindows(bp === pp ? ms : cachedModels(pp));
    const meta = modelsMeta(bp);
    // 只认同名：指定了（或那家有默认型号）却不在清单里，能力和窗口就是不知道，别借第一项的（#82，和 currentModelInfo 一致）
    const want = now.model || pp.defaultModel;
    const cur = (want ? own.find((m) => m.id === want) : own[0]) || {};
    return sendJson(res, 200, {
      models: ms,
      source: meta.source,               // live = 刚从 agy models 拉到；static = 离线兜底；stale = 拉取失败，旧缓存
      sourceNote: meta.note,             // not_logged_in / no_models_for_account / fetch_failed / null
      resolvedDefault: meta.defaultId,   // agy models 输出里标出的默认项（TSV 没有，JSON 有才填）；没有就是 null，别拿清单第一项冒充
      current: now.model || null,
      provider: pp.id,                       // 这个会话用的那家
      listProvider: bp.id,                   // models 是哪家的
      globalProvider: PROVIDER.id,
      providers: providerList(),
      nativeModels: !!bp.nativeModels,
      defaultModel: bp.defaultModel || null,
      effort: now.effortRun || null,          // 真跑时的档位（跟来的档位那家不支持时已换过）
      effortLevels: effortLevelsOf(cur, pp),
      effortDefault: (cur.effort && cur.effort.default_level) || null,
      // agy 不报窗口：前端用量条和门限按 0（不知道）算，不写死
      contextWindow: Number(cur.context_window) || 0,
      maxOutputTokens: Number(cur.max_output_tokens) || 0,
      autoCompactWindow: effectiveAutoCompact(),
      compactLine: null,
      compactDefault: null,
    });
  }
  return NEXT;
}
