import { ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { getItem } from '../../game/config';
import type { GameConfig, ItemDef, RodDef } from '../../game/types';
import type { ActionOutcome } from '../../services/actions';
import { shopDiscount } from '../../services/buffs';
import type { GameContext } from '../../services/context';
import { currentRod, ownedRodIds } from '../../services/fishing';
import { gameConfig } from '../../services/guildSettings';
import { getQty, listInventory } from '../../services/inventory';
import { isSellable, matchesBulk, quoteSell, type BulkFilter } from '../../services/market';
import { ensureProfile, totalLevel } from '../../services/player';
import { getOffer, listOffers, type ShopOffer, type ShopSection } from '../../services/shop';
import { navRow, row, type Panel, type Row, type Viewer } from '../app';
import { rodImage } from '../assets';
import { outcomeLines } from './fishPanel';
import { cid } from './ids';
import { COLORS, money, num, truncate } from './theme';

export type MarketSection = ShopSection | 'vender';
export const MARKET_SECTIONS: MarketSection[] = ['canas', 'suministros', 'equipo', 'permisos', 'mejoras', 'vender'];

const SECTION_META: Record<MarketSection, { label: string; emoji: string; desc: string }> = {
  canas: { label: 'Cañas', emoji: '🎣', desc: 'Líneas, suerte, ahorro de carnada y velocidad' },
  suministros: { label: 'Suministros', emoji: '🧺', desc: 'Carnada, potenciadores y consumibles' },
  equipo: { label: 'Equipo de granja', emoji: '🛠️', desc: 'Herramientas y accesorios' },
  permisos: { label: 'Permisos', emoji: '📜', desc: 'Nuevas zonas de cultivo' },
  mejoras: { label: 'Mejoras', emoji: '⬆️', desc: 'Bonificaciones permanentes' },
  vender: { label: 'Vender', emoji: '💰', desc: 'El mercado compra tus cultivos y peces' },
};

export interface MarketOpts {
  page?: number;
  notice?: string;
  /** Ficha de un artículo de la tienda: "<proveedor>:<clave>". */
  offer?: string;
  /** Ficha de venta de un objeto del inventario. */
  sellItem?: string;
  /** Confirmación de venta en lote. */
  bulk?: BulkFilter;
}

const PAGE = 8;
const SELL_PAGE = 10;
export const BULK_LABEL: Record<BulkFilter, string> = { comunes: 'Lo común', cultivos: 'Cultivos', peces: 'Peces (hasta Raro)' };
const STATE_ICON = { available: '🟢', locked: '🔒', owned: '✅', equipped: '🎣', maxed: '👑' } as const;

/**
 * Discord rechaza algunos emojis muy nuevos dentro de las opciones de menú (y con eso el panel entero).
 * Los que están en el bloque Unicode 12+ (U+1FA70 en adelante) se muestran en el texto, no como ícono.
 */
function safeEmoji(e: string): string | null {
  return [...e].every((ch) => (ch.codePointAt(0) ?? 0) < 0x1fa70) ? e : null;
}

function option(value: string, label: string, emoji: string, description?: string): StringSelectMenuOptionBuilder {
  const safe = safeEmoji(emoji);
  const o = new StringSelectMenuOptionBuilder().setValue(value).setLabel(truncate(safe ? label : `${emoji} ${label}`, 100));
  if (safe) o.setEmoji(safe);
  if (description) o.setDescription(truncate(description, 100));
  return o;
}

export function resultNotice(message: string, outcome?: ActionOutcome): string {
  const extra = outcomeLines(outcome);
  return [message, outcome?.activity ? `🔥 +${outcome.activity} de actividad` : '', ...extra].filter(Boolean).join('\n');
}

function offerLine(cfg: GameConfig, o: ShopOffer): string {
  const price = o.state === 'owned' || o.state === 'equipped' || o.state === 'maxed' ? '' : ` — ${money(cfg, o.price)}${o.bulk ? ' c/u' : ''}`;
  const missing = o.state === 'locked' ? ` · 🔒 ${o.requirements.filter((r) => !r.ok).map((r) => r.label).join(', ')}` : '';
  const tag = o.state === 'equipped' ? ' · **equipada**' : o.state === 'owned' ? ' · tuya' : o.state === 'maxed' ? ' · máximo' : '';
  return `${STATE_ICON[o.state]} ${o.emoji} **${o.name}**${price}${tag}\n-# ${o.stats}${missing}`;
}

function rodDelta(a: RodDef, b: RodDef): string {
  const d = (x: number, y: number, fmt: (n: number) => string, better: 'up' | 'down' = 'up') => {
    if (x === y) return '＝';
    const good = better === 'up' ? y > x : y < x;
    return `${good ? '🟢' : '🔴'} ${fmt(y - x)}`;
  };
  const sign = (n: number, f: (n: number) => string) => `${n > 0 ? '+' : ''}${f(n)}`;
  return [
    `Líneas ${a.lines} → **${b.lines}** ${d(a.lines, b.lines, (n) => sign(n, String))}`,
    `Suerte +${Math.round(a.luck * 100)}% → **+${Math.round(b.luck * 100)}%** ${d(a.luck, b.luck, (n) => sign(Math.round(n * 100), (x) => `${x}%`))}`,
    `Ahorro ${Math.round(a.baitSave * 100)}% → **${Math.round(b.baitSave * 100)}%** ${d(a.baitSave, b.baitSave, (n) => sign(Math.round(n * 100), (x) => `${x}%`))}`,
    `Espera ${a.cooldownSeconds} s → **${b.cooldownSeconds} s** ${d(a.cooldownSeconds, b.cooldownSeconds, (n) => sign(n, (x) => `${x} s`), 'down')}`,
  ].join('\n');
}

export function marketPanel(ctx: GameContext, v: Viewer, section: MarketSection, opts: MarketOpts = {}): Panel {
  const p = ensureProfile(ctx, v.guildId, v.userId);
  const cfg = gameConfig(ctx, v.guildId);
  const meta = SECTION_META[section];
  const embed = new EmbedBuilder()
    .setColor(COLORS.market)
    .setAuthor({ name: `Mercado del Valle — ${v.name}`, iconURL: v.avatar })
    .setTitle(`${meta.emoji} ${meta.label}`)
    .setFooter({ text: `Tenés ${cfg.currency.emoji} ${num(p.coins)} ${cfg.currency.name} · Nivel total ${totalLevel(p)}` });
  const disc = shopDiscount(ctx, v.guildId, v.userId);
  const header = [
    opts.notice ?? '',
    disc.discount > 0 ? `🏷️ **Rebaja activa: −${Math.round(disc.discount * 100)}%** en todas las compras (termina <t:${Math.ceil(disc.until / 1000)}:R>).` : '',
  ].filter(Boolean).join('\n\n');
  const withHeader = (body: string) => (header ? `${header}\n\n${body}` : body).slice(0, 4000);
  const files: Panel['files'] = [];
  const rows: Row[] = [
    row(new StringSelectMenuBuilder().setCustomId(cid('mk', 'sec', v.userId)).setPlaceholder('Sección del mercado…')
      .addOptions(MARKET_SECTIONS.map((s) => option(s, SECTION_META[s].label, SECTION_META[s].emoji, SECTION_META[s].desc).setDefault(s === section)))),
  ];

  // ── Ficha de un artículo de la tienda ──
  if (section !== 'vender' && opts.offer) {
    const o = getOffer(ctx, v.guildId, v.userId, opts.offer);
    const [prov, key] = o.id.split(':');
    const reqs = o.requirements.map((r) => `${r.ok ? '✅' : '❌'} ${r.label}`).join('\n');
    embed.setTitle(`${o.emoji} ${o.name}`).setDescription(withHeader(`*${o.description}*\n${o.stats ? `\n${o.stats}` : ''}`));
    if (o.rod) {
      const cur = currentRod(cfg, p, ownedRodIds(ctx, v.guildId, v.userId));
      if (cur.id !== o.rod.id) embed.addFields({ name: `Comparada con ${cur.emoji} ${cur.name}`, value: rodDelta(cur, o.rod) });
      const img = rodImage(o.sprite);
      if (img) {
        embed.setThumbnail(img.url);
        files.push(img.file);
      }
    }
    if (reqs) embed.addFields({ name: o.state === 'locked' ? 'Te falta' : 'Requisitos', value: reqs });
    if (o.bulk) {
      const afford = Math.floor(p.coins / Math.max(1, o.price));
      const left = o.dailyLimit !== null ? o.dailyLimit - o.boughtToday : Infinity;
      const can = (n: number) => o.state === 'available' && n <= afford && n <= left;
      rows.push(row(
        ...[1, 10, 50].map((n) => new ButtonBuilder().setCustomId(cid('mk', 'buy', v.userId, prov, key, n)).setLabel(`×${n} · ${num(o.price * n)}`)
          .setStyle(n === 1 ? ButtonStyle.Success : ButtonStyle.Primary).setDisabled(!can(n))),
        new ButtonBuilder().setCustomId(cid('mk', 'buyq', v.userId, prov, key)).setLabel('Cantidad…').setStyle(ButtonStyle.Secondary).setDisabled(o.state !== 'available'),
      ));
    } else if (o.state === 'owned' && prov === 'rod') {
      rows.push(row(new ButtonBuilder().setCustomId(cid('mk', 'equip', v.userId, key)).setLabel('Equipar').setEmoji('🎣').setStyle(ButtonStyle.Success)));
    } else if (o.state === 'available' || o.state === 'locked') {
      rows.push(row(new ButtonBuilder().setCustomId(cid('mk', 'buy', v.userId, prov, key, 1)).setLabel(`Comprar · ${num(o.price)}`)
        .setEmoji('🛒').setStyle(ButtonStyle.Success).setDisabled(o.state !== 'available')));
    }
    rows.push(row(new ButtonBuilder().setCustomId(cid('mk', 'open', v.userId, section, 0)).setLabel('Volver').setEmoji('↩️').setStyle(ButtonStyle.Secondary)));
    rows.push(navRow(v.userId, 'mercado'));
    return { embeds: [embed], components: rows.slice(0, 5), files };
  }

  // ── Lista de una sección de la tienda ──
  if (section !== 'vender') {
    const offers = listOffers(ctx, v.guildId, v.userId, section);
    const pages = Math.max(1, Math.ceil(offers.length / PAGE));
    const page = Math.min(Math.max(0, opts.page ?? 0), pages - 1);
    const slice = offers.slice(page * PAGE, (page + 1) * PAGE);
    embed.setDescription(withHeader(slice.map((o) => offerLine(cfg, o)).join('\n') || '*No hay artículos en esta sección.*'));
    embed.setFooter({ text: `${pages > 1 ? `Página ${page + 1}/${pages} · ` : ''}Tenés ${cfg.currency.emoji} ${num(p.coins)} ${cfg.currency.name} · 🟢 disponible · 🔒 bloqueado · ✅ tuyo` });
    if (section === 'canas') {
      const img = rodImage(currentRod(cfg, p, ownedRodIds(ctx, v.guildId, v.userId)).sprite);
      if (img) {
        embed.setThumbnail(img.url);
        files.push(img.file);
      }
    }
    if (slice.length) {
      rows.push(row(new StringSelectMenuBuilder().setCustomId(cid('mk', 'pick', v.userId, section)).setPlaceholder('Ver un artículo…')
        .addOptions(slice.map((o) => option(o.id.replace(':', '|'), o.name, o.emoji,
          `${STATE_ICON[o.state]} ${o.state === 'owned' || o.state === 'equipped' ? 'Tuya' : o.state === 'maxed' ? 'Al máximo' : `${num(o.price)}${o.bulk ? ' c/u' : ''}`} · ${o.stats}`)))));
    }
    if (pages > 1) {
      rows.push(row(
        new ButtonBuilder().setCustomId(cid('mk', 'open', v.userId, section, page - 1)).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId(cid('mk', 'open', v.userId, section, page + 1)).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
      ));
    }
    rows.push(navRow(v.userId, 'mercado'));
    return { embeds: [embed], components: rows.slice(0, 5), files };
  }

  // ── Vender ──
  const sellable = listInventory(ctx, v.guildId, v.userId)
    .map((r) => ({ row: r, item: getItem(cfg, r.item_id) as ItemDef }))
    .filter((x) => x.item && isSellable(x.item))
    .sort((a, b) => cfg.rarities[b.item.rarity].rank - cfg.rarities[a.item.rarity].rank || a.item.name.localeCompare(b.item.name));
  const demandIcon = { alta: '📈', normal: '➖', baja: '📉', saturada: '🧊' } as const;

  if (opts.sellItem) {
    // Ficha de venta: precios reales de ahora y botones para 1, la mitad o todo.
    const item = getItem(cfg, opts.sellItem);
    const owned = item ? getQty(ctx, v.guildId, v.userId, item.id) : 0;
    if (item && owned > 0 && isSellable(item)) {
      const half = Math.max(1, Math.floor(owned / 2));
      const q1 = quoteSell(ctx, v.guildId, v.userId, item, 1);
      const qHalf = quoteSell(ctx, v.guildId, v.userId, item, half);
      const qAll = quoteSell(ctx, v.guildId, v.userId, item, owned);
      embed.setTitle(`💰 Vender ${item.emoji} ${item.name}`).setDescription(withHeader([
        `Tenés **${num(owned)}** · ${cfg.rarities[item.rarity].emoji} ${cfg.rarities[item.rarity].label} · demanda ${demandIcon[q1.demand]} ${q1.demand}`,
        '',
        `**1** → ${money(cfg, q1.total)}`,
        owned > 1 ? `**${num(half)}** (la mitad) → ${money(cfg, qHalf.total)}` : '',
        owned > 1 ? `**${num(owned)}** (todo) → ${money(cfg, qAll.total)}` : '',
        '',
        '-# Vender mucho de lo mismo baja el precio (se recupera solo). El precio final se calcula al vender.',
      ].filter((x, i, a) => x !== '' || (a[i - 1] !== '' && i > 0)).join('\n')));
      rows.push(row(
        new ButtonBuilder().setCustomId(cid('mk', 'sell', v.userId, item.id, '1')).setLabel('Vender 1').setStyle(ButtonStyle.Success),
        ...(owned > 1 ? [
          new ButtonBuilder().setCustomId(cid('mk', 'sell', v.userId, item.id, 'half')).setLabel(`Mitad (${num(half)})`).setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(cid('mk', 'sell', v.userId, item.id, 'all')).setLabel(`Todo (${num(owned)})`).setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(cid('mk', 'sellq', v.userId, item.id)).setLabel('Cantidad…').setStyle(ButtonStyle.Secondary),
        ] : []),
      ));
      rows.push(row(new ButtonBuilder().setCustomId(cid('mk', 'open', v.userId, 'vender', opts.page ?? 0)).setLabel('Volver').setEmoji('↩️').setStyle(ButtonStyle.Secondary)));
      rows.push(navRow(v.userId, 'mercado'));
      return { embeds: [embed], components: rows, files };
    }
    // Ya no tiene ese objeto (lo vendió todo): cae a la lista.
  }

  const pages = Math.max(1, Math.ceil(sellable.length / SELL_PAGE));
  const page = Math.min(Math.max(0, opts.page ?? 0), pages - 1);
  const slice = sellable.slice(page * SELL_PAGE, (page + 1) * SELL_PAGE);
  const lines = slice.map(({ row: r, item }) => {
    const q = quoteSell(ctx, v.guildId, v.userId, item, 1);
    return `${cfg.rarities[item.rarity].emoji} ${item.emoji} **${item.name}** ×${num(r.quantity)} — ${money(cfg, q.total)} c/u ${demandIcon[q.demand]}`;
  });
  embed.setDescription(withHeader(`${lines.join('\n') || '*No tenés nada para vender todavía.*'}\n\n-# 📈 alta · ➖ normal · 📉 baja · 🧊 saturada · Elegí un objeto para ver cuánto te pagan.`));
  embed.setFooter({ text: `${pages > 1 ? `Página ${page + 1}/${pages} · ` : ''}Tenés ${cfg.currency.emoji} ${num(p.coins)} ${cfg.currency.name}` });
  if (slice.length) {
    rows.push(row(new StringSelectMenuBuilder().setCustomId(cid('mk', 'sellpick', v.userId, page)).setPlaceholder('Vender un objeto…')
      .addOptions(slice.map(({ row: r, item }) => option(item.id, `${item.name} ×${num(r.quantity)}`, item.emoji, cfg.rarities[item.rarity].label)))));
  }
  if (opts.bulk) {
    const f = opts.bulk;
    const matched = sellable.filter((x) => matchesBulk(cfg, x.item, f));
    const estimate = matched.reduce((s, x) => s + quoteSell(ctx, v.guildId, v.userId, x.item, x.row.quantity).total, 0);
    embed.addFields({ name: `¿Vender ${BULK_LABEL[f].toLowerCase()}?`, value: `${matched.length} tipos de objeto por aprox. ${money(cfg, estimate)}.\nNunca se venden en lote: Épicos o mejores, reliquias, carnada, consumibles ni materiales de cañas.` });
    rows.push(row(
      new ButtonBuilder().setCustomId(cid('mk', 'bulkok', v.userId, f)).setLabel('Confirmar venta').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(!matched.length),
      new ButtonBuilder().setCustomId(cid('mk', 'open', v.userId, 'vender', page)).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
    ));
  } else if (sellable.length) {
    rows.push(row(...(Object.keys(BULK_LABEL) as BulkFilter[]).map((f) =>
      new ButtonBuilder().setCustomId(cid('mk', 'bulk', v.userId, f)).setLabel(BULK_LABEL[f]).setEmoji('💰').setStyle(ButtonStyle.Secondary))));
  }
  if (pages > 1) {
    rows.push(row(
      new ButtonBuilder().setCustomId(cid('mk', 'open', v.userId, 'vender', page - 1)).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(cid('mk', 'open', v.userId, 'vender', page + 1)).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
    ));
  }
  rows.push(navRow(v.userId, 'mercado'));
  return { embeds: [embed], components: rows.slice(0, 5), files };
}

export function quantityModalTitle(kind: 'buy' | 'sell', name: string): string {
  return truncate(`${kind === 'buy' ? 'Comprar' : 'Vender'} ${name}`, 45);
}
