'use strict';

const { Device } = require('homey');

class VirtualButtonDevice extends Device {

  async onInit() {
    this.log('Virtual Button Device has been initialized');

    // Initialize buttons based on settings
    await this.initializeButtons();

    this.log('Virtual Button Device initialization complete');
  }

  async initializeButtons(numberOfButtons = null) {
    // Allow passing numberOfButtons directly, otherwise get from settings
    if (numberOfButtons === null) {
      numberOfButtons = this.getSetting('number_of_buttons') || 1;
    }
    this.log(`Initializing ${numberOfButtons} button(s)`);

    // First, remove any buttons beyond the configured number
    for (let i = 10; i >= 1; i--) {
      const capabilityId = i === 1 ? 'button' : `button.${i}`;

      if (i > numberOfButtons && this.hasCapability(capabilityId)) {
        await this.removeCapability(capabilityId);
        this.log(`Removed capability: ${capabilityId}`);
      }
    }

    // Then add buttons up to the configured number
    for (let i = 1; i <= numberOfButtons; i++) {
      const capabilityId = i === 1 ? 'button' : `button.${i}`;

      // Add button if it doesn't exist
      if (!this.hasCapability(capabilityId)) {
        await this.addCapability(capabilityId);
        this.log(`Added capability: ${capabilityId}`);
      }

      // Set capability options for display name
      await this.setCapabilityOptions(capabilityId, {
        title: {
          en: `Button ${i}`
        }
      }).catch(err => this.log(`Could not set capability options for ${capabilityId}:`, err));

      // Only register capability listener if not already registered
      if (!this.hasCapabilityListener(capabilityId)) {
        this.registerCapabilityListener(capabilityId, async () => {
          await this.pressButton(i.toString());
        });
      }
    }
  }

  hasCapabilityListener(capabilityId) {
    // Check if listener is already registered by checking if _capabilityInstances exists
    return this._capabilityInstances && this._capabilityInstances[capabilityId] && this._capabilityInstances[capabilityId]._listenerRegistered;
  }

  async pressButton(buttonNumber) {
    const numberOfButtons = this.getSetting('number_of_buttons') || 1;
    const buttonNum = parseInt(buttonNumber);

    // Check if the button number is within the configured range
    if (buttonNum > numberOfButtons) {
      this.error(`Button ${buttonNumber} is not configured (only ${numberOfButtons} buttons available)`);
      throw new Error(`Button ${buttonNumber} is not configured. This device only has ${numberOfButtons} button(s).`);
    }

    this.log(`Button ${buttonNumber} pressed`);

    // Trigger the flow card through the driver
    const trigger = this.driver.buttonPressedTrigger;
    if (trigger) {
      await trigger.trigger(this, {}, { button_number: buttonNumber })
        .then(() => this.log(`Triggered virtual_button_pressed for button ${buttonNumber}`))
        .catch(err => this.error('Error triggering virtual_button_pressed', err));
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings were changed', { oldSettings, newSettings, changedKeys });

    // If number of buttons changed, reinitialize buttons with the new value
    if (changedKeys.includes('number_of_buttons')) {
      this.log(`Number of buttons changed from ${oldSettings.number_of_buttons} to ${newSettings.number_of_buttons}`);
      await this.initializeButtons(newSettings.number_of_buttons);
    }
  }

  async onDeleted() {
    this.log('Virtual Button Device has been deleted');
  }

}

module.exports = VirtualButtonDevice;
