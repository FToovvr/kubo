import { RegularMessagePiece } from "../../../../go_cqhttp_client/message_piece.ts";
import { CommandArgument } from "./command_argument.ts";
import { EmbeddingRaw } from "./command_piece.ts";
import { CommandContext } from "./execute_context.ts";

export type CommandCallback = (
  ctx: CommandContext,
  args: CommandArgument[],
) => CommandCallbackReturnValue;

/**
 * 存储注册命令数据所用的数据结构。
 */
export interface CommandEntity {
  command: string;
  /** 可读的名称 */
  readableName: string;
  description: string;

  supportedStyles: Set<CommandStyle>;
  // lineStylePriority: CommandPriority;
  referencePolicy: ReferencePolicy;

  argumentsBeginningPolicy: ArgumentsBeginningPolicy;

  // TODO!: 是否允许合并、延时控制、分段等，应该由如本处的返回值控制
  // TODO!!: reply 由 ctx 处理，而非返回？
  callback: CommandCallback;
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
