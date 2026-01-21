'use strict';

const { Device } = require('homey');

class VirtualButtonDevice extends Device {

  async onInit() {
    this.log('Virtual Button Device has been initialized');

    // Initialize buttons based on settings
    await this.initializeButtons();

    this.log('Virtual Button Device initialization complete');
  }

  async initializeButtons(numberOfButtons = null, forceRefresh = false) {
    // Allow passing numberOfButtons directly, otherwise get from settings
    if (numberOfButtons === null) {
      numberOfButtons = this.getSetting('number_of_buttons') || 1;
    }
    this.log(`Initializing ${numberOfButtons} button(s), forceRefresh: ${forceRefresh}`);

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

      // Get custom name from settings, or use default
      const customName = this.getSetting(`button_${i}_name`);
      const buttonTitle = customName && customName.trim() !== '' ? customName : `Button ${i}`;

      // If forceRefresh is true, remove and re-add the capability to force UI update
      if (forceRefresh && this.hasCapability(capabilityId)) {
        this.log(`Force refreshing capability: ${capabilityId}`);
        await this.removeCapability(capabilityId);
        await this.addCapability(capabilityId);
        this.log(`Re-added capability: ${capabilityId}`);
      } else if (!this.hasCapability(capabilityId)) {
        // Add button if it doesn't exist
        await this.addCapability(capabilityId);
        this.log(`Added capability: ${capabilityId}`);
      }

      // Set capability options for display name
      this.log(`Setting title for ${capabilityId} to: "${buttonTitle}"`);
      await this.setCapabilityOptions(capabilityId, {
        title: {
          en: buttonTitle
        }
      }).catch(err => this.log(`Could not set capability options for ${capabilityId}:`, err));

      // Verify the title was set
      const options = this.getCapabilityOptions(capabilityId);
      this.log(`Verified title for ${capabilityId}:`, options.title);

      // Register capability listener - wrapping in try-catch to suppress warnings
      try {
        this.registerCapabilityListener(capabilityId, async () => {
          await this.pressButton(i.toString());
        });
      } catch (err) {
        // Listener already registered, this is fine
      }
    }
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

    // If any button name changed, update only the affected buttons
    const buttonNameChanges = changedKeys.filter(key => key.startsWith('button_') && key.endsWith('_name'));
    if (buttonNameChanges.length > 0) {
      this.log('Button name(s) changed:', buttonNameChanges);

      for (const key of buttonNameChanges) {
        // Extract button number from key like "button_3_name"
        const buttonNum = parseInt(key.match(/button_(\d+)_name/)[1]);
        const capabilityId = buttonNum === 1 ? 'button' : `button.${buttonNum}`;
        const customName = newSettings[key];
        const buttonTitle = customName && customName.trim() !== '' ? customName : `Button ${buttonNum}`;

        this.log(`Updating ${capabilityId} title to: "${buttonTitle}"`);

        if (this.hasCapability(capabilityId)) {
          // Remove and re-add to force UI refresh
          await this.removeCapability(capabilityId);
          await this.addCapability(capabilityId);

          await this.setCapabilityOptions(capabilityId, {
            title: {
              en: buttonTitle
            }
          });

          // Re-register listener
          try {
            this.registerCapabilityListener(capabilityId, async () => {
              await this.pressButton(buttonNum.toString());
            });
          } catch (err) {
            // Listener already registered
          }

          this.log(`Updated ${capabilityId} successfully`);
        }
      }
    }
  }

  async onDeleted() {
    this.log('Virtual Button Device has been deleted');
  }

}

module.exports = VirtualButtonDevice;
