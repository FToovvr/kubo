export interface TrieVertex {
  next: { [key: string]: TrieVertex };
  isLeaf: boolean;
}

function makeVertex(): TrieVertex {
  return {
    next: {},
    isLeaf: false,
  };
}

export class Trie {
  root = makeVertex();

  constructor(words: string[]) {
    for (const word of words) {
      let last = this.root;
      last.isLeaf = false;

      for (let i = 0; i < word.length; i++) {
        const char = word[i];
        const isFinal = i === word.length - 1;

        const cur = last.next[char] ?? makeVertex();
        if (isFinal) {
          cur.isLeaf = true;
        }
        last.next[char] = cur;
        last = cur;
      }
    }
  }
}

export interface ACVertex {
  next: { [key: string]: ACVertex };
  isLeaf: boolean;
  depth?: number;
  suffixLink?: ACVertex;
}

/**
 * TODO:
 *    实现跨字符串匹配以及无视部分字符的功能。
 *    - 跨字符串匹配，如："bc" 匹配 ["ab", "cd"]
 *    - 无视部分字符，如：忽略空格，"bc" 匹配 "ab cd"
 *      - 需要在录入字典时就处理，去掉字典项里的相关字符
 */
export class AhoCorasick extends Trie {
  declare root: ACVertex;

  constructor(words: string[]) {
    super(words);

    this.root.suffixLink = this.root;
    this.root.depth = 0;
  }

  private getSuffixLink(v: ACVertex, parent: ACVertex, edge: string) {
    if (parent === this.root) {
      return this.root;
    } else {
      return this.next(parent.suffixLink!, edge) ?? this.root;
    }
  }

  private next(cur: ACVertex, char: string): ACVertex | null {
    const next = cur.next[char];
    if (!next) {
      return null;
    }

    if (!next.suffixLink) {
      next.suffixLink = this.getSuffixLink(next, cur, char);
    }
    if (!(typeof next.depth === "number")) {
      next.depth = cur.depth! + 1;
    }

    return next;
  }

  match(text: string) {
    const matches: { start: number; length: number }[] = [];
    let cur = this.root;

    for (let i = 0; i < text.length; i++) {
      let last: ACVertex | null = null;
      while (true) {
        const char = text[i];

        if (cur.isLeaf) {
          matches.push({ start: i - cur.depth!, length: cur.depth! });
        }

        const _cur = this.next(cur, char);
        if (_cur) {
          cur = _cur;
          break;
        } else {
          last = cur;
          cur = cur.suffixLink ?? this.root;
          if (cur === last) {
            break;
          }
        }
      }
    }

    if (cur.isLeaf) {
      matches.push({ start: text.length - cur.depth!, length: cur.depth! });
    }

    return matches;
  }
}
