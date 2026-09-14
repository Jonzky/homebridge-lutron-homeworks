import { Service, PlatformAccessory, Characteristic, WithUUID } from 'homebridge';
import { ConfigDevice, DEFAULT_BLIND_LEVELS } from './Schemas/device';
import { EngineLogger } from './network';
import { LightController, ShadeController, ShadeMotion, BlindController } from './controllers';

/** Momentary switches spring back to off after this long. */
const MOMENTARY_RESET_MS = 1000;

/** What an accessory needs from the platform. HomeworksPlatform satisfies this. */
export interface AccessoryHost {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly log: EngineLogger;
}

export type SendLevelCallback = (level: number, accessory: HomeworksAccessory) => void;

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
  ): HomeworksAccessory {
    switch (config.deviceType) {
      case 'shade':
        return new HomeworksShadeAccessory(host, accessory, uuid, config);
      case 'blind':
        return new HomeworksBlindAccessory(host, accessory, uuid, config);
      case 'light':
      default:
        return new HomeworksLightAccessory(host, accessory, uuid, config);
    }
  }

  /** Set by the platform; invoked when HomeKit wants the processor to change this load. */
  public onSendLevel?: SendLevelCallback;

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

  public getName(): string {
    return this.config.name;
  }

  public getUUID(): string {
    return this.uuid;
  }

  /** Level the processor reported for this load, from a DL line or an RDL reply. */
  public abstract handleProcessorLevel(level: number): void;

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
      this.onSendLevel(level, this);
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
 * A relay-driven blind with no position feedback, exposed as three switches:
 * Raise and Lower stay on while the processor reports the matching code and
 * send the stop code when switched off; Stop is momentary.
 */
export class HomeworksBlindAccessory extends HomeworksAccessory {
  private readonly raise: Service;
  private readonly lower: Service;
  private readonly stop: Service;
  private readonly controller: BlindController;
  private stopResetTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(host: AccessoryHost, accessory: PlatformAccessory, uuid: string, config: ConfigDevice) {
    super(host, accessory, uuid, config);
    const { Service, Characteristic } = host;

    this.pruneServices([Service.Switch]);
    this.raise = this.switchService('raise', `${config.name} Raise`);
    this.lower = this.switchService('lower', `${config.name} Lower`);
    this.stop = this.switchService('stop', `${config.name} Stop`);

    this.controller = new BlindController(config.blindLevels ?? DEFAULT_BLIND_LEVELS, {
      sendLevel: level => this.sendLevel(level),
      publish: state => {
        this.raise.updateCharacteristic(Characteristic.On, state.motion === 'raising');
        this.lower.updateCharacteristic(Characteristic.On, state.motion === 'lowering');
      },
    });

    this.raise.getCharacteristic(Characteristic.On)
      .onGet(() => this.controller.state.motion === 'raising')
      .onSet(value => {
        if (value) {
          this.controller.homeKitRaise();
        } else if (this.controller.state.motion === 'raising') {
          this.controller.homeKitStop();
        }
      });

    this.lower.getCharacteristic(Characteristic.On)
      .onGet(() => this.controller.state.motion === 'lowering')
      .onSet(value => {
        if (value) {
          this.controller.homeKitLower();
        } else if (this.controller.state.motion === 'lowering') {
          this.controller.homeKitStop();
        }
      });

    this.stop.getCharacteristic(Characteristic.On)
      .onGet(() => false)
      .onSet(value => {
        if (value) {
          this.controller.homeKitStop();
          this.springBackStop();
        }
      });
  }

  public handleProcessorLevel(level: number): void {
    this.controller.processorLevel(level);
  }

  private switchService(subtype: string, name: string): Service {
    const { Service, Characteristic } = this.host;
    const service = this.accessory.getServiceById(Service.Switch, subtype) || this.accessory.addService(Service.Switch, name, subtype);
    service.setCharacteristic(Characteristic.Name, name);
    return service;
  }

  private springBackStop(): void {
    if (this.stopResetTimer) {
      clearTimeout(this.stopResetTimer);
    }
    this.stopResetTimer = setTimeout(() => {
      this.stopResetTimer = undefined;
      this.stop.updateCharacteristic(this.host.Characteristic.On, false);
    }, MOMENTARY_RESET_MS);
  }
}
