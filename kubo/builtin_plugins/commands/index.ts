import { KuboBot } from "../../bot.ts";
import { registerBuiltinCoreCommands } from "./core/index.ts";
import { registerBuiltinDevCommands } from "./dev/index.ts";

export function registerBuiltinCommands(bot: KuboBot) {
  registerBuiltinCoreCommands(bot);
  registerBuiltinDevCommands(bot);
}
