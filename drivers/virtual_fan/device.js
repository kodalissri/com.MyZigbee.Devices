'use strict';

const { Device } = require('homey');
const mqtt = require('mqtt');

// DPID → MQTT sub-path mappings
const TOPIC_ONOFF        = '1/set';
const TOPIC_MODE         = '2/set';
const TOPIC_SPEED        = '3/set';
const TOPIC_OSCILLATE    = '5/set';
const TOPIC_TEMPERATURE  = '21/get';

// Fan mode string → DPID value
const MODE_MAP = {
  normal:  0,
  natural: 1,
  sleep:   2,
  auto:    3,
};

// Map Homey dim (0–1) to fan speed (1–5)
const dimToSpeed = (dim) => Math.max(1, Math.min(5, Math.round(dim * 4) + 1));

class OmniBreezeFanDevice extends Device {

  async onInit() {
    this.log('OmniBreeze Fan device initialized');
    this._mqttClient = null;
    await this._connectMqtt();
    this._registerCapabilityListeners();
  }

  // ─── MQTT ──────────────────────────────────────────────────────────────────

  async _connectMqtt(overrideSettings = {}) {
    // Disconnect any existing client first
    await this._disconnectMqtt();

    // Use overrideSettings (from onSettings) if provided, otherwise fall back to stored settings
    const broker   = overrideSettings.mqtt_broker   ?? this.getSetting('mqtt_broker');
    const port     = overrideSettings.mqtt_port     ?? this.getSetting('mqtt_port')     ?? 1883;
    const username = overrideSettings.mqtt_username ?? this.getSetting('mqtt_username') ?? '';
    const password = overrideSettings.mqtt_password ?? this.getSetting('mqtt_password') ?? '';
    const topic    = overrideSettings.mqtt_topic    ?? this.getSetting('mqtt_topic')    ?? 'omnibreeze-fan-1';

    if (!broker) {
      this.log('No MQTT broker configured — skipping connection');
      return;
    }

    const url = `mqtt://${broker}:${port}`;
    this.log(`Connecting to MQTT broker: ${url}, topic prefix: ${topic}`);

    const options = {
      clientId: `homey_omnibreeze_${this.getData().id}`,
      clean: true,
      reconnectPeriod: 5000,
    };
    if (username) options.username = username;
    if (password) options.password = password;

    this._activeTopic = topic;
    this._mqttClient = mqtt.connect(url, options);

    this._mqttClient.on('connect', () => {
      this.log('MQTT connected');
      // Subscribe to all state feedback topics from the device
      const subscriptions = [
        `${topic}/1/get`,   // power state
        `${topic}/2/get`,   // mode state
        `${topic}/3/get`,   // speed state
        `${topic}/5/get`,   // oscillation state
        `${topic}/${TOPIC_TEMPERATURE}`,  // temperature (read-only)
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

  _publish(subPath, value) {
    if (!this._mqttClient || !this._mqttClient.connected) {
      this.error('MQTT not connected — cannot publish');
      return;
    }
    const topic = `${this._activeTopic}/${subPath}`;
    const payload = String(value);
    this.log(`MQTT publish → ${topic} : ${payload}`);
    this._mqttClient.publish(topic, payload);
  }

  _handleMqttMessage(topic, message) {
    const base = this._activeTopic;
    const val = message.trim();

    if (topic === `${base}/1/get`) {
      const on = val === '1' || val.toLowerCase() === 'true';
      this.log(`State update — onoff: ${on}`);
      this.setCapabilityValue('onoff', on).catch(this.error);

    } else if (topic === `${base}/2/get`) {
      const modeIndex = parseInt(val, 10);
      const modeKey = Object.keys(MODE_MAP).find((k) => MODE_MAP[k] === modeIndex);
      if (modeKey) {
        this.log(`State update — fan_mode: ${modeKey}`);
        this.setCapabilityValue('fan_mode', modeKey).catch(this.error);
      }

    } else if (topic === `${base}/3/get`) {
      const speed = parseInt(val, 10);
      if (speed >= 1 && speed <= 5) {
        const dim = (speed - 1) / 4;
        this.log(`State update — speed: ${speed} → dim: ${dim}`);
        this.setCapabilityValue('dim', dim).catch(this.error);
      }

    } else if (topic === `${base}/5/get`) {
      const oscillating = val === '1' || val.toLowerCase() === 'true';
      this.log(`State update — oscillating: ${oscillating}`);
      this.setCapabilityValue('oscillating', oscillating).catch(this.error);

    } else if (topic === `${base}/${TOPIC_TEMPERATURE}`) {
      const temp = parseFloat(val);
      if (!isNaN(temp)) {
        this.log(`State update — temperature: ${temp}°C`);
        this.setCapabilityValue('measure_temperature', temp).catch(this.error);
      }
    }
  }

  // ─── Capability Listeners ──────────────────────────────────────────────────

  _registerCapabilityListeners() {
    this.registerCapabilityListener('onoff', async (value) => {
      this._publish(TOPIC_ONOFF, value ? 1 : 0);
    });

    this.registerCapabilityListener('dim', async (value) => {
      const speed = dimToSpeed(value);
      this.log(`dim=${value} → speed=${speed}`);
      this._publish(TOPIC_SPEED, speed);
    });

    this.registerCapabilityListener('fan_mode', async (value) => {
      const dpValue = MODE_MAP[value] ?? 0;
      this.log(`fan_mode=${value} → dpid=${dpValue}`);
      this._publish(TOPIC_MODE, dpValue);
    });

    this.registerCapabilityListener('oscillating', async (value) => {
      this._publish(TOPIC_OSCILLATE, value ? 1 : 0);
    });
  }

  // ─── Settings ──────────────────────────────────────────────────────────────

  async onSettings({ newSettings, changedKeys }) {
    const mqttKeys = ['mqtt_broker', 'mqtt_port', 'mqtt_username', 'mqtt_password', 'mqtt_topic'];
    if (changedKeys.some((k) => mqttKeys.includes(k))) {
      this.log('MQTT settings changed — reconnecting');
      // Pass newSettings directly: getSetting() still returns old values at this point
      await this._connectMqtt(newSettings);
    }

    if (changedKeys.includes('beep')) {
      this.log(`Beep → ${newSettings.beep}`);
      this._publish('13/set', newSettings.beep ? 1 : 0);
    }

    if (changedKeys.includes('display_leds')) {
      this.log(`Display LEDs → ${newSettings.display_leds}`);
      this._publish('15/set', newSettings.display_leds ? 1 : 0);
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async onDeleted() {
    this.log('OmniBreeze Fan device deleted');
    await this._disconnectMqtt();
  }

}

module.exports = OmniBreezeFanDevice;
