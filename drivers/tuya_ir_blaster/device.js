'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { CLUSTER, Cluster } = require('zigbee-clusters');

// Import and register the Zosung IR clusters - this MUST happen before device init
const ZosungIRTransmitCluster = require('../../lib/ZosungIRTransmitCluster');
const { ZosungIRTransmitBoundCluster } = require('../../lib/ZosungIRTransmitCluster');
const ZosungIRControlCluster = require('../../lib/ZosungIRControlCluster');

const ZOSUNG_TRANSMIT_CLUSTER_ID = 0xED00; // 60672
const ZOSUNG_CONTROL_CLUSTER_ID = 0xE004; // 57348
const MIN_LEARN_LENGTH = 90;
const LONG_LEARN_LENGTH = 300;

class ZS06IRRemote extends ZigBeeDevice {

    async onNodeInit({ zclNode, node }) {
        this.log('ZS06 IR Remote (TS1201) initializing...');

        // Initialize session-based storage for multi-part transfers
        this.irStore = new Map();
        this.currentSeq = 0;
        this._lastLearnSeqHandled = null;
        this._debugEnabled = !!this.getSetting('debug_logs');

        // Store zclNode reference
        this._zclNode = zclNode;

        // Store the raw ZigBee node for sendFrame access
        this._node = node;
        this.log('ZigBee node available:', !!node);
        if (node) {
            this.log('ZigBee node methods:', Object.keys(node).filter(k => typeof node[k] === 'function'));
        }

        // Log available endpoints and clusters
        this._debugEndpoints();

        // Get the Zosung IR Transmit cluster
        await this._initializeZosungCluster();

        // Battery Reporting
        if (this.hasCapability('measure_battery')) {
            try {
                this.registerCapability('measure_battery', CLUSTER.POWER_CONFIGURATION);
            } catch (err) {
                this.log('Battery capability registration failed:', err.message);
            }
        }

        // Learning Mode listener
        this.registerCapabilityListener('button.learn_ir', async () => {
            this.log('Learn IR button pressed');
            return this._startLearningMode();
        });

        // Register Flow Cards
        this._registerFlowCards();

        this.log('ZS06 IR Remote initialization complete');
    }

    _isDebug() {
        return !!this._debugEnabled;
    }

    async onSettings({ newSettings }) {
        if (Object.prototype.hasOwnProperty.call(newSettings, 'debug_logs')) {
            this._debugEnabled = !!newSettings.debug_logs;
            this.log(`[Settings] Debug logs ${this._debugEnabled ? 'enabled' : 'disabled'}`);
        }
    }

    _debugEndpoints() {
        const endpoints = this._zclNode.endpoints;
        this.log('Available endpoints:', Object.keys(endpoints));

        for (const [epId, ep] of Object.entries(endpoints)) {
            this.log(`Endpoint ${epId} clusters:`, Object.keys(ep.clusters || {}));
        }
    }

    async _initializeZosungCluster() {
        const endpoint = this._zclNode.endpoints[1];

        if (!endpoint) {
            this.error('Endpoint 1 not found!');
            return;
        }

        // Get Transmit cluster by name (as registered)
        let transmitCluster = endpoint.clusters[ZosungIRTransmitCluster.NAME] ||
                              endpoint.clusters['60672'] ||
                              endpoint.clusters[String(ZOSUNG_TRANSMIT_CLUSTER_ID)] ||
                              endpoint.clusters[ZOSUNG_TRANSMIT_CLUSTER_ID];

        if (transmitCluster) {
            this.log('Found Zosung Transmit cluster');
            this.zosungCluster = transmitCluster;
            this._setupClusterEventListeners();
        } else {
            this.log('Zosung Transmit cluster not found. Available:', Object.keys(endpoint.clusters));
        }

        // Get Control cluster for learning mode (0xE004 = 57348)
        let controlCluster = endpoint.clusters[ZosungIRControlCluster.NAME] ||
                             endpoint.clusters['57348'] ||
                             endpoint.clusters[String(ZOSUNG_CONTROL_CLUSTER_ID)] ||
                             endpoint.clusters[ZOSUNG_CONTROL_CLUSTER_ID];

        if (controlCluster) {
            this.log('Found Zosung Control cluster');
            this.zosungControlCluster = controlCluster;
        } else {
            this.log('Zosung Control cluster not found. Available:', Object.keys(endpoint.clusters));
        }

        // Bind the BoundCluster to receive commands FROM the device (learning mode)
        this._bindTransmitCluster();
    }

    _bindTransmitCluster() {
        try {
            const endpoint = this._zclNode.endpoints[1];
            if (!endpoint) return;

            this.log('Binding ZosungIRTransmitBoundCluster to receive device commands');

            // Create bound cluster to receive commands from device
            const boundCluster = new ZosungIRTransmitBoundCluster({
                onZosungSendIRCode00: this._onCode00.bind(this),
                onZosungSendIRCode01: (payload) => this.log('[BoundCode01] Ack received:', payload),
                onZosungSendIRCode02: this._onCode02.bind(this),
                onZosungSendIRCode03: this._onCode03Bound.bind(this),
                onZosungSendIRCode04: this._onCode04.bind(this),
                onZosungSendIRCode05: this._onCode05Bound.bind(this),
                endpoint: endpoint,
            });

            // Bind to endpoint to receive incoming commands
            endpoint.bind(ZosungIRTransmitCluster.NAME, boundCluster);
            this.log('BoundCluster successfully bound');
        } catch (err) {
            this.error('Failed to bind transmit cluster:', err.message);
        }
    }

    _setupClusterEventListeners() {
        if (!this.zosungCluster) return;

        this.log('Setting up Zosung cluster event listeners');

        // Listen for events emitted by the cluster's on<CommandName> handlers
        this.zosungCluster.on('commandZosungSendIRCode00', this._onCode00.bind(this));
        this.zosungCluster.on('commandZosungSendIRCode02', this._onCode02.bind(this));
        this.zosungCluster.on('commandZosungSendIRCode03', this._onCode03.bind(this));
        this.zosungCluster.on('commandZosungSendIRCode04', this._onCode04.bind(this));
        this.zosungCluster.on('commandZosungSendIRCode05', this._onCode05.bind(this));

        this.log('Event listeners registered');
    }

    _getCluster() {
        if (this.zosungCluster) return this.zosungCluster;

        // Try to get it again
        const endpoint = this._zclNode.endpoints[1];
        if (!endpoint) return null;

        return endpoint.clusters[ZosungIRTransmitCluster.NAME] ||
               endpoint.clusters['60672'] ||
               endpoint.clusters[ZOSUNG_TRANSMIT_CLUSTER_ID] ||
               endpoint.clusters['zosungIRTransmit'];
    }

    async _startLearningMode() {
        this.log('Starting IR learning mode...');

        // Use Control cluster to start learning mode
        const controlCluster = this._getControlCluster();

        if (!controlCluster) {
            throw new Error('Zosung IR Control cluster not available. Please re-pair the device.');
        }

        try {
            // Send {study: 0} to start learning mode via Control cluster
            const learnCommand = JSON.stringify({ study: 0 });
            const commandBuffer = Buffer.from(learnCommand, 'utf8');

            this.log('Sending learn command via Control cluster:', learnCommand);

            if (typeof controlCluster.zosungControlIRCommand00 === 'function') {
                await controlCluster.zosungControlIRCommand00({
                    data: commandBuffer,
                });
                this.log('Learn mode command sent successfully via Control cluster');
            } else {
                this.error('zosungControlIRCommand00 method not available');
                this.log('Control cluster keys:', Object.keys(controlCluster));
                throw new Error('Control cluster command method not available');
            }
        } catch (err) {
            this.error('Failed to start learning mode:', err.message);
            throw err;
        }
    }

    _getControlCluster() {
        if (this.zosungControlCluster) return this.zosungControlCluster;

        // Try to get it again (0xE004 = 57348)
        const endpoint = this._zclNode.endpoints[1];
        if (!endpoint) return null;

        return endpoint.clusters[ZosungIRControlCluster.NAME] ||
               endpoint.clusters['57348'] ||
               endpoint.clusters[ZOSUNG_CONTROL_CLUSTER_ID] ||
               endpoint.clusters['zosungIRControl'];
    }

    async _onCode00(payload) {
        // Device initiated transfer (learning mode start)
        this.log(`[Code00] Learning started: Seq=${payload.seq}, Length=${payload.length}, Cmd=${payload.cmd}`);

        // Only process if this is a learning response (cmd=4) and we don't already have this seq
        if (this.irStore.has(payload.seq)) {
            this.log(`[Code00] Already processing seq ${payload.seq}, skipping duplicate`);
            return;
        }

        const skipSave = payload.cmd === 4 && payload.length < MIN_LEARN_LENGTH;
        if (skipSave) {
            this.log(`[Code00] Learn length ${payload.length} is below minimum ${MIN_LEARN_LENGTH}, will discard result`);
        } else if (payload.cmd === 4 && payload.length > LONG_LEARN_LENGTH) {
            this.log(`[Code00] Learn length ${payload.length} is very long; try a short press to avoid repeats`);
        }

        this.irStore.set(payload.seq, {
            buf: Buffer.alloc(payload.length),
            position: 0,
            length: payload.length,
            skipSave,
        });

        const cluster = this._getCluster();
        if (!cluster) {
            this.error('Cluster not available for response');
            return;
        }

        this.log('[Code00] Sending Code01 acknowledgment...');

        try {
            // Acknowledge with Code01
            await cluster.zosungSendIRCode01({
                zero: 0,
                seq: payload.seq,
                length: payload.length,
                unk1: payload.unk1 || 0,
                unk2: payload.unk2 || 0,
                unk3: payload.unk3 || 0,
                cmd: payload.cmd || 0,
                unk4: payload.unk4 || 0,
            });
            this.log('[Code00] Code01 sent successfully');

            // Request first part with Code02
            this.log('[Code00] Sending Code02 to request first chunk...');
            await cluster.zosungSendIRCode02({
                seq: payload.seq,
                position: 0,
                maxlen: 0x38, // 56 bytes
            });
            this.log('[Code00] Code02 sent successfully, waiting for Code03...');
        } catch (err) {
            this.error('Error in _onCode00:', err.message, err.stack);
        }
    }

    async _onCode02(payload) {
        // Device requests a part of the IR code (when sending)
        this.log('───────────────────────────────────────────────────────────');
        this.log(`[Code02] *** DEVICE REQUESTS DATA CHUNK ***`);
        this.log(`[Code02] Payload:`, JSON.stringify(payload));
        this.log(`[Code02] Seq=${payload.seq}, Pos=${payload.position}, MaxLen=${payload.maxlen}`);

        const entry = this.irStore.get(payload.seq);
        this.log(`[Code02] irStore has seq ${payload.seq}:`, !!entry);
        this.log(`[Code02] All irStore keys:`, Array.from(this.irStore.keys()));

        if (!entry) {
            this.error(`[Code02] ERROR: No entry found for seq ${payload.seq}`);
            return;
        }

        if (!entry.data) {
            this.error(`[Code02] ERROR: Entry exists but no data for seq ${payload.seq}`);
            this.log(`[Code02] Entry contents:`, JSON.stringify(entry));
            return;
        }

        this.log(`[Code02] Entry data length: ${entry.data.length}`);
        this.log(`[Code02] Entry data type: ${typeof entry.data}`);

        try {
            // Use fixed chunk size of 0x32 (50) as per zigbee2mqtt implementation
            const CHUNK_SIZE = 0x32; // 50 bytes
            const part = entry.data.substring(payload.position, payload.position + CHUNK_SIZE);

            this.log(`[Code02] Using chunk size: ${CHUNK_SIZE} (zigbee2mqtt standard)`);

            // Convert string to buffer for transmission
            const partBuffer = Buffer.from(part);

            // Calculate CRC on the STRING - matches zigbee2mqtt calcStringCrc
            const msgCrc = this.calcStringCrc(part);

            this.log(`[Code02] Chunk: pos=${payload.position} size=${part.length} crc=${msgCrc}`);
            if (this._isDebug()) {
                this.log(`[Code02]   - Buffer size: ${partBuffer.length} bytes`);
                this.log(`[Code02]   - Part content: "${part.substring(0, 60)}${part.length > 60 ? '...' : ''}"`);
                this.log(`[Code02]   - Remaining: ${entry.data.length - payload.position - part.length} chars`);
            }

            const cluster = this._getCluster();
            if (!cluster || typeof cluster.zosungSendIRCode03 !== 'function') {
                this.error('[Code02] Cluster method not available for Code03');
                return;
            }

            this.log('[Code02] Sending Code03 via cluster.zosungSendIRCode03...');
            await cluster.zosungSendIRCode03({
                zero: 0,
                seq: payload.seq,
                position: payload.position,
                msgpart: partBuffer,
                msgpartcrc: msgCrc,
            });
            this.log('[Code02] Code03 sent via cluster.zosungSendIRCode03');

            this.log('───────────────────────────────────────────────────────────');
        } catch (err) {
            this.error('[Code02] ERROR sending Code03:', err.message);
            this.error('[Code02] Stack:', err.stack);
        }
    }

    async _onCode03(payload) {
        // Device sends a part of the IR code (learning mode)
        this.log(`[Code03] Received chunk: Seq=${payload.seq}, Pos=${payload.position}`);
        if (this._isDebug()) {
            this.log(`[Code03] msgpart type: ${typeof payload.msgpart}, isBuffer: ${Buffer.isBuffer(payload.msgpart)}`);
            if (payload.msgpart) {
                this.log(`[Code03] msgpart length: ${payload.msgpart.length}, hex: ${payload.msgpart.toString('hex').substring(0, 100)}...`);
            }
        }

        const entry = this.irStore.get(payload.seq);
        if (!entry) {
            this.log(`No learning entry found for seq ${payload.seq}`);
            return;
        }

        // Some devices include a length prefix in msgpart; strip it for CRC/copy
        let msgData = payload.msgpart;
        let hadLengthPrefix = false;
        if (Buffer.isBuffer(msgData) && msgData.length > 1 && msgData[0] === msgData.length - 1 && msgData[0] <= 0x38) {
            msgData = msgData.slice(1);
            hadLengthPrefix = true;
        }

        // Calculate CRC for debugging - but don't fail on mismatch for now
        const calculatedCrc = this.calcCrc(msgData);
        this.log(`[Code03] CRC: calculated=${calculatedCrc}, received=${payload.msgpartcrc}, lengthPrefix=${hadLengthPrefix}`);

        // Note: Some implementations have different CRC algorithms or the msgpart might include extra bytes
        // For now, we'll continue even if CRC doesn't match, as the data might still be valid

        const cluster = this._getCluster();
        if (!cluster) {
            this.error('Cluster not available');
            return;
        }

        try {
            // Copy received data to buffer (use stripped msgData if length prefix present)
            if (entry.position + msgData.length <= entry.buf.length) {
                msgData.copy(entry.buf, entry.position);
                entry.position += msgData.length;
            } else {
                // Truncate if we'd overflow
                const copyLen = entry.buf.length - entry.position;
                msgData.copy(entry.buf, entry.position, 0, copyLen);
                entry.position += copyLen;
            }

            this.log(`[Code03] Progress: ${entry.position}/${entry.length} bytes`);

            if (entry.position < entry.length) {
                // Request next part
                this.log(`[Code03] Requesting next chunk at position ${entry.position}...`);
                await cluster.zosungSendIRCode02({
                    seq: payload.seq,
                    position: entry.position,
                    maxlen: 0x38,
                });
            } else {
                // All parts received, send completion
                this.log(`[Code03] All data received, sending Code04 completion...`);
                await cluster.zosungSendIRCode04({
                    zero0: 0,
                    seq: payload.seq,
                    zero1: 0,
                });
            }
        } catch (err) {
            this.error('Error in _onCode03:', err.message);
        }
    }

    async _onCode04(payload) {
        // Device confirms all parts received (sending complete)
        this.log('═══════════════════════════════════════════════════════════');
        this.log(`[Code04] *** DEVICE CONFIRMS ALL DATA RECEIVED ***`);
        this.log(`[Code04] Payload:`, JSON.stringify(payload));
        this.log(`[Code04] Seq=${payload.seq}`);

        const cluster = this._getCluster();
        if (!cluster) {
            this.error('[Code04] ERROR: Cluster not available');
            return;
        }

        try {
            if (payload.zero0 !== 0) {
                this.error(`[Code04] Device reported error: zero0=${payload.zero0}`);
                return;
            }

            this.log('[Code04] Sending Code05 to finalize...');
            if (typeof cluster.zosungSendIRCode05 === 'function') {
                await cluster.zosungSendIRCode05({
                    seq: payload.seq,
                    zero: 0,
                });
                this.log('[Code04] Code05 sent via zosungSendIRCode05');
            } else {
                await cluster.command(0x05, {
                    seq: payload.seq,
                    zero: 0,
                });
                this.log('[Code04] Code05 sent via command(0x05)');
            }

            this.irStore.delete(payload.seq);
            this.log('[Code04] *** IR TRANSMISSION COMPLETE! ***');
            this.log('═══════════════════════════════════════════════════════════');
        } catch (err) {
            this.error('[Code04] Error sending Code05:', err.message);
            this.error('[Code04] Stack:', err.stack);
        }
    }

    async _onCode05(payload) {
        // Learning complete
        this.log(`[Code05] Learning complete for seq ${payload.seq}`);

        if (this._lastLearnSeqHandled === payload.seq) {
            this.log('[Code05] Duplicate learn complete ignored');
            return;
        }
        this._lastLearnSeqHandled = payload.seq;

        const entry = this.irStore.get(payload.seq);
        if (!entry) {
            this.log(`[Code05] No entry found for seq ${payload.seq}`);
            return;
        }

        if (entry.skipSave) {
            this.log('[Code05] Learned code discarded due to short length');
            this.irStore.delete(payload.seq);
            return;
        }

        // Convert raw buffer to base64
        const learnedCode = entry.buf.toString('base64');
        this.log('[Code05] IR code learned successfully!');
        this.log('[Code05] Code length:', learnedCode.length, 'chars');
        this.log('[Code05] Code preview:', learnedCode.substring(0, 100) + '...');

        // Store the learned code in memory
        this._lastLearnedCode = learnedCode;

        // Save to device settings so user can copy it
        try {
            await this.setSettings({ last_learned_code: learnedCode });
            this.log('[Code05] Learned code saved to settings');
        } catch (err) {
            this.error('[Code05] Failed to save code to settings:', err.message);
        }

        // Trigger the flow card
        this.log('[Code05] Triggering flow card, irLearnedTrigger exists:', !!this.irLearnedTrigger);
        if (this.irLearnedTrigger) {
            try {
                await this.irLearnedTrigger.trigger(this, { code: learnedCode });
                this.log('[Code05] Flow trigger fired successfully');
            } catch (err) {
                this.error('[Code05] Flow trigger error:', err.message);
            }
        } else {
            this.log('[Code05] No trigger card registered, trying homey.flow directly...');
            try {
                const triggerCard = this.homey.flow.getDeviceTriggerCard('ir_code_learned');
                if (triggerCard) {
                    await triggerCard.trigger(this, { code: learnedCode });
                    this.log('[Code05] Flow trigger fired via homey.flow');
                }
            } catch (err) {
                this.error('[Code05] Direct flow trigger error:', err.message);
            }
        }

        // Stop learning mode
        try {
            const controlCluster = this._getControlCluster();
            if (controlCluster && typeof controlCluster.zosungControlIRCommand00 === 'function') {
                await controlCluster.zosungControlIRCommand00({
                    data: Buffer.from(JSON.stringify({ study: 1 })),
                });
                this.log('[Code05] Learning stopped (study:1) via Control cluster');
            }
        } catch (err) {
            this.error('[Code05] Failed to stop learning mode:', err.message);
        }

        this.irStore.delete(payload.seq);
    }

    // BoundCluster handlers - these receive commands FROM the device
    async _onCode03Bound(payload) {
        // Device sends a part of the IR code (learning mode) via bound cluster
        this.log(`[BoundCode03] Received IR data chunk: Seq=${payload.seq}, Pos=${payload.position}`);

        const entry = this.irStore.get(payload.seq);
        if (!entry) {
            this.log(`[BoundCode03] No learning entry found for seq ${payload.seq}`);
            return;
        }

        // Log CRC for debugging (strip length prefix if present)
        let msgData = payload.msgpart;
        let hadLengthPrefix = false;
        if (Buffer.isBuffer(msgData) && msgData.length > 1 && msgData[0] === msgData.length - 1 && msgData[0] <= 0x38) {
            msgData = msgData.slice(1);
            hadLengthPrefix = true;
        }
        const calculatedCrc = this.calcCrc(msgData);
        this.log(`[BoundCode03] CRC: calculated=${calculatedCrc}, received=${payload.msgpartcrc}, lengthPrefix=${hadLengthPrefix}`);

        const cluster = this._getCluster();
        if (!cluster) {
            this.error('[BoundCode03] Transmit cluster not available for response');
            return;
        }

        try {
            // Copy received data to buffer (use stripped msgData if length prefix present)
            if (entry.position + msgData.length <= entry.buf.length) {
                msgData.copy(entry.buf, entry.position);
                entry.position += msgData.length;
            } else {
                const copyLen = entry.buf.length - entry.position;
                msgData.copy(entry.buf, entry.position, 0, copyLen);
                entry.position += copyLen;
            }

            this.log(`[BoundCode03] Progress: ${entry.position}/${entry.length} bytes (lengthPrefix=${hadLengthPrefix})`);

            if (entry.position < entry.length) {
                // Request next part
                this.log(`[BoundCode03] Requesting next chunk at position ${entry.position}...`);
                await cluster.zosungSendIRCode02({
                    seq: payload.seq,
                    position: entry.position,
                    maxlen: 0x38,
                });
            } else {
                // All parts received, send completion
                this.log(`[BoundCode03] All data received, sending Code04 completion...`);
                await cluster.zosungSendIRCode04({
                    zero0: 0,
                    seq: payload.seq,
                    zero1: 0,
                });
            }
        } catch (err) {
            this.error('Error in _onCode03Bound:', err.message);
        }
    }

    async _onCode05Bound(payload) {
        // Learning complete - received via bound cluster
        this.log(`[BoundCode05] Learning complete for seq ${payload.seq}`);

        if (this._lastLearnSeqHandled === payload.seq) {
            this.log('[BoundCode05] Duplicate learn complete ignored');
            return;
        }
        this._lastLearnSeqHandled = payload.seq;

        const entry = this.irStore.get(payload.seq);
        if (!entry) {
            this.log(`No entry found for seq ${payload.seq}`);
            return;
        }

        if (entry.skipSave) {
            this.log('Learned code discarded due to short length');
            this.irStore.delete(payload.seq);
            return;
        }

        const learnedCode = entry.buf.toString('base64');
        this.log('IR code learned successfully!');
        this.log('Learned code (first 100 chars):', learnedCode.substring(0, 100));
        this.log('Code length:', learnedCode.length, 'chars');

        // Store the learned code - you might want to save to settings
        this._lastLearnedCode = learnedCode;

        if (this.irLearnedTrigger) {
            this.irLearnedTrigger.trigger(this, { code: learnedCode }).catch(this.error);
        }

        // Stop learning mode
        try {
            const controlCluster = this._getControlCluster();
            if (controlCluster && typeof controlCluster.zosungControlIRCommand00 === 'function') {
                await controlCluster.zosungControlIRCommand00({
                    data: Buffer.from(JSON.stringify({ study: 1 })),
                });
                this.log('[BoundCode05] Learning stopped (study:1) via Control cluster');
            }
        } catch (err) {
            this.error('[BoundCode05] Failed to stop learning mode:', err.message);
        }

        this.irStore.delete(payload.seq);
    }

    _registerFlowCards() {
        try {
            // Get the trigger card for IR learned
            this.irLearnedTrigger = this.homey.flow.getDeviceTriggerCard('ir_code_learned');
            this.log('IR learned trigger card obtained:', !!this.irLearnedTrigger);

            this.log('Flow cards registered');
        } catch (e) {
            this.error('Flow registration failed:', e.message);
        }
    }

    async initiateIRSend(code) {
        this.log('═══════════════════════════════════════════════════════════');
        this.log('[IRSend] *** STARTING IR TRANSMISSION ***');
        this.log('[IRSend] Code length:', code ? code.length : 'NULL');
        if (this._isDebug()) {
            this.log('[IRSend] Code preview:', code ? code.substring(0, 80) + '...' : 'NULL');
        }

        const cluster = this._getCluster();
        const controlCluster = this._getControlCluster();

        this.log('[IRSend] Transmit cluster available:', !!cluster);
        this.log('[IRSend] Control cluster available:', !!controlCluster);

        if (!cluster) {
            this.error('[IRSend] ERROR: Zosung IR cluster not available!');
            throw new Error('Zosung IR cluster not available. Please re-pair the device.');
        }

        // Log available methods on cluster
        // Avoid noisy method dumps in normal logs

        // First, send study:1 to prepare device for IR transmission
        if (controlCluster) {
            try {
                const studyCmd = JSON.stringify({ study: 1 });
                this.log('[IRSend] Sending study:1 to prepare device...');
        // Avoid noisy method dumps in normal logs

                if (typeof controlCluster.zosungControlIRCommand00 === 'function') {
                    await controlCluster.zosungControlIRCommand00({
                        data: Buffer.from(studyCmd, 'utf8'),
                    });
                    this.log('[IRSend] study:1 sent successfully');
                } else {
                    this.log('[IRSend] zosungControlIRCommand00 not available, trying command()...');
                    await controlCluster.command(0x00, {
                        data: Buffer.from(studyCmd, 'utf8'),
                    });
                    this.log('[IRSend] study:1 sent via command()');
                }
            } catch (err) {
                this.error('[IRSend] WARNING: Could not send study command:', err.message);
                this.error('[IRSend] Stack:', err.stack);
            }
        } else {
            this.log('[IRSend] No control cluster - skipping study:1');
        }

        const seq = (this.currentSeq++) % 0x10000;
        const irMsg = JSON.stringify({
            key_num: 1,
            delay: 300,
            key1: { num: 1, freq: 38000, type: 1, key_code: code },
        });

        this.log(`[IRSend] Sequence number: ${seq}`);
        this.log(`[IRSend] IR message length: ${irMsg.length}`);
        if (this._isDebug()) {
            this.log(`[IRSend] IR message: ${irMsg.substring(0, 150)}...`);
        }

        // Store the message for chunked transmission
        this.irStore.set(seq, { data: irMsg, length: irMsg.length });
        this.log(`[IRSend] Stored in irStore. Current entries:`, Array.from(this.irStore.keys()));

        try {
            const code00Payload = {
                seq,
                length: irMsg.length,
                unk1: 0,
                unk2: 0xe004,
                unk3: 0x01,
                cmd: 0x02, // 0x02 = send IR
                unk4: 0,
            };
            this.log('[IRSend] Code00 payload:', JSON.stringify(code00Payload));

            if (typeof cluster.zosungSendIRCode00 === 'function') {
                this.log('[IRSend] Calling zosungSendIRCode00...');
                await cluster.zosungSendIRCode00(code00Payload);
                this.log('[IRSend] Code00 sent successfully via zosungSendIRCode00');
            } else {
                this.log('[IRSend] zosungSendIRCode00 not available, trying command(0x00)...');
                await cluster.command(0x00, code00Payload);
                this.log('[IRSend] Code00 sent successfully via command(0x00)');
            }

            this.log('[IRSend] *** Now waiting for device to send Code02 requests ***');
            this.log('═══════════════════════════════════════════════════════════');
        } catch (err) {
            this.error('[IRSend] FAILED to initiate IR send:', err.message);
            this.error('[IRSend] Stack:', err.stack);
            this.irStore.delete(seq);
            throw err;
        }
    }

    calcCrc(buffer) {
        if (!Buffer.isBuffer(buffer)) {
            buffer = Buffer.from(buffer);
        }
        return Array.from(buffer).reduce((a, b) => a + b, 0) % 0x100;
    }

    // CRC calculation for STRING data (used when sending IR codes)
    // This matches zigbee2mqtt's calcStringCrc implementation exactly
    calcStringCrc(str) {
        return str
            .split('')
            .map(x => x.charCodeAt(0))
            .reduce((a, b) => a + b, 0) % 0x100;
    }

    onDeleted() {
        this.log('ZS06 IR Remote device removed');
    }
}

module.exports = ZS06IRRemote;
