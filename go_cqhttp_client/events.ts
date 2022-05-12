import { MessagePiece } from "./message_piece.ts";

export interface RawEvent {
  post_type: string;
}

export interface MessageRawEvent extends RawEvent {
  post_type: "message";
  message_type: string;

  message_id: number;
  user_id: number;
  time: number;

  message: MessagePiece[];
  raw_message: string;
}

export interface MessageOfGroupRawEvent extends MessageRawEvent {
  message_type: "group";
  group_id: number;
  sender: {
    // 群昵称
    card: string;
    nickname: string;
  };
}

export interface MessageOfPrivateRawEvent extends MessageRawEvent {
  message_type: "private";
  sub_type: string; // "friend" | …
}

export class MessageEvent {
  readonly messageType: string;
  raw: MessageRawEvent;

  messageId: number;
  sender: {
    qq: number;
  };
  timestamp: number;

  message: MessagePiece[];

  constructor(raw: MessageRawEvent) {
    this.messageType = raw.message_type;
    this.raw = raw;

    this.messageId = raw.message_id;
    this.sender = { qq: raw.user_id };
    this.timestamp = raw.time;

    this.message = raw.message;
  }
}

export class MessageOfGroupEvent extends MessageEvent {
  readonly messageType = "group";
  declare sender: {
    qq: number;
    groupCard: string | null;
    nickname: string;
  };

  groupId: number;

  constructor(raw: MessageOfGroupRawEvent) {
    super(raw);

    this.groupId = raw.group_id;

    this.sender = {
      ...this.sender,
      groupCard: raw.sender.card !== "" ? raw.sender.card : null,
      nickname: raw.sender.nickname,
    };
  }
}

export class MessageOfPrivateEvent extends MessageEvent {
  readonly messageType = "private";
  subType: string;

  constructor(raw: MessageOfPrivateRawEvent) {
    super(raw);

    this.subType = raw.sub_type;
  }
}

export interface RequestRawEvent extends RawEvent {
  post_type: "request";
  request_type: string;
}

// https://docs.go-cqhttp.org/event/#加好友请求
export interface FriendRequestRawEvent extends RequestRawEvent {
  request_type: "friend";

  user_id: number;
  comment: string;
  time: number;

  flag: string;
}

export class FriendRequestEvent {
  raw: FriendRequestRawEvent;

  qq: number;
  comment: string;
  timestamp: number;

  // 在调用处理请求的 API 时需要传入
  flag: string;

  constructor(raw: FriendRequestRawEvent) {
    this.raw = raw;

    this.qq = raw.user_id;
    this.comment = raw.comment;
    this.timestamp = raw.time;

    this.flag = raw.flag;
  }
}
