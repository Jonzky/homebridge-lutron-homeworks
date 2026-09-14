import { EventEmitter } from 'events';

/**
 * Minimal stand-in for net.Socket. Records writes and lets tests drive
 * connect / data / close events synchronously.
 */
export class FakeSocket extends EventEmitter {
  public connectedTo: { host: string; port: number } | null = null;
  public writes: string[] = [];
  public destroyed = false;
  public ended = false;
  public keepAlive: { enable: boolean; delay: number | undefined } | null = null;

  connect(port: number, host: string, connectListener?: () => void): this {
    this.connectedTo = { host, port };
    if (connectListener) {
      this.once('connect', connectListener);
    }
    return this;
  }

  write(data: string): boolean {
    this.writes.push(data);
    return true;
  }

  destroy(error?: Error): this {
    if (this.destroyed) {
      return this;
    }
    this.destroyed = true;
    if (error) {
      this.emit('error', error);
    }
    this.emit('close', error !== undefined);
    return this;
  }

  end(): this {
    this.ended = true;
    return this;
  }

  setKeepAlive(enable: boolean, delay?: number): this {
    this.keepAlive = { enable, delay };
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  // ---- test drivers ----
  emitConnect(): void {
    this.emit('connect');
  }

  receive(text: string): void {
    this.emit('data', Buffer.from(text));
  }

  emitClose(hadError = false): void {
    this.destroyed = true;
    this.emit('close', hadError);
  }

  writesMatching(text: string): string[] {
    return this.writes.filter(w => w === text);
  }
}
