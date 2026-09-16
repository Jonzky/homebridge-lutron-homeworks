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

describe('normalizeConfiguration for blind groups', () => {
  const blinds = [
    { name: 'Lounge', integrationID: '1', deviceType: 'blind' },
    { name: 'Study', integrationID: '2', deviceType: 'blind', raiseLevel: 20 },
    { name: 'Broken', integrationID: '3', deviceType: 'blind' },
    { name: 'Kitchen', integrationID: '4', deviceType: 'light' },
  ];
  const group = (extra: Record<string, unknown> = {}) =>
    ({ name: 'All blinds', integrationID: 'all', deviceType: 'blindGroup', ...extra });
  const groupOf = (devices: unknown[]) => {
    const result = normalizeConfiguration({ host: HOST, devices });
    return { result, group: result.configuration?.devices.find(d => d.deviceType === 'blindGroup') };
  };

  it('defaults a group to every blind in the config', () => {
    const { group: g } = groupOf([...blinds, group()]);
    expect(g).toEqual({
      name: 'All blinds', integrationID: 'all', deviceType: 'blindGroup', isDimmable: false, groupMemberIds: ['1', '2', '3'],
    });
  });

  it('excludes blinds listed by name or id', () => {
    const { group: g } = groupOf([...blinds, group({ exclude: ['Broken', '1'] })]);
    expect(g?.groupMemberIds).toEqual(['2']);
  });

  it('resolves an explicit members list by name or id in the order given', () => {
    const { group: g } = groupOf([...blinds, group({ members: ['Study', '1'] })]);
    expect(g?.groupMemberIds).toEqual(['2', '1']);
  });

  it('skips unknown or non-blind members with a warning', () => {
    const { result, group: g } = groupOf([...blinds, group({ members: ['Kitchen', 'Nope', '1'] })]);
    expect(g?.groupMemberIds).toEqual(['1']);
    expect(result.warnings.join(' ')).toMatch(/Kitchen/);
    expect(result.warnings.join(' ')).toMatch(/Nope/);
  });

  it('skips a group that ends up with no members', () => {
    const { result, group: g } = groupOf([...blinds, group({ members: ['Nope'] })]);
    expect(g).toBeUndefined();
    expect(result.warnings.join(' ')).toMatch(/All blinds/);
  });

  it('lets a group be listed before its members', () => {
    const { group: g } = groupOf([group(), ...blinds]);
    expect(g?.groupMemberIds).toEqual(['1', '2', '3']);
  });
});

describe('normalizeConfiguration blind group include', () => {
  const blinds = [
    { name: 'Lounge', integrationID: '1', deviceType: 'blind' },
    { name: 'Study', integrationID: '2', deviceType: 'blind' },
    { name: 'Hall', integrationID: '3', deviceType: 'blind' },
  ];
  const groupOf = (extra: Record<string, unknown>) => {
    const group = { name: 'Some', integrationID: 'g', deviceType: 'blindGroup', ...extra };
    const result = normalizeConfiguration({ host: HOST, devices: [...blinds, group] });
    return { result, group: result.configuration?.devices.find(d => d.deviceType === 'blindGroup') };
  };

  it('include selects only the listed blinds, by name or id, in the order given', () => {
    expect(groupOf({ include: ['Study', '1'] }).group?.groupMemberIds).toEqual(['2', '1']);
  });

  it('exclude applies on top of include', () => {
    expect(groupOf({ include: ['Study', '1'], exclude: ['1'] }).group?.groupMemberIds).toEqual(['2']);
  });

  it('include wins over the members alias when both are given, with a warning', () => {
    const { result, group } = groupOf({ include: ['Study'], members: ['Hall'] });
    expect(group?.groupMemberIds).toEqual(['2']);
    expect(result.warnings.join(' ')).toMatch(/members/);
  });
});
