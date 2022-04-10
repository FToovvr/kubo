import { Client } from "../go_cqhttp_client/client.ts";
import { KuboBot } from "./bot.ts";

import approveAllFriendRequests from "./modules/approve_all_friend_requests.ts";
import sensitiveFilter from "./modules/sensitive_filter/index.ts";

export function makeDefaultKuboBot(client: Client, args: {
  sensitiveList: string[] | null;
}) {
  return new KuboBot(client)
    .use(approveAllFriendRequests())
    .use(args.sensitiveList ? sensitiveFilter(args.sensitiveList) : null);
}
