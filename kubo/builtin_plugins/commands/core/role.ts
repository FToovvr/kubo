import { KuboBot, KuboPlugin } from "../../../bot.ts";
import { CommandCallback } from "../../../modules/command_manager/models/command_entity.ts";
import { Roles } from "../../../modules/roles_manager/roles_manager.ts";
import { hasHelpFlag, makeBadArgumentsError } from "../utils.ts";

function makeUsageHead(prefix: string, heads: string[]) {
  return `
${heads.map((head) => prefix + head).join(" ")}
查询/管理用户角色。
    `.trim();
}

function makeUsageExample(prefix: string, head: string) {
  return `
示例：
    > ${prefix}${head} get 12345678
    获取 QQ 为 12345678 的用户的角色信息。
    QQ 换位 at 也可以。

    > ${prefix}${head} get -me
    获取自己的角色信息。
`.trim();
}

function makeSimpleUsage(prefix: string, head: string) {
  return `
${makeUsageHead(prefix, [head])}

${makeUsageExample(prefix, head)}
  `.trim();

  // TODO: 完整帮助信息请使用 \`${prefix}cmd help ${head}\` 查询。
}

function makeCallback(bot: KuboBot): CommandCallback {
  return async (ctx, args) => {
    if (args.length === 0 || hasHelpFlag(args)) {
      return makeSimpleUsage(ctx.prefix ?? "", ctx.head);
    }

    if (args[0].text !== "get") {
      return makeBadArgumentsError(ctx, ["未知子命令"]);
    }
    if (args.length !== 2) {
      return makeBadArgumentsError(ctx, ["参数数量不正确"]);
    }

    let targetQQ: number;
    if (args[1].number) {
      targetQQ = args[1].number;
    } else if (args[1].at) {
      targetQQ = Number(args[1].at.data.qq);
    } else if (args[1].flag === "me") {
      targetQQ = ctx.message.senderQQ;
    } else {
      return makeBadArgumentsError(ctx, ["目标 QQ 格式不正确（既非数字也非 at）"]);
    }

    let roles: Roles;
    if (ctx.message.isInGroupChat) {
      const _roles = bot.roles.getUserGroupRoles(
        targetQQ,
        ctx.message.groupId!,
      );
      if (!await _roles.isGroupMember()) {
        return { error: "查询对象不是群成员！" };
      }
      roles = _roles;
    } else {
      roles = bot.roles.getUserGlobalRoles(targetQQ);
    }
    let roleArray = await roles.getRoles();

    // TODO: 改善输出（比如把 “目标” 改成昵称）
    return `目标（QQ=${targetQQ}）在本群拥有的角色：\n` +
      roleArray.map((r) => `【${r.displayName}】（${r.internalName}）`).join("\n");
  };
}

export default function () {
  const id = "cmd_role";
  const plugin: KuboPlugin = {
    id,

    init(bot) {
      const entity = bot.commands.registerCommand("role", {
        readableName: "角色",
        description: "查看/管理用户角色",
        isExclusive: true,
        callback: makeCallback(bot),
      });
      bot.commands.registerAlias(entity, ["角色"]);
    },
  };

  return plugin;
}
