import { DB } from "https://deno.land/x/sqlite@v3.3.0/mod.ts";
import { getCurrentUTCTimestamp } from "../utils/misc.ts";

import { KuboPlugin } from "./bot.ts";

type Value = number | string | null;

export class Store {
  db: DB;
  private intervalId: number;

  constructor(db: DB) {
    this.db = db;

    db.query(`
      CREATE TABLE IF NOT EXISTS store (
        "namespace" TEXT NOT NULL,
        -- group 与 qq 其一为 0 代表只涉及另一者对应的 QQ 或群，两者皆为 0 代表适用全局
        "group" NUMBER NOT NULL DEFAULT 0,
        "qq" NUMBER NOT NULL DEFAULT 0,

        "key" TEXT NOT NULL,
        "value" NULL,

        "expire_timestamp" NUMBER NULL DEFAULT NULL,

        PRIMARY KEY ("namespace", "group", "qq", "key")
      );

      CREATE INDEX IF NOT EXISTS idx__store__namespace_qq_group_key ON store("namespace", "group", "qq", "key");
      CREATE INDEX IF NOT EXISTS idx__store__qq ON store("qq");
      CREATE INDEX IF NOT EXISTS idx__store__group ON store("group");
    `);

    this.cleanExpired();

    // 20 分钟清理一次
    this.intervalId = setInterval(this.cleanExpired, 1000 * 60 * 20);
  }

  close() {
    clearInterval(this.intervalId);
  }

  cleanExpired() {
    const now = getCurrentUTCTimestamp();
    this.db.query(`DELETE FROM store WHERE expire_timestamp < ?`, [now]);
  }

  get(ctx: { namespace: string; group?: number; qq?: number }, key: string) {
    if ((ctx.group ?? 1) <= 0 || (ctx.qq ?? 1) <= 0) {
      throw new Error(`不正确的 QQ 或群号：${ctx}`);
    }
    const row = this.db.query(
      `
      SELECT "value", "expire_timestamp" FROM store
      WHERE "namespace" = ? AND "group" = ? AND "qq" = ? AND "key" = ?
    `,
      [ctx.namespace, ctx.group ?? 0, ctx.qq ?? 0, key],
    );
    if (row.length === 0) {
      return null;
    }
    const [value, expire_timestamp] = row[0] as [Value, number];
    const now = getCurrentUTCTimestamp();
    if (expire_timestamp && now > expire_timestamp) { // 清理的事情交给别处
      return null;
    }
    return value;
  }

  set(
    ctx: { namespace: string; group?: number; qq?: number },
    key: string,
    val: Value,
    args: { expireTimestamp?: number } = {},
  ) {
    if ((ctx.group ?? 1) <= 0 || (ctx.qq ?? 1) <= 0) {
      throw new Error(`不正确的 QQ 或群号：${ctx}`);
    }

    if (val === null) {
      this.db.query(
        `
        DELETE FROM store
        WHERE "namespace" = ? AND "group" = ? AND "qq" = ? AND "key" = ?
      `,
        [ctx.namespace, ctx.group ?? 0, ctx.qq ?? 0, key],
      );
      return;
    }

    this.db.query(
      `
      INSERT OR REPLACE INTO store ("namespace", "group", "qq", "key", "value", "expire_timestamp")
        values (?, ?, ?, ?, ?, ?)
    `,
      [
        ctx.namespace,
        ctx.group ?? 0,
        ctx.qq ?? 0,
        key,
        val,
        args.expireTimestamp ?? null,
      ],
    );
  }
}

export class StoreWrapper {
  store: Store;
  private _namespace: string;
  public get namespace(): string {
    return this._namespace;
  }

  constructor(store: Store, namespace: string) {
    this.store = store;
    this._namespace = namespace;
  }

  get(ctx: { group?: number; qq?: number }, key: string) {
    return this.store.get({ namespace: this.namespace, ...ctx }, key);
  }

  set(
    ctx: { group?: number; qq?: number },
    key: string,
    val: Value,
    args: { expireTimestamp?: number } = {},
  ) {
    return this.store.set(
      { namespace: this.namespace, ...ctx },
      key,
      val,
      args,
    );
  }
}

export class PluginStoreWrapper extends StoreWrapper {
  pluginId: string;

  constructor(store: Store, plugin: KuboPlugin) {
    super(store, "never");
    this.pluginId = plugin.id;
  }

  override get namespace() {
    return `p.${this.pluginId}`;
  }
}
