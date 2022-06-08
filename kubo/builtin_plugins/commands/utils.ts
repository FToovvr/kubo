import { CommandArgument } from "../../modules/command_manager/models/command_argument.ts";
import { CommandCallbackReturnValue } from "../../modules/command_manager/models/command_entity.ts";
import { PluginContextForCommand } from "../../modules/command_manager/models/execute_context.ts";

export function makeUnknownArgumentErrorText(i: number, arg: CommandArgument) {
  let error = "未知参数";
  // TODO: 提供一个将参数文本化的函数？
  if (arg.text) {
    error += ` ${Deno.inspect(arg.text)}`;
  }
  error += `（位于第 ${i + 1} 位）`;
  return error;
}

// TODO: usage 是不是应该由系统处理？
export function makeUsageResponse(
  ctx: PluginContextForCommand, // TODO: 这里用 ctx 不严谨，应该草 bot 那里获得 prefix
  usage: string,
): CommandCallbackReturnValue {
  if (ctx.isEmbedded) {
    return { error: makeCheckUsageText(ctx) };
  }
  return usage;
}

export function makeCheckUsageText(
  ctx: PluginContextForCommand, // TODO: 这里用 ctx 不严谨，应该草 bot 那里获得 prefix
  hasSimpleUsage = true,
) {
  let text = `请使用整行命令 \`${ctx.prefix}cmd help ${ctx.head}\` 查询命令完整的帮助信息`;
  if (hasSimpleUsage) {
    text += `，或以整行命令 \`${ctx.headInvoked} -help\` 查询其简版使用方式`;
  }
  text += "。";
  return text;
}

export function makeBadArgumentsError(
  ctx: PluginContextForCommand,
  errors: string[],
) {
  if (!errors.length) throw new Error("never");
  return {
    error: "参数有误，" + errors[0] + "！" + makeCheckUsageText(ctx),
  };
}

export function getShortestHead(heads: string[]) {
  heads = heads.sort((h1, h2) => h1.length - h2.length);
  return heads[0];
}

export function hasHelpFlag(args: CommandArgument[]) {
  return args.filter((arg) => {
    const flag = arg.flag;
    return flag === "h" || flag === "help";
  }).length > 0;
}
