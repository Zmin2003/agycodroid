#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
//  agy-verified.mjs —— 维护「哪些 agy 版本在 agycodroid 上真机验过 / 哪些有问题」（本机记录，不发布、不签名）
//
//  node scripts/agy-verified.mjs list
//  node scripts/agy-verified.mjs add <agy-verify-X.Y.Z.json …>     并进真机验证结果（scripts/verify-agy.mjs 在手机上跑出来的）
//  node scripts/agy-verified.mjs bad <版本> --zh "出了什么事、怎么绕" --en "…" [--fixed <版本>]
//  node scripts/agy-verified.mjs unbad <版本>      撤掉「有问题」
//  node scripts/agy-verified.mjs rm <版本>         删掉这一版的验证记录
//
//  维护的是仓库里的 agy/verified.json（维护者手里的本地记录；fork 没有上游的签名私钥，不签名、不发布）。
//  应用里的版本选单与自动更新读的是本机缓存 home/.cache/agycodroid/agy-verified.json，
//  那份由真机验证（scripts/verify-agy.mjs）直接写，不从这里同步。
//  渠道（latest）走到有问题的版本时，自动更新先不装（用户自己点更新照样装）。
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const die = (s) => { console.error("✗ " + s); process.exit(1); };
const FILE = "agy/verified.json", F = path.join(ROOT, FILE);
const VER = /^\d+\.\d+\.\d+$/;
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
const isMap = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const load = () => {
  let raw;
  try { raw = fs.readFileSync(F); } catch (e) { if (e.code === "ENOENT") return { v: 1, updated: "", versions: {}, bad: {} }; die(`读不了 ${F}：${e.message}`); }
  let d;
  try { d = JSON.parse(raw.toString("utf8")); } catch (e) { die(`${F} 不是完整的 JSON（${e.message}）：先从 git 恢复`); }
  if (!d || typeof d !== "object" || !isMap(d.versions) || (d.bad !== undefined && !isMap(d.bad))) die(`${F} 的结构不对：先从 git 恢复`);
  return d;
};
const save = (d) => {
  d.v = 1;
  d.updated = new Date().toISOString();
  fs.mkdirSync(path.dirname(F), { recursive: true });
  fs.writeFileSync(F, JSON.stringify(d, null, 1) + "\n");
};
const cmpVer = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const devName = (r) => `${r.device} · Android ${r.android}`;
const d = load();
d.bad ||= {};
const cmd = argv.shift();

if (cmd === "list" || !cmd) {
  const vs = Object.keys(d.versions).sort((a, b) => cmpVer(b, a));
  if (!vs.length) console.log("（还没有验证记录）");
  for (const v of vs) console.log(`${v}  ${d.versions[v].map((r) => `${devName(r)}（${r.at}，App ${r.app || "?"}）`).join("；")}`);
  for (const [v, b] of Object.entries(d.bad)) console.log(`✗ ${v}  ${b.zh}${b.fixed ? `（${b.fixed} 已修）` : ""}`);
  if (!cmd) console.log("\n用法见文件开头注释");
  process.exit(0);
}

let msg;
if (cmd === "add") {
  if (!argv.length) die("给 verify-agy.mjs 跑出来的结果文件");
  const added = [];
  for (const f of argv) {
    let r;
    try { r = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { die(`${f} 读不了：${e.message}`); }
    if (r.v !== 1 || !VER.test(r.version || "")) die(`${f} 不是 verify-agy.mjs 的结果`);
    if (!r.pass) die(`${f}：${r.version} 没通过验证（${Object.entries(r.steps).filter(([, s]) => !s.pass).map(([k, s]) => `${k}: ${s.detail}`).join("；")}），不能记成已验证`);
    if (!r.app || !r.device?.targetSdk) die(`${f}：结果里没有 App 版本 / 安装包类型——不是在 agycodroid 的终端里跑的，不能当真机验证`);
    if (!r.sha512) die(`${f}：结果里没有 sha512`);
    const rec = { at: r.at.slice(0, 10), device: [r.device.maker, r.device.model].filter(Boolean).join(" "), android: r.device.android, sdk: r.device.sdk,
      targetSdk: r.device.targetSdk, app: r.app, devkit: r.devkit, sha512: r.sha512 };
    // 同一台设备、同一 Android 版本、同一种安装包（28 / 36）只留最新一条
    const list = (d.versions[r.version] || []).filter((x) => !(x.device === rec.device && x.android === rec.android && x.targetSdk === rec.targetSdk));
    if (list.some((x) => x.sha512 !== rec.sha512)) die(`${r.version} 的 sha512 和已有记录不一致——不该发生，先查清楚`);
    d.versions[r.version] = [...list, rec];
    added.push(`${r.version}（${devName(rec)}）`);
  }
  msg = `agy 真机验证：${added.join("、")}`;
} else if (cmd === "bad") {
  const v = argv.shift(), zh = opt("--zh"), en = opt("--en"), fixed = opt("--fixed");
  if (!VER.test(v || "")) die("版本号要 2.1.300 这样的");
  if (!zh || !en) die("--zh 和 --en 都要写：一两句话说清出了什么事、怎么绕");
  if (fixed && !VER.test(fixed)) die("--fixed 要版本号");
  d.bad[v] = { zh, en, at: new Date().toISOString().slice(0, 10), ...(fixed ? { fixed } : {}) };
  msg = `agy ${v} 标为有问题：${zh}`;
} else if (cmd === "unbad" || cmd === "rm") {
  const v = argv.shift(), box = cmd === "unbad" ? d.bad : d.versions;
  if (!box[v]) die(`没有 ${v}`);
  delete box[v];
  msg = cmd === "unbad" ? `agy ${v} 撤掉「有问题」` : `删掉 agy ${v} 的验证记录`;
} else die(`不认识的命令 ${cmd}`);

// 只留最近 40 个验过的版本：版本选单只需要近期的
const keep = Object.keys(d.versions).sort((a, b) => cmpVer(b, a)).slice(0, 40);
d.versions = Object.fromEntries(keep.sort(cmpVer).map((v) => [v, d.versions[v]]));
save(d);
console.log(msg);
