import { Socket } from 'net';
import { LineFramer, PromptKind, MONITOR_COMMAND, MONITOR_ACK, KEEPALIVE_COMMAND } from './protocol';

export interface EngineLogger {
  debug(message: string, ...parameters: unknown[]): void;
  info(message: string, ...parameters: unknown[]): void;
  warn(message: string, ...parameters: unknown[]): void;
  error(message: string, ...parameters: unknown[]): void;
}

/** The slice of net.Socket the engine relies on, so tests can substitute a fake. */
export interface EngineSocket {
  readonly destroyed: boolean;
  connect(port: number, host: string, connectListener?: () => void): unknown;
  write(data: string): boolean;
  destroy(error?: Error): unknown;
  end(): unknown;
  setKeepAlive(enable: boolean, initialDelay?: number): unknown;
  setNoDelay(noDelay?: boolean): unknown;
  on(event: 'connect', listener: () => void): unknown;
  on(event: 'data', listener: (data: Buffer) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (hadError: boolean) => void): unknown;
}

export interface EngineOptions {
  createSocket: () => EngineSocket;
  /** Silence before a keepalive is sent; a second silent period drops the link. */
  idleTimeoutMs: number;
  /** First reconnect delay; doubles on each consecutive failure. */
  reconnectDelayMs: number;
  reconnectMaxDelayMs: number;
  /** Time to wait for a prompt after connecting before sending CRLF to provoke one. */
  handshakeNudgeMs: number;
  /** Commands held while not ready; oldest are dropped beyond this. */
  maxQueuedCommands: number;
}

const DEFAULT_OPTIONS: EngineOptions = {
  createSocket: () => new Socket(),
  idleTimeoutMs: 40_000,
  reconnectDelayMs: 5_000,
  reconnectMaxDelayMs: 60_000,
  handshakeNudgeMs: 3_000,
  maxQueuedCommands: 32,
};

export type ReceiveCallback = (engine: NetworkEngine, line: string) => void;
export type DidConnectCallback = (engine: NetworkEngine) => void;

enum ComState {
  Idle,
  Connecting,
  Connected,
  Authenticating,
  Establishing,
  Ready,
  Disconnected,
}

const CRLF = '\r\n';
const LOGIN_FAILURE = /login\s+(incorrect|failed|invalid|denied)/i;

/**
 * Owns the telnet session with the processor.
 *
 *   Idle -> Connecting -> Connected --LOGIN:--> Authenticating --LNET>--> Establishing --ack--> Ready
 *
 * A command prompt seen in any pre-Ready state requests level monitoring, so a
 * processor that never asks for a login still reaches Ready. Any close schedules a
 * reconnect with exponential backoff unless shutdown() was called.
 */
export class NetworkEngine {
  private readonly options: EngineOptions;
  private socket: EngineSocket | null = null;
  private framer = new LineFramer();
  private state = ComState.Idle;
  private credentialsSent = false;
  private monitoringRequested = false;
  private pingOutstanding = false;
  private shuttingDown = false;
  private reconnectDelayMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private nudgeTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly queue: string[] = [];
  private readonly receiveCallbacks: ReceiveCallback[] = [];
  private readonly didConnectCallbacks: DidConnectCallback[] = [];

  constructor(
    public readonly log: EngineLogger,
    private readonly host: string,
    private readonly port: number,
    private readonly username: string,
    private readonly password: string,
    options: Partial<EngineOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.reconnectDelayMs = this.options.reconnectDelayMs;
  }

  // ---- public API ----

  connect(): void {
    if (this.shuttingDown) {
      return;
    }
    if (this.socket && !this.socket.destroyed && this.state !== ComState.Disconnected && this.state !== ComState.Idle) {
      this.log.debug('[Network] connect() ignored, a connection is already in progress');
      return;
    }

    this.clearTimers();
    this.framer = new LineFramer();
    this.credentialsSent = false;
    this.monitoringRequested = false;
    this.pingOutstanding = false;
    this.state = ComState.Connecting;

    const socket = this.options.createSocket();
    this.socket = socket;

    socket.on('connect', () => {
      if (socket !== this.socket) {
        return;
      }
      this.state = ComState.Connected;
      socket.setKeepAlive(true, 15_000);
      socket.setNoDelay(true);
      this.armIdleTimer();
      this.armHandshakeNudge();
      this.log.debug('[Network] Socket connected, waiting for the processor prompt');
    });
    socket.on('data', (data) => {
      if (socket === this.socket) {
        this.handleData(data.toString());
      }
    });
    socket.on('error', (error) => {
      if (socket === this.socket) {
        this.log.error('[Network] Socket error: %s', error.message);
      }
    });
    socket.on('close', () => {
      if (socket === this.socket) {
        this.handleClose();
      }
    });

    this.log.info('[Network] Connecting to %s:%d', this.host, this.port);
    socket.connect(this.port, this.host);
  }

  /** Writes a command now, or queues it until the session is ready. */
  send(command: string): void {
    if (this.isReady() && this.socket && !this.socket.destroyed) {
      this.log.debug('[Network] > %s', command);
      this.write(command);
      return;
    }
    this.queue.push(command);
    if (this.queue.length > this.options.maxQueuedCommands) {
      const dropped = this.queue.shift();
      this.log.warn('[Network] Command queue full, dropped: %s', dropped);
    }
    this.log.debug('[Network] Not ready, queued: %s', command);
  }

  /** Stops reconnecting and closes the session. Call from Homebridge's shutdown event. */
  shutdown(): void {
    this.shuttingDown = true;
    this.clearTimers();
    this.queue.length = 0;
    if (this.socket && !this.socket.destroyed) {
      this.socket.end();
    }
  }

  isReady(): boolean {
    return this.state === ComState.Ready;
  }

  /** Called with every protocol line the processor sends after the handshake. */
  registerReceiveCallback(callback: ReceiveCallback): void {
    this.receiveCallbacks.push(callback);
  }

  /** Called each time the session becomes ready, including after a reconnect. */
  registerDidConnectCallback(callback: DidConnectCallback): void {
    this.didConnectCallbacks.push(callback);
  }

  // ---- inbound ----

  private handleData(text: string): void {
    this.pingOutstanding = false;
    this.armIdleTimer();

    const { lines, prompt } = this.framer.push(text);
    for (const line of lines) {
      this.handleLine(line);
    }
    if (prompt) {
      this.handlePrompt(prompt);
    }
  }

  private handleLine(line: string): void {
    if (line.includes(MONITOR_ACK)) {
      if (!this.isReady()) {
        this.becomeReady();
      }
      return;
    }
    if (LOGIN_FAILURE.test(line)) {
      this.log.error('[Network] Processor rejected the login: "%s"', line);
    }
    for (const callback of this.receiveCallbacks) {
      try {
        callback(this, line);
      } catch (error) {
        this.log.error('[Network] Receive callback failed on "%s": %s', line, describe(error));
      }
    }
  }

  private handlePrompt(prompt: PromptKind): void {
    this.clearNudge();
    switch (prompt) {
      case 'login':
        if (this.credentialsSent) {
          this.log.error('[Network] Login rejected (LOGIN: prompt repeated). Check username/password in the config.');
          this.socket?.destroy();
          return;
        }
        this.state = ComState.Authenticating;
        this.credentialsSent = true;
        this.write(this.username);
        return;
      case 'password':
        if (!this.password) {
          this.log.warn('[Network] Processor asked for a password but none is configured');
        }
        this.write(this.password);
        return;
      case 'command':
        if (!this.monitoringRequested) {
          this.monitoringRequested = true;
          this.state = ComState.Establishing;
          this.log.debug('[Network] Requesting dimmer level monitoring');
          this.write(MONITOR_COMMAND);
        }
        return;
    }
  }

  private becomeReady(): void {
    this.state = ComState.Ready;
    this.reconnectDelayMs = this.options.reconnectDelayMs;
    this.log.info('[Network] Connected to %s, dimmer level monitoring active', this.host);
    this.flushQueue();
    for (const callback of this.didConnectCallbacks) {
      try {
        callback(this);
      } catch (error) {
        this.log.error('[Network] Connect callback failed: %s', describe(error));
      }
    }
  }

  // ---- outbound ----

  private write(text: string): void {
    this.socket?.write(text + CRLF);
  }

  private flushQueue(): void {
    while (this.queue.length > 0) {
      const command = this.queue.shift()!;
      this.log.debug('[Network] > %s (queued)', command);
      this.write(command);
    }
  }

  // ---- timers ----

  private armIdleTimer(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => this.onIdle(), this.options.idleTimeoutMs);
  }

  private onIdle(): void {
    if (!this.socket || this.socket.destroyed) {
      return;
    }
    if (this.pingOutstanding) {
      this.log.warn('[Network] No reply to keepalive, dropping the connection');
      this.socket.destroy(new Error('keepalive timeout'));
      return;
    }
    this.pingOutstanding = true;
    this.log.debug('[Network] Link quiet, sending keepalive');
    this.write(KEEPALIVE_COMMAND);
    this.armIdleTimer();
  }

  private armHandshakeNudge(): void {
    this.clearNudge();
    this.nudgeTimer = setTimeout(() => {
      if (this.state === ComState.Connected && this.socket && !this.socket.destroyed) {
        this.log.debug('[Network] No prompt received, sending CRLF to provoke one');
        this.socket.write(CRLF);
      }
    }, this.options.handshakeNudgeMs);
  }

  private handleClose(): void {
    this.clearTimers();
    const wasReady = this.isReady();
    this.state = ComState.Disconnected;
    if (this.shuttingDown) {
      this.log.info('[Network] Connection closed');
      return;
    }
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(delay * 2, this.options.reconnectMaxDelayMs);
    this.log.warn('[Network] Connection lost%s. Reconnecting in %d s', wasReady ? '' : ' during handshake', Math.round(delay / 1000));
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private clearNudge(): void {
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = undefined;
    }
  }

  private clearTimers(): void {
    this.clearIdle();
    this.clearNudge();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
