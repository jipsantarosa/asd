import { ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { getItem } from '../../game/config';
import type { GameConfig, LakeTileDef } from '../../game/types';
import type { ActionOutcome } from '../../services/actions';
import type { ActiveBuff } from '../../services/buffs';
import type { GameContext } from '../../services/context';
import { RARITY_ORDER, castVigorCost, fishingLoadout, getLake, rarityOdds, type CastResult, type FishResult } from '../../services/fishing';
import { gameConfig } from '../../services/guildSettings';
import { getQty } from '../../services/inventory';
import { quoteSell } from '../../services/market';
import { ensureProfile, getUpgradeLevels, vigorState } from '../../services/player';
import { xpToNext } from '../../services/progression';
import { getOffer } from '../../services/shop';
import { navRow, row, type Panel, type Viewer } from '../app';
import { rodImage } from '../assets';
import { levelUpNotice } from './farmPanel';
import { cid } from './ids';
import { COLORS, bar, kg, num, rel } from './theme';

const pct = (x: number) => `${(x * 100).toLocaleString('es-AR', { maximumFractionDigits: x < 0.01 ? 2 : 1 })}%`;

export function buffLine(buffs: ActiveBuff[]): string {
  return buffs.map((b) => `${b.def.emoji} ${b.def.name}${b.guildWide ? ' (servidor)' : ''} ${rel(b.expiresAt)}`).join(' · ');
}

export function oddsLine(cfg: GameConfig, luck: number, ultraMult: number): string {
  const o = rarityOdds(cfg, luck, ultraMult);
  return RARITY_ORDER.map((r) => `${cfg.rarities[r].emoji} ${pct(o[r])}`).join(' ');
}

/** Líneas de logros que se agregan a cualquier resultado (granja, pesca, mercado). */
export function outcomeLines(outcome: ActionOutcome | undefined): string[] {
  if (!outcome) return [];
  return outcome.achievements.map((a) => `🏅 **¡Logro: ${a.def.name}!** ${a.rewardLines.join(' · ')} *(detalles por DM)*`);
}

const TILE_STYLE: Record<string, ButtonStyle> = {
  agua: ButtonStyle.Secondary, burbujas: ButtonStyle.Success, algas: ButtonStyle.Primary, roca: ButtonStyle.Primary, remolino: ButtonStyle.Danger,
};

export interface FishPanelOpts {
  notice?: string;
  result?: FishResult | CastResult;
  details?: boolean;
}

/**
 * El Lago: 12 casillas de agua, cada una un botón. Tocás dónde tirar; burbujas, algas, rocas y remolinos
 * cambian la pesca. Después de cada tiro el lago se mueve. Todo en el mismo mensaje, sin espera.
 */
export function fishPanel(ctx: GameContext, v: Viewer, opts: FishPanelOpts = {}): Panel {
  const { notice, result, details = false } = opts;
  const p = ensureProfile(ctx, v.guildId, v.userId);
  const cfg = gameConfig(ctx, v.guildId);
  const lo = fishingLoadout(ctx, v.guildId, v.userId, p);
  const lake = getLake(ctx, v.guildId, v.userId);
  const bait = getQty(ctx, v.guildId, v.userId, cfg.fishing.baitItemId);
  const baitItem = getItem(cfg, cfg.fishing.baitItemId)!;
  const lines = Math.max(1, Math.min(lo.lines, Math.max(1, bait)));
  const vigorCost = castVigorCost(cfg, lines);
  const atMax = p.fish_level >= cfg.tuning.progression.maxLevel;
  const need = atMax ? 1 : xpToNext(cfg, p.fish_level);
  const mode = details ? 'd' : 's';

  const status = [
    `**Nv. ${p.fish_level}** ${atMax ? '👑' : `\`${bar(p.fish_xp, need, 8)}\` ${Math.floor((p.fish_xp / need) * 100)}%`}　${baitItem.emoji} **${num(bait)}**`
      + (vigorCost > 0 ? `　⚡ **${Math.floor(vigorState(cfg, p, getUpgradeLevels(ctx, v.guildId, v.userId), ctx.now()).current)}**` : ''),
    `${lo.rod.emoji} ${lo.rod.name} · ${lo.lines} ${lo.lines === 1 ? 'línea' : 'líneas'} por tiro · 🍀 +${Math.round(lo.luck * 100)}%`,
  ];
  if (lo.buffs.length) status.push(`✨ ${buffLine(lo.buffs)}`);
  if (notice) status.unshift(notice, '');
  // Leyenda solo de lo que hay ahora en el lago.
  const present = cfg.fishing.tiles.filter((t) => lake.tiles.some((x) => x.id === t.id));
  status.push('', `**Elegí dónde tirar** · ${present.map((t) => `${t.emoji} ${t.name}`).join(' · ')}`);
  if (bait < 1) status.push(`⛔ **Sin carnada** — comprala abajo (${cfg.currency.emoji} ${num(getOffer(ctx, v.guildId, v.userId, `supply:${baitItem.id}`).price)} c/u).`);

  const best = result?.catches.reduce((m, c) => Math.max(m, cfg.rarities[c.rarity].rank), 0) ?? -1;
  const embed = new EmbedBuilder()
    .setColor(best >= 2 ? cfg.rarities[RARITY_ORDER[best]].color : COLORS.fish)
    .setAuthor({ name: `🏞️ El lago de ${v.name}`, iconURL: v.avatar })
    .setDescription(status.join('\n'));
  const image = rodImage(lo.rod.sprite);
  if (image) embed.setThumbnail(image.url);

  if (result) {
    const tile = result.tile ? cfg.fishing.tiles.find((t) => t.id === result.tile) : undefined;
    const groups = new Map<string, { c: FishResult['catches'][number]; qty: number; best: number; flags: Set<string> }>();
    for (const c of result.catches) {
      const g = groups.get(c.itemId) ?? { c, qty: 0, best: 0, flags: new Set<string>() };
      g.qty += c.echo ? 2 : 1;
      g.best = Math.max(g.best, c.weight);
      if (c.newSpecies) g.flags.add('🆕');
      if (c.newRecord) g.flags.add('📏');
      if (c.echo) g.flags.add('🔁');
      if (c.pity) g.flags.add('🧵');
      groups.set(c.itemId, g);
    }
    let value = 0;
    const caught = [...groups.values()]
      .sort((a, b) => cfg.rarities[b.c.rarity].rank - cfg.rarities[a.c.rarity].rank)
      .map((g) => {
        const it = getItem(cfg, g.c.itemId)!;
        const rar = cfg.rarities[g.c.rarity];
        const worth = quoteSell(ctx, v.guildId, v.userId, it, g.qty).total;
        value += worth;
        return `${rar.emoji} ${it.emoji} ${rar.rank >= 3 ? `**${it.name}**` : it.name} ×${g.qty} · *${rar.label}* · ${kg(g.best)} · ${cfg.currency.emoji} ${num(worth)}${g.flags.size ? ` ${[...g.flags].join('')}` : ''}`;
      });
    if (result.snapped) caught.push(`✂️ ${result.snapped === 1 ? 'Se cortó 1 línea' : `Se cortaron ${result.snapped} líneas`} en el remolino.`);
    if (!caught.length) caught.push('*No sacaste nada esta vez.*');
    const summary = [
      `✨ +${num(result.gain.amount)} XP`,
      `${cfg.currency.emoji} ~${num(value)}`,
      `${baitItem.emoji} −${result.baitUsed}${result.baitSaved ? ` (${result.baitSaved} ahorrada${result.baitSaved > 1 ? 's' : ''})` : ''}`,
    ].join(' · ');
    const extra = [
      ...result.extras.map((e) => { const it = getItem(cfg, e.itemId)!; return `🎁 También sacaste ${it.emoji} **${it.name}**`; }),
      ...result.collections.map((c) => `📚 ¡Colección **${cfg.rarities[c.rarity].label}** completa! ${cfg.currency.emoji} ${num(c.coins)}`),
      result.gain.levelUp ? levelUpNotice('pesca', result.gain.levelUp.to, result.gain.levelUp.coins, result.gain.levelUp.reachedMax, cfg.currency.emoji) : '',
      ...outcomeLines(result.outcome),
    ].filter(Boolean);
    embed.addFields({ name: `🪝 Tiraste en ${tile ? `${tile.emoji} ${tile.name}` : 'el lago'}`, value: [...caught, '', summary, ...extra].join('\n').slice(0, 1024) });
  }

  if (details) {
    // Probabilidades reales por tipo de casilla con tu suerte actual (configurables en game.config.json).
    const odds = cfg.fishing.tiles.map((t: LakeTileDef) => {
      const luck = Math.max(0, lo.luck + t.luck);
      return `${t.emoji} **${t.name}** — ${t.description}\n-# ${oddsLine(cfg, luck, lo.ultraMult * (t.ultraMult ?? 1))}`;
    });
    embed.addFields({ name: '🎲 Probabilidad por línea en cada casilla', value: odds.join('\n').slice(0, 1024) });
    const pity = cfg.tuning.fish.pityThreshold;
    if (pity > 0) embed.addFields({ name: '🧵 Racha de la suerte', value: `\`${bar(p.fish_pity, pity, 10)}\` ${Math.min(p.fish_pity, pity)}/${pity} — al llenarse, Épico garantizado.` });
  }
  embed.setFooter({ text: `${cfg.currency.emoji} ${num(p.coins)} ${cfg.currency.name} · ${num(p.catches_total)} capturas · 🆕 especie 📏 récord 🔁 eco 🧵 racha` });

  // 3 filas de 4 casillas (máx. 12).
  const tileRows: ReturnType<typeof row>[] = [];
  for (let r = 0; r < Math.ceil(lake.tiles.length / 4); r++) {
    tileRows.push(row(...lake.tiles.slice(r * 4, r * 4 + 4).map((t, k) =>
      new ButtonBuilder().setCustomId(cid('fi', 'cast', v.userId, r * 4 + k, mode)).setEmoji(t.emoji)
        .setStyle(TILE_STYLE[t.id] ?? ButtonStyle.Secondary))));
  }
  const baitOffer = getOffer(ctx, v.guildId, v.userId, `supply:${baitItem.id}`);
  return {
    embeds: [embed],
    files: image ? [image.file] : [],
    components: [
      ...tileRows.slice(0, 3),
      row(
        new ButtonBuilder().setCustomId(cid('fi', 'cast', v.userId, 'r', mode)).setLabel('Pescar').setEmoji('🎣').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(cid('fi', 'bait', v.userId, mode)).setEmoji(baitItem.emoji).setLabel(`+10 · ${num(baitOffer.price * 10)}`)
          .setStyle(ButtonStyle.Primary).setDisabled(baitOffer.state === 'locked' || p.coins < baitOffer.price * 10),
        new ButtonBuilder().setCustomId(cid('mk', 'open', v.userId, 'canas', 0)).setEmoji('🛒').setLabel('Cañas').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(cid('mk', 'open', v.userId, 'suministros', 0)).setEmoji('✨').setLabel('Cebos').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(cid('fi', 'view', v.userId, details ? 's' : 'd')).setEmoji('ℹ️').setStyle(ButtonStyle.Secondary),
      ),
      navRow(v.userId, 'pesca'),
    ],
  };
}
