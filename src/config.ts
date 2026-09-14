import { Configuration } from './Schemas/configuration';
import { ConfigDevice, DeviceType } from './Schemas/device';

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

function normalizeDevices(items: unknown[], warnings: string[]): ConfigDevice[] {
  const seen = new Set<string>();
  const devices: ConfigDevice[] = [];

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
    if (entry.deviceType === 'shade' || entry.deviceType === 'light') {
      deviceType = entry.deviceType;
    } else if (entry.deviceType !== undefined) {
      warnings.push(`${label} ("${name}"): unknown deviceType ${JSON.stringify(entry.deviceType)}, treating it as a light`);
    }

    devices.push({ name, integrationID, deviceType, isDimmable: entry.isDimmable === true });
  });

  return devices;
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
