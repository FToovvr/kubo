import {
  FriendRequestEvent,
  MessageEvent,
  MessageOfGroupEvent,
  MessageOfPrivateEvent,
} from "../go_cqhttp_client/events.ts";
import { MessagePiece } from "../go_cqhttp_client/message_piece.ts";
import { KuboBot } from "./index.ts";

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
) => ProcessResult<CanPass> | Promise<ProcessResult<CanPass>>;
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
export function extractMessageFilter(
  m: MessageMatcher | FallbackMessageMatcher,
) {
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

export type ActivityStatus = "enabled" | "disabled";
export type ActivityStatusWithDefault = ActivityStatus | "default";

export interface MessageContentCounts {
  bytes: number;
  images: number;
  hasReply: boolean;
  standAloneAts: number;
  emoticons: number;
  otherPieces: Set<string>;
}

export type AffectScope =
  | { scope: "global" }
  | { scope: "group"; group: number }
  | { scope: "user"; qq: number };
