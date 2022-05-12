import { regularizeMessage } from "./regularize.ts";

import { assertEquals } from "https://deno.land/std@0.134.0/testing/asserts.ts";

import { at, text } from "../../go_cqhttp_client/message_piece.ts";
import { MessagePieceForTokenizer } from "./tokenizer.ts";
import {
  _test_cleaningCommands,
  _test_makeContext,
  _test_makePreCommandPiece,
  _test_makeUnexecutedCommandPiece,
} from "./test_utils.ts";
import { linefeedPiece } from "./models/command_piece_pre.ts";
import { MessageLineIncludingUnexecutedCommands } from "./types.ts";

interface Row {
  in: (MessagePieceForTokenizer | string)[];
  out: MessageLineIncludingUnexecutedCommands[];
}

async function testRegularizeMessage(table: Row[], t: Deno.TestContext) {
  for (const [i, row] of table.entries()) {
    await t.step(`case ${i + 1}`, () => {
      assertEquals(
        _test_cleaningCommands(regularizeMessage(row.in), {
          removesSpaceRelatedProperties: false,
        }),
        row.out,
      );
    });
  }
}

const testPrefix = "kubo/command_manager/regularize";
const testPrefixCmd = `${testPrefix} 命令`;

Deno.test(`${testPrefix} 一般内容`, async (t) => {
  await testRegularizeMessage([
    { in: [], out: [] },
    { in: [text("1"), text("2")], out: [[text("12")]] },
    { in: [text("1"), "2", text("3")], out: [[text("123")]] },
    { in: [text("1"), at(2)], out: [[text("1"), at(2)]] },
    { in: [text("1"), linefeedPiece, at(2)], out: [[text("1")], [at(2)]] },
    { in: [text("1 2")], out: [[text("1 2")]] },
  ], t);
});

Deno.test(`${testPrefixCmd}:嵌入、等待组合`, async (t) => {
  for (const isEmbedded of [false, true]) {
    for (const isAwait of [false, true]) {
      await testRegularizeMessage([{
        in: [_test_makePreCommandPiece(["foo"], { isEmbedded, isAwait })],
        out: [[
          _test_makeUnexecutedCommandPiece(["foo"], { isEmbedded, isAwait }),
        ]],
      }], t);
    }
  }
});

Deno.test(`${testPrefixCmd}`, async (t) => {
  await testRegularizeMessage([
    {
      in: [
        _test_makePreCommandPiece(["foo"], {}, [
          at(42),
          "bar",
          text("f oo "),
          at(42),
        ]),
      ],
      out: [[
        _test_makeUnexecutedCommandPiece(["foo"], {}, [
          [at(42), text("barf")],
          [text("oo")],
          [at(42)],
        ]),
      ]],
    },
    {
      in: [
        _test_makePreCommandPiece(["foo"], {}, [
          "foo\tbar",
          linefeedPiece,
          "baz",
        ]),
      ],
      out: [[
        _test_makeUnexecutedCommandPiece(["foo"], {}, [
          [text("foo")],
          [text("bar")],
          [text("baz")],
        ]),
      ]],
    },
    {
      in: [
        _test_makePreCommandPiece(["foo"], {}, [
          "foo",
          _test_makePreCommandPiece(["bar"], { isEmbedded: true }, [
            linefeedPiece,
            linefeedPiece,
            "bar",
            linefeedPiece,
            "\t ",
          ]),
        ]),
      ],
      out: [[
        _test_makeUnexecutedCommandPiece(["foo"], {}, [
          [
            text("foo"),
            _test_makeUnexecutedCommandPiece(["bar"], { isEmbedded: true }, [
              [text("bar")],
            ]),
          ],
        ]),
      ]],
    },
  ], t);
});
