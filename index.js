"use strict";

const BasixWebPhone = require("./core");
const browserPlatform = require("./adapters/browser");

function createPhone() {
  return new BasixWebPhone(browserPlatform());
}

// Preserve riot_app's CommonJS singleton and session/event interface.
module.exports = createPhone();
module.exports.createPhone = createPhone;
