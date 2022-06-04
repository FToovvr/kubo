import {
  At,
  getTypedMessagePiece,
  MessagePiece,
  Reply,
  ReplyAt,
  replyAt,
  Text,
  text,
} from "../go_cqhttp_client/message_piece.ts";

// 测试用
export function arr2Msg(arr: [string, { [key: string]: any }][]) {
  return arr.map(([type, data]) => ({ type, data }) as MessagePiece);
}

// 如果是纯文本信息，返回该文本，否则返回 null
export function tryExtractPureText(msg: MessagePiece[]) {
  if (msg.length === 1 && msg[0].type === "text") {
    const text = msg[0] as Text;
    return text.data.text;
  }
  return null;
}

// 合并相邻的 text
export function mergeAdjoiningTextPiecesInPlace(message: MessagePiece[]) {
  for (let i = 0; i < message.length;) {
    const piece = message[i];
    if (piece.type === "text") {
      const tPiece = piece as Text;
      if (tPiece.data.text.length === 0) {
        // 去掉空 text
        message.splice(i, 1);
        continue;
      } else if (i > 0 && message[i - 1].type === "text") {
        // 合并相邻的 text
        message[i - 1] = text(
          (message[i - 1] as Text).data.text + (piece as Text).data.text,
        );
        message.splice(i, 1);
        continue;
      }
    }
    i++;
  }
}

// 去掉可能存在的引用回复
export function removeReferenceFromMessage(message: MessagePiece[]) {
  const { rest: newMessage } = extractReferenceFromMessage(message);
  return newMessage ?? null;
}

export function extractReferenceFromMessage<T extends MessagePiece | Text>(
  message: T[],
): { replyAt?: ReplyAt; rest: T[] } {
  // 注：观察带引用但消息：
  //     - 有外部 at 的消息，iOS TIM 和 macOS QQ 的格式皆为
  //       [reply(refMsgId), at(qq), text(" "), at(qq), text(content)]
  //     - 无外部 at 的消息，
  //       - iOS TIM 的格式为
  //         [reply(refMsgId), at(qq), text(" " + content)]
  //       - macOS QQ（删完 at 再多退格一次）的格式为
  //         [reply(refMsgId), text(content)]
  //       - macOS QQ（不多退格）的格式（应该）为
  //         [reply(refMsgId), at(qq), text("\n"), text(content)]

  if (message.length === 0 || message[0].type !== "reply") {
    return { rest: message };
  }
  if (message.length === 1) {
    // 单独有一个 reply 的情况不知该怎么处理，就当根本没有吧
    return { rest: [] };
  }

  let reply = message[0] as Reply;
  let at: At | null = null;
  let rest: T[];
  if (message[1].type === "at") {
    at = message[1] as At;
    rest = message.slice(2);
  } else {
    rest = message.slice(1);
  }

  // 处理可能多出来空白
  if (rest.length > 0 && rest[0].type === "text") {
    const first = rest[0] as unknown as Text;
    const firstText = first.data.text;
    if (firstText === "\n" || firstText === " ") {
      rest.splice(0, 1);
    } else if (firstText[0] === " ") {
      rest[0] = text(firstText.substring(1)) as T;
    }
  }
  return { replyAt: replyAt(reply, at ?? undefined), rest };
}

/**
 * 用途是区分由 pieces 组成的行与由 pieces 组成的多段消息。
 *
 * TODO: go_cqhttp_client 那里应该也有个 Message
 */
export class MessageLine<T extends MessagePiece = MessagePiece>
  extends Array<T> {
  constructor(...items: T[]) {
    super(...items);
  }
}

/**
 * 将消息分割成行，每行由 MessagePiece 数组组成。
 */
export function splitMessageIntoLines<T extends MessagePiece | Text>(msg: T[]) {
  const lines: MessageLine<T>[] = [];

  let curLine = new MessageLine<T>();

  // 总之先分成行
  for (const _piece of msg) {
    const piece = getTypedMessagePiece(_piece);
    if (piece.text) {
      const textLines = piece.text.data.text.split("\n");
      const [first] = textLines.splice(0, 1);
      if (first !== "") {
        curLine.push(text(first) as T);
      }
      while (textLines.length > 0) {
        const [first] = textLines.splice(0, 1);
        lines.push(curLine);
        curLine = first !== "" ? [text(first) as T] : [];
      }
    } else {
      curLine.push(_piece);
    }
  }
  if (msg.length > 0) {
    lines.push(curLine);
  }

  return lines;
}
