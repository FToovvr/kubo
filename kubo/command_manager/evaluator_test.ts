import { CommandResponses, evaluateMessage } from "./evaluator.ts";

import {
  assert,
  assertEquals,
  equal,
} from "https://deno.land/std@0.134.0/testing/asserts.ts";

import { text } from "../../go_cqhttp_client/message_piece.ts";
import { CommandCallback, CommandStyle } from "./models/command_entity.ts";
import { CommandNote } from "./models/command_piece_executed.ts";
import { _test_makeContext } from "./test_utils.ts";
import { TokenizingContext } from "./tokenizer.ts";
import { MessagePieceIncludingExecutedCommand } from "./types.ts";

const testPrefix = `kubo/command_manager/evaluator`;

const mockBot = { self: { qq: 42 } };

Deno.test(`${testPrefix} 简单命令执行`, async (t) => {
  const forNonEmbedded = {
    possibleReturnValues: [
      "foo",
      { response: "foo" },
      [text("foo")],
      { response: [text("foo")] },
    ],
  };

  const forEmbedded = {
    possibleReturnValues: [
      "foo",
      { embedding: "foo" },
      [text("foo")],
      { embedding: [text("foo")] },
    ],
  };

  const table: {
    type: "nothing" | "embedded" | "line";
    message: string;
    responses?: string[][];
    embeddingResult?: string;
  }[] = [
    { type: "nothing", message: "no commands" },
    { type: "nothing", message: "/null" },
    { type: "line", message: "/foo", responses: [["foo"]] },
    { type: "line", message: "/null\n/foo", responses: [["foo"]] },
    { type: "line", message: "/foo\nfoo\n/foo", responses: [["foo"], ["foo"]] },
    { type: "embedded", message: "… {/foo} …", embeddingResult: "… « foo » …" },
    { type: "embedded", message: "…{/foo}…", embeddingResult: "… « foo » …" },
  ];

  for (const { type, message, embeddingResult, responses } of table) {
    const returnValues = [
      ...(() => {
        if (type === "nothing") return ["never"];
        if (type === "line") return forNonEmbedded.possibleReturnValues;
        if (type === "embedded") return forEmbedded.possibleReturnValues;
        throw new Error("never");
      })(),
      undefined,
    ];

    for (const returnValue of returnValues) {
      await t.step(Deno.inspect({ message, returnValue }), () => {
        const context = _test_makeContext(["foo"], "/", () => returnValue);
        const evaluated = evaluateMessage(
          { bot: mockBot, ...context },
          [text(message)],
        );

        if (type === "nothing" || returnValue === undefined) {
          assertEquals(evaluated, {
            processResult: "skip",
            embeddingResult: null,
            responses: [],
          });
        } else if (type === "line") {
          assertEquals(evaluated.processResult, "pass");
          assertEquals(evaluated.embeddingResult, null);
          assertEquals(evaluated.responses.length, responses!.length);
          assertEquals(
            evaluated.responses.map((x) => x.contents),
            responses!.map((x) => x.map((x) => [text(x)])),
          );
        } else if (type === "embedded") {
          assertEquals(evaluated.processResult, "pass");
          assertEquals(evaluated.embeddingResult, [text(embeddingResult!)]);
          assertEquals(evaluated.responses, []);
        }
      });
    }
  }
});

Deno.test(`${testPrefix} 声明命令执行`, () => {
  const context = _test_makeContext(["no-responses"], "/", (_, ctx) => {
    ctx.claimExecuted();
    return;
  });
  const evaluated = evaluateMessage(
    { bot: mockBot, ...context },
    [text("/no-responses")],
  );
  assertEquals(evaluated, {
    processResult: "pass",
    embeddingResult: null,
    responses: [],
  });
});

Deno.test(`${testPrefix} 命令参数`, async (t) => {
  const table: {
    message: string;
    response?: string;
    embeddingResult?: string;
  }[] = [
    { message: "/echo hello world", response: "echo: hello world" },
    {
      message: "/echo hello\tworld",
      // FIXME!: 实际上应该是 "echo: hello\tworld"，但目前实现不了…
      response: "echo: hello world",
    },
    {
      message: "… { /echo hello world } …",
      embeddingResult: "… « echo: hello world » …",
    },
    {
      message: "… { /echo hello\nworld } …",
      // FIXME!: 实际上应该是 "echo: hello\nworld"，但目前实现不了…
      embeddingResult: "… « echo: hello world » …",
    },
  ];

  const context = _test_makeContext(
    ["echo"],
    "/",
    (_cmd, ctx, opts, args) => _test_cmd_echo(ctx, opts, args),
  );

  for (const { message, response, embeddingResult } of table) {
    await t.step(Deno.inspect(message), () => {
      testEvaluation(context, message, { response, embeddingResult });
    });
  }
});

Deno.test(`${testPrefix} 命令嵌套`, async (t) => {
  const table: {
    message: string;
    response?: string;
    embeddingResult?: string;
  }[] = [
    { message: "/echo hello world", response: "echo: hello world" },
    // TODO!: 引入 { … } 后要合在一起
    { message: "/echo { /null }", response: "echo: { /null }" },
    {
      message: "/echo { /square 2 }",
      response: "echo: [cmd] 4",
      embeddingResult: "/\u033Decho « 4 »",
    },
    { message: "/echo { /square foo }", response: "echo: { /square foo }" },
    {
      message: "/null { /square 2 }",
      embeddingResult: "/null « 4 »",
    },
    {
      message: "/square { /square { /square 2 } }",
      embeddingResult: "/\u033Dsquare « 16 »",
      response: "square of 16 is 256",
    },
  ];

  const context = _test_makeContext(
    ["square", "echo"],
    "/",
    (cmd, ctx, opts, args) => {
      if (!args) throw new Error("never");
      switch (cmd) {
        case "echo": {
          return _test_cmd_echo(ctx, opts, args);
          break;
        }
        case "square": {
          if (args.length !== 1) throw new Error("never");
          if (args[0].length !== 1) throw new Error("never");
          const arg: MessagePieceIncludingExecutedCommand = args[0][0];
          let num: number;
          switch (arg.type) {
            case "text": {
              num = Number(arg.data.text);
              break;
            }
            case "__kubo_executed_command": {
              if (typeof arg.result.embeddingRaw !== "number") {
                throw new Error("never");
              }
              num = arg.result.embeddingRaw;
              break;
            }
            default:
              throw new Error("never");
              break;
          }
          if (Number.isNaN(num)) return; // skip
          const result = num * num;
          return {
            embedding: `${result}`,
            embeddingRaw: result,
            response: `square of ${num} is ${result}`,
          };
          break;
        }
        default:
          throw new Error("never");
          break;
      }
    },
  );

  for (const { message, response, embeddingResult } of table) {
    await t.step(Deno.inspect(message), () => {
      testEvaluation(context, message, { response, embeddingResult });
    });
  }
});

Deno.test(`${testPrefix} 命令执行顺序`, () => {
  let counter = 0;

  const context = _test_makeContext(
    ["foo"],
    "/",
    (_cmd, _ctx, _opts, args) => {
      if (!args) throw new Error("never");
      let counted = false;
      for (const arg of args) {
        if (arg.length !== 1) throw new Error("never");
        if (arg[0].type === "text") {
          if (counted) throw new Error("never");
          counter++;
          const assertedCount = Number(arg[0].data.text);
          assertEquals(counter, assertedCount);
          counted = true;
        } else if (arg[0].type === "__kubo_executed_command") continue;
        else throw new Error("never");
      }
      if (!counted) throw new Error("never");
      return `${counted}`;
    },
  );

  const evaluated = evaluateMessage(
    { bot: mockBot, ...context },
    [text([
      "/foo 4 { /foo 3 }",
      "{ /foo 1 }",
      "/foo 9 { /foo 8 { /foo 5 } { /foo 7 { /foo 6 } } }",
      "{ /foo 2 }",
    ].join("\n"))],
  );

  assertEquals(evaluated.processResult, "pass");
});

Deno.test(`${testPrefix} 命令以未声明支持的书写形式呈现`, () => {
  const styles: CommandStyle[] = ["line", "embedded", "integrated"];
  const table: { message: string; style: CommandStyle }[] = [
    { message: "/foo", style: "line" },
    { message: "{ /foo }", style: "embedded" },
    { message: "foo", style: "integrated" },
  ];

  for (const supportedStyle of styles) {
    const context = _test_makeContext(["foo"], "/", () => "foo", {
      supportedStyles: supportedStyle,
    });

    for (const { message, style: usedStyle } of table) {
      const executed = evaluateMessage(
        { bot: mockBot, ...context },
        [text(message)],
      );
      if (usedStyle === supportedStyle) {
        assertEquals(executed.processResult, "pass");
      } else {
        assertEquals(executed.processResult, "skip");
      }
    }
  }
});

Deno.test(`${testPrefix} 遭遇错误`, async (t) => {
  const table = [
    { message: "/error" },
    { message: "{ /error }", embeddingResult: "« /error⇒error »" },
    {
      message: "/echo { /error }",
      embeddingResult: "/̽echo « /error⇒error »",
      response: "echo: [failed-cmd]",
      // hasPassed: true,
    },
  ];

  for (const level of ["user", "system"] as const) {
    const context = _test_makeContext(
      ["error", "echo"],
      "/",
      (cmd, ctx, opts, args) => {
        if (cmd === "echo") return _test_cmd_echo(ctx, opts, args);

        if (cmd !== "error") throw new Error("never");
        if (level === "user") return { error: "something wrong" };
        if (level === "system") throw new Error("something wrong");
        throw new Error("never");
      },
    );

    for (
      const { message, embeddingResult, response /*, hasPassed*/ } of table
    ) {
      await t.step(Deno.inspect({ level, message }), () => {
        const evaluated = testEvaluation(
          context,
          message,
          {
            response,
            embeddingResult,
            // 即使没有成功的命令，命令系统也做了处理，因此算做 pass
            // hasPassed ?? false,
            noteCount: 1,
          },
        );

        assertErrors(evaluated.responses, [{
          level: `${level}-error`,
          content: level === "user" ? "something wrong" : "执行命令途中遭遇异常，请参考日志！",
        }], "error");
      });
    }
  }
});

Deno.test(`${testPrefix} 次选命令`, async (t) => {
  const table: {
    args: [
      "foo-skip" | "foo-pass" | "foo-error",
      "foobar-skip" | "foobar-pass" | "foobar-error",
    ];
    hasSkipped?: boolean;
    response?: "foo-pass" | "foobar-pass";
    erroredCommand?: "foo" | "foobar";
  }[] = [
    { args: ["foo-skip", "foobar-skip"], hasSkipped: true },
    { args: ["foo-skip", "foobar-pass"], response: "foobar-pass" },
    { args: ["foo-skip", "foobar-error"], erroredCommand: "foobar" },
    { args: ["foo-pass", "foobar-skip"], response: "foo-pass" },
    { args: ["foo-pass", "foobar-pass"], response: "foobar-pass" },
    {
      args: ["foo-pass", "foobar-error"],
      response: "foo-pass",
      erroredCommand: "foobar",
    },
    { args: ["foo-error", "foobar-skip"], erroredCommand: "foo" },
    { args: ["foo-error", "foobar-pass"], response: "foobar-pass" },
    { args: ["foo-error", "foobar-error"], erroredCommand: "foobar" },
  ];

  const context = _test_makeContext(
    ["foo", "foobar"],
    "/",
    (cmd, ctx, opts, args) => {
      if (!args) throw new Error("never");
      for (const [i, arg] of args.entries()) {
        if (arg.length !== 1 || arg[0].type !== "text") {
          throw new Error("never");
        }
        const text = arg[0].data.text;

        if (cmd === "foo") {
          if (i === 0) {
            assertEquals(text, "bar");
          }
          if (text === "foo-skip") return;
          if (text === "foo-pass") return "foo-pass";
          if (text === "foo-error") return { error: "foo-error" };
        } else {
          if (cmd !== "foobar") throw new Error("never");
          if (text === "foobar-skip") return;
          if (text === "foobar-pass") return "foobar-pass";
          if (text === "foobar-error") return { error: "foobar-error" };
        }
      }
      throw new Error("never");
    },
    {
      argumentsBeginningPolicy: "unrestricted",
    },
  );

  for (const { args, hasSkipped, response, erroredCommand } of table) {
    await t.step(Deno.inspect(args), () => {
      const message = `/foobar ${args[0]} ${args[1]}`;
      const evaluated = testEvaluation(context, message, {
        response,
        hasPassed: !(hasSkipped ?? false),
        noteCount: erroredCommand ? 1 : 0,
      });
      if (erroredCommand) {
        assertErrors(evaluated.responses, [{
          level: "user-error",
          content: erroredCommand + "-error",
        }], erroredCommand);
      }
    });
  }
});

Deno.test(`${testPrefix} 嵌入命令未提供嵌入内容`, () => {
  const context = _test_makeContext(
    ["nothing"],
    "/",
    (cmd, ctx, opts, args) => {
      ctx.claimExecuted();
    },
  );

  const evaluated = testEvaluation(context, "{/nothing}", {
    embeddingResult: "« /nothing⇒error »",
    noteCount: 1,
  });
  assertErrors(
    evaluated.responses,
    [{ level: "system-error", content: "嵌入命令未提供嵌入内容" }],
    "nothing",
  );
});

const _test_cmd_echo: CommandCallback = (ctx, _, args) => {
  if (!args) throw new Error("never");
  if (
    args.length === 1 && args[0].length === 1 &&
    args[0][0].type === "__kubo_executed_command"
  ) {
    if (args[0][0].hasFailed) return [text("echo: [failed-cmd]")];
    return [text("echo: [cmd] "), ...args[0][0].result.embedding!];
  }
  // FIXME: 相关代码改好后用 rawArguments
  const arg = args.map((x) => {
    if (x.length !== 1) throw new Error("never");
    if (x[0].type !== "text") throw new Error("never");
    return x[0].data.text;
  });
  return `echo: ${arg.join(" ")}`;
};

function testEvaluation(
  context: TokenizingContext,
  message: string,
  args: {
    response?: string | undefined;
    embeddingResult?: string | undefined;
    hasPassed?: boolean;
    noteCount?: number;
  },
) {
  args = {
    hasPassed: true,
    noteCount: 0,
    ...args,
  };

  const evaluated = evaluateMessage(
    { bot: mockBot, ...context },
    [text(message)],
  );
  assertEquals(evaluated.processResult, args.hasPassed ? "pass" : "skip");
  if (args.response) {
    assertEquals(evaluated.responses.length, 1 + args.noteCount!);

    let targetResponseIndex: number | null = null;
    for (const [i, response] of evaluated.responses.entries()) {
      if (response.contents.length > 0) {
        if (targetResponseIndex !== null) throw new Error("never");
        targetResponseIndex = i;
      }
    }
    if (targetResponseIndex === null) throw new Error("never");

    assertEquals(evaluated.responses[targetResponseIndex].contents.length, 1);
    const content = evaluated.responses[targetResponseIndex].contents[0];
    assertEquals(content.length, 1);
    if (content[0].type === "text") {
      assertEquals(content[0].data.text, args.response);
    } else assert(false);
  } else {
    assertEquals(evaluated.responses.length, 0 + args.noteCount!);
  }
  if (args.embeddingResult) {
    assertEquals(evaluated.embeddingResult, [text(args.embeddingResult)]);
  } else {
    assertEquals(evaluated.embeddingResult, null);
  }
  return evaluated;
}

function assertErrors(
  actualResponses: CommandResponses[],
  expectedErrors: CommandNote[],
  expectedErroredCommand: string,
) {
  expectedErrors = [...expectedErrors];
  for (const { command, hasFailed, notes } of actualResponses) {
    if (command.command.command === expectedErroredCommand) {
      assert(hasFailed);
      for (const [i, error] of expectedErrors.entries()) {
        if (equal(notes, [error])) {
          expectedErrors.splice(i, 1);
          break;
        }
        if (i === expectedErrors.length - 1) {
          assert(false);
        }
      }
    } else {
      assert(!hasFailed);
      assertEquals(notes, []);
    }
  }
  assertEquals(expectedErrors.length, 0);
}
