import { splitMessagesBySpaces } from "./utils.ts";

import { assertEquals } from "https://deno.land/std@0.134.0/testing/asserts.ts";

import {
  at,
  RegularMessagePiece,
  text,
} from "../../go_cqhttp_client/message_piece.ts";

Deno.test("kubo/command_manager/utils.splitMessagesBySpaces", async (t) => {
  const table: { in: RegularMessagePiece[]; out: RegularMessagePiece[][] }[] = [
    // 1
    { in: [], out: [] },
    // 2
    { in: [text("")], out: [] },
    // 3
    { in: [text("foo")], out: [[text("foo")]] },
    // 4
    { in: [text(" foo ")], out: [[text("foo")]] },
    // 5
    { in: [text("\n"), text("foo")], out: [[text("foo")]] },
    // 6
    { in: [text("foo bar")], out: [[text("foo")], [text("bar")]] },
    // 7
    { in: [text("foo\t \nbar")], out: [[text("foo")], [text("bar")]] },
    // 8
    { in: [text("foo"), at(42)], out: [[text("foo"), at(42)]] },
    // 9
    { in: [text("foo\n"), at(42)], out: [[text("foo")], [at(42)]] },
    // 10
    {
      in: [text("foo"), at(42), text("bar")],
      out: [[text("foo"), at(42), text("bar")]],
    },
    // 11
    {
      in: [text("foo\n"), at(42), text("\nbar")],
      out: [[text("foo")], [at(42)], [text("bar")]],
    },
    // 12
    { in: [at(42), text("foo"), at(42)], out: [[at(42), text("foo"), at(42)]] },
    // 13
    { in: [at(42), text("\n"), at(42)], out: [[at(42)], [at(42)]] },
  ];

  for (const [i, { in: _in, out }] of table.entries()) {
    await t.step(`case ${i + 1}`, () => {
      assertEquals({ i, cmp: splitMessagesBySpaces(_in) }, { i, cmp: out });
    });
  }
});
