import { ConfigDevice } from './device';

/**
 * The plugin's platform block in config.json after normalization.
 */
export interface Configuration {
  /** IP address or hostname of the HomeWorks processor. */
  host: string;

  /** Telnet port of the processor. Defaults to 23. */
  apiPort: number;

  /** Sent at the processor's LOGIN: prompt. */
  username: string;

  /** Sent only if the processor issues a separate PASSWORD: prompt. */
  password: string;

  devices: ConfigDevice[];
}
