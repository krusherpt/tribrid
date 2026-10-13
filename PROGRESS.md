# tribrid — progress snapshot (updated 2026-10-12)

## Status: HAVEN LEG FULLY E2E-VERIFIED (11/11)
`node spikes/haven-e2e.cjs` boots a throwaway Haven server + the REAL bridge +
2 fake browser users and proves:
- bot webhook token auth, voice-join, roster
- user→bot WebRTC negotiation (Haven politeness: bot answers offers)
- audio user→bridge→other user intact (sine peak 22149 of ~20000 amplitude)
- mix-minus perfect (speaker hears nothing of self, peak 0)
- jitter buffer drops stale burst frames as designed (154 pkts at real-time pacing)
Unit tests: 4/4. `npm run build` clean.
Re-verified 2026-10-13 against **Haven 4.22.0** — vendored at `vendor/haven`
(scratch-pruning killed the old clone; lesson saved in the skill).
Also fixed: Discord leg now sweeps SSRCs mapped before wireReceiver ran;
Fluxer presence posts now surface the message id + DELETE (no more stacking).

## What exists
- docs/RESEARCH.md — full protocol research (verified against source of Haven 4.21 + fluxer docs)
- src/audio/engine.ts   — 48k stereo 20ms mixer, per-outlet mix-minus, jitter rings, speech detect
- src/audio/codec.ts    — opus via @discordjs/opus (wasm opusscript fallback), tested roundtrip
- src/legs/discord.ts   — @discordjs/voice leg (rx: per-user subscribe, tx: persistent opus resource)
- src/legs/haven.ts     — bot socket.io + werift P2P mesh (bot=polite, answer offers, 8s offer fallback)
                          + voice-speaking relay (user-visible bot ring) + voice-activity keepalive 25s (AFK-sweep-proof)
- src/legs/fluxer.ts    — gateway WS (op2/op4/op1) + LiveKit rtc-node (grant->room, AudioStream rx / AudioSource tx)
- src/presence.ts, src/text.ts — roster line posted to each platform's text channel
- src/index.ts, config.ts, log.ts — .env-driven, legs enable when their keys are present
- README.md + .env.example — user-facing setup docs DONE
- spikes/werift-loop.cjs — PASSED: opus tx/rx + ICE/DTLS over werift
- spikes/haven-e2e.cjs  — the 11/11 E2E above

## Harness lessons (baked into spikes/haven-e2e.cjs, reusable)
- Haven USER-side voice-join has NO ack callback (only bot-side does);
  join confirmation = 'voice-existing-users' event
- Seed throwaway Haven by direct better-sqlite3 writes between two server boots;
  user JWT = sign({id,username,isAdmin,displayName,pwv:1}, server JWT_SECRET);
  webhook INSERT INTO webhooks(..., can_use_voice=1) → its token = bot token
- Mic frames must be paced at 20ms in tests (synchronous bursts legitimately
  hit the 120ms jitter-drop policy)

## Remaining to verify live (needs user's creds/instances)
1. Discord leg: needs bot app + token + guild/voice/text IDs (selfDeaf:false already set)
2. Fluxer leg: needs a Fluxer instance with bots enabled + token
3. Real Chrome ↔ bridge interop on Haven (rnnoise may offer 16k; werift answers
   with OUR codec list so 48k should stick — have a community member test)
4. TURN server for WAN Haven peers (HAVEN_ICE_SERVERS_JSON)
5. (done 2026-10-13) Fluxer presence delete wired via leg deleteMessage()

## Old watchpoints still open
- werift sendRtp seq/ts offsets after replaceRTP — re-check on packet loss/RTX
- Discord ssrcMap 'create' event timing vs speaking subscriptions

## Deploy target
logic VPS (pm2). Community test = user runs one platform, friends join the others.
