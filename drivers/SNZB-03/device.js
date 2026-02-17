'use strict';

const SonoffBase = require('../../lib/sonoffbase');

class SonoffSNZB03 extends SonoffBase {
    async onNodeInit({ zclNode }) {
        await super.onNodeInit({ zclNode });

        const endpoint = zclNode.endpoints[1];
        if (endpoint?.clusters?.iasZone) {
            endpoint.clusters.iasZone.onZoneStatusChangeNotification = data => {
                const isMotion = data.zoneStatus.alarm1;
                this.log(`Motion: ${isMotion ? 'Detected' : 'Clear'}`);
                this.setCapabilityValue('alarm_motion', isMotion).catch(this.error);
            };
        }
    }
}

module.exports = SonoffSNZB03;
