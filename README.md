# Kubo

## go-cqhttp 配置

```yaml
message:
  post-format: array

servers:
  - http:
    # ...
  - ws:
    # ...
```

## 项目结构

- go_cqhttp_client 与 go-cqhttp 沟通的客户端
- kubo 「Kubo」迷你 bot 框架相关
- alia 「Alia」骰子 bot 相关
- utils 各种辅助工具的实现（与骰子功能无直接关联）

## Test/Bench

- `deno bench --unstable --allow-read utils/aho_corasick_bench.ts`

## 鸣谢

- go-cqhttp
- [THUOCL](https://github.com/thunlp/THUOCL): 测试数据 `THUOCL_animal.txt`
