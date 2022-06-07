import { KuboBot, KuboPlugin } from "../../../bot.ts";
import { CommandCallback } from "../../../modules/command_manager/models/command_entity.ts";
import {
  _temp_registerCommandWithAliases,
  makeBadArgumentsError,
  makeUnknownArgumentErrorText,
  makeUsageResponse,
} from "../utils.ts";

const usage = `
inspect
检视消息的数据内容，以方便 debug。

使用方式：
    <引用一条回复>
    inspect [-array|-cq|-full-event] [-this]

选项：
    -h -help  输出帮助文本（本文本）

    -array      显示数组形式的消息内容（默认）
    -cq         显示 CQ 码形式的消息内容文本
    -full-event 显示整个消息事件的内容

    -this  检视发送的消息本身，这时不用再引用回复
           （尚未实现）
`.trim();

function makeCallback(bot: KuboBot): CommandCallback {
  return async (ctx, args) => {
    if (!ctx.message.isInGroupChat && !ctx.message.isInPrivateChat) {
      return { error: `${ctx.headInvoked} 目前只支持群聊及私聊。` };
    }

    let shouldSendUsage = false;
    let errors: string[] = [];
    let toDisplay: "array" | "cq" | "full-event" | null = null;

    for (const [i, arg] of args.entries()) {
      const flag = arg.flag;
      if (!flag) {
        errors.push(makeUnknownArgumentErrorText(i, arg));
        continue;
      }
      switch (flag) {
        case "h":
        case "help": {
          shouldSendUsage = true;
          break;
        }
        case "array":
        case "cq":
        case "full-event": {
          if (toDisplay) {
            errors.push(`参数 -${toDisplay} 与其他参数冲突`);
          }
          toDisplay = flag;
          break;
        }
        case "this": {
          return { error: "TODO: -this" };
        }
        default: {
          errors.push(`未知标志 -${flag}`);
          break;
        }
      }
    }

    if (
      (!args.length && !ctx.message.replyAt && !ctx.followingLines?.length) ||
      shouldSendUsage
    ) {
      return makeUsageResponse(ctx, usage);
    }
    if (errors.length) return makeBadArgumentsError(ctx, errors);

    const message = await ctx.message.getRepliedMessageEventRaw(bot);
    if (!message) return { error: "未找到消息，很可能是本 bot 本地并未存有该消息。" };

    toDisplay = toDisplay ?? "array";
    if (toDisplay === "array") {
      return JSON.stringify(message.message, null, 2);
    } else if (toDisplay === "cq") {
      if (!("raw_message" in message)) {
        return { error: "该消息不存在 CQ 码的形式。" };
      }
      return JSON.stringify(message.raw_message, null, 2);
    } else {
      if (toDisplay !== "full-event") throw new Error("never");
      return JSON.stringify(message, null, 2);
    }
  };
}

export default function () {
  const id = "cmd_inspect";
  const plugin: KuboPlugin = {
    id,

    init(bot) {
      _temp_registerCommandWithAliases(bot.commands, "inspect", {
        readableName: "检视",
        description: "检视消息内容",
        isExclusive: true,
        callback: makeCallback(bot),
      }, ["检视"]);
    },
  };

  return plugin;
}
