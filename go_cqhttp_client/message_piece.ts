// 参考：
// https://github.com/Mrs4s/go-cqhttp/blob/a75f412b828ac26cb17a1e6d7522df7b6bb480a5/coolq/cqcode.go#L107
export interface MessagePiece {
  type: string;
}

export function buildMessage(
  strings: TemplateStringsArray,
  ...values: (MessagePiece | MessagePiece[])[]
) {
  const msg: MessagePiece[] = [];
  for (let i = 0; i < strings.length; i++) {
    if (strings[i].length > 0) {
      msg.push(text(strings[i]));
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

// TextElement
export interface Text extends MessagePiece {
  type: "text";
  data: {
    text: string;
  };
}
export function text(text: string): Text {
  return { type: "text", data: { text } };
}

export interface Reply extends MessagePiece {
  type: "reply";
  data: { id: string };
}
export function reply(id: number): Reply {
  return { type: "reply", data: { id: String(id) } };
}
export function replyAt(id: number, qq: number) {
  return [reply(id), at(qq)];
}

// AtElement
export interface At extends MessagePiece {
  type: "at";
  // 如果不是 all，则是 QQ 号
  data: { qq: string | "all" };
}
export function at(qq: number | "all"): At {
  return { type: "at", data: { qq: qq === "all" ? qq : String(qq) } };
}

export interface Emoticon extends MessagePiece {
  type: "face";
  data: { id: string };
}
function emoticon(id: string): Emoticon {
  return { type: "face", data: { id } };
}

export interface Image extends MessagePiece {
  type: "image";
  data: {
    file: string;
    type?: never; // TODO: "flash" | "show"
    // subType: number; // TODO
    // TODO: url, cache, id, c
  };
}
export function imageFromBase64(base64: string): Image {
  return { type: "image", data: { file: `base64://${base64}` } };
}

// // ForwardElement
// export interface Forward extends MessagePiece {
//   type: "forward";
//   data: { id: string };
// }

// // LightAppElement
// export interface Json extends MessagePiece {
//   type: "json";
//   data: { data: string };
// }

// // RedBagElement
// export interface RedPacket extends MessagePiece {
//   type: "redbag";
//   data: { title: string };
// }

// TODO: record, video, dice, xml
