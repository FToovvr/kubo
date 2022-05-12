import { RegularMessagePiece } from "../../go_cqhttp_client/message_piece.ts";
import { Trie } from "../../utils/aho_corasick.ts";
import { MessageLine } from "../../utils/message_utils.ts";
import { CommandEntity } from "./models/command_entity.ts";
import { ExecutedCommandPiece } from "./models/command_piece_executed.ts";
import { UnexecutedCommandPiece } from "./models/command_piece_unexecuted.ts";

/**
 * 用于存放已注册的命令。
 */
export type CommandTrie = Trie<CommandEntity>;

export type CommandArgument<HasUnexecuted extends boolean = true> =
  (HasUnexecuted extends true ? MessagePieceIncludingCommand
    : MessagePieceIncludingExecutedCommand)[];

export type MessagePieceIncludingUnexecutedCommand =
  | RegularMessagePiece
  | UnexecutedCommandPiece;

export type MessagePieceIncludingExecutedCommand =
  | RegularMessagePiece
  | ExecutedCommandPiece;

export type MessagePieceIncludingCommand =
  | MessagePieceIncludingExecutedCommand
  | UnexecutedCommandPiece;

export type MessageLineIncludingUnexecutedCommands = MessageLine<
  MessagePieceIncludingUnexecutedCommand
>;

export type MessageLineIncludingExecutedCommands = MessageLine<
  MessagePieceIncludingExecutedCommand
>;

export type MessageLineIncludingCommands = MessageLine<
  MessagePieceIncludingCommand
>;
