import { assertEquals } from "https://deno.land/std@0.134.0/testing/asserts.ts";

import { MessagePiece } from "../../../go_cqhttp_client/message_piece.ts";
import { SensitiveFilter } from "./sensitive_filter.ts";

function arr2Msg(arr: [string, any][]) {
  return arr.map(([type, data]) => ({ type, data }) as MessagePiece);
}

Deno.test("sensitive_filter", () => {
  assertEquals(
    (new SensitiveFilter(["bar", "z"])).filter("foobarbaz"),
    "foo○○○ba○",
  );
  assertEquals(
    (new SensitiveFilter(["bar", "z"])).filter(
      arr2Msg([["text", { text: "foobarbaz" }]]),
    ),
    arr2Msg([["text", { text: "foo○○○ba○" }]]),
  );
  assertEquals(
    (new SensitiveFilter(["_abc", "abcd"])).filter(
      arr2Msg([["text", { text: "__abcdef" }]]),
    ),
    arr2Msg([["text", { text: "_○○○○○ef" }]]),
  );
  assertEquals(
    (new SensitiveFilter(["sens", "tive"])).filter(
      arr2Msg([
        ["text", { text: "some" }],
        ["at", { qq: "123" }],
        ["text", { text: "!!sensi-" }],
        ["foo", { text: "-tive!!" }],
        ["text", { text: "messages" }],
      ]),
    ),
    arr2Msg([
      ["text", { text: "some" }],
      ["at", { qq: "123" }],
      ["text", { text: "!!○○○○i-" }],
      ["foo", { text: "-tive!!" }],
      ["text", { text: "messages" }],
    ]),
  );
});
