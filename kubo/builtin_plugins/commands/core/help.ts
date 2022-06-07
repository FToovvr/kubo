import { KuboPlugin } from "../../../bot.ts";

function makeNoArgumentsUsage(prefix: string) {
  return `
Kubo 骰子框架 - 超早期开发版
https://github.com/FToovvr/kubo

查询命令帮助信息：
    ${prefix}cmd help <命令>
查询完整的命令列表：
    ${prefix}cmd list
`.trim();
}

export default function () {
  const id = "cmd_help";
  const plugin: KuboPlugin = {
    id,

    init(bot) {
      const entity = bot.commands.registerCommand("help", {
        readableName: "帮助",
        description: "查看帮助信息",
        callback: (ctx, args) => {
          return makeNoArgumentsUsage(ctx.prefix ?? "");
        },
      });
      bot.commands.registerAlias(entity, ["帮助", "man"]);
    },
  };

  return plugin;
}
