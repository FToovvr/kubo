import { _MockKuboBot, CommandManager } from "./manager.ts";

import {
  assertThrows,
  equal,
} from "https://deno.land/std@0.134.0/testing/asserts.ts";
import {
  assertSpyCall,
  assertSpyCalls,
  spy,
} from "https://deno.land/x/mock@0.15.0/mod.ts";

import { DB } from "https://deno.land/x/sqlite@v3.3.0/mod.ts";
import { MessageEvent } from "../../go_cqhttp_client/events.ts";
import { SettingsManager } from "../settings_manager.ts";
import { Store, StoreWrapper } from "../storage.ts";
import { _test_makeFakeCommand } from "./test_utils.ts";
import {
  _test_makeMessageOfGroupEvent,
  _test_makeMessageOfPrivateEvent,
} from "../../go_cqhttp_client/test_utils.ts";
import { replyAt, text } from "../../go_cqhttp_client/message_piece.ts";

async function withCommandManager(
  selfQQ: number,
  callback: (
    cm: CommandManager,
    mockMessage: (ev: MessageEvent) => void,
    spies: {
      sendGroupMessage: _MockKuboBot["sendGroupMessage"];
      sendPrivateMessage: _MockKuboBot["sendPrivateMessage"];
    },
  ) => void | Promise<void>,
) {
  const db = new DB();
  const store = new Store(db);
  const wrapper = new StoreWrapper(store, "settings");
  const settingsManager = new SettingsManager(wrapper);

  let onMessageCallback!: InstanceType<typeof CommandManager>["processMessage"];
  const bot: _MockKuboBot = {
    settingsManager,
    onMessage: (on, msgMatcher, _onMessageCallback) => {
      if (on !== "all") throw new Error("never");
      if (!equal(msgMatcher, { all: true })) throw new Error("never");
      onMessageCallback = _onMessageCallback;
    },
    self: { qq: selfQQ },
    sendGroupMessage: spy(async () => null) as unknown as any,
    sendPrivateMessage: spy(async () => null) as unknown as any,
  };

  const cm = new CommandManager(bot);

  const mockMessage = (ev: MessageEvent) => {
    onMessageCallback(bot, ev.message, ev);
  };

  await callback(cm, mockMessage, {
    sendGroupMessage: bot.sendGroupMessage,
    sendPrivateMessage: bot.sendPrivateMessage,
  });

  store.close();
  db.close();
}

const testPrefix = "kubo/command_manager/manager";

const selfQQ = 0.5e10 + Math.floor(Math.random() * 1e10);
const senderQQ = 1.5e10 + Math.floor(Math.random() * 1e10);
const groupId = 2.5e10 + Math.floor(Math.random() * 1e10);

Deno.test(`${testPrefix} 注册命令`, async (t) => {
  await withCommandManager(selfQQ, async (cm, mockMessage, spies) => {
    await t.step("命令词中不能包含非法字符", async (t) => {
      for (const cmd of ["fo o", "fo{o", "fo}o", "fo\\o"]) {
        await t.step(cmd, () => {
          assertThrows(() => {
            cm.registerCommand(cmd, _test_makeFakeCommand(cmd));
          });
        });
      }
    });

    await t.step("命令不能重复", () => {
      cm.registerCommand("foo", _test_makeFakeCommand("foo"));
      assertThrows(() => {
        cm.registerCommand("foo", _test_makeFakeCommand("foo"));
      });
    });

    await t.step("正常注册命令", () => {
      cm.registerCommand("foobar", _test_makeFakeCommand("foobar"));
      cm.registerCommand("f", _test_makeFakeCommand("f"));
      cm.registerCommand("bar", _test_makeFakeCommand("bar"));
    });
  });
});

Deno.test(`${testPrefix} 回复`, async (t) => {
  const possibleScenes = ["私聊好友", "私聊临时", "群聊", "群聊匿名", "讨论组"] as const;
  throw new Error("TODO");

  const table: {
    message: string;
    embeddedResult?: string;
    restResponse?: string;
  }[] = [
    { message: "nothing" },
    {
      message: "/echo hello",
      restResponse: [
        "➩ hello",
      ].join("\n"),
    },
    {
      message: "/echo hello\n/echo world",
      restResponse: [
        "⊛ /echo hello ➩",
        "hello",
        "⊛ /echo world ➩",
        "world",
      ].join("\n"),
    },
    {
      message: "blah {/echo hello} blah",
      embeddedResult: [
        "blah « hello » blah",
      ].join("\n"),
    },
    {
      message: "/echo hello {/echo world}",
      embeddedResult: [
        "/̽echo hello « world »",
      ].join("\n"),
      restResponse: [
        "➩ hello [cmd:echo,content=world]",
      ].join("\n"),
    },
    {
      message: "/error",
      restResponse: [
        "➩ ⚠ 命令错误 : error",
      ].join("\n"),
    },
    {
      message: "/echo hello\n/error",
      restResponse: [
        "⊛ /echo hello ➩",
        "hello",
        "⊛ /error ➩",
        "⚠ 命令错误 : error",
      ].join("\n"),
    },
    {
      message: "/echo {/error}",
      embeddedResult: [
        "/̽echo « /error⇒error »",
      ].join("\n"),
      restResponse: [
        "⊛ … { /error } … ➩",
        "⚠ 命令错误 : error",
        "⊛ /echo « /error⇒erro… ➩",
        "[failed-cmd]",
      ].join("\n"),
    },
  ];

  for (const scene of possibleScenes) {
    for (
      const { message: rawMessage, embeddedResult, restResponse } of table
    ) {
      const message = `previous line\n${rawMessage}\nnext line`;
      if (scene === "群聊匿名" || scene === "私聊临时" || scene === "讨论组") {
        // TODO: implement
        continue;
      }

      await t.step(`${scene} ${Deno.inspect(rawMessage)}`, async () => {
        const formalMsg = [text(message)];
        const ev = (() => {
          if (scene === "私聊好友") {
            return _test_makeMessageOfPrivateEvent(
              { qq: senderQQ },
              formalMsg,
            );
          } else if (scene === "群聊") {
            return _test_makeMessageOfGroupEvent(
              { qq: senderQQ },
              groupId,
              formalMsg,
            );
          } else throw new Error("never");
        })();

        await withCommandManager(selfQQ, async (cm, mockMessage, spies) => {
          _test_registerCmdEchoAndError(cm);

          mockMessage(ev);

          if (!embeddedResult && !restResponse) {
            assertSpyCalls(spies.sendPrivateMessage, 0);
            assertSpyCalls(spies.sendGroupMessage, 0);
            return;
          }

          let expectedResponse = "";
          if (embeddedResult) {
            expectedResponse +=
              `嵌入结果：\nprevious line\n${embeddedResult}\nnext line`;
          }
          if (embeddedResult && restResponse) {
            expectedResponse += "\n================\n";
          }
          if (restResponse) {
            expectedResponse += restResponse;
          }

          if (scene === "私聊好友") {
            assertSpyCall(
              spies.sendPrivateMessage,
              0,
              {
                args: [senderQQ, [text(expectedResponse)]],
              },
            );
            assertSpyCalls(spies.sendPrivateMessage, 1);
            assertSpyCalls(spies.sendGroupMessage, 0);
          } else if (scene === "群聊") {
            const expectedReplyAt = replyAt(ev.messageId, senderQQ);
            assertSpyCall(
              spies.sendGroupMessage,
              0,
              {
                args: [groupId, [...expectedReplyAt, text(expectedResponse)]],
              },
            );
            assertSpyCalls(spies.sendPrivateMessage, 0);
            assertSpyCalls(spies.sendGroupMessage, 1);
          } else throw new Error("never");
        });
      });
    }
  }
});

function _test_registerCmdEchoAndError(cm: CommandManager) {
  cm.registerCommand("echo", {
    readableName: "回响",
    description: "将输入的参数输出",
    callback: (ctx, args) => {
      let _ret = args?.map((arg) => {
        const sole = arg.sole;
        if (!sole) return [text("[complex]")];

        if (sole.type === "__kubo_executed_command") {
          if (sole.hasFailed) return [text("[failed-cmd]")];
          if (sole.result?.embedding?.length ?? 0 > 0) {
            return [
              text(`[cmd:${sole.command.command},content=`),
              ...sole.result!.embedding!,
              text(`]`),
            ];
          } else {
            return [text(`[cmd:${sole.command.command}]`)];
          }
        }
        if (sole.type === "text") return [sole];
        return [text("[other]")];
      });
      const ret = _ret?.flatMap((arg, i) =>
        i < _ret!.length - 1 ? [...arg, text(" ")] : [...arg]
      );
      if (ret) {
        return {
          response: ret,
          embedding: ret,
        };
      }
    },
  });
  cm.registerCommand("error", {
    readableName: "错误",
    description: "返回错误",
    callback: (ctx, args) => ({ error: "error" }),
  });
}
