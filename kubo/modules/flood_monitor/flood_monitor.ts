import { newScopeFormToOld } from "../../builtin_plugins/commands/utils.ts";
import { IStore, StoreWrapper } from "../../storage.ts";
import { AffectScope, MessageContentCounts } from "../../types.ts";

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
    group: number | null,
    sourceQQ: number | null,
    counts?: MessageContentCounts,
  ) {
    return await this.reportOutboundMessage(group, sourceQQ, counts);
  }

  async reportOutboundPrivateMessage(
    sourceQQ: number | null,
    counts?: MessageContentCounts,
  ) {
    return await this.reportOutboundMessage(null, sourceQQ, counts);
  }

  private async reportOutboundMessage(
    sourceGroup: number | null,
    sourceQQ: number | null,
    counts?: MessageContentCounts, // TODO: 把发送内容的大小也计入考察当中
  ): Promise<{ isOk: boolean; errors: string[] }> {
    const now = new Date();

    let informee: { place: "group" | "private"; target: number } | undefined =
      undefined;
    if (sourceGroup) {
      informee = {
        place: "group",
        target: sourceGroup,
      };
    } else if (sourceQQ) {
      informee = {
        place: "private",
        target: sourceQQ,
      };
    }

    let isOk = true;
    let errors = [];

    const globalResult = await this.process(
      { scope: "global" },
      now,
      this.thresholds.global,
      informee,
    );
    if (!globalResult.isOk) {
      isOk = false;
      if (globalResult.error) {
        errors.push(globalResult.error);
      }
    }

    if (sourceGroup) {
      const groupResult = await this.process(
        { scope: "group", group: sourceGroup },
        now,
        this.thresholds.group,
      );
      if (!groupResult.isOk) {
        isOk = false;
        if (groupResult.error) {
          errors.push(groupResult.error);
        }
      }
    }

    if (sourceQQ) {
      const userResult = await this.process(
        { scope: "user", qq: sourceQQ },
        now,
        this.thresholds.user,
      );
      if (!userResult.isOk) {
        isOk = false;
        if (userResult.error) {
          errors.push(userResult.error);
        }
      }
    }

    return { isOk, errors };
  }

  private async process(
    scope: AffectScope,
    now: Date,
    threshold: number,
    informee?: {
      place: "group" | "private";
      target: number;
    },
  ): Promise<{ isOk: true } | { isOk: false; error: string | null }> {
    // 检查是否已在冷却
    const isFrozen = await this.checkAndUpdateFreezingStatus(scope, now);
    if (isFrozen) {
      if ("group" in scope || "qq" in scope || !informee) {
        return { isOk: false, error: null };
      }
      const hasInformed = await this.checkAndUpdateHasInformed(
        {},
        informee.place,
        informee.target,
      );
      if (hasInformed) return { isOk: false, error: null };

      const freezeUntil = await getDate(
        this.store,
        { scope: "global" },
        "freeze-until",
      );
      if (!freezeUntil) throw new Error("never");
      const freezeUntilText = makeTimeText(freezeUntil);
      return { isOk: false, error: `全局操作过于频繁，正在冷却（直到 ${freezeUntilText}）` };
    }

    // 获取一分钟内的消息的时间戳
    const oneMinuteAgo = new Date(now);
    oneMinuteAgo.setMinutes(now.getMinutes() - 1);
    oneMinuteAgo.setSeconds(oneMinuteAgo.getSeconds() + 1);
    const outbound = filterOutExpired(
      await getTextList(this.store, scope, "outbound"),
      oneMinuteAgo,
    );

    // 更新记录的消息的时间戳
    const newOutBound = [...outbound, "" + Math.floor(Number(now) / 1000)];
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
        [...formerTriggered, "" + Math.floor(Number(now) / 1000)].join(","),
      );

      // 设置冷却时间
      const freezeUntil = new Date(now);
      freezeUntil.setMinutes(now.getMinutes() + minutes);
      const freezeUntilTs = Math.floor(Number(freezeUntil) / 1000);
      await this.store.set(scope, "freeze-until", String(freezeUntilTs));

      // 返回说明消息
      let place: string;
      if ("group" in scope) {
        place = `本群（${scope.group}）中`;
      } else if ("qq" in scope) {
        place = `用户（${scope.qq}）的`;
      } else {
        place = "全局";
        if (informee) {
          await this.checkAndUpdateHasInformed(
            {},
            informee.place,
            informee.target,
          );
        }
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
    scope: AffectScope,
    now: Date,
  ) {
    const freezeUntil = await getDate(this.store, scope, "freeze-until");
    if (!freezeUntil) return false;
    if (now >= freezeUntil) {
      await this.unfreeze(scope);
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

    const targets = await getTextList(this.store, { scope: "global" }, key);
    if (targets.indexOf("" + target) >= 0) return true;

    const newList = [...targets, "" + target];
    await this.store.set({}, key, newList.join(","));

    return false;
  }

  async isFrozen(scope: AffectScope) {
    return await this.checkAndUpdateFreezingStatus(scope, new Date());
  }

  async unfreeze(
    scope: AffectScope,
    extra: { removeRecords: boolean } = { removeRecords: false },
  ) {
    await this.store.set(scope, "freeze-until", null);
    await this.store.set(scope, "has-informed-group", null);
    await this.store.set(scope, "has-informed-private", null);
    if (extra.removeRecords) {
      await this.store.set(scope, "triggered", null);
      await this.store.set(scope, "outbound", null);
    }
  }
}

/**
 * @param textTss 文本形式的时间戳数组，按由早至晚的顺序排列
 */
function filterOutExpired(textTss: string[], expireAt: Date) {
  const index = textTss
    .findIndex((textTs) => new Date(Number(textTs) * 1000) >= expireAt);
  if (index < 0) return [];
  return textTss.slice(index);
}

async function getTextList(
  store: StoreWrapper,
  scope: AffectScope,
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
  scope: AffectScope,
  key: string,
) {
  const string = (await store.get(scope, key)) as string | null;
  if (!string) return null;
  return new Date(Number(string) * 1000);
}
