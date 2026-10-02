import { ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { fairSummaryOf, type Round } from '../../../casino/engine';
import { activeSeed, rngFor, seedById, sha256 } from '../../../casino/rng';
import type { GameContext } from '../../../services/context';
import { row, type Panel, type Viewer } from '../../app';
import { cid } from '../../ui/ids';
import { COLORS, coins, mult, rel } from '../../ui/theme';
import { gameLabel } from '../format';

const HOW = [
  '**Cómo funciona:** cada ronda usa `HMAC-SHA256(semilla_servidor, "semilla_cliente:nonce:bloque")`.',
  'Cada bloque da 8 números de 32 bits; cada número ÷ 2³² es un azar entre 0 y 1. Las mezclas (cartas, minas, torre) usan Fisher-Yates con esos números.',
  'La semilla del servidor es secreta mientras está activa, pero su **hash** se publica antes de jugar: no se puede cambiar sin que se note.',
];

export function fairnessPanel(ctx: GameContext, v: Viewer, notice?: string): Panel {
  const seed = activeSeed(ctx, v.userId);
  const revealed = ctx.db.all<{ id: number; server_seed: string; server_seed_hash: string; client_seed: string; nonce: number; revealed_at: number }>(
    'SELECT id, server_seed, server_seed_hash, client_seed, nonce, revealed_at FROM casino_seeds WHERE user_id = ? AND active = 0 ORDER BY id DESC LIMIT 2', v.userId,
  );
  const e = new EmbedBuilder()
    .setColor(COLORS.help)
    .setAuthor({ name: `Juego justo · ${v.name}`, iconURL: v.avatar })
    .setTitle('🔐 Azar verificable')
    .setDescription([
      ...(notice ? [notice, ''] : []),
      `**Hash de la semilla del servidor (activa):**\n\`${seed.serverSeedHash}\``,
      `**Semilla del cliente:** \`${seed.clientSeed}\` · **próximo nonce:** \`${seed.nonce}\``,
      '',
      ...HOW,
      '',
      revealed.length ? '**Semillas reveladas:**' : '-# Rotá la semilla para revelar la actual y poder verificar tus rondas.',
      ...revealed.map((r) => `\`${r.server_seed}\`\n-# hash ${r.server_seed_hash.slice(0, 16)}… · cliente \`${r.client_seed}\` · ${r.nonce} rondas · revelada ${rel(r.revealed_at)}`),
    ].join('\n'));
  return {
    embeds: [e],
    components: [row(
      new ButtonBuilder().setCustomId(cid('cl', 'fair', v.userId, 'rotate')).setLabel('Rotar semilla').setEmoji('🔄').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(cid('cl', 'fair', v.userId, 'client')).setLabel('Semilla del cliente').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(cid('cl', 'fair', v.userId, 'verify')).setLabel('Verificar ronda').setEmoji('🔍').setStyle(ButtonStyle.Secondary),
    )],
  };
}

/** Verificación de una ronda: semilla revelada, hash, y el resultado recalculado. */
export function verifyPanel(ctx: GameContext, round: Round): Panel {
  const f = fairSummaryOf(ctx, round);
  const e = new EmbedBuilder().setColor(COLORS.help).setTitle(`🔍 Ronda #${round.id} · ${gameLabel(round.game)}`);
  const head = [
    `Apuesta ${coins(round.totalBet)} → ${coins(round.payout)} (${mult(round.multiplier)}) · ${round.summary ?? ''}`,
    `**Semilla del cliente:** \`${f.clientSeed}\` · **nonce:** \`${f.nonce}\``,
    `**Hash publicado:** \`${f.serverSeedHash}\``,
  ];
  if (!f.revealed) {
    e.setDescription([...head, '', '🔒 La semilla del servidor de esta ronda **sigue activa** (secreta). Rotala con `!fairness rotar` para revelarla y verificar.'].join('\n'));
    return { embeds: [e], components: [] };
  }
  const seed = seedById(ctx, round.seedId)!;
  const hashOk = sha256(seed.serverSeed) === seed.serverSeedHash;
  const first = rngFor(seed, round.nonce).next();
  e.setDescription([
    ...head,
    `**Semilla del servidor (revelada):** \`${f.serverSeed}\``,
    `${hashOk ? '✅' : '❌'} SHA-256 de la semilla ${hashOk ? 'coincide' : 'NO coincide'} con el hash publicado.`,
    '',
    `**Resultado recalculado:** ${f.summary}`,
    `-# Primer número de la ronda: ${first.toFixed(10)} · RTP de la ronda ${(round.rtp * 100).toLocaleString('es-AR', { maximumFractionDigits: 2 })} %`,
    '',
    '-# Podés recalcularlo vos: `HMAC_SHA256(semilla_servidor, "semilla_cliente:nonce:0")`, primeros 4 bytes ÷ 2³².',
  ].join('\n'));
  return { embeds: [e], components: [] };
}
