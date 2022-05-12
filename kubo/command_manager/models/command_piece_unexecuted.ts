import {
  MessagePiece,
  RegularMessagePiece,
  text,
} from "../../../go_cqhttp_client/message_piece.ts";
import { mergeAdjoiningTextPiecesInPlace } from "../../../utils/message_utils.ts";
import { theAwaitMark } from "../constants.ts";
import {
  CommandArgument,
  MessagePieceIncludingUnexecutedCommand,
} from "../types.ts";
import { splitMessagesBySpaces } from "../utils.ts";
import { CommandEntity } from "./command_entity.ts";
import { PreCommandPiece } from "./command_piece_pre.ts";

export class UnexecutedCommandPiece implements MessagePiece {
  type = "__kubo_unexecuted_command" as const;

  possibleCommands: CommandEntity[];

  prefix: string | null;
  isEmbedded: boolean;
  spaceAfterLeftCurlyBracket?: string;
  isAwait: boolean;

  #rawArgumentsWithCommands: MessagePieceIncludingUnexecutedCommand[];
  arguments: CommandArgument[];
  spaceBeforeArguments: string;
  get isSqueezed() {
    if (this.spaceBeforeArguments.length > 0) return false;
    if (this.arguments?.[0]?.[0] === undefined) return false;
    return this.arguments[0][0].type === "text";
  }

  constructor(cmd: PreCommandPiece) {
    this.possibleCommands = cmd.possibleCommands;
    this.prefix = cmd.prefix;
    this.isEmbedded = cmd.isEmbedded;
    if (cmd.rawLeftForEmbedded !== undefined) {
      this.spaceAfterLeftCurlyBracket = cmd.rawLeftForEmbedded;
    }
    this.isAwait = cmd.isAwait;

    let rawArgs = cmd.rawArguments.map(
      (x): MessagePieceIncludingUnexecutedCommand => {
        if (typeof x === "string") return text(x);
        if (x.type === "__kubo_linefeed") return text("\n");
        if (x.type === "__kubo_pre_command") {
          return new UnexecutedCommandPiece(x as PreCommandPiece);
        }
        // @ts-ignore typescript 没有推断失败
        return x;
      },
    );
    mergeAdjoiningTextPiecesInPlace(rawArgs);
    this.#rawArgumentsWithCommands = rawArgs;
    this.arguments = splitMessagesBySpaces(rawArgs);
    this.spaceBeforeArguments = cmd.spaceBeforeArguments;
  }

  get hasPrefix() {
    return this.prefix !== null;
  }

  #rawArgumentsCache: RegularMessagePiece[] | null = null;

  get raw() {
    return this.reconstructRaw(true);
  }

  get rawArguments() {
    return this.reconstructRawArguments();
  }

  reconstructRaw(isFirstLevel: boolean) {
    const result: RegularMessagePiece[] = [];

    const rawArgs = this.reconstructRawArguments();

    if (this.isEmbedded) {
      if (!this.hasPrefix) throw new Error("never");
      result.push(
        text(
          "{" + this.spaceAfterLeftCurlyBracket! + this.prefix! +
            (this.isAwait ? theAwaitMark : "") +
            this.possibleCommands[this.possibleCommands.length - 1].command +
            this.spaceBeforeArguments,
        ),
      );
      result.push(...rawArgs);
      result.push(text("}"));
    } else {
      result.push(
        text(
          (this.prefix ?? "") +
            (this.isAwait ? theAwaitMark : "") +
            this.possibleCommands[this.possibleCommands.length - 1].command +
            this.spaceBeforeArguments,
        ),
      );
      result.push(...rawArgs);
    }

    if (isFirstLevel) {
      mergeAdjoiningTextPiecesInPlace(result);
    }

    return result;
  }

  reconstructRawArguments() {
    if (this.#rawArgumentsCache) return this.#rawArgumentsCache;

    const result: RegularMessagePiece[] = [];
    for (const piece of this.#rawArgumentsWithCommands) {
      if (piece.type === "__kubo_unexecuted_command") {
        result.push(...(piece as UnexecutedCommandPiece).reconstructRaw(false));
      } else {
        result.push(piece as RegularMessagePiece);
      }
    }
    return result;
  }
}
