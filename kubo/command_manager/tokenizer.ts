import {
  getTypedMessagePiece,
  RegularMessagePiece,
  text,
} from "../../go_cqhttp_client/message_piece.ts";
import { theAwaitMark } from "./constants.ts";
import {
  LinefeedPiece,
  linefeedPiece,
  makePreCommandPiece,
  PreCommandPiece,
} from "./models/command_piece_pre.ts";
import { regularizeMessage } from "./regularize.ts";
import {
  CommandTrie,
  MessageLineIncludingUnexecutedCommands,
} from "./types.ts";

/** XXX: 目前的想法是还是不要解析嵌入于嵌入命令中的行命令好了 */
const allowsNestedLineCommand = false;

export interface TokenizingContext {
  commandTrie: CommandTrie;
  prefix: string;
}

type State = { // 在解析参数
  state: "lineCmd:args" | "embCmd:args";
  preCommand: PreCommandPiece;
} | { // 在找嵌入命令的前缀
  state: "embCmd:expectingPrefix";
  rawLeft: string;
} | { // 嵌入命令没找到前缀，在找右花括号
  state: "embCmd:failing";
  content: MessagePieceForTokenizer[];
};

export type MessagePieceForTokenizer =
  | RegularMessagePiece
  | PreCommandPiece
  | LinefeedPiece;

export function tokenizeMessage(
  ctx: TokenizingContext,
  msg: RegularMessagePiece[],
) {
  const tokenizer = new Tokenizer(ctx, msg);
  return tokenizer.tokenize();
}

/**
 * 将消息中可能的命令转化为 PreCommandPiece，将换行转化为 LinefeedPiece。
 *
 * 传入的消息应该已经经过清理，即不包含 reply 以及最开头的 at
 */
class Tokenizer {
  commandTrie: CommandTrie;
  prefix: string;

  inputMessage: RegularMessagePiece[];

  constructor(ctx: TokenizingContext, msg: RegularMessagePiece[]) {
    this.commandTrie = ctx.commandTrie;
    this.prefix = ctx.prefix;

    if (msg.length > 0) {
      const first = getTypedMessagePiece(msg[0]);
      let uncleaned = false;
      if (first.reply || first.at) {
        uncleaned = true;
      } else if (msg.length > 1 && first.text?.data.text.trim() === "") {
        const second = getTypedMessagePiece(msg[1]);
        if (second.at) {
          uncleaned = true;
        }
      }
      if (uncleaned) {
        throw new Error("传入 Tokenizer 的消息未被清理！");
      }
    }

    this.inputMessage = msg;
  }

  private done = false;
  private tokenizedMessage: MessagePieceForTokenizer[] = [];
  private cachedFinalMessage!: MessageLineIncludingUnexecutedCommands[];
  private stateStack: State[] = [];

  tokenize(): MessageLineIncludingUnexecutedCommands[] {
    if (this.done) {
      return this.cachedFinalMessage!;
    }
    this.done = true;

    this.tokenizeMessage();

    this.cachedFinalMessage = regularizeMessage(this.tokenizedMessage);

    return this.cachedFinalMessage;
  }

  private curPiece!: RegularMessagePiece;
  private isFirstPiece = true;

  private tokenizeMessage() {
    for (const piece of this.inputMessage) {
      this.curPiece = piece;
      this.tokenizePiece();
      this.isFirstPiece = false;
    }

    this.tokenizeRemainStates();
  }

  private tokenizePiece() {
    const typedPiece = getTypedMessagePiece(this.curPiece);

    if (typedPiece.text) {
      this.tokenizeText(typedPiece.text.data.text);
    } else { // tokenizeNonTextPiece
      const topState = this.topState;
      if (topState?.state === "embCmd:expectingPrefix") {
        // 在左花括号与斜杠间有其他内容，因此不是命令
        this.stateStack.pop();
        this.appendPieces([topState.rawLeft]);
      }
      this.appendPieces([this.curPiece]);
    }
  }

  private linesOfCurPiece!: string[];
  private get curLine(): string {
    return this.linesOfCurPiece[0]!;
  }
  private isFirstLineOfCurPiece!: boolean;
  private shouldNotBreakLine!: boolean;

  private tokenizeText(text: string) {
    this.linesOfCurPiece = text.split("\n");
    this.isFirstLineOfCurPiece = true;
    this.shouldNotBreakLine = false;
    while (this.linesOfCurPiece.length > 0) {
      this.tokenizeLine();
      this.isFirstLineOfCurPiece = false;
    }
  }

  private tokenizeLine() {
    // console.log({
    //   curLine: this.curLine,
    //   isFirstLineOfCurPiece: this.isFirstLineOfCurPiece,
    //   shouldNotBreakLine: this.shouldNotBreakLine,
    //   stateStackLength: this.stateStack.length,
    //   topState: this.topState?.state,
    //   // @ts-ignore
    //   topStateArgs: this.topState?.preCommand?.rawArguments,
    // });

    //==== 处理换行 ====//
    if (!this.isFirstLineOfCurPiece) {
      // 除了第一个元素外，this.lines 其他元素的内容前都有一个换行符
      if (this.shouldNotBreakLine) {
        this.shouldNotBreakLine = false;
      } else {
        if (this.topState?.state === "lineCmd:args") {
          // 遇到换行，说明行命令结束
          this.stateStack.pop();
        }
        this.appendPieces([linefeedPiece]);
      }
    }

    //==== 处理寻找嵌入命令的前缀 ====//
    if (this.topState?.state === "embCmd:expectingPrefix") {
      this.expectSlashForEmbCmd();
      return;
    }

    //==== 处理嵌入命令后续 ====//
    if (
      this.topState?.state === "embCmd:args" ||
      this.topState?.state === "embCmd:failing"
    ) {
      const match = /(?<!\\)\}/.exec(this.curLine);
      const lbIndex = this.curLine.indexOf("{");
      if (match && (lbIndex < 0 || (lbIndex > match.index))) {
        this.appendPieces([this.curLine.slice(0, match.index)]);
        if (this.topState?.state === "embCmd:args") {
          //== 处理嵌入命令的参数 ==//
          this.exitEmbeddedState();
        } else { // this.topState?.state === "embCmd:failing"
          //== 处理嵌入命令匹配失败 ==//
          const topState = this.stateStack.pop();
          if (topState?.state !== "embCmd:failing") throw new Error("never");
          this.appendPieces(["{"]);
          this.appendPieces(topState.content);
          this.appendPieces(["}"]);
        }
        // NOTE: 这里似乎是唯一会改变之后使用到 this.curLine 内容的地方？
        this.linesOfCurPiece[0] = this.curLine.slice(match.index + 1);
        this.shouldNotBreakLine = true;
        return;
      }
    }

    //==== 处理尝试寻找行命令或整体命令 ====//
    if (allowsNestedLineCommand || this.stateStack.length === 0) {
      const canBeIntegratedCommand = this.isFirstPiece &&
        this.isFirstLineOfCurPiece;
      const matchResult = this.matchLineCommandPrefix(canBeIntegratedCommand);
      if (matchResult) { // 处理行命令、整体命令的起始（或全部）部分
        const { matches, prefix, awaitMark } = matchResult;
        if (matches.length === 0) throw new Error("never");
        const rest = this.curLine.substring(
          (prefix ? prefix.length : 0) +
            (awaitMark ? awaitMark.length : 0) +
            longestLength(matches),
        );
        this.appendCommand("line", matches.map((x) => x.value!), {
          prefix,
          isAwait: awaitMark !== null,
        });
        if (rest.length > 0) {
          this.linesOfCurPiece[0] = rest;
          this.shouldNotBreakLine = true;
        } else {
          this.linesOfCurPiece.splice(0, 1);
        }
        return;
      }
    }

    //==== 处理尝试寻找嵌入命令 ====//
    const lbIndex = this.curLine.indexOf("{");
    if (lbIndex >= 0) {
      if (lbIndex > 0) {
        this.appendPieces([this.curLine.substring(0, lbIndex)]);
      }
      this.linesOfCurPiece[0] = this.curLine.substring(lbIndex + 1); // 跳过 "{"
      this.stateStack.push({ state: "embCmd:expectingPrefix", rawLeft: "" });
      this.shouldNotBreakLine = true;
      return;
    }

    if (this.curLine !== "") {
      this.appendPieces([this.curLine]);
    }

    this.linesOfCurPiece.splice(0, 1);
  }

  private exitEmbeddedState() {
    while (true) {
      const topState = this.topState;
      if (topState?.state === "embCmd:args") {
        this.stateStack.pop();
        break;
      } else if (topState?.state === "lineCmd:args") {
        this.stateStack.pop();
      } else {
        throw new Error("never");
      }
    }
  }

  private expectSlashForEmbCmd() {
    const topState = this.topState;
    if (topState?.state !== "embCmd:expectingPrefix") throw new Error("never");

    const slashIndex = this.curLine.indexOf(this.prefix);

    if (slashIndex < 0) { // 没有找到命令前缀
      if (this.curLine.trim() === "") { // 全是空白，可能是在下一行
        topState.rawLeft += this.curLine;
        this.linesOfCurPiece.splice(0, 1);
      } else { // 在前缀之前遇到了其他内容，因此不是命令
        this.stateStack.pop();
        this.stateStack.push({ state: "embCmd:failing", content: [] });
        this.appendPieces([topState.rawLeft]); // FIXME: 加不加这一行效果都一样？！
        this.shouldNotBreakLine = true;
      }
      return;
    }

    this.shouldNotBreakLine = true;

    const beginning = this.curLine.substring(0, slashIndex);
    topState.rawLeft += beginning;
    if (beginning.trim() !== "") {
      // 在左花括号与斜杠间有其他内容，因此不是命令
      this.stateStack.pop();
      this.stateStack.push({ state: "embCmd:failing", content: [] });
      this.appendPieces([topState.rawLeft]);
      this.linesOfCurPiece[0] = this.curLine.substring(slashIndex);
    } else {
      let rest = this.curLine.substring(slashIndex + this.prefix.length);
      const isAwait = rest.startsWith(theAwaitMark);
      if (isAwait) {
        rest = rest.substring(theAwaitMark.length);
      }
      const matches = this.commandTrie.matchPrefix(rest);
      if (matches.length === 0) {
        this.stateStack.pop();
        this.appendPieces(["{" + topState.rawLeft + this.prefix]);
        this.linesOfCurPiece[0] = rest;
      } else {
        const restRest = rest.substring(longestLength(matches));
        this.appendCommand(
          "embedded",
          matches.map((x) => x.value!),
          { prefix: this.prefix, isAwait },
        );
        this.linesOfCurPiece[0] = restRest;
      }
    }
  }

  private tokenizeRemainStates() {
    while (this.stateStack.length > 0) {
      const top = this.stateStack.pop()!;
      switch (top.state) {
        case "lineCmd:args": {
          // noop
          break;
        }
        case "embCmd:expectingPrefix": {
          this.appendPieces(["{" + top.rawLeft]);
          break;
        }
        case "embCmd:args": {
          top.preCommand.isAbandoned = true;
          break;
        }
        default:
          throw new Error("never");
      }
    }
  }

  private get topState(): State | undefined {
    return this.stateStack[this.stateStack.length - 1];
  }

  private appendPieces(
    _pieces: (MessagePieceForTokenizer | string)[],
    args: { isForEmbedded?: boolean } = {},
  ): void {
    let pieces: MessagePieceForTokenizer[] = _pieces
      .map((x) => typeof x === "string" ? text(x) : x);
    args = {
      isForEmbedded: false,
      ...args,
    };

    let targetState = this.topState;
    if (targetState?.state === "embCmd:expectingPrefix") {
      if (args.isForEmbedded!) {
        targetState = this.stateStack[this.stateStack.length - 2];
      } else {
        throw new Error("never");
      }
    }

    if (!targetState) {
      this.tokenizedMessage.push(...pieces);
      return;
    }

    if (targetState.state === "embCmd:failing") {
      targetState.content.push(...pieces);
      return;
    }

    if (
      targetState.state !== "embCmd:args" &&
      targetState.state !== "lineCmd:args"
    ) {
      throw new Error("never");
    }

    const preCmd =
      ((targetState as unknown as any).preCommand as PreCommandPiece);
    if (preCmd.rawArguments.length === 0) {
      // 处理命令开头后、参数前的空白
      const restPieces = [...pieces];
      while (restPieces.length > 0) {
        const piece = restPieces[0];
        let str: string;
        if (piece.type === "text") {
          str = piece.data.text;
        } else if (piece.type === "__kubo_linefeed") {
          str = "\n";
        } else break;
        if (str.trim() === "") {
          preCmd.spaceBeforeArguments += str;
          restPieces.splice(0, 1);
        } else {
          const space = /^\s+/.exec(str);
          if (space) {
            preCmd.spaceBeforeArguments += space[0];
            restPieces[0] = text(str.slice(space[0].length));
          }
          break;
        }
      }
      preCmd.rawArguments.push(...restPieces);
    } else {
      preCmd.rawArguments.push(...pieces);
    }
  }

  private appendCommand(
    style: "line" | "embedded",
    possibleCommands: Parameters<typeof makePreCommandPiece>[0],
    args: {
      prefix: string | null;
      isAwait: boolean;
    },
  ): PreCommandPiece {
    if (style === "embedded" && args.prefix === null) throw new Error("never");
    const preCommand = makePreCommandPiece(possibleCommands, {
      ...args,
      isEmbedded: style === "embedded",
    });
    this.appendPieces([preCommand], { isForEmbedded: style === "embedded" });

    if (style === "line") {
      this.stateStack.push({ "state": "lineCmd:args", preCommand });
    } else {
      if (style !== "embedded") throw new Error("never");
      const topState = this.topState;
      if (topState?.state !== "embCmd:expectingPrefix") {
        throw new Error("never");
      }
      preCommand.rawLeftForEmbedded = topState.rawLeft;
      this.stateStack.pop();
      this.stateStack.push({ "state": "embCmd:args", preCommand });
    }
    return preCommand;
  }

  /**
   * 匹配行命令或整体命令的前缀
   */
  private matchLineCommandPrefix(canBeIntegratedCommand: boolean) {
    let curLine = this.curLine;
    const hasPrefix = curLine.startsWith(this.prefix);
    if (hasPrefix) {
      curLine = curLine.substring(this.prefix.length);
    } else if (!canBeIntegratedCommand) return null;
    let awaitMark: string | null = null;
    if (hasPrefix && curLine.startsWith(theAwaitMark)) {
      awaitMark = theAwaitMark;
      curLine = curLine.substring(awaitMark.length);
    }
    const matches = this.commandTrie.matchPrefix(curLine);
    if (matches.length === 0) return null;
    return { matches, prefix: hasPrefix ? this.prefix : null, awaitMark };
  }
}

function longestLength(matches: ReturnType<CommandTrie["matchPrefix"]>) {
  return matches[matches.length - 1].word.length;
}
