import { KuboPlugin } from "../../../index.ts";
import { CommandArgument } from "../../../modules/command_manager/models/command_argument.ts";
import {
  CommandCallback,
  CommandCallbackReturnValue,
} from "../../../modules/command_manager/models/command_entity.ts";
import { PluginContextForCommand } from "../../../modules/command_manager/models/execute_context.ts";
import { ActivityStatusWithDefault } from "../../../types.ts";
import {
  makeBadArgumentsError,
  makeUnknownArgumentErrorText,
  makeUsageResponse,
  newScopeFormToOld,
  ScopeParser,
} from "../utils.ts";

// TODO: /bot status -all

function makeNoArgumentsUsage(prefix: string, head: string) {
  return `
Kubo 骰子框架 - 超早期开发版
https://github.com/FToovvr/kubo

${makeUsageExample(prefix, head)}

================

查询帮助：
    ${prefix}help
查询命令帮助信息：
    ${prefix}cmd help <命令>
查询完整的命令列表：
    ${prefix}cmd list
`.trim();
}

function makeUsageHead(prefix: string, heads: string[]) {
  return `
${heads.map((head) => prefix + head).join(" ")}
查询/管理 bot。
    `.trim();
}

function makeUsageExample(prefix: string, head: string) {
  return `
示例：
    群内开启/关闭 bot：
    > ${prefix}${head} on/off
    （需要管理员或骰主身份） 

    全局开启/关闭 bot：
    > ${prefix}${head} on/off -global
    （需要骰主身份）
`.trim();
}

function makeSimpleUsage(prefix: string, head: string) {
  return `
${makeUsageHead(prefix, [head])}

${makeUsageExample(prefix, head)}

完整帮助信息请使用 \`${prefix}cmd help ${head}\` 查询。
  `.trim();
}

const callback: CommandCallback = async (ctx, args) => {
  if (!args.length) return makeNoArgumentsUsage(ctx.prefix ?? "", ctx.head);

  let shouldSendUsage = false;
  let subCmd: "activity" | null = null;
  let subCmdArgs!: CommandArgument[];
  const errors = [];

  for (const [i, arg] of args.entries()) {
    const flag = arg.flag;
    if (flag) {
      if (flag === "h" || flag === "help") {
        shouldSendUsage = true;
      } else {
        errors.push(`未知标志项 ${flag}`);
      }
      continue;
    }

    const text = arg.text;
    if (text) {
      if (["activity", "on", "off"].indexOf(text) >= 0) {
        if (i !== 0) {
          errors.push("子命令需要位于参数的第一位");
          continue;
        }

        if (text === "activity") {
          subCmd = "activity";
          subCmdArgs = args.slice(i + 1);
        } else if (["on", "off"].indexOf(text) >= 0) {
          subCmd = "activity";
          subCmdArgs = args.slice(i);
        } else {
          throw new Error("never");
        }
        break;
      } else {
        errors.push("未知子命令");
      }
      continue;
    }

    errors.push(makeUnknownArgumentErrorText(i, arg));
  }

  if (shouldSendUsage) {
    return makeUsageResponse(ctx, makeSimpleUsage(ctx.prefix ?? "", ctx.head));
  }
  if (errors.length) return makeBadArgumentsError(ctx, errors);
  if (!subCmd) return makeBadArgumentsError(ctx, ["子命令缺失"]);

  if (subCmd === "activity") {
    return subCmd_activity(ctx, subCmdArgs);
  } else throw new Error("never");
};

async function subCmd_activity(
  ctx: PluginContextForCommand,
  subCmdArgs: CommandArgument[],
): Promise<CommandCallbackReturnValue> {
  if (
    subCmdArgs.length &&
    ["on", "off", "reset"].indexOf(subCmdArgs[0].text ?? "") >= 0
  ) {
    const subSubCmd = subCmdArgs[0].text;

    let changesTo: ActivityStatusWithDefault;
    if (subSubCmd === "on") {
      changesTo = "enabled";
    } else if (subSubCmd === "off") {
      changesTo = "disabled";
    } else if (subSubCmd === "reset") {
      changesTo = "default";
    } else throw new Error("never");

    const { scope, errors } = parseScopeFromSubCommandArguments(
      ctx,
      subCmdArgs.slice(1),
    );
    if (errors.length) {
      return makeBadArgumentsError(ctx, errors, { subCommand: "activity" });
    }

    return changeActivityStatus(ctx, changesTo, scope!);
  }

  const { scope, errors } = parseScopeFromSubCommandArguments(
    ctx,
    subCmdArgs,
  );
  if (errors.length) {
    return makeBadArgumentsError(ctx, errors, { subCommand: "activity" });
  }

  return generateActivityText(ctx, scope!);
}

async function changeActivityStatus(
  ctx: PluginContextForCommand,
  changesTo: ActivityStatusWithDefault,
  scope: "global" | { group: number },
): Promise<CommandCallbackReturnValue> {
  // 检查权限
  const sender = ctx.message.senderQQ;
  if (!await ctx.bot.roles.canManageBot(scope, sender)) {
    const roles = ctx.bot.roles.getRolesCanManageBot(scope).join("、");
    return { error: `执行者权限不足！，可执行本操作的角色有：${roles}。` };
  }

  const changeToName = getActivityStatusName(changesTo);

  let originalStatus = await ctx.bot.getActivityStatus(scope);
  let originalName: string;
  if (scope === "global") {
    if (originalStatus.global === changesTo) {
      return `bot 在全局的活动状态新旧设定值未改变（设定值：「${changeToName}」），忽略。`;
    }
    originalName = getActivityStatusName(originalStatus.global);
  } else {
    if (!("group" in originalStatus)) throw new Error("never");
    if (originalStatus.group === changesTo) {
      const group = scope.group;
      return `bot 在群组（${group}）的活动状态新旧设定值未改变（设定值：「${changeToName}」），忽略。`;
    }
    originalName = getActivityStatusName(originalStatus.group);
  }

  await ctx.bot.changeActivityStatus(scope, changesTo);

  let scopeText: string;
  if (scope === "global") {
    scopeText = "全局";
  } else {
    if (scope.group === ctx.message.groupId) {
      scopeText = "本群";
    } else {
      scopeText = "目标群";
    }
  }
  let text =
    `已将 bot 在${scopeText}的活动状态变更为「${changeToName}」（原先值：「${originalName}」）`;
  if (changesTo === "disabled") {
    text += "\n";
    text += `bot 在关闭时将仅响应 ${ctx.prefix ?? ""}bot 命令。`;
  }

  return text;
}

async function generateActivityText(
  ctx: PluginContextForCommand,
  scope: "global" | { group: number },
): Promise<CommandCallbackReturnValue> {
  const texts: string[] = [];

  let status = await ctx.bot.getActivityStatus(scope);

  texts.push(`默认：${getActivityStatusName(status.default)}`);
  texts.push(
    `全局：${getActivityStatusName(status.globalCalculated)}` +
      (status.global === "default" ? "（继承默认值）" : ""),
  );
  if ("group" in status) {
    if (status.global === "disabled") {
      texts.push(`群内：禁用（由于全局禁用；原值：${getActivityStatusName(status.group)}）`);
    } else {
      texts.push(
        `群内：${getActivityStatusName(status.groupCalculated)}` +
          (status.group === "default" ? "（继承全局值）" : ""),
      );
    }
  }
  texts.push(`结算：${getActivityStatusName(status.calculated)}`);

  texts.reverse();

  let scopeText: string;
  if (scope === "global") {
    scopeText = "全局";
  } else {
    if (scope.group === ctx.message.groupId) {
      scopeText = "本群";
    } else {
      scopeText = "目标群";
    }
  }
  return `bot 在${scopeText}的活动状态：\n` + texts.map((x) => "    " + x).join("\n");
}

function parseScopeFromSubCommandArguments(
  ctx: PluginContextForCommand,
  subCmdArgs: CommandArgument[],
) {
  const errors: string[] = [];

  const scopeParser = new ScopeParser();
  for (const [i, arg] of subCmdArgs.entries()) {
    if (i > 0) {
      errors.push("子命令参数过多");
      continue;
    }

    const { hasConsumed } = scopeParser.parse(ctx, arg);
    if (hasConsumed) continue;

    errors.push(makeUnknownArgumentErrorText(null, arg));
  }

  errors.push(...scopeParser.errors);

  let scope = scopeParser.finalScope;
  if (scope === null) {
    if (ctx.message.isInGroupChat) {
      scope = { scope: "group", group: ctx.message.groupId! };
    } else {
      scope = { scope: "global" };
    }
  } else if (scope?.scope === "user") {
    scope = undefined;
    errors.push("该子命令不适用于用户");
  }

  return {
    scope: newScopeFormToOld(scope) as "global" | { group: number },
    errors,
  };
}

function getActivityStatusName(status: ActivityStatusWithDefault) {
  if (status === "default") return "默认";
  if (status === "enabled") return "开启";
  if (status === "disabled") return "关闭";
  throw new Error("never");
}

export default function () {
  const id = "cmd_bot";

  const plugin: KuboPlugin = {
    id,

    init(bot) {
      const entity = bot.commands.registerCommand("bot", {
        readableName: "bot",
        description: "查询/管理 bot",
        // supportedStyles: "line",
        isExclusive: true,
        canRunEvenWhenBotOff: true,
        callback,
      });
      // bot.commands.registerAlias(entity, []);
    },
  };

  return plugin;
}
