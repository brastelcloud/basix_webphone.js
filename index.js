"use strict";

const EventEmitter = require('events')

module.exports = (function(env) {
	var SIP = require('sip.js');

	var phone = new Object();
    Object.assign(phone, EventEmitter.prototype)

	var process_ws_disconnection = function() {
		if(!phone.ua) return;

		phone.ua.stop();
		delete phone.ua;
		phone.emit('stopped');
	};

	phone._startUA = function() {
		console.log("WebPhone._startUA: begin");
		phone.isConnected = false;

		phone.ua = new SIP.UA({
			uri: "ws_sip_" + phone.args.user_name + "@" + phone.args.domain_name,
			transportOptions: {
				wsServers: ["wss://" + phone.args.app_cname + "/basix/api/ws_sip"],

				maxReconnectionAttempts: 0,
			},
			register: false,
			registerExpires: 100,
			noAnswerTimeout: 180,
			autostart: false,
			sessionDescriptionHandlerFactoryOptions: {
				constraints: {
					audio: true,
					video: false
				},
				peerConnectionOptions: {
					iceCheckingTimeout: 500,
				},
			},
		});

		console.log('Registering to transportCreated');
		phone.ua.on('transportCreated', function(transport) {
			console.log("transportCreated");

			transport.on('connected', function() {
				console.log("transport connected");
				phone.isConnected = true;
			});

			transport.on('transportError', function() {
				console.log("transportError");
				phone.isConnected = false;
				process_ws_disconnection();
			})

			transport.on('disconnected', function() {
				console.log("transport disconnected");
				phone.isConnected = false;
				process_ws_disconnection();
			});
		});

		phone.ua.on('unregistered', function() {
			console.log("WebPhone: unregistered");
			phone.ua.stop();
			delete phone.ua;
			phone.stopped();
		});

		phone.ua.start();
		console.log("WebPhone._startUA: end");
	};

	phone.makeCall = function(destination) {
		if(!phone.isConnected) {
			console.log("Cannot make call as ua is not connected");
			return false;
		}

		var slot = null;
		for(var i=0 ; i<phone.args.max_sessions ; ++i) {
			if(!phone.sessions[i]) {
				console.log("slot " + i + " OK");
				slot = i;
				break;
			} else {
				console.dir(phone.sessions[i]);
			}
		}

		if(slot == null) {
			console.log("All slots in use");
			return false;
		}

		var options = {
			media: {
				constraints: {
					audio: true,
					video: false
				},
				render: {
					remote: phone.audio_tags[slot]
				}
			}
		};

		var session = phone.ua.invite("sip:" + destination + "@anything", options);
		session.on('progress', function(response) {
			console.log("WebPhone slot=" + slot + " got event 'progress'");
			session.data['state'] = 'progress';
			phone.emit('session_update', session);
		});

		session.on('accepted', function(data) {
			console.log("WebPhone slot=" + slot + " got event 'accepted'");
			session.data['state'] = 'talking';
			phone.emit('session_update', session);
			phone.holdOtherSessions(slot);
			phone.hangupMediaPlugSession();
		});

		session.on('rejected', function(response, cause) {
			console.log("WebPhone slot=" + slot + " got event 'rejected'");
			session.data['state'] = 'rejected';
			phone.emit('session_update', session);
		});

		session.on('failed', function(response, cause) {
			console.log("WebPhone slot=" + slot + " got event 'failed' with cause=" + cause);
			session.data['state'] = 'terminated';
			phone.emit('session_update', session);
		});

		session.on('terminated', function(message, cause) {
			console.log("WebPhone slot=" + slot + " got event 'terminated' with cause=" + cause);
			session.data['state'] = 'terminated';
			phone.emit('session_update', session);
			delete phone.sessions[session.data['id']];
		});

		session.on('cancel', function() {
			console.log("WebPhone slot=" + slot + " got event 'cancel'");
			session.data['state'] = 'cancel';
			phone.emit('session_update', session);
		});

		session.on('bye', function(request) {
			console.log("WebPhone slot=" + slot + " got event 'bye'");
		});

		session.on('trackAdded', function() {
			console.log("trackAdded")
			var audio = phone.audio_tags[slot]
			console.dir(audio);

			var pc = session.sessionDescriptionHandler.peerConnection;

			// Gets remote tracks
			var remoteStream = new MediaStream();
			pc.getReceivers().forEach(function(receiver) {
				remoteStream.addTrack(receiver.track);
			});
			audio.srcObject = remoteStream;
			audio.play();
		});

		session.data['state'] = 'calling';
		session.data['direction'] = 'outbound';
		session.data['id'] = slot;
		session.data['peer_number'] = destination;
		session.data['peer_name'] = destination;
		phone.sessions[slot] = session;

		phone.emit('session_update', session);
	};

	phone.hold = function(slot) {
		var session = phone.session[slot];
		session.hold();
	};

	phone.unhold = function(slot) {
		var session = phone.session[slot];
		session.unhold();
	};

	phone.getMaxSessions = function() {
		return phone.args.max_sessions;
	};

	phone.getSessions = function() {
		return phone.sessions;
	};

  phone.transfer = function(slot, dest) {
		console.log("WebPhone transfer");
		var session = phone.sessions[slot];
		if(!session) {
			console.log("No session at slot " + slot);
			return;
		}
    var options = {
        extraHeaders: [
          'Referred-By: ' + phone.args.user_name
        ],
    }
    session.refer(dest + "@basix", options);
  };

	phone.toggleSlot = function(slot) {
		console.log("WebPhone toggleSlot");
		var session = phone.sessions[slot];
		if(!session) {
			console.log("No session at slot " + slot);
			return;
		}

		 if(session.data['state'] == 'talking') {
			session.hold();
			session.data['state'] = 'on hold';
			phone.emit('session_update', session);
			return;
		}

		if(session.data['state'] == 'on hold') {
			session.unhold();
			session.data['state'] = 'talking';
			phone.emit('session_update', session);
		}

		phone.holdOtherSessions(slot);
		phone.hangupMediaPlugSession();
	};


	phone.hangupMediaPlugSession = function() {	
		if(!phone.media_plug_session) return;
		phone.media_plug_session.terminate();
		phone.emit('media_plug_terminated');
	};

	phone.holdOtherSessions = function(slot) {	
		for(var i=0 ; i<phone.args.max_sessions ; ++i) {
			var s = phone.sessions[i];
			if(i != slot && s && s.data['state'] == 'talking') {
				s.hold();
				s.data['state'] = 'on hold';
				phone.emit('session_update', s);
			}
		}
	};

	phone.sendDTMF = function(key) {
		for(var i=0 ; i<phone.args.max_sessions ; ++i) {
			var s = phone.sessions[i];
			if(s && s.data['state'] == 'talking') {
				s.dtmf(key);
			}
		}
	};

	phone.hangupCurrentCall = function() {
		for(var i=0 ; i<phone.args.max_sessions ; ++i) {
			var s = phone.sessions[i];
			if(s && s.data['state'] == 'talking') {
				s.terminate();
				return;
			}
			if(s && s.data['state'] == 'calling') {
				s.terminate();
				return;
			}
			if(s && s.data['state'] == 'progress') {
				s.terminate();
				return;
			}
		}
	};

	phone.init = function(args) {
		console.log("WebPhone init");
		console.dir(args);

		if(phone._initialized) {
			console.log("Already initialized")
			return
		}

		phone.args = args;

		phone.sessions = [];
		phone.audio_tags = [];

		for(var id=0 ; id<phone.args.max_sessions ; id++) {
			var audioTag = document.createElement('audio')
			audioTag.id = 'BasixWebPhoneRemoteAudio' + id
			document.body.appendChild(audioTag)
			phone.audio_tags[id] = audioTag
		}

		var audioTag = document.createElement('audio')
		audioTag.id = 'BasixWebPhoneRemoteAudioMediaPlug'
		document.body.appendChild(audioTag)
		phone.media_plug_audio_tag = audioTag

		phone._startUA();

		phone._initialized = true;
	};

	phone.start = function() {
		console.log("WebPhone start");
		if(!phone.ua) {
			phone._startUA();
		}
	};

	phone.makeMediaPlugCall = function() {
		if(!phone.isConnected) {
			console.log("Cannot make call as ua is not connected");
			return false;
		}

		var options = null;

		var session = phone.ua.invite("sip:media_plug@anything", options);

		session.on('accepted', function(data) {
			console.log("WebPhone MediaPlug got event 'accepted'");
			var uuid = data.headers['X-Channel-Uuid'][0].raw;
			console.log("WebPhone Media_plug_uuid=" + uuid);
			phone.media_plug_uuid = uuid;
			if(phone.pending_media_plug_cmd) {
				setTimeout(function() {
					console.log("Sending pending_media_plug_cmd");
					phone.args.cti.sendMediaPlugCommand(phone.media_plug_uuid, phone.pending_media_plug_cmd);
					phone.pending_media_plug_cmd = null;
				}, 2000);
			}
		});

		session.on('rejected', function(response, cause) {
			console.log("WebPhone MediaPlug got event 'rejected'");
		});

		session.on('failed', function(response, cause) {
			console.log("WebPhone MediaPlug got event 'failed' with cause=" + cause);

			window.toast_mic_access_error()
		});

		session.on('terminated', function(message, cause) {
			console.log("WebPhone MediaPlug 'terminated' with cause=" + cause);
			phone.media_plug_session = null;
			phone.media_plug_uuid = null;
		});

		session.on('bye', function(request) {
			console.log("WebPhone MediaPlug got event 'bye'");
		});

		session.on('trackAdded', function() {
			console.log("trackAdded")
			var audio = phone.media_plug_audio_tag;
			console.dir(audio);

			var pc = session.sessionDescriptionHandler.peerConnection;

			// Gets remote tracks
			var remoteStream = new MediaStream();
			pc.getReceivers().forEach(function(receiver) {
				remoteStream.addTrack(receiver.track);
			});
			audio.srcObject = remoteStream;
			audio.play();
		});

		phone.media_plug_session = session;

		return true;
	};


	phone.eavesdrop = function(uuid, subcommand) {
		var cmd = ["eavesdrop", uuid, subcommand];
		console.log("WebPhone eavesdrop " + subcommand);
		if(!phone.media_plug_session) {
			if(phone.makeMediaPlugCall()) {
				console.log("WebPhone.makeMediaPlugCall() successful")
				phone.pending_media_plug_cmd = cmd;
			} else {
				console.log("WebPhone.makeMediaPlugCall() failed")
			}
		} else if(phone.media_plug_session == 'pending') {
			console.log("WebPhone: pending");
			phone.pending_media_plug_cmd = cmd;
		} else {
			console.log("WebPhone: executing media_plug cmd");
			phone.args.cti.sendMediaPlugCommand(phone.media_plug_uuid, cmd);
		}
	};

	phone.get_media_plug_uuid = function() {
		return phone.media_plug_uuid;
	};

	phone.disconnect_media_plug = function() {
		if(phone.media_plug_session) {
			phone.media_plug_session.terminate();			
		}
	};

	return phone;
})();
