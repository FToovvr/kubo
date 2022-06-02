// 参考：
// https://github.com/Mrs4s/go-cqhttp/blob/a75f412b828ac26cb17a1e6d7522df7b6bb480a5/coolq/cqcode.go#L107
export interface MessagePiece {
  type: string;
}

export type RegularMessagePiece = Text | Reply | At | Emoticon | Image;

// 用于模板字符串
export function buildMessage<T extends MessagePiece | Text>(
  strings: TemplateStringsArray,
  ...values: (T | T[])[]
) {
  const msg: T[] = [];
  for (let i = 0; i < strings.length; i++) {
    if (strings[i].length > 0) {
      msg.push(text(strings[i]) as T);
    }
    const x = values[i];
    if (Array.isArray(x)) {
      msg.push(...x);
    } else if (x) {
      msg.push(x);
    }
  }
  return msg;
}

export function getTypedMessagePiece(piece: MessagePiece) {
  switch (piece.type) {
    case "text":
      return { text: piece as Text };
    case "reply":
      return { reply: piece as Reply };
    case "at":
      return { at: piece as At };
    case "face":
      return { emoticon: piece as Emoticon };
    case "image":
      return { image: piece as Image };
  }
  return { unknown: piece };
}

// TextElement
export interface Text extends MessagePiece {
  readonly type: "text";
  readonly data: { readonly text: string };
}
export function text(text: string): Text {
  return { type: "text", data: { text } };
}

export interface Reply extends MessagePiece {
  readonly type: "reply";
  readonly data: { readonly id: string };
}
export function reply(id: number): Reply {
  return { type: "reply", data: { id: String(id) } };
}
export function replyAt(id: number, qq: number): [Reply, At] {
  return [reply(id), at(qq)];
}

// AtElement
export interface At extends MessagePiece {
  readonly type: "at";
  // 如果不是 all，则是 QQ 号
  readonly data: { readonly qq: string | "all" };
}
export function at(qq: number | "all"): At {
  return { type: "at", data: { qq: qq === "all" ? qq : String(qq) } };
}

export interface Emoticon extends MessagePiece {
  readonly type: "face";
  readonly data: { readonly id: string };
}
export function emoticon(id: string): Emoticon {
  return { type: "face", data: { id } };
}

export interface Image extends MessagePiece {
  readonly type: "image";
  readonly data: {
    readonly file: string;
    readonly type?: never; // TODO: "flash" | "show"
    // readonly subType: number; // TODO
    // readonly TODO: url, cache, id, c
  };
}
export function imageFromBase64(base64: string): Image {
  // TODO: validate base64
  return { type: "image", data: { file: `base64://${base64}` } };
}

// // ForwardElement
// export interface Forward extends MessagePiece {
//   readonly type: "forward";
//   readonly data: { readonly id: string };
// }

// // LightAppElement
// export interface Json extends MessagePiece {
//   readonly type: "json";
//   readonly data: { readonly data: string };
// }

// // RedBagElement
// export interface RedPacket extends MessagePiece {
//   readonly type: "redbag";
//   readonly data: { readonly title: string };
// }

// TODO: record, video, dice, xml
