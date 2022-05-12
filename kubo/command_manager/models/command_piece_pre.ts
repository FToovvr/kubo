import { MessagePiece } from "../../../go_cqhttp_client/message_piece.ts";
import { MessagePieceForTokenizer } from "../tokenizer.ts";
import { CommandEntity } from "./command_entity.ts";

export interface PreCommandPiece extends MessagePiece {
  type: "__kubo_pre_command";
  possibleCommands: CommandEntity[];
  prefix: string | null;
  isEmbedded: boolean;
  rawLeftForEmbedded?: string;
  isAwait: boolean;
  /** XXX: 如果不是可能命令中较长的命令，需要根据较长命令的名称补上最开头的参数的文本 */
  rawArguments: (MessagePieceForTokenizer)[];
  /**
   * 命令开头后、参数前的空白。
   *
   * XXX: 只对第一个参数是文本时适用。其他情况，无论命令是否要求后面跟着空白都算符合
   */
  spaceBeforeArguments: string;

  isAbandoned: boolean;
}

export function makePreCommandPiece(
  possibleCommands: CommandEntity[],
  args: {
    prefix: string | null;
    isEmbedded: boolean;
    isAwait?: boolean;
    spaceBeforeArguments?: string;
  },
  cmdRawArguments: (MessagePieceForTokenizer)[] = [],
): PreCommandPiece {
  if (possibleCommands.length == 0) throw new Error("never");

  return {
    type: "__kubo_pre_command",
    possibleCommands: possibleCommands,
    prefix: args.prefix,
    isEmbedded: args.isEmbedded,
    isAwait: args.isAwait ?? false,
    rawArguments: cmdRawArguments,
    spaceBeforeArguments: args.spaceBeforeArguments ?? "",

    isAbandoned: false,
  };
}

export interface LinefeedPiece extends MessagePiece {
  type: "__kubo_linefeed";
}
export const linefeedPiece: LinefeedPiece = { type: "__kubo_linefeed" };
