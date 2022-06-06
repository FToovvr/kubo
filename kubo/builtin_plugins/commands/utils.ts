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
  ctx: PluginContextForCommand,
  usage: string,
): CommandCallbackReturnValue {
  if (ctx.isEmbedded) {
    return { error: makeCheckUsageText(ctx) };
  }
  return usage;
}

export function makeCheckUsageText(ctx: PluginContextForCommand) {
  return `请使用行命令 \`${ctx.headInvoked} -help\` 来查询使用方式。`;
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
