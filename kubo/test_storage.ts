import { DB } from "https://deno.land/x/sqlite@v3.3.0/mod.ts";
import utils from "./utils.ts";

import { KuboPlugin } from "./bot.ts";
import { IStore } from "./storage.ts";

type Value = number | string | null;

export class TestStore implements IStore {
  private db: DB;
  private intervalId!: number;

  constructor() {
    this.db = new DB(":memory:");
  }

  async init() {
    const queries = [
      `
      CREATE TABLE IF NOT EXISTS store (
        "namespace" TEXT NOT NULL,
        -- group 与 qq 其一为 0 代表只涉及另一者对应的 QQ 或群，两者皆为 0 代表适用全局
        "group" NUMBER NOT NULL DEFAULT 0,
        "qq" NUMBER NOT NULL DEFAULT 0,

        "key" TEXT NOT NULL,
        "value" TEXT NULL,

        "expire_timestamp" NUMBER NULL DEFAULT NULL,

        PRIMARY KEY ("namespace", "group", "qq", "key")
      );`,
      `CREATE INDEX IF NOT EXISTS idx__store__namespace_qq_group_key ON store("namespace", "group", "qq", "key");`,
      `CREATE INDEX IF NOT EXISTS idx__store__qq ON store("qq");`,
      `CREATE INDEX IF NOT EXISTS idx__store__group ON store("group");`,
      `CREATE INDEX IF NOT EXISTS idx__store__expire_timestamp ON store("expire_timestamp");`,
    ];

    for (const query of queries) {
      this.db.query(query);
    }

    this.cleanExpired();

    // 20 分钟清理一次
    this.intervalId = setInterval(this.cleanExpired.bind(this), 1000 * 60 * 20);
  }

  close() {
    clearInterval(this.intervalId);
    this.db.close();
  }

  cleanExpired() {
    const now = utils.now();
    this.db.query(`DELETE FROM store WHERE expire_timestamp < ?`, [now]);
  }

  async get(
    ctx: { namespace: string; group?: number; qq?: number },
    key: string,
  ) {
    if ((ctx.group ?? 1) <= 0 || (ctx.qq ?? 1) <= 0) {
      throw new Error(`不正确的 QQ 或群号：${ctx}`);
    }
    const rows = this.db.query(
      `
      SELECT "value", "expire_timestamp" FROM store
      WHERE "namespace" = ? AND "group" = ? AND "qq" = ? AND "key" = ?
    `,
      [ctx.namespace, ctx.group ?? 0, ctx.qq ?? 0, key],
    );
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
      this.db.query(
        `
        DELETE FROM store
        WHERE "namespace" = ? AND "group" = ? AND "qq" = ? AND "key" = ?
      `,
        [ctx.namespace, ctx.group ?? 0, ctx.qq ?? 0, key],
      );
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
        expireTimestamp,
      ],
    );
  }
}
