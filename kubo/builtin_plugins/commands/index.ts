import { KuboBot } from "../../bot.ts";
import { registerBuiltinDevCommands } from "./dev/index.ts";

export function registerBuiltinCommands(bot: KuboBot) {
  registerBuiltinDevCommands(bot);
}
