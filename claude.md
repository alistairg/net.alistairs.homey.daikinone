This project is a Homey Pro driver for Daikin One thermostats, targeting the Homey App Store.

## Stack
- Homey SDK v3, TypeScript
- App ID: `net.alistairs.daikinone`
- Daikin One Cloud API (`https://integrator-api.daikinskyport.com`)

## Architecture

### API Client (`lib/DaikinOneApi.ts`)
- Handles auth via email + integrator token -> short-lived access token (15 min TTL)
- Auto-refreshes tokens 2 minutes before expiry
- Concurrency limiter (max 3 simultaneous requests per API spec)
- API key: developer API key (short, ~40 chars) sent as `x-api-key` header
- At runtime, loaded via `Homey.env.DAIKIN_API_KEY` (from `env.json`) with `process.env` and `__DAIKIN_API_KEY__` as fallbacks
- Accepts optional `log` function for debug output

### Driver (`drivers/thermostat/`)
- **Pairing**: Uses Homey's `login_credentials` template. Username = email, Password = integrator token (long JWE, ~1784 chars)
- **Repair**: Same flow, re-stores credentials
- **Device polling**: Every 3 minutes (API minimum). 15-second delay after writes before re-polling.

### Capabilities
Standard Homey capabilities (static, in driver.compose.json):
- `target_temperature` - required by thermostat class but not directly used; subcapabilities handle setpoints
- `measure_temperature` - indoor temperature
- `measure_humidity` - indoor humidity
- `thermostat_mode` - off/heat/cool/auto (+ emergency heat when hardware supports it)

Setpoint subcapabilities (dynamically added based on modeLimit):
- `target_temperature.heat` - "Heating Target" thermostat ring, added when device supports heating
- `target_temperature.cool` - "Cooling Target" thermostat ring, added when device supports cooling

Custom capabilities (`.homeycompose/capabilities/`):
- `equipment_status` - idle/cooling/heating/dehumidifying/fan (read-only)
- `outdoor_temperature`, `outdoor_humidity` - outdoor sensors (read-only)
- `fan_circulate_mode`, `fan_circulate_speed` - dynamically added only for unitary systems
- `schedule_enabled` - toggle (note: mode/setpoint changes via API disable schedule as a side effect)
- `geofencing_enabled` - read-only indicator

### Dynamic Capability Behaviour
- `target_temperature.heat` and `.cool` added/removed based on `modeLimit`
- `fan_circulate_mode` and `fan_circulate_speed` added when device reports fan data (unitary systems only)
- `thermostat_mode` enum values update based on `modeLimit` and emergency heat availability
- Setpoint min/max update from device-reported limits per poll

### Key Lessons Learned
- The `thermostat` device class requires `target_temperature` in the static capabilities list or the app disconnects immediately
- Subcapabilities like `target_temperature.heat` each render as their own thermostat ring in the Homey UI
- `target_temperature_min`/`target_temperature_max` are newer capabilities (>=12.2.0) that render as plain sliders, not thermostat rings — don't use them
- `env.json` is Homey's mechanism for env vars in Docker; access via `Homey.env.VAR_NAME` (not `process.env`)
- `homey app run` runs in Docker on the Homey Pro; `--clean` wipes device data and forces re-pairing

## API Key Handling
- **Local dev**: `env.json` with `DAIKIN_API_KEY` (gitignored). This is the developer API key, not the user's integrator token.
- **Store publish**: `DAIKIN_API_KEY=xxx npm run publish-build` compiles TS then injects key into compiled JS via sed

## Build & Deploy
- `npm run build` — compiles TS and copies assets (app.json, icons, .homeycompose) to `.homeybuild/`
- `homey app run --clean` — deploys to Homey Pro, wipes devices, triggers re-pairing
- `app.json` in root is the composed manifest (must be kept in sync with driver.compose.json manually)

## Daikin API Reference
See memory file for full API details. Key constraints:
- Poll minimum: 3 minutes per device
- Max 3 concurrent HTTP requests
- Wait 15s after PUT before polling for state
- PUT `/msp` requires all 3 fields (mode, heatSetpoint, coolSetpoint) and disables schedule
- Fan control only works on unitary systems (not VRV/split)
- All temperatures in Celsius

## TODO
- Proper app/driver icon artwork (currently placeholders)
- Flow cards (triggers/conditions/actions) for Homey automations
- Localization beyond English
- Error recovery: retry with backoff on 429/transient failures
