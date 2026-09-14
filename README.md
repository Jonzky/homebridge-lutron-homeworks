# homebridge-homeworks-alt

A [Homebridge](https://homebridge.io) platform plugin for Lutron HomeWorks processors that speak the older telnet integration protocol: the `LNET>` prompt and commands such as `FADEDIM`, `DLMON` and `RDL` (Illumination-era systems). It is a fork of [kikolobo's homebridge-lutron-homeworks](https://github.com/kikolobo/homebridge-lutron-homeworks), which now targets HomeWorks QS and its `#OUTPUT` protocol. Full credit to kikolobo for the original.

Requires Node.js 20 or newer and Homebridge 1.8 or newer, including Homebridge 2.x.

## What it does

- Lights (on/off, optionally dimmable) and shades driven as dimmer levels.
- Relay-driven blinds that only understand raise, lower and stop.
- Live state: the plugin enables dimmer level monitoring on the processor, so changes made from keypads or other apps show up in HomeKit.
- A resilient connection: line-based parsing of the telnet stream, keepalive with dead-peer detection, reconnect with backoff, and commands queued while reconnecting.

## Configuration

Add a platform block to `config.json`, or use the Homebridge UI. The `platform` value must be exactly `Homeworks-alt`.

```json
{
  "platform": "Homeworks-alt",
  "host": "192.168.1.50",
  "apiPort": 23,
  "username": "jetski",
  "password": "",
  "devices": [
    { "name": "Kitchen", "integrationID": "01:01:00:01:04", "deviceType": "light", "isDimmable": true },
    { "name": "Hall", "integrationID": "01:01:00:01:05", "deviceType": "light" },
    { "name": "Study shade", "integrationID": "01:01:00:02:01", "deviceType": "shade" },
    { "name": "Lounge blind", "integrationID": "01:01:00:03:01", "deviceType": "blind" }
  ]
}
```

| Field | Notes |
|---|---|
| `host` | Required. IP address or hostname of the processor. |
| `apiPort` | Telnet port. Defaults to 23. |
| `username` | Sent at the processor's `LOGIN:` prompt. On Illumination-era processors this is the whole login string. |
| `password` | Only sent if the processor issues a separate `PASSWORD:` prompt. Leave empty otherwise. |
| `devices[].name` | HomeKit name. |
| `devices[].integrationID` | The address the processor reports in `DL` lines, without the brackets. The HomeKit accessory identity is derived from it, so changing it re-creates the accessory. |
| `devices[].deviceType` | `light` (default), `shade` or `blind`. |
| `devices[].isDimmable` | Lights only. Omitted means not dimmable. |
| `devices[].raiseLevel`, `lowerLevel`, `stopLevel` | Blinds only. Defaults 16, 35 and 0. |

### Device types

- **light**: a Lightbulb. Turning a dimmable light on restores its last level rather than jumping to 100%.
- **shade**: a Window Covering whose position is the dimmer level. Position state follows the processor's confirmation.
- **blind**: a blind whose motor is driven by relays, where the dimmer level is a command code rather than a position. HomeKit shows three switches named `<name> Raise`, `<name> Lower` and `<name> Stop`. Raise and Lower stay on while the processor reports the matching code and send the stop code when switched off; Stop is momentary. Because the processor keeps reporting the last code, the switches turn off on their own after a minute.

Devices with a missing name or integration ID, or with a duplicate integration ID, are skipped with a warning in the Homebridge log. A missing host or an invalid port is logged as an error and the plugin stays inactive.

## Getting the integration IDs

The processor stores its database as XML. The processor allows anonymous FTP; `fullxml.dat` is a zip that contains the XML file. On the author's processor the credentials `LutronGUI` / `jetski` also worked for the processor software. Lutron's [XML extraction FAQ](https://www.lutron.com/TechnicalDocumentLibrary/HWQS_XML_Extraction_FAQ.pdf) describes the process for QS systems.

`LutronXML_Parsin_Tool/DbXParser.html` is a small browser page that converts that XML into a `devices` array for this plugin. Open it in a browser, fill in host, port and login, load the XML file, and paste the generated JSON into your Homebridge configuration. It does no validation, so check the result.

The simplest way to confirm an integration ID is to connect with telnet, send `DLMON`, operate the load from a keypad, and read the address from the `DL, [address], level` line the processor prints.

## Default processor credentials

Try the ones your installer provided first. Known defaults on various HomeWorks systems include `jetski` (Illumination telnet login), `lutron` / `integration` and `nwk` / `nwk`.

## Development

```bash
npm install
npm run lint       # ESLint, warnings fail
npm run typecheck  # tsc without emitting
npm test           # vitest unit tests (protocol framing, config, controllers, HAP accessories)
npm run build      # compiles src/ to dist/
npm run watch      # build, npm link, then restart Homebridge on changes (homebridge -I -D)
```

`known_commands.txt` is the processor's own `HELP` output and documents every command the telnet interface accepts.

## Licence

Apache-2.0. Original work by kikolobo.
