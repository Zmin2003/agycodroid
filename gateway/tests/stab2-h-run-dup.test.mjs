// h 组 BUG-R03：相同终止身份的 result 重复到达，token 统计与回复轮数只结算一次；
// 真正不同的轮次（身份不同、usage 数值相同）仍分别计量。
// agy 的 result 身份是 conversation_id + num_turns（run.mjs 按 uuid "agy-<cid>-<turns>" 去重）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { runWith, sid, init, result, flushUsage, usageTotals } from "./fixtures/stab2-h-run-harness.mjs";

test("BUG-R03：相同 conversation_id + num_turns 的 result 重复到达 → token 与轮数只结算一次", async () => {
  const s = sid();
  const r = result(10, 2, { cid: s, turns: 1 });
  flushUsage(); const before = usageTotals();
  const e = await runWith("r-h-dup", [init(s), r, r], 0);
  flushUsage(); const after = usageTotals();
  assert.equal(!!e.failed, false, JSON.stringify(e));
  assert.deepEqual({ t: after.t - before.t, i: after.i - before.i, o: after.o - before.o }, { t: 1, i: 10, o: 2 },
    "同一份 result 不能结算两次（改前是 t2/i20/o4）");
});

test("BUG-R03 对照：num_turns 不同的两轮 result 即使 usage 数值相同也各记各的", async () => {
  const s = sid();
  const r1 = result(10, 2, { cid: s, turns: 1 });
  const r2 = result(10, 2, { cid: s, turns: 2 });
  flushUsage(); const before = usageTotals();
  const e = await runWith("r-h-two", [init(s), r1, r2], 0);
  flushUsage(); const after = usageTotals();
  assert.equal(!!e.failed, false, JSON.stringify(e));
  assert.deepEqual({ t: after.t - before.t, i: after.i - before.i, o: after.o - before.o }, { t: 2, i: 20, o: 4 },
    "数值相同但身份不同，不能合并");
});
