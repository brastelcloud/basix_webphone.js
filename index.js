"use strict";

const EventEmitter = require("events");

function setSessionPeer(session, channel) {
  session.data['peer_address'] = channel.other_info.address;
  var peer_info = channel.other_info;

  if(peer_info.whoscall) {
    var user = phone.args.cti.get_store()['user'][channel.user_id]
    if(user.flags & 1024) {
      peer_info.whoscall = JSON.parse(decodeURIComponent(peer_info.whoscall))
    } else {
      peer_info.whoscall = null
    }
  }
  session.data['peer_info'] = peer_info;
}

function getRelativeParkPosition(absPosition, park_group) {
  // Shared domain positions
  if (absPosition >= 997 && absPosition <= 999) {
    return absPosition - 993; // 997→4, 998→5, 999→6
  }

  // Validate range
  if (absPosition < 901 || absPosition > 996) {
    return null; // or throw error
  }

  // Base position for this group
  var base = 901 + (park_group * 3);

  // Calculate relative (1,2,3)
  var relative = absPosition - base + 1;

  // Ensure it's valid (belongs to this group)
  if (relative < 1 || relative > 3) {
    return null; // not part of this user's group
  }

  return relative;
}

module.exports = (function (env) {
  var SIP = require("sip.js");

  var phone = new Object();
  Object.assign(phone, EventEmitter.prototype);

  var process_ws_disconnection = function () {
    if (!phone.ua) return;

    phone.ua.stop();
    delete phone.ua;
    phone.emit("stopped");
  };

  phone._startUA = function () {
    console.log("WebPhone._startUA: begin");
    phone.isConnected = false;

    phone.ua = new SIP.UA({
      //uri: "ws_sip_" + phone.args.user_name + "@" + phone.args.domain_name,
      uri: phone.args.user_name + "@" + phone.args.domain_name,
      transportOptions: {
        wsServers: ["wss://" + phone.args.app_cname + "/basix/api/ws_sip"],
        maxReconnectionAttempts: 0,
        connectionTimeout: 10000,
      },
      register: false,
      registerExpires: 100,
      noAnswerTimeout: 180,
      autostart: false,
      sessionDescriptionHandlerFactoryOptions: {
        constraints: {
          audio: true,
          video: false,
        },
        peerConnectionOptions: {
          iceCheckingTimeout: 500,
        },
      },
    });

    console.log("Registering to transportCreated");
    phone.ua.on("transportCreated", function (transport) {
      console.log("transportCreated");

      transport.on("connected", function () {
        console.log("transport connected");
        phone.isConnected = true;
      });

      transport.on("transportError", function () {
        console.log("transportError");
        phone.isConnected = false;
        process_ws_disconnection();
      });

      transport.on("disconnected", function () {
        console.log("transport disconnected");
        phone.isConnected = false;
        process_ws_disconnection();
      });
    });

    phone.ua.on("unregistered", function () {
      console.log("WebPhone: unregistered");
      phone.ua.stop();
      delete phone.ua;
      phone.stopped();
    });

    phone.ua.start();
    console.log("WebPhone._startUA: end");
  };

  phone.addCtiIncomingCall = function(channel) {
    console.log("addCtiIncomingCall", channel)

    var slot = null;
    for (var i = 0; i < phone.args.max_sessions; ++i) {
      if (!phone.sessions[i]) {
        console.log("slot " + i + " OK");
        slot = i;
        break;
      } else {
        console.dir(phone.sessions[i]);
      }
    }

    if(slot == null) {
      console.log("No free slot for incoming call")
      return
    }

    // Fake session
    var session = {data: {}}

    session.data["state"] = "ringing";
    session.data["direction"] = "inbound";
    session.data["id"] = slot;
    session.data["offer_timestamp"] = channel.offer_timestamp;
    session.data["user_id"] = channel.user_id;
    session.data["group_id"] = channel.group_id;
    session.data["cti_state"] = channel.state;
    session.data["target"] = channel.target;
    setSessionPeer(session, channel)

    session.data["channel"] = channel;
    phone.sessions[slot] = session;

    phone.emit("session_update", session);
  }

  phone.removeCtiIncomingCall = function(channel) {
    console.log("removeCtiIncomingCall", channel)
    console.log(phone.sessions)
    var foundSession = null;
    for (var i = 0; i < phone.args.max_sessions; ++i) {
      if (phone.sessions[i]) {
        var session = phone.sessions[i]
        if(session.data.channel && session.data.channel.uuid == channel.uuid) {
          foundSession = session
          break;
        }
      }
    }

    if(foundSession == null) {
      console.log("Incoming call not found")
      return
    }

    foundSession.data.state = "idle"

    phone.emit("session_update", foundSession); // Emit idle state
    delete phone.sessions[foundSession.data.id]; // Finally delete the session
  }

  phone.answerCtiCall = function(slot) {
    console.log("WebPhone answerCtiCall");
    var session = phone.sessions[slot];
    if (!session) {
      console.log("No session at slot " + slot);
      return;
    }

    if(!session.data.channel) return;

    phone.removeCtiIncomingCall(session.data.channel);

    phone.makeCall("pickup_uuid." + session.data.channel.other_uuid, {slot, peer_address: session.data.peer_address, peer_info: session.data.peer_info})
  }

  phone.makeCall = function (destination, options = {}) {
    if (!phone.isConnected) {
      console.log("Cannot make call as ua is not connected");
      phone.emit('error', 'not_connected')
      return false;
    }

    var slot = options.slot;
    if(!slot) {
      for (var i = 0; i < phone.args.max_sessions; ++i) {
        if (!phone.sessions[i]) {
          console.log("slot " + i + " OK");
          slot = i;
          break;
        } else {
          console.dir(phone.sessions[i]);
        }
      }
    }

    if (slot == null) {
      console.log("All slots in use");
      phone.emit('error', 'all_slots_in_use')
      return false;
    }

    if(phone.sessions[slot]) {
      console.log(`slot=${slot} in use`)
      return
    }

    var call_options = {
      media: {
        constraints: {
          audio: true,
          video: false,
        },
        render: {
          remote: phone.audio_tags[slot],
        },
      },
    };

    var session = phone.ua.invite("sip:" + destination + "@anything", call_options);

    session.on("progress", function (response) {
      console.log("WebPhone slot=" + slot + " got event 'progress'", response);
      if(response.body) {
        // Early media (180 or 183 with SDP)
        session.data["state"] = "progress";
        phone.emit("session_update", session);
      } else if(response.status_code == 180) {
        // In this case the UI should play ringback tone
        session.data["state"] = "ringing";
        phone.emit("session_update", session);
      }
    });

    session.on("accepted", function (data) {
      console.log("WebPhone slot=" + slot + " got event 'accepted'", data);
      session.data["state"] = "talking";
      phone.emit("session_update", session);
      phone.holdOtherSessions(slot);
      phone.hangupMediaPlugSession();
    });

    session.on("rejected", function (response, cause) {
      console.log("WebPhone slot=" + slot + " got event 'rejected'");
      session.data["state"] = "rejected";
      phone.emit("session_update", session);
    });

    session.on("failed", function (response, cause) {
      console.log(
        "WebPhone slot=" + slot + " got event 'failed' with cause=" + cause,
      );
      session.data["state"] = "terminated";
      phone.emit("session_update", session);
    });

    session.on("terminated", function (message, cause) {
      console.log(
        "WebPhone slot=" + slot + " got event 'terminated' with cause=" + cause,
      );
      session.data["state"] = "terminated";
      phone.emit("session_update", session); // Emit terminated state immediately
      var sessionId = session.data["id"];

      // Delay setting to 'idle' and then deleting
      setTimeout(() => {
        console.log("WebPhone: Setting session to 'idle' for ID:", sessionId);
        // Create a new object for the 'idle' state to avoid issues with the original session object being terminated
        var idleSession = {
          data: {
            id: sessionId,
            state: "idle",
            // Preserve other relevant data for display if necessary.
            peer_address: session.data["peer_address"],
          },
        };
        phone.emit("session_update", idleSession); // Emit idle state
        delete phone.sessions[sessionId]; // Finally delete the session
      }, 5000);
    });

    session.on("cancel", function () {
      console.log("WebPhone slot=" + slot + " got event 'cancel'");
      session.data["state"] = "cancel";
      phone.emit("session_update", session);
    });

    session.on("bye", function (request) {
      console.log("WebPhone slot=" + slot + " got event 'bye'");
    });

    session.on("trackAdded", function () {
      console.log("trackAdded");
      var audio = phone.audio_tags[slot];
      console.dir(audio);

      var pc = session.sessionDescriptionHandler.peerConnection;

      // Gets remote tracks
      var remoteStream = new MediaStream();
      pc.getReceivers().forEach(function (receiver) {
        remoteStream.addTrack(receiver.track);
      });
      audio.srcObject = remoteStream;
      audio.play();
    });

    session.data["state"] = "calling";
    session.data["direction"] = "outbound";
    session.data["id"] = slot;
    session.data["peer_address"] = options.peer_address ? options.peer_address : destination;
    session.data['peer_info'] = options.peer_info;
    phone.sessions[slot] = session;

    phone.emit("session_update", session);
  };

  phone.hold = function (slot) {
    var session = phone.sessions[slot];
    session.hold();
  };

  phone.unhold = function (slot) {
    var session = phone.sessions[slot];
    session.unhold();
  };

  phone.getMaxSessions = function () {
    return phone.args.max_sessions;
  };

  phone.getSessions = function () {
    return phone.sessions;
  };

  phone.transfer = function (slot, dest) {
    console.log("WebPhone transfer");
    var session = phone.sessions[slot];
    if (!session) {
      console.log("No session at slot " + slot);
      return;
    }
    var options = {
      extraHeaders: ["Referred-By: " + phone.args.user_name],
    };

    if (typeof dest === 'string') {
      // it's a string
      session.refer(dest + "@basix", options);
    } else if (typeof dest === 'object') {
      // this would be a consultative/attended transfer. So dest is expected to contain the target session
      session.refer(dest, options);
    }
  };

  phone.toggleSlot = function (slot) {
    console.log("WebPhone toggleSlot");
    var session = phone.sessions[slot];
    if (!session) {
      console.log("No session at slot " + slot);
      return;
    }

    if (session.data["state"] == "talking") {
      session.hold();
      session.data["state"] = "on hold";
      phone.emit("session_update", session);
      return;
    }

    if (session.data["state"] == "on hold") {
      session.unhold();
      session.data["state"] = "talking";
      phone.emit("session_update", session);
    }

    if (session.data["state"] == "ringing" && session.data.channel) {
      phone.answerCtiCall(slot)
    }

    phone.holdOtherSessions(slot);
    phone.hangupMediaPlugSession();
  };

  phone.hangupMediaPlugSession = function () {
    if (!phone.media_plug_session) return;
    phone.media_plug_session.terminate();
    phone.emit("media_plug_terminated");
  };

  phone.holdOtherSessions = function (slot) {
    for (var i = 0; i < phone.args.max_sessions; ++i) {
      var s = phone.sessions[i];
      if (i != slot && s && s.data["state"] == "talking") {
        s.hold();
        s.data["state"] = "on hold";
        phone.emit("session_update", s);
      }
    }
  };

  phone.sendDTMF = function (key) {
    for (var i = 0; i < phone.args.max_sessions; ++i) {
      var s = phone.sessions[i];
      if (s && s.data["state"] == "talking") {
        s.dtmf(key);
      }
    }
  };

  phone.hangup = function (slot) {
    console.log("Webphone hangup");
    var session = phone.sessions[slot];
    if (!session) {
      console.log("No session at slot " + slot);
      return;
    }

    if(session.data.channel) {
      phone.args.cti.hangup(session.data.channel.uuid)
    } else {
      session.terminate();
    }
    return;
  }

  phone.hangupCurrentCall = function () {
    for (var i = 0; i < phone.args.max_sessions; ++i) {
      var s = phone.sessions[i];
      if (s && s.data["state"] == "talking") {
        s.terminate();
        return;
      }
      if (s && s.data["state"] == "calling") {
        s.terminate();
        return;
      }
      if (s && s.data["state"] == "progress") {
        s.terminate();
        return;
      }
    }
  };

  phone.init = function (args) {
    console.log("WebPhone init");
    console.dir(args);

    if (phone._initialized) {
      console.log("Already initialized");
      return;
    }

    phone.args = args;

    phone.sessions = [];

    phone.audio_tags = [];

    phone.parking_state = [];

    for (var id = 0; id < phone.args.max_sessions; id++) {
      var audioTag = document.createElement("audio");
      audioTag.id = "BasixWebPhoneRemoteAudio" + id;
      document.body.appendChild(audioTag);
      phone.audio_tags[id] = audioTag;
    }

    var audioTag = document.createElement("audio");
    audioTag.id = "BasixWebPhoneRemoteAudioMediaPlug";
    document.body.appendChild(audioTag);
    phone.media_plug_audio_tag = audioTag;

    if(args.cti) {
      args.cti.on('open', () => {
        console.log("basix_webphone.js cti open")
      })

      args.cti.on('closed', () => {
        console.log("basix_webphone.js cti closed")
      })

      args.cti.on('error', err => {
        console.log("basix_webphone.js cti error", err)
      })

      args.cti.on('initial_info', ({element_name, data}) => {
        // TODO
      })

      args.cti.on('info_event', ({element_name, info, event_name}) => {
        console.log("basix_webphone.js info_event", element_name, info, event_name)
        if(element_name == "channel") {
          var channel = info;

          if(channel.user_id != phone.args.user_id) return;

          if(channel.called_number == "LOCAL_PARK") {
            if(channel.direction != "outbound") {
              console.log("no outbound")
              return;
            }

            if(!channel.state) {
              console.log("no state")
              return
            }

            if(event_name == "updated") {
              if(channel.state.name != "ringing") {
                console.log("no ringing")
                return
              }
              phone.addCtiIncomingCall(channel);
            } else if(event_name == "removed") {
              phone.removeCtiIncomingCall(channel);
            }
          } else {
            // Might be event for a channel for a webphone session.
            var session = null
            for (var i = 0; i < phone.args.max_sessions; ++i) {
              if (phone.sessions[i] && phone.sessions[i].dialog && phone.sessions[i].dialog.id.call_id == channel.call_id) {
                session = phone.sessions[i]
                break
              }
            }

            if(session) {
              setSessionPeer(session, channel)
              session.data["answer_timestamp"] = channel.answer_timestamp;
              session.data["cti_state"] = channel.cti_state;
              phone.emit("session_update", session);
            }
          }
        } else if(element_name == 'channel_waiting') {
          var channel_waiting = info;

          if(channel_waiting.state.name != 'park') return;

          var state = channel_waiting.state;

          var store = phone.args.cti.get_store()

          var user = store['user'][phone.args.user_id];

          var slot = getRelativeParkPosition(state.data.slot, user.park_group)

          console.log("slot", slot);
          if(!slot) return;

          if(event_name == 'added') {
            var parker = store['user'][state.data.parker_id];
            var data = {
              park_timestamp: state.ts,
              park_position: state.data.slot,
              end_user: channel_waiting.end_user,
              parker,
              uuid: channel_waiting.uuid,
              peer_number: channel_waiting.direction == "inbound" ? channel_waiting.calling_number : channel_waiting.called_number,
            }
            phone.parking_state[slot] = data;
          } else if(event_name == 'removed') {
            phone.parking_state[slot] = null;
          }

          console.log("emitting parking_state_change", event_name);
          phone.emit('parking_state_change', phone.parking_state);
        }
      })
    }

    phone._startUA();

    phone._initialized = true;
  };

  phone.start = function () {
    console.log("WebPhone start");
    if (!phone.ua) {
      phone._startUA();
    }
  };

  phone.makeMediaPlugCall = function () {
    if (!phone.isConnected) {
      console.log("Cannot make media_plug call as ua is not connected");
      phone.emit('error', 'not_connected')
      return false;
    }

    var options = null;

    var session = phone.ua.invite("sip:media_plug@anything", options);

    session.on("accepted", function (data) {
      console.log("WebPhone MediaPlug got event 'accepted'");
      var uuid = data.headers["X-Channel-Uuid"][0].raw;
      console.log("WebPhone Media_plug_uuid=" + uuid);
      phone.media_plug_uuid = uuid;
      if (phone.pending_media_plug_cmd) {
        setTimeout(function () {
          console.log("Sending pending_media_plug_cmd");
          phone.args.cti.sendMediaPlugCommand(
            phone.media_plug_uuid,
            phone.pending_media_plug_cmd,
          );
          phone.pending_media_plug_cmd = null;
        }, 2000);
      }
    });

    session.on("rejected", function (response, cause) {
      console.log("WebPhone MediaPlug got event 'rejected'");
      phone.emit('error', 'media_plug_call_rejected')
    });

    session.on("failed", function (response, cause) {
      console.log("WebPhone MediaPlug got event 'failed' with cause=" + cause);
      phone.emit('error', 'media_plug_call_failed')

      window.toast_mic_access_error();
    });

    session.on("terminated", function (message, cause) {
      console.log("WebPhone MediaPlug 'terminated' with cause=" + cause);
      phone.media_plug_session = null;
      phone.media_plug_uuid = null;
    });

    session.on("bye", function (request) {
      console.log("WebPhone MediaPlug got event 'bye'");
    });

    session.on("trackAdded", function () {
      console.log("trackAdded");
      var audio = phone.media_plug_audio_tag;
      console.dir(audio);

      var pc = session.sessionDescriptionHandler.peerConnection;

      // Gets remote tracks
      var remoteStream = new MediaStream();
      pc.getReceivers().forEach(function (receiver) {
        remoteStream.addTrack(receiver.track);
      });
      audio.srcObject = remoteStream;
      audio.play();
    });

    phone.media_plug_session = session;

    return true;
  };

  phone.eavesdrop = function (uuid, subcommand) {
    var cmd = ["eavesdrop", uuid, subcommand];
    console.log("WebPhone eavesdrop " + subcommand);
    if (!phone.media_plug_session) {
      if (phone.makeMediaPlugCall()) {
        console.log("WebPhone.makeMediaPlugCall() successful");
        phone.pending_media_plug_cmd = cmd;
      } else {
        console.log("WebPhone.makeMediaPlugCall() failed");
      }
    } else if (phone.media_plug_session == "pending") {
      console.log("WebPhone: pending");
      phone.pending_media_plug_cmd = cmd;
    } else {
      console.log("WebPhone: executing media_plug cmd");
      phone.args.cti.sendMediaPlugCommand(phone.media_plug_uuid, cmd);
    }
  };

  phone.get_media_plug_uuid = function () {
    return phone.media_plug_uuid;
  };

  phone.disconnect_media_plug = function () {
    if (phone.media_plug_session) {
      phone.media_plug_session.terminate();
    }
  };

  return phone;
})();
