'use strict';

// Check this path! If your lib folder is in the app root:
const SonoffBase = require('../../lib/sonoffbase');

class SonoffSNZB04 extends SonoffBase {
    async onNodeInit({ zclNode }) {
        // Essential: call the base class init
        await super.onNodeInit({ zclNode });

        if (zclNode.endpoints[1].clusters.iasZone) {
            zclNode.endpoints[1].clusters.iasZone.onZoneStatusChangeNotification = data => {
                const isAlarm = data.zoneStatus.alarm1;
                this.log(`Contact Status: ${isAlarm ? 'Open' : 'Closed'}`);
                this.setCapabilityValue('alarm_contact', isAlarm).catch(this.error);
            };
        }
    }
}

module.exports = SonoffSNZB04;