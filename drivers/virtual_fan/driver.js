'use strict';

const { Driver } = require('homey');

class VirtualFanDriver extends Driver {

  async onInit() {
    this.log('OmniBreeze Fan driver initialized');
  }

  async onPair(session) {
    session.setHandler('list_devices', async () => {
      return [
        {
          name: 'OmniBreeze Fan',
          data: {
            id: `omnibreeze_fan_${Date.now()}`
          },
          settings: {
            mqtt_broker: '',
            mqtt_port: 1883,
            mqtt_username: '',
            mqtt_password: '',
            mqtt_topic: 'omnibreeze-fan-1'
          }
        }
      ];
    });
  }

}

module.exports = VirtualFanDriver;
