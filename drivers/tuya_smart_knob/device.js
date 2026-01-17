'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER } = require('zigbee-clusters');
const OnOffBoundCluster = require('../../lib/OnOffBoundCluster');
const LevelControlBoundCluster = require('../../lib/LevelControlBoundCluster');
const ColorControlBoundCluster = require('../../lib/ColorControlBoundCluster');

class TuyaSmartKnob extends ZigBeeDevice {

    async onNodeInit({ zclNode }) {

        // Initialize double-click detection
        this.lastPressTime = 0;
        this.DOUBLE_CLICK_WINDOW = 500; // 500ms window for double-click

        // Initialize rotation detection for command 252
        this.last252Time = 0;
        this.rotation252Count = 0;
        this.ROTATION_WINDOW = 5000; // 5 second window to detect rotation pattern (allows slow rotation)

        // Register capabilities
        if (!this.hasCapability('measure_battery')) {
            await this.addCapability('measure_battery').catch(this.error);
        }

        // Add last_action capability for showing button actions in app
        if (!this.hasCapability('last_action')) {
            await this.addCapability('last_action').catch(this.error);
        }

        // Initialize last action
        await this.setCapabilityValue('last_action', '-').catch(this.error);

        // Battery reporting
        if (this.hasCapability('measure_battery')) {
            this.registerCapability('measure_battery', CLUSTER.POWER_CONFIGURATION, {
                reportOpts: {
                    configureAttributeReporting: {
                        minInterval: 3600,
                        maxInterval: 65000,
                        minChange: 10,
                    },
                },
            });
        }

        // Store zclNode for later use in settings
        this.zclNode = zclNode;

        // Get the raw Zigbee node for frame inspection
        const node = await this.homey.zigbee.getNode(this);

        // Override handleFrame to handle Tuya commands
        const originalHandleFrame = node.handleFrame.bind(node);
        node.handleFrame = (endpointId, clusterId, frame, meta) => {
            const frameJSON = frame.toJSON();

            // Handle Tuya manufacturer-specific OnOff commands (Cluster 6)
            if (clusterId === 6 && frameJSON.data) {
                const frameData = frameJSON.data;

                if (frameData.length > 3) {
                    const commandId = frameData[2]; // Command ID is at index 2
                    const data = frameData[3];      // Data payload is at index 3

                    if (commandId === 252 || commandId === 253) {
                        this._handleTuyaButtonCommand(commandId, data);
                    }
                }
            }

            return originalHandleFrame(endpointId, clusterId, frame, meta);
        };

        // Configure bindings for the device to send commands to Homey
        try {
            // Create bound cluster instance for receiving on/off commands (toggle)
            const onOffBoundCluster = new OnOffBoundCluster({
                onToggle: this._handleToggle.bind(this),
                onSetOn: () => {},
                onSetOff: () => {},
            });

            // Bind OnOff cluster only
            await zclNode.endpoints[1].bind(CLUSTER.ON_OFF.NAME, onOffBoundCluster);
        } catch (err) {
            this.error('OnOff binding configuration failed:', err.message);
        }

        // Try binding LevelControl with BoundCluster
        try {
            const levelControlBoundCluster = new LevelControlBoundCluster({
                onStep: this._handleStep.bind(this),
                onStepWithOnOff: this._handleStep.bind(this),
                onStop: () => {},
                onStopWithOnOff: () => {},
            });

            await zclNode.endpoints[1].bind(CLUSTER.LEVEL_CONTROL.NAME, levelControlBoundCluster);
        } catch (err) {
            // Binding may not be supported by all devices
        }

        // Try binding ColorControl with BoundCluster for long press detection
        try {
            const colorControlBoundCluster = new ColorControlBoundCluster({
                onStepColorTemp: this._handleLongPress.bind(this),
                onMoveToHue: () => {},
                onStop: () => {},
            });

            await zclNode.endpoints[1].bind(CLUSTER.COLOR_CONTROL.NAME, colorControlBoundCluster);
        } catch (err) {
            // Binding may not be supported by all devices
        }

        // Listen for onOff commands (for Tuya manufacturer-specific commands)
        if (zclNode.endpoints[1].clusters.onOff) {
            zclNode.endpoints[1].clusters.onOff.on('command', (command) => {
                this._handleOnOffCommand(command);
            });
        }

        // Listen for levelControl commands
        if (zclNode.endpoints[1].clusters.levelControl) {
            zclNode.endpoints[1].clusters.levelControl.on('command', this._handleLevelControlCommand.bind(this));
        }

        // Listen for colorControl commands
        if (zclNode.endpoints[1].clusters.colorControl) {
            zclNode.endpoints[1].clusters.colorControl.on('command', (command) => {
                this._handleColorControlCommand(command);
            });
        }

        // Register action flow cards
        this._registerFlowCards();
    }

    _handleTuyaButtonCommand(commandId, data) {
        const now = Date.now();

        // Command 252 (0xFC) - rotation commands
        if (commandId === 252 && data === 0) {
            // Rotation right (clockwise)
            const timeSinceLast252 = now - this.last252Time;

            if (timeSinceLast252 < this.ROTATION_WINDOW) {
                this.rotation252Count++;
            } else {
                this.rotation252Count = 1;
            }

            // Update last action in app
            this.setCapabilityValue('last_action', '↻ Rotate Right').catch(this.error);

            // Always trigger rotation right
            this.rotateRightTrigger.trigger(this, {
                step_size: 1,
                transition_time: 0
            }).catch(this.error);

            this.last252Time = now;
        } else if (commandId === 252 && data === 1) {
            // Rotation left (counter-clockwise)
            const timeSinceLast252 = now - this.last252Time;

            if (timeSinceLast252 < this.ROTATION_WINDOW) {
                this.rotation252Count++;
            } else {
                this.rotation252Count = 1;
            }

            // Update last action in app
            this.setCapabilityValue('last_action', '↺ Rotate Left').catch(this.error);

            // Always trigger rotation left
            this.rotateLeftTrigger.trigger(this, {
                step_size: 1,
                transition_time: 0
            }).catch(this.error);

            this.last252Time = now;
        } else if (commandId === 253 && data === 0) {
            // Single press
            this.setCapabilityValue('last_action', '◉ Single Press').catch(this.error);
            this.singlePressTrigger.trigger(this, {}).catch(this.error);
            this.toggleTrigger.trigger(this, {}).catch(this.error);
        } else if (commandId === 253 && data === 1) {
            // Double press
            this.setCapabilityValue('last_action', '◉◉ Double Press').catch(this.error);
            this.doublePressTrigger.trigger(this, {}).catch(this.error);
        } else if (commandId === 253 && data === 2) {
            // Long press
            this.setCapabilityValue('last_action', '⊙ Long Press').catch(this.error);
            this.longPressTrigger.trigger(this, {}).catch(this.error);
        }
    }

    _handleOnOffCommand(command) {
        const { name } = command;

        // Handle standard toggle command
        if (name === 'toggle') {
            this._handleToggle();
        }
    }

    _handleToggle() {
        const now = Date.now();
        const timeSinceLastPress = now - this.lastPressTime;

        if (timeSinceLastPress < this.DOUBLE_CLICK_WINDOW && timeSinceLastPress > 50) {
            // Double press detected
            this.doublePressTrigger.trigger(this, {}).catch(this.error);
            this.lastPressTime = 0; // Reset to prevent triple-click triggering double again
        } else {
            // Single press - use timeout to distinguish from potential double press
            if (this.singlePressTimeout) {
                clearTimeout(this.singlePressTimeout);
            }

            this.singlePressTimeout = setTimeout(() => {
                this.singlePressTrigger.trigger(this, {}).catch(this.error);
            }, this.DOUBLE_CLICK_WINDOW);

            this.lastPressTime = now;
        }

        // Always trigger toggle for backwards compatibility
        this.toggleTrigger.trigger(this, {}).catch(this.error);
    }

    _handleStep(payload) {
        const { mode, stepSize, transitionTime } = payload;

        if (mode === 'up') {
            this.rotateRightTrigger.trigger(this, {
                step_size: stepSize,
                transition_time: (transitionTime || 0) / 10
            }).catch(this.error);
        } else {
            this.rotateLeftTrigger.trigger(this, {
                step_size: stepSize,
                transition_time: (transitionTime || 0) / 10
            }).catch(this.error);
        }
    }

    _handleLevelControlCommand(command) {
        const { name, args } = command;

        if (name === 'step' || name === 'stepWithOnOff') {
            const stepMode = args.stepmode || 0;
            const stepSize = args.stepsize || 1;
            const transitionTime = args.transitiontime || 0;
            const direction = stepMode === 0 ? 'up' : 'down';

            if (direction === 'up') {
                this.rotateRightTrigger.trigger(this, {
                    step_size: stepSize,
                    transition_time: transitionTime / 10
                }).catch(this.error);
            } else {
                this.rotateLeftTrigger.trigger(this, {
                    step_size: stepSize,
                    transition_time: transitionTime / 10
                }).catch(this.error);
            }
        }
    }

    _handleLongPress(payload) {
        this.longPressTrigger.trigger(this, {}).catch(this.error);
    }

    _handleColorControlCommand(command) {
        const { name } = command;

        if (name === 'stepColorTemp') {
            // Long press detected - stepColorTemp is sent at start of long press
            this.longPressTrigger.trigger(this, {}).catch(this.error);
        } else if (name === 'enhancedMoveToHueAndSaturation') {
            // This might be double-click
            this.doublePressTrigger.trigger(this, {}).catch(this.error);
        }
    }

    _registerFlowCards() {
        // Register action trigger cards
        this.rotateLeftTrigger = this.homey.flow.getDeviceTriggerCard('rotate_left');
        this.rotateRightTrigger = this.homey.flow.getDeviceTriggerCard('rotate_right');
        this.singlePressTrigger = this.homey.flow.getDeviceTriggerCard('single_press');
        this.doublePressTrigger = this.homey.flow.getDeviceTriggerCard('double_press');
        this.longPressTrigger = this.homey.flow.getDeviceTriggerCard('long_press');
        this.toggleTrigger = this.homey.flow.getDeviceTriggerCard('toggle_action');
    }


    async onSettings({ oldSettings, newSettings, changedKeys }) {
        for (const key of changedKeys) {
            if (key === 'operation_mode') {
                try {
                    const mode = newSettings.operation_mode === 'event' ? 1 : 0;
                    await this.zclNode.endpoints[1].clusters.onOff.writeAttributes({
                        tuyaOperationMode: mode
                    });
                } catch (error) {
                    this.error('Failed to set operation mode:', error);
                    throw error;
                }
            }
        }
    }

    onDeleted() {
        // Device deleted
    }

}

module.exports = TuyaSmartKnob;