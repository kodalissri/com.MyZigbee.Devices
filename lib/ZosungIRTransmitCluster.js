'use strict';

/**
 * ZosungIRTransmitCluster
 *
 * This class defines the Zosung IR Transmit Zigbee cluster for IR blaster devices.
 * It handles the multi-part protocol for sending and receiving IR codes through
 * a series of command exchanges between the device and the hub.
 *
 * Protocol Flow (Sending IR Code):
 * 1. Hub sends Code00 with IR message length
 * 2. Device requests Code01 acknowledgment
 * 3. Device requests Code02 for message parts
 * 4. Hub responds with Code03 containing message chunks
 * 5. Device sends Code04 when complete
 * 6. Hub sends Code05 to finalize
 *
 * Protocol Flow (Learning IR Code):
 * 1. Hub sends learn command via IR Control cluster
 * 2. User points remote at device and presses button
 * 3. Device sends learned code through Code00-05 sequence
 * 4. Hub receives complete IR code in base64 format
 *
 * Based on zigbee2mqtt zosung.ts implementation
 */

const { Cluster, BoundCluster, ZCLDataTypes } = require('zigbee-clusters');

// Use standard ZCL buffer (length-prefixed). This matches zigbee2mqtt behavior.

// Cluster ID for Zosung IR Transmit
const CLUSTER_ID = 0xED00;  // 60672 decimal

const ATTRIBUTES = {};

const COMMANDS = {
    /**
     * Code00: Initial handshake to start IR transmission
     * Sent by device to initiate transfer or by hub to send IR code
     */
    zosungSendIRCode00: {
        id: 0x00,
        disableDefaultResponse: true,
        args: {
            seq: ZCLDataTypes.uint16,      // Sequence number
            length: ZCLDataTypes.uint32,   // Total length of IR message
            unk1: ZCLDataTypes.uint32,     // Unknown field 1 (0x00000000)
            unk2: ZCLDataTypes.uint16,     // Unknown field 2 (0xe004)
            unk3: ZCLDataTypes.uint8,      // Unknown field 3 (0x01)
            cmd: ZCLDataTypes.uint8,       // Command type (0x02 for send, 0x04 for learn response)
            unk4: ZCLDataTypes.uint16      // Unknown field 4 (0x0000)
        }
    },

    /**
     * Code01: Acknowledgment of Code00
     * Hub confirms receipt of device's Code00
     */
    zosungSendIRCode01: {
        id: 0x01,
        disableDefaultResponse: true,
        args: {
            zero: ZCLDataTypes.uint8,      // Always 0
            seq: ZCLDataTypes.uint16,      // Sequence number
            length: ZCLDataTypes.uint32,   // Message length
            unk1: ZCLDataTypes.uint32,     // Echo from Code00
            unk2: ZCLDataTypes.uint16,     // Echo from Code00
            unk3: ZCLDataTypes.uint8,      // Echo from Code00
            cmd: ZCLDataTypes.uint8,       // Echo from Code00
            unk4: ZCLDataTypes.uint16      // Echo from Code00
        }
    },

    /**
     * Code02: Request for message part
     * Hub requests a chunk of the IR message from device
     */
    zosungSendIRCode02: {
        id: 0x02,
        disableDefaultResponse: true,
        args: {
            seq: ZCLDataTypes.uint16,      // Sequence number
            position: ZCLDataTypes.uint32, // Position in message buffer
            maxlen: ZCLDataTypes.uint8     // Maximum chunk length (0x38 = 56 bytes)
        }
    },

    /**
     * Code03: Message part delivery
     * Hub sends a chunk of the IR message OR device sends chunk to hub (learning mode)
     *
     * NOTE: Using ZCLDataTypes.buffer8 (1-byte length prefix).
     */
    zosungSendIRCode03: {
        id: 0x03,
        disableDefaultResponse: true,
        args: {
            zero: ZCLDataTypes.uint8,      // Always 0
            seq: ZCLDataTypes.uint16,      // Sequence number
            position: ZCLDataTypes.uint32, // Position in message buffer
            msgpart: ZCLDataTypes.buffer8,  // Message chunk (1-byte length prefix)
            msgpartcrc: ZCLDataTypes.uint8 // CRC checksum of msgpart
        }
    },

    /**
     * Code04: Transfer complete
     * Hub signals all chunks received
     */
    zosungSendIRCode04: {
        id: 0x04,
        disableDefaultResponse: true,
        args: {
            zero0: ZCLDataTypes.uint8,     // Always 0
            seq: ZCLDataTypes.uint16,      // Sequence number
            zero1: ZCLDataTypes.uint16     // Always 0
        }
    },

    /**
     * Code05: Final confirmation
     * Hub acknowledges completion
     */
    zosungSendIRCode05: {
        id: 0x05,
        disableDefaultResponse: true,
        args: {
            seq: ZCLDataTypes.uint16,      // Sequence number
            zero: ZCLDataTypes.uint8       // Always 0
        }
    }
};

class ZosungIRTransmitCluster extends Cluster {

    static get ID() {
        return CLUSTER_ID;
    }

    static get NAME() {
        return 'zosungIRTransmit';
    }

    static get ATTRIBUTES() {
        return ATTRIBUTES;
    }

    static get COMMANDS() {
        return COMMANDS;
    }

    /**
     * Handler for Code00 command (incoming from device)
     */
    onZosungSendIRCode00(payload) {
        this.emit('commandZosungSendIRCode00', payload);
    }

    /**
     * Handler for Code01 command (incoming from device)
     */
    onZosungSendIRCode01(payload) {
        this.emit('commandZosungSendIRCode01', payload);
    }

    /**
     * Handler for Code02 command (incoming from device)
     */
    onZosungSendIRCode02(payload) {
        this.emit('commandZosungSendIRCode02', payload);
    }

    /**
     * Handler for Code03 command (incoming from device - IR data chunk)
     */
    onZosungSendIRCode03(payload) {
        this.emit('commandZosungSendIRCode03', payload);
    }

    /**
     * Handler for Code04 command (incoming from device)
     */
    onZosungSendIRCode04(payload) {
        this.emit('commandZosungSendIRCode04', payload);
    }

    /**
     * Handler for Code05 command (incoming from device)
     */
    onZosungSendIRCode05(payload) {
        this.emit('commandZosungSendIRCode05', payload);
    }
}

/**
 * BoundCluster for receiving commands FROM the device
 * This is needed for learning mode where the device sends IR codes to the hub
 */
class ZosungIRTransmitBoundCluster extends BoundCluster {

    constructor({ onZosungSendIRCode00, onZosungSendIRCode01, onZosungSendIRCode02,
                  onZosungSendIRCode03, onZosungSendIRCode04, onZosungSendIRCode05,
                  endpoint }) {
        super();
        this._onZosungSendIRCode00 = onZosungSendIRCode00;
        this._onZosungSendIRCode01 = onZosungSendIRCode01;
        this._onZosungSendIRCode02 = onZosungSendIRCode02;
        this._onZosungSendIRCode03 = onZosungSendIRCode03;
        this._onZosungSendIRCode04 = onZosungSendIRCode04;
        this._onZosungSendIRCode05 = onZosungSendIRCode05;
        this._endpoint = endpoint;
    }

    // Command handlers - these are called when device sends commands to hub
    zosungSendIRCode00(payload) {
        console.log('[BoundCluster] Received zosungSendIRCode00:', JSON.stringify(payload));
        if (typeof this._onZosungSendIRCode00 === 'function') {
            return this._onZosungSendIRCode00(payload);
        }
    }

    zosungSendIRCode01(payload) {
        console.log('[BoundCluster] Received zosungSendIRCode01:', JSON.stringify(payload));
        if (typeof this._onZosungSendIRCode01 === 'function') {
            return this._onZosungSendIRCode01(payload);
        }
    }

    zosungSendIRCode02(payload) {
        console.log('[BoundCluster] Received zosungSendIRCode02:', JSON.stringify(payload));
        if (typeof this._onZosungSendIRCode02 === 'function') {
            return this._onZosungSendIRCode02(payload);
        }
    }

    zosungSendIRCode03(payload) {
        console.log('[BoundCluster] Received zosungSendIRCode03 (IR DATA CHUNK):', JSON.stringify(payload));
        console.log('[BoundCluster] msgpart buffer:', payload.msgpart ? payload.msgpart.toString('hex') : 'undefined');
        if (typeof this._onZosungSendIRCode03 === 'function') {
            return this._onZosungSendIRCode03(payload);
        }
    }

    zosungSendIRCode04(payload) {
        console.log('[BoundCluster] Received zosungSendIRCode04:', JSON.stringify(payload));
        if (typeof this._onZosungSendIRCode04 === 'function') {
            return this._onZosungSendIRCode04(payload);
        }
    }

    zosungSendIRCode05(payload) {
        console.log('[BoundCluster] Received zosungSendIRCode05:', JSON.stringify(payload));
        if (typeof this._onZosungSendIRCode05 === 'function') {
            return this._onZosungSendIRCode05(payload);
        }
    }
}

// Register the cluster
Cluster.addCluster(ZosungIRTransmitCluster);

module.exports = ZosungIRTransmitCluster;
module.exports.ZosungIRTransmitBoundCluster = ZosungIRTransmitBoundCluster;
