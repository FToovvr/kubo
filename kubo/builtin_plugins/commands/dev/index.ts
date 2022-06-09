import { KuboBot } from "../../../index.ts";
import createInspectPlugin from "./inspect.ts";

export function registerBuiltinDevCommands(bot: KuboBot) {
  bot.use(createInspectPlugin());
}
