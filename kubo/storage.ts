import { Client as PgClient } from "https://deno.land/x/postgres@v0.16.0/mod.ts";

import utils from "./utils.ts";

import { AffectScope, KuboPlugin } from "./types.ts";

type Value = number | string | null;

export interface StoreSetArguments {
  expireTimestamp?: number;
  expireInterval?: number;
}

export interface IStore {
  get: (
    ctx: { namespace: string; group?: number; qq?: number },
    key: string,
  ) => Promise<string | null>;
  set: (
    ctx: { namespace: string; group?: number; qq?: number },
    key: string,
    val: Value,
    args: StoreSetArguments,
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
      INSERT INTO store ("namespace", "group", "qq", "key", "value", "expire_timestamp")
        values (
          ${ctx.namespace},
          ${ctx.group ?? 0},
          ${ctx.qq ?? 0},
          ${key},
          ${val},
          ${expireTimestamp})
      ON CONFLICT ("namespace", "group", "qq", "key") DO UPDATE SET
        "value" = ${val}, "expire_timestamp" = ${expireTimestamp}
      `;
  }
}

export class StoreWrapper {
  store: IStore;
  private _namespace: string;
  public get namespace(): string {
    return this._namespace;
  }

  private usesCache: boolean;
  private writesBackImmediately?: boolean;
  private cache: {
    [group: number]: {
      [qq: number]: {
        [key: string]: {
          value: Value;
          hasChanged: boolean;
          args?: StoreSetArguments;
        };
      };
    };
  } = {};

  constructor(
    store: IStore,
    namespace: string,
    args:
      | {}
      | { usesCache: false }
      | { usesCache: true; writesBackImmediately: boolean } = {},
  ) {
    this.store = store;
    this._namespace = namespace;
    if ("usesCache" in args) {
      this.usesCache = args.usesCache;
      if (args.usesCache) {
        this.writesBackImmediately = args.writesBackImmediately;
      }
    } else {
      this.usesCache = false;
    }
  }

  // 记得调用
  async close() {
    await this.writeBack();
  }

  async get(ctx: AffectScope, key: string): Promise<Value>;
  async get(ctx: { group?: number; qq?: number }, key: string): Promise<Value>;
  async get(
    ctx: { scope?: string; group?: number; qq?: number },
    key: string,
  ): Promise<Value> {
    if (this.usesCache) {
      let cache = this.getCacheOfScope(ctx.group ?? null, ctx.qq ?? null);
      const valueWrapper = cache[key];
      if (valueWrapper !== undefined) return valueWrapper.value;
    }

    const value = await this.store.get(
      { namespace: this.namespace, ...ctx },
      key,
    );

    if (this.usesCache) {
      let cache = this.getCacheOfScope(ctx.group ?? null, ctx.qq ?? null);
      let oldValue = cache[key]?.value;
      if (oldValue !== undefined) {
        if (oldValue !== value) throw new Error("never");
      } else {
        cache[key] = { value, hasChanged: false };
      }
    }

    return value;
  }

  async set(
    ctx: AffectScope,
    key: string,
    val: Value,
    args?: StoreSetArguments,
  ): Promise<void>;
  async set(
    ctx: { group?: number; qq?: number },
    key: string,
    val: Value,
    args?: StoreSetArguments,
  ): Promise<void>;
  async set(
    ctx: { scope?: string; group?: number; qq?: number },
    key: string,
    val: Value,
    args?: StoreSetArguments,
  ): Promise<void> {
    args = {};

    if (this.usesCache) {
      const cache = this.getCacheOfScope(ctx.group ?? null, ctx.qq ?? null);
      cache[key] = { value: val, hasChanged: true, args };
      if (!this.writesBackImmediately!) return;
    }

    await this.store.set(
      { namespace: this.namespace, ...ctx },
      key,
      val,
      args,
    );
  }

  async writeBack() {
    for (const [group, groupCache] of Object.entries(this.cache)) {
      for (const [qq, qqCache] of Object.entries(groupCache)) {
        for (const [key, valueRecord] of Object.entries(qqCache)) {
          const { value, hasChanged, args } = valueRecord;
          if (!hasChanged) continue;
          await this.store.set(
            {
              namespace: this.namespace,
              ...(group !== "0" ? { group: Number(group) } : {}),
              ...(qq !== "0" ? { qq: Number(qq) } : {}),
            },
            key,
            value,
            args!,
          );
          valueRecord.hasChanged = false;
        }
      }
    }
  }

  getCacheOfScope(group: number | null, qq: number | null) {
    let groupCache = this.cache[group ?? 0];
    if (!groupCache) {
      groupCache = {};
      this.cache[group ?? 0] = groupCache;
    }
    let qqCache = groupCache[qq ?? 0];
    if (!qqCache) {
      qqCache = {};
      groupCache[qq ?? 0] = qqCache;
    }
    return qqCache;
  }
}

export class PluginStoreWrapper extends StoreWrapper {
  pluginId: string;

  constructor(
    store: Store,
    plugin: KuboPlugin,
    args: ConstructorParameters<typeof StoreWrapper>[2] = {},
  ) {
    super(store, "never", args);
    this.pluginId = plugin.id;
  }

  override get namespace() {
    return `p.${this.pluginId}`;
  }
}
