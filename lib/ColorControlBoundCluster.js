'use strict';

const { BoundCluster } = require('zigbee-clusters');

class ColorControlBoundCluster extends BoundCluster {

  constructor({
    onStepColorTemp, onMoveToHue, onStop
  }) {
    super();
    this._onStepColorTemp = onStepColorTemp;
    this._onMoveToHue = onMoveToHue;
    this._onStop = onStop;
  }

  stepColorTemp(payload) {
    if (typeof this._onStepColorTemp === 'function') {
      this._onStepColorTemp(payload);
    }
  }

  moveToHue(payload) {
    if (typeof this._onMoveToHue === 'function') {
      this._onMoveToHue(payload);
    }
  }

  stop() {
    if (typeof this._onStop === 'function') {
      this._onStop();
    }
  }

}

module.exports = ColorControlBoundCluster;
