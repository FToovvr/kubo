import {
  MessagePiece,
  RegularMessagePiece,
  Text,
  text,
} from "../../go_cqhttp_client/message_piece.ts";
import {
  mergeAdjoiningTextPiecesInPlace,
  MessageLine,
  splitMessageIntoLines,
} from "../../utils/message_utils.ts";
import { KuboBot } from "../bot.ts";
import { CommandEvaluationError } from "./errors.ts";
import { makeCommandContext } from "./models/command_context.ts";
import {
  CommandCallbackReturnValue,
  CommandEntity,
  CommandOptions,
} from "./models/command_entity.ts";
import {
  CommandExecutedResult,
  CommandNote,
  ExecutedCommandPiece,
  makeExecutedCommand,
} from "./models/command_piece_executed.ts";
import { UnexecutedCommandPiece } from "./models/command_piece_unexecuted.ts";
import { tokenizeMessage } from "./tokenizer.ts";
import {
  CommandArgument,
  CommandTrie,
  MessageLineIncludingCommands,
  MessageLineIncludingExecutedCommands,
  MessageLineIncludingUnexecutedCommands,
  MessagePieceIncludingCommand,
  MessagePieceIncludingExecutedCommand,
} from "./types.ts";
import { fillingEmbeddedContent, separateHeadFromMessage } from "./utils.ts";

class ExecutingCommand {
  constructor(
    public readonly id: number,
    // public readonly context: CommandContext,
    // public readonly entity: CommandEntity,
    public readonly options: CommandOptions,
    public executed: ExecutedCommandPiece | null = null,
    public failed = false,
  ) {}
}

export interface CommandResponses {
  contents: RegularMessagePiece[][];
  command: ExecutedCommandPiece;
  hasFailed: boolean;
  notes: CommandNote[];
}

interface BaseBot {
  self: { qq: number };
}

interface EvaluatorContext<Bot extends BaseBot = KuboBot> {
  bot: Bot;
  commandTrie: CommandTrie;
  prefix: string;
}

export function evaluateMessage<Bot extends BaseBot = KuboBot>(
  ctx: EvaluatorContext<Bot>,
  msg: RegularMessagePiece[],
) {
  const evaluator = new MessageEvaluator(ctx, msg);
  const processResult = evaluator.execute();
  const embeddingResult = (() => {
    if (evaluator.hasEmbeddedCommand) {
      return evaluator.generateEmbeddedOutput();
    }
    return null;
  })();
  const responses = evaluator.responses;

  return { processResult, embeddingResult, responses };
}

interface ExecutingError {
  error: { level: "system" | "user"; content: string };
  command: ExecutingCommand;
}

/**
 * 执行消息中的命令。
 *
 * 命令的执行结果会汇集在这里，而不会从这里直接发出去。
 */
class MessageEvaluator<Bot extends BaseBot = KuboBot> {
  private inputMessage: RegularMessagePiece[];
  private parsedMessage: MessageLineIncludingUnexecutedCommands[] | null;
  private firstPass: MessageLineIncludingCommands[] | null = null;
  private finalPass: MessageLineIncludingExecutedCommands[] | null = null;

  private readonly commands: Map<number, ExecutingCommand> = new Map();
  private nextCommandId = 0;
  private getNextId() {
    const now = this.nextCommandId;
    this.nextCommandId++;
    return now;
  }

  get hasCommand() {
    return this.commands.size > 0;
  }
  get hasEmbeddedCommand() {
    for (const [_, exCmd] of this.commands) {
      if (exCmd.options.isEmbedded) return true;
    }
    return false;
  }

  generateEmbeddedOutput() {
    const msg = this.finalPass!.map((x) => [...x, text("\n")]).flat();
    msg.splice(msg.length - 1, 1);
    return fillingEmbeddedContent(msg);
  }

  get executedCommands() {
    return [...this.commands.values()].map((x) => x.executed!);
  }

  get responses(): CommandResponses[] {
    return this.executedCommands
      .map((cmd): CommandResponses => ({
        contents: cmd.result?.responses ?? [],
        command: cmd,
        hasFailed: cmd.hasFailed,
        notes: cmd.notes,
      }))
      .filter((res) => res.contents.length + res.notes.length > 0);
  }

  constructor(
    private context: EvaluatorContext<Bot>,
    msg: RegularMessagePiece[],
  ) {
    this.inputMessage = msg;
    const { cleanedMessage, replyAt, leadingAt } = separateHeadFromMessage(
      this.inputMessage,
    );

    if (leadingAt && Number(leadingAt.data.qq) !== this.context.bot.self.qq) {
      this.parsedMessage = null;
      return;
    }

    this.parsedMessage = tokenizeMessage(context, cleanedMessage);
  }

  execute(): "skip" | "pass" {
    if (!this.parsedMessage) return "skip";
    if (this.firstPass) throw new Error("never");

    this.firstPass = this.executeMessage(this.parsedMessage, "embedded");
    this.finalPass = this.executeMessage(this.firstPass, "line");

    if (!this.hasCommand) return "skip";

    return "pass";
  }

  private executeMessage<
    T extends "line" | "embedded",
    Piece extends (T extends "line" ? MessagePieceIncludingCommand
      : MessagePieceIncludingExecutedCommand),
  >(
    msg: MessageLineIncludingCommands[],
    target: T,
  ) {
    const result: MessageLine<Piece>[] = [];

    for (const [i, line] of msg.entries()) {
      const lineResult = this.executeLine<T, Piece>(line, target, {
        isFirstLine: i === 0,
      });
      result.push(...lineResult);
    }

    return result;
  }

  private executeLine<
    T extends "line" | "embedded",
    Piece extends (T extends "line" ? MessagePieceIncludingCommand
      : MessagePieceIncludingExecutedCommand),
  >(
    line: MessageLineIncludingCommands,
    target: T,
    args: { isFirstLine: boolean },
  ): MessageLine<Piece>[] {
    const resultLines: MessageLine<Piece>[] = [[]];
    function push(
      pieces: MessagePieceIncludingCommand[],
      checksMultiline = false,
    ) {
      if (!checksMultiline) {
        const curLine = resultLines[resultLines.length - 1];
        const curLineLast: Piece | undefined = curLine?.[curLine.length - 1];
        if (pieces?.[0].type === "text" && curLineLast?.type === "text") {
          curLine[curLine.length - 1] = text(
            (curLineLast as Text).data.text + pieces[0].data.text,
          ) as unknown as Piece;
          curLine.push(...pieces.slice(1) as unknown as Piece[]);
        } else {
          curLine.push(...pieces as unknown as Piece[]);
        }
        return;
      }
      const lines = splitMessageIntoLines(pieces);
      push(lines.splice(0, 1)[0]);
      for (const line of lines) {
        resultLines.push([]);
        push(line);
      }
    }

    for (const [i, piece] of line.entries()) {
      if (!(piece instanceof UnexecutedCommandPiece)) {
        push([piece]);
        continue;
      } else {
        const execResult = this.executeCommand(piece, target, {
          isLeading: i === 0,
        });
        if (!execResult) { // 确定了不是命令
          push(piece.raw, true);
        } else if (execResult === "later") { // 优先级比本轮低，因此本轮不执行
          if (target === "line") throw new Error("never");
          push([piece]);
        } else { // ExecutedCommandPiece
          push([execResult]);
        }
      }
    }

    return resultLines;
  }

  private executeCommand(
    uCmd: UnexecutedCommandPiece,
    target: "line" | "embedded",
    args: { isLeading: boolean },
  ): ExecutedCommandPiece | null | "later" {
    if (target === "embedded" && !uCmd.isEmbedded) return "later";
    if (target === "line" && uCmd.isEmbedded) throw new Error("never");

    const firstI = uCmd.possibleCommands.length - 1;
    const firstCmdHead = uCmd.possibleCommands[firstI].command;

    let argumentsWithoutNesting: RegularMessagePiece[][] | null = null;
    let executedArguments: MessageLineIncludingExecutedCommands[] | null = null;

    let execResult: ExecutedCommandPiece | null = null;
    let firstError: ExecutingError | null = null;

    for (let i = firstI; i >= 0; i--) { // 由长至短匹配
      const possCmd = uCmd.possibleCommands[i];
      const isFirst = i === firstI;

      //== 检查候选命令是否支持当前所用的书写形式 ==
      let isSupported = false;
      if (possCmd.supportedStyles.has("embedded")) {
        isSupported ||= uCmd.isEmbedded;
      }
      if (possCmd.supportedStyles.has("line")) {
        isSupported ||= !uCmd.isEmbedded && uCmd.hasPrefix;
      }
      if (possCmd.supportedStyles.has("integrated")) {
        isSupported ||= !uCmd.isEmbedded && !uCmd.hasPrefix;
      }
      if (!isSupported) continue;

      //== 检查候选命令对参数前空白的要求是否与当前相符 ==
      const isSqueezed = !isFirst || uCmd.isSqueezed;
      switch (possCmd.argumentsBeginningPolicy) {
        case "follows-spaces": { // 要求命令开头后、参数前有空白
          if (isSqueezed) continue;
          break;
        }
        case "unrestricted": {
          break;
        }
        default:
          throw new Error("never");
      }

      //== 准备参数列表 ==
      let allowsNestedCommandsInArguments: boolean;
      switch (possCmd.argumentsPolicy) {
        case "parse-all": {
          allowsNestedCommandsInArguments = true;
          if (!executedArguments) {
            executedArguments = this.executeArguments(uCmd.arguments);
          }
          break;
        }
        case "no-nesting": {
          allowsNestedCommandsInArguments = false;
          if (!argumentsWithoutNesting) {
            // TODO: implement
            throw new Error("unimplemented");
          }
          break;
        }
        default:
          throw new Error("never");
      }

      //== 参数列表开头的填充 ==
      const toPrepend = firstCmdHead.substring(possCmd.command.length);
      const cmdArgs = [
        ...(toPrepend.length ? [[text(toPrepend)]] : []),
        ...executedArguments!,
      ];

      const _executedArguments = (() => {
        if (executedArguments) return executedArguments;
        return [];
      })();
      const _execResult = this._executeCommand(possCmd, cmdArgs, {
        executedArguments: _executedArguments,
        isEmbedded: uCmd.isEmbedded,
        shouldAwait: uCmd.isAwait,
        prefix: uCmd.prefix,
        isLeading: args.isLeading,
      });
      if (_execResult) {
        if ("error" in _execResult) {
          if (firstError) continue;
          firstError = _execResult;
          execResult = null;
          continue;
        }
        execResult = _execResult;
        break;
      }
    }

    if (firstError) { // 所有可能的命令都有错误，返回首个执行出错误的命令
      this.commands.set(firstError.command.id, firstError.command);
      if (!execResult) return firstError.command.executed;
    }
    return execResult;
  }

  private _executeCommand(
    cmd: CommandEntity,
    cmdArgs: CommandArgument<false>[] | undefined,
    extra: {
      executedArguments: MessageLineIncludingExecutedCommands[];
      isEmbedded: boolean;
      shouldAwait: boolean;
      prefix: string | null;
      isLeading: boolean;
    },
  ): ExecutedCommandPiece | null | ExecutingError {
    const id = this.getNextId();
    const { context, controller: contextController } = makeCommandContext(
      id,
      /*this,*/ {
        prefix: extra.prefix,
        isEmbedded: extra.isEmbedded,
        shouldAwait: extra.shouldAwait,
      },
    );
    const options = new CommandOptions(context);
    const exCmd = new ExecutingCommand(id, /* context, cmd, */ options);
    this.commands.set(id, exCmd);

    let error: ExecutingError["error"] | null = null;
    let cbReturned: CommandCallbackReturnValue | undefined = undefined;
    try {
      cbReturned = cmd.callback(context, options, cmdArgs);
    } catch (e) {
      if (e instanceof CommandEvaluationError) {
        error = { level: "system", content: e.message };
      } else if (e instanceof Error && e.message === "never") {
        throw e;
      } else {
        error = { level: "system", content: "执行命令途中遭遇异常，请参考日志！" }; // TODO: 日志
      }
    }
    contextController.invalidate();

    let result: CommandExecutedResult | null = null;
    if (typeof cbReturned === "object" && "error" in cbReturned) {
      error = { level: "user", content: cbReturned.error };
    } else if (cbReturned) {
      result = processCallbackReturnValue(cbReturned, extra) || {};

      if (extra.isEmbedded && contextController.hasManuallyClaimed) {
        // TODO: "warn: 嵌入命令手动声明执行命令是无效操作，因为嵌入命令必须返回嵌入内容"
      }
    }
    if (
      extra.isEmbedded &&
      ((!result && contextController.hasManuallyClaimed) ||
        (result && !result.embedding))
    ) {
      error = { level: "system", content: "嵌入命令未提供嵌入内容" };
    }

    if (result === null && !contextController.hasManuallyClaimed && !error) {
      this.commands.delete(id);
      return null;
    }

    const executed = makeExecutedCommand(
      cmd,
      {
        prefix: extra.prefix,
        isEmbedded: extra.isEmbedded,
        shouldAwait: extra.shouldAwait,
        executedArguments: extra.executedArguments,
        isLeading: extra.isLeading,
      },
      result,
      error
        ? [(() => {
          let level: "system-error" | "user-error" = (() => {
            if (error.level === "system") return "system-error";
            if (error.level === "user") return "user-error";
            throw new Error("never");
          })();
          return { level, content: error.content };
        })()]
        : [],
      !!error,
    );
    exCmd.executed = executed;
    if (error) {
      this.commands.delete(id);
      exCmd.failed = true;
      return { error, command: exCmd };
    }
    return executed;
  }

  private executeArguments(
    args: MessageLineIncludingCommands[],
  ): MessageLineIncludingExecutedCommands[] {
    return this.executeMessage(
      args,
      "embedded",
    ) as MessageLineIncludingExecutedCommands[];
  }
}

// // XXX: 废弃时发现有 bug，不改了
// function prependingTextToArguments<
//   T extends MessagePiece | RegularMessagePiece,
// >(
//   args: T[][],
//   textToPrepend: string,
// ) {
//   if (textToPrepend === "") return args;

//   args = [...args];
//   if (args.length > 0) {
//     args[0] = prependingTextToArgument(args[0], textToPrepend);
//   }
//   return args;
// }

function prependingTextToArgument<T extends MessagePiece | RegularMessagePiece>(
  arg: T[],
  textToPrepend: string,
): T[] {
  if (arg.length === 0) return [text(textToPrepend) as T];
  if (arg[0].type === "text") {
    return [
      text(textToPrepend + (arg[0] as unknown as Text).data.text) as T,
      ...arg.slice(1),
    ];
  }
  return [text(textToPrepend) as T, ...arg];
}

function processCallbackReturnValue(
  cbReturned: CommandCallbackReturnValue,
  extra: { isEmbedded: boolean },
): CommandExecutedResult | null {
  if (typeof cbReturned === "object" && "error" in cbReturned) {
    throw new Error("never");
  } else if (cbReturned === undefined) throw new Error("never");

  if (typeof cbReturned === "string") {
    if (extra.isEmbedded) return { embedding: [text(cbReturned)] };
    return { responses: [[text(cbReturned)]] };
  } else if (Array.isArray(cbReturned)) {
    const copied = [...cbReturned];
    mergeAdjoiningTextPiecesInPlace(copied);
    if (extra.isEmbedded) return { embedding: copied };
    return { responses: [copied] };
  }
  if (extra.isEmbedded) {
    if (!cbReturned!.embedding) return null;
    const embedding = typeof cbReturned!.embedding === "string"
      ? [text(cbReturned!.embedding)]
      : cbReturned!.embedding;
    mergeAdjoiningTextPiecesInPlace(embedding);
    return {
      embedding,
      ...(cbReturned!.embeddingRaw
        ? { embeddingRaw: cbReturned?.embeddingRaw }
        : {}),
    };
  } else {
    if (!cbReturned!.response) return null;
    const response = typeof cbReturned!.response === "string"
      ? [text(cbReturned!.response)]
      : cbReturned!.response;
    mergeAdjoiningTextPiecesInPlace(response);
    return { responses: [response] };
  }
}
