import { SETTINGS } from "./settings-store.mjs";
import { PROVIDER, keyOf, providerBrief, providerById } from "./providers.mjs";
import { NEXT, sendJson } from "./http.mjs";
import { effectiveModel } from "./sessmodel.mjs";
import { effectiveAutoCompact } from "./stream.mjs";

// ── 模型清单：静态的，没有 /models 可拉 ─────────────────────────────
// agy 没有公开的模型列表接口，官方文档只给过一个例子 slug（gemini-3.8-flash-medium）。
// 所以清单 = 那个文档示例 + 用户在接口卡里自己加的 slug（extraModels）。
// 不要在这里编一串模型名：用户想用什么 slug 直接填，agy 不认识的会在 headless 下直接报错退出，
// 不会静默换一个（见 README）。
export let MODELS = null, MODELS_AT = 0, MODELS_FOR = null;
const CACHE = new Map();   // 接口 id → { list, at }
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

/** agy 不报上下文窗口：learnWindow 是空操作（保留导出名，调用方照调）。 */
export function learnWindow(result, p = PROVIDER) {}
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

/** 静态清单（见文件头）：文档示例 + 这家接口卡里用户自己加的 slug。 */
function staticList(p) {
  const one = (e) => ({ id: e.id, name: e.id, context_window: e.contextWindow || 0, max_output_tokens: 0, input_modalities: ["text"], effort: { supported_levels: AGY_EFFORT, default_level: null } });
  const out = [...EXAMPLE_MODELS];
  for (const e of extraModelsOf(p)) if (!out.some((m) => m.id === e.id)) out.push(one(e));
  return out;
}

/** p：哪家（缺省 = 全局生效的）。静态清单不需要网络，force 也一样。 */
export async function fetchModels(force, p = PROVIDER, { guess = false } = {}) {
  const list = staticList(p);
  CACHE.set(p.id, { list, at: Date.now() });
  if (p.id === PROVIDER.id) { MODELS = list; MODELS_AT = Date.now(); MODELS_FOR = p.id; }
  return list;
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
    // 只认同名：指定了（或那家有默认型号）却不在清单里，能力和窗口就是不知道，别借第一项的（#82，和 currentModelInfo 一致）
    const want = now.model || pp.defaultModel;
    const cur = (want ? own.find((m) => m.id === want) : own[0]) || {};
    return sendJson(res, 200, {
      models: ms,
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
