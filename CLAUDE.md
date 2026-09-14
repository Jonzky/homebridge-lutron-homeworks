# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Homebridge **dynamic platform plugin** that exposes Lutron HomeWorks loads to HomeKit over the processor's telnet integration port. It targets the older (Illumination-era) protocol: an `LNET>` prompt, a `LOGIN:` challenge, and commands such as `FADEDIM`, `DLMON`, `RDL` (`known_commands.txt` is the processor's own `HELP` output). It is a fork of kikolobo's `homebridge-lutron-homeworks`; upstream has since moved entirely to the HomeWorks QS protocol (`~OUTPUT`, `#MONITORING`, `QNET>`), so **never merge upstream**. Published to npm as `homebridge-homeworks-alt`.

The code cannot be exercised against the processor from a dev machine. Unit tests cover everything below the socket; behaviour on the real hardware is validated by the owner.

## Commands

```bash
npm run lint        # eslint . --max-warnings=0 (ESLint 10 flat config, eslint.config.mjs)
npm run typecheck   # tsc --noEmit
npm test            # vitest run; npm run test:watch for watch mode
npx vitest run test/network.test.ts        # one file
npx vitest run -t "reconnects with a fresh"  # one test by name
npm run build       # rimraf ./dist && tsc  (dist/ is the published artifact, gitignored)
npm run watch       # build, npm link, nodemon -> tsc && homebridge -I -D on src changes
```

`prepublishOnly` runs lint, tests and build. CI (`.github/workflows/build.yml`) does the same on Node 20/22/24. Engines: Node >= 20.18, Homebridge `^1.8.0 || ^2.0.0-beta.0`; the devDependency compiles against Homebridge 2.4.

## Identity strings that must agree

- `src/settings.ts`: `PLATFORM_NAME = 'Homeworks-alt'` and `PLUGIN_NAME = 'homebridge-homeworks-alt'` (must equal `package.json` `name`).
- `config.schema.json` `pluginAlias` must equal `PLATFORM_NAME` exactly; Homebridge resolves the `platform` key with a case-sensitive map lookup.
- `LutronXML_Parsin_Tool/DbXParser.html` emits `"platform": "Homeworks-alt"`.
- Accessory UUIDs are `hap.uuid.generate(integrationID)`. Changing how the UUID is derived, or the string form of an integration ID, re-creates every accessory in HomeKit and loses room assignments.

## Architecture

Layers, from the socket up. Each lower layer has no dependency on the ones above it and is unit tested on its own.

### `src/protocol.ts` (pure)

`LineFramer` turns TCP chunks into complete lines plus prompt events. Prompts (`LOGIN:`, `PASSWORD:`, `LNET>`, `QNET>`) are not newline-terminated, so they are detected as the trailing partial of a chunk; a command prompt glued to the front of a line is stripped. `parseDlLine` parses `DL, [address], level` and returns null for anything else. `fadeDimCommand` and `requestLevelCommand` produce the exact wire format (`FADEDIM, level, 0, 0, id` and `RDL, id`, spaces included).

### `src/network.ts` (`NetworkEngine`)

Owns the telnet session. State machine:

```
Idle -> Connecting -> Connected --LOGIN:--> Authenticating --LNET>--> Establishing --"Dimmer level monitoring"--> Ready
```

- A command prompt seen in any pre-Ready state sends `DLMON`, so a processor that never asks for a login still reaches Ready. If no prompt arrives after connecting, CRLF is written to provoke one.
- At `LOGIN:` only `username` is written. `password` is written only at a `PASSWORD:` prompt. A repeated `LOGIN:` means rejection: the socket is destroyed and reconnect backoff applies.
- `send()` writes when Ready, otherwise queues (bounded, oldest dropped); the queue flushes on Ready.
- Keepalive: after `idleTimeoutMs` (40 s) of silence `PINFO` is written; a second silent period destroys the socket, which triggers the normal reconnect. Reconnect delay doubles per failure up to 60 s and resets on Ready. Events from a replaced socket are ignored. `shutdown()` stops everything.
- Receive callbacks get one trimmed line per call and are wrapped in try/catch; a throwing callback can never take down the socket handler.
- `createSocket` and all timings are injectable through `EngineOptions`; tests use `test/helpers/fakeSocket.ts` with vitest fake timers.

### `src/config.ts`

`normalizeConfiguration(raw)` validates the platform block and returns `{ configuration | null, problems, warnings }`. Fatal: missing host, bad port, `devices` not an array. Skipped with a warning: device without name or integrationID, duplicate integrationID. `isDimmable` is true only when literally `true` (omitted means not dimmable; the schema default matches). `deviceType` is `light` (default), `shade` or `blind`; blinds get `blindLevels` from `raiseLevel`/`lowerLevel`/`stopLevel` with defaults 16/35/0.

### `src/controllers.ts` (pure state machines)

- `LightController`: `homeKitSetOn`, `homeKitSetBrightness`, `processorLevel`. Turning a dimmable light on restores the last non-zero level after a short debounce so a Brightness set in the same HomeKit transaction wins and only one command goes out. Non-dimmable lights send 100.
- `ShadeController`: level is position. `homeKitSetTarget` sends the level and reports increasing/decreasing until the processor confirms the target; a settle timeout (30 s) stops HomeKit from showing "opening" forever. A report while stopped is a move from elsewhere and updates both current and target.
- `BlindController`: fixed codes for raise/lower/stop, no position. The processor keeps reporting the last code, so motion returns to stopped after 60 s without sending anything.

### `src/homeworksAccessory.ts` (HAP adapters)

`HomeworksAccessory.CreateAccessory` picks the subclass by `deviceType`. Each subclass wraps a controller: `publish` pushes state to characteristics with `updateCharacteristic`, HomeKit writes go through `onGet`/`onSet` (never the legacy `'get'`/`'set'` events). Non-dimmable lights never touch Brightness and remove a stale one from the cache, because HAP silently adds optional characteristics on `updateCharacteristic`. Each subclass calls `pruneServices` to drop services of the other device types left in the cache. Blinds are three `Switch` services with subtypes `raise`, `lower`, `stop`, labelled through `ConfiguredName` (the Home app ignores `Name` for services inside an accessory); it is set only when empty so a Home app rename persists. The platform calls `handleProcessorLevel(level)` and sets `onSendLevel`.

### `src/platform.ts` (glue)

Constructor: normalize config, log problems, build the engine (or stay inert if the config is invalid). On `didFinishLaunching`: reconcile accessories against the Homebridge cache by UUID (add / update / unregister), then `engine.connect()`. On Ready the platform sends `RDL` for every device one second apart. `DL` lines are routed by `parseDlLine` to the accessory whose UUID matches the reported address. On `shutdown` the engine is shut down.

### Tests (`test/`)

`protocol`, `network`, `config`, `controllers`, `homeworksAccessory`. The accessory tests use real `@homebridge/hap-nodejs` `Accessory`/`Service` objects and drive characteristics with `handleSetRequest` / `handleGetRequest`. Homebridge itself is never loaded in tests.

## Conventions

ESLint enforces single quotes, 2-space indent, semicolons, trailing commas on multiline, braces on all blocks, 140 columns. `console` is banned; log through the Homebridge `Logger` (`this.log`, `this.host.log`) with the prefixes `[Network]`, `[Platform]`, `[Accessory][<name>]`. Per-line traffic is logged at debug only.

## Getting processor data

The processor allows anonymous FTP; `fullxml.dat` is a zip containing the XML database. `LutronXML_Parsin_Tool/DbXParser.html` converts that XML into a `devices` array. The most reliable way to learn an integration ID is `DLMON` over telnet and reading the `DL` line the processor prints when the load is operated.
