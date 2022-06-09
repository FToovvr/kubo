import { KuboBot } from "../../../index.ts";
import createChoosePlugin from "./choose.ts";
import createWeightPlugin from "./weight.ts";

export function registerBuiltinTuanCommands(bot: KuboBot) {
  bot
    .use(createChoosePlugin())
    .use(createWeightPlugin());
}
