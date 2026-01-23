'use strict';

const { Driver } = require('homey');

/**
 * Zosung IR Blaster Driver
 *
 * Manages Zosung IR Blaster devices and registers flow cards for
 * learning and blasting IR codes.
 */
class ZosungIRBlasterDriver extends Driver {

    async onInit() {
        this.log('Zosung IR Blaster Driver initialized');

        // Register trigger: IR code learned
        this.irCodeLearnedTrigger = this.homey.flow.getDeviceTriggerCard('ir_code_learned');

        // Register action: Learn IR code
        this.homey.flow.getActionCard('learn_ir_code')
            .registerRunListener(async (args) => {
                this.log(`Learning IR code for slot ${args.slot_number}`);
                await args.device.startLearning(parseInt(args.slot_number));
            })
            .registerArgumentAutocompleteListener('slot_number', async (query, args) => {
                // Get the number of configured IR slots
                const numberOfSlots = args.device.getSetting('number_of_ir_codes') || 10;
                const results = [];

                for (let i = 1; i <= numberOfSlots; i++) {
                    const slotName = args.device.getSetting(`ir_name_${i}`) || `IR Code ${i}`;
                    const slotCode = args.device.getSetting(`ir_code_${i}`);

                    // Filter by query if provided
                    if (!query || slotName.toLowerCase().includes(query.toLowerCase()) || i.toString().includes(query)) {
                        results.push({
                            id: i.toString(),
                            name: `${i}. ${slotName}${slotCode ? ' ✓' : ''}`,
                            description: slotCode ? 'IR code stored' : 'Empty slot'
                        });
                    }
                }

                return results;
            });

        // Register action: Blast IR code
        this.homey.flow.getActionCard('blast_ir_code')
            .registerRunListener(async (args) => {
                this.log(`Blasting IR code from slot ${args.slot_number}`);
                await args.device.blastIRCode(parseInt(args.slot_number));
            })
            .registerArgumentAutocompleteListener('slot_number', async (query, args) => {
                // Get the number of configured IR slots
                const numberOfSlots = args.device.getSetting('number_of_ir_codes') || 10;
                const results = [];

                for (let i = 1; i <= numberOfSlots; i++) {
                    const slotName = args.device.getSetting(`ir_name_${i}`) || `IR Code ${i}`;
                    const slotCode = args.device.getSetting(`ir_code_${i}`);

                    // Only show slots with stored IR codes
                    if (slotCode) {
                        // Filter by query if provided
                        if (!query || slotName.toLowerCase().includes(query.toLowerCase()) || i.toString().includes(query)) {
                            results.push({
                                id: i.toString(),
                                name: `${i}. ${slotName}`,
                                description: 'IR code ready to blast'
                            });
                        }
                    }
                }

                return results;
            });

        this.log('Flow cards registered');
    }

}

module.exports = ZosungIRBlasterDriver;
