import { KuboPlugin } from "../bot.ts";
import { PluginStoreWrapper } from "../storage.ts";

export default function () {
  const id = "one_min_rp";
  let store: PluginStoreWrapper | null = null;
  const plugin: KuboPlugin = {
    id,

    init(bot) {
      store = bot.getStore(plugin);
      // 迷思：好多骰子都有 jrrp 功能，会不会其实都是为了测试数据持久化功能？
      bot.commandManager.registerCommand("1mrp", {
        readableName: "一分钟人品",
        description: "jrrp，但是只有一分钟",
        callback: (ctx, args) => {
          // TODO: ctx.sender
          throw new Error("unimplemented");

          // let cur = store!.get({ qq: ev.sender.qq }, "1mrp");
          // console.log({ cur });
          // if (!cur) {
          //   const now = bot.utils.getCurrentUTCTimestamp();
          //   const expireTimestamp = (Math.floor(now / (1 * 60)) + 1) * (1 * 60);
          //   cur = bot.utils.generateRandomInteger(0, 100); // 101 种可能
          //   store!.set({ qq: ev.sender.qq }, "1mrp", cur, { expireTimestamp });
          // }
          // bot.sendGroupMessage(
          //   ev.groupId,
          //   `${ev.sender.groupCard} 这一分钟的 rp = ${cur}`,
          // );
        },
      });
    },
  };

  return plugin;
}
