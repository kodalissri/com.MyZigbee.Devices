'use strict';

const { Device } = require('homey');
const mqtt = require('mqtt');

// Tasmota switch number that the LD2410B OUT pin is wired to (GPIO16 = Switch 1)
const MOTION_SWITCH = 'Switch1';

class VindriktningDevice extends Device {

  async onInit() {
    this.log('VINDRIKTNING device initialized');
    this._mqttClient = null;
    await this._connectMqtt();
  }

  // ─── MQTT ──────────────────────────────────────────────────────────────────

  async _connectMqtt(overrideSettings = {}) {
    await this._disconnectMqtt();

    // Use overrideSettings (from onSettings) if provided, else stored settings.
    const broker   = overrideSettings.mqtt_broker   ?? this.getSetting('mqtt_broker');
    const port     = overrideSettings.mqtt_port     ?? this.getSetting('mqtt_port')     ?? 1883;
    const username = overrideSettings.mqtt_username ?? this.getSetting('mqtt_username') ?? '';
    const password = overrideSettings.mqtt_password ?? this.getSetting('mqtt_password') ?? '';
    const topic    = overrideSettings.mqtt_topic    ?? this.getSetting('mqtt_topic')    ?? 'vindriktning';

    if (!broker) {
      this.log('No MQTT broker configured — skipping connection');
      this.setUnavailable('No MQTT broker configured').catch(this.error);
      return;
    }

    const url = `mqtt://${broker}:${port}`;
    this.log(`Connecting to MQTT broker: ${url}, Tasmota topic: ${topic}`);

    const options = {
      clientId: `homey_vindriktning_${this.getData().id}`,
      clean: true,
      reconnectPeriod: 5000,
    };
    if (username) options.username = username;
    if (password) options.password = password;

    this._activeTopic = topic;
    this._mqttClient = mqtt.connect(url, options);

    this._mqttClient.on('connect', () => {
      this.log('MQTT connected');
      this.setAvailable().catch(this.error);
      // Tasmota publishes telemetry under these topics
      const subscriptions = [
        `tele/${topic}/SENSOR`,  // PM2.5 (and LD2410 if used over serial)
        `tele/${topic}/STATE`,   // periodic state incl. Switch1 + Wifi
        `stat/${topic}/RESULT`,  // instant switch/command changes
      ];
      subscriptions.forEach((t) => {
        this._mqttClient.subscribe(t, (err) => {
          if (err) this.error(`Failed to subscribe to ${t}:`, err);
          else this.log(`Subscribed to ${t}`);
        });
      });
    });

    this._mqttClient.on('message', (receivedTopic, message) => {
      this._handleMqttMessage(receivedTopic, message.toString());
    });

    this._mqttClient.on('error', (err) => {
      this.error('MQTT error:', err.message);
    });

    this._mqttClient.on('reconnect', () => {
      this.log('MQTT reconnecting...');
    });

    this._mqttClient.on('close', () => {
      this.log('MQTT connection closed');
    });
  }

  async _disconnectMqtt() {
    if (this._mqttClient) {
      await new Promise((resolve) => {
        this._mqttClient.end(true, {}, resolve);
      });
      this._mqttClient = null;
      this.log('MQTT disconnected');
    }
  }

  _handleMqttMessage(topic, message) {
    let data;
    try {
      data = JSON.parse(message);
    } catch (err) {
      this.log(`Non-JSON payload on ${topic}: ${message}`);
      return;
    }

    // ── PM2.5 (VINDRIKTNING) ──────────────────────────────────────────────
    // tele/<topic>/SENSOR → {"VINDRIKTNING":{"PM2.5":63}}
    const pm = this._extractPm25(data);
    if (pm !== null) {
      this.log(`PM2.5: ${pm} µg/m³`);
      this.setCapabilityValue('measure_pm25', pm).catch(this.error);
    }

    // ── Motion (LD2410B OUT → Switch1) ────────────────────────────────────
    const motion = this._extractMotion(data);
    if (motion !== null) {
      this.log(`Motion (${MOTION_SWITCH}): ${motion}`);
      this.setCapabilityValue('alarm_motion', motion).catch(this.error);
    }

    // ── WiFi signal (tele/<topic>/STATE → {"Wifi":{"Signal":-62}}) ────────
    if (data.Wifi && typeof data.Wifi.Signal === 'number') {
      this.setCapabilityValue('measure_signal_strength', data.Wifi.Signal).catch(this.error);
    }
  }

  // Pull "PM2.5" out of a VINDRIKTNING object, tolerating key variants.
  _extractPm25(data) {
    const obj = data.VINDRIKTNING ?? data.Vindriktning;
    if (!obj || typeof obj !== 'object') return null;
    const raw = obj['PM2.5'] ?? obj['PM25'] ?? obj['pm2.5'];
    const val = parseFloat(raw);
    return isNaN(val) ? null : val;
  }

  // Read the configured switch in either Tasmota representation:
  //   "Switch1":"ON"                     (tele STATE)
  //   "Switch1":{"Action":"ON"}          (stat RESULT, SetOption114)
  _extractMotion(data) {
    if (!(MOTION_SWITCH in data)) return null;
    const raw = data[MOTION_SWITCH];
    const state = typeof raw === 'object' && raw !== null ? raw.Action : raw;
    if (typeof state !== 'string') return null;
    return state.toUpperCase() === 'ON';
  }

  // ─── Settings ──────────────────────────────────────────────────────────────

  async onSettings({ newSettings, changedKeys }) {
    const mqttKeys = ['mqtt_broker', 'mqtt_port', 'mqtt_username', 'mqtt_password', 'mqtt_topic'];
    if (changedKeys.some((k) => mqttKeys.includes(k))) {
      this.log('MQTT settings changed — reconnecting');
      // getSetting() still returns old values here, so pass newSettings through.
      await this._connectMqtt(newSettings);
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async onDeleted() {
    this.log('VINDRIKTNING device deleted');
    await this._disconnectMqtt();
  }

}

module.exports = VindriktningDevice;
