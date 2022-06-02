import { KuboBot } from "../../../bot.ts";
import createHelpPlugin from "./help.ts";

export function registerBuiltinCoreCommands(bot: KuboBot) {
  bot.use(createHelpPlugin());
}
