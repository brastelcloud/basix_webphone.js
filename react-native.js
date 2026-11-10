"use strict";

const BasixWebPhone = require("./core");

/**
 * The host supplies the SIP.js 0.13-compatible UA, authenticated transport,
 * native session description handler, and audio integration. No browser
 * adapter or SIP.js default browser implementation is loaded by this entry.
 */
function createPhone(platform) {
  for (const method of ["createUserAgent", "setup", "callOptions", "attach", "clear", "destroy"]) {
    if (typeof platform?.[method] !== "function") {
      throw new TypeError(`React Native platform must implement ${method}()`);
    }
  }
  return new BasixWebPhone(platform);
}

module.exports = { createPhone };
