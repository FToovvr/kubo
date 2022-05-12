import { tokenizeMessage, TokenizingContext } from "./tokenizer.ts";

import { assertEquals } from "https://deno.land/std@0.134.0/testing/asserts.ts";

import { at, text } from "../../go_cqhttp_client/message_piece.ts";
import {
  _test_cleaningCommands,
  _test_makeContext,
  _test_makeUnexecutedCommandPiece,
} from "./test_utils.ts";

interface Row {
  in: Parameters<typeof tokenizeMessage>[1];
  out: ReturnType<typeof tokenizeMessage>;
}

async function testTokenizeMessage(
  ctx: TokenizingContext,
  args: { ignoreSpaceRelatedStuffOnCommands?: boolean },
  table: Row[],
  t: Deno.TestContext,
) {
  args = {
    ignoreSpaceRelatedStuffOnCommands: true,
    ...args,
  };
  for (const [i, { in: _in, out: _expectedOut }] of table.entries()) {
    await t.step(`case ${i + 1}`, () => {
      const cArgs: Parameters<typeof _test_cleaningCommands>[1] = {
        removesSpaceRelatedProperties: args.ignoreSpaceRelatedStuffOnCommands!,
      };
      const actualOut = _test_cleaningCommands(
        tokenizeMessage(ctx, _in),
        cArgs,
      );
      const expectedOut = _test_cleaningCommands(_expectedOut, cArgs);
      assertEquals(actualOut, expectedOut);
    });
  }
}

const testPrefix = "kubo/command_manager/tokenizer";
const testPrefixLineCmd = `${testPrefix} 行命令与整体命令`;
const testPrefixEmbeddedCmd = `${testPrefix} 嵌入命令`;
const testPrefixNesting = `${testPrefix} 命令嵌套`;
const testPrefixAwait = `${testPrefix} 等待型命令`;
const testPrefixSpaceBeforeArguments = `${testPrefix} 参数列表前的空白`;

Deno.test(`${testPrefix} 无命令`, async (t) => {
  await testTokenizeMessage(_test_makeContext(), {}, [
    { in: [], out: [] },
    { in: [text("foo")], out: [[text("foo")]] },
    { in: [text("foo bar")], out: [[text("foo bar")]] },
    { in: [text("foo\nbar")], out: [[text("foo")], [text("bar")]] },
    { in: [text("foo/bar")], out: [[text("foo/bar")]] },
  ], t);
});

Deno.test(`${testPrefixLineCmd}:命令识别`, async (t) => {
  await testTokenizeMessage(_test_makeContext(["foo"]), {}, [
    { in: [text("fo")], out: [[text("fo")]] },
    {
      in: [text("\n/foo\nbar")],
      out: [[], [_test_makeUnexecutedCommandPiece(["foo"])], [text("bar")]],
    },
    { in: [text(" /foo")], out: [[text(" /foo")]] },
    {
      in: [text("foo")],
      out: [[_test_makeUnexecutedCommandPiece(["foo"], { prefix: null })]],
    },
    { in: [text("\nfoo")], out: [[], [text("foo")]] },
  ], t);
});

Deno.test(`${testPrefixLineCmd}:重叠命令`, async (t) => {
  await testTokenizeMessage(_test_makeContext(["fo", "foo", "fooo"]), {}, [
    {
      in: [text("/foo")],
      out: [[_test_makeUnexecutedCommandPiece(["fo", "foo"])]],
    },
  ], t);
});

Deno.test(`${testPrefixLineCmd}:前缀`, async (t) => {
  await testTokenizeMessage(_test_makeContext(["foo"], "//"), {}, [
    {
      in: [text("//foo")],
      out: [[_test_makeUnexecutedCommandPiece(["foo"], { prefix: "//" })]],
    },
  ], t);
});

Deno.test(`${testPrefixLineCmd}:参数`, async (t) => {
  await testTokenizeMessage(_test_makeContext(["foo"]), {}, [
    {
      in: [text("/foo 123 4")],
      out: [[
        _test_makeUnexecutedCommandPiece(["foo"], {}, [
          [text("123")],
          [text("4")],
        ]),
      ]],
    },
    {
      in: [text("/foo123")],
      out: [
        [_test_makeUnexecutedCommandPiece(["foo"], {
          // XXX: 这部分测试忽略掉了与命令的空白相关的内容
          // hasSpaceBeforeArguments: false,
        }, [[text("123")]])],
      ],
    },
    {
      in: [text("/foo "), text("123"), at(42), text("123 "), at(42)],
      out: [[
        _test_makeUnexecutedCommandPiece(["foo"], {}, [
          [text("123"), at(42), text("123")],
          [at(42)],
        ]),
      ]],
    },
    {
      in: [text("/foo"), at(42)],
      out: [
        [_test_makeUnexecutedCommandPiece(["foo"], {}, [[at(42)]])],
      ],
    },
  ], t);
});

Deno.test(`${testPrefixEmbeddedCmd}:命令识别`, async (t) => {
  await testTokenizeMessage(_test_makeContext(["foo"]), {}, [
    { in: [text("{foo}")], out: [[text("{foo}")]] },
    { in: [text("{ barbar /foo}")], out: [[text("{ barbar /foo}")]] },
    { in: [text("{ /null }")], out: [[text("{ /null }")]] },
    { in: [text("bar { /null }")], out: [[text("bar { /null }")]] },
    {
      in: [text("{/foo}")],
      out: [[
        _test_makeUnexecutedCommandPiece(["foo"], { isEmbedded: true }),
      ]],
    },
    {
      in: [text("{/foo}bar")],
      out: [[
        _test_makeUnexecutedCommandPiece(["foo"], { isEmbedded: true }),
        text("bar"),
      ]],
    },
    {
      in: [text("bar{/foo}")],
      out: [[
        text("bar"),
        _test_makeUnexecutedCommandPiece(["foo"], { isEmbedded: true }),
      ]],
    },
    {
      in: [text("bar\n{/foo}")],
      out: [
        [text("bar")],
        [_test_makeUnexecutedCommandPiece(["foo"], { isEmbedded: true })],
      ],
    },
    {
      in: [text("{/foo}{/foo}")],
      out: [
        [
          _test_makeUnexecutedCommandPiece(["foo"], { isEmbedded: true }),
          _test_makeUnexecutedCommandPiece(["foo"], { isEmbedded: true }),
        ],
      ],
    },
  ], t);
});

Deno.test(`${testPrefixNesting}:行命令中的嵌入命令`, async (t) => {
  await testTokenizeMessage(_test_makeContext(["foo", "bar"]), {}, [
    {
      in: [text("foo{/bar}baz")],
      out: [[
        _test_makeUnexecutedCommandPiece(["foo"], { prefix: null }, [
          [
            _test_makeUnexecutedCommandPiece(["bar"], { isEmbedded: true }),
            text("baz"),
          ],
        ]),
      ]],
    },
    {
      in: [text("/foo { /null }")],
      out: [[
        _test_makeUnexecutedCommandPiece(["foo"], {}, [
          [text("{")],
          [text("/null")],
          [text("}")],
        ] // TODO!: 引入 { … } 后要合在一起
        ),
      ]],
    },
  ], t);
});

Deno.test(`${testPrefixNesting}:嵌入命令中的行命令`, async (t) => {
  await testTokenizeMessage(_test_makeContext(["foo", "bar"]), {}, [
    { // 目前不允许嵌入命令中带有行命令，因此不解析
      in: [text("{/foo\n/foo}")],
      out: [
        [
          _test_makeUnexecutedCommandPiece(["foo"], { isEmbedded: true }, [
            [text("/foo")],
          ]),
        ],
      ],
    },
  ], t);
});

Deno.test(`${testPrefixNesting}:嵌入命令中的嵌入命令`, async (t) => {
  await testTokenizeMessage(_test_makeContext(["foo", "bar", "baz"]), {}, [
    {
      in: [text("{/foo{/bar {/baz}a}}")],
      out: [
        [
          _test_makeUnexecutedCommandPiece(["foo"], { isEmbedded: true }, [
            [_test_makeUnexecutedCommandPiece(["bar"], { isEmbedded: true }, [
              [
                _test_makeUnexecutedCommandPiece(["baz"], { isEmbedded: true }),
                text("a"),
              ],
            ])],
          ]),
        ],
      ],
    },
    {
      in: [text("{/bar {baz}a}")],
      out: [
        [
          _test_makeUnexecutedCommandPiece(["bar"], { isEmbedded: true }, [
            [text("{baz}a")],
          ]),
        ],
      ],
    },
    {
      in: [text("{/bar {/baz}")],
      out: [
        [
          text("{/bar "),
          _test_makeUnexecutedCommandPiece(["baz"], { isEmbedded: true }),
        ],
      ],
    },
  ], t);
});

Deno.test(`${testPrefixAwait}`, async (t) => {
  await testTokenizeMessage(_test_makeContext(["foo"]), {}, [
    { in: [text("?foo")], out: [[text("?foo")]] },
    {
      in: [text("/?foo")],
      out: [[_test_makeUnexecutedCommandPiece(["foo"], { isAwait: true })]],
    },
    { in: [text("{?foo}")], out: [[text("{?foo}")]] },
    {
      in: [text("{/?foo}")],
      out: [[
        _test_makeUnexecutedCommandPiece(["foo"], {
          isEmbedded: true,
          isAwait: true,
        }),
      ]],
    },
  ], t);
});

Deno.test(`${testPrefixSpaceBeforeArguments}`, async (t) => {
  await testTokenizeMessage(_test_makeContext(["foo"]), {
    ignoreSpaceRelatedStuffOnCommands: false,
  }, [
    {
      in: [text("/foobar")],
      out: [[
        _test_makeUnexecutedCommandPiece(
          ["foo"],
          { spaceBeforeArguments: "" },
          [[text("bar")]],
        ),
      ]],
    },
    {
      in: [text("/foo  ")],
      out: [[
        _test_makeUnexecutedCommandPiece(
          ["foo"],
          { spaceBeforeArguments: "  " },
        ),
      ]],
    },
    {
      in: [text("/foo bar")],
      out: [[
        _test_makeUnexecutedCommandPiece(
          ["foo"],
          { spaceBeforeArguments: " " },
          [[text("bar")]],
        ),
      ]],
    },
    {
      in: [text("/foo\t bar")],
      out: [[
        _test_makeUnexecutedCommandPiece(
          ["foo"],
          { spaceBeforeArguments: "\t " },
          [[text("bar")]],
        ),
      ]],
    },
    {
      in: [text("{/foo  }")],
      out: [[
        _test_makeUnexecutedCommandPiece(
          ["foo"],
          { spaceBeforeArguments: "  ", isEmbedded: true },
        ),
      ]],
    },
    {
      in: [text("{/foo\t bar}")],
      out: [[
        _test_makeUnexecutedCommandPiece(
          ["foo"],
          { spaceBeforeArguments: "\t ", isEmbedded: true },
          [[text("bar")]],
        ),
      ]],
    },
    {
      in: [text("{/foo\n\t bar}")],
      out: [[
        _test_makeUnexecutedCommandPiece(
          ["foo"],
          { spaceBeforeArguments: "\n\t ", isEmbedded: true },
          [[text("bar")]],
        ),
      ]],
    },
  ], t);
});

// Deno.test("temp", () => {
//   await testTokenizeMessage(makeContext(["foo"]), {
//     ignoreSpaceRelatedStuffOnCommands: false,
//   }, [

//   ]);
// });
