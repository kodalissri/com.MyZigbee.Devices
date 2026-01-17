'use strict';

const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');

// DataPoint mapping based on your logs and Zigbee2Mqtt source
const dataPoints = {
    occupancy: 1,
    battery: 4,
    sensitivity: 9,
    keep_time: 10,
    illuminance: 12,
    illuminance_alt: 101,
    illuminance_interval: 102,
    illuminance_config: 103 // Discovered from your logs
};

class MotionSensorLux extends TuyaSpecificClusterDevice {

    async onNodeInit({ zclNode }) {
        this.log('Tuya Motion Sensor (ZG-204ZL) initialized');

        // Initialize the settings queue
        this.pendingSettings = [];

        // Listen for Tuya DataPoints
        zclNode.endpoints[1].clusters.tuya.on("response", value => this.handleDataPoint(value));
    }

    async handleDataPoint(data) {
        const dp = data.dp;
        const value = this.getDataValue(data);

        // --- SETTINGS QUEUE LOGIC ---
        // We only attempt to write when the device reports Lux or Battery (DP 4, 12, 101).
        // This avoids colliding with the high-traffic 'Motion' burst.
        if (this.pendingSettings && this.pendingSettings.length > 0 && [4, 12, 101].includes(dp)) {
            const setting = this.pendingSettings[0];
            this.log(`Device awake (DP ${dp} received). Writing queued setting: ${setting.key}...`);

            // Use writeData32 for numeric DPs (102, 103), writeEnum for Enums (9, 10)
            const promise = (setting.dp >= 102)
                ? this.writeData32(setting.dp, setting.value)
                : this.writeEnum(setting.dp, setting.value);

            promise
                .then(() => {
                    this.log(`Command sent for ${setting.key}`);
                    this.pendingSettings.shift();
                })
                .catch(err => {
                    // Silent catch because we trust the 'Device reported...' log more than the ACK
                    this.pendingSettings.shift();
                });
        }

        // --- DATAPOINT PROCESSING ---
        switch (dp) {
            case dataPoints.occupancy:
                const invertSetting = this.getSetting('invert_motion');
                // Tuya Standard: 1 = Motion, 0 = Clear. 
                const isMotion = invertSetting ? !value : !!value;

                this.log(`Motion (Raw: ${value}, Invert: ${invertSetting}):`, isMotion);
                await this.setCapabilityValue('alarm_motion', isMotion).catch(this.error);
                break;

            case dataPoints.illuminance:
            case dataPoints.illuminance_alt:
                this.log('Luminance (Lux):', value);
                await this.setCapabilityValue('measure_luminance', value).catch(this.error);
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

            // SYNC: Update Homey UI if the device reports its internal settings
            case dataPoints.sensitivity:
            case dataPoints.keep_time:
                this.log(`Device reported ${dp === 9 ? 'sensitivity' : 'keep_time'}:`, value);
                await this.setSettings({
                    [dp === 9 ? 'sensitivity' : 'keep_time']: String(value)
                }).catch(() => { });
                break;

            case dataPoints.illuminance_interval:
            case dataPoints.illuminance_config:
                this.log(`Device reported ${dp === 102 ? 'interval' : 'sensitivity_config'}:`, value);
                await this.setSettings({
                    [dp === 102 ? 'illuminance_interval' : 'illuminance_config']: value
                }).catch(() => { });
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
            // Local Homey logic settings don't get sent to Zigbee
            if (key === 'invert_motion') continue;

            if (dataPoints[key]) {
                const val = parseInt(newSettings[key]);
                this.log(`Queuing setting update for ${key}: ${val}`);

                // Check if already in queue to avoid duplicates
                if (!this.pendingSettings.find(s => s.key === key)) {
                    this.pendingSettings.push({ dp: dataPoints[key], value: val, key: key });
                }
            }
        }
        return true;
    }

}

module.exports = MotionSensorLux;