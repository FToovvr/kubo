import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.134.0/testing/asserts.ts";
import { FakeTime } from "https://deno.land/x/mock@0.15.0/mod.ts";

import { DB } from "https://deno.land/x/sqlite@v3.3.0/mod.ts";

import { TestStore } from "./test_storage.ts";

async function withNewStore(cb: (store: TestStore) => Promise<void> | void) {
  const store = new TestStore();
  await store.init();
  await cb(store);
  store.close();
}

Deno.test("kubo/storage set&get", async () => {
  await withNewStore(async (store) => {
    const ctx = { namespace: "test" };

    for (const _ in [1, 2]) {
      for (const val of ["foo", 42, null]) {
        await store.set(ctx, "test", val);
        if (val === null) {
          assertEquals(await store.get(ctx, "test"), null);
        } else {
          assertEquals(await store.get(ctx, "test"), String(val));
        }
      }
    }

    assertEquals(await store.get(ctx, "not found"), null);
  });
});

Deno.test("kubo/storage ctx error", async () => {
  await withNewStore(async (store) => {
    const ctxs: { namespace: string; group?: number; qq?: number }[] = [];
    for (const group of [null, 0, -1]) {
      for (const qq of [null, 0, -1]) {
        ctxs.push({
          namespace: "",
          ...(group ? { group } : {}),
          ...(qq ? { qq } : {}),
        });
      }
    }

    for (const [i, ctx] of Object.entries(ctxs)) {
      if (!ctx.qq && !ctx.group) {
        store.set(ctx, "test", 0);
        assertEquals(await store.get(ctx, "test"), "0");
        continue;
      }
      assertRejects(async () => await store.set(ctx, "test", 0));
      assertRejects(async () => await store.get(ctx, "test"));
    }
  });
});

Deno.test("kubo/storage ctx", async () => {
  await withNewStore(async (store) => {
    const ctxs: { namespace: string; group?: number; qq?: number }[] = [];
    for (const namespace of ["a", "b"]) {
      for (const group of [null, 1]) {
        for (const qq of [null, 1]) {
          ctxs.push({
            namespace,
            ...(group ? { group } : {}),
            ...(qq ? { qq } : {}),
          });
        }
      }
    }

    for (const [i, ctx] of Object.entries(ctxs)) {
      await store.set(ctx, "test", i);
    }

    for (const [i, ctx] of Object.entries(ctxs)) {
      assertEquals(await store.get(ctx, "test"), i);
    }
  });
});

Deno.test("kubo/storage expire", async () => {
  const nowMs = (new Date()).getTime();
  const now = Math.floor(nowMs / 1000);
  const time = new FakeTime(nowMs);

  await withNewStore(async (store) => {
    const ctx = { namespace: "test" };

    try {
      store.set(ctx, "key", "value", {
        expireTimestamp: now + 10, // 十秒后
      });
      time.tick(1000); // 开始的一秒后
      assertEquals(await store.get(ctx, "key"), "value");
      time.tick(10000); // 开始的十一秒后
      assertEquals(await store.get(ctx, "key"), null);
    } finally {
      time.restore();
    }
  });
});
