import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.134.0/testing/asserts.ts";
import { FakeTime } from "https://deno.land/x/mock@0.15.0/mod.ts";

import { TestStore } from "../../test_storage.ts";
import { FloodMonitor } from "./flood_monitor.ts";

async function withFloodMonitor(
  cb: (m: FloodMonitor, time: FakeTime) => Promise<void>,
) {
  const store = new TestStore();
  store.init();
  const monitor = new FloodMonitor(store, {
    thresholds: {
      global: 60,
      group: 30,
      user: 15,
    },
  });

  const fakeTime = new FakeTime(new Date());
  try {
    await cb(monitor, fakeTime);
  } finally {
    fakeTime.restore();
  }

  await monitor.close();
  store.close();
}

const testPrefix = "kubo/flood_monitor";

Deno.test(`${testPrefix}`, async (t) => {
  await t.step("触发阈值", async (t) => {
    await t.step("单用户", async (t) => {
      const userA = 10000, userB = 10001;
      const groupA = 42;
      await withFloodMonitor(async (m, time) => {
        const threshold = m.thresholds.user;
        const half = Math.floor(threshold / 2);
        for (let i = 0; i < half; i++) { // 尚未触发冷却
          const result = await m.reportOutboundGroupMessage(42, userA);
          assert(result.isOk);
          assertEquals(result.errors, []);
        }
        for (let i = half; i < threshold; i++) { // 尚未触发冷却
          const result = await m.reportOutboundPrivateMessage(userA);
          assert(result.isOk);
          assertEquals(result.errors, []);
        }
        { // 在群组触发冷却
          const result = await m.reportOutboundGroupMessage(groupA, userA);
          assert(!result.isOk);
          // 触发冷却的那个操作，会返回错误文本
          assertEquals(result.errors.length, 1);
        }
        { // 触发冷却后的私聊
          const result = await m.reportOutboundPrivateMessage(userA);
          assert(!result.isOk);
          // 冷却期间的操作，不会返回错误文本
          assertEquals(result.errors, []);
        }
        { // 其他用户不受影响
          const result = await m.reportOutboundGroupMessage(groupA, userB);
          assert(result.isOk);
          assertEquals(result.errors, []);
        }
        { // 其他用户不受影响
          const result = await m.reportOutboundPrivateMessage(userB);
          assert(result.isOk);
          assertEquals(result.errors, []);
        }

        time.tick(1000 * 59); // 59 秒后
        { // 仍然在冷却
          const result = await m.reportOutboundGroupMessage(groupA, userA);
          assert(!result.isOk);
          assertEquals(result.errors, []);
        }
        time.tick(1000 * 1); // 整 60 秒后
        { // 冷却解除，群聊恢复
          const result = await m.reportOutboundGroupMessage(groupA, userA);
          assert(result.isOk);
          assertEquals(result.errors, []);
        }
        { // 冷却解除，私聊恢复
          const result = await m.reportOutboundPrivateMessage(userA);
          assert(result.isOk);
          assertEquals(result.errors, []);
        }

        // 再次触发冷却
        for (let i = 0; i < threshold - 2; i++) {
          const result = await m.reportOutboundPrivateMessage(userA);
          assert(result.isOk);
          assertEquals(result.errors, []);
        }
        {
          const result = await m.reportOutboundPrivateMessage(userA);
          assert(!result.isOk);
          assertEquals(result.errors.length, 1);
        }
        // 同一天第二次触发是五分钟
        time.tick(1000 * (5 * 60 - 1)); // 4 分 59 秒后
        {
          const result = await m.reportOutboundPrivateMessage(userA);
          assert(!result.isOk);
          assertEquals(result.errors, []);
        }
        time.tick(1000 * 1); // 整 5 分钟后
        {
          const result = await m.reportOutboundPrivateMessage(userA);
          assert(result.isOk);
          assertEquals(result.errors, []);
        }
      });
    });

    await t.step("群组", async (t) => {
      const userA = 10000, userBBase = 20000, userC = 30000;
      const groupA = 1, groupB = 2;
      await withFloodMonitor(async (m, time) => {
        const threshold = m.thresholds.group;

        for (let i = 0; i < threshold; i++) { // 尚未触发冷却
          const userBX = userBBase + i;
          const result = await m.reportOutboundGroupMessage(groupA, userBX);
          assert(result.isOk);
          assertEquals(result.errors, []);
        }
        { // 触发冷却
          const result = await m.reportOutboundGroupMessage(groupA, userA);
          assert(!result.isOk);
          assertEquals(result.errors.length, 1);
        }
        { // 触发群组冷却的用户不会触发用户冷却
          const result = await m.reportOutboundGroupMessage(groupB, userA);
          assert(result.isOk);
          assertEquals(result.errors, []);
        }
        { // 没有参与触发群组冷却的用户也会受到群组冷却的限制
          const result = await m.reportOutboundGroupMessage(groupA, userC);
          assert(!result.isOk);
          assertEquals(result.errors, []);
        }
      });
    });

    await t.step("全局", async (t) => {
      const userA = 10000, userBBase = 20000, userC = 30000;
      const groupA = 1, groupB = 2;
      await withFloodMonitor(async (m, time) => {
        const threshold = m.thresholds.global;

        for (let i = 0; i < threshold; i++) { // 尚未触发冷却
          const userBX = userBBase + i;
          const result = await m.reportOutboundPrivateMessage(userBX);
          assert(result.isOk);
          assertEquals(result.errors, []);
        }
        { // 触发冷却
          const result = await m.reportOutboundGroupMessage(groupA, userA);
          assert(!result.isOk);
          assertEquals(result.errors.length, 1);
        }
        { // 在其他不相干的地方也触发冷却
          const result = await m.reportOutboundGroupMessage(groupB, userC);
          assert(!result.isOk);
          // 对于全局冷却，每个试图操作的地方都能收到一次相关提示
          assertEquals(result.errors.length, 1);
        }
        { // 相同的地方不会触发第二次提示
          const result = await m.reportOutboundGroupMessage(groupA, userA);
          assert(!result.isOk);
          assertEquals(result.errors, []);
        }
        time.tick(1000 * (5 * 60 - 1)); // 进展到解除冷却的前一秒
        { // 私聊也有提示
          const userB0 = userBBase + 0;
          const result = await m.reportOutboundPrivateMessage(userB0);
          assert(!result.isOk);
          assertEquals(result.errors.length, 1);
        }

        time.tick(1000); // 解除冷却

        { // 再来一次
          for (let i = 0; i < threshold; i++) { // 同上：尚未触发冷却
            const userBX = userBBase + i;
            const result = await m.reportOutboundPrivateMessage(userBX);
            assert(result.isOk);
            assertEquals(result.errors, []);
          }
          { // 同上：触发冷却
            const result = await m.reportOutboundGroupMessage(groupA, userA);
            assert(!result.isOk);
            assertEquals(result.errors.length, 1);
          }
          { // 同上：在其他不相干的地方也触发冷却
            const result = await m.reportOutboundGroupMessage(groupB, userC);
            assert(!result.isOk);
            // 之前收到过全局冷却提示的地方，在新的冷却期也会重新收到
            assertEquals(result.errors.length, 1);
          }
          { // 同上：相同的地方不会触发第二次提示
            const result = await m.reportOutboundGroupMessage(groupA, userA);
            assert(!result.isOk);
            assertEquals(result.errors, []);
          }
        }
      });
    });
  });
});
