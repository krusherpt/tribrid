# tribrid

> **Disclaimer:** this project was made using AI (Qwen Flash Next).

Low-latency voice mesh between **Discord**, **Haven** and **Fluxer** — one
always-on bot that sits in a voice channel on each platform and forwards
everything it hears to the others, so a call is a call no matter where your
friends hung out.

```
        Discord leg              Haven leg               Fluxer leg
   (@discordjs/voice, UDP)  (bot socket + P2P WebRTC)  (gateway + LiveKit)
              \\                    |                    //
               \\                   |                   //
                +------- mixer: 48kHz stereo, 20ms -------+
                     per-listener mix-minus routing
```

* **Nobody hears an echo of their own platform.** Each listener receives the
  mix of *all other sources*; on Haven (which is peer-to-peer per user) the
  exclusion is per *user*, not per platform.
* **Roster line** — optional text-channel message like
  `3 on Discord: alice, bob… • 1 on Haven: carl` so people know who's around.
* Typical one-way cross-platform delay: **~100-160 ms** on consumer internet.

## Platform notes

| Platform | Bot voice? | How the leg works |
|---|---|---|
| Discord | yes | `@discordjs/voice`; joins when a human is present, per-user receive streams |
| Haven | yes (official bot voice API) | socket.io bot token (= a webhook with *can use voice*), then one WebRTC P2P connection per user. Needs TURN (`HAVEN_ICE_SERVERS_JSON`) for users outside your LAN |
| Fluxer | yes (bots use the LiveKit media engine) | Discord-style gateway WS for signaling, `@livekit/rtc-node` for media |

Configure only the legs you have — a leg activates when its keys are present.

## Setup

```bash
npm install
cp .env.example .env   # fill in at least two legs
npm run build
npm start              # or: pm2 start dist/index.js --name tribrid
```

**Discord**: create an app → bot → copy token. Invite with *Connect*, *Speak*,
*Use Voice Activity* (plus *Send Messages* if you want the roster line). Put
guild / voice / text channel IDs (right-click channel → Copy ID, dev mode on)
in `.env`.

**Haven**: channel settings → webhooks → create webhook → tick **can use
voice** → the webhook's token is `HAVEN_BOT_TOKEN`. The channel's 8-hex code
(from its URL) is `HAVEN_CHANNEL_CODE`. On the bridge host, set
`HAVEN_ICE_SERVERS_JSON` with your TURN server for non-LAN users.

**Fluxer**: bot token from the instance's bot panel (Fluxer bots are an
instance feature — ask your host to enable them). `FLUXER_URL`, guild and
channel IDs as on Discord.

## How it sounds

Audio is decoded to a common 48 kHz stereo format, mixed on one 20 ms clock,
re-encoded to Opus per listener. A 60 ms de-jitter ring absorbs network
jitter; anything older than 120 ms is dropped rather than allowed to lag the
live call.

## Development

```bash
npm test                    # mixer/codec unit tests
node spikes/werift-loop.cjs # WebRTC transport spike
node spikes/haven-e2e.cjs   # full Haven E2E: throwaway server + bridge + 2 fake users
```

The E2E suite boots a real Haven server, seeds it, runs the real bridge
against it and verifies user→bot→user audio plus echo prevention. See
`docs/RESEARCH.md` for the protocol notes behind every leg.

## License
AGPL-3.0
