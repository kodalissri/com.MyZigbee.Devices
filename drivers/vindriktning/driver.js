'use strict';

const { Driver } = require('homey');

class VindriktningDriver extends Driver {

  async onInit() {
    this.log('VINDRIKTNING Air Quality driver initialized');
  }

  async onPair(session) {
    session.setHandler('list_devices', async () => {
      return [
        {
          name: 'VINDRIKTNING Air Quality',
          data: {
            id: `vindriktning_${Date.now()}`
          },
          settings: {
            mqtt_broker: '10.10.10.250',
            mqtt_port: 1883,
            mqtt_username: '',
            mqtt_password: '',
            mqtt_topic: 'VINDRIKTNING_1'
          }
        }
      ];
    });
  }

}

module.exports = VindriktningDriver;
