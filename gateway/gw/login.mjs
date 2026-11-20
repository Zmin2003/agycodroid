import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CFG, log, tz } from "./config.mjs";
import { dropModelCache, fetchModels, isLoginMode, loginState, modelsProbeActive, noteLoggedIn } from "./models.mjs";
import { normUsage } from "./stream.mjs";
import { agyBlocked, agyCmd, agyEnv, killTree, runAntigravity, toFront } from "./agy.mjs";
import { RUNS } from "./runs.mjs";
import { keyOf, providerById, upsertProvider, PROVIDER } from "./providers.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";

// ── 账户登录（OAuth 全程由 agy 自己完成；网关只转递地址，不碰凭据）────────
//
// 两条路：
//   google（OAuth）：起一个裸 agy（交互式界面），它会自己打开系统浏览器完成 Google 登录，
//         之后 headless 模式直接用缓存下来的凭据（官方文档原话：
//         "Headless mode uses your cached credentials. Authenticate once with an interactive agy session first."）。
//         网关尽力把授权地址递给界面：
//           · agy 如果认 $BROWSER（Unix 惯例，未在官方文档里确认）：我们的"浏览器"是个小脚本，只把地址写进文件，由界面交给系统浏览器打开；
//           · 否则 agy 会把授权地址打印到 stdout/stderr（SSH 流程就是这样：打印唯一授权地址，用户在本地登录，
//             浏览器显示一串字母数字码，再贴回终端），网关从输出里扫出地址。
//         注意：裸 agy 是交互式 TUI，没有 TTY 时它可能表现异常——最稳的路是在终端里直接跑一次 `agy`，
//         或者走 Gemini API Key。网关这里不假装它一定能成：拿不到地址就如实报错。
//   apikey（Gemini API Key）：不在这里登录。设置 → 接口与型号 里填 key，网关只在起 agy 子进程时
//         把 GEMINI_API_KEY 写进那个进程的环境（agy 只从环境变量读 key，文件里配了 modelProvider: gemini
//         但环境里没 key 时它启动不了）。
// 以前的 /api/login/code（接收授权码再写进 stdin）没有了：授权码只贴给 agy 自己的提示，网关不经手凭据。
let LOGIN = null;
const LOGIN_DIR = path.join(CFG.home, ".cache", "agyapp-login");

// 授权地址：优先认 Google 授权的特征（accounts.google.com / oauth），别抓第一个 https 链接
// 就当授权地址；末尾的标点（) ] . , 等）不是地址的一部分，去掉（M4）
function pickAuthUrl(text) {
  const urls = (String(text || "").match(/https:\/\/[^\s"'<>]+/g) || [])
    .map((u) => u.replace(/[)\]}.,;:!?'"]+$/, ""));
  return urls.find((u) => /accounts\.google\.com|oauth/i.test(u)) || urls[0] || "";
}

function authEnv() {
  const P = providerById("google");
  const env = agyEnv({ provider: P });
  delete env.GEMINI_API_KEY;
  return env;
}

async function loginStart() {
  const blocked = await agyBlocked();
  if (blocked) return { ok: false, message: blocked };
  if (LOGIN && LOGIN.child.exitCode === null) try { killTree(LOGIN.child); } catch {}
  fs.mkdirSync(LOGIN_DIR, { recursive: true });
  const urlFile = path.join(LOGIN_DIR, "url");
  const browser = path.join(LOGIN_DIR, "browser.sh");
  try { fs.unlinkSync(urlFile); } catch {}
  fs.writeFileSync(browser, '#!/system/bin/sh\nprintf "%s\\n" "$1" > "' + urlFile + '"\n', { mode: 0o700 });
  const env = { ...authEnv(), BROWSER: browser };
  const [cmd0, args0] = agyCmd([]);
  const child = spawn(cmd0, args0, { cwd: CFG.home, env, stdio: ["ignore", "pipe", "pipe"] });
  const L = LOGIN = { child, out: "", startedAt: Date.now(), done: false, ok: false, urlFile };
  // 登录不完成不能永久挂：最多 15 分钟，到点收掉子进程并把状态结掉（0.6.9 审计 195-R.9）
  const expire = setTimeout(() => {
    if (L.done) return;
    L.done = true; L.ok = false; L.out += "\n" + tz("登录超时（15 分钟）");
    try { killTree(child); } catch {}
    log("登录：超时");
  }, 15 * 60e3);
  expire.unref?.();
  const onData = (d) => { L.out += String(d); };
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");   // 按流解码：多字节字符跨块不会被拆坏
  child.stdout.on("data", onData); child.stderr.on("data", onData);
  child.on("error", (e) => {
    clearTimeout(expire);
    if (L.done) return;
    L.done = true; L.ok = false; L.out += "\n" + (e.code || e.message);
    log("登录：没起来（" + (e.code || e.message) + "）");
  });
  child.on("close", (code) => {
    clearTimeout(expire);
    if (L.done) return;   // error / 超时之后可能还会补一个 close，已经结过账了
    L.done = true;
    L.ok = code === 0;
    log("登录：" + (L.ok ? "成功" : "结束（退出码 " + code + "）"));
    // 浏览器授权完停在成功页上，用户不知道怎么回来 —— 主动把界面叫回前台
    if (L.ok) toFront("登录成功").then((r) => log("登录：回到前台 → " + (r.via || r.message || "?")));
  });
  log("登录：已启动交互式 agy（Google OAuth）");
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      let auto = "";
      try { auto = fs.readFileSync(urlFile, "utf8").trim(); } catch {}
      const manual = pickAuthUrl(L.out);
      // 任一来源拿到地址就返回：以前要 auto 和 manual 同时有才提前返回，agy 不认 $BROWSER 时
      // 只有 manual，要等满 20 秒浏览器才跳出来（M4）；晚到的另一条地址轮询里再补开
      if ((auto || manual) || L.done || Date.now() - L.startedAt > 20000) {
        clearInterval(tick);
        if (auto || manual) return resolve({ ok: true, url: auto || manual, manualUrl: manual, auto: !!auto });
        // 20 秒还没拿到地址，但 agy 还在跑：别判失败（晚到的地址还能从 /api/login/status 取），
        // 交给界面继续轮询；真退出了才算失败（0.6.9 审计 195-G.4）
        if (!L.done) return resolve({ ok: true, pending: true, url: null, message: tz("登录还在进行，拿到授权地址后会打开") });
        resolve({ ok: false, message: tz("没拿到登录地址。交互式 agy 没有 TTY 时可能无法正常工作，请在终端里直接跑一次 agy 完成登录，或改用 Gemini API Key。"), output: L.out.slice(-1500) });
      }
    }, 200);
  });
}

/** 登录状态：用一次最小的 headless 调用探（`agy -p "ping" --output-format json`，30 秒超时，缓存 30 秒）。
 *  注意这会产生一次真实的模型调用（很小），不是免费的。
 *  成功 → 已登录；输出里有 authentication required → 未登录；别的失败（起不来、超时、解析不了）
 *  不能当成「未登录」—— 有上次问出的就沿用并标明是旧的，没有就标「不知道」，把原因带给界面（#102 04-010）。
 *  agy 不报账号/组织/套餐：email/org/plan 恒为 null。 */
// ping 的 --output-format json 吐的是 stream-json 事件流（每行一个事件，见 stream.mjs）：
// result 事件的 result.usage 就是这次 ping 的用量；没有 result 时退到最后一条带 usage 的
// step_update。前端要的是短字段（input / output / thinking / cache_read / total，见
// 09-settings.js usageHtml），这里用 normUsage() 归一化后再转短字段——不编字段：ping
// 输出里没有 usage 就返回 null，前端照旧显示“发一条消息后显示”（Q-04）。
function pingUsage(out) {
  let stepUsage = null, resultUsage = null;
  for (const line of String(out || "").split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let ev; try { ev = JSON.parse(s); } catch { continue; }
    if (!ev || typeof ev !== "object") continue;
    if (ev.event === "result" && ev.result && ev.result.usage) resultUsage = ev.result.usage;
    else if (ev.event === "step_update" && ev.step_update && ev.step_update.usage) stepUsage = ev.step_update.usage;
    else if (ev.usage) resultUsage = ev.usage;   // 整段就是一个带 usage 的 JSON 对象时也认
  }
  const n = normUsage(resultUsage || stepUsage);
  if (!n) return null;
  const u = { input: n.input_tokens, output: n.output_tokens, thinking: n.thinking_tokens, cache_read: n.cache_read_input_tokens, total: n.total_tokens };
  if (!u.input && !u.output && !u.thinking && !u.cache_read && !u.total) return null;   // 全 0 的空 usage 不算有数
  return u;
}

export let AUTH_CACHE = null;   // 只缓存默认（全局）探针的结果：caps.mjs 的 /api/status 照读它
const AUTH_CACHE_BY = new Map();   // 按 provider 指名探的，另记（Google 卡片问 google 时别污染全局那份）
let AUTH_GOOD = null;   // 最后一次问出结果的状态
let AUTH_GOOD_PROVIDER = null;   // 那次探的是哪家：stale 回退只认同一家探出的结果
function clearAuthCache() { AUTH_CACHE = null; AUTH_CACHE_BY.clear(); AUTH_GOOD = null; AUTH_GOOD_PROVIDER = null; }

/** 登录状态：用一次最小的 headless 调用探（`agy -p "ping" --output-format json`，30 秒超时，缓存 30 秒）。
 *  注意这会产生一次真实的模型调用（很小），不是免费的。
 *  成功 → 已登录；输出里有 authentication required → 未登录；别的失败（起不来、超时、解析不了）
 *  不能当成「未登录」—— 有上次问出的就沿用并标明是旧的，没有就标「不知道」，把原因带给界面（#102 04-010）。
 *  agy 不报账号/组织/套餐：email/org/plan 恒为 null。
 *  providerId：指名探哪家（"google" / "gemini"）。不给就是全局生效那家。M1：全局切到 gemini
 *  时默认探针靠 key 成功，只说明 key 能用——authMethod 按实际填，且 key 模式的成功不写
 *  LOGGED_IN（那是 Google 登录态，models.mjs 的 providerList 靠它认 google 卡片能不能用）；
 *  Google 卡片要问 google 那边有没有登录，就传 "google" 指名探（09-settings.js renderLoginCard）。 */
export async function authStatus(force, providerId) {
  const probe = providerById(providerId) || PROVIDER;
  const cache = providerId ? AUTH_CACHE_BY.get(probe.id) : AUTH_CACHE;
  if (!force && cache && Date.now() - cache.at < 30000) return cache.v;
  const r = await runAntigravity(["-p", "ping", "--output-format", "json"], { timeoutMs: 30000, provider: probe });
  const out = (r.out || "") + "\n" + (r.err || "");
  const save = (v) => { const c = { at: Date.now(), v }; if (providerId) AUTH_CACHE_BY.set(probe.id, c); else AUTH_CACHE = c; return v; };
  if (r.code === 0) {
    // 按实际探的那家写，别写死 "google"：全局切到 Gemini Key 时探针成功只说明 Key 能用（L1）
    const usage = pingUsage(r.out);
    const was = loginState();
    const v = { loggedIn: true, authMethod: probe.id === "gemini" ? "gemini" : "google", email: null, org: null, plan: null, ...(usage ? { usage } : {}) };
    AUTH_GOOD = v; AUTH_GOOD_PROVIDER = probe.id;
    // 只有 Google 那边的成功才写 LOGGED_IN：key 模式的成功不代表 Google 账号登录着（M1 另一半）
    if (v.authMethod === "google") {
      noteLoggedIn(true);
      // 首次由未登录变已登录：登录态刚就绪，立刻重拉一次模型清单（`agy models` 此时可跑），
      // 不用等用户手动进模型面板才看到新清单。models.mjs 借 authStatus 探登录态时不触发
      // （modelsProbeActive），否则同一轮里 agy models 会跑两遍。失败也不影响本次登录回执。
      if (was !== true && !modelsProbeActive()) fetchModels(true, providerById("google")).catch(() => {});
    }
    return save(v);
  }
  if (/authentication required/i.test(out)) {
    const v = { loggedIn: false, authMethod: "none", email: null, org: null, plan: null };
    AUTH_GOOD = v; AUTH_GOOD_PROVIDER = probe.id;
    // 只有指名探 google 探出的“没登录”才是否定 Google 登录态：key 失效说明不了 Google 那边
    if (probe.id === "google") {
      const was = loginState();
      noteLoggedIn(false);
      // 刚掉线：之前拉到的 live 清单作废，下次按未登录回静态兜底
      if (was === true) dropModelCache();
    }
    return save(v);
  }
  const error = String(out || "").trim().split("\n").pop().slice(0, 300) || "exit " + r.code;
  const v = (AUTH_GOOD && AUTH_GOOD_PROVIDER === probe.id) ? { ...AUTH_GOOD, stale: true, error } : { loggedIn: false, authMethod: "none", email: null, org: null, plan: null, unknown: true, error };
  return save(v);
}

// ── 路由：/api/login/start /api/login/status /api/login/cancel /api/login/logout ──
export async function routeLogin(req, res, u, p) {
  if (req.method === "POST" && p === "/api/login/start") {
    const b = JSON.parse((await readBody(req)) || "{}");
    if (b.method === "apikey") {
      return sendJson(res, 200, { ok: true, apikey: true,
        message: tz("Gemini API Key 在 设置 → 接口与型号 里填。填好之后不用再登录，直接发消息就行。") });
    }
    return sendJson(res, 200, await loginStart());
  }
  if (req.method === "GET" && p === "/api/login/status") {
    // 先置 reported 再 await：并发请求以前会各拉一次状态探针（0.6.9 审计 195-G.8）
    const need = !!(LOGIN && LOGIN.done && !LOGIN.reported);
    if (LOGIN && LOGIN.done) LOGIN.reported = true;
    const st = await authStatus(need || u.searchParams.get("refresh") === "1", u.searchParams.get("provider") || undefined);
    let url = "";
    if (LOGIN && !LOGIN.done) {
      try { url = fs.readFileSync(LOGIN.urlFile, "utf8").trim(); } catch {}
      if (!url) url = pickAuthUrl(LOGIN.out);
    }
    return sendJson(res, 200, {
      ...st,
      pending: !!(LOGIN && !LOGIN.done),
      url: url || null,          // 20 秒后才拿到的授权地址，界面轮询时补开（0.6.9 审计 195-G.4）
      last: LOGIN && LOGIN.done ? { ok: LOGIN.ok, output: LOGIN.ok ? "" : LOGIN.out.slice(-800) } : null,
    });
  }
  if (req.method === "POST" && p === "/api/login/cancel") {
    if (LOGIN && !LOGIN.done) try { killTree(LOGIN.child); } catch {}
    clearAuthCache();   // LG-17：取消登录后 30 秒内不能再显旧的已登录态
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && p === "/api/login/logout") {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || "{}") || {}; } catch { body = {}; }
    const want = typeof body.provider === "string" ? body.provider : "";
    if (want && want !== "google" && want !== "gemini")
      return sendJson(res, 400, { ok: false, error: "bad provider", message: tz("只认 google / gemini 两家。") });
    // M2：以前不管用户在 Google 卡片点退出还是别的，先查 gemini 有无 key，有就只清 key 直接
    // return——想退 OAuth 的实际只（尝试）清了 key。现在按用户点的卡片 / 指名的那家退：
    // 指名哪家就只退哪家；没指名就两边依次处理、分别回执（Google 那边只在有登录过的证据时
    // 才试——没探过登录态时不猜它登没登过；设置页 Google 卡片调时一定带 provider=google）。
    // Google 登录的轮次在跑时照旧 409（审查 B19）；只退 key 时不拦它，key 自己的 409 由
    // upsertProvider 回（B8 的失败要报真失败，不能再回 200“已清除”）。
    const googleEvidence = AUTH_GOOD_PROVIDER === "google" && !!(AUTH_GOOD && AUTH_GOOD.loggedIn);
    if (want !== "gemini" && [...RUNS.values()].some((r) => !r.ended && isLoginMode(providerById(r.provider) || undefined)))
      return sendJson(res, 409, { error: "busy", message: tz("这一轮还在生成，等它跑完再退出登录。") });
    const results = {};
    const msgs = [];
    // Gemini API Key 那边：清掉存着的 key 就等于退出（B8）
    if (want !== "google") {
      const P = providerById("gemini");
      if (P && keyOf(P)) {
        // 旧代码 upsertProvider({ ...P, key: "" }) 是错的：签名是 (id, b, prepare)，
        // 对象当 id 传，PRESETS["[object Object]"] 为空直接 early return，key 根本没清；
        // 而且就算传对了，body 的字段名是 apiKey 不是 key，空串还是“不改”的意思——
        // 只有 clearKey: true 才会删 key。返回值必须查：gemini 的轮次在跑时
        // upsertProvider 会回 409 busy，失败要报真失败，不能再回 200“已清除”。
        const rr = upsertProvider("gemini", { clearKey: true });
        if (rr.error) return sendJson(res, rr.status || 400, { ok: false, error: rr.error, message: rr.message, results });
        clearAuthCache();   // key 模式的探针结果已失效；LOGGED_IN 不动（那是 Google 登录态）
        results.gemini = { ok: true, message: tz("已清除保存的 Gemini API Key。") };
        msgs.push(results.gemini.message);
      } else {
        results.gemini = { ok: true, skipped: true, message: tz("没有保存的 Gemini API Key。") };
      }
    }
    // Google OAuth 那边：`agy auth logout` 是未确认的子命令（官方文档没写），把结果原样带给界面
    if (want === "google" || (!want && googleEvidence)) {
      const r = await runAntigravity(["auth", "logout"], { timeoutMs: 20000 });
      const ok = r.code === 0;
      if (ok) { noteLoggedIn(false); clearAuthCache(); }
      else AUTH_CACHE = null;   // 这次没问出来：默认探针的缓存作废，下次状态查询重探
      results.google = { ok, output: (r.out + r.err).slice(-500) };
      msgs.push(ok ? tz("已退出 Google 账户登录。") : tz("退出 Google 账户登录失败。"));
      return sendJson(res, 200, { ok, message: msgs.join(""), results, ...(ok ? {} : { output: results.google.output }) });
    }
    return sendJson(res, 200, { ok: true, message: msgs.join("") || tz("已退出登录。"), results });
  }
  return NEXT;
}
