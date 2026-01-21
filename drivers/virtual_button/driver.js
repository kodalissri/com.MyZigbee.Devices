'use strict';

const { Driver } = require('homey');

class VirtualButtonDriver extends Driver {

  async onInit() {
    this.log('Virtual Button Driver has been initialized');

    // Register the button press trigger
    this.buttonPressedTrigger = this.homey.flow.getDeviceTriggerCard('virtual_button_pressed')
      .registerRunListener(async (args, state) => {
        this.log(`Trigger listener: args.button_number=${args.button_number}, state.button_number=${state.button_number}`);
        return args.button_number === state.button_number;
      });

    // Register the button press action
    this.homey.flow.getActionCard('press_button')
      .registerRunListener(async (args, state) => {
        this.log(`Action: Pressing button ${args.button_number} on device ${args.device.getName()}`);
        await args.device.pressButton(args.button_number);
      });
  }

  async onPair(session) {
    this.log('Pairing started');

    session.setHandler('list_devices', async () => {
      const devices = [
        {
          name: 'Virtual Button Device',
          data: {
            id: `virtual_button_${Date.now()}`
          },
          settings: {
            number_of_buttons: 1
          }
        }
      ];
      return devices;
    });
  }

}

module.exports = VirtualButtonDriver;
