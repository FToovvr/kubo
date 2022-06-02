import {
  at,
  emoticon,
  imageFromBase64,
  RegularMessagePiece,
  Text,
  text,
} from "../../../go_cqhttp_client/message_piece.ts";

import { assertEquals } from "https://deno.land/std@0.134.0/testing/asserts.ts";

import { CommandArgument, CommandArgumentOption } from "./command_argument.ts";
import {
  CompactComplexPiece,
  ComplexPiecePart,
  ExecutedCommandPiece,
  ExecutedPiece,
  GroupPiece,
} from "./command_piece.ts";

const testPrefix = `kubo/command_manager/models/command_argument`;

type ArgumentFields = {
  [
    key in keyof Partial<
      Omit<
        InstanceType<typeof CommandArgument>,
        "content" | "gapAtRight"
      >
    >
  ]: CommandArgument[key];
};

const fieldKeys: (keyof ArgumentFields)[] = [
  "sole",
  "text",
  "number",
  "bigint",
  "boolean",
  "at",
  "emoticon",
  "image",
];

Deno.test(`${testPrefix}`, async (t) => {
  await t.step("单独内容", async (t) => {
    type Row = [RegularMessagePiece, ArgumentFields];
    const table: Row[] = [
      [text("foo"), { text: "foo" }],
      [text("42"), { text: "42", number: 42, bigint: 42n }],
      [text("3.14"), { text: "3.14", number: 3.14 }],
      [text("true"), { text: "true", boolean: true }],
      [text("N"), { text: "N", boolean: false }],

      [at(42), { at: at(42) }],
      [emoticon("foo"), { emoticon: emoticon("foo") }],
      [imageFromBase64(""), { image: imageFromBase64("") }],
    ];

    for (const [i, [originalInput, expected]] of table.entries()) {
      for (const inGroup of [false, true]) {
        let desc = `case ${i + 1}`;
        if (inGroup) {
          desc += " + 于组中";
        } else {
          desc += ": " + Deno.inspect(originalInput);
        }

        await t.step(desc, async (t) => {
          let input: RegularMessagePiece | GroupPiece<true> = originalInput;
          if (inGroup) {
            input = _test_makeCompactGroup([input]);
          }

          const arg = new CommandArgument({ content: input, gapAtRight: "" });
          const expectedOption = (!inGroup && originalInput.type === "text")
            ? new CommandArgumentOption(originalInput.data.text, null)
            : null;
          assertFields(arg, expected, {
            sole: originalInput,
            option: expectedOption,
          });
        });
      }
    }
  });

  await t.step("CompactComplexPiece", async (t) => {
    await t.step("一般情况", async (t) => {
      type Row = CompactComplexPiece<true>;
      const table: Row[] = [
        new CompactComplexPiece<true>([text("foo"), at(42)]),
      ];

      for (const [i, input] of table.entries()) {
        await t.step(`case ${i + 1}: ${Deno.inspect(input)}`, async (t) => {
          const arg = new CommandArgument({ content: input, gapAtRight: "" });
          assertFields(arg, {}, { sole: null, option: null });
        });
      }
    });

    await t.step("迷惑情况", async (t) => {
      type Row = [CompactComplexPiece<true>, ArgumentFields, { sole: string }];
      const group_1 = _test_makeCompactGroup([text("1")]);
      const table: Row[] = [
        [
          new CompactComplexPiece<true>([text("a"), group_1]),
          { text: "a1" },
          { sole: "a1" },
        ],
        [
          new CompactComplexPiece<true>([group_1, text("a")]),
          { text: "1a" },
          { sole: "1a" },
        ],
        [
          new CompactComplexPiece<true>([group_1, group_1]),
          { text: "11", number: 11, bigint: 11n },
          { sole: "11" },
        ],
        [
          new CompactComplexPiece<true>([text("1"), group_1]),
          { text: "11", number: 11, bigint: 11n },
          { sole: "11" },
        ],
        [
          new CompactComplexPiece<true>([group_1, text("1")]),
          { text: "11", number: 11, bigint: 11n },
          { sole: "11" },
        ],
        [
          new CompactComplexPiece<true>([
            text("1"),
            _test_makeCompactGroup([text("1"), group_1, group_1]),
            text("1"),
          ]),
          { text: "11111", number: 11111, bigint: 11111n },
          { sole: "11111" },
        ],
      ];

      for (const [i, [input, expected, { sole }]] of table.entries()) {
        await t.step(`case ${i + 1} ${Deno.inspect(input)}`, async (t) => {
          const arg = new CommandArgument({ content: input, gapAtRight: "" });
          assertFields(arg, expected, { sole: text(sole), option: null });
        });
      }
    });
  });

  await t.step("组", async (t) => {
    // 一般情况已经在前面测试过了

    await t.step("迷惑情况", async (t) => {
      await t.step("连环嵌套", async (t) => {
        type Row = [ExecutedPiece[], ArgumentFields];
        const table: Row[] = [
          [[text("a")], { text: "a" }],
          [[text("1")], { text: "1", number: 1, bigint: 1n }],
        ];

        for (const [i, [deepest, expected]] of table.entries()) {
          const input = _test_makeNestedGroup(deepest, 5);

          await t.step(`case ${i + 1}: ${Deno.inspect(input)}`, async (t) => {
            const arg = new CommandArgument({ content: input, gapAtRight: "" });
            const expectedSole = deepest.length === 1 ? deepest[0] : null;
            assertFields(arg, expected, { sole: expectedSole, option: null });
          });
        }
      });
    });
  });

  await t.step("选项", async (t) => {
    const group_bar_baz = new GroupPiece<true>({
      blankAtLeftSide: " ",
      parts: [
        { content: text("bar"), gapAtRight: " " },
        { content: text("baz"), gapAtRight: " " },
      ],
    });

    await t.step("无值", async (t) => {
      await t.step("case 1", async (t) => {
        assertFields(
          new CommandArgument({ content: text("foo"), gapAtRight: "" }),
          { text: "foo" },
          { option: new CommandArgumentOption("foo", null) },
        );
      });
      await t.step("case 2", async (t) => {
        assertFields(
          new CommandArgument({
            content: new CompactComplexPiece([text("foo"), at(42)]),
            gapAtRight: "",
          }),
          {},
          { option: null },
        );
      });
      await t.step("case 3", async (t) => {
        assertFields(
          new CommandArgument({
            content: new CompactComplexPiece([
              text("foo"),
              group_bar_baz,
              text("bar="),
              at(42),
            ]),
            gapAtRight: "",
          }),
          {},
          { option: null },
        );
      });
    });

    await t.step("带值", async (t) => {
      type Row = {
        input: ExecutedPiece;
        expectedKey: string;
        expectedValue: ExecutedPiece;
      };

      const table: Row[] = [
        {
          input: text("foo=bar"),
          expectedKey: "foo",
          expectedValue: text("bar"),
        },
        {
          input: new CompactComplexPiece([text("foo="), at(42)]),
          expectedKey: "foo",
          expectedValue: at(42),
        },
        {
          input: new CompactComplexPiece([text("foo=bar"), at(42)]),
          expectedKey: "foo",
          expectedValue: new CompactComplexPiece([text("bar"), at(42)]),
        },
        {
          input: new CompactComplexPiece([text("foo="), group_bar_baz]),
          expectedKey: "foo",
          expectedValue: group_bar_baz,
        },
        {
          input: new CompactComplexPiece([text("foo=bar"), group_bar_baz]),
          expectedKey: "foo",
          expectedValue: new CompactComplexPiece([text("bar"), group_bar_baz]),
        },
      ];

      for (
        const [i, { input, expectedKey, expectedValue }] of table.entries()
      ) {
        await t.step(`case ${i + 1}: ${Deno.inspect(input)}`, async (t) => {
          assertFields(
            new CommandArgument({ content: input, gapAtRight: "" }),
            null,
            { option: new CommandArgumentOption(expectedKey, expectedValue) },
          );
        });
      }
    });
  });

  await t.step("选项值", async (t) => {
    await t.step("case 1", async (t) => {
      assertFields(
        new CommandArgumentOption("foo", text("42")).value,
        { text: "42", number: 42, bigint: 42n },
      );
    });
  });

  await t.step("嵌入命令", async (t) => {
    for (const [i, hasFailed] of [false, true].entries()) {
      const result = hasFailed ? null : { embedding: [text("42")] };
      await t.step(
        `case ${i + 1}: ${Deno.inspect({ hasFailed })}`,
        async (t) => {
          await t.step("case 1", async (t) => {
            assertFields(
              new CommandArgument({
                content: new ExecutedCommandPiece(null as unknown as any, {
                  context: null as unknown as any,
                  isEmbedded: true,
                  blankAtLeftSide: "",
                  prefix: "/",
                  shouldAwait: false,
                  arguments: [],
                  gapAfterHead: "",
                  hasFailed,
                  result,
                  notes: [],
                }),
                gapAtRight: "",
              }),
              hasFailed ? {} : { text: "42", number: 42, bigint: 42n },
            );
          });
        },
      );
    }
  });
});

function assertFields(
  actualArgument: CommandArgument | CommandArgumentOption["value"],
  expectedFields: Omit<ArgumentFields, "sole" | "option"> | null,
  extraExpected: {
    sole?: any; //CommandArgument["sole"];
    option?: any; //CommandArgument["option"];
  } = {},
) {
  if (extraExpected.sole !== undefined) {
    assertEquals(actualArgument.sole, extraExpected.sole);
  }
  if (extraExpected.option !== undefined) {
    assertEquals(actualArgument.option, extraExpected.option);
  }
  if (expectedFields !== null) {
    for (const key of fieldKeys) {
      if (key === "sole" || key === "option") continue;
      const actualValue = actualArgument[key];
      const expectedValue = expectedFields[key] ?? null;
      const inspected = Deno.inspect({
        key,
        expected: expectedValue,
        actual: actualValue,
      });
      assertEquals(actualValue, expectedValue, inspected);
    }
  }
}

function _test_makeCompactGroup(parts: ExecutedPiece[]) {
  return new GroupPiece({
    blankAtLeftSide: "",
    parts: parts.map((part) => ({ content: part, gapAtRight: "" })),
  });
}

function _test_makeNestedGroup(
  parts: ExecutedPiece[],
  level: number,
) {
  let group = _test_makeCompactGroup(parts);
  for (let i = 0; i < level - 1; i++) {
    group = _test_makeCompactGroup(parts);
  }
  return group;
}
