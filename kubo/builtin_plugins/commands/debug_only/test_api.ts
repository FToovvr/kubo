import { KuboPlugin } from "../../../index.ts";
import { CommandCallback } from "../../../modules/command_manager/models/command_entity.ts";

const id = "test_api";

const callback: CommandCallback = async (ctx, args) => {
  if (!ctx.bot.roles.canManageBotGlobally(ctx.message.senderQQ)) {
    return { error: "骰主 only。" };
  }

  if (!args.length) return { error: "缺参数。" };

  switch (args[0].text) {
    case "getGroupMemberList": {
      const group = ctx.message.groupId;
      if (!group) return { error: "非群内" };
      const resp = await ctx.bot._client.apiClient.getGroupMemberList(group);
      return JSON.stringify(resp, null, 2);
      break;
    }
    default:
      return { error: "错参数。" };
  }
};

export default function () {
  const plugin: KuboPlugin = {
    id,

    init(bot) {
      bot.commands.registerCommand("test-api", {
        readableName: "测试 API",
        description: "[DEBUG] 测试 API",
        callback,
      });
    },
  };

  return plugin;
}
