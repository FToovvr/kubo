import { encode as encodeBase64 } from "https://deno.land/std@0.95.0/encoding/base64.ts";
import { parse as parseYaml } from "https://deno.land/std@0.134.0/encoding/yaml.ts";
import * as path from "https://deno.land/std@0.134.0/path/mod.ts";

import { DB } from "https://deno.land/x/sqlite@v3.3.0/mod.ts";
import { createCanvas } from "https://deno.land/x/canvas@v1.4.1/mod.ts";

import {
  StandardWebSocketClient,
  WebSocketClient,
} from "https://deno.land/x/websocket@v0.1.3/mod.ts";

import { Client } from "./go_cqhttp_client/client.ts";
import {
  buildMessage,
  imageFromBase64,
  replyAt,
  text,
} from "./go_cqhttp_client/message_piece.ts";
import { makeDefaultKuboBot } from "./kubo/index.ts";
import { randIntBM } from "./utils/misc.ts";
import {
  MessageOfGroupEvent,
  MessageOfPrivateEvent,
} from "./go_cqhttp_client/events.ts";

console.log("初始化中…");

const config = parseYaml(await Deno.readTextFile("config.yaml")) as {
  connection: {
    host: string;
    ports: { http: number; ws: number };
    "access-token-file": string;
  };
  storage: {
    "db-file": string;
  };
  common: {
    "owner-qq": number | number[];
  };
  "x-sensitive-words-dir": string;
  "x-my-group": number;
};

const accessToken = await Deno.readTextFile(
  config.connection["access-token-file"],
);

const sensitiveList = await (async () => {
  const pendings: string[] = [config["x-sensitive-words-dir"]];
  const allWords = [];
  while (pendings.length > 0) {
    const [cur] = pendings.splice(0, 1);
    for await (const entry of Deno.readDir(cur)) {
      if (entry.isFile && /\.list$/.test(entry.name)) {
        const text = await Deno.readTextFile(path.join(cur, entry.name));
        const words = text.split("\n");
        allWords.push(...words);
      } else if (entry.isDirectory) {
        pendings.push(path.join(cur, entry.name));
      }
    }
  }
  return allWords;
})();

const db = new DB(config.storage["db-file"]);

async function main() {
  const 猫猫睡觉 = await fileToBase64("test_fixtures/猫猫睡觉.jpg");

  const client = new Client({
    connection: {
      ...config.connection,
      accessToken,
    },
    sending: {
      // 在处理完令牌桶后的延时
      // TODO: 应该直接和令牌桶整合
      messageDelay: () => {
        return randIntBM(111, 888);
      },
    },
  });

  if (false) { // 获取原始事件数据用
    const ws: WebSocketClient = new StandardWebSocketClient(
      client.eventClient.endpoint,
    );

    // go-cqhttp 没有说明，因此参考这个：
    // https://github.com/kyubotics/coolq-http-api/blob/master/docs/4.15/WebSocketAPI.md
    ws.on("message", function (message: unknown) {
      // @ts-ignore
      const data = JSON.parse(message.data);
      // if (data.post_type === "message") {
      // @ts-ignore
      console.log(data);
      // }
    });

    await new Promise(() => {});
    return;
  }

  const bot = makeDefaultKuboBot(client, db, {
    sensitiveList,
    ownerQQ: config.common["owner-qq"],
  });
  const group = config["x-my-group"];

  bot.use({
    id: "_",
    hooks: {
      beforeSendMessage(bot, msg) {
        bot.log("test", "debug", { outboundMessage: msg });
        return null;
      },
    },
  });

  bot.onMessage("group", { all: true }, (bot, msg, ev) => {
    if (bot.isOwner(ev.sender.qq) && ev.groupId === group) {
      return "skip";
    }
    return "stop";
  });

  bot.onMessage("all", "123", (bot, msg, ev) => {
    const promises: Promise<string>[] = [];
    for (let i = 1; i <= 3; i++) {
      promises.push(bot.sendGroupMessage(group, String(i)));
    }
    (async () => {
      const results = await Promise.all(promises);
      bot.log("test", "debug", { results });
    })();
    return "stop";
  });

  bot.onMessage("all", { startsWith: "晚安" }, (bot, msg, ev) => {
    (async () => {
      const ret = await bot.sendGroupMessage(
        group,
        buildMessage`${imageFromBase64(猫猫睡觉)}`,
      );

      bot.log("test", "debug", { ret });
    })();
    return "stop";
  });

  bot.onMessage("all", { startsWith: "复读" }, (bot, msg, ev) => {
    const ref = replyAt(ev.messageId, ev.sender.qq);
    let outMsg = [];
    if (typeof msg === "string") {
      outMsg = [...ref, text(msg.substring(2))];
    } else {
      let text1: string | null = bot.utils.tryExtractPureText(msg)! ?? "";
      text1 = text1.length === 2 ? null : text1.substring(2).trimStart();
      outMsg = [...ref, ...(text1 ? [text(text1)] : []), ...msg.slice(1)];
    }
    (async () => {
      let ret: any;
      if (ev instanceof MessageOfGroupEvent) {
        ret = await bot.sendGroupMessage(group, outMsg);
      } else if (ev instanceof MessageOfPrivateEvent) {
        ret = await bot.sendPrivateMessage(ev.sender.qq, outMsg);
      }
      bot.log("test", "debug", { ret });
    })();

    return "stop";
  });

  bot.onMessage("all", { unprocessed: true }, (bot, _, ev) => {
    bot.log("test", "debug", { ev });
    console.log({
      before: ev.message,
      after: bot.utils.removeReferenceFromMessage(ev.message),
    });
    return "stop";
  });

  bot.commands.registerCommand("随机单色图片", {
    readableName: "随机单色图片",
    description: "生产随机单色图片",
    callback: () => {
      const canvas = createCanvas(1, 1);
      const ctx = canvas.getContext("2d");
      const [r, g, b] = [
        bot.utils.randInt(0, 255),
        bot.utils.randInt(0, 255),
        bot.utils.randInt(0, 255),
      ];
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, 0, 1, 1);
      const base64 = encodeBase64(canvas.toBuffer());
      return [
        imageFromBase64(base64),
        text(ctx.fillStyle),
      ];
    },
  });

  bot.commands.registerCommand("echo", {
    readableName: "回响",
    description: "将输入的参数输出",
    callback: (ctx, args) => {
      let _ret = args?.map((arg) => {
        const sole = arg.sole;
        if (!sole) return [text("[complex]")];

        if (sole.type === "__kubo_executed_command") {
          if (sole.hasFailed) return [text("[failed-cmd]")];
          if (sole.result?.embedding?.length ?? 0 > 0) {
            return [
              text(`[cmd:${sole.command.command},content=`),
              ...sole.result!.embedding!,
              text(`]`),
            ];
          } else {
            return [text(`[cmd:${sole.command.command}]`)];
          }
        }
        if (sole.type === "text") return [sole];
        return [text("[other]")];
      });
      const ret = _ret?.flatMap((arg, i) =>
        i < _ret!.length - 1 ? [...arg, text(" ")] : [...arg]
      );
      if (ret) {
        return {
          response: ret,
          embedding: ret,
        };
      }
    },
  });
  bot.commands.registerCommand("error", {
    readableName: "错误",
    description: "返回错误",
    callback: (ctx, args) => ({ error: "error" }),
  });

  console.log("开始运行…");
  Deno.addSignalListener("SIGINT", async () => {
    console.log("正在终止…");
    await bot.close();
    console.log("bot 已终止！");
    Deno.exit(0);
  });
  await bot.run();
}

async function fileToBase64(path: string) {
  const data = await Deno.readFile(path);
  return encodeBase64(data);
}

await main();
