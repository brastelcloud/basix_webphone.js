"use strict";

const EventEmitter = require("events");
const SIP = require("sip.js");

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
  constructor() {
    super();
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
    this.auto_answer = true;

    // Default logger
    this.logger = {
      log: console.log.bind(console),
      error: console.error.bind(console),
      dir: console.dir.bind(console),
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
    this.logger.dir(args);

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

    this._setupAudioTags();
    this._setupCtiListeners();
    this._startUA();

    this._initialized = true;
  }

  /**
   * Manages audio element creation/assignment.
   * @private
   */
  _setupAudioTags() {
    // If user provided tags, use them.
    if (this.args.audioTags && this.args.audioTags.length > 0) {
      this.audioTags = this.args.audioTags;
    }
    // Otherwise, create them if allowed.
    else if (this.args.autoCreateAudioTags) {
      for (let id = 0; id < this.args.max_sessions; id++) {
        const audioTag = document.createElement("audio");
        audioTag.id = `BasixWebPhoneRemoteAudio${id}`;
        audioTag.autoplay = true;
        document.body.appendChild(audioTag);
        this.audioTags[id] = audioTag;
      }

      const mediaPlugTag = document.createElement("audio");
      mediaPlugTag.id = "BasixWebPhoneRemoteAudioMediaPlug";
      mediaPlugTag.autoplay = true;
      document.body.appendChild(mediaPlugTag);
      this.mediaPlugAudioTag = mediaPlugTag;
    }
  }

  /**
   * Sets up listeners for the CTI system.
   * @private
   */
  _setupCtiListeners() {
    const { cti } = this.args;
    if (!cti) return;

    cti.on("open", () => this.logger.log("BasixWebPhone: CTI open"));
    cti.on("closed", () => this.logger.log("BasixWebPhone: CTI closed"));
    cti.on("error", (err) => {
      this.logger.error("BasixWebPhone: CTI error", err);
      this.emit("error", { source: "cti", error: err });
    });

    cti.on("initial_info", ({ element_name, data }) => {
      Object.values(data).forEach(info => {
        this.handleInfoEvent(element_name, info, "updated");
      });
    });

    cti.on("info_event", ({ element_name, info, event_name }) => {
      this.handleInfoEvent(element_name, info, event_name);
    });
  }

  /**
   * Starts the SIP User Agent.
   * @private
   */
  _startUA() {
    this.logger.log("BasixWebPhone: Starting UA");
    this.isConnected = false;

    this.ua = new SIP.UA({
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
      sessionDescriptionHandlerFactoryOptions: {
        constraints: { audio: true, video: false },
        peerConnectionOptions: { iceCheckingTimeout: 500 },
      },
    });

    this.ua.on("transportCreated", (transport) => {
      transport.on("connected", () => {
        this.logger.log("BasixWebPhone: Transport connected");
        this.isConnected = true;
        this.emit("connected");
      });

      transport.on("transportError", () => {
        this.logger.error("BasixWebPhone: Transport error");
        this.isConnected = false;
        this._processWsDisconnection();
      });

      transport.on("disconnected", () => {
        this.logger.log("BasixWebPhone: Transport disconnected");
        this.isConnected = false;
        this._processWsDisconnection();
      });
    });

    this.ua.on("unregistered", () => {
      this.logger.log("BasixWebPhone: Unregistered");
      this.ua.stop();
      this.emit("stopped");
    });

    this.ua.start();
  }

  _processWsDisconnection() {
    if (!this.ua) return;
    this.ua.stop();
    this.emit("disconnected");
  }

  /**
   * Starts the UA if not already started.
   */
  start() {
    if (!this.ua) {
      this._startUA();
    }
  }

  /**
   * Stops and cleans up resources.
   */
  destroy() {
    this.logger.log("BasixWebPhone: Destroying");
    if (this.ua) {
      this.ua.stop();
      this.ua = null;
    }

    // Cleanup audio tags if we created them
    if (this.args.autoCreateAudioTags) {
      this.audioTags.forEach(tag => tag?.remove());
      this.mediaPlugAudioTag?.remove();
    }

    this.sessions = [];
    this.audioTags = [];
    this._initialized = false;
    this.removeAllListeners();
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

      const callOptions = {
        media: {
          constraints: { audio: true, video: false },
          render: { remote: this.audioTags[slot] },
        },
      };

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

      this.logger.log("emitting session_update");
      this.logger.dump(session);
      this.emit("session_update", session);

      resolve(session);
    });
  }

  _attachSessionListeners(session, slot) {
    session.on("progress", (response) => {
      this.logger.log(`BasixWebPhone: Slot ${slot} progress`, response.statusCode);

      // Handle Early Media (SIP.js 183/180 with SDP)
      if (response.statusCode === 183 && response.body) {
        session.createDialog(response, 'UAC');
        session.sessionDescriptionHandler.setDescription(response.body).then(() => {
          session.status = 11; // C.STATUS_EARLY_MEDIA;
          session.hasAnswer = true;
        });
      }

      if (response.body) {
        session.data.state = "progress";
      } else if (response.statusCode === 180) {
        if (session.data.state !== "progress") {
          session.data.state = "alerting";
        }
      }
      this.emit("session_update", session);
    });

    session.on("accepted", (response) => {
      this.logger.log(`BasixWebPhone: Slot ${slot} accepted`);
      session.data.state = "talking";
      this.emit("session_update", session);
      this.holdOtherSessions(slot);
      this.hangupMediaPlugSession();
    });

    session.on("rejected", (response, cause) => {
      this.logger.log(`BasixWebPhone: Slot ${slot} rejected`, cause);
      session.data.state = "rejected";
      this.emit("session_update", session);
    });

    session.on("terminated", (message, cause) => {
      this.logger.log(`BasixWebPhone: Slot ${slot} terminated`, cause);
      const idleSession = { data: { id: slot, state: "idle" } };
      this.emit("session_update", idleSession);
      this.sessions[slot] = null;
    });

    session.on("trackAdded", () => {
      this.logger.log(`BasixWebPhone: Slot ${slot} trackAdded`);
      const audio = this.audioTags[slot];
      if (!audio) return;

      const pc = session.sessionDescriptionHandler.peerConnection;
      const remoteStream = new MediaStream();
      pc.getReceivers().forEach(receiver => {
        if (receiver.track) remoteStream.addTrack(receiver.track);
      });
      audio.srcObject = remoteStream;
      audio.play().catch(err => this.logger.error("Audio play failed", err));
    });
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
      return;
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
    this.emit("session_update", session);

    return slot;
  }

  removeCtiIncomingCall(channel) {
    const slot = this.sessions.findIndex(s => s?.data?.channel?.uuid === channel.uuid);
    if (slot === -1) return;

    const session = this.sessions[slot];
    session.data.state = "idle";
    this.emit("session_update", session);
    this.sessions[slot] = null;
  }

  /**
   * Answer a call via CTI (triggers an outbound SIP pickup).
   */
  answerCtiCall(slot) {
    const session = this.sessions[slot];
    if (!session || !session.data.channel) return;

    const { channel, peer_info, target } = session.data;
    this.removeCtiIncomingCall(channel);
    return this.makeCall(`pickup_uuid.${channel.other_uuid}`, { slot, peer_info, target });
  }

  hold(slot) {
    const session = this.sessions[slot];
    if (session && typeof session.hold === "function") {
      session.hold();
      session.data.state = "on hold";
      this.emit("session_update", session);
    }
  }

  unhold(slot) {
    const session = this.sessions[slot];
    if (session && typeof session.unhold === "function") {
      session.unhold();
      session.data.state = "talking";
      this.emit("session_update", session);
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
      session.terminate();
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
      activeSession.terminate();
    }
  }

  /**
   * Internal Peer Info logic.
   * @private
   */
  _setSessionPeer(session, channel) {
    let peer_info;
    if (channel.other_info) {
      peer_info = channel.other_info;
    } else {
      let address = "";
      if (channel.direction === "inbound") {
        address = channel.calling_number;
      } else if (!channel.called_number.startsWith("pickup_uuid.")) {
        address = channel.called_number;
      }
      peer_info = { address };
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

    if (channel.called_number === "RINGING_PARK") {
      if (channel.direction !== "outbound" || !channel.state) return;

      if (event_name === "updated" && channel.state.name === "ringing") {
        var slot = this.addCtiIncomingCall(channel);
        if(this.auto_answer && channel.tags && channel.tags.includes("auto_answer")) {
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
        this._setSessionPeer(session, channel);
        session.data.answer_timestamp = channel.answer_timestamp;
        session.data.cti_state = channel.state;
        this.emit("session_update", session);
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
      const uuid = data.headers["X-Channel-Uuid"][0].raw;
      this.mediaPlugUuid = uuid;
      if (this.pendingMediaPlugCmd) {
        setTimeout(() => {
          this.args.cti.sendMediaPlugCommand(this.mediaPlugUuid, this.pendingMediaPlugCmd);
          this.pendingMediaPlugCmd = null;
        }, 2000);
      }
    });

    session.on("failed", () => this.emit("error", "media_plug_call_failed"));
    session.on("terminated", () => {
      this.mediaPlugSession = null;
      this.mediaPlugUuid = null;
    });

    session.on("trackAdded", () => {
      const audio = this.mediaPlugAudioTag;
      if (!audio) return;
      const pc = session.sessionDescriptionHandler.peerConnection;
      const remoteStream = new MediaStream();
      pc.getReceivers().forEach(r => r.track && remoteStream.addTrack(r.track));
      audio.srcObject = remoteStream;
      audio.play().catch(e => this.logger.error(e));
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

  set auto_answer(status) {
    this.auto_answer = status;
    return this.auto_answer;
  }

  get auto_answer() {
    return this.auto_answer;
  }
}

module.exports = new BasixWebPhone();
