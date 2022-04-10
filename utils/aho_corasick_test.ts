import { assertEquals } from "https://deno.land/std@0.134.0/testing/asserts.ts";

import { AhoCorasick, Trie, TrieVertex } from "./aho_corasick.ts";

interface TrieArr {
  [key: number]: [string, 0 | 1, TrieArr | null];
}
function _arrayToTrie(arr: TrieArr): { next: TrieVertex["next"] } {
  const x: [string, TrieVertex][] = Object.values(arr).map((el) => [el[0], {
    isLeaf: !!el[1],
    next: el[2] ? arrayToTrie(el[2]).next : {},
  }]);
  return { next: Object.fromEntries(x) };
}

function arrayToTrie(arr: TrieArr) {
  return {
    isLeaf: false,
    next: _arrayToTrie(arr).next,
  };
}

Deno.test("trie", (t) => {
  assertEquals(
    new Trie(["ab", "abc"]).root,
    arrayToTrie([["a", 0, [["b", 1, [["c", 1, null]]]]]]),
  );
  assertEquals(
    new Trie(["ab", "bc"]).root,
    arrayToTrie([["a", 0, [["b", 1, null]]], ["b", 0, [["c", 1, null]]]]),
  );
  assertEquals(
    new Trie(["a", "ab1", "ab2"]).root,
    arrayToTrie([["a", 1, [["b", 0, [["1", 1, null], ["2", 1, null]]]]]]),
  );
});

Deno.test("aho_corasick", () => {
  // test case from https://www.geeksforgeeks.org/aho-corasick-algorithm-pattern-searching/

  assertEquals(
    (new AhoCorasick(["he", "she", "hers", "his"])).match("ahishers"),
    [
      { start: 1, length: 3 }, // his
      { start: 3, length: 3 }, // she
      { start: 4, length: 2 }, // he
      { start: 4, length: 4 }, // his
    ],
  );

  assertEquals(
    (new AhoCorasick(["ab", "bc"])).match("aabc"),
    [
      { start: 1, length: 2 }, // ab
      { start: 2, length: 2 }, // bc
    ],
  );

  // console.log(Deno.inspect(ac.root, { depth: Infinity }));
  // console.log(Deno.inspect(ac.root, { depth: Infinity }));
});
