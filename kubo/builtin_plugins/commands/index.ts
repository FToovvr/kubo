import { KuboBot } from "../../index.ts";
import { registerBuiltinCoreCommands } from "./core/index.ts";
import { registerBuiltinDevCommands } from "./dev/index.ts";
import { registerBuiltinTuanCommands } from "./tuan/index.ts";

export function registerBuiltinCommands(bot: KuboBot) {
  registerBuiltinCoreCommands(bot);
  registerBuiltinDevCommands(bot);
  registerBuiltinTuanCommands(bot);
}
