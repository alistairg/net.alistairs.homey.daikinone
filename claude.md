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
- API key loaded from `process.env.DAIKIN_API_KEY` at runtime, with `__DAIKIN_API_KEY__` placeholder for build-time injection

### Driver (`drivers/thermostat/`)
- **Pairing**: Uses Homey's `login_credentials` template (email + integrator token)
- **Repair**: Same flow, re-stores credentials
- **Device polling**: Every 3 minutes (API minimum). 15-second delay after writes before re-polling.

### Capabilities
Standard Homey capabilities:
- `target_temperature` - heat setpoint in heat/auto mode, cool setpoint in cool mode
- `measure_temperature` - indoor temperature
- `measure_humidity` - indoor humidity
- `thermostat_mode` - off/heat/cool/auto (+ emergency heat when hardware supports it)

Custom capabilities (`.homeycompose/capabilities/`):
- `cool_setpoint` - dynamically added only in auto mode for dual-setpoint control
- `equipment_status` - idle/cooling/heating/dehumidifying/fan (read-only)
- `outdoor_temperature`, `outdoor_humidity` - outdoor sensors (read-only)
- `fan_circulate_mode`, `fan_circulate_speed` - dynamically added only for unitary systems
- `schedule_enabled` - toggle (note: mode/setpoint changes via API disable schedule as a side effect)
- `geofencing_enabled` - read-only indicator

### Dynamic Capability Behaviour
- Capabilities are added/removed at runtime based on device state and model
- `thermostat_mode` enum values update based on `modeLimit` and emergency heat availability
- Setpoint min/max update from device-reported limits per poll

## API Key Handling
- **Local dev**: Create `.env` with `DAIKIN_API_KEY=xxx` (gitignored)
- **Store publish**: `DAIKIN_API_KEY=xxx npm run publish-build` compiles TS then injects key into compiled JS

## Daikin API Reference
See memory file for full API details. Key constraints:
- Poll minimum: 3 minutes per device
- Max 3 concurrent HTTP requests
- Wait 15s after PUT before polling for state
- PUT `/msp` requires all 3 fields (mode, heatSetpoint, coolSetpoint) and disables schedule
- Fan control only works on unitary systems (not VRV/split)
- All temperatures in Celsius

## TODO
- Test with real hardware and API key
- Proper app/driver icon artwork (currently placeholders)
- Flow cards (triggers/conditions/actions) for Homey automations
- Localization beyond English
- Error recovery: retry with backoff on 429/transient failures
