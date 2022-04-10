import { AhoCorasick } from "./aho_corasick.ts";

const wordList = await (async () => {
  const data = await Deno.readTextFile("test_fixtures/THUOCL_animal.txt");
  const lines = data.split("\n");
  return lines.map((line) => line.split("\t")[0]);
})();
const ac = new AhoCorasick(wordList);

Deno.bench({ name: "aho_corasick 初始化", warmup: 10, n: 10 }, () => {
  const ac = new AhoCorasick(wordList);
});

Deno.bench({ name: "aho_corasick 无匹配" }, () => {
  ac.match("进度：实现了 AC 自动机。");
});

const animalText = "【信鸽】在咕咕咕、咕咕咕地叫着！毕竟虽然【水母】不是鸽子，但【信鸽】是！";

Deno.bench({ name: "aho_corasick 有匹配" }, () => {
  // 竟然正好都没有？！
  // ac.match("老鹰 老虎 蝗虫");
  ac.match(animalText);
});

const superAnimalText = animalText.repeat(1000);

Deno.bench({ name: `aho_corasick ${superAnimalText.length}字符的文本` }, () => {
  // 竟然正好都没有？！
  // ac.match("老鹰 老虎 蝗虫");
  ac.match(superAnimalText);
});
