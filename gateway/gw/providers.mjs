import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CFG, PATHS, log, tz } from "./config.mjs";
import { SETTINGS, saveSettings } from "./settings-store.mjs";
import { MODEL_ID_RE, dropModelCache, extraModelsOf } from "./models.mjs";
import { RUNS } from "./runs.mjs";
import { NEXT, fetchText, readBody, sendJson } from "./http.mjs";
import { readSmallFile } from "./saferead.mjs";
import { isObj, loadState, saveState } from "./statefile.mjs";
import { onShutdown } from "./crashguard.mjs";

// ── 接口配置：只有两家，都是 Antigravity 官方的 ─────────────────────
//   google：Google OAuth 登录（agy 自己完成，网关不碰凭据；见 login.mjs）
//   gemini：Gemini API Key（settings.json 里 modelProvider: gemini + 环境变量 GEMINI_API_KEY）
// 自定义的 Anthropic 兼容接口没有了：agy 不认 ANTHROPIC_BASE_URL，
// 以前那套第三方厂商目录（DeepSeek / GLM / Qwen …）是给 Claude Code 用的，
// 换 agy 后全部失效。旧 agyapp-providers.json 里存的那些条目会被忽略（文件本身不动，
// 下次保存也不会把它们写丢——只是界面不再列出来）。
const PROVIDERS_FILE = path.join(CFG.home, "agyapp-providers.json");
export const SEED_FILE = process.env.AGAPP_SEED || "/sdcard/DeepSeekHarness/claude-apk/config.json";   // files.mjs 还在用这个导出名（种子导入），值留着

// 内置接口（默认生效的是 google：OAuth 是 agy 的第一登录方式）
export const BUILTIN_PROVIDER = {
  id: "google",
  label: "Google 账户登录",
  labelEn: "Google account sign-in",
  group: "google",
  login: true,
  nativeModels: false,
  defaultModel: "",
  hint: "用 Google 账户登录 Antigravity（OAuth 由 agy 自己完成，网关不碰凭据）。先在终端里跑一次 agy 完成登录，或在设置里点「登录」。",
  hintEn: "Sign in to Antigravity with a Google account (OAuth is done by agy itself; the gateway never touches your credentials).",
};

const PRESETS = {
  google: {
    ...BUILTIN_PROVIDER,
  },
  gemini: {
    id: "gemini",
    label: "Gemini API Key",
    labelEn: "Gemini API Key",
    group: "gemini",
    login: false,
    nativeModels: false,
    defaultModel: "",
    keyUrl: "https://aistudio.google.com/apikey",
    hint: "Google AI Studio 的 Gemini API Key。网关只在起 agy 子进程时把 GEMINI_API_KEY 写进那个进程的环境（agy 只从环境变量读 key）。",
    hintEn: "A Gemini API key from Google AI Studio. The gateway only puts GEMINI_API_KEY into the agy child process environment at spawn (agy reads the key only from the environment).",
  },
};

// 端侧小模型没有了（local llama 是给 Claude Code 挂本地 llama-server 的，agy 没有这条路）。
// local.mjs 还在用这两个导出名，留作不会被用到的常量，避免它启动即崩。
export const LLAMA_PORT = Number(process.env.AGAPP_LLAMA_PORT) || 8811;
export const LLAMA_KEY_FILE = path.join(CFG.home, ".cache", "llama-api-key");

// 预置条目只从配置文件里取这些"属于用户"的字段；其余以目录为准。
const USER_FIELDS = ["apiKey", "defaultModel", "extraModels", "inlineImages"];

/** 配置文件里的模型清单也要过一遍形状：它和自定义厂商一样是用户可以手改/分享进来的。 */
const cleanModel = (m) => {
  if (!m || typeof m !== "object") return null;
  const id = typeof m.id === "string" ? m.id.trim().slice(0, 200) : "";
  if (!id) return null;
  const out = { ...m, id, name: typeof m.name === "string" ? m.name.slice(0, 200) : id };
  const lv = out.effort && out.effort.supported_levels;
  if (out.effort && typeof out.effort === "object" && Array.isArray(lv))
    out.effort = { ...out.effort, supported_levels: lv.filter((x) => typeof x === "string").slice(0, 32) };
  else delete out.effort;
  for (const k of ["context_window", "max_output_tokens"]) if (!Number.isFinite(out[k]) || out[k] < 0) delete out[k];
  if (!Array.isArray(out.input_modalities)) delete out.input_modalities;
  return out;
};
const cleanModels = (a) => Array.isArray(a) ? a.slice(0, 500).map(cleanModel).filter(Boolean) : [];

/** 合成一条生效配置：目录 + 用户字段 */
// 配置文件能手改、能分享导入：这几个字段该是字符串的不是（数字、对象、数组），拼进 --model / 环境变量时
// 每一轮起跑就失败。先从 raw 里拿掉（0.6.9 审计 199-5-03）
const STR_FIELDS = ["defaultModel", "apiKey"];
function cleanRaw(id, raw) {
  if (!raw || !STR_FIELDS.some((k) => raw[k] != null && typeof raw[k] !== "string")) return raw;
  const out = { ...raw };
  for (const k of STR_FIELDS) if (out[k] != null && typeof out[k] !== "string") { log(`⚠️ 接口 ${id} 的 ${k} 不是字符串，不用`); delete out[k]; }
  return out;
}
function composeProvider(id, raw) {
  const pre = PRESETS[id];
  if (!pre) return null;
  raw = cleanRaw(id, raw);
  const v = { ...pre };
  for (const k of USER_FIELDS) if (raw && raw[k] != null && raw[k] !== "") v[k] = raw[k];
  if (raw && Array.isArray(raw.fallbackModels) && raw.fallbackModels.length) v.fallbackModels = cleanModels(raw.fallbackModels);
  return v;
}

// 三张表都不带原型：id 是外面传进来的，providers["constructor"] / PRESETS["__proto__"] 不能被当成认识的厂商（v0514 审查低-4）
Object.setPrototypeOf(PRESETS, null);
const bare = (o) => Object.assign(Object.create(null), o);
let PROVIDERS_RAW = { active: null, providers: bare({}) };   // 配置文件原样（只含用户字段）
let PROV_DISK_H = null;    // 盘上那份最后读写时的样子（见 providersDiskCheck）
const provHash = (s) => crypto.createHash("sha256").update(s).digest("hex");
/** 配置文件的形状：顶层是对象，providers 是对象、每条也是对象（别的丢掉） */
function provShape(j) {
  if (!isObj(j)) return undefined;
  const providers = bare({});
  if (isObj(j.providers)) for (const [k, v] of Object.entries(j.providers)) if (isObj(v)) providers[k] = v;
  return { ...j, providers };
}
function loadProviders() {
  // 读坏了（语法错、形状不对）：原文件留底成 .bad-*（厂商 Key 都在里面），按空表起。
  // 以前是静默回落空表，下一次保存就把整份连 Key 一起覆盖掉（0.6.9 审计 P1-1）
  const r = loadState(PROVIDERS_FILE, { shape: provShape, fallback: () => null, max: 4 << 20 });
  if (r.data) {
    PROVIDERS_RAW = r.data;
    const raw = readSmallFile(PROVIDERS_FILE, 4 << 20);
    PROV_DISK_H = raw == null ? null : provHash(raw);
  } else if (r.bad) PROV_DISK_H = null;
  const providers = bare({});
  for (const id of Object.keys(PRESETS)) providers[id] = composeProvider(id, PROVIDERS_RAW.providers[id]);
  // 旧文件里别的条目（第三方厂商 / 自定义接口）不再合成：agy 用不了它们。RAW 里留着，下次保存不丢。
  const active = providers[PROVIDERS_RAW.active] ? PROVIDERS_RAW.active : "google";
  return { active, providers };
}
function saveProvidersRaw() {
  // 随机、独占且不跟随链接的临时文件；旧固定 .tmp 或碰撞文件都不能接收凭据。
  const temp = PROVIDERS_FILE + "." + crypto.randomBytes(12).toString("hex") + ".tmp";
  let fd, created = false;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    created = true;
    const out = JSON.stringify(PROVIDERS_RAW, null, 2);
    fs.writeFileSync(fd, out);
    fs.fsyncSync(fd);     // 先落盘再换名：掉电时不会换上一个还没写进去的空文件（密钥都在这里）
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, PROVIDERS_FILE);
    PROV_DISK_H = provHash(out);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created) { try { fs.unlinkSync(temp); } catch {} }
  }
  PROVIDERS_CFG = loadProviders();
}
/** 网关跑着时厂商配置以内存为准：盘上被别人改了（换接口地址就能把密钥送出去），按内存写回，返回 true（调用方记留痕）。
 *  网关没跑时改的，启动时照常读进来 */
export function providersDiskCheck() {
  if (PROV_DISK_H == null) return false;
  const raw = readSmallFile(PROVIDERS_FILE, 4 << 20);
  if (raw != null && provHash(raw) === PROV_DISK_H) return false;
  try { saveProvidersRaw(); return true; } catch (e) { log(`[厂商配置] 写回失败：${e.message}`); return false; }
}
export let PROVIDERS_CFG = loadProviders();
// 受控修复会重写整表，必须核对整份原始配置，包括删除的字段、无关接口和 active。
export const providersDiskMatches = (disk) => isDeepStrictEqual(disk, { ...PROVIDERS_RAW, providers: { ...PROVIDERS_RAW.providers } });

/** 给界面看的一家：密钥只露末四位 */
function providerView(id, v) {
  const key = String(v.apiKey || "").trim();
  return {
    id, label: v.label || id, labelEn: v.labelEn || "", group: v.group || "google", custom: false,
    login: !!v.login, nativeModels: !!v.nativeModels, local: false,
    baseUrl: "", modelsUrl: "", authStyle: "bearer",
    endpoints: [], endpoint: null,
    defaultModel: v.defaultModel || null, fastModel: null, inlineImages: !!v.inlineImages, contextWindow: 0,
    extraModels: extraModelsOf(v),
    keyUrl: v.keyUrl || null, hint: v.hint || "", hintEn: v.hintEn || "",
    hasKey: !!key, keyTail: key ? key.slice(-4) : "", endpointLost: null,
    plainHttp: false,
    active: id === PROVIDER.id,
  };
}

export function upsertProvider(id, b, prepare) {
  if (!id || !PRESETS[id]) return { error: "unknown provider", message: tz("agycodroid 只有 Google 登录和 Gemini API Key 两家，不支持自定义接口。") };
  const cur = { ...(PROVIDERS_RAW.providers[id] || {}) };
  let keyCleared = false;
  const str = (v) => String(v == null ? "" : v).trim();
  // 预置厂商还没 Key、这次又什么都没给：别回「已保存」，其实什么都没配上（审查 P3-3）
  if (id === "gemini" && "apiKey" in b && !str(b.apiKey) && !cur.apiKey && !b.clearKey
    && !["defaultModel"].some((k) => k in b && str(b[k]) && str(b[k]) !== str(cur[k]))) return { error: "need_key", message: tz("先把 API Key 粘进来再保存") };
  if ("apiKey" in b && str(b.apiKey)) cur.apiKey = str(b.apiKey);   // 空串 = 不改（界面上不回显旧密钥）
  if (b.clearKey) { delete cur.apiKey; keyCleared = true; }
  // 图片随消息发（兼容兜底，见 inlineimg.mjs）
  if ("inlineImages" in b) { if (b.inlineImages === true) cur.inlineImages = true; else delete cur.inlineImages; }
  for (const k of ["defaultModel"]) if (k in b) { if (str(b[k])) cur[k] = str(b[k]); else delete cur[k]; }
  // 另加的型号（接口卡「更多模型」）：[{ id, contextWindow }]，空数组 = 清掉
  if ("extraModels" in b) {
    const list = Array.isArray(b.extraModels) ? b.extraModels : null;
    if (!list || list.length > 64) return { error: "bad_extra_models", message: tz("更多模型最多 64 个") };
    for (const e of list) {
      const mid = e && typeof e.id === "string" ? e.id.trim() : "", n = Number(e && e.contextWindow);
      if (!MODEL_ID_RE.test(mid)) return { error: "bad_extra_models", message: tz("模型名不能有空格、逗号或控制字符，不超过 128 个字符：{id}", { id: String(e && e.id || "").slice(0, 40) }) };
      if (e.contextWindow && !(Number.isInteger(n) && n >= 1024 && n <= 16777216)) return { error: "bad_context_window", message: tz("上下文窗口填 1024 到 16777216 之间的整数，也可以写 256k、1m") };
    }
    const clean = extraModelsOf({ extraModels: list });
    if (clean.length) cur.extraModels = clean; else delete cur.extraModels;
  }
  // 正在用这家的轮次已经拿了旧密钥：密钥是每次现读（keyOf 按 id 取新的），改了就等它跑完再换（审查 B01）。
  // 只改默认型号、名字这些不碍事，照常放行
  if (("apiKey" in b && str(b.apiKey)) || b.clearKey) {
    const prevKey = String((PROVIDERS_RAW.providers[id] || {}).apiKey || "");
    if (prevKey !== String(cur.apiKey || "") && [...RUNS.values()].some((r) => !r.ended && r.provider === id))
      return { error: "busy", status: 409, message: tz("这一家正在用，等这一轮跑完再改密钥。") };
  }
  const rollback = prepare?.(id), previous = PROVIDERS_RAW.providers[id];
  PROVIDERS_RAW.providers[id] = cur;
  try { saveProvidersRaw(); }
  catch (error) {
    if (previous === undefined) delete PROVIDERS_RAW.providers[id]; else PROVIDERS_RAW.providers[id] = previous;
    try { rollback?.(); } catch { log("[provider] 受管映射回滚未完成"); }
    throw error;
  }
  if (id === PROVIDER.id) applyProvider();
  dropModelCache();   // 会话可能钉在不是全局的这家上：哪家改了都清，免得清单/窗口还是旧的
  log(`[provider] 已保存 ${id}${"apiKey" in b && str(b.apiKey) ? "（含密钥）" : ""}`);
  return { ok: true, id, provider: providerView(id, PROVIDERS_CFG.providers[id]), ...(keyCleared ? { keyCleared: true } : {}) };
}

// ── 用量与消费（设置页的厂商卡片）────────────────────────────────────
// agy 不报花费、也没有余额接口：消费/余额那套整个没有了。
// 只留 token 账本（每轮结束按 agy 报的用量记一笔），用量页和定时任务的花费上限看这个。
const BILL_FILE = path.join(CFG.home, "agyapp-billing.json");
// 账本缺字段时 noteTokens 会抛异常，而 server.mjs 不接 uncaughtException（整条 result 会带崩网关）。
// 读进来先补成完整形状；整体不是对象就按空账本处理。
function billShape(j) {
  if (!j || typeof j !== "object" || Array.isArray(j)) return {};
  for (const [id, b] of Object.entries(j)) {
    if (!b || typeof b !== "object" || Array.isArray(b)) { delete j[id]; continue; }
    // 数组元素也要校验：noteTokens 直接按下标读，null/字符串会抛 TypeError 带崩网关
    if (!Array.isArray(b.spends)) b.spends = [];
    else b.spends = b.spends.filter((x) => Array.isArray(x) && x.length >= 2 && Number.isFinite(x[0]) && Number.isFinite(x[1]));
    if (!Array.isArray(b.tok)) b.tok = [];
    else b.tok = b.tok.filter((x) => Array.isArray(x) && x.length >= 4 && Number.isFinite(x[0]) && Number.isFinite(x[1]) && Number.isFinite(x[2]) && Number.isFinite(x[3]));
    if (!b.tokOld || typeof b.tokOld !== "object") b.tokOld = { in: 0, out: 0, cache: 0 };
    else for (const k of ["in", "out", "cache"]) if (typeof b.tokOld[k] !== "number") b.tokOld[k] = 0;
    if (typeof b.spentOld !== "number") b.spentOld = 0;
    if (typeof b.since !== "number") b.since = Date.now();
  }
  return j;
}
// 账本用无原型对象：provider id 为 __proto__ 时不能把 since/spends/tok 写到 Object.prototype
// 语法坏了 / 太大：原文件留底成 .bad-*，不再当空账本、500ms 后整份写回把消费历史清零（0.6.9 审计 195-Z.5）
let BILL = (() => { const out = Object.create(null); Object.assign(out, loadState(BILL_FILE, { shape: (j) => (isObj(j) ? billShape(j) : undefined) }).data); return out; })();
let billSaveT = null;
// 直接写目标文件会先截断：写一半被杀/满盘就把整个账本毁了，下次启动只能当空账本。临时文件 + fsync + 换名
const flushBill = () => { if (!billSaveT) return; clearTimeout(billSaveT); billSaveT = null; saveState(BILL_FILE, BILL, { pretty: false }); };
const saveBill = () => { clearTimeout(billSaveT); billSaveT = setTimeout(flushBill, 500); };
onShutdown("账本", flushBill);   // SIGTERM 时防抖还没到点的也写下去（195-W.2）
const billOf = (id) => {
  const b = (BILL[id] ||= {});
  b.since ||= Date.now(); b.spends ||= []; b.spentOld ||= 0; b.tok ||= []; b.tokOld ||= { in: 0, out: 0, cache: 0 };
  return b;
};
const KEEP_MS = 92 * 86400e3;   // 明细留三个月，更早的并进累计

/** agy 没有余额接口：永远是 none（billingInfo 只返回 token 账本）。 */
export function billKind(v) { return { kind: "none" }; }

/** 一轮结束记 token（按小时合并） */
export function noteTokens(id, u) {
  if (!id || !u) return;
  noteAdd(id, [u.input_tokens || 0, u.output_tokens || 0, (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)]);
}
/** 运行中的计量（usage.mjs usageMeter）每涨一次记一笔：d.i 是含缓存的输入、d.c 是其中读缓存的、d.o 输出。
 *  以前等 result 才按 result.usage 记：子代理的不在里面、中断的那轮没有 result、跨小时的全算到结束那个小时（0.6.9 审计 195-O.1/O.3/O.4）。
 *  写缓存的那部分并进输入（计量里分不出来） */
export function noteTokenDelta(id, d) {
  if (!id || !d) return;
  const add = [Math.max(0, (d.i || 0) - (d.c || 0)), d.o || 0, d.c || 0];
  if (add[0] || add[1] || add[2]) noteAdd(id, add);
}
function noteAdd(id, add) {
  const b = billOf(id);
  const hour = Math.floor(Date.now() / 3600e3) * 3600e3;
  const last = b.tok[b.tok.length - 1];
  if (last && last[0] === hour) for (let i = 0; i < 3; i++) last[i + 1] += add[i];
  else b.tok.push([hour, ...add]);
  const cut = Date.now() - KEEP_MS;
  while (b.tok.length && b.tok[0][0] < cut) { const x = b.tok.shift(); b.tokOld.in += x[1]; b.tokOld.out += x[2]; b.tokOld.cache += x[3]; }
  saveBill();
}

// 汇率：界面货币跟语言走（中文显示人民币，其余显示美元），token 没有单价所以换算只用于旧账本的显示；半天取一次
// 取不到时退避（0.6.9 审计 195-E.11：以前每次 /api/billing 都重新去等，离线时每次多等十几秒）：
// 失败后 1 分钟内不再试，连续失败翻倍到 1 小时；同时只有一个请求在路上，后来的等它
let FX = null, FX_FAIL = 0, FX_NEXT = 0, FX_FLY = null;
export async function usdCny() {
  if (FX && Date.now() - FX.at < 12 * 3600e3) return FX;
  if (Date.now() < FX_NEXT) return FX;
  if (FX_FLY) return FX_FLY;
  FX_FLY = (async () => {
    try {
      const j = await fetchJson("https://open.er-api.com/v6/latest/USD", {});
      if (j.result === "success" && j.rates && j.rates.CNY) { FX = { rate: +j.rates.CNY, at: Date.now(), src: "open.er-api.com" }; FX_FAIL = 0; return FX; }
      throw new Error("返回不对");
    } catch (e) {
      FX_FAIL++; FX_NEXT = Date.now() + Math.min(3600e3, 60e3 * 2 ** (FX_FAIL - 1));
      log(`汇率获取失败：${e.message}（${Math.round((FX_NEXT - Date.now()) / 60e3)} 分钟内不再试）`);
      return FX;
    } finally { FX_FLY = null; }
  })();
  return FX_FLY;
}
async function fetchJson(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  const text = await fetchText(r);
  let j = null; try { j = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`HTTP ${r.status}：${(j && (j.error?.message || j.message || j.msg)) || text.slice(0, 120)}`);
  return j;
}

/** 用量：只有 token 账本，没有余额、没有花费（agy 不报）。 */
async function billingInfo(id, force) {
  const v = PROVIDERS_CFG.providers[id];
  if (!v) return { error: tz("没有这家接口") };
  const out = { id, kind: "none", hasKey: !!String(v.apiKey || "").trim() };
  const b = BILL[id];
  if (b) Object.assign(out, { since: b.since, spends: b.spends, spentOld: b.spentOld, ledgerCurrency: b.currency || null, tok: b.tok, tokOld: b.tokOld, checkedAt: b.last ? b.last.at : null });
  out.fx = await usdCny();
  return out;
}

/** 一轮跑完：没有余额可查，什么都不做（token 已经由 noteTokenDelta 边跑边记）。保留导出名，run.mjs 照调。 */
export function billAfterRun(id) {}

export let PROVIDER = BUILTIN_PROVIDER;

/** 取密钥：只认这家自己存的那一条。
 *  google（OAuth）→ null：不注入任何密钥，让 agy 用它缓存的登录态。
 *  gemini → 存着的 GEMINI_API_KEY。
 *  不再回落到环境变量 / 历史配置文件：以前那套回落会把别家的钥匙注进不该去的地方
 *  （官方账户切过去时被注成 ANTHROPIC_API_KEY，拿 DeepSeek 钥匙打 api.anthropic.com，全网 401）。
 *  另外注意：网关自己环境里的 GEMINI_API_KEY 也不会被读——agyEnv 只认存着的 key（见 agy.mjs）。 */
function loadApiKey(p) {
  if (!p) return null;
  if (p.login) return null;
  if (p.apiKey) return String(p.apiKey).trim();
  return null;
}

export let API_KEY = null;   // 在 SETTINGS 载入后按「生效接口」解析
/** 按 id 取一家（0.3.16 起各会话可以用不同的接口）：生效的那家直接给 PROVIDER；配置里没有的给 null */
export function providerById(id) {
  if (!id || id === PROVIDER.id) return PROVIDER;
  if (PROVIDERS_CFG && PROVIDERS_CFG.providers[id]) return pickProvider(id);
  return id === BUILTIN_PROVIDER.id ? BUILTIN_PROVIDER : null;
}
/** 各家能不能用（有钥匙 / 走登录），给输入栏的模型面板按接口分组用。钥匙本身不出网关 */
export function providerBrief() {
  const ids = PROVIDERS_CFG ? Object.keys(PROVIDERS_CFG.providers) : [BUILTIN_PROVIDER.id];
  if (!ids.includes(PROVIDER.id)) ids.unshift(PROVIDER.id);
  return ids.map((id) => {
    const p = providerById(id);
    return p && { id, label: p.label || id, labelEn: p.labelEn || "", login: !!p.login, local: false,
      nativeModels: !!p.nativeModels, usable: !!(p.login || keyOf(p)), active: id === PROVIDER.id,
      keyMode: keyOf(p) ? "key" : p.login ? "login" : "none", defaultModel: p.defaultModel || null };
  }).filter(Boolean);
}
/** 这一家的密钥：生效的那家用已解析好的 API_KEY，别家现取（同样的规则，见 loadApiKey） */
export function keyOf(p) {
  if (!p || p === PROVIDER || p.id === PROVIDER.id) return API_KEY;
  return loadApiKey(p);
}

/** 应用当前接口：更新上游与密钥。
 *  模型清单缓存无需在此清除 —— 缓存按接口配置指纹存取（models.mjs 的 sigOf），
 *  换接口自然对不上。 */
export function applyProvider() {
  PROVIDER = resolveProvider();
  CFG.upstream = "";
  API_KEY = loadApiKey(PROVIDER);
}

// PERM_MODES 挪到 config.mjs：settings.mjs 加载时就要用，放这里会因循环依赖在单独导入时撞上暂时性死区（审查 10-30 v0.5.12 低5）
export { PERM_MODES } from "./config.mjs";

// id / explicit 放最后：条目里自带的同名字段不能盖过它们（见 composeProvider）
function pickProvider(id) { return { ...PROVIDERS_CFG.providers[id], id, explicit: !!PROVIDERS_RAW.providers[id] || id !== BUILTIN_PROVIDER.id }; }
/** 生效接口：设置里的 provider 优先，其次配置文件 active，最后内置兜底（google） */
function resolveProvider() {
  const want = SETTINGS.provider;
  if (PROVIDERS_CFG) {
    const pick = pickProvider;
    if (want && PROVIDERS_CFG.providers[want]) return pick(want);
    const a = PROVIDERS_CFG.active;
    if (a && PROVIDERS_CFG.providers[a]) return pick(a);
  }
  return BUILTIN_PROVIDER;
}

/** 测一家能不能用：跑一次最小的 headless 调用（`agy -p "ping" --output-format json`，30 秒超时）。
 *  注意这会产生一次真实的模型调用（很小），不是免费的。
 *  成功 → ok；输出里有 authentication required → 未登录；别的失败 → 把原因带回。 */
async function testProvider(id) {
  const p = providerById(id);
  if (!p) return { ok: false, message: tz("没有这家接口") };
  if (p.login) {
    // OAuth 模式没有 key 可测：直接探登录态（login.mjs 的 authStatus 同款探针）
    const { authStatus } = await import("./login.mjs");
    const st = await authStatus(true);
    if (st.loggedIn) return { ok: true, message: tz("已登录（Google 账户）。") };
    if (st.unknown) return { ok: false, message: tz("测不出来：{err}", { err: st.error || "" }) };
    return { ok: false, message: tz("还没登录。先在终端里跑一次 agy 完成登录，或在设置里点「登录」。") };
  }
  if (!keyOf(p)) return { ok: false, message: tz("还没填 Gemini API Key。") };
  const { runAntigravity } = await import("./agy.mjs");
  const r = await runAntigravity(["-p", "ping", "--output-format", "json"], { timeoutMs: 30000, provider: p });
  const out = (r.out || "") + "\n" + (r.err || "");
  if (r.code === 0) return { ok: true, message: tz("能用（已返回一次模型调用）。") };
  if (/authentication required/i.test(out)) return { ok: false, message: tz("密钥不对或已失效，请重新填。") };
  return { ok: false, message: String(out).trim().split("\n").pop().slice(0, 300) || ("exit " + r.code) };
}

// ── 路由：/api/key /api/providers /api/providers/save /api/providers/delete /api/providers/test /api/billing ──
export async function routeProviders(req, res, u, p) {
  // 老接口：只存密钥。新界面走 /api/providers/save
  if (req.method === "POST" && p === "/api/key") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const k = String(b.apiKey || "").trim();
    if (!k) return sendJson(res, 400, { error: "empty" });
    const r = upsertProvider(b.provider ? String(b.provider) : PROVIDER.id, { apiKey: k });
    return sendJson(res, r.error ? r.status || 400 : 200, r);
  }
  // ── 接口列表（供界面切换用）──
  if (req.method === "GET" && p === "/api/providers") {
    const list = Object.entries(PROVIDERS_CFG.providers).map(([id, v]) => providerView(id, v));
    return sendJson(res, 200, {
      active: PROVIDER.id,
      configFile: PROVIDERS_FILE,
      configFound: fs.existsSync(PROVIDERS_FILE),
      providers: list,
    });
  }
  // 存一家：只收密钥 / 默认模型 / 更多模型 / 图片随消息发
  if (req.method === "POST" && p === "/api/providers/save") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const r = upsertProvider(b.id ? String(b.id) : null, b);
    return sendJson(res, r.error ? r.status || 400 : 200, r);
  }
  if (req.method === "POST" && p === "/api/providers/delete") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const id = String(b.id || "");
    if ([...RUNS.values()].some((r) => !r.ended && r.provider === id)) return sendJson(res, 409, { error: "busy", message: tz("这一家正在用，等这一轮跑完再删。") });
    const previous = PROVIDERS_RAW.providers[id];
    if (!PRESETS[id] && !previous) return sendJson(res, 404, { error: "unknown provider" });
    const wasActive = id === PROVIDER.id;   // 在 applyProvider() 换掉当前接口之前记下
    // 预置接口删不掉，只清空用户字段（密钥等）
    delete PROVIDERS_RAW.providers[id];
    const resetSettings = SETTINGS.provider === id;
    const settingsOld = resetSettings ? { provider: SETTINGS.provider, model: SETTINGS.model } : null;
    if (resetSettings) { SETTINGS.provider = null; SETTINGS.model = null; }
    try {
      saveProvidersRaw();
    } catch (e) {
      // 写盘失败：把它放回内存里的原始表，和磁盘（没变）保持一致；这样再删一次还是这家，不会 404，
      // 也不会被之后保存别的接口时顺手写死（#122-5）
      if (previous === undefined) delete PROVIDERS_RAW.providers[id]; else PROVIDERS_RAW.providers[id] = previous;
      if (settingsOld) { SETTINGS.provider = settingsOld.provider; SETTINGS.model = settingsOld.model; }
      throw e;
    }
    if (resetSettings) saveSettings();   // 接口已经删掉了；设置即使没写进去，加载时也会按「那家不在了」回落
    applyProvider();
    dropModelCache();
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && p === "/api/providers/test") {
    const b = JSON.parse((await readBody(req)) || "{}");
    return sendJson(res, 200, await testProvider(String(b.id || PROVIDER.id)));
  }
  if (req.method === "GET" && p === "/api/billing") {
    return sendJson(res, 200, await billingInfo(String(u.searchParams.get("id") || PROVIDER.id), u.searchParams.get("refresh") === "1"));
  }
  return NEXT;
}

// 设置已在 settings-store.mjs 载入；本模块的变量此时都已初始化，在这里解析生效接口（原来在 settings.mjs 顶层调，单独导入时会撞死区）
applyProvider();
export const _billForTest = { billOf, billShape, noteTokens };   // 只给测试用
