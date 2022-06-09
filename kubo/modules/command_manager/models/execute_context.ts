import { ReplyAt, text } from "../../../../go_cqhttp_client/message_piece.ts";
import {
  mergeAdjoiningTextPiecesInPlace,
} from "../../../../utils/message_utils.ts";
import {
  CommandEvaluationError,
  GetFollowingLinesOfEmbeddedMessageError,
} from "../errors.ts";
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
import {
  MessageEvent,
  MessageOfGroupEvent,
} from "../../../../go_cqhttp_client/events.ts";
import { KuboBot } from "../../../index.ts";
import { ExecutedLine } from "../types.ts";

interface ExecutionFailure {
  error: {
    level: "system-error" | "user-error" | "system-warn";
    content: string;
  };
}

/**
 * 一条消息的执行上下文
 */
export class ExecuteContextForMessage {
  nextCommandId = 1;
  // TODO: slotId 由 tokenizer 分配，这样也许能够方便实现预览嵌入命令前后的内容
  nextSlotId = -1;

  #controllers = new Map<number, CommandContextController>();
  slots: {
    [slotId: number]: {
      slotId: number;
      executedCommands: ExecutedCommandPiece[];
    };
  } = {};

  pluginContext!: PluginContextForMessage;

  getNextSlotId() {
    const next = this.nextSlotId;
    this.slots[next] = { slotId: next, executedCommands: [] };
    this.nextSlotId--;
    return next;
  }

  async tryExecuteCommand(
    slotId: number,
    unexecuted: UnexecutedCommandPiece,
    entity: CommandEntity,
    args: CommandArgument[],
    extra: {
      isSqueezed: boolean;
      lineCmdExtra?: {
        lineCmdCount: number;
        lineNumber: number;
        followingLines: ExecutedLine[];
      };
    },
  ): Promise<boolean> {
    if (
      (unexecuted.isEmbedded && extra.lineCmdExtra) ||
      (!unexecuted.isEmbedded && !extra.lineCmdExtra)
    ) {
      throw new Error("never");
    }

    const { commandId, context, contextController } = this.makeCommandContext({
      prefix: unexecuted.prefix,
      head: entity.command,
      isEmbedded: unexecuted.isEmbedded,
      shouldAwait: unexecuted.isAwait,
      arguments: args,
      ...(extra.lineCmdExtra !== undefined
        ? { lineCmdExtra: extra.lineCmdExtra }
        : {}),
    });

    let error: ExecutionFailure["error"] | null = null;

    if (!error && !checkCommandStyle(entity, unexecuted)) {
      const currentStyle = unexecuted.isEmbedded ? "…{/嵌入}…" : "（行首）/整行（行尾）";
      const supportedStyles = [...entity.supportedStyles.values()]
        .map((s) => { // TODO: 改成专门的通用函数放在某处
          if (s === "embedded") return "…{/嵌入}…";
          if (s === "line") return "（行首）/整行（行尾）";
          throw new Error("never");
        })
        .join("、");
      let warnContent =
        `该命令不支持所用的书写形式（${currentStyle}）。 可用的书写形式：${supportedStyles}。`;
      error = { level: "system-warn", content: warnContent };
    }

    if (!error && !checkArgumentsBeginningPolicy(entity, extra.isSqueezed)) {
      if (entity.argumentsBeginningPolicy !== "follows-spaces") {
        throw new Error("never");
      }
      error = { level: "system-warn", content: "该命令开头与参数之间需要留有空白。" };
    }

    if (!error && !unexecuted.isEmbedded && entity.isExclusive) {
      const warnContents: string[] = [];
      if (
        entity.isExclusive === "leading" &&
        extra.lineCmdExtra!.lineNumber! > 1
      ) {
        warnContents.push("只支持置于消息的最开头（无视掉引用和 at）");
      }
      if (entity.isExclusive && extra.lineCmdExtra!.lineCmdCount! !== 1) {
        warnContents.push("必须是消息中唯一的整行命令");
      }

      if (warnContents.length) {
        const warnContent = "该命令" + warnContents.join("，且") + "。";
        error = { level: "system-warn", content: warnContent };
      }
    }

    let cbReturned: CommandCallbackReturnValue | null;
    if (!error) {
      cbReturned = await (async () => {
        try {
          // TODO: 整个执行过程中似乎纯粹是这里导致执行相关的函数需要异步？
          //       可以考虑在实现等待型命令的时候一起实现，只不过从外部看更加透明
          return await entity.callback(context, args);
        } catch (e) {
          if (e instanceof CommandEvaluationError) {
            error = { level: "system-error", content: e.message };
          } else if (e instanceof Error && e.message === "never") {
            throw e;
          } else {
            // TODO: log
            // NOTE: 如果要直接在输出错误信息，应该清理掉信息中的绝对路径，而只使用相对路径
            error = { level: "system-error", content: "执行命令途中遭遇异常，请参考日志！" };
          }
        }
        return null;
      })();
    } else {
      cbReturned = null;
    }
    contextController.invalidate();

    let result: CommandExecutedResult | null = null;
    if (cbReturned && typeof cbReturned === "object" && "error" in cbReturned) {
      error = { level: "user-error", content: cbReturned.error };
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
      error = { level: "system-error", content: "嵌入命令未提供嵌入内容" };
      result = null;
    }

    if (result === null && !contextController.hasManuallyClaimed && !error) {
      return false;
    }

    let executed: ExecutedCommandPiece;
    if (error) {
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
    const slot = this.slots[slotId];
    if (!slot) throw new Error("never");
    slot.executedCommands.push(executed);

    return !error;
  }

  getExecutionResult(slotId: number): ExecutedCommandPiece | null {
    const slot = this.slots[slotId];
    if (!slot) throw new Error("never");

    let qualified: ExecutedCommandPiece | null = null;
    let lastHasFailed: false | "error" | "warn" | null = null;
    // 完整地迭代一遍，以预防有两个命令候选被执行的情况
    for (const executed of slot.executedCommands) {
      if (!executed.hasFailed) {
        if (qualified && !qualified.hasFailed) throw new Error("never");
        qualified = executed;
        lastHasFailed = false;
      } else {
        if (lastHasFailed !== null && !lastHasFailed) continue;
        let hasFailedJustForSysWarn = true;
        for (const note of executed.notes) {
          if (note.level !== "system-warn") {
            hasFailedJustForSysWarn = false;
          }
        }
        if (hasFailedJustForSysWarn && lastHasFailed === "error") continue;
        qualified = executed;
        lastHasFailed = hasFailedJustForSysWarn ? "warn" : "error";
      }
    }

    return qualified;
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
  bot: KuboBot;
  event: MessageEvent;
  replyAt?: ReplyAt;
}
export class PluginContextForMessage {
  bot: KuboBot;
  event: MessageEvent;
  replyAt?: ReplyAt;

  constructor(args: PluginContextForMessageArguments) {
    this.bot = args.bot;
    this.event = args.event;
    if (args.replyAt) {
      this.replyAt = args.replyAt;
    }
  }

  get messageId() {
    return this.event.messageId;
  }
  get senderQQ() {
    return this.event.sender.qq;
  }
  get isInGroupChat() {
    return this.event.messageType === "group";
  }
  get groupId() {
    if (!this.isInGroupChat) return undefined;
    return (this.event as MessageOfGroupEvent).groupId;
  }
  get isInPrivateChat() {
    return this.event.messageType === "private";
  }
  get replyAtSeq(): number | undefined {
    return (this.replyAt?.reply.data as any).seq;
  }
  get replyAtSeqData(): {
    qq: number;
    seq: number;
  } | {
    group: number;
    seq: number;
  } | undefined {
    const seq = this.replyAtSeq;
    if (seq === undefined) return undefined;
    if (this.isInGroupChat) {
      const groupId = this.groupId;
      if (!groupId) return undefined;
      return { group: this.groupId!, seq };
    } else if (this.isInPrivateChat) {
      return { qq: this.senderQQ, seq };
    }
    return undefined;
  }
  async getRepliedMessageEventRaw(bot: KuboBot) {
    const seqData = this.replyAtSeqData;
    if (seqData) {
      if ("qq" in seqData) {
        return await bot.messages.getMessageEventRaw(seqData);
      }
      if ("group" in seqData) {
        return await bot.messages.getMessageEventRaw(seqData);
      }
    }

    const replyAt = this.replyAt;
    if (replyAt) {
      return await bot.messages.getMessageEventRaw(replyAt);
    }
  }
}

interface CommandContextArguments {
  prefix: string | null;
  head: string;
  isEmbedded: boolean;
  shouldAwait: boolean;

  arguments: CommandArgument[];
  lineCmdExtra?: {
    lineCmdCount: number;
    lineNumber: number;
    followingLines: ExecutedLine[];
  };
}

export class PluginContextForCommand {
  private isValid = true;

  get message() {
    return this.executeContext.pluginContext;
  }

  get bot() {
    return this.message.bot;
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

  readonly lineCommandCount?: number;
  get isExclusive() {
    return this.isEmbedded ? undefined : this.lineCommandCount === 1;
  }
  /**
   * 以 1 开始记。
   */
  readonly lineNumber?: number;
  get isLeading() {
    return this.isEmbedded ? undefined : this.lineNumber === 1;
  }
  get isLeadingExclusive() {
    return this.isEmbedded ? undefined : this.isExclusive && this.isLeading;
  }

  readonly followingLines?: ExecutedLine[];
  /**
   * 获取命令之后跟随的几行内容。
   *
   * TODO: test
   *
   * @param boundary 获取行的界限
   *  - "list" 获取紧随其后的列表
   *    （列表由紧凑的列表项组成，列表项由 "-" 等开头；暂不支持有序列表）
   *  - "until-blank-line" 获取直到空行的内容
   *  - "until-line-command" 获取直到下个行命令的内容
   *  - "paragraph" 获取直到空行或者下个行命令的内容
   *  - "until-end" 获取往后所有行的内容
   */
  getFollowing(
    boundary:
      | "list"
      | "until-blank-line"
      | "until-line-command"
      | "paragraph"
      | "until-end",
  ) {
    if (this.isEmbedded) throw new GetFollowingLinesOfEmbeddedMessageError();
    if (!this.followingLines) throw new Error("never");
    const out: ExecutedLine[] = [];

    for (const line of this.followingLines) {
      if (boundary === "list") {
        if (line?.[0].type !== "text") break;
        const text = line[0].data.text;
        if (!/( {0,3}|\t)[-*+]/.test(text)) break;
      }

      if (
        boundary === "until-blank-line" ||
        boundary === "paragraph"
      ) {
        if (line.length === 0) break;
        if (line.length === 1 && line[0].type === "text") {
          const text = line[0].data.text;
          if (/^\s+$/.test(text)) break;
        }
      }

      if (
        boundary === "until-line-command" ||
        boundary === "paragraph"
      ) {
        if (line.length === 1 && line[0].type === "__kubo_executed_command") {
          break;
        }
      }

      out.push(line);
    }

    return out;
  }

  private hasManuallyClaimed = false;

  private constructor(
    private executeContext: ExecuteContextForMessage,
    controller: CommandContextController,
    public readonly _internal_id: number,
    extra: CommandContextArguments,
  ) {
    if (
      (extra.isEmbedded && extra.lineCmdExtra) ||
      (!extra.isEmbedded && !extra.lineCmdExtra)
    ) {
      throw new Error("never");
    }

    controller.onInvalidate = () => this.isValid = false;
    controller.getHasManuallyClaimed = () => this.hasManuallyClaimed;

    this.prefix = extra.prefix;
    this.head = extra.head;
    this.isEmbedded = extra.isEmbedded;
    this.shouldAwait = extra.shouldAwait;

    this.arguments = extra.arguments;
    if (this.isEmbedded) {
    } else {
      this.lineCommandCount = extra.lineCmdExtra!.lineCmdCount;
      this.lineNumber = extra.lineCmdExtra!.lineNumber;
      this.followingLines = extra.lineCmdExtra!.followingLines;
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

/**
 * 检查候选命令是否支持当前所用的书写形式
 */
function checkCommandStyle(
  cmdEntity: CommandEntity,
  curCmdPiece: UnexecutedCommandPiece,
) {
  let isSupported = false;
  let supportedStyleCount = 0;
  if (cmdEntity.supportedStyles.has("line")) {
    supportedStyleCount++;
    isSupported ||= !curCmdPiece.isEmbedded && curCmdPiece.hasPrefix;
  }
  if (cmdEntity.supportedStyles.has("embedded")) {
    supportedStyleCount++;
    isSupported ||= curCmdPiece.isEmbedded && curCmdPiece.hasPrefix;
  }
  if (cmdEntity.supportedStyles.size !== supportedStyleCount) {
    throw new Error("never");
  }
  return isSupported;
}

/**
 * 候选命令对参数前空白的要求是否与当前相符
 */
function checkArgumentsBeginningPolicy(
  cmdEntity: CommandEntity,
  isSqueezed: boolean,
) {
  if (cmdEntity.argumentsBeginningPolicy === "follows-spaces") {
    return !isSqueezed;
  }
  if (cmdEntity.argumentsBeginningPolicy !== "unrestricted") {
    throw new Error("never");
  }
  return true;
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
  error: ExecutionFailure["error"],
): CommandNote {
  return { level: error.level, content: error.content };
}

function makeNoteFromSystemLevelWarn(
  warn: { content: string },
): CommandNote {
  return { level: "system-warn", content: warn.content };
}
