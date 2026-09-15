import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { Configuration } from './Schemas/configuration';
import { ConfigDevice } from './Schemas/device';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { HomeworksAccessory, HomeworksBlindAccessory } from './homeworksAccessory';
import { NetworkEngine } from './network';
import { normalizeConfiguration } from './config';
import { parseDlLine, fadeDimCommand, requestLevelCommand } from './protocol';

/** Spacing between the per-device level requests issued after each connect. */
const LEVEL_REQUEST_INTERVAL_MS = 1000;

export class HomeworksPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  private readonly configuration: Configuration | null;
  private readonly engine: NetworkEngine | null;
  private readonly cachedPlatformAccessories: PlatformAccessory[] = [];
  /** Live accessories keyed by HomeKit UUID, which is derived from the integration ID. */
  private readonly homeworksAccessories = new Map<string, HomeworksAccessory>();
  private levelRequestTimers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    const { configuration, problems, warnings } = normalizeConfiguration(config);
    for (const warning of warnings) {
      log.warn('[Platform] %s', warning);
    }
    for (const problem of problems) {
      log.error('[Platform] %s', problem);
    }
    this.configuration = configuration;

    if (configuration) {
      this.engine = new NetworkEngine(log, configuration.host, configuration.apiPort, configuration.username, configuration.password);
      this.engine.registerReceiveCallback((_engine, line) => this.handleProcessorLine(line));
      this.engine.registerDidConnectCallback(() => this.requestAllLevels());
    } else {
      this.engine = null;
      log.error('[Platform] Configuration is invalid; the plugin will not connect. Fix config.json and restart Homebridge.');
    }

    api.on('didFinishLaunching', () => {
      if (!this.configuration || !this.engine) {
        return;
      }
      this.discoverDevices(this.configuration.devices);
      this.engine.connect();
    });

    api.on('shutdown', () => {
      this.clearLevelRequests();
      this.engine?.shutdown();
    });
  }

  /** Homebridge restores accessories from its cache through here before didFinishLaunching. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug('[Platform] Restoring cached accessory: %s', accessory.displayName);
    this.cachedPlatformAccessories.push(accessory);
  }

  // ---- processor -> HomeKit ----

  private handleProcessorLine(line: string): void {
    const report = parseDlLine(line);
    if (!report) {
      this.log.debug('[Platform] < %s', line);
      return;
    }
    const uuid = this.api.hap.uuid.generate(report.address);
    const target = this.homeworksAccessories.get(uuid);
    if (!target) {
      this.log.debug('[Platform] Level report for an address not in the config: %s = %d', report.address, report.level);
      return;
    }
    this.log.debug('[Platform] %s reported level %d', target.getName(), report.level);
    target.handleProcessorLevel(report.level);
  }

  /** Pull the current level of every device, spaced out so the processor is not flooded. */
  private requestAllLevels(): void {
    this.clearLevelRequests();
    let index = 0;
    for (const accessory of this.homeworksAccessories.values()) {
      if (!accessory.hasProcessorAddress()) {
        continue;
      }
      const timer = setTimeout(() => {
        this.engine?.send(requestLevelCommand(accessory.getIntegrationId()));
      }, index * LEVEL_REQUEST_INTERVAL_MS);
      this.levelRequestTimers.push(timer);
      index++;
    }
  }

  private clearLevelRequests(): void {
    for (const timer of this.levelRequestTimers) {
      clearTimeout(timer);
    }
    this.levelRequestTimers = [];
  }

  // ---- HomeKit accessory reconciliation ----

  /**
   * Adds, updates or removes HomeKit accessories to match the config. Runs once
   * per Homebridge start; the accessory UUID is derived from the integration ID.
   * Groups are attached after the loads they contain.
   */
  private discoverDevices(devices: ConfigDevice[]): void {
    const kept: PlatformAccessory[] = [];

    for (const device of devices.filter(d => d.deviceType !== 'blindGroup')) {
      kept.push(this.attachDevice(device, []));
    }
    for (const device of devices.filter(d => d.deviceType === 'blindGroup')) {
      const members: HomeworksBlindAccessory[] = [];
      for (const memberId of device.groupMemberIds ?? []) {
        const member = this.homeworksAccessories.get(this.api.hap.uuid.generate(memberId));
        if (member instanceof HomeworksBlindAccessory) {
          members.push(member);
        } else {
          this.log.warn('[Platform] Group %s: member %s is not a configured blind', device.name, memberId);
        }
      }
      kept.push(this.attachDevice(device, members));
    }

    const stale = this.cachedPlatformAccessories.filter(cached => !kept.includes(cached));
    if (stale.length > 0) {
      this.log.warn('[Platform] Removing %d accessories that are no longer in the config', stale.length);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }

  private attachDevice(device: ConfigDevice, members: HomeworksBlindAccessory[]): PlatformAccessory {
    const uuid = this.api.hap.uuid.generate(device.integrationID);
    let accessory = this.cachedPlatformAccessories.find(cached => cached.UUID === uuid);

    if (accessory) {
      this.log.debug('[Platform] Updating %s', device.name);
      accessory.context.device = device;
      accessory.displayName = device.name;
      this.api.updatePlatformAccessories([accessory]);
    } else {
      this.log.info('[Platform] Adding %s', device.name);
      accessory = new this.api.platformAccessory(device.name, uuid);
      accessory.context.device = device;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    const detail = device.deviceType === 'blindGroup'
      ? `${members.length} members`
      : `id ${device.integrationID}${device.isDimmable ? ', dimmable' : ''}`;
    this.log.info('[Platform] Registering %s (%s, %s)', device.name, device.deviceType, detail);

    const homeworksAccessory = HomeworksAccessory.CreateAccessory(this, accessory, uuid, device, members);
    homeworksAccessory.onSendLevel = (level, integrationId) => {
      this.log.debug('[Platform] %s -> %d', integrationId, level);
      this.engine?.send(fadeDimCommand(level, integrationId));
    };
    this.homeworksAccessories.set(uuid, homeworksAccessory);
    return accessory;
  }
}
