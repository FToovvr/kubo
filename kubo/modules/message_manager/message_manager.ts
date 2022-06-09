import { Client as PgClient } from "https://deno.land/x/postgres@v0.16.0/mod.ts";

import { SendMessageResponse } from "../../../go_cqhttp_client/api_response.ts";
import {
  MessageRawEvent,
  NoticeRawEvent,
  RawEvent,
  RequestRawEvent,
} from "../../../go_cqhttp_client/events.ts";
import { Reply, ReplyAt } from "../../../go_cqhttp_client/message_piece.ts";
import { KuboBot } from "../../index.ts";
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
    
        "message_type" TEXT NULL,
        "place_id" BIGINT NULL, -- 私聊则是 QQ 号，群聊则是群号
        "message_seq" BIGINT NULL,
    
        "time" BIGINT NOT NULL,  -- int64
        "sub_type" TEXT NOT NULL,
        "user_id" BIGINT NOT NULL, -- int64
        "raw" TEXT NOT NULL,
    
        "expire_timestamp" BIGINT NULL
    
        -- PRIMARY KEY ("message_id") -- 出现过 recordSent 重复的情况，慎重起见暂时去掉
      );`,
      `CREATE INDEX IF NOT EXISTS idx__history_message__message_id ON history_message("message_id"); -- 暂时先把 index 加在这里`,
      `CREATE INDEX IF NOT EXISTS idx__history_message__time ON history_message("time");`,
      `CREATE INDEX IF NOT EXISTS idx__history_message__expire_timestamp ON history_message("expire_timestamp");`,
      `CREATE INDEX IF NOT EXISTS idx__history_message__message_type_message_seq ON history_message("message_type", "message_seq")`,
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
    this.client.apiClient.hooks.afterSentMessage.push(
      async (resp, targetId) => {
        if (resp.status !== "ok") return;
        await this.recordSent(resp, targetId);
      },
    );
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

      let placeId: number | null = null;
      if (ev.message_type === "group" && "group_id" in ev) {
        placeId = (ev as any).group_id;
      } else if (ev.message_type === "private" && "user_id" in ev) {
        placeId = ev.user_id;
      }

      let messageSeq: number | null = null;
      if ((ev as any).message_seq) {
        messageSeq = (ev as any).message_seq;
      } else {
        const msgResp = await this.client.apiClient.getMessage(ev.message_id);
        if (msgResp.status === "ok" && "real_id" in (msgResp.data ?? {})) {
          messageSeq = msgResp.data.real_id;
        }
      }

      await this.db.queryArray`
        INSERT INTO history_message ("message_id", "message_type", "place_id", "message_seq", "time", "sub_type", "user_id", "raw", "expire_timestamp")
          VALUES (
            ${ev.message_id},
            ${ev.message_type ?? null},
            ${placeId},
            ${messageSeq},
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
        INSERT INTO history_notice ("time", "notice_type", "raw")
          VALUES (${ev.time}, ${ev.notice_type}, ${JSON.stringify(ev)})
      `;
    } else {
      const ev = _ev as RawEvent;
      await this.db.queryArray`
        INSERT INTO history_unknown ("time", "post_type", "raw")
          VALUES (${ev.time}, ${ev.post_type}, ${JSON.stringify(ev)})
      `;
    }
  }

  /**
   * @param placeId 对于 bot 而言的对面。
   * 如果是群聊，则是群号；如果是私聊，则是 bot 发往的地方。
   */
  async recordSent(resp: SendMessageResponse, placeId: number) {
    if (resp.status !== "ok") throw new Error("never");

    const msgWrapped = await this.client.apiClient.getMessage(
      resp.data!.message_id,
    );
    const msg = msgWrapped.data;

    await this.db.queryArray`
      INSERT INTO history_message ("message_id", "message_type", "place_id", "message_seq", "time", "sub_type", "user_id", "raw", "expire_timestamp")
        VALUES (
          ${msg.message_id},
          ${msg.message_type},
          ${placeId},
          ${msg.message_seq},
          ${msg.time},
          ${"__kubo_sent_out"},
          ${msg.sender.user_id},
          ${JSON.stringify(msg)},
          ${null /* 自己发的消息不设过期 */}
        )`;
  }

  async getMessageEventRaw(messageId: number): Promise<any>;
  async getMessageEventRaw(reply: Reply): Promise<any>;
  async getMessageEventRaw(replyAt: ReplyAt): Promise<any>;
  async getMessageEventRaw(
    replyAtSeqData: { group: number; seq: number },
  ): Promise<any>;
  async getMessageEventRaw(
    replyAtSeqData: { qq: number; seq: number },
  ): Promise<any>;
  async getMessageEventRaw(
    stuff: number | Reply | ReplyAt | {
      qq: number;
      seq: number;
    } | {
      group: number;
      seq: number;
    },
  ): Promise<any> {
    let messageId: number;
    let result: string;

    if (typeof stuff === "object" && "seq" in stuff) {
      let place: "private" | "group";
      let place_id: number;
      if ("group" in stuff) {
        place = "group";
        place_id = stuff.group;
      } else {
        if (!("qq" in stuff)) throw new Error("never");
        place = "private";
        place_id = stuff.qq;
      }

      const queryResult = await this.db.queryArray`
        SELECT "raw" FROM history_message
        WHERE message_type = ${place}
          AND place_id = ${place_id}
          AND message_seq = ${stuff.seq}
        `;
      const rows = queryResult.rows;
      if (rows.length === 0) return null;
      result = rows[0][0] as string;
    } else {
      if (typeof stuff === "number") {
        messageId = stuff;
      } else if ("type" in stuff && stuff.type === "reply") {
        messageId = Number(stuff.data.id);
      } else if ("reply" in stuff) {
        if (stuff.reply?.type !== "reply") throw new Error("never");
        messageId = Number(stuff.reply.data.id);
      } else {
        throw new Error("never");
      }

      const queryResult = await this.db.queryArray
        `SELECT "raw" FROM history_message WHERE message_id = ${messageId}`;
      const rows = queryResult.rows;
      if (rows.length === 0) return null;
      result = rows[0][0] as string;
    }

    return JSON.parse(result);
  }
}
