// ── 应用内通知：维护者推一两句话给所有用户（出了什么问题、该怎么绕、哪版修了）─────
//
// 来源：仓库 notices/notices.json，维护者在发布机上用组件索引那把 ed25519 钥匙签名（notices.json.sig），
// 只从 GitHub 取（raw.githubusercontent.com/Zmin2003/agycodroid），只认签名对得上的那份 ——
// 仓库被人改了也推不出假通知。
// 内容只当纯文本显示；链接只认 https。按 App 版本范围（minVer / maxVer）和有效期（from / until）筛选，
// 「知道了」记在 home/.config/agycodroid/notices-seen.json，同一条不再显示。
// 不发任何本机信息：就是一次普通的 GET，和检查更新一样。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG, LIVE, PREFIX, log } from "./config.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { privCall } from "./usage.mjs";

const SOURCES = (process.env.AGAPP_NOTICES_URL ? [process.env.AGAPP_NOTICES_URL] : [])
  .concat(["https://raw.githubusercontent.com/Zmin2003/agycodroid/main/notices/notices.json"]);
// 与组件索引同一把公钥（gw/components.mjs）；Antigravity CLI 验证记录（gw/ccverified.mjs）也用它。测试（AGAPP_TEST=1）时可换成测试钥匙
export const PUBKEY = crypto.createPublicKey(!LIVE && process.env.AGAPP_TEST_PUBKEY ? process.env.AGAPP_TEST_PUBKEY :
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAQJPFI78YJdSCFuHjAsDXBjpEPJYBMH4Ib+elSkcuxSQ=\n-----END PUBLIC KEY-----\n");
const EVERY = 3 * 3600e3;
/** 读回验过签才存的那份：正文原样字节 + 旁边的 .sig；签名对不上、缺 .sig（旧版存的）都当没有，等下次联网重取 */
function loadSigned(file) {
  try {
    const body = fs.readFileSync(file), sig = fs.readFileSync(file + ".sig", "utf8").trim();
    if (!crypto.verify(null, body, PUBKEY, Buffer.from(sig, "base64"))) { log(`[signed] ${path.basename(file)} 签名对不上，不认`); return null; }
    return JSON.parse(body.toString("utf8"));
  } catch { return null; }
}
/** 存正文原样字节（不重新序列化，签名才对得上）和签名；先写 .sig 再换正文，换到一半也只是验不过、当没有 */
function saveSigned(file, body, sig) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".sig.tmp", sig); fs.renameSync(file + ".sig.tmp", file + ".sig");
  fs.writeFileSync(file + ".tmp", body); fs.renameSync(file + ".tmp", file);
}
const CACHE = path.join(CFG.home, ".cache", "agycodroid", "notices.json");
const SEEN = path.join(CFG.home, ".config", "agycodroid", "notices-seen.json");

let data = null, fetchedAt = 0, lastError = "", appVer = "", busy = null;
// 磁盘上那份连同签名一起存（CACHE.sig），读回来再验一遍：同 uid 的程序能写这个文件，没签名的不认（审查 11-05 安全 1）
data = loadSigned(CACHE);

const readSeen = () => { try { return new Set(JSON.parse(fs.readFileSync(SEEN, "utf8")).dismissed || []); } catch { return new Set(); } };

// 版本比较（NT-14：与 Updater.java 的 cmpVer 同一规则，semver §11）：
//   先比数字核心（0.3.10 > 0.3.9，超长数字段按长度再按字典序比，不丢精度）；
//   核心相同且只有一边带预发布后缀时，带后缀的低于同一核心无后缀的版本
//   （0.2.0-rc1 < 0.2.0，不然 rc 用户收不到正式版的通知）；
//   两边都带后缀时，后缀按 `.` 分段比：纯数字段按数值、纯数字段小于字母段、
//   字母段按 ASCII 字典序、段少的小；`+` 后的构建元数据不参与比较。
//   注意字母段是严格字典序：rc10 < rc2（不要按嵌的数字比，否则与 Java 侧不一致）。
// 以前这里只比数字核心、后缀直接丢掉，0.2.0-rc1 和 0.2.0 算相等，minVer/maxVer 过滤会放错通知。
function cmpNums(a, b) {
  const x = String(a ?? "").split(/[^0-9]+/), y = String(b ?? "").split(/[^0-9]+/);
  while (x.length && x[x.length - 1] === "") x.pop();   // Java 的 split 会去掉尾部空串
  while (y.length && y[y.length - 1] === "") y.pop();
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = (i < x.length ? x[i] : "").replace(/^0+/, ""), q = (i < y.length ? y[i] : "").replace(/^0+/, "");
    if (p.length !== q.length) return p.length < q.length ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}
function stripBuild(v) {
  const s = String(v ?? "");
  const i = s.indexOf("+");
  return i === -1 ? s : s.slice(0, i);
}
// 预发布后缀按 semver §11 分段比较（与 Updater.java 的 cmpPrerelease 同一规则）。
function cmpPrerelease(a, b) {
  const x = String(a ?? "").split(".");
  const y = String(b ?? "").split(".");
  while (x.length && x[x.length - 1] === "") x.pop(); // 与 Java split 一致，去尾部空段
  while (y.length && y[y.length - 1] === "") y.pop();
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (i >= x.length) return -1;
    if (i >= y.length) return 1;
    const p = x[i], q = y[i];
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) {
      const pp = p.replace(/^0+/, ""), qq = q.replace(/^0+/, "");
      if (pp.length !== qq.length) return pp.length < qq.length ? -1 : 1;
      return pp < qq ? -1 : 1;
    }
    if (pn) return -1;
    if (qn) return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
export function cmpVer(a, b) {
  const pa = stripBuild(a).split("-", 2), pb = stripBuild(b).split("-", 2);
  const c = cmpNums(pa[0], pb[0]);
  if (c) return c;
  const sa = pa.length > 1, sb = pb.length > 1;
  if (sa !== sb) return sa ? -1 : 1;
  return sa ? cmpPrerelease(pa[1], pb[1]) : 0;
}

async function fetchOne(url) {
  const get = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(20000), headers: { "cache-control": "no-cache" } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); };
  const body = await get(url), sig = (await get(url + ".sig")).toString("utf8").trim();
  if (!crypto.verify(null, body, PUBKEY, Buffer.from(sig, "base64"))) throw new Error("签名对不上");
  const j = JSON.parse(body.toString("utf8"));
  if (!Array.isArray(j.notices)) throw new Error("格式不对");
  return { j, body, sig };
}

export async function refreshNotices(force = false) {
  if (busy) return busy;
  if (!force && Date.now() - fetchedAt < EVERY) return;
  busy = (async () => {
    if (PREFIX && !appVer) {
      const st = await privCall({ op: "upd_status" }, 5000).catch(() => ({}));
      appVer = st?.items?.find?.((i) => i.id === "app")?.current || "";
    }
    const errs = [];
    for (const u of SOURCES) {
      try {
        const { j, body, sig } = await fetchOne(u);
        // 两个来源可能一新一旧（官网每半小时同步）：只往新的换
        if (!data || !(String(j.updated || "") < String(data.updated || ""))) {
          data = j;
          saveSigned(CACHE, body, sig);
        }
        fetchedAt = Date.now(); lastError = "";
        return;
      } catch (e) { errs.push(`${new URL(u).host}：${e.cause?.code || e.message}`); }
    }
    fetchedAt = Date.now() - EVERY + 600e3;     // 都失败：10 分钟后再试
    lastError = errs.join("；");
    log(`[notices] 取不到：${lastError}`);
  })().finally(() => { busy = null; });
  return busy;
}

const pick = (o, lang) => (o && typeof o === "object" ? o[lang] || o.zh || o.en || "" : String(o || ""));

function active(lang) {
  // 用本机时区的日期：toISOString() 是 UTC，东八区在 0–8 点会把当天的通知判成还没到
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return (data?.notices || []).filter((n) => n && n.id
    && (!n.from || n.from <= today) && (!n.until || n.until >= today)
    // notices M2：appVer 为空（网关没起来、版本号取不到）时，带版本范围的通知不显示——
    // 没法判断它属不属于这台机器，宁可不推（以前 !appVer 直接放行，写给旧版的升级提醒会推给新版用户）。
    // 不带版本范围的照常显示
    && (!n.minVer || (appVer && cmpVer(appVer, n.minVer) >= 0))
    && (!n.maxVer || (appVer && cmpVer(appVer, n.maxVer) <= 0))
  ).map((n) => ({
    id: String(n.id), level: n.level === "warn" ? "warn" : "info", date: n.from || n.date || "",
    title: pick(n.title, lang), body: pick(n.body, lang),
    link: /^https:\/\/[^\s"'<>]+$/.test(n.link || "") ? n.link : "",
    linkText: pick(n.linkText, lang),
  }));
}

// 后台每 3 小时取一次。界面只在打开应用 / 切回前台时来要（用的时候不打扰），那时过期了就当场取，最多等 8 秒
if (LIVE) setInterval(() => refreshNotices().catch(() => {}), EVERY).unref?.();

// GET /api/notices[?lang=en&all=1]：要显示的通知（all=1 连已关掉的一起，给设置页「通知」看）
// POST /api/notices/dismiss {id}：知道了
export async function routeNotices(req, res, u, p) {
  if (p === "/api/notices" && req.method === "GET") {
    await Promise.race([refreshNotices().catch(() => {}), new Promise((r) => setTimeout(r, 8000))]);
    const lang = (u.searchParams.get("lang") || "zh").startsWith("zh") ? "zh" : "en";
    const seen = readSeen(), all = active(lang);
    const items = u.searchParams.get("all") === "1" ? all.map((n) => ({ ...n, seen: seen.has(n.id) })) : all.filter((n) => !seen.has(n.id));
    // fetching：还在取（前端 8 秒等不到时能看到「正在取」而不是当成没有通知）；
    // cached：手上有验过签的旧数据。error 非空就是这次没取到（0.6.9 审计 195-R.8）
    return sendJson(res, 200, { ok: true, items, error: lastError, at: fetchedAt, fetching: !!busy, cached: !!data });
  }
  if (p === "/api/notices/dismiss" && req.method === "POST") {
    let id = "";
    try { id = String(JSON.parse(await readBody(req)).id || ""); } catch {}
    if (!id) return sendJson(res, 400, { ok: false });
    const seen = readSeen(); seen.add(id);
    // 只留还在发布的那些 id，文件不会越积越大
    const live = new Set((data?.notices || []).map((n) => String(n.id)));
    fs.mkdirSync(path.dirname(SEEN), { recursive: true });
    fs.writeFileSync(SEEN, JSON.stringify({ dismissed: [...seen].filter((x) => live.has(x) || x === id) }));
    return sendJson(res, 200, { ok: true });
  }
  return NEXT;
}
