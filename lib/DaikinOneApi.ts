import Homey from 'homey';
import https from 'https';

const BASE_URL = 'https://integrator-api.daikinskyport.com';

// env.json vars are exposed via Homey.env at runtime, process.env for build-time injection
const API_KEY = Homey.env.DAIKIN_API_KEY ?? process.env.DAIKIN_API_KEY ?? '__DAIKIN_API_KEY__';

const MAX_CONCURRENT_REQUESTS = 3;
const TOKEN_REFRESH_MARGIN_MS = 2 * 60 * 1000; // Refresh 2 minutes before expiry

export interface DaikinLocation {
  locationName: string;
  devices: DaikinDeviceInfo[];
}

export interface DaikinDeviceInfo {
  id: string;
  name: string;
  model: string;
  firmwareVersion: string;
  locationName: string;
}

export interface DaikinDeviceState {
  equipmentStatus: number;
  mode: number;
  modeLimit: number;
  modeEmHeatAvailable: boolean;
  fan: number;
  fanCirculate: number;
  fanCirculateSpeed: number;
  heatSetpoint: number;
  coolSetpoint: number;
  setpointDelta: number;
  setpointMinimum: number;
  setpointMaximum: number;
  tempIndoor: number;
  humIndoor: number;
  tempOutdoor: number;
  humOutdoor: number;
  scheduleEnabled: boolean;
}

export interface DaikinMspPayload {
  mode: number;
  heatSetpoint: number;
  coolSetpoint: number;
}

export interface DaikinFanPayload {
  fanCirculate: number;
  fanCirculateSpeed: number;
}

interface TokenData {
  accessToken: string;
  expiresAt: number;
}

type LogFn = (...args: unknown[]) => void;

/**
 * Structured result from validate(). Lets callers (pair flow, repair flow,
 * device init) distinguish credential errors from network errors from
 * empty-account so they can show appropriate UX.
 */
export type ValidateResult =
  | { ok: true; deviceCount: number }
  | {
      ok: false;
      reason: 'invalid-credentials' | 'rate-limited' | 'network' | 'no-devices' | 'unknown';
      message: string;
    };

export class DaikinOneApi {
  private email: string;
  private integratorToken: string;
  private tokenData: TokenData | null = null;
  private activeRequests = 0;
  private requestQueue: Array<{ resolve: () => void }> = [];
  private log: LogFn;

  // In-flight token refresh promise. When non-null, a refresh is already
  // underway and concurrent callers should await it rather than racing
  // a second /v1/token request that would invalidate the first one.
  private refreshing: Promise<string> | null = null;

  // Earliest timestamp at which the next request should fire. Set when the
  // server returns 429 with a Retry-After header. Subsequent calls await
  // this so we don't pile on more requests during the backoff window.
  private nextAllowedRequestAt = 0;

  constructor(email: string, integratorToken: string, log?: LogFn) {
    this.email = email;
    this.integratorToken = integratorToken;
    this.log = log ?? console.log;
  }

  /**
   * Update the credentials this API instance uses. Invalidates any cached
   * token. Used when the user re-pairs or updates settings.
   */
  setCredentials(email: string, integratorToken: string): void {
    this.email = email;
    this.integratorToken = integratorToken;
    this.tokenData = null;
    this.refreshing = null;
  }

  /**
   * Validate that the credentials are correct by attempting to get a token
   * and list devices. Returns a structured result so callers can show
   * appropriate UX for the different failure modes.
   */
  async validate(): Promise<ValidateResult> {
    let devices;
    try {
      this.log('[API] validate: getting token...');
      await this.ensureToken();
    } catch (err) {
      if (err instanceof DaikinApiError) {
        if (err.statusCode === 401 || err.statusCode === 403) {
          return { ok: false, reason: 'invalid-credentials', message: err.message };
        }
        if (err.statusCode === 429) {
          return { ok: false, reason: 'rate-limited', message: err.message };
        }
        if (err.statusCode === 0) {
          return { ok: false, reason: 'network', message: err.message };
        }
      }
      return { ok: false, reason: 'unknown', message: err instanceof Error ? err.message : String(err) };
    }

    try {
      this.log('[API] validate: token OK, listing devices...');
      devices = await this.getDevices();
    } catch (err) {
      return { ok: false, reason: 'unknown', message: err instanceof Error ? err.message : String(err) };
    }

    if (devices.length === 0) {
      return { ok: false, reason: 'no-devices', message: 'No thermostats found in this Daikin One account.' };
    }

    this.log('[API] validate: success, found', devices.length, 'device(s)');
    return { ok: true, deviceCount: devices.length };
  }

  /**
   * List all locations and their thermostats.
   */
  async getDevices(): Promise<DaikinDeviceInfo[]> {
    this.log('[API] getDevices: fetching /v1/devices');
    const locations = await this.request<DaikinLocation[]>('GET', '/v1/devices');
    const devices: DaikinDeviceInfo[] = [];
    for (const location of locations) {
      for (const device of location.devices) {
        devices.push({
          ...device,
          locationName: location.locationName,
        });
      }
    }
    this.log('[API] getDevices: parsed', devices.length, 'device(s)');
    return devices;
  }

  /**
   * Get the current state of a thermostat.
   */
  async getDeviceState(deviceId: string): Promise<DaikinDeviceState> {
    return this.request<DaikinDeviceState>('GET', `/v1/devices/${deviceId}`);
  }

  /**
   * Update mode and setpoints. All three fields are required.
   * WARNING: This disables the schedule and away state on the thermostat.
   */
  async setModeAndSetpoints(deviceId: string, payload: DaikinMspPayload): Promise<void> {
    await this.request('PUT', `/v1/devices/${deviceId}/msp`, payload);
  }

  /**
   * Enable or disable the thermostat schedule.
   */
  async setSchedule(deviceId: string, enabled: boolean): Promise<void> {
    await this.request('PUT', `/v1/devices/${deviceId}/schedule`, {
      scheduleEnabled: enabled,
    });
  }

  /**
   * Update fan circulation settings (unitary systems only).
   */
  async setFan(deviceId: string, payload: DaikinFanPayload): Promise<void> {
    await this.request('PUT', `/v1/devices/${deviceId}/fan`, payload);
  }

  private async ensureToken(): Promise<string> {
    // Cached and not expiring soon → use it
    if (this.tokenData && Date.now() < this.tokenData.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return this.tokenData.accessToken;
    }

    // A refresh is already in flight — wait for it instead of starting a second one.
    // Without this, N concurrent requests after expiry would all fire /v1/token in
    // parallel; the second login invalidates the first session and both retries fail.
    if (this.refreshing) {
      return this.refreshing;
    }

    this.refreshing = this.doRefresh();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  private async doRefresh(): Promise<string> {
    this.log('[API] ensureToken: requesting new token');
    const body = {
      email: this.email,
      integratorToken: this.integratorToken,
    };

    // Token request does not count against concurrency limit (it's auth)
    const response = await this.httpRequest<{
      accessToken: string;
      accessTokenExpiresIn: number;
      tokenType: string;
    }>('POST', '/v1/token', body, false);

    this.log('[API] ensureToken: got token, expires in', response.accessTokenExpiresIn, 's');
    this.tokenData = {
      accessToken: response.accessToken,
      expiresAt: Date.now() + response.accessTokenExpiresIn * 1000,
    };

    return this.tokenData.accessToken;
  }

  private async acquireConcurrencySlot(): Promise<void> {
    if (this.activeRequests < MAX_CONCURRENT_REQUESTS) {
      this.activeRequests++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.requestQueue.push({ resolve });
    });
  }

  private releaseConcurrencySlot(): void {
    if (this.requestQueue.length > 0) {
      const next = this.requestQueue.shift()!;
      next.resolve();
    } else {
      this.activeRequests--;
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.awaitRateLimitWindow();
    const token = await this.ensureToken();
    await this.acquireConcurrencySlot();
    try {
      return await this.httpRequest<T>(method, path, body, true, token);
    } finally {
      this.releaseConcurrencySlot();
    }
  }

  /**
   * If a 429 set a Retry-After timestamp, sleep until it elapses.
   * Avoids hammering the API during a rate-limit window.
   */
  private async awaitRateLimitWindow(): Promise<void> {
    const wait = this.nextAllowedRequestAt - Date.now();
    if (wait > 0) {
      this.log(`[API] backing off for ${Math.ceil(wait / 1000)}s (Retry-After)`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  private httpRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    useAuth = true,
    token?: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const url = new URL(path, BASE_URL);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
      };

      if (useAuth && token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const payload = body ? JSON.stringify(body) : undefined;

      this.log(`[API] >>> ${method} ${url.pathname}`, useAuth ? '(auth)' : '(no-auth)');

      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname,
          method,
          headers,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            this.log(`[API] <<< ${method} ${url.pathname} => ${res.statusCode} (${data.length} bytes)`);

            if (res.statusCode === 200) {
              try {
                resolve(JSON.parse(data) as T);
              } catch {
                reject(new DaikinApiError('Invalid JSON response', res.statusCode));
              }
            } else if (res.statusCode === 401) {
              this.tokenData = null;
              reject(new DaikinApiError('Access token expired or invalid', 401));
            } else if (res.statusCode === 429) {
              // Honour Retry-After if the server provides one. Format is
              // either seconds-as-integer or HTTP-date; we handle both.
              // Default fallback is 60s if the header is absent or unparseable.
              const retryAfter = res.headers['retry-after'];
              let waitMs = 60_000;
              if (typeof retryAfter === 'string') {
                const asInt = parseInt(retryAfter, 10);
                if (!Number.isNaN(asInt) && asInt > 0) {
                  waitMs = asInt * 1000;
                } else {
                  const asDate = Date.parse(retryAfter);
                  if (!Number.isNaN(asDate)) {
                    waitMs = Math.max(0, asDate - Date.now());
                  }
                }
              }
              this.nextAllowedRequestAt = Date.now() + waitMs;
              reject(new DaikinApiError(`Rate limit exceeded; backing off ${Math.ceil(waitMs / 1000)}s`, 429));
            } else {
              let message = `HTTP ${res.statusCode}`;
              try {
                const parsed = JSON.parse(data);
                if (parsed.messages) {
                  message = parsed.messages;
                }
              } catch {
                // Use default message
              }
              reject(new DaikinApiError(message, res.statusCode ?? 0));
            }
          });
        },
      );

      req.on('error', (err) => {
        this.log(`[API] !!! ${method} ${url.pathname} network error:`, err.message);
        reject(new DaikinApiError(`Network error: ${err.message}`, 0));
      });

      if (payload) {
        req.write(payload);
      }

      req.end();
    });
  }
}

export class DaikinApiError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'DaikinApiError';
    this.statusCode = statusCode;
  }
}
