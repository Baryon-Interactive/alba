export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(fn, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { if (await fn()) return; await pause(80); }
  throw new Error(`Timed out: ${label}`);
}
export class DevTools {
  id = 0; pending = new Map(); errors = [];
  async connect(url) {
    this.socket = new WebSocket(url);
    this.socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id) { const waiter = this.pending.get(message.id); this.pending.delete(message.id); if (message.error) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result); }
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails.text);
    };
    await new Promise((resolve, reject) => { this.socket.onopen = resolve; this.socket.onerror = reject; });
  }
  call(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.id; this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); }); }
  async js(expression) { const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
}
