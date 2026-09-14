export type DeviceType = 'light' | 'shade';

/**
 * One load on the processor, as it appears in config.json after normalization.
 */
export interface ConfigDevice {
  /** Display name in HomeKit. */
  name: string;

  /**
   * Processor address exactly as the processor reports it in `DL` lines with the
   * brackets removed (e.g. `01:01:00:01:04`). The HomeKit UUID is derived from it,
   * so it must not change once an accessory has been paired.
   */
  integrationID: string;

  deviceType: DeviceType;

  /** Exposes a Brightness characteristic. Omitted in config means false. */
  isDimmable: boolean;
}
