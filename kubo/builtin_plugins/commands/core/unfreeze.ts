import { KuboPlugin } from "../../../index.ts";
import { CommandCallback } from "../../../modules/command_manager/models/command_entity.ts";
import {
  hasHelpFlag,
  makeBadArgumentsError,
  makeUnknownArgumentErrorText,
  newScopeFormToOld,
  ScopeParser,
} from "../utils.ts";

function makeUsageHead(prefix: string, heads: string[]) {
  return `
${heads.map((head) => prefix + head).join(" ")}
解除 bot 的冷却状态。
    `.trim();
}

function makeUsageExample(prefix: string, head: string) {
  return `
示例：
    > ${prefix}${head} -here
    清除所在群的冷却状态。

    > ${prefix}${head} -group=123
    > ${prefix}${head} -qq=456
    清除目标 群组 / QQ 的冷却状态。

    > ${prefix}${head} -global
    清除全局的冷却状态
    
`.trim();
}

function makeSimpleUsage(prefix: string, head: string) {
  return `
${makeUsageHead(prefix, [head])}

${makeUsageExample(prefix, head)}
  `.trim();

  // TODO: 完整帮助信息请使用 \`${prefix}cmd help ${head}\` 查询。
}

const callback: CommandCallback = async (ctx, args) => {
  if (!args.length || hasHelpFlag(args)) {
    return makeSimpleUsage(ctx.prefix ?? "", ctx.head);
  }

  // 检查权限
  const sender = ctx.message.senderQQ;
  if (!await ctx.bot.roles.canManageBotGlobally(sender)) {
    const roles = ctx.bot.roles.getRolesCanManageBotGlobally().join("、");
    return { error: `执行者权限不足！，可执行本操作的角色有：${roles}。` };
  }

  if (args.length !== 1) {
    return makeBadArgumentsError(ctx, ["参数数量不正确"]);
  }

  const errors: string[] = [];
  const scopeParser = new ScopeParser();
  for (const [i, arg] of args.entries()) {
    if (i > 0) throw new Error("never");

    const { hasConsumed } = scopeParser.parse(ctx, arg);
    if (hasConsumed) continue;

    errors.push(makeUnknownArgumentErrorText(null, arg));
  }

  if (scopeParser.errors.length) {
    errors.push(...scopeParser.errors);
  }
  if (errors.length) {
    return makeBadArgumentsError(ctx, errors);
  }

  let scope = scopeParser.finalScope;
  if (scope === null) {
    return makeBadArgumentsError(ctx, ["未指定适用范围"]);
  } else if (scope === undefined) throw new Error("never");

  const isFrozenNow = await ctx.bot.floodMonitor.isFrozen(scope);

  if (!isFrozenNow) {
    return "指定的适用范围中 bot 并未处于冷却状态，忽略。";
  }

  await ctx.bot.floodMonitor.unfreeze(scope, { removeRecords: true });
  return "已解除 bot 在指定适用范围中的冷却状态。";
};

export default function () {
  const id = "cmd_unfreeze";
  const plugin: KuboPlugin = {
    id,

    init(bot) {
      const entity = bot.commands.registerCommand("unfreeze", {
        readableName: "解除冷却",
        description: "解除冷却状态",
        isExclusive: true,
        callback,
      });
      bot.commands.registerAlias(entity, ["解除冷却"]);
    },
  };

  return plugin;
}
