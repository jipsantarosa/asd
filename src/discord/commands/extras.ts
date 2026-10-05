import { AttachmentBuilder, EmbedBuilder, InteractionContextType, SlashCommandBuilder, type Message } from 'discord.js';
import { GameError } from '../../services/context';
import { fetchCs2, fetchValorant, valoSummary } from '../../services/gameStats';
import { decodeImage, encodeGif, GIF_MAX_FRAMES, GIF_MAX_INPUT } from '../media/gif';
import { clean } from '../ui/theme';
import type { Command, CommandContext } from './types';

const num = (n: number) => n.toLocaleString('es-AR');
const t = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;

// ───────────────────────── !gif ─────────────────────────

const IMAGE_EXT = /\.(png|jpe?g)(\?|$)/i;

function imagesOf(m: Message | null): string[] {
  if (!m) return [];
  const files = [...m.attachments.values()].filter((a) => (a.contentType ?? '').match(/^image\/(png|jpe?g)/) || IMAGE_EXT.test(a.name)).map((a) => a.url);
  const embeds = m.embeds.map((e) => e.image?.url ?? e.thumbnail?.url).filter((u): u is string => !!u && IMAGE_EXT.test(u));
  return [...files, ...embeds];
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res?.ok) throw new GameError('No pude descargar la imagen.');
  if (Number(res.headers.get('content-length') ?? 0) > GIF_MAX_INPUT) throw new GameError('La imagen pesa demasiado (máximo 8 MB).');
  return Buffer.from(await res.arrayBuffer());
}

async function gifSources(c: CommandContext): Promise<string[]> {
  if (c.interaction) {
    const urls = ['imagen', 'imagen2', 'imagen3'].map((n) => c.interaction!.options.getAttachment(n)?.url).filter((u): u is string => !!u);
    const u = c.interaction.options.getUser('usuario');
    if (u) urls.push(u.displayAvatarURL({ extension: 'png', forceStatic: true, size: 512 }));
    return urls;
  }
  const own = imagesOf(c.message);
  if (own.length) return own;
  if (c.message?.reference?.messageId) {
    const ref = await c.message.fetchReference().catch(() => null);
    const fromReply = imagesOf(ref);
    if (fromReply.length) return fromReply;
  }
  const user = await c.user_('usuario', 0);
  return user ? [user.displayAvatarURL({ extension: 'png', forceStatic: true, size: 512 })] : [];
}

export const gifCmd: Command = {
  name: 'gif',
  aliases: ['togif', 'agif'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('gif').setDescription('🎞️ Convierte fotos (PNG o JPG) en GIF. Con varias, arma una animación.')
    .addAttachmentOption((o) => o.setName('imagen').setDescription('Foto PNG o JPG'))
    .addAttachmentOption((o) => o.setName('imagen2').setDescription('Otra foto (para animar)'))
    .addAttachmentOption((o) => o.setName('imagen3').setDescription('Otra foto (para animar)'))
    .addUserOption((o) => o.setName('usuario').setDescription('Usar el avatar de alguien')),
  async run(c) {
    const urls = (await gifSources(c)).slice(0, GIF_MAX_FRAMES);
    if (!urls.length) {
      throw new GameError(`Mandá \`${c.prefix}gif\` con una foto adjunta, respondiendo a un mensaje con una foto, o mencionando a alguien para usar su avatar. Con varias fotos (hasta ${GIF_MAX_FRAMES}) arma una animación.`);
    }
    await c.defer();
    const images = [];
    for (const u of urls) images.push(decodeImage(await download(u)));
    const gif = encodeGif(images);
    if (gif.length > 10 * 1024 * 1024) throw new GameError('El GIF quedó demasiado pesado para Discord. Probá con menos fotos.');
    await c.reply({
      content: images.length > 1 ? `🎞️ Listo: ${images.length} fotos en un GIF animado.` : '🎞️ Listo, acá está tu GIF.',
      files: [new AttachmentBuilder(gif, { name: 'convertido.gif' })],
    });
  },
};

// ───────────────────────── !uservalo ─────────────────────────

const NEED_HENRIK = 'Para ver estadísticas de Valorant falta la clave de la API. El dueño del bot tiene que conseguir una gratis en el Discord de **HenrikDev** (https://docs.henrikdev.xyz) y ponerla en el `.env` como `HENRIK_API_KEY=...`.';
const NEED_STEAM = 'Para ver estadísticas de CS2 falta la clave de Steam. El dueño del bot la saca gratis en https://steamcommunity.com/dev/apikey y la pone en el `.env` como `STEAM_API_KEY=...`.';

export const valoCmd: Command = {
  name: 'uservalo',
  aliases: ['valo', 'valorant', 'val'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('uservalo').setDescription('🎯 Estadísticas de Valorant de un Riot ID (Nombre#TAG).')
    .addStringOption((o) => o.setName('riot_id').setDescription('Por ejemplo TenZ#0505').setRequired(true).setMaxLength(24)),
  async run(c) {
    const raw = c.text('riot_id', 0);
    if (!raw) throw new GameError(`Uso: \`${c.prefix}uservalo Nombre#TAG\`.`);
    const key = process.env.HENRIK_API_KEY?.trim();
    if (!key) throw new GameError(NEED_HENRIK);
    await c.defer();
    const p = await fetchValorant(raw, key);
    const s = valoSummary(p.matches);
    const e = new EmbedBuilder()
      .setColor(0xfd4556)
      .setAuthor({ name: `${p.name}#${p.tag}`, iconURL: p.rankImage ?? undefined })
      .setTitle('🎯 Valorant')
      .addFields(
        { name: 'Nivel', value: num(p.level), inline: true },
        { name: 'Región', value: p.region.toUpperCase(), inline: true },
        { name: 'Rango', value: p.rank ? `${p.rank}${p.rr !== null ? ` · ${p.rr} RR` : ''}` : 'Sin rango', inline: true },
        ...(p.peak ? [{ name: 'Mejor rango', value: p.peak, inline: true }] : []),
      );
    if (s.played) {
      e.addFields(
        { name: `Últimas ${s.played} partidas`, value: `**${s.wins}** ganadas · K/D **${s.kd}** · HS **${s.hs ?? '—'}%**\n${num(s.kills)} / ${num(s.deaths)} / ${num(s.assists)} (K/D/A)` },
        {
          name: 'Partidas',
          value: p.matches.map((m) => `${m.won === null ? '▫️' : m.won ? '🟢' : '🔴'} **${clean(m.agent)}** · ${clean(m.map)} · ${clean(m.mode)} · ${m.kills}/${m.deaths}/${m.assists}${m.startedAt ? ` · ${t(m.startedAt)}` : ''}`).join('\n').slice(0, 1024),
        },
      );
    }
    if (p.card) e.setImage(p.card);
    e.setFooter({ text: 'Datos de la API de HenrikDev (no oficial de Riot).' });
    await c.reply({ embeds: [e] });
  },
};

// ───────────────────────── !cs2 ─────────────────────────

export const cs2Cmd: Command = {
  name: 'cs2',
  aliases: ['cs', 'csgo', 'counter'],
  prefix: true,
  data: new SlashCommandBuilder().setContexts(InteractionContextType.Guild).setName('cs2').setDescription('🔫 Estadísticas de CS2 de un perfil de Steam.')
    .addStringOption((o) => o.setName('steam').setDescription('Enlace del perfil, SteamID64 o nombre personalizado').setRequired(true).setMaxLength(120)),
  async run(c) {
    const raw = c.text('steam', 0);
    if (!raw) throw new GameError(`Uso: \`${c.prefix}cs2 <enlace de tu perfil de Steam>\`.`);
    const key = process.env.STEAM_API_KEY?.trim();
    if (!key) throw new GameError(NEED_STEAM);
    await c.defer();
    const p = await fetchCs2(raw, key);
    const s = p.stats;
    const e = new EmbedBuilder()
      .setColor(0xde9b35)
      .setAuthor({ name: p.name, iconURL: p.avatar ?? undefined, url: p.url })
      .setTitle('🔫 Counter-Strike 2')
      .setThumbnail(p.avatar)
      .addFields(
        { name: 'K/D', value: `**${s.kd}** (${num(s.kills)} / ${num(s.deaths)})`, inline: true },
        { name: 'Headshots', value: `${s.headshotPct}%`, inline: true },
        { name: 'Precisión', value: `${s.accuracyPct}%`, inline: true },
        { name: 'Horas jugadas', value: num(s.hours), inline: true },
        { name: 'Partidas ganadas', value: `${num(s.matchesWon)}${s.winPct !== null ? ` (${s.winPct}%)` : ''}`, inline: true },
        { name: 'MVPs', value: num(s.mvps), inline: true },
      )
      .setFooter({ text: 'Estadísticas totales que publica Steam (necesita el perfil y los detalles del juego en público).' });
    await c.reply({ embeds: [e] });
  },
};

export const EXTRA_COMMANDS = [gifCmd, valoCmd, cs2Cmd];
