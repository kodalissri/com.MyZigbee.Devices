'use strict';
const { Device } = require('homey');
const { Client } = require('@2colors/esphome-native-api');

class ESPHomeHRVDevice extends Device {

  async onInit() {
    this._client = null;

    // Migrate old alarm_generic capability to hrv_boost_active
    if (this.hasCapability('alarm_generic')) {
      await this.removeCapability('alarm_generic').catch(this.error);
      this.log('Migrated: removed alarm_generic');
    }
    if (!this.hasCapability('hrv_boost_active')) {
      await this.addCapability('hrv_boost_active').catch(this.error);
      this.log('Migrated: added hrv_boost_active');
    }

    // Migrate uptime metric → connection status tile
    if (this.hasCapability('measure_uptime')) {
      await this.removeCapability('measure_uptime').catch(this.error);
      this.log('Migrated: removed measure_uptime');
    }
    if (!this.hasCapability('connection_status')) {
      await this.addCapability('connection_status').catch(this.error);
      this.log('Migrated: added connection_status');
    }
    // Show a neutral state until the first connect/disconnect event arrives
    if (!this.getCapabilityValue('connection_status')) {
      await this.setCapabilityValue('connection_status', 'Connecting…').catch(this.error);
    }

    this.registerCapabilityListener('button.boost_20', () => this._triggerBoost(20));
    this.registerCapabilityListener('button.boost_40', () => this._triggerBoost(40));
    this.registerCapabilityListener('button.boost_60', () => this._triggerBoost(60));
    this.registerCapabilityListener('button.boost_stop', () => this._triggerStop());

    await this._connect();
  }

  async _connect() {
    const settings = this.getSettings();

    this.log(`Connecting to ${settings.ip}:${settings.port || 6053}`);

    this._client = new Client({
      host: settings.ip,
      port: settings.port || 6053,
      encryptionKey: settings.encryptionKey || undefined,
      clientInfo: 'homey-esphome-hrv',
      initializeDeviceInfo: true,
      initializeListEntities: true,
      initializeSubscribeStates: true,
      reconnect: true,
      reconnectInterval: 15000,
      pingInterval: 15000,
      pingAttempts: 3,
    });

    this._client.on('connected', () => {
      this.log('Connected to', settings.ip);
      this.setAvailable().catch(this.error);
      this.setCapabilityValue('connection_status', 'Online').catch(this.error);
    });

    this._client.on('disconnected', () => {
      this.log('Disconnected from', settings.ip);
      this.setUnavailable('Connection lost').catch(this.error);
      this.setCapabilityValue('connection_status', `Offline since ${this._formatNow()}`).catch(this.error);
    });

    this._client.on('error', (err) => {
      this.error('Client error:', err.message);
    });

    this._client.on('newEntity', (entity) => {
      this.log(`[entity] name="${entity.name}" type=${entity.type}`);

      if (entity.name === 'HRV Boost Active') {
        entity.on('state', (stateObj) => {
          this.log('HRV Boost Active state:', JSON.stringify(stateObj));
          this.setCapabilityValue('hrv_boost_active', stateObj.state).catch(this.error);
        });
      }

      if (entity.name === 'HRV WiFi Signal') {
        entity.on('state', (stateObj) => {
          this.log('HRV WiFi Signal state:', stateObj.state);
          this.setCapabilityValue('measure_signal_strength', stateObj.state).catch(this.error);
        });
      }

      const boostEntities = ['HRV Boost 20 Min', 'HRV Boost 40 Min', 'HRV Boost 60 Min', 'HRV Boost Stop'];
      if (boostEntities.includes(entity.name)) {
        this.log(`Stored button entity: "${entity.name}"`);
        this[`_entity_${entity.name}`] = entity;
      }
    });

    this._client.connect();
  }

  async _triggerBoost(minutes) {
    const entityName = `HRV Boost ${minutes} Min`;
    this.log(`_triggerBoost(${minutes}) — looking for "${entityName}"`);
    const entity = this[`_entity_${entityName}`];
    if (!entity) {
      this.error(`Entity "${entityName}" not ready — stored keys:`, Object.keys(this).filter(k => k.startsWith('_entity_')));
      throw new Error(`${entityName} entity not ready`);
    }
    this.log(`Pushing "${entityName}"`);
    entity.push();
  }

  // Local time like "Jun 15, 18:07" using Homey's configured timezone
  _formatNow() {
    const tz = this.homey.clock.getTimezone();
    return new Date().toLocaleString('en-GB', {
      timeZone: tz,
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  async _triggerStop() {
    this.log('_triggerStop() — looking for "HRV Boost Stop"');
    const entity = this['_entity_HRV Boost Stop'];
    if (!entity) {
      this.error('Entity "HRV Boost Stop" not ready — stored keys:', Object.keys(this).filter(k => k.startsWith('_entity_')));
      throw new Error('HRV Boost Stop entity not ready');
    }
    this.log('Pushing "HRV Boost Stop"');
    entity.push();
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.some(k => ['ip', 'port', 'encryptionKey'].includes(k))) {
      this.log('Connection settings changed — reconnecting');
      await this._disconnect();
      await this._connect();
    }
  }

  async onDeleted() {
    await this._disconnect();
  }

  async _disconnect() {
    if (this._client) {
      this._client.disconnect();
      this._client = null;
    }
  }
}

module.exports = ESPHomeHRVDevice;
