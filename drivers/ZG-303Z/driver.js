'use strict';

const { ZigBeeDriver } = require('homey-zigbeedriver');

class ZG303ZDriver extends ZigBeeDriver {

    async onInit() {
        this.log('ZG-303Z Soil Sensor Driver has been initialized');
    }

}

module.exports = ZG303ZDriver;
