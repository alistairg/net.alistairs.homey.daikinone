import Homey from 'homey';
import { DaikinOneApi, ValidateResult } from '../../lib/DaikinOneApi';

const VALIDATE_ERROR_MESSAGES: Record<Exclude<ValidateResult, { ok: true }>['reason'], string> = {
  'invalid-credentials': 'Email or integrator token is incorrect. Please check both and try again.',
  'rate-limited': 'Daikin One is rate-limiting requests. Please wait a minute and try again.',
  'network': 'Could not reach Daikin One. Check your internet connection and try again.',
  'no-devices': 'No thermostats found in this Daikin One account.',
  'unknown': 'Could not connect to Daikin One. Please try again.',
};

function messageForValidateFailure(result: Exclude<ValidateResult, { ok: true }>): string {
  return VALIDATE_ERROR_MESSAGES[result.reason] ?? VALIDATE_ERROR_MESSAGES.unknown;
}

class DaikinOneDriver extends Homey.Driver {

  async onInit(): Promise<void> {
    await super.onInit();
    this.log('DaikinOneDriver initialized');
  }

  async onPair(session: Homey.Driver.PairSession): Promise<void> {
    // Pair runs in a temporary API instance — we don't want to mutate the
    // app singleton's credentials until the user has confirmed the pair.
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
      const result = await api.validate();
      this.log('[Pair] login: validate result:', result.ok ? 'OK' : result.reason);

      if (!result.ok) {
        throw new Error(messageForValidateFailure(result));
      }

      // Persist credentials. The app singleton listens for these settings
      // and will rebuild its API client to match.
      this.homey.settings.set('daikin_email', email);
      this.homey.settings.set('daikin_integrator_token', integratorToken);
      this.log('[Pair] login: credentials stored');

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
      const result = await api.validate();

      if (!result.ok) {
        throw new Error(messageForValidateFailure(result));
      }

      this.homey.settings.set('daikin_email', email);
      this.homey.settings.set('daikin_integrator_token', integratorToken);

      return true;
    });
  }
}

module.exports = DaikinOneDriver;
