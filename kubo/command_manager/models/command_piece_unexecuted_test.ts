import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.134.0/testing/asserts.ts";
import {
  at,
  RegularMessagePiece,
  text,
} from "../../../go_cqhttp_client/message_piece.ts";
import { _test_makeContext } from "../test_utils.ts";
import { tokenizeMessage, TokenizingContext } from "../tokenizer.ts";
import { UnexecutedCommandPiece } from "./command_piece_unexecuted.ts";

const testPrefixUnexecutedCmd =
  `kubo/command_manager//command_piece_unexecuted`;

Deno.test(`${testPrefixUnexecutedCmd} isSqueezed`, () => {
  const context = _test_makeContext(["foo"]);

  const table: {
    in: RegularMessagePiece[];
    isSqueezed: boolean;
  }[] = [
    { in: [text("foo")], isSqueezed: false },
    { in: [text("foo ")], isSqueezed: false },
    { in: [text("/foo")], isSqueezed: false },
    { in: [text("/foo\t\n")], isSqueezed: false },
    { in: [text("{/foo}")], isSqueezed: false },
    { in: [text("{/foo  }")], isSqueezed: false },
    { in: [text("{/foo 123 }")], isSqueezed: false },
    { in: [text("foo123")], isSqueezed: true },
    { in: [text("/foo123")], isSqueezed: true },
    { in: [text("{/foo123}")], isSqueezed: true },
    { in: [text("/foo"), at(42)], isSqueezed: false },
    { in: [text("{/foo"), at(42), text("}")], isSqueezed: false },
  ];

  for (const { in: _in, isSqueezed } of table) {
    const uCmd = getFirstCommandPiece(context, _in);
    assertEquals(
      uCmd.isSqueezed,
      isSqueezed,
      `in: ${_in}, actual: ${uCmd.isSqueezed}, expected: ${isSqueezed}, cmd: ${
        JSON.stringify({ ...uCmd }, null, 2)
      }`,
    );
  }
});

Deno.test(`${testPrefixUnexecutedCmd} reconstructRaw`, () => {
  const context = _test_makeContext(["foo"]);

  const table: {
    in: RegularMessagePiece[];
  }[] = [
    { in: [text("foo")] },
    { in: [text("foo ")] },
    { in: [text("foo 123  456\t789")] },
    { in: [text("{/foo}")] },
    { in: [text("{/foo\n\t}")] },
    { in: [text("{/foo  \n  123  456}")] },
    { in: [text("/foo{  /foo  \n  123{/foo   }"), at(42), text("  456}")] },
  ];

  for (const { in: _in } of table) {
    const uCmd = getFirstCommandPiece(context, _in);
    assertEquals(uCmd.raw, _in);
  }
});

function getFirstCommandPiece(
  context: TokenizingContext,
  msg: RegularMessagePiece[],
) {
  const pieces = tokenizeMessage(context, msg);
  assert(pieces?.[0]?.[0].type === "__kubo_unexecuted_command");
  return pieces[0][0] as UnexecutedCommandPiece;
}
