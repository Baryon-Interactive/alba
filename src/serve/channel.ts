import { Worker } from 'node:worker_threads';

/** A bounded RPC channel. Worker failure rejects every waiter; shutdown never leaves requests hanging. */
export class WorkerChannel {
  readonly worker: Worker;
  private next = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private failure?: Error;
  constructor(file: URL, data: unknown) {
    this.worker = new Worker(file, { workerData: data });
    this.worker.on('message', message => {
      if (!message.id) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error)); else waiter.resolve(message.value);
    });
    this.worker.on('error', error => this.fail(error));
    this.worker.on('exit', code => this.fail(new Error(`Serve worker exited (${code})`)));
  }
  private fail(error: Error) {
    this.failure = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
  call<T>(method: string, args: unknown): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= 256) return Promise.reject(new Error('Serve worker queue is full'));
    const id = ++this.next;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ id, method, args }); });
  }
  async close(): Promise<void> { this.fail(new Error('Serve stopped')); await this.worker.terminate(); }
}
