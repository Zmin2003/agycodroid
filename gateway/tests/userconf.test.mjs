// 用户级配置留痕（gw/userconf.mjs）、之前的对话留下的进程（gw/leftover.mjs）、设置文件被外部改写、输出风格只列用户目录
// 监视目标是 agy 真正读的 ~/.gemini/antigravity-cli/settings.json（旧版 ~/.claude 已不再监视，见 userconf.mjs 文件头）。
// 旧版“钩子注入可见”（stream.mjs 的 hookContext）已不存在：agy 没有钩子往上下文里塞东西。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CFG, PATHS } from "../gw/config.mjs";
import { UC_SEALED, _ucFlush, _ucReset, ucAfterRun, ucAppBegin, ucAppWrote, ucBeforeRun, ucKeep, ucPending, ucRevert, ucSetRevertNote, ucTakeNote } from "../gw/userconf.mjs";
import { _keptReset, keepProcs, killProcs, leftoverProcs, procStart } from "../gw/leftover.mjs";
import { transcriptItems } from "../gw/transcript.mjs";

// CI 的 Linux 没有 /system/bin/sh（#113 同款）
const SH = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
import { SETTINGS, outputStyles, saveSettings, settingsDiskCheck } from "../gw/settings-store.mjs";

const H = (rel) => path.join(CFG.home, rel);
const AGY = ".gemini/antigravity-cli/settings.json";
const put = (rel, s) => { fs.mkdirSync(path.dirname(H(rel)), { recursive: true }); fs.writeFileSync(H(rel), s); };
const putAgy = (j) => put(AGY, JSON.stringify(j));
function fresh() {
  for (const r of [".claude", ".claude.json", ".gemini", ".agyapp-userconf", "agyapp-userconf.json"]) fs.rmSync(H(r), { recursive: true, force: true });
  _ucReset();
}

test("只有安全键（model）的 settings.json 不问", () => {
  fresh();
  putAgy({ model: "x" });     // 只有不让东西跑起来的键：不算
  assert.equal(ucPending(), null);
});

test("第一次检查：settings.json 里会让东西跑起来的键问一次", () => {
  fresh();
  putAgy({ model: "x", permissions: { allow: ["Bash(*)"] } });
  const p = ucPending();
  assert.ok(p && p.first);
  assert.deepEqual(p.rels, [AGY]);
  ucKeep(p.rels);
  assert.equal(ucPending(), null, "保留之后不再问");
});

test("权限规则改了 → 问，摘要里有权限；改 model 这类键不问；撤销只换回权限那块、别的键照留", () => {
  fresh();
  putAgy({ model: "a" });
  ucPending();                                  // 建基线
  putAgy({ model: "b" });
  assert.equal(ucPending(), null);
  putAgy({ model: "b", permissions: { allow: ["Bash(*)"] } });
  const p = ucPending();
  assert.equal(p.changes.length, 1);
  assert.equal(p.changes[0].kind, "added");
  assert.match(p.changes[0].preview, /permissions: .*Bash/);
  const r = ucRevert(p.rels);
  assert.deepEqual(r.failed, []);
  const j = JSON.parse(fs.readFileSync(H(AGY), "utf8"));
  assert.equal(j.permissions, undefined);
  assert.equal(j.model, "b");
  assert.equal(ucPending(), null);
  // 又被改回来：卡片上记着第几次
  putAgy({ model: "b", permissions: { allow: ["Read(*)"] } });
  assert.equal(ucPending().changes[0].again, 1);
});

test("旧的 ~/.claude 不再监视：CLAUDE.md、skill、.claude.json 改了也不问；旧确认记录里的 .claude 项升级后剔掉", () => {
  fresh();
  put(".claude/CLAUDE.md", "# 我的规矩\n");
  put(".claude/skills/a/SKILL.md", "---\nname: a\n---\n");
  put(".claude.json", JSON.stringify({ mcpServers: { evil: { command: "sh" } } }));
  assert.equal(ucPending(), null);
  // 升级前认下过的 .claude 项留在记录文件里：读记录时剔掉，删了也不报
  fs.writeFileSync(H("agyapp-userconf.json"), JSON.stringify({ files: { ".claude/CLAUDE.md": "deadbeef", ".claude/settings.json": "deadbeef" }, modes: {} }));
  _ucReset();
  assert.equal(ucPending(), null);
});

test("副本也被改了：还原后对不上，报没法还原", () => {
  fresh();
  putAgy({ model: "a", permissions: { allow: ["Bash(*)"] } });
  ucKeep(ucPending().rels);
  for (const f of fs.readdirSync(H(".agyapp-userconf"))) if (/^[0-9a-f]{24}$/.test(f)) fs.writeFileSync(path.join(H(".agyapp-userconf"), f), "被换掉的副本\n");
  putAgy({ model: "a", permissions: { allow: ["Read(*)"] } });
  assert.deepEqual(ucRevert(ucPending().rels).failed, [AGY]);
});

test("应用自己写的（ucAppWrote）直接认下；写之前就有没确认的改动不认；没带快照不认", () => {
  fresh();
  putAgy({ model: "a", permissions: { allow: ["Bash(*)"] } });
  ucPending();
  ucKeep(ucPending()?.rels || []);
  // 应用改了允许的键（permissions）：认下
  const b0 = ucAppBegin();
  putAgy({ model: "a", permissions: { allow: ["Bash(*)", "Read(*)"] } });
  ucAppWrote([H(AGY)], b0, { [AGY]: ["permissions"] });
  assert.equal(ucPending(), null);
  // 先埋一个没确认的权限改动，应用再改也不认
  putAgy({ model: "a", permissions: { allow: ["Evil(*)"] } });
  const b1 = ucAppBegin();
  putAgy({ model: "a", permissions: { allow: ["Evil(*)", "Read(*)"] } });
  ucAppWrote([H(AGY)], b1, { [AGY]: ["permissions"] });
  assert.deepEqual(ucPending().rels, [AGY]);
  ucKeep([AGY]);
  // 没带快照：不认
  putAgy({ model: "a", permissions: { allow: ["Evil(*)", "Read(*)", "Write(*)"] } });
  ucAppWrote([H(AGY)]);
  assert.ok(ucPending());
});

test("运行期间改的：卡片上标出来；撤销后给模型的提醒只说一次", () => {
  fresh();
  ucPending();
  const run = { id: "r1", sessionId: "s1" };
  ucBeforeRun(run);
  putAgy({ permissions: { allow: ["Bash(*)"] } });
  ucAfterRun(run);
  const p = ucPending();
  assert.equal(p.changes[0].during, "s1");
  ucRevert(p.rels);
  ucSetRevertNote(p.rels, 1);
  assert.match(ucTakeNote(), /antigravity-cli\/settings\.json.*1 background process/s);
  assert.equal(ucTakeNote(), "");
});

test("留下的进程：带已结束轮次编号的列出来；还在跑的那轮不算；保留后不再列；结束会连子孙一起", async () => {
  const c = spawn(SH, ["-c", "sleep 30 & wait"], { env: { ...process.env, AGAPP_RUN_ID: "gone-1", AGAPP_GW_PORT: String(CFG.port), AGAPP_GW_PID: String(process.pid), HOME: CFG.home }, detached: true, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 300));
  try {
    assert.ok(!leftoverProcs(new Map([["gone-1", procStart(c.pid)]])).some((p) => p.pid === c.pid), "还在跑的轮次不算");
    const l = leftoverProcs(new Map());
    const me = l.find((p) => p.pid === c.pid);
    assert.ok(me && me.kind === "run");
    assert.ok(!l.some((p) => p.ppid === c.pid), "子进程跟着父进程，不单列");
    keepProcs([me]);
    assert.ok(!leftoverProcs(new Map()).some((p) => p.pid === c.pid || p.ppid === c.pid));
    assert.ok(killProcs([me]) >= 2);
    await new Promise((r) => setTimeout(r, 200));
    let alive = true; try { process.kill(c.pid, 0); } catch { alive = false; }
    let st = ""; try { st = fs.readFileSync(`/proc/${c.pid}/stat`, "utf8"); } catch {}
    assert.ok(!alive || / Z /.test(st), "进程已结束");
  } finally { try { process.kill(-c.pid, "SIGKILL"); } catch {} }
});

test("#167 保留的看护后来起的子进程不再问；网关重启后照认；命令行对不上不认；别的照问", async () => {
  const env = { ...process.env, AGAPP_RUN_ID: "gone-2", AGAPP_GW_PORT: String(CFG.port), AGAPP_GW_PID: String(process.pid), HOME: CFG.home };
  const c = spawn(SH, ["-c", "while :; do sleep 0.1; done"], { env, detached: true, stdio: "ignore" });
  const other = spawn(SH, ["-c", "sleep 30 & wait"], { env, detached: true, stdio: "ignore" });
  await sleep(300);
  try {
    const me = leftoverProcs(new Map()).find((p) => p.pid === c.pid);
    assert.ok(me);
    keepProcs([me]);
    await sleep(400);                 // 看护换了好几茬 sleep
    const mineOrKids = (l) => l.some((p) => p.pid === c.pid || p.ppid === c.pid);
    let l = leftoverProcs(new Map());
    assert.ok(!mineOrKids(l), "新起的子进程跟着保留");
    assert.ok(l.some((p) => p.pid === other.pid), "没保留的照问");
    _keptReset();
    l = leftoverProcs(new Map());
    assert.ok(!mineOrKids(l), "网关重启后照认");
    const f = H("agyapp-leftover-kept.json"), j = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const k of Object.keys(j.kept)) j.kept[k] = "别的命令";
    fs.writeFileSync(f, JSON.stringify(j));
    _keptReset();
    assert.ok(leftoverProcs(new Map()).some((p) => p.pid === c.pid), "命令行对不上（pid 复用）不认");
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(JSON.stringify(j)), boot: "x" }));
    _keptReset();
    assert.ok(leftoverProcs(new Map()).some((p) => p.pid === c.pid), "换了开机不认");
  } finally { for (const x of [c, other]) try { process.kill(-x.pid, "SIGKILL"); } catch {} fs.rmSync(H("agyapp-leftover-kept.json"), { force: true }); _keptReset(); }
});

test("会话记录里的 hook_additional_context 附件仍按 hookctx 显示（旧记录兼容）", () => {
  const it = transcriptItems({ type: "attachment", attachment: { type: "hook_additional_context", content: ["HOOKMARK"], hookEvent: "UserPromptSubmit" } });
  assert.deepEqual(it, [{ role: "hookctx", event: "UserPromptSubmit", text: "HOOKMARK" }]);
});

test("设置文件网关跑着时被外部改写：按内存写回", () => {
  assert.ok(saveSettings());
  const before = fs.readFileSync(PATHS.settings, "utf8");
  assert.equal(settingsDiskCheck(), false);
  fs.writeFileSync(PATHS.settings, JSON.stringify({ ...SETTINGS, outputStyle: "boot-frame" }));
  assert.equal(settingsDiskCheck(), true);
  assert.equal(fs.readFileSync(PATHS.settings, "utf8"), before);
});

test("输出风格只列内置的两档：agy 不读 ~/.claude/output-styles，工作区里别人放的也不列", () => {
  put(".claude/output-styles/mine.md", "---\nname: Mine\n---\n");
  const ws = path.join(CFG.workspace, ".claude/output-styles");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "probe.md"), "---\nname: Probe\ndescription: 输出格式检查\n---\n每条回答第一行写 [T]\n");
  const ids = outputStyles().map((o) => o.id);
  assert.deepEqual(ids, ["Explanatory", "Learning"]);
  assert.ok(!ids.includes("Mine"));
  assert.ok(!ids.includes("Probe"));
  fs.rmSync(path.join(CFG.workspace, ".claude"), { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("改了又改回：常驻监视看见了，现在和确认的一样也照样问；起进程紧前核到就不起", async () => {
  fresh();
  putAgy({ model: "a" });
  ucKeep(ucPending()?.rels || []);
  assert.equal(ucPending(), null);
  const orig = fs.readFileSync(H(AGY), "utf8");
  putAgy({ model: "a", permissions: { allow: ["Bash(*)"] } });
  await sleep(150); _ucFlush();
  fs.writeFileSync(H(AGY), orig);
  await sleep(150);
  assert.deepEqual(ucBeforeRun({ id: "x1" }), [AGY], "起进程紧前核到");
  const p = ucPending();
  assert.equal(p.changes[0].kind, "transient");
  assert.match(p.changes[0].preview, /Bash/);
  assert.deepEqual(ucRevert(p.rels).failed, []);
  assert.equal(ucPending(), null);
  assert.deepEqual(ucBeforeRun({ id: "x2" }), []);
  ucAfterRun({ id: "x2" });
});

test("应用写入期间别的键也变了：按允许的键核，不认", () => {
  fresh();
  putAgy({ model: "a", permissions: { allow: ["Bash(*)"] } });
  ucKeep(ucPending()?.rels || []);
  const b = ucAppBegin();
  putAgy({ model: "a", permissions: { allow: ["Bash(*)", "Read(*)"] }, toolPermission: "bypass" });
  ucAppWrote([H(AGY)], b, { [AGY]: ["permissions"] });
  assert.deepEqual(ucPending().rels, [AGY]);
  // 只动了允许的键：认
  ucKeep([AGY]);
  const b2 = ucAppBegin();
  putAgy({ model: "a", permissions: { allow: ["Bash(*)"] }, toolPermission: "bypass" });
  ucAppWrote([H(AGY)], b2, { [AGY]: ["permissions"] });
  assert.equal(ucPending(), null);
});

test("副本被换了还原不成：现在的样子被清掉危险键，不留在原地", () => {
  fresh();
  putAgy({ model: "a", permissions: { allow: ["Bash(*)"] } });
  ucKeep(ucPending().rels);
  for (const f of fs.readdirSync(H(".agyapp-userconf"))) if (/^[0-9a-f]{24}$/.test(f)) fs.writeFileSync(path.join(H(".agyapp-userconf"), f), "被换掉的副本\n");
  putAgy({ model: "a", permissions: { allow: ["Read(*)"] } });
  const r = ucRevert(ucPending().rels);
  assert.deepEqual(r.failed, [AGY]);
  // 磁盘上的文件本身已被换成非法文本，读不出原来的安全键：只能从空对象起步，危险键清掉
  assert.deepEqual(JSON.parse(fs.readFileSync(H(AGY), "utf8")), {}, "危险键清掉");
  assert.ok(r.quarantine && fs.existsSync(path.join(r.quarantine, AGY)));
});

test("设置文件现在不是合法 JSON：撤销前先拷进隔离目录", () => {
  fresh();
  putAgy({ model: "a" });
  ucKeep(ucPending()?.rels || []);
  putAgy({ model: "a", permissions: { allow: ["Bash(*)"] } });
  const p = ucPending();
  fs.writeFileSync(H(AGY), "{ 坏了");
  const r = ucRevert(p.rels);
  assert.ok(r.quarantine === null || fs.existsSync(r.quarantine));
  const q = fs.readdirSync(H(".agyapp-userconf/quarantine"));
  assert.ok(q.some((d) => fs.existsSync(path.join(H(".agyapp-userconf/quarantine"), d, AGY))));
});

test("留下的进程冒充正在跑的那一轮：起得比那一轮早，照样列", async () => {
  const c = spawn(SH, ["-c", "sleep 30"], { env: { ...process.env, AGAPP_RUN_ID: "live-1", AGAPP_GW_PORT: String(CFG.port), AGAPP_GW_PID: String(process.pid), HOME: CFG.home }, detached: true, stdio: "ignore" });
  await sleep(300);
  try {
    const later = spawn(SH, ["-c", "sleep 5"], { detached: true, stdio: "ignore" });
    await sleep(1200);
    const late = spawn(SH, ["-c", "sleep 5"], { detached: true, stdio: "ignore" });
    await sleep(100);
    try {
      assert.ok(+procStart(late.pid) > +procStart(c.pid));
      assert.ok(leftoverProcs(new Map([["live-1", procStart(late.pid)]])).some((p) => p.pid === c.pid), "那一轮的 claude 比它晚起");
      assert.ok(leftoverProcs(new Map([["live-1", null]])).some((p) => p.pid === c.pid), "那一轮还没起 claude");
      assert.ok(!leftoverProcs(new Map([["live-1", procStart(c.pid)]])).some((p) => p.pid === c.pid), "真是那一轮起的");
    } finally { for (const x of [later, late]) try { process.kill(-x.pid, "SIGKILL"); } catch {} }
  } finally { try { process.kill(-c.pid, "SIGKILL"); } catch {} }
});

test("点「保留」只认卡片上那一版：等用户点的时候又被改了，不认、返回出来（GHSA-q9wp）", () => {
  fresh();
  putAgy({ permissions: { allow: ["V0"] } });
  ucKeep(ucPending().rels);
  putAgy({ permissions: { allow: ["V1"] } });
  const p = ucPending();
  assert.match(p.changes[0].preview, /V1/);
  putAgy({ permissions: { allow: ["V2 没给用户看过"] } });
  assert.deepEqual(ucKeep(p.rels, p.ticket), [AGY]);
  const again = ucPending();
  assert.ok(again && again.rels.includes(AGY), "V2 没被认下，下一轮还要问");
  assert.match(again.changes[0].preview, /V2/);
  // 这回没再动：照常认下
  assert.deepEqual(ucKeep(again.rels, again.ticket), []);
  assert.equal(ucPending(), null);
});

test("卡片之后改了又改回同一版：常驻监视看见了，也不认", async () => {
  fresh();
  putAgy({ permissions: { allow: ["V0"] } });
  ucKeep(ucPending().rels);
  putAgy({ permissions: { allow: ["V1"] } });
  const p = ucPending();
  await new Promise((r) => setTimeout(r, 20));
  putAgy({ permissions: { allow: ["偷换"] } }); _ucFlush();
  putAgy({ permissions: { allow: ["V1"] } }); _ucFlush();
  assert.deepEqual(ucKeep(p.rels, p.ticket), [AGY]);
});

test("发行版只问 agy 的 settings.json：~/.claude 改了不问；起进程紧前也只核这一份", () => {
  fresh();
  putAgy({ permissions: { allow: ["Bash(*)"] } });
  put(".claude/CLAUDE.md", "# x\n");
  const first = ucPending(UC_SEALED);
  assert.ok(first && first.first);
  assert.deepEqual(first.rels, [AGY], "第一次：settings.json 问一次，CLAUDE.md 发行版不读、不出现");
  ucKeep(first.rels, first.ticket);
  assert.equal(ucPending(UC_SEALED), null);
  put(".claude/CLAUDE.md", "# y\n");
  put(".claude/skills/s/SKILL.md", "---\nname: s\n---\n");
  assert.equal(ucPending(UC_SEALED), null, "发行版不读的不问");
  assert.deepEqual(ucBeforeRun({ id: 1 }, UC_SEALED), [], "也不挡起进程");
  ucAfterRun({ id: 1 });
  putAgy({ permissions: { allow: ["Bash(*)", "Read(*)"] } });
  const p = ucPending(UC_SEALED);
  assert.deepEqual(p.rels, [AGY]);
  assert.deepEqual(ucBeforeRun({ id: 2 }, UC_SEALED), [AGY]);
  assert.deepEqual(ucPending().rels, [AGY], "全量检查如今也只看这一份");
});
