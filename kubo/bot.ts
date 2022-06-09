import { Client as PgClient } from "https://deno.land/x/postgres@v0.16.0/mod.ts";

import { Client as GoCqHttpClient } from "../go_cqhttp_client/client.ts";
import {
  MessageEvent,
  MessageOfGroupEvent,
} from "../go_cqhttp_client/events.ts";
import { MessagePiece, Text } from "../go_cqhttp_client/message_piece.ts";
import { CommandManager } from "./modules/command_manager/index.ts";
import { MessageManager } from "./modules/message_manager/message_manager.ts";
import { RolesManager } from "./modules/roles_manager/roles_manager.ts";
import { SettingsManager } from "./modules/settings_manager/index.ts";

import { PluginStoreWrapper, Store, StoreWrapper } from "./storage.ts";
import {
  ActivityStatus,
  ActivityStatusWithDefault,
  ComplexMessageMatcher,
  extractMessageFilter,
  FallbackMessageMatcher,
  KuboPlugin,
  MessageMatcher,
  OnAllMessageCallback,
  OnGroupMessageCallback,
  OnMessageCallback,
  OnPrivateMessageCallback,
  ProcessResult,
  TextMessageMatcher,
} from "./types.ts";
import utils from "./utils.ts";

class BotNotRunningError extends Error {
  constructor() {
    super("Bot is not running!");
  }
}

export class KuboBot {
  // 不建议插件直接使用
  _client: GoCqHttpClient;
  _db: PgClient;
  _store: Store;

  isRunning = false;

  self!: {
    qq: number;
    nickname: string;
  };

  settings!: SettingsManager;
  messages!: MessageManager;
  commands!: CommandManager;
  roles!: RolesManager;

  utils = utils;

  ownerQQ: number | number[] | null;

  protected hooks = {
    beforeSendMessage: [] as ((
      bot: KuboBot,
      message: string | MessagePiece[],
    ) => string | MessagePiece[] | null | { intercept: true })[],
    afterInit: [] as ((bot: KuboBot) => void)[],
  };

  constructor(client: GoCqHttpClient, db: PgClient, cfg?: {
    ownerQQ?: number | number[];
  }) {
    this._client = client;
    this._db = db;
    this._store = new Store(db);

    this.ownerQQ = cfg?.ownerQQ || null;
  }

  log(label: string, level: "debug" | "info", ...args: any[]) {
    console.log(level, label, ...args);
  }

  #initCallbacks: ((bot: KuboBot) => void)[] = [];
  init(cb: (bot: KuboBot) => void) {
    this.#initCallbacks.push(cb);
  }

  async run() {
    await this._client.start();
    await this._db.connect();
    await this._store.init();
    this.initOnMessage();

    {
      this.settings = new SettingsManager(
        new StoreWrapper(this._store, "settings"),
      );

      this.messages = new MessageManager(this._db, this._client);
      await this.messages.init();

      // 需要 initOnMessage
      this.commands = new CommandManager(this);
      await this.commands.init();

      this.roles = new RolesManager(this);

      await this.initSettings();
    }

    for (const cb of this.#initCallbacks) {
      cb(this);
    }

    this.self = await this._client.getLoginInfo();
    this.log(
      "kubo",
      "info",
      `登陆账号：QQ「${this.self.qq}」，昵称「${this.self.nickname}」`,
    );

    this.isRunning = true;

    return new Promise(() => {});
  }

  private async initSettings() {
    await this.settings.register("activity-status", {
      info: { readableName: "bot 运行状态", description: "Bot 是否启用" },
      valueType: "string", // "enabled" | "disabled" | "default"
      default: "default",
      // TODO: 加一个参数让 /cfg 看到后拒绝直接修改
    });
  }

  private checkBotIsRunning() {
    if (!this.isRunning) throw new BotNotRunningError();
  }

  async close() {
    this._store.close();
    await this._db.end();
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

  batch(cb: (bot: KuboBot) => void): KuboBot {
    cb(this);
    return this;
  }

  getPluginStore(plugin: KuboPlugin) {
    this.checkBotIsRunning();

    return new PluginStoreWrapper(this._store, plugin);
  }

  //==== Common ====

  isOwner(qq: number) {
    if (!this.ownerQQ) return false;
    if (typeof this.ownerQQ === "number") return qq === this.ownerQQ;
    return this.ownerQQ.indexOf(qq) !== -1;
  }

  //==== Helpers ====

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

  private initOnMessage() {
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

    this._client.eventClient.callbacks.onMessage.push(async (ev, type) => {
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
          result = await processPureTextMessage(
            ev,
            pureText,
            filteredMatcher.text,
            callback as unknown as any, // 弃疗
          ) ?? "skip";
        } else if (filteredMatcher.complex) {
          result = await processComplexMessage(
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

          const result = await cb(this, pureText ?? ev.message, ev);
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

  async changeActivityStatus(
    // TODO: 支持 scope.qq，相当于 block
    scope: "global" | { group: number },
    newValue: "enabled" | "disabled" | "default",
  ) {
    if (newValue === "default") {
      await this.settings.set(scope, "activity-status", null);
    } else {
      await this.settings.set(scope, "activity-status", newValue);
    }
  }

  async getActivityStatus(_scope: "global" | { group: number }) {
    // TODO: 把 settings.set 改为接收 "global" | { group: number }
    //       或者 { scope: "global" } | { scope: "group"; group: number }
    //       或者专门写一个 Scope 类
    const scope = _scope === "global" ? {} : _scope;

    const defaultStatus: ActivityStatus = "enabled"; // TODO: 允许在运行时修改
    const globalStatus = (await this.settings.get(
      {},
      "activity-status",
    )) as ActivityStatusWithDefault;
    const globalCalculated =
      (globalStatus === "default"
        ? defaultStatus
        : globalStatus) as ActivityStatus;

    const globalActivityStatus = {
      default: defaultStatus,
      global: globalStatus,
      globalCalculated,
      calculated: globalCalculated,
    };
    if (scope === "global") {
      return globalActivityStatus;
    }

    const groupStatus = await this.settings.get(
      scope,
      "activity-status",
    ) as ActivityStatusWithDefault;
    if (globalCalculated === "disabled") {
      return {
        ...globalActivityStatus,
        group: groupStatus,
        groupCalculated: "disabled" as ActivityStatus,
        isGroupValueIgnored: true,
        calculated: "disabled" as ActivityStatus,
      };
    }
    const groupCalculated = groupStatus === "default"
      ? globalCalculated
      : groupStatus;
    return {
      ...globalActivityStatus,
      group: groupStatus,
      groupCalculated,
      isGroupValueIgnored: false,
      calculated: groupCalculated,
    };
  }

  async sendGroupMessage(
    toGroup: number,
    message: string | MessagePiece[],
  ) {
    this.checkBotIsRunning();

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
    this.checkBotIsRunning();

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
    this.checkBotIsRunning();

    return await this._client.handleFriendRequest(flag, action);
  }
}
