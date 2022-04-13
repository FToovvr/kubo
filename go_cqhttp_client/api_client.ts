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

  async fetch(path: string, data: any) {
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
      body: JSON.stringify(data),
    });

    return await (await resp).json();
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

    return await this.fetch("/send_group_msg", {
      group_id: toGroup,
      message,
      auto_escape: !args.cq,
    });
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

    return await this.fetch("/send_private_msg", {
      user_id: toQQ,
      message,
      auto_escape: !args.cq,
    });
  }

  async handleFriendRequest(flag: string, action: "approve" | "deny") {
    return await this.fetch("/set_friend_add_request", {
      flag,
      approve: action === "approve",
    });
  }
}
