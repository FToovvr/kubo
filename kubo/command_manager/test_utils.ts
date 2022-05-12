import { MessagePiece, text } from "../../go_cqhttp_client/message_piece.ts";
import { Trie } from "../../utils/aho_corasick.ts";
import { MessageLine } from "../../utils/message_utils.ts";
import { completeCommandEntity, LooseCommandEntity } from "./manager.ts";
import { CommandContext } from "./models/command_context.ts";
import {
  ArgumentsBeginningPolicy,
  CommandCallbackReturnValue,
  CommandEntity,
  CommandOptions,
} from "./models/command_entity.ts";
import { makePreCommandPiece } from "./models/command_piece_pre.ts";
import { UnexecutedCommandPiece } from "./models/command_piece_unexecuted.ts";
import { MessagePieceForTokenizer, TokenizingContext } from "./tokenizer.ts";
import { CommandArgument } from "./types.ts";

type TestCallback = (
  command: string,
  ctx: CommandContext,
  opts: CommandOptions,
  args: CommandArgument<false>[] | undefined,
) => CommandCallbackReturnValue;

interface MakeContextArgs {
  supportedStyles?: Required<LooseCommandEntity["supportedStyles"]>;
  argumentsBeginningPolicy?: ArgumentsBeginningPolicy;
}

/**
 * @param callback 所有命令统一的 callback，需要通过 entity 来辨认
 */
export function _test_makeContext(
  cmds: string[] = [],
  prefix = "/",
  callback: TestCallback | null = null,
  args: MakeContextArgs = {},
): TokenizingContext {
  const cmdEntities = _test_makeFakeCommands(cmds, callback, args);
  const trie = new Trie<CommandEntity>();
  for (const entity of cmdEntities) {
    trie.set(entity.command, entity);
  }
  return {
    commandTrie: trie,
    prefix,
  };
}

export function _test_makeFakeCommands(
  cmds: string[],
  callback: TestCallback | null = null,
  args: MakeContextArgs = {},
) {
  return cmds.map((cmd) => _test_makeFakeCommand(cmd, callback, args));
}

export function _test_makeFakeCommand(
  cmd: string,
  callback: TestCallback | null = null,
  args: MakeContextArgs = {},
) {
  return completeCommandEntity(cmd, {
    readableName: cmd.toUpperCase(),
    description: cmd + "…",
    ...args,
    callback: callback
      ? (ctx, opts, args) => callback(cmd, ctx, opts, args)
      : (null as unknown as any),
  });
}

export function _test_makePreCommandPiece(
  cmds: string[],
  args: {
    prefix?: string;
    isEmbedded?: boolean;
    isAwait?: boolean;
    spaceBeforeArguments?: string;
  } = {},
  cmdRawArgs: (string | MessagePieceForTokenizer)[] = [],
) {
  args = {
    prefix: "/",
    isEmbedded: false,
    isAwait: false,
    spaceBeforeArguments: " ",
    ...args,
  };
  return makePreCommandPiece(
    _test_makeFakeCommands(cmds),
    args as Parameters<typeof makePreCommandPiece>[1],
    cmdRawArgs.map((x) => typeof x === "string" ? text(x) : x),
  );
}

export function _test_makeUnexecutedCommandPiece(
  cmds: string[],
  args: {
    prefix?: string | null;
    isEmbedded?: boolean;
    isAwait?: boolean;
    spaceBeforeArguments?: string;
  } = {},
  cmdArgs: CommandArgument[] = [],
): UnexecutedCommandPiece {
  args = {
    prefix: "/",
    isEmbedded: false,
    isAwait: false,
    spaceBeforeArguments: " ",
    ...args,
  };
  // @ts-ignore
  return {
    type: "__kubo_unexecuted_command",
    possibleCommands: _test_makeFakeCommands(cmds),
    prefix: args.prefix!,
    isEmbedded: args.isEmbedded!,
    isAwait: args.isAwait!,
    arguments: cmdArgs,
    spaceBeforeArguments: args.spaceBeforeArguments!,
  };
}

export function _test_cleaningCommands<T extends MessagePiece>(
  msg: MessageLine<T>[],
  args: { removesSpaceRelatedProperties: boolean },
): MessageLine<MessagePiece>[] {
  return msg.map((line) => _test_cleaningCommandsOfLine(line, args));
}

export function _test_cleaningCommandsOfLine<T extends MessagePiece>(
  line: MessageLine<T>,
  args: { removesSpaceRelatedProperties: boolean },
) {
  return line.map((x) => {
    if (x.type !== "__kubo_unexecuted_command") return x;
    return _test_cleaningCommand(
      x as unknown as UnexecutedCommandPiece,
      args,
    );
  });
}

export function _test_cleaningCommand(
  cmd: UnexecutedCommandPiece,
  args: { removesSpaceRelatedProperties: boolean },
): UnexecutedCommandPiece {
  // @ts-ignore
  cmd = { ...cmd };
  // @ts-ignore
  // delete cmd.rawArguments;
  delete cmd.spaceAfterLeftCurlyBracket;
  if (args.removesSpaceRelatedProperties) {
    // @ts-ignore
    delete cmd.spaceBeforeArguments;
  }
  cmd.arguments = cmd.arguments.map((cmdArg) =>
    _test_cleaningCommandsOfLine(cmdArg, args)
  );
  return cmd;
}
