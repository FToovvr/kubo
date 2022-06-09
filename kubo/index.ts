export { KuboBot } from "./bot.ts";
export { type KuboPlugin } from "./types.ts";

import { Client as PgClient } from "https://deno.land/x/postgres@v0.16.0/mod.ts";

import { Client as GoCqHttpClient } from "../go_cqhttp_client/client.ts";
import { KuboBot } from "./index.ts";

import approveAllFriendRequests from "./builtin_plugins/approve_all_friend_requests.ts";
import sensitiveFilter from "./builtin_plugins/sensitive_filter/index.ts";
import { registerBuiltinCommands } from "./builtin_plugins/commands/index.ts";

export function makeDefaultKuboBot(client: GoCqHttpClient, db: PgClient, args: {
  sensitiveList?: string[];
  ownerQQ?: number | number[];
}) {
  const bot = new KuboBot(client, db, args);

  bot.init((bot) => {
    bot.use(approveAllFriendRequests())
      .use(args.sensitiveList ? sensitiveFilter(args.sensitiveList) : null)
      .batch((bot) => registerBuiltinCommands(bot))
      // .use(oneMinRp())
      .use(null); // 防止分号被补到上一行
  });

  return bot;
}
