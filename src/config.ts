import { z } from 'zod';
import 'dotenv/config';

const bool = (v: unknown) => v === '1' || v === 'true';

const IceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
  /** coturn --use-auth-secret: bridge mints Haven-style time-limited creds */
  authSecret: z.string().optional(),
});

/**
 * Config is deliberately flat and env-driven so the same .env works for
 * docker, pm2, and a bare `node dist/index.js`.
 *
 * A leg is ENABLED only when its required keys are all present; partial
 * config logs a warning and skips the leg (community-testing friendly).
 */
const EnvSchema = z.object({
  // ---- Discord ----
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),
  DISCORD_VOICE_CHANNEL_ID: z.string().optional(),
  /** Text channel for presence announcements (optional) */
  DISCORD_TEXT_CHANNEL_ID: z.string().optional(),
  /** 'in' = others hear Discord, 'out' = Discord users hear others, 'both' (default), 'off' */
  DISCORD_BRIDGE: z.enum(['in', 'out', 'both', 'off']).default('both'),

  // ---- Haven ----
  HAVEN_URL: z.string().optional(), // e.g. https://haven.example.com
  HAVEN_BOT_TOKEN: z.string().optional(), // webhook token with can_use_voice
  HAVEN_CHANNEL_CODE: z.string().optional(), // 8-hex channel code of the voice channel
  HAVEN_TEXT_CHANNEL_CODE: z.string().optional(),
  /**
   * Haven's /api/ice-servers requires a USER session token (401 for bots),
   * so the bridge must be told ICE servers directly. JSON array:
   * [{"urls":["stun:..."]},{"urls":["turn:..."],"username":"u","credential":"p"}]
   * Copy them from the Haven admin's Settings → Voice & Connectivity.
   */
  HAVEN_ICE_SERVERS_JSON: z.string().optional(),
  HAVEN_BRIDGE: z.enum(['in', 'out', 'both', 'off']).default('both'),

  // ---- Fluxer ----
  FLUXER_URL: z.string().optional(), // instance base, e.g. https://fluxer.example.com
  FLUXER_BOT_TOKEN: z.string().optional(),
  FLUXER_VOICE_CHANNEL_ID: z.string().optional(),
  FLUXER_GUILD_ID: z.string().optional(), // omit for a DM call
  FLUXER_TEXT_CHANNEL_ID: z.string().optional(),
  FLUXER_BRIDGE: z.enum(['in', 'out', 'both', 'off']).default('both'),

  // ---- presence bridge ----
  PRESENCE_ENABLED: z.string().optional(),
  PRESENCE_INTERVAL_S: z.coerce.number().int().min(10).default(30),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
  authSecret?: string;
}

export interface LegMode {
  in: boolean;
  out: boolean;
}

function legMode(v: 'in' | 'out' | 'both' | 'off'): LegMode {
  return { in: v === 'in' || v === 'both', out: v === 'out' || v === 'both' };
}

export interface BridgeConfig {
  discord?: {
    token: string;
    guildId: string;
    voiceChannelId: string;
    textChannelId?: string;
    mode: LegMode;
  };
  haven?: {
    url: string;
    botToken: string;
    channelCode: string;
    textChannelCode?: string;
    iceServers: IceServer[];
    mode: LegMode;
  };
  fluxer?: {
    url: string;
    botToken: string;
    voiceChannelId: string;
    guildId?: string;
    textChannelId?: string;
    mode: LegMode;
  };
  presence: { enabled: boolean; intervalMs: number };
  logLevel: string;
}

export function loadConfig(): { config: BridgeConfig; warnings: string[] } {
  const env = EnvSchema.parse(process.env);
  const warnings: string[] = [];
  const config: BridgeConfig = {
    presence: { enabled: bool(env.PRESENCE_ENABLED ?? '1'), intervalMs: env.PRESENCE_INTERVAL_S * 1000 },
    logLevel: env.LOG_LEVEL,
  };

  if (env.DISCORD_BOT_TOKEN && env.DISCORD_GUILD_ID && env.DISCORD_VOICE_CHANNEL_ID) {
    config.discord = {
      token: env.DISCORD_BOT_TOKEN,
      guildId: env.DISCORD_GUILD_ID,
      voiceChannelId: env.DISCORD_VOICE_CHANNEL_ID,
      textChannelId: env.DISCORD_TEXT_CHANNEL_ID,
      mode: legMode(env.DISCORD_BRIDGE),
    };
  } else if (env.DISCORD_BOT_TOKEN) {
    warnings.push('Discord: DISCORD_BOT_TOKEN set but GUILD_ID/VOICE_CHANNEL_ID missing — leg disabled');
  }

  if (env.HAVEN_URL && env.HAVEN_BOT_TOKEN && env.HAVEN_CHANNEL_CODE) {
    let iceServers: IceServer[] = [];
    if (env.HAVEN_ICE_SERVERS_JSON) {
      try {
        iceServers = z.array(IceServerSchema).parse(JSON.parse(env.HAVEN_ICE_SERVERS_JSON)).map((s) => ({
          ...s,
          urls: Array.isArray(s.urls) ? s.urls : [s.urls],
        }));
      } catch (e) {
        warnings.push(`Haven: HAVEN_ICE_SERVERS_JSON invalid (${e instanceof Error ? e.message : e}) — STUN-only`);
      }
    } else {
      warnings.push(
        'Haven: no HAVEN_ICE_SERVERS_JSON — peers outside the bridge\'s network may not connect (copy the admin\'s STUN/TURN into the bridge config)'
      );
    }
    config.haven = {
      url: env.HAVEN_URL.replace(/\/$/, ''),
      botToken: env.HAVEN_BOT_TOKEN,
      channelCode: env.HAVEN_CHANNEL_CODE,
      textChannelCode: env.HAVEN_TEXT_CHANNEL_CODE,
      iceServers,
      mode: legMode(env.HAVEN_BRIDGE),
    };
  } else if (env.HAVEN_URL) {
    warnings.push('Haven: HAVEN_URL set but bot token/channel code missing — leg disabled');
  }

  if (env.FLUXER_URL && env.FLUXER_BOT_TOKEN && env.FLUXER_VOICE_CHANNEL_ID) {
    config.fluxer = {
      url: env.FLUXER_URL.replace(/\/$/, ''),
      botToken: env.FLUXER_BOT_TOKEN,
      voiceChannelId: env.FLUXER_VOICE_CHANNEL_ID,
      guildId: env.FLUXER_GUILD_ID,
      textChannelId: env.FLUXER_TEXT_CHANNEL_ID,
      mode: legMode(env.FLUXER_BRIDGE),
    };
  } else if (env.FLUXER_URL) {
    warnings.push('Fluxer: FLUXER_URL set but token/channel missing — leg disabled');
  }

  const active = [config.discord && 'discord', config.haven && 'haven', config.fluxer && 'fluxer'].filter(Boolean);
  if (active.length < 2) {
    warnings.push(`Only ${active.length} leg(s) configured (${active.join(', ') || 'none'}). The bridge is useful with >= 2.`);
  }
  return { config, warnings };
}
