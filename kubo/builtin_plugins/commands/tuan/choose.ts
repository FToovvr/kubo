import {
  RegularMessagePiece,
  text,
} from "../../../../go_cqhttp_client/message_piece.ts";
import { KuboPlugin } from "../../../bot.ts";
import { LooseCommandEntity } from "../../../modules/command_manager/manager.ts";
import { CommandArgument } from "../../../modules/command_manager/models/command_argument.ts";
import {
  CommandCallback,
  CommandCallbackReturnValue,
} from "../../../modules/command_manager/models/command_entity.ts";
import { generateEmbeddedOutput } from "../../../modules/command_manager/models/command_piece.ts";
import { ExecutedLine } from "../../../modules/command_manager/types.ts";
import utils from "../../../utils.ts";
import {
  makeBadArgumentsError,
  makeUnknownArgumentErrorText,
  makeUsageResponse,
} from "../utils.ts";

const id = "cmd_choose";

// TODO: 响应 /?c 命令时，应该允许 /c3 这样头部与参数没有空白的写法。
//       方式也许可以是允许附带特殊参数而添加重名的命令，
//       然后让允许没有空白的命令优先级更高一些。
const usage = `
choose c
从多个候选内容中选出一个结果。根据选项，可以自选，也可以随取。

使用方式：
    choose [<nth>] -- <候选内容项>…

    choose [<nth>] [-list]
    <列表>

示例：
    > /choose -- 苹果 鸭梨 香蕉
    ➩ “苹果”“鸭梨”“香蕉” 之间任选一个（相同概率）

    > /choose 3 -- { São Paulo } 上海 { New York } Sydney
    ➩ “New York”
    （花括号允许内容中间带有空白，返回第三个结果 “New York”）

    > /choose
    > - 33.3%
    > - {/w2} 66.7%
    ➩ “- 33.3%” 或 “- « /w⇒权重=2 »66.7%”（概率分别为 1/3 与 2/3）
    （\`-list\` 标志在这里被省略）
    （\`w\` 命令将默认为 1 的权重改为其正整数参数对应的数值，需要位于列表项的标志之后）

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

const callback: CommandCallback = async (ctx, args) => {
  let shouldSendUsage = false;
  let possibleSources: "list" | "arg" | "both" = "both";
  let errors: string[] = [];

  let nth: number | null = null;
  let argLots: CommandArgument[] | null = null;

  console.log(Deno.inspect({ args }, { depth: Infinity, colors: true }));

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
    const number = arg.number;
    if (number !== null) {
      if (nth !== null) {
        errors.push("参数列表中存在多个序号");
      } else if (!Number.isInteger(number)) {
        errors.push("序号并非整数");
      } else if (number < 1) {
        errors.push("序号并非正数");
      } else if (number === Infinity) {
        errors.push("序号过大");
      } else {
        nth = number;
      }
      continue;
    }
    errors.push(makeUnknownArgumentErrorText(i, arg));
  }

  let isByRandom = nth === null;

  if (shouldSendUsage) return makeUsageResponse(ctx, usage);
  if (errors.length) return makeBadArgumentsError(ctx, errors);

  if (argLots) {
    if (!argLots.length) return { error: "已指定候选参数位于参数列表，但参数列表中没有候选内容！" };
    let chosen: CommandArgument;
    if (nth) {
      chosen = argLots[(nth - 1) % argLots.length];
    } else {
      chosen = argLots[utils.randInt(0, argLots.length - 1)];
    }
    return makeResponse(ctx.isEmbedded, chosen.evaluated, isByRandom);
  }

  // 从这里开始处理列表

  const listLines = ctx.getFollowing("list");
  if (listLines.length === 0) {
    if (possibleSources === "both") return makeUsageResponse(ctx, usage);
    if (possibleSources === "list") return { error: "命令下方不存在列表！" };
    throw new Error("never");
  }

  type ListLot = { line: ExecutedLine; weight: number };
  const listLots: ListLot[] = [];
  const infLists: ExecutedLine[] = [];

  for (const line of listLines) {
    listLots.push({ line, weight: 0 });
    for (const piece of line) {
      if (piece.type !== "__kubo_executed_command") continue;
      const value = piece.result?.embeddingRaw?.value ?? {};
      if (!("listItemWeight" in value)) continue;
      const weight = value.listItemWeight;
      if (typeof value !== "number") continue;
      if (!Number.isInteger(value) && value !== Infinity) continue;
      listLots[listLots.length - 1].weight += weight;
    }
    if (listLots[listLots.length - 1].weight === Infinity) {
      infLists.push(line);
    }
  }

  if (infLists.length && !nth) {
    const chosen = infLists[utils.randInt(0, infLists.length - 1)];
    return makeResponse(
      ctx.isEmbedded,
      generateEmbeddedOutput(chosen),
      isByRandom,
    );
  }

  let totalWeight = 0;
  for (const lot of listLots) {
    if (lot.weight === 0) {
      lot.weight = 1;
    }
    totalWeight += lot.weight;
  }
  if (nth !== null) {
    nth = ((nth - 1) % totalWeight) + 1;
  } else {
    nth = utils.randInt(1, totalWeight);
  }

  let remain = nth;
  for (const lot of listLots) {
    if (remain > lot.weight) {
      remain -= lot.weight;
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
      // TODO: 以 choose 为正式命令，以 c 为别名。
      const entity: LooseCommandEntity = {
        readableName: "选择",
        description: "从候选内容中任选其一",
        callback,
      };
      bot.commands.registerCommand("choose", entity);
      bot.commands.registerCommand("c", entity);
    },
  };

  return plugin;
}
