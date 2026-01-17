'use strict';

const { Cluster } = require('zigbee-clusters');
const TuyaSpecificCluster = require('../../lib/TuyaSpecificCluster');
const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');

Cluster.addCluster(TuyaSpecificCluster);

// Data Points for TS0601 (_TZE200_rhgsbacq) - HOBEIAN ZG-204ZV Profile
const dataPoints = {
    presenceState: 1,        // Motion/Presence detection
    radarSensitivity: 2,     // Radar sensitivity (0-10) step value 1
    radarDetectionDistance: 4,  // Radar Distance 0-10m step value 0.01)
    motionStates: 101,           // none, large, small, scatic
    motionDetectionMode: 122,       // ["only_pir", "pir_and_radar", "only_radar"])
    motionDetectionSensitivity: 123,    // PIR sensitivity (0-10) step value 1
    fadingTime: 102,         // Motion keep time (seconds)
    illuminance: 106,        // Light sensing (lux)
    battery: 121,            // Battery percentage
};

const dataTypes = {
    raw: 0,
    bool: 1,
    value: 2,
    string: 3,
    enum: 4,
    bitmap: 5,
};

const convertMultiByteNumberPayloadToSingleDecimalNumber = (chunks) => {
    let value = 0;
    for (let i = 0; i < chunks.length; i++) {
        value = value << 8;
        value += chunks[i];
    }
    return value;
};

const getDataValue = (dpValue) => {
    switch (dpValue.datatype) {
        case dataTypes.raw:
            return dpValue.data;
        case dataTypes.bool:
            return dpValue.data[0] === 1;
        case dataTypes.value:
            return convertMultiByteNumberPayloadToSingleDecimalNumber(dpValue.data);
        case dataTypes.string:
            let dataString = '';
            for (let i = 0; i < dpValue.data.length; ++i) {
                dataString += String.fromCharCode(dpValue.data[i]);
            }
            return dataString;
        case dataTypes.enum:
            return dpValue.data[0];
        case dataTypes.bitmap:
            return convertMultiByteNumberPayloadToSingleDecimalNumber(dpValue.data);
    }
};

class PIRRadarSensorMulti extends TuyaSpecificClusterDevice {
    async onNodeInit({ zclNode }) {
        this.printNode();

        zclNode.endpoints[1].clusters.tuya.on("response", value => this.handleDataPoint(value));
    }

    async handleDataPoint(data) {
        const dp = data.dp;
        const value = getDataValue(data);

        switch (dp) {
            case dataPoints.presenceState:
                this.log("Presence state:", value);
                this.setCapabilityValue('alarm_presence', Boolean(value)).catch(this.error);
                break;

            case dataPoints.motionStates:
                const motionState = value
                this.log("Motion State:", value);
                this.setCapabilityValue('Motion_State_Capability', String(motionState)).catch(this.error); 
                break;

            case dataPoints.radarSensitivity:
                this.log("Radar sensitivity:", value);
                break;

            case dataPoints.motionDetectionMode:
                this.log("Motion Detection Mode:", value);
                break;

            case dataPoints.motionDetectionSensitivity:
                this.log("Motion detection Sensitivity:", value);
                break;

            case dataPoints.radarDetectionDistance:
                this.log("Radar Detection Distance:", value);
                break;

            case dataPoints.illuminance:
                this.log("Illuminance:", value, "lux");
                this.setCapabilityValue('measure_luminance', value).catch(this.error);
                break;

            case dataPoints.battery:
                const batteryValue = value;
                this.log("Battery:", value, "%");
                // Battery capability could be added if needed
                this.setCapabilityValue('measure_battery', batteryValue).catch(this.error);
                break;

            case dataPoints.fadingTime:
                this.log("Fading time:", value, "seconds");
                break;

            default:
                this.log("Unhandled data point:", dp, "value:", value);
                break;
        }
    }

    onDeleted() {
        this.log("PIR Radar Multi-Sensor removed");
    }

    async onSettings({ newSettings, changedKeys }) {
        try {
            if (changedKeys.includes('radar_sensitivity')) {
                await this.writeData32(dataPoints.radarSensitivity, newSettings['radar_sensitivity']);
            }
            if (changedKeys.includes('fading_time')) {
                await this.writeData32(dataPoints.fadingTime, newSettings['fading_time']);
            }
            if (changedKeys.includes('radar_distance_detection')) {
                await this.writeData32(dataPoints.radarDetectionDistance, newSettings['radar_distance_detection']);
            }
            if (changedKeys.includes('PIR_sensitivity')) {
                await this.writeData32(dataPoints.motionDetectionSensitivity, newSettings['PIR_sensitivity']);
            }
            if (changedKeys.includes('motion_detection_mode')) {
                await this.writeData32(dataPoints.motionDetectionMode, newSettings['motion_detection_mode']);
            }
            this.log('Settings changed:', changedKeys);
        }
        catch (error) {
            this.error('Error in onSettings:', error);
        }
    }
}
module.exports = PIRRadarSensorMulti;