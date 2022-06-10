import { AllowedValueType, SettingsManager } from "./settings_manager.ts";

import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.134.0/testing/asserts.ts";

import { TestStore } from "../../test_storage.ts";

async function withManager(
  cb: (manager: SettingsManager) => Promise<void> | void,
) {
  const store = new TestStore();
  store.init();
  const manager = new SettingsManager(store);

  await cb(manager);

  manager.close();
  store.close();
}

Deno.test("kubo/settings_manager", async (t) => {
  await withManager(async (m) => {
    await t.step("访问没有注册的配置节点", async (t) => {
      // 若访问未注册的节点，set/get 将直接抛出异常
      await assertRejects(async () => { // FIXME: Uncaught (in promise) Error???
        await m.set({}, "foo", "bar");
      });
      await assertRejects(async () => {
        await m.get({}, "foo");
      });

      // 若访问未注册的节点，trySet/tryGet 将返回 undefined
      assertEquals(await m.trySet({}, "foo", "bar"), undefined);
      assertEquals(await m.tryGet({}, "foo"), undefined);

      // 若访问未注册的节点，tryGetRegisteredNode 将返回空 Object
      assertEquals(await m.tryGetRegisteredNode(["foo", "bar", "baz"]), {});
    });
    await t.step("集合节点", async (t) => {
      const fooInfo = {
        readableName: "呒呜呜",
        description: "This is a random description",
      };
      const barInfo = {
        readableName: "吧啊儿",
        description: "This is another random description",
      };

      // 不应该允许路径中空的注册
      await assertRejects(async () => {
        await m.registerCollection(["nothingness", "foo"], { info: fooInfo });
      });
      // 首次注册
      await m.registerCollection("foo", { info: fooInfo });
      assertEquals((await m.tryGetRegisteredNode("foo")).collectionNode!, {
        type: "collection",
        name: "foo",
        ...fooInfo,
      });

      // 不应该允许重复注册
      await assertRejects(async () =>
        await m.registerCollection(["foo"], { info: barInfo })
      );
      // 允许嵌套注册
      await m.registerCollection(["foo", "bar"], { info: barInfo });
      assertEquals(
        (await m.tryGetRegisteredNode(["foo", "bar"])).collectionNode!,
        {
          type: "collection",
          name: "bar",
          ...barInfo,
        },
      );
    });
    await t.step("值节点", async (t) => {
      const kvXInfo = { readableName: "键值X", description: "blah blah" };

      // 不应该允许路径中空的注册
      await assertRejects(async () =>
        await m.register(["foo", "_", "kvX"], {
          info: kvXInfo,
          valueType: "boolean",
        })
      );

      await m.register("kvX", { info: kvXInfo, valueType: "boolean" });

      // 不应该允许重复注册
      await assertRejects(async () =>
        await m.register("foo", { info: kvXInfo, valueType: "boolean" })
      );
      await assertRejects(async () =>
        await m.register(["kvX"], { info: kvXInfo, valueType: "boolean" })
      );
      await assertRejects(async () =>
        await m.registerCollection(["kvX"], { info: kvXInfo })
      );
      // 值节点应该是叶节点
      await assertRejects(async () =>
        await m.register(["kvX", "x"], { info: kvXInfo, valueType: "boolean" })
      );
      await assertRejects(async () =>
        await m.registerCollection(["kvX", "x"], { info: kvXInfo })
      );

      // 注册但为设置值，且未设置默认值，则返回 null
      assertEquals(await m.get({}, ["kvX"]), null);
      // 测试能否正确存取值
      await m.set({}, ["kvX"], true);
      assertEquals(await m.get({}, ["kvX"]), true);

      // 测试能否正确存取各种值
      const nodes: {
        name: string;
        info: { readableName: string; description: string };
        valueType: AllowedValueType;
        values: (string | boolean | number)[];
      }[] = [];
      for (
        const [vt, vs] of [
          ["string", ["str"]],
          ["boolean", [true, false]],
          ["number", [42, 0]],
        ] as const
      ) {
        nodes.push({
          name: `kv-${vt}`,
          info: { readableName: `键值-${vt}`, description: "blah blah" },
          valueType: vt,
          values: [...vs],
        });
      }
      for (const base of [[], ["foo"]]) {
        for (const node of nodes) {
          const values = node.values;
          const path = [...base, node.name];
          await m.register(path, {
            info: node.info,
            valueType: node.valueType,
          });
          assertEquals(await m.get({}, path), null);
          for (const value of values) {
            await m.set({}, path, value);
            assertEquals(await m.get({}, path), value);
          }
        }
      }
      for (const base of [[], ["foo"]]) {
        for (const node of nodes) {
          const values = node.values;
          const path = [...base, node.name];
          assertEquals(await m.get({}, path), values[values.length - 1]);
          await m.set({}, path, null);
          assertEquals(await m.get({}, path), null);
        }
      }
    });
    await t.step("converter", async (t) => {
      const path = "bool then num then str";
      const info = { readableName: "布尔然后字符串然后数字", description: "如名" };

      await m.register(path, { info, valueType: "boolean" });
      await m.set({}, path, true);

      await m.register(path, { info, valueType: "string", force: true });
      await assertRejects(async () => await m.get({}, path));
      // 如果不读原先的值，不提供 converter 也成
      await m.set({}, path, "42");

      const converter = (o: any) => Number(o);
      await m.register(path, {
        info,
        valueType: "number",
        converter,
        force: true,
      });
      assertEquals(await m.get({}, path), 42);
    });
    await t.step("scope", async (t) => {
      const path = "for scope";
      const info = { readableName: "为了司寇坡！", description: "又看不到…" };
      await m.register(path, { info, valueType: "number" });

      assertEquals(await m.get({ group: 1 }, path, true), null);

      await m.set({ group: 1 }, path, 123);
      assertEquals(await m.get({ group: 1 }, path, true), 123);
      assertEquals(await m.get({}, path), null);

      await m.set({}, path, 456);
      assertEquals(await m.get({ group: 1 }, path, true), 123);
      assertEquals(await m.get({}, path), 456);
      assertEquals(await m.get({ group: 2 }, path, true), 456);

      await m.set({ group: 2 }, path, 789);
      assertEquals(await m.get({ group: 1 }, path, true), 123);
      assertEquals(await m.get({}, path), 456);
      assertEquals(await m.get({ group: 2 }, path, true), 789);

      await m.set({ group: 1 }, path, null);
      assertEquals(await m.get({ group: 1 }, path, true), 456);
    });
    await t.step("default", async (t) => {
      const path = "for default";
      const info = { readableName: "为了地否特！", description: "又看不到…" };
      await m.register(path, { info, valueType: "number", default: 42 });

      assertEquals(await m.get({}, path), 42);
      assertEquals(await m.get({ group: 1 }, path, true), 42);

      await m.set({ group: 1 }, path, 123);
      assertEquals(await m.get({ group: 1 }, path, true), 123);

      await m.set({}, path, 456);
      assertEquals(await m.get({ group: 1 }, path, true), 123);
      assertEquals(await m.get({ group: 2 }, path, true), 456);

      await m.set({}, path, null);
      assertEquals(await m.get({ group: 1 }, path, true), 123);
      assertEquals(await m.get({ group: 2 }, path, true), 42);

      await m.set({ group: 1 }, path, null);
      assertEquals(await m.get({ group: 1 }, path, true), 42);
    });
  });
});
