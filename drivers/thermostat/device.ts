import Homey from 'homey';
import { DaikinOneApi, DaikinDeviceState, DaikinApiError } from '../../lib/DaikinOneApi';
import {
  DAIKIN_MODE_TO_HOMEY,
  HOMEY_MODE_TO_DAIKIN,
  EQUIPMENT_STATUS,
  FAN_CIRCULATE_MODE,
  FAN_SPEED,
  HOMEY_FAN_CIRCULATE_TO_DAIKIN,
  HOMEY_FAN_SPEED_TO_DAIKIN,
  MODE_LIMIT,
  POLL_INTERVAL_MS,
  POST_WRITE_DELAY_MS,
} from '../../lib/DaikinOneConstants';

// Capabilities that only apply to unitary systems (not VRV/split)
const FAN_CAPABILITIES = ['fan_circulate_mode', 'fan_circulate_speed'] as const;

// Emergency heat mode for Homey (only shown when hardware supports it)
const EMERGENCY_HEAT_MODE = { id: 'emergency_heat', title: { en: 'Emergency Heat' } };

class DaikinOneThermostat extends Homey.Device {

  private api: DaikinOneApi | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastState: DaikinDeviceState | null = null;
  private writeInProgress = false;

  async onInit(): Promise<void> {
    this.log('DaikinOneThermostat initialized:', this.getName());

    const api = this.getApi();
    if (!api) {
      await this.setUnavailable('No credentials configured. Please re-pair the device.');
      return;
    }
    this.api = api;

    // Initial poll to get device state and configure capabilities
    await this.pollDeviceState();

    // Start polling
    this.pollTimer = this.homey.setInterval(
      () => this.pollDeviceState().catch((err) => this.error('Poll error:', err)),
      POLL_INTERVAL_MS,
    );

    // Register capability listeners for standard capabilities
    this.registerCapabilityListener('target_temperature', (value: number) =>
      this.onTargetTemperature(value),
    );

    this.registerCapabilityListener('thermostat_mode', (value: string) =>
      this.onThermostatMode(value),
    );

    this.registerCapabilityListener('schedule_enabled', (value: boolean) =>
      this.onScheduleEnabled(value),
    );

    // Register cool_setpoint listener if it's currently present
    if (this.hasCapability('cool_setpoint')) {
      this.registerCapabilityListener('cool_setpoint', (value: number) =>
        this.onCoolSetpoint(value),
      );
    }

    // Register fan capability listeners if present
    if (this.hasCapability('fan_circulate_mode')) {
      this.registerCapabilityListener('fan_circulate_mode', (value: string) =>
        this.onFanCirculateMode(value),
      );
    }

    if (this.hasCapability('fan_circulate_speed')) {
      this.registerCapabilityListener('fan_circulate_speed', (value: string) =>
        this.onFanCirculateSpeed(value),
      );
    }
  }

  async onDeleted(): Promise<void> {
    this.log('DaikinOneThermostat deleted:', this.getName());
    this.clearPollTimer();
  }

  async onUninit(): Promise<void> {
    this.clearPollTimer();
  }

  private getApi(): DaikinOneApi | null {
    const email = this.homey.settings.get('daikin_email');
    const token = this.homey.settings.get('daikin_integrator_token');
    if (!email || !token) return null;
    return new DaikinOneApi(email, token);
  }

  private clearPollTimer(): void {
    if (this.pollTimer) {
      this.homey.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ── Polling ──────────────────────────────────────────────────

  async pollDeviceState(): Promise<void> {
    if (!this.api) return;

    try {
      const deviceId = this.getData().id;
      const state = await this.api.getDeviceState(deviceId);

      this.lastState = state;

      // Configure dynamic capabilities based on device state
      await this.syncDynamicCapabilities(state);

      // Update all capability values
      await this.syncCapabilityValues(state);

      // Mark available if it was previously unavailable
      if (!this.getAvailable()) {
        await this.setAvailable();
      }
    } catch (err) {
      if (err instanceof DaikinApiError) {
        if (err.statusCode === 401) {
          await this.setUnavailable('Authentication failed. Please re-pair the device.');
        } else if (err.message === 'DeviceOfflineException') {
          await this.setUnavailable('Thermostat is offline.');
        } else {
          this.error('API error during poll:', err.message);
          await this.setUnavailable(`API error: ${err.message}`);
        }
      } else {
        this.error('Unexpected poll error:', err);
        await this.setUnavailable('Unable to reach Daikin One cloud.');
      }
    }
  }

  /**
   * Add/remove capabilities dynamically based on the thermostat's features.
   */
  private async syncDynamicCapabilities(state: DaikinDeviceState): Promise<void> {
    const currentMode = DAIKIN_MODE_TO_HOMEY[state.mode] ?? 'off';
    const isAutoMode = currentMode === 'auto';

    // cool_setpoint: only present in auto mode
    if (isAutoMode && !this.hasCapability('cool_setpoint')) {
      await this.addCapability('cool_setpoint');
      this.registerCapabilityListener('cool_setpoint', (value: number) =>
        this.onCoolSetpoint(value),
      );
    } else if (!isAutoMode && this.hasCapability('cool_setpoint')) {
      await this.removeCapability('cool_setpoint');
    }

    // Fan capabilities: only for unitary systems (fanCirculate exists and is meaningful)
    // VRV and split systems don't support fan control
    const model = this.getStoreValue('model') as string;
    const supportsFan = this.deviceSupportsFan(model);

    for (const cap of FAN_CAPABILITIES) {
      if (supportsFan && !this.hasCapability(cap)) {
        await this.addCapability(cap);
        if (cap === 'fan_circulate_mode') {
          this.registerCapabilityListener(cap, (value: string) =>
            this.onFanCirculateMode(value),
          );
        } else {
          this.registerCapabilityListener(cap, (value: string) =>
            this.onFanCirculateSpeed(value),
          );
        }
      } else if (!supportsFan && this.hasCapability(cap)) {
        await this.removeCapability(cap);
      }
    }

    // Emergency heat mode: update thermostat_mode values if available
    await this.syncThermostatModeValues(state);
  }

  /**
   * Update thermostat_mode enum values based on modeLimit and emergency heat availability.
   */
  private async syncThermostatModeValues(state: DaikinDeviceState): Promise<void> {
    const values: Array<{ id: string; title: { en: string } }> = [];

    values.push({ id: 'off', title: { en: 'Off' } });

    if (state.modeLimit === MODE_LIMIT.NONE ||
        state.modeLimit === MODE_LIMIT.ALL ||
        state.modeLimit === MODE_LIMIT.HEAT_ONLY) {
      values.push({ id: 'heat', title: { en: 'Heat' } });
    }

    if (state.modeLimit === MODE_LIMIT.NONE ||
        state.modeLimit === MODE_LIMIT.ALL ||
        state.modeLimit === MODE_LIMIT.COOL_ONLY) {
      values.push({ id: 'cool', title: { en: 'Cool' } });
    }

    if (state.modeLimit === MODE_LIMIT.NONE || state.modeLimit === MODE_LIMIT.ALL) {
      values.push({ id: 'auto', title: { en: 'Auto' } });
    }

    if (state.modeEmHeatAvailable) {
      values.push(EMERGENCY_HEAT_MODE);
    }

    await this.setCapabilityOptions('thermostat_mode', { values });
  }

  /**
   * Sync all capability values from the device state.
   */
  private async syncCapabilityValues(state: DaikinDeviceState): Promise<void> {
    const currentMode = DAIKIN_MODE_TO_HOMEY[state.mode] ?? 'off';

    // Standard capabilities
    await this.safeSetCapabilityValue('measure_temperature', state.tempIndoor);
    await this.safeSetCapabilityValue('measure_humidity', state.humIndoor);
    await this.safeSetCapabilityValue('thermostat_mode', currentMode);

    // Equipment status
    const statusKey = EQUIPMENT_STATUS[state.equipmentStatus]?.toLowerCase() ?? 'idle';
    await this.safeSetCapabilityValue('equipment_status', statusKey);

    // Outdoor sensors
    await this.safeSetCapabilityValue('outdoor_temperature', state.tempOutdoor);
    await this.safeSetCapabilityValue('outdoor_humidity', state.humOutdoor);

    // Schedule & geofencing
    await this.safeSetCapabilityValue('schedule_enabled', state.scheduleEnabled);
    await this.safeSetCapabilityValue('geofencing_enabled', state.geofencingEnabled);

    // Target temperature: depends on mode
    if (currentMode === 'heat' || currentMode === 'emergency_heat') {
      await this.safeSetCapabilityValue('target_temperature', state.heatSetpoint);
    } else if (currentMode === 'cool') {
      await this.safeSetCapabilityValue('target_temperature', state.coolSetpoint);
    } else if (currentMode === 'auto') {
      // In auto mode, target_temperature is the heat setpoint
      await this.safeSetCapabilityValue('target_temperature', state.heatSetpoint);
      await this.safeSetCapabilityValue('cool_setpoint', state.coolSetpoint);
    }

    // Update target_temperature min/max from device-reported limits
    await this.setCapabilityOptions('target_temperature', {
      min: state.setpointMinimum,
      max: state.setpointMaximum,
      step: 0.5,
    });

    if (this.hasCapability('cool_setpoint')) {
      await this.setCapabilityOptions('cool_setpoint', {
        min: state.setpointMinimum,
        max: state.setpointMaximum,
        step: 0.5,
      });
    }

    // Fan values (if supported)
    if (this.hasCapability('fan_circulate_mode')) {
      const fanMode = FAN_CIRCULATE_MODE[state.fanCirculate] ?? 'off';
      await this.safeSetCapabilityValue('fan_circulate_mode', fanMode);
    }
    if (this.hasCapability('fan_circulate_speed')) {
      const fanSpeed = FAN_SPEED[state.fanCirculateSpeed] ?? 'low';
      await this.safeSetCapabilityValue('fan_circulate_speed', fanSpeed);
    }
  }

  // ── Command handlers ─────────────────────────────────────────

  private async onTargetTemperature(value: number): Promise<void> {
    if (!this.api || !this.lastState) {
      throw new Error('Device not ready');
    }

    const state = this.lastState;
    const currentMode = DAIKIN_MODE_TO_HOMEY[state.mode] ?? 'off';

    let heatSetpoint = state.heatSetpoint;
    let coolSetpoint = state.coolSetpoint;

    if (currentMode === 'heat' || currentMode === 'emergency_heat') {
      heatSetpoint = value;
      // Ensure delta constraint
      coolSetpoint = Math.max(coolSetpoint, value + state.setpointDelta);
    } else if (currentMode === 'cool') {
      coolSetpoint = value;
      heatSetpoint = Math.min(heatSetpoint, value - state.setpointDelta);
    } else if (currentMode === 'auto') {
      // In auto mode, target_temperature controls heat setpoint
      heatSetpoint = value;
      coolSetpoint = Math.max(coolSetpoint, value + state.setpointDelta);
    } else {
      // Off mode - just store the value
      return;
    }

    await this.sendMsp(state.mode, heatSetpoint, coolSetpoint);
  }

  private async onCoolSetpoint(value: number): Promise<void> {
    if (!this.api || !this.lastState) {
      throw new Error('Device not ready');
    }

    const state = this.lastState;
    let heatSetpoint = state.heatSetpoint;
    const coolSetpoint = value;

    // Ensure delta constraint
    heatSetpoint = Math.min(heatSetpoint, coolSetpoint - state.setpointDelta);

    await this.sendMsp(state.mode, heatSetpoint, coolSetpoint);
  }

  private async onThermostatMode(value: string): Promise<void> {
    if (!this.api || !this.lastState) {
      throw new Error('Device not ready');
    }

    const state = this.lastState;
    const daikinMode = value === 'emergency_heat' ? 4 : (HOMEY_MODE_TO_DAIKIN[value] ?? 0);

    await this.sendMsp(daikinMode, state.heatSetpoint, state.coolSetpoint);
  }

  private async onScheduleEnabled(value: boolean): Promise<void> {
    if (!this.api) {
      throw new Error('Device not ready');
    }

    const deviceId = this.getData().id;
    await this.api.setSchedule(deviceId, value);
    this.scheduleDelayedPoll();
  }

  private async onFanCirculateMode(value: string): Promise<void> {
    if (!this.api) {
      throw new Error('Device not ready');
    }

    const deviceId = this.getData().id;
    const daikinValue = HOMEY_FAN_CIRCULATE_TO_DAIKIN[value] ?? 0;
    const currentSpeed = this.lastState?.fanCirculateSpeed ?? 0;

    await this.api.setFan(deviceId, {
      fanCirculate: daikinValue,
      fanCirculateSpeed: currentSpeed,
    });
    this.scheduleDelayedPoll();
  }

  private async onFanCirculateSpeed(value: string): Promise<void> {
    if (!this.api) {
      throw new Error('Device not ready');
    }

    const deviceId = this.getData().id;
    const daikinValue = HOMEY_FAN_SPEED_TO_DAIKIN[value] ?? 0;
    const currentMode = this.lastState?.fanCirculate ?? 0;

    await this.api.setFan(deviceId, {
      fanCirculate: currentMode,
      fanCirculateSpeed: daikinValue,
    });
    this.scheduleDelayedPoll();
  }

  // ── Helpers ──────────────────────────────────────────────────

  /**
   * Send a mode/setpoint update and schedule a delayed poll to read back the result.
   */
  private async sendMsp(mode: number, heatSetpoint: number, coolSetpoint: number): Promise<void> {
    if (!this.api) {
      throw new Error('Device not ready');
    }

    const deviceId = this.getData().id;

    // Clamp setpoints to device limits
    const state = this.lastState;
    if (state) {
      heatSetpoint = this.clamp(heatSetpoint, state.setpointMinimum, state.setpointMaximum);
      coolSetpoint = this.clamp(coolSetpoint, state.setpointMinimum, state.setpointMaximum);

      // Enforce minimum delta
      if (coolSetpoint - heatSetpoint < state.setpointDelta) {
        coolSetpoint = heatSetpoint + state.setpointDelta;
      }
    }

    await this.api.setModeAndSetpoints(deviceId, { mode, heatSetpoint, coolSetpoint });
    this.scheduleDelayedPoll();
  }

  /**
   * After a write, wait the required 15 seconds then poll for updated state.
   */
  private scheduleDelayedPoll(): void {
    if (this.writeInProgress) return;
    this.writeInProgress = true;

    this.homey.setTimeout(async () => {
      this.writeInProgress = false;
      await this.pollDeviceState().catch((err) => this.error('Post-write poll error:', err));
    }, POST_WRITE_DELAY_MS);
  }

  /**
   * Set a capability value, only if the device has that capability.
   */
  private async safeSetCapabilityValue(capability: string, value: unknown): Promise<void> {
    if (this.hasCapability(capability) && value !== undefined && value !== null) {
      await this.setCapabilityValue(capability, value).catch((err) =>
        this.error(`Failed to set ${capability}:`, err),
      );
    }
  }

  /**
   * Determine if the device model supports fan circulation control.
   * VRV and split systems do not support fan control.
   */
  private deviceSupportsFan(model: string): boolean {
    // ONEPLUS and TOUCH on unitary systems support fan control
    // We can't determine the HVAC system type from the model alone,
    // so we check if fanCirculate is meaningful in the state
    if (!this.lastState) return false;

    // If the device reports fanCirculate values, it supports fan control
    // VRV/split systems typically report 0 for fanCirculate and it's not writable
    // The safest heuristic: if we've seen a non-zero fanCirculate or the model is known unitary
    return this.lastState.fanCirculate !== undefined;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }
}

module.exports = DaikinOneThermostat;
