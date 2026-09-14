import { describe, it, expect, vi, afterEach } from 'vitest';
import { LightController, ShadeController } from '../src/controllers';

afterEach(() => {
  vi.useRealTimers();
});

function makeLight(dimmable: boolean, options: { onDebounceMs?: number } = {}) {
  const sent: number[] = [];
  const published: Array<{ on: boolean; brightness: number }> = [];
  const controller = new LightController(dimmable, {
    sendLevel: level => sent.push(level),
    publish: state => published.push({ ...state }),
  }, options);
  return { controller, sent, published };
}

describe('LightController', () => {
  it('turning a non-dimmable light on sends 100 immediately', () => {
    const { controller, sent } = makeLight(false);
    controller.homeKitSetOn(true);
    expect(sent).toEqual([100]);
    expect(controller.state).toEqual({ on: true, brightness: 100 });
  });

  it('turning a dimmable light on restores the last brightness once the debounce window passes', () => {
    vi.useFakeTimers();
    const { controller, sent } = makeLight(true, { onDebounceMs: 50 });
    controller.processorLevel(40);
    controller.homeKitSetOn(false);
    controller.homeKitSetOn(true);
    expect(sent).toEqual([0]);
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([0, 40]);
  });

  it('restores 100 when the light has never been seen on', () => {
    vi.useFakeTimers();
    const { controller, sent } = makeLight(true, { onDebounceMs: 50 });
    controller.homeKitSetOn(true);
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([100]);
  });

  it('a brightness set inside the debounce window replaces the restore so only one command goes out', () => {
    vi.useFakeTimers();
    const { controller, sent } = makeLight(true, { onDebounceMs: 50 });
    controller.homeKitSetOn(true);
    controller.homeKitSetBrightness(70);
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([70]);
    expect(controller.state).toEqual({ on: true, brightness: 70 });
  });

  it('turning off sends 0 immediately and cancels a pending restore', () => {
    vi.useFakeTimers();
    const { controller, sent } = makeLight(true, { onDebounceMs: 50 });
    controller.homeKitSetOn(true);
    controller.homeKitSetOn(false);
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([0]);
    expect(controller.state).toEqual({ on: false, brightness: 0 });
  });

  it('turning on a light that is already on sends nothing', () => {
    const { controller, sent } = makeLight(true);
    controller.processorLevel(55);
    controller.homeKitSetOn(true);
    expect(sent).toEqual([]);
  });

  it('a brightness set while on sends that level and remembers it', () => {
    vi.useFakeTimers();
    const { controller, sent } = makeLight(true, { onDebounceMs: 50 });
    controller.processorLevel(55);
    controller.homeKitSetBrightness(80);
    expect(sent).toEqual([80]);
    controller.homeKitSetOn(false);
    controller.homeKitSetOn(true);
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([80, 0, 80]);
  });

  it('a brightness set to 0 turns the light off without forgetting the last level', () => {
    vi.useFakeTimers();
    const { controller, sent } = makeLight(true, { onDebounceMs: 50 });
    controller.processorLevel(60);
    controller.homeKitSetBrightness(0);
    expect(controller.state).toEqual({ on: false, brightness: 0 });
    controller.homeKitSetOn(true);
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([0, 60]);
  });

  it('a processor report updates the state and publishes it to HomeKit', () => {
    const { controller, published } = makeLight(true);
    controller.processorLevel(60);
    expect(controller.state).toEqual({ on: true, brightness: 60 });
    expect(published).toEqual([{ on: true, brightness: 60 }]);
  });

  it('a processor report of 0 publishes off', () => {
    const { controller, published } = makeLight(true);
    controller.processorLevel(60);
    controller.processorLevel(0);
    expect(published.at(-1)).toEqual({ on: false, brightness: 0 });
  });

  it('a processor report that matches the current state publishes nothing', () => {
    const { controller, published } = makeLight(true);
    controller.processorLevel(60);
    controller.processorLevel(60);
    expect(published).toHaveLength(1);
  });

  it('a processor report cancels a pending restore', () => {
    vi.useFakeTimers();
    const { controller, sent } = makeLight(true, { onDebounceMs: 50 });
    controller.homeKitSetOn(true);
    controller.processorLevel(30);
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([]);
  });
});

function makeShade(options: { settleMs?: number } = {}) {
  const sent: number[] = [];
  const published: Array<{ current: number; target: number; motion: string }> = [];
  const controller = new ShadeController({
    sendLevel: level => sent.push(level),
    publish: state => published.push({ ...state }),
  }, options);
  return { controller, sent, published };
}

describe('ShadeController', () => {
  it('setting a higher target sends the level and reports increasing', () => {
    const { controller, sent, published } = makeShade();
    controller.homeKitSetTarget(80);
    expect(sent).toEqual([80]);
    expect(controller.state).toEqual({ current: 0, target: 80, motion: 'increasing' });
    expect(published.at(-1)).toEqual({ current: 0, target: 80, motion: 'increasing' });
  });

  it('setting a lower target reports decreasing', () => {
    const { controller } = makeShade();
    controller.processorLevel(100);
    controller.homeKitSetTarget(20);
    expect(controller.state.motion).toBe('decreasing');
  });

  it('setting the current position as the target still sends it but stays stopped', () => {
    const { controller, sent } = makeShade();
    controller.processorLevel(50);
    controller.homeKitSetTarget(50);
    expect(sent).toEqual([50]);
    expect(controller.state.motion).toBe('stopped');
  });

  it('a processor report equal to the target marks the shade stopped', () => {
    const { controller, published } = makeShade();
    controller.homeKitSetTarget(80);
    controller.processorLevel(80);
    expect(controller.state).toEqual({ current: 80, target: 80, motion: 'stopped' });
    expect(published.at(-1)).toEqual({ current: 80, target: 80, motion: 'stopped' });
  });

  it('a processor report while stopped moves both current and target, as the shade was moved elsewhere', () => {
    const { controller } = makeShade();
    controller.processorLevel(35);
    expect(controller.state).toEqual({ current: 35, target: 35, motion: 'stopped' });
  });

  it('a processor report that differs from the target during motion updates current only', () => {
    const { controller } = makeShade();
    controller.homeKitSetTarget(80);
    controller.processorLevel(40);
    expect(controller.state).toEqual({ current: 40, target: 80, motion: 'increasing' });
  });

  it('settles at the target if the processor never confirms', () => {
    vi.useFakeTimers();
    const { controller, published } = makeShade({ settleMs: 30000 });
    controller.homeKitSetTarget(80);
    vi.advanceTimersByTime(30000);
    expect(controller.state).toEqual({ current: 80, target: 80, motion: 'stopped' });
    expect(published.at(-1)).toEqual({ current: 80, target: 80, motion: 'stopped' });
  });

  it('a confirmation cancels the settle timer so nothing is published twice', () => {
    vi.useFakeTimers();
    const { controller, published } = makeShade({ settleMs: 30000 });
    controller.homeKitSetTarget(80);
    controller.processorLevel(80);
    const count = published.length;
    vi.advanceTimersByTime(60000);
    expect(published).toHaveLength(count);
  });
});

import { BlindController } from '../src/controllers';

function makeBlind(options: { motionTimeoutMs?: number } = {}) {
  const sent: number[] = [];
  const published: string[] = [];
  const controller = new BlindController({ raise: 16, lower: 35, stop: 0 }, {
    sendLevel: level => sent.push(level),
    publish: state => published.push(state.motion),
  }, options);
  return { controller, sent, published };
}

describe('BlindController', () => {
  it('raise sends the raise code and reports raising', () => {
    const { controller, sent, published } = makeBlind();
    controller.homeKitRaise();
    expect(sent).toEqual([16]);
    expect(controller.state.motion).toBe('raising');
    expect(published).toEqual(['raising']);
  });

  it('lower sends the lower code and reports lowering', () => {
    const { controller, sent } = makeBlind();
    controller.homeKitLower();
    expect(sent).toEqual([35]);
    expect(controller.state.motion).toBe('lowering');
  });

  it('stop sends the stop code and reports stopped', () => {
    const { controller, sent, published } = makeBlind();
    controller.homeKitRaise();
    controller.homeKitStop();
    expect(sent).toEqual([16, 0]);
    expect(published).toEqual(['raising', 'stopped']);
  });

  it('a processor report of the raise code reports raising without sending anything', () => {
    const { controller, sent, published } = makeBlind();
    controller.processorLevel(16);
    expect(sent).toEqual([]);
    expect(published).toEqual(['raising']);
  });

  it('a processor report of the stop code reports stopped', () => {
    const { controller, published } = makeBlind();
    controller.processorLevel(35);
    controller.processorLevel(0);
    expect(published).toEqual(['lowering', 'stopped']);
  });

  it('a processor report of an unknown code is ignored', () => {
    const { controller, published } = makeBlind();
    controller.processorLevel(50);
    expect(controller.state.motion).toBe('stopped');
    expect(published).toEqual([]);
  });

  it('a processor report matching the current motion publishes nothing', () => {
    const { controller, published } = makeBlind();
    controller.homeKitRaise();
    controller.processorLevel(16);
    expect(published).toEqual(['raising']);
  });

  it('motion resets to stopped after the motion timeout without sending a command', () => {
    vi.useFakeTimers();
    const { controller, sent, published } = makeBlind({ motionTimeoutMs: 60000 });
    controller.homeKitLower();
    vi.advanceTimersByTime(60000);
    expect(controller.state.motion).toBe('stopped');
    expect(published).toEqual(['lowering', 'stopped']);
    expect(sent).toEqual([35]);
  });

  it('a stop from the processor cancels the motion timeout', () => {
    vi.useFakeTimers();
    const { controller, published } = makeBlind({ motionTimeoutMs: 60000 });
    controller.homeKitLower();
    controller.processorLevel(0);
    vi.advanceTimersByTime(120000);
    expect(published).toEqual(['lowering', 'stopped']);
  });
});
