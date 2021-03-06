import { AhoCorasick } from "../../../utils/aho_corasick.ts";
import {
  MessagePiece,
  Text,
  text,
} from "../../../go_cqhttp_client/message_piece.ts";

export class SensitiveFilter {
  ac: AhoCorasick;

  constructor(sensitiveList: string[]) {
    this.ac = new AhoCorasick(sensitiveList.filter((x) => x.trim().length > 0));
  }

  private static censorText(text: string, start: number, length: number) {
    const beginning = text.substring(0, start);
    const ending = text.substring(start + length);
    return beginning + "○".repeat(length) + ending;
  }

  filterText(text: string) {
    const matches = this.ac.match(text);
    for (const { start, length } of matches) {
      text = SensitiveFilter.censorText(text, start, length);
    }
    return text;
  }

  filter(message: MessagePiece[] | string) {
    if (typeof message === "string") {
      return this.filterText(message);
    }

    const retMessage: MessagePiece[] = [];
    for (let piece of structuredClone(message) as MessagePiece[]) {
      if (piece.type === "text") {
        piece = text(this.filterText((piece as Text).data.text));
      }
      retMessage.push(piece);
    }

    return retMessage;
  }
}
