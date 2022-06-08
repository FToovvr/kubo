import { KuboPlugin } from "../../../bot.ts";
import {
  CommandCallback,
  CommandUsageCallback,
} from "../../../modules/command_manager/models/command_entity.ts";
import {
  getShortestHead,
  hasHelpFlag,
  makeBadArgumentsError,
  makeUsageResponse,
} from "../utils.ts";

const id = "cmd_weight";

function makeUsageHead(prefix: string, heads: string[]) {
  return `
${heads.map((head) => prefix + head).join(" ")}
设置列表项的权重。
    `.trim();
}

function makeUsageExample(prefix: string, head: string) {
  return `
示例：
    > ${prefix}c
    > - 这一项没有设置权重，因此权重为 1，被选中的概率是 1/20
    > - {${prefix}${head}15} 这一项的权重是 15，被选中的概率是 15/20
    > - {${prefix}${head}1} 存在多个权重取总和，{${prefix}${head}3} 这一项的权重是 4，被选中的概率是 4/20
    > - {${prefix}${head}0} 这一项的权重是 0，因此不会被选到
`.trim();
}

const usageCallback: CommandUsageCallback = ({ prefix, head, aliases }) => {
  const heads = [head, ...aliases];
  const usageHead = makeUsageHead(prefix, heads);

  return `
${usageHead}

使用方式：
    （列表项中）…{${prefix}${head} <n>}…
    （本命令允许头部与参数之间没有空白相隔）

${makeUsageExample(prefix, getShortestHead(heads))}

选项：
    <n> 权重，正整数。

额外说明：
    没有本命令改变权重的列表权重默认为 1。
    若一个列表项包含多个本命令，其最终权重为所有通过本命令设置的权重的总和。
    若列表中存在权重为无限的列表项：
    - 序号选择最多只能选到第一个权重为无限的列表项；
    - 随机选择会从权重为无限的列表项中等概率选取其一。
  `.trim();
};

function makeSimpleUsage(prefix: string, head: string) {
  return `
${makeUsageHead(prefix, [head])}

${makeUsageExample(prefix, head)}

完整帮助信息请使用 \`${prefix}cmd help ${head}\` 查询。
  `.trim();
}

const callback: CommandCallback = (ctx, args) => {
  if (args.length === 0 || hasHelpFlag(args)) {
    return makeUsageResponse(ctx, makeSimpleUsage(ctx.prefix ?? "", ctx.head));
  }

  let error: string | null = null;
  let num: bigint | null;
  if (args.length !== 1) {
    error = `预期 1 个参数，得到 ${args.length} 个参数`;
    num = null;
  } else {
    num = args[0].bigint;
    if (num === null) {
      error = "请提供整数参数";
    } else if (num < 0n) {
      error = "请提供非负数参数";
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
      const entity = bot.commands.registerCommand("weight", {
        readableName: "权重",
        description: "设置列表项权重",
        supportedStyles: "embedded",
        argumentsBeginningPolicy: "unrestricted",
        callback,
        usageCallback,
      });
      bot.commands.registerAlias(entity, ["w", "权重"]);
    },
  };

  return plugin;
}
