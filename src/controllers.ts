/**
 * Device state machines with no HomeKit or socket dependencies. The accessory
 * classes in homeworksAccessory.ts wrap these and translate to HAP characteristics.
 */

// ---------------------------------------------------------------- lights

export interface LightState {
  on: boolean;
  brightness: number;
}

export interface LightOutput {
  /** Send a dimmer level (0-100) to the processor. */
  sendLevel(level: number): void;
  /** Push state to HomeKit after it changed. */
  publish(state: LightState): void;
}

export interface LightOptions {
  /**
   * When HomeKit turns a dimmable light on it often sends On followed by
   * Brightness in the same transaction. Waiting this long before restoring the
   * previous level lets that Brightness win, so the load does not flash to a
   * different level first.
   */
  onDebounceMs?: number;
}

export class LightController {
  readonly state: LightState = { on: false, brightness: 0 };
  private lastBrightness = 100;
  private pendingOn: ReturnType<typeof setTimeout> | undefined;
  private readonly debounceMs: number;

  constructor(
    private readonly dimmable: boolean,
    private readonly output: LightOutput,
    options: LightOptions = {},
  ) {
    this.debounceMs = options.onDebounceMs ?? 50;
  }

  homeKitSetOn(on: boolean): void {
    if (!on) {
      this.cancelPendingOn();
      this.apply(0);
      this.output.sendLevel(0);
      return;
    }
    if (this.state.on) {
      return;
    }
    if (!this.dimmable) {
      this.apply(100);
      this.output.sendLevel(100);
      return;
    }
    this.cancelPendingOn();
    this.apply(this.lastBrightness);
    this.pendingOn = setTimeout(() => {
      this.pendingOn = undefined;
      this.output.sendLevel(this.state.brightness);
    }, this.debounceMs);
  }

  homeKitSetBrightness(level: number): void {
    this.cancelPendingOn();
    this.apply(level);
    this.output.sendLevel(level);
  }

  /** Level reported by the processor (DL line or RDL reply). */
  processorLevel(level: number): void {
    this.cancelPendingOn();
    this.apply(level);
  }

  dispose(): void {
    this.cancelPendingOn();
  }

  private apply(level: number): void {
    const on = level > 0;
    if (on) {
      this.lastBrightness = level;
    }
    if (this.state.on === on && this.state.brightness === level) {
      return;
    }
    this.state.on = on;
    this.state.brightness = level;
    this.output.publish({ ...this.state });
  }

  private cancelPendingOn(): void {
    if (this.pendingOn) {
      clearTimeout(this.pendingOn);
      this.pendingOn = undefined;
    }
  }
}

// ---------------------------------------------------------------- shades

export type ShadeMotion = 'decreasing' | 'increasing' | 'stopped';

export interface ShadeState {
  current: number;
  target: number;
  motion: ShadeMotion;
}

export interface ShadeOutput {
  sendLevel(level: number): void;
  publish(state: ShadeState): void;
}

export interface ShadeOptions {
  /** If the processor never confirms the target, assume it was reached after this long. */
  settleMs?: number;
}

/**
 * A shade driven as a dimmer: the level is the position. The processor reports
 * the new level once the move completes, which is when the shade is marked stopped.
 */
export class ShadeController {
  readonly state: ShadeState = { current: 0, target: 0, motion: 'stopped' };
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly settleMs: number;

  constructor(private readonly output: ShadeOutput, options: ShadeOptions = {}) {
    this.settleMs = options.settleMs ?? 30_000;
  }

  homeKitSetTarget(target: number): void {
    this.state.target = target;
    if (target > this.state.current) {
      this.state.motion = 'increasing';
    } else if (target < this.state.current) {
      this.state.motion = 'decreasing';
    } else {
      this.state.motion = 'stopped';
    }
    this.output.sendLevel(target);
    this.publish();

    this.clearSettle();
    if (this.state.motion !== 'stopped') {
      this.settleTimer = setTimeout(() => {
        this.settleTimer = undefined;
        this.state.current = this.state.target;
        this.state.motion = 'stopped';
        this.publish();
      }, this.settleMs);
    }
  }

  processorLevel(level: number): void {
    if (this.state.motion === 'stopped') {
      if (level === this.state.current && level === this.state.target) {
        return;
      }
      // Moved from a keypad or another app: follow it.
      this.state.current = level;
      this.state.target = level;
      this.publish();
      return;
    }
    this.state.current = level;
    if (level === this.state.target) {
      this.state.motion = 'stopped';
      this.clearSettle();
    }
    this.publish();
  }

  dispose(): void {
    this.clearSettle();
  }

  private publish(): void {
    this.output.publish({ ...this.state });
  }

  private clearSettle(): void {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = undefined;
    }
  }
}
