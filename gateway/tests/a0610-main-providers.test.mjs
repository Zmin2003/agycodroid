// 厂商配置（gw/providers.mjs）：0.6.9 审计 P1-1 / P1-2 / P1-8 / P1-15
// 配置是模块加载时读的：每个场景在子进程里用自己的临时 home 跑，别和别的测试文件共用一份配置
// 移植：P1-15 / P1-2 / P1-8（自定义接口的 endpoints、换端点清 Key、custom-N 编号）、
// U.5 / U.7（清单接口试发、分页拉取）、196-凭据.1（线路失配的 Key 处理）、199-9-02
// （明文 http 警告）都随自定义 / 第三方厂商一起没了——agy 只有 google / gemini 两个
// 内置厂商，没有 endpoints、没有清单接口、没有线路概念，相关用例删除。
// 留下的 P1-1、195-Z.5、195-Z.1 测的是配置 / 账本 / 设置文件坏了留底，与厂商无关。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const GW = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "gw");
const ROOT = fs.mkdtempSync(path.join(process.env.AGAPP_WORKSPACE, "a0610-prov-"));
let seq = 0;

/** 在子进程里：先写好 files（相对 home），再 import providers.mjs 跑 code；code 里 console.log(JSON) 作为结果 */
function scenario(files, code) {
  const home = path.join(ROOT, "h" + ++seq);
  fs.mkdirSync(home, { recursive: true });
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(home, f), typeof v === "string" ? v : JSON.stringify(v));
  const src = `const P = await import(${JSON.stringify(path.join(GW, "providers.mjs"))}); ${code}; process.exit(0);`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], {
    env: { ...process.env, AGAPP_HOME: home, HOME: home, AGAPP_WORKSPACE: path.join(home, "ws"), AGAPP_PREFIX: "" }, encoding: "utf8", timeout: 30000 });
  return { rc: r.status, out: r.stdout.trim().split("\n").pop(), err: r.stderr, home };
}

test("P1-1：配置文件坏了 → 原文件留底，保存不会把 Key 覆盖没", () => {
  const bad = '{"providers":{"custom-1":{"baseUrl":"https://a.example","apiKey":"SECRET-1"}}';   // 少个 }
  const r = scenario({ "agyapp-providers.json": bad },
    `const r = P.upsertProvider("", { baseUrl: "https://b.example", apiKey: "k2", label: "b" }); console.log(JSON.stringify({ ok: r.ok }));`);
  assert.equal(r.rc, 0, r.err);
  const bads = fs.readdirSync(r.home).filter((f) => f.startsWith("agyapp-providers.json.bad-"));
  assert.equal(bads.length, 1);
  assert.equal(fs.readFileSync(path.join(r.home, bads[0]), "utf8"), bad, "坏文件原样留着（Key 在里面）");
});

test("195-Z.5：账本语法坏了 → 留底，不当空账本整份写回", () => {
  const bad = '{"deepseek":{"since":1,"spends":[[1,2]]';
  const r = scenario({ "agyapp-billing.json": bad }, `P._billForTest.noteTokens?.("deepseek", { input_tokens: 1, output_tokens: 1 }); await new Promise((r) => setTimeout(r, 800)); console.log("{}");`);
  assert.equal(r.rc, 0, r.err);
  const bads = fs.readdirSync(r.home).filter((f) => f.startsWith("agyapp-billing.json.bad-"));
  assert.equal(bads.length, 1);
  assert.equal(fs.readFileSync(path.join(r.home, bads[0]), "utf8"), bad);
});

test("195-Z.1：设置文件坏了 → 留底；之后保存写的是新文件，坏的那份还在", () => {
  const bad = '{"model":"keep-me","addDirs":["/x"]';
  const r = scenario({ "agyapp-settings.json": bad }, `const S = await import(${JSON.stringify(path.join(GW, "settings-store.mjs"))}); console.log(JSON.stringify({ saved: S.saveSettings(), model: S.SETTINGS.model ?? null }));`);
  assert.equal(r.rc, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { saved: true, model: null });
  const bads = fs.readdirSync(r.home).filter((f) => f.startsWith("agyapp-settings.json.bad-"));
  assert.equal(bads.length, 1);
  assert.equal(fs.readFileSync(path.join(r.home, bads[0]), "utf8"), bad);
});
