/**
 * Fluxer leg — Discord-like gateway WS for signaling, LiveKit for media.
 *
 * Flow (docs: gateway/commands Voice State Update, gateway/events
 * Voice Server Update, voice/index):
 *  1. GET {url}/v1/gateway/bot  (Authorization: Bot <token>) -> ws url
 *  2. WS ?v=1&encoding=json, wait op10 Hello, Identify op2, heartbeat op1
 *  3. op4 VoiceStateUpdate {guild_id, channel_id} (no connection_id -> new)
 *  4. dispatch VOICE_SERVER_UPDATE {token, endpoint, e2ee_key?}
 *  5. connect LiveKit room with that grant; autoSubscribe -> per-participant
 *     audio tracks -> AudioStream(48k,2) -> mixer sources; one shared
 *     AudioSource/LocalAudioTrack publishes the mix-minus frame each 20ms.
 * Bots can never use Fluxer P2P voice ("A bot session never agrees"), so
 * the grant is always a LiveKit grant.
 */
import WebSocket from 'ws';
import type { Mixer, Outlet } from '../audio/engine.js';
import { FRAME_SAMPLES } from '../audio/engine.js';
import { makeDecoder, floatToS16, pcm16ToFloatStereo } from '../audio/codec.js';
import type { LegMode } from '../config.js';
import { log, dbg, warn, err } from '../log.js';

const TAG = 'fluxer';

interface FluxerGrant {
  token: string;
  endpoint: string;
  channel_id: string;
  connection_id: string;
  guild_id?: string;
  e2ee_key?: string;
}

export interface FluxerLeg {
  roster(): { id: string; name: string }[];
  outletId: string;
  postMessage(content: string): Promise<string | null>;
  deleteMessage(id: string): Promise<void>;
  destroy(): void;
}

export async function startFluxerLeg(
  cfg: {
    url: string;
    botToken: string;
    voiceChannelId: string;
    guildId?: string;
    textChannelId?: string;
    mode: LegMode;
  },
  mixer: Mixer
): Promise<FluxerLeg> {
  // rtc-node is optional at install time; fail the leg, not the process.
  let lk: typeof import('@livekit/rtc-node');
  try {
    lk = await import('@livekit/rtc-node');
  } catch (e) {
    throw new Error(`@livekit/rtc-node unavailable (${e instanceof Error ? e.message : e}) — Fluxer leg disabled`);
  }

  const {
    Room,
    RoomEvent,
    ConnectionState,
    AudioSource,
    LocalAudioTrack,
    AudioFrame,
    AudioStream,
    TrackPublishOptions,
    TrackSource,
    TrackKind,
  } = lk as unknown as typeof lk & {
    TrackSource: { SOURCE_MICROPHONE: number };
    ConnectionState: { CONN_CONNECTED: number; CONN_RECONNECTING: number };
    TrackKind: { KIND_AUDIO: number };
  };

  const api = cfg.url; // api base == instance origin per discovery
  const auth = { Authorization: `Bot ${cfg.botToken}` };

  // ---- gateway ----
  let ws: WebSocket | null = null;
  let seq: number | null = null;
  let hbTimer: NodeJS.Timeout | null = null;
  let hbAcked = true;
  let destroyed = false;
  let botUserId: string | null = null;
  const roster = new Map<string, string>();

  // ---- livekit ----
  let room: import('@livekit/rtc-node').Room | null = null;
  let audioSource: InstanceType<typeof AudioSource> | null = null;
  let publishPromise: Promise<unknown> | null = null;
  let grantConnectionId: string | null = null;
  const readers = new Map<string, { src: ReturnType<Mixer['createSource']>; stop: () => void }>();

  async function gatewayUrl(): Promise<string> {
    const r = await fetch(`${api}/v1/gateway/bot`, { headers: auth });
    if (!r.ok) throw new Error(`GET /v1/gateway/bot -> ${r.status} ${await r.text().catch(() => '')}`);
    const j = (await r.json()) as { url: string };
    return j.url;
  }

  const send = (op: number, d: unknown) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op, d }));
  };

  async function connectGateway(): Promise<void> {
    if (destroyed) return;
    const url = await gatewayUrl();
    ws = new WebSocket(`${url.replace(/\/$/, '')}/?v=1&encoding=json`);

    ws.on('message', (raw: Buffer) => {
      let p: { op: number; t?: string; s?: number; d?: Record<string, unknown> };
      try {
        p = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (p.s != null) seq = p.s;
      switch (p.op) {
        case 10: {
          // Hello: identify, then heartbeat on the advertised interval
          const interval = Number((p.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 41250);
          send(2, {
            token: cfg.botToken,
            properties: { os: 'linux', browser: 'tribrid', device: 'tribrid' },
          });
          hbTimer = setInterval(() => {
            if (!hbAcked) {
              warn(TAG, 'heartbeat ack lost — reconnecting gateway');
              ws?.terminate();
              return;
            }
            hbAcked = false;
            send(1, seq);
          }, interval);
          break;
        }
        case 11:
          hbAcked = true;
          break;
        case 0:
          handleDispatch(p.t ?? '', p.d ?? {});
          break;
        case 9: // Invalid Session (never resume-able): fresh reconnect
          warn(TAG, 'invalid session — reconnecting');
          ws?.close();
          break;
        case 7: // Reconnect
          dbg(TAG, 'gateway asks reconnect');
          ws?.close();
          break;
        case 12: // Gateway Error
          dbg(TAG, `gateway error: ${JSON.stringify(p.d)}`);
          break;
      }
    });

    ws.on('close', (code, reason) => {
      dbg(TAG, `gateway closed ${code} ${reason.toString()}`);
      if (hbTimer) clearInterval(hbTimer);
      hbTimer = null;
      ws = null;
      if (!destroyed) setTimeout(connectGateway, 3_000);
    });

    ws.on('error', (e) => warn(TAG, `gateway ws error: ${e.message}`));
  }

  const joinVoice = () => {
    send(4, {
      guild_id: cfg.guildId ?? null,
      channel_id: cfg.voiceChannelId,
      self_mute: !cfg.mode.out,
      self_deaf: !cfg.mode.in,
    });
    log(TAG, `sent VoiceStateUpdate channel=${cfg.voiceChannelId}`);
  };

  function handleDispatch(t: string, d: Record<string, unknown>) {
    switch (t) {
      case 'READY': {
        const user = (d as { user?: { id?: string } }).user;
        botUserId = user?.id ?? null;
        log(TAG, `gateway READY bot=${botUserId}`);
        joinVoice();
        break;
      }
      case 'VOICE_SERVER_UPDATE': {
        const g = d as unknown as FluxerGrant;
        if (!g.token || !g.endpoint) {
          dbg(TAG, 'grant without token/endpoint (P2P?) — ignoring');
          return;
        }
        grantConnectionId = g.connection_id;
        log(TAG, `grant endpoint=${g.endpoint} conn=${g.connection_id}${g.e2ee_key ? ' (e2ee)' : ''}`);
        void connectLiveKit(g).catch((e) => err(TAG, `livekit connect: ${e instanceof Error ? e.message : e}`));
        break;
      }
      case 'VOICE_STATE_UPDATE': {
        const v = d as {
          user_id?: string;
          channel_id?: string | null;
          connection_id?: string;
          member?: { user?: { username?: string; display_name?: string } };
        };
        if (!v.user_id || v.user_id === botUserId) return;
        if (v.channel_id === cfg.voiceChannelId && v.connection_id !== grantConnectionId) {
          const name = v.member?.user?.display_name || v.member?.user?.username || v.user_id;
          roster.set(v.user_id, name);
        } else {
          roster.delete(v.user_id);
        }
        break;
      }
    }
  }

  function decodeKey(key: string): Uint8Array {
    // e2ee_key: key material string; treat hex as hex, else base64, else utf8.
    if (/^[0-9a-fA-F]+$/.test(key) && key.length % 2 === 0) {
      return Uint8Array.from(key.match(/../g)!.map((h) => parseInt(h, 16)));
    }
    try {
      return Uint8Array.from(Buffer.from(key, 'base64'));
    } catch {
      return Uint8Array.from(Buffer.from(key, 'utf8'));
    }
  }

  async function connectLiveKit(g: FluxerGrant): Promise<void> {
    if (room) {
      try {
        await room.disconnect();
      } catch {
        /* noop */
      }
      room = null;
    }
    for (const r of readers.values()) r.stop();
    readers.clear();

    // RoomOptions are passed to connect(), not the constructor
    const r = new Room();
    room = r;

    // ---- TX side ----
    const src = new AudioSource(48_000, 2);
    audioSource = src;
    const track = LocalAudioTrack.createAudioTrack('tribrid-mix', src);
    const pubOpts = new TrackPublishOptions();
    Object.assign(pubOpts, { source: TrackSource.SOURCE_MICROPHONE, name: 'tribrid-mix' });

    const outlet: Outlet = {
      id: 'fluxer',
      enabled: cfg.mode.out,
      accepts: (p) => p !== 'fluxer',
      onFrame(frame: Float32Array) {
        const st = r.connectionState;
        if (st !== ConnectionState.CONN_CONNECTED && st !== ConnectionState.CONN_RECONNECTING) return;
        if (src.queueSize > 10) return; // ~200ms backlog: drop to stay real-time
        void src.captureFrame(new AudioFrame(floatToInt16(frame), 48_000, 2, FRAME_SAMPLES));
      },
    };
    mixer.addOutlet(outlet);

    // ---- RX side ----
    r.on(RoomEvent.TrackSubscribed, (t, _pub, participant) => {
      if (t.kind !== TrackKind.KIND_AUDIO) return;
      const uid = participant.identity;
      const decKey = uid; // identity user_{id}_{conn}
      const srcStream = new AudioStream(t, 48_000, 2);
      const reader = srcStream.getReader();
      let stopped = false;
      const mixerSrc = mixer.createSource('fluxer', decKey);
      readers.set(`${participant.sid}:${t.sid}`, {
        src: mixerSrc,
        stop: () => {
          stopped = true;
          reader.cancel().catch(() => undefined);
          mixerSrc.stop();
        },
      });
      void (async () => {
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done || stopped) break;
          if (value) mixerSrc.push(pcm16ToFloatStereo(value.data)); // AudioFrame data is Int16Array @48k/2
        }
      })();
      dbg(TAG, `subscribed audio ${uid}`);
    });

    r.on(RoomEvent.TrackUnsubscribed, (_t, _pub, participant) => {
      const psid = participant.sid ?? '';
      for (const [k, v] of readers) {
        if (k.startsWith(`${psid}:`)) {
          v.stop();
          readers.delete(k);
        }
      }
    });

    r.on(RoomEvent.Disconnected, () => {
      warn(TAG, 'livekit disconnected');
      mixer.removeOutlet(outlet.id);
      audioSource = null;
      // request a fresh grant by re-joining voice (new connection id)
      if (!destroyed) setTimeout(joinVoice, 2_000);
    });
    r.on(RoomEvent.Reconnecting, () => dbg(TAG, 'livekit reconnecting'));
    r.on(RoomEvent.Reconnected, () => log(TAG, 'livekit reconnected'));

    const opts = {
      autoSubscribe: true,
      dynacast: false,
      ...(g.e2ee_key
        ? {
            encryption: {
              keyProviderOptions: { sharedKey: decodeKey(g.e2ee_key) },
            },
          }
        : {}),
    } as import('@livekit/rtc-node').RoomOptions;

    await r.connect(g.endpoint, g.token, opts);
    log(TAG, `livekit connected room=${r.name}`);
    const lp = r.localParticipant;
    if (lp) {
      publishPromise = lp
        .publishTrack(track, pubOpts)
        .then((p) => {
          log(TAG, `published mix track sid=${p.sid ?? '?'}`);
          return p;
        })
        .catch((e) => err(TAG, `publish failed: ${e instanceof Error ? e.message : e}`));
    }
  }

  function floatToInt16(frame: Float32Array): Int16Array {
    const buf = floatToS16(frame);
    return new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
  }

  async function postMessage(content: string): Promise<string | null> {
    if (!cfg.textChannelId) return null;
    const r = await fetch(`${api}/v1/channels/${cfg.textChannelId}/messages`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!r.ok) {
      warn(TAG, `postMessage ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
      return null;
    }
    const j = (await r.json().catch(() => null)) as { id?: string } | null;
    return j?.id ?? null;
  }

  async function deleteMessage(id: string): Promise<void> {
    if (!cfg.textChannelId) return;
    const r = await fetch(`${api}/v1/channels/${cfg.textChannelId}/messages/${id}`, {
      method: 'DELETE',
      headers: auth,
    });
    if (!r.ok) dbg(TAG, `deleteMessage ${r.status}`);
  }

  await connectGateway();

  return {
    roster: () => [...roster.entries()].map(([id, name]) => ({ id, name })),
    outletId: 'fluxer',
    postMessage,
    deleteMessage,
    destroy() {
      destroyed = true;
      if (hbTimer) clearInterval(hbTimer);
      mixer.removeOutlet('fluxer');
      for (const v of readers.values()) v.stop();
      readers.clear();
      void (async () => {
        try {
          await room?.disconnect();
        } catch {
          /* noop */
        }
        try {
          audioSource?.close();
        } catch {
          /* noop */
        }
        ws?.close();
      })();
    },
  };
}
