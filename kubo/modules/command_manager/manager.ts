import {
  MessagePiece,
  RegularMessagePiece,
  replyAt,
  text,
} from "../../../go_cqhttp_client/message_piece.ts";
import { Trie } from "../../../utils/aho_corasick.ts";
import { Optional } from "../../../utils/type_utils.ts";
import { KuboBot, ProcessResult } from "../../bot.ts";
import { SettingsManager } from "../settings_manager/index.ts";
import { CommandTrie } from "./types.ts";
import {
  MessageEvent,
  MessageOfGroupEvent,
} from "../../../go_cqhttp_client/events.ts";
import { CommandEntity, CommandStyle } from "./models/command_entity.ts";
import { evaluateMessage } from "./evaluator.ts";
import { generateUnifiedResponse } from "./utils.ts";
import { mergeAdjoiningTextPiecesInPlace } from "../../../utils/message_utils.ts";
import { Spy } from "https://deno.land/x/mock@0.15.0/mod.ts";

/**
 * 存储注册命令数据所用的数据结构的简化版。
 * 允许省略部分参数，省略的参数会视为默认值
 */
export type LooseCommandEntity =
  & Optional<
    Omit<CommandEntity, "command" | "supportedStyles">,
    // | "lineStylePriority"
    | "referencePolicy"
    | "argumentsBeginningPolicy"
  >
  & {
    supportedStyles?: Set<CommandStyle> | CommandStyle | CommandStyle[];
  };

export function completeCommandEntity(
  command: string,
  entity: LooseCommandEntity,
): CommandEntity {
  let supportedStyles: Set<CommandStyle>;
  if (!entity.supportedStyles) {
    supportedStyles = new Set(["line", "embedded"]);
  } else if (entity.supportedStyles instanceof Set) {
    supportedStyles = entity.supportedStyles;
  } else if (typeof entity.supportedStyles === "string") {
    supportedStyles = new Set([entity.supportedStyles]);
  } else { // Array.isArray(entity.supportedStyles)
    supportedStyles = new Set(entity.supportedStyles);
  }
  delete entity.supportedStyles;

  return {
    command,
    // lineStylePriority: "low",
    referencePolicy: "omittable",
    argumentsBeginningPolicy: "follows-spaces",

    ...entity,
    supportedStyles,
  };
}

/**
 * 测试需要
 */
export interface _MockKuboBot {
  settings: SettingsManager;
  onMessage: _MockKuboBotOnMessage;
  self: { qq: number };
  sendGroupMessage: Spy<
    KuboBot | _MockKuboBot,
    Parameters<KuboBot["sendGroupMessage"]>,
    ReturnType<KuboBot["sendGroupMessage"]>
  >;
  sendPrivateMessage: Spy<
    KuboBot | _MockKuboBot,
    Parameters<KuboBot["sendPrivateMessage"]>,
    ReturnType<KuboBot["sendPrivateMessage"]>
  >;
}
type _MockKuboBotOnMessage = (
  on: "all",
  msgMatcher: { all: true },
  cb: InstanceType<typeof CommandManager>["processMessage"],
) => void;

export class CommandManager {
  #bot: KuboBot | _MockKuboBot;

  readonly commands: CommandTrie = new Trie<CommandEntity>();

  constructor(bot: KuboBot | _MockKuboBot) {
    this.#bot = bot;

    this.#bot.settings.register("prefix", {
      info: { readableName: "命令前缀", description: "触发命令的前缀" },
      valueType: "string",
      default: "/",
    });

    this.#bot.onMessage("all", { all: true }, this.processMessage.bind(this));
  }

  registerCommand(command: string, looseEntity: LooseCommandEntity) {
    if (this.commands.get(command)) {
      throw new Error(`命令重复！命令：${{ command, entity: looseEntity }}`);
    }
    if (/[\s{}\\]/.test(command)) {
      throw new Error(`命令不能含有空白字符、花括号或反斜杠！`);
    }

    const entity = completeCommandEntity(command, looseEntity);
    this.commands.set(command, entity);
  }

  private processMessage(
    bot: KuboBot | _MockKuboBot,
    msg: string | MessagePiece[],
    ev: MessageEvent,
  ): ProcessResult<true> {
    let group: number | null = null;
    let callerQQ = ev.sender.qq;
    if (ev instanceof MessageOfGroupEvent) {
      group = ev.groupId;
    }
    const scope = group ? { group } : {};
    const prefix = this.#bot.settings.get(scope, "prefix") as string;

    if (typeof msg === "string") {
      msg = [text(msg)];
    }
    const { processResult, embeddingResult, responses } = evaluateMessage(
      { bot, commandTrie: this.commands, prefix },
      msg as RegularMessagePiece[], // TODO: 从源头使用 RegularMessagePiece
    );

    const unifiedResponse = generateUnifiedResponse({ cmdsResps: responses });

    if (
      ((embeddingResult?.length ?? 0) === 0) &&
      ((unifiedResponse?.length ?? 0) === 0)
    ) {
      return processResult;
    }

    const out: RegularMessagePiece[] = [];
    if (group) {
      const ref = replyAt(ev.messageId, ev.sender.qq);
      out.push(...ref.array);
    }
    if (embeddingResult) {
      out.push(text("嵌入结果：\n"));
      out.push(...embeddingResult);
    }
    if (unifiedResponse) {
      if (embeddingResult) {
        out.push(text("\n" + "=".repeat(16) + "\n"));
      }
      out.push(...unifiedResponse);
    }
    mergeAdjoiningTextPiecesInPlace(out);

    // TODO: await or not?
    if (out.length > 0) {
      // console.log(Deno.inspect(out, { depth: Infinity }));
      if (group) {
        bot.sendGroupMessage(group, out);
      } else { // TODO: 处理匿名的情况
        bot.sendPrivateMessage(callerQQ, out);
      }
    }

    return processResult;
  }
}
