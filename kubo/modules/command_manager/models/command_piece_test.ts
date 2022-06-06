import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.134.0/testing/asserts.ts";
import {
  at,
  emoticon,
  imageFromBase64,
  RegularMessagePiece,
  Text,
  text,
} from "../../../../go_cqhttp_client/message_piece.ts";
import { _test_makeContext, _test_makeFakeCommands } from "../test_utils.ts";
import { tokenizeMessage, TokenizingEnvironment } from "../tokenizer.ts";
import { CommandArgument } from "./command_argument.ts";
import {
  CommandCallback,
  CommandCallbackReturnValue,
  CommandEntity,
} from "./command_entity.ts";
import {
  CommandExecutedResult,
  CommandNote,
  CompactComplexPiece,
  ComplexPiecePart,
  EmbeddingRaw,
  ExecutedCommandPiece,
  ExecutedPiece,
  GroupPiece,
  UnexecutedCommandPiece,
} from "./command_piece.ts";
import { ExecuteContextForMessage } from "./execute_context.ts";

const testPrefix = `kubo/command_manager/models/command_piece`;

Deno.test(`${testPrefix} isSqueezed`, async (t) => {
  const context = _test_makeContext(["foo"]);

  const table: {
    in: RegularMessagePiece[];
    isSqueezed: boolean;
  }[] = [
    { in: [text("/foo")], isSqueezed: false },
    { in: [text("/foo\t\n")], isSqueezed: false },
    { in: [text("{/foo}")], isSqueezed: false },
    { in: [text("{/foo  }")], isSqueezed: false },
    { in: [text("{/foo 123 }")], isSqueezed: false },
    { in: [text("/foo123")], isSqueezed: true },
    { in: [text("{/foo123}")], isSqueezed: true },
    { in: [text("/foo"), at(42)], isSqueezed: false },
    { in: [text("{/foo"), at(42), text("}")], isSqueezed: false },
  ];

  for (const [i, { in: _in, isSqueezed }] of table.entries()) {
    const inspected = Deno.inspect(
      _in.length === 1 && _in[0].type === "text" ? _in[0].data.text : _in,
    );
    await t.step(`case ${i + 1}: ` + inspected, async (t) => {
      const uCmd = getFirstCommandPiece(context, _in);
      assertEquals(
        uCmd.isSqueezed,
        isSqueezed,
      );
    });
  }
});

Deno.test(`${testPrefix} reconstructRaw`, async (t) => {
  const context = _test_makeContext(["foo"]);

  const table: {
    in: RegularMessagePiece[];
  }[] = [
    { in: [text("{/foo}")] },
    { in: [text("{/foo\n\t}")] },
    { in: [text("{/foo  \n  123  456}")] },
    { in: [text("/foo{  /foo  \n  123{/foo   }"), at(42), text("  456}")] },
  ];

  for (const [i, { in: _in }] of table.entries()) {
    const inspected = Deno.inspect(
      _in.length === 1 && _in[0].type === "text" ? _in[0].data.text : _in,
    );
    await t.step(`case ${i + 1}: ` + inspected, async (t) => {
      const uCmd = getFirstCommandPiece(context, _in);
      assertEquals(await uCmd.asRaw(), _in);
    });
  }
});

function getFirstCommandPiece(
  context: TokenizingEnvironment,
  msg: RegularMessagePiece[],
) {
  const pieces = tokenizeMessage(context, msg);
  assert(pieces?.[0]?.[0].type === "__kubo_unexecuted_command");
  return pieces[0][0] as UnexecutedCommandPiece;
}

Deno.test(`${testPrefix} 执行`, async (t) => {
  for (const style of ["line", "embedded"] as const) {
    await t.step(style, async (t) => {
      await t.step("单候选（无参数）", async (t) => {
        await t.step("中标", async (t) => {
          const candidates = _test_makeFakeCommands(
            ["ok"],
            (cmd, ctx, args) => {
              return "ok";
            },
          );
          const execContext = _test_makeExecuteContextForMessage();
          const cmd = _test_makeUnexecuted(style, { candidates });
          const executed = await _test_executeCommand(execContext, cmd);
          assert(executed);
          assertExecuted(executed, cmd, {
            result: _test_makeExpectedResult(style, [text("ok")]),
          });
        });

        await t.step("落空", async (t) => {
          const candidates = _test_makeFakeCommands(
            ["miss"],
            (cmd, ctx, args) => {
              return;
            },
          );
          const execContext = _test_makeExecuteContextForMessage();
          const cmd = _test_makeUnexecuted(style, { candidates });
          const executed = await _test_executeCommand(execContext, cmd);
          assertEquals(executed, null);
        });

        await t.step("用户错误", async (t) => {
          const candidates = _test_makeFakeCommands(
            ["error"],
            (cmd, ctx, args) => {
              return { error: "test_error" };
            },
          );
          const execContext = _test_makeExecuteContextForMessage();
          const cmd = _test_makeUnexecuted(style, { candidates });
          const executed = await _test_executeCommand(execContext, cmd);
          assert(executed);
          assertExecuted(executed, cmd, {
            hasFailed: true,
            notes: [
              { level: "user-error", content: "test_error" },
            ],
          });
        });

        await t.step("系统错误", async (t) => {
          const candidates = _test_makeFakeCommands(
            ["error"],
            (cmd, ctx, args) => {
              throw new Error("test_error");
            },
          );
          const execContext = _test_makeExecuteContextForMessage();
          const cmd = _test_makeUnexecuted(style, { candidates });
          const executed = await _test_executeCommand(execContext, cmd);
          assert(executed);
          assertExecuted(executed, cmd, {
            hasFailed: true,
            notes: [
              { level: "system-error", content: "执行命令途中遭遇异常，请参考日志！" },
            ],
          });
        });

        if (style === "embedded") {
          await t.step("提供嵌入内容", async (t) => {
            const candidates = _test_makeFakeCommands(
              ["get-42"],
              (cmd, ctx, args) => {
                return { embedding: "42", embeddingRaw: { value: 42 } };
              },
            );
            const execContext = _test_makeExecuteContextForMessage();
            const cmd = _test_makeUnexecuted(style, { candidates });
            const executed = await _test_executeCommand(execContext, cmd);
            assert(executed);
            assertExecuted(executed, cmd, {
              result: { embedding: [text("42")], embeddingRaw: { value: 42 } },
            });
          });

          await t.step("未提供嵌入内容", async (t) => {
            const candidates = _test_makeFakeCommands(
              ["foo"],
              (cmd, ctx, args) => {
                ctx.claimExecuted();
              },
            );
            const execContext = _test_makeExecuteContextForMessage();
            const cmd = _test_makeUnexecuted(style, { candidates });
            const executed = await _test_executeCommand(execContext, cmd);
            assert(executed);
            assertExecuted(executed, cmd, {
              hasFailed: true,
              notes: [{ level: "system-error", content: "嵌入命令未提供嵌入内容" }],
            });
          });
        }

        if (style === "line") {
          await t.step("手动声明执行成功", async (t) => {
            const candidates = _test_makeFakeCommands(
              ["foo"],
              (cmd, ctx, args) => {
                ctx.claimExecuted();
              },
            );
            const execContext = _test_makeExecuteContextForMessage();
            const cmd = _test_makeUnexecuted(style, { candidates });
            const executed = await _test_executeCommand(execContext, cmd);
            assert(executed);
            assertExecuted(executed, cmd, {});
          });
        }
      });

      await t.step("多候选（无参数）", async (t) => {
        await t.step("第一候选中标", async (t) => {
          const candidates = _test_makeFakeCommands(
            ["foo", "foobar"],
            (cmd, ctx, args) => {
              if (cmd === "foo") return "foo";
              return "foobar";
            },
            { argumentsBeginningPolicy: "unrestricted" },
          );
          const execContext = _test_makeExecuteContextForMessage();
          const cmd = _test_makeUnexecuted(style, { candidates });
          const executed = await _test_executeCommand(execContext, cmd);
          assert(executed);
          assertExecuted(executed, cmd, {
            result: _test_makeExpectedResult(style, [text("foobar")]),
          });
        });

        await t.step("第一候选落空，第二候选中标", async (t) => {
          const candidates = _test_makeFakeCommands(
            ["foo", "foobar"],
            (cmd, ctx, args) => {
              if (cmd === "foo") return "foo";
              return;
            },
            { argumentsBeginningPolicy: "unrestricted" },
          );
          const execContext = _test_makeExecuteContextForMessage();
          const cmd = _test_makeUnexecuted(style, { candidates });
          const executed = await _test_executeCommand(execContext, cmd);
          assert(executed);
          assertExecuted(executed, cmd, {
            result: _test_makeExpectedResult(style, [text("foo")]),
          });
        });

        await t.step("第一候选错误，第二候选中标", async (t) => {
          const candidates = _test_makeFakeCommands(
            ["foo", "foobar"],
            (cmd, ctx, args) => {
              if (cmd === "foo") return "foo";
              return { error: "test_error" };
            },
            { argumentsBeginningPolicy: "unrestricted" },
          );
          const execContext = _test_makeExecuteContextForMessage();
          const cmd = _test_makeUnexecuted(style, { candidates });
          const executed = await _test_executeCommand(execContext, cmd);
          assert(executed);
          assertExecuted(executed, cmd, {
            result: _test_makeExpectedResult(style, [text("foo")]),
          });
        });

        await t.step("所有候选错误", async (t) => {
          const candidates = _test_makeFakeCommands(
            ["foo", "foobar"],
            (cmd, ctx, args) => {
              return { error: "test_error" };
            },
            { argumentsBeginningPolicy: "unrestricted" },
          );
          const execContext = _test_makeExecuteContextForMessage();
          const cmd = _test_makeUnexecuted(style, { candidates });
          const executed = await _test_executeCommand(execContext, cmd);
          assert(executed);
          assertExecuted(executed, cmd, {
            hasFailed: true,
            notes: [{ level: "user-error", content: "test_error" }],
          });
        });

        await t.step("所有候选落空", async (t) => {
          const candidates = _test_makeFakeCommands(
            ["foo", "foobar"],
            (cmd, ctx, args) => {
              return;
            },
            { argumentsBeginningPolicy: "unrestricted" },
          );
          const execContext = _test_makeExecuteContextForMessage();
          const cmd = _test_makeUnexecuted(style, { candidates });
          const executed = await _test_executeCommand(execContext, cmd);
          assertEquals(executed, null);
        });

        await t.step("第一、第三个选项落空，第二个选项错误：因此第二个选项有效", async (t) => {
          const candidates = _test_makeFakeCommands(
            ["foobar", "foo", "f"],
            (cmd, ctx, args) => {
              if (cmd === "foobar") return { error: "test_error" };
              return;
            },
            { argumentsBeginningPolicy: "unrestricted" },
          );
          const execContext = _test_makeExecuteContextForMessage();
          const cmd = _test_makeUnexecuted(style, { candidates });
          const executed = await _test_executeCommand(execContext, cmd);
          assert(executed);
          assertExecuted(executed, cmd, {
            hasFailed: true,
            notes: [{ level: "user-error", content: "test_error" }],
          });
        });

        await t.step("第一候选落空，第二候选因参数起始策略而落空", async (t) => {
          const candidates = _test_makeFakeCommands(
            ["foobar"],
            (cmd, ctx, args) => {
              if (cmd === "foobar") return;
              return "foo";
            },
            { argumentsBeginningPolicy: "follows-spaces" },
          );
          const execContext = _test_makeExecuteContextForMessage();
          const cmd = _test_makeUnexecuted(style, { candidates });
          const executed = await _test_executeCommand(execContext, cmd);
          assertEquals(executed, null);
        });

        await t.step("第一候选错误，第二候选因参数起始策略而落空，第三候选中标", async (t) => {
          const [cmd_foobar, cmd_foo] = _test_makeFakeCommands(
            ["foobar", "foo"],
            (cmd, ctx, args) => {
              if (cmd === "foobar") return { error: "test_error" };
              return cmd;
            },
            { argumentsBeginningPolicy: "follows-spaces" },
          );
          const [cmd_f] = _test_makeFakeCommands(
            ["f"],
            (cmd, ctx, args) => {
              return "f";
            },
            { argumentsBeginningPolicy: "unrestricted" },
          );
          const candidates = [cmd_foobar, cmd_foo, cmd_f];
          const execContext = _test_makeExecuteContextForMessage();
          const cmd = _test_makeUnexecuted(style, { candidates });
          const executed = await _test_executeCommand(execContext, cmd);
          assert(executed);
          assertExecuted(executed, cmd, {
            result: _test_makeExpectedResult(style, [text("f")]),
          });
        });
      });

      await t.step("带常规参数", async (t) => {
        await t.step("case 1: sum command", async (t) => {
          const candidates = _test_makeFakeCommands(
            ["sum"],
            (cmd, ctx, args) => test_cmd_sum(ctx, args),
          );

          type Row = { args: Text[]; result: number | null };
          const table: Row[] = [
            { args: [text("42")], result: 42 },
            { args: [text("123"), text("456"), text("789")], result: 1368 },
            { args: [text("12.3"), text("-45.6")], result: -33.3 },
            { args: [text("foo"), text("42")], result: null },
            { args: [text("NaN")], result: null },
            { args: [text("Infinity")], result: Infinity },
          ];

          for (const row of table) {
            const desc = "/sum " +
              row.args.map((arg) => arg.data.text).join(" ");
            await t.step(desc, async (t) => {
              const cmdRawArgs: ComplexPiecePart[] = [], cmdArgs = [];
              for (const arg of row.args) {
                const cmdRawArg = {
                  content: arg,
                  gapAtRight: " ",
                };
                const cmdArg = new CommandArgument(cmdRawArg);
                cmdRawArgs.push(cmdRawArg);
                cmdArgs.push(cmdArg);
              }
              const execContext = _test_makeExecuteContextForMessage();
              const cmd = _test_makeUnexecuted(style, {
                candidates,
                cmdRawArgs,
              });
              const executed = await _test_executeCommand(execContext, cmd);
              assert(executed);
              if (row.result !== null) {
                assertExecuted(executed, cmd, {
                  arguments: cmdArgs,
                  result: (style === "embedded"
                    ? {
                      embedding: [text(String(row.result))],
                      embeddingRaw: { value: row.result },
                    }
                    : {
                      response: [text(`相加结果为：${row.result}`)],
                    }),
                });
              } else {
                assertExecuted(executed, cmd, {
                  arguments: cmdArgs,
                  hasFailed: true,
                  notes: [{ level: "user-error", content: "不支持非数字参数！" }],
                });
              }
            });
          }
        });
      });

      await t.step("存在嵌套的参数", async (t) => {
        const [cmd_get42] = _test_makeFakeCommands(
          ["get-42"],
          (cmd, ctx, args) => {
            return { embedding: "42", embeddingRaw: { value: 42 } };
          },
        );
        const [cmd_sum] = _test_makeFakeCommands(
          ["sum"],
          (cmd, ctx, args) => test_cmd_sum(ctx, args),
        );

        type Row = {
          description: string;
          args: ComplexPiecePart<false>[];
          argsAfterExecution?: CommandArgument[];
          result: number;
        };
        const table: Row[] = [
          {
            description: "/sum 1 { /get-42 }",
            args: [
              { content: text("1"), gapAtRight: " " },
              {
                content: _test_makeUnexecuted("embedded", {
                  gapAfterHead: " ",
                  candidates: [cmd_get42],
                }),
                gapAtRight: "",
              },
            ],
            argsAfterExecution: [
              new CommandArgument({ content: text("1"), gapAtRight: " " }),
              new CommandArgument({
                content: new ExecutedCommandPiece(cmd_get42, {
                  context: null as unknown as any,
                  isEmbedded: true,
                  blankAtLeftSide: " ",
                  prefix: "/",
                  shouldAwait: false,
                  arguments: [],
                  gapAfterHead: " ",
                  hasFailed: false,
                  result: {
                    embedding: [text("42")],
                    embeddingRaw: { value: 42 },
                  },
                  notes: [],
                }),
                gapAtRight: "",
              }),
            ],
            result: 43,
          },
          {
            description: "/sum { 2 } { { /get-42 } }",
            args: [
              {
                content: new GroupPiece({
                  blankAtLeftSide: " ",
                  parts: [{ content: text("2"), gapAtRight: " " }],
                }),
                gapAtRight: " ",
              },
              {
                content: new GroupPiece({
                  blankAtLeftSide: " ",
                  parts: [{
                    content: _test_makeUnexecuted("embedded", {
                      gapAfterHead: " ",
                      candidates: [cmd_get42],
                    }),
                    gapAtRight: " ",
                  }],
                }),
                gapAtRight: "",
              },
            ],
            result: 44,
          },
          {
            description: "/sum 3{ /get-42 }",
            args: [{
              content: new CompactComplexPiece([
                text("3"),
                _test_makeUnexecuted("embedded", {
                  gapAfterHead: " ",
                  candidates: [cmd_get42],
                }),
              ]),
              gapAtRight: "",
            }],
            result: 342,
          },
          {
            description: "/sum { 4{ /get-42 } }",
            args: [{
              content: new GroupPiece({
                blankAtLeftSide: " ",
                parts: [{
                  content: new CompactComplexPiece([
                    text("4"),
                    _test_makeUnexecuted("embedded", {
                      gapAfterHead: " ",
                      candidates: [cmd_get42],
                    }),
                  ]),
                  gapAtRight: " ",
                }],
              }),
              gapAtRight: "",
            }],
            result: 442,
          },
          {
            description: "/sum 5{ {/get-42} }",
            args: [{
              content: new CompactComplexPiece([
                text("5"),
                new GroupPiece({
                  blankAtLeftSide: " ",
                  parts: [{
                    content: _test_makeUnexecuted("embedded", {
                      gapAfterHead: " ",
                      candidates: [cmd_get42],
                    }),
                    gapAtRight: " ",
                  }],
                }),
              ]),
              gapAtRight: "",
            }],
            result: 542,
          },
        ];

        for (const [i, row] of table.entries()) {
          await t.step(`case ${i + 1}: ${row.description}`, async (t) => {
            const execContext = _test_makeExecuteContextForMessage();
            const cmd = _test_makeUnexecuted(style, {
              candidates: [cmd_sum],
              cmdRawArgs: row.args,
            });
            const executed = await _test_executeCommand(execContext, cmd);
            assert(executed);
            assertExecuted(executed, cmd, {
              arguments: row.argsAfterExecution
                ? row.argsAfterExecution
                : "skip",
              result: (style === "embedded"
                ? {
                  embedding: [text(String(row.result))],
                  embeddingRaw: { value: row.result },
                }
                : {
                  response: [text(`相加结果为：${row.result}`)],
                }),
            });
          });
        }
      });

      // ctx.getWholeArgumentSince(n)
      await t.step("获取从某一位置起作为整体的参数", async (t) => {
        throw new Error("unimplemented");
      });

      await t.step("将命令复原到原始形式", async (t) => {
        type Row = {
          description: string;
          cmd: UnexecutedCommandPiece;
          expectedRaw: {
            forLine: RegularMessagePiece[];
            forEmbedded: RegularMessagePiece[];
          };
          expectedReconstructed: {
            forLine: ExecutedPiece[];
            forEmbedded: GroupPiece<true>;
          };
        };

        const [cmd_get42] = _test_makeFakeCommands(
          ["get-42"],
          (cmd, ctx, args) => {
            return { embedding: "42", embeddingRaw: { value: 42 } };
          },
        );
        const [cmd_sum] = _test_makeFakeCommands(
          ["sum"],
          (cmd, ctx, args) => test_cmd_sum(ctx, args),
          { argumentsBeginningPolicy: "unrestricted" },
        );

        function makeCmd_sum(
          gapAfterHead: "" | " ",
          cmdRawArgs: ComplexPiecePart<false>[],
        ) {
          return _test_makeUnexecuted(style, {
            blankAtLeftSide: "",
            gapAfterHead,
            candidates: [cmd_sum],
            cmdRawArgs,
          });
        }

        await t.step("参数不含命令", async (t) => {
          const table: (Row | null)[] = [
            {
              description: "/sum",
              cmd: makeCmd_sum("", []),
              expectedRaw: {
                forLine: [text("/sum")],
                forEmbedded: [text("{/sum}")],
              },
              expectedReconstructed: {
                forLine: [text("/sum")],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [{ content: text("/sum"), gapAtRight: "" }],
                }),
              },
            },
            {
              description: "/sum1",
              cmd: makeCmd_sum("", [{ content: text("1"), gapAtRight: "" }]),
              expectedRaw: {
                forLine: [text("/sum1")],
                forEmbedded: [text("{/sum1}")],
              },
              expectedReconstructed: {
                forLine: [text("/sum1")],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [{ content: text("/sum1"), gapAtRight: "" }],
                }),
              },
            },
            {
              description: "/sum 1",
              cmd: makeCmd_sum(" ", [{ content: text("1"), gapAtRight: "" }]),
              expectedRaw: {
                forLine: [text("/sum 1")],
                forEmbedded: [text("{/sum 1}")],
              },
              expectedReconstructed: {
                forLine: [text("/sum 1")],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [
                    { content: text("/sum"), gapAtRight: " " },
                    { content: text("1"), gapAtRight: "" },
                  ],
                }),
              },
            },
            {
              description: "/sum[at]",
              cmd: makeCmd_sum("", [{ content: at(42), gapAtRight: "" }]),
              expectedRaw: {
                forLine: [text("/sum"), at(42)],
                forEmbedded: [text("{/sum"), at(42), text("}")],
              },
              expectedReconstructed: {
                forLine: [text("/sum"), at(42)],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [{
                    content: new CompactComplexPiece([text("/sum"), at(42)]),
                    gapAtRight: "",
                  }],
                }),
              },
            },
            {
              description: "/sum [at]",
              cmd: makeCmd_sum(" ", [{ content: at(42), gapAtRight: "" }]),
              expectedRaw: {
                forLine: [text("/sum "), at(42)],
                forEmbedded: [text("{/sum "), at(42), text("}")],
              },
              expectedReconstructed: {
                forLine: [text("/sum "), at(42)],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [
                    { content: text("/sum"), gapAtRight: " " },
                    { content: at(42), gapAtRight: "" },
                  ],
                }),
              },
            },
            {
              description: "/sum1[at]",
              cmd: makeCmd_sum("", [{
                content: new CompactComplexPiece([text("1"), at(42)]),
                gapAtRight: "",
              }]),
              expectedRaw: {
                forLine: [text("/sum1"), at(42)],
                forEmbedded: [text("{/sum1"), at(42), text("}")],
              },
              expectedReconstructed: {
                forLine: [text("/sum1"), at(42)],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [{
                    content: new CompactComplexPiece([text("/sum1"), at(42)]),
                    gapAtRight: "",
                  }],
                }),
              },
            },
            {
              description: "/sum 1[at]",
              cmd: makeCmd_sum(" ", [{
                content: new CompactComplexPiece([text("1"), at(42)]),
                gapAtRight: "",
              }]),
              expectedRaw: {
                forLine: [text("/sum 1"), at(42)],
                forEmbedded: [text("{/sum 1"), at(42), text("}")],
              },
              expectedReconstructed: {
                forLine: [text("/sum 1"), at(42)],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [
                    {
                      content: text("/sum"),
                      gapAtRight: " ",
                    },
                    {
                      content: new CompactComplexPiece([text("1"), at(42)]),
                      gapAtRight: "",
                    },
                  ],
                }),
              },
            },
            {
              description: "/sum[at]1",
              cmd: makeCmd_sum("", [{
                content: new CompactComplexPiece([at(42), text("1")]),
                gapAtRight: "",
              }]),
              expectedRaw: {
                forLine: [text("/sum"), at(42), text("1")],
                forEmbedded: [text("{/sum"), at(42), text("1}")],
              },
              expectedReconstructed: {
                forLine: [text("/sum"), at(42), text("1")],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [{
                    content: new CompactComplexPiece([
                      text("/sum"),
                      at(42),
                      text("1"),
                    ]),
                    gapAtRight: "",
                  }],
                }),
              },
            },
            {
              description: "/sum [at]1",
              cmd: makeCmd_sum(" ", [{
                content: new CompactComplexPiece([at(42), text("1")]),
                gapAtRight: "",
              }]),
              expectedRaw: {
                forLine: [text("/sum "), at(42), text("1")],
                forEmbedded: [text("{/sum "), at(42), text("1}")],
              },
              expectedReconstructed: {
                forLine: [text("/sum "), at(42), text("1")],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [
                    {
                      content: text("/sum"),
                      gapAtRight: " ",
                    },
                    {
                      content: new CompactComplexPiece([at(42), text("1")]),
                      gapAtRight: "",
                    },
                  ],
                }),
              },
            },
            {
              description: "/sum{1}",
              cmd: makeCmd_sum("", [{
                content: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [{ content: text("1"), gapAtRight: "" }],
                }),
                gapAtRight: "",
              }]),
              expectedRaw: {
                forLine: [text("/sum{1}")],
                forEmbedded: [
                  text("{/sum{1}}"),
                ],
              },
              expectedReconstructed: {
                forLine: [
                  text("/sum"),
                  new GroupPiece({
                    blankAtLeftSide: "",
                    parts: [{ content: text("1"), gapAtRight: "" }],
                  }),
                ],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [
                    {
                      content: new CompactComplexPiece([
                        text("/sum"),
                        new GroupPiece({
                          blankAtLeftSide: "",
                          parts: [{ content: text("1"), gapAtRight: "" }],
                        }),
                      ]),
                      gapAtRight: "",
                    },
                  ],
                }),
              },
            },
            {
              description: "/sum {1}",
              cmd: makeCmd_sum(" ", [{
                content: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [{ content: text("1"), gapAtRight: "" }],
                }),
                gapAtRight: "",
              }]),
              expectedRaw: {
                forLine: [text("/sum {1}")],
                forEmbedded: [text("{/sum {1}}")],
              },
              expectedReconstructed: {
                forLine: [
                  text("/sum "),
                  new GroupPiece({
                    blankAtLeftSide: "",
                    parts: [{ content: text("1"), gapAtRight: "" }],
                  }),
                ],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [
                    {
                      content: text("/sum"),
                      gapAtRight: " ",
                    },
                    {
                      content: new GroupPiece({
                        blankAtLeftSide: "",
                        parts: [{ content: text("1"), gapAtRight: "" }],
                      }),
                      gapAtRight: "",
                    },
                  ],
                }),
              },
            },
            {
              description: "/sum{1[at]}",
              cmd: makeCmd_sum("", [{
                content: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [{
                    content: new CompactComplexPiece([text("1"), at(42)]),
                    gapAtRight: "",
                  }],
                }),
                gapAtRight: "",
              }]),
              expectedRaw: {
                forLine: [text("/sum{1"), at(42), text("}")],
                forEmbedded: [text("{/sum{1"), at(42), text("}}")],
              },
              expectedReconstructed: {
                forLine: [
                  text("/sum"),
                  new GroupPiece({
                    blankAtLeftSide: "",
                    parts: [{
                      content: new CompactComplexPiece([text("1"), at(42)]),
                      gapAtRight: "",
                    }],
                  }),
                ],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [
                    {
                      content: new CompactComplexPiece([
                        text("/sum"),
                        new GroupPiece({
                          blankAtLeftSide: "",
                          parts: [{
                            content: new CompactComplexPiece([
                              text("1"),
                              at(42),
                            ]),
                            gapAtRight: "",
                          }],
                        }),
                      ]),
                      gapAtRight: "",
                    },
                  ],
                }),
              },
            },
            {
              description: "/sum {1[at]}",
              cmd: makeCmd_sum(" ", [{
                content: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [{
                    content: new CompactComplexPiece([text("1"), at(42)]),
                    gapAtRight: "",
                  }],
                }),
                gapAtRight: "",
              }]),
              expectedRaw: {
                forLine: [text("/sum {1"), at(42), text("}")],
                forEmbedded: [text("{/sum {1"), at(42), text("}}")],
              },
              expectedReconstructed: {
                forLine: [
                  text("/sum "),
                  new GroupPiece({
                    blankAtLeftSide: "",
                    parts: [{
                      content: new CompactComplexPiece([text("1"), at(42)]),
                      gapAtRight: "",
                    }],
                  }),
                ],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [
                    {
                      content: text("/sum"),
                      gapAtRight: " ",
                    },
                    {
                      content: new GroupPiece({
                        blankAtLeftSide: "",
                        parts: [{
                          content: new CompactComplexPiece([text("1"), at(42)]),
                          gapAtRight: "",
                        }],
                      }),
                      gapAtRight: "",
                    },
                  ],
                }),
              },
            },
            {
              description: "/sum{[at]1}",
              cmd: makeCmd_sum("", [{
                content: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [{
                    content: new CompactComplexPiece([at(42), text("1")]),
                    gapAtRight: "",
                  }],
                }),
                gapAtRight: "",
              }]),
              expectedRaw: {
                forLine: [text("/sum{"), at(42), text("1}")],
                forEmbedded: [text("{/sum{"), at(42), text("1}}")],
              },
              expectedReconstructed: {
                forLine: [
                  text("/sum"),
                  new GroupPiece({
                    blankAtLeftSide: "",
                    parts: [{
                      content: new CompactComplexPiece([at(42), text("1")]),
                      gapAtRight: "",
                    }],
                  }),
                ],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [{
                    content: new CompactComplexPiece([
                      text("/sum"),
                      new GroupPiece({
                        blankAtLeftSide: "",
                        parts: [{
                          content: new CompactComplexPiece([at(42), text("1")]),
                          gapAtRight: "",
                        }],
                      }),
                    ]),
                    gapAtRight: "",
                  }],
                }),
              },
            },
            {
              description: "/sum {[at]1}",
              cmd: makeCmd_sum(" ", [{
                content: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [{
                    content: new CompactComplexPiece([at(42), text("1")]),
                    gapAtRight: "",
                  }],
                }),
                gapAtRight: "",
              }]),
              expectedRaw: {
                forLine: [text("/sum {"), at(42), text("1}")],
                forEmbedded: [text("{/sum {"), at(42), text("1}}")],
              },
              expectedReconstructed: {
                forLine: [
                  text("/sum "),
                  new GroupPiece({
                    blankAtLeftSide: "",
                    parts: [{
                      content: new CompactComplexPiece([at(42), text("1")]),
                      gapAtRight: "",
                    }],
                  }),
                ],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [
                    {
                      content: text("/sum"),
                      gapAtRight: " ",
                    },
                    {
                      content: new GroupPiece({
                        blankAtLeftSide: "",
                        parts: [{
                          content: new CompactComplexPiece([at(42), text("1")]),
                          gapAtRight: "",
                        }],
                      }),
                      gapAtRight: "",
                    },
                  ],
                }),
              },
            },
          ];

          for (const [i, row] of table.entries()) {
            if (!row) break;
            await t.step(`case ${i + 1}: ${row.description}`, async (t) => {
              await t.step("还原为 RegularMessagePiece[]", async (t) => {
                if (style === "line") {
                  assertEquals(
                    await row.cmd.asRaw(),
                    row.expectedRaw.forLine,
                  );
                } else {
                  if (style !== "embedded") throw new Error("never");
                  assertEquals(
                    await row.cmd.asRaw(),
                    row.expectedRaw.forEmbedded,
                  );
                }
              });
              await t.step("执行并重组", async (t) => {
                const execContext = _test_makeExecuteContextForMessage();
                if (style === "line") {
                  assertEquals(
                    await row.cmd.asLineExecuted(execContext),
                    row.expectedReconstructed.forLine,
                  );
                } else {
                  if (style !== "embedded") throw new Error("never");
                  assertEquals(
                    await row.cmd.asGroupExecuted(execContext),
                    row.expectedReconstructed.forEmbedded,
                  );
                }
              });
              await t.step("执行后还原为 RegularMessagePiece[]", async (t) => {
                const execContext = _test_makeExecuteContextForMessage();
                const executed = await _test_executeCommand(
                  execContext,
                  row.cmd,
                )!;
                if (style === "line") {
                  assertEquals(
                    await executed!.asRaw(),
                    row.expectedRaw.forLine,
                  );
                } else {
                  if (style !== "embedded") throw new Error("never");
                  assertEquals(
                    await executed!.asRaw(),
                    row.expectedRaw.forEmbedded,
                  );
                }
              });
            });
          }
        });

        await t.step("候选包括多条命令", async (t) => {
          await t.step("case 1", async (t) => {
            const candidates = _test_makeFakeCommands(
              ["foo", "foobar"],
              (cmd, ctx, args) => {
                if (cmd === "foo") return "foo";
                return "foobar";
              },
              { argumentsBeginningPolicy: "unrestricted" },
            );
            const execContext = _test_makeExecuteContextForMessage();
            const unexecuted = _test_makeUnexecuted(style, {
              blankAtLeftSide: "",
              gapAfterHead: "",
              candidates,
              cmdRawArgs: [{ content: text("baz"), gapAtRight: "" }],
            });
            if (style === "line") {
              assertEquals(
                await unexecuted.asLineExecuted(execContext),
                [text("/foobarbaz")],
              );
            } else {
              if (style !== "embedded") throw new Error("never");
              assertEquals(
                await unexecuted.asGroupExecuted(execContext),
                new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [{ content: text("/foobarbaz"), gapAtRight: "" }],
                }),
              );
            }
          });
        });

        await t.step("调用错方法", async (t) => {
          await t.step("case 1", async (t) => {
            const candidates = _test_makeFakeCommands(
              ["foo"],
              (cmd, ctx, args) => "foo",
              { argumentsBeginningPolicy: "unrestricted" },
            );
            const execContext = _test_makeExecuteContextForMessage();
            const unexecuted = _test_makeUnexecuted(style, { candidates });
            if (style === "line") {
              assertRejects(async () =>
                await unexecuted.asGroupExecuted(execContext)
              );
            } else {
              if (style !== "embedded") throw new Error("never");
              assertRejects(async () =>
                await unexecuted.asLineExecuted(execContext)
              );
            }
          });
        });

        await t.step("参数含有命令", async (t) => {
          function makeCmd_get42() {
            return _test_makeUnexecuted("embedded", {
              blankAtLeftSide: "",
              candidates: [cmd_get42],
              gapAfterHead: "",
            });
          }
          const executedCmd_get42 = _test_makeExecuted("embedded", cmd_get42, {
            blankAtLeftSide: "",
            gapAfterHead: "",
            result: { embedding: [text("42")], embeddingRaw: { value: 42 } },
          });

          const table: (Row | null)[] = [
            {
              description: "/sum{/get-42}",
              cmd: makeCmd_sum("", [{
                content: makeCmd_get42(),
                gapAtRight: "",
              }]),
              expectedRaw: {
                forLine: [text("/sum{/get-42}")],
                forEmbedded: [text("{/sum{/get-42}}")],
              },
              expectedReconstructed: {
                forLine: [text("/sum"), executedCmd_get42],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [{
                    content: new CompactComplexPiece([
                      text("/sum"),
                      executedCmd_get42,
                    ]),
                    gapAtRight: "",
                  }],
                }),
              },
            },
            {
              description: "/sum {/get-42}",
              cmd: makeCmd_sum(" ", [{
                content: makeCmd_get42(),
                gapAtRight: "",
              }]),
              expectedRaw: {
                forLine: [text("/sum {/get-42}")],
                forEmbedded: [text("{/sum {/get-42}}")],
              },
              expectedReconstructed: {
                forLine: [text("/sum "), executedCmd_get42],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [
                    {
                      content: text("/sum"),
                      gapAtRight: " ",
                    },
                    {
                      content: executedCmd_get42,
                      gapAtRight: "",
                    },
                  ],
                }),
              },
            },
            {
              description: "/sum1{/get-42}",
              cmd: makeCmd_sum("", [
                {
                  content: new CompactComplexPiece([
                    text("1"),
                    makeCmd_get42(),
                  ]),
                  gapAtRight: "",
                },
              ]),
              expectedRaw: {
                forLine: [text("/sum1{/get-42}")],
                forEmbedded: [text("{/sum1{/get-42}}")],
              },
              expectedReconstructed: {
                forLine: [text("/sum1"), executedCmd_get42],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [
                    {
                      content: new CompactComplexPiece([
                        text("/sum1"),
                        executedCmd_get42,
                      ]),
                      gapAtRight: "",
                    },
                  ],
                }),
              },
            },
            {
              description: "/sum 1{/get-42}",
              cmd: makeCmd_sum(" ", [
                {
                  content: new CompactComplexPiece([
                    text("1"),
                    makeCmd_get42(),
                  ]),
                  gapAtRight: "",
                },
              ]),
              expectedRaw: {
                forLine: [text("/sum 1{/get-42}")],
                forEmbedded: [text("{/sum 1{/get-42}}")],
              },
              expectedReconstructed: {
                forLine: [text("/sum 1"), executedCmd_get42],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [
                    {
                      content: text("/sum"),
                      gapAtRight: " ",
                    },
                    {
                      content: new CompactComplexPiece([
                        text("1"),
                        executedCmd_get42,
                      ]),
                      gapAtRight: "",
                    },
                  ],
                }),
              },
            },
            {
              description: "/sum{/get-42}1",
              cmd: makeCmd_sum("", [
                {
                  content: new CompactComplexPiece([
                    makeCmd_get42(),
                    text("1"),
                  ]),
                  gapAtRight: "",
                },
              ]),
              expectedRaw: {
                forLine: [text("/sum{/get-42}1")],
                forEmbedded: [text("{/sum{/get-42}1}")],
              },
              expectedReconstructed: {
                forLine: [text("/sum"), executedCmd_get42, text("1")],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [
                    {
                      content: new CompactComplexPiece([
                        text("/sum"),
                        executedCmd_get42,
                        text("1"),
                      ]),
                      gapAtRight: "",
                    },
                  ],
                }),
              },
            },
            {
              description: "/sum {/get-42}1",
              cmd: makeCmd_sum(" ", [
                {
                  content: new CompactComplexPiece([
                    makeCmd_get42(),
                    text("1"),
                  ]),
                  gapAtRight: "",
                },
              ]),
              expectedRaw: {
                forLine: [text("/sum {/get-42}1")],
                forEmbedded: [text("{/sum {/get-42}1}")],
              },
              expectedReconstructed: {
                forLine: [text("/sum "), executedCmd_get42, text("1")],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [
                    {
                      content: text("/sum"),
                      gapAtRight: " ",
                    },
                    {
                      content: new CompactComplexPiece([
                        executedCmd_get42,
                        text("1"),
                      ]),
                      gapAtRight: "",
                    },
                  ],
                }),
              },
            },
            {
              description: "/sum[at]{/get-42}",
              cmd: makeCmd_sum("", [
                {
                  content: new CompactComplexPiece([
                    at(42),
                    makeCmd_get42(),
                  ]),
                  gapAtRight: "",
                },
              ]),
              expectedRaw: {
                forLine: [text("/sum"), at(42), text("{/get-42}")],
                forEmbedded: [text("{/sum"), at(42), text("{/get-42}}")],
              },
              expectedReconstructed: {
                forLine: [text("/sum"), at(42), executedCmd_get42],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [
                    {
                      content: new CompactComplexPiece([
                        text("/sum"),
                        at(42),
                        executedCmd_get42,
                      ]),
                      gapAtRight: "",
                    },
                  ],
                }),
              },
            },
            {
              description: "/sum [at]{/get-42}",
              cmd: makeCmd_sum(" ", [
                {
                  content: new CompactComplexPiece([
                    at(42),
                    makeCmd_get42(),
                  ]),
                  gapAtRight: "",
                },
              ]),
              expectedRaw: {
                forLine: [text("/sum "), at(42), text("{/get-42}")],
                forEmbedded: [text("{/sum "), at(42), text("{/get-42}}")],
              },
              expectedReconstructed: {
                forLine: [text("/sum "), at(42), executedCmd_get42],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [
                    {
                      content: text("/sum"),
                      gapAtRight: " ",
                    },
                    {
                      content: new CompactComplexPiece([
                        at(42),
                        executedCmd_get42,
                      ]),
                      gapAtRight: "",
                    },
                  ],
                }),
              },
            },
            {
              description: "/sum{{/get-42}}",
              cmd: makeCmd_sum("", [
                {
                  content: new GroupPiece({
                    blankAtLeftSide: "",
                    parts: [{ content: makeCmd_get42(), gapAtRight: "" }],
                  }),
                  gapAtRight: "",
                },
              ]),
              expectedRaw: {
                forLine: [text("/sum{{/get-42}}")],
                forEmbedded: [text("{/sum{{/get-42}}}")],
              },
              expectedReconstructed: {
                forLine: [
                  text("/sum"),
                  new GroupPiece({
                    blankAtLeftSide: "",
                    parts: [{ content: executedCmd_get42, gapAtRight: "" }],
                  }),
                ],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [
                    {
                      content: new CompactComplexPiece([
                        text("/sum"),
                        new GroupPiece({
                          blankAtLeftSide: "",
                          parts: [{
                            content: executedCmd_get42,
                            gapAtRight: "",
                          }],
                        }),
                      ]),
                      gapAtRight: "",
                    },
                  ],
                }),
              },
            },
            {
              description: "/sum {{/get-42}}",
              cmd: makeCmd_sum(" ", [
                {
                  content: new GroupPiece({
                    blankAtLeftSide: "",
                    parts: [{ content: makeCmd_get42(), gapAtRight: "" }],
                  }),
                  gapAtRight: "",
                },
              ]),
              expectedRaw: {
                forLine: [text("/sum {{/get-42}}")],
                forEmbedded: [text("{/sum {{/get-42}}}")],
              },
              expectedReconstructed: {
                forLine: [
                  text("/sum "),
                  new GroupPiece({
                    blankAtLeftSide: "",
                    parts: [{ content: executedCmd_get42, gapAtRight: "" }],
                  }),
                ],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [
                    {
                      content: text("/sum"),
                      gapAtRight: " ",
                    },
                    {
                      content: new GroupPiece({
                        blankAtLeftSide: "",
                        parts: [{ content: executedCmd_get42, gapAtRight: "" }],
                      }),
                      gapAtRight: "",
                    },
                  ],
                }),
              },
            },
            {
              description: "/sum{1{/get-42}}",
              cmd: makeCmd_sum("", [
                {
                  content: new GroupPiece({
                    blankAtLeftSide: "",
                    parts: [{
                      content: new CompactComplexPiece([
                        text("1"),
                        makeCmd_get42(),
                      ]),
                      gapAtRight: "",
                    }],
                  }),
                  gapAtRight: "",
                },
              ]),
              expectedRaw: {
                forLine: [text("/sum{1{/get-42}}")],
                forEmbedded: [text("{/sum{1{/get-42}}}")],
              },
              expectedReconstructed: {
                forLine: [
                  text("/sum"),
                  new GroupPiece({
                    blankAtLeftSide: "",
                    parts: [{
                      content: new CompactComplexPiece([
                        text("1"),
                        executedCmd_get42,
                      ]),
                      gapAtRight: "",
                    }],
                  }),
                ],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [
                    {
                      content: new CompactComplexPiece([
                        text("/sum"),
                        new GroupPiece({
                          blankAtLeftSide: "",
                          parts: [{
                            content: new CompactComplexPiece([
                              text("1"),
                              executedCmd_get42,
                            ]),
                            gapAtRight: "",
                          }],
                        }),
                      ]),
                      gapAtRight: "",
                    },
                  ],
                }),
              },
            },
            {
              description: "/sum {1{/get-42}}",
              cmd: makeCmd_sum(" ", [
                {
                  content: new GroupPiece({
                    blankAtLeftSide: "",
                    parts: [{
                      content: new CompactComplexPiece([
                        text("1"),
                        makeCmd_get42(),
                      ]),
                      gapAtRight: "",
                    }],
                  }),
                  gapAtRight: "",
                },
              ]),
              expectedRaw: {
                forLine: [text("/sum {1{/get-42}}")],
                forEmbedded: [text("{/sum {1{/get-42}}}")],
              },
              expectedReconstructed: {
                forLine: [
                  text("/sum "),
                  new GroupPiece({
                    blankAtLeftSide: "",
                    parts: [{
                      content: new CompactComplexPiece([
                        text("1"),
                        executedCmd_get42,
                      ]),
                      gapAtRight: "",
                    }],
                  }),
                ],
                forEmbedded: new GroupPiece({
                  blankAtLeftSide: "",
                  parts: [
                    {
                      content: text("/sum"),
                      gapAtRight: " ",
                    },
                    {
                      content: new GroupPiece({
                        blankAtLeftSide: "",
                        parts: [{
                          content: new CompactComplexPiece([
                            text("1"),
                            executedCmd_get42,
                          ]),
                          gapAtRight: "",
                        }],
                      }),
                      gapAtRight: "",
                    },
                  ],
                }),
              },
            },
          ];

          for (const [i, row] of table.entries()) {
            if (!row) break;
            await t.step(`case ${i + 1}: ${row.description}`, async (t) => {
              await t.step("还原为 RegularMessagePiece[]", async (t) => {
                if (style === "line") {
                  assertEquals(
                    await row.cmd.asRaw(),
                    row.expectedRaw.forLine,
                  );
                } else {
                  if (style !== "embedded") throw new Error("never");
                  assertEquals(
                    await row.cmd.asRaw(),
                    row.expectedRaw.forEmbedded,
                  );
                }
              });
              await t.step("执行并重组", async (t) => {
                const execContext = _test_makeExecuteContextForMessage();
                if (style === "line") {
                  assertEquals(
                    await row.cmd.asLineExecuted(execContext),
                    row.expectedReconstructed.forLine,
                  );
                } else {
                  if (style !== "embedded") throw new Error("never");
                  assertEquals(
                    await row.cmd.asGroupExecuted(execContext),
                    row.expectedReconstructed.forEmbedded,
                  );
                }
              });
              await t.step("执行后还原为 RegularMessagePiece[]", async (t) => {
                const execContext = _test_makeExecuteContextForMessage();
                // XXX: 这里的 `executed` 其实是在上个测试用例执行的，
                //      也许应该让每次执行生成不同的 `executed`，而不是用 cache。
                //      比如 `unexecuted.clone().execute()`。
                const executed = await _test_executeCommand(
                  execContext,
                  row.cmd,
                )!;
                if (style === "line") {
                  assertEquals(
                    await executed!.asRaw(),
                    row.expectedRaw.forLine,
                  );
                } else {
                  if (style !== "embedded") throw new Error("never");
                  assertEquals(
                    await executed!.asRaw(),
                    row.expectedRaw.forEmbedded,
                  );
                }
              });
            });
          }
        });
      });

      if (style === "line") {
        await t.step("获取其他行的内容", async (t) => {
          throw new Error("unimplemented");
        });
      }

      await t.step("获取引用回复的内容", async (t) => {
        throw new Error("unimplemented");
      });
    });
  }

  // 为允许插件直接调用命令获得结果开路（视作非等待型嵌入命令）
  await t.step("悬空执行", async (t) => {
    throw new Error("unimplemented");
  });

  await t.step("preview", async (t) => {
    const candidates = _test_makeFakeCommands(["foo"]);

    type Row = {
      description: string;
      cmd: UnexecutedCommandPiece;
      preview: RegularMessagePiece[];
    };

    const table: Row[] = [
      {
        description: "/foo",
        cmd: _test_makeUnexecuted("line", { candidates, gapAfterHead: "" }),
        preview: [text("/foo")],
      },
      {
        description: "/foo 344556677889900",
        cmd: _test_makeUnexecuted("line", {
          candidates,
          gapAfterHead: " ",
          cmdRawArgs: [{ content: text("344556677889900"), gapAtRight: "" }],
        }),
        preview: [text("/foo 344556677889900")],
      },
      {
        description: "/foo 3四五六七八九零",
        cmd: _test_makeUnexecuted("line", {
          candidates,
          gapAfterHead: " ",
          cmdRawArgs: [{ content: text("3四五六七八九零"), gapAtRight: "" }],
        }),
        preview: [text("/foo 3四五六七八九零")],
      },
      {
        description: "/foo 3四五六七八九0叉",
        cmd: _test_makeUnexecuted("line", {
          candidates,
          gapAfterHead: " ",
          cmdRawArgs: [{ content: text("3四五六七八九0叉"), gapAtRight: "" }],
        }),
        preview: [text("/foo 3四五六七八九0…")],
      },
      {
        description: "/foo 344556677889900x",
        cmd: _test_makeUnexecuted("line", {
          candidates,
          gapAfterHead: " ",
          cmdRawArgs: [{ content: text("344556677889900x"), gapAtRight: "" }],
        }),
        preview: [text("/foo 344556677889900…")],
      },
      {
        description: "/foo 344556677889900xx",
        cmd: _test_makeUnexecuted("line", {
          candidates,
          gapAfterHead: " ",
          cmdRawArgs: [{ content: text("344556677889900xx"), gapAtRight: "" }],
        }),
        preview: [text("/foo 344556677889900…")],
      },
      {
        description: "/foo 344556677[at]",
        cmd: _test_makeUnexecuted("line", {
          candidates,
          gapAfterHead: " ",
          cmdRawArgs: [{
            content: new CompactComplexPiece([text("344556677"), at(42)]),
            gapAtRight: "",
          }],
        }),
        preview: [text("/foo 344556677[at]")],
      },
      {
        description: "/foo 34455667788990[at]",
        cmd: _test_makeUnexecuted("line", {
          candidates,
          gapAfterHead: " ",
          cmdRawArgs: [{
            content: new CompactComplexPiece([text("34455667788990"), at(42)]),
            gapAtRight: "",
          }],
        }),
        preview: [text("/foo 34455667788990…")],
      },
      {
        description: "/foo 34455667788[face]",
        cmd: _test_makeUnexecuted("line", {
          candidates,
          gapAfterHead: " ",
          cmdRawArgs: [{
            content: new CompactComplexPiece([
              text("34455667788"),
              emoticon("foo"),
            ]),
            gapAtRight: "",
          }],
        }),
        preview: [text("/foo 34455667788"), emoticon("foo")],
      },
      {
        description: "/foo 34455667788990[face]",
        cmd: _test_makeUnexecuted("line", {
          candidates,
          gapAfterHead: " ",
          cmdRawArgs: [{
            content: new CompactComplexPiece([
              text("34455667788990"),
              emoticon("foo"),
            ]),
            gapAtRight: "",
          }],
        }),
        preview: [text("/foo 34455667788990…")],
      },
      {
        description: "/foo 3[face]6677889900",
        cmd: _test_makeUnexecuted("line", {
          candidates,
          gapAfterHead: " ",
          cmdRawArgs: [{
            content: new CompactComplexPiece([
              text("3"),
              emoticon("foo"),
              text("66778899"),
            ]),
            gapAtRight: "",
          }],
        }),
        preview: [text("/foo 3"), emoticon("foo"), text("66778899")],
      },
      {
        description: "/foo [image]",
        cmd: _test_makeUnexecuted("line", {
          candidates,
          gapAfterHead: " ",
          cmdRawArgs: [{
            content: imageFromBase64("dGVzdA=="),
            gapAtRight: "",
          }],
        }),
        preview: [text("/foo …")],
      },
      {
        description: "{/foo 3[face]66[at]}",
        cmd: _test_makeUnexecuted("embedded", {
          candidates,
          blankAtLeftSide: "",
          gapAfterHead: " ",
          cmdRawArgs: [{
            content: new CompactComplexPiece([
              text("3"),
              emoticon("foo"),
              text("66"),
              at(42),
            ]),
            gapAtRight: "",
          }],
        }),
        preview: [
          text("… {/foo 3"),
          emoticon("foo"),
          text("66[at]} …"),
        ],
      },
      {
        description: "{ /foo 3[face][at] }",
        cmd: _test_makeUnexecuted("embedded", {
          candidates,
          blankAtLeftSide: " ",
          gapAfterHead: " ",
          cmdRawArgs: [{
            content: new CompactComplexPiece([
              text("3"),
              emoticon("foo"),
              at(42),
            ]),
            gapAtRight: " ",
          }],
        }),
        preview: [
          text("… { /foo 3"),
          emoticon("foo"),
          text("[at] } …"),
        ],
      },
      {
        description: "{ /foo 3[face]6677[at] }",
        cmd: _test_makeUnexecuted("embedded", {
          candidates,
          blankAtLeftSide: " ",
          gapAfterHead: " ",
          cmdRawArgs: [{
            content: new CompactComplexPiece([
              text("3"),
              emoticon("foo"),
              text("6677"),
              at(42),
            ]),
            gapAtRight: " ",
          }],
        }),
        preview: [
          text("… { /foo 3"),
          emoticon("foo"),
          text("6677[at] } …"),
        ],
      },
      {
        description: "{ /foo 3[face]66778[at] }",
        cmd: _test_makeUnexecuted("embedded", {
          candidates,
          blankAtLeftSide: " ",
          gapAfterHead: " ",
          cmdRawArgs: [{
            content: new CompactComplexPiece([
              text("3"),
              emoticon("foo"),
              text("66778"),
              at(42),
            ]),
            gapAtRight: " ",
          }],
        }),
        preview: [
          text("… { /foo 3"),
          emoticon("foo"),
          text("66778… } …"),
        ],
      },
      {
        description: "{ /foo三四五六七八九零x }",
        cmd: _test_makeUnexecuted("embedded", {
          candidates: _test_makeFakeCommands(["foo三四五六七八九零x"]),
          blankAtLeftSide: " ",
          gapAfterHead: " ",
          cmdRawArgs: [],
        }),
        preview: [
          text("… { /foo三四五六七八九零… } …"),
        ],
      },
      {
        description: "{ \t /foo \n   bar \n}",
        cmd: _test_makeUnexecuted("embedded", {
          candidates,
          blankAtLeftSide: " \t ",
          gapAfterHead: " \n   ",
          cmdRawArgs: [{
            content: text("bar"),
            gapAtRight: " \t",
          }],
        }),
        preview: [
          text("… { /foo bar } …"),
        ],
      },
    ];

    for (const [i, { description, cmd, preview }] of table.entries()) {
      await t.step(`case ${i + 1}: ${description}`, async (t) => {
        const execContext = _test_makeExecuteContextForMessage();
        const executed = await _test_executeCommand(execContext, cmd)!;
        assertEquals(await executed!.generatePreview(), preview);
      });
    }
  });

  // TODO: 放这里合适吗？
  await t.step("嵌入填充", async (t) => {
  });
});

function assertExecuted(
  actualExecuted: ExecutedCommandPiece,
  originalUnexecuted: UnexecutedCommandPiece,
  expected: {
    arguments?: CommandArgument[] | "skip";

    hasFailed?: boolean;
    result?: CommandExecutedResult | null;
    notes?: CommandNote[];
  },
) {
  assertEquals(actualExecuted.isEmbedded, originalUnexecuted.isEmbedded);
  assertEquals(actualExecuted.shouldAwait, originalUnexecuted.isAwait);

  if (expected.arguments !== "skip") {
    assertEquals(actualExecuted.arguments, expected.arguments ?? []);
  }

  assertEquals(actualExecuted.hasFailed, expected.hasFailed ?? false);
  assertEquals(actualExecuted.result, expected.result ?? null);
  assertEquals(actualExecuted.notes, expected.notes ?? []);
}

// TODO: candidates 是不是应该作为第二个参数？
//（UnexecutedCommandPiece 的构造器同理，与上述对应的值是不是应该作为第一个参数？）
// 这样 UnexecutedCommandPiece 能与 ExecutedCommandPiece 保持一致
function _test_makeUnexecuted(
  style: "embedded" | "line",
  args: {
    blankAtLeftSide?: string;
    gapAfterHead?: string;
    cmdRawArgs?: ComplexPiecePart<false>[];
    candidates: CommandEntity[];
  },
) {
  args = { ...args };
  if (!args.cmdRawArgs) {
    args.cmdRawArgs = [];
  }
  if (
    args.gapAfterHead === undefined &&
    (args.cmdRawArgs.length > 0 && args.candidates.length > 1)
  ) {
    // 只有在没有参数，或者只有一个候选命令的情况下允许省略 gapAfterHead，
    // 因为这时此值不会产生影响
    throw new Error("never");
  }

  if (style === "embedded") {
    return new UnexecutedCommandPiece({
      type: "embedded",

      possibleCommands: args.candidates,
      isAwait: false,
      prefix: "/",

      blankAtLeftSide: args.blankAtLeftSide ?? " ",
      gapAfterHead: args.gapAfterHead ?? " ",

      rawArguments: args.cmdRawArgs,
    });
  } else {
    if (style !== "line") throw new Error("never");
    return new UnexecutedCommandPiece({
      type: "line",

      possibleCommands: args.candidates,
      isAwait: false,
      prefix: "/",

      gapAfterHead: args.gapAfterHead ?? " ",

      rawArguments: args.cmdRawArgs,
    });
  }
}

async function _test_executeCommand(
  execContext: ExecuteContextForMessage,
  cmd: UnexecutedCommandPiece,
) {
  if (cmd.isEmbedded) {
    return await cmd.execute(execContext);
  } else {
    return await cmd.execute(execContext, { lineNumber: -1 });
  }
}

function _test_makeExecuted(
  style: "embedded" | "line",
  cmd: CommandEntity,
  args: {
    blankAtLeftSide?: string;
    gapAfterHead?: string;
    cmdArgs?: CommandArgument[];
    result?: CommandExecutedResult | null;
  } = {},
) {
  if (style !== "embedded" && style !== "line") throw new Error("never");
  args = { ...args };
  if (!args.cmdArgs) {
    args.cmdArgs = [];
  }
  if (!args.result) {
    args.result = null;
  }

  return new ExecutedCommandPiece(cmd, {
    context: null as unknown as any,
    isEmbedded: style === "embedded",
    blankAtLeftSide: style === "embedded"
      ? (args.blankAtLeftSide ?? " ")
      : undefined,
    prefix: "/",
    shouldAwait: false,

    arguments: args.cmdArgs,
    gapAfterHead: args.gapAfterHead ?? " ",

    hasFailed: false,
    result: args.result,
    notes: [],
  });
}

function _test_makeExecuteContextForMessage() {
  return new ExecuteContextForMessage();
}

function _test_makeExpectedResult(
  style: "line" | "embedded",
  value: RegularMessagePiece[],
  embeddingRaw?: EmbeddingRaw,
): CommandExecutedResult {
  if (style === "line") {
    return { response: value };
  }
  if (style !== "embedded") throw new Error("never");
  return {
    embedding: value,
    ...(embeddingRaw ? { embeddingRaw } : {}),
  };
}

const test_cmd_sum: CommandCallback = (ctx, args) => {
  let result = 0;
  for (const arg of args) {
    if (!arg.number) {
      return { error: "不支持非数字参数！" };
    }
    result += arg.number;
  }
  if (ctx.isEmbedded) {
    return {
      embedding: String(result),
      embeddingRaw: { value: result },
    };
  } else {
    return { response: `相加结果为：${result}` };
  }
};
