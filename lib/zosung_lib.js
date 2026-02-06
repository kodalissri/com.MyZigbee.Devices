/**
 * Zosung IR Protocol Library for Homey Pro
 * Handles CRC calculation and packet formatting for multi-part IR transfers.
 */

"use strict";

const ZOSUNG_CLUSTERS = {
    TRANSMIT: 'zosungIRTransmit', // 0xED00 / 60672
    CONTROL: 'zosungIRControl'    // 0xED01 / 60673
};

/**
 * Calculate CRC for a Buffer
 * Sum of all bytes % 256
 */
function calcArrayCrc(values) {
    if (!Buffer.isBuffer(values)) values = Buffer.from(values);
    return Array.from(values).reduce((a, b) => a + b, 0) % 0x100;
}

/**
 * Calculate CRC for a String
 * Sum of character codes % 256
 */
function calcStringCrc(str) {
    return (
        str
            .split("")
            .map((x) => x.charCodeAt(0))
            .reduce((a, b) => a + b, 0) % 0x100
    );
}

/**
 * Formats the IR code into the JSON structure expected by Zosung devices
 */
function formatIRPayload(base64Code) {
    return JSON.stringify({
        key_num: 1,
        delay: 300,
        key1: {
            num: 1,
            freq: 38000,
            type: 1,
            key_code: base64Code,
        },
    });
}

module.exports = {
    ZOSUNG_CLUSTERS,
    calcArrayCrc,
    calcStringCrc,
    formatIRPayload,
};