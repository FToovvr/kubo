import { APIClient } from "./api_client.ts";
import { MessagePiece } from "./message_piece.ts";
import { sleep } from "../utils/misc.ts";

type Message =
  & {
    message: string | MessagePiece[];
  }
  & ({
    type: "group";
    toGroup: number;
  } | {
    type: "private";
    toQQ: number;
  });

type PendingMessage = Message & {
  sendAfterTsMs: number;
  resolve: (any: any) => void;
};

/**
 * 类似令牌桶的机制已由冷却系统实现，因此不再在这里使用令牌桶
 */
export class MessageSender {
  apiClient: APIClient;

  constructor(apiClient: APIClient) {
    this.apiClient = apiClient;
  }

  pendings: PendingMessage[] = [];
  isSending = false;

  sendMessage(message: Message, delayMs: number) {
    const now = new Date();

    return new Promise<any>((resolve) => {
      let sendAfterTsMs: number;
      if (this.pendings.length) {
        sendAfterTsMs = Math.max(
          this.pendings[this.pendings.length - 1].sendAfterTsMs,
          Number(now),
        ) + delayMs;
      } else {
        sendAfterTsMs = Number(now) + delayMs;
      }

      this.pendings.push({ ...message, sendAfterTsMs, resolve });

      if (!this.isSending) {
        if (this.pendings.length !== 1) throw new Error("never");

        // 不 await
        this.doSend();
      }
    });
  }

  private async doSend() {
    if (this.isSending) throw new Error("never");
    this.isSending = true;

    while (this.pendings.length) {
      const timeDiff = this.pendings[0].sendAfterTsMs - Number(new Date());
      if (timeDiff > 0) await sleep(timeDiff);
      const message = this.pendings.splice(0, 1)[0];

      let resp: any;
      switch (message.type) {
        case "group": {
          resp = await this.apiClient.sendGroupMessage(
            message.toGroup,
            message.message,
            { cq: false },
          );
          break;
        }
        case "private": {
          resp = await this.apiClient.sendPrivateMessage(
            message.toQQ,
            message.message,
            { cq: false },
          );
          break;
        }
        default:
          throw new Error("never");
      }
      message.resolve(resp);
    }

    this.isSending = false;
  }
}
