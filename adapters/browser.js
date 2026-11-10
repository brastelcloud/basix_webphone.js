"use strict";

module.exports = function browserPlatform() {
  const ownedAudio = [];
  return {
    createUserAgent(options) {
      const SIP = require("sip.js");
      return new SIP.UA(options);
    },
    bindLifecycle(stop) {
      window.addEventListener("pagehide", stop);
      return () => window.removeEventListener("pagehide", stop);
    },
    setup(phone) {
      if (phone.args.audioTags.length) {
        phone.audioTags = phone.args.audioTags;
      } else if (phone.args.autoCreateAudioTags) {
        const create = id => {
          const audio = document.createElement("audio");
          audio.id = id;
          audio.autoplay = true;
          document.body.appendChild(audio);
          ownedAudio.push(audio);
          return audio;
        };
        phone.audioTags = Array.from({ length: phone.args.max_sessions }, (_, slot) =>
          create(`BasixWebPhoneRemoteAudio${slot}`));
        phone.mediaPlugAudioTag = create("BasixWebPhoneRemoteAudioMediaPlug");
      }
    },
    callOptions(phone, slot) {
      return { media: {
        constraints: { audio: true, video: false },
        render: { remote: phone.audioTags[slot] },
        RTCOfferOptions: { voiceActivityDetection: false },
      } };
    },
    clear(audio) {
      if (!audio) return;
      audio.pause();
      audio.srcObject = null;
    },
    attach(audio, session, logger, label) {
      const pc = session.sessionDescriptionHandler?.peerConnection;
      if (!audio || !pc) return;
      let stream = audio.srcObject;
      if (!(stream instanceof MediaStream)) {
        stream = new MediaStream();
        audio.srcObject = stream;
      }
      const ids = new Set(stream.getTracks().map(track => track.id));
      pc.getReceivers().forEach(({ track }) => {
        if (track && !ids.has(track.id)) {
          stream.addTrack(track);
          ids.add(track.id);
        }
      });
      audio.play()?.catch(error => {
        if (error.name !== "AbortError") logger.error(label, error);
      });
    },
    destroy(phone) {
      phone.audioTags.forEach(audio => this.clear(audio));
      this.clear(phone.mediaPlugAudioTag);
      ownedAudio.splice(0).forEach(audio => audio.remove());
    },
  };
};
