import { KuboBot } from "../../index.ts";
import { registerBuiltinCoreCommands } from "./core/index.ts";
import { registerDebugOnlyCommands } from "./debug_only/index.ts";
import { registerBuiltinDevCommands } from "./dev/index.ts";
import { registerBuiltinTuanCommands } from "./tuan/index.ts";

export function registerBuiltinCommands(
  bot: KuboBot,
  args: { isDebug: boolean },
) {
  registerBuiltinCoreCommands(bot);
  registerBuiltinDevCommands(bot);
  registerBuiltinTuanCommands(bot);
  if (args.isDebug) {
    registerDebugOnlyCommands(bot);
  }
}
