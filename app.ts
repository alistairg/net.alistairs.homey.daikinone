import Homey from 'homey';

class DaikinOneApp extends Homey.App {

  async onInit(): Promise<void> {
    this.log('Daikin One app initialized');
  }
}

module.exports = DaikinOneApp;
