'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER } = require('zigbee-clusters');
const OnOffBoundCluster = require('../../lib/OnOffBoundCluster');
const LevelControlBoundCluster = require('../../lib/LevelControlBoundCluster');
const ColorControlBoundCluster = require('../../lib/ColorControlBoundCluster');

const LOG_PREFIX = '[KNOB_TEST]';

class TuyaSmartKnob extends ZigBeeDevice {

  async onNodeInit({ zclNode }) {
    this.lastPressTime = 0;
    this.DOUBLE_CLICK_WINDOW = 500;
    this.last252Time = 0;
    this.rotation252Count = 0;
    this.ROTATION_WINDOW = 5000;

    if (!this.hasCapability('measure_battery')) {
      await this.addCapability('measure_battery').catch(this.error);
    }

    if (!this.hasCapability('last_action')) {
      await this.addCapability('last_action').catch(this.error);
    }

    await this.setCapabilityValue('last_action', '-').catch(this.error);

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

    this.zclNode = zclNode;
    const node = await this.homey.zigbee.getNode(this);

    const originalHandleFrame = node.handleFrame.bind(node);
    node.handleFrame = (endpointId, clusterId, frame, meta) => {
      const frameJSON = frame.toJSON();
      if (clusterId === 6 && frameJSON.data) {
        const tuyaAction = this._extractTuyaActionFromFrameData(frameJSON.data);
        if (tuyaAction) {
          this._handleTuyaButtonCommand(tuyaAction.commandId, tuyaAction.data);
        }
      }
      return originalHandleFrame(endpointId, clusterId, frame, meta);
    };

    try {
      const onOffBoundCluster = new OnOffBoundCluster({
        onToggle: this._handleToggle.bind(this),
        onSetOn: () => {},
        onSetOff: () => {},
      });
      await zclNode.endpoints[1].bind(CLUSTER.ON_OFF.NAME, onOffBoundCluster);
    } catch (err) {
      this.error('OnOff binding configuration failed:', err.message);
    }

    try {
      const levelControlBoundCluster = new LevelControlBoundCluster({
        onStep: this._handleStep.bind(this),
        onStepWithOnOff: this._handleStep.bind(this),
        onStop: () => {},
        onStopWithOnOff: () => {},
      });
      await zclNode.endpoints[1].bind(CLUSTER.LEVEL_CONTROL.NAME, levelControlBoundCluster);
    } catch (err) {
      // Binding may not be supported by all devices.
    }

    try {
      const colorControlBoundCluster = new ColorControlBoundCluster({
        onStepColorTemp: this._handleLongPress.bind(this),
        onMoveToHue: () => {},
        onStop: () => {},
      });
      await zclNode.endpoints[1].bind(CLUSTER.COLOR_CONTROL.NAME, colorControlBoundCluster);
    } catch (err) {
      // Binding may not be supported by all devices.
    }

    if (zclNode.endpoints[1].clusters.onOff) {
      zclNode.endpoints[1].clusters.onOff.on('attributeReport', (data) => this._handleOperationModeReport(data));
      zclNode.endpoints[1].clusters.onOff.on('readResponse', (data) => this._handleOperationModeReport(data));
      zclNode.endpoints[1].clusters.onOff.on('command', (command) => this._handleOnOffCommand(command));
    }

    if (zclNode.endpoints[1].clusters.levelControl) {
      zclNode.endpoints[1].clusters.levelControl.on('command', this._handleLevelControlCommand.bind(this));
    }

    if (zclNode.endpoints[1].clusters.colorControl) {
      zclNode.endpoints[1].clusters.colorControl.on('command', (command) => this._handleColorControlCommand(command));
    }

    this._registerFlowCards();
    await this._readOperationMode();
    await this._syncOperationModeWithSettings();
  }

  _handleOperationModeReport(data) {
    if (!data || data.tuyaOperationMode === undefined) return;
    const mode = data.tuyaOperationMode === 1 ? 'event' : 'command';
    this.setSettings({ operation_mode: mode }).catch(() => {});
  }

  async _readOperationMode() {
    try {
      const onOff = this.zclNode?.endpoints?.[1]?.clusters?.onOff;
      if (!onOff) return;
      if (!this._supportsTuyaOperationMode()) return;
      const result = await onOff.readAttributes(['tuyaOperationMode']);
      if (result && result.tuyaOperationMode !== undefined) {
        const mode = result.tuyaOperationMode === 1 ? 'event' : 'command';
        this.setSettings({ operation_mode: mode }).catch(() => {});
      }
    } catch (err) {
      if (String(err?.message || '').includes('not a valid attribute of onOff')) {
        this._tuyaOperationModeUnsupported = true;
        return;
      }
      // Ignore read errors on sleepy nodes.
    }
  }

  async _syncOperationModeWithSettings(modeSetting = this.getSetting('operation_mode')) {
    if (modeSetting !== 'event' && modeSetting !== 'command') return;
    if (!this._supportsTuyaOperationMode()) return;
    try {
      const mode = modeSetting === 'event' ? 1 : 0;
      await this.zclNode.endpoints[1].clusters.onOff.writeAttributes({
        tuyaOperationMode: mode,
      });
    } catch (error) {
      if (String(error?.message || '').includes('not a valid attribute of onOff')) {
        this._tuyaOperationModeUnsupported = true;
        if (!this._loggedMissingTuyaOperationMode) {
          this._loggedMissingTuyaOperationMode = true;
          this.log(LOG_PREFIX, 'tuyaOperationMode write unsupported on this device, skipping future sync');
        }
        return;
      }
      this.error('Failed to sync operation mode:', error);
    }
  }

  _extractTuyaActionFromFrameData(frameData) {
    if (!Array.isArray(frameData) || frameData.length < 2) return null;
    const candidateOffsets = [[2, 3], [1, 2], [0, 1]];
    for (const [commandIndex, dataIndex] of candidateOffsets) {
      const commandId = frameData[commandIndex];
      const data = frameData[dataIndex];
      if ((commandId === 252 || commandId === 253) && Number.isInteger(data)) {
        return { commandId, data };
      }
    }
    return null;
  }

  _supportsTuyaOperationMode() {
    if (this._tuyaOperationModeUnsupported) return false;
    const onOff = this.zclNode?.endpoints?.[1]?.clusters?.onOff;
    if (!onOff?.constructor) return false;
    const attrs = onOff.constructor.attributes || onOff.constructor.ATTRIBUTES || {};
    const supported = Boolean(attrs.tuyaOperationMode);
    if (!supported && !this._loggedMissingTuyaOperationMode) {
      this._loggedMissingTuyaOperationMode = true;
      this.log(LOG_PREFIX, 'tuyaOperationMode attribute not exposed by onOff cluster, skipping mode sync');
    }
    return supported;
  }

  _extractTuyaValue(args) {
    if (!args) return null;
    if (typeof args.value === 'number') return args.value;
    if (typeof args.data?.value === 'number') return args.data.value;
    if (typeof args.action === 'number') return args.action;
    if (typeof args.button === 'number') return args.button;

    const rawData = args.data;
    if (Array.isArray(rawData) && rawData.length > 0 && Number.isInteger(rawData[0])) return rawData[0];
    if (Buffer.isBuffer(rawData) && rawData.length > 0) return rawData[0];

    return null;
  }

  _handleTuyaButtonCommand(commandId, data) {
    const now = Date.now();
    if (commandId === 252 && data === 0) {
      this.log(LOG_PREFIX, 'Decoded action:', 'rotate_right');
      const timeSinceLast252 = now - this.last252Time;
      this.rotation252Count = timeSinceLast252 < this.ROTATION_WINDOW ? this.rotation252Count + 1 : 1;
      this.setCapabilityValue('last_action', 'Rotate Right').catch(this.error);
      this.rotateRightTrigger.trigger(this, { step_size: 1, transition_time: 0 }).catch(this.error);
      this.last252Time = now;
      return;
    }

    if (commandId === 252 && data === 1) {
      this.log(LOG_PREFIX, 'Decoded action:', 'rotate_left');
      const timeSinceLast252 = now - this.last252Time;
      this.rotation252Count = timeSinceLast252 < this.ROTATION_WINDOW ? this.rotation252Count + 1 : 1;
      this.setCapabilityValue('last_action', 'Rotate Left').catch(this.error);
      this.rotateLeftTrigger.trigger(this, { step_size: 1, transition_time: 0 }).catch(this.error);
      this.last252Time = now;
      return;
    }

    if (commandId === 253 && data === 0) {
      this.log(LOG_PREFIX, 'Decoded action:', 'single');
      this.setCapabilityValue('last_action', 'Single Press').catch(this.error);
      this.singlePressTrigger.trigger(this, {}).catch(this.error);
      this.toggleTrigger.trigger(this, {}).catch(this.error);
      return;
    }

    if (commandId === 253 && data === 1) {
      this.log(LOG_PREFIX, 'Decoded action:', 'double');
      this.setCapabilityValue('last_action', 'Double Press').catch(this.error);
      this.doublePressTrigger.trigger(this, {}).catch(this.error);
      return;
    }

    if (commandId === 253 && data === 2) {
      this.log(LOG_PREFIX, 'Decoded action:', 'hold');
      this.setCapabilityValue('last_action', 'Long Press').catch(this.error);
      this.longPressTrigger.trigger(this, {}).catch(this.error);
    }
  }

  _handleOnOffCommand(command) {
    const { name, args } = command;
    if (name === 'toggle') {
      this._handleToggle();
      return;
    }

    if (name === 'commandTuyaAction' || name === 'tuyaAction') {
      const value = this._extractTuyaValue(args);
      if (value === null) return;
      if (value === 0) {
        this.setCapabilityValue('last_action', 'Single Press').catch(this.error);
        this.singlePressTrigger.trigger(this, {}).catch(this.error);
        this.toggleTrigger.trigger(this, {}).catch(this.error);
      } else if (value === 1) {
        this.setCapabilityValue('last_action', 'Double Press').catch(this.error);
        this.doublePressTrigger.trigger(this, {}).catch(this.error);
      } else if (value === 2) {
        this.setCapabilityValue('last_action', 'Long Press').catch(this.error);
        this.longPressTrigger.trigger(this, {}).catch(this.error);
      }
      return;
    }

    if (name === 'commandTuyaAction2' || name === 'tuyaAction2') {
      const value = this._extractTuyaValue(args);
      if (value === null) return;
      if (value === 0) {
        this.setCapabilityValue('last_action', 'Rotate Right').catch(this.error);
        this.rotateRightTrigger.trigger(this, { step_size: 1, transition_time: 0 }).catch(this.error);
      } else if (value === 1) {
        this.setCapabilityValue('last_action', 'Rotate Left').catch(this.error);
        this.rotateLeftTrigger.trigger(this, { step_size: 1, transition_time: 0 }).catch(this.error);
      }
    }
  }

  _handleToggle() {
    const now = Date.now();
    const timeSinceLastPress = now - this.lastPressTime;
    if (timeSinceLastPress < this.DOUBLE_CLICK_WINDOW && timeSinceLastPress > 50) {
      this.doublePressTrigger.trigger(this, {}).catch(this.error);
      this.lastPressTime = 0;
    } else {
      if (this.singlePressTimeout) {
        clearTimeout(this.singlePressTimeout);
      }
      this.singlePressTimeout = setTimeout(() => {
        this.singlePressTrigger.trigger(this, {}).catch(this.error);
      }, this.DOUBLE_CLICK_WINDOW);
      this.lastPressTime = now;
    }
    this.toggleTrigger.trigger(this, {}).catch(this.error);
  }

  _handleStep(payload) {
    const { mode, stepSize, transitionTime } = payload;
    if (mode === 'up') {
      this.rotateRightTrigger.trigger(this, {
        step_size: stepSize,
        transition_time: (transitionTime || 0) / 10,
      }).catch(this.error);
    } else {
      this.rotateLeftTrigger.trigger(this, {
        step_size: stepSize,
        transition_time: (transitionTime || 0) / 10,
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
          transition_time: transitionTime / 10,
        }).catch(this.error);
      } else {
        this.rotateLeftTrigger.trigger(this, {
          step_size: stepSize,
          transition_time: transitionTime / 10,
        }).catch(this.error);
      }
    }
  }

  _handleLongPress() {
    this.longPressTrigger.trigger(this, {}).catch(this.error);
  }

  _handleColorControlCommand(command) {
    const { name } = command;
    if (name === 'stepColorTemp') {
      this.longPressTrigger.trigger(this, {}).catch(this.error);
    } else if (name === 'enhancedMoveToHueAndSaturation') {
      this.doublePressTrigger.trigger(this, {}).catch(this.error);
    }
  }

  _registerFlowCards() {
    this.rotateLeftTrigger = this.homey.flow.getDeviceTriggerCard('rotate_left_test');
    this.rotateRightTrigger = this.homey.flow.getDeviceTriggerCard('rotate_right_test');
    this.singlePressTrigger = this.homey.flow.getDeviceTriggerCard('single_press_test');
    this.doublePressTrigger = this.homey.flow.getDeviceTriggerCard('double_press_test');
    this.longPressTrigger = this.homey.flow.getDeviceTriggerCard('long_press_test');
    this.toggleTrigger = this.homey.flow.getDeviceTriggerCard('toggle_action_test');
  }

  async onSettings({ newSettings, changedKeys }) {
    for (const key of changedKeys) {
      if (key === 'operation_mode') {
        try {
          await this._syncOperationModeWithSettings(newSettings.operation_mode);
        } catch (error) {
          if (String(error?.message || '').includes('not a valid attribute of onOff')) {
            this._tuyaOperationModeUnsupported = true;
            return;
          }
          this.error('Failed to set operation mode:', error);
          return;
        }
      }
    }
  }

  onDeleted() {
    // Device deleted.
  }

}

module.exports = TuyaSmartKnob;
