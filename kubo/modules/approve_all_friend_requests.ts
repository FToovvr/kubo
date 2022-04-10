import { KuboPlugin } from "../bot.ts";

import { sleep } from "../../utils/misc.ts";

export default function (): KuboPlugin {
  const id = "approve_all_friend_request";
  return {
    id,

    listeners: {
      onReceiveFriendRequest: async (bot, ev) => {
        await sleep(2000);
        const ret = await bot.handleFriendRequest(ev.flag, "approve");
        bot.log(id, "debug", ret);
      },
    },
  };
}
