import { describe, it, expect } from 'vitest';
import { LineFramer, parseDlLine, fadeDimCommand, requestLevelCommand } from '../src/protocol';

describe('LineFramer', () => {
  it('delivers a complete CRLF-terminated line without the terminator', () => {
    const framer = new LineFramer();
    expect(framer.push('DL, [01:01:00:01:04], 50\r\n')).toEqual({ lines: ['DL, [01:01:00:01:04], 50'], prompt: null });
  });

  it('reassembles a line split across two chunks', () => {
    const framer = new LineFramer();
    expect(framer.push('DL, [01:01:00:')).toEqual({ lines: [], prompt: null });
    expect(framer.push('01:04], 50\r\n')).toEqual({ lines: ['DL, [01:01:00:01:04], 50'], prompt: null });
  });

  it('delivers several lines from one chunk and skips blank ones', () => {
    const framer = new LineFramer();
    expect(framer.push('DL, [1], 50\r\n\r\nDL, [2], 0\n')).toEqual({ lines: ['DL, [1], 50', 'DL, [2], 0'], prompt: null });
  });

  it('reports a trailing command prompt and still delivers the lines before it', () => {
    const framer = new LineFramer();
    expect(framer.push('DL, [1], 50\r\nLNET> ')).toEqual({ lines: ['DL, [1], 50'], prompt: 'command' });
  });

  it('recognises QNET> as a command prompt too', () => {
    const framer = new LineFramer();
    expect(framer.push('QNET> ')).toEqual({ lines: [], prompt: 'command' });
  });

  it('reports login and password prompts', () => {
    const framer = new LineFramer();
    expect(framer.push('LOGIN: ')).toEqual({ lines: [], prompt: 'login' });
    expect(framer.push('PASSWORD: ')).toEqual({ lines: [], prompt: 'password' });
  });

  it('strips a prompt echoed at the start of a line and reports it', () => {
    const framer = new LineFramer();
    expect(framer.push('LNET> DL, [1], 50\r\n')).toEqual({ lines: ['DL, [1], 50'], prompt: 'command' });
  });

  it('clears the partial buffer after reporting a prompt', () => {
    const framer = new LineFramer();
    framer.push('LNET> ');
    expect(framer.push('DL, [1], 5\r\n')).toEqual({ lines: ['DL, [1], 5'], prompt: null });
  });

  it('keeps buffering when the partial is not a prompt', () => {
    const framer = new LineFramer();
    expect(framer.push('login incorrect')).toEqual({ lines: [], prompt: null });
    expect(framer.push('\r\n')).toEqual({ lines: ['login incorrect'], prompt: null });
  });
});

describe('parseDlLine', () => {
  it('parses the bracketed address and the level', () => {
    expect(parseDlLine('DL, [01:01:00:01:04], 50')).toEqual({ address: '01:01:00:01:04', level: 50 });
  });

  it('accepts fractional levels and no spaces', () => {
    expect(parseDlLine('DL,[1:4:2:3],12.5')).toEqual({ address: '1:4:2:3', level: 12.5 });
  });

  it('returns null for lines that are not dimmer level reports', () => {
    expect(parseDlLine('KBP, [1:1:1], 3')).toBeNull();
    expect(parseDlLine('Device serial 123')).toBeNull();
  });

  it('returns null for a truncated report instead of throwing', () => {
    expect(parseDlLine('DL, [01:01:00:01:04]')).toBeNull();
    expect(parseDlLine('DL')).toBeNull();
    expect(parseDlLine('DL, [01:01:00:01:04], abc')).toBeNull();
  });
});

describe('command builders', () => {
  it('formats FADEDIM with fade time and delay zeroed', () => {
    expect(fadeDimCommand(75, '01:01:00:01:04')).toBe('FADEDIM, 75, 0, 0, 01:01:00:01:04');
  });

  it('formats a level request', () => {
    expect(requestLevelCommand('01:01:00:01:04')).toBe('RDL, 01:01:00:01:04');
  });
});
