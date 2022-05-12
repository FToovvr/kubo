import {
  getTypedMessagePiece,
  text,
} from "../../go_cqhttp_client/message_piece.ts";
import { UnexecutedCommandPiece } from "./models/command_piece_unexecuted.ts";
import { MessagePieceForTokenizer } from "./tokenizer.ts";
import {
  MessageLineIncludingUnexecutedCommands,
  MessagePieceIncludingUnexecutedCommand,
} from "./types.ts";

export function regularizeMessage(
  mess: (MessagePieceForTokenizer | string)[],
): MessageLineIncludingUnexecutedCommands[] {
  const lines: MessageLineIncludingUnexecutedCommands[] = [];
  let curLine: MessageLineIncludingUnexecutedCommands = [];

  if (mess.length === 0) return [];

  for (let i = 0; i < mess.length; i++) {
    const _piece = mess[i];
    const isStr = typeof _piece === "string";
    const piece = isStr ? undefined : getTypedMessagePiece(_piece);
    if (isStr || piece!.text) {
      const textPiece = isStr ? text(_piece) : piece!.text!;
      const lastPiece: MessagePieceIncludingUnexecutedCommand | undefined =
        curLine[curLine.length - 1];
      if (lastPiece?.type === "text") {
        curLine[curLine.length - 1] = text(
          lastPiece.data.text + textPiece.data.text,
        );
      } else {
        curLine.push(textPiece);
      }
    } else if (piece!.unknown) {
      if (_piece.type === "__kubo_pre_command") {
        const piece = _piece;
        if (piece.isAbandoned) {
          if (!piece.isEmbedded) throw new Error("never");
          const longestCommand =
            piece.possibleCommands[piece.possibleCommands.length - 1].command;
          const reconstructed = "{" + piece.rawLeftForEmbedded! + piece.prefix +
            longestCommand + piece.spaceBeforeArguments;
          mess.splice(i + 1, 0, reconstructed, ...piece.rawArguments);
        } else {
          curLine.push(new UnexecutedCommandPiece(piece));
        }
      } else if (_piece.type === "__kubo_linefeed") {
        lines.push(curLine);
        curLine = [];
      } else throw new Error("never");
    } else {
      curLine.push(_piece as MessagePieceIncludingUnexecutedCommand);
    }
  }

  lines.push(curLine);

  return lines;
}
