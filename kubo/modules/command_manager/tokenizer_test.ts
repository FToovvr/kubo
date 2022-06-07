import { assertEquals } from "https://deno.land/std@0.134.0/testing/asserts.ts";
import { at, Image, text } from "../../../go_cqhttp_client/message_piece.ts";
import {
  mergeAdjoiningTextPiecesInPlace,
  MessageLine,
} from "../../../utils/message_utils.ts";
import {
  CompactComplexPiece,
  GroupPiece,
  UnexecutedCommandPiece,
} from "./models/command_piece.ts";
import { _test_makeContext, _test_makeFakeCommands } from "./test_utils.ts";
import { tokenizeMessage, TokenizingEnvironment } from "./tokenizer.ts";

interface Row {
  in: Parameters<typeof tokenizeMessage>[1];
  // FIXME: 类型不对，应该是 Array 而非 MessageLine
  out: ReturnType<typeof tokenizeMessage>[0][];
}

async function testTokenizeMessage(
  t: Deno.TestContext,
  ctx: TokenizingEnvironment,
  args: {
    usesSteps?: boolean;
    ignoreSpaceRelatedStuffOnCommands?: boolean;
    testsForSecondLine?: boolean;
  },
  table: Row[],
) {
  args = {
    usesSteps: true,
    ignoreSpaceRelatedStuffOnCommands: true,
    testsForSecondLine: true,
    ...args,
  };

  // NOTE: 由于目前禁用了整体命令（处于第一行五前缀的行命令），
  //       是否在第一行不会影响到解析，因此设为 false
  args.testsForSecondLine = false;

  const appliedConditions = [];
  if (args.testsForSecondLine!) {
    appliedConditions.push({
      description: "at 2nd line",
      set: "atSecondLine" as const,
    });
  }

  const conditions: {
    description: "";
    atSecondLine?: boolean;
  }[] = [{ description: "" }];
  for (const appliedCondition of appliedConditions) {
    const copied = conditions.map((x) => ({ ...x }));
    for (const copiedItem of copied) {
      copiedItem[appliedCondition.set] = true;
      // if (copiedItem.description.length) {
      copiedItem.description += " + ";
      // }
      copiedItem.description += appliedCondition.description;
    }
    conditions.push(...copied);
  }

  for (let [i, { in: _in, out: _expectedOut }] of table.entries()) {
    const inspected = (() => {
      if (_in.length === 1 && _in[0].type === "text") {
        return Deno.inspect(_in[0].data.text);
      }
      return Deno.inspect(_in);
    })();

    for (const { description, atSecondLine } of conditions) {
      if (atSecondLine) {
        _in = new MessageLine(text("\n"), ..._in);
        mergeAdjoiningTextPiecesInPlace(_in);
        _expectedOut = [new MessageLine(), ..._expectedOut];
      }

      const fn = () => {
        const actualOut = tokenizeMessage(ctx, _in);
        const expectedOut = _expectedOut.map((line) =>
          new MessageLine(...line)
        );
        assertEquals(
          actualOut,
          expectedOut,
          // Deno.inspect({ actualOut, expectedOut }, { depth: Infinity }),
        );
      };

      if (args.usesSteps!) {
        await t.step(
          `case ${i + 1}${description}` +
            (description.length ? "" : (": " + inspected)),
          fn,
        );
      } else {
        fn();
      }
    }
  }
}

const testPrefix = "kubo/command_manager/tokenizer" as const;

Deno.test(`${testPrefix} 无命令` as const, async (t) => {
  await testTokenizeMessage(t, _test_makeContext(), {}, [
    { in: [], out: [[]] },
    { in: [text("foo")], out: [[text("foo")]] },
    { in: [text("foo bar")], out: [[text("foo bar")]] },
    { in: [text("foo\n")], out: [[text("foo")], []] },
    { in: [text("foo\nbar")], out: [[text("foo")], [text("bar")]] },
    { in: [text("foo/bar")], out: [[text("foo/bar")]] },
  ]);
});

Deno.test(`${testPrefix} 组` as const, async (t) => {
  const context = _test_makeContext();

  await t.step("基础", async (t) => {
    await testTokenizeMessage(t, context, {}, [
      {
        in: [text("{}")],
        out: [[
          new GroupPiece({
            blankAtLeftSide: "",
            parts: [],
          }),
        ]],
      },
      {
        in: [text("{foo}")],
        out: [[
          new GroupPiece({
            blankAtLeftSide: "",
            parts: [{ content: text("foo"), gapAtRight: "" }],
          }),
        ]],
      },
      {
        in: [text("{foo \t\n bar baz  }")],
        out: [[
          new GroupPiece({
            blankAtLeftSide: "",
            parts: [
              { content: text("foo"), gapAtRight: " \t\n " },
              { content: text("bar"), gapAtRight: " " },
              { content: text("baz"), gapAtRight: "  " },
            ],
          }),
        ]],
      },
    ]);
  });

  await t.step("花括号不匹配", async (t) => {
    await testTokenizeMessage(t, context, {}, [
      { in: [text("{")], out: [[text("{")]] },
      { in: [text("}")], out: [[text("}")]] },
      {
        in: [text("{{}")],
        out: [[text("{"), new GroupPiece({ blankAtLeftSide: "", parts: [] })]],
      },
      {
        in: [text("{}}")],
        out: [[new GroupPiece({ blankAtLeftSide: "", parts: [] }), text("}")]],
      },
    ]);
  });

  await t.step("花括号转义", async (t) => {
    throw new Error("TODO: FIXME");
    await testTokenizeMessage(t, context, {}, [
      { in: [text("\\{ foo }")], out: [[text("{ foo }")]] },
      { in: [text("{ foo \\}")], out: [[text("{ foo }")]] },
      { in: [text("\\{ foo \\}")], out: [[text("{ foo }")]] },
      {
        in: [text("\\{ { foo }")],
        out: [[
          text("{ "),
          new GroupPiece({
            blankAtLeftSide: " ",
            parts: [{ content: text("foo"), gapAtRight: " " }],
          }),
        ]],
      },
      {
        in: [text("{ \\{ foo }")],
        out: [[
          new GroupPiece({
            blankAtLeftSide: " ",
            parts: [{ content: text("{ foo"), gapAtRight: "" }],
          }),
        ]],
      },
    ]);
  });

  await t.step("花括号内侧附近空白", async (t) => {
    const contents = [text("foo"), at(42)];

    const spaces = ["", " ", "\t", "\n"];
    const combinations = [];
    for (const space1 of spaces) {
      for (const space2 of spaces) {
        combinations.push(space1 + space2);
      }
    }

    const table: Row[] = [];

    for (const blankLeft of combinations) {
      for (const blankRight of combinations) {
        for (const content of contents) {
          const _in = [text("{" + blankLeft), content, text(blankRight + "}")];
          mergeAdjoiningTextPiecesInPlace(_in);
          const out = [[
            new GroupPiece({
              blankAtLeftSide: blankLeft,
              parts: [{ content, gapAtRight: blankRight }],
            }),
          ]];
          table.push({ in: _in, out });
        }
      }
    }

    // 4 种空白两两组和组成 4^2=16 组，左右组合组成 16^2=256 组，
    // 中间的填充内容有两种可能的情况，组成 256*2=512 组，
    // 由于还会测试处于第二行的情况，最终会有 512*2=1024 组情况。
    // 数量过于庞大，因此不单独分出步骤
    await testTokenizeMessage(t, context, { usesSteps: false }, table);
  });

  await t.step("外侧附近的内容", async (t) => {
    const lefts = [
      [text("bar")],
      [text("bar ")],
      [at(111)],
      [at(111), text(" ")],
    ];
    const rights = [
      [text("baz")],
      [text(" baz")],
      [at(222)],
      [text(" "), at(222)],
    ];

    const table: Row[] = [];

    for (const left of lefts) {
      for (const right of rights) {
        const _in = [...left, text("{foo}"), ...right];
        mergeAdjoiningTextPiecesInPlace(_in);
        const out = [[
          ...left,
          new GroupPiece({
            blankAtLeftSide: "",
            parts: [{ content: text("foo"), gapAtRight: "" }],
          }),
          ...right,
        ]];
        table.push({ in: _in, out });
      }
    }

    // table:
    // "bar{foo}baz"
    // "bar{foo} baz"
    // "bar {foo}baz"
    // "bar {foo} baz"

    await testTokenizeMessage(t, context, {}, table);
  });

  await t.step("组中组", async (t) => {
    await testTokenizeMessage(t, context, {}, [
      {
        in: [text("{{}}")],
        out: [[
          new GroupPiece({
            blankAtLeftSide: "",
            parts: [{
              content: new GroupPiece({
                blankAtLeftSide: "",
                parts: [],
              }),
              gapAtRight: "",
            }],
          }),
        ]],
      },
      {
        in: [text("{bar{foo}baz}")],
        out: [[
          new GroupPiece({
            blankAtLeftSide: "",
            parts: [
              {
                content: new CompactComplexPiece([
                  text("bar"),
                  new GroupPiece({
                    blankAtLeftSide: "",
                    parts: [{ content: text("foo"), gapAtRight: "" }],
                  }),
                  text("baz"),
                ]),
                gapAtRight: "",
              },
            ],
          }),
        ]],
      },
    ]);
  });

  await t.step("两组毗邻", async (t) => {
    await testTokenizeMessage(t, context, {}, [
      {
        in: [text("{foo}{bar}")],
        out: [[
          new GroupPiece({
            blankAtLeftSide: "",
            parts: [{ content: text("foo"), gapAtRight: "" }],
          }),
          new GroupPiece({
            blankAtLeftSide: "",
            parts: [{ content: text("bar"), gapAtRight: "" }],
          }),
        ]],
      },
      {
        in: [text("{foo} {bar}")],
        out: [[
          new GroupPiece({
            blankAtLeftSide: "",
            parts: [{ content: text("foo"), gapAtRight: "" }],
          }),
          text(" "),
          new GroupPiece({
            blankAtLeftSide: "",
            parts: [{ content: text("bar"), gapAtRight: "" }],
          }),
        ]],
      },
      {
        in: [text("{{foo}{bar}}")],
        out: [[
          new GroupPiece({
            blankAtLeftSide: "",
            parts: [
              {
                content: new CompactComplexPiece([
                  new GroupPiece({
                    blankAtLeftSide: "",
                    parts: [{ content: text("foo"), gapAtRight: "" }],
                  }),
                  new GroupPiece({
                    blankAtLeftSide: "",
                    parts: [{ content: text("bar"), gapAtRight: "" }],
                  }),
                ]),
                gapAtRight: "",
              },
            ],
          }),
        ]],
      },
      {
        in: [text("{{foo} {bar}}")],
        out: [[
          new GroupPiece({
            blankAtLeftSide: "",
            parts: [
              {
                content: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [{ content: text("foo"), gapAtRight: "" }],
                }),
                gapAtRight: " ",
              },
              {
                content: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [{ content: text("bar"), gapAtRight: "" }],
                }),
                gapAtRight: "",
              },
            ],
          }),
        ]],
      },
    ]);
  });

  await t.step("花括号内侧的多种内容", async (t) => {
    const lefts = [text("bar"), at(111)];
    const rights = [text("baz"), at(222)];
    const blankConditions: { left?: boolean; right?: boolean }[] = [
      {},
      { left: true },
      { right: true },
      { left: true, right: true },
    ];

    const table: Row[] = [];

    for (const left of lefts) {
      for (const right of rights) {
        for (const { left: blankLeft, right: blankRight } of blankConditions) {
          if (
            (!blankLeft && left.type === "text") ||
            (!blankRight && right.type === "text")
          ) { // 这样文本就粘到一起了，没有测试的必要
            continue;
          }
          const _in = [
            text("{"),
            left,
            ...(blankLeft ? [text(" ")] : []),
            text("foo"),
            ...(blankRight ? [text(" ")] : []),
            right,
            text("}"),
          ];
          mergeAdjoiningTextPiecesInPlace(_in);
          var expectedGroupParts: GroupPiece["parts"];
          if (blankLeft && blankRight) {
            expectedGroupParts = [
              { content: left, gapAtRight: " " },
              { content: text("foo"), gapAtRight: " " },
              { content: right, gapAtRight: "" },
            ];
          } else if (blankLeft) {
            expectedGroupParts = [
              { content: left, gapAtRight: " " },
              {
                content: new CompactComplexPiece([
                  text("foo"),
                  right,
                ]),
                gapAtRight: "",
              },
            ];
          } else if (blankRight) {
            expectedGroupParts = [
              {
                content: new CompactComplexPiece([
                  left,
                  text("foo"),
                ]),
                gapAtRight: " ",
              },
              { content: right, gapAtRight: "" },
            ];
          } else {
            expectedGroupParts = [
              {
                content: new CompactComplexPiece([
                  left,
                  text("foo"),
                  right,
                ]),
                gapAtRight: "",
              },
            ];
          }
          table.push({
            in: _in,
            out: [[
              new GroupPiece({
                blankAtLeftSide: "",
                parts: expectedGroupParts,
              }),
            ]],
          });
        }
      }
    }

    await testTokenizeMessage(t, context, {}, table);
  });

  await t.step("花括号内相邻的非文本内容", async (t) => {
    await testTokenizeMessage(t, context, {}, [
      {
        in: [text("{"), at(111), at(222), text("}")],
        out: [[
          new GroupPiece({
            blankAtLeftSide: "",
            parts: [{
              content: new CompactComplexPiece([at(111), at(222)]),
              gapAtRight: "",
            }],
          }),
        ]],
      },
      {
        in: [text("{"), at(111), text(" "), at(222), text("}")],
        out: [[
          new GroupPiece({
            blankAtLeftSide: "",
            parts: [{
              content: at(111),
              gapAtRight: " ",
            }, {
              content: at(222),
              gapAtRight: "",
            }],
          }),
        ]],
      },
    ]);
  });
});

Deno.test(`${testPrefix} 行命令`, async (t) => {
  await t.step("识别", async (t) => {
    const context = _test_makeContext(["foo"]);

    const expectedCmdPiece = _test_makeUnexecutedCommandPiece(context, ["foo"]);

    await testTokenizeMessage(t, context, {}, [
      { in: [text("/fo")], out: [[text("/fo")]] },
      {
        in: [text("/foo")],
        out: [[expectedCmdPiece]],
      },
      {
        in: [text("/foo\nbar")],
        out: [[expectedCmdPiece], [text("bar")]],
      },
      { in: [text(" /foo")], out: [[text(" /foo")]] },
    ]);
  });

  await t.step("重叠", async (t) => {
    const context = _test_makeContext(["fo", "foo", "fooo"]);

    const expectedCmdPiece = _test_makeUnexecutedCommandPiece(context, [
      "fo",
      "foo",
    ]);

    await testTokenizeMessage(t, context, {}, [
      {
        in: [text("/foo")],
        out: [[expectedCmdPiece]],
      },
    ]);
  });

  await t.step("前缀", async (t) => {
    const context = _test_makeContext(["foo"], "//");

    const expectedCmdPiece = _test_makeUnexecutedCommandPiece(
      context,
      ["foo"],
      {
        prefix: "//",
      },
    );

    await testTokenizeMessage(t, context, {}, [
      {
        in: [text("//foo")],
        out: [[expectedCmdPiece]],
      },
    ]);
  });

  await t.step("参数", async (t) => {
    const context = _test_makeContext(["foo"]);

    await testTokenizeMessage(t, context, {}, [
      {
        in: [text("/foo 123 4")],
        out: [[
          _test_makeUnexecutedCommandPiece(context, ["foo"], {
            gapAfterHead: " ",
          }, [
            { content: text("123"), gapAtRight: " " },
            { content: text("4"), gapAtRight: "" },
          ]),
        ]],
      },
      {
        in: [text("/foo123")],
        out: [[
          _test_makeUnexecutedCommandPiece(context, ["foo"], {
            gapAfterHead: "",
          }, [
            { content: text("123"), gapAtRight: "" },
          ]),
        ]],
      },
      {
        in: [text("/foo "), text("123"), at(42), text("123 "), at(42)],
        out: [[
          _test_makeUnexecutedCommandPiece(context, ["foo"], {
            gapAfterHead: " ",
          }, [
            {
              content: new CompactComplexPiece([
                text("123"),
                at(42),
                text("123"),
              ]),
              gapAtRight: " ",
            },
            { content: at(42), gapAtRight: "" },
          ]),
        ]],
      },
      {
        in: [text("/foo"), at(42)],
        out: [[
          _test_makeUnexecutedCommandPiece(context, ["foo"], {
            gapAfterHead: "",
          }, [
            { content: at(42), gapAtRight: "" },
          ]),
        ]],
      },
      {
        in: [text("/foo"), at(42), text("  ")],
        out: [[
          _test_makeUnexecutedCommandPiece(context, ["foo"], {
            gapAfterHead: "",
          }, [
            { content: at(42), gapAtRight: "  " },
          ]),
        ]],
      },
      {
        in: [text("/foobar"), at(42)],
        out: [[
          _test_makeUnexecutedCommandPiece(context, ["foo"], {
            gapAfterHead: "",
          }, [
            {
              content: new CompactComplexPiece([text("bar"), at(42)]),
              gapAtRight: "",
            },
          ]),
        ]],
      },
      {
        in: [text("/foobar"), at(42), text("  ")],
        out: [[
          _test_makeUnexecutedCommandPiece(context, ["foo"], {
            gapAfterHead: "",
          }, [
            {
              content: new CompactComplexPiece([text("bar"), at(42)]),
              gapAtRight: "  ",
            },
          ]),
        ]],
      },
    ]);
  });

  await t.step("组作为参数", async (t) => {
    const context = _test_makeContext(["foo"]);

    const preTable: {
      in: Row["in"];
      soleOutCommand: {
        gapAfterHead: string;
        rawArguments: UnexecutedCommandPiece["arguments"];
      };
    }[] = [
      {
        in: [text("/foo {bar}")],
        soleOutCommand: {
          gapAfterHead: " ",
          rawArguments: [
            {
              content: new GroupPiece({
                blankAtLeftSide: "",
                parts: [{ content: text("bar"), gapAtRight: "" }],
              }),
              gapAtRight: "",
            },
          ],
        },
      },
      {
        in: [text("/foo{bar}")],
        soleOutCommand: {
          gapAfterHead: "",
          rawArguments: [{
            content: new GroupPiece({
              blankAtLeftSide: "",
              parts: [{ content: text("bar"), gapAtRight: "" }],
            }),
            gapAtRight: "",
          }],
        },
      },
      {
        in: [text("/foo {bar}baz")],
        soleOutCommand: {
          gapAfterHead: " ",
          rawArguments: [{
            content: new CompactComplexPiece([
              new GroupPiece({
                blankAtLeftSide: "",
                parts: [{ content: text("bar"), gapAtRight: "" }],
              }),
              text("baz"),
            ]),
            gapAtRight: "",
          }],
        },
      },
      {
        in: [text("/foo baz{bar}")],
        soleOutCommand: {
          gapAfterHead: " ",
          rawArguments: [{
            content: new CompactComplexPiece([
              text("baz"),
              new GroupPiece({
                blankAtLeftSide: "",
                parts: [{ content: text("bar"), gapAtRight: "" }],
              }),
            ]),
            gapAtRight: "",
          }],
        },
      },
      {
        in: [text("/foobaz{bar}")],
        soleOutCommand: {
          gapAfterHead: "",
          rawArguments: [{
            content: new CompactComplexPiece([
              text("baz"),
              new GroupPiece({
                blankAtLeftSide: "",
                parts: [{ content: text("bar"), gapAtRight: "" }],
              }),
            ]),
            gapAtRight: "",
          }],
        },
      },
      {
        in: [text("/foo xxx {bar}")],
        soleOutCommand: {
          gapAfterHead: " ",
          rawArguments: [
            { content: text("xxx"), gapAtRight: " " },
            {
              content: new GroupPiece({
                blankAtLeftSide: "",
                parts: [{ content: text("bar"), gapAtRight: "" }],
              }),
              gapAtRight: "",
            },
          ],
        },
      },
      {
        in: [text("/foo xxx baz{bar}")],
        soleOutCommand: {
          gapAfterHead: " ",
          rawArguments: [
            { content: text("xxx"), gapAtRight: " " },
            {
              content: new CompactComplexPiece([
                text("baz"),
                new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [{ content: text("bar"), gapAtRight: "" }],
                }),
              ]),
              gapAtRight: "",
            },
          ],
        },
      },
    ];

    const table: Row[] = [];

    for (const { in: _in, soleOutCommand } of preTable) {
      table.push({
        in: _in,
        out: [[
          _test_makeUnexecutedCommandPiece(context, ["foo"], {
            gapAfterHead: soleOutCommand.gapAfterHead,
          }, soleOutCommand.rawArguments),
        ]],
      });
      table.push({
        in: (() => {
          const newIn = [..._in, text(" 123")];
          mergeAdjoiningTextPiecesInPlace(newIn);
          return newIn;
        })(),
        out: [[
          _test_makeUnexecutedCommandPiece(
            context,
            ["foo"],
            {
              gapAfterHead: soleOutCommand.gapAfterHead,
            },
            (() => {
              const newRawArguments = [...soleOutCommand.rawArguments];
              {
                const lastIndex = newRawArguments.length - 1;
                const origLast = newRawArguments[lastIndex];
                newRawArguments[lastIndex] = {
                  content: origLast.content,
                  gapAtRight: origLast.gapAtRight + " ",
                };
              }
              newRawArguments.push({
                content: text("123"),
                gapAtRight: "",
              });
              return newRawArguments;
            })(),
          ),
        ]],
      });
    }

    await testTokenizeMessage(t, context, {}, table);
  });

  // NOTE: 感觉这些旧测试样例有调整的空间？
  await t.step("头部与参数列表间的空隙", async (t) => {
    const context = _test_makeContext(["foo"]);

    await testTokenizeMessage(t, context, {}, [
      {
        in: [text("/foobar")],
        out: [[
          _test_makeUnexecutedCommandPiece(context, ["foo"], {
            gapAfterHead: "",
          }, [{ content: text("bar"), gapAtRight: "" }]),
        ]],
      },
      {
        in: [text("/foo  ")],
        out: [[
          _test_makeUnexecutedCommandPiece(context, ["foo"], {
            gapAfterHead: "  ",
          }, []),
        ]],
      },
      {
        in: [text("/foo bar")],
        out: [[
          _test_makeUnexecutedCommandPiece(context, ["foo"], {
            gapAfterHead: " ",
          }, [{ content: text("bar"), gapAtRight: "" }]),
        ]],
      },
      {
        in: [text("/foo\t bar")],
        out: [[
          _test_makeUnexecutedCommandPiece(context, ["foo"], {
            gapAfterHead: "\t ",
          }, [{ content: text("bar"), gapAtRight: "" }]),
        ]],
      },
    ]);
  });
});

Deno.test(`${testPrefix} 嵌入命令`, async (t) => {
  await t.step("命令识别", async (t) => {
    const context = _test_makeContext(["foo"]);

    await t.step("非命令", async (t) => {
      await testTokenizeMessage(t, context, {}, [
        {
          in: [text("{foo}")],
          out: [[
            new GroupPiece({
              blankAtLeftSide: "",
              parts: [{ content: text("foo"), gapAtRight: "" }],
            }),
          ]],
        },
        {
          in: [text("{ barbar /foo}")],
          out: [[
            new GroupPiece({
              blankAtLeftSide: " ",
              parts: [
                { content: text("barbar"), gapAtRight: " " },
                { content: text("/foo"), gapAtRight: "" },
              ],
            }),
          ]],
        },
        {
          in: [text("{ /null }")],
          out: [[
            new GroupPiece({
              blankAtLeftSide: " ",
              parts: [{ content: text("/null"), gapAtRight: " " }],
            }),
          ]],
        },
        {
          in: [text("bar { /null }")],
          out: [[
            text("bar "),
            new GroupPiece({
              blankAtLeftSide: " ",
              parts: [{ content: text("/null"), gapAtRight: " " }],
            }),
          ]],
        },
      ]);
    });

    const expectedCmdPiece = _test_makeUnexecutedCommandPiece(
      context,
      ["foo"],
      { isEmbedded: true },
    );

    await t.step("存在命令", async (t) => {
      await testTokenizeMessage(t, context, {}, [
        { in: [text("{/foo}")], out: [[expectedCmdPiece]] },
        { in: [text("{/foo}bar")], out: [[expectedCmdPiece, text("bar")]] },
        { in: [text("bar{/foo}")], out: [[text("bar"), expectedCmdPiece]] },
        { in: [text("bar\n{/foo}")], out: [[text("bar")], [expectedCmdPiece]] },
        {
          in: [text("{/foo}{/foo}")],
          out: [[expectedCmdPiece, expectedCmdPiece]],
        },
      ]);
    });
  });

  // NOTE: 感觉这些旧测试样例有调整的空间？
  await t.step("头部与参数列表间的空隙", async (t) => {
    const context = _test_makeContext(["foo"]);

    await testTokenizeMessage(t, context, {}, [
      {
        in: [text("{/foo  }")],
        out: [[
          _test_makeUnexecutedCommandPiece(context, ["foo"], {
            isEmbedded: true,
            gapAfterHead: "  ",
          }, []),
        ]],
      },
      {
        in: [text("{/foo\t bar}")],
        out: [[
          _test_makeUnexecutedCommandPiece(context, ["foo"], {
            isEmbedded: true,
            gapAfterHead: "\t ",
          }, [{ content: text("bar"), gapAtRight: "" }]),
        ]],
      },
      {
        in: [text("{/foo\n\t bar}")],
        out: [[
          _test_makeUnexecutedCommandPiece(context, ["foo"], {
            isEmbedded: true,
            gapAfterHead: "\n\t ",
          }, [{ content: text("bar"), gapAtRight: "" }]),
        ]],
      },
    ]);
  });
});

Deno.test(`${testPrefix} 命令嵌套`, async (t) => {
  await t.step("行命令中的嵌入命令", async (t) => {
    const context = _test_makeContext(["line", "emb"]);

    function makeLineCmdPiece(
      args: {
        gapAfterHead: string;
      },
      cmdRawArgs: UnexecutedCommandPiece["arguments"],
    ) {
      return _test_makeUnexecutedCommandPiece(
        context,
        ["line"],
        args,
        cmdRawArgs,
      );
    }
    const embeddedCmdPiece = _test_makeUnexecutedCommandPiece(
      context,
      ["emb"],
      { isEmbedded: true },
    );

    await testTokenizeMessage(t, context, {}, [
      {
        in: [text("/line{/emb}baz")],
        out: [[
          makeLineCmdPiece({ gapAfterHead: "" }, [{
            content: new CompactComplexPiece([embeddedCmdPiece, text("baz")]),
            gapAtRight: "",
          }]),
        ]],
      },
      {
        in: [text("/line {/emb} baz")],
        out: [[
          makeLineCmdPiece({ gapAfterHead: " " }, [
            { content: embeddedCmdPiece, gapAtRight: " " },
            { content: text("baz"), gapAtRight: "" },
          ]),
        ]],
      },
      {
        in: [text("/line { /null }")],
        out: [[
          makeLineCmdPiece({ gapAfterHead: " " }, [
            {
              content: new GroupPiece({
                blankAtLeftSide: " ",
                parts: [{ content: text("/null"), gapAtRight: " " }],
              }),
              gapAtRight: "",
            },
          ]),
        ]],
      },
    ]);
  });

  function makeEmbeddedCmdPiece(
    context: TokenizingEnvironment,
    name: string,
    args: {
      blankAtLeftSide: string;
      gapAfterHead: string;
    },
    cmdRawArgs: UnexecutedCommandPiece["arguments"],
  ) {
    return _test_makeUnexecutedCommandPiece(
      context,
      [name],
      { ...args, isEmbedded: true },
      cmdRawArgs,
    );
  }

  await t.step("嵌入命令中的行命令", async (t) => {
    const context = _test_makeContext(["line", "emb"]);

    function _makeEmbeddedCmdPiece(args: {
      blankAtLeftSide: string;
      gapAfterHead: string;
    }, cmdRawArgs: UnexecutedCommandPiece["arguments"]) {
      return makeEmbeddedCmdPiece(context, "emb", args, cmdRawArgs);
    }

    await testTokenizeMessage(t, context, {}, [
      {
        in: [text("{/emb\n/line}")],
        out: [[
          _makeEmbeddedCmdPiece({ blankAtLeftSide: "", gapAfterHead: "\n" }, [
            { content: text("/line"), gapAtRight: "" },
          ]),
        ]],
      },
    ]);
  });

  await t.step("嵌入命令中的嵌入命令", async (t) => {
    const context = _test_makeContext(["foo", "bar", "baz"]);

    function _makeEmbeddedCmdPiece(name: string, args: {
      blankAtLeftSide: string;
      gapAfterHead: string;
    }, cmdRawArgs: UnexecutedCommandPiece["arguments"]) {
      return makeEmbeddedCmdPiece(context, name, args, cmdRawArgs);
    }

    await testTokenizeMessage(t, context, {}, [
      {
        in: [text("{/bar {/baz}}")],
        out: [[
          _makeEmbeddedCmdPiece("bar", {
            blankAtLeftSide: "",
            gapAfterHead: " ",
          }, [
            {
              content: _makeEmbeddedCmdPiece("baz", {
                blankAtLeftSide: "",
                gapAfterHead: "",
              }, []),
              gapAtRight: "",
            },
          ]),
        ]],
      },
      {
        in: [text("{/bar {/baz}a}")],
        out: [[
          _makeEmbeddedCmdPiece("bar", {
            blankAtLeftSide: "",
            gapAfterHead: " ",
          }, [
            {
              content: new CompactComplexPiece([
                _makeEmbeddedCmdPiece("baz", {
                  blankAtLeftSide: "",
                  gapAfterHead: "",
                }, []),
                text("a"),
              ]),
              gapAtRight: "",
            },
          ]),
        ]],
      },
      {
        in: [text("{/foo{/bar {/baz}a}}")],
        out: [[
          _makeEmbeddedCmdPiece("foo", {
            blankAtLeftSide: "",
            gapAfterHead: "",
          }, [{
            content: _makeEmbeddedCmdPiece("bar", {
              blankAtLeftSide: "",
              gapAfterHead: " ",
            }, [{
              content: new CompactComplexPiece([
                _makeEmbeddedCmdPiece("baz", {
                  blankAtLeftSide: "",
                  gapAfterHead: "",
                }, []),
                text("a"),
              ]),
              gapAtRight: "",
            }]),
            gapAtRight: "",
          }]),
        ]],
      },
      { // 花括号不匹配
        in: [text("{/bar {/baz}")],
        out: [[
          text("{/bar "),
          _makeEmbeddedCmdPiece("baz", {
            blankAtLeftSide: "",
            gapAfterHead: "",
          }, []),
        ]],
      },
    ]);
  });
});

Deno.test(`${testPrefix} 等待型命令`, async (t) => {
  const context = _test_makeContext(["foo"]);

  const expectedLineCmdPiece = _test_makeUnexecutedCommandPiece(context, [
    "foo",
  ], {
    isAwait: true,
  });
  const expectedEmbeddedCmdPiece = _test_makeUnexecutedCommandPiece(context, [
    "foo",
  ], {
    isEmbedded: true,
    isAwait: true,
  });

  await testTokenizeMessage(t, context, {}, [
    { in: [text("?foo")], out: [[text("?foo")]] },
    { in: [text("/?null")], out: [[text("/?null")]] },
    {
      in: [text("/?foo")],
      out: [[expectedLineCmdPiece]],
    },
    {
      in: [text("{?foo}")],
      out: [[
        new GroupPiece({
          blankAtLeftSide: "",
          parts: [{ content: text("?foo"), gapAtRight: "" }],
        }),
      ]],
    },
    {
      in: [text("{/?null}")],
      out: [[
        new GroupPiece({
          blankAtLeftSide: "",
          parts: [{ content: text("/?null"), gapAtRight: "" }],
        }),
      ]],
    },
    {
      in: [text("{/?foo}")],
      out: [[expectedEmbeddedCmdPiece]],
    },
    {
      in: [text("/?foo {/?foo}")],
      out: [[
        _test_makeUnexecutedCommandPiece(context, ["foo"], {
          gapAfterHead: " ",
          isAwait: true,
        }, [
          { content: expectedEmbeddedCmdPiece, gapAtRight: "" },
        ]),
      ]],
    },
  ]);
});

Deno.test(`${testPrefix} 综合`, async (t) => {
  const context = _test_makeContext(["c", "w", "r"]);

  const w3 = _test_makeUnexecutedCommandPiece(context, ["w"], {
    isEmbedded: true,
    gapAfterHead: "",
  }, [{ content: text("3"), gapAtRight: "" }]);

  const textToParse = `你走出小镇，往王都的方向出发，遇到了…
/c -list
- {/w3} 一支向边境方向行进的商队。
- {/w3} 魔物，是 { /c -- 史莱姆 { 哥布林 lv{/r10+d10} } 沙虫 }
- {/w3} 遗落在路边的金币，价值 { /rd100 }
- { /c -- 大成功 大失败 }`;

  await testTokenizeMessage(t, context, {}, [
    {
      in: [text(textToParse)],
      out: [
        [text("你走出小镇，往王都的方向出发，遇到了…")],
        [_test_makeUnexecutedCommandPiece(context, ["c"], {
          gapAfterHead: " ",
        }, [
          { content: text("-list"), gapAtRight: "" },
        ])],
        [text("- "), w3, text(" 一支向边境方向行进的商队。")],
        [
          text("- "),
          w3,
          text(" 魔物，是 "),
          _test_makeUnexecutedCommandPiece(context, ["c"], {
            isEmbedded: true,
            blankAtLeftSide: " ",
            gapAfterHead: " ",
          }, [
            { content: text("--"), gapAtRight: " " },
            { content: text("史莱姆"), gapAtRight: " " },
            {
              content: new GroupPiece({
                blankAtLeftSide: " ",
                parts: [
                  { content: text("哥布林"), gapAtRight: " " },
                  {
                    content: new CompactComplexPiece([
                      text("lv"),
                      _test_makeUnexecutedCommandPiece(context, ["r"], {
                        isEmbedded: true,
                        blankAtLeftSide: "",
                        gapAfterHead: "",
                      }, [{ content: text("10+d10"), gapAtRight: "" }]),
                    ]),
                    gapAtRight: " ",
                  },
                ],
              }),
              gapAtRight: " ",
            },
            { content: text("沙虫"), gapAtRight: " " },
          ]),
        ],
        [
          text("- "),
          w3,
          text(" 遗落在路边的金币，价值 "),
          _test_makeUnexecutedCommandPiece(context, ["r"], {
            isEmbedded: true,
            blankAtLeftSide: " ",
            gapAfterHead: "",
          }, [{ content: text("d100"), gapAtRight: " " }]),
        ],
        [
          text("- "),
          _test_makeUnexecutedCommandPiece(context, ["c"], {
            isEmbedded: true,
            blankAtLeftSide: " ",
            gapAfterHead: " ",
          }, [
            { content: text("--"), gapAtRight: " " },
            { content: text("大成功"), gapAtRight: " " },
            { content: text("大失败"), gapAtRight: " " },
          ]),
        ],
      ],
    },
  ]);
});

Deno.test(`${testPrefix} 实际例子`, async (t) => {
  await t.step("case 1", async (t) => {
    // 来自 insertedQueue 的内容，却包含换行符

    const context = _test_makeContext(["c"]);

    await testTokenizeMessage(t, context, {}, [
      {
        in: [
          {
            "data": {
              "text": "/c -- {\n",
            },
            "type": "text",
          },
          {
            "data": {
              "file": "xxx.image",
              // "subType": "0",
              // "url": "https://www.example.com",
            },
            "type": "image",
          },
          {
            "data": {
              "text": "\n} {\n1\n}",
            },
            "type": "text",
          },
        ],
        out: [[
          _test_makeUnexecutedCommandPiece(context, ["c"], {
            gapAfterHead: " ",
          }, [
            {
              content: text("--"),
              gapAtRight: " ",
            },
            {
              content: new GroupPiece({
                blankAtLeftSide: "\n",
                parts: [{
                  content: {
                    type: "image",
                    data: { file: "xxx.image" },
                  } as Image,
                  gapAtRight: "\n",
                }],
              }),
              gapAtRight: " ",
            },
            {
              content: new GroupPiece({
                blankAtLeftSide: "\n",
                parts: [{
                  content: text("1"),
                  gapAtRight: "\n",
                }],
              }),
              gapAtRight: "",
            },
          ]),
        ]],
      },
    ]);
  });
});

// Deno.test({
//   name: "temp",
//   only: true,
//   fn: async (t) => {
//     await testTokenizeMessage(t, _test_makeContext(["foo"]), {}, [

//     ]);
//   },
// });

function _test_makeUnexecutedCommandPiece(
  ctx: TokenizingEnvironment,
  cmds: string[],
  args: {
    isEmbedded?: boolean;
    isAwait?: boolean;
    blankAtLeftSide?: string;
    gapAfterHead?: string;

    prefix?: string;
  } = {},
  rawArguments: UnexecutedCommandPiece["arguments"] = [],
) {
  if (!(args.isEmbedded ?? false)) {
    if (args.blankAtLeftSide) throw new Error("never");
  }

  args = {
    isEmbedded: false,
    isAwait: false,
    blankAtLeftSide: "",
    gapAfterHead: "",
    ...args,
  };

  if (args.prefix) assertEquals(args.prefix, ctx.prefix);

  if (args.isEmbedded) {
    return new UnexecutedCommandPiece({
      type: "embedded",
      prefix: ctx.prefix,
      possibleCommands: _test_makeFakeCommands(cmds),
      isAwait: args.isAwait!,
      rawArguments,
      blankAtLeftSide: args.blankAtLeftSide!,
      gapAfterHead: args.gapAfterHead!,
    });
  }

  return new UnexecutedCommandPiece({
    type: "line",
    prefix: ctx.prefix,
    possibleCommands: _test_makeFakeCommands(cmds),
    isAwait: args.isAwait!,
    rawArguments,
    gapAfterHead: args.gapAfterHead!,
  });
}
