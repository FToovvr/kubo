import {
  RegularMessagePiece,
  text,
} from "../../../../go_cqhttp_client/message_piece.ts";
import {
  mergeAdjoiningTextPiecesInPlace,
} from "../../../../utils/message_utils.ts";
import { theAwaitMark } from "../constants.ts";
import { CommandArgument } from "./command_argument.ts";
import { CommandEntity } from "./command_entity.ts";
import {
  ExecuteContextForMessage,
  PluginContextForCommand,
} from "./execute_context.ts";

export interface ComplexPiecePart<HasExecuted extends boolean = false> {
  content:
    | RegularMessagePiece
    | CompactComplexPiece<HasExecuted>
    | GroupPiece<HasExecuted>
    | (HasExecuted extends true ? ExecutedCommandPiece
      : UnexecutedCommandPiece);
  gapAtRight: string;
}
export type UnexecutedPiece = ComplexPiecePart<false>["content"];
export type ExecutedPiece = ComplexPiecePart<true>["content"];

export function reconstructFromComplexPieceParts<
  HasExecuted extends boolean = false,
>(parts: ComplexPiecePart<HasExecuted>[]) {
  const rawParts = parts.flatMap((part) => {
    if (part.content.type === "text") {
      return [text(part.content.data.text + part.gapAtRight)];
    } else if (part.content.type === "__kubo_compact_complex") {
      const rawParts = part.content.asRaw();
      if (!rawParts.length) throw new Error("never");
      const lastRawPart = rawParts[rawParts.length - 1];
      if (lastRawPart.type === "text") {
        rawParts[rawParts.length - 1] = text(
          lastRawPart.data.text + part.gapAtRight,
        );
      } else {
        rawParts.push(text(part.gapAtRight));
      }
      return rawParts;
    }
    return [part.content, text(part.gapAtRight)];
  });
  return rawParts;
}

abstract class BaseCommandPiece<HasExecuted extends boolean> {
  abstract get type(): HasExecuted extends true ? "__kubo_executed_command"
    : "__kubo_unexecuted_command";

  abstract get headCommand(): CommandEntity;

  abstract get isEmbedded(): boolean;
  abstract get blankAtLeftSide(): string | undefined;
  abstract get prefix(): string | null;
  abstract get isAwait(): boolean;

  abstract get arguments(): ComplexPiecePart<HasExecuted>[];
  abstract get gapAfterHead(): string;

  protected async _asRaw<
    HasExecuted extends boolean,
    Piece extends (
      | ExecutedPiece
      | RegularMessagePiece
    ) = (HasExecuted extends true ? ExecutedPiece : RegularMessagePiece),
  >(
    execContext: HasExecuted extends true ? ExecuteContextForMessage : null,
    args: { noOuterBrackets?: boolean } = {},
  ): Promise<Piece[]> {
    const rawParts: Piece[] = [];

    if (this.isEmbedded) {
      if (this.blankAtLeftSide === undefined) throw new Error("never");
      if (!(args.noOuterBrackets ?? false)) {
        rawParts.push(text("{" + this.blankAtLeftSide) as Piece);
      }
    } else {
      if (this.blankAtLeftSide !== undefined) throw new Error("never");
    }

    if (this.prefix) {
      rawParts.push(text(this.prefix) as Piece);
    }
    rawParts.push(
      text(
        this.headCommand.command,
      ) as Piece,
    );
    rawParts.push(text(this.gapAfterHead) as Piece);

    if (this.isAwait) {
      rawParts.push(text(theAwaitMark) as Piece);
    }

    const preRawParts = reconstructFromComplexPieceParts(this.arguments);
    for (const preRawPart of preRawParts) {
      if (preRawPart.type === "__kubo_group") {
        if (execContext) {
          rawParts.push(await preRawPart.execute(execContext) as Piece);
        } else {
          rawParts.push(...await preRawPart._internal_asRaw() as Piece[]);
        }
      } else if (preRawPart.type === "__kubo_unexecuted_command") {
        if (execContext) {
          rawParts.push(await preRawPart.execute(execContext) as Piece);
        } else {
          rawParts.push(...await preRawPart.asRaw() as Piece[]);
        }
      } else if (preRawPart.type === "__kubo_executed_command") {
        if (execContext) throw new Error("never");
        rawParts.push(...await preRawPart.asRaw() as Piece[]);
      } else {
        rawParts.push(preRawPart as Piece);
      }
    }

    if (this.isEmbedded) {
      if (args.noOuterBrackets ?? false) {
        if (!rawParts.length) throw new Error("never");
        const lastPart = rawParts[rawParts.length - 1];
        if (lastPart.type === "text") {
          rawParts[rawParts.length - 1] = text(
            lastPart.data.text.trimEnd(),
          ) as Piece;
        }
      } else {
        rawParts.push(text("}") as Piece);
      }
    }

    mergeAdjoiningTextPiecesInPlace(rawParts);
    return rawParts;
  }
}

export class UnexecutedCommandPiece extends BaseCommandPiece<false> {
  readonly type = "__kubo_unexecuted_command" as const;

  possibleCommands: CommandEntity[];
  get headCommand() {
    return this.possibleCommands[this.possibleCommands.length - 1];
  }

  isEmbedded: boolean;
  // 本来应该是 `blankAtLeftSide?: string`，但由于配置的缘故，改写成这样
  blankAtLeftSide: string | undefined;
  prefix: string | null;
  get hasPrefix() {
    return this.prefix !== null;
  }
  isAwait: boolean;

  arguments: ComplexPiecePart[];
  gapAfterHead: string;

  constructor(
    args:
      & {
        possibleCommands: CommandEntity[];

        isAwait: boolean;

        rawArguments: ComplexPiecePart[];
        gapAfterHead: string;
      }
      & ({
        type: "embedded";
        blankAtLeftSide: string;
        prefix: string;
      } | {
        type: "line";
        prefix: string | null;
      }),
  ) {
    super();

    this.possibleCommands = args.possibleCommands;
    this.isAwait = args.isAwait;
    this.arguments = args.rawArguments;
    this.gapAfterHead = args.gapAfterHead;

    if (args.type === "embedded") {
      this.isEmbedded = true;
      this.blankAtLeftSide = args.blankAtLeftSide;
    } else {
      if (args.type !== "line") throw new Error("never");
      this.isEmbedded = false;
    }
    this.prefix = args.prefix;
    if (this.prefix === "") throw new Error("never");
  }

  get isSqueezed() {
    if (this.arguments.length === 0) return false;
    if (this.arguments[0].content.type !== "text") return false;
    return this.gapAfterHead.length === 0;
  }

  /**
   * NOTE: 在规划上， UnexecutedCommand 的 asRaw 是用不上的。
   *       因为要保证所有的命令都被执行。
   */
  async asRaw(): Promise<RegularMessagePiece[]> {
    return await this._asRaw<false>(null);
  }

  async asLineExecuted(execContext: ExecuteContextForMessage) {
    if (this.isEmbedded) throw new Error("never");
    return await this._asRaw<true>(execContext);
  }

  // 执行失败时退化成组
  async asGroupExecuted(execContext: ExecuteContextForMessage) {
    if (!this.isEmbedded) throw new Error("never");
    const parts = [...await this.executeArguments(execContext)];
    const prefix = this.prefix ?? "";
    if (
      this.gapAfterHead === "" &&
      parts.length > 0
    ) {
      if (parts[0].content.type === "text") {
        parts[0] = {
          content: text(prefix + this.fullHead + parts[0].content.data.text),
          gapAtRight: parts[0].gapAtRight,
        };
      } else if (parts[0].content.type === "__kubo_compact_complex") {
        const complex = parts[0].content;
        const [headText, remain] = (() => {
          if (complex.parts[0].type === "text") {
            return [complex.parts[0].data.text, complex.parts.slice(1)];
          }
          return ["", complex.parts];
        })();
        parts[0] = {
          content: new CompactComplexPiece([
            text(prefix + this.fullHead + headText),
            ...remain,
          ]),
          gapAtRight: parts[0].gapAtRight,
        };
      } else {
        parts[0] = {
          content: new CompactComplexPiece([
            text(prefix + this.fullHead),
            parts[0].content,
          ]),
          gapAtRight: parts[0].gapAtRight,
        };
      }
    } else {
      parts.splice(0, 0, {
        content: text(prefix + this.fullHead),
        gapAtRight: this.gapAfterHead,
      });
    }
    return new GroupPiece<true>({
      blankAtLeftSide: this.blankAtLeftSide!,
      parts: parts,
    });
  }

  get fullHead() {
    return this.possibleCommands[this.possibleCommands.length - 1].command;
  }

  #executedCache: ExecutedCommandPiece | null | undefined = undefined;
  async execute(
    execContext: ExecuteContextForMessage,
    extra: { lineNumber?: number } = {},
  ): Promise<ExecutedCommandPiece | null> {
    if (this.#executedCache !== undefined) return this.#executedCache;

    const slotId = execContext.getNextSlotId();

    // 由长至短匹配
    const candidates = [...this.possibleCommands].reverse();
    if (candidates.length === 0) throw new Error("never");
    const fullHead = candidates[0].command;
    if (fullHead !== this.fullHead) throw new Error("never");

    const executedArguments = await this.executeArguments(execContext);

    for (const [i, candidate] of candidates.entries()) {
      //== 检查候选命令是否支持当前所用的书写形式 ==
      let isSupported = false;
      let supportedStyleCount = 0;
      if (candidate.supportedStyles.has("line")) {
        supportedStyleCount++;
        isSupported ||= !this.isEmbedded && this.hasPrefix;
      }
      if (candidate.supportedStyles.has("embedded")) {
        supportedStyleCount++;
        isSupported ||= this.isEmbedded && this.hasPrefix;
      }
      if (candidate.supportedStyles.size !== supportedStyleCount) {
        throw new Error("never");
      }
      if (!isSupported) continue;

      //== 检查候选命令对参数前空白的要求是否与当前相符 ==
      const isSqueezed = i > 0 || this.isSqueezed;
      if (candidate.argumentsBeginningPolicy === "follows-spaces") {
        if (isSqueezed) continue;
      } else {
        if (candidate.argumentsBeginningPolicy !== "unrestricted") {
          throw new Error("never");
        }
      }

      //== 参数列表开头的填充 ==
      const toPrepend = fullHead.substring(candidate.command.length);
      const cmdArgs = [...executedArguments];
      if (toPrepend.length) {
        let hasPrepended = false;
        if (this.gapAfterHead.length) {
          // noop, 让兜底来处理
        } else if (cmdArgs.length > 0) {
          if (cmdArgs[0].content.type === "text") {
            cmdArgs[0] = {
              content: text(toPrepend + cmdArgs[0].content.type),
              gapAtRight: cmdArgs[0].gapAtRight,
            };
            hasPrepended = true;
          } else if (cmdArgs[0].content.type === "__kubo_compact_complex") {
            cmdArgs[0] = {
              content: new CompactComplexPiece(((parts) => {
                if (parts[0].type === "text") {
                  return [
                    text(toPrepend + parts[0].data.text),
                    ...parts.slice(1),
                  ];
                }
                return [text(toPrepend), ...parts];
              })(cmdArgs[0].content.parts)),
              gapAtRight: cmdArgs[0].gapAtRight,
            };
          }
        }
        if (!hasPrepended) {
          cmdArgs.splice(0, 0, {
            content: text(toPrepend),
            gapAtRight: this.gapAfterHead,
          });
        }
      }

      const succeeded = await execContext.tryExecuteCommand(
        slotId,
        this,
        candidate,
        executedArguments.map((rawArg) => new CommandArgument(rawArg)),
        {
          ...(extra.lineNumber !== undefined
            ? { lineNumber: extra.lineNumber }
            : {}),
        },
      );

      if (succeeded) {
        break;
      }
    }

    this.#executedCache = execContext.getExecutionResult(slotId);
    return this.#executedCache;
  }

  async executeOrAsGroup(execContext: ExecuteContextForMessage) {
    const executed = await this.execute(execContext);
    if (executed) return executed;
    return this.asGroupExecuted(execContext);
  }

  #executedArgumentsCache: ComplexPiecePart<true>[] | undefined = undefined;
  async executeArguments(
    execContext: ExecuteContextForMessage,
  ): Promise<ComplexPiecePart<true>[]> {
    if (this.#executedArgumentsCache !== undefined) {
      return this.#executedArgumentsCache;
    }

    this.#executedArgumentsCache = [];
    for (const part of this.arguments) {
      this.#executedArgumentsCache.push({
        content: await executeUnexecutedNonLinePiece(
          execContext,
          part.content,
        ),
        gapAtRight: part.gapAtRight,
      });
    }

    return this.#executedArgumentsCache;
  }
}

// 由多个不同类型的 piece 组成，如命令参数中的 "foo=@xxx"
export class CompactComplexPiece<HasExecuted extends boolean = false> {
  readonly type = "__kubo_compact_complex" as const;

  constructor(
    public parts: (
      | RegularMessagePiece
      | GroupPiece<HasExecuted>
      | (HasExecuted extends true ? ExecutedCommandPiece
        : UnexecutedCommandPiece)
    )[],
  ) {
    if (parts.length < 2) throw new Error("never");
  }

  asRaw() {
    return [...this.parts];
  }

  async execute(
    execContext: ExecuteContextForMessage,
  ): Promise<CompactComplexPiece<true>> {
    const executedParts = [];
    for (const part of this.parts) {
      if (part.type === "__kubo_executed_command") throw new Error("never");
      if (part.type === "__kubo_unexecuted_command") {
        executedParts.push(await part.executeOrAsGroup(execContext));
      } else if (part.type === "__kubo_group") {
        executedParts.push(await part.execute(execContext));
      } else {
        executedParts.push(part);
      }
    }
    return new CompactComplexPiece<true>(executedParts);
  }

  generateEmbeddedOutput() {
    // XXX: 应该限制一下只有执行后的 CompactComplexPiece 才能调用本方法，
    //      但目前办不到。
    return generateEmbeddedOutput(this.parts as ExecutedPiece[]);
  }
}

// 由左右花括号及其中内容组成，如 "{ foo bar }"
// TODO: 也许应该把 blankAtLeftSide + parts 恢复成连贯的消息内容？
export class GroupPiece<HasExecuted extends boolean = false> {
  readonly type = "__kubo_group";

  blankAtLeftSide: string;

  parts: ComplexPiecePart<HasExecuted>[];

  constructor(args: {
    blankAtLeftSide: string;
    parts: ComplexPiecePart<HasExecuted>[];
  }) {
    this.blankAtLeftSide = args.blankAtLeftSide;
    this.parts = args.parts;
  }

  async _internal_asRaw() {
    const rawParts: RegularMessagePiece[] = [];

    rawParts.push(text("{" + this.blankAtLeftSide));

    const preRawParts = reconstructFromComplexPieceParts(this.parts);
    for (const preRawPart of preRawParts) {
      if (preRawPart.type === "__kubo_group") {
        rawParts.push(...await preRawPart._internal_asRaw());
      } else if (
        preRawPart.type === "__kubo_unexecuted_command" ||
        preRawPart.type === "__kubo_executed_command"
      ) {
        rawParts.push(...await preRawPart.asRaw());
      } else {
        rawParts.push(preRawPart);
      }
    }

    rawParts.push(text("}"));

    mergeAdjoiningTextPiecesInPlace(rawParts);
    return rawParts;
  }

  // TODO: test
  // FIXME: 没有处理合并 CompactComplexPiece 的情况
  asFlat(withOuterBrackets = true): ComplexPiecePart<HasExecuted>["content"][] {
    const flat = [];
    if (withOuterBrackets) {
      flat.push(text("{"));
    }
    flat.push(...this.parts.flatMap((part) => {
      return [part.content, text(part.gapAtRight)];
    }));
    if (withOuterBrackets) {
      flat.push(text("}"));
    }
    mergeAdjoiningTextPiecesInPlace(flat);
    return flat;
  }

  async execute(
    execContext: ExecuteContextForMessage,
  ): Promise<GroupPiece<true>> {
    const executedParts: ComplexPiecePart<true>[] = [];
    for (const part of this.parts) {
      const type = part.content.type;
      if (type === "__kubo_executed_command") throw new Error("never");
      if (type === "__kubo_unexecuted_command") {
        executedParts.push({
          content: await part.content.executeOrAsGroup(execContext),
          gapAtRight: part.gapAtRight,
        });
      } else if (
        type === "__kubo_compact_complex" ||
        type === "__kubo_group"
      ) {
        executedParts.push({
          content: await part.content.execute(execContext),
          gapAtRight: part.gapAtRight,
        });
      } else {
        executedParts.push(part as ComplexPiecePart<true>);
      }
    }
    return new GroupPiece<true>({
      blankAtLeftSide: this.blankAtLeftSide,
      parts: executedParts,
    });
  }

  generateEmbeddedOutput() {
    // XXX: 应该限制一下只有执行后的 CompactComplexPiece 才能调用本方法，
    //      但目前办不到。
    return generateEmbeddedOutput(this.asFlat() as ExecutedPiece[]);
  }
}

export class ExecutedCommandPiece extends BaseCommandPiece<true> {
  readonly type = "__kubo_executed_command" as const;

  // NOTE: 用 # 藏起来是为了方便测试，应该有更好的处理方法。
  #context: PluginContextForCommand;
  get context() {
    return this.#context;
  }

  get headCommand() {
    return this.command;
  }

  isEmbedded: boolean;
  blankAtLeftSide: string | undefined;
  prefix: string | null;
  shouldAwait: boolean;
  get isAwait() {
    return this.shouldAwait;
  }

  arguments: CommandArgument[];
  gapAfterHead: string;

  hasFailed: boolean;
  result: CommandExecutedResult | null;
  notes: CommandNote[];

  constructor(
    public command: CommandEntity,
    args: {
      context: PluginContextForCommand;

      isEmbedded: boolean;
      blankAtLeftSide: string | undefined;
      prefix: string | null;
      shouldAwait: boolean;

      arguments: CommandArgument[];
      gapAfterHead: string;

      hasFailed: boolean;
      result: CommandExecutedResult | null;
      notes: CommandNote[];
    },
  ) {
    super();

    this.#context = args.context;

    this.isEmbedded = args.isEmbedded;
    this.blankAtLeftSide = args.blankAtLeftSide;
    this.prefix = args.prefix;
    this.shouldAwait = args.shouldAwait;

    this.arguments = args.arguments;
    this.gapAfterHead = args.gapAfterHead;

    this.hasFailed = args.hasFailed;
    this.result = args.result;
    this.notes = args.notes;
  }

  get isLeading() {
    if (this.isEmbedded) return false;
    return this.context.lineNumber === 1;
  }

  async asRaw(
    args: { noOuterBrackets?: boolean } = {},
  ): Promise<RegularMessagePiece[]> {
    return await this._asRaw<false>(null, args);
  }

  asFlat(): ComplexPiecePart<true>["content"][] {
    if (this.isEmbedded) throw new Error("never");
    const flat = [
      text(this.command.command + this.gapAfterHead),
      ...this.arguments.flatMap((part) => {
        return [part.content, text(part.gapAtRight)];
      }),
    ];
    mergeAdjoiningTextPiecesInPlace(flat);
    return flat;
  }

  generateEmbeddedOutput() {
    const out: RegularMessagePiece[] = [];

    if (this.isEmbedded) {
      let embedding: RegularMessagePiece[] = [];
      if (this.hasFailed) {
        // TODO: 提供更多信息？
        const errorMessage = `${this.prefix}${this.command.command}⇒error`;
        embedding = [text(errorMessage)];
      } else {
        if (!this.result?.embedding) throw new Error("never");
        embedding = this.result.embedding;
      }

      const leftBound = (() => {
        let bound = "";
        bound += "«";
        const firstTextInEmbedding = (embedding[0].type === "text"
          ? embedding[0].data.text
          : null);
        if (!firstTextInEmbedding || !/^\s/.test(firstTextInEmbedding)) {
          bound += " ";
        }
        return text(bound);
      })();

      const rightBound = (() => {
        let bound = "";
        const lastTextInEmbedding = (() => {
          const last = embedding[embedding.length - 1];
          return (last.type === "text" ? last.data.text : null);
        })();
        if (!lastTextInEmbedding || !/\s$/.test(lastTextInEmbedding)) {
          bound += " ";
        }
        bound += "»";
        return text(bound);
      })();

      out.push(leftBound, ...embedding, rightBound);
    } else {
      out.push(...generateEmbeddedOutput(this.asFlat()));
    }
    return out;
  }

  async generatePreview() {
    const preview: RegularMessagePiece[] = [];

    let qi = 10;

    if (this.isEmbedded) {
      const blankAtLeftSide = (this.blankAtLeftSide! ? " " : "");
      preview.push(text("… {" + blankAtLeftSide));
    }

    const rawPieces = await this.asRaw({ noOuterBrackets: true });
    OUT:
    for (const piece of rawPieces) {
      if (qi <= 0) {
        qi = -Infinity;
        break;
      }

      switch (piece.type) {
        case "text": {
          let chars = "";
          let charsWeight = 0;
          let lastIsSpace = false;
          for (let char of [...piece.data.text]) {
            if (/\s/.test(char)) {
              if (lastIsSpace) continue;
              char = " ";
              lastIsSpace = true;
            } else {
              lastIsSpace = false;
            }
            const isAscii = /^[\x00-\x7F]$/.test(char);
            const charWeight = isAscii ? 0.5 : 1;
            charsWeight += charWeight;
            if (qi - charsWeight >= 0) {
              chars += char;
            } else {
              break;
            }
          }
          preview.push(text(chars));
          qi -= charsWeight;
          break;
        }
        case "at": {
          if (qi - 3 >= 0) {
            preview.push(text("[at]"));
          }
          qi -= 3;
          break;
        }
        case "face": {
          if (qi - 2 >= 0) {
            preview.push(piece);
          }
          qi -= 2;
          break;
        }
        default: {
          qi = -Infinity;
          break OUT;
        }
      }
    }

    if (qi < 0) { // 不完整
      if (this.isEmbedded) {
        preview.push(text("…"));
      } else {
        preview.push(text("…"));
      }
    }

    if (this.isEmbedded) {
      const lastGap = (() => {
        if (!this.arguments.length) return this.gapAfterHead;
        const gap = this.arguments[this.arguments.length - 1].gapAtRight;
        return (gap === "" ? "" : " ");
      })();
      preview.push(text(lastGap + "} …"));
    }

    mergeAdjoiningTextPiecesInPlace(preview);

    return preview;
  }
}

export interface EmbeddingRaw {
  value: any;
  [key: string]: any;
}

export interface CommandExecutedResult {
  embedding?: RegularMessagePiece[];
  embeddingRaw?: EmbeddingRaw;

  response?: RegularMessagePiece[];
}

export interface CommandNote {
  level: "system-warn" | "system-error" | "user-error";
  content: string;
}

/**
 * NOTE: 不能是行命令
 */
export async function executeUnexecutedNonLinePiece(
  executeContext: ExecuteContextForMessage,
  unexecutedPiece: UnexecutedPiece,
) {
  if (unexecutedPiece.type === "__kubo_unexecuted_command") {
    if (!unexecutedPiece.isEmbedded) throw new Error("never");
    return await unexecutedPiece.executeOrAsGroup(executeContext);
  } else if (
    unexecutedPiece.type === "__kubo_compact_complex" ||
    unexecutedPiece.type === "__kubo_group"
  ) {
    return await unexecutedPiece.execute(executeContext);
  } else {
    return unexecutedPiece;
  }
}

export function generateEmbeddedOutput(pieces: ExecutedPiece[]) {
  const out: RegularMessagePiece[] = [];

  for (const [i, piece] of pieces.entries()) {
    switch (piece.type) {
      case "__kubo_executed_command": {
        if (piece.isEmbedded && i > 0) {
          const prevPiece = pieces[i - 1];
          if (prevPiece.type === "text" && !/\s$/.test(prevPiece.data.text)) {
            out.push(text(" "));
          }
        }

        out.push(...piece.generateEmbeddedOutput());

        if (piece.isEmbedded && i < pieces.length - 1) {
          const nextPiece = pieces[i + 1];
          if (nextPiece.type === "text" && !/^\s/.test(nextPiece.data.text)) {
            out.push(text(" "));
          }
        }
        break;
      }
      case "__kubo_compact_complex":
      case "__kubo_group": {
        out.push(...piece.generateEmbeddedOutput());
        break;
      }
      default: {
        out.push(piece);
        break;
      }
    }
  }

  mergeAdjoiningTextPiecesInPlace(out);

  return out;
}
