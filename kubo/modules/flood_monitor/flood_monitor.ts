import { IStore, StoreWrapper } from "../../storage.ts";
import { MessageContentCounts } from "../../types.ts";

export class FloodMonitor {
  store: StoreWrapper;

  thresholds: {
    global: number;
    group: number;
    user: number;
  };

  constructor(
    store: IStore,
    args: {
      thresholds?: {
        global?: number;
        group?: number;
        user?: number;
      };
    } = {},
  ) {
    this.store = new StoreWrapper(store, "flood", {
      usesCache: true,
      writesBackImmediately: false,
    });

    this.thresholds = {
      global: 60,
      group: 30,
      user: 15,
      ...(args.thresholds ?? {}),
    };
  }

  async close() {
    await this.store.close();
  }

  async reportOutboundGroupMessage(
    group: number,
    triggerQQ: number,
    counts?: MessageContentCounts,
  ) {
    return await this.reportOutboundMessage(group, triggerQQ, counts);
  }

  async reportOutboundPrivateMessage(
    triggerQQ: number,
    counts?: MessageContentCounts,
  ) {
    return await this.reportOutboundMessage(null, triggerQQ, counts);
  }

  private async reportOutboundMessage(
    group: number | null,
    triggerQQ: number,
    counts?: MessageContentCounts, // TODO: 把发送内容的大小也计入考察当中
  ): Promise<{ isOk: boolean; error?: string | null }> {
    const now = new Date();

    const informee = {
      place: group ? "group" : "private" as "group" | "private",
      target: group ? group : triggerQQ,
    };

    const globalResult = await this.process(
      {},
      now,
      this.thresholds.global,
      informee,
    );
    if (!globalResult.isOk) return globalResult;

    if (group) {
      const groupResult = await this.process(
        { group },
        now,
        this.thresholds.group,
      );
      if (!groupResult.isOk) return groupResult;
    }

    const userResult = await this.process(
      { qq: triggerQQ },
      now,
      this.thresholds.user,
    );
    if (!userResult.isOk) return userResult;

    return { isOk: true };
  }

  private async process(
    scope: {} | { group: number } | { qq: number },
    now: Date,
    threshold: number,
    informee?: {
      place: "group" | "private";
      target: number;
    },
  ): Promise<{ isOk: true } | { isOk: false; error: string | null }> {
    const expireAt = new Date(now);

    // 检查是否已在冷却
    const isFrozen = await this.checkAndUpdateFreezingStatus(scope, now);
    if (isFrozen) {
      if ("group" in scope || "qq" in scope) {
        return { isOk: false, error: null };
      }
      if (!informee) throw new Error("never");
      const hasInformed = await this.checkAndUpdateHasInformed(
        {},
        informee.place,
        informee.target,
      );
      if (hasInformed) return { isOk: false, error: null };

      const freezeUntil = await getDate(this.store, {}, "freeze-until");
      if (!freezeUntil) throw new Error("never");
      const freezeUntilText = makeTimeText(freezeUntil);
      return { isOk: false, error: `全局操作过于频繁，正在冷却（直到 ${freezeUntilText}）` };
    }

    // 获取一分钟内的消息的时间戳
    const outbound = filterOutExpired(
      await getTextList(this.store, scope, "outbound"),
      expireAt,
    );

    // 更新记录的消息的时间戳
    const newOutBound = [...outbound, "" + (Number(now) / 1000)];
    await this.store.set(
      scope,
      "outbound",
      newOutBound.join(","),
    );

    if (newOutBound.length > threshold) {
      // 检查冷却触发次数，以一天内的触发次数计算冷却时间（上限一天）
      const formerTriggered = await getTextList(this.store, scope, "triggered");

      let minutes: number;
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      const triggeredInADay =
        filterOutExpired(formerTriggered, yesterday).length + 1;
      if ("group" in scope) {
        minutes = Math.floor(
          Math.min(Math.pow(triggeredInADay, 2), 60),
        );
      } else if ("qq" in scope) {
        minutes = Math.floor(
          Math.min(Math.pow(triggeredInADay, 2.5), 60 * 12),
        );
      } else {
        minutes = 5;
      }

      // 更新冷却触发记录
      await this.store.set(
        scope,
        "triggered",
        [...formerTriggered, "" + Number(now) / 1000].join(","),
      );

      // 设置冷却时间
      const freezeUntil = new Date(now);
      freezeUntil.setMinutes(now.getMinutes() + minutes);
      const freezeUntilTs = Number(freezeUntil) / 1000;
      await this.store.set(scope, "freeze-until", String(freezeUntilTs));

      // 返回说明消息
      let place: string;
      if ("group" in scope) {
        place = `本群（${scope.group}）中`;
      } else if ("qq" in scope) {
        place = `用户（${scope.qq}）的`;
      } else {
        place = "全局";
        if (!informee) throw new Error("never");
        await this.checkAndUpdateHasInformed(
          {},
          informee.place,
          informee.target,
        );
      }
      const freezeUntilText = makeTimeText(freezeUntil);
      return {
        isOk: false,
        error: `${place}操作过于频繁，正在冷却，请等待 ${minutes} 分钟（直到 ${freezeUntilText}）`,
      };
    } else {
      return { isOk: true };
    }
  }

  private async checkAndUpdateFreezingStatus(
    scope: {} | { group: number } | { qq: number },
    now: Date,
  ) {
    const freezeUntil = await getDate(this.store, scope, "freeze-until");
    if (!freezeUntil) return false;
    if (now >= freezeUntil) {
      await this.store.set(scope, "freeze-until", null);
      await this.store.set(scope, "has-informed-group", null);
      await this.store.set(scope, "has-informed-private", null);
      return false;
    }
    return true;
  }

  private async checkAndUpdateHasInformed(
    scope: {},
    place: "group" | "private",
    target: number,
  ) {
    let key: string;
    if (place === "group") {
      key = "has-informed-group";
    } else {
      if (place !== "private") throw new Error("never");
      key = "has-informed-private";
    }

    const targets = await getTextList(this.store, {}, key);
    if (targets.indexOf("" + target) >= 0) return true;

    const newList = [...targets, "" + target];
    await this.store.set({}, key, newList.join(","));

    return false;
  }
}

/**
 * @param textTss 文本形式的时间戳数组，按由早至晚的顺序排列
 */
function filterOutExpired(textTss: string[], expireAt: Date) {
  const index = textTss
    .findIndex((textTs) => new Date(Number(textTs) * 1000) >= expireAt);
  return textTss.slice(index);
}

async function getTextList(
  store: StoreWrapper,
  scope: {} | { group: number } | { qq: number },
  key: string,
) {
  const value = await store.get(scope, key) as string | null;
  const list = (value ?? "").split(",");
  if (list.length === 1 && list[0] === "") return [];
  return list;
}

function makeTimeText(date: Date) {
  const fakeDate = new Date(date);
  fakeDate.setHours(date.getHours() + 8);
  const fakeISO = fakeDate.toISOString();
  const [fakeYMD, remain] = fakeISO.split("T");
  const [fakeHMS, _remain] = remain.split(".");
  return `${fakeYMD} ${fakeHMS}`;
}

async function getDate(
  store: StoreWrapper,
  scope: {} | { group: number } | { qq: number },
  key: string,
) {
  const string = (await store.get(scope, key)) as string | null;
  if (!string) return null;
  return new Date(Number(string) * 1000);
}
