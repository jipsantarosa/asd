import type { EmbedBuilder, Guild } from 'discord.js';
import { finishTournament, getTournament, startTournament, type FinishResult, type Tournament } from '../../casino/tournaments';
import { getSettings } from '../../services/guildSettings';
import { logger } from '../../logger';
import type { App } from '../app';
import { finishedEmbed, startedEmbed } from './ui/tournaments';

/** Envía un anuncio al canal de anuncios del casino de cada servidor que lo configuró. */
export async function announceEverywhere(app: App, build: (guild: Guild) => EmbedBuilder | Promise<EmbedBuilder>): Promise<number> {
  const rows = app.ctx.db.all<{ guild_id: string; announce_channel_id: string }>('SELECT guild_id, announce_channel_id FROM casino_guild_settings WHERE announce_channel_id IS NOT NULL');
  let sent = 0;
  for (const r of rows) {
    const guild = app.client.guilds.cache.get(r.guild_id);
    const ch = guild?.channels.cache.get(r.announce_channel_id);
    if (!guild || !ch?.isTextBased() || !ch.isSendable()) continue;
    try {
      await ch.send({ embeds: [await build(guild)], allowedMentions: { parse: [] } });
      sent += 1;
    } catch (err) {
      logger.warn(`No pude anunciar en ${r.guild_id}:`, err instanceof Error ? err.message : err);
    }
  }
  return sent;
}

export async function announceStart(app: App, t: Tournament): Promise<void> {
  await announceEverywhere(app, (g) => startedEmbed(t, getSettings(app.ctx, g.id).prefix));
}

export async function announceFinish(app: App, r: FinishResult): Promise<void> {
  await announceEverywhere(app, (g) => finishedEmbed(app, g, r.tournament, r.winners, r.participants));
}

/** Cierra un torneo, reparte premios y lo anuncia (los automáticos solo se anuncian si alguien jugó). */
export async function closeAndAnnounce(app: App, id: number): Promise<FinishResult | null> {
  const r = finishTournament(app.ctx, id);
  if (r && (r.tournament.kind === 'special' || r.participants > 0)) await announceFinish(app, r);
  return r;
}

/** Inicia (ya) un torneo y lo anuncia si es especial. */
export async function startAndAnnounce(app: App, id: number): Promise<Tournament> {
  const t = startTournament(app.ctx, id, true);
  if (t.kind === 'special') await announceStart(app, t);
  return getTournament(app.ctx, id)!;
}
