import { Trie } from "../../../utils/aho_corasick.ts";
import { completeCommandEntity, LooseCommandEntity } from "./manager.ts";
import { CommandArgument } from "./models/command_argument.ts";
import {
  ArgumentsBeginningPolicy,
  CommandCallbackReturnValue,
  CommandEntity,
} from "./models/command_entity.ts";
import { PluginContextForCommand } from "./models/execute_context.ts";
import { TokenizingEnvironment } from "./tokenizer.ts";

type TestCallback = (
  command: string,
  ctx: PluginContextForCommand,
  args: CommandArgument[],
) => CommandCallbackReturnValue | Promise<CommandCallbackReturnValue>;

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
): TokenizingEnvironment {
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
      ? (ctx, args) => callback(cmd, ctx, args)
      : (null as unknown as any),
  });
}
