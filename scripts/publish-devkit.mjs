#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
//  publish-devkit.mjs —— 发一版工具包：从打 tag 到镜像、浏览器组件、预览包，一条命令走完，每步核哈希
//
//  用法:  node scripts/publish-devkit.mjs <devkit-YYYY.MM.DD[.n]> [--why "一句话：这版改了什么"] [--install]
//         node scripts/publish-devkit.mjs <tag> --from <步骤>     从某步重来（之前的步骤视为已完成）
//         node scripts/publish-devkit.mjs <tag> --check            只对账，不改任何东西
//         node scripts/publish-devkit.mjs <tag> --only <步骤>      只跑这一步（前面步骤的结果从状态文件里取）
//  步骤:  preflight → tag → ci → fetch → pin → market → chromium → mirror → preview → testmerge → check
//  状态记在 ~/.work/publish/<tag>/state.json：中途断了（网络、CI 失败）再跑同一条命令，从没做完的那步接着来。
//  最后的 check 不信状态文件，从 GitHub / 市场 / 镜像 / APK 重新取一遍逐项核对，有一项不对就退出码 1。
//
//  要的东西（都不进仓库）：gh 已登录（agycodroid 与市场仓库可写）；
//    INDEX_SIGNING_KEY_FILE  组件索引签名钥匙（缺省 bldtools/index-signing-ed25519.pem），重签浏览器组件索引用
//    SITE_KICK               （fork 没有自己的镜像站/官网生成器，mirror 步骤目前跑不起来：见 DL 与 step.mirror；本行留作将来搭了镜像站时用）
//    MARKET                  市场仓库目录（缺省与本仓库同级的 agycodroid-components；首次发布：仓库不存在时 market 步跳过，种子推好后 --from market 补跑）
//    TEST_WT                 test 分支的工作树（有就把 main 合过去，没有就跳过）
//    CHROM_CACHE             浏览器组件的下载缓存（缺省 ~/.work/chrom22/cache）
//  预览包只打不装；加 --install 才用 priv 覆盖安装（会关掉正在用的 agycodroid）。
//  这个脚本只管工具包。App 正式发版仍是 build.sh + release.sh，且要用户点头。
//  fork 现状（2026-11-19）：REPO/MREPO 已指到 Zmin2003/agycodroid；没有自己的镜像站（DL 为空），mirror 步跑不起来；
//  首次发 components Release 的自举（CP-02）：市场仓库不存在时 preflight 不拦、market 步跳过（devkit-only），种子推好后 --from market 补跑；
//  仓库目录在但 bases.json 缺失时从空 bases 生成；chromium 步在 components Release 不存在时从空生成预置索引、上传前先建空 Release；
//  recipes/ 为空且社区索引不存在时 checkMarket 跳过并注明，有配方时缺索引报明确错误。
//  preflight/tag/ci/fetch/pin/preview/testmerge/check（除镜像项、市场项）不受影响。
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const HOME = process.env.HOME;
const REPO = "Zmin2003/agycodroid", MREPO = "Zmin2003/agycodroid-components";
const MARKET = process.env.MARKET || path.join(ROOT, "..", "agycodroid-components");
const KEYFILE = process.env.INDEX_SIGNING_KEY_FILE || (process.env.BLDTOOLS || process.env.HOME + "/.bldtools") + "/index-signing-ed25519.pem";
const TEST_WT = process.env.TEST_WT || path.join(HOME, ".work/cc-testwt");
const CHROM_CACHE = process.env.CHROM_CACHE || path.join(HOME, ".work/chrom22/cache");
const DL = ""; // fork 目前没有自己的镜像站（上游是 https://dl.cccodroid.net）；mirror 步骤见 step.mirror，会直接报停
const STEPS = ["preflight", "tag", "ci", "fetch", "pin", "market", "chromium", "mirror", "preview", "testmerge", "check"];

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? (argv.splice(i, 1), true) : false; };
const WHY = opt("--why") || "", FROM = opt("--from"), ONLY = opt("--only"), CHECK_ONLY = flag("--check"), INSTALL = flag("--install");
const TAG = argv[0];
if (!/^devkit-\d{4}\.\d{2}\.\d{2}(\.\d+)?$/.test(TAG || "")) { console.error("用法: node scripts/publish-devkit.mjs devkit-YYYY.MM.DD[.n] [--why …] [--from 步骤] [--check] [--install]"); process.exit(2); }
if (ONLY && !STEPS.includes(ONLY)) { console.error(`✗ 没有步骤 ${ONLY}`); process.exit(2); }
if (FROM && !STEPS.includes(FROM)) { console.error(`✗ 没有步骤 ${FROM}；可选：${STEPS.join(" ")}`); process.exit(2); }
const BASE = `https://github.com/${REPO}/releases/download/${TAG}/`;

const W = path.join(HOME, ".work/publish", TAG), REL = path.join(W, "rel");
fs.mkdirSync(REL, { recursive: true });
const SF = path.join(W, "state.json");
const state = fs.existsSync(SF) ? JSON.parse(fs.readFileSync(SF, "utf8")) : { tag: TAG, done: {} };
const save = () => fs.writeFileSync(SF, JSON.stringify(state, null, 1) + "\n");

// ── 小工具 ──
const sh = (cmd, args, o = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"], ...o }).trim();
const run = (cmd, args, o = {}) => { const r = spawnSync(cmd, args, { stdio: "inherit", ...o }); if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} … 退出码 ${r.status}`); };
const gh = (...a) => sh("gh", a);
// gh release download/view 在 Release（或附件）不存在时的报错：当成“线上没有”，别当成流程失败
const ghMissing = (e) => /404|not found|no assets match/i.test(`${e.message}\n${e.stderr || ""}`);
const git = (dir, ...a) => sh("git", ["-c", "safe.directory=*", "-C", dir, ...a]);
const gitc = (dir, ...a) => sh("git", ["-c", "safe.directory=*", "-c", "user.name=Zmin2003", "-c", "user.email=zmin2003@users.noreply.github.com", "-C", dir, ...a]);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const shaFile = (f) => new Promise((ok, no) => { const h = crypto.createHash("sha256"); fs.createReadStream(f).on("data", (d) => h.update(d)).on("end", () => ok(h.digest("hex"))).on("error", no); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => console.log(s);
const fail = (s) => { throw new Error(s); };
const json = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const get = async (url, method = "GET") => {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { method, redirect: "follow", signal: AbortSignal.timeout(60000), headers: { "cache-control": "no-cache" } });
      return r;
    } catch (e) { if (i >= 3) throw new Error(`${url}：${e.cause?.code || e.message}`); await sleep(3000 * (i + 1)); }
  }
};
const getBuf = async (url) => { const r = await get(url); if (!r.ok) fail(`HTTP ${r.status} ${url}`); return Buffer.from(await r.arrayBuffer()); };
// 公钥从 App 源码里读（和 App 验签用的同一把），不在这里另抄一份
const PUB = (() => {
  const m = /-----BEGIN PUBLIC KEY-----\\n([A-Za-z0-9+/=]+)\\n-----END PUBLIC KEY-----/.exec(fs.readFileSync(path.join(ROOT, "gateway/gw/components.mjs"), "utf8"));
  if (!m) fail("gateway/gw/components.mjs 里找不到索引公钥");
  return crypto.createPublicKey(`-----BEGIN PUBLIC KEY-----\n${m[1]}\n-----END PUBLIC KEY-----\n`);
})();
const verifySig = (body, sigText) => crypto.verify(null, body, PUB, Buffer.from(String(sigText).trim(), "base64"));
// /sdcard 是 FUSE，小文件 stat 报的大小可能过时，cp/git 会产出空文件：提交前逐个核
const fuseOk = (dir, files) => { for (const f of files) { const p = path.join(dir, f); const a = fs.statSync(p).size, b = fs.readFileSync(p).length; if (a !== b) fail(`${f}：stat ${a} ≠ 实际 ${b}（FUSE 报了过时的大小），等一下再跑`); } };
const writeFresh = (p, data) => { fs.rmSync(p, { force: true }); fs.writeFileSync(p, data); };
const lockOf = () => json(path.join(REL, "devkit.lock.json"));
// 对账不依赖之前的步骤：清单不在就从 Release 取（也能拿来核已经发完的旧版本）
const ensureRel = () => { if (!["devkit.lock.json", "modules.json", "modules.json.sig"].every((f) => fs.existsSync(path.join(REL, f)))) gh("release", "download", TAG, "-R", REPO, "-D", REL, "--clobber", "-p", "devkit.lock.json", "-p", "modules.json", "-p", "modules.json.sig"); };

// 等 CI 跑完：每分钟问一次状态。不用 gh run watch —— 一个半小时里网络抖一下它就非零退出，会把成功的构建当失败
async function waitRun(repo, id) {
  let errs = 0, told = false;
  for (;;) {
    try {
      const r = JSON.parse(gh("run", "view", String(id), "-R", repo, "--json", "status,conclusion"));
      errs = 0;
      // devkit 工作流走 devkit-release 环境：签名钥匙要维护者批准才放出来，批之前一直是 waiting
      if (r.status === "waiting" && !told) { told = true; console.log(`  ⏸ 等审批：到 https://github.com/${repo}/actions/runs/${id} 点 Review deployments → 勾 devkit-release → Approve and deploy`); }
      if (r.status === "completed") return r.conclusion;
    } catch (e) { if (++errs >= 15) fail(`连续 15 分钟查不到 run ${id} 的状态：${e.message.split("\n")[0]}`); }
    await sleep(60000);
  }
}

// ── 各步 ──
const step = {};

step.preflight = async () => {
  gh("auth", "status");
  if (!fs.existsSync(KEYFILE)) fail(`没有索引签名钥匙 ${KEYFILE}（INDEX_SIGNING_KEY_FILE）`);
  // 市场仓库（agycodroid-components）还不存在时不拦死：只发 devkit（devkit-only 发布），
  // market 步与 check 里的市场项在仓库建好之前跳过（首次发布分支，CP-02a）；chromium 步从空生成预置组件索引。
  const marketOk = fs.existsSync(path.join(MARKET, "bases.json"));
  if (!marketOk) say(`  ⚠ 首次发布：市场仓库不在 ${MARKET}（MARKET/bases.json 不存在），这次只发 devkit（devkit-only），不发市场组件；market 步与 check 里的市场项跳过，种子推好后用 --from market 补跑`);
  if (git(ROOT, "rev-parse", "--abbrev-ref", "HEAD") !== "main") fail("agycodroid 不在 main 上");
  if (git(ROOT, "status", "--porcelain")) fail("agycodroid 工作区有未提交的改动：工具包要对应一个确定的提交");
  git(ROOT, "fetch", "-q", "origin", "main", "--tags");
  if (git(ROOT, "rev-parse", "HEAD") !== git(ROOT, "rev-parse", "origin/main")) fail("agycodroid 的 main 和 origin/main 不一致：先推送或拉取");
  if (git(ROOT, "tag", "-l", TAG)) fail(`tag ${TAG} 已经有了（本地或远端）：换个号，或用 --from 接着之前那次`);
  if (marketOk && git(MARKET, "status", "--porcelain")) fail("市场仓库工作区有未提交的改动");
  const prev = json(path.join(ROOT, "devkit-pin.json")).tag;
  if (!DL) say("  ⚠ fork 没有自己的镜像站：mirror 这步跑不起来（见文件头说明），其余步骤继续");
  else if (!process.env.SITE_KICK) say("  ⚠ 没给 SITE_KICK：镜像要等生成器的 30 分钟定时，mirror 这步会多等一会");
  say(`  上一版 ${prev} → 这一版 ${TAG}；提交 ${git(ROOT, "rev-parse", "--short", "HEAD")}`);
  return { prev, commit: git(ROOT, "rev-parse", "HEAD"), market: marketOk, firstRelease: !marketOk };
};

step.tag = async () => {
  const commit = state.done.preflight.commit;
  if (git(ROOT, "rev-parse", "HEAD") !== commit) fail("preflight 之后 HEAD 变了：从 preflight 重来");
  gitc(ROOT, "tag", "-a", TAG, "-m", TAG + (WHY ? "：" + WHY : ""));
  git(ROOT, "push", "-q", "origin", TAG);
  return { commit };
};

step.ci = async () => {
  let id;
  for (let i = 0; i < 40 && !id; i++) {
    const runs = JSON.parse(gh("run", "list", "-R", REPO, "-w", "devkit", "-L", "10", "--json", "databaseId,headBranch,headSha"));
    id = runs.find((r) => r.headBranch === TAG && r.headSha === state.done.tag.commit)?.databaseId;
    if (!id) await sleep(15000);
  }
  if (!id) fail(`10 分钟没等到 ${TAG} 的 devkit 构建`);
  say(`  CI run ${id}：https://github.com/${REPO}/actions/runs/${id}（约一个半小时）`);
  const c = await waitRun(REPO, id);
  if (c !== "success") fail(`CI ${c}：gh run view ${id} -R ${REPO} --log-failed。偶发的就 gh run rerun ${id} -R ${REPO} 后再跑本命令；要改代码就删掉 tag（git push origin :${TAG} && git tag -d ${TAG}），提交推送后 --from preflight`);
  return { run: id };
};

step.fetch = async () => {
  for (const f of fs.readdirSync(REL)) fs.rmSync(path.join(REL, f));
  gh("release", "download", TAG, "-R", REPO, "-D", REL, "-p", "devkit.lock.json", "-p", "modules.json", "-p", "modules.json.sig");
  const lock = lockOf(), mods = json(path.join(REL, "modules.json"));
  if (!verifySig(fs.readFileSync(path.join(REL, "modules.json")), fs.readFileSync(path.join(REL, "modules.json.sig"), "utf8"))) fail("modules.json 验签失败");
  say("  ✓ modules.json 验签");
  // Release 里的每个 gz 都在，大小与清单一致
  const assets = new Map(JSON.parse(gh("release", "view", TAG, "-R", REPO, "--json", "assets")).assets.map((a) => [a.name, a.size]));
  const want = [[lock.gz.file, lock.gz.bytes], ...mods.modules.map((m) => [m.file || m.gz.file, m.bytes || m.gz.bytes])];
  for (const [f, b] of want) if (assets.get(f) !== b) fail(`Release 里 ${f} 大小 ${assets.get(f)} ≠ 清单 ${b}`);
  say(`  ✓ ${want.length} 个 gz 都在 Release 上，大小与清单一致`);
  // 36 版 APK 要从 glibc 包里抽 ld.so；Termux 仓库删了旧包时 build.sh 退回 Release 上这份（devkit.yml「留存 glibc 包」）
  const g = lock.packages.find((p) => p.name === "glibc");
  if (g && assets.get("glibc.deb") !== g.size) fail(`Release 里 glibc.deb 大小 ${assets.get("glibc.deb")} ≠ 锁文件 ${g.size}`);
  if (g) say("  ✓ glibc.deb 留存在 Release 上");
  // devkit.json 点名要的包都进了（10.22.1 以为 which 在 debianutils 里、实际没有，就是这一步该拦下的）
  const dj = json(path.join(ROOT, "devkit/devkit.json"));
  // full:false 的模块（go、node）不进整包，它们的包只在 modules.json 各自的清单里，要一起算
  const names = new Set([...lock.packages.map((p) => p.name), ...mods.modules.flatMap((m) => (m.packages || []).map((p) => (typeof p === "string" ? p : p.name)))]);
  const named = [...new Set(Object.values(dj.groups).flat())].filter((n) => typeof n === "string" && !(dj.exclude || []).includes(n));
  const miss = named.filter((n) => !names.has(n));
  if (miss.length) fail(`devkit.json 点名的包不在清单里：${miss.join(" ")}（虚包要写实际提供它的包名，如 man → mandoc）`);
  say(`  ✓ devkit.json 点名的 ${named.length} 个包都在（共 ${lock.packages.length} 个，含依赖）`);
  // 和上一版比：多了什么、少了什么。少了包要人看过，默认不放行
  const prev = state.done.preflight.prev;
  const pl = JSON.parse((await getBuf(`https://github.com/${REPO}/releases/download/${prev}/devkit.lock.json`)).toString());
  const pv = new Map(pl.packages.map((p) => [p.name, p.version]));
  const add = lock.packages.filter((p) => !pv.has(p.name)).map((p) => p.name);
  const gone = [...pv.keys()].filter((n) => !names.has(n));
  const bumped = lock.packages.filter((p) => pv.has(p.name) && pv.get(p.name) !== p.version).length;
  say(`  对比 ${prev}：新增 ${add.length}${add.length ? "（" + add.join(" ") + "）" : ""}，去掉 ${gone.length}${gone.length ? "（" + gone.join(" ") + "）" : ""}，升版本 ${bumped}`);
  if (gone.length && !process.env.ALLOW_REMOVED) fail(`比上一版少了包：${gone.join(" ")}。确认是有意的就 ALLOW_REMOVED=1 再跑 --from fetch`);
  return { gz: lock.gz.sha256, packages: lock.packages.length, modulesSha: sha(fs.readFileSync(path.join(REL, "modules.json"))), add, gone };
};

step.pin = async () => {
  const { gz, packages, modulesSha } = state.done.fetch;
  writeFresh(path.join(ROOT, "devkit-sources.txt"), BASE + "\n");
  const tmp = path.join(W, "devkit-pin.json");
  run("node", [path.join(ROOT, "scripts/pin-devkit.mjs"), BASE, tmp]);
  const pin = json(tmp);
  if (pin.tag !== TAG || pin.gz.sha256 !== gz) fail(`钉子不对：${pin.tag} ${pin.gz.sha256}`);
  if (pin.modules?.sha256 !== modulesSha) fail("钉子里 modules.json 的 sha256 和刚验过签的那份不一致");
  writeFresh(path.join(ROOT, "devkit-pin.json"), fs.readFileSync(tmp));
  // devkit/README.md 里的包数与当前版本号（两处，改不到就停，别让文档悄悄过时）
  const rp = path.join(ROOT, "devkit/README.md");
  let s = fs.readFileSync(rp, "utf8"), n = 0;
  s = s.replace(/\| \d+ 个包：/, () => (n++, `| ${packages} 个包：`));
  s = s.replace(/共 \d+ 个包（devkit-[\d.]+/, () => (n++, `共 ${packages} 个包（${TAG}`));
  if (n !== 2) fail("devkit/README.md 里没找到「| N 个包：」和「共 N 个包（devkit-…」两处，格式变了：改脚本或手改");
  writeFresh(rp, s);
  const files = ["devkit-pin.json", "devkit-sources.txt", "devkit/README.md"];
  fuseOk(ROOT, files);
  gitc(ROOT, "add", ...files);
  gitc(ROOT, "commit", "-q", "-m", `App 改钉工具包 ${TAG}${WHY ? "（" + WHY + "）" : ""}\n\n${packages} 个包，gz ${gz.slice(0, 12)}…`);
  git(ROOT, "push", "-q", "origin", "main");
  return { commit: git(ROOT, "rev-parse", "HEAD") };
};

step.market = async () => {
  const bp = path.join(MARKET, "bases.json");
  // 首次发布分支（CP-02a）：preflight 已判市场仓库未就绪（market:false），或 bases.json 不存在。
  // 仓库目录根本不在 → 跳过（devkit-only），不当成失败，日志写清原因与补跑办法；
  // 目录在但 bases.json 缺失 → 先同步远端（种子可能已推、本地只是没拉到），同步后仍无则从空 bases 生成再继续。
  if (state.done.preflight?.market === false || !fs.existsSync(bp)) {
    if (!fs.existsSync(MARKET)) {
      say(`  · 首次发布：市场仓库不在 ${MARKET}，market 步跳过（这次只发 devkit）；种子推好后用 --from market 补跑`);
      return { skipped: true, firstRelease: true, reason: `market repo missing: ${MARKET}` };
    }
    if (!fs.existsSync(path.join(MARKET, ".git"))) fail(`市场目录 ${MARKET} 在，但不是 git 仓库：把 agycodroid-components 克隆到这里（或设 MARKET），再 --from market 重跑`);
    try {
      git(MARKET, "fetch", "-q", "origin", "main");
      git(MARKET, "checkout", "-q", "-B", "main", "origin/main");
    } catch (e) {
      say(`  · 首次发布：市场仓库 ${MARKET} 还没有可同步的 main（种子未推），market 步跳过（这次只发 devkit）；种子推好后用 --from market 补跑`);
      return { skipped: true, firstRelease: true, reason: "market repo has no main yet" };
    }
    if (!fs.existsSync(bp)) {
      say(`  · 首次发布：${bp} 不存在，从空 bases 生成（空多行数组，与种子 bases.json 同格式），再继续`);
      writeFresh(bp, `{\n  "bases": [\n  ]\n}\n`);
    }
  } else {
    git(MARKET, "fetch", "-q", "origin", "main");
    git(MARKET, "checkout", "-q", "-B", "main", "origin/main");
  }
  const b = json(bp);
  let commit;
  if (b.bases[0]?.tag === TAG) { say("  bases.json 第一行已经是它"); commit = git(MARKET, "rev-parse", "HEAD"); }
  else {
    if (b.bases.some((x) => x.tag === TAG)) fail(`bases.json 里已有 ${TAG} 但不在第一行`);
    // 空数组（首次发布、种子 bases.json）时上面这一插会在 ] 前多一个尾逗号（…},\n  ]），JSON 不认：去掉它再验
    let s = fs.readFileSync(bp, "utf8").replace(/("bases": \[\n)/, `$1    { "tag": "${TAG}" },\n`);
    try { JSON.parse(s); } catch { s = s.replace(/,\n(\s*\])/, "\n$1"); }
    if (JSON.parse(s).bases[0]?.tag !== TAG) fail("bases.json 插不进去，格式变了");
    writeFresh(bp, s);
    fuseOk(MARKET, ["bases.json"]);
    gitc(MARKET, "add", "bases.json");
    gitc(MARKET, "commit", "-q", "-m", `bases 加 ${TAG}${WHY ? "（" + WHY + "）" : ""}`);
    git(MARKET, "push", "-q", "origin", "HEAD:main");
    commit = git(MARKET, "rev-parse", "HEAD");
  }
  let id;
  for (let i = 0; i < 40 && !id; i++) {
    const runs = JSON.parse(gh("run", "list", "-R", MREPO, "-L", "10", "--json", "databaseId,headSha,workflowName"));
    id = runs.find((r) => r.headSha === commit && /build/i.test(r.workflowName))?.databaseId;
    if (!id) await sleep(15000);
  }
  if (!id) fail("没等到市场的构建");
  say(`  市场 CI run ${id}：所有组件为 ${TAG} 重打`);
  const c = await waitRun(MREPO, id);
  if (c !== "success") fail(`市场 CI ${c}：gh run view ${id} -R ${MREPO} --log-failed；修好后 --from market`);
  await checkMarket();
  return { commit, run: id };
};

// 市场索引：验签；每个配方在新底座上都有构建。
// 首次发布（CP-02c）：社区索引 Release 还不存在（404）时——recipes/ 为空就跳过并注明（不算失败），
// 有配方就报明确错误（缺索引、等市场 CI 发 index Release）；其它错误（网络等）照常抛。
async function checkMarket(gz = state.done.fetch.gz) {
  const recipesDir = path.join(MARKET, "recipes");
  const recipes = fs.existsSync(recipesDir)
    ? fs.readdirSync(recipesDir).filter((d) => fs.statSync(path.join(recipesDir, d)).isDirectory())
    : [];
  let body;
  try {
    body = await getBuf(`https://github.com/${MREPO}/releases/download/index/components.json`);
  } catch (e) {
    if (!/HTTP 404/.test(e.message)) throw e;
    if (!recipes.length) {
      say(`  · 首次发布：社区索引 Release 还不存在（https://github.com/${MREPO}/releases/download/index/components.json 404），且 recipes/ 为空——checkMarket 跳过（不算失败）；等市场 CI 发出第一个空签名索引后，用 --from market 或 --check 再核对`);
      return { skipped: true, firstRelease: true, reason: "community index Release missing, no recipes" };
    }
    fail(`社区索引 Release 不存在（https://github.com/${MREPO}/releases/download/index/components.json 404），但 recipes/ 里已有 ${recipes.length} 个配方（${recipes.join(" ")}）：先确认市场 CI 已跑过并发出 index Release（.github/workflows/build.yml，名含 build），再 --from market 重跑`);
  }
  const sig = (await getBuf(`https://github.com/${MREPO}/releases/download/index/components.json.sig`)).toString();
  if (!verifySig(body, sig)) fail("市场索引验签失败");
  const idx = JSON.parse(body);
  const miss = recipes.filter((id) => !idx.components[id]?.builds.some((b) => b.base === gz));
  if (miss.length) fail(`市场索引里这些组件没有 ${gz.slice(0, 12)} 的构建：${miss.join(" ")}`);
  const ver = recipes.filter((id) => idx.components[id].builds.find((b) => b.base === gz).verified).length;
  say(`  ✓ 市场索引验签；${recipes.length} 个组件都有新底座的构建（其中 ${ver} 个已有验证或继承，其余待真机验）`);
}

step.chromium = async () => {
  const D = path.join(W, "chromium");
  fs.rmSync(D, { recursive: true, force: true }); fs.mkdirSync(D, { recursive: true });
  run("node", [path.join(ROOT, "devkit/devkit.mjs"), "component", "chromium", "--target", "cc.agyroid", "--base", path.join(REL, "devkit.lock.json"), "--out", D, "--cache", CHROM_CACHE], { cwd: path.join(ROOT, "devkit") });
  const meta = json(path.join(D, "component-chromium.json"));
  if (meta.base.gz !== state.done.fetch.gz) fail(`浏览器组件打在了 ${meta.base.gz.slice(0, 12)} 上`);
  // 线上那份索引会被合并后重签：先验它的签名，不然有仓库写权限的人改一下 Release 附件，就能借发布机的钥匙签出「官方」组件（11-03 审查 M-4）
  // components Release 还不存在（第一次发）时 download 会失败：当成“线上无索引、从空生成”
  // （components-index.mjs 在输出文件不存在时就是从空生成）；其它错误（网络等）照常抛，不当成无索引。
  let onlineIndex = false;
  try {
    gh("release", "download", "components", "-R", REPO, "-p", "components.json", "-p", "components.json.sig", "-D", D, "--clobber");
    onlineIndex = true;
  } catch (e) {
    if (!ghMissing(e)) throw e;
    say("  · 线上还没有 components Release：从空生成预置组件索引");
  }
  if (onlineIndex && !verifySig(fs.readFileSync(path.join(D, "components.json")), fs.readFileSync(path.join(D, "components.json.sig"), "utf8"))) fail("线上的预置组件索引验签失败，不合并");
  run("node", [path.join(ROOT, "devkit/components-index.mjs"), path.join(D, "components.json"), `https://github.com/${REPO}/releases/download/components/`, path.join(D, "component-chromium.json")], { env: { ...process.env, INDEX_SIGNING_KEY_FILE: KEYFILE } });
  const body = fs.readFileSync(path.join(D, "components.json"));
  if (!verifySig(body, fs.readFileSync(path.join(D, "components.json.sig"), "utf8"))) fail("新签的预置组件索引验不过");
  const b = JSON.parse(body).components.chromium.builds.find((x) => x.base === state.done.fetch.gz);
  if (!b) fail("新索引里没有这版工具包的浏览器构建");
  const tgz = path.join(D, "component-chromium-cc.agyroid.tar.gz"), h = await shaFile(tgz);
  if (h !== b.sha256 || fs.statSync(tgz).size !== b.bytes) fail(`浏览器包 ${h.slice(0, 12)} 和索引 ${b.sha256.slice(0, 12)} 对不上`);
  const asset = path.join(D, b.asset);
  fs.copyFileSync(tgz, asset);
  let online = new Map();
  try {
    online = new Map(JSON.parse(gh("release", "view", "components", "-R", REPO, "--json", "assets")).assets.map((a) => [a.name, a.size]));
  } catch (e) {
    // Release 不存在（download 那步已确认过线上无索引）才建一个；其它错误照常抛
    if (onlineIndex || !ghMissing(e)) throw e;
    say("  · 线上还没有 components Release：先建一个空的再传");
    run("gh", ["release", "create", "components", "-R", REPO, "--title", "components", "--notes", "预置组件索引（components.json + chromium 包），由 scripts/publish-devkit.mjs 的 chromium 步首次创建"]);
  }
  if (online.get(b.asset) === b.bytes) say(`  ${b.asset} 已在线上（大小一致），不重传`);
  else run("gh", ["release", "upload", "components", "-R", REPO, asset, "--clobber"]);
  // 先传包、后传索引：索引指向的包一定已经在了
  run("gh", ["release", "upload", "components", "-R", REPO, path.join(D, "components.json"), path.join(D, "components.json.sig"), "--clobber"]);
  return { version: b.version, asset: b.asset, sha256: b.sha256, bytes: b.bytes, index: sha(body) };
};

step.mirror = async () => {
  // fork 目前没有自己的镜像站（DL 为空）：这步跑不起来，直接报停，不等 45 分钟。
  // 前置条件：搭好镜像站（域名 + 生成器 + SITE_KICK），并把上面 DL 指过去。
  if (!DL) fail("没有镜像站（DL 为空）：mirror 这步跑不起来；先搭镜像站，或跳过这步直接跑后面的步骤");
  if (process.env.SITE_KICK) run("sh", [process.env.SITE_KICK]);
  const u = `${DL}/devkit/${TAG}/modules.json.sig`;
  for (let i = 0; ; i++) {
    if ((await get(u, "HEAD")).status === 200) break;
    if (i >= 90) fail(`45 分钟镜像上还没有 ${u}`);
    await sleep(30000);
  }
  await sleep(5000);
  await checkMirror();
};

async function checkMirror() {
  for (const f of ["modules.json", "modules.json.sig", "devkit.lock.json"]) {
    const a = await getBuf(`${DL}/devkit/${TAG}/${f}`);
    if (!a.equals(fs.readFileSync(path.join(REL, f)))) fail(`镜像上的 ${f} 和 Release 上的不一致`);
  }
  const lock = lockOf(), mods = json(path.join(REL, "modules.json"));
  const want = [[lock.gz.file, lock.gz.bytes], ...mods.modules.map((m) => [m.file || m.gz.file, m.bytes || m.gz.bytes])];
  for (const [f, b] of want) {
    const n = +(await get(`${DL}/devkit/${TAG}/${f}`, "HEAD")).headers.get("content-length");
    if (n !== b) fail(`镜像上 ${f} 大小 ${n} ≠ ${b}`);
  }
  say(`  ✓ 镜像：3 个清单逐字节一致，${want.length} 个 gz 大小一致`);
  const gz = lockOf().gz.sha256;
  const c = state.done.chromium || JSON.parse(await getBuf(`https://github.com/${REPO}/releases/download/components/components.json`)).components.chromium.builds.find((x) => x.base === gz);
  if (!c) fail("预置索引里没有这版工具包的浏览器，镜像也就无从核起");
  {
    const n = +(await get(`${DL}/components/official/${c.asset}`, "HEAD")).headers.get("content-length");
    if (n !== c.bytes) fail(`镜像上的浏览器组件 ${c.asset} 大小 ${n} ≠ ${c.bytes}（生成器还没同步到？过会儿 --check）`);
    say(`  ✓ 镜像：浏览器组件 ${c.asset} 已同步`);
  }
}

step.preview = async () => {
  const mf = path.join(ROOT, "android/AndroidManifest.xml");
  if (git(ROOT, "status", "--porcelain")) fail("工作区不干净，打预览包前先收拾");
  const m0 = fs.readFileSync(mf, "utf8");
  const v = (/android:versionName="([^"]+)"/.exec(m0) || [])[1];
  const [a, b2, c] = v.split(".").map(Number);
  const pv = `${a}.${b2}.${c + 1}-preview`;
  writeFresh(mf, m0.replace(`android:versionName="${v}"`, `android:versionName="${pv}"`));
  try { run("sh", [path.join(ROOT, "scripts/build.sh")], { cwd: ROOT }); }
  finally { git(ROOT, "checkout", "-q", "android/AndroidManifest.xml"); }
  const apk = path.join(ROOT, "dist/agycodroid.apk");
  const inApk = sh("unzip", ["-p", apk, "assets/devkit-pin.json"]);
  if (inApk !== fs.readFileSync(path.join(ROOT, "devkit-pin.json"), "utf8").trim()) fail("APK 里带的 devkit-pin.json 和仓库里的不一样");
  const out = `/sdcard/Download/agycodroid-${pv}.apk`;
  fs.copyFileSync(apk, out);
  const h = await shaFile(out);
  say(`  ✓ 预览包 ${out}（${pv}，sha256 ${h.slice(0, 16)}…，钉 ${TAG}）`);
  if (INSTALL) {
    say(sh("priv", [`cp ${out} /data/local/tmp/ccp.apk && pm install -r /data/local/tmp/ccp.apk; rm -f /data/local/tmp/ccp.apk`]));
  } else say(`  没装（加 --install 才装）。手动装：priv 'cp ${out} /data/local/tmp/ccp.apk && pm install -r /data/local/tmp/ccp.apk; rm -f /data/local/tmp/ccp.apk'`);
  return { apk: out, version: pv, sha256: h };
};

step.testmerge = async () => {
  if (!fs.existsSync(path.join(TEST_WT, ".git"))) { say(`  没有 test 工作树 ${TEST_WT}，跳过`); return { skipped: true }; }
  if (git(TEST_WT, "status", "--porcelain")) fail("test 工作树有未提交的改动");
  git(TEST_WT, "fetch", "-q", "origin");
  try { gitc(TEST_WT, "merge", "--no-edit", "-m", `合并 main：工具包 ${TAG}`, "origin/main"); }
  catch (e) { try { git(TEST_WT, "merge", "--abort"); } catch {} fail("main 合到 test 有冲突，已撤回；手动合"); }
  git(TEST_WT, "push", "-q", "origin", "HEAD:test");
  return { commit: git(TEST_WT, "rev-parse", "HEAD") };
};

// 全链对账：不信状态文件里的结论，重新从各处取来核
step.check = async () => {
  let bad = 0;
  ensureRel();
  const gz = lockOf().gz.sha256;
  const t = async (name, fn) => { try { await fn(); } catch (e) { bad++; say(`  ✗ ${name}：${e.message}`); } };
  await t("Release 与 App 的钉子", async () => {
    const lockBuf = await getBuf(BASE + "devkit.lock.json"), lock = JSON.parse(lockBuf.toString());
    const mods = await getBuf(BASE + "modules.json"), sig = (await getBuf(BASE + "modules.json.sig")).toString();
    if (!verifySig(mods, sig)) fail("modules.json 验签失败");
    // 整包清单的签名（10-29 起 CI 才签，之前的版本没有）：有就必须验得过
    let lsig = null; try { lsig = (await getBuf(BASE + "devkit.lock.json.sig")).toString(); } catch {}
    // 10-29 之后发的必须有：App 那边缺签名就拒装，这里不能比它松（审查 10-29 L21）
    const ymd = (TAG.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/) || []).slice(1).map(Number);
    if (lsig == null && ymd.length && ymd[0] * 1e4 + ymd[1] * 100 + ymd[2] >= 20261029) fail("devkit.lock.json.sig 不在 Release 上");
    if (lsig != null && !verifySig(lockBuf, lsig)) fail("devkit.lock.json 验签失败");
    if (lsig != null && lock.release !== TAG) fail(`devkit.lock.json 签进去的 release 是 ${lock.release || "（空）"}，不是 ${TAG}——App 会拒装`);
    if (lock.gz.sha256 !== gz) fail("线上清单的 gz 和本地留的那份不一致");
    if (state.done.fetch && state.done.fetch.gz !== gz) fail("线上清单的 gz 和 fetch 时记下的不一致");
    const src = fs.readFileSync(path.join(ROOT, "devkit-sources.txt"), "utf8").split("\n")[0].trim();
    if (src !== BASE) fail(`devkit-sources.txt 是 ${src}`);
    const pin = JSON.parse(git(ROOT, "show", "origin/main:devkit-pin.json"));
    if (pin.tag !== TAG || pin.gz.sha256 !== lock.gz.sha256 || pin.modules?.sha256 !== sha(mods)) fail("origin/main 上的 devkit-pin.json 和 Release 对不上");
    if (pin.lock?.sha256 !== sha(lockBuf)) fail("origin/main 上的 devkit-pin.json 钉的 devkit.lock.json 和 Release 对不上");
    say(`  ✓ Release 清单验签；origin/main 钉的就是它（gz ${lock.gz.sha256.slice(0, 12)}）`);
  });
  await t("市场", async () => {
    // 首次发布：这次 market 步已跳过（devkit-only），或市场仓库根本不在，就不对账、不算失败，日志写清原因
    if (state.done.market?.skipped) { say(`  · 市场：这次是首次发布（devkit-only），market 步已跳过，不对账`); return; }
    if (!fs.existsSync(path.join(MARKET, "bases.json"))) { say(`  · 市场：市场仓库不在 ${MARKET}（首次发布、devkit-only），跳过`); return; }
    git(MARKET, "fetch", "-q", "origin", "main");
    let basesRaw;
    try { basesRaw = git(MARKET, "show", "origin/main:bases.json"); }
    catch (e) { fail(`市场仓库 origin/main 上没有 bases.json（首次发布、种子未推？）：先推种子，再 --from market 补跑`); }
    if (JSON.parse(basesRaw).bases[0]?.tag !== TAG) fail("市场 bases.json 第一行不是它");
    await checkMarket(gz);
  });
  await t("预置浏览器", async () => {
    let body;
    try {
      body = await getBuf(`https://github.com/${REPO}/releases/download/components/components.json`);
    } catch (e) {
      // components Release 还没发：报“未发”，不对账失败（其它错误照常算失败）
      if (/HTTP 404/.test(e.message)) { say("  · 预置浏览器：components Release 还没发（未发）"); return; }
      throw e;
    }
    if (!verifySig(body, (await getBuf(`https://github.com/${REPO}/releases/download/components/components.json.sig`)).toString())) fail("预置组件索引验签失败");
    const b = JSON.parse(body).components.chromium.builds.find((x) => x.base === gz);
    if (!b) fail("预置索引里没有这版工具包的浏览器");
    const r = await get(b.url, "HEAD");
    if (+r.headers.get("content-length") !== b.bytes) fail(`${b.asset} 线上大小 ${r.headers.get("content-length")} ≠ ${b.bytes}`);
    say(`  ✓ 预置索引验签；浏览器 ${b.version} 的包在线上（${b.asset}）`);
  });
  await t("镜像", async () => { if (!DL) { say("  · 镜像：fork 没有镜像站，跳过"); return; } await checkMirror(); });
  await t("预览包", async () => {
    const p = state.done.preview;
    if (!p) { say("  · 预览包：这次没打（没有记录），不核"); return; }
    if (await shaFile(p.apk) !== p.sha256) fail(`${p.apk} 被换过了`);
    if (JSON.parse(sh("unzip", ["-p", p.apk, "assets/devkit-pin.json"])).gz.sha256 !== gz) fail("预览包钉的不是这版");
    say(`  ✓ 预览包 ${p.apk} 钉的是这版`);
  });
  if (bad) fail(`对账有 ${bad} 项不对`);
  say(`\n✓ ${TAG} 全链对上了。下一步：在 agycodroid 里升级工具包，然后终端跑 node /sdcard/DeepSeekHarness/claude-workspace/verify.mjs`);
};

// ── 主流程 ──
if (CHECK_ONLY) { await step.check().catch((e) => { say("✗ " + e.message); process.exit(1); }); process.exit(0); }
if (FROM) for (const s of STEPS.slice(STEPS.indexOf(FROM))) delete state.done[s];
save();
for (const s of STEPS) {
  if (ONLY && s !== ONLY) continue;
  if (state.done[s] && s !== "check" && !ONLY) { say(`· ${s}（已完成）`); continue; }
  say(`\n▶ ${s}`);
  try {
    state.done[s] = (await step[s]()) || { at: new Date().toISOString() };
    save();
  } catch (e) {
    say(`\n✗ ${s} 失败：${e.message}\n  修好后再跑同一条命令，会从 ${s} 接着来（状态在 ${SF}）`);
    process.exit(1);
  }
}
