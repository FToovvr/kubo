import { SendMessageResponse } from "./api_response.ts";
import { MessagePiece } from "./message_piece.ts";

export class APIClient {
  entrypoint: string;
  accessToken: string | null;

  constructor(args: {
    host: string;
    port: number;
    accessToken?: string;
  }) {
    this.entrypoint = `http://${args.host}:${args.port}`;
    this.accessToken = args.accessToken ?? null;
  }

  async fetch(path: string, data?: any) {
    const endpoint = this.entrypoint + path;
    const resp = fetch(endpoint, {
      method: "POST",
      headers: {
        ...(this.accessToken
          ? { "Authorization": `Bearer ${this.accessToken}` }
          : null),
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      // 即使无需参数也要是 `{}`
      body: JSON.stringify(data ?? {}),
    });

    return await (await resp).json();
  }

  hooks = {
    afterSentMessage: [] as ((resp: SendMessageResponse) => void)[],
  };

  async getLoginInfo() {
    const data = (await this.fetch("/get_login_info")).data;
    return {
      qq: Number(data.user_id),
      nickname: data.nickname,
    };
  }

  async sendGroupMessage(
    toGroup: number,
    message: string | MessagePiece[],
    args?: { cq?: boolean },
  ) {
    args = {
      cq: false,
      ...args,
    };

    const resp = await this.fetch("/send_group_msg", {
      group_id: toGroup,
      message,
      auto_escape: !args.cq,
    });
    this.hooks.afterSentMessage.forEach((cb) =>
      cb(resp as SendMessageResponse)
    );
    return resp;
  }

  async sendPrivateMessage(
    toQQ: number,
    message: string | MessagePiece[],
    args?: { cq?: boolean },
  ) {
    args = {
      cq: false,
      ...args,
    };

    const resp = await this.fetch("/send_private_msg", {
      user_id: toQQ,
      message,
      auto_escape: !args.cq,
    });
    this.hooks.afterSentMessage.forEach((cb) =>
      cb(resp as SendMessageResponse)
    );
    return resp;
  }

  async handleFriendRequest(flag: string, action: "approve" | "deny") {
    return await this.fetch("/set_friend_add_request", {
      flag,
      approve: action === "approve",
    });
  }

  async getMessage(messageId: number) {
    return await this.fetch("/get_msg", { message_id: messageId });
  }
}
