/**
 * Pure helpers for the HomeWorks (Illumination-era) telnet integration protocol.
 * Nothing in this module touches a socket, so it is unit tested directly.
 */

export type PromptKind = 'login' | 'password' | 'command';

export interface FramedChunk {
  /** Complete, trimmed, non-empty lines extracted from the stream. */
  lines: string[];
  /** A prompt the processor is now waiting at, if one was seen in this chunk. */
  prompt: PromptKind | null;
}

/** Sent once per connection to enable unsolicited `DL` level reports. */
export const MONITOR_COMMAND = 'DLMON';
/** Substring of the processor's acknowledgement of MONITOR_COMMAND. */
export const MONITOR_ACK = 'Dimmer level monitoring';
/** Cheap query used as a keepalive; any reply proves the link is alive. */
export const KEEPALIVE_COMMAND = 'PINFO';

const PROMPTS: ReadonlyArray<{ token: string; kind: PromptKind }> = [
  { token: 'LOGIN:', kind: 'login' },
  { token: 'PASSWORD:', kind: 'password' },
  { token: 'LNET>', kind: 'command' },
  { token: 'QNET>', kind: 'command' },
];

/** Prompts are not newline-terminated: they show up as the trailing partial of a chunk. */
function trailingPrompt(partial: string): PromptKind | null {
  const trimmed = partial.trim();
  for (const prompt of PROMPTS) {
    if (trimmed.endsWith(prompt.token)) {
      return prompt.kind;
    }
  }
  return null;
}

/**
 * Unsolicited traffic can be printed straight after a pending command prompt,
 * which leaves the prompt glued to the front of the line.
 * Only command prompts are stripped; LOGIN:/PASSWORD: never precede traffic.
 */
function stripLeadingCommandPrompt(line: string): { line: string; prompt: PromptKind | null } {
  for (const prompt of PROMPTS) {
    if (prompt.kind === 'command' && line.startsWith(prompt.token)) {
      return { line: line.slice(prompt.token.length).trim(), prompt: prompt.kind };
    }
  }
  return { line, prompt: null };
}

/**
 * Reassembles a TCP byte stream into protocol lines and prompt events.
 * One instance per connection; feed it every chunk in order.
 */
export class LineFramer {
  private buffer = '';

  push(chunk: string): FramedChunk {
    this.buffer += chunk;
    const lines: string[] = [];
    let prompt: PromptKind | null = null;

    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const raw = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const stripped = stripLeadingCommandPrompt(raw);
      if (stripped.prompt) {
        prompt = stripped.prompt;
      }
      if (stripped.line !== '') {
        lines.push(stripped.line);
      }
      newlineIndex = this.buffer.indexOf('\n');
    }

    const trailing = trailingPrompt(this.buffer);
    if (trailing) {
      prompt = trailing;
      this.buffer = '';
    }

    return { lines, prompt };
  }
}

export interface DimmerLevelReport {
  /** Processor address exactly as reported, brackets removed (e.g. `01:01:00:01:04`). */
  address: string;
  level: number;
}

const DL_PATTERN = /^DL\s*,\s*\[?\s*([^\],\s]+)\s*\]?\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

/** Parses a `DL, [address], level` report. Returns null for anything else, never throws. */
export function parseDlLine(line: string): DimmerLevelReport | null {
  const match = DL_PATTERN.exec(line);
  if (!match) {
    return null;
  }
  return { address: match[1], level: Number(match[2]) };
}

/** `FADEDIM, level, fadeSeconds, delaySeconds, address` with an instant fade. */
export function fadeDimCommand(level: number, integrationId: string): string {
  return `FADEDIM, ${level}, 0, 0, ${integrationId}`;
}

/** Asks the processor to report the current level of one zone as a `DL` line. */
export function requestLevelCommand(integrationId: string): string {
  return `RDL, ${integrationId}`;
}
