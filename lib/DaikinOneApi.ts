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

export class DaikinOneApi {
  private email: string;
  private integratorToken: string;
  private tokenData: TokenData | null = null;
  private activeRequests = 0;
  private requestQueue: Array<{ resolve: () => void }> = [];
  private log: LogFn;

  constructor(email: string, integratorToken: string, log?: LogFn) {
    this.email = email;
    this.integratorToken = integratorToken;
    this.log = log ?? console.log;
  }

  /**
   * Validate that the credentials are correct by attempting to get a token and list devices.
   */
  async validate(): Promise<boolean> {
    try {
      this.log('[API] validate: getting token...');
      await this.ensureToken();
      this.log('[API] validate: token OK, listing devices...');
      const devices = await this.getDevices();
      this.log('[API] validate: success, found', devices.length, 'device(s)');
      return true;
    } catch (err) {
      this.log('[API] validate: FAILED:', err);
      return false;
    }
  }

  /**
   * List all locations and their thermostats.
   */
  async getDevices(): Promise<DaikinDeviceInfo[]> {
    this.log('[API] getDevices: fetching /v1/devices');
    const locations = await this.request<DaikinLocation[]>('GET', '/v1/devices');
    this.log('[API] getDevices: raw response:', JSON.stringify(locations).slice(0, 500));
    const devices: DaikinDeviceInfo[] = [];
    for (const location of locations) {
      for (const device of location.devices) {
        devices.push({
          ...device,
          locationName: location.locationName,
        });
      }
    }
    this.log('[API] getDevices: parsed', devices.length, 'device(s):', devices.map(d => `${d.name} (${d.id})`));
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
    if (this.tokenData && Date.now() < this.tokenData.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      this.log('[API] ensureToken: reusing cached token (expires in', Math.round((this.tokenData.expiresAt - Date.now()) / 1000), 's)');
      return this.tokenData.accessToken;
    }

    this.log('[API] ensureToken: requesting new token for', this.email);
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
    const token = await this.ensureToken();
    await this.acquireConcurrencySlot();
    try {
      return await this.httpRequest<T>(method, path, body, true, token);
    } finally {
      this.releaseConcurrencySlot();
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

      this.log(`[API] >>> ${method} ${url.pathname}`, useAuth ? '(auth)' : '(no-auth)', payload ? `body=${payload.slice(0, 200)}` : '');
      this.log(`[API] >>> x-api-key: ${API_KEY.slice(0, 20)}...${API_KEY.slice(-10)} (${API_KEY.length} chars)`);

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
            this.log(`[API] <<< body: ${data.slice(0, 500)}`);

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
              reject(new DaikinApiError('Rate limit exceeded', 429));
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
