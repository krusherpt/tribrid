/**
 * Presence bridge: "people know there's people on the other platform."
 * Polls each leg's voice roster and posts a compact line into each leg's
 * text channel — once per change, throttled, replacing the previous line.
 * Text is best-effort: a leg without a text channel just gets no line.
 */
import { log, dbg } from './log.js';
import type { Platform } from './audio/engine.js';

export interface PresenceTarget {
  platform: Platform;
  post(text: string): Promise<string | null>; // returns message id for deletion
  del(id: string): Promise<void>;
}

export interface RosterProvider {
  platform: Platform;
  roster(): { id: string; name: string }[];
}

const THROTTLE_MS = 8_000;
const MAX_NAMES = 6;

function summarize(rosters: Map<Platform, { id: string; name: string }[]>): string {
  const parts: string[] = [];
  for (const [platform, users] of rosters) {
    const label = platform.charAt(0).toUpperCase() + platform.slice(1);
    if (users.length === 0) {
      parts.push(`${label}: —`);
    } else {
      const names = users.map((u) => u.name).slice(0, MAX_NAMES);
      const more = users.length > MAX_NAMES ? ` +${users.length - MAX_NAMES}` : '';
      parts.push(`${label}: ${users.length} (${names.join(', ')}${more})`);
    }
  }
  return `🔊 ${parts.join('  •  ')}`;
}

export class PresenceBridge {
  private lastSig = '';
  private lastPostAt = 0;
  private lastIds = new Map<Platform, string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private targets: PresenceTarget[],
    private providers: RosterProvider[],
    private intervalMs: number
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async deleteOld(platform: Platform) {
    const id = this.lastIds.get(platform);
    if (!id) return;
    const t = this.targets.find((x) => x.platform === platform);
    if (t) {
      try {
        await t.del(id);
      } catch {
        /* best effort: some instances deny bot message deletion */
      }
    }
    this.lastIds.delete(platform);
  }

  async tick(): Promise<void> {
    const rosters = new Map<Platform, { id: string; name: string }[]>();
    for (const p of this.providers) rosters.set(p.platform, p.roster());

    const sig = JSON.stringify(
      [...rosters.entries()].map(([p, u]) => [p, u.map((x) => x.id).sort()])
    );
    if (sig === this.lastSig) return; // no membership change

    const now = Date.now();
    if (now - this.lastPostAt < THROTTLE_MS && this.lastSig) {
      dbg('presence', `change debounced (${now - this.lastPostAt}ms)`);
      return;
    }

    const line = summarize(rosters);
    this.lastSig = sig;
    this.lastPostAt = now;
    log('presence', line);

    for (const t of this.targets) {
      await this.deleteOld(t.platform);
      try {
        const id = await t.post(line);
        if (id) this.lastIds.set(t.platform, id);
      } catch (e) {
        dbg('presence', `post to ${t.platform} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}
