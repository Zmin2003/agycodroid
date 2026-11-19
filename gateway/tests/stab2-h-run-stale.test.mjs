// h 组 BUG-R02（agy 版）：一轮已出 result、但还有插话没送达（resultStale），CLI 接着退出
// 却没出第二轮的 result 时，不能沿用上一轮的成功。
// agy 里「又起了一轮」就是有插话待送达：result 到达时 pendingInject 非空，run.mjs 记
// resultStale、不关 stdin；CLI 退出时仍没等到第二轮结果 → 按失败算。
// 旧版用 background_tasks_changed + message_start 表达「新一轮已开始」，agy 没有这些事件。
import { test } from "node:test";
import assert from "node:assert/strict";
import { events, runWith, startRun, endOf, until, sid, init, resp, result, script, root } from "./fixtures/stab2-h-run-harness.mjs";
import { enqueue } from "../gw/queue.mjs";

test("BUG-R02：插话已送达、没等到第二轮 result 却 exit 0 → 按失败算，不沿用上一轮成功", async () => {
  const s = sid();
  script([init(s), resp(0, "hi"), { sleep: 2 }, result(10, 1, { cid: s })], 0);
  const going = startRun({ id: "r-h-stale0", message: "fixture", cwd: root });
  await until(() => events.some((e) => e.type === "init" && e.sessionId === s));
  // 显式插话：同一会话、正在跑 → 直接写进 stdin，pendingInject 非空
  enqueue({ message: "插话", sessionId: s, mode: "inject" });
  await going;
  await until(() => endOf("r-h-stale0"));
  const e = endOf("r-h-stale0");
  assert.equal(e.failed, true, JSON.stringify(e));
  assert.ok(events.find((ev) => ev.type === "error" && ev.runId === "r-h-stale0"), "要告诉用户这一轮没答完");
});

test("BUG-R02 对照：没出 result 就 exit 17 → 按失败算", async () => {
  const e = await runWith("r-h-stale17", [init(sid()), resp(0, "hi")], 17);
  assert.equal(e.failed, true, JSON.stringify(e));
});

test("BUG-R02 对照：正常答完、exit 0 照旧算成功", async () => {
  const s = sid();
  const e = await runWith("r-h-bg0", [init(s), resp(0, "hi"), result(10, 1, { cid: s })], 0);
  assert.equal(!!e.failed, false, JSON.stringify(e));
  assert.equal(e.subtype, "SUCCESS");
});
