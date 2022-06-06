import { KuboPlugin } from "../../../bot.ts";
import { CommandCallback } from "../../../modules/command_manager/models/command_entity.ts";
import {
  _temp_registerCommandWithAliases,
  makeBadArgumentsError,
  makeUsageResponse,
} from "../utils.ts";

const id = "cmd_weight";

const usage = `
weight w
设置列表项的权重。

使用方式：
    （列表项中）…{/w <n>}…
    （本命令允许头部与参数之间没有空白相隔）

选项：
    <n> 权重，正整数或 “Infinity”。

额外说明：
    没有本命令改变权重的列表权重默认为 1。
    若一个列表项包含多个本命令，其最终权重为所有通过本命令设置的权重的总和。
    若列表中存在权重为无限的列表项：
    - 序号选择最多只能选到第一个权重为无限的列表项；
    - 随机选择会从权重为无限的列表项中等概率选取其一。
`.trim();

const callback: CommandCallback = (ctx, args) => {
  if (args.length === 0 || args.filter((arg) => arg.flag === "h").length) {
    return makeUsageResponse(ctx, usage);
  }

  let error: string | null = null;
  let num: number | null;
  if (args.length !== 1) {
    error = `预期 1 个参数，得到 ${args.length} 个参数`;
    num = NaN;
  } else {
    num = args[0].number;
    if (num === null) {
      error = "请提供数字参数";
    } else if (!Number.isInteger(num) && num !== Infinity) {
      error = "请提供整数参数，或者以 Infinity 作为参数";
    } else if (num < 1) {
      error = "请提供正数参数";
    }
  }
  if (error) return makeBadArgumentsError(ctx, [error]);
  if (num === null) throw new Error("never");

  return {
    embedding: `权重=${num}`,
    embeddingRaw: { value: { listItemWeight: num } },
  };
};

export default function () {
  const plugin: KuboPlugin = {
    id,

    init(bot) {
      _temp_registerCommandWithAliases(bot.commands, "weight", {
        readableName: "权重",
        description: "设置列表项权重",
        supportedStyles: "embedded",
        argumentsBeginningPolicy: "unrestricted",
        callback,
      }, ["w"]);
    },
  };

  return plugin;
}
