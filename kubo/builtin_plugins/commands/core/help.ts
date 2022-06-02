import { KuboPlugin } from "../../../bot.ts";

const todoMessage = `
TODO: 写帮助系统

源代码仓库：
https://github.com/FToovvr/kubo
`.trim();

export default function () {
  const id = "cmd_help";
  const plugin: KuboPlugin = {
    id,

    init(bot) {
      bot.commands.registerCommand("help", {
        readableName: "帮助",
        description: "查看帮助信息",
        callback: (ctx, args) => {
          return todoMessage;
        },
      });
    },
  };

  return plugin;
}
