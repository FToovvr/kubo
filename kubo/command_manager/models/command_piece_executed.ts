import {
  MessagePiece,
  RegularMessagePiece,
} from "../../../go_cqhttp_client/message_piece.ts";
import { MessageLineIncludingExecutedCommands } from "../types.ts";
import { CommandEntity } from "./command_entity.ts";

export interface ExecutedCommandPiece extends MessagePiece {
  type: "__kubo_executed_command";

  command: CommandEntity;

  // NOTE: 考虑到读取已执行函数时不应考虑前缀具体是什么，因此去掉。
  // /**
  //  * 命令的前缀。例如前缀是 `/`，则对于：
  //  * - `/foo` `{/foo}` 为  "/"；
  //  * - `foo` 为 null。
  //  *
  //  * 不带前缀的命令，只能作为非嵌入、非 await 命令出现在第一行。
  //  */
  prefix: string | null;

  /**
   * 是否是嵌入命令，例如：
   * - `{/foo}` `{ /foo }` 为 true；
   * - 其他形式为 false。
   *
   * 注意必须包含前缀，且前缀不能和命令分离。
   */
  isEmbedded: boolean;

  /**
   * 是否是 await 命令，例如：
   * - `/&r` `{/&r}` 为 true；
   * - 其他形式为 false。
   */
  shouldAwait: boolean;

  /**
   * 是否处于最开头的位置。
   */
  isLeading: boolean;

  arguments: MessageLineIncludingExecutedCommands[];

  result: CommandExecutedResult;

  notes: CommandNote[];
  hasFailed: boolean;
}

export interface CommandExecutedResult {
  embedding?: RegularMessagePiece[];
  embeddingRaw?: any;

  responses?: RegularMessagePiece[][];
}

export interface CommandNote {
  level: "system-warn" | "system-error" | "user-error";
  content: string;
}

export function makeExecutedCommand(
  cmd: CommandEntity,
  args: {
    prefix: string | null;
    isEmbedded: boolean;
    shouldAwait: boolean;
    isLeading: boolean;
    executedArguments: MessageLineIncludingExecutedCommands[];
  },
  result: CommandExecutedResult | null,
  notes: CommandNote[],
  hasFailed: boolean,
): ExecutedCommandPiece {
  return {
    type: "__kubo_executed_command",
    command: cmd,
    prefix: args.prefix,
    isEmbedded: args.isEmbedded,
    shouldAwait: args.shouldAwait,
    isLeading: args.isLeading,
    arguments: args.executedArguments,
    result: result ?? {},
    notes,
    hasFailed,
  };
}
