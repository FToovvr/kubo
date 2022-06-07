import {
  RegularMessagePiece,
  text,
} from "../../../../go_cqhttp_client/message_piece.ts";
import { KuboPlugin } from "../../../bot.ts";
import { CommandArgument } from "../../../modules/command_manager/models/command_argument.ts";
import {
  CommandCallback,
  CommandCallbackReturnValue,
  CommandUsageCallback,
} from "../../../modules/command_manager/models/command_entity.ts";
import { generateEmbeddedOutput } from "../../../modules/command_manager/models/command_piece.ts";
import { ExecutedLine } from "../../../modules/command_manager/types.ts";
import utils from "../../../utils.ts";
import {
  getShortestHead,
  makeBadArgumentsError,
  makeUnknownArgumentErrorText,
  makeUsageResponse,
} from "../utils.ts";

// TODO: 响应 /?c 命令时，应该允许 /c3 这样头部与参数没有空白的写法。
//       方式也许可以是允许附带特殊参数而添加重名的命令，
//       然后让允许没有空白的命令优先级更高一些。
// TODO: 也许在第一个候选项不是数字时，可以允许省略 "--"。
const id = "cmd_choose";

function makeUsageHead(prefix: string, heads: string[]) {
  return `
${heads.map((head) => prefix + head).join(" ")}
从多个候选内容中选出一个结果。根据选项，可以自选，也可以随取。
    `.trim();
}

function makeUsageExample(prefix: string, head: string) {
  return `
示例：
    > ${prefix}${head} -- 石头 剪刀 布
    ➩ “石头” “剪刀” “布” 随机等概率选取

    > ${prefix}${head} 3 -- { São Paulo } 上海 { New York }
    ➩ “New York”（指定了序号 “3”，因此返回第三个结果 “New York”）
    （花括号允许空白内容）

    > ${prefix}${head}
    > - 33.3%
    > - {/w2} 66.7%
    ➩ “- 33.3%” 或 “- « /w⇒权重=2 »66.7%”（概率分别为 1/3 与 2/3）
    （可以在命令后方加上 \`-list\` 参数，以明确表示候选项来自列表）
    （\`w\` 命令用于修改权重（权重默认为 1））
`.trim();
}

const usageCallback: CommandUsageCallback = ({ prefix, head, aliases }) => {
  const heads = [head, ...aliases];
  const usageHead = makeUsageHead(prefix, heads);

  return `
${usageHead}

使用方式：
    choose [<nth>] -- <候选内容项>…

    choose [<nth>] [-list]
    <列表>

${makeUsageExample(prefix, getShortestHead(heads))}

选项：
    -h -help  输出帮助文本（本文本）

    <nth> 序号，要选择第几个内容（由 1 开始计数）

    --        指示候选内容来自后面的参数，如此使用时不可省略
    -l -list  指示候选内容来自下一行开始的列表，可以省略

内容：
    <候选内容项>...
      数个候选内容，由空白分割。
      如内容本身包含空白，需要用花括号（\`{\`、\`}\`）将内容包含。

    <列表>
      列表由列表项组成，每行列表项以 “-”“+”“*” 其一开头。 
      每个列表项都是一个候选内容，无需额外处理其中的空白。
      只能在整行书写形式中使用，不能在嵌入书写形式中使用。
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
  let shouldSendUsage = false;
  let possibleSources: "list" | "arg" | "both" = "both";
  let errors: string[] = [];

  let nth: bigint | null = null;
  let argLots: CommandArgument[] | null = null;

  for (const [i, arg] of args.entries()) {
    const flag = arg.flag;
    if (flag) {
      if (flag === "h" || flag === "help") {
        shouldSendUsage = true;
      } else if (flag === "l" || flag === "list") {
        if (possibleSources !== "both") {
          errors.push("重复的 -list 参数");
          continue;
        }
        possibleSources = "list";
      } else if (flag === "-") {
        if (possibleSources === "list") {
          errors.push("已包含 -list，不能在参数列表中包含候选内容");
          break;
        }
        possibleSources = "arg";
        argLots = args.slice(i + 1);
        break;
      } else {
        errors.push(`未知标志 -${flag}`);
      }
      continue;
    }
    const number = arg.bigint;
    if (number === null && arg.number !== null) {
      errors.push("序号并非整数");
    } else if (number !== null) {
      if (nth !== null) {
        errors.push("参数列表中存在多个序号");
      } else if (number < 1) {
        errors.push("序号并非正数");
      } else {
        nth = number;
      }
      continue;
    }
    errors.push(makeUnknownArgumentErrorText(i, arg));
  }

  let isByRandom = nth === null;

  if (shouldSendUsage) {
    return makeUsageResponse(ctx, makeSimpleUsage(ctx.prefix ?? "", ctx.head));
  }
  if (errors.length) return makeBadArgumentsError(ctx, errors);

  if (argLots) {
    if (!argLots.length) return { error: "已指定候选参数位于参数列表，但参数列表中没有候选内容！" };
    let chosen: CommandArgument;
    if (nth) {
      chosen = argLots[Number((nth - 1n) % BigInt(argLots.length))];
    } else {
      chosen = argLots[utils.randInt(0, argLots.length - 1)];
    }
    let out: RegularMessagePiece[];
    if (chosen.content.type === "__kubo_group") {
      out = generateEmbeddedOutput(chosen.content.asFlat(false));
    } else {
      out = chosen.evaluated;
    }
    return makeResponse(ctx.isEmbedded, out, isByRandom);
  }

  // 从这里开始处理列表

  const listLines = ctx.getFollowing("list");
  if (listLines.length === 0) {
    if (possibleSources === "both") {
      return makeUsageResponse(
        ctx,
        makeSimpleUsage(ctx.prefix ?? "", ctx.head),
      );
    }
    if (possibleSources === "list") return { error: "命令下方不存在列表！" };
    throw new Error("never");
  }

  type ListLot = { line: ExecutedLine; weight: bigint | null };
  const listLots: ListLot[] = [];

  for (const line of listLines) {
    listLots.push({ line, weight: null });
    for (const piece of line) {
      if (piece.type !== "__kubo_executed_command") continue;
      const value = piece.result?.embeddingRaw?.value ?? {};
      if (!("listItemWeight" in value)) continue;
      const weight = value.listItemWeight;
      if (typeof weight !== "bigint") continue;
      const oldWeight = listLots[listLots.length - 1].weight;
      listLots[listLots.length - 1].weight = (oldWeight ?? 0n) + weight;
    }
  }

  let totalWeight = 0n;
  for (const lot of listLots) {
    if (lot.weight === null) {
      lot.weight = 1n;
    } else if (lot.weight < 0n) {
      lot.weight = 0n;
    }
    totalWeight += lot.weight;
  }
  if (totalWeight === 0n) {
    return { error: "总权重不能为 0！" };
  }
  if (nth !== null) {
    nth = ((nth - 1n) % totalWeight) + 1n;
  } else {
    const totalWeightNum = Number(totalWeight);
    if (BigInt(~~totalWeightNum) !== totalWeight) {
      return { error: "权重总和过大，JavaScript 的 number 类型无法精准容纳！" };
    }
    nth = BigInt(utils.randInt(1, totalWeightNum));
  }

  let remain = nth;
  for (const lot of listLots) {
    if (remain > lot.weight!) {
      remain -= lot.weight!;
      continue;
    }
    const chosen = lot.line;
    return makeResponse(
      ctx.isEmbedded,
      generateEmbeddedOutput(chosen),
      isByRandom,
    );
  }

  throw new Error("never");
};

function makeResponse(
  isEmbedded: boolean,
  chosen: RegularMessagePiece[],
  isByRandom: boolean,
): CommandCallbackReturnValue {
  if (isEmbedded) {
    return {
      embedding: chosen,
      embeddingRaw: { value: { result: chosen } },
    };
  }
  // NOTE: 暂时不根据是否随机改变文本了，因为程序很容易就能被迷惑住。
  //       倒不如直接观察命令具体是怎么写的，那样更靠谱。
  return { response: [text("选择的是："), ...chosen] };
}

export default function () {
  const plugin: KuboPlugin = {
    id,

    init(bot) {
      const entity = bot.commands.registerCommand("choose", {
        readableName: "选择",
        description: "从候选内容中任选其一",
        callback,
        usageCallback,
      });
      bot.commands.registerAlias(entity, ["c", "选择"]);
    },
  };

  return plugin;
}
