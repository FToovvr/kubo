export class TokenBucket {
  size: number;
  current = 0;
  supplementPerSecond: number;

  waitings: { amount: number; cb: () => void }[] = [];

  constructor(
    args: { size: number; supplementPerSecond: number; initial?: number },
  ) {
    args = {
      initial: args.size,
      ...args,
    };
    this.size = args.size;
    this.supplementPerSecond = args.supplementPerSecond;
    this.current = args.initial!;

    setInterval(() => {
      this.current = Math.min(
        this.size,
        this.current + this.supplementPerSecond,
      );

      while (true) {
        if (
          this.waitings.length > 0 && this.tryTake(this.waitings[0].amount)
        ) {
          const [ok] = this.waitings.splice(0, 1);
          ok.cb();
        } else {
          break;
        }
      }
    }, 1000);
  }

  tryTake(amount: number = 1) {
    if (this.current < amount) {
      return false;
    }
    this.current -= amount;
    return true;
  }

  async take(amount: number = 1, args: { force?: boolean } = {}) {
    args = {
      force: false,
      ...args,
    };

    if (args.force) {
      this.current -= amount;
      return;
    }

    if (this.tryTake(amount)) {
      return;
    }
    return new Promise<void>((resolve) => {
      this.waitings.push({ amount, cb: resolve });
    });
  }
}
