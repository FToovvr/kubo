import {
  At,
  getTypedMessagePiece,
  MessagePiece,
  Reply,
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
): { replyAt?: [Reply, At]; rest: T[] } {
  // 注：观察到：
  //     - iOS 端引用回复时会多出一个空格；
  //     - macOS 端则会多出一个 text（并未被合并），内容为 "\n"

  if (message.length === 0 || message[0].type !== "reply") {
    return { rest: message ?? [] };
  } else if (message.length === 1) {
    // 单独有一个 reply 的情况不知该怎么处理，就当根本没有吧
    return message[0].type === "reply" ? { rest: [] } : { rest: message };
  } else if (message[1].type !== "at") {
    return { rest: message.slice(1) };
  }
  const [_reply, _at, ...rest] = message;
  const reply = _reply as unknown as Reply;
  const at = _at as unknown as At;
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
  return { replyAt: [reply, at], rest };
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
