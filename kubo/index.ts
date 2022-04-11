import { DB } from "https://deno.land/x/sqlite@v3.3.0/mod.ts";

import { Client } from "../go_cqhttp_client/client.ts";
import { KuboBot } from "./bot.ts";

import approveAllFriendRequests from "./modules/approve_all_friend_requests.ts";
import sensitiveFilter from "./modules/sensitive_filter/index.ts";
import oneMinRp from "./modules/one_min_rp.ts";

export function makeDefaultKuboBot(client: Client, db: DB, args: {
  sensitiveList: string[] | null;
}) {
  return new KuboBot(client, db)
    .use(approveAllFriendRequests())
    .use(args.sensitiveList ? sensitiveFilter(args.sensitiveList) : null)
    // .use(oneMinRp())
    .use(null); // 防止分号被补到上一行
}
