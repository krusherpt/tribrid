/**
 * Haven leg — socket.io bot voice API (src/botVoice.js in Haven).
 *
 * Auth:  io(url, { auth: { botToken } })   (webhook token with can_use_voice)
 * Join:  emit('voice-join', { code }, ack)
 * Media: P2P WebRTC per user (bots are never relayed). Haven's politeness
 *        rule is `Number(mine) < Number(remote)`; bot ids are NEGATIVE
 *        (-webhookId), so the bot is ALWAYS polite and real clients always
 *        send the offer to it. We therefore answer offers, and only create
 *        an offer ourselves if a peer stays silent too long (deadlock guard).
 * ICE:   Haven's /api/ice-servers needs a user session, so ICE servers come
 *        from bridge config (HAVEN_ICE_SERVERS_JSON).
 */
import { createHmac } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { RTCPeerConnection, useOPUS, MediaStreamTrack, RtpPacket, RtpHeader } from 'werift';
import type { Mixer, Outlet } from '../audio/engine.js';
import { FRAME_SAMPLES } from '../audio/engine.js';
import { makeDecoder, makeEncoder, floatToS16, pcm16ToFloatStereo } from '../audio/codec.js';
import type { IceServer, LegMode } from '../config.js';
import { log, dbg, warn, err } from '../log.js';

const TAG = 'haven';

interface HavenPeer {
  userId: number;
  username: string;
  pc: RTCPeerConnection;
  localTrack: MediaStreamTrack;
  outlet: Outlet;
  src: ReturnType<Mixer['createSource']>;
  dec: ReturnType<typeof makeDecoder>;
  ts: number;
  seq: number;
  offeredByThem: boolean;
  connecting: boolean;
  connected: boolean;
  offerTimer?: NodeJS.Timeout;
  closed: boolean;
}

export interface HavenLeg {
  roster(): { id: string; name: string }[];
  setVoiceWanted(w: boolean): void;
  setPresenceText(text: string): void;
  outletIdPrefix: string;
  destroy(): void;
}

export async function startHavenLeg(
  cfg: {
    url: string;
    botToken: string;
    channelCode: string;
    iceServers: IceServer[];
    mode: LegMode;
  },
  mixer: Mixer,
  onRosterChanged?: () => void
): Promise<HavenLeg> {
  let peerRxCount = 0;
  const rxTimer = setInterval(() => {
    if (peerRxCount) { dbg(TAG, `rx frames last 30s: ${peerRxCount}`); peerRxCount = 0; }
  }, 30_000);
  const peers = new Map<number, HavenPeer>();
  const roster = new Map<number, string>();
  let botId: number | null = null;
  let socket: Socket;

  // Haven shows a speaking ring for the bot from 'voice-speaking' relays, and
  // the AFK sweep evicts voice users whose 'voice-activity' goes stale — so
  // report bot speech (debounced, rising edge immediate) and heartbeat.
  let botSpeaking = false;
  let speakOffT: NodeJS.Timeout | undefined;
  let activityTimer: NodeJS.Timeout | undefined;
  function reportBotSpeaking(active: boolean): void {
    if (active) {
      if (speakOffT) { clearTimeout(speakOffT); speakOffT = undefined; }
      if (!botSpeaking && socket?.connected) {
        botSpeaking = true;
        socket.emit('voice-speaking', { code: cfg.channelCode, speaking: true });
      }
    } else if (botSpeaking && !speakOffT) {
      speakOffT = setTimeout(() => {
        speakOffT = undefined;
        if (botSpeaking && socket?.connected) {
          botSpeaking = false;
          socket.emit('voice-speaking', { code: cfg.channelCode, speaking: false });
        }
      }, 350);
    }
  }
  let destroyed = false;
  let joinAcked = false;
  let inVoice = false;
  let voiceWanted = true;
  let lastStatusText = '';

  // werift takes one URL string per ice server entry (STUN and TURN both).
  // Entries with `authSecret` get fresh coturn REST creds (identical
  // derivation to Haven's own /api/ice-servers: base64 HMAC-SHA1 of
  // "<expiry>:<user>"), re-minted for every peer connection.
  const iceConfig = (): { urls: string; username?: string; credential?: string }[] =>
    cfg.iceServers.flatMap((s) =>
      s.urls.map((u) => {
        if (s.authSecret) {
          const expiry = Math.floor(Date.now() / 1000) + 24 * 3600;
          const username = `${expiry}:tribrid`;
          const credential = createHmac('sha1', s.authSecret).update(username).digest('base64');
          return { urls: u, username, credential };
        }
        return s.username && s.credential ? { urls: u, username: s.username, credential: s.credential } : { urls: u };
      })
    );

  const zeroPcm = Buffer.alloc(FRAME_SAMPLES * 2 * 2); // 20ms stereo silence

  const makePeer = (userId: number, username: string): HavenPeer | null => {
    if (peers.has(userId)) return peers.get(userId)!;
    const enc = makeEncoder(48_000);
    const silencePkt = enc.encode(zeroPcm);
    const src = mixer.createSource('haven', String(userId));
    const dec = makeDecoder();

    const localTrack = new MediaStreamTrack({ kind: 'audio' });
    const pc = new RTCPeerConnection({
      iceServers: iceConfig(),
      codecs: { audio: [useOPUS({ clockRate: 48000, channels: 2 })] },
    });
    pc.addTransceiver(localTrack, { direction: 'sendrecv' });

    // Candidate trickle -> Haven
    pc.onIceCandidate.subscribe((c) => {
      if (!c) return;
      socket.emit('voice-ice-candidate', {
        code: cfg.channelCode,
        targetUserId: userId,
        candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex },
      });
    });

    pc.connectionStateChange.subscribe((s) => {
      dbg(TAG, `peer ${userId} connectionState=${s}`);
      if (s === 'connected') peer.connected = true;
      if (s === 'failed' || s === 'closed') destroyPeer(userId, `connection ${s}`);
    });

    // Remote track -> decode -> mixer
    pc.onTrack.subscribe((t) => {
      dbg(TAG, `peer ${userId} onTrack ${t.kind}`);
      t.onReceiveRtp.subscribe((pkt) => {
        const pcm = dec.decode(Buffer.from(pkt.payload));
        if (pcm && pcm.length > 0) { src.push(pcm16ToFloatStereo(pcm)); peerRxCount++; }
      });
    });

    // TX outlet: everything except THIS user's own audio (per-user mix-minus)
    let ts = (Math.random() * 2 ** 32) >>> 0;
    let seq = Math.floor(Math.random() * 2 ** 16);
    let silentTicks = 0;
    const outlet: Outlet = {
      id: `haven:${userId}`,
      enabled: cfg.mode.out,
      accepts: (p, id) => !(p === 'haven' && id === String(userId)),
      onFrame(frame: Float32Array, active: boolean) {
        if (!peer.connected) return;
        reportBotSpeaking(active);
        let payload: Buffer;
        if (active) {
          silentTicks = 0;
          payload = enc.encode(floatToS16(frame));
        } else if (++silentTicks >= 75) {
          silentTicks = 0;
          payload = silencePkt;
        } else return;
        const pkt = new RtpPacket(
          new RtpHeader({ sequenceNumber: seq, timestamp: ts, marker: false, payloadType: 96 }),
          payload
        );
        seq = (seq + 1) & 0xffff;
        ts = (ts + FRAME_SAMPLES) >>> 0;
        localTrack.writeRtp(pkt);
      },
    };
    mixer.addOutlet(outlet);

    // Deadlock guard: a peer that never receives an offer from us would sit
    // silent if its client assumed WE offer. Real Haven clients offer to bots
    // (we're polite), so this fires only for exotic clients.
    const offerTimer = setTimeout(async () => {
      const p = peers.get(userId);
      if (!p || p.closed || p.offeredByThem || p.connecting || p.connected) return;
      dbg(TAG, `peer ${userId} silent 8s, bot initiates offer`);
      try {
        p.connecting = true;
        const offer = await p.pc.createOffer();
        await p.pc.setLocalDescription(offer);
        socket.emit('voice-offer', {
          code: cfg.channelCode,
          targetUserId: userId,
          offer: { type: offer.type, sdp: offer.sdp },
        });
      } catch (e) {
        warn(TAG, `offer to ${userId} failed: ${e instanceof Error ? e.message : e}`);
      }
    }, 8_000);

    const peer: HavenPeer = {
      userId,
      username,
      pc,
      localTrack,
      outlet,
      src,
      dec,
      ts,
      seq,
      offeredByThem: false,
      connecting: false,
      connected: false,
      offerTimer,
      closed: false,
    };
    peers.set(userId, peer);
    return peer;
  };

  const destroyPeer = (userId: number, why: string) => {
    const p = peers.get(userId);
    if (!p) return;
    peers.delete(userId);
    roster.delete(userId);
    p.closed = true;
    if (p.offerTimer) clearTimeout(p.offerTimer);
    mixer.removeOutlet(p.outlet.id);
    p.src.stop();
    try {
      p.pc.close();
    } catch {
      /* already closed */
    }
    dbg(TAG, `peer ${userId} closed (${why})`);
  };

  const answerOffer = async (userId: number, username: string, offer: { type: string; sdp: string }) => {
    const peer = makePeer(userId, username);
    if (!peer || peer.closed) return;
    peer.offeredByThem = true;
    if (peer.offerTimer) clearTimeout(peer.offerTimer);
    try {
      await peer.pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      socket.emit('voice-answer', {
        code: cfg.channelCode,
        targetUserId: userId,
        answer: { type: 'answer', sdp: peer.pc.localDescription?.sdp ?? answer.sdp },
      });
    } catch (e) {
      warn(TAG, `answer to ${userId} failed: ${e instanceof Error ? e.message : e}`);
      destroyPeer(userId, 'answer failed');
    }
  };

  // ---- socket wiring ----
  socket = io(cfg.url, {
    auth: { botToken: cfg.botToken },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 2_000,
    reconnectionDelayMax: 30_000,
  });

  socket.on('connect', () => {
    log(TAG, `socket connected (${socket.id})`);
    joinAcked = false;
  });

  socket.on('connect_error', (e) => warn(TAG, `connect_error: ${e.message}`));

  socket.on('disconnect', (reason) => {
    warn(TAG, `socket disconnected: ${reason}`);
    for (const id of [...peers.keys()]) destroyPeer(id, 'socket disconnect');
  });

  socket.on('bot-session', (s: { id: number; username: string; channelCode: string }) => {
    botId = s.id;
    if (lastStatusText) socket.emit('set-status', { status: 'online', statusText: lastStatusText });
    log(TAG, `bot session id=${s.id} name="${s.username}" homeChannel=${s.channelCode}`);
  });

  const joinVoice = () => {
    if (inVoice || !socket.connected) return;
    socket.emit('voice-join', { code: cfg.channelCode }, (res: { error?: string; success?: boolean }) => {
      if (res?.error) {
        err(TAG, `voice-join refused: ${res.error}`);
      } else {
        joinAcked = true;
        inVoice = true;
        log(TAG, `voice-join ok channel=${cfg.channelCode}`);
      }
    });
  };

  socket.on('connect', () => {
    inVoice = false;
    if (!activityTimer) {
      activityTimer = setInterval(() => {
        if (inVoice && socket.connected) socket.emit('voice-activity', { code: cfg.channelCode });
      }, 25_000);
    }
    if (voiceWanted) joinVoice();
  });

  socket.on('voice-existing-users', (data: { users?: { id: number; username: string; isBot?: boolean }[] }) => {
    for (const u of data.users ?? []) {
      if (u.isBot || u.id === botId) continue;
      roster.set(u.id, u.username);
      if (cfg.mode.in) makePeer(u.id, u.username); // wait politely for their offer
    }
    log(TAG, `existing users: ${[...roster.entries()].map(([i, n]) => `${n}#${i}`).join(', ') || '(none)'}`);
    onRosterChanged?.();
  });

  socket.on('voice-user-joined', (data: { user?: { id: number; username: string; isBot?: boolean } }) => {
    const u = data.user;
    if (!u || u.isBot || u.id === botId) return;
    roster.set(u.id, u.username);
    log(TAG, `joined: ${u.username}#${u.id}`);
    onRosterChanged?.();
    if (cfg.mode.in) makePeer(u.id, u.username);
  });

  socket.on('voice-user-left', (data: { user?: { id: number } }) => {
    if (!data.user) return;
    log(TAG, `left: #${data.user.id}`);
    onRosterChanged?.();
    if (data.user.id === botId) inVoice = false; // kicked / evicted ourselves
    destroyPeer(data.user.id, 'left');
  });

  socket.on('voice-offer', (data: { from?: { id: number; username: string }; offer?: { type: string; sdp: string } }) => {
    if (!data.from || !data.offer) return;
    if (data.from.id === botId) return;
    answerOffer(data.from.id, data.from.username ?? String(data.from.id), data.offer);
  });

  socket.on('voice-answer', (data: { from?: { id: number }; answer?: { type: string; sdp: string } }) => {
    if (!data.from || !data.answer) return;
    const peer = peers.get(data.from.id);
    if (!peer || peer.closed) return;
    peer.pc.setRemoteDescription({ type: 'answer', sdp: data.answer.sdp }).catch((e) =>
      warn(TAG, `setRemote(answer) ${data.from!.id}: ${e instanceof Error ? e.message : e}`)
    );
  });

  socket.on('voice-ice-candidate', (data: { from?: { id: number }; candidate?: { candidate: string; sdpMid?: string; sdpMLineIndex?: number } }) => {
    if (!data.from || !data.candidate) return;
    const peer = peers.get(data.from.id);
    if (!peer || peer.closed || !data.candidate.candidate) return;
    // addIceCandidate accepts the RTCIceCandidateInit shape directly
    peer.pc.addIceCandidate(data.candidate).catch((e) =>
      dbg(TAG, `addIceCandidate ${data.from!.id}: ${e instanceof Error ? e.message : e}`)
    );
  });

  socket.on('voice-kicked', (data: { reason?: string }) => {
    err(TAG, `kicked by server: ${data?.reason ?? 'unknown'} — not rejoining until restart`);
    destroyed = true;
  });

  return {
    roster: () => [...roster.entries()].map(([id, name]) => ({ id: String(id), name })),
    setPresenceText(text: string) {
      const t = text.slice(0, 128);
      if (t === lastStatusText) return;
      lastStatusText = t;
      if (socket?.connected) socket.emit('set-status', { status: 'online', statusText: t });
    },
    setVoiceWanted(w: boolean) {
      if (w === voiceWanted) return;
      voiceWanted = w;
      if (w) {
        joinVoice();
      } else if (inVoice && socket.connected) {
        log(TAG, 'nobody to bridge — leaving voice');
        socket.emit('voice-leave', { code: cfg.channelCode });
        inVoice = false;
        roster.clear();
        for (const id of [...peers.keys()]) destroyPeer(id, 'left voice');
      }
    },
    outletIdPrefix: 'haven:',
    destroy() {
    clearInterval(rxTimer);
      destroyed = true;
      if (activityTimer) clearInterval(activityTimer);
      if (speakOffT) clearTimeout(speakOffT);
      for (const id of [...peers.keys()]) destroyPeer(id, 'shutdown');
      try {
        socket.disconnect();
      } catch {
        /* noop */
      }
    },
  };
}
