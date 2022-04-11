import { encode as encodeBase64 } from "https://deno.land/std@0.95.0/encoding/base64.ts";
import { parse as parseYaml } from "https://deno.land/std@0.134.0/encoding/yaml.ts";

import { DB } from "https://deno.land/x/sqlite@v3.3.0/mod.ts";

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
import { generateRandomIntegerByBoxMuller } from "./utils/misc.ts";

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
  "x-sensitive-list-file": string;
  "x-my-qq": number;
  "x-my-group": number;
};

const accessToken = await Deno.readTextFile(
  config.connection["access-token-file"],
);

const sensitiveList = (await Deno.readTextFile(
  config["x-sensitive-list-file"],
)).split("\n");

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
        return generateRandomIntegerByBoxMuller(111, 888);
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
    sensitiveList: [...sensitiveList, "瑟瑟"],
  });
  const qq = config["x-my-qq"];
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

  bot.onGroupMessage({ all: true }, (bot, msg, ev) => {
    if (ev.sender.qq === qq && ev.groupId === group) {
      return "skip";
    }
    return "stop";
  });

  bot.onGroupMessage("123", (bot, msg, ev) => {
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

  bot.onGroupMessage({ startsWith: "晚安" }, (bot, msg, ev) => {
    (async () => {
      const ret = await bot.sendGroupMessage(
        group,
        buildMessage`${imageFromBase64(猫猫睡觉)}`,
      );

      bot.log("test", "debug", { ret });
    })();
    return "stop";
  });

  bot.onGroupMessage({ startsWith: "复读" }, (bot, msg, ev) => {
    // const message = bot.utils.removeReferenceFromMessage(ev.message);
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
      const ret = await bot.sendGroupMessage(group, outMsg);
      bot.log("test", "debug", { ret });
    })();

    return "stop";
  });

  bot.onGroupMessage({ unprocessed: true }, (bot, _, ev) => {
    bot.log("test", "debug", { ev });
    return "stop";
  });

  console.log("开始运行…");
  await bot.run();
}

async function fileToBase64(path: string) {
  const data = await Deno.readFile(path);
  return encodeBase64(data);
}

await main();
