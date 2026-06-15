'use strict';
const { Driver } = require('homey');
const { Client } = require('@2colors/esphome-native-api');

class ESPHomeHRVDriver extends Driver {

  async onInit() {
    this.log('ESPHome HRV Driver initialized');
  }

  async onPair(session) {
    let validatedSettings = null;

    session.setHandler('validate', async ({ ip, port, encryptionKey }) => {
      ip = (ip || '').trim();
      if (!ip) throw new Error('Please enter an IP address.');

      port = parseInt(port, 10) || 6053;

      // Attempt a real connection to verify the details
      await new Promise((resolve, reject) => {
        const client = new Client({
          host: ip,
          port,
          encryptionKey: encryptionKey || undefined,
          clientInfo: 'homey-esphome-hrv-pair',
          initializeDeviceInfo: false,
          initializeListEntities: false,
          initializeSubscribeStates: false,
          reconnect: false,
        });

        const timeout = setTimeout(() => {
          client.disconnect();
          reject(new Error('Connection timed out. Check the IP address and port.'));
        }, 8000);

        client.on('connected', () => {
          clearTimeout(timeout);
          client.disconnect();
          resolve();
        });

        client.on('error', (err) => {
          clearTimeout(timeout);
          reject(new Error('Connection failed: ' + err.message));
        });

        client.connect();
      });

      validatedSettings = { ip, port, encryptionKey: encryptionKey || '' };
      this.log('Validated ESPHome device at', ip + ':' + port);
    });

    session.setHandler('list_devices', async () => {
      if (!validatedSettings) throw new Error('No validated device — go back and enter the connection details.');
      return [{
        name: 'ESPHome HRV',
        data: { id: 'esphome_hrv_' + validatedSettings.ip.replace(/\./g, '_') },
        settings: validatedSettings,
      }];
    });
  }

}

module.exports = ESPHomeHRVDriver;
