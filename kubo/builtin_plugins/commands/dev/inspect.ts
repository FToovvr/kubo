import { KuboPlugin } from "../../../bot.ts";

const usage = `
inspect
检视消息的数据内容，以方便 debug。

使用方式：
    <引用一条回复>
    inspect [-array|-cq|-full-event] [-this]

选项：
    -array      显示数组形式的消息内容（默认）
    -cq         显示 CQ 码形式的消息内容文本
    -full-event 显示整个消息事件的内容

    -this  检视发送的消息本身，这时不用再引用回复
           （尚未实现）

    -h -help  输出帮助文本（本文本）

`.trim();

export default function () {
  const id = "cmd_inspect";
  const plugin: KuboPlugin = {
    id,

    init(bot) {
      bot.commands.registerCommand("inspect", {
        readableName: "检视",
        description: "检视消息内容",
        callback: async (ctx, args) => {
          let shouldSendUsage = false;
          let hasError = false;
          let toDisplay: "array" | "cq" | "full-event" | null = null;

          for (const arg of args) {
            const flag = arg.flag;
            if (!flag) {
              hasError = true;
              break;
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
                if (toDisplay) hasError = true;
                toDisplay = flag;
                break;
              }
              case "this": {
                return { error: "TODO" };
              }
              default: {
                hasError = true;
                break;
              }
            }
          }

          if (shouldSendUsage) return usage;
          if (hasError) {
            return { error: `参数有误，请使用 \`${ctx.headInvoked} -help\` 来查询使用方式。` };
          }

          if (!ctx.replyAt) return usage;
          const replyId = ctx.replyAt.reply.data.id;
          const message = await bot.messages.getMessageEventRaw(
            Number(replyId),
          );
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
        },
      });
    },
  };

  return plugin;
}
