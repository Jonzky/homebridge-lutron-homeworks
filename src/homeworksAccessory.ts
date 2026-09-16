import { Service, PlatformAccessory, Characteristic, WithUUID } from 'homebridge';
import { ConfigDevice, DEFAULT_BLIND_LEVELS } from './Schemas/device';
import { EngineLogger } from './network';
import { LightController, ShadeController, ShadeMotion, BlindController, BlindMotion } from './controllers';

/** Momentary switches spring back to off after this long. */
const MOMENTARY_RESET_MS = 1000;

/**
 * The Home app (iOS 16+) displays and edits service names through ConfiguredName and
 * ignores Name. Initialise it only when empty so a rename made in the Home app survives
 * restarts; the characteristic value is persisted in Homebridge's accessory cache.
 */
function ensureConfiguredName(host: AccessoryHost, service: Service, name: string): void {
  const { ConfiguredName } = host.Characteristic;
  service.addOptionalCharacteristic(ConfiguredName);
  const characteristic = service.getCharacteristic(ConfiguredName);
  if (!characteristic.value) {
    characteristic.updateValue(name);
  }
}

/** What an accessory needs from the platform. HomeworksPlatform satisfies this. */
export interface AccessoryHost {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly log: EngineLogger;
}

export type SendLevelCallback = (level: number, integrationId: string) => void;

/**
 * One HomeKit accessory bound to one processor load. Subclasses translate
 * between HAP characteristics and a controller from controllers.ts.
 */
export abstract class HomeworksAccessory {
  public static CreateAccessory(
    host: AccessoryHost,
    accessory: PlatformAccessory,
    uuid: string,
    config: ConfigDevice,
    members: HomeworksBlindAccessory[] = [],
  ): HomeworksAccessory {
    switch (config.deviceType) {
      case 'shade':
        return new HomeworksShadeAccessory(host, accessory, uuid, config);
      case 'blind':
        return new HomeworksBlindAccessory(host, accessory, uuid, config);
      case 'blindGroup':
        return new HomeworksBlindGroupAccessory(host, accessory, uuid, config, members);
      case 'light':
      default:
        return new HomeworksLightAccessory(host, accessory, uuid, config);
    }
  }

  /** Set by the platform; invoked when HomeKit wants the processor to change this load. */
  public onSendLevel?: SendLevelCallback;

  /** The service whose ConfiguredName the Home app treats as this accessory's name, if any. */
  private namedService: Service | null = null;

  constructor(
    protected readonly host: AccessoryHost,
    protected readonly accessory: PlatformAccessory,
    private readonly uuid: string,
    protected readonly config: ConfigDevice,
  ) {
    this.accessory.getService(host.Service.AccessoryInformation)!
      .setCharacteristic(host.Characteristic.Manufacturer, 'Lutron')
      .setCharacteristic(host.Characteristic.Model, `HomeWorks ${config.deviceType}`)
      .setCharacteristic(host.Characteristic.SerialNumber, config.integrationID);
  }

  public getIntegrationId(): string {
    return this.config.integrationID;
  }

  /** The name shown in HomeKit if the user renamed it there, otherwise the config name. */
  public getName(): string {
    return this.getHomeKitRename() ?? this.config.name;
  }

  /** The name the user gave this accessory in the Home app, when it differs from the config. */
  public getHomeKitRename(): string | null {
    if (!this.namedService) {
      return null;
    }
    const value = this.namedService.getCharacteristic(this.host.Characteristic.ConfiguredName).value;
    return typeof value === 'string' && value !== '' && value !== this.config.name ? value : null;
  }

  /** Marks the primary service as the one carrying the accessory's HomeKit name. */
  protected adoptConfiguredName(service: Service): void {
    ensureConfiguredName(this.host, service, this.config.name);
    this.namedService = service;
  }

  public getUUID(): string {
    return this.uuid;
  }

  /** Level the processor reported for this load, from a DL line or an RDL reply. */
  public abstract handleProcessorLevel(level: number): void;

  /** False for virtual accessories (groups) whose integrationID is not a processor address. */
  public hasProcessorAddress(): boolean {
    return true;
  }

  /**
   * Removes services of the other device types, so an accessory whose deviceType
   * changed in the config does not keep showing its old controls from the cache.
   */
  protected pruneServices(keep: Array<WithUUID<typeof Service>>): void {
    const types = this.host.Service;
    const managed = [types.Lightbulb, types.WindowCovering, types.Switch];
    const keepUuids = new Set(keep.map(type => type.UUID));
    for (const service of [...this.accessory.services]) {
      if (managed.some(type => type.UUID === service.UUID) && !keepUuids.has(service.UUID)) {
        this.host.log.debug('[Accessory][%s] Removing stale %s service', this.getName(), service.displayName || service.UUID);
        this.accessory.removeService(service);
      }
    }
  }

  protected sendLevel(level: number): void {
    if (this.onSendLevel) {
      this.onSendLevel(level, this.getIntegrationId());
    } else {
      this.host.log.warn('[Accessory][%s] No send callback registered, dropping level %d', this.getName(), level);
    }
  }
}

export class HomeworksLightAccessory extends HomeworksAccessory {
  private readonly service: Service;
  private readonly controller: LightController;

  constructor(host: AccessoryHost, accessory: PlatformAccessory, uuid: string, config: ConfigDevice) {
    super(host, accessory, uuid, config);
    const { Service, Characteristic } = host;

    this.pruneServices([Service.Lightbulb]);
    this.service = accessory.getService(Service.Lightbulb) || accessory.addService(Service.Lightbulb);
    this.service.setCharacteristic(Characteristic.Name, config.name);
    this.adoptConfiguredName(this.service);

    this.controller = new LightController(config.isDimmable, {
      sendLevel: level => this.sendLevel(level),
      publish: state => {
        this.service.updateCharacteristic(Characteristic.On, state.on);
        if (config.isDimmable) {
          this.service.updateCharacteristic(Characteristic.Brightness, state.brightness);
        }
      },
    });

    this.service.getCharacteristic(Characteristic.On)
      .onGet(() => this.controller.state.on)
      .onSet(value => {
        this.controller.homeKitSetOn(value as boolean);
      });

    if (config.isDimmable) {
      this.service.getCharacteristic(Characteristic.Brightness)
        .onGet(() => this.controller.state.brightness)
        .onSet(value => {
          this.controller.homeKitSetBrightness(value as number);
        });
    } else if (this.service.testCharacteristic(Characteristic.Brightness)) {
      // Left behind by an earlier version or a config that used to say dimmable.
      this.service.removeCharacteristic(this.service.getCharacteristic(Characteristic.Brightness));
      host.log.debug('[Accessory][%s] Removed a stale Brightness characteristic', config.name);
    }
  }

  public handleProcessorLevel(level: number): void {
    this.controller.processorLevel(level);
  }
}

/**
 * A shade driven through the dimmer commands: the level is the position.
 * TargetPosition sends the level; CurrentPosition and PositionState follow
 * what the processor reports back.
 */
export class HomeworksShadeAccessory extends HomeworksAccessory {
  private readonly service: Service;
  private readonly controller: ShadeController;

  constructor(host: AccessoryHost, accessory: PlatformAccessory, uuid: string, config: ConfigDevice) {
    super(host, accessory, uuid, config);
    const { Service, Characteristic } = host;

    this.pruneServices([Service.WindowCovering]);
    this.service = accessory.getService(Service.WindowCovering) || accessory.addService(Service.WindowCovering);
    this.service.setCharacteristic(Characteristic.Name, config.name);
    this.adoptConfiguredName(this.service);

    this.controller = new ShadeController({
      sendLevel: level => this.sendLevel(level),
      publish: state => {
        this.service.updateCharacteristic(Characteristic.CurrentPosition, state.current);
        this.service.updateCharacteristic(Characteristic.TargetPosition, state.target);
        this.service.updateCharacteristic(Characteristic.PositionState, this.toHapMotion(state.motion));
      },
    });

    this.service.getCharacteristic(Characteristic.CurrentPosition)
      .onGet(() => this.controller.state.current);
    this.service.getCharacteristic(Characteristic.PositionState)
      .onGet(() => this.toHapMotion(this.controller.state.motion));
    this.service.getCharacteristic(Characteristic.TargetPosition)
      .onGet(() => this.controller.state.target)
      .onSet(value => {
        this.controller.homeKitSetTarget(value as number);
      });

    this.service.updateCharacteristic(Characteristic.PositionState, this.toHapMotion('stopped'));
  }

  public handleProcessorLevel(level: number): void {
    this.controller.processorLevel(level);
  }

  private toHapMotion(motion: ShadeMotion): number {
    const { PositionState } = this.host.Characteristic;
    switch (motion) {
      case 'increasing':
        return PositionState.INCREASING;
      case 'decreasing':
        return PositionState.DECREASING;
      default:
        return PositionState.STOPPED;
    }
  }
}

/**
 * Shared shape for anything driven by raise / lower / stop: three Switch services
 * inside one accessory. Raise and Lower show the current motion and send stop when
 * switched off; Stop is momentary.
 */
abstract class RaiseLowerStopAccessory extends HomeworksAccessory {
  protected readonly raiseSwitch: Service;
  protected readonly lowerSwitch: Service;
  protected readonly stopSwitch: Service;
  private stopResetTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(host: AccessoryHost, accessory: PlatformAccessory, uuid: string, config: ConfigDevice) {
    super(host, accessory, uuid, config);
    const { Service, Characteristic } = host;

    this.pruneServices([Service.Switch]);
    this.raiseSwitch = this.switchService('raise', 'Raise');
    this.lowerSwitch = this.switchService('lower', 'Lower');
    this.stopSwitch = this.switchService('stop', 'Stop');

    this.raiseSwitch.getCharacteristic(Characteristic.On)
      .onGet(() => this.currentMotion() === 'raising')
      .onSet(value => {
        if (value) {
          this.doRaise();
        } else if (this.currentMotion() === 'raising') {
          this.doStop();
        }
      });

    this.lowerSwitch.getCharacteristic(Characteristic.On)
      .onGet(() => this.currentMotion() === 'lowering')
      .onSet(value => {
        if (value) {
          this.doLower();
        } else if (this.currentMotion() === 'lowering') {
          this.doStop();
        }
      });

    this.stopSwitch.getCharacteristic(Characteristic.On)
      .onGet(() => false)
      .onSet(value => {
        if (value) {
          this.doStop();
          this.springBackStop();
        }
      });
  }

  protected abstract currentMotion(): BlindMotion;
  protected abstract doRaise(): void;
  protected abstract doLower(): void;
  protected abstract doStop(): void;

  /** Push the current motion to the Raise and Lower switches. */
  protected refreshSwitches(): void {
    const { On } = this.host.Characteristic;
    const motion = this.currentMotion();
    this.raiseSwitch.updateCharacteristic(On, motion === 'raising');
    this.lowerSwitch.updateCharacteristic(On, motion === 'lowering');
  }

  private switchService(subtype: string, name: string): Service {
    const { Service, Characteristic } = this.host;
    const service = this.accessory.getServiceById(Service.Switch, subtype) || this.accessory.addService(Service.Switch, name, subtype);
    service.setCharacteristic(Characteristic.Name, name);
    ensureConfiguredName(this.host, service, name);
    return service;
  }

  private springBackStop(): void {
    if (this.stopResetTimer) {
      clearTimeout(this.stopResetTimer);
    }
    this.stopResetTimer = setTimeout(() => {
      this.stopResetTimer = undefined;
      this.stopSwitch.updateCharacteristic(this.host.Characteristic.On, false);
    }, MOMENTARY_RESET_MS);
  }
}

/**
 * A relay-driven blind with no position feedback: the dimmer level is a command
 * code (raise / lower / stop), not a position.
 */
export class HomeworksBlindAccessory extends RaiseLowerStopAccessory {
  private readonly controller: BlindController;
  private readonly motionListeners: Array<() => void> = [];

  constructor(host: AccessoryHost, accessory: PlatformAccessory, uuid: string, config: ConfigDevice) {
    super(host, accessory, uuid, config);
    this.controller = new BlindController(config.blindLevels ?? DEFAULT_BLIND_LEVELS, {
      sendLevel: level => this.sendLevel(level),
      publish: () => {
        this.refreshSwitches();
        for (const listener of this.motionListeners) {
          listener();
        }
      },
    });
  }

  public handleProcessorLevel(level: number): void {
    this.controller.processorLevel(level);
  }

  public get motion(): BlindMotion {
    return this.controller.state.motion;
  }

  /** Called whenever the motion changes, from HomeKit or from the processor. Used by groups. */
  public onMotionChange(listener: () => void): void {
    this.motionListeners.push(listener);
  }

  public raise(): void {
    this.controller.homeKitRaise();
  }

  public lower(): void {
    this.controller.homeKitLower();
  }

  public stop(): void {
    this.controller.homeKitStop();
  }

  protected currentMotion(): BlindMotion {
    return this.motion;
  }

  protected doRaise(): void {
    this.raise();
  }

  protected doLower(): void {
    this.lower();
  }

  protected doStop(): void {
    this.stop();
  }
}

/** Interval between commands to consecutive members, so the processor is not flooded. */
const GROUP_STAGGER_MS = 100;

/**
 * A virtual accessory whose Raise / Lower / Stop fan out to several blinds. Its
 * switches show a motion only while every member reports it. Its integrationID
 * is a stable label for HomeKit, never sent to the processor.
 */
export class HomeworksBlindGroupAccessory extends RaiseLowerStopAccessory {
  private readonly members: HomeworksBlindAccessory[];
  private pending: Array<ReturnType<typeof setTimeout>> = [];

  constructor(host: AccessoryHost, accessory: PlatformAccessory, uuid: string, config: ConfigDevice, members: HomeworksBlindAccessory[]) {
    super(host, accessory, uuid, config);
    this.members = members;
    for (const member of members) {
      member.onMotionChange(() => this.refreshSwitches());
    }
    if (members.length === 0) {
      host.log.warn('[Accessory][%s] Blind group has no members', config.name);
    }
  }

  public hasProcessorAddress(): boolean {
    return false;
  }

  public handleProcessorLevel(): void {
    // A group has no processor address; nothing can be reported for it.
  }

  protected currentMotion(): BlindMotion {
    if (this.members.length === 0) {
      return 'stopped';
    }
    const first = this.members[0].motion;
    return this.members.every(member => member.motion === first) ? first : 'stopped';
  }

  protected doRaise(): void {
    this.fanOut(member => member.raise());
  }

  protected doLower(): void {
    this.fanOut(member => member.lower());
  }

  protected doStop(): void {
    this.fanOut(member => member.stop());
  }

  private fanOut(action: (member: HomeworksBlindAccessory) => void): void {
    for (const timer of this.pending) {
      clearTimeout(timer);
    }
    this.pending = [];
    this.members.forEach((member, index) => {
      if (index === 0) {
        action(member);
      } else {
        this.pending.push(setTimeout(() => action(member), index * GROUP_STAGGER_MS));
      }
    });
  }
}
