'use strict';

const { Driver } = require('homey');

// Import and ensure clusters are registered before any device is initialized
const ZosungIRTransmitCluster = require('../../lib/ZosungIRTransmitCluster');
const ZosungIRControlCluster = require('../../lib/ZosungIRControlCluster');

class ZS06IRRemoteDriver extends Driver {

    async onInit() {
        this.log('ZS06 IR Remote Driver initialized');
        this.log('Zosung IR Transmit cluster registered with ID:', ZosungIRTransmitCluster.ID);
        this.log('Zosung IR Control cluster registered with ID:', ZosungIRControlCluster.ID);

        // Register flow action cards
        this._registerFlowCards();
    }

    _registerFlowCards() {
        // Send IR from slot action
        const sendSlotAction = this.homey.flow.getActionCard('send_ir_slot');
        sendSlotAction.registerRunListener(async (args, state) => {
            this.log('═══════════════════════════════════════════════════════════');
            this.log('[Flow] send_ir_slot triggered');
            this.log('[Flow] Device:', args.device ? args.device.getName() : 'unknown');
            this.log('[Flow] Slot:', args.slot);

            const device = args.device;
            const slotIndex = args.slot;
            const settings = device.getSettings();

            this.log('[Flow] Settings keys:', Object.keys(settings));
            this.log('[Flow] Looking for key: ir_code_' + slotIndex);

            const code = settings[`ir_code_${slotIndex}`];
            this.log('[Flow] Code found:', !!code);
            this.log('[Flow] Code length:', code ? code.length : 0);

            if (!code || code.length < 5) {
                this.error('[Flow] ERROR: Slot', slotIndex, 'is empty or invalid');
                throw new Error(`Slot ${slotIndex} is empty or invalid.`);
            }

            this.log('[Flow] Code preview:', code.substring(0, 50) + '...');
            this.log('[Flow] Calling device.initiateIRSend()...');

            try {
                const result = await device.initiateIRSend(code);
                this.log('[Flow] initiateIRSend completed successfully');
                return result;
            } catch (err) {
                this.error('[Flow] initiateIRSend failed:', err.message);
                throw err;
            }
        });
        this.log('Registered send_ir_slot action');

        // Send custom IR code action
        const sendCodeAction = this.homey.flow.getActionCard('send_ir_code');
        sendCodeAction.registerRunListener(async (args, state) => {
            this.log('═══════════════════════════════════════════════════════════');
            this.log('[Flow] send_ir_code triggered');
            this.log('[Flow] Device:', args.device ? args.device.getName() : 'unknown');
            this.log('[Flow] Code length:', args.code ? args.code.length : 0);

            const device = args.device;
            if (!args.code || args.code.length < 5) {
                this.error('[Flow] ERROR: Invalid IR code');
                throw new Error('Invalid IR code');
            }

            this.log('[Flow] Code preview:', args.code.substring(0, 50) + '...');
            this.log('[Flow] Calling device.initiateIRSend()...');

            try {
                const result = await device.initiateIRSend(args.code);
                this.log('[Flow] initiateIRSend completed successfully');
                return result;
            } catch (err) {
                this.error('[Flow] initiateIRSend failed:', err.message);
                throw err;
            }
        });
        this.log('Registered send_ir_code action');

        // Compare IR codes condition
        const compareCondition = this.homey.flow.getConditionCard('compare_ir_codes');
        compareCondition.registerRunListener(async (args, state) => {
            const result = this._compareIrCodes(args.code_a, args.code_b);
            this.log('[Flow] compare_ir_codes:', JSON.stringify(result));
            return result.equal;
        });
        this.log('Registered compare_ir_codes condition');

        this.log('Flow action cards registered');
    }

    async onPairListDevices() {
        // ZigBee devices are discovered automatically
        return [];
    }

    _compareIrCodes(codeA, codeB) {
        const a = (codeA || '').toString().replace(/\s+/g, '');
        const b = (codeB || '').toString().replace(/\s+/g, '');

        if (!a || !b) {
            return { equal: false, similarity: 0, lenA: 0, lenB: 0, reason: 'empty_code' };
        }

        const bufA = Buffer.from(a, 'base64');
        const bufB = Buffer.from(b, 'base64');

        const lenA = bufA.length;
        const lenB = bufB.length;

        if (lenA === 0 || lenB === 0) {
            return { equal: false, similarity: 0, lenA, lenB, reason: 'invalid_base64' };
        }

        const minLen = Math.min(lenA, lenB);
        let same = 0;
        for (let i = 0; i < minLen; i++) {
            if (bufA[i] === bufB[i]) same++;
        }

        const similarity = minLen === 0 ? 0 : Math.round((same / minLen) * 1000) / 1000;
        const equal = lenA === lenB && similarity === 1;

        return { equal, similarity, lenA, lenB };
    }

}

module.exports = ZS06IRRemoteDriver;
