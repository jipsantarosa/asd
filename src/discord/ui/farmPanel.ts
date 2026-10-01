import { ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { getEquipLine, getItem, getZone } from '../../game/config';
import type { GameContext } from '../../services/context';
import { farmVigorCost, parseLastFarm, type FarmResult } from '../../services/farming';
import { gameConfig } from '../../services/guildSettings';
import { listInventory } from '../../services/inventory';
import { getReadyAt } from '../../services/limits';
import {
  currentFatigue, ensureProfile, equipStats, fatigueMultiplier, getEquipTiers, getUpgradeLevels, isUnlocked, vigorState,
} from '../../services/player';
import { xpToNext } from '../../services/progression';
import { navRow, row, type Panel, type Viewer } from '../app';
import { cid } from './ids';
import { COLORS, bar, money, num, rel } from './theme';

export function farmPanel(ctx: GameContext, v: Viewer, notice?: string, result?: FarmResult): Panel {
  const p = ensureProfile(ctx, v.guildId, v.userId);
  const cfg = gameConfig(ctx, v.guildId);
  const now = ctx.now();
  const zone = getZone(cfg, p.farm_zone) ?? cfg.farming.zones[0];
  const tiers = getEquipTiers(ctx, v.guildId, v.userId);
  const stats = equipStats(cfg, tiers, ['herramienta', 'accesorio']);
  const vigor = vigorState(cfg, p, getUpgradeLevels(ctx, v.guildId, v.userId), now);
  const cost = farmVigorCost(zone, stats.vigorDiscount);
  const readyAt = getReadyAt(ctx, v.guildId, v.userId, 'farm');
  const fatigueMult = fatigueMultiplier(cfg, currentFatigue(cfg, p, now));
  const maxLevel = cfg.tuning.progression.maxLevel;
  const toolOk = tiers.herramienta >= zone.minToolTier;

  const lines: string[] = [];
  if (notice) lines.push(notice, '');
  lines.push(`${zone.emoji} **${zone.name}** — *${zone.description}*`, '');
  lines.push(`⚡ **Vigor** ${bar(vigor.current, vigor.max)} \`${Math.floor(vigor.current)}/${vigor.max}\`${vigor.current < vigor.max ? ` · lleno ${rel(vigor.fullAt)}` : ''}`);
  lines.push(p.farm_level >= maxLevel
    ? `🌾 **Granja nv. ${p.farm_level}** · 👑 nivel máximo`
    : `🌾 **Granja nv. ${p.farm_level}** ${bar(p.farm_xp, xpToNext(cfg, p.farm_level))} \`${num(p.farm_xp)}/${num(xpToNext(cfg, p.farm_level))} XP\``);
  const rhythm = fatigueMult >= 1 ? '🟢 descansado' : fatigueMult > 0.7 ? `🟡 cansado (${Math.round(fatigueMult * 100)}%)` : `🔴 agotado (${Math.round(fatigueMult * 100)}%)`;
  lines.push(`😮‍💨 **Ritmo** ${rhythm} · 🌿 **Abono** ${p.fertilizer > 0 ? `${p.fertilizer} cosechas` : 'sin abono'}`);
  if (!toolOk) {
    const need = getEquipLine(cfg, 'herramienta').tiers[zone.minToolTier];
    lines.push(`⛔ Esta zona requiere ${need.emoji} **${need.name}**.`);
  } else if (readyAt > now) lines.push(`⏳ Próxima cosecha ${rel(readyAt)}`);
  else if (vigor.current < cost) lines.push(`⏳ Vigor suficiente ${rel(now + (cost - vigor.current) * vigor.regenMs)}`);
  else lines.push('✅ **Listo para cosechar**');

  const golden = result?.golden ?? false;
  const embed = new EmbedBuilder()
    .setColor(golden ? COLORS.golden : COLORS.farm)
    .setAuthor({ name: `Granja de ${v.name}`, iconURL: v.avatar })
    .setDescription(lines.join('\n'));

  const last = result
    ? { drops: result.drops, golden: result.golden, fertilized: result.fertilized, xp: result.gain.amount, fatigueMult: result.fatigueMult, at: now }
    : parseLastFarm(p.last_farm_json);
  if (last) {
    const dropText = last.drops.length
      ? last.drops.map((d) => {
        const it = getItem(cfg, d.itemId);
        return `${d.special ? '✨ ' : ''}${it?.emoji ?? '❔'} ${it?.name ?? d.itemId} ×${d.qty}`;
      }).join('\n')
      : 'La tierra no dio nada esta vez.';
    const tags = [last.golden ? '🌟 **¡Cosecha dorada!**' : '', last.fertilized ? '🌿 abonada' : '', last.fatigueMult < 1 ? `😮‍💨 ${Math.round(last.fatigueMult * 100)}%` : '']
      .filter(Boolean).join(' · ');
    embed.addFields({ name: `🧺 Última cosecha ${result ? '' : `(${rel(last.at)})`}`, value: `${dropText}\n+${num(last.xp)} XP${tags ? `\n${tags}` : ''}`, inline: true });
  }
  const tool = getEquipLine(cfg, 'herramienta').tiers[tiers.herramienta];
  const acc = getEquipLine(cfg, 'accesorio').tiers[tiers.accesorio];
  embed.addFields({
    name: '🧰 Equipo',
    value: `${tool.emoji} ${tool.name}\n${acc.emoji} ${acc.name}\n📦 ×${stats.yieldMult.toFixed(2)} cosecha${stats.vigorDiscount ? ` · −${Math.round(stats.vigorDiscount * 100)}% vigor` : ''}`,
    inline: true,
  });
  embed.setFooter({ text: `${cfg.currency.emoji} ${num(p.coins)} ${cfg.currency.name} · ${num(p.farms_total)} cosechas en total` });

  const components = [
    row(
      new ButtonBuilder().setCustomId(cid('fa', 'farm', v.userId)).setLabel(`Farmear  (−${cost} ⚡)`).setEmoji('🌾')
        .setStyle(ButtonStyle.Success).setDisabled(!toolOk),
      new ButtonBuilder().setCustomId(cid('fa', 'view', v.userId)).setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    ),
    row(
      new StringSelectMenuBuilder()
        .setCustomId(cid('fa', 'zone', v.userId))
        .setPlaceholder('Cambiar de zona…')
        .addOptions(cfg.farming.zones.map((z) => {
          const open = isUnlocked(ctx, v.guildId, v.userId, 'zona', z.id);
          return new StringSelectMenuOptionBuilder()
            .setValue(z.id)
            .setLabel(`${open ? '' : '🔒 '}${z.name}`)
            .setEmoji(z.emoji)
            .setDescription(open ? `${z.vigorCost} ⚡ · ${z.baseXp} XP base` : `Nivel ${z.level} · permiso ${money(cfg, z.unlockCost)} en el Mercado`)
            .setDefault(z.id === zone.id);
        })),
    ),
  ];

  const usable = listInventory(ctx, v.guildId, v.userId)
    .filter((r) => cfg.consumables.some((c) => c.itemId === r.item_id));
  if (usable.length) {
    components.push(row(
      new StringSelectMenuBuilder()
        .setCustomId(cid('fa', 'use', v.userId))
        .setPlaceholder('🧪 Usar un objeto…')
        .addOptions(usable.map((r) => {
          const it = getItem(cfg, r.item_id)!;
          const def = cfg.consumables.find((c) => c.itemId === r.item_id)!;
          const effect = def.effect.type === 'vigor' ? `+${def.effect.amount} vigor`
            : def.effect.type === 'abono' ? `+${def.effect.charges} cosechas abonadas`
              : `Activa ${cfg.buffs.find((b) => b.id === (def.effect as { buffId: string }).buffId)?.name ?? 'un potenciador'}`;
          return new StringSelectMenuOptionBuilder().setValue(it.id).setLabel(`${it.name} ×${num(r.quantity)}`).setEmoji(it.emoji)
            .setDescription(`${effect}${def.dailyUseLimit ? ` · máx. ${def.dailyUseLimit}/día` : ''}`);
        })),
    ));
  }
  components.push(navRow(v.userId, 'granja'));
  return { embeds: [embed], components };
}

export function levelUpNotice(skill: 'granja' | 'pesca', to: number, coins: number, max: boolean, cfgEmoji: string): string {
  return `🎉 **¡Subiste a ${skill} nv. ${to}!** ${coins ? `+${cfgEmoji} ${num(coins)}` : ''}${max ? ' 👑 ¡Nivel máximo!' : ''}`;
}
