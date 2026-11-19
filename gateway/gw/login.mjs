import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CFG, PATHS, log, tz } from "./config.mjs";
import { isLoginMode, noteLoggedIn } from "./models.mjs";
import { agyBlocked, agyCmd, agyEnv, killTree, runAntigravity } from "./agy.mjs";
import { RUNS } from "./runs.mjs";
import { keyOf, providerById, upsertProvider } from "./providers.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { toFront } from "./local.mjs";

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
      const manual = (L.out.match(/https:\/\/\S+/) || [""])[0];
      if ((auto && manual) || L.done || Date.now() - L.startedAt > 20000) {
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
export let AUTH_CACHE = null;
let AUTH_GOOD = null;   // 最后一次问出结果的状态
export async function authStatus(force) {
  if (!force && AUTH_CACHE && Date.now() - AUTH_CACHE.at < 30000) return AUTH_CACHE.v;
  const r = await runAntigravity(["-p", "ping", "--output-format", "json"], { timeoutMs: 30000 });
  const out = (r.out || "") + "\n" + (r.err || "");
  if (r.code === 0) {
    const v = { loggedIn: true, authMethod: "google", email: null, org: null, plan: null };
    AUTH_CACHE = { at: Date.now(), v }; AUTH_GOOD = v;
    noteLoggedIn(true);
    return v;
  }
  if (/authentication required/i.test(out)) {
    const v = { loggedIn: false, authMethod: "none", email: null, org: null, plan: null };
    AUTH_CACHE = { at: Date.now(), v }; AUTH_GOOD = v;
    noteLoggedIn(false);
    return v;
  }
  const error = String(out || "").trim().split("\n").pop().slice(0, 300) || "exit " + r.code;
  const v = AUTH_GOOD ? { ...AUTH_GOOD, stale: true, error } : { loggedIn: false, authMethod: "none", email: null, org: null, plan: null, unknown: true, error };
  AUTH_CACHE = { at: Date.now(), v };
  return v;
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
    const st = await authStatus(need || u.searchParams.get("refresh") === "1");
    let url = "";
    if (LOGIN && !LOGIN.done) {
      try { url = fs.readFileSync(LOGIN.urlFile, "utf8").trim(); } catch {}
      if (!url) url = (LOGIN.out.match(/https:\/\/\S+/) || [""])[0];
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
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && p === "/api/login/logout") {
    // 看每一轮实际用的那家，不只看全局默认：全局是 API Key、某个会话单独选了 Google 账户时也算（审查 B19）
    if ([...RUNS.values()].some((r) => !r.ended && isLoginMode(providerById(r.provider) || undefined))) return sendJson(res, 409, { error: "busy", message: tz("这一轮还在生成，等它跑完再退出登录。") });
    const P = providerById("gemini");
    if (P && keyOf(P)) {
      // API Key 模式：清掉存着的 key 就等于退出
      upsertProvider({ ...P, key: "" });
      AUTH_CACHE = null; AUTH_GOOD = null; noteLoggedIn(false);
      return sendJson(res, 200, { ok: true, message: tz("已清除保存的 Gemini API Key。") });
    }
    // OAuth 模式：`agy auth logout` 是未确认的子命令（官方文档没写），把结果原样带给界面
    const r = await runAntigravity(["auth", "logout"], { timeoutMs: 20000 });
    AUTH_CACHE = null;
    if (r.code === 0) { noteLoggedIn(false); AUTH_GOOD = null; }
    return sendJson(res, 200, { ok: r.code === 0, output: (r.out + r.err).slice(-500) });
  }
  return NEXT;
}
