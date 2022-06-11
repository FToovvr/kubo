import { text } from "../../../../go_cqhttp_client/message_piece.ts";
import { KuboPlugin } from "../../../types.ts";

const id = "echo_and_error";

export default function () {
  const plugin: KuboPlugin = {
    id,

    init(bot) {
      bot.commands.registerCommand("echo", {
        readableName: "回响",
        description: "[DEBUG] 将输入的参数输出（测试发送文本）",
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
        description: "[DEBUG] 返回错误（测试处理执行错误）",
        callback: (ctx, args) => ({ error: "error" }),
      });
    },
  };

  return plugin;
}
