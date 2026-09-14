import { describe, it, expect } from 'vitest';
import { normalizeConfiguration } from '../src/config';

const HOST = '10.0.0.5';

describe('normalizeConfiguration', () => {
  it('applies defaults for port, credentials and devices', () => {
    const result = normalizeConfiguration({ host: HOST });
    expect(result.problems).toEqual([]);
    expect(result.configuration).toEqual({ host: HOST, apiPort: 23, username: '', password: '', devices: [] });
  });

  it('rejects a missing host', () => {
    const result = normalizeConfiguration({ apiPort: 23 });
    expect(result.configuration).toBeNull();
    expect(result.problems.join(' ')).toMatch(/host/);
  });

  it('accepts a numeric string port, as the config generator emits', () => {
    const result = normalizeConfiguration({ host: HOST, apiPort: '2323' });
    expect(result.configuration?.apiPort).toBe(2323);
  });

  it('rejects a port that is not a number or is out of range', () => {
    expect(normalizeConfiguration({ host: HOST, apiPort: 'abc' }).configuration).toBeNull();
    expect(normalizeConfiguration({ host: HOST, apiPort: 70000 }).configuration).toBeNull();
    expect(normalizeConfiguration({ host: HOST, apiPort: 'abc' }).problems.join(' ')).toMatch(/port/i);
  });

  it('treats a light with isDimmable omitted as not dimmable', () => {
    const result = normalizeConfiguration({ host: HOST, devices: [{ name: 'Kitchen', integrationID: '01:01:00:01:04' }] });
    expect(result.configuration?.devices).toEqual([
      { name: 'Kitchen', integrationID: '01:01:00:01:04', deviceType: 'light', isDimmable: false },
    ]);
  });

  it('keeps isDimmable true only when it is literally true', () => {
    const devices = [
      { name: 'A', integrationID: '1', isDimmable: true },
      { name: 'B', integrationID: '2', isDimmable: 'yes' },
    ];
    const result = normalizeConfiguration({ host: HOST, devices });
    expect(result.configuration?.devices.map(d => d.isDimmable)).toEqual([true, false]);
  });

  it('coerces a numeric integrationID to a trimmed string', () => {
    const devices = [{ name: 'A', integrationID: 70 }, { name: 'B', integrationID: ' 71 ' }];
    const result = normalizeConfiguration({ host: HOST, devices });
    expect(result.configuration?.devices.map(d => d.integrationID)).toEqual(['70', '71']);
  });

  it('skips devices without a name or integration ID and reports each one', () => {
    const devices = [{ integrationID: '1' }, { name: 'NoId' }, { name: '', integrationID: '2' }];
    const result = normalizeConfiguration({ host: HOST, devices });
    expect(result.configuration?.devices).toEqual([]);
    expect(result.warnings).toHaveLength(3);
  });

  it('skips a device whose integration ID was already used and reports it', () => {
    const devices = [{ name: 'A', integrationID: '1' }, { name: 'B', integrationID: '1' }];
    const result = normalizeConfiguration({ host: HOST, devices });
    expect(result.configuration?.devices.map(d => d.name)).toEqual(['A']);
    expect(result.warnings.join(' ')).toMatch(/B/);
  });

  it('accepts shade as a device type and falls back to light for unknown types with a warning', () => {
    const devices = [{ name: 'Blind', integrationID: '1', deviceType: 'shade' }, { name: 'Odd', integrationID: '2', deviceType: 'fan' }];
    const result = normalizeConfiguration({ host: HOST, devices });
    expect(result.configuration?.devices.map(d => d.deviceType)).toEqual(['shade', 'light']);
    expect(result.warnings.join(' ')).toMatch(/Odd/);
  });

  it('rejects a devices value that is not an array', () => {
    const result = normalizeConfiguration({ host: HOST, devices: { name: 'A' } });
    expect(result.configuration).toBeNull();
    expect(result.problems.join(' ')).toMatch(/devices/);
  });

  it('rejects a config that is not an object', () => {
    expect(normalizeConfiguration(null).configuration).toBeNull();
    expect(normalizeConfiguration('x').configuration).toBeNull();
  });
});

describe('normalizeConfiguration for blinds', () => {
  it('accepts blind as a device type with the default raise, lower and stop codes', () => {
    const result = normalizeConfiguration({ host: HOST, devices: [{ name: 'Study', integrationID: '1', deviceType: 'blind' }] });
    expect(result.configuration?.devices[0]).toEqual({
      name: 'Study', integrationID: '1', deviceType: 'blind', isDimmable: false, blindLevels: { raise: 16, lower: 35, stop: 0 },
    });
  });

  it('accepts custom blind codes, including numeric strings', () => {
    const device = { name: 'Study', integrationID: '1', deviceType: 'blind', raiseLevel: '20', lowerLevel: 40, stopLevel: 1 };
    const result = normalizeConfiguration({ host: HOST, devices: [device] });
    expect(result.configuration?.devices[0].blindLevels).toEqual({ raise: 20, lower: 40, stop: 1 });
  });

  it('falls back to the default code with a warning when a blind code is invalid', () => {
    const device = { name: 'Study', integrationID: '1', deviceType: 'blind', raiseLevel: 'up' };
    const result = normalizeConfiguration({ host: HOST, devices: [device] });
    expect(result.configuration?.devices[0].blindLevels).toEqual({ raise: 16, lower: 35, stop: 0 });
    expect(result.warnings.join(' ')).toMatch(/raiseLevel/);
  });

  it('does not attach blind codes to other device types', () => {
    const result = normalizeConfiguration({ host: HOST, devices: [{ name: 'A', integrationID: '1', deviceType: 'light', raiseLevel: 5 }] });
    expect(result.configuration?.devices[0]).not.toHaveProperty('blindLevels');
  });
});
