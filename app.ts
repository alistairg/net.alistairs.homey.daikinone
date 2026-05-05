import Homey from 'homey';
import { DaikinOneApi } from './lib/DaikinOneApi';

export default class DaikinOneApp extends Homey.App {

  private _api: DaikinOneApi | null = null;

  async onInit(): Promise<void> {
    this.log('Daikin One app initialized');
    this.refreshApi();

    // If credentials change after pair/repair, rebuild the singleton.
    this.homey.settings.on('set', (key: string) => {
      if (key === 'daikin_email' || key === 'daikin_integrator_token') {
        this.refreshApi();
      }
    });
  }

  /**
   * Returns the shared API client, or null if no credentials are stored
   * yet (initial install before pairing). Devices and drivers should call
   * this on every operation rather than caching the reference, so a
   * settings update propagates immediately.
   */
  getApi(): DaikinOneApi | null {
    return this._api;
  }

  private refreshApi(): void {
    const email = this.homey.settings.get('daikin_email') as string | null;
    const token = this.homey.settings.get('daikin_integrator_token') as string | null;

    if (!email || !token) {
      this._api = null;
      return;
    }

    if (this._api) {
      // Reuse the existing instance so devices that hold a reference
      // see the new credentials and the cached token is invalidated.
      this._api.setCredentials(email, token);
    } else {
      this._api = new DaikinOneApi(email, token, (...args: unknown[]) => this.log(...args));
    }
  }
}

module.exports = DaikinOneApp;
