'use strict';

const { Cluster } = require('zigbee-clusters');
const TuyaSpecificCluster = require('../../lib/TuyaSpecificCluster');
const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');

Cluster.addCluster(TuyaSpecificCluster);

// Data Points for TS0601 (_TZE200_rhgsbacq) - HOBEIAN ZG-204ZV Profile
const dataPoints = {
    presenceState: 1,        // Motion/Presence detection
    radarSensitivity: 2,     // Radar sensitivity (0-19)
    humidity: 101,           // Relative humidity (value %)
    fadingTime: 102,         // Motion keep time (seconds)
    illuminance: 106,        // Light sensing (lux)
    battery: 110,            // Battery percentage
    temperature: 111,       // Temperature (value/10 °C)
    illuminationInterval: 107,       // Illumination Update interval
    indicator: 108,         // LED indicator
    tempunit: 109,          // temperature units c to f
    temperaturecaliberation: 105,
    humiditycaliberation: 104,
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


const localTempCalibration2 = {
    from: (v) => v,
    to: (v) => {
        if (v < 0) return v + 0x100000000;
        return v;
    },
};

const localTempCalibration3 = {
    from: (v) => {
        if (v > 0x7fffffff) v -= 0x100000000;
        return v / 10;
    },
    to: (v) => {
        if (v > 0) return v * 10;
        if (v < 0) return v * 10 + 0x100000000;
        return v;
    },
};

class RadarSensorMulti extends TuyaSpecificClusterDevice {
    async onNodeInit({ zclNode }) {
        this.printNode();

        zclNode.endpoints[1].clusters.tuya.on("response", value => this.handleDataPoint(value));
    }

    async handleDataPoint(data) {
        const dp = data.dp;
        const value = getDataValue(data);

        switch (dp) {
            case dataPoints.presenceState:
                this.log("Motion state:", value);
                this.setCapabilityValue('alarm_presence', Boolean(value)).catch(this.error);
                break;

            case dataPoints.radarSensitivity:
                this.log("Radar sensitivity:", value);
                break;

            case dataPoints.illuminance:
                this.log("Illuminance:", value, "lux");
                this.setCapabilityValue('measure_luminance', value).catch(this.error);
                break;

            case dataPoints.temperature:
                const temperatureValue = value / 10.0;
                this.log("Temperature:", temperatureValue, "°C");
                this.setCapabilityValue('measure_temperature', temperatureValue).catch(this.error);
                break;

            case dataPoints.humidity:
                const humidityValue = value;
                this.log("Humidity:", humidityValue, "%");
                this.setCapabilityValue('measure_humidity', humidityValue).catch(this.error);
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

            case dataPoints.indicator:
                this.log("Indicator:", value);
                this.setSettings({ indicator: Boolean(value) }).catch(() => {});
                break;

            case dataPoints.tempunit:
                this.log("Temperature unit:", value);
                this.setSettings({ temperature_unit: String(value) }).catch(() => {});
                break;

            case dataPoints.temperaturecaliberation:
                {
                    const calib = localTempCalibration3.from(value);
                    this.log("Temperature calibration:", calib);
                    this.setSettings({ temperature_calibration: calib }).catch(() => {});
                }
                break;

            case dataPoints.humiditycaliberation:
                {
                    const calib = localTempCalibration2.from(value);
                    this.log("Humidity calibration:", calib);
                    this.setSettings({ humidity_calibration: calib }).catch(() => {});
                }
                break;


            default:
                this.log("Unhandled data point:", dp, "value:", value);
                break;
        }
    }

    onDeleted() {
        this.log("Radar Multi-Sensor removed");
    }

    async onSettings({ newSettings, changedKeys }) {
        try {
            if (changedKeys.includes('radar_sensitivity')) {
                await this.writeData32(dataPoints.radarSensitivity, newSettings['radar_sensitivity']);
            }
            if (changedKeys.includes('fading_time')) {
                await this.writeData32(dataPoints.fadingTime, newSettings['fading_time']);
            }
            if (changedKeys.includes('illuminance_update_interval')) {
                await this.writeData32(dataPoints.illuminationInterval, newSettings['illuminance_update_interval']);
            }

            if (changedKeys.includes('indicator')) {
                await this.writeBool(dataPoints.indicator, newSettings['indicator']);
            }
            if (changedKeys.includes('temperature_unit')) {
                await this.writeEnum(dataPoints.tempunit, Number(newSettings['temperature_unit']));
            }
            if (changedKeys.includes('temperature_calibration')) {
                await this.writeData32(
                    dataPoints.temperaturecaliberation,
                    localTempCalibration3.to(newSettings['temperature_calibration']),
                );
            }
            if (changedKeys.includes('humidity_calibration')) {
                await this.writeData32(
                    dataPoints.humiditycaliberation,
                    localTempCalibration2.to(newSettings['humidity_calibration']),
                );
            }
            this.log('Settings changed:', changedKeys);
        }
        catch (error) {
            this.error('Error in onSettings:', error);
        }
    }
}
module.exports = RadarSensorMulti;