# tribrid — voice bridge between Discord, Haven, and Fluxer

Research notes from source-code reads (2026-10-11):
- Haven 4.21.0 cloned from ancsemi/Haven @ main
- fluxer cloned from fluxerapp/fluxer @ main

## What each platform's voice actually is

### Discord (as a bot)
- Voice = the documented "Voice connections" protocol: gateway WS for signaling,
  then a UDP socket (with IP discovery) for SRTP audio.
- Use @discordjs/voice. Audio is Opus 48 kHz, 20 ms frames, stereo,
  RTP-profile RFC3550 (no header extensions).
- RX: `connection.receiver` → per-user ssrcs, `subscribe({ mode: 'streams' })`
  gives decoded Opus packets per member (and 'opus' packets for raw).
  Set `selfDeaf: false` when joining or there is no receiver.
- TX: any `AudioResource`; feed it Opus frames from a 48 kHz encoder
  (opus encoder via nodejs-wawa-corrections / @snazzah/davey not needed;
  plain `opusscript` or native libopus binding, e.g. `@discordjs/opus`).

### Haven (ancsemi/Haven)
- Node.js server, socket.io for everything. Voice = **peer-to-peer WebRTC
  (RTCRtpSender) between clients**, with an optional mediasoup relay
  (`src/voiceRelay/`) that is only used between *relay-capable* browser clients.
- **There is a dedicated bot voice API** (src/botVoice.js): bots connect as a
  socket.io socket with `auth: { botToken: <64-hex webhook token> }`
  (webhook must have `can_use_voice`). Bots are *always signaled P2P*, never
  through the mediasoup relay ("Anyone who cannot [use the relay] (an older
  app, a bot) is still reached directly").
- Bot socket events (all JSON over socket.io):
  - server→bot: `bot-session` {id, webhookId, username, channelCode}
  - bot→server: `voice-join` {code: <8-hex channel code>} + ack cb
  - server→bot: `voice-existing-users` {users[], voiceBitrate} (these are the
    peers the bot must initiate offers to; already `polite:false` convention)
  - signaling: `voice-offer` / `voice-answer` / `voice-ice-candidate`
    {code, targetUserId, offer|answer|candidate, from}
  - presence/meta: `voice-user-joined`, `voice-user-left`, `voice-speaking`
    {userId, speaking}, `voice-mute-state`, `voice-activity`,
    `voice-kicked`, `voice-leave` {code}
- Rate limit on the bot socket: 300 socket events / 10 s window.
- Media: standard WebRTC Opus over DTLS-SRTP; mediasoup profile when relayed
  is `audio/opus 48000/2`, so 48 kHz is the house rate. Client mic uses
  opusStereo:false, DTX, FEC — answers may offer mono; bot offer should pin
  48 kHz. Browser clients often negotiate 16 kHz when their mic pipeline uses
  rnnoise — bot should munge its offer to force `opus/48000` only.
- ICE config: `GET /api/ice-servers` returns STUN + optional TURN (admin-
  configured). Bot must use it; without TURN, remote peers behind symmetric
  NAT won't connect.
- Text bot API: `POST /api/webhooks/<token>` {content} etc. Presence bridge
  messages can go through this.
- One socket per webhook token (a second connect kicks the first).

### Fluxer (fluxerapp/fluxer)
- Elixir gateway + **LiveKit** for all media (no custom voice protocol,
  no P2P for bots — "A bot session never agrees [to P2P]").
- Gateway: Discord-style WS. Identify with bot token, op 0/1/4/6...
  Voice join = op 4 `Voice State Update`
  {guild_id, channel_id, self_mute/self_deaf...} (omit `p2p`, bots can't).
- Server replies with dispatch `VOICE_STATE_UPDATE` (roster changes; visible
  to any session viewing the channel) + `VOICE_SERVER_UPDATE` to us alone:
  {token, endpoint, channel_id, connection_id, guild_id?, e2e_key?}. Grant
  lives 600 s.
- Media: connect to LiveKit endpoint with that token using the LiveKit
  participant identity scheme:
  room `guild_{guild_id}_channel_{channel_id}`, identity
  `user_{user_id}_{connection_id}`. From Node: `@livekit/rtc-node` (Rust-core
  SDK, real audio frames in/out) — `livekit-client` is browser-only.
  Publish: 48 kHz PCM16 `AudioStream` (SDK encodes Opus). Subscribe:
  audio frames callback → mix.
  If `e2e_key` present, LiveKit E2EE must be enabled with that key.
- Bots can also use the REST API (`/v1/...`, Discord-like) for text.

## Where the bridge attaches

- Discord: full duplex audio (join as bot, rx+tx). Easy, documented.
- Haven: full duplex audio via P2P WebRTC bot socket. Need a Node WebRTC
  stack: `wrtc` (dead, node≤18) vs `node-webrtc`-forks vs **`mediasoup`
  not usable for us** → best current option: `werift` (TS WebRTC, works on
  modern Node) or embed a headless Chromium (`puppeteer`) that hosts a
  hidden RTCPeerConnection per Haven peer (the "browser-as-media-gateway"
  trick). Recommend trying `werift` first, Chromium fallback.
- Fluxer: full duplex audio via LiveKit worker (rtc-node). Cleanest of the
  three.

## Audio topology (tincan-style mesh, mix-minus is the crux)

```
            ┌──────────── 48 kHz float mixer (4 input buses) ────────────┐
 Discord rx ─► decode opus ─► PCM ─► bus D                                │
 Haven   rx ─► WebRTC PCM  ─────► bus H                                  │
 Fluxer  rx ─► LiveKit PCM ─────► bus F                                  │
            │                                                             │
            ├─► bus H+bus F ─► opus enc 48k stereo 20ms ─► Discord tx    
            ├─► bus D+bus F ─► WebRTC AudioTrack ─► Haven tx (per peer)  
            └─► bus D+bus H ─► AudioStream PCM ─► LiveKit tx             
```
- Single shared clock: everything resampled to 48 kHz stereo float.
  Discord/Haven/LiveKit all natively 48k → resampling only if a Haven client
  negotiates 16k (should be prevented by SDP munging).
- Mix-minus per destination (never send a platform its own audio back →
  no echo loop).
- DTX/CNG: when nobody speaks on the source side, emit silence/DTX, don't
  spam packets; LiveKit has built-in VAD-silence suppression; Discord likes
  small keepalive silence.
- One 20 ms tick loop drives all encoders (no per-packet pacing drift).

## Presence bridge ("know there's people on the other platform")
- Discord: gateway `VOICE_STATE_UPDATE` events (join/leave/speaking).
- Haven: bot socket already receives `voice-user-joined/left` +
  `voice-speaking` for joined channel.
- Fluxer: `VOICE_STATE_UPDATE` dispatch.
- Bridge bot posts ephemeral-ish webhook messages + sets channel topic
  ("2 in Discord • 1 in Haven") in each linked room; optional push DM.

## Latency budget (measured-class estimates)
- Discord hop: opus decode/encode 2–5 ms + UDP RTT + discord jitter ~20–40 ms
- Haven hop: browser WebRTC P2P, jitter buffer ~30–60 ms
- Fluxer hop: LiveKit SFU ~30–60 ms
- Our mixer tick: +20 ms frame + <5 ms processing
- Expected one-way cross-platform: **~90–160 ms** on a good link, well under
  the ~300 ms where conversation gets awkward. Double-Opus only on the
  LiveKit leg (decode→mix→encode), which is ~4 ms.

## Risks / open questions
1. Haven bot voice is young (webhook can_use_voice + P2P only). werift must
   interop with Chrome's RTCRtpSender strict DTLS/SRTP + possible 16 kHz
   rnnoise pipeline. Fallback: hidden Chromium via puppeteer.
2. Haven P2P needs TURN for WAN peers → admin must configure TURN in Haven
   (or the bridge runs on the same LAN/Tailscale as the Haven server).
3. Fluxer LiveKit: need rtc-node E2EE support check if instance enables
   channel E2EE. Also instance must expose LiveKit publicly to the bridge.
4. Three-party mixing means the bridge must run near all three: best on a
   box with UDP egress (logic VPS or the ai box on the LAN).
5. Discord ToS: bots connecting voice are fine; user-token selfbots are not —
   stay on the official bot API for Discord. Haven/Fluxer are self-hosted,
   no ToS issue.
