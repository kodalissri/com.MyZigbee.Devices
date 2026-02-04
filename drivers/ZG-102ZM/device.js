'use strict';

const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');

// DataPoint mapping based on Zigbee2MQTT source
// https://www.zigbee2mqtt.io/devices/ZG-102ZM.html
const dataPoints = {
    vibration: 1,      // Boolean: vibration detected (trueFalse1)
    contact: 101,      // Boolean: contact state (inverted - true = open, false = closed)
    battery: 4,        // Integer: battery percentage (0-100)
    sensitivity: 6     // Integer: vibration sensitivity (1-50)
};

class VibrationContactSensor extends TuyaSpecificClusterDevice {

    async onNodeInit({ zclNode }) {
        this.log('Tuya Vibration Contact Sensor (ZG-102ZM) initialized');

        // Initialize the settings queue for battery-powered device
        this.pendingSettings = [];
        this.settingWriteInProgress = false;

        // Apply capability visibility based on settings
        await this.updateCapabilityVisibility();

        // Listen for Tuya DataPoints
        zclNode.endpoints[1].clusters.tuya.on("response", value => this.handleDataPoint(value));
    }

    async updateCapabilityVisibility() {
        const displayMode = this.getSetting('display_mode') || 'both';
        const showVibration = displayMode === 'both' || displayMode === 'vibration';
        const showContact = displayMode === 'both' || displayMode === 'contact';

        // Handle vibration capability
        if (showVibration && !this.hasCapability('alarm_vibration')) {
            await this.addCapability('alarm_vibration').catch(this.error);
        } else if (!showVibration && this.hasCapability('alarm_vibration')) {
            await this.removeCapability('alarm_vibration').catch(this.error);
        }

        // Handle contact capability
        if (showContact && !this.hasCapability('alarm_contact')) {
            await this.addCapability('alarm_contact').catch(this.error);
        } else if (!showContact && this.hasCapability('alarm_contact')) {
            await this.removeCapability('alarm_contact').catch(this.error);
        }
    }

    async handleDataPoint(data) {
        const dp = data.dp;
        const value = this.getDataValue(data);

        // Settings queue logic - write pending settings when device reports battery
        // This ensures settings are sent when the battery-powered device is awake
        // Use flag to prevent duplicate sends when device sends multiple battery reports
        if (this.pendingSettings && this.pendingSettings.length > 0 && dp === dataPoints.battery && !this.settingWriteInProgress) {
            const setting = this.pendingSettings[0];
            this.settingWriteInProgress = true;
            this.log(`Device awake (DP ${dp} received). Writing queued setting: ${setting.key}...`);

            this.writeData32(setting.dp, setting.value)
                .then(() => {
                    this.log(`Command sent for ${setting.key}`);
                    this.pendingSettings.shift();
                    this.settingWriteInProgress = false;
                })
                .catch(() => {
                    this.pendingSettings.shift();
                    this.settingWriteInProgress = false;
                });
        }

        switch (dp) {
            case dataPoints.vibration:
                // trueFalse1 converter: 1 = vibration detected
                const isVibration = value === 1 || value === true;
                if (this.hasCapability('alarm_vibration')) {
                    this.log('Vibration detected:', isVibration);
                    await this.setCapabilityValue('alarm_vibration', isVibration).catch(this.error);
                }
                break;

            case dataPoints.contact:
                // Inverted: Tuya sends true when contact is OPEN (no magnet)
                // Homey alarm_contact: true = open/alarm, false = closed/safe
                const isOpen = value === 1 || value === true;
                if (this.hasCapability('alarm_contact')) {
                    this.log('Contact state:', isOpen ? 'Open' : 'Closed');
                    await this.setCapabilityValue('alarm_contact', isOpen).catch(this.error);
                }
                break;

            case dataPoints.battery:
                // Filter out temporary voltage drops during radio activity
                if (this.lastBatteryValue && (this.lastBatteryValue - value) > 50) {
                    this.log(`Ignoring suspicious battery drop: ${value}% (Previous: ${this.lastBatteryValue}%)`);
                    return;
                }
                this.lastBatteryValue = value;
                this.log('Battery Percentage:', value);
                await this.setCapabilityValue('measure_battery', value).catch(this.error);
                await this.setCapabilityValue('alarm_battery', value <= 20).catch(this.error);
                break;

            case dataPoints.sensitivity:
                // Sensitivity value 1-50 (higher = more sensitive)
                this.log('Device reported sensitivity:', value);
                await this.setSettings({ sensitivity: value }).catch(() => {});
                break;

            default:
                this.log(`Device reported unknown DP ${dp} with value:`, value);
        }
    }

    // Helper to parse Tuya values based on their declared datatype
    getDataValue(dpValue) {
        switch (dpValue.datatype) {
            case 0: return dpValue.data[0] === 1; // Raw/Bool
            case 1: return dpValue.data[0] === 1; // Bool
            case 2: return dpValue.data.readUInt32BE(0); // Value/Integer
            case 4: return dpValue.data[0]; // Enum
            default: return dpValue.data;
        }
    }

    // Triggered when user changes settings in the Homey App
    async onSettings({ newSettings, changedKeys }) {
        for (const key of changedKeys) {
            // Handle sensitivity setting - queue for device update
            if (key === 'sensitivity' && dataPoints[key]) {
                const val = parseInt(newSettings[key]);
                this.log(`Queuing sensitivity update: ${val}`);

                // Check if already in queue to avoid duplicates
                if (!this.pendingSettings.find(s => s.key === key)) {
                    this.pendingSettings.push({ dp: dataPoints[key], value: val, key: key });
                }
            }

            // Handle display mode setting - update capability visibility
            if (key === 'display_mode') {
                // Use setImmediate to apply after settings are saved
                setImmediate(() => this.updateCapabilityVisibility());
            }
        }
        return true;
    }

}

module.exports = VibrationContactSensor;
