import { KuboBot, KuboPlugin } from "../../../index.ts";
import { CommandCallback } from "../../../modules/command_manager/models/command_entity.ts";
import { makeCheckUsageText } from "../utils.ts";

function makeNoArgumentsUsage(prefix: string, head: string) {
  return `
${prefix}command ${prefix}cmd ${prefix}命令
查询/管理 bot 命令。

查询命令帮助信息：
    ${prefix}${head} help <命令>
查询完整的命令列表：
    ${prefix}${head} list
`.trim();
}

const callback: CommandCallback = async (ctx, args) => {
  if (!args.length) return makeNoArgumentsUsage(ctx.prefix ?? "", ctx.head);

  const firstFlag = args[0].flag;
  if (firstFlag === "h" || firstFlag === "help") {
    return makeNoArgumentsUsage(ctx.prefix ?? "", ctx.head);
  }

  const subCmd = args[0].text;
  if (!subCmd || subCmd === "help" && args.length === 1) {
    return makeNoArgumentsUsage(ctx.prefix ?? "", ctx.head);
  }

  if (subCmd === "h" || subCmd === "help" && args.length === 2) {
    let target = args[1].text;
    if (!target) return { error: "所给命令并非文本，请检查查询的命令是否有误！" };
    const prefix = await ctx.bot.commands.getPrefix( // 为以后可能有的复数前缀留个心眼
      ctx.message.groupId !== undefined ? { group: ctx.message.groupId } : {},
    );
    if (target.startsWith(prefix)) {
      target = target.slice(prefix.length);
    }
    if (!target.length) return { error: "不接受查询纯前缀！" };
    return await subCmd_help(ctx.bot, target, ctx.message.groupId);
  } else if (subCmd === "l" || subCmd === "list" && args.length === 1) {
    return subCmd_list(ctx.bot, ctx.prefix ?? "", ctx.message.groupId);
  } else {
    return { error: "参数有误！" + makeCheckUsageText(ctx) };
  }
};

async function subCmd_help(
  bot: KuboBot,
  head: string,
  group?: number,
): Promise<string> {
  const usage = await bot.commands.getUsage(
    head,
    group !== undefined ? { group } : {},
  );
  if (usage === undefined) return "该命令不存在！";
  else if (usage === null) return "该命令没有帮助信息！";

  return usage;
}

function subCmd_list(bot: KuboBot, prefix: string, group?: number) {
  const commandTexts: string[] = [];
  const commands = bot.commands.listCommands({
    ...(group !== undefined ? { inGroup: group } : {}),
  });
  for (const { entity, aliases, status } of commands) {
    // TODO: 显示命令启用状态（包含提示状态源自哪里）
    let text = "";
    const headTexts: string[] = [];
    const heads = [entity.command, ...aliases.map((a) => a.command)];
    for (const head of heads) {
      headTexts.push(`${prefix}${head}`);
    }
    text += headTexts.join(" ") + "\n";
    text += `    ${entity.readableName}：${entity.description}` + "\n";

    {
      let extraLine = "";
      if (entity.usageCallback) {
        extraLine += "【有详细帮助信息】";
      }
      if (extraLine.length) {
        text += "    " + extraLine + "\n";
      }
    }

    commandTexts.push(text);
  }

  const text = commandTexts.join("");

  return text;
}

export default function () {
  const id = "cmd_command";
  const plugin: KuboPlugin = {
    id,

    init(bot) {
      const entity = bot.commands.registerCommand("command", {
        readableName: "命令",
        description: "查询/管理命令",
        // supportedStyles: "line",
        isExclusive: true,
        callback,
      });
      bot.commands.registerAlias(entity, ["cmd", "命令"]);
    },
  };

  return plugin;
}
