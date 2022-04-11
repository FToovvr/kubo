import { MessagePiece, Text } from "../go_cqhttp_client/message_piece.ts";

import {
  generateRandomByBoxMuller,
  generateRandomInteger,
  generateRandomIntegerByBoxMuller,
  getCurrentUTCTimestamp,
  getCurrentUTCTimestampMs,
} from "../utils/misc.ts";

export default {
  // 去掉可能存在的引用回复
  removeReferenceFromMessage: (message: MessagePiece[]) => {
    if (message.length === 0 || message[0].type !== "reply") [];
    if (message.length === 1) return [];
    if (message[1].type === "at") {
      const [_1, _2, ...ret] = message;
      return ret;
    }
    const [_, ...ret] = message;
    return ret;
  },

  // 如果是纯文本信息，返回该文本，否则返回 null
  tryExtractPureText: (msg: MessagePiece[]) => {
    if (msg.length === 1 && msg[0].type === "text") {
      const text = msg[0] as Text;
      return text.data.text;
    }
    return null;
  },

  generateRandomInteger,
  generateRandomByBoxMuller,
  generateRandomIntegerByBoxMuller,
  getCurrentUTCTimestampMs,
  getCurrentUTCTimestamp,
};
