import { DB } from "https://deno.land/x/sqlite@v3.3.0/mod.ts";

import { Client } from "../go_cqhttp_client/client.ts";
import {
  FriendRequestEvent,
  MessageEvent,
  MessageOfGroupEvent,
  MessageOfPrivateEvent,
} from "../go_cqhttp_client/events.ts";
import { MessagePiece, Text } from "../go_cqhttp_client/message_piece.ts";
import { SettingsManager } from "./settings_manager.ts";

import { PluginStoreWrapper, Store, StoreWrapper } from "./storage.ts";
import utils from "./utils.ts";

export interface KuboPlugin {
  id: string;

  init?: (bot: KuboBot) => void | false; // false 则不加载

  hooks?: {
    beforeSendMessage?: (
      bot: KuboBot,
      message: string | MessagePiece[],
    ) => string | MessagePiece[] | null;
  };
  listeners?: {
    onReceiveFriendRequest?(bot: KuboBot, ev: FriendRequestEvent): void;
  };
}

/**
 * `"skip"` 未处理
 * `"pass"` 已处理，并且可以继续处理（matcher 为 `{ unprocessed: true }` 时不可用）
 * `"stop"` 已处理，并且到此为止
 */
export type ProcessResult<CanPass extends boolean = true> =
  | "skip"
  | (CanPass extends true ? "pass" : never)
  | "stop";

type MessageKind = "text" | "pieces" | "pieces+text" | "unknown";
export type OnMessageCallback<
  T extends MessageEvent,
  Msg extends MessageKind,
  CanPass extends boolean = true,
> = (
  bot: KuboBot,
  msg: (Msg extends "text" ? string
    : (Msg extends "pieces" ? MessagePiece[] : (MessagePiece[] | string))),
  ev: T,
) => ProcessResult<CanPass>;
export type OnAllMessageCallback<
  Msg extends MessageKind,
  CanPass extends boolean = true,
> = OnMessageCallback<MessageEvent, Msg, CanPass>;
export type OnGroupMessageCallback<
  Msg extends MessageKind,
  CanPass extends boolean = true,
> = OnMessageCallback<MessageOfGroupEvent, Msg, CanPass>;
export type OnPrivateMessageCallback<
  Msg extends MessageKind,
  CanPass extends boolean = true,
> = OnMessageCallback<MessageOfPrivateEvent, Msg, CanPass>;

/**
 * `{ all: true }` 全部
 * `string` 只存在文本，且精确匹配文本
 * `RegExp` 只存在文本，且正则匹配文本
 * `{ startsWith: string }` 只存在文本，且精确匹配前缀
 * `{ unprocessed: true }` 所有其他处理都完成后，仍未处理的消息
 */
export type MessageMatcher = TextMessageMatcher | ComplexMessageMatcher;
export type TextMessageMatcher = string | RegExp;
export type ComplexMessageMatcher = { all: true } | { startsWith: string };
export type FallbackMessageMatcher = { unprocessed: true };
function extractMessageFilter(m: MessageMatcher | FallbackMessageMatcher) {
  const result = {
    text: null as (TextMessageMatcher | null),
    complex: null as (ComplexMessageMatcher | null),
    fallback: null as (FallbackMessageMatcher | null),
  };

  if (
    typeof m === "string" || m instanceof RegExp
  ) {
    result.text = m;
  } else if ((m instanceof Object && "unprocessed" in m)) {
    result.fallback = m;
  } else if (
    (m instanceof Object && "startsWith" in m) ||
    (m instanceof Object && "all" in m)
  ) {
    result.complex = m;
  }

  return result;
}

export class KuboBot {
  // 不建议插件直接使用
  _client: Client;
  _db: DB;
  _store: Store;

  settingsManager: SettingsManager;

  utils = utils;

  ownerQQ: number | number[] | null;

  protected hooks = {
    beforeSendMessage: [] as ((
      bot: KuboBot,
      message: string | MessagePiece[],
    ) => string | MessagePiece[] | null | { intercept: true })[],
  };

  constructor(client: Client, db: DB, cfg?: {
    ownerQQ?: number | number[];
  }) {
    this._client = client;
    this._db = db;
    this._store = new Store(db);
    this.settingsManager = new SettingsManager(
      new StoreWrapper(this._store, "settings"),
    );
    this.ownerQQ = cfg?.ownerQQ || null;
    this.init();
  }

  log(label: string, level: "debug", ...args: any[]) {
    console.debug(label, ...args);
  }

  async run() {
    await this._client.run();
  }

  async close() {
    this._store.close();
    this._db.close();
  }

  //==== on Plugins ====

  plugins: { [key: string]: any } = {};

  use(plugin: KuboPlugin | null): KuboBot {
    if (!plugin) {
      return this;
    }

    if (plugin.id in this.plugins) {
      throw new Error(`插件 ID 重复：${plugin.id}`);
    }
    this.plugins[plugin.id] = plugin;

    if (plugin.init?.(this) === false) {
      // TODO: log
      return this;
    }

    const hooks = plugin.hooks ?? {};
    if (hooks.beforeSendMessage) {
      this.hooks.beforeSendMessage.push(hooks.beforeSendMessage);
    }

    const listeners = plugin.listeners ?? {};
    if (listeners.onReceiveFriendRequest) {
      this._client.eventClient.callbacks.onFriendRequest.push(
        (ev) => listeners.onReceiveFriendRequest!(this, ev),
      );
    }

    return this;
  }

  getStore(plugin: KuboPlugin) {
    return new PluginStoreWrapper(this._store, plugin);
  }

  //==== Common ====

  isOwner(qq: number) {
    if (!this.ownerQQ) return false;
    if (typeof this.ownerQQ === "number") return qq === this.ownerQQ;
    return this.ownerQQ.indexOf(qq) !== -1;
  }

  //==== Helpers ====

  init() {
    this.initOnMessage();
  }

  private onMessageCallbacks: (
    | ["all", MessageMatcher, OnAllMessageCallback<"unknown">]
    | ["group", MessageMatcher, OnGroupMessageCallback<"unknown">]
    | ["private", MessageMatcher, OnPrivateMessageCallback<"unknown">]
  )[] = [];

  private onMessageFallbacks: (
    | [
      "all",
      OnAllMessageCallback<"pieces+text", false>,
    ]
    | [
      "group",
      OnGroupMessageCallback<"pieces+text", false>,
    ]
    | [
      "private",
      OnPrivateMessageCallback<"pieces+text", false>,
    ]
  )[] = [];

  initOnMessage() {
    const processPureTextMessage = <
      T extends MessageEvent,
      Cb extends OnMessageCallback<T, "text">,
    >(
      ev: T,
      text: string,
      matcher: TextMessageMatcher,
      cb: Cb,
    ) => {
      if (
        text === matcher ||
        (matcher instanceof RegExp && matcher.test(text)) ||
        (matcher instanceof Object && "startsWith" in matcher)
      ) {
        return cb(this, text, ev);
      }
    };

    const processComplexMessage = <
      T extends MessageEvent,
      Cb extends OnMessageCallback<T, "pieces+text">,
    >(
      ev: T,
      msg: string | MessagePiece[],
      matcher: ComplexMessageMatcher,
      cb: Cb,
    ) => {
      if (
        (matcher instanceof Object && "all" in matcher && matcher.all) ||
        false // 保持格式
      ) {
        return cb(this, msg, ev);
      }
      if (matcher instanceof Object && "startsWith" in matcher) {
        const textBegin = typeof msg === "string"
          ? msg
          : ((msg.length > 0 && msg[0].type === "text")
            ? (msg[0] as Text).data.text
            : null);
        if (textBegin && textBegin.startsWith(matcher.startsWith)) {
          return cb(this, msg, ev);
        }
      }
    };

    this._client.eventClient.callbacks.onMessage.push((ev, type) => {
      let isProcessed = false;
      const pureText = this.utils.tryExtractPureText(ev.message);
      OUT:
      for (
        const [on, messageMatcher, callback] of this.onMessageCallbacks
      ) {
        const filteredMatcher = extractMessageFilter(messageMatcher);

        if (
          (type === "group" && on !== "all" && on !== "group") ||
          (type === "private" && on !== "all" && on !== "private")
        ) {
          continue;
        }

        if (on !== "all" && on !== "group") {
          continue;
        }
        // 处理群消息

        let result: ProcessResult | null = null;
        if (filteredMatcher.text) {
          if (!pureText) continue;
          // 处理消息是纯文本的情况
          // FIXME: 为什么可能会返回 undefined？
          result = processPureTextMessage(
            ev,
            pureText,
            filteredMatcher.text,
            callback as unknown as any, // 弃疗
          ) ?? "skip";
        } else if (filteredMatcher.complex) {
          result = processComplexMessage(
            ev,
            pureText ?? ev.message,
            filteredMatcher.complex,
            callback as unknown as any,
          ) ?? "skip";
        }
        if (result === "pass" || result == "stop") {
          isProcessed = true;
          if (result === "stop") {
            break OUT;
          }
        }
      }

      if (isProcessed) return;
      OUT:
      for (const [on, cb] of this.onMessageFallbacks) {
        if (ev instanceof MessageOfGroupEvent) {
          if (on !== "all" && on !== "group") {
            continue;
          }

          const result = cb(this, pureText ?? ev.message, ev);
          if (result === "stop") {
            isProcessed = true;
            break OUT;
          }
        }
      }
    });
  }

  async onMessage<
    T extends MessageMatcher | FallbackMessageMatcher,
    U extends "all" | "group" | "private",
    CanPass extends (T extends FallbackMessageMatcher ? false : true),
  >(
    on: U,
    msgMatcher: T,
    cb: U extends "all" ? OnAllMessageCallback<
      T extends TextMessageMatcher ? "text" : "pieces+text",
      CanPass
    >
      : (U extends "group" ? OnGroupMessageCallback<
        T extends TextMessageMatcher ? "text" : "pieces+text",
        CanPass
      >
        : (U extends "private" ? OnPrivateMessageCallback<
          T extends TextMessageMatcher ? "text" : "pieces+text",
          CanPass
        >
          : never)),
  ) {
    const filteredMatcher = extractMessageFilter(msgMatcher);
    if (filteredMatcher.fallback) {
      this.onMessageFallbacks.push([
        on,
        cb as unknown as any, // 弃疗，只要回调函数还能正确确定参数类型就好
      ]);
      return;
    }

    this.onMessageCallbacks.push([
      on,
      msgMatcher as MessageMatcher,
      cb as unknown as any,
    ]);
  }

  //==== Actions ====

  async sendGroupMessage(
    toGroup: number,
    message: string | MessagePiece[],
  ) {
    for (const hook of this.hooks.beforeSendMessage) {
      const _msg = hook(this, message) ?? message;
      if (_msg instanceof Object && "intercept" in _msg && _msg.intercept) {
        return null;
      }
      message = _msg as typeof message;
    }
    return await this._client.sendGroupMessage(toGroup, message);
  }

  async sendPrivateMessage(
    toQQ: number,
    message: string | MessagePiece[],
  ) {
    for (const hook of this.hooks.beforeSendMessage) {
      const _msg = hook(this, message) ?? message;
      if (_msg instanceof Object && "intercept" in _msg && _msg.intercept) {
        return null;
      }
      message = _msg as typeof message;
    }
    return await this._client.sendPrivateMessage(toQQ, message);
  }

  async handleFriendRequest(flag: string, action: "approve" | "deny") {
    return await this._client.handleFriendRequest(flag, action);
  }
}
