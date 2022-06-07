import { KuboPlugin } from "../../../bot.ts";
import { _temp_registerCommandWithAliases } from "../utils.ts";

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
      _temp_registerCommandWithAliases(bot.commands, "help", {
        readableName: "帮助",
        description: "查看帮助信息",
        callback: (ctx, args) => {
          return todoMessage;
        },
      }, ["帮助"]);
    },
  };

  return plugin;
}
