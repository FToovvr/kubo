import {
  StandardWebSocketClient,
  WebSocketClient,
} from "https://deno.land/x/websocket@v0.1.3/mod.ts";

import {
  FriendRequestEvent,
  FriendRequestRawEvent,
  MessageEvent,
  MessageOfGroupEvent,
  MessageOfGroupRawEvent,
  MessageOfPrivateEvent,
  MessageOfPrivateRawEvent,
  MessageRawEvent,
  RawEvent,
  RequestRawEvent,
} from "./events.ts";

export class EventClient {
  //==== 基础配置 ====

  readonly endpoint: string;

  constructor(args: {
    host: string;
    port: number;
    accessToken?: string;
  }) {
    let endpoint = `ws://${args.host}:${args.port}/event`;
    if (args.accessToken) {
      const params = new URLSearchParams({ access_token: args.accessToken });
      endpoint += "?" + params.toString();
    }
    this.endpoint = endpoint;
  }

  //==== 连接 ====

  client: WebSocketClient | null = null;

  connect() {
    if (this.client) {
      throw new Error("重复连接事件客户端！");
    }

    this.client = new StandardWebSocketClient(this.endpoint);

    this.client.on("message", (ev: { data: string }) => {
      const data = JSON.parse(ev.data);
      this.handleIncomingMessageEvent(data);
    });
  }

  //==== 回调 ====

  callbacks = {
    onMessage: [] as ((ev: MessageEvent, type: "group" | "private") => void)[],
    onFriendRequest: [] as ((ev: FriendRequestEvent) => void)[],
  };

  protected handleIncomingMessageEvent(data: RawEvent) {
    switch (data.post_type) {
      case "message": {
        switch ((data as MessageRawEvent).message_type) {
          case "group": {
            const ev = new MessageOfGroupEvent(data as MessageOfGroupRawEvent);
            this.callbacks.onMessage.forEach((cb) => cb(ev, "group"));
            break;
          }
          case "private": {
            const ev = new MessageOfPrivateEvent(
              data as MessageOfPrivateRawEvent,
            );
            this.callbacks.onMessage.forEach((cb) => cb(ev, "private"));
            break;
          }
        }
        break;
      }
      case "request": {
        switch ((data as RequestRawEvent).request_type) {
          case "friend": {
            const ev = new FriendRequestEvent(data as FriendRequestRawEvent);
            this.callbacks.onFriendRequest.forEach((cb) => cb(ev));
            break;
          }
        }
        break;
      }
    }
  }
}
