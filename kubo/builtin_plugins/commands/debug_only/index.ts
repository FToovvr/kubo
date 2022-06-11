import { KuboBot } from "../../../index.ts";
import createOneMinRpPlugin from "./one_min_rp.ts";
import createRandomSingleColorImagePlugin from "./random_single_color_image.ts";
import createEchoAndErrorPlugin from "./echo_and_error.ts";

export function registerDebugOnlyCommands(bot: KuboBot) {
  bot
    .use(createEchoAndErrorPlugin())
    .use(createOneMinRpPlugin())
    .use(createRandomSingleColorImagePlugin())
    .use(null);
}
