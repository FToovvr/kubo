import { Client as PgClient } from "https://deno.land/x/postgres@v0.16.0/mod.ts";

import { SendMessageResponse } from "../../../go_cqhttp_client/api_response.ts";
import {
  MessageRawEvent,
  NoticeRawEvent,
  RawEvent,
  RequestRawEvent,
} from "../../../go_cqhttp_client/events.ts";
import { KuboBot } from "../../bot.ts";
import utils from "../../utils.ts";

export class MessageManager {
  client: KuboBot["_client"];
  db: PgClient;
  private intervalId!: number;

  constructor(db: PgClient, client: KuboBot["_client"]) {
    this.client = client;
    this.db = db;
  }

  async init() {
    const queries = [
      `
      CREATE TABLE IF NOT EXISTS history_message (
        "message_id" INTEGER NOT NULL, -- int32
    
        "time" BIGINT NOT NULL,  -- int64
        "sub_type" TEXT NOT NULL,
        "user_id" BIGINT NOT NULL, -- int64
        "raw" TEXT NOT NULL,
    
        "expire_timestamp" BIGINT NULL,
    
        PRIMARY KEY ("message_id")
      );`,
      `CREATE INDEX IF NOT EXISTS idx__history_message__time ON history_message("time");`,
      `CREATE INDEX IF NOT EXISTS idx__history_message__expire_timestamp ON history_message("expire_timestamp");`,
      `
      CREATE TABLE IF NOT EXISTS history_request (
        "time" BIGINT NOT NULL,
        "request_type" TEXT NOT NULL,
        "raw" TEXT NOT NULL
      );`,
      `CREATE INDEX IF NOT EXISTS idx__history_request__time ON history_request("time");`,
      `CREATE TABLE IF NOT EXISTS history_notice (
        "time" BIGINT NOT NULL,
        "notice_type" TEXT NOT NULL,
        "raw" TEXT NOT NULL
      );`,
      `CREATE INDEX IF NOT EXISTS idx__history_notice__time ON history_notice("time");`,
      `CREATE TABLE IF NOT EXISTS history_unknown (
        "time" BIGINT NOT NULL,
        "post_type" TEXT NOT NULL,
        "raw" TEXT NOT NULL
      );`,
      `CREATE INDEX IF NOT EXISTS idx__history_unknown__time ON history_unknown("time");`,
    ];

    for (const query of queries) {
      await this.db.queryArray(query);
    }

    await this.cleanExpired();

    // 每分钟清理一次
    this.intervalId = setInterval(this.cleanExpired.bind(this), 1000 * 60);

    this.client.eventClient.callbacks.onAllRaw.push(async (ev) =>
      await this.recordEvent(ev)
    );
    this.client.apiClient.hooks.afterSentMessage.push(async (resp) => {
      if (resp.status !== "ok") return;
      await this.recordSent(resp);
    });
  }

  close() {
    clearInterval(this.intervalId);
  }

  async cleanExpired() {
    const now = utils.now();
    await this.db.queryArray
      `DELETE FROM history_message WHERE expire_timestamp < ${now}`;
  }

  async recordEvent(_ev: RawEvent) {
    if (_ev.post_type === "meta_event") return;
    if (_ev.post_type === "message") {
      const ev = _ev as MessageRawEvent;
      const subType = (() => {
        const subType = (ev as any).sub_type;
        return typeof subType === "string" ? subType : null;
      })();

      await this.db.queryArray`
        INSERT INTO history_message ("message_id", "time", "sub_type", "user_id", "raw", "expire_timestamp")
          VALUES (
            ${ev.message_id},
            ${ev.time},
            ${subType},
            ${ev.user_id},
            ${JSON.stringify(ev)},
            ${utils.now() + 60 * 60 /* 一个小时 */}
          )`;
    } else if (_ev.post_type === "request") {
      const ev = _ev as RequestRawEvent;
      await this.db.queryArray`
        INSERT INTO history_request ("time", "request_type", "raw")
          VALUES (${ev.time}, ${ev.request_type}, ${JSON.stringify(ev)})
      `;
    } else if (_ev.post_type === "notice") {
      const ev = _ev as NoticeRawEvent;
      await this.db.queryArray`
        INSERT INTO history_request ("time", "request_type", "raw")
          VALUES (${ev.time}, ${ev.notice_type}, ${JSON.stringify(ev)})
      `;
    } else {
      const ev = _ev as RawEvent;
      await this.db.queryArray`
        INSERT INTO history_request ("time", "request_type", "raw")
          VALUES (${ev.time}, ${ev.post_type}, ${JSON.stringify(ev)})
      `;
    }
  }

  async recordSent(resp: SendMessageResponse) {
    if (resp.status !== "ok") throw new Error("never");

    const msgWrapped = await this.client.apiClient.getMessage(
      resp.data!.message_id,
    );
    const msg = msgWrapped.data;

    await this.db.queryArray`
      INSERT INTO history_message ("message_id", "time", "sub_type", "user_id", "raw", "expire_timestamp")
        VALUES (
          ${msg.message_id},
          ${msg.time},
          ${"__kubo_sent_out"},
          ${msg.sender.user_id},
          ${JSON.stringify(msg)},
          ${null /* 自己发的消息不设过期 */}
        )`;
  }

  async getMessageEventRaw(messageId: number) {
    const result = await this.db.queryArray
      `SELECT "raw" FROM history_message WHERE message_id = ${messageId}`;
    const rows = result.rows;
    if (rows.length === 0) return null;
    return JSON.parse(rows[0][0] as string);
  }
}
