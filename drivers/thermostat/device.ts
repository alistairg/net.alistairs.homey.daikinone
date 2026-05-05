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

// Emergency heat mode for Homey (only shown when hardware supports it).
// Frozen because this object is pushed into thermostat_mode's `values`
// array via setCapabilityOptions — defensive against accidental mutation.
const EMERGENCY_HEAT_MODE = Object.freeze({ id: 'emergency_heat', title: { en: 'Emergency Heat' } });

// Tolerate this many consecutive transient poll failures before flipping the
// device to unavailable. 401 (auth) is sticky regardless and bypasses this.
const FAILURE_TOLERANCE = 3;

// Spread of jitter applied to the poll interval so multiple devices don't
// fire in lockstep. The Daikin API caps at 3 concurrent requests; with N
// devices polling on the same tick we'd routinely exceed that.
const POLL_JITTER_MS = 30_000;

class DaikinOneThermostat extends Homey.Device {

  private pollTimer: NodeJS.Timeout | null = null;
  private delayedPollTimer: NodeJS.Timeout | null = null;
  private lastState: DaikinDeviceState | null = null;
  private writeInProgress = false;
  private consecutiveFailures = 0;
  private registeredListeners = new Set<string>();
  // Last setpoint min/max we wrote via setCapabilityOptions, so we can
  // skip the no-op write on every poll. Residential thermostat limits
  // basically never change at runtime.
  private lastSetpointBounds: { min: number; max: number } | null = null;

  /**
   * Always reads from the app singleton, so credential changes during
   * a session (e.g. user re-pairs) propagate without device restart.
   */
  private get api(): DaikinOneApi | null {
    return (this.homey.app as DaikinOneApp).getApi();
  }

  async onInit(): Promise<void> {
    await super.onInit();
    this.log('DaikinOneThermostat initialized:', this.getName());

    if (!this.api) {
      await this.setUnavailable('No credentials configured. Please re-pair the device.');
      return;
    }

    // Initial poll to get device state and configure capabilities
    await this.pollDeviceState();

    // Start polling with a per-device random offset, so multiple devices
    // don't all hit the API on the same tick.
    const jitter = Math.floor(Math.random() * POLL_JITTER_MS);
    this.pollTimer = this.homey.setInterval(
      () => this.pollDeviceState().catch((err) => this.error('Poll error:', err)),
      POLL_INTERVAL_MS + jitter,
    );

    // Register capability listeners. Always-present capabilities go here;
    // dynamic capabilities (heat/cool setpoints, fan) register from
    // syncDynamicCapabilities via registerCapabilityListenerOnce so that
    // an addCapability cycle doesn't double-fire the listener.
    this.registerCapabilityListenerOnce('target_temperature', (value: number) =>
      this.onTargetTemperature(value),
    );

    this.registerCapabilityListenerOnce('thermostat_mode', (value: string) =>
      this.onThermostatMode(value),
    );

    this.registerCapabilityListenerOnce('schedule_enabled', (value: boolean) =>
      this.onScheduleEnabled(value),
    );

    if (this.hasCapability('target_temperature.heat')) {
      this.registerCapabilityListenerOnce('target_temperature.heat', (value: number) =>
        this.onHeatSetpoint(value),
      );
    }
    if (this.hasCapability('target_temperature.cool')) {
      this.registerCapabilityListenerOnce('target_temperature.cool', (value: number) =>
        this.onCoolSetpoint(value),
      );
    }
    if (this.hasCapability('fan_circulate_mode')) {
      this.registerCapabilityListenerOnce('fan_circulate_mode', (value: string) =>
        this.onFanCirculateMode(value),
      );
    }
    if (this.hasCapability('fan_circulate_speed')) {
      this.registerCapabilityListenerOnce('fan_circulate_speed', (value: string) =>
        this.onFanCirculateSpeed(value),
      );
    }
  }

  /**
   * Idempotent capability listener registration. Homey's
   * registerCapabilityListener doesn't deduplicate, so without this
   * helper we'd attach a second handler whenever a dynamic capability
   * gets removed and re-added (e.g. modeLimit changes at runtime).
   */
  private registerCapabilityListenerOnce(
    capability: string,
    listener: (value: any, opts?: any) => Promise<void>,
  ): void {
    if (this.registeredListeners.has(capability)) return;
    this.registerCapabilityListener(capability, listener);
    this.registeredListeners.add(capability);
  }

  async onDeleted(): Promise<void> {
    await super.onDeleted();
    this.log('DaikinOneThermostat deleted:', this.getName());
    this.clearPollTimer();
  }

  async onUninit(): Promise<void> {
    await super.onUninit();
    this.clearPollTimer();
  }

  private clearPollTimer(): void {
    if (this.pollTimer) {
      this.homey.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.delayedPollTimer) {
      this.homey.clearTimeout(this.delayedPollTimer);
      this.delayedPollTimer = null;
    }
  }

  // ── Polling ──────────────────────────────────────────────────

  async pollDeviceState(): Promise<void> {
    if (!this.api) return;

    try {
      const deviceId = this.getData().id;
      const state = await this.api.getDeviceState(deviceId);

      this.lastState = state;
      this.consecutiveFailures = 0;

      // Configure dynamic capabilities based on device state
      await this.syncDynamicCapabilities(state);

      // Update all capability values
      await this.syncCapabilityValues(state);

      // Mark available if it was previously unavailable
      if (!this.getAvailable()) {
        await this.setAvailable();
      }
    } catch (err) {
      // Auth failures are sticky — no point in tolerating them, the user
      // needs to re-pair. Same for the panel reporting itself offline.
      if (err instanceof DaikinApiError) {
        if (err.statusCode === 401) {
          await this.setUnavailable('Authentication failed. Please re-pair the device.');
          return;
        }
        if (err.message === 'DeviceOfflineException') {
          await this.setUnavailable('Thermostat is offline.');
          return;
        }
      }

      // Otherwise, transient failure — count it, only flip to unavailable
      // after enough consecutive misses. Avoids UI flicker on momentary
      // network blips and 429 backoffs.
      this.consecutiveFailures++;
      const reason = err instanceof Error ? err.message : String(err);
      this.error(`Poll error (${this.consecutiveFailures}/${FAILURE_TOLERANCE}):`, reason);

      if (this.consecutiveFailures >= FAILURE_TOLERANCE) {
        await this.setUnavailable(`Unable to reach Daikin One cloud: ${reason}`);
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
      this.registerCapabilityListenerOnce('target_temperature.heat', (value: number) =>
        this.onHeatSetpoint(value),
      );
      this.log('Added target_temperature.heat');
    } else if (!supportsHeat && this.hasCapability('target_temperature.heat')) {
      await this.removeCapability('target_temperature.heat');
      this.registeredListeners.delete('target_temperature.heat');
      this.log('Removed target_temperature.heat');
    }

    // target_temperature.cool: present when device supports cooling
    const supportsCool = state.modeLimit === MODE_LIMIT.NONE ||
                         state.modeLimit === MODE_LIMIT.ALL ||
                         state.modeLimit === MODE_LIMIT.COOL_ONLY;

    if (supportsCool && !this.hasCapability('target_temperature.cool')) {
      await this.addCapability('target_temperature.cool');
      this.registerCapabilityListenerOnce('target_temperature.cool', (value: number) =>
        this.onCoolSetpoint(value),
      );
      this.log('Added target_temperature.cool');
    } else if (!supportsCool && this.hasCapability('target_temperature.cool')) {
      await this.removeCapability('target_temperature.cool');
      this.registeredListeners.delete('target_temperature.cool');
      this.log('Removed target_temperature.cool');
    }

    // Update setpoint options from device-reported limits, but only when
    // they actually change. Saves a write per capability per poll cycle.
    const boundsChanged =
      !this.lastSetpointBounds ||
      this.lastSetpointBounds.min !== state.setpointMinimum ||
      this.lastSetpointBounds.max !== state.setpointMaximum;

    if (boundsChanged) {
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
      this.lastSetpointBounds = {
        min: state.setpointMinimum,
        max: state.setpointMaximum,
      };
    }

    // Fan capabilities: only for unitary systems. Detection is via the
    // API response (whether fanCirculate is present), not the model
    // string — the API is the source of truth.
    const supportsFan = this.lastStateHasFanData();

    for (const cap of FAN_CAPABILITIES) {
      if (supportsFan && !this.hasCapability(cap)) {
        await this.addCapability(cap);
        if (cap === 'fan_circulate_mode') {
          this.registerCapabilityListenerOnce(cap, (value: string) =>
            this.onFanCirculateMode(value),
          );
        } else {
          this.registerCapabilityListenerOnce(cap, (value: string) =>
            this.onFanCirculateSpeed(value),
          );
        }
      } else if (!supportsFan && this.hasCapability(cap)) {
        await this.removeCapability(cap);
        this.registeredListeners.delete(cap);
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

  /**
   * User-driven write to the main `target_temperature` ring.
   *
   * The capability fans out to either heatSetpoint or coolSetpoint
   * depending on current mode, and we mirror back to the matching
   * `target_temperature.{heat|cool}` subcapability so the dedicated
   * ring stays consistent.
   *
   * No recursion: setCapabilityValue (used inside the handlers) does
   * not fire the registered capability listener — Homey separates
   * set-from-app from set-from-user. If you ever change one of the
   * inner calls to triggerCapabilityListener, this becomes an infinite
   * loop. See discussion in issue #8.
   */
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

    if (currentMode === 'heat') {
      await this.onHeatSetpoint(value);
      await this.safeSetCapabilityValue('target_temperature.heat', value);
    } else {
      await this.onCoolSetpoint(value);
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

  /**
   * Schedule a state-resync poll {@link POST_WRITE_DELAY_MS} after a write.
   *
   * Daikin needs ~15s before the new state is reflected in /v1/devices.
   * If a second write arrives during that window, we want to reset the
   * timer (always poll 15s after the *most recent* write), not silently
   * drop the follow-up. The previous implementation set
   * writeInProgress=true and bailed out of subsequent calls, leaving the
   * original timer to fire on potentially stale state.
   */
  private scheduleDelayedPoll(): void {
    if (this.delayedPollTimer) {
      this.homey.clearTimeout(this.delayedPollTimer);
    }
    this.writeInProgress = true;
    this.delayedPollTimer = this.homey.setTimeout(async () => {
      this.delayedPollTimer = null;
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

  private lastStateHasFanData(): boolean {
    if (!this.lastState) return false;
    return this.lastState.fanCirculate !== undefined;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }
}

module.exports = DaikinOneThermostat;
