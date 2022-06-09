import {
  RegularMessagePiece,
  text,
} from "../../../go_cqhttp_client/message_piece.ts";
import { MessageLine } from "../../../utils/message_utils.ts";
import { KuboBot } from "../../index.ts";
import {
  CommandNote,
  ExecutedCommandPiece,
  executeUnexecutedNonLinePiece,
  generateEmbeddedOutput,
  UnexecutedCommandPiece,
} from "./models/command_piece.ts";
import {
  ExecuteContextForMessage,
  PluginContextForMessage,
} from "./models/execute_context.ts";
import { tokenizeMessage } from "./tokenizer.ts";
import { CommandTrie, ExecutedLine, UnexecutedLine } from "./types.ts";
import { separateHeadFromMessage } from "./utils.ts";
import { MessageEvent } from "../../../go_cqhttp_client/events.ts";

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

export async function evaluateMessage<Bot extends BaseBot = KuboBot>(
  ctx: EvaluatorEnvironment<Bot>,
  event: MessageEvent,
  msg: RegularMessagePiece[],
) {
  const evaluator = new MessageEvaluator(ctx, event, msg);
  const processResult = await evaluator.execute();
  const embeddingResult = (() => {
    if (evaluator.hasEmbeddedCommand) {
      return evaluator.generateEmbeddedOutput();
    }
    return null;
  })();
  const responses = evaluator.responses;

  return { processResult, embeddingResult, responses };
}

type LineCommandWithFollowingLines = {
  cmd: UnexecutedCommandPiece | null;
  cmdLineIndex: number | null;
  followingLines: ExecutedLine[];
};

/**
 * 执行消息中的命令。
 *
 * 命令的执行结果会汇集在这里，而不会从这里直接发出去。
 */
class MessageEvaluator<Bot extends BaseBot = KuboBot> {
  private bot: Bot;

  private parsedMessage:
    | UnexecutedLine[]
    | null
    | undefined = undefined;
  private executedMessage:
    | ExecutedLine[]
    | undefined = undefined;

  private executeContext: ExecuteContextForMessage;

  get executedCommands() {
    return Object.values(this.executeContext.slots)
      .map((slot) => this.executeContext.getExecutionResult(slot.slotId))
      .filter((executed) => !!executed) as ExecutedCommandPiece[];
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

  private pluginContext: PluginContextForMessage | null;

  constructor(
    env: EvaluatorEnvironment<Bot>,
    event: MessageEvent,
    private inputMessage: RegularMessagePiece[],
  ) {
    this.bot = env.bot;

    const { cleanedMessage, replyAt, leadingAt } = separateHeadFromMessage(
      this.inputMessage,
    );

    this.executeContext = new ExecuteContextForMessage();

    if (leadingAt && Number(leadingAt.data.qq) !== this.bot.self.qq) {
      // 专门指定了 bot，但并非本 bot
      this.parsedMessage = null;
      this.pluginContext = null;
      return;
    }

    this.parsedMessage = tokenizeMessage(env, cleanedMessage);
    this.pluginContext = new PluginContextForMessage({
      bot: this.bot as unknown as KuboBot, // TODO: 更优雅一些
      event,
      ...(replyAt ? { replyAt } : {}),
    });
  }

  async execute(): Promise<"skip" | "pass"> {
    if (this.parsedMessage === undefined) throw new Error("never");
    if (!this.parsedMessage) return "skip";
    if (this.executedMessage) throw new Error("never");

    // TODO: 更优雅一些
    if (!this.pluginContext) throw new Error("never");
    this.executeContext.pluginContext = this.pluginContext;

    this.executedMessage = [];

    const isBotOff = await (async (pluginContext) => {
      const scope = pluginContext.isInGroupChat
        ? { group: pluginContext.groupId! }
        : "global";
      return (await this.pluginContext!.bot.getActivityStatus(scope))
        .calculated === "disabled";
    })(this.pluginContext);
    if (isBotOff) {
      return await this.executeCommandsThatCanRunWhenBotIsOff();
    }

    const lineCommandsToExecute: LineCommandWithFollowingLines[] = [];
    let curLineCmd: LineCommandWithFollowingLines | null = null;

    // 先执行 embedded command
    for (const [lineIndex, unexecutedLine] of this.parsedMessage.entries()) {
      if (
        unexecutedLine.length === 1 &&
        unexecutedLine[0].type === "__kubo_unexecuted_command" &&
        !unexecutedLine[0].isEmbedded
      ) { // 行命令自身延后执行
        await unexecutedLine[0].executeArguments(this.executeContext);

        if (curLineCmd) {
          lineCommandsToExecute.push(curLineCmd);
        }
        curLineCmd = {
          cmd: unexecutedLine[0],
          cmdLineIndex: lineIndex,
          followingLines: [] as ExecutedLine[],
        };
        this.executedMessage.push(new MessageLine());
        continue;
      }

      const executedLine: ExecutedLine = new MessageLine();
      for (const unexecutedPiece of unexecutedLine) {
        const result = await executeUnexecutedNonLinePiece(
          this.executeContext,
          unexecutedPiece,
        );
        if (result.type === "__kubo_compact_complex") {
          throw new Error("never");
        }
        executedLine.push(result);
      }
      this.executedMessage.push(executedLine);

      if (curLineCmd) {
        curLineCmd.followingLines.push(executedLine);
      } else {
        curLineCmd = {
          cmd: null,
          cmdLineIndex: null,
          followingLines: [executedLine],
        };
      }
    }

    if (curLineCmd) {
      lineCommandsToExecute.push(curLineCmd);
    }

    // 再执行 line command
    await this.executeLineCommands(lineCommandsToExecute);

    if (!this.hasCommand) return "skip";

    return "pass";
  }

  /**
   * 可以在 bot off 时执行的命令必须是整行命令，
   * 且不能允许在其头部与参数列表之间不带空白。
   * 此外，其参数列表不能含有复杂的参数
   */
  private async executeCommandsThatCanRunWhenBotIsOff(): Promise<
    "skip" | "pass"
  > {
    if (!this.executedMessage) throw new Error("never");

    const qualifiedCommands: {
      cmd: UnexecutedCommandPiece;
      cmdLineIndex: number;
      followingLines: [];
    }[] = [];

    OUT:
    for (const [i, line] of this.parsedMessage!.entries()) {
      this.executedMessage.push(new MessageLine());
      if (line.length === 1 && line[0].type === "__kubo_unexecuted_command") {
        const cmd = line[0];
        const possibleCommands = cmd.possibleCommands;
        const longest = possibleCommands[possibleCommands.length - 1];
        if (longest.canRunEvenWhenBotOff) {
          for (const arg of cmd.arguments) {
            if (
              arg.content.type === "__kubo_compact_complex" ||
              arg.content.type === "__kubo_group" ||
              arg.content.type === "__kubo_unexecuted_command"
            ) {
              continue OUT;
            }
          }

          const newCmd = cmd.clone();
          newCmd.possibleCommands = [longest];
          qualifiedCommands.push({
            cmd: newCmd,
            cmdLineIndex: i,
            followingLines: [],
          });
        }
      }
    }

    if (!qualifiedCommands.length) return "skip";

    await this.executeLineCommands(qualifiedCommands);

    if (!this.hasCommand) return "skip";

    return "pass";
  }

  private async executeLineCommands(
    lineCommandsToExecute: LineCommandWithFollowingLines[],
  ) {
    if (!this.executedMessage) throw new Error("never");

    for (
      const [i, {
        cmdLineIndex,
        cmd,
        followingLines,
      }] of lineCommandsToExecute.entries()
    ) {
      if (!cmd) {
        if (i !== 0) throw new Error("never");
        continue;
      }
      if (cmdLineIndex === null) throw new Error("never");

      if (this.executedMessage[cmdLineIndex].length !== 0) {
        throw new Error("never");
      }
      const executed = await cmd.execute(this.executeContext, {
        lineCmdExtra: {
          lineCmdCount: lineCommandsToExecute.length,
          lineNumber: cmdLineIndex + 1,
          followingLines,
        },
      });
      if (executed) {
        this.executedMessage[cmdLineIndex].push(executed);
      } else {
        const result = await cmd.asLineExecuted(this.executeContext);
        for (const piece of result) {
          if (
            piece.type === "__kubo_compact_complex" ||
            piece.type === "__kubo_group"
          ) {
            throw new Error("never");
          }
          this.executedMessage[cmdLineIndex].push(piece);
        }
      }
    }
  }
}
