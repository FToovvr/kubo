import { AllowedValueType, SettingsManager } from "./settings_manager.ts";

import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.134.0/testing/asserts.ts";

import { DB } from "https://deno.land/x/sqlite@v3.3.0/mod.ts";

import { Store, StoreWrapper } from "./storage.ts";

async function withManager(
  cb: (manager: SettingsManager) => Promise<void> | void,
) {
  const db = new DB();
  const store = new Store(db);
  const wrapper = new StoreWrapper(store, "settings");
  const manager = new SettingsManager(wrapper);

  await cb(manager);

  store.close();
  db.close();
}

Deno.test("kubo/settings_manager", async (t) => {
  await withManager(async (m) => {
    await t.step("访问没有注册的配置节点", () => {
      // 若访问未注册的节点，set/get 将直接抛出异常
      assertThrows(() => {
        m.set({}, "foo", "bar");
      });
      assertThrows(() => {
        m.get({}, "foo");
      });

      // 若访问未注册的节点，trySet/tryGet 将返回 undefined
      assertEquals(m.trySet({}, "foo", "bar"), undefined);
      assertEquals(m.tryGet({}, "foo"), undefined);

      // 若访问未注册的节点，tryGetRegisteredNode 将返回空 Object
      assertEquals(m.tryGetRegisteredNode(["foo", "bar", "baz"]), {});
    });
    await t.step("集合节点", () => {
      const fooInfo = {
        readableName: "呒呜呜",
        description: "This is a random description",
      };
      const barInfo = {
        readableName: "吧啊儿",
        description: "This is another random description",
      };

      // 不应该允许路径中空的注册
      assertThrows(() => {
        m.registerCollection(["nothingness", "foo"], { info: fooInfo });
      });
      // 首次注册
      m.registerCollection("foo", { info: fooInfo });
      assertEquals(m.tryGetRegisteredNode("foo").collectionNode!, {
        type: "collection",
        name: "foo",
        ...fooInfo,
      });

      // 不应该允许重复注册
      assertThrows(() => m.registerCollection(["foo"], { info: barInfo }));
      // 允许嵌套注册
      m.registerCollection(["foo", "bar"], { info: barInfo });
      assertEquals(m.tryGetRegisteredNode(["foo", "bar"]).collectionNode!, {
        type: "collection",
        name: "bar",
        ...barInfo,
      });
    });
    await t.step("值节点", () => {
      const kvXInfo = { readableName: "键值X", description: "blah blah" };

      // 不应该允许路径中空的注册
      assertThrows(() =>
        m.register(["foo", "_", "kvX"], { info: kvXInfo, valueType: "boolean" })
      );

      m.register("kvX", { info: kvXInfo, valueType: "boolean" });

      // 不应该允许重复注册
      assertThrows(() =>
        m.register("foo", { info: kvXInfo, valueType: "boolean" })
      );
      assertThrows(() =>
        m.register(["kvX"], { info: kvXInfo, valueType: "boolean" })
      );
      assertThrows(() => m.registerCollection(["kvX"], { info: kvXInfo }));
      // 值节点应该是叶节点
      assertThrows(() =>
        m.register(["kvX", "x"], { info: kvXInfo, valueType: "boolean" })
      );
      assertThrows(() => m.registerCollection(["kvX", "x"], { info: kvXInfo }));

      // 注册但为设置值，且未设置默认值，则返回 null
      assertEquals(m.get({}, ["kvX"]), null);
      // 测试能否正确存取值
      m.set({}, ["kvX"], true);
      assertEquals(m.get({}, ["kvX"]), true);

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
          m.register(path, {
            info: node.info,
            valueType: node.valueType,
          });
          assertEquals(m.get({}, path), null);
          for (const value of values) {
            m.set({}, path, value);
            assertEquals(m.get({}, path), value);
          }
        }
      }
      for (const base of [[], ["foo"]]) {
        for (const node of nodes) {
          const values = node.values;
          const path = [...base, node.name];
          assertEquals(m.get({}, path), values[values.length - 1]);
          m.set({}, path, null);
          assertEquals(m.get({}, path), null);
        }
      }
    });
    await t.step("converter", () => {
      const path = "bool then num then str";
      const info = { readableName: "布尔然后字符串然后数字", description: "如名" };

      m.register(path, { info, valueType: "boolean" });
      m.set({}, path, true);

      m.register(path, { info, valueType: "string", force: true });
      assertThrows(() => m.get({}, path));
      // 如果不读原先的值，不提供 converter 也成
      m.set({}, path, "42");

      const converter = (o: any) => Number(o);
      m.register(path, { info, valueType: "number", converter, force: true });
      assertEquals(m.get({}, path), 42);
    });
    await t.step("scope", () => {
      const path = "for scope";
      const info = { readableName: "为了司寇坡！", description: "又看不到…" };
      m.register(path, { info, valueType: "number" });

      assertEquals(m.get({ group: 1 }, path), null);

      m.set({ group: 1 }, path, 123);
      assertEquals(m.get({ group: 1 }, path), 123);
      assertEquals(m.get({}, path), null);

      m.set({}, path, 456);
      assertEquals(m.get({ group: 1 }, path), 123);
      assertEquals(m.get({}, path), 456);
      assertEquals(m.get({ group: 2 }, path), 456);

      m.set({ group: 2 }, path, 789);
      assertEquals(m.get({ group: 1 }, path), 123);
      assertEquals(m.get({}, path), 456);
      assertEquals(m.get({ group: 2 }, path), 789);

      m.set({ group: 1 }, path, null);
      assertEquals(m.get({ group: 1 }, path), 456);
    });
    await t.step("default", () => {
      const path = "for default";
      const info = { readableName: "为了地否特！", description: "又看不到…" };
      m.register(path, { info, valueType: "number", default: 42 });

      assertEquals(m.get({}, path), 42);
      assertEquals(m.get({ group: 1 }, path), 42);

      m.set({ group: 1 }, path, 123);
      assertEquals(m.get({ group: 1 }, path), 123);

      m.set({}, path, 456);
      assertEquals(m.get({ group: 1 }, path), 123);
      assertEquals(m.get({ group: 2 }, path), 456);

      m.set({}, path, null);
      assertEquals(m.get({ group: 1 }, path), 123);
      assertEquals(m.get({ group: 2 }, path), 42);

      m.set({ group: 1 }, path, null);
      assertEquals(m.get({ group: 1 }, path), 42);
    });
  });
});
