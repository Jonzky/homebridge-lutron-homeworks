import { Configuration } from './Schemas/configuration';
import { ConfigDevice, DeviceType, DEFAULT_BLIND_LEVELS } from './Schemas/device';

export interface ConfigurationResult {
  /** Null when a problem makes the plugin unable to run at all. */
  configuration: Configuration | null;
  /** Fatal issues; each one is logged as an error. */
  problems: string[];
  /** Devices that were skipped or adjusted; each one is logged as a warning. */
  warnings: string[];
}

const DEFAULT_PORT = 23;

/**
 * Validates the raw platform block from config.json and fills in defaults.
 * Never throws: bad input is reported through `problems` and `warnings`.
 */
export function normalizeConfiguration(raw: unknown): ConfigurationResult {
  const problems: string[] = [];
  const warnings: string[] = [];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { configuration: null, problems: ['Configuration must be an object'], warnings };
  }
  const source = raw as Record<string, unknown>;

  const host = typeof source.host === 'string' ? source.host.trim() : '';
  if (host === '') {
    problems.push('"host" is required: the IP address or hostname of the HomeWorks processor');
  }

  let apiPort = DEFAULT_PORT;
  if (source.apiPort !== undefined && source.apiPort !== null && source.apiPort !== '') {
    const parsed = typeof source.apiPort === 'number' ? source.apiPort : Number(String(source.apiPort).trim());
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      problems.push(`"apiPort" must be a port number between 1 and 65535, got ${JSON.stringify(source.apiPort)}`);
    } else {
      apiPort = parsed;
    }
  }

  const username = stringOrEmpty(source.username);
  const password = stringOrEmpty(source.password);

  let devices: ConfigDevice[] = [];
  if (source.devices !== undefined && source.devices !== null) {
    if (Array.isArray(source.devices)) {
      devices = normalizeDevices(source.devices, warnings);
    } else {
      problems.push('"devices" must be an array');
    }
  }

  if (problems.length > 0) {
    return { configuration: null, problems, warnings };
  }
  return { configuration: { host, apiPort, username, password, devices }, problems, warnings };
}

interface PendingGroup {
  device: ConfigDevice;
  label: string;
  members?: string[];
  exclude?: string[];
}

function normalizeDevices(items: unknown[], warnings: string[]): ConfigDevice[] {
  const seen = new Set<string>();
  const devices: ConfigDevice[] = [];
  const pendingGroups: PendingGroup[] = [];

  items.forEach((item, index) => {
    const label = `devices[${index}]`;
    if (typeof item !== 'object' || item === null) {
      warnings.push(`${label} ignored: not an object`);
      return;
    }
    const entry = item as Record<string, unknown>;

    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (name === '') {
      warnings.push(`${label} ignored: "name" is missing`);
      return;
    }

    const integrationID = idToString(entry.integrationID);
    if (integrationID === '') {
      warnings.push(`${label} ("${name}") ignored: "integrationID" is missing`);
      return;
    }
    if (seen.has(integrationID)) {
      warnings.push(`${label} ("${name}") ignored: integrationID ${integrationID} is already used by another device`);
      return;
    }
    seen.add(integrationID);

    let deviceType: DeviceType = 'light';
    if (entry.deviceType === 'shade' || entry.deviceType === 'light' || entry.deviceType === 'blind' || entry.deviceType === 'blindGroup') {
      deviceType = entry.deviceType;
    } else if (entry.deviceType !== undefined) {
      warnings.push(`${label} ("${name}"): unknown deviceType ${JSON.stringify(entry.deviceType)}, treating it as a light`);
    }

    const device: ConfigDevice = { name, integrationID, deviceType, isDimmable: entry.isDimmable === true };
    if (deviceType === 'blind') {
      const context = `${label} ("${name}")`;
      device.blindLevels = {
        raise: blindLevel(entry.raiseLevel, 'raiseLevel', DEFAULT_BLIND_LEVELS.raise, context, warnings),
        lower: blindLevel(entry.lowerLevel, 'lowerLevel', DEFAULT_BLIND_LEVELS.lower, context, warnings),
        stop: blindLevel(entry.stopLevel, 'stopLevel', DEFAULT_BLIND_LEVELS.stop, context, warnings),
      };
    }
    if (deviceType === 'blindGroup') {
      const context = `${label} ("${name}")`;
      pendingGroups.push({
        device,
        label: context,
        members: stringList(entry.members, 'members', context, warnings),
        exclude: stringList(entry.exclude, 'exclude', context, warnings),
      });
    }
    devices.push(device);
  });

  // Groups are resolved after every device is known, so a group may be listed before its members.
  for (const group of pendingGroups) {
    group.device.groupMemberIds = resolveGroupMembers(group, devices, warnings);
    if (group.device.groupMemberIds.length === 0) {
      warnings.push(`${group.label} ignored: it has no member blinds`);
      devices.splice(devices.indexOf(group.device), 1);
    }
  }

  return devices;
}

/** Members and exclusions may name a blind by integrationID or by name. */
function resolveGroupMembers(group: PendingGroup, devices: ConfigDevice[], warnings: string[]): string[] {
  const blinds = devices.filter(d => d.deviceType === 'blind');
  const findDevice = (ref: string) => devices.find(d => d.integrationID === ref || d.name === ref);

  let members: ConfigDevice[];
  if (group.members) {
    members = [];
    for (const ref of group.members) {
      const found = findDevice(ref);
      if (!found) {
        warnings.push(`${group.label}: member "${ref}" does not match any device`);
      } else if (found.deviceType !== 'blind') {
        warnings.push(`${group.label}: member "${ref}" is a ${found.deviceType}, not a blind`);
      } else if (!members.includes(found)) {
        members.push(found);
      }
    }
  } else {
    members = [...blinds];
  }

  for (const ref of group.exclude ?? []) {
    const found = findDevice(ref);
    if (!found) {
      warnings.push(`${group.label}: exclusion "${ref}" does not match any device`);
    }
    members = members.filter(m => m !== found);
  }

  return members.map(m => m.integrationID);
}

function stringList(value: unknown, key: string, context: string, warnings: string[]): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    warnings.push(`${context}: "${key}" must be a list of names or integration IDs, ignoring it`);
    return undefined;
  }
  return value.map(item => idToString(item)).filter(item => item !== '');
}

function blindLevel(value: unknown, key: string, fallback: number, context: string, warnings: string[]): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    warnings.push(`${context}: "${key}" must be a whole number between 0 and 100, using ${fallback}`);
    return fallback;
  }
  return parsed;
}

function idToString(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return '';
}

function stringOrEmpty(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return value === undefined || value === null ? '' : String(value);
}
