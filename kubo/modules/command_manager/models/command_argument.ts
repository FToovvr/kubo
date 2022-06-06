import {
  At,
  Emoticon,
  Image,
  RegularMessagePiece,
  text,
} from "../../../../go_cqhttp_client/message_piece.ts";
import {
  CompactComplexPiece,
  ComplexPiecePart,
  ExecutedCommandPiece,
  ExecutedPiece,
} from "./command_piece.ts";

export class CommandArgument implements ComplexPiecePart<true> {
  content: ExecutedPiece;
  gapAtRight: string;

  constructor(
    args: ComplexPiecePart<true>,
  ) {
    this.content = args.content;
    this.gapAtRight = args.gapAtRight;
  }

  #soleCache: RegularMessagePiece | null | undefined = undefined;
  /**
   * 如果内容的类型唯一，则返回该内容。
   * 对于组、嵌入命令，视其包含的内容为目标内容
   */
  get soleContent() {
    if (this.#soleCache !== undefined) {
      return this.#soleCache;
    }
    const result = getSoleContent(this.content);
    this.#soleCache = result;
    return result;
  }

  get sole() {
    if (this.command) return this.command;
    return this.soleContent;
  }

  get text(): string | null {
    return this.soleContent?.type === "text"
      ? this.soleContent.data.text
      : null;
  }

  get boolean() {
    const text = this.text;
    if (!text) return null;
    const lower = text.toLowerCase();
    if (TRUE_VALUES.has(lower)) return true;
    if (FALSE_VALUES.has(lower)) return false;
    return null;
  }

  get number(): number | null {
    const text = this.text;
    const num = text !== null ? Number(text) : null;
    return Number.isNaN(num) ? null : num;
  }

  get bigint(): bigint | null {
    if (!this.text) return null;
    try {
      return BigInt(this.text);
    } catch (e) {
      return null;
    }
  }

  get at(): At | null {
    return this.soleContent?.type === "at" ? this.soleContent : null;
  }

  get emoticon(): Emoticon | null {
    return this.soleContent?.type === "face" ? this.soleContent : null;
  }

  get image(): Image | null {
    return this.soleContent?.type === "image" ? this.soleContent : null;
  }

  get command(): ExecutedCommandPiece | null {
    if (this.content.type !== "__kubo_executed_command") return null;
    return this.content;
  }

  get option() {
    if (
      this.content.type !== "text" &&
      this.content.type !== "__kubo_compact_complex"
    ) {
      return null;
    }

    if (this.content.type === "text") {
      const optionText = this.content.data.text;
      const eqIndex = optionText.indexOf("=");
      if (eqIndex < 0) return new CommandArgumentOption(optionText, null);
      return new CommandArgumentOption(
        optionText.slice(0, eqIndex),
        text(optionText.slice(eqIndex + 1)),
      );
    }

    const parts = this.content.parts;
    if (parts[0].type !== "text") {
      return null;
    }
    const firstText = parts[0].data.text;
    const eqIndex = firstText.indexOf("=");
    if (eqIndex < 0) return null;
    let key = firstText.slice(0, eqIndex);
    let valueParts = parts.slice(1);
    if (eqIndex !== firstText.length - 1) {
      const remainText = firstText.slice(eqIndex + 1);
      valueParts.splice(0, 0, text(remainText));
    }
    const value = valueParts.length === 1
      ? valueParts[0]
      : new CompactComplexPiece<true>(valueParts);
    return new CommandArgumentOption(key, value);
  }

  get flag() {
    const option = this.option;
    if (!option) return null;
    if (option.value.content !== null) return null;
    if (!option.key.startsWith("-")) return null;
    return option.key.slice(1);
  }

  get evaluated(): RegularMessagePiece[] {
    if (
      this.content.type === "__kubo_executed_command" ||
      this.content.type === "__kubo_group" ||
      this.content.type === "__kubo_compact_complex"
    ) {
      return this.content.generateEmbeddedOutput();
    }
    return [this.content];
  }
}

export class CommandArgumentOption {
  key: string;
  value: Omit<CommandArgument, "gapAtRight">;

  constructor(
    key: string,
    value: ExecutedPiece | null,
  ) {
    this.key = key;
    this.value = new Proxy<CommandArgument | { null: true }>(
      value
        ? new CommandArgument({ content: value, gapAtRight: "" })
        : { null: true },
      {
        get(obj, prop) {
          if ("null" in obj) {
            if (obj.null !== true) throw new Error("never");
            if (prop === "boolean") return true;
            return null;
          }
          if (prop === "gapAtRight") return undefined;
          // @ts-ignore
          return obj[prop];
        },
      },
    ) as CommandArgumentOption["value"];
  }
}

function getSoleContent(content: ExecutedPiece) {
  let current = content;
  let result: RegularMessagePiece | null = null;
  // 为处理 "{{{{{{{{{content}}}}}}}}}" 这种迷惑情况，使用循环
  while (true) {
    if (current.type === "__kubo_group") {
      if (current.parts.length === 1) {
        current = current.parts[0].content;
      } else {
        const pureText = tryExtractPureText(
          current.parts.map((part) => part.content),
        );
        if (pureText) {
          result = text(pureText);
        }
        break;
      }
    } else if (current.type === "__kubo_executed_command") {
      if (!current.isEmbedded) throw new Error("never");
      if (current.hasFailed) break;
      if (
        !current.result || !current.result.embedding ||
        current.result.embedding.length === 0
      ) {
        throw new Error("never");
      } else if (current.result.embedding.length === 1) {
        // NOTE: 现阶段 embedding 只能是，… 同下
        // current = current.result!.embedding[0];

        result = current.result.embedding[0];
        break;
      }
      // NOTE: 现阶段 embedding 只能是 RegularMessagePiece，所以无需这么做
      // const pureText = tryExtractPureText(current.result.embedding)
      break;
    } else if (current.type === "__kubo_compact_complex") {
      const pureText = tryExtractPureText(current.parts);
      if (pureText) {
        result = text(pureText);
      }
      break;
    } else {
      result = current;
      break;
    }
  }

  return result;
}

const TRUE_VALUES = new Set(["true", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["false", "no", "n", "off"]);

function tryExtractPureText(parts: ExecutedPiece[]) {
  let currentText = "";
  for (const part of parts) {
    if (part.type === "text") {
      currentText += part.data.text;
    } else if (part.type === "__kubo_group") {
      const sole = getSoleContent(part);
      if (!sole || sole.type !== "text") return null;
      currentText += sole.data.text;
    } else if (part.type === "__kubo_executed_command") {
      if (!part.isEmbedded) throw new Error("never");
      if (part.hasFailed) return null;
      if (
        !part.result || !part.result.embedding ||
        part.result.embedding.length === 0
      ) {
        throw new Error("never");
      } else if (part.result.embedding.length === 1) {
        // NOTE: 现阶段 embedding 只能是，… 同上
        if (part.result.embedding[0].type === "text") {
          currentText += part.result.embedding[0].data.text;
        } else {
          return null;
        }
      }
      // NOTE: 现阶段 embedding 只能是，… 同上
      //  tryExtractPureText(part.result.embedding); …
    } else {
      return null;
    }
  }
  return currentText;
}
