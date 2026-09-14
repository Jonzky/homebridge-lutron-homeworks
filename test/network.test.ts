import { describe, it, expect, vi, afterEach } from 'vitest';
import { NetworkEngine, EngineOptions } from '../src/network';
import { FakeSocket } from './helpers/fakeSocket';
import { silentLogger } from './helpers/logger';

function makeEngine(options: Partial<EngineOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const log = silentLogger();
  const engine = new NetworkEngine(log, '10.0.0.5', 23, 'user', 'secret', {
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    ...options,
  });
  const socket = () => sockets[sockets.length - 1];
  const connected = () => {
    engine.connect();
    socket().emitConnect();
  };
  const ready = () => {
    connected();
    socket().receive('LNET> ');
    socket().receive('Dimmer level monitoring enabled\r\nLNET> ');
  };
  return { engine, sockets, socket, connected, ready, log };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('NetworkEngine handshake', () => {
  it('connects to the configured host and port', () => {
    const { engine, socket } = makeEngine();
    engine.connect();
    expect(socket().connectedTo).toEqual({ host: '10.0.0.5', port: 23 });
  });

  it('answers the LOGIN: prompt with the username', () => {
    const { socket, connected } = makeEngine();
    connected();
    socket().receive('LOGIN: ');
    expect(socket().writes).toEqual(['user\r\n']);
  });

  it('answers a PASSWORD: prompt with the password', () => {
    const { socket, connected } = makeEngine();
    connected();
    socket().receive('LOGIN: ');
    socket().receive('PASSWORD: ');
    expect(socket().writes).toEqual(['user\r\n', 'secret\r\n']);
  });

  it('requests dimmer level monitoring at the first command prompt after login', () => {
    const { socket, connected } = makeEngine();
    connected();
    socket().receive('LOGIN: ');
    socket().receive('login successful\r\nLNET> ');
    expect(socket().writes).toEqual(['user\r\n', 'DLMON\r\n']);
  });

  it('requests monitoring at the command prompt even when no login was asked for', () => {
    const { socket, connected } = makeEngine();
    connected();
    socket().receive('LNET> ');
    expect(socket().writes).toEqual(['DLMON\r\n']);
  });

  it('sends DLMON only once per connection', () => {
    const { socket, connected } = makeEngine();
    connected();
    socket().receive('LNET> ');
    socket().receive('LNET> ');
    socket().receive('Dimmer level monitoring enabled\r\nLNET> ');
    expect(socket().writesMatching('DLMON\r\n')).toHaveLength(1);
  });

  it('becomes ready and fires connect callbacks once monitoring is acknowledged', () => {
    const { engine, ready } = makeEngine();
    const onConnect = vi.fn();
    engine.registerDidConnectCallback(onConnect);
    ready();
    expect(engine.isReady()).toBe(true);
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('is not ready before the monitoring acknowledgement', () => {
    const { engine, socket, connected } = makeEngine();
    connected();
    socket().receive('LNET> ');
    expect(engine.isReady()).toBe(false);
  });

  it('nudges the processor with CRLF when nothing arrives after connecting', () => {
    vi.useFakeTimers();
    const { socket, connected } = makeEngine({ handshakeNudgeMs: 3000 });
    connected();
    vi.advanceTimersByTime(3000);
    expect(socket().writes).toEqual(['\r\n']);
  });

  it('does not nudge when a prompt arrived in time', () => {
    vi.useFakeTimers();
    const { socket, connected } = makeEngine({ handshakeNudgeMs: 3000 });
    connected();
    socket().receive('LOGIN: ');
    vi.advanceTimersByTime(3000);
    expect(socket().writes).toEqual(['user\r\n']);
  });

  it('treats a second LOGIN: prompt as a rejected login and drops the connection', () => {
    const { socket, connected, log } = makeEngine();
    connected();
    socket().receive('LOGIN: ');
    socket().receive('login incorrect\r\nLOGIN: ');
    expect(socket().destroyed).toBe(true);
    expect(log.error).toHaveBeenCalled();
  });
});

describe('NetworkEngine receive framing', () => {
  it('delivers each complete line to receive callbacks individually', () => {
    const { engine, socket, ready } = makeEngine();
    const lines: string[] = [];
    engine.registerReceiveCallback((_engine, line) => lines.push(line));
    ready();
    socket().receive('DL, [1], 50\r\nDL, [2], 0\r\n');
    expect(lines).toEqual(['DL, [1], 50', 'DL, [2], 0']);
  });

  it('delivers a line that arrives in the same chunk as a prompt', () => {
    const { engine, socket, ready } = makeEngine();
    const lines: string[] = [];
    engine.registerReceiveCallback((_engine, line) => lines.push(line));
    ready();
    socket().receive('DL, [1], 50\r\nLNET> ');
    expect(lines).toEqual(['DL, [1], 50']);
  });

  it('reassembles a line split across two chunks', () => {
    const { engine, socket, ready } = makeEngine();
    const lines: string[] = [];
    engine.registerReceiveCallback((_engine, line) => lines.push(line));
    ready();
    socket().receive('DL, [1');
    socket().receive('], 50\r\n');
    expect(lines).toEqual(['DL, [1], 50']);
  });

  it('does not deliver the monitoring acknowledgement as traffic', () => {
    const { engine, ready } = makeEngine();
    const lines: string[] = [];
    engine.registerReceiveCallback((_engine, line) => lines.push(line));
    ready();
    expect(lines).toEqual([]);
  });

  it('survives a receive callback that throws', () => {
    const { engine, socket, ready, log } = makeEngine();
    engine.registerReceiveCallback(() => {
      throw new Error('boom');
    });
    ready();
    expect(() => socket().receive('DL, [1], 50\r\n')).not.toThrow();
    expect(log.error).toHaveBeenCalled();
  });
});

describe('NetworkEngine sending', () => {
  it('writes the command with CRLF immediately when ready', () => {
    const { engine, socket, ready } = makeEngine();
    ready();
    engine.send('FADEDIM, 50, 0, 0, 1');
    expect(socket().writes.at(-1)).toBe('FADEDIM, 50, 0, 0, 1\r\n');
  });

  it('queues commands sent before ready and flushes them in order once ready', () => {
    const { engine, socket, connected } = makeEngine();
    connected();
    engine.send('FADEDIM, 50, 0, 0, 1');
    engine.send('FADEDIM, 0, 0, 0, 2');
    expect(socket().writes).toEqual([]);
    socket().receive('LNET> ');
    socket().receive('Dimmer level monitoring enabled\r\nLNET> ');
    expect(socket().writes).toEqual(['DLMON\r\n', 'FADEDIM, 50, 0, 0, 1\r\n', 'FADEDIM, 0, 0, 0, 2\r\n']);
  });

  it('keeps only the most recent commands when the queue is full', () => {
    const { engine, socket, connected } = makeEngine({ maxQueuedCommands: 2 });
    connected();
    engine.send('A');
    engine.send('B');
    engine.send('C');
    socket().receive('LNET> ');
    socket().receive('Dimmer level monitoring enabled\r\nLNET> ');
    expect(socket().writes).toEqual(['DLMON\r\n', 'B\r\n', 'C\r\n']);
  });

  it('queues rather than writes while disconnected', () => {
    const { engine, socket, ready } = makeEngine();
    ready();
    socket().emitClose();
    engine.send('FADEDIM, 50, 0, 0, 1');
    expect(socket().writesMatching('FADEDIM, 50, 0, 0, 1\r\n')).toHaveLength(0);
  });
});

describe('NetworkEngine keepalive', () => {
  it('sends PINFO after the idle period with no traffic', () => {
    vi.useFakeTimers();
    const { socket, ready } = makeEngine({ idleTimeoutMs: 40000 });
    ready();
    vi.advanceTimersByTime(40000);
    expect(socket().writes.at(-1)).toBe('PINFO\r\n');
  });

  it('destroys the socket when a second idle period passes without any reply', () => {
    vi.useFakeTimers();
    const { socket, ready } = makeEngine({ idleTimeoutMs: 40000 });
    ready();
    vi.advanceTimersByTime(40000);
    expect(socket().destroyed).toBe(false);
    vi.advanceTimersByTime(40000);
    expect(socket().destroyed).toBe(true);
  });

  it('does not ping while traffic keeps arriving', () => {
    vi.useFakeTimers();
    const { socket, ready } = makeEngine({ idleTimeoutMs: 40000 });
    ready();
    vi.advanceTimersByTime(30000);
    socket().receive('DL, [1], 1\r\n');
    vi.advanceTimersByTime(30000);
    expect(socket().writesMatching('PINFO\r\n')).toHaveLength(0);
  });

  it('is satisfied by any reply to the ping', () => {
    vi.useFakeTimers();
    const { socket, ready } = makeEngine({ idleTimeoutMs: 40000 });
    ready();
    vi.advanceTimersByTime(40000);
    socket().receive('P001 some processor info\r\nLNET> ');
    vi.advanceTimersByTime(40000);
    expect(socket().destroyed).toBe(false);
    expect(socket().writesMatching('PINFO\r\n')).toHaveLength(2);
  });
});

describe('NetworkEngine reconnect', () => {
  it('reconnects with a fresh socket after the reconnect delay', () => {
    vi.useFakeTimers();
    const { sockets, socket, ready } = makeEngine({ reconnectDelayMs: 5000 });
    ready();
    socket().emitClose();
    vi.advanceTimersByTime(4999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].connectedTo).toEqual({ host: '10.0.0.5', port: 23 });
  });

  it('re-runs the handshake on the new socket', () => {
    vi.useFakeTimers();
    const { engine, sockets, socket, ready } = makeEngine({ reconnectDelayMs: 5000 });
    ready();
    socket().emitClose();
    vi.advanceTimersByTime(5000);
    expect(engine.isReady()).toBe(false);
    sockets[1].emitConnect();
    sockets[1].receive('LOGIN: ');
    expect(sockets[1].writes).toEqual(['user\r\n']);
  });

  it('doubles the delay on repeated failures up to the maximum', () => {
    vi.useFakeTimers();
    const { sockets, socket, connected } = makeEngine({ reconnectDelayMs: 5000, reconnectMaxDelayMs: 12000 });
    connected();
    socket().emitClose();
    vi.advanceTimersByTime(5000);
    expect(sockets).toHaveLength(2);
    socket().emitClose();
    vi.advanceTimersByTime(9999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    socket().emitClose();
    vi.advanceTimersByTime(12000);
    expect(sockets).toHaveLength(4);
  });

  it('resets the delay after a successful connection', () => {
    vi.useFakeTimers();
    const { sockets, socket, connected } = makeEngine({ reconnectDelayMs: 5000, reconnectMaxDelayMs: 60000 });
    connected();
    socket().emitClose();
    vi.advanceTimersByTime(5000);
    socket().emitClose();
    vi.advanceTimersByTime(10000);
    expect(sockets).toHaveLength(3);
    socket().emitConnect();
    socket().receive('LNET> ');
    socket().receive('Dimmer level monitoring enabled\r\nLNET> ');
    socket().emitClose();
    vi.advanceTimersByTime(5000);
    expect(sockets).toHaveLength(4);
  });

  it('ignores events from a socket it has already replaced', () => {
    vi.useFakeTimers();
    const { sockets, socket, ready } = makeEngine({ reconnectDelayMs: 5000 });
    ready();
    const old = socket();
    old.emitClose();
    vi.advanceTimersByTime(5000);
    old.emitClose();
    vi.advanceTimersByTime(60000);
    expect(sockets).toHaveLength(2);
  });

  it('stops the keepalive timer when the connection closes', () => {
    vi.useFakeTimers();
    const { socket, ready } = makeEngine({ idleTimeoutMs: 40000, reconnectDelayMs: 500000 });
    ready();
    const old = socket();
    old.emitClose();
    vi.advanceTimersByTime(100000);
    expect(old.writesMatching('PINFO\r\n')).toHaveLength(0);
  });

  it('stops reconnecting after shutdown', () => {
    vi.useFakeTimers();
    const { engine, sockets, socket, ready } = makeEngine({ reconnectDelayMs: 5000 });
    ready();
    engine.shutdown();
    expect(socket().ended).toBe(true);
    socket().emitClose();
    vi.advanceTimersByTime(60000);
    expect(sockets).toHaveLength(1);
  });
});
