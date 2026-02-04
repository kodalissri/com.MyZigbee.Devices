'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER } = require('zigbee-clusters');

const {
    limitValue,
    calculateLevelControlTransitionTime,
    calculateColorControlTransitionTime,
    wrapAsyncWithRetry,
    wait
} = require('../../lib/util');

// ZCL constants
const MAX_HUE = 254;
const MAX_DIM = 254;
const MAX_SATURATION = 254;

// OSRAM color temperature range in mireds (based on typical OSRAM specs)
// Warm white ~2700K (370 mireds) to Cool white ~6500K (153 mireds)
const MIN_COLORTEMP_MIREDS = 153;  // 6500K (cool)
const MAX_COLORTEMP_MIREDS = 370;  // 2700K (warm)

// Time in ms to ignore incoming reports after sending a command
// This prevents stale reports from reverting the UI state
const REPORT_DEBOUNCE_TIME = 2000;

class OsramLightifyRGBWDevice extends ZigBeeDevice {

    async onNodeInit({ zclNode }) {
        this.log('OSRAM Lightify RGBW initializing...');

        // Store the endpoint ID (OSRAM uses endpoint 3)
        this.endpointId = 3;

        // Initialize report suppression timestamps
        this._ignoreHueReportsUntil = 0;
        this._ignoreSaturationReportsUntil = 0;
        this._ignoreColorTempReportsUntil = 0;

        // Read initial attributes
        await wrapAsyncWithRetry(this.readInitialAttributes.bind(this));

        // Register on/off and dim capabilities
        if (this.hasCapability('onoff') && this.hasCapability('dim')) {
            this.registerOnOffAndDimCapabilities({ zclNode });
        }

        // Register color capabilities
        if (this.hasCapability('light_hue') ||
            this.hasCapability('light_saturation') ||
            this.hasCapability('light_temperature') ||
            this.hasCapability('light_mode')) {
            await this.registerColorCapabilities({ zclNode });
        }
    }

    // Cluster accessors
    get onOffCluster() {
        if (!this.zclNode.endpoints[this.endpointId]?.clusters?.onOff) {
            throw new Error('missing_on_off_cluster');
        }
        return this.zclNode.endpoints[this.endpointId].clusters.onOff;
    }

    get levelControlCluster() {
        if (!this.zclNode.endpoints[this.endpointId]?.clusters?.levelControl) {
            throw new Error('missing_level_control_cluster');
        }
        return this.zclNode.endpoints[this.endpointId].clusters.levelControl;
    }

    get colorControlCluster() {
        if (!this.zclNode.endpoints[this.endpointId]?.clusters?.colorControl) {
            throw new Error('missing_color_control_cluster');
        }
        return this.zclNode.endpoints[this.endpointId].clusters.colorControl;
    }

    async readInitialAttributes() {
        try {
            // Read color control attributes
            const colorAttrs = await this.colorControlCluster.readAttributes([
                'currentHue',
                'currentSaturation',
                'colorTemperatureMireds',
                'colorMode'
            ]).catch(err => {
                this.error('Failed to read color control attributes:', err);
                return {};
            });

            // Update initial capability values from device
            if (typeof colorAttrs.currentHue === 'number' && this.hasCapability('light_hue')) {
                await this.setCapabilityValue('light_hue', colorAttrs.currentHue / MAX_HUE).catch(this.error);
            }
            if (typeof colorAttrs.currentSaturation === 'number' && this.hasCapability('light_saturation')) {
                await this.setCapabilityValue('light_saturation', colorAttrs.currentSaturation / MAX_SATURATION).catch(this.error);
            }
            if (typeof colorAttrs.colorTemperatureMireds === 'number' && this.hasCapability('light_temperature')) {
                const tempValue = (colorAttrs.colorTemperatureMireds - MIN_COLORTEMP_MIREDS) / (MAX_COLORTEMP_MIREDS - MIN_COLORTEMP_MIREDS);
                await this.setCapabilityValue('light_temperature', limitValue(tempValue, 0, 1)).catch(this.error);
            }
            if (colorAttrs.colorMode && this.hasCapability('light_mode')) {
                const mode = (colorAttrs.colorMode === 'colorTemperatureMireds') ? 'temperature' : 'color';
                await this.setCapabilityValue('light_mode', mode).catch(this.error);
            }

        } catch (err) {
            this.error('Error reading initial attributes:', err);
        }
    }

    registerOnOffAndDimCapabilities({ zclNode }) {
        // Register onoff capability
        this.registerCapability('onoff', CLUSTER.ON_OFF, {
            endpoint: this.endpointId,
            getOpts: {
                getOnStart: true,
                getOnOnline: true,
            },
        });

        // Register dim capability with custom set parser for smooth transitions
        this.registerCapability('dim', CLUSTER.LEVEL_CONTROL, {
            endpoint: this.endpointId,
            set: 'moveToLevelWithOnOff',
            setParser: (value, opts) => {
                return {
                    level: Math.round(value * MAX_DIM),
                    transitionTime: calculateLevelControlTransitionTime(opts),
                };
            },
            get: 'currentLevel',
            getOpts: {
                getOnStart: true,
                getOnOnline: true,
            },
            report: 'currentLevel',
            reportParser: value => {
                // Update onoff state based on dim level
                if (value === 0) {
                    this.setCapabilityValue('onoff', false).catch(this.error);
                } else if (this.getCapabilityValue('onoff') === false) {
                    this.setCapabilityValue('onoff', true).catch(this.error);
                }
                return value / MAX_DIM;
            },
        });
    }

    async registerColorCapabilities({ zclNode }) {
        // Build list of color capabilities to register together
        // Using registerMultipleCapabilities debounces changes so hue+saturation
        // are collected together before sending a single command
        const colorCapabilities = [];

        if (this.hasCapability('light_hue')) {
            colorCapabilities.push({
                capabilityId: 'light_hue',
                cluster: CLUSTER.COLOR_CONTROL,
            });
        }

        if (this.hasCapability('light_saturation')) {
            colorCapabilities.push({
                capabilityId: 'light_saturation',
                cluster: CLUSTER.COLOR_CONTROL,
            });
        }

        if (this.hasCapability('light_temperature')) {
            colorCapabilities.push({
                capabilityId: 'light_temperature',
                cluster: CLUSTER.COLOR_CONTROL,
            });
        }

        if (this.hasCapability('light_mode')) {
            colorCapabilities.push({
                capabilityId: 'light_mode',
                cluster: CLUSTER.COLOR_CONTROL,
            });
        }

        // Register all color capabilities together with debouncing
        if (colorCapabilities.length > 0) {
            this.registerMultipleCapabilities(colorCapabilities, async (valueObj, optsObj) => {
                const lightHueChanged = typeof valueObj.light_hue === 'number';
                const lightSaturationChanged = typeof valueObj.light_saturation === 'number';
                const lightTemperatureChanged = typeof valueObj.light_temperature === 'number';
                const lightModeChanged = typeof valueObj.light_mode === 'string';

                // If hue or saturation changed, or mode switched to color
                if (lightHueChanged || lightSaturationChanged || (lightModeChanged && valueObj.light_mode === 'color')) {
                    return this.changeColor(
                        {
                            hue: valueObj.light_hue,
                            saturation: valueObj.light_saturation,
                        },
                        { ...optsObj.light_hue, ...optsObj.light_saturation }
                    );
                }

                // If temperature changed or mode switched to temperature
                if (lightTemperatureChanged || (lightModeChanged && valueObj.light_mode === 'temperature')) {
                    return this.changeColorTemperature(
                        valueObj.light_temperature,
                        optsObj.light_temperature || {}
                    );
                }
            });
        }

        // Setup attribute report listeners
        this.setupColorReportListeners();
    }

    setupColorReportListeners() {
        try {
            const colorControl = this.colorControlCluster;

            // Listen for hue changes
            colorControl.on('attr.currentHue', value => {
                // Ignore reports if we recently sent a command
                if (Date.now() < this._ignoreHueReportsUntil) return;
                if (this.hasCapability('light_hue')) {
                    this.setCapabilityValue('light_hue', value / MAX_HUE).catch(this.error);
                }
            });

            // Listen for saturation changes
            colorControl.on('attr.currentSaturation', value => {
                // Ignore reports if we recently sent a command
                if (Date.now() < this._ignoreSaturationReportsUntil) return;
                if (this.hasCapability('light_saturation')) {
                    this.setCapabilityValue('light_saturation', value / MAX_SATURATION).catch(this.error);
                }
            });

            // Listen for color temperature changes
            colorControl.on('attr.colorTemperatureMireds', value => {
                // Ignore reports if we recently sent a command
                if (Date.now() < this._ignoreColorTempReportsUntil) return;
                if (this.hasCapability('light_temperature')) {
                    const tempValue = (value - MIN_COLORTEMP_MIREDS) / (MAX_COLORTEMP_MIREDS - MIN_COLORTEMP_MIREDS);
                    this.setCapabilityValue('light_temperature', limitValue(tempValue, 0, 1)).catch(this.error);
                }
            });

            // Listen for color mode changes
            colorControl.on('attr.colorMode', value => {
                if (this.hasCapability('light_mode')) {
                    const mode = (value === 'colorTemperatureMireds') ? 'temperature' : 'color';
                    this.setCapabilityValue('light_mode', mode).catch(this.error);
                }
            });

        } catch (err) {
            this.error('Error setting up color report listeners:', err);
        }
    }

    async changeColor({ hue, saturation }, opts = {}) {
        // Get current values if not provided
        if (typeof hue !== 'number') hue = this.getCapabilityValue('light_hue') ?? 0;
        if (typeof saturation !== 'number') saturation = this.getCapabilityValue('light_saturation') ?? 1;

        // Set report suppression timestamps to prevent stale reports from reverting the change
        const suppressUntil = Date.now() + REPORT_DEBOUNCE_TIME;
        this._ignoreHueReportsUntil = suppressUntil;
        this._ignoreSaturationReportsUntil = suppressUntil;

        try {
            await this.colorControlCluster.moveToHueAndSaturation({
                hue: Math.round(hue * MAX_HUE),
                saturation: Math.round(saturation * MAX_SATURATION),
                transitionTime: calculateColorControlTransitionTime(opts),
            });

            // Update light_mode to color
            if (this.hasCapability('light_mode') && this.getCapabilityValue('light_mode') !== 'color') {
                await this.setCapabilityValue('light_mode', 'color').catch(this.error);
            }
            return true;
        } catch (err) {
            this.error('Failed to change color:', err);
            throw err;
        }
    }

    async changeColorTemperature(temperature, opts = {}) {
        // Get current value if not provided
        if (typeof temperature !== 'number') temperature = this.getCapabilityValue('light_temperature') ?? 0.5;

        // Set report suppression timestamp to prevent stale reports from reverting the change
        this._ignoreColorTempReportsUntil = Date.now() + REPORT_DEBOUNCE_TIME;

        try {
            // Convert 0-1 scale to mireds (0 = cool/low mireds, 1 = warm/high mireds)
            await this.colorControlCluster.moveToColorTemperature({
                colorTemperature: Math.round(MIN_COLORTEMP_MIREDS + (temperature * (MAX_COLORTEMP_MIREDS - MIN_COLORTEMP_MIREDS))),
                transitionTime: calculateColorControlTransitionTime(opts),
            });

            // Update light_mode to temperature
            if (this.hasCapability('light_mode') && this.getCapabilityValue('light_mode') !== 'temperature') {
                await this.setCapabilityValue('light_mode', 'temperature').catch(this.error);
            }
            return true;
        } catch (err) {
            this.error('Failed to change color temperature:', err);
            throw err;
        }
    }

    // Handle device coming back online
    async onEndDeviceAnnounce() {
        try {
            // Read current state
            const [onOffAttrs, levelAttrs, colorAttrs] = await Promise.all([
                this.onOffCluster.readAttributes(['onOff']).catch(() => ({})),
                this.levelControlCluster.readAttributes(['currentLevel']).catch(() => ({})),
                this.colorControlCluster.readAttributes([
                    'currentHue',
                    'currentSaturation',
                    'colorTemperatureMireds',
                    'colorMode'
                ]).catch(() => ({})),
            ]);

            // Update capabilities
            if (typeof onOffAttrs.onOff === 'boolean') {
                await this.setCapabilityValue('onoff', onOffAttrs.onOff).catch(this.error);
            }
            if (typeof levelAttrs.currentLevel === 'number') {
                await this.setCapabilityValue('dim', levelAttrs.currentLevel / MAX_DIM).catch(this.error);
            }
            if (typeof colorAttrs.currentHue === 'number' && this.hasCapability('light_hue')) {
                await this.setCapabilityValue('light_hue', colorAttrs.currentHue / MAX_HUE).catch(this.error);
            }
            if (typeof colorAttrs.currentSaturation === 'number' && this.hasCapability('light_saturation')) {
                await this.setCapabilityValue('light_saturation', colorAttrs.currentSaturation / MAX_SATURATION).catch(this.error);
            }
            if (typeof colorAttrs.colorTemperatureMireds === 'number' && this.hasCapability('light_temperature')) {
                const tempValue = (colorAttrs.colorTemperatureMireds - MIN_COLORTEMP_MIREDS) / (MAX_COLORTEMP_MIREDS - MIN_COLORTEMP_MIREDS);
                await this.setCapabilityValue('light_temperature', limitValue(tempValue, 0, 1)).catch(this.error);
            }
            if (colorAttrs.colorMode && this.hasCapability('light_mode')) {
                const mode = (colorAttrs.colorMode === 'colorTemperatureMireds') ? 'temperature' : 'color';
                await this.setCapabilityValue('light_mode', mode).catch(this.error);
            }
        } catch (err) {
            this.error('Error refreshing device state:', err);
        }
    }
}

module.exports = OsramLightifyRGBWDevice;
