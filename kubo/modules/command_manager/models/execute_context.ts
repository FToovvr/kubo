import { ReplyAt, text } from "../../../../go_cqhttp_client/message_piece.ts";
import {
  mergeAdjoiningTextPiecesInPlace,
} from "../../../../utils/message_utils.ts";
import { CommandEvaluationError } from "../errors.ts";
import { CommandArgument } from "./command_argument.ts";
import { CommandCallbackReturnValue, CommandEntity } from "./command_entity.ts";
import {
  CommandExecutedResult,
  CommandNote,
  ExecutedCommandPiece,
  ExecutedPiece,
  GroupPiece,
  UnexecutedCommandPiece,
} from "./command_piece.ts";
import { MessageEvent } from "../../../../go_cqhttp_client/events.ts";

export interface ExecutionError {
  error: { level: "system" | "user"; content: string };
  commandId: number;
}

/**
 * 一条消息的执行上下文
 */
export class ExecuteContextForMessage {
  nextCommandId = 1;
  // TODO: slotId 由 tokenizer 分配，这样也许能够方便实现预览嵌入命令前后的内容
  nextSlotId = -1;

  #controllers = new Map<number, CommandContextController>();
  slots: { [slotId: number]: { executed: ExecutedCommandPiece | null } } = {};

  pluginContext!: PluginContextForMessage;

  getNextSlotId() {
    const next = this.nextSlotId;
    this.slots[next] = { executed: null };
    this.nextSlotId--;
    return next;
  }

  async tryExecuteCommand(
    slotId: number,
    unexecuted: UnexecutedCommandPiece,
    entity: CommandEntity,
    args: CommandArgument[],
    extra: { lineNumber?: number } = {},
  ): Promise<boolean> {
    const { commandId, context, contextController } = this.makeCommandContext({
      prefix: unexecuted.prefix,
      head: entity.command,
      isEmbedded: unexecuted.isEmbedded,
      shouldAwait: unexecuted.isAwait,
      arguments: args,
      ...(extra.lineNumber !== undefined
        ? { lineNumber: extra.lineNumber }
        : {}),
    });

    let error: ExecutionError["error"] | null = null;
    const cbReturned = await (async () => {
      try {
        return await entity.callback(context, args);
      } catch (e) {
        if (e instanceof CommandEvaluationError) {
          error = { level: "system", content: e.message };
        } else if (e instanceof Error && e.message === "never") {
          throw e;
        } else {
          // TODO: log
          // NOTE: 如果要直接在输出错误信息，应该清理掉信息中的绝对路径，而只使用相对路径
          error = { level: "system", content: "执行命令途中遭遇异常，请参考日志！" };
        }
      }
      return null;
    })();
    contextController.invalidate();

    let result: CommandExecutedResult | null = null;
    if (cbReturned && typeof cbReturned === "object" && "error" in cbReturned) {
      error = { level: "user", content: cbReturned.error };
    } else if (cbReturned) {
      result = processCallbackReturnValue(cbReturned, context) || {};

      if (context.isEmbedded && contextController.hasManuallyClaimed) {
        // TODO: "warn: 嵌入命令手动声明执行命令是无效操作，因为嵌入命令必须返回嵌入内容"
      }
    }
    if (
      context.isEmbedded && (
        (!result && contextController.hasManuallyClaimed) ||
        (result && !result.embedding)
      )
    ) {
      error = { level: "system", content: "嵌入命令未提供嵌入内容" };
      result = null;
    }

    if (result === null && !contextController.hasManuallyClaimed && !error) {
      return false;
    }

    let executed: ExecutedCommandPiece;
    if (error) {
      if (this.slots[slotId]!.executed !== null) {
        if (this.slots[slotId]!.executed!.hasFailed) return false;
        if (!this.slots[slotId]!.executed!.hasFailed) throw new Error("never");
      }
      // 遇到错误，而且是第一个错误

      executed = new ExecutedCommandPiece(entity, {
        context,
        isEmbedded: context.isEmbedded,
        blankAtLeftSide: unexecuted.blankAtLeftSide,
        prefix: unexecuted.prefix,
        shouldAwait: context.shouldAwait,
        arguments: args,
        gapAfterHead: unexecuted.gapAfterHead,
        hasFailed: true,
        result: null,
        notes: [makeNoteFromError(error)],
      });
    } else {
      executed = new ExecutedCommandPiece(entity, {
        context,
        isEmbedded: context.isEmbedded,
        blankAtLeftSide: unexecuted.blankAtLeftSide,
        prefix: unexecuted.prefix,
        shouldAwait: context.shouldAwait,
        arguments: args,
        gapAfterHead: unexecuted.gapAfterHead,
        hasFailed: false,
        result,
        notes: [],
      });
    }
    this.slots[slotId] = { executed };

    return !error;
  }

  getExecutionResult(slotId: number): ExecutedCommandPiece | null {
    const slot = this.slots[slotId];
    if (!slot) throw new Error("never");
    return slot.executed;
  }

  private makeCommandContext(args: CommandContextArguments) {
    const commandId = this.nextCommandId;
    this.nextCommandId++;
    const contextController = new CommandContextController();
    const context = PluginContextForCommand._internal_make(
      this,
      contextController,
      commandId,
      args,
    );

    this.#controllers.set(commandId, contextController);

    return { commandId, context, contextController };
  }
}

interface PluginContextForMessageArguments {
  event: MessageEvent;
  replyAt?: ReplyAt;
}
export class PluginContextForMessage {
  event: MessageEvent;
  replyAt?: ReplyAt;

  constructor(args: PluginContextForMessageArguments) {
    this.event = args.event;
    if (args.replyAt) {
      this.replyAt = args.replyAt;
    }
  }

  get messageId() {
    return this.event.messageId;
  }
  get isInGroupChat() {
    return this.event.messageType === "group";
  }
}

interface CommandContextArguments {
  prefix: string | null;
  head: string;
  isEmbedded: boolean;
  shouldAwait: boolean;

  arguments: CommandArgument[];
  lineNumber?: number; // when !isEmbedded
}

export class PluginContextForCommand {
  private isValid = true;

  get message() {
    return this.executeContext.pluginContext;
  }

  readonly prefix: string | null;
  get hasPrefix() {
    if (this.prefix === "") throw new Error("never");
    return this.prefix !== null;
  }

  readonly head: string;
  /**
   * 被调用时，头部的样子。
   * 目的是在有多个前缀 / 别名时，提示信息中显示的命令能保持调用时的那样。
   *
   * 例：
   * - 命令 `/foo bar` 的 `headInvoked` 是 `/foo`；
   * - 命令 `{ /foo bar }` 的 `headInvoked` 也是 `/foo`；
   */
  get headInvoked() {
    return this.prefix + this.head;
  }

  readonly arguments: CommandArgument[];
  // TODO: test
  getRemainArgumentsAsWhole(begin: number): ExecutedPiece[] | null {
    const remain = this.arguments.slice(begin);
    if (remain.length === 0) return null;
    return new GroupPiece({
      blankAtLeftSide: "",
      parts: remain,
    }).asFlat(false);
  }
  // TODO: public readonly allLines, followingLines

  readonly isEmbedded: boolean;
  readonly shouldAwait: boolean;

  /**
   * 以 1 开始记。
   */
  readonly lineNumber?: number;
  // /**
  //  * 获取命令之后跟随的几行内容。
  //  *
  //  * TODO: test
  //  *
  //  * @param boundary 获取行的界限
  //  *  - "list" 获取紧随其后的列表
  //  *    （列表由紧凑的列表项组成，列表项由 "-" 等开头；暂不支持有序列表）
  //  *  - "until-blank-line" 获取直到空行的内容
  //  *  - "until-line-command" 获取直到下个行命令的内容
  //  *  - "paragraph" 获取直到空行或者下个行命令的内容
  //  *  - "until-end" 获取往后所有行的内容
  //  */
  // getFollowingLines(
  //   boundary:
  //     | "list"
  //     | "until-blank-line"
  //     | "until-line-command"
  //     | "paragraph"
  //     | "until-end",
  // ) {
  //   if (this.isEmbedded) throw new GetFollowingLinesOfEmbeddedMessageError();
  //   const out: ExecutedLine[] = [];

  //   for (const line of this.message.lines.slice(this.lineNumber! - 1 + 1)) {
  //     if (boundary === "list") {
  //       if (line?.[0].type !== "text") break;
  //       const text = line[0].data.text;
  //       if (!/( {0,3}|\t)[-*+]/.test(text)) break;
  //     }

  //     if (
  //       boundary === "until-blank-line" ||
  //       boundary === "paragraph"
  //     ) {
  //       if (line.length === 0) break;
  //       if (line.length === 1 && line[0].type === "text") {
  //         const text = line[0].data.text;
  //         if (/^\s+$/.test(text)) break;
  //       }
  //     }

  //     if (
  //       boundary === "until-line-command" ||
  //       boundary === "paragraph"
  //     ) {
  //       if (line.length === 1 && line[0].type === "__kubo_executed_command") {
  //         break;
  //       }
  //     }

  //     out.push(line);
  //   }

  //   return out;
  // }

  private hasManuallyClaimed = false;

  private constructor(
    private executeContext: ExecuteContextForMessage,
    controller: CommandContextController,
    public readonly _internal_id: number,
    extra: CommandContextArguments,
  ) {
    controller.onInvalidate = () => this.isValid = false;
    controller.getHasManuallyClaimed = () => this.hasManuallyClaimed;

    this.prefix = extra.prefix;
    this.head = extra.head;
    this.isEmbedded = extra.isEmbedded;
    this.shouldAwait = extra.shouldAwait;

    this.arguments = extra.arguments;
    if (this.isEmbedded) {
      if (extra.lineNumber !== undefined) throw new Error("never");
    } else {
      if (extra.lineNumber === undefined) throw new Error("never");
      this.lineNumber = extra.lineNumber;
    }
  }

  static _internal_make(
    executeContext: ExecuteContextForMessage,
    controller: CommandContextController,
    id: number,
    extra: CommandContextArguments,
  ) {
    return new PluginContextForCommand(
      executeContext,
      controller,
      id,
      extra,
    );
  }

  /** 声明该命令已执行（即使作为行命令没有回复内容） */
  claimExecuted() {
    this.hasManuallyClaimed = true;
  }
}

export class CommandContextController {
  onInvalidate!: (() => void);
  getHasManuallyClaimed!: (() => boolean);

  invalidate() {
    this.onInvalidate();
  }

  get hasManuallyClaimed() {
    return this.getHasManuallyClaimed();
  }
}

// TODO: 也许可以单独测试一下这部分代码？
function processCallbackReturnValue(
  cbReturned: CommandCallbackReturnValue,
  extra: { isEmbedded: boolean },
): CommandExecutedResult | null {
  if (typeof cbReturned === "object" && "error" in cbReturned) {
    throw new Error("never");
  } else if (cbReturned === undefined) throw new Error("never");

  if (typeof cbReturned === "string") {
    if (extra.isEmbedded) return { embedding: [text(cbReturned)] };
    return { response: [text(cbReturned)] };
  } else if (Array.isArray(cbReturned)) {
    const copied = [...cbReturned];
    mergeAdjoiningTextPiecesInPlace(copied);
    if (extra.isEmbedded) return { embedding: copied };
    return { response: copied };
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
    return { response: response };
  }
}

function makeNoteFromError(
  error: ExecutionError["error"],
): CommandNote {
  let level: "system-error" | "user-error" = (() => {
    if (error.level === "system") return "system-error";
    if (error.level === "user") return "user-error";
    throw new Error("never");
  })();
  return { level, content: error.content };
}
