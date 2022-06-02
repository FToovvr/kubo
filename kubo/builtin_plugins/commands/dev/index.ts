import { KuboBot } from "../../../bot.ts";
import createInspectPlugin from "./inspect.ts";

export function registerBuiltinDevCommands(bot: KuboBot) {
  bot.use(createInspectPlugin());
}
