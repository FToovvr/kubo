import {
  MessagePiece,
  RegularMessagePiece,
  replyAt,
  text,
} from "../../../go_cqhttp_client/message_piece.ts";
import { Trie } from "../../../utils/aho_corasick.ts";
import { Optional } from "../../../utils/type_utils.ts";
import { KuboBot } from "../../index.ts";
import { SettingsManager } from "../settings_manager/index.ts";
import { CommandTrie } from "./types.ts";
import {
  MessageEvent,
  MessageOfGroupEvent,
} from "../../../go_cqhttp_client/events.ts";
import {
  CommandAliasEntity,
  CommandEntity,
  CommandStyle,
} from "./models/command_entity.ts";
import { evaluateMessage } from "./evaluator.ts";
import { generateUnifiedResponse } from "./utils.ts";
import { mergeAdjoiningTextPiecesInPlace } from "../../../utils/message_utils.ts";
import { Spy } from "https://deno.land/x/mock@0.15.0/mod.ts";
import { ProcessResult } from "../../types.ts";

/**
 * 存储注册命令数据所用的数据结构的简化版。
 * 允许省略部分参数，省略的参数会视为默认值
 */
export type LooseCommandEntity =
  & Optional<
    Omit<CommandEntity, "command" | "supportedStyles">,
    | "isExclusive"
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
  const isExclusive = entity.isExclusive ?? false;

  let supportedStyles: Set<CommandStyle>;
  if (!entity.supportedStyles) {
    if (isExclusive) {
      supportedStyles = new Set(["line"]);
    } else {
      supportedStyles = new Set(["line", "embedded"]);
    }
  } else if (entity.supportedStyles instanceof Set) {
    supportedStyles = entity.supportedStyles;
  } else if (typeof entity.supportedStyles === "string") {
    supportedStyles = new Set([entity.supportedStyles]);
  } else { // Array.isArray(entity.supportedStyles)
    supportedStyles = new Set(entity.supportedStyles);
  }
  // delete entity.supportedStyles;

  return {
    command,
    isExclusive,
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

  prefix!: string;

  readonly commands: CommandTrie = new Trie<CommandEntity>();
  readonly commandToAliases = new Map<CommandEntity, CommandAliasEntity[]>();

  constructor(bot: KuboBot | _MockKuboBot) {
    this.#bot = bot;
  }

  async init() {
    await this.#bot.settings.register("prefix", {
      info: { readableName: "命令前缀", description: "触发命令的前缀" },
      valueType: "string",
      default: "/",
    });

    this.#bot.onMessage("all", { all: true }, this.processMessage.bind(this));
  }

  registerCommand(
    command: string,
    looseEntity: LooseCommandEntity,
    extra: {
      aliases?: string | string[];
    } = {},
  ) {
    this.checkCommandHead(command, looseEntity);

    const entity = completeCommandEntity(command, looseEntity);
    this.commands.set(command, entity);

    if (extra.aliases !== undefined) {
      this.registerAlias(entity, extra.aliases);
    }

    return entity;
  }

  registerAlias(target: CommandEntity, aliases: string | string[]) {
    if (typeof aliases === "string") {
      aliases = [aliases];
    }

    const aliasEntities = [];
    for (const alias of aliases) {
      this.checkCommandHead(alias);
      const aliasEntity = new CommandAliasEntity(target, alias);
      this.commands.set(alias, aliasEntity);
      aliasEntities.push(aliasEntity);
    }
    this.commandToAliases.set(target, [
      ...this.commandToAliases.get(target) ?? [],
      ...aliasEntities,
    ]);
  }

  checkCommandHead(command: string, looseEntity?: LooseCommandEntity) {
    if (this.commands.get(command)) {
      throw new Error(
        `命令重复！命令：${{ command, ...(looseEntity ? { looseEntity } : {}) }}`,
      );
    }
    if (/[\s{}\\]/.test(command)) {
      throw new Error(`命令不能含有空白字符、花括号或反斜杠！`);
    }
  }

  listCommands(extra: { inGroup?: number /* TODO */ } = {}) {
    return [...this.commands.values()]
      .filter((entity) => !(entity instanceof CommandAliasEntity))
      .map((entity) => {
        const aliases = this.commandToAliases.get(entity) ?? [];
        return {
          entity,
          aliases: aliases,
          status: {
            global: "enabled",
            here: "inherited",
          },
        };
      });
  }

  /**
   * @returns
   * - 没找到命令则返回 undefined；
   * - 命令没有 usage 则返回 null；
   * - 命令有 usage 则返回 usage string。
   */
  async getUsage(
    commandHead: string,
    scope: { group?: number },
  ): Promise<string | null | undefined> {
    const cmd = this.commands.get(commandHead);
    if (!cmd) return undefined;
    if (!cmd.usageCallback) return null;

    const prefix = await this.getPrefix(scope);
    let entity: CommandEntity;
    if (cmd instanceof CommandAliasEntity) {
      entity = cmd.target;
    } else {
      entity = cmd;
    }

    return cmd.usageCallback({
      prefix,
      head: entity.command,
      aliases: (this.commandToAliases.get(entity) ?? []).map((a) => a.command),
    });
  }

  private async processMessage(
    bot: KuboBot | _MockKuboBot,
    msg: string | MessagePiece[],
    ev: MessageEvent,
  ): Promise<ProcessResult<true>> {
    let group: number | null = null;
    let callerQQ = ev.sender.qq;
    if (ev instanceof MessageOfGroupEvent) {
      group = ev.groupId;
    }
    const scope = group ? { group } : {};
    const prefix = await this.getPrefix(scope);

    if (typeof msg === "string") {
      msg = [text(msg)];
    }
    const { processResult, embeddingResult, responses } = await evaluateMessage(
      { bot, commandTrie: this.commands, prefix },
      ev,
      msg as RegularMessagePiece[], // TODO: 从源头使用 RegularMessagePiece
    );

    const unifiedResponse = await generateUnifiedResponse({
      cmdsResps: responses,
    });

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

  async getPrefix(scope: { group?: number }) {
    return await this.#bot.settings.get(scope, "prefix") as string;
  }
}
