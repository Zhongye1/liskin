/**
 * 极简异步队列：生产者 push + close，消费者用 for-await 消费。
 *
 * 用于把「runAgent 的事件流」与「工具确认的暂停/恢复」合并成单条
 * EventMsg 流：ConfirmingToolPort 在确认时 push 一条 ToolConfirmRequired，
 * 然后阻塞在自己的 deferred 上；submit 的生成器从队列消费，天然按顺序交错。
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly pending: T[] = [];
  private readonly waiters: ((v: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(...items: T[]): void {
    for (const item of items) {
      if (this.closed) {
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter({ value: item, done: false });
      } else {
        this.pending.push(item);
      }
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waiters) {
      waiter({ value: undefined, done: true });
    }
    this.waiters.length = 0;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const item = this.pending.shift();
      if (item !== undefined) {
        yield item;
      } else if (this.closed) {
        return;
      } else {
        const result = await new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
        if (result.done) {
          return;
        }
        yield result.value;
      }
    }
  }
}

/** 一个可外部 resolve 的 Promise（用于 confirm 暂停/恢复）。 */
export class Deferred<T> {
  public readonly promise: Promise<T>;
  private resolveFn!: (value: T) => void;
  private resolved = false;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolveFn = resolve;
    });
  }

  resolve(value: T): void {
    if (this.resolved) {
      return;
    }
    this.resolved = true;
    this.resolveFn(value);
  }

  get isResolved(): boolean {
    return this.resolved;
  }
}
