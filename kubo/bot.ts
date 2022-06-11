import { Client as PgClient } from "https://deno.land/x/postgres@v0.16.0/mod.ts";

import { Client as GoCqHttpClient } from "../go_cqhttp_client/client.ts";
import {
  MessageEvent,
  MessageOfGroupEvent,
} from "../go_cqhttp_client/events.ts";
import {
  getTypedMessagePiece,
  MessagePiece,
  Text,
  text,
} from "../go_cqhttp_client/message_piece.ts";
import { extractReferenceFromMessage } from "../utils/message_utils.ts";
import { CommandManager } from "./modules/command_manager/index.ts";
import { FloodMonitor } from "./modules/flood_monitor/flood_monitor.ts";
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
  MessageContentCounts,
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
  floodMonitor!: FloodMonitor;

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
      this.settings = new SettingsManager(this._store);

      this.messages = new MessageManager(this._db, this._client);
      await this.messages.init();

      // 需要 initOnMessage
      this.commands = new CommandManager(this);
      await this.commands.init();

      this.roles = new RolesManager(this);

      await this.initSettings();

      this.floodMonitor = new FloodMonitor(this._store, {
        thresholds: { global: 60, group: 30, user: 15 },
      });
    }

    this.self = await this._client.getLoginInfo();

    this.isRunning = true;
    for (const cb of this.#initCallbacks) {
      cb(this);
    }

    this.log(
      "kubo",
      "info",
      `登陆账号：QQ「${this.self.qq}」，昵称「${this.self.nickname}」`,
    );

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

  private isBotRunningOrDie() {
    if (!this.isRunning) throw new BotNotRunningError();
  }

  async close() {
    // TODO: plugin.close
    for (const wrapper of this.pluginStoreWrappers) {
      wrapper.close();
    }
    await this.floodMonitor.close();
    this.settings.close();

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

  pluginStoreWrappers: PluginStoreWrapper[] = [];
  getPluginStore(plugin: KuboPlugin) {
    this.isBotRunningOrDie();

    const wrapper = new PluginStoreWrapper(this._store, plugin);
    this.pluginStoreWrappers.push(wrapper);
    return wrapper;
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
    args: { sourceQQ: number; sourceGroup?: number },
  ) {
    return await this.sendMessage("group", toGroup, message, {
      sourceQQ: args.sourceQQ,
      sourceGroup: args.sourceGroup ?? toGroup,
    });
  }

  async sendPrivateMessage(
    toQQ: number,
    message: string | MessagePiece[],
    args: { sourceQQ?: number; sourceGroup?: number } = {},
  ) {
    return await this.sendMessage("private", toQQ, message, {
      sourceQQ: args.sourceQQ ?? toQQ,
      sourceGroup: args.sourceGroup ?? null,
    });
  }

  async sendMessage(
    place: "group" | "private",
    toTarget: number,
    message: string | MessagePiece[],
    args: { sourceQQ: number; sourceGroup: number | null },
  ): Promise<{ sent: false | "message" | "error"; response: any | null }> {
    this.isBotRunningOrDie();

    for (const hook of this.hooks.beforeSendMessage) {
      const _msg = hook(this, message) ?? message;
      if (_msg instanceof Object && "intercept" in _msg && _msg.intercept) {
        return { sent: false, response: null };
      }
      message = _msg as typeof message;
    }

    let errorMessages: string[] = [];

    if (typeof message === "string") {
      message = [text(message)];
    }
    const counts = countMessageContent(message);
    const checkResult = checkIfMessageFits(counts);
    if (!checkResult.fits) {
      errorMessages.push("拒绝发送响应消息：" + checkResult.error + "！");
    }

    let floodCheck: { isOk: boolean; errors: string[] };
    if (args.sourceGroup) {
      floodCheck = await this.floodMonitor.reportOutboundGroupMessage(
        args.sourceGroup,
        args.sourceQQ,
        counts,
      );
    } else {
      floodCheck = await this.floodMonitor.reportOutboundPrivateMessage(
        args.sourceQQ,
        counts,
      );
    }
    if (!floodCheck.isOk) {
      if (!floodCheck.errors.length) return { sent: false, response: null };
      if (floodCheck.errors.length === 1) {
        errorMessages.push("冷却中：" + floodCheck.errors[0] + "！");
      } else {
        errorMessages.push("冷却中：\n" + floodCheck.errors.join("\n") + "！");
      }
    }

    let sent: "message" | "error" = "message";
    if (errorMessages.length) {
      const { replyAt } = extractReferenceFromMessage(message);
      message = [];
      sent = "error";
      if (replyAt) {
        message.push(...replyAt.array);
      }
      message.push(text(errorMessages.join("\n")));
    }

    let resp: any;
    if (place === "group") {
      resp = await this._client.sendGroupMessage(toTarget, message);
    } else if (place === "private") {
      resp = await this._client.sendPrivateMessage(toTarget, message);
    } else throw new Error("never");
    return { sent, response: resp };
  }

  async handleFriendRequest(flag: string, action: "approve" | "deny") {
    this.isBotRunningOrDie();

    return await this._client.handleFriendRequest(flag, action);
  }
}

/**
 * 检查要发送的单个消息大小是否合理。
 * 标准：
 * - 3000 字节
 * - 10 张图（手机 TIM 能发 20 张）
 * - 1 个 reply+at，以及 1 个单独的 at
 * - face 算 10 个字节
 * - 其他皆不允许
 *
 * TODO: 允许通过 /cfg 调节上限值
 */
function checkIfMessageFits(
  counts: MessageContentCounts,
): { fits: true } | { fits: false; error: string } {
  if (counts.bytes + counts.emoticons * 10 > 3000) {
    return {
      fits: false,
      error: `消息包含的文本有 ${counts.bytes} 字节，超过上限值（3000 字节）` +
        (counts.emoticons ? "（每个表情算 10 字节）" : ""),
    };
  } else if (counts.images > 10) {
    return {
      fits: false,
      error: `消息包含的图片有 ${counts.images} 张，超过上限值（10 张）`,
    };
  } else if (counts.standAloneAts > 1) {
    return {
      fits: false,
      error: `消息包含的 at 有 ${counts.standAloneAts} 个，超过上限值（1 个）`,
    };
  } else if (counts.otherPieces.size) {
    return {
      fits: false,
      error: "存在程序无法处理的内容：" + [...counts.otherPieces.values()].join("、"),
    };
  }
  return { fits: true };
}

function countMessageContent(msg: MessagePiece[]): MessageContentCounts {
  let counts = {
    bytes: 0,
    images: 0,
    hasReply: false,
    standAloneAts: 0,
    emoticons: 0,
    otherPieces: new Set<string>(),
  };

  for (let i = 0; i < msg.length; i++) {
    const _piece = msg[i];
    const pieces = getTypedMessagePiece(_piece);
    if (pieces.text) {
      counts.bytes += pieces.text.data.text.length;
    } else if (pieces.image) {
      counts.images++;
    } else if (pieces.at) {
      counts.standAloneAts++;
    } else if (pieces.reply) {
      counts.hasReply = true;
      if (msg[i + 1]?.type === "at") {
        i++;
      }
    } else if (pieces.emoticon) {
      counts.emoticons++;
    } else {
      counts.otherPieces.add(_piece.type);
    }
  }

  return counts;
}
