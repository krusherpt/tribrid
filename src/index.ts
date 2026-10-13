import { loadConfig } from './config.js';
import { setLogLevel, log, warn, err } from './log.js';
import { Mixer, type Platform } from './audio/engine.js';
import { codecBackend } from './audio/codec.js';
import { startDiscordLeg, type DiscordLeg } from './legs/discord.js';
import { startHavenLeg, type HavenLeg } from './legs/haven.js';
import { startFluxerLeg, type FluxerLeg } from './legs/fluxer.js';
import { PresenceBridge, type PresenceTarget, type RosterProvider } from './presence.js';
import { TextBridge } from './text.js';

async function main(): Promise<void> {
  const { config, warnings } = loadConfig();
  setLogLevel(config.logLevel);
  for (const w of warnings) warn('config', w);
  log('main', `opus backend: ${codecBackend}`);

  const mixer = new Mixer();
  mixer.start();
  log('main', 'mixer clock running (48kHz stereo, 20ms frames)');

  const legs: { platform: Platform; destroy(): void }[] = [];

  let discord: DiscordLeg | null = null;
  if (config.discord) {
    try {
      discord = await startDiscordLeg(config.discord, mixer, () => presenceTick());
      mixer.enabledSrc.discord = config.discord.mode.in;
      legs.push({ platform: 'discord', destroy: () => discord!.destroy() });
    } catch (e) {
      err('discord', `leg failed to start: ${e instanceof Error ? e.stack ?? e.message : e}`);
    }
  }

  let haven: HavenLeg | null = null;
  if (config.haven) {
    try {
      haven = await startHavenLeg(config.haven, mixer, () => presenceTick());
      mixer.enabledSrc.haven = config.haven.mode.in;
      legs.push({ platform: 'haven', destroy: () => haven!.destroy() });
    } catch (e) {
      err('haven', `leg failed to start: ${e instanceof Error ? e.stack ?? e.message : e}`);
    }
  }

  let fluxer: FluxerLeg | null = null;
  if (config.fluxer) {
    try {
      fluxer = await startFluxerLeg(config.fluxer, mixer);
      mixer.enabledSrc.fluxer = config.fluxer.mode.in;
      legs.push({ platform: 'fluxer', destroy: () => fluxer!.destroy() });
    } catch (e) {
      err('fluxer', `leg failed to start: ${e instanceof Error ? e.stack ?? e.message : e}`);
    }
  }

  // ── Opportunistic voice: join when anyone is on ANY side, leave when empty ──
  // Haven voice events only reach the bot *while it is in the voice room*
  // (server emits to the room, and bot-sockets are excluded from channel-level
  // broadcasts), so when the Haven side looks empty we periodically "probe"
  // by joining briefly; existing-users either keeps us or we hop back out.
  const GRACE_MS = 90_000;
  const PROBE_MS = 120_000;
  let havenSeen = 0;
  let discordSeen = 0;
  let lastProbe = Date.now();
  let lastActSig = '';
  function updateActivities(): void {
    const dUsers = discord ? discord.roster() : [];
    const hUsers = haven ? haven.roster() : [];
    const sig = [dUsers, hUsers].map((u) => u.map((x) => x.id).sort().join()).join('|');
    if (sig === lastActSig) return;
    lastActSig = sig;
    const fmt = (users: { name: string }[], other: string) =>
      users.length === 0
        ? `waiting for ${other}`
        : `${users.length} on ${other}` +
          (users.length <= 3 ? `: ${users.map((u) => u.name).join(', ')}` : '');
    // each side advertises WHO IS ON THE OTHER side (never its own roster)
    discord?.setActivity(haven ? fmt(hUsers, 'Haven') : '');
    haven?.setPresenceText(discord ? fmt(dUsers, 'Discord') : '');
  }

  function presenceTick(): void {
    updateActivities();
    const now = Date.now();
    const dh = discord ? discord.roster().length : 0;
    const hv = haven ? haven.roster().length : 0;
    if (dh > 0) discordSeen = now;
    if (hv > 0) havenSeen = now;
    if (!discord || !haven) return; // single-leg: nothing to bridge
    // Symmetric rule: a human on EITHER side (or seen within the grace
    // window) keeps BOTH legs parked. Nobody anywhere for GRACE_MS → both
    // leave. (Earlier asymmetric rules left the moment a room emptied.)
    const lastHuman = Math.max(discordSeen, havenSeen);
    const wantVoice = dh > 0 || hv > 0 || now - lastHuman < GRACE_MS;
    discord.setVoiceWanted(wantVoice);
    if (!wantVoice && now - lastProbe > PROBE_MS && now - havenSeen > GRACE_MS) {
      lastProbe = now;
      haven.setVoiceWanted(true); // brief probe; next tick decides to stay or leave
      return;
    }
    haven.setVoiceWanted(wantVoice);
  }
  const presenceTimer = setInterval(() => {
    presenceTick();
    lastActSig = ''; // periodic re-sync (presence can be reset by reconnects)
  }, 6_000);
  setTimeout(presenceTick, 2_000);

  if (legs.length === 0) {
    err('main', 'no legs started — check config, exiting');
    mixer.stop();
    process.exit(1);
  }

  log('main', `legs up: ${legs.map((l) => l.platform).join(', ')}`);

  // ---- presence + optional text bridge ----
  const text = new TextBridge(
    { discord, haven, fluxer },
    config.haven ? { url: config.haven.url, botToken: config.haven.botToken } : undefined
  );
  const providers: RosterProvider[] = [
    ...(discord ? [{ platform: 'discord' as Platform, roster: () => discord!.roster() }] : []),
    ...(haven ? [{ platform: 'haven' as Platform, roster: () => haven!.roster() }] : []),
    ...(fluxer ? [{ platform: 'fluxer' as Platform, roster: () => fluxer!.roster() }] : []),
  ];
  const targets: PresenceTarget[] = [];
  if (discord && config.discord?.textChannelId)
    targets.push({ platform: 'discord', post: (t) => text.postDiscord(t), del: (id) => text.deleteDiscord(id) });
  if (haven && config.haven?.textChannelCode)
    targets.push({ platform: 'haven', post: (t) => text.postHaven(t), del: (id) => text.deleteHaven(id) });
  if (fluxer && config.fluxer?.textChannelId)
    // Fluxer webhooks aren't exposed to bots yet; lines stack there (delete
    // via REST is a follow-up). Set PRESENCE_ENABLED=0 to silence.
    targets.push({ platform: 'fluxer', post: (t) => text.postFluxer(t), del: (id) => text.deleteFluxer(id) });

  const presence = new PresenceBridge(targets, providers, config.presence.intervalMs);
  if (config.presence.enabled && targets.length > 0) presence.start();

  // periodic stats
  const statsTimer = setInterval(() => {
    const s = mixer.stats();
    if (s.streams > 0) log('mixer', `streams=${s.streams} dropped=${JSON.stringify(s.droppedPerStream)}`);
  }, 60_000);

  const shutdown = (sig: string) => {
    log('main', `shutting down (${sig})`);
    presence.stop();
    clearInterval(statsTimer);
    mixer.stop();
    for (const l of legs) {
      try {
        l.destroy();
      } catch (e) {
        err(l.platform, `destroy: ${e instanceof Error ? e.message : e}`);
      }
    }
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (r) => err('main', `unhandledRejection: ${r}`));
}

main().catch((e) => {
  err('main', e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
