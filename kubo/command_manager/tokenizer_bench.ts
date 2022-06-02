import { text } from "../../go_cqhttp_client/message_piece.ts";
import { _test_makeContext } from "./test_utils.ts";
import { tokenizeMessage } from "./tokenizer.ts";

const testPrefix = "kubo/command_manager/tokenizer" as const;

// FIXME: 虽然无伤大雅，但这里 `r` 的参数起始策略是 "follows-spaces"
//        因此魔物那一行的 /r 不会被识别上。
const context = _test_makeContext(["c", "w", "r"]);

const textToParse = `你走出小镇，往王都的方向出发，遇到了…
/c -list
- {/w3} 一支向边境方向行进的商队。
- {/w3} 魔物，是 { /c -- 史莱姆 { 哥布林 lv{/r10+d10} } 沙虫 }
- {/w3} 遗落在路边的金币，价值 { /rd100 }
- { /c -- 大成功 大失败 }`;

Deno.bench({ name: `${testPrefix} 解析消息` }, () => {
  tokenizeMessage(context, [text(textToParse)]);
});
