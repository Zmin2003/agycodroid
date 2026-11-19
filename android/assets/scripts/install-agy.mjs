// ─────────────────────────────────────────────────────────────────────
//  install-agy.mjs —— 下载 Google 官方的 Antigravity CLI（agy，原版二进制，不做任何修改）
//
//  用法: node install-agy.mjs [latest|<版本号>]      （install-agy.sh 转过来）
//
//  信任从哪来（只有一条）：官方 manifest。
//   ① 读官方 manifest：https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/android_arm64.json
//      （官方 install.sh 同款地址：DOWNLOAD_BASE_URL + "/manifests/" + platform + ".json"，平台 android_arm64）。
//      manifest 返回 {"version","url","sha512"}：version 是当时最新版，url 是 tar.gz 下载地址，sha512 是它的校验和。
//      版本 / URL / sha512 都随发版变化，这里一律不硬编码，运行时现读。
//   ② 按 manifest 的 url 下载 tar.gz，核 sha512，对上才解包；解出名字以 antigravity 结尾的成员，落地为 agy（755）。
//      tar.gz 里没有这个成员、或者 sha512 对不上，都不装。
//   ③ 装进版本目录后先试跑 `agy --version`，跑得起来才切 current 软链；只留当前版 + 上一版。
//      存两份记录供启动前核验：manifest.json 副本（tar.gz 的 sha512）与 agy.sha512（程序本身的 sha512，
//      安装时现算——manifest 的 sha512 是 tar.gz 的，不能直接拿来比程序）。
//  agy 是官方 bionic 安卓构建，直接跑：不需要 glibc 加载器、不用 seccomp 垫片、不用 DNS 桥 / CA 包。
//  agy 没有像 Anthropic 那样的 PGP 签名清单：不要编造签名 / 公钥，信任锚就是 TLS 到官方端点 + manifest 给出的 sha512。
//  manifest 只给最新版：要装的版本如果不是 manifest 当时的最新版、本地又没装过，就装不了（没有按版本取包的官方地址）。
//  已经装过的版本（版本目录里有存下的 manifest.json 副本）可以直接切回去，不用重新下载。
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const MANIFEST_URL = process.env.AGAPP_AGY_MANIFEST_URL
  || "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/android_arm64.json";

const PREFIX = process.env.PREFIX || "";
const CURL = PREFIX ? path.join(PREFIX, "bin", "curl") : "curl";
const TAR = PREFIX ? path.join(PREFIX, "bin", "tar") : "tar";
const DEST = path.join(process.env.HOME, ".local/share/agycodroid/agy");
const CHANNEL = process.argv[2] || "latest";
const say = (s) => console.log(s);
const die = (s) => { console.log("✗ " + s); process.exit(1); };

// curl 退出码 → 人话（只认最常见的几种，其余报原码）；诊断包里靠它分清是断网、DNS、被墙还是证书
const CURL_WHY = { 5: "代理地址解析失败", 6: "域名解析失败", 7: "连不上", 22: "服务器报错", 28: "超时", 35: "TLS 握手失败", 52: "服务器没回应", 56: "连接被中断", 60: "证书校验失败", 77: "读不到根证书" };
let lastWhy = "";
const why = (r) => {
  if (r.error) return r.error.code === "ENOENT" ? "找不到 curl" : r.error.code === "ENOBUFS" ? "回来的内容超出上限" : "curl 起不来：" + r.error.code;
  if (r.signal) return "curl 被系统杀掉：" + r.signal;
  let line = String(r.stderr || "").trim().split("\n").pop().replace(/^curl: \(\d+\)\s*/, "").slice(0, 120);
  if (/proxy/i.test(line)) line = "";   // 代理地址可能是内网主机名，不进日志（诊断包会带出去）
  return (CURL_WHY[r.status] || "curl 退出码 " + r.status) + (line ? " · " + line : "");
};
/** 小文件：curl 拿到内存，失败再试一次，还不行返回 null（不抛）；失败原因留在 lastWhy */
function small(url, t = 20) {
  // file:// 只给测试换地址用（AGAPP_AGY_MANIFEST_URL）：不用 --proto 限制
  const args = url.startsWith("file://")
    ? ["-fsSL", "--connect-timeout", "10", "--max-time", String(t), url]
    : ["-fsSL", "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "10", "--max-time", String(t), url];
  for (let i = 0; i < 2; i++) {
    const r = spawnSync(CURL, args, { maxBuffer: 32 << 20 });
    if (r.status === 0) { lastWhy = ""; return r.stdout; }
    lastWhy = why(r);
  }
  return null;
}
const jsonOf = (b) => { try { return b && JSON.parse(b.toString("utf8")); } catch { return null; } };
// 整串匹配：版本号来自 manifest，要拼进目录，「2.1.0/../x」这种不能放过
const isVer = (v) => /^\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z.]{1,40})?$/.test(v || "");
const sha = (f, alg = "sha512", enc = "hex") => { const h = crypto.createHash(alg), fd = fs.openSync(f, "r"), b = Buffer.alloc(1 << 20); let n; while ((n = fs.readSync(fd, b, 0, b.length)) > 0) h.update(b.subarray(0, n)); fs.closeSync(fd); return h.digest(enc); };
const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

/** 单线 curl 下载（断点续传 -C -；30 秒低于 20 KB/s 就当断了，交给上层重试）。file:// 也照样走 curl */
function fetchTo(url, file) {
  return new Promise((resolve) => {
    const args = url.startsWith("file://")
      ? ["-fsSL", "-C", "-", "-o", file, url]
      : ["-fsSL", "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "15", "--speed-limit", "20480", "--speed-time", "30", "-C", "-", "-o", file, url];
    const c = spawn(CURL, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = ""; c.stderr.on("data", (d) => { err += d; });
    const tick = setInterval(() => console.log(`@progress ${size(file)} 0`), 2000);
    c.on("close", (code) => { clearInterval(tick); console.log(`@progress ${size(file)} 0`); resolve(code === 0 ? "" : (err.trim().split("\n").pop() || "curl " + code).replace(/^curl: \(\d+\) /, "")); });
  });
}

/** 在解开的目录里找名字以 antigravity 结尾的文件成员（只认文件，不跟软链出去）；正好一个才认 */
function findAntigravity(dir) {
  const out = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      const s = fs.lstatSync(p);
      if (s.isDirectory()) walk(p);
      else if (s.isFile() && n.endsWith("antigravity")) out.push(p);
    }
  };
  try { walk(dir); } catch { return null; }
  return out.length === 1 ? out[0] : null;
}

/** 原子切 current 软链，再只留当前版和上一版（正在跑的旧 agy 已经映射进内存，删文件不影响它） */
function switchCurrent(out) {
  const cur = path.join(DEST, "current");
  let prev = ""; try { prev = fs.readlinkSync(cur); } catch {}
  const tmp = cur + ".new"; fs.rmSync(tmp, { force: true }); fs.symlinkSync(out, tmp); fs.renameSync(tmp, cur);
  for (const d of fs.readdirSync(DEST)) {
    const p = path.join(DEST, d);
    if (d.startsWith(".") || d === "current" || p === out || p === prev) continue;
    try { if (fs.lstatSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
}

// ── 1. 官方 manifest（唯一的信任锚：TLS + manifest 给出的 sha512）──────────────
const mRaw = small(MANIFEST_URL, 30);
if (!mRaw) die("官方 manifest 取不到：" + (lastWhy || "网络不通") + "。检查网络后重试（manifest 地址见文件开头）");
const manifest = jsonOf(mRaw);
const MVER = manifest && manifest.version, MURL = manifest && manifest.url, MSHA = manifest && manifest.sha512;
if (!isVer(MVER) || typeof MURL !== "string" || !/^(https|file):\/\//.test(MURL) || !/^[a-f0-9]{128}$/i.test(MSHA || ""))
  die("官方 manifest 内容不对（要 version / url / sha512 三项），没法确认文件是原版：换个网络再试");
const SHA = MSHA.toLowerCase();
say(`最新版 ${MVER}（来自官方 manifest）`);

// ── 2. 要装的版本 ───────────────────────────────────────────────
// latest = manifest 当时的最新版；具体版本号 = 钉住那一版（只在本地已装过时能切回去）
const WANT = isVer(CHANNEL) ? CHANNEL : CHANNEL === "latest" ? MVER : "";
if (!WANT) die(`不认识的版本：${CHANNEL}（填 latest 或 2.1.100 这样的版本号）`);
const OUT = path.join(DEST, WANT);
const BIN = path.join(OUT, "agy");
const storedManifest = (() => { try { return jsonOf(fs.readFileSync(path.join(OUT, "manifest.json"))); } catch { return null; } })();
// manifest 的 sha512 是 tar.gz 的校验和，不是解出程序的：程序本身的 sha512 由安装时另存一份 agy.sha512，启动前核验（gw/agyseal.mjs）比它
const storedBinSha = (() => { try { return fs.readFileSync(path.join(OUT, "agy.sha512"), "utf8").trim(); } catch { return ""; } })();
const storedOk = storedManifest && storedManifest.version === WANT && /^[a-f0-9]{128}$/i.test(storedBinSha || "")
  && fs.existsSync(BIN) && sha(BIN) === storedBinSha.toLowerCase();
if (WANT !== MVER) {
  // 不是最新版：只有本地已装过、且存下的 manifest 副本与二进制对得上时才能切回去；否则没有官方取包地址
  if (storedOk) {
    say(`${WANT} 已装过（与存下的 manifest 副本一致），直接切回去，不重新下载`);
    switchCurrent(OUT);
    process.exit(0);
  }
  die(`${WANT} 不是 manifest 当时的最新版（${MVER}），本地又没装过：官方 manifest 只给最新版的下载地址，装不了这一版`);
}

// ── 3. 下载 tar.gz（manifest 的 url），核 sha512 ───────────────────────
fs.mkdirSync(OUT, { recursive: true });
if (storedOk) say("已是该版本，校验通过");
else {
  const tgz = path.join(OUT, "agy.tgz.part");
  const tagFile = tgz + ".for";
  // 上次断点续传留下来的半截包：是同一份（manifest 的 sha512 没变）才接着下，否则从头来
  try { if (fs.readFileSync(tagFile, "utf8") !== SHA) { fs.rmSync(tgz, { force: true }); fs.writeFileSync(tagFile, SHA); } }
  catch { fs.writeFileSync(tagFile, SHA); }
  let err = await fetchTo(MURL, tgz);
  if (err) {
    // 断了就续传重试一次，还不行就报错（已下的部分留着，下次接着续传）
    say(`  下载断了（${err}），续传重试…`);
    err = await fetchTo(MURL, tgz);
    if (err) die(`下载没成功（${err}）：检查网络后重试（已下的部分会保留，下次接着续传）`);
  }
  const got = sha(tgz);
  if (got !== SHA) { fs.rmSync(tgz, { force: true }); die(`sha512 不符（期望 ${SHA.slice(0, 12)}…，实得 ${got.slice(0, 12)}…），没装`); }
  say("✓ sha512 与官方 manifest 一致");
  // 解包：tar.gz 里名字以 antigravity 结尾的成员就是程序本身
  const x = path.join(OUT, "x"); fs.rmSync(x, { recursive: true, force: true }); fs.mkdirSync(x);
  const r = spawnSync(TAR, ["-xzf", tgz, "-C", x]);
  if (r.status !== 0) { fs.rmSync(x, { recursive: true, force: true }); die("解包失败：" + String(r.stderr || "").trim()); }
  const member = findAntigravity(x);
  if (!member) { fs.rmSync(x, { recursive: true, force: true }); die("tar.gz 里没有名字以 antigravity 结尾的成员，没装"); }
  fs.renameSync(member, BIN);
  fs.rmSync(x, { recursive: true, force: true }); fs.rmSync(tgz, { force: true }); fs.rmSync(tagFile, { force: true });
  // 存一份 manifest.json 副本供启动前核验（gw/agyseal.mjs）：它记的是 tar.gz 的 sha512；
  // 程序本身的 sha512 另存 agy.sha512，核验时比它（manifest 的 sha512 是 tar.gz 的，不能直接比程序）
  try { fs.writeFileSync(path.join(OUT, "manifest.json"), mRaw); } catch (e) { say("  manifest 副本没存上：" + e.message); }
  try { fs.writeFileSync(path.join(OUT, "agy.sha512"), sha(BIN) + "\n"); } catch (e) { say("  程序校验和没存上：" + e.message); }
  try { fs.writeFileSync(path.join(DEST, ".source"), MURL + "\n"); } catch {}
}

// ── 4. 先试跑新版，跑得起来才换上，留一版旧的 ─────────────────────
// 先换 current 再试跑的话，试跑失败会让 current 指着一个跑不起来的版本，旧版明明还在却用不上
// agy 是官方 bionic 构建，直接跑：不用 glibc 加载器、不用 preload
fs.chmodSync(BIN, 0o755);
{
  const env = { ...process.env }; delete env.LD_PRELOAD;
  const r = spawnSync(BIN, ["--version"], { stdio: "inherit", env });
  if (r.status !== 0) die("新版本试跑失败（--version 没跑通），没有换上，继续用原来的版本");
}
switchCurrent(OUT);
process.exit(0);
