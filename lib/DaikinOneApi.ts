import https from 'https';

const BASE_URL = 'https://integrator-api.daikinskyport.com';

// Injected at build time via env/config. Falls back to env var for local development.
const API_KEY = process.env.DAIKIN_API_KEY ?? '__DAIKIN_API_KEY__';

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
  geofencingEnabled: boolean;
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

export class DaikinOneApi {
  private email: string;
  private integratorToken: string;
  private tokenData: TokenData | null = null;
  private activeRequests = 0;
  private requestQueue: Array<{ resolve: () => void }> = [];

  constructor(email: string, integratorToken: string) {
    this.email = email;
    this.integratorToken = integratorToken;
  }

  /**
   * Validate that the credentials are correct by attempting to get a token and list devices.
   */
  async validate(): Promise<boolean> {
    try {
      await this.ensureToken();
      await this.getDevices();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all locations and their thermostats.
   */
  async getDevices(): Promise<DaikinDeviceInfo[]> {
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
      return this.tokenData.accessToken;
    }

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
            if (res.statusCode === 200) {
              try {
                resolve(JSON.parse(data) as T);
              } catch {
                reject(new DaikinApiError('Invalid JSON response', res.statusCode));
              }
            } else if (res.statusCode === 401) {
              // Token expired - clear it so next request re-authenticates
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
