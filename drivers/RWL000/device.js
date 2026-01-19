'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER } = require('zigbee-clusters');
const OnOffBoundCluster = require('../../lib/OnOffBoundCluster');
const LevelControlBoundCluster = require('../../lib/LevelControlBoundCluster');

class DimmerSwitch extends ZigBeeDevice {

async onNodeInit({ zclNode }) {

  this.printNode();

    // Add last_action capability if it doesn't exist (for devices paired before this update)
    if (!this.hasCapability('last_action')) {
      await this.addCapability('last_action');
      this.log('Added last_action capability');
    }

    // Buttons - Endpoint 1
    zclNode.endpoints[1].bind(CLUSTER.ON_OFF.NAME, new OnOffBoundCluster({
      onSetOn: this._onCommandParser.bind(this),
      onSetOff: this._offCommandParser.bind(this),
      offWithEffect: this._offCommandParser.bind(this)
    }));

    zclNode.endpoints[1].bind(CLUSTER.LEVEL_CONTROL.NAME, new LevelControlBoundCluster({
      onStep: this._stepCommandParser.bind(this),
      onStepWithOnOff: this._stepCommandParser.bind(this),
      onStop: this._stopCommandParser.bind(this),
      onStopWithOnOff: this._stopCommandParser.bind(this),
    }));

    this._switchOnTriggerDevice = this.homey.flow.getDeviceTriggerCard('RWL000_on');
    this._switchOffTriggerDevice = this.homey.flow.getDeviceTriggerCard('RWL000_off');
    this._switchDimTriggerDevice = this.homey.flow.getDeviceTriggerCard('RWL000_dim')
      .registerRunListener(async (args, state) => {
        return (null, args.action === state.action);
      });

    // Battery - Endpoint 2 (CRITICAL: Must use endpoint 2, not device level)
    // Listen for battery percentage reports from endpoint 2
    if (this.hasCapability('alarm_battery')) {
      this.batteryThreshold = this.getSetting('batteryThreshold') || 20;

      // Register event listener for battery updates on endpoint 2
      zclNode.endpoints[2].clusters[CLUSTER.POWER_CONFIGURATION.NAME]
        .on('attr.batteryPercentageRemaining', this.onBatteryPercentageRemainingAttributeReport.bind(this));

      // Read initial battery status from endpoint 2
      try {
        const batteryStatus = await this.zclNode.endpoints[2].clusters.powerConfiguration.readAttributes(['batteryPercentageRemaining']);
        this.log("Initial battery level:", batteryStatus.batteryPercentageRemaining / 2, "%");
        this.setCapabilityValue('alarm_battery', (batteryStatus.batteryPercentageRemaining / 2 < this.batteryThreshold) ? true : false);
      } catch (err) {
        this.error('Error reading initial battery status:', err);
      }
    }

  }

  _onCommandParser() {
    this.setCapabilityValue('last_action', 'On button pressed').catch(err => this.error('Error setting last_action:', err));
    return this._switchOnTriggerDevice.trigger(this, {}, {})
      .then(() => this.log('triggered RWL000_on'))
      .catch(err => this.error('Error triggering RWL000_on', err));
  }

  _offCommandParser() {
    this.setCapabilityValue('last_action', 'Off button pressed').catch(err => this.error('Error setting last_action:', err));
    return this._switchOffTriggerDevice.trigger(this, {}, {})
      .then(() => this.log('triggered RWL000_off'))
      .catch(err => this.error('Error triggering RWL000_off', err));
  }

  _stepCommandParser(payload) {
    var action = payload.stepSize === 30 ? 'press' : 'hold'; // 30=press,56=hold
    var actionText = payload.mode === 'up' ? 'Dim up' : 'Dim down';
    var fullAction = `${actionText} (${action})`;
    this.setCapabilityValue('last_action', fullAction).catch(err => this.error('Error setting last_action:', err));
    return this._switchDimTriggerDevice.trigger(this, {}, { action: `${payload.mode}-${action}` })
      .then(() => this.log(`triggered RWL000_dim, action=${payload.mode}-${action}`))
      .catch(err => this.error('Error triggering RWL000_dim', err));
  }

  _stopCommandParser() {
    this.setCapabilityValue('last_action', 'Dim button released').catch(err => this.error('Error setting last_action:', err));
    return this._switchDimTriggerDevice.trigger(this, {}, { action: 'release' })
    .then(() => this.log('triggered RWL000_dim, action=release'))
    .catch(err => this.error('Error triggering RWL000_dim', err));
  }

  onBatteryPercentageRemainingAttributeReport(batteryPercentageRemaining) {
    const batteryPercentage = batteryPercentageRemaining / 2;
    this.log('Battery percentage report:', batteryPercentage, '%');
    this.setCapabilityValue('alarm_battery', (batteryPercentage < this.batteryThreshold) ? true : false)
      .catch(err => this.error('Error setting alarm_battery capability value', err));
  }

}

module.exports = DimmerSwitch;