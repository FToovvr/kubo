import { KuboBot, KuboPlugin } from "../../../bot.ts";
import { CommandCallback } from "../../../modules/command_manager/models/command_entity.ts";

function makeNoArgumentsUsage(prefix: string) {
  return `
${prefix}command ${prefix}cmd ${prefix}命令
查询/管理 bot 命令。

查询完整的命令列表：
    ${prefix}command -list
`.trim();
}

function makeCallback(bot: KuboBot): CommandCallback {
  return async (ctx, args) => {
    if (!args.length) return makeNoArgumentsUsage(ctx.prefix ?? "");
    if (args.length !== 1 || args[0].flag !== "list") {
      return { error: "参数有误！" }; // TODO: + makeCheckUsageText(ctx)
    }

    const commandTexts: string[] = [];
    const commands = bot.commands.listCommands();
    for (const { entity, aliases, status } of commands) {
      // TODO: 显示命令启用状态（包含提示状态源自哪里）
      let text = "";
      const headTexts: string[] = [];
      const heads = [entity.command, ...aliases.map((a) => a.command)];
      for (const head of heads) {
        headTexts.push(`${ctx.prefix}${head}`);
      }
      text += headTexts.join(" ") + "\n";
      text += `    ${entity.readableName}：${entity.description}` + "\n";
      commandTexts.push(text);
    }

    const text = commandTexts.join("");

    return text;
  };
}

export default function () {
  const id = "cmd_command";
  const plugin: KuboPlugin = {
    id,

    init(bot) {
      const entity = bot.commands.registerCommand("command", {
        readableName: "命令",
        description: "获取名信息",
        // supportedStyles: "line",
        isExclusive: true,
        callback: makeCallback(bot),
      });
      bot.commands.registerAlias(entity, ["cmd", "命令"]);
    },
  };

  return plugin;
}
