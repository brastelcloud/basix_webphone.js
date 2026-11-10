# basix_webphone.js

Shared Basix CTI and SIP call control for the browser webphone and native hosts.
The existing SIP.js fork remains pinned; this change does not upgrade SIP.js.

## Browser compatibility

Existing `basix_app_server/riot_app` usage remains valid:

```js
const WebPhone = require('basix_webphone.js');
WebPhone.init({
  cti: CTI,
  user_id: userId,
  user_name: userName,
  domain_name: domainName,
  max_sessions: 3,
  wsServers: () => Promise.resolve([sipWebSocketUrl]),
});
```

The default export is still a singleton. `createPhone()` creates an independent
browser instance when needed. `init()` starts SIP; repeated initialization is a
no-op. `start()` restarts a stopped UA and is a no-op while already starting or
connected. `stop()` stops SIP. `destroy()` stops SIP, detaches the library's CTI
and pagehide listeners, releases audio, and clears state and phone listeners.
Call `init()` again to reuse a destroyed instance.

The host owns login/logout, CTI authentication, credentials, and the supplied
WebSocket address provider. The browser retains its app-session authentication;
the library does not issue or persist device tokens. On explicit logout, the host
should destroy the phone and close its own CTI connection. It must invalidate its
server-side credentials as usual. `destroy()` does not revoke credentials or stop
the externally owned CTI client.

The browser adapter creates remote HTML audio elements and stops SIP on pagehide.
Caller-provided `audioTags` are cleared but never removed from the document.
Session objects, `session.data`, state names, transfer targets, and EventEmitter
subscriptions remain compatible with Riot. `parking_state` aliases `parkingState`.
Media-plug termination emits `media_plug_terminated`.

## React Native host integration

Import the explicit entry point:

```js
const { createPhone } = require('basix_webphone.js/react-native');
const phone = createPhone(nativePlatform);

phone.on('error', handlePhoneError);
phone.on('session_update', updateCallUi);
phone.init({
  cti: authenticatedCti,
  user_id: userId,
  user_name: userName,
  domain_name: domainName,
  max_sessions: 3,
  wsServers: getSipWebSocketAddresses,
});
```

`nativePlatform` is implemented by the mobile app (for example,
`basix_webrtc_phone`). It is an integration contract, not a bundled native SIP or
WebRTC implementation. This entry point loads neither the browser adapter nor
SIP.js, and requires no `window`, `document`, or HTML audio elements.

| Platform method | Responsibility |
| --- | --- |
| `createUserAgent(options)` | Return an unstarted SIP.js 0.13-compatible UA. Configure the native WebRTC session description handler and authenticated WebSocket transport here. Preserve the supplied options, including `register: false`, RTP DTMF, and the address provider. |
| `setup(phone)` | Allocate per-instance media resources. May populate `phone.audioTags` and `phone.mediaPlugAudioTag` with opaque native handles; they need not be HTML elements. |
| `callOptions(phone, slot)` | Return native media options for an outgoing INVITE. |
| `attach(handle, session, logger, label)` | Handle remote tracks, for ordinary calls and media-plug sessions. |
| `clear(handle)` | Release a remote media binding; tolerate missing handles. |
| `destroy(phone)` | Release resources, including partial initialization; tolerate repeated calls. |
| `bindLifecycle(stop)` (optional) | Register platform lifecycle handlers and return an unsubscribe function. Backgrounding a native phone should not automatically stop a live call. |

The UA must expose the existing `on`, `start`, `stop`, and `invite` APIs. Its
sessions must support the SIP.js 0.13 event/session interface, including dialogs,
`hold`, `unhold`, `dtmf`, `refer`, and `terminate`. The shared early-media path
still uses `createDialog` and `sessionDescriptionHandler.setDescription` from the
pinned fork. A current SIP.js release is not a drop-in replacement.

The native host owns secure device-token storage, native transport authorization,
CTI startup, push handling, CallKit/Telecom, audio-session activation, routing,
and network recovery. It must not log tokens. Native WebRTC compatibility and
background calling require real-device validation; this refactor alone does not
make those integrations operational.

## Validation

Run `npm test` with Node.js 18 or later. Tests use Node's built-in test runner,
fake SIP sessions and CTI, and browser media stubs, with no PBX or native SDK.
They cover the existing call/session interface, early media, pickup, DTMF,
transfers, parking, media plug, lifecycle cleanup, and DOM-free native imports.

Before releasing to `riot_app`, update its pinned Git dependency and lockfile,
build its Webpack bundle, and verify calls, early media, hold/resume, DTMF,
blind/attended transfers, parking, supervisor listening, tones, and logout against
Basix. Editing this sibling checkout does not update Riot's pinned dependency.
