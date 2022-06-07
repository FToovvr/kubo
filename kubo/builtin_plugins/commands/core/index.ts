import { KuboBot } from "../../../bot.ts";
import createHelpPlugin from "./help.ts";
import createCommandPlugin from "./command.ts";

export function registerBuiltinCoreCommands(bot: KuboBot) {
  bot.use(createHelpPlugin());
  bot.use(createCommandPlugin());
}
