import {
  MessagePiece,
  RegularMessagePiece,
  text,
} from "../../../go_cqhttp_client/message_piece.ts";
import {
  mergeAdjoiningTextPiecesInPlace,
  MessageLine,
} from "../../../utils/message_utils.ts";
import { theAwaitMark } from "./constants.ts";
import {
  CompactComplexPiece,
  ComplexPiecePart,
  GroupPiece,
  reconstructFromComplexPieceParts,
  UnexecutedCommandPiece,
} from "./models/command_piece.ts";
import { CommandTrie, UnexecutedLine } from "./types.ts";

export interface TokenizingEnvironment {
  commandTrie: CommandTrie;
  prefix: string;
}

export type MessagePieceForTokenizer = ComplexPiecePart["content"];

type State = {
  state: "line cmd" | "group";
  pre: PreComplexPiece;
};

type LinefeedPiece = { type: "__kubo_linefeed" };

const usesDebugLog = (() => {
  let usesDebugLog = false;
  // 为了能用一个快捷键就切换…
  // usesDebugLog = true;
  return usesDebugLog;
})();

export function tokenizeMessage(
  ctx: TokenizingEnvironment,
  msg: RegularMessagePiece[],
): UnexecutedLine[] {
  const lines: UnexecutedLine[] = [];
  let curLine: UnexecutedLine = new MessageLine();

  // TODO: 也许是 stack 或者单纯只能有一个 piece 更好？
  const insertedQueue: (RegularMessagePiece | LinefeedPiece)[] = [];

  const states: State[] = [];

  function pushPieces(
    ...pieces: (RegularMessagePiece | UnexecutedCommandPiece | GroupPiece)[]
  ) {
    const topState = states.length ? states[states.length - 1] : null;
    if (!topState) {
      curLine.push(...pieces);
    } else {
      topState.pre.push(...pieces);
    }
  }

  let i = -1;
  OUT:
  while (true) {
    if (usesDebugLog) {
      console.log(Deno.inspect({
        states,
        curLine,
        lines,
        insertedQueue,
        remain: msg.slice(i + 1),
      }, { depth: Infinity }));
    }

    const [curPiece, isFromInsertedQueue] =
      ((): [RegularMessagePiece | LinefeedPiece | null, boolean] => {
        if (insertedQueue.length > 0) {
          return [insertedQueue.splice(0, 1)[0], true];
        }
        i++;
        if (i < msg.length) return [msg[i], false];
        return [null, false];
      })();
    if (!curPiece) break;

    if (usesDebugLog) {
      console.log(Deno.inspect({
        curPiece,
        isFromInsertedQueue,
      }, { depth: Infinity }));
    }

    // 处理换行
    if (curPiece.type === "__kubo_linefeed") {
      const topState = states.length ? states[states.length - 1] : null;

      if (topState?.state === "line cmd") {
        const cmd = topState.pre.asCommandPiece(ctx, "line", {
          // allowsNoPrefix: lines.length === 0,
        });
        states.pop();
        if (cmd) {
          pushPieces(cmd);
        } else {
          pushPieces(...topState.pre.asPlain());
        }
      }

      if (!topState || topState.state === "line cmd") {
        lines.push(curLine);
        curLine = new MessageLine();
      } else {
        if (topState.state !== "group") throw new Error("never");
        topState.pre.push(text("\n"));
      }

      continue;
    }

    // 悬空状态或行命令状态下，识别换行符并处理
    if (states.length === 0 || states[states.length - 1].state === "line cmd") {
      if (curPiece.type === "text") {
        const curText = curPiece.data.text;

        // 换行符，提前把后边的也处理了
        const reLf = /([^\r\n]*)(\r?\n?)/g;
        const toInsert = [];
        let remain!: string;
        while (true) {
          const match = reLf.exec(curText);
          if (!match) throw new Error("never");
          if (match[2].length === 0) {
            remain = match[1];
            break;
          }
          if (match[1].length > 0) {
            // 由于带有换行符的文本不会出现在其中，因此直接 push
            toInsert.push(text(match[1]));
          }
          toInsert.push({ type: "__kubo_linefeed" as const });
        }
        if (toInsert.length > 0) {
          if (insertedQueue.length > 0) throw new Error("never");
          insertedQueue.splice(
            0,
            0,
            ...toInsert,
            ...(remain.length > 0 ? [text(remain)] : []),
          );
          // 如果处理过换行，那就直接下一轮
          continue OUT;
        }
      }
    }

    // 从此开始，非命令或整行命令里不会存在 "\n"，但嵌入命令中还可能会有
    if (
      (states.length === 0 || states[states.length - 1].state === "line cmd") &&
      curPiece.type === "text"
    ) {
      if (/[\r\n]/.test(curPiece.data.text)) throw new Error("never");
    }

    // 悬空状态下，处理疑似行命令
    if (states.length === 0) {
      if (curLine.length === 0) {
        const isFirstLine = lines.length === 0;
        if (
          curPiece.type === "text" &&
          (
            curPiece.data.text.startsWith(ctx.prefix) /*||
            (isFirstLine && /^\S/.test(curPiece.data.text))*/
            // 暂时先不允许第一行的命令省略前缀了，其实那样也挺意味不明的…
          )
        ) { // 可能是行命令
          states.push({ state: "line cmd", pre: new PreComplexPiece() });
          insertedQueue.splice(0, 0, curPiece);
          continue;
        }
      }
    }

    // 任意状态下，处理花括号
    if (curPiece.type === "text") {
      const curText = curPiece.data.text;

      const matchCurlyBracket = /(?<!\\)[{}]/.exec(curText);
      if (matchCurlyBracket) {
        if (matchCurlyBracket.index > 0) {
          const textBeforeRb = curText.slice(0, matchCurlyBracket.index);
          const rest = curText.slice(matchCurlyBracket.index);
          insertedQueue.splice(0, 0, text(textBeforeRb), text(rest));
          continue;
        }

        if (matchCurlyBracket[0] === "{") {
          // 开花括号
          states.push({ state: "group", pre: new PreComplexPiece() });
          if (curText.length > "{".length) {
            insertedQueue.splice(0, 0, text(curText.slice("{".length)));
          }
        } else {
          // 闭花括号
          if (matchCurlyBracket[0] !== "}") throw new Error("never");
          if (states.length > 0) {
            const topState = states[states.length - 1];
            if (topState.state === "group") {
              const cmd = topState.pre.asCommandPiece(ctx, "embedded");
              states.pop();
              if (cmd) {
                pushPieces(cmd);
              } else {
                pushPieces(topState.pre.asGroupPiece());
              }
            }
          } else {
            pushPieces(text("}"));
          }
          if (curText.length > "}".length) {
            insertedQueue.splice(0, 0, text(curText.slice("}".length)));
          }
        }
        continue;
      }
    }

    if (states.length === 0) {
      curLine.push(curPiece);
    } else {
      states[states.length - 1].pre.push(curPiece);
    }
  }

  // 处理剩余的 states
  while (true) {
    const poppedState = states.pop();
    if (!poppedState) break;
    const currentTopState = states.length ? states[states.length - 1] : null;

    if (poppedState.state === "group") {
      const reconstructed = [text("{"), ...poppedState.pre.asPlain()];
      mergeAdjoiningTextPiecesInPlace(reconstructed);
      if (currentTopState) {
        currentTopState.pre.push(...reconstructed);
      } else {
        curLine.push(...reconstructed);
      }
    } else {
      if (poppedState.state !== "line cmd") throw new Error("never");
      if (currentTopState) throw new Error("never");
      const cmd = poppedState.pre.asCommandPiece(ctx, "line", {
        // allowsNoPrefix: lines.length === 0,
      });
      if (cmd) {
        curLine.push(cmd);
      } else {
        curLine.push(...poppedState.pre.asPlain());
      }
    }
  }

  // if (curLine.length) {
  lines.push(curLine);
  // }

  return lines;
}

class PreComplexPiece implements MessagePiece {
  readonly type = "__pre_complex_piece" as const;

  blankAtLeftSide: string = "";

  parts: ComplexPiecePart[] = [];

  push(
    ...pieces: (RegularMessagePiece | UnexecutedCommandPiece | GroupPiece)[]
  ) {
    for (const piece of pieces) {
      const lastPart = this.parts.length
        ? this.parts[this.parts.length - 1]
        : null;
      // TODO: CompactComplexPiece
      let shouldCompact = lastPart?.gapAtRight === "";

      if (piece.type === "text") {
        let pieceText = piece.data.text;
        if (!pieceText.length) throw new Error("never");

        // 处理最开头的空白
        const leftSpaces = /^\s+/.exec(pieceText);
        if (leftSpaces) {
          if (this.parts.length === 0) {
            this.blankAtLeftSide += leftSpaces[0];
          } else {
            this.parts[this.parts.length - 1].gapAtRight += leftSpaces[0];
          }
          // 由于 re 的缘故，不用专门去掉前面的空白也没问题
          // text = text.slice(leftSpaces[0].length);

          shouldCompact = false;
        }

        const re = /(\S+)(\s+|$)/g;
        while (true) {
          const match = re.exec(pieceText);
          if (!match) break;

          if (shouldCompact) {
            if (lastPart!.gapAtRight !== "") throw new Error("never");
            shouldCompact = false;

            if (lastPart!.content.type === "text") {
              this.parts[this.parts.length - 1] = {
                content: text(lastPart!.content.data.text + match[1]),
                gapAtRight: match[2],
              };
            } else if (lastPart!.content.type === "__kubo_compact_complex") {
              const complexParts = lastPart!.content.parts;
              if (!complexParts.length) throw new Error("never");
              const lastComplexPart = complexParts[complexParts.length - 1]!;
              if (lastComplexPart.type === "text") {
                complexParts[complexParts.length - 1] = text(
                  lastComplexPart.data.text + match[1],
                );
              } else {
                complexParts.push(text(match[1]));
              }
              lastPart!.gapAtRight = match[2];
            } else {
              this.parts[this.parts.length - 1] = {
                content: new CompactComplexPiece([
                  lastPart!.content,
                  text(match[1]),
                ]),
                gapAtRight: match[2],
              };
            }
          } else {
            this.parts.push({ content: text(match[1]), gapAtRight: match[2] });
          }
        }
      } else {
        if (!shouldCompact) {
          this.parts.push({ content: piece, gapAtRight: "" });
        } else {
          if (lastPart!.gapAtRight !== "") throw new Error("never");

          if (lastPart!.content.type === "__kubo_compact_complex") {
            lastPart!.content.parts.push(piece);
          } else {
            this.parts[this.parts.length - 1] = {
              content: new CompactComplexPiece([lastPart!.content, piece]),
              gapAtRight: "",
            };
          }
        }
      }
    }
  }

  asGroupPiece() {
    const groupParts: ComplexPiecePart[] = [];
    let shouldCombine = false;
    for (const part of this.parts) {
      if (!shouldCombine) {
        groupParts.push(part);
      } else {
        if (groupParts[groupParts.length - 1].gapAtRight.length > 0) {
          throw new Error("never");
        }
        if (part.content.type === "__kubo_compact_complex") {
          throw new Error("never");
        }

        const last = groupParts[groupParts.length - 1].content;
        if (last.type === "__kubo_compact_complex") {
          last.parts.push(part.content);
        } else {
          groupParts[groupParts.length - 1] = {
            content: new CompactComplexPiece([last, part.content]),
            gapAtRight: "",
          };
        }

        if (part.gapAtRight.length > 0) {
          shouldCombine = false;
          if (groupParts[groupParts.length - 1].gapAtRight.length > 0) {
            throw new Error("never");
          }
          groupParts[groupParts.length - 1].gapAtRight = part.gapAtRight;
        } else {
          shouldCombine = true;
        }
      }
    }

    return new GroupPiece({
      parts: groupParts,
      blankAtLeftSide: this.blankAtLeftSide,
    });
  }

  asCommandPiece(
    ctx: TokenizingEnvironment,
    type: "embedded" | "line",
    args: {
      allowsNoPrefix?: boolean;
    } = {},
  ) {
    args = {
      allowsNoPrefix: false,
      ...args,
    };
    if (args.allowsNoPrefix) throw new Error("never"); // 目前不允许整体命令
    if (type === "embedded" && args.allowsNoPrefix) throw new Error("never");

    // TODO：这样的话不是命令时会调用两次，应该优化一下
    const group = this.asGroupPiece();
    if (!group.parts.length) return null;
    const lead = group.parts[0].content;
    let leadText: string, leadComplexRemain: CompactComplexPiece["parts"];
    if (
      lead.type === "text"
    ) {
      leadText = lead.data.text;
      leadComplexRemain = [];
    } else if (
      lead.type === "__kubo_compact_complex" && lead.parts[0].type === "text"
    ) {
      leadText = lead.parts[0].data.text;
      leadComplexRemain = lead.parts.slice(1);
    } else {
      return null;
    }

    let isAwait = false;
    let prefix: string | null;
    let prefixEndOffset: number;
    if (
      leadText.startsWith(ctx.prefix) &&
      leadText.length > ctx.prefix.length
    ) {
      prefix = ctx.prefix;
      prefixEndOffset = ctx.prefix.length;
      if (leadText[prefixEndOffset].startsWith(theAwaitMark)) {
        isAwait = true;
        prefixEndOffset += theAwaitMark.length;
      }
    } else if (args.allowsNoPrefix!) {
      prefix = null;
      prefixEndOffset = 0;
    } else return null;

    const matches = ctx.commandTrie.matchPrefix(
      prefixEndOffset ? leadText.slice(prefixEndOffset) : leadText,
    );
    if (matches.length === 0) return null;

    const longestMatch = matches[matches.length - 1];
    let gapAfterHead: string;
    if (prefixEndOffset + longestMatch.word.length === leadText.length) {
      if (leadComplexRemain.length) {
        gapAfterHead = "";
        let replacement;
        if (leadComplexRemain.length === 1) {
          replacement = leadComplexRemain[0];
        } else {
          replacement = new CompactComplexPiece(leadComplexRemain);
        }
        group.parts.splice(0, 1, {
          content: replacement,
          gapAtRight: group.parts[0].gapAtRight,
        });
      } else {
        gapAfterHead = group.parts[0].gapAtRight;
        group.parts.splice(0, 1);
      }
    } else {
      gapAfterHead = "";
      const startIndex = prefixEndOffset + longestMatch.word.length;
      const remainText = text(leadText.slice(startIndex));
      if (leadComplexRemain.length) {
        if (group.parts[0].content.type !== "__kubo_compact_complex") {
          throw new Error("never");
        }
        group.parts[0].content.parts[0] = remainText;
      } else {
        if (group.parts[0].content.type !== "text") throw new Error("never");
        group.parts[0].content = remainText;
      }
    }

    const overlappedArgs /*: Partial<
      ConstructorParameters<typeof UnexecutedCommandPiece>[0]
    >*/ = {
      possibleCommands: matches.map((x) => x.value!),
      isAwait,
      rawArguments: group.parts,
      gapAfterHead,
    } as const;
    if (type === "embedded") {
      return new UnexecutedCommandPiece({
        ...overlappedArgs,
        type: "embedded",
        blankAtLeftSide: group.blankAtLeftSide,
        prefix: prefix!,
      });
    } else {
      if (group.blankAtLeftSide.length !== 0) throw new Error("never");
      return new UnexecutedCommandPiece({
        ...overlappedArgs,
        type: "line",
        prefix,
      });
    }
  }

  asPlain(): (RegularMessagePiece | UnexecutedCommandPiece | GroupPiece)[] {
    const rawParts = reconstructFromComplexPieceParts(this.parts);

    if (rawParts.length === 0) return rawParts;
    if (rawParts[0].type === "text") {
      rawParts[0] = text(this.blankAtLeftSide + rawParts[0].data.text);
    } else {
      rawParts.splice(0, 0, text(this.blankAtLeftSide));
    }
    mergeAdjoiningTextPiecesInPlace(rawParts);
    return rawParts;
  }
}
