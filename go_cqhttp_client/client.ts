import { EventClient } from "./event_client.ts";
import { APIClient } from "./api_client.ts";
import { TokenBucket } from "../utils/token_bucket.ts";
import { MessagePiece, Text } from "./message_piece.ts";
import { mergeAdjoiningTextPiecesInPlace } from "../utils/message_utils.ts";
import { MessageSender } from "./message_sender.ts";

export class Client {
  //==== 配置相关 ====

  readonly host: string;
  readonly ports: { http: number; ws: number };
  readonly accessToken: string | null;

  eventClient: EventClient;
  apiClient: APIClient;

  constructor(
    args: {
      connection: {
        host: string;
        ports: { http: number; ws: number };
        accessToken?: string;
      };

      sending?: {
        messageTokenBucket?: TokenBucket;
        messageDelay?: number | (() => number);
      };
    },
  ) {
    this.host = args.connection.host;
    this.ports = args.connection.ports;
    this.accessToken = args.connection.accessToken ?? null;

    this.eventClient = new EventClient({
      host: this.host,
      port: this.ports.ws,
      ...(this.accessToken ? { accessToken: this.accessToken } : {}),
    });

    this.apiClient = new APIClient({
      host: this.host,
      port: this.ports.http,
      ...(this.accessToken ? { accessToken: this.accessToken } : {}),
    });

    this.messageSender = new MessageSender(this.apiClient);
    this.messageDelay = args.sending?.messageDelay ?? 0;
  }

  //==== 运行 ====

  async start() {
    this.eventClient.connect();
  }

  //==== 发送消息 ====

  messageSender: MessageSender;
  messageDelay: number | (() => number);

  protected supportedTypes = new Set(["text", "at", "face", "image"]);

  protected getMessageDelay() {
    let d = this.messageDelay ?? 0;
    return (typeof d === "number") ? d : d();
  }

  protected checkMessage(message: string | MessagePiece[]) {
    if (message.length === 0) { // string 和 array 正好都可以判断
      throw new Error(`消息不能为空！消息内容：${JSON.stringify(message)}`);
    }

    if (typeof message !== "string") {
      mergeAdjoiningTextPiecesInPlace(message);

      for (const [i, piece] of message.entries()) {
        if (this.supportedTypes.has(piece.type)) {
          // ok

          if (piece.type === "text" && (piece as Text).data.text.length === 0) {
            throw new Error(`文本消息片段的内容不能为空！消息内容：${JSON.stringify(message)}`);
          }
        } else if (piece.type === "reply") {
          // TODO: 也许还该检查一下回复内容的发送者是不是 at 的人
          if (i !== 0) {
            throw new Error(`回复消息必须位于首位！消息内容：${JSON.stringify(message)}`);
          } else if (message.length < 2 || message[1].type !== "at") {
            throw new Error(`回复消息后必须紧跟 at 消息！消息内容：${JSON.stringify(message)}`);
          }
        } else {
          throw new Error(
            `暂不支持回复类型 ${piece.type}！消息内容：${JSON.stringify(message)}`,
          );
        }
      }
    }
  }

  async getLoginInfo() {
    return await this.apiClient.getLoginInfo();
  }

  sendGroupMessage(
    toGroup: number,
    message: string | MessagePiece[],
  ) {
    this.checkMessage(message);
    return this.messageSender.sendMessage({
      type: "group",
      toGroup,
      message,
    }, this.getMessageDelay());
  }

  sendPrivateMessage(
    toQQ: number,
    message: string | MessagePiece[],
  ) {
    this.checkMessage(message);
    return this.messageSender.sendMessage({
      type: "private",
      toQQ,
      message,
    }, this.getMessageDelay());
  }

  async handleFriendRequest(flag: string, action: "approve" | "deny") {
    return await this.apiClient.handleFriendRequest(flag, action);
  }
}
