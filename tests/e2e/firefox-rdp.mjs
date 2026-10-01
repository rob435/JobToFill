// Minimal client for Firefox's Remote Debugging Protocol (what about:debugging uses).
// WebDriver BiDi can't reach extension contexts, so the Firefox tests use this to run
// code in the extension's background page and in its own pages (popup, settings).
import net from 'node:net';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RemoteDebugger {
  static async connect(port, timeout = 20000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        const socket = await new Promise((resolve, reject) => {
          const s = net.connect(port, '127.0.0.1', () => resolve(s));
          s.once('error', reject);
        });
        const client = new RemoteDebugger(socket);
        await client.greeting;
        return client;
      } catch (err) {
        if (Date.now() > deadline) {
          throw new Error(`Could not connect to Firefox's debugger on port ${port}: ${err.message}`, { cause: err });
        }
        await sleep(200);
      }
    }
  }

  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.replies = new Map(); // actor -> queue of { resolve, reject } for pending requests
    this.waiting = new Map(); // resultID -> resolve, for evaluateJSAsync
    this.results = new Map(); // resultID -> evaluationResult packets that arrived before anyone waited
    this.listeners = new Set(); // (event packet) => void
    this.greeting = new Promise((resolve, reject) => this.queue('root').push({ resolve, reject }));
    socket.on('data', (chunk) => this.receive(chunk));
  }

  queue(actor) {
    if (!this.replies.has(actor)) this.replies.set(actor, []);
    return this.replies.get(actor);
  }

  /** Packets are framed as `<byte length>:<json>`. */
  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const colon = this.buffer.indexOf(':');
      if (colon < 0) return;
      const length = Number(this.buffer.subarray(0, colon).toString());
      if (this.buffer.length < colon + 1 + length) return;
      const packet = JSON.parse(this.buffer.subarray(colon + 1, colon + 1 + length).toString());
      this.buffer = this.buffer.subarray(colon + 1 + length);
      this.dispatch(packet);
    }
  }

  dispatch(packet) {
    if (packet.type === 'evaluationResult') {
      const resolve = this.waiting.get(packet.resultID);
      this.waiting.delete(packet.resultID);
      if (resolve) resolve(packet);
      else this.results.set(packet.resultID, packet);
    } else if (packet.type && !packet.error) {
      for (const listener of this.listeners) listener(packet);
    } else {
      const pending = this.queue(packet.from).shift();
      if (!pending) return;
      if (packet.error) pending.reject(new Error(`${packet.error}: ${packet.message || ''}`));
      else pending.resolve(packet);
    }
  }

  request(to, type, props) {
    return new Promise((resolve, reject) => {
      this.queue(to).push({ resolve, reject });
      const body = JSON.stringify({ to, type, ...props });
      this.socket.write(`${Buffer.byteLength(body)}:${body}`);
    });
  }

  /**
   * Watch every document of an installed add-on (background page, popup, settings tab…).
   * Returns `consoleFor(urlPart)`, which waits for a matching document and gives its console actor.
   */
  async watchExtension(addonId) {
    let addon;
    for (let i = 0; i < 50 && !addon; i++) {
      addon = (await this.request('root', 'listAddons')).addons.find((a) => a.id === addonId);
      if (!addon) await sleep(200);
    }
    if (!addon) throw new Error(`Add-on ${addonId} is not installed`);
    const watcher = (await this.request(addon.actor, 'getWatcher')).actor;
    const targets = new Map(); // target actor -> form
    this.listeners.add((packet) => {
      if (packet.from !== watcher) return;
      if (packet.type === 'target-available-form') targets.set(packet.target.actor, packet.target);
      if (packet.type === 'target-destroyed-form') targets.delete(packet.target.actor);
    });
    await this.request(watcher, 'watchTargets', { targetType: 'frame' });

    return async (urlPart, timeout = 10000) => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const forms = [...targets.values()].filter((t) => t.url && t.url.includes(urlPart));
        if (forms.length) return forms[forms.length - 1].consoleActor;
        if (Date.now() > deadline) throw new Error(`No extension document matching ${urlPart}`);
        await sleep(100);
      }
    };
  }

  /** Run `fn(arg)` in the document behind `consoleActor` and return its (JSON-serializable) result. */
  async call(consoleActor, fn, arg) {
    const text = `(async () => {
      try { return JSON.stringify({ value: (await (${fn})(${JSON.stringify(arg === undefined ? null : arg)})) ?? null }); }
      catch (e) { return JSON.stringify({ error: String((e && e.stack) || e) }); }
    })()`;
    const { resultID } = await this.request(consoleActor, 'evaluateJSAsync', { text, mapped: { await: true } });
    const packet = await this.evaluationResult(resultID);
    if (packet.exceptionMessage) throw new Error(packet.exceptionMessage);
    const out = JSON.parse(await this.stringOf(packet.result));
    if (out.error) throw new Error(out.error);
    return out.value;
  }

  evaluationResult(resultID) {
    const early = this.results.get(resultID);
    this.results.delete(resultID);
    return early ? Promise.resolve(early) : new Promise((resolve) => this.waiting.set(resultID, resolve));
  }

  async stringOf(grip) {
    if (typeof grip === 'string') return grip;
    if (grip && grip.type === 'longString') {
      const { substring } = await this.request(grip.actor, 'substring', { start: 0, end: grip.length });
      return substring;
    }
    throw new Error('Unexpected evaluation result: ' + JSON.stringify(grip));
  }

  close() {
    this.socket.destroy();
  }
}
