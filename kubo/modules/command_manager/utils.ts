import {
  At,
  getTypedMessagePiece,
  MessagePiece,
  RegularMessagePiece,
  Reply,
  Text,
  text,
} from "../../../go_cqhttp_client/message_piece.ts";
import {
  extractReferenceFromMessage,
  mergeAdjoiningTextPiecesInPlace,
} from "../../../utils/message_utils.ts";
import { CommandResponses } from "./evaluator.ts";

type SeparateHeadFromMessageReturning<T extends MessagePiece> = {
  // 清理掉位于开头的引用回复以及位于开头的 at 后的消息
  cleanedMessage: T[];
  // 引用回复
  replyAt?: [Reply, At];
  // 位于开头的直接 at，多用于明确指定响应命令的 bot
  leadingAt?: At;
};

/**
 * 将开头的信息与消息的剩余内容相分离
 */
export function separateHeadFromMessage<T extends MessagePiece>(
  msg: T[],
): SeparateHeadFromMessageReturning<T> {
  const { replyAt, rest } = extractReferenceFromMessage(msg);
  if (rest[0]) {
    const first = getTypedMessagePiece(rest[0]);
    // 清除掉空白文本
    if (first.text && first.text.data.text.trim().length === 0) {
      rest.splice(0, 1);
    }
  }
  let leadingAt: At | null = null;
  if (rest[0]) {
    const first = getTypedMessagePiece(rest[0]);
    // 清除掉多余的 at
    if (first.at) {
      leadingAt = first.at;
      rest.splice(0, 1);
    }
  }

  return {
    cleanedMessage: rest,
    ...(replyAt ? { replyAt } : {}),
    ...(leadingAt ? { leadingAt } : {}),
  };
}

export function splitMessagesBySpaces<T extends MessagePiece>(msg: T[]): T[][] {
  if (hasAdjoiningTextPieces(msg)) {
    mergeAdjoiningTextPiecesInPlace(msg);
  }

  const args: T[][] = [];
  let curArg: T[] = [];

  for (const piece of msg) {
    if (piece.type === "text") {
      let pieceText = (piece as unknown as Text).data.text;
      if (pieceText.trim() === "") { // 只有空白，纯分隔作用
        args.push(curArg);
        curArg = [];
        continue;
      }
      if (pieceText[0].trim() === "") { // 左边分割
        args.push(curArg);
        curArg = [];
        pieceText = pieceText.trimStart();
      }
      const textArgs = splitTextBySpaces(pieceText)
        .map((t) => text(t));
      for (const [i, textArg] of textArgs.entries()) {
        const textArgText = textArg.data.text;
        if (
          i === textArgs.length - 1 &&
          pieceText[pieceText.length - 1].trim() !== ""
        ) { // 右边不用分割
          curArg.push(textArg as unknown as T);
        } else { // 中间分割或右边分割
          args.push([...curArg, text(textArgText.trimEnd()) as unknown as T]);
          curArg = [];
        }
      }
    } else {
      curArg.push(piece);
    }
  }
  if (curArg.length > 0) {
    args.push(curArg);
  }

  if (args.length > 0 && args[0].length === 0) {
    args.splice(0, 1);
  }

  return args;
}

function splitTextBySpaces(text: string) {
  const matches = text.trim().matchAll(/\S+/g);
  return [...matches].map((m) => m[0]);
}

function hasAdjoiningTextPieces(msg: MessagePiece[]) {
  let lastIsText = false;
  for (const piece of msg) {
    if (piece.type === "text") {
      if (lastIsText) return true;
      lastIsText = true;
    } else {
      lastIsText = false;
    }
  }
  return false;
}

// TODO: testing
export function generateUnifiedResponse(
  { cmdsResps }: { cmdsResps: CommandResponses[] },
) {
  if (cmdsResps.length === 0) return null;
  if (cmdsResps.length === 1 && cmdsResps[0].command.isLeading) {
    return generateUnifiedResponseForSingleCommand(cmdsResps[0], false);
  }
  const out: RegularMessagePiece[] = [];
  for (const [i, cmdResps] of cmdsResps.entries()) {
    // if (i !== 0) {
    //   out.push(text("-".repeat(16)));
    // }
    out.push(...generateUnifiedResponseForSingleCommand(cmdResps, true));
    if (i < cmdsResps.length - 1) {
      out.push(text("\n"));
    }
  }

  mergeAdjoiningTextPiecesInPlace(out);

  return out;
}

function generateUnifiedResponseForSingleCommand(
  responses: CommandResponses,
  requiresPreview: boolean,
) {
  const out: RegularMessagePiece[] = [];
  if (requiresPreview) {
    out.push(
      text("⊛ "),
      ...responses.command.generatePreview(),
      text(" ➩\n"),
    );
  } else {
    if (
      (
        responses.contents.length === 1 && responses.notes.length === 0 &&
        !hasLinefeed(responses.contents[0])
      ) || (
        responses.notes.length === 1 && responses.contents.length === 0 &&
        !hasLinefeed(responses.notes[0].content)
      )
    ) {
      out.push(text("➩ "));
    } else {
      out.push(text("➩\n"));
    }
  }

  for (const [i, content] of responses.contents.entries()) {
    if (typeof content === "string") {
      out.push(text(content));
    } else {
      out.push(...content);
    }
    if (i < responses.contents.length - 1 || responses.notes.length > 0) {
      out.push(text("\n"));
    }
  }

  for (const note of responses.notes) {
    let levelText: string;
    if (note.level === "system-error") {
      levelText = "系统级错误";
    } else if (note.level === "system-warn") {
      levelText = "系统级警告";
    } else {
      if (note.level !== "user-error") throw new Error("never");
      levelText = "命令错误";
    }
    out.push(text(`⚠ ${levelText} : ${note.content}`));
  }

  mergeAdjoiningTextPiecesInPlace(out);

  return out;
}

function hasLinefeed(msg: RegularMessagePiece[] | string) {
  if (typeof msg === "string") return msg.indexOf("\n") >= 0;
  for (const piece of msg) {
    if (piece.type === "text" && piece.data.text.indexOf("\n") >= 0) {
      return true;
    }
  }
  return false;
}
