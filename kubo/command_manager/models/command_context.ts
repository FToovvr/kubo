import {
  RegularMessagePiece,
} from "../../../go_cqhttp_client/message_piece.ts";

interface Extra {
  prefix: string | null;
  isEmbedded: boolean;
  shouldAwait: boolean;
}

export class CommandContext {
  private isValid = true;

  public readonly prefix: string | null;
  // TODO: public readonly replyAt

  public readonly isEmbedded: boolean;
  public readonly shouldAwait: boolean;

  private hasManuallyClaimed = false;

  private constructor(
    controller: CommandContextController,
    public readonly id: number,
    extra: Extra,
  ) {
    controller.onInvalidate = () => this.isValid = false;
    controller.getHasManuallyClaimed = () => this.hasManuallyClaimed;

    this.prefix = extra.prefix;
    this.isEmbedded = extra.isEmbedded;
    this.shouldAwait = extra.shouldAwait;
  }
  static make(controller: CommandContextController, id: number, extra: Extra) {
    return new CommandContext(controller, id, extra);
  }

  /** 声明该命令已执行（即使作为行命令没有回复内容） */
  claimExecuted() {
    this.hasManuallyClaimed = true;
  }
}

export class CommandContextController {
  onInvalidate!: (() => void);
  getHasManuallyClaimed!: (() => boolean);

  invalidate() {
    this.onInvalidate();
  }

  get hasManuallyClaimed() {
    return this.getHasManuallyClaimed();
  }
}

export function makeCommandContext(id: number, extra: Extra) {
  const controller = new CommandContextController();
  const context = CommandContext.make(controller, id, extra);
  return { controller, context };
}
