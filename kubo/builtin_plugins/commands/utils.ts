import { CommandArgument } from "../../modules/command_manager/models/command_argument.ts";
import { CommandCallbackReturnValue } from "../../modules/command_manager/models/command_entity.ts";
import { PluginContextForCommand } from "../../modules/command_manager/models/execute_context.ts";

export function makeUnknownArgumentErrorText(
  i: number | null,
  arg: CommandArgument,
) {
  let error = "未知参数";
  // TODO: 提供一个将参数文本化的函数？
  if (arg.text) {
    error += ` ${Deno.inspect(arg.text)}`;
  }
  if (i !== null) {
    error += `（位于第 ${i + 1} 位）`;
  }
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
  extra: { subCommand?: string } = {},
) {
  if (!errors.length) throw new Error("never");

  let error = "";
  if ("subCommand" in extra) {
    error += `子命令 ${extra.subCommand} 的`;
  }
  error += "参数有误，" + errors[0] + "！" + "\n" + makeCheckUsageText(ctx);

  return { error };
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

type Scope =
  | { scope: "global" }
  | { scope: "group"; group: number }
  | { scope: "user"; qq: number };
type OldScope = "global" | { group: number } | { qq: number };

export class ScopeParser {
  scopes: { scope: Scope; raw: string }[] = [];
  private _errors: string[] = [];

  parse(
    ctx: PluginContextForCommand,
    arg: CommandArgument,
  ): { hasConsumed: boolean } {
    const flag = arg.flag;
    if (flag) {
      if (flag === "here") {
        if (ctx.message.isInGroupChat) {
          this.scopes.push({
            scope: { scope: "group", group: ctx.message.groupId! },
            raw: arg.text!,
          });
        } else {
          this._errors.push(`参数 -${flag} 只能在群聊中使用`);
        }
        return { hasConsumed: true };
      } else if (flag === "global") {
        this.scopes.push({ scope: { scope: "global" }, raw: arg.text! });
        return { hasConsumed: true };
      }
      return { hasConsumed: false };
    }

    const option = arg.option;
    if (option && (option.key === "-group" || option.key === "-qq")) {
      const value = option.value.integer;
      if (!value || value < 0) {
        this._errors.push(`参数选项 ${option} 的值必须为正整数`);
        return { hasConsumed: true };
      }
      const raw = arg.text!;

      if (option.key === "-group") {
        this.scopes.push({ scope: { scope: "group", group: value }, raw });
      } else if (option.key === "-qq") {
        this.scopes.push({ scope: { scope: "user", qq: value }, raw });
      }
      return { hasConsumed: true };
    }

    return { hasConsumed: false };
  }

  get errors() {
    return [
      ...this._errors,
      ...(this.scopes.length > 1
        ? [`参数中包含多个适用范围（${this.scopes.map(({ raw }) => raw).join("、")}）`]
        : []),
    ];
  }

  get finalScope() {
    if (!this.scopes.length) return null;
    if (this.scopes.length === 1) return this.scopes[0].scope;
    return undefined;
  }
}

export function newScopeFormToOld(
  scope: Scope | undefined,
): OldScope | undefined {
  if (!scope) return undefined;

  if (scope.scope === "global") return "global";
  if (scope.scope === "group") return { group: scope.group };
  if (scope.scope === "user") return { qq: scope.qq };
  throw new Error("never");
}
