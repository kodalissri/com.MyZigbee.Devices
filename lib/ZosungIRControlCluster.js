'use strict';

/**
 * ZosungIRControlCluster
 *
 * This class defines the Zosung IR Control Zigbee cluster for IR blaster devices.
 * It handles control commands such as starting/stopping IR learning mode.
 *
 * Usage:
 * - Send {study: 0} to start learning an IR code
 * - Send {study: 1} to stop learning mode
 *
 * Based on zigbee2mqtt zosung.ts implementation
 */

const { Cluster, ZCLDataTypes } = require('zigbee-clusters');

// Cluster ID for Zosung IR Control
const CLUSTER_ID = 0xE004;  // 57348 decimal

const ATTRIBUTES = {};

const COMMANDS = {
    /**
     * Command00: Control IR device state
     * Used to start/stop IR learning mode
     *
     * data should be a JSON string buffer:
     * - {study: 0} = Start learning mode
     * - {study: 1} = Stop learning mode
     */
    zosungControlIRCommand00: {
        id: 0x00,
        args: {
            data: ZCLDataTypes.buffer  // JSON string as buffer
        }
    }
};

class ZosungIRControlCluster extends Cluster {

    static get ID() {
        return CLUSTER_ID;
    }

    static get NAME() {
        return 'zosungIRControl';
    }

    static get ATTRIBUTES() {
        return ATTRIBUTES;
    }

    static get COMMANDS() {
        return COMMANDS;
    }

    /**
     * Handler for Control Command 00
     * Processes IR control commands
     */
    onZosungControlIRCommand00(payload) {
        this.emit('commandZosungControlIRCommand00', payload);
    }
}

// Register the cluster
Cluster.addCluster(ZosungIRControlCluster);

module.exports = ZosungIRControlCluster;
