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
    indicator: 107,         // LED indicator
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
        zclNode.endpoints[1].clusters.tuya.on("reporting", value => this.handleDataPoint(value));
    }

    async handleDataPoint(data) {
        const dp = data.dp;
        const value = getDataValue(data);

        switch (dp) {
            case dataPoints.presenceState:
                this.setCapabilityValue('alarm_presence', Boolean(value)).catch(this.error);
                break;

            case dataPoints.motionStates:
                this.setCapabilityValue('Motion_State_Capability', String(value)).catch(this.error);
                break;

            case dataPoints.radarSensitivity:
                this._lastRadarSensReport = { value: Number(value), ts: Date.now() };
                this.setSettings({ radar_sensitivity: Number(value) }).catch(() => {});
                break;

            case dataPoints.motionDetectionMode:
                this._lastModeReport = { value: Number(value), ts: Date.now() };
                this.setSettings({ motion_detection_mode: String(value) }).catch(() => {});
                break;

            case dataPoints.motionDetectionSensitivity:
                this._lastPirSensReport = { value: Number(value), ts: Date.now() };
                this.setSettings({ PIR_sensitivity: Number(value) }).catch(() => {});
                break;

            case dataPoints.radarDetectionDistance:
                this._lastDistanceReport = { value: Number(value), ts: Date.now() };
                this.setSettings({ radar_distance_detection: value / 100 }).catch(() => {});
                break;

            case dataPoints.indicator:
                this.setSettings({ indicator: Boolean(value) }).catch(() => {});
                break;

            case dataPoints.illuminance:
                this.setCapabilityValue('measure_luminance', value).catch(this.error);
                break;

            case dataPoints.battery:
                this.setCapabilityValue('measure_battery', value).catch(this.error);
                break;

            case dataPoints.fadingTime:
                this._lastFadingTimeReport = { value: Number(value), ts: Date.now() };
                this.setSettings({ fading_time: Number(value) }).catch(() => {});
                break;

            default:
                this.log("Unhandled DP:", dp, "value:", value);
                break;
        }
    }

    onDeleted() {
        this.log("PIR Radar Multi-Sensor removed");
    }

    async _waitForReport(getReport, expectedValue, timeoutMs = 3000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const last = getReport();
            if (last && last.value === expectedValue && Date.now() - last.ts < 5000) {
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return false;
    }

    async onSettings({ newSettings, changedKeys }) {
        try {
            if (changedKeys.includes('radar_sensitivity')) {
                const val = Number(newSettings['radar_sensitivity']);
                try {
                    await this.writeData32(dataPoints.radarSensitivity, val);
                } catch (err) {
                    if (await this._waitForReport(() => this._lastRadarSensReport, val)) {
                        this.log('Radar sensitivity write returned FAILURE but matching report received; treating as success');
                    } else {
                        throw err;
                    }
                }
            }
            if (changedKeys.includes('fading_time')) {
                const val = Number(newSettings['fading_time']);
                try {
                    await this.writeData32(dataPoints.fadingTime, val);
                } catch (err) {
                    if (await this._waitForReport(() => this._lastFadingTimeReport, val)) {
                        this.log('Fading time write returned FAILURE but matching report received; treating as success');
                    } else {
                        throw err;
                    }
                }
            }
            if (changedKeys.includes('radar_distance_detection')) {
                const meters = Number(newSettings['radar_distance_detection']);
                const scaled = Math.round(meters * 100);
                try {
                    await this.writeData32(dataPoints.radarDetectionDistance, scaled);
                    this.log('Radar detection distance set:', meters, 'm (raw:', scaled, ')');
                } catch (err) {
                    if (await this._waitForReport(() => this._lastDistanceReport, scaled)) {
                        this.log('Radar distance write returned FAILURE but matching report received; treating as success');
                    } else {
                        throw err;
                    }
                }
            }
            if (changedKeys.includes('PIR_sensitivity')) {
                const val = Number(newSettings['PIR_sensitivity']);
                try {
                    await this.writeData32(dataPoints.motionDetectionSensitivity, val);
                } catch (err) {
                    if (await this._waitForReport(() => this._lastPirSensReport, val)) {
                        this.log('PIR sensitivity write returned FAILURE but matching report received; treating as success');
                    } else {
                        throw err;
                    }
                }
            }
            if (changedKeys.includes('motion_detection_mode')) {
                const mode = Number(newSettings['motion_detection_mode']);
                try {
                    await this.writeData32(dataPoints.motionDetectionMode, mode);
                } catch (err) {
                    if (await this._waitForReport(() => this._lastModeReport, mode)) {
                        this.log('Motion mode write returned FAILURE but matching report received; treating as success');
                    } else {
                        throw err;
                    }
                }
            }

            if (changedKeys.includes('indicator')) {
                await this.writeBool(dataPoints.indicator, newSettings['indicator']);
            }
            this.log('Settings changed:', changedKeys);
        }
        catch (error) {
            this.error('Error in onSettings:', error);
        }
    }
}
module.exports = PIRRadarSensorMulti;
