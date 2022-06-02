import { DB } from "https://deno.land/x/sqlite@v3.3.0/mod.ts";
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
  db: DB;
  private intervalId: number;

  constructor(db: DB, client: KuboBot["_client"]) {
    this.client = client;
    this.db = db;

    const queries = [
      `
      CREATE TABLE IF NOT EXISTS history_message (
        "message_id" NUMBER NOT NULL,

        "time" NUMBER NOT NULL,
        "sub_type" TEXT NOT NULL,
        "user_id" NUMBER NOT NULL,
        "raw" TEXT NOT NULL,

        "expire_timestamp" NUMBER NULL,

        PRIMARY KEY ("message_id")
      );`,
      `CREATE INDEX IF NOT EXISTS idx__history_message__time ON history_message("time");`,
      `CREATE INDEX IF NOT EXISTS idx__history_message__expire_timestamp ON history_message("expire_timestamp");`,
      `
      CREATE TABLE IF NOT EXISTS history_request (
        "time" NUMBER NOT NULL,
        "request_type" TEXT NOT NULL,
        "raw" TEXT NOT NULL
      );`,
      `CREATE INDEX IF NOT EXISTS idx__history_request__time ON history_request("time");`,
      `CREATE TABLE IF NOT EXISTS history_notice (
        "time" NUMBER NOT NULL,
        "notice_type" TEXT NOT NULL,
        "raw" TEXT NOT NULL
      );`,
      `CREATE INDEX IF NOT EXISTS idx__history_notice__time ON history_notice("time");`,
      `CREATE TABLE IF NOT EXISTS history_unknown (
        "time" NUMBER NOT NULL,
        "post_type" TEXT NOT NULL,
        "raw" TEXT NOT NULL
      );`,
      `CREATE INDEX IF NOT EXISTS idx__history_unknown__time ON history_unknown("time");`,
    ];

    for (const query of queries) {
      db.query(query);
    }

    this.cleanExpired();

    // 每分钟清理一次
    this.intervalId = setInterval(this.cleanExpired.bind(this), 1000 * 60);

    this.client.eventClient.callbacks.onAllRaw.push((ev) =>
      this.recordEvent(ev)
    );
    this.client.apiClient.hooks.afterSentMessage.push((resp) => {
      if (resp.status !== "ok") return;
      this.recordSent(resp);
    });
  }

  close() {
    clearInterval(this.intervalId);
  }

  cleanExpired() {
    const now = utils.now();
    this.db.query(`DELETE FROM history_message WHERE expire_timestamp < ?`, [
      now,
    ]);
  }

  recordEvent(_ev: RawEvent) {
    if (_ev.post_type === "meta_event") return;
    if (_ev.post_type === "message") {
      const ev = _ev as MessageRawEvent;
      this.db.query(
        `
        INSERT INTO history_message ("message_id", "time", "sub_type", "user_id", "raw", "expire_timestamp")
          VALUES (?, ?, ?, ?, ?, ?)
      `,
        [
          ev.message_id,
          ev.time,
          (() => {
            const subType = (ev as any).sub_type;
            return typeof subType === "string" ? subType : null;
          })(),
          ev.user_id,
          JSON.stringify(ev),
          utils.now() + 60 * 60, // 一个小时
        ],
      );
    } else if (_ev.post_type === "request") {
      const ev = _ev as RequestRawEvent;
      this.db.query(
        `
        INSERT INTO history_request ("time", "request_type", "raw")
          VALUES (?, ?, ?)
      `,
        [ev.time, ev.request_type, JSON.stringify(ev)],
      );
    } else if (_ev.post_type === "notice") {
      const ev = _ev as NoticeRawEvent;
      this.db.query(
        `
        INSERT INTO history_notice ("time", "notice_type", "raw")
          VALUES (?, ?, ?)
      `,
        [ev.time, ev.notice_type, JSON.stringify(ev)],
      );
    } else {
      const ev = _ev as RawEvent;
      this.db.query(
        `
        INSERT INTO history_unknown ("time", "post_type", "raw")
          VALUES (?, ?, ?)
      `,
        [ev.time, ev.post_type, JSON.stringify(ev)],
      );
    }
  }

  async recordSent(resp: SendMessageResponse) {
    if (resp.status !== "ok") throw new Error("never");

    const msgWrapped = await this.client.apiClient.getMessage(
      resp.data!.message_id,
    );
    const msg = msgWrapped.data;

    this.db.query(
      `
      INSERT INTO history_message ("message_id", "time", "sub_type", "user_id", "raw", "expire_timestamp")
        VALUES (?, ?, ?, ?, ?, ?)
    `,
      [
        msg.message_id,
        msg.time,
        "__kubo_sent_out",
        msg.sender.user_id,
        JSON.stringify(msg),
        null, // 自己发的消息不设过期
      ],
    );
  }

  getMessageEventRaw(messageId: number) {
    const rows = this.db.query(
      `SELECT "raw" FROM history_message WHERE message_id = ?`,
      [messageId],
    );
    if (rows.length === 0) return null;
    return JSON.parse(rows[0][0] as string);
  }
}
