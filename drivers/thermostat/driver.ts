import Homey from 'homey';
import { DaikinOneApi } from '../../lib/DaikinOneApi';

class DaikinOneDriver extends Homey.Driver {

  async onInit(): Promise<void> {
    this.log('DaikinOneDriver initialized');
  }

  async onPair(session: Homey.Driver.PairSession): Promise<void> {
    let api: DaikinOneApi | null = null;

    session.setHandler('login', async (data: { username: string; password: string }) => {
      const email = data.username.trim();
      const integratorToken = data.password.trim();

      if (!email || !integratorToken) {
        throw new Error('Please enter both your email and integrator token.');
      }

      api = new DaikinOneApi(email, integratorToken);
      const valid = await api.validate();

      if (!valid) {
        throw new Error(
          'Could not connect to Daikin One. Please check your email and integrator token.',
        );
      }

      // Store credentials at the app level for all devices to share
      this.homey.settings.set('daikin_email', email);
      this.homey.settings.set('daikin_integrator_token', integratorToken);

      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!api) {
        throw new Error('Please complete the login step first.');
      }

      const devices = await api.getDevices();

      return devices.map((device) => ({
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
