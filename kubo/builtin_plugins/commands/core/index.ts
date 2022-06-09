import { KuboBot } from "../../../index.ts";
import createHelpPlugin from "./help.ts";
import createCommandPlugin from "./command.ts";
import createRolePlugin from "./role.ts";
import createBotPlugin from "./bot.ts";

export function registerBuiltinCoreCommands(bot: KuboBot) {
  bot.use(createHelpPlugin());
  bot.use(createCommandPlugin());
  bot.use(createRolePlugin());
  bot.use(createBotPlugin());
}
