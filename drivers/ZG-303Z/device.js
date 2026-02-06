'use strict';

const { Cluster, CLUSTER } = require('zigbee-clusters');
const TuyaSpecificCluster = require('../../lib/TuyaSpecificCluster');
const TuyaSpecificClusterDevice = require('../../lib/TuyaSpecificClusterDevice');

Cluster.addCluster(TuyaSpecificCluster);

// Tuya Data Point IDs for ZG-303Z Soil Moisture Sensor
// Based on Zigbee2MQTT configuration for _TZE200_wqashyqo
// Reference: https://github.com/Koenkk/zigbee2mqtt/blob/master/lib/extension/bridge.ts
const DP_HANDLERS = {
    // DP 1: Water warning (enum: 0=none, 1=alarm)
    1: { handler: 'waterWarning' },

    // DP 103: Temperature (divided by 10)
    103: { handler: 'temperature', divideBy: 10 },

    // DP 107: Soil Moisture (raw percentage)
    107: { handler: 'soilMoisture' },

    // DP 108: Battery (raw percentage)
    108: { handler: 'battery' },

    // DP 109: Air Humidity (raw percentage)
    109: { handler: 'humidity' },

    // Settings/Calibration DPs
    102: { handler: 'setting' },  // soil_calibration
    104: { handler: 'setting' },  // temperature_calibration
    105: { handler: 'setting' },  // humidity_calibration
    106: { handler: 'setting' },  // temperature_unit (enum: 0=C, 1=F)
    110: { handler: 'setting' },  // soil_warning threshold
    111: { handler: 'setting' },  // temperature_sampling interval
    112: { handler: 'setting' },  // soil_sampling interval

    // Legacy DPs (for other firmware variants - keep for compatibility)
    3: { handler: 'temperature', divideBy: 10 },
    5: { handler: 'soilMoisture' },
    14: { handler: 'humidity' },
    15: { handler: 'battery' },
    16: { handler: 'waterWarning' },
};

// Datapoint IDs for writing settings (based on Zigbee2MQTT)
const DP_WRITE = {
    SOIL_CALIBRATION: 102,
    TEMP_CALIBRATION: 104,
    HUMIDITY_CALIBRATION: 105,
    TEMP_UNIT: 106,
    SOIL_WARNING_THRESHOLD: 110,
    TEMP_SAMPLING_INTERVAL: 111,
    SOIL_SAMPLING_INTERVAL: 112,
};

// Default settings values
const DEFAULTS = {
    SAMPLING_SECONDS: 1800,
    SOIL_WARNING_PERCENT: 30,
    CALIBRATION: 0,
};

// Tuya data types
const dataTypes = {
    raw: 0,
    bool: 1,
    value: 2,
    string: 3,
    enum: 4,
    bitmap: 5,
};

// Helper functions
const clampNumber = (value, min, max) => {
    if (typeof value !== 'number' || isNaN(value)) return min;
    return Math.max(min, Math.min(max, value));
};

const clampPercent = (value) => clampNumber(value, 0, 100);

const clampInt = (value, min, max) => Math.round(clampNumber(value, min, max));

const rawTemperatureTimes10ToCelsius = (raw) => raw / 10;

const toTuyaTemperatureCalibrationTenths = (celsius) => clampInt(celsius * 10, -20, 20);

const toTuyaPercentCalibration = (percent) => clampInt(percent, -30, 30);

const toTuyaSamplingSeconds = (seconds) => clampInt(seconds, 5, 3600);

const toTuyaSoilWarningThresholdPercent = (percent) => clampInt(percent, 0, 100);

const computeWaterAlarmFromSoilMoisture = ({ soilMoisturePercent, thresholdPercent }) => {
    return soilMoisturePercent < thresholdPercent;
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
        default:
            return dpValue.data;
    }
};

class ZG303ZSoilSensor extends TuyaSpecificClusterDevice {

    async onNodeInit({ zclNode }) {
        this.printNode();

        this.lastSoilMoisturePercent = null;
        this.pendingSettingsApply = false;
        this.lastWakeHandledAt = 0;

        // Get endpoint 1
        const endpoint = zclNode.endpoints[1];
        if (!endpoint) {
            this.error('Endpoint 1 not found');
            return;
        }
        this.endpoint1 = endpoint;

        // Detect if this is a sleepy (battery-powered) device
        const isSleepy = this.isDeviceSleepy();

        // Set up Tuya cluster listeners
        this.setupTuyaListeners(zclNode);

        // Register for raw cluster commands on the Tuya cluster
        this.registerRawReportHandler(zclNode);

        // For sleepy devices, defer commands until device wakes up
        // For always-on devices, apply settings immediately
        if (!isSleepy) {
            await this.applyDeviceSettings().catch(this.error);
            await this.readBattery(endpoint).catch(this.error);
        }
    }

    setupTuyaListeners(zclNode) {
        const endpoint = zclNode.endpoints[1];
        if (!endpoint) return;

        const tuyaCluster = endpoint.clusters.tuya;
        if (tuyaCluster) {
            tuyaCluster.on('reporting', (args) => {
                this.processTuyaReport(args);
            });

            tuyaCluster.on('response', (args) => {
                this.processTuyaReport(args);
            });
        }
    }

    registerRawReportHandler(zclNode) {
        const endpoint = zclNode.endpoints[1];
        if (!endpoint) return;

        // Intercept handleFrame for the Tuya cluster (0xEF00 = 61184)
        const TUYA_CLUSTER_ID = 61184;
        const originalHandleFrame = endpoint.handleFrame?.bind(endpoint);

        if (originalHandleFrame) {
            endpoint.handleFrame = (clusterId, frame, meta) => {
                if (clusterId === TUYA_CLUSTER_ID) {
                    this.parseRawTuyaFrame(frame);
                    // Device is awake since we received data - trigger wake handler
                    this.onDeviceAwake().catch(this.error);
                }
                return originalHandleFrame(clusterId, frame, meta);
            };
        }
    }

    parseRawTuyaFrame(frame) {
        try {
            // ZCL header parsing
            if (frame.length < 3) return;

            const frameControl = frame.readUInt8(0);
            const manufacturerSpecific = (frameControl & 0x04) !== 0;
            const headerLen = manufacturerSpecific ? 5 : 3;

            if (frame.length < headerLen + 2) return;

            let offset = headerLen;
            offset += 2; // Skip status and transid

            // Parse datapoints
            while (frame.length - offset >= 4) {
                const dp = frame.readUInt8(offset);
                const datatype = frame.readUInt8(offset + 1);
                const len = frame.readUInt16BE(offset + 2);
                offset += 4;

                if (len < 0 || frame.length - offset < len) break;

                const data = frame.slice(offset, offset + len);
                offset += len;

                this.processDataPoint(dp, datatype, data);
            }
        } catch (error) {
            this.error('Error parsing raw Tuya frame:', error);
        }
    }

    processTuyaReport(args) {
        if (!args) return;

        const { dp, datatype, data } = args;

        if (typeof dp === 'number' && data) {
            const buffer = Buffer.isBuffer(data) ? data : Buffer.from(Array.isArray(data) ? data : [data]);
            this.processDataPoint(dp, datatype || 0, buffer);
        }
    }

    parseDpValue(datatype, data) {
        switch (datatype) {
            case dataTypes.bool:
                return data.readUInt8(0) !== 0;
            case dataTypes.value:
                if (data.length >= 4) return data.readInt32BE(0);
                if (data.length >= 2) return data.readInt16BE(0);
                return data.readUInt8(0);
            case dataTypes.enum:
                return data.readUInt8(0);
            default:
                if (data.length >= 4) return data.readInt32BE(0);
                if (data.length >= 2) return data.readUInt16BE(0);
                if (data.length >= 1) return data.readUInt8(0);
                return 0;
        }
    }

    processDataPoint(dp, datatype, data) {
        const mapping = DP_HANDLERS[dp];
        if (!mapping) return;

        const rawValue = this.parseDpValue(datatype, data);

        // Apply divideBy transformation if specified in mapping
        const value = mapping.divideBy && typeof rawValue === 'number'
            ? rawValue / mapping.divideBy
            : rawValue;

        // Dispatch based on handler type
        switch (mapping.handler) {
            case 'temperature':
                if (typeof rawValue === 'number') {
                    const tempC = rawTemperatureTimes10ToCelsius(rawValue);
                    if (this.hasCapability('measure_temperature')) {
                        this.setCapabilityValue('measure_temperature', tempC).catch(this.error);
                    }
                }
                break;

            case 'soilMoisture':
                if (typeof rawValue === 'number') {
                    // Z2M confirms DP 107 reports raw percentage directly
                    // However, DP 5 (legacy) may report differently - handle both cases
                    let soilMoisture = rawValue;

                    // If value > 100, it might be from legacy DP 5 with special encoding
                    // Extract last byte as percentage
                    if (soilMoisture > 100) {
                        soilMoisture = rawValue & 0xFF;
                    }

                    soilMoisture = clampPercent(soilMoisture);
                    this.lastSoilMoisturePercent = soilMoisture;

                    if (this.hasCapability('measure_soil_moisture')) {
                        this.setCapabilityValue('measure_soil_moisture', soilMoisture).catch(this.error);
                    }

                    // Local alarm derived from threshold setting
                    const threshold = this.getSetting('soil_warning') ?? DEFAULTS.SOIL_WARNING_PERCENT;
                    const alarm = computeWaterAlarmFromSoilMoisture({
                        soilMoisturePercent: soilMoisture,
                        thresholdPercent: threshold,
                    });
                    if (this.hasCapability('alarm_water_shortage')) {
                        this.setCapabilityValue('alarm_water_shortage', alarm).catch(this.error);
                    }
                }
                break;

            case 'battery':
                if (typeof value === 'number') {
                    const battery = clampPercent(value);
                    if (this.hasCapability('measure_battery')) {
                        this.setCapabilityValue('measure_battery', battery).catch(this.error);
                    }
                }
                break;

            case 'humidity':
                if (typeof value === 'number') {
                    const humidity = clampPercent(value);
                    if (this.hasCapability('measure_humidity')) {
                        this.setCapabilityValue('measure_humidity', humidity).catch(this.error);
                    }
                }
                break;

            case 'waterWarning':
                if (typeof value === 'number' || typeof value === 'boolean') {
                    const alarm = value === 1 || value === true;
                    if (this.hasCapability('alarm_water_shortage')) {
                        this.setCapabilityValue('alarm_water_shortage', alarm).catch(this.error);
                    }
                }
                break;

            case 'setting':
                // Setting confirmed by device
                break;
        }
    }

    async applyDeviceSettings() {
        const temperatureSampling = toTuyaSamplingSeconds(this.getSetting('temperature_sampling') ?? DEFAULTS.SAMPLING_SECONDS);
        const soilSampling = toTuyaSamplingSeconds(this.getSetting('soil_sampling') ?? DEFAULTS.SAMPLING_SECONDS);
        const soilWarning = toTuyaSoilWarningThresholdPercent(this.getSetting('soil_warning') ?? DEFAULTS.SOIL_WARNING_PERCENT);

        // Calibrations
        const temperatureCalibrationTenths = toTuyaTemperatureCalibrationTenths(this.getSetting('temperature_calibration') ?? DEFAULTS.CALIBRATION);
        const humidityCalibration = toTuyaPercentCalibration(this.getSetting('humidity_calibration') ?? DEFAULTS.CALIBRATION);
        const soilCalibration = toTuyaPercentCalibration(this.getSetting('soil_calibration') ?? DEFAULTS.CALIBRATION);

        try {
            // Best-effort: device may be sleeping; will apply on next awake/report window
            await this.writeEnum(DP_WRITE.TEMP_UNIT, 0); // enforce Celsius
            await this.writeData32(DP_WRITE.TEMP_SAMPLING_INTERVAL, temperatureSampling);
            await this.writeData32(DP_WRITE.SOIL_SAMPLING_INTERVAL, soilSampling);
            await this.writeData32(DP_WRITE.SOIL_WARNING_THRESHOLD, soilWarning);
            await this.writeData32(DP_WRITE.TEMP_CALIBRATION, temperatureCalibrationTenths);
            await this.writeData32(DP_WRITE.HUMIDITY_CALIBRATION, humidityCalibration);
            await this.writeData32(DP_WRITE.SOIL_CALIBRATION, soilCalibration);

        } catch (err) {
            this.error('Failed to apply device settings:', err);
        }
    }

    async readBattery(endpoint) {
        if (!endpoint.clusters.powerConfiguration) return;

        try {
            const batteryStatus = await endpoint.clusters.powerConfiguration.readAttributes(['batteryPercentageRemaining']);
            if (batteryStatus.batteryPercentageRemaining !== undefined) {
                const battery = Math.round(batteryStatus.batteryPercentageRemaining / 2);
                await this.setCapabilityValue('measure_battery', battery);
            }
        } catch (err) {
            // Device may be sleeping - battery will be read on next wake
        }
    }

    async onSettings({ oldSettings, newSettings, changedKeys }) {
        const isSleepy = this.isDeviceSleepy();

        // For sleepy devices, queue settings for when device wakes up
        if (isSleepy) {
            this.pendingSettingsApply = true;
        } else {
            // Device is always-on, apply settings immediately
            for (const key of changedKeys) {
                const value = newSettings[key];
                try {
                    if (key === 'temperature_sampling') {
                        await this.writeData32(DP_WRITE.TEMP_SAMPLING_INTERVAL, toTuyaSamplingSeconds(value ?? DEFAULTS.SAMPLING_SECONDS));
                    }
                    if (key === 'soil_sampling') {
                        await this.writeData32(DP_WRITE.SOIL_SAMPLING_INTERVAL, toTuyaSamplingSeconds(value ?? DEFAULTS.SAMPLING_SECONDS));
                    }
                    if (key === 'soil_warning') {
                        await this.writeData32(DP_WRITE.SOIL_WARNING_THRESHOLD, toTuyaSoilWarningThresholdPercent(value ?? DEFAULTS.SOIL_WARNING_PERCENT));
                    }
                    if (key === 'temperature_calibration') {
                        await this.writeData32(DP_WRITE.TEMP_CALIBRATION, toTuyaTemperatureCalibrationTenths(value ?? DEFAULTS.CALIBRATION));
                    }
                    if (key === 'humidity_calibration') {
                        await this.writeData32(DP_WRITE.HUMIDITY_CALIBRATION, toTuyaPercentCalibration(value ?? DEFAULTS.CALIBRATION));
                    }
                    if (key === 'soil_calibration') {
                        await this.writeData32(DP_WRITE.SOIL_CALIBRATION, toTuyaPercentCalibration(value ?? DEFAULTS.CALIBRATION));
                    }
                } catch (err) {
                    this.error('Failed to apply setting to device:', err);
                }
            }
        }

        // Always recompute local alarm immediately (doesn't require device communication)
        if (changedKeys.includes('soil_warning')) {
            const value = newSettings['soil_warning'];
            if (typeof this.lastSoilMoisturePercent === 'number') {
                const alarm = computeWaterAlarmFromSoilMoisture({
                    soilMoisturePercent: this.lastSoilMoisturePercent,
                    thresholdPercent: value ?? DEFAULTS.SOIL_WARNING_PERCENT,
                });
                if (this.hasCapability('alarm_water_shortage')) {
                    this.setCapabilityValue('alarm_water_shortage', alarm).catch(this.error);
                }
            }
        }
    }

    isDeviceSleepy() {
        return this.node?.receiveWhenIdle === false;
    }

    async onEndDeviceAnnounce() {
        await this.onDeviceAwake();
    }

    async onDeviceAwake() {
        const now = Date.now();
        const DEBOUNCE_MS = 5000;

        if (now - this.lastWakeHandledAt < DEBOUNCE_MS) return;
        this.lastWakeHandledAt = now;

        // Mark device as available
        await this.setAvailable().catch(this.error);

        // Only apply settings if user changed them while device was sleeping
        if (this.pendingSettingsApply) {
            await this.applyDeviceSettings().catch(this.error);
            this.pendingSettingsApply = false;
        }

        // Read battery status
        if (this.endpoint1) {
            await this.readBattery(this.endpoint1).catch(this.error);
        }
    }

    onDeleted() {
        // Cleanup if needed
    }
}

module.exports = ZG303ZSoilSensor;
