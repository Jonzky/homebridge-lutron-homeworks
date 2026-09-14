import { Service, PlatformAccessory, Characteristic } from 'homebridge';
import { ConfigDevice } from './Schemas/device';
import { EngineLogger } from './network';
import { LightController, ShadeController, ShadeMotion } from './controllers';

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
