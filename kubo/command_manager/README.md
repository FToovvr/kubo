# 命令管理器

## 结构

命令管理器主要包括三部分：

- `manager.ts` 负责管理命令；
- `evaluator.ts` 负责执行命令。
- `tokenizer.ts` 负责将消息中潜在的命令转化为 MessagePiece；

其中，只有 manager 是公开的；manager 使用 evaluator；evaluator 使用 tokenizer。

- manager 接收到命令，交给 evaluator 执行，然后负责输出结果；
- evaluator 收到消息，交给 tokenizer 解析命令，然后执行命令并返回；
- tokenizer 收到消息，解析命令并返回。

tokenizer 下还包括 `regularize.ts`，用于规范化其返回的内容。
