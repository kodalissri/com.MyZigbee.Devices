'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver'); // Ensure this is imported
const { CLUSTER } = require('zigbee-clusters');

class SonoffBase extends ZigBeeDevice { // Must extend ZigBeeDevice

    async onNodeInit({ zclNode }) {
        this.log("NodeInit SonoffBase");

        if (this.hasCapability('measure_battery')) {
            await this.configureBatteryReporting(zclNode);
        }
    }

    async configureBatteryReporting(zclNode) {
        try {
            this.log("Configuring Battery Reporting with Low Battery Alarm...");

            // Define the threshold for low battery (20%)
            const LOW_BATTERY_THRESHOLD = 20;

            this.registerCapability('measure_battery', CLUSTER.POWER_CONFIGURATION, {
                getOpts: { getOnOnline: true },
                reportOpts: {
                    configureAttributeReporting: {
                        attribute: 'batteryPercentageRemaining',
                        minimumReportInterval: 3600,
                        maximumReportInterval: 43200,
                        reportableChange: 1, // Report on 1% change since it's direct 0-100
                    },
                },
                report: 'batteryPercentageRemaining',
                map: value => {
                    // Since your logs show '100', we use the value directly
                    const percentage = Math.round(value);

                    // Handle Low Battery Alarm
                    if (this.hasCapability('alarm_battery')) {
                        const isLow = percentage <= LOW_BATTERY_THRESHOLD;
                        this.setCapabilityValue('alarm_battery', isLow).catch(this.error);
                    }

                    return percentage;
                },
            });

            this.log("Battery & Alarm reporting configured.");
        } catch (err) {
            this.error("Failed to configure battery reporting:", err);
        }
    }

    async checkBattery() {
        try {
            const cluster = this.zclNode.endpoints[1].clusters[CLUSTER.POWER_CONFIGURATION.NAME];
            if (cluster) {
                const attributes = await cluster.readAttributes(['batteryPercentageRemaining']);
                const p = Math.round(attributes.batteryPercentageRemaining / 2);
                await this.setCapabilityValue('measure_battery', p);
            }
        } catch (err) {
            this.error("Manual battery read failed:", err);
        }
    }
}

module.exports = SonoffBase; // Ensure this is exported