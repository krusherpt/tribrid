/**
 * Discord leg — joins via @discordjs/voice.
 * RX: receiver.subscribe() per speaker -> Opus -> float -> mixer source.
 * TX: mixer outlet -> Opus encode -> AudioResource per 20 ms frame.
 */
import {
  Client,
  GatewayIntentBits,
  type VoiceBasedChannel,
} from 'discord.js';
import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  VoiceConnectionDisconnectReason,
  entersState,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  NoSubscriberBehavior,
  EndBehaviorType,
  type VoiceConnection,
  type AudioResource,
} from '@discordjs/voice';
import type { Mixer, Outlet } from '../audio/engine.js';
import { makeDecoder, makeEncoder, floatToS16, pcm16ToFloatStereo, type Decoder } from '../audio/codec.js';
import type { LegMode } from '../config.js';
import { log } from '../log.js';

const TAG = 'discord';

export interface DiscordLeg {
  client: Client;
  roster(): { id: string; name: string }[];
  setVoiceWanted(w: boolean): void;
  outletId: string;
  textChannelId?: string;
  destroy(): void;
}

interface Sub {
  stream: NodeJS.ReadableStream & { destroy?: () => void };
  src: ReturnType<Mixer['createSource']>;
  dec: Decoder;
}

export async function startDiscordLeg(
  cfg: { token: string; guildId: string; voiceChannelId: string; textChannelId?: string; mode: LegMode },
  mixer: Mixer,
  onRosterChanged?: () => void
): Promise<DiscordLeg> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  const subs = new Map<string, Sub>();
  const roster = new Map<string, string>(); // userId -> display name
  let connection: VoiceConnection | null = null;
  const outletTimers: ReturnType<typeof setInterval>[] = [];
  let destroyed = false;
  let voiceWanted = true;

  const decoderCache = new Map<string, Decoder>();
  const getDecoder = (id: string): Decoder => {
    let d = decoderCache.get(id);
    if (!d) {
      d = makeDecoder();
      decoderCache.set(id, d);
    }
    return d;
  };

  const ensureSub = (userId: string) => {
    if (subs.has(userId) || !cfg.mode.in) return;
    if (!connection) return;
    const src = mixer.createSource('discord', userId);
    const dec = getDecoder(userId);
    const stream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });
    stream.on('data', (opus: Buffer) => {
      const pcm = dec.decode(opus);
      if (pcm && pcm.length > 0) src.push(pcm16ToFloatStereo(pcm));
    });
    subs.set(userId, { stream, src, dec });
  };

  const dropSub = (userId: string) => {
    const s = subs.get(userId);
    if (!s) return;
    try {
      s.stream.destroy?.();
    } catch {
      /* already gone */
    }
    s.src.stop();
    subs.delete(userId);
  };

  const wireReceiver = (conn: VoiceConnection) => {
    conn.receiver.ssrcMap.on('create', (data: { userId: string }) => ensureSub(data.userId));
    conn.receiver.ssrcMap.on('update', (_old: unknown, data: { userId: string }) => ensureSub(data.userId));
    conn.receiver.ssrcMap.on('delete', (data: { userId: string }) => dropSub(data.userId));
    // SSRCs can be discovered before this wiring runs (users already talking
    // when we went ready, or reconnection) — sweep the existing map too.
    const raw = (conn.receiver.ssrcMap as unknown as { map?: Map<number, { userId?: string }> }).map;
    if (raw) for (const entry of raw.values()) if (entry.userId) ensureSub(entry.userId);
  };

  // ---- TX outlet ----
  const enc = makeEncoder(64_000);
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });
  // One long-lived Opus resource fed from the mixer clock (object-mode
  // Readable of Opus packets). Pacing = the mixer's own 20 ms tick, which is
  // real time. While no remote audio is present we send silence keepalives
  // every ~1.5 s (DTX-like) so the wire idles and the bot's speaking
  // indicator behaves.
  const { Readable } = await import('node:stream');
  const opusStream = new Readable({ objectMode: true, read() {} });
  const resource: AudioResource = createAudioResource(opusStream, {
    inputType: StreamType.Opus,
    inlineVolume: false,
  });
  player.play(resource);
  const SILENCE = Buffer.from([0xf8, 0xff, 0xfe]); // opus "silence" packet
  let silentTicks = 0;
  let dbgFrames = 0;
  let dbgActive = 0;
  let dbgPushed = 0;
  const dbgOutlet = setInterval(() => {
    if (dbgFrames) {
      log(TAG, `outlet 30s: frames=${dbgFrames} active=${dbgActive} pushed=${dbgPushed} player=${player.state.status} conn=${connection?.state.status ?? 'none'}`);
      dbgFrames = dbgActive = dbgPushed = 0;
    }
  }, 30_000);
  outletTimers.push(dbgOutlet);
  const outlet: Outlet = {
    id: 'discord',
    enabled: cfg.mode.out,
    accepts: (p) => p !== 'discord',
    onFrame(frame: Float32Array, active: boolean) {
      dbgFrames++;
      if (!connection || connection.state.status !== 'ready') return;
      if (active) {
        dbgActive++;
        silentTicks = 0;
        opusStream.push(enc.encode(floatToS16(frame)));
        dbgPushed++;
      } else if (++silentTicks >= 75) {
        silentTicks = 0;
        opusStream.push(SILENCE);
        dbgPushed++;
      }
    },
  };
  mixer.addOutlet(outlet);
  player.on('error', (e) => log(TAG, `player error: ${e.message}`));
  player.on('stateChange', (o, n) => log(TAG, `player state ${o.status} -> ${n.status}`));

  const connectChannel = (channel: VoiceBasedChannel) => {
    // selfDeaf:false is required or the receiver gets no audio at all.
    const conn = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      // discord.js >= 14.25 exposes the adapter on the guild (channel.adapterCreator was removed).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adapterCreator: (channel.guild as any).voiceAdapterCreator ?? (channel as any).adapterCreator,
      selfDeaf: false,
      selfMute: true, // we have no mic; playback still works
    });
    connection = conn;
    conn.subscribe(player);
    wireReceiver(conn);

    conn.on('stateChange', async (oldState, newState) => {
      log(TAG, `state ${oldState.status} -> ${newState.status}`);
      if (
        newState.status === 'disconnected' &&
        !destroyed &&
        // app-side channel delete / kick are handled by the poll loop too
        (newState.reason === VoiceConnectionDisconnectReason.WebSocketClose ||
          newState.reason === VoiceConnectionDisconnectReason.AdapterUnavailable)
      ) {
        try {
          await Promise.race([
            entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
            entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          conn.destroy();
          connection = null;
        }
      }
    });

    entersState(conn, VoiceConnectionStatus.Ready, 20_000)
      .then(() => log(TAG, 'voice ready'))
      .catch(() => log(TAG, 'warn: voice not ready in 20s'));
  };

  // Roster via gateway voice state events (works even when we are deaf-ish)
  client.on('voiceStateUpdate', (oldState, newState) => {
    const userId = (newState.id ?? oldState.id) as string;
    const name = newState.member?.displayName ?? oldState.member?.displayName ?? userId;
    const inOurChannel = (s: typeof newState) =>
      s.channelId !== null && s.channelId === cfg.voiceChannelId && !s.member?.user.bot;
    const before = roster.size;
    if (inOurChannel(newState)) {
      roster.set(userId, name);
    } else if (oldState.channelId === cfg.voiceChannelId) {
      roster.delete(userId);
    }
    if (roster.size !== before) onRosterChanged?.();
  });

  // Periodic self-heal: (re)join when the voice channel exists and we are not in it.
  const joinLoop = setInterval(async () => {
    if (destroyed || !voiceWanted) return;
    if (connection && connection.state.status !== 'destroyed') return;
    try {
      const guild = client.guilds.cache.get(cfg.guildId);
      const channel = guild?.channels.cache.get(cfg.voiceChannelId) as VoiceBasedChannel | undefined;
      if (!channel?.isVoiceBased()) return; // channel empty-missing / wrong type / deleted
      // Join when anyone human is present (the whole point: connect only when
      // someone is on this side so the room is not occupied by an idle bot).
      const humans = (channel.members?.size ?? 0) > 0 || roster.size > 0;
      if (!humans) return;
      log(TAG, 'joining voice channel');
      connectChannel(channel);
    } catch (e) {
      log(TAG, `join attempt failed: ${e instanceof Error ? e.message : e}`);
    }
  }, 10_000);

  await client.login(cfg.token);
  log(TAG, `gateway ready as ${client.user?.tag ?? '?'}`);

  return {
    client,
    roster: () => [...roster.entries()].map(([id, name]) => ({ id, name })),
    setVoiceWanted(w: boolean) {
      if (w === voiceWanted) return;
      voiceWanted = w;
      if (!w && connection && connection.state.status !== 'destroyed') {
        log(TAG, 'nobody to bridge — leaving voice');
        try {
          connection.destroy();
        } catch {
          /* ignore */
        }
        connection = null;
      }
    },
    outletId: outlet.id,
    textChannelId: cfg.textChannelId,
    destroy() {
    for (const t of outletTimers) clearInterval(t);
      destroyed = true;
      clearInterval(joinLoop);
      mixer.removeOutlet(outlet.id);
      for (const id of [...subs.keys()]) dropSub(id);
      try {
        connection?.destroy();
      } catch {
        /* noop */
      }
      client.destroy();
    },
  };
}
