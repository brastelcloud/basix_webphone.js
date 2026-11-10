"use strict";

const EventEmitter = require("events");

/**
 * Helper to handle circular references in JSON stringify for SIP.js objects.
 */
function safeStringify(obj) {
  const seen = new WeakSet();
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  }, 2);
}

class BasixWebPhone extends EventEmitter {
  constructor(platform) {
    super();
    this.platform = platform;
    this._ctiListeners = [];
    this._unbindLifecycle = null;
    this._stopping = false;
    this._initialized = false;
    this.ua = null;
    this.sessions = [];
    this.audioTags = [];
    this.parkingState = [];
    this.isConnected = false;
    this.args = null;
    this.mediaPlugSession = null;
    this.mediaPlugUuid = null;
    this.pendingMediaPlugCmd = null;
    this.mediaPlugAudioTag = null;

    // React Native/Hermes does not expose every browser console method.
    const output = typeof console === "undefined" ? {} : console;
    const log = typeof output.log === "function" ? output.log.bind(output) : () => {};
    this.logger = {
      log,
      error: typeof output.error === "function" ? output.error.bind(output) : log,
      dir: typeof output.dir === "function" ? output.dir.bind(output) : log,
      dump: (obj) => this.logger.log(safeStringify(obj))
    };
  }

  /**
   * Initialize the phone with configuration.
   * @param {Object} args Configuration object.
   */
  init(args) {
    if (this._initialized) {
      this.logger.log("BasixWebPhone: Already initialized");
      return;
    }

    this.logger.log("BasixWebPhone: Initializing");
    // Configuration can contain credentials and transport factories; do not log it.

    this.args = {
      max_sessions: 2,
      app_cname: "",
      domain_name: "",
      user_name: "",
      user_id: null,
      cti: null,
      autoCreateAudioTags: true,
      audioTags: [], // Optional: pass existing audio elements
      ...args
    };

    this.sessions = new Array(this.args.max_sessions).fill(null);
    this.parkingState = [];

    this._initialized = true;
    try {
      this._setupAudioTags();
      this._setupCtiListeners();
      this._unbindLifecycle = this.platform.bindLifecycle?.(() => this.stop());
      this._startUA();
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  /**
   * Manages audio element creation/assignment.
   * @private
   */
  _setupAudioTags() {
    this.platform.setup(this);
  }

  /**
   * Sets up listeners for the CTI system.
   * @private
   */
  _setupCtiListeners() {
    const { cti } = this.args;
    if (!cti) return;

    this._listenCti(cti, "open", () => this.logger.log("BasixWebPhone: CTI open"));
    this._listenCti(cti, "closed", () => this.logger.log("BasixWebPhone: CTI closed"));
    this._listenCti(cti, "error", (err) => {
      this.logger.error("BasixWebPhone: CTI error", err);
      this.emit("error", { source: "cti", error: err });
    });

    this._listenCti(cti, "initial_info", ({ element_name, data }) => {
      if (element_name === "channel") {
        const live = new Set(Object.values(data).filter(channel => channel.last_event !== "CHANNEL_HANGUP" && channel.state?.name !== "hangup").map(channel => channel.uuid));
        for (const session of [...this.sessions]) {
          if (session?.data.cti_channel_uuid && !live.has(session.data.cti_channel_uuid)) {
            session.close?.();
            this._releaseSession(session.data.id, session);
          }
        }
      }
      Object.values(data).forEach(info => {
        this.handleInfoEvent(element_name, info, "updated");
      });
    });

    this._listenCti(cti, "info_event", ({ element_name, info, event_name }) => {
      this.handleInfoEvent(element_name, info, event_name);
    });
  }

  _listenCti(cti, event, listener) {
    cti.on(event, listener);
    this._ctiListeners.push([cti, event, listener]);
  }

  // Legacy riot_app property; always references the current state array.
  get parking_state() { return this.parkingState; }

  /**
   * Starts the SIP User Agent.
   * @private
   */
  _startUA() {
    this.logger.log("BasixWebPhone: Starting UA");
    this.isConnected = false;

    this._stopping = false;
    this.ua = this.platform.createUserAgent({
      uri: `${this.args.user_name}@${this.args.domain_name}`,
      transportOptions: {
        wsServers: this.args.wsServers,
        maxReconnectionAttempts: 0,
        connectionTimeout: 10000,
      },
      register: false,
      registerExpires: 100,
      noAnswerTimeout: 180,
      autostart: false,
      dtmfType: "rtp",
      sessionDescriptionHandlerFactoryOptions: {
        constraints: { audio: true, video: false },
        peerConnectionOptions: { iceCheckingTimeout: 500 },
      },
    });

    const ua = this.ua;
    ua.on("transportCreated", (transport) => {
      if (this.ua !== ua) return;
      transport.on("connected", () => {
        if (this.ua !== ua || this._stopping) return;
        this.logger.log("BasixWebPhone: Transport connected");
        this.isConnected = true;
        this.emit("connected");
      });

      transport.on("transportError", () => {
        if (this.ua !== ua) return;
        this.logger.error("BasixWebPhone: Transport error");
        this.isConnected = false;
        this._processWsDisconnection();
      });

      transport.on("disconnected", () => {
        if (this.ua !== ua) return;
        this.logger.log("BasixWebPhone: Transport disconnected");
        this.isConnected = false;
        this._processWsDisconnection();
      });
    });

    ua.on("unregistered", () => {
      if (this.ua !== ua) return;
      this.logger.log("BasixWebPhone: Unregistered");
      this.stop();
    });

    this.ua.start();
  }

  _processWsDisconnection() {
    if (!this.ua || this._stopping) return;
    this._stopping = true;
    this.isConnected = false;
    this.ua.stop();
    this.emit("disconnected");
  }

  /**
   * Starts the UA if not already started.
   */
  start() {
    if (!this._initialized) throw new Error("Initialize the phone before starting it");
    if (!this.ua) {
      this._startUA();
    } else if (this._stopping) {
      this._stopping = false;
      this.ua.start();
    }
  }

  stop() {
    if (!this.ua || this._stopping) return;
    this._stopping = true;
    this.isConnected = false;
    this.ua.stop();
    this.emit("stopped");
  }

  /**
   * Stops and cleans up resources.
   */
  destroy() {
    this.logger.log("BasixWebPhone: Destroying");
    this._unbindLifecycle?.();
    this._unbindLifecycle = null;
    this._ctiListeners.forEach(([cti, event, listener]) => cti.removeListener(event, listener));
    this._ctiListeners = [];
    clearTimeout(this._mediaPlugTimer);
    this.stop();
    this.ua = null;
    this.platform.destroy(this);
    this.sessions = [];
    this.audioTags = [];
    this.mediaPlugAudioTag = null;
    this.parkingState = [];
    this.mediaPlugSession = null;
    this.mediaPlugUuid = null;
    this.pendingMediaPlugCmd = null;
    this.args = null;
    this._initialized = false;
    this.removeAllListeners();
  }

  _clearAudioElement(audio) {
    this.platform.clear(audio);
  }

  _attachRemoteAudio(audio, session, label = "Audio play failed") {
    this.platform.attach(audio, session, this.logger, label);
  }

  /**
   * Places an outbound call.
   * @returns {Promise<SIP.Session>}
   */
  makeCall(destination, options = {}) {
    return new Promise((resolve, reject) => {
      this.logger.log("BasixWebPhone: makeCall", destination);

      if (!this.isConnected) {
        const err = "not_connected";
        this.emit("error", err);
        return reject(new Error(err));
      }

      let slot = options.slot;
      if (slot === undefined) {
        slot = this.sessions.findIndex(s => s === null);
      }

      if (slot === -1 || slot === null) {
        const err = "all_slots_in_use";
        this.emit("error", err);
        return reject(new Error(err));
      }

      if (this.sessions[slot]) {
        return reject(new Error(`Slot ${slot} already in use`));
      }

      const callOptions = this.platform.callOptions(this, slot);

      const session = this.ua.invite(`sip:${destination}@anything`, callOptions);
      session.data = {
        id: slot,
        state: "calling",
        direction: "outbound",
        target: options.target,
        peer_info: options.peer_info || { address: destination.startsWith("pickup_uuid.") ? "" : destination }
      };

      this._attachSessionListeners(session, slot);
      this.sessions[slot] = session;

      this._emit_session_update(session);

      resolve(session);
    });
  }

  _emit_session_update(session) {
      this.logger.log("emitting session_update");
      this.logger.dump(session.data);
      this.emit("session_update", session);
  }

  _attachSessionListeners(session, slot) {
    session.on("progress", (response) => {
      if (this.sessions[slot] !== session) return;
      this.logger.log(`BasixWebPhone: Slot ${slot} progress`, response.statusCode);

      // Handle Early Media (SIP.js 183/180 with SDP)
      if (response.statusCode === 183 && response.body) {
        session.createDialog(response, 'UAC');
        session.sessionDescriptionHandler.setDescription(response.body).then(() => {
          session.status = 11; // C.STATUS_EARLY_MEDIA;
          session.hasAnswer = true;
        }).catch(error => {
          this.logger.error("Early media failed", error);
          if (this.sessions[slot] === session) {
            try { session.terminate(); } finally { this._releaseSession(slot, session); }
          }
        });
      }

      if (response.body) {
        session.data.state = "progress";
      } else if (response.statusCode === 180) {
        if (session.data.state !== "progress") {
          session.data.state = "alerting";
        }
      }
      this._emit_session_update(session);
    });

    session.on("accepted", (response) => {
      if (this.sessions[slot] !== session) return;
      this.logger.log(`BasixWebPhone: Slot ${slot} accepted`);
      session.data.state = "talking";
      this._emit_session_update(session);
      this.holdOtherSessions(slot);
      this.hangupMediaPlugSession();
    });

    session.on("rejected", (response, cause) => {
      if (this.sessions[slot] !== session) return;
      this.logger.log(`BasixWebPhone: Slot ${slot} rejected`, cause);
      session.data.state = "rejected";
      this._emit_session_update(session);
      this.emit('no_answer');
      this._releaseSession(slot, session);
    });

    // SIP.js does not always emit terminated after local CANCEL or a failed
    // final SDP answer. Release the UI/native slot on every terminal outcome.
    session.on("cancel", () => this._releaseSession(slot, session));
    session.on("bye", () => {
      try { session.close?.(); } finally { this._releaseSession(slot, session); }
    });
    session.on("failed", (response, cause) => {
      const current = this.sessions[slot] === session;
      try { session.close?.(); } finally { this._releaseSession(slot, session); }
      if (current) this.emit("call_failed", { slot, cause, statusCode: response?.statusCode });
    });
    session.on("terminated", () => this._releaseSession(slot, session));

    session.on("trackAdded", () => {
      if (this.sessions[slot] !== session) return;
      this.logger.log(`BasixWebPhone: Slot ${slot} trackAdded`);
      this._attachRemoteAudio(this.audioTags[slot], session);
    });
  }

  _releaseSession(slot, session) {
    // Late responses from a cancelled dialog must never clear a reused slot.
    if (this.sessions[slot] !== session) return;
    this.sessions[slot] = null;
    try { this._clearAudioElement(this.audioTags[slot]); }
    catch (error) { this.logger.error("Remote audio cleanup failed", error); }
    this._emit_session_update({ data: { id: slot, state: "idle" } });
  }

  /**
   * Handle CTI incoming call event.
   */
  addCtiIncomingCall(channel) {
    this.logger.log("BasixWebPhone: addCtiIncomingCall");
    this.logger.dump(channel);

    const slot = this.sessions.findIndex(s => s === null);
    if (slot === -1) {
      this.logger.log("BasixWebPhone: No free slot for incoming call");
      return null;
    }

    // Fake session for CTI ringing
    const session = {
      data: {
        id: slot,
        state: "ringing",
        direction: "inbound",
        offer_timestamp: channel.offer_timestamp,
        user_id: channel.user_id,
        group_id: channel.group_id,
        cti_state: channel.state,
        target: channel.target,
        channel: channel
      }
    };

    this._setSessionPeer(session, channel);
    this.sessions[slot] = session;
    this._emit_session_update(session);

    return slot;
  }

  removeCtiIncomingCall(channel) {
    const slot = this.sessions.findIndex(s => s?.data?.channel?.uuid === channel.uuid);
    if (slot === -1) return;

    const session = this.sessions[slot];
    session.data.state = "idle";
    this.sessions[slot] = null;
    this._emit_session_update(session);
  }

  /**
   * Answer a call via CTI (triggers an outbound SIP pickup).
   */
  answerCtiCall(slot) {
    const session = this.sessions[slot];
    if (!session || !session.data.channel) return;

    const { channel, peer_info, target } = session.data;
    this.removeCtiIncomingCall(channel);
    if(channel.other_uuid) {
      return this.makeCall(`pickup_uuid.${channel.other_uuid}`, { slot, peer_info, target });
    } else {
      var reference_uuid = channel.called_number.split(".")[1];
      return this.makeCall(`assimilate.${reference_uuid}`, { slot, peer_info, target });
    }
  }

  hold(slot) {
    const session = this.sessions[slot];
    if (session && typeof session.hold === "function") {
      session.hold();
      session.data.state = "on hold";
      this._emit_session_update(session);
    }
  }

  unhold(slot) {
    const session = this.sessions[slot];
    if (session && typeof session.unhold === "function") {
      session.unhold();
      session.data.state = "talking";
      this._emit_session_update(session);
    }
  }

  toggleSlot(slot) {
    const session = this.sessions[slot];
    if (!session) return;

    const state = session.data.state;
    if (state === "talking") {
      this.hold(slot);
    } else if (state === "on hold") {
      this.unhold(slot);
      this.holdOtherSessions(slot);
      this.hangupMediaPlugSession();
    } else if (state === "ringing" && session.data.channel) {
      this.answerCtiCall(slot);
    }
  }

  holdOtherSessions(currentSlot) {
    this.sessions.forEach((s, i) => {
      if (i !== currentSlot && s && s.data.state === "talking") {
        this.hold(i);
      }
    });
  }

  hangup(slot) {
    const session = this.sessions[slot];
    if (!session) return;

    if (session.data.channel) {
      this.args.cti.hangup(session.data.channel.uuid);
    } else if (typeof session.terminate === "function") {
      try {
        if (!session.isCanceled) session.terminate();
      } catch (error) {
        session.close?.();
        throw error;
      } finally {
        this._releaseSession(slot, session);
      }
    }
  }

  sendDTMF(key) {
    this.sessions.forEach(s => {
      if (s && s.data.state === "talking" && typeof s.dtmf === "function") {
        s.dtmf(key);
      }
    });
  }

  transfer(slot, dest) {
    const session = this.sessions[slot];
    if (!session) return;

    if (session.data.state === "ringing") {
      if (typeof dest === "object") return;
      this.args.cti.transfer(session.data.channel.other_uuid, this.args.user_id, this.args.user_name, dest);
    } else if (["talking", "on hold"].includes(session.data.state)) {
      const options = { extraHeaders: [`Referred-By: ${this.args.user_name}`] };
      if (typeof dest === "string") {
        session.refer(`${dest}@basix`, options);
      } else {
        session.refer(dest, options);
      }
    }
  }

  /**
   * Hangs up any active call in the first available talking/calling slot.
   */
  hangupCurrentCall() {
    const activeSession = this.sessions.find(s =>
      s && ["talking", "calling", "progress"].includes(s.data?.state)
    );
    if (activeSession && typeof activeSession.terminate === "function") {
      this.hangup(activeSession.data.id);
    }
  }

  /**
   * Internal Peer Info logic.
   * @private
   */
  _setSessionPeer(session, channel) {
    console.log("_setSesionPeer", channel)
    let peer_info;
    if (channel.other_info) {
      peer_info = channel.other_info;
    } else {
      peer_info = session.data.peer_info;
      if(!peer_info) {
        let address = "";
        if (channel.called_number.startsWith("RINGING_PARK")) {
          address = channel.calling_number;
        } else if (!channel.called_number.startsWith("pickup_uuid.")) {
          address = channel.called_number;
        }
        peer_info = { address };
      }
    }

    if (peer_info.whoscall) {
      const store = this.args.cti.get_store();
      const user = store["user"][channel.user_id];
      if (user && (user.flags & 1024)) {
        peer_info.whoscall = JSON.parse(decodeURIComponent(peer_info.whoscall));
      } else {
        peer_info.whoscall = null;
      }
    }
    session.data.peer_info = peer_info;
  }

  /**
   * Handle CTI Info Events.
   */
  handleInfoEvent(element_name, info, event_name) {
    if (element_name === "channel") {
      this._handleChannelEvent(info, event_name);
    } else if (element_name === "channel_waiting") {
      this._handleParkingEvent(info, event_name);
    }
  }

  /**
   * Alias for handleInfoEvent for backward compatibility.
   */
  handle_info_event(element_name, info, event_name) {
    return this.handleInfoEvent(element_name, info, event_name);
  }

  _handleChannelEvent(channel, event_name) {
    if (channel.user_id !== this.args.user_id) return;

    if (channel.called_number.match(/^RINGING_PARK/)) {
      if (channel.direction !== "outbound" || !channel.state) return;

      if (event_name === "updated" && channel.state.name === "ringing") {
        var slot = this.addCtiIncomingCall(channel);
        if(slot >= 0 && channel.tags && channel.tags.includes('auto_answer')) {
          this.answerCtiCall(slot);
        }
      } else if (event_name === "removed") {
        this.removeCtiIncomingCall(channel);
      }
    } else {
      // Update existing SIP session with CTI data if call IDs match
      const session = this.sessions.find(s =>
        s?.dialog?.id?.callId === channel.call_id
      );

      if (session) {
        if (event_name === "removed" || channel.last_event === "CHANNEL_HANGUP" || channel.state?.name === "hangup") {
          session.close?.();
          this._releaseSession(session.data.id, session);
          return;
        }
        session.data.cti_channel_uuid = channel.uuid;
        this._setSessionPeer(session, channel);
        session.data.answer_timestamp = channel.answer_timestamp;
        session.data.cti_state = channel.state;
        this._emit_session_update(session);
      }
    }
  }

  _handleParkingEvent(channel_waiting, event_name) {
    if (channel_waiting.state.name !== "park") return;

    const { state } = channel_waiting;
    const store = this.args.cti.get_store();
    const user = store["user"][this.args.user_id];

    const slot = this._getRelativeParkPosition(state.data.slot, user.park_group);
    if (!slot) return;

    if (event_name === "added" || event_name === "updated") {
      let whoscall = null;
      if (channel_waiting.whoscall && (user.flags & 1024)) {
        whoscall = JSON.parse(decodeURIComponent(channel_waiting.whoscall));
      }

      var peer_info = {
        direction: channel_waiting.direction,
        peer_location: channel_waiting.peer_location,
        address: channel_waiting.direction === "inbound" ? channel_waiting.calling_number : channel_waiting.called_number,
        offer_timestamp: channel_waiting.offer_timestamp,
      }

      if(channel_waiting.user_id) {
        peer_info = {...peer_info, type: "user", user_id: channel_waiting.user_id}
      } else if(channel_waiting.end_user) {
        peer_info = {...peer_info, type: "end_user", "end_user": channel_waiting.end_user}
      }

      this.parkingState[slot] = {
        park_timestamp: state.ts,
        park_position: state.data.slot,
        end_user: channel_waiting.end_user,
        parker: store["user"][state.data.parker_id],
        uuid: channel_waiting.uuid,
        peer_info,
        whoscall,
      };
    } else if (event_name === "removed") {
      this.parkingState[slot] = null;
    }

    this.emit("parking_state_change", this.parkingState);
  }

  _getRelativeParkPosition(absPosition, park_group) {
    if (absPosition >= 997 && absPosition <= 999) return absPosition - 993;
    if (absPosition < 901 || absPosition > 996) return null;

    const base = 901 + (park_group * 3);
    const relative = absPosition - base + 1;
    return (relative < 1 || relative > 3) ? null : relative;
  }

  /**
   * Media Plug (Eavesdrop/Whisper) logic.
   */
  makeMediaPlugCall() {
    if (!this.isConnected) return false;

    const session = this.ua.invite("sip:media_plug@anything");
    this.mediaPlugSession = session;

    session.on("accepted", (data) => {
      if (this.mediaPlugSession !== session) return;
      const uuid = data.headers["X-Channel-Uuid"][0].raw;
      this.mediaPlugUuid = uuid;
      if (this.pendingMediaPlugCmd) {
        this._mediaPlugTimer = setTimeout(() => {
          if (this.mediaPlugSession !== session || !this.pendingMediaPlugCmd) return;
          this.args.cti.sendMediaPlugCommand(this.mediaPlugUuid, this.pendingMediaPlugCmd);
          this.pendingMediaPlugCmd = null;
        }, 2000);
      }
    });

    session.on("failed", () => {
      if (this.mediaPlugSession === session) this.emit("error", "media_plug_call_failed");
    });
    session.on("terminated", () => {
      if (this.mediaPlugSession !== session) return;
      clearTimeout(this._mediaPlugTimer);
      this.pendingMediaPlugCmd = null;
      this._clearAudioElement(this.mediaPlugAudioTag);
      this.mediaPlugSession = null;
      this.mediaPlugUuid = null;
      this.emit("media_plug_terminated");
    });

    session.on("trackAdded", () => {
      if (this.mediaPlugSession !== session) return;
      this._attachRemoteAudio(this.mediaPlugAudioTag, session, "Media plug audio play failed");
    });

    return true;
  }

  eavesdrop(uuid, subcommand) {
    const cmd = ["eavesdrop", uuid, subcommand];
    if (!this.mediaPlugSession) {
      if (this.makeMediaPlugCall()) {
        this.pendingMediaPlugCmd = cmd;
      }
    } else {
      this.args.cti.sendMediaPlugCommand(this.mediaPlugUuid, cmd);
    }
  }

  hangupMediaPlugSession() {
    if (this.mediaPlugSession) {
      this.mediaPlugSession.terminate();
    }
  }

  /**
   * Alias for hangupMediaPlugSession for backward compatibility.
   */
  disconnect_media_plug() {
    return this.hangupMediaPlugSession();
  }

  // Getters
  getMaxSessions() { return this.args.max_sessions; }
  getSessions() { return this.sessions; }
  getMediaPlugUuid() { return this.mediaPlugUuid; }

  /**
   * Alias for getMediaPlugUuid for backward compatibility.
   */
  get_media_plug_uuid() {
    return this.getMediaPlugUuid();
  }
}

module.exports = BasixWebPhone;
