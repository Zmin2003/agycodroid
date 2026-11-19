import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

test("账本数组里的 null/畸形元素在加载时被清掉，不会让记账崩溃", async () => {
  const { _billForTest: B } = await import("../gw/providers.mjs");
  const j = B.billShape({ p: { tok: [null, ["x"], [1, 2, 3, 4]], spends: [null, [1, 2], ["a", 2]] } });
  assert.deepEqual(j.p.tok, [[1, 2, 3, 4]]);
  assert.deepEqual(j.p.spends, [[1, 2]]);
});
