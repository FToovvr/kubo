import { RegularMessagePiece } from "../../../../go_cqhttp_client/message_piece.ts";
import { CommandArgument } from "./command_argument.ts";
import { EmbeddingRaw } from "./command_piece.ts";
import { PluginContextForCommand } from "./execute_context.ts";

export type CommandCallback = (
  ctx: PluginContextForCommand,
  args: CommandArgument[],
) => CommandCallbackReturnValue | Promise<CommandCallbackReturnValue>;

export type CommandUsageCallback = (
  ctx: { prefix: string; head: string; aliases: string[] },
) => string;

/**
 * 存储注册命令数据所用的数据结构。
 */
export interface CommandEntity {
  command: string;
  /** 可读的名称 */
  readableName: string;
  description: string;

  supportedStyles: Set<CommandStyle>;
  /**
   * 命令是否在一条消息中独占
   * - false 该命令可以与多条命令共存
   * - true 该命令需要是消息中唯一的命令（无论其他命令是否也是该命令都不成）
   * - "leading" 该命令需要时消息中唯一的命令，且出现在最开头
   */
  isExclusive: boolean | "leading";
  referencePolicy: ReferencePolicy;
  canRunEvenWhenBotOff: boolean;

  argumentsBeginningPolicy: ArgumentsBeginningPolicy;

  // TODO!: 是否允许合并、延时控制、分段等，应该由如本处的返回值控制
  // TODO!!: reply 由 ctx 处理，而非返回？
  callback: CommandCallback;

  // `| undefined` 防止 CommandAliasEntity 对应的 getter 报错
  usageCallback?: CommandUsageCallback | undefined;
}

export class CommandAliasEntity implements CommandEntity {
  constructor(
    public target: CommandEntity,
    public command: string,
  ) {
  }

  get readableName() {
    return this.target.readableName;
  }
  get description() {
    return this.target.description;
  }

  get supportedStyles() {
    return this.target.supportedStyles;
  }
  get isExclusive() {
    return this.target.isExclusive;
  }
  get referencePolicy() {
    return this.target.referencePolicy;
  }
  get canRunEvenWhenBotOff() {
    return this.target.canRunEvenWhenBotOff;
  }

  get argumentsBeginningPolicy() {
    return this.target.argumentsBeginningPolicy;
  }

  get callback() {
    return this.target.callback;
  }

  get usageCallback() {
    return this.target.usageCallback;
  }
}

// TODO: 是不是该允许单独的 RegularMessagePiece？
export type CommandCallbackReturnValue =
  | {
    embedding?: string | RegularMessagePiece[];
    embeddingRaw?: EmbeddingRaw;
    response?: string | RegularMessagePiece[];
  }
  | string
  | RegularMessagePiece[]
  | void
  | { error: string };

export type CommandProcessResult = "skip" | "capture";

/**
 * 命令支持的书写形式：
 * - "lined" 行命令 -- 命令位于一行的开始，带前缀；
 * - "embedded" 嵌入命令 -- 命令位于任意位置，被半角花括号包围，带前缀；
 */
export type CommandStyle = "line" | "embedded";

/**
 * 命令的优先级。
 *
 * 嵌入命令必须为 "normal"；整体命令必须为 "low"；~~行命令默认为 "normal"，但也可以设置为 "low"。~~行命令必须为 "low"。
 */
export type CommandPriority = "normal" | "low";

/**
 * 发送的回应是否引用源消息的处理策略：
 *  - "required" 一定要带，也就是说不能被合并；
 *  - "no-reference" 一定不带；
 *  - "omittable" 可带可不带，即如果单发则带，合并则不带。
 */
export type ReferencePolicy = "required" | "omittable" | "no-reference";

/**
 * 参数起始策略（命令的参数从何开始）：
 * - "follows-spaces" 命令和参数需要以空白相隔；
 * - "unrestricted" 没有特别要求。
 */
export type ArgumentsBeginningPolicy = "follows-spaces" | "unrestricted";
