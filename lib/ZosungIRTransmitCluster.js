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

const { Cluster, ZCLDataTypes } = require('zigbee-clusters');

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
        args: {
            seq: ZCLDataTypes.uint16,      // Sequence number
            length: ZCLDataTypes.uint32,   // Total length of IR message
            unk1: ZCLDataTypes.uint32,     // Unknown field 1 (0x00000000)
            unk2: ZCLDataTypes.uint16,     // Unknown field 2 (0xe004)
            unk3: ZCLDataTypes.uint8,      // Unknown field 3 (0x01)
            cmd: ZCLDataTypes.uint8,       // Command type (0x02 for send)
            unk4: ZCLDataTypes.uint16      // Unknown field 4 (0x0000)
        }
    },

    /**
     * Code01: Acknowledgment of Code00
     * Device confirms receipt of initial message
     */
    zosungSendIRCode01: {
        id: 0x01,
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
     * Device requests a chunk of the IR message
     */
    zosungSendIRCode02: {
        id: 0x02,
        args: {
            seq: ZCLDataTypes.uint16,      // Sequence number
            position: ZCLDataTypes.uint32, // Position in message buffer
            maxlen: ZCLDataTypes.uint8     // Maximum chunk length (0x38 = 56 bytes)
        }
    },

    /**
     * Code03: Message part delivery
     * Hub sends a chunk of the IR message
     */
    zosungSendIRCode03: {
        id: 0x03,
        args: {
            zero: ZCLDataTypes.uint8,      // Always 0
            seq: ZCLDataTypes.uint16,      // Sequence number
            position: ZCLDataTypes.uint32, // Position in message buffer
            msgpart: ZCLDataTypes.buffer,  // Message chunk
            msgpartcrc: ZCLDataTypes.uint8 // CRC checksum of msgpart
        }
    },

    /**
     * Code03 Response: Device acknowledges message part
     * Used when device is sending IR code to hub (learning mode)
     */
    zosungSendIRCode03Resp: {
        id: 0x03,
        response: true,
        args: {
            zero: ZCLDataTypes.uint8,
            seq: ZCLDataTypes.uint16,
            position: ZCLDataTypes.uint32,
            msgpart: ZCLDataTypes.buffer,
            msgpartcrc: ZCLDataTypes.uint8
        }
    },

    /**
     * Code04: Transfer complete
     * Device signals all chunks received
     */
    zosungSendIRCode04: {
        id: 0x04,
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
        args: {
            seq: ZCLDataTypes.uint16,      // Sequence number
            zero: ZCLDataTypes.uint8       // Always 0
        }
    },

    /**
     * Code05 Response: Device confirms IR code received
     * Used when device is sending IR code to hub (learning mode)
     */
    zosungSendIRCode05Resp: {
        id: 0x05,
        response: true,
        args: {
            seq: ZCLDataTypes.uint16,
            zero: ZCLDataTypes.uint8
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
     * Handler for Code00 command
     * Initiates IR code transfer
     */
    onZosungSendIRCode00(payload) {
        this.emit('commandZosungSendIRCode00', payload);
    }

    /**
     * Handler for Code01 command
     * Acknowledges initial handshake
     */
    onZosungSendIRCode01(payload) {
        this.emit('commandZosungSendIRCode01', payload);
    }

    /**
     * Handler for Code02 command
     * Requests message chunk
     */
    onZosungSendIRCode02(payload) {
        this.emit('commandZosungSendIRCode02', payload);
    }

    /**
     * Handler for Code03 response
     * Receives message chunk from device (learning mode)
     */
    onZosungSendIRCode03Resp(payload) {
        this.emit('commandZosungSendIRCode03Resp', payload);
    }

    /**
     * Handler for Code04 command
     * Confirms transfer complete
     */
    onZosungSendIRCode04(payload) {
        this.emit('commandZosungSendIRCode04', payload);
    }

    /**
     * Handler for Code05 response
     * Receives final confirmation from device (learning mode)
     */
    onZosungSendIRCode05Resp(payload) {
        this.emit('commandZosungSendIRCode05Resp', payload);
    }
}

// Register the cluster
Cluster.addCluster(ZosungIRTransmitCluster);

module.exports = ZosungIRTransmitCluster;
