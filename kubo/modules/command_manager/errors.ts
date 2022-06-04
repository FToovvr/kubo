export class CommandEvaluationError extends Error {}

export class GetFollowingLinesOfEmbeddedMessageError
  extends CommandEvaluationError {
  constructor() {
    super("嵌入命令没有位于其后的行。");
  }
}
