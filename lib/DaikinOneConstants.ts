/**
 * Maps Daikin API mode values to Homey thermostat_mode IDs.
 */
export const DAIKIN_MODE_TO_HOMEY: Record<number, string> = {
  0: 'off',
  1: 'heat',
  2: 'cool',
  3: 'auto',
  4: 'heat', // Emergency heat maps to 'heat' in Homey
};

export const HOMEY_MODE_TO_DAIKIN: Record<string, number> = {
  off: 0,
  heat: 1,
  cool: 2,
  auto: 3,
};

/**
 * Equipment status descriptions (read-only).
 */
export const EQUIPMENT_STATUS: Record<number, string> = {
  0: 'Idle',
  1: 'Cooling',
  2: 'Dehumidifying',
  3: 'Heating',
  4: 'Fan',
  5: 'Auxiliary_heat',
};

/**
 * Fan circulate mode values.
 */
export const FAN_CIRCULATE_MODE: Record<number, string> = {
  0: 'off',
  1: 'always',
  2: 'schedule',
};

export const HOMEY_FAN_CIRCULATE_TO_DAIKIN: Record<string, number> = {
  off: 0,
  always: 1,
  schedule: 2,
};

/**
 * Fan circulate speed values.
 */
export const FAN_SPEED: Record<number, string> = {
  0: 'low',
  1: 'medium',
  2: 'high',
};

export const HOMEY_FAN_SPEED_TO_DAIKIN: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/**
 * Mode limit values.
 */
export const MODE_LIMIT = {
  NONE: 0,
  ALL: 1,
  HEAT_ONLY: 2,
  COOL_ONLY: 3,
} as const;

/**
 * Polling interval in milliseconds (3 minutes as per API rate limits).
 */
export const POLL_INTERVAL_MS = 3 * 60 * 1000;

/**
 * Delay after a write command before polling for updated state.
 */
export const POST_WRITE_DELAY_MS = 15 * 1000;
