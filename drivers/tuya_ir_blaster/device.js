'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { Cluster } = require('zigbee-clusters');
const ZosungIRTransmitCluster = require('../../lib/ZosungIRTransmitCluster');
const ZosungIRControlCluster = require('../../lib/ZosungIRControlCluster');

Cluster.addCluster(ZosungIRTransmitCluster);
Cluster.addCluster(ZosungIRControlCluster);

/**
 * Zosung IR Blaster Device
 *
 * Implements the Zosung IR protocol for learning and blasting IR codes.
 * Handles multi-part message transfer protocol for IR code transmission.
 */
class ZosungIRBlasterDevice extends ZigBeeDevice {

    async onNodeInit({ zclNode }) {
        this.printNode();

        // Initialize sequence counter (starts at -1 so first nextSeq() returns 0)
        this._seq = -1;

        // IR message info for multi-part transfer
        this._irMessageInfo = null;

        // Initialize IR code storage (10 slots)
        this._irCodeSlots = this.getStoreValue('irCodeSlots') || {};

        // Current learning slot
        this._currentLearningSlot = null;

        // Register cluster event listeners
        const transmitCluster = zclNode.endpoints[1].clusters.zosungIRTransmit;
        const controlCluster = zclNode.endpoints[1].clusters.zosungIRControl;

        if (transmitCluster) {
            // Listen for IR code transmission events
            transmitCluster.on('commandZosungSendIRCode00', this._handleIRCode00.bind(this));
            transmitCluster.on('commandZosungSendIRCode01', this._handleIRCode01.bind(this));
            transmitCluster.on('commandZosungSendIRCode02', this._handleIRCode02.bind(this));
            transmitCluster.on('commandZosungSendIRCode03Resp', this._handleIRCode03Resp.bind(this));
            transmitCluster.on('commandZosungSendIRCode04', this._handleIRCode04.bind(this));
            transmitCluster.on('commandZosungSendIRCode05Resp', this._handleIRCode05Resp.bind(this));
        }

        // Register capability listeners
        if (this.hasCapability('ir_learn_slot')) {
            this.registerCapabilityListener('ir_learn_slot', this.onSlotChanged.bind(this));
            // Set default slot to 1
            await this.setCapabilityValue('ir_learn_slot', '1').catch(this.error);
        }

        if (this.hasCapability('ir_learn_button')) {
            this.registerCapabilityListener('ir_learn_button', this.onLearnButtonPressed.bind(this));
        }

        if (this.hasCapability('ir_test_button')) {
            this.registerCapabilityListener('ir_test_button', this.onTestButtonPressed.bind(this));
        }

        this.log('Zosung IR Blaster initialized');
    }

    /**
     * Get next sequence number
     */
    _nextSeq() {
        this._seq = (this._seq + 1) % 0x10000;
        return this._seq;
    }

    /**
     * Calculate CRC checksum for a buffer
     */
    _calcBufferCrc(buffer) {
        return Array.from(buffer).reduce((a, b) => a + b, 0) % 0x100;
    }

    /**
     * Calculate CRC checksum for a string
     */
    _calcStringCrc(str) {
        return str.split('').map(x => x.charCodeAt(0)).reduce((a, b) => a + b, 0) % 0x100;
    }

    /**
     * Handle IR Code 00 - Initial handshake for receiving IR code (learning mode)
     */
    async _handleIRCode00(payload) {
        this.log('Received IR Code00:', payload);
        const { seq, length, unk1, unk2, unk3, cmd, unk4 } = payload;

        // Initialize receive buffer
        this._irMessageInfo = {
            seq: seq,
            data: {
                position: 0,
                buf: Buffer.alloc(length)
            }
        };

        // Send acknowledgment (Code01)
        await this.zclNode.endpoints[1].clusters.zosungIRTransmit.zosungSendIRCode01({
            zero: 0,
            seq: seq,
            length: length,
            unk1: unk1,
            unk2: unk2,
            unk3: unk3,
            cmd: cmd,
            unk4: unk4
        });

        this.log('Sent IR Code01 acknowledgment');

        // Request first chunk (Code02)
        await this.zclNode.endpoints[1].clusters.zosungIRTransmit.zosungSendIRCode02({
            seq: seq,
            position: 0,
            maxlen: 0x38  // Request 56 bytes at a time
        });

        this.log('Requested IR Code02 - first chunk');
    }

    /**
     * Handle IR Code 01 - Acknowledgment (when sending IR code)
     */
    async _handleIRCode01(payload) {
        this.log('Received IR Code01:', payload);
        // This is received when we're sending an IR code to blast
        // Device acknowledges our Code00 initiation
    }

    /**
     * Handle IR Code 02 - Request for message part (when sending IR code)
     */
    async _handleIRCode02(payload) {
        this.log('Received IR Code02 request:', payload);
        const { seq, position } = payload;

        // Check if we have a message to send
        if (!this._irMessageInfo || this._irMessageInfo.seq !== seq) {
            this.error(`No IR message for seq ${seq}`);
            return;
        }

        const irMessage = this._irMessageInfo.data;

        // Extract the requested chunk
        const part = irMessage.substring(position, position + 0x32);  // Max 50 chars
        const sum = this._calcStringCrc(part);

        // Send the chunk (Code03)
        await this.zclNode.endpoints[1].clusters.zosungIRTransmit.zosungSendIRCode03({
            zero: 0,
            seq: seq,
            position: position,
            msgpart: Buffer.from(part),
            msgpartcrc: sum
        });

        this.log(`Sent IR Code03 chunk at position ${position}`);
    }

    /**
     * Handle IR Code 03 Response - Receive message part (learning mode)
     */
    async _handleIRCode03Resp(payload) {
        this.log('Received IR Code03 response:', payload);
        const { seq, position, msgpart, msgpartcrc } = payload;

        // Verify we're expecting this message
        if (!this._irMessageInfo || this._irMessageInfo.seq !== seq) {
            this.error(`Unexpected seq ${seq}`);
            return;
        }

        const rcv = this._irMessageInfo.data;

        if (rcv.position !== position) {
            this.error(`Position mismatch: expected ${rcv.position}, got ${position}`);
            return;
        }

        // Verify CRC
        const calculatedCrc = this._calcBufferCrc(msgpart);
        if (calculatedCrc !== msgpartcrc) {
            this.error(`CRC mismatch: expected ${msgpartcrc}, got ${calculatedCrc}`);
            return;
        }

        // Copy the chunk to our buffer
        const bytesWritten = msgpart.copy(rcv.buf, rcv.position);
        rcv.position += bytesWritten;

        this.log(`Received ${bytesWritten} bytes, total: ${rcv.position}/${rcv.buf.length}`);

        // Check if we need more chunks
        if (rcv.position < rcv.buf.length) {
            // Request next chunk
            await this.zclNode.endpoints[1].clusters.zosungIRTransmit.zosungSendIRCode02({
                seq: seq,
                position: rcv.position,
                maxlen: 0x38
            });
            this.log(`Requested next chunk at position ${rcv.position}`);
        } else {
            // All chunks received, send Code04
            await this.zclNode.endpoints[1].clusters.zosungIRTransmit.zosungSendIRCode04({
                zero0: 0,
                seq: seq,
                zero1: 0
            });
            this.log('Sent IR Code04 - transfer complete');
        }
    }

    /**
     * Handle IR Code 04 - Transfer complete confirmation (when sending IR code)
     */
    async _handleIRCode04(payload) {
        this.log('Received IR Code04:', payload);
        const { seq } = payload;

        // Send final confirmation (Code05)
        await this.zclNode.endpoints[1].clusters.zosungIRTransmit.zosungSendIRCode05({
            seq: seq,
            zero: 0
        });

        // Clear message info
        this._irMessageInfo = null;

        this.log('IR code successfully sent to device');
    }

    /**
     * Handle IR Code 05 Response - Final confirmation (learning mode)
     */
    async _handleIRCode05Resp(payload) {
        this.log('Received IR Code05 response:', payload);
        const { seq } = payload;

        // Verify we're expecting this message
        if (!this._irMessageInfo || this._irMessageInfo.seq !== seq) {
            this.error(`Unexpected seq ${seq}`);
            return;
        }

        const rcv = this._irMessageInfo.data;

        // Convert buffer to base64
        const learnedIRCode = rcv.buf.toString('base64');
        this.log('Learned IR code:', learnedIRCode);

        // Save to selected slot
        await this._saveLearnedCode(learnedIRCode);

        // Clear message info
        this._irMessageInfo = null;

        // Stop learning mode
        await this.zclNode.endpoints[1].clusters.zosungIRControl.zosungControlIRCommand00({
            data: Buffer.from(JSON.stringify({ study: 1 }))
        });

        this.log('IR code learning completed');
    }

    /**
     * Start learning an IR code for a specific slot (for flow card compatibility)
     */
    async startLearning(slotNumber) {
        this.log(`Starting IR learning for slot ${slotNumber}`);

        // Store which slot we're learning for
        this._currentLearningSlot = slotNumber.toString();

        // Start learning mode
        await this.zclNode.endpoints[1].clusters.zosungIRControl.zosungControlIRCommand00({
            data: Buffer.from(JSON.stringify({ study: 0 }))
        });

        this.log(`Learning mode activated for slot ${slotNumber}`);
    }

    /**
     * Blast an IR code (accepts either slot number or IR code string)
     */
    async blastIRCode(slotNumberOrCode) {
        let irCode;

        // Check if it's a slot number (string like "1", "2", etc) or base64 IR code
        if (slotNumberOrCode.length <= 2 && !isNaN(slotNumberOrCode)) {
            // It's a slot number - load from memory
            irCode = this._irCodeSlots[slotNumberOrCode];
            if (!irCode) {
                // Try loading from old settings format for backward compatibility
                irCode = this.getSetting(`ir_code_${slotNumberOrCode}`);
            }
            if (!irCode) {
                throw new Error(`No IR code stored in slot ${slotNumberOrCode}`);
            }
            this.log(`Blasting IR code from slot ${slotNumberOrCode}`);
        } else {
            // It's an IR code directly
            irCode = slotNumberOrCode;
            this.log('Blasting IR code directly');
        }

        // Create IR message JSON
        const irMessage = JSON.stringify({
            key_num: 1,
            delay: 300,
            key1: {
                num: 1,
                freq: 38000,
                type: 1,
                key_code: irCode
            }
        });

        const seq = this._nextSeq();

        // Store message for multi-part transfer
        this._irMessageInfo = {
            seq: seq,
            data: irMessage
        };

        // Initiate transfer with Code00
        await this.zclNode.endpoints[1].clusters.zosungIRTransmit.zosungSendIRCode00({
            seq: seq,
            length: irMessage.length,
            unk1: 0x00000000,
            unk2: 0xe004,
            unk3: 0x01,
            cmd: 0x02,
            unk4: 0x0000
        });

        this.log('IR code blast initiated');
    }

    /**
     * Handler for slot selection change
     */
    async onSlotChanged(slotId) {
        this.log(`IR slot changed to: ${slotId}`);
        // Slot is used for both learning and testing
        return Promise.resolve();
    }

    /**
     * Handler for learn button press
     */
    async onLearnButtonPressed() {
        try {
            const slotId = await this.getCapabilityValue('ir_learn_slot');
            this.log(`Learn button pressed for slot ${slotId}`);

            // Store which slot we're learning for
            this._currentLearningSlot = slotId;

            // Start learning mode
            await this.zclNode.endpoints[1].clusters.zosungIRControl.zosungControlIRCommand00({
                data: Buffer.from(JSON.stringify({ study: 0 }))
            });

            this.log(`Learning mode started for slot ${slotId}. Point remote and press button.`);

            // Show notification to user
            await this.homey.notifications.createNotification({
                excerpt: `Learning IR code for slot ${slotId}. Point your remote and press a button within 30 seconds.`
            }).catch(this.error);

            return Promise.resolve(true);
        } catch (error) {
            this.error('Failed to start learning mode:', error);
            throw error;
        }
    }

    /**
     * Handler for test button press
     */
    async onTestButtonPressed() {
        try {
            const slotId = await this.getCapabilityValue('ir_learn_slot');
            this.log(`Test button pressed for slot ${slotId}`);

            // Get IR code from storage
            const irCode = this._irCodeSlots[slotId];

            if (!irCode) {
                this.error(`No IR code stored in slot ${slotId}`);
                await this.homey.notifications.createNotification({
                    excerpt: `Slot ${slotId} is empty. Please learn an IR code first.`
                }).catch(this.error);
                return Promise.resolve(false);
            }

            // Transmit the IR code
            await this.blastIRCode(irCode);

            this.log(`IR code from slot ${slotId} transmitted successfully`);

            return Promise.resolve(true);
        } catch (error) {
            this.error('Failed to transmit IR code:', error);
            throw error;
        }
    }

    /**
     * Save learned IR code to selected slot
     */
    async _saveLearnedCode(irCode) {
        const slotId = this._currentLearningSlot;

        if (!slotId) {
            this.error('No learning slot selected');
            return;
        }

        // Save to memory
        this._irCodeSlots[slotId] = irCode;

        // Persist to storage
        await this.setStoreValue('irCodeSlots', this._irCodeSlots);

        this.log(`IR code saved to slot ${slotId}`);

        // Show success notification
        await this.homey.notifications.createNotification({
            excerpt: `IR code successfully learned and saved to slot ${slotId}!`
        }).catch(this.error);

        // Clear current learning slot
        this._currentLearningSlot = null;
    }
}

module.exports = ZosungIRBlasterDevice;
