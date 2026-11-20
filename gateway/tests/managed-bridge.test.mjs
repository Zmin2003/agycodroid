import "../gw/config.mjs"; // 必须经 scripts/test.mjs：只操作隔离 HOME / fake PREFIX。
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { retireManagedBridge, warmManagedBridge } from "../gw/managed-bridge.mjs";
import { guardRegistryFlock, registryFlockFixture } from "./fixtures/registry-flock.mjs";

// 用确定的假值验证环境隔离；不读取或转发调用者的任何真实凭据。
process.env.ANTHROPIC_API_KEY = "fixture-only-do-not-forward";
process.env.ANTHROPIC_AUTH_TOKEN = "fixture-only-do-not-forward";
process.env.AGAPP_RUN = "fixture-only-do-not-forward";
const home = process.env.AGAPP_HOME, prefix = process.env.AGAPP_PREFIX;
const root = fs.mkdtempSync(path.join(process.env.AGAPP_WORKSPACE, "managed-"));
const reg = path.join(home, ".agycodroid/services/openai-bridge.json");
const record = path.join(path.dirname(prefix), "components/openai-bridge.json");
const component = path.join(prefix, "lib/openai-bridge/component.cjs");
const lockFixture = registryFlockFixture();
beforeEach(() => lockFixture.reset());
const put = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o), { mode: 0o600 }); };
const replaceJson = (p, o) => { put(p + ".new", o); fs.renameSync(p + ".new", p); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, message, ms = 3000) {
  const start = performance.now();
  while (!check()) {
    assert.ok(performance.now() - start < ms, message);
    await delay(15);
  }
}
async function within(work, ms, message) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
const fixtureSource = `const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const args=process.argv.slice(2),dir=args[args.indexOf('--dir')+1],endpoint=args[args.indexOf('--endpoint')+1],instanceId=args[args.indexOf('--instance')+1];
fs.appendFileSync(path.join(dir,'calls'),JSON.stringify({command:args[0],apiInEnv:!!process.env.ANTHROPIC_API_KEY||!!process.env.ANTHROPIC_AUTH_TOKEN,agyappRun:!!process.env.AGAPP_RUN})+'\\n');
const mode=fs.readFileSync(path.join(dir,'mode'),'utf8');
if(args[0]==='ensure'){
  fs.writeFileSync(path.join(dir,'launcher.pid'),String(process.pid));
  if(mode==='resident-hang'){
    const resident=spawn(process.execPath,['-e',"const fs=require('node:fs'),dir=process.argv[1].slice('managed-fixture-resident='.length);let beat=0;setInterval(()=>fs.writeFileSync(dir+'/heartbeat',String(++beat)),25);",'managed-fixture-resident='+dir],{detached:true,stdio:'ignore',env:process.env});
    resident.unref();fs.writeFileSync(path.join(dir,'resident.pid'),String(resident.pid));
  }
  setTimeout(()=>{if(mode==='fail')process.exitCode=1;else console.log(JSON.stringify({schema:1,id:'openai-bridge',ready:true,endpoint,instanceId:mode==='wrong'?'wrong':instanceId}));},mode==='hang'||mode==='resident-hang'?70000:100);
}else if(args[0]==='uninstall'){
  setTimeout(()=>{
    const registration=path.join(process.env.HOME,'.agycodroid/services/openai-bridge.json');
    if(mode==='fail'||mode==='uninstall-fail')process.exitCode=1;
    else if(mode==='replace-reg'){
      fs.rmSync(registration,{force:true});
      fs.writeFileSync(registration+'.next',fs.readFileSync(path.join(dir,'replacement.json')));
      fs.renameSync(registration+'.next',registration);
    }else if(mode!=='leave-reg')fs.rmSync(registration,{force:true});
  },100);
}else process.exitCode=2;
`;

function fixture(mode = "ok") {
  const dir = fs.mkdtempSync(path.join(root, "instance-"));
  fs.mkdirSync(path.dirname(component), { recursive: true });
  fs.writeFileSync(component, fixtureSource);
  fs.writeFileSync(path.join(dir, "mode"), mode);
  const r = { schema: 1, id: "openai-bridge", endpoint: "http://127.0.0.1:34591", runtimeDir: dir, instanceId: crypto.randomBytes(16).toString("hex") };
  const rec = { id: "openai-bridge", state: "ok", files: ["lib/openai-bridge/component.cjs", ...Array.from({ length: 1000 }, (_, i) => "lib/openai-bridge/node_modules/fixture/" + i)] };
  put(reg, r);
  put(record, rec);
  return { r, rec, dir, p: { custom: true, baseUrl: r.endpoint }, calls: () => {
    try { return fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n").map(JSON.parse); } catch { return []; }
  } };
}

function replacementFixture(f) {
  const dir = fs.mkdtempSync(path.join(root, "replacement-"));
  const r = { ...f.r, endpoint: "http://127.0.0.1:34594", runtimeDir: dir, instanceId: crypto.randomBytes(16).toString("hex") };
  fs.writeFileSync(path.join(dir, "mode"), "ok");
  fs.writeFileSync(path.join(dir, "private-data.txt"), "unrelated replacement fixture must survive");
  put(path.join(f.dir, "replacement.json"), r);
  return { dir, r };
}
function preservedReplacement(f, replacement) {
  assert.deepEqual(JSON.parse(fs.readFileSync(reg, "utf8")), replacement.r, "原实例卸载不得清掉随后注册的新实例");
  assert.equal(fs.readFileSync(path.join(replacement.dir, "private-data.txt"), "utf8"), "unrelated replacement fixture must survive");
  assert.equal(fs.existsSync(path.join(replacement.dir, "calls")), false, "不能执行新实例运行目录的 uninstall/ensure");
  assert.equal(fs.existsSync(path.join(replacement.dir, "launcher.pid")), false);
  assert.ok(f.calls().every((call) => call.command === "uninstall"));
}

// 只清理本测试写下且 /proc 命令行仍匹配的假进程，绝不扫描/停止真实桥服务。
function stopFixtureProcess(dir, name) {
  try {
    const pid = Number(fs.readFileSync(path.join(dir, name + ".pid"), "utf8"));
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (name === "resident" ? cmd.includes("managed-fixture-resident=" + dir) : cmd.includes(component) && cmd.includes(dir)) process.kill(pid, "SIGTERM");
  } catch {}
}
after(() => {
  for (const d of fs.readdirSync(root)) for (const name of ["launcher", "resident"]) stopFixtureProcess(path.join(root, d), name);
  fs.rmSync(root, { recursive: true, force: true });
  for (const p of [reg, record, component]) fs.rmSync(p, { force: true });
});

test("合法 uninstall 删除自身后注册新实例：retire 成功且保留 replacement，不执行新目录", async () => {
  const f = fixture("replace-reg"), replacement = replacementFixture(f);
  assert.equal(await retireManagedBridge("openai-bridge"), true);
  assert.deepEqual(f.calls(), [{ command: "uninstall", apiInEnv: false, agyappRun: false }]);
  preservedReplacement(f, replacement);
});

for (const [name, corrupt] of [
  ["坏 JSON", () => fs.writeFileSync(reg, "{bad-json")],
  ["schema 2", (f) => put(reg, { ...f.r, schema: 2 })],
]) test(`fallback ${name}快照读取后被合法新实例替换：只保留新注册、不执行任何目录`, async (t) => {
  const f = fixture(), replacement = replacementFixture(f);
  corrupt(f);
  const close = fs.closeSync;
  let replaced = false;
  const hook = t.mock.method(fs, "closeSync", function (fd) {
    let target;
    try { target = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch {}
    const result = Reflect.apply(close, fs, [fd]);
    if (!replaced && target === reg) {
      // 确定发生在原文件 snapshot 读取结束后，不依赖定时或调度竞争。
      replaced = true;
      replaceJson(reg, replacement.r);
    }
    return result;
  });
  let result;
  try { result = await retireManagedBridge("openai-bridge"); }
  finally { hook.mock.restore(); }
  assert.equal(replaced, true, "必须实际触发旧注册读取后的替换窗口");
  assert.equal(typeof result, "boolean");
  assert.deepEqual(f.calls(), []);
  preservedReplacement(f, replacement);
});

test("合法停用失败保留注册，返回卸载专用错误且允许修复后重试", async () => {
  const f = fixture("uninstall-fail");
  await assert.rejects(retireManagedBridge("openai-bridge"), (e) => {
    assert.match(e.message, /卸载|停用/);
    assert.doesNotMatch(e.message, /已停止本轮请求/);
    assert.equal(e.code, "MANAGED_BRIDGE_RETIRE_FAILED");
    assert.equal(e.stage, "retire-exit");
    return true;
  });
  assert.equal(fs.existsSync(reg), true);
  fs.writeFileSync(path.join(f.dir, "mode"), "ok");
  assert.equal(await retireManagedBridge("openai-bridge"), true);
});

test("retire 注册锁仅支持toybox -n：健康停用与坏注册清理都无需host -w", async () => {
  const f = fixture("leave-reg");
  assert.equal(await retireManagedBridge("openai-bridge"), true);
  assert.equal(fs.existsSync(reg), false); assert.deepEqual(f.calls().map((call) => call.command), ["uninstall"]);
  assert.ok(lockFixture.calls().length >= 2);
  assert.ok(lockFixture.calls().every((call) => JSON.stringify(call.args) === JSON.stringify(["-n", "3"])));
  put(reg, { ...f.r, schema: 2 });
  assert.equal(await retireManagedBridge("openai-bridge"), true);
  assert.equal(fs.existsSync(reg), false); assert.equal(f.calls().length, 1, "坏注册只能清固定元数据，不能执行uninstall");
});

test("retire 注册锁持续争用约1秒：专用锁失败保注册，释放后重试不粘retiring", async (t) => {
  const f = fixture(), original = fs.readFileSync(reg, "utf8"), guard = guardRegistryFlock(t, lockFixture); lockFixture.setMode("busy");
  const started = performance.now(); let ticks = 0; const heartbeat = setInterval(() => ticks++, 20);
  try {
    await assert.rejects(retireManagedBridge("openai-bridge"), (error) => {
      assert.equal(error.code, "MANAGED_BRIDGE_RETIRE_FAILED"); assert.equal(error.stage, "retire-lock");
      assert.match(error.message, /卸载|停用/); assert.doesNotMatch(error.message, /已停止本轮请求/);
      return true;
    });
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 900 && elapsed < 2200, `retire锁等待必须约1秒且有界，实际${elapsed}ms`);
    assert.ok(ticks >= 10, "锁争用时应异步重试而非阻塞网关");
    assert.ok(lockFixture.calls().length > 1); assert.deepEqual(f.calls(), []);
    assert.equal(fs.readFileSync(reg, "utf8"), original); assert.equal(fs.existsSync(component), true); assert.equal(fs.existsSync(record), true);
  } finally { clearInterval(heartbeat); lockFixture.setMode("ok"); guard.restore(); }
  assert.equal(await retireManagedBridge("openai-bridge"), true);
  assert.equal(fs.existsSync(reg), false); assert.deepEqual(f.calls().map((call) => call.command), ["uninstall"]);
});

test("坏注册遇到锁争用也不能无锁删除，锁恢复后可安全清掉而不执行组件", async (t) => {
  const f = fixture(), guard = guardRegistryFlock(t, lockFixture); fs.writeFileSync(reg, "{bad-registry-json"); lockFixture.setMode("busy");
  try {
    await assert.rejects(retireManagedBridge("openai-bridge"), { code: "MANAGED_BRIDGE_RETIRE_FAILED", stage: "retire-lock" });
    assert.equal(fs.readFileSync(reg, "utf8"), "{bad-registry-json"); assert.deepEqual(f.calls(), []);
  } finally { lockFixture.setMode("ok"); guard.restore(); }
  assert.equal(await retireManagedBridge("openai-bridge"), true);
  assert.equal(fs.existsSync(reg), false); assert.deepEqual(f.calls(), []);
});


test("网关启动预热：有注册时后台拉起一次", async () => {
  const f = fixture();
  assert.equal(await warmManagedBridge(), true);
  assert.deepEqual(f.calls().map((call) => call.command), ["ensure"]);
  assert.equal(await warmManagedBridge(), true);
  assert.equal(f.calls().length, 1, "ready 缓存内不重复拉起");
});

test("网关启动预热：没有注册时不碰组件", async () => {
  const f = fixture();
  fs.rmSync(reg, { force: true });
  assert.equal(await warmManagedBridge(), false);
  assert.deepEqual(f.calls(), []);
});

test("网关启动预热：用户停用（disabled）时不碰", async () => {
  const f = fixture(), marker = path.join(f.dir, "disabled");
  fs.writeFileSync(marker, "stopped\n");
  assert.equal(await warmManagedBridge(), false);
  assert.deepEqual(f.calls(), []);
  assert.equal(fs.readFileSync(marker, "utf8"), "stopped\n");
});

test("网关启动预热：上一周期的故障锁改名留证、清掉旧预算，再给一次机会", async () => {
  const f = fixture(), state = path.join(f.dir, "runtime-home/.claude-code-router");
  fs.mkdirSync(state, { recursive: true });
  const lock = path.join(state, "recovery.failed"), attempts = path.join(state, "recovery.attempts");
  fs.writeFileSync(lock, "recovery limit reached\n");
  fs.writeFileSync(attempts, "3\n");
  const old = new Date(Date.now() - process.uptime() * 1000 - 60000);
  for (const file of [lock, attempts]) fs.utimesSync(file, old, old);
  assert.equal(await warmManagedBridge(), true);
  assert.deepEqual(f.calls().map((call) => call.command), ["ensure"]);
  assert.equal(fs.existsSync(lock), false, "旧故障锁应已改名");
  assert.equal(fs.existsSync(attempts), false, "旧恢复预算应已清掉");
  const archivedLock = fs.readdirSync(state).find((name) => /^recovery\.failed\.prev-\d+-[0-9a-f]+$/.test(name));
  assert.ok(archivedLock, "旧锁应留一份 .prev 证据");
  assert.equal(fs.readFileSync(path.join(state, archivedLock), "utf8"), "recovery limit reached\n");
  assert.equal(fs.readFileSync(path.join(state, archivedLock.replace("recovery.failed", "recovery.attempts")), "utf8"), "3\n");
});

test("网关启动预热：本周期刚写下的故障锁不动、不硬启", async () => {
  const f = fixture(), state = path.join(f.dir, "runtime-home/.claude-code-router");
  fs.mkdirSync(state, { recursive: true });
  const lock = path.join(state, "recovery.failed");
  fs.writeFileSync(lock, "recovery limit reached\n");
  await delay(20);
  assert.equal(await warmManagedBridge(), false);
  assert.deepEqual(f.calls(), []);
  assert.equal(fs.readFileSync(lock, "utf8"), "recovery limit reached\n");
});

test("网关启动预热：故障锁是链接时只读不动", async () => {
  const f = fixture(), state = path.join(f.dir, "runtime-home/.claude-code-router");
  fs.mkdirSync(state, { recursive: true });
  const target = path.join(f.dir, "not-a-lock"), lock = path.join(state, "recovery.failed");
  fs.writeFileSync(target, "keep me\n");
  fs.symlinkSync(target, lock);
  assert.equal(await warmManagedBridge(), false);
  assert.deepEqual(f.calls(), []);
  assert.equal(fs.lstatSync(lock).isSymbolicLink(), true);
});

test("网关启动预热：旧锁配本周期预算时不清理、不启动", async () => {
  const f = fixture(), state = path.join(f.dir, "runtime-home/.claude-code-router");
  fs.mkdirSync(state, { recursive: true });
  const lock = path.join(state, "recovery.failed"), attempts = path.join(state, "recovery.attempts");
  fs.writeFileSync(lock, "old failure\n");
  const old = new Date(Date.now() - process.uptime() * 1000 - 60000);
  fs.utimesSync(lock, old, old);
  fs.writeFileSync(attempts, "1\n");
  assert.equal(await warmManagedBridge(), false);
  assert.equal(fs.readFileSync(lock, "utf8"), "old failure\n");
  assert.equal(fs.readFileSync(attempts, "utf8"), "1\n");
  assert.deepEqual(f.calls(), []);
});

for (const part of ["runtime-home", ".claude-code-router"]) test(`网关启动预热：${part} 是目录链接时不动目标`, async () => {
  const f = fixture(), target = path.join(f.dir, "elsewhere");
  fs.mkdirSync(path.join(target, ".claude-code-router"), { recursive: true });
  const parent = part === "runtime-home" ? f.dir : path.join(f.dir, "runtime-home");
  fs.mkdirSync(parent, { recursive: true });
  fs.symlinkSync(target, path.join(parent, part));
  const state = path.join(f.dir, "runtime-home/.claude-code-router");
  const lock = path.join(state, "recovery.failed");
  fs.writeFileSync(lock, "preserve\n");
  const old = new Date(Date.now() - process.uptime() * 1000 - 60000);
  fs.utimesSync(lock, old, old);
  assert.equal(await warmManagedBridge(), false);
  assert.equal(fs.readFileSync(lock, "utf8"), "preserve\n");
  assert.deepEqual(f.calls(), []);
});

for (const pending of [false, true]) test(`网关启动预热：提前请求${pending ? "仍在途" : "已失败"}时旧锁恢复不受失败缓存阻挡`, async () => {
  const f = fixture("fail"), state = path.join(f.dir, "runtime-home/.claude-code-router");
  fs.mkdirSync(state, { recursive: true });
  const lock = path.join(state, "recovery.failed");
  // 提前请求本身也是预热：它失败后才写下旧锁，第二次预热清旧锁时须连失败缓存一起清掉。
  const request = warmManagedBridge();
  await until(() => f.calls().length === 1, "提前预热未启动");
  if (!pending) await request;
  fs.writeFileSync(lock, "previous failure\n");
  const old = new Date(Date.now() - process.uptime() * 1000 - 60000);
  fs.utimesSync(lock, old, old);
  fs.writeFileSync(path.join(f.dir, "mode"), "ok");
  assert.equal(await warmManagedBridge(), true);
  await request;
  assert.equal(f.calls().length, 2);
  assert.equal(fs.existsSync(lock), false);
});

test("网关启动预热：没有故障锁时保留看护已有预算", async () => {
  const f = fixture(), attempts = path.join(f.dir, "runtime-home/.claude-code-router/recovery.attempts");
  fs.mkdirSync(path.dirname(attempts), { recursive: true });
  fs.writeFileSync(attempts, "2\n");
  const old = new Date(Date.now() - process.uptime() * 1000 - 60000);
  fs.utimesSync(attempts, old, old);
  assert.equal(await warmManagedBridge(), true);
  assert.equal(fs.readFileSync(attempts, "utf8"), "2\n");
});

test("网关启动预热：组件不健康只当没预热，不抛出", async () => {
  const f = fixture("fail");
  assert.equal(await warmManagedBridge(), false);
  assert.deepEqual(f.calls().map((call) => call.command), ["ensure"]);
});

// 删桥后覆盖缺口补位（round2 bridge-verify）：原“retire 取消在途 ensure”用例随
// ensureManagedBridge 删除而消失；inFlight 现只由 warm 经 startBridge 填充，
// retire 仍同步快照 inFlight 并逐个 cancel——本用例直接覆盖“retire 取消一次在途 warm 启动”。
test("retire 取消在途 warm 启动：不等 70 秒、不误杀常驻服务", async () => {
  const f = fixture("resident-hang");
  const warming = warmManagedBridge();
  await until(() => f.calls().length === 1, "预热未启动 ensure");
  await until(() => fs.existsSync(path.join(f.dir, "heartbeat")), "常驻服务未起心跳");
  const beatBefore = Number(fs.readFileSync(path.join(f.dir, "heartbeat"), "utf8"));
  const started = performance.now();
  const retired = await within(retireManagedBridge("openai-bridge"), 10000, "retire 应取消在途 warm，不等 70 秒挂起");
  const elapsed = performance.now() - started;
  assert.equal(retired, true);
  assert.ok(elapsed < 10000, `retire 应在 10 秒内完成，实际 ${elapsed}ms`);
  assert.equal(await within(warming, 10000, "在途 warm 应随 retire 取消而收尾"), false);
  assert.deepEqual(f.calls().map((call) => call.command), ["ensure", "uninstall"]);
  assert.equal(fs.existsSync(reg), false, "retire 成功后注册应已清除");
  await delay(200);
  const beatAfter = Number(fs.readFileSync(path.join(f.dir, "heartbeat"), "utf8"));
  assert.ok(beatAfter > beatBefore, "常驻服务心跳应继续，不能被 retire 误杀");
});
