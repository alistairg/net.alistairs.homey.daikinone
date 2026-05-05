import Homey from 'homey';
import { DaikinOneApi, DaikinDeviceState, DaikinApiError } from '../../lib/DaikinOneApi';
import type DaikinOneApp from '../../app';
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

  private pollTimer: NodeJS.Timeout | null = null;
  private lastState: DaikinDeviceState | null = null;
  private writeInProgress = false;

  /**
   * Always reads from the app singleton, so credential changes during
   * a session (e.g. user re-pairs) propagate without device restart.
   */
  private get api(): DaikinOneApi | null {
    return (this.homey.app as DaikinOneApp).getApi();
  }

  async onInit(): Promise<void> {
    this.log('DaikinOneThermostat initialized:', this.getName());

    if (!this.api) {
      await this.setUnavailable('No credentials configured. Please re-pair the device.');
      return;
    }

    // Initial poll to get device state and configure capabilities
    await this.pollDeviceState();

    // Start polling
    this.pollTimer = this.homey.setInterval(
      () => this.pollDeviceState().catch((err) => this.error('Poll error:', err)),
      POLL_INTERVAL_MS,
    );

    // Register capability listeners
    this.registerCapabilityListener('target_temperature', (value: number) =>
      this.onTargetTemperature(value),
    );

    this.registerCapabilityListener('thermostat_mode', (value: string) =>
      this.onThermostatMode(value),
    );

    this.registerCapabilityListener('schedule_enabled', (value: boolean) =>
      this.onScheduleEnabled(value),
    );

    // Register setpoint listeners if already present
    if (this.hasCapability('target_temperature.heat')) {
      this.registerCapabilityListener('target_temperature.heat', (value: number) =>
        this.onHeatSetpoint(value),
      );
    }
    if (this.hasCapability('target_temperature.cool')) {
      this.registerCapabilityListener('target_temperature.cool', (value: number) =>
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
    // target_temperature.heat: present when device supports heating
    const supportsHeat = state.modeLimit === MODE_LIMIT.NONE ||
                         state.modeLimit === MODE_LIMIT.ALL ||
                         state.modeLimit === MODE_LIMIT.HEAT_ONLY;

    if (supportsHeat && !this.hasCapability('target_temperature.heat')) {
      await this.addCapability('target_temperature.heat');
      this.registerCapabilityListener('target_temperature.heat', (value: number) =>
        this.onHeatSetpoint(value),
      );
      this.log('Added target_temperature.heat');
    } else if (!supportsHeat && this.hasCapability('target_temperature.heat')) {
      await this.removeCapability('target_temperature.heat');
      this.log('Removed target_temperature.heat');
    }

    // target_temperature.cool: present when device supports cooling
    const supportsCool = state.modeLimit === MODE_LIMIT.NONE ||
                         state.modeLimit === MODE_LIMIT.ALL ||
                         state.modeLimit === MODE_LIMIT.COOL_ONLY;

    if (supportsCool && !this.hasCapability('target_temperature.cool')) {
      await this.addCapability('target_temperature.cool');
      this.registerCapabilityListener('target_temperature.cool', (value: number) =>
        this.onCoolSetpoint(value),
      );
      this.log('Added target_temperature.cool');
    } else if (!supportsCool && this.hasCapability('target_temperature.cool')) {
      await this.removeCapability('target_temperature.cool');
      this.log('Removed target_temperature.cool');
    }

    // Update setpoint options from device-reported limits
    if (this.hasCapability('target_temperature.heat')) {
      await this.setCapabilityOptions('target_temperature.heat', {
        title: { en: 'Heating Target' },
        min: state.setpointMinimum,
        max: state.setpointMaximum,
        step: 0.5,
      });
    }
    if (this.hasCapability('target_temperature.cool')) {
      await this.setCapabilityOptions('target_temperature.cool', {
        title: { en: 'Cooling Target' },
        min: state.setpointMinimum,
        max: state.setpointMaximum,
        step: 0.5,
      });
    }

    // Fan capabilities: only for unitary systems
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

    // Update thermostat_mode enum values
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

    // Setpoint subcapabilities — always update both if present
    await this.safeSetCapabilityValue('target_temperature.heat', state.heatSetpoint);
    await this.safeSetCapabilityValue('target_temperature.cool', state.coolSetpoint);

    // Main target_temperature ring: mode + equipment-aware display
    // In heat/cool mode, shows the active setpoint. In auto, follows equipment status.
    // When idle or off, shows room temp so the ring color goes neutral.
    const targetTemp = this.resolveTargetTemperature(currentMode, statusKey, state);
    await this.safeSetCapabilityValue('target_temperature', targetTemp);

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

    if (currentMode === 'off') {
      throw new Error('Climate control is off. Turn on to adjust target.');
    }
    if (currentMode === 'auto') {
      throw new Error('Auto climate control is active. Adjust the Heat and Cool setpoints as needed.');
    }

    // Heat or cool mode — delegate to the relevant setpoint handler
    if (currentMode === 'heat') {
      await this.onHeatSetpoint(value);
    } else {
      await this.onCoolSetpoint(value);
    }

    // Keep the subcapability ring in sync
    if (currentMode === 'heat') {
      await this.safeSetCapabilityValue('target_temperature.heat', value);
    } else {
      await this.safeSetCapabilityValue('target_temperature.cool', value);
    }
  }

  private async onHeatSetpoint(value: number): Promise<void> {
    if (!this.api || !this.lastState) {
      throw new Error('Device not ready');
    }

    const state = this.lastState;
    const heatSetpoint = value;
    const coolSetpoint = Math.max(state.coolSetpoint, value + state.setpointDelta);

    await this.sendMsp(state.mode, heatSetpoint, coolSetpoint);

    // Optimistically sync main ring if we're in heat mode
    const currentMode = DAIKIN_MODE_TO_HOMEY[state.mode] ?? 'off';
    if (currentMode === 'heat') {
      await this.safeSetCapabilityValue('target_temperature', value);
    }
  }

  private async onCoolSetpoint(value: number): Promise<void> {
    if (!this.api || !this.lastState) {
      throw new Error('Device not ready');
    }

    const state = this.lastState;
    const coolSetpoint = value;
    const heatSetpoint = Math.min(state.heatSetpoint, value - state.setpointDelta);

    await this.sendMsp(state.mode, heatSetpoint, coolSetpoint);

    // Optimistically sync main ring if we're in cool mode
    const currentMode = DAIKIN_MODE_TO_HOMEY[state.mode] ?? 'off';
    if (currentMode === 'cool') {
      await this.safeSetCapabilityValue('target_temperature', value);
    }
  }

  private async onThermostatMode(value: string): Promise<void> {
    if (!this.api || !this.lastState) {
      throw new Error('Device not ready');
    }

    const state = this.lastState;
    const daikinMode = value === 'emergency_heat' ? 4 : (HOMEY_MODE_TO_DAIKIN[value] ?? 0);

    await this.sendMsp(daikinMode, state.heatSetpoint, state.coolSetpoint);

    // Immediately update target_temperature to reflect the new mode
    const statusKey = EQUIPMENT_STATUS[state.equipmentStatus]?.toLowerCase() ?? 'idle';
    const targetTemp = this.resolveTargetTemperature(value, statusKey, state);
    await this.safeSetCapabilityValue('target_temperature', targetTemp);
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

  private async sendMsp(mode: number, heatSetpoint: number, coolSetpoint: number): Promise<void> {
    if (!this.api) {
      throw new Error('Device not ready');
    }

    const deviceId = this.getData().id;

    const state = this.lastState;
    if (state) {
      heatSetpoint = this.clamp(heatSetpoint, state.setpointMinimum, state.setpointMaximum);
      coolSetpoint = this.clamp(coolSetpoint, state.setpointMinimum, state.setpointMaximum);

      if (coolSetpoint - heatSetpoint < state.setpointDelta) {
        coolSetpoint = heatSetpoint + state.setpointDelta;
      }
    }

    await this.api.setModeAndSetpoints(deviceId, { mode, heatSetpoint, coolSetpoint });
    this.scheduleDelayedPoll();
  }

  private scheduleDelayedPoll(): void {
    if (this.writeInProgress) return;
    this.writeInProgress = true;

    this.homey.setTimeout(async () => {
      this.writeInProgress = false;
      await this.pollDeviceState().catch((err) => this.error('Post-write poll error:', err));
    }, POST_WRITE_DELAY_MS);
  }

  private async safeSetCapabilityValue(capability: string, value: unknown): Promise<void> {
    if (this.hasCapability(capability) && value !== undefined && value !== null) {
      await this.setCapabilityValue(capability, value).catch((err) =>
        this.error(`Failed to set ${capability}:`, err),
      );
    }
  }

  /**
   * Determine what target_temperature should display based on mode and equipment activity.
   * Returns the active setpoint when heating/cooling, or room temp when idle/off (neutral ring).
   */
  private resolveTargetTemperature(
    mode: string,
    equipmentStatus: string,
    state: DaikinDeviceState,
  ): number {
    switch (mode) {
      case 'heat':
        return state.heatSetpoint;
      case 'cool':
        return state.coolSetpoint;
      case 'auto':
        if (equipmentStatus === 'heating' || equipmentStatus === 'auxiliary_heat') {
          return state.heatSetpoint;
        }
        if (equipmentStatus === 'cooling' || equipmentStatus === 'dehumidifying') {
          return state.coolSetpoint;
        }
        return state.tempIndoor;
      default: // off
        return state.tempIndoor;
    }
  }

  private deviceSupportsFan(_model: string): boolean {
    if (!this.lastState) return false;
    return this.lastState.fanCirculate !== undefined;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }
}

module.exports = DaikinOneThermostat;
