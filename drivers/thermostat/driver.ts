import Homey from 'homey';
import { DaikinOneApi } from '../../lib/DaikinOneApi';

class DaikinOneDriver extends Homey.Driver {

  async onInit(): Promise<void> {
    this.log('DaikinOneDriver initialized');
  }

  async onPair(session: Homey.Driver.PairSession): Promise<void> {
    let api: DaikinOneApi | null = null;

    this.log('[Pair] Session started');

    session.setHandler('login', async (data: { username: string; password: string }) => {
      this.log('[Pair] login handler called');

      const email = data.username.trim();
      const integratorToken = data.password.trim();

      if (!email || !integratorToken) {
        this.log('[Pair] login: missing email or token');
        throw new Error('Please enter both your email and integrator token.');
      }

      this.log('[Pair] login: creating API client');
      api = new DaikinOneApi(email, integratorToken, (...args: unknown[]) => this.log(...args));

      this.log('[Pair] login: validating credentials...');
      const valid = await api.validate();
      this.log('[Pair] login: validate returned', valid);

      if (!valid) {
        throw new Error(
          'Could not connect to Daikin One. Please check your email and integrator token.',
        );
      }

      this.homey.settings.set('daikin_email', email);
      this.homey.settings.set('daikin_integrator_token', integratorToken);
      this.log('[Pair] login: credentials stored, returning true');

      return true;
    });

    session.setHandler('list_devices', async () => {
      this.log('[Pair] list_devices handler called');

      if (!api) {
        this.log('[Pair] list_devices: no API client (login not completed)');
        throw new Error('Please complete the login step first.');
      }

      this.log('[Pair] list_devices: fetching devices...');
      const devices = await api.getDevices();
      this.log('[Pair] list_devices: got', devices.length, 'device(s)');

      const result = devices.map((device) => ({
        name: device.name,
        data: {
          id: device.id,
        },
        store: {
          model: device.model,
          firmwareVersion: device.firmwareVersion,
          locationName: device.locationName,
        },
      }));

      this.log('[Pair] list_devices: returning', result.length, 'device(s)');
      return result;
    });
  }

  async onRepair(session: Homey.Driver.PairSession): Promise<void> {
    session.setHandler('login', async (data: { username: string; password: string }) => {
      const email = data.username.trim();
      const integratorToken = data.password.trim();

      if (!email || !integratorToken) {
        throw new Error('Please enter both your email and integrator token.');
      }

      const api = new DaikinOneApi(email, integratorToken);
      const valid = await api.validate();

      if (!valid) {
        throw new Error(
          'Could not connect to Daikin One. Please check your email and integrator token.',
        );
      }

      this.homey.settings.set('daikin_email', email);
      this.homey.settings.set('daikin_integrator_token', integratorToken);

      return true;
    });
  }
}

module.exports = DaikinOneDriver;
