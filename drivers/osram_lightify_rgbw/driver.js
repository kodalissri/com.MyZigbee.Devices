'use strict';

const { Driver } = require('homey');

class OsramLightifyRGBWDriver extends Driver {

    async onInit() {
        this.log('OSRAM Lightify RGBW Driver initialized');
    }

}

module.exports = OsramLightifyRGBWDriver;
