import { describe, it, expect, vi, afterEach } from 'vitest';
import { Accessory, Service, Characteristic, uuid } from '@homebridge/hap-nodejs';
import { HomeworksAccessory } from '../src/homeworksAccessory';
import { silentLogger } from './helpers/logger';

afterEach(() => {
  vi.useRealTimers();
});

type AnyDevice = Record<string, unknown>;

function build(device: AnyDevice, existing?: Accessory) {
  const accessory = existing ?? new Accessory(device.name as string, uuid.generate(device.integrationID as string));
  (accessory as unknown as { context: unknown }).context = { device };
  const sent: number[] = [];
  const host = { Service, Characteristic, log: silentLogger() };
  // The host and accessory are structurally what the classes need; the casts keep the test free of Homebridge's runtime.
  const hwa = HomeworksAccessory.CreateAccessory(
    host as unknown as Parameters<typeof HomeworksAccessory.CreateAccessory>[0],
    accessory as unknown as Parameters<typeof HomeworksAccessory.CreateAccessory>[1],
    accessory.UUID,
    device as unknown as Parameters<typeof HomeworksAccessory.CreateAccessory>[3],
  );
  hwa.onSendLevel = level => sent.push(level);
  return { hwa, accessory, sent };
}

function light(isDimmable: boolean, existing?: Accessory) {
  const built = build({ name: 'Kitchen', integrationID: '01:01:00:01:04', deviceType: 'light', isDimmable }, existing);
  const service = built.accessory.getService(Service.Lightbulb)!;
  return { ...built, service };
}

describe('HomeworksLightAccessory', () => {
  it('exposes a Lightbulb with On but without Brightness when not dimmable', () => {
    const { service } = light(false);
    expect(service.testCharacteristic(Characteristic.On)).toBe(true);
    expect(service.testCharacteristic(Characteristic.Brightness)).toBe(false);
  });

  it('removes a stale Brightness characteristic left on a cached non-dimmable light', () => {
    const cached = new Accessory('Kitchen', uuid.generate('01:01:00:01:04'));
    cached.addService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness);
    const { service } = light(false, cached);
    expect(service.testCharacteristic(Characteristic.Brightness)).toBe(false);
  });

  it('exposes Brightness when dimmable', () => {
    const { service } = light(true);
    expect(service.testCharacteristic(Characteristic.Brightness)).toBe(true);
  });

  it('sends 100 when HomeKit turns a non-dimmable light on', async () => {
    const { service, sent } = light(false);
    await service.getCharacteristic(Characteristic.On).handleSetRequest(true);
    expect(sent).toEqual([100]);
  });

  it('sends the brightness when HomeKit sets it on a dimmable light', async () => {
    const { service, sent } = light(true);
    await service.getCharacteristic(Characteristic.Brightness).handleSetRequest(35);
    expect(sent).toEqual([35]);
  });

  it('updates On and Brightness values from a processor level report', () => {
    const { hwa, service } = light(true);
    hwa.handleProcessorLevel(60);
    expect(service.getCharacteristic(Characteristic.On).value).toBe(true);
    expect(service.getCharacteristic(Characteristic.Brightness).value).toBe(60);
  });

  it('updates On from a processor report on a non-dimmable light without adding Brightness', () => {
    const { hwa, service } = light(false);
    hwa.handleProcessorLevel(100);
    expect(service.getCharacteristic(Characteristic.On).value).toBe(true);
    expect(service.testCharacteristic(Characteristic.Brightness)).toBe(false);
  });

  it('answers a HomeKit read with the last known state', async () => {
    const { hwa, service } = light(true);
    hwa.handleProcessorLevel(42);
    expect(await service.getCharacteristic(Characteristic.Brightness).handleGetRequest()).toBe(42);
    expect(await service.getCharacteristic(Characteristic.On).handleGetRequest()).toBe(true);
  });

  it('sets the AccessoryInformation serial number to the integration ID', () => {
    const { accessory } = light(true);
    const info = accessory.getService(Service.AccessoryInformation)!;
    expect(info.getCharacteristic(Characteristic.SerialNumber).value).toBe('01:01:00:01:04');
  });
});

function shade(existing?: Accessory) {
  const built = build({ name: 'Blind', integrationID: '01:01:00:02:01', deviceType: 'shade', isDimmable: false }, existing);
  const service = built.accessory.getService(Service.WindowCovering)!;
  return { ...built, service };
}

describe('HomeworksShadeAccessory', () => {
  it('exposes a WindowCovering that starts stopped', () => {
    const { service } = shade();
    expect(service.getCharacteristic(Characteristic.PositionState).value).toBe(Characteristic.PositionState.STOPPED);
  });

  it('sends the target and reports increasing until the processor confirms', async () => {
    const { hwa, service, sent } = shade();
    await service.getCharacteristic(Characteristic.TargetPosition).handleSetRequest(80);
    expect(sent).toEqual([80]);
    expect(service.getCharacteristic(Characteristic.PositionState).value).toBe(Characteristic.PositionState.INCREASING);
    hwa.handleProcessorLevel(80);
    expect(service.getCharacteristic(Characteristic.CurrentPosition).value).toBe(80);
    expect(service.getCharacteristic(Characteristic.PositionState).value).toBe(Characteristic.PositionState.STOPPED);
  });

  it('follows a move made from a keypad', () => {
    const { hwa, service } = shade();
    hwa.handleProcessorLevel(25);
    expect(service.getCharacteristic(Characteristic.CurrentPosition).value).toBe(25);
    expect(service.getCharacteristic(Characteristic.TargetPosition).value).toBe(25);
  });
});

function blind(existing?: Accessory) {
  const built = build({
    name: 'Study', integrationID: '01:01:00:03:01', deviceType: 'blind', isDimmable: false,
    blindLevels: { raise: 16, lower: 35, stop: 0 },
  }, existing);
  const sw = (subtype: string) => built.accessory.getServiceById(Service.Switch, subtype)!;
  return { ...built, raise: sw('raise'), lower: sw('lower'), stop: sw('stop') };
}

describe('HomeworksBlindAccessory', () => {
  it('exposes three switches named Raise, Lower and Stop', () => {
    const { raise, lower, stop } = blind();
    expect(raise.getCharacteristic(Characteristic.Name).value).toBe('Raise');
    expect(lower.getCharacteristic(Characteristic.Name).value).toBe('Lower');
    expect(stop.getCharacteristic(Characteristic.Name).value).toBe('Stop');
  });

  it('sets ConfiguredName so the Home app shows the switch names', () => {
    const { raise, lower, stop } = blind();
    expect(raise.getCharacteristic(Characteristic.ConfiguredName).value).toBe('Raise');
    expect(lower.getCharacteristic(Characteristic.ConfiguredName).value).toBe('Lower');
    expect(stop.getCharacteristic(Characteristic.ConfiguredName).value).toBe('Stop');
  });

  it('keeps a ConfiguredName the user changed in the Home app', () => {
    const cached = new Accessory('Study', uuid.generate('01:01:00:03:01'));
    const renamed = cached.addService(Service.Switch, 'Raise', 'raise');
    renamed.addOptionalCharacteristic(Characteristic.ConfiguredName);
    renamed.setCharacteristic(Characteristic.ConfiguredName, 'Up');
    const { raise } = blind(cached);
    expect(raise.getCharacteristic(Characteristic.ConfiguredName).value).toBe('Up');
  });

  it('turning the Raise switch on sends the raise code and turning it off sends stop', async () => {
    const { raise, sent } = blind();
    await raise.getCharacteristic(Characteristic.On).handleSetRequest(true);
    await raise.getCharacteristic(Characteristic.On).handleSetRequest(false);
    expect(sent).toEqual([16, 0]);
  });

  it('turning the Lower switch on sends the lower code', async () => {
    const { lower, sent } = blind();
    await lower.getCharacteristic(Characteristic.On).handleSetRequest(true);
    expect(sent).toEqual([35]);
  });

  it('the Stop switch sends the stop code and springs back off', async () => {
    vi.useFakeTimers();
    const { stop, sent } = blind();
    await stop.getCharacteristic(Characteristic.On).handleSetRequest(true);
    expect(sent).toEqual([0]);
    vi.advanceTimersByTime(1000);
    expect(stop.getCharacteristic(Characteristic.On).value).toBe(false);
  });

  it('a processor report of the lower code turns the Lower switch on and the Raise switch off', () => {
    const { hwa, raise, lower } = blind();
    hwa.handleProcessorLevel(16);
    expect(raise.getCharacteristic(Characteristic.On).value).toBe(true);
    hwa.handleProcessorLevel(35);
    expect(raise.getCharacteristic(Characteristic.On).value).toBe(false);
    expect(lower.getCharacteristic(Characteristic.On).value).toBe(true);
  });

  it('removes a stale Lightbulb service when a cached accessory becomes a blind', () => {
    const cached = new Accessory('Study', uuid.generate('01:01:00:03:01'));
    cached.addService(Service.Lightbulb);
    const { accessory } = blind(cached);
    expect(accessory.getService(Service.Lightbulb)).toBeUndefined();
  });
});
