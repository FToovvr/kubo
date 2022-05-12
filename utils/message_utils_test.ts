import { arr2Msg, splitMessageIntoLines } from "./message_utils.ts";

import { assertEquals } from "https://deno.land/std@0.134.0/testing/asserts.ts";

import {
  At,
  at,
  RegularMessagePiece,
  Reply,
  reply,
  text,
} from "../go_cqhttp_client/message_piece.ts";
import {
  extractReferenceFromMessage,
  mergeAdjoiningTextPiecesInPlace,
  tryExtractPureText,
} from "./message_utils.ts";

type Arr2MsgParam = Parameters<typeof arr2Msg>[0];

Deno.test("utils/message_utils.tryExtractPureText", async (t) => {
  const table: { in: Arr2MsgParam; out: string | null }[] = [
    // 只有纯文本
    { in: [["text", { text: "foo" }]], out: "foo" },
    // 空消息
    { in: [], out: null },
    // 有其他类型的消息
    { in: [["text", { text: "foo" }], ["xxx", {}]], out: null },
    // 只有其他类型的消息
    { in: [["xxx", {}]], out: null },
    // 其他类型的消息正好的 data 正好带 text
    { in: [["xxx", { text: "foo" }]], out: null },
  ];
  for (const { in: _in, out } of table) {
    await t.step(Deno.inspect(_in), () => {
      assertEquals(tryExtractPureText(arr2Msg(_in)), out);
    });
  }
});

Deno.test("utils/message_utils.mergeAdjoiningTextPiecesInPlace", async (t) => {
  const table: { before: Arr2MsgParam; after: Arr2MsgParam }[] = [
    {
      before: [["text", { text: "foo" }]],
      after: [["text", { text: "foo" }]],
    },
    {
      before: [["text", { text: "foo" }], ["text", { text: "bar" }]],
      after: [["text", { text: "foobar" }]],
    },
    {
      before: [
        ["text", { text: "foo" }],
        ["text", { text: "bar" }],
        ["text", { text: "baz" }],
      ],
      after: [["text", { text: "foobarbaz" }]],
    },
    { // 其他类型的消息正好的 data 正好带 text
      before: [["text", { text: "foo" }], ["xxx", { text: "bar" }]],
      after: [["text", { text: "foo" }], ["xxx", { text: "bar" }]],
    },
    {
      before: [
        ["xxx", {}],
        ["text", { text: "foo" }],
        ["text", { text: "bar" }],
        ["yyy", {}],
      ],
      after: [["xxx", {}], ["text", { text: "foobar" }], ["yyy", {}]],
    },
    {
      before: [
        ["text", { text: "foo" }],
        ["text", { text: "foo" }],
        ["xxx", {}],
        ["text", { text: "bar" }],
        ["text", { text: "bar" }],
      ],
      after: [
        ["text", { text: "foofoo" }],
        ["xxx", {}],
        ["text", { text: "barbar" }],
      ],
    },
  ];
  for (const { before, after } of table) {
    await t.step(Deno.inspect(before), () => {
      const msg = arr2Msg(before);
      mergeAdjoiningTextPiecesInPlace(msg);
      assertEquals(msg, arr2Msg(after));
    });
  }
});

Deno.test("utils/message_utils.extractReferenceFromMessage", async (t) => {
  const table: {
    in: Arr2MsgParam;
    replyAt?: [Reply, At];
    rest: Arr2MsgParam;
  }[] = [
    { // 1 没有引用回复
      in: [["text", { text: "foo" }]],
      rest: [["text", { text: "foo" }]],
    },
    { // 2 只有 reply
      in: [["reply", { id: "-42" }], ["text", { text: "foo" }]],
      rest: [["text", { text: "foo" }]],
    },
    { // 3 只有 at
      in: [["at", { qq: "42" }], ["text", { text: "foo" }]],
      rest: [["at", { qq: "42" }], ["text", { text: "foo" }]],
    },
    { // 4 啥也没有
      in: [],
      rest: [],
    },
    { // 5 齐了
      in: [
        ["reply", { id: "-42" }],
        ["at", { qq: "42" }],
        ["text", { text: "foo" }],
      ],
      replyAt: [reply(-42), at(42)],
      rest: [["text", { text: "foo" }]],
    },
    { // 6 齐了，但没后文
      in: [
        ["reply", { id: "-42" }],
        ["at", { qq: "42" }],
      ],
      replyAt: [reply(-42), at(42)],
      rest: [],
    },
    { // 7 多一个空格，iOS 端观察到的情况
      in: [
        ["reply", { id: "-42" }],
        ["at", { qq: "42" }],
        ["text", { text: " foo" }],
      ],
      replyAt: [reply(-42), at(42)],
      rest: [["text", { text: "foo" }]],
    },
    { // 8 同上，但后面跟的其他类型的内容
      in: [
        ["reply", { id: "-42" }],
        ["at", { qq: "42" }],
        ["text", { text: " " }],
        ["at", { qq: "42" }], // 这个 at 是后面跟着的，下同
      ],
      replyAt: [reply(-42), at(42)],
      rest: [["at", { qq: "42" }]],
    },
    { // 9 同上上，但后面没有跟着内容
      in: [
        ["reply", { id: "-42" }],
        ["at", { qq: "42" }],
        ["text", { text: " " }],
      ],
      replyAt: [reply(-42), at(42)],
      rest: [],
    },
    { // 10 多一个换行的 text，macOS 端观察到的情况
      in: [
        ["reply", { id: "-42" }],
        ["at", { qq: "42" }],
        ["text", { text: "\n" }],
        ["text", { text: "foo" }],
      ],
      replyAt: [reply(-42), at(42)],
      rest: [["text", { text: "foo" }]],
    },
    { // 11 同上
      in: [
        ["reply", { id: "-42" }],
        ["at", { qq: "42" }],
        ["text", { text: "\n" }],
        ["at", { qq: "42" }],
      ],
      replyAt: [reply(-42), at(42)],
      rest: [["at", { qq: "42" }]],
    },
    { // 12 多两个及以上的空格时，应该只去掉第一个
      in: [
        ["reply", { id: "-42" }],
        ["at", { qq: "42" }],
        ["text", { text: " ".repeat(4) }],
        ["at", { qq: "42" }],
      ],
      replyAt: [reply(-42), at(42)],
      rest: [["text", { text: " ".repeat(3) }], ["at", { qq: "42" }]],
    },
  ];

  for (const [i, { in: _in, replyAt, rest }] of table.entries()) {
    await t.step(`case ${i + 1} ${Deno.inspect(_in)}`, () => {
      const msg = arr2Msg(_in);
      const {
        replyAt: actualReplyAt,
        rest: actualRest,
      } = extractReferenceFromMessage(msg);
      assertEquals(actualReplyAt, replyAt);
      assertEquals(actualRest, arr2Msg(rest));
    });
  }
});

Deno.test("utils/message_utils.splitMessageIntoLines", async (t) => {
  const table: { in: RegularMessagePiece[]; out: RegularMessagePiece[][] }[] = [
    { in: [], out: [] },
    { in: [text("")], out: [[]] },
    { in: [text("\n")], out: [[], []] },
    { in: [text("foo")], out: [[text("foo")]] },
    { in: [text("foo\nbar")], out: [[text("foo")], [text("bar")]] },
    {
      in: [text("\nfoo\n\nbar\n")],
      out: [[], [text("foo")], [], [text("bar")], []],
    },
    {
      in: [text("\nfoo\n\nbar\n")],
      out: [[], [text("foo")], [], [text("bar")], []],
    },
    { in: [at(42)], out: [[at(42)]] },
    { in: [text("foo"), at(42)], out: [[text("foo"), at(42)]] },
    {
      in: [text("foo\nbar"), at(42)],
      out: [[text("foo")], [text("bar"), at(42)]],
    },
    {
      in: [text("foo\n"), at(42), at(42), text("bar\n")],
      out: [[text("foo")], [at(42), at(42), text("bar")], []],
    },
    { in: [at(42), text("\nbar")], out: [[at(42)], [text("bar")]] },
  ];

  for (const { in: _in, out } of table) {
    await t.step(Deno.inspect(_in), () => {
      assertEquals(
        // XXX: 需要把 MessageLine 重新变为一般的数组，AssertEquals 才能运作。
        //      反过来把 out 变成 MessageLine[] 也不成。
        splitMessageIntoLines(_in).map((x) => [...x]),
        out,
      );
    });
  }
});
