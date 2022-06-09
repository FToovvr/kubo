import { Client as PgClient } from "https://deno.land/x/postgres@v0.16.0/mod.ts";

import utils from "./utils.ts";

import { KuboPlugin } from "./types.ts";

type Value = number | string | null;

export interface IStore {
  get: (
    ctx: { namespace: string; group?: number; qq?: number },
    key: string,
  ) => Promise<string | null>;
  set: (
    ctx: { namespace: string; group?: number; qq?: number },
    key: string,
    val: Value,
    args: { expireTimestamp?: number; expireInterval?: number },
  ) => Promise<void>;
}

export class Store implements IStore {
  private db: PgClient;
  private intervalId!: number;

  constructor(db: PgClient) {
    this.db = db;
  }

  async init() {
    const queries = [
      `
      CREATE TABLE IF NOT EXISTS store (
        "namespace" TEXT NOT NULL,
        -- group 与 qq 其一为 0 代表只涉及另一者对应的 QQ 或群，两者皆为 0 代表适用全局
        "group" BIGINT NOT NULL DEFAULT 0, -- int64
        "qq" BIGINT NOT NULL DEFAULT 0, -- int64

        "key" TEXT NOT NULL,
        "value" TEXT NULL,

        "expire_timestamp" BIGINT NULL DEFAULT NULL,

        PRIMARY KEY ("namespace", "group", "qq", "key")
      );`,
      `CREATE INDEX IF NOT EXISTS idx__store__namespace_qq_group_key ON store("namespace", "group", "qq", "key");`,
      `CREATE INDEX IF NOT EXISTS idx__store__qq ON store("qq");`,
      `CREATE INDEX IF NOT EXISTS idx__store__group ON store("group");`,
      `CREATE INDEX IF NOT EXISTS idx__store__expire_timestamp ON store("expire_timestamp");`,
    ];

    for (const query of queries) {
      await this.db.queryArray(query);
    }

    await this.cleanExpired();

    // 20 分钟清理一次
    this.intervalId = setInterval(this.cleanExpired.bind(this), 1000 * 60 * 20);
  }

  close() {
    clearInterval(this.intervalId);
  }

  async cleanExpired() {
    const now = utils.now();
    await this.db.queryArray`DELETE FROM store WHERE expire_timestamp < ${now}`;
  }

  async get(
    ctx: { namespace: string; group?: number; qq?: number },
    key: string,
  ) {
    if ((ctx.group ?? 1) <= 0 || (ctx.qq ?? 1) <= 0) {
      throw new Error(`不正确的 QQ 或群号：${ctx}`);
    }
    const result = await this.db.queryArray`
      SELECT "value", "expire_timestamp" FROM store
      WHERE "namespace" = ${ctx.namespace}
        AND "group" = ${ctx.group ?? 0}
        AND "qq" = ${ctx.qq ?? 0}
        AND "key" = ${key}
    `;
    const rows = result.rows;
    if (rows.length === 0) {
      return null;
    }
    const [value, expire_timestamp] = rows[0] as [Value, number];
    const now = utils.now();
    if (expire_timestamp && now > expire_timestamp) { // 清理的事情交给别处
      return null;
    }
    return value as string;
  }

  async set(
    ctx: { namespace: string; group?: number; qq?: number },
    key: string,
    val: Value,
    args: {
      expireTimestamp?: number;
      expireInterval?: number; // TODO: testing
    } = {},
  ) {
    if ((ctx.group ?? 1) <= 0 || (ctx.qq ?? 1) <= 0) {
      throw new Error(`不正确的 QQ 或群号：${ctx}`);
    }

    if (val === null) {
      await this.db.queryArray`
        DELETE FROM store
        WHERE "namespace" = ${ctx.namespace}
          AND "group" = ${ctx.group ?? 0}
          AND "qq" = ${ctx.qq ?? 0}
          AND "key" = ${key}
      `;
      return;
    }

    const expireTimestamp = (() => {
      const tsExplicit = args.expireTimestamp ?? null;
      const tsByInterval = args.expireInterval
        ? (utils.now() + args.expireInterval)
        : null;
      if (tsExplicit !== null && tsByInterval !== null) {
        return Math.max(tsExplicit, tsByInterval);
      }
      return tsExplicit ?? tsByInterval;
    })();

    await this.db.queryArray`
      INSERT OR REPLACE INTO store ("namespace", "group", "qq", "key", "value", "expire_timestamp")
        values (
          ${ctx.namespace},
          ${ctx.group ?? 0},
          ${ctx.qq ?? 0},
          ${key},
          ${val},
          ${expireTimestamp})
      `;
  }
}

export class StoreWrapper {
  store: IStore;
  private _namespace: string;
  public get namespace(): string {
    return this._namespace;
  }

  constructor(store: IStore, namespace: string) {
    this.store = store;
    this._namespace = namespace;
  }

  async get(ctx: { group?: number; qq?: number }, key: string) {
    return await this.store.get({ namespace: this.namespace, ...ctx }, key);
  }

  async set(
    ctx: { group?: number; qq?: number },
    key: string,
    val: Value,
    args: { expireTimestamp?: number } = {},
  ) {
    return await this.store.set(
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
