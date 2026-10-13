/**
 * Thin text posting used by the presence bridge (and future commands):
 *  - Discord: channel.send / message.delete via discord.js
 *  - Haven:   POST /api/webhooks/<token> (presence line is a webhook msg;
 *             deletion needs the same webhook: DELETE .../messages/<id>)
 *  - Fluxer:  POST /v1/channels/{id}/messages via the leg's bot token
 */
import type { DiscordLeg } from './legs/discord.js';
import type { HavenLeg } from './legs/haven.js';
import type { FluxerLeg } from './legs/fluxer.js';

interface Deps {
  discord: DiscordLeg | null;
  haven: HavenLeg | null;
  fluxer: FluxerLeg | null;
}

export class TextBridge {
  private havenToken?: string;
  private havenUrl?: string;

  constructor(private deps: Deps, havenCfg?: { url: string; botToken: string }) {
    if (havenCfg) {
      this.havenUrl = havenCfg.url;
      this.havenToken = havenCfg.botToken;
    }
  }

  configureHaven(url: string, botToken: string): void {
    this.havenUrl = url;
    this.havenToken = botToken;
  }

  async postDiscord(text: string): Promise<string | null> {
    const d = this.deps.discord;
    if (!d) return null;
    // text channel id is resolved inside the discord leg config; exposed via client
    const client = d.client;
    const chanId = (d as unknown as { textChannelId?: string }).textChannelId;
    if (!chanId) return null;
    const ch = await client.channels.fetch(chanId).catch(() => null);
    if (!ch || !('send' in ch)) return null;
    const msg = await (ch as { send: (o: { content: string }) => Promise<{ id: string }> }).send({ content: text });
    return msg.id;
  }

  async deleteDiscord(id: string): Promise<void> {
    const d = this.deps.discord;
    if (!d) return;
    const chanId = (d as unknown as { textChannelId?: string }).textChannelId;
    if (!chanId) return;
    const ch = await d.client.channels.fetch(chanId).catch(() => null);
    if (!ch || !('messages' in ch)) return;
    await (ch as { messages: { delete: (id: string) => Promise<unknown> } }).messages.delete(id).catch(() => undefined);
  }

  async postHaven(text: string): Promise<string | null> {
    if (!this.havenUrl || !this.havenToken) return null;
    const r = await fetch(`${this.havenUrl}/api/webhooks/${this.havenToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    });
    if (!r.ok) throw new Error(`haven webhook ${r.status}`);
    const j = (await r.json()) as { message_id?: number };
    return j.message_id != null ? String(j.message_id) : null;
  }

  async deleteHaven(id: string): Promise<void> {
    if (!this.havenUrl || !this.havenToken) return;
    await fetch(`${this.havenUrl}/api/webhooks/${this.havenToken}/messages/${id}`, { method: 'DELETE' }).catch(
      () => undefined
    );
  }

  async postFluxer(text: string): Promise<string | null> {
    const f = this.deps.fluxer;
    if (!f) return null;
    return f.postMessage(text);
  }

  async deleteFluxer(id: string): Promise<void> {
    await this.deps.fluxer?.deleteMessage(id);
  }
}
