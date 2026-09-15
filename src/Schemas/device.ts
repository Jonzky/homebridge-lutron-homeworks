export type DeviceType = 'light' | 'shade' | 'blind' | 'blindGroup';

/** Dimmer levels a relay-driven blind interprets as commands. */
export interface BlindLevels {
  raise: number;
  lower: number;
  stop: number;
}

/** Observed on the author's processor; overridable per device in config. */
export const DEFAULT_BLIND_LEVELS: BlindLevels = { raise: 16, lower: 35, stop: 0 };

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

  /** Lights only: exposes a Brightness characteristic. Omitted in config means false. */
  isDimmable: boolean;

  /** Blinds only. */
  blindLevels?: BlindLevels;

  /** Blind groups only: integration IDs of the member blinds, resolved and in order. */
  groupMemberIds?: string[];
}
