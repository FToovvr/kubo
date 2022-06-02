import {
  RegularMessagePiece,
  text,
} from "../../../go_cqhttp_client/message_piece.ts";
import { MessageLine } from "../../../utils/message_utils.ts";
import { KuboBot } from "../../bot.ts";
import {
  CommandNote,
  ExecutedCommandPiece,
  ExecutedPiece,
  executeUnexecutedNonLinePiece,
  generateEmbeddedOutput,
  UnexecutedCommandPiece,
} from "./models/command_piece.ts";
import { ExecuteContext } from "./models/execute_context.ts";
import { MessagePieceForTokenizer, tokenizeMessage } from "./tokenizer.ts";
import { CommandTrie } from "./types.ts";
import { separateHeadFromMessage } from "./utils.ts";

export interface CommandResponses {
  contents: RegularMessagePiece[][];
  command: ExecutedCommandPiece;
  hasFailed: boolean;
  notes: CommandNote[];
}

interface BaseBot {
  self: { qq: number };
}

interface EvaluatorEnvironment<Bot extends BaseBot = KuboBot> {
  commandTrie: CommandTrie;
  prefix: string;
  bot: Bot;
}

export function evaluateMessage<Bot extends BaseBot = KuboBot>(
  ctx: EvaluatorEnvironment<Bot>,
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

/**
 * 执行消息中的命令。
 *
 * 命令的执行结果会汇集在这里，而不会从这里直接发出去。
 */
class MessageEvaluator<Bot extends BaseBot = KuboBot> {
  private commandTrie: CommandTrie;
  private prefix: string;
  private bot: Bot;

  private parsedMessage:
    | MessageLine<MessagePieceForTokenizer>[]
    | null
    | undefined = undefined;
  private executedMessage:
    | MessageLine<ExecutedPiece>[]
    | undefined = undefined;

  private executeContext: ExecuteContext;

  get executedCommands() {
    return Object.values(this.executeContext.slots)
      .filter((slot) => slot.executed)
      .map((slot) => slot.executed!);
  }

  get hasCommand() {
    return this.executedCommands.length > 0;
  }
  get hasEmbeddedCommand() {
    for (const cmd of this.executedCommands) {
      if (cmd.isEmbedded) return true;
    }
    return false;
  }

  generateEmbeddedOutput() {
    if (this.executedMessage === undefined) throw new Error("never");
    const msg = this.executedMessage.flatMap((line, i) => {
      if (i !== this.executedMessage!.length - 1) {
        return [...line, text("\n")];
      }
      return [...line];
    });
    return generateEmbeddedOutput(msg);
  }

  get responses(): CommandResponses[] {
    return this.executedCommands
      .map((cmd): CommandResponses => ({
        contents: cmd.result?.response ? [cmd.result.response] : [],
        command: cmd,
        hasFailed: cmd.hasFailed,
        notes: cmd.notes,
      }))
      .filter((res) => res.contents.length + res.notes.length > 0);
  }

  constructor(
    env: EvaluatorEnvironment<Bot>,
    private inputMessage: RegularMessagePiece[],
  ) {
    this.commandTrie = env.commandTrie;
    this.prefix = env.prefix;
    this.bot = env.bot;

    const { cleanedMessage, replyAt, leadingAt } = separateHeadFromMessage(
      this.inputMessage,
    );

    this.executeContext = new ExecuteContext({
      ...(replyAt ? { replyAt } : {}),
    });

    if (leadingAt && Number(leadingAt.data.qq) !== this.bot.self.qq) {
      // 专门指定了 bot，但并非本 bot
      this.parsedMessage = null;
      return;
    }

    this.parsedMessage = tokenizeMessage(env, cleanedMessage);
  }

  execute(): "skip" | "pass" {
    if (this.parsedMessage === undefined) throw new Error("never");
    if (!this.parsedMessage) return "skip";
    if (this.executedMessage) throw new Error("never");

    this.executedMessage = [];
    const lineCommandsToExecute: {
      lineIndex: number;
      cmd: UnexecutedCommandPiece;
    }[] = [];

    // 先执行 embedded command
    for (const [lineIndex, unexecutedLine] of this.parsedMessage.entries()) {
      if (
        unexecutedLine.length === 1 &&
        unexecutedLine[0].type === "__kubo_unexecuted_command" &&
        !unexecutedLine[0].isEmbedded
      ) { // 行命令自身延后执行
        unexecutedLine[0].executeArguments(this.executeContext);
        lineCommandsToExecute.push({ lineIndex, cmd: unexecutedLine[0] });
        this.executedMessage.push(new MessageLine<ExecutedPiece>());
        continue;
      }

      const executedLine = new MessageLine<ExecutedPiece>();
      for (const unexecutedPiece of unexecutedLine) {
        const result = executeUnexecutedNonLinePiece(
          this.executeContext,
          unexecutedPiece,
        );
        executedLine.push(result);
      }
      this.executedMessage.push(executedLine);
    }

    // 再执行 line command
    for (const { lineIndex, cmd } of lineCommandsToExecute) {
      if (this.executedMessage[lineIndex].length !== 0) {
        throw new Error("never");
      }
      const executed = cmd.execute(this.executeContext, {
        lineNumber: lineIndex + 1,
      });
      if (executed) {
        this.executedMessage[lineIndex].push(executed);
      } else {
        const result = cmd.asLineExecuted(this.executeContext);
        this.executedMessage[lineIndex].push(...result);
      }
    }

    if (!this.hasCommand) return "skip";

    return "pass";
  }
}
