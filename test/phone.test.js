"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { execFileSync } = require("node:child_process");
const BasixWebPhone = require("../core");
const { createPhone } = require("../react-native");
const browserPlatform = require("../adapters/browser");

class Session extends EventEmitter {
  hold() { this.held = true; }
  unhold() { this.held = false; }
  dtmf(key) { this.key = key; }
  refer(target) { this.target = target; }
  terminate() { this.emit("terminated"); }
}

class UA extends EventEmitter {
  constructor(options) { super(); this.options = options; this.starts = 0; }
  start() { this.starts++; }
  stop() { this.stops = (this.stops || 0) + 1; this.transport?.emit("disconnected"); }
  connect() {
    this.transport = new EventEmitter();
    this.emit("transportCreated", this.transport);
    this.transport.emit("connected");
  }
  invite(uri, options) {
    const session = new Session();
    session.uri = uri;
    session.options = options;
    return session;
  }
}

function fixture(platform = {}) {
  const calls = [];
  const phone = createPhone({
    createUserAgent: options => new UA(options),
    setup() {},
    callOptions: () => ({ nativeMedia: true }),
    attach: (...args) => calls.push(["attach", ...args]),
    clear: audio => calls.push(["clear", audio]),
    destroy() {},
    ...platform,
  });
  phone.logger = { log() {}, error() {}, dir() {}, dump() {} };
  phone.on("error", () => {});
  const cti = new EventEmitter();
  cti.get_store = () => ({ user: { 42: { flags: 0, park_group: 0 } } });
  const wsServers = () => Promise.resolve(["wss://pbx/basix/api/ws_sip"]);
  phone.init({ cti, user_id: 42, user_name: "alice", domain_name: "pbx", max_sessions: 3, wsServers });
  phone.ua.connect();
  return { phone, cti, calls, wsServers };
}

test("native entry loads without DOM, SIP.js, or React Native dependencies", () => {
  execFileSync(process.execPath, ["-e", `
    const Module = require('module');
    const original = Module._load;
    Module._load = function(name, ...args) {
      if (['sip.js', 'react-native', 'react-native-webrtc'].includes(name)) throw Error(name);
      return original.call(this, name, ...args);
    };
    if (typeof window !== 'undefined') throw Error('unexpected DOM');
    require('./react-native');
  `], { cwd: require("node:path").resolve(__dirname, "..") });
});

test("call states, native media, early media, DTMF, and attended transfer retain sessions", async () => {
  const { phone, wsServers, calls } = fixture();
  assert.equal(phone.ua.options.transportOptions.wsServers, wsServers);
  assert.equal(phone.ua.options.register, false);
  assert.equal(phone.ua.options.dtmfType, "rtp");
  const states = [];
  phone.on("session_update", session => states.push(session.data.state));
  const first = await phone.makeCall("100");
  assert.equal(first.uri, "sip:100@anything");
  assert.deepEqual(first.options, { nativeMedia: true });
  first.createDialog = () => {};
  first.sessionDescriptionHandler = { setDescription: async sdp => assert.equal(sdp, "sdp") };
  first.emit("progress", { statusCode: 180 });
  first.emit("progress", { statusCode: 183, body: "sdp" });
  await Promise.resolve();
  assert.equal(first.hasAnswer, true);
  first.emit("accepted");
  phone.sendDTMF("5");
  assert.equal(first.key, "5");
  first.emit("trackAdded");
  assert.equal(calls[0][0], "attach");
  const second = await phone.makeCall("101");
  second.emit("accepted");
  assert.equal(first.held, true);
  phone.transfer(0, second);
  assert.equal(first.target, second);
  phone.transfer(0, "7");
  assert.equal(first.target, "7@basix");
  phone.hangup(0);
  assert.equal(phone.getSessions()[0], null);
  assert.deepEqual(states.slice(0, 4), ["calling", "alerting", "progress", "talking"]);
  phone.destroy();
});

test("CTI pickup, parking snapshots and teardown preserve browser contracts", async () => {
  const { phone, cti } = fixture();
  const offer = { uuid: "offer", other_uuid: "caller", user_id: 42, called_number: "RINGING_PARK.1",
    calling_number: "123", direction: "outbound", state: { name: "ringing" } };
  cti.emit("info_event", { element_name: "channel", info: offer, event_name: "updated" });
  assert.equal(phone.getSessions()[0].data.state, "ringing");
  const session = await phone.answerCtiCall(0);
  assert.equal(session.uri, "sip:pickup_uuid.caller@anything");
  cti.emit("initial_info", { element_name: "channel_waiting", data: {
    parked: { uuid: "parked", state: { name: "park", ts: 123, data: { slot: 901, parker_id: 42 } } },
  } });
  assert.equal(phone.parking_state[1].uuid, "parked");
  assert.equal(phone.parking_state, phone.parkingState);
  phone.destroy();
  assert.equal(cti.listenerCount("info_event"), 0);
  assert.equal(cti.listenerCount("initial_info"), 0);
  session.emit("accepted");
  assert.deepEqual(phone.getSessions(), []);
  phone.destroy();
});

test("stop/restart is idempotent and stale transports cannot reconnect after logout", () => {
  const { phone } = fixture();
  const ua = phone.ua;
  let stopped = 0;
  phone.on("stopped", () => stopped++);
  phone.stop();
  phone.stop();
  assert.equal(stopped, 1);
  assert.equal(ua.stops, 1);
  phone.start();
  phone.start();
  assert.equal(ua.starts, 2);
  phone.destroy();
  ua.transport.emit("connected");
  assert.equal(phone.isConnected, false);
});

test("media plug cleanup notifies the supervisor UI", () => {
  const { phone } = fixture();
  let ended = 0;
  phone.on("media_plug_terminated", () => ended++);
  phone.eavesdrop("channel", "listen");
  phone.disconnect_media_plug();
  assert.equal(ended, 1);
  assert.equal(phone.get_media_plug_uuid(), null);
  assert.equal(phone.pendingMediaPlugCmd, null);
  phone.destroy();
});

test("browser singleton remains compatible and browser audio/lifecycle stay isolated", () => {
  const previous = { window: global.window, document: global.document, MediaStream: global.MediaStream };
  const lifecycle = new EventEmitter();
  const elements = [];
  global.window = {
    addEventListener: (name, listener) => lifecycle.on(name, listener),
    removeEventListener: (name, listener) => lifecycle.removeListener(name, listener),
  };
  global.document = { body: { appendChild() {} }, createElement() {
    const audio = { pause() { this.paused = true; }, play: () => Promise.resolve(), remove() { this.removed = true; } };
    elements.push(audio);
    return audio;
  } };
  global.MediaStream = class {
    constructor() { this.tracks = []; }
    getTracks() { return this.tracks; }
    addTrack(track) { this.tracks.push(track); }
  };
  try {
    const singleton = require("../index");
    assert.equal(singleton, require("../index"));
    assert.equal(typeof singleton.init, "function");
    const platform = browserPlatform();
    const { phone } = fixture({ ...platform, createUserAgent: options => new UA(options) });
    phone.init({});
    assert.equal(elements.length, 4);
    assert.equal(lifecycle.listenerCount("pagehide"), 1);
    const audio = phone.audioTags[0];
    const track = { id: "remote" };
    platform.attach(audio, { sessionDescriptionHandler: { peerConnection: { getReceivers: () => [{ track }] } } }, phone.logger);
    assert.deepEqual(audio.srcObject.getTracks(), [track]);
    assert.equal(platform.callOptions(phone, 0).media.render.remote, audio);
    lifecycle.emit("pagehide");
    assert.equal(phone.isConnected, false);
    phone.destroy();
    assert.equal(lifecycle.listenerCount("pagehide"), 0);
    assert.ok(elements.every(element => element.removed));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key]; else global[key] = value;
    }
  }
});

test("browser teardown preserves caller-owned audio elements", () => {
  const platform = browserPlatform();
  const audio = { pause() {}, remove() { throw Error("caller-owned element removed"); } };
  const phone = { args: { audioTags: [audio], autoCreateAudioTags: true }, audioTags: [] };
  platform.setup(phone);
  platform.destroy(phone);
});

test("failed initialization detaches CTI handlers and permits retry", () => {
  const phone = new BasixWebPhone({ setup() {}, destroy() {}, createUserAgent() { throw Error("startup failed"); } });
  phone.logger = { log() {} };
  const cti = new EventEmitter();
  assert.throws(() => phone.init({ cti }), /startup failed/);
  assert.equal(cti.listenerCount("info_event"), 0);
  assert.equal(phone._initialized, false);
});
