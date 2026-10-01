import {
  ActionRowBuilder, ChannelType, EmbedBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle,
  type MessageComponentInteraction, type ModalSubmitInteraction, type TextChannel, type NewsChannel,
} from 'discord.js';
import { getItem, getTunable } from '../../game/config';
import type { EquipSlot } from '../../game/types';
import { useConsumable } from '../../services/consumables';
import { GameError, fmt } from '../../services/context';
import { farm, setFarmZone } from '../../services/farming';
import { castAt, equipRod, ownedRodIds } from '../../services/fishing';
import { gameConfig, getSettings, resetTunable, setPrefix, setTunable } from '../../services/guildSettings';
import { getQty } from '../../services/inventory';
import { getReadyAt } from '../../services/limits';
import { getLogConfig, saveLogConfig } from '../../services/logConfig';
import { sellBulk, sellItem, type BulkFilter } from '../../services/market';
import { getOffer, purchase } from '../../services/shop';
import type { ActionOutcome } from '../../services/actions';
import { ensureProfile, SLOTS, totalLevel, type UnlockKind, type UpgradeId } from '../../services/player';
import {
  addRolesToGroup, createGroup, deleteGroup, getGroup, removeReward, removeRoleFromGroup, setPublished, setReward,
  toggleMode, updateGroupText, type RewardSkill,
} from '../../services/roles';
import { viewerOf, type App, type NavTarget, type Panel } from '../app';
import { logSystem } from '../logging/sender';
import { roleProblem, syncRewardRoles } from '../roleSafety';
import { farmPanel, levelUpNotice } from '../ui/farmPanel';
import { fishPanel, outcomeLines } from '../ui/fishPanel';
import { mediaPanel, mediaStats } from '../ui/mediaPanels';
import { clearInfo, type ClearKind } from '../commands/premium';
import { requireTier } from '../../services/premium';
import { clearMedia } from '../../services/userMedia';
import { clearNames, recordName } from '../../services/userNames';
import { fetchAndRecord } from '../tracking/userMedia';
import { kissAnsweredRow, kissEmbed } from '../ui/kissPanels';
import { randomKissGif } from '../fun/kissGif';
import { claimKissReply, kissBack } from '../../services/social';
import type { ParsedId } from '../ui/ids';
import { cid } from '../ui/ids';
import { ACH_FILTERS, HELP_PAGE_IDS, INV_FILTER_IDS, achievementsPanel, helpPanel, inventoryPanel, profilePanel, type AchFilter, type HelpPage, type InvFilter } from '../ui/infoPanels';
import { MARKET_SECTIONS, marketPanel, quantityModalTitle, resultNotice, type MarketSection } from '../ui/marketPanel';
import { publicGroupMessage, rolePicker, rolesAdminPanel } from '../ui/rolesPanel';
import { TUNABLE_SECTIONS, settingsPanel } from '../ui/settingsPanel';
import { topPanel } from '../ui/topPanel';
import { eventsAdminPanel } from '../ui/eventPanels';
import { launchEvent } from '../events/scheduler';
import { joinEvent, setEventChannel, setEventsEnabled, getEventConfig } from '../../services/events';
import { TOP_CATEGORIES, type TopCategory } from '../../services/leaderboard';

export type Ix = MessageComponentInteraction<'cached'> | ModalSubmitInteraction<'cached'>;
type Handler = (app: App, i: Ix, id: ParsedId) => Promise<void>;

// ───────────────────────── utilidades ─────────────────────────

function values(i: Ix): string[] {
  return i.isAnySelectMenu() ? i.values : [];
}

function field(i: Ix, name: string): string {
  if (!i.isModalSubmit()) return '';
  return i.fields.getTextInputValue(name).trim();
}

/** Reemplaza el panel en el mismo mensaje. */
async function update(i: Ix, panel: Panel): Promise<void> {
  // attachments: [] quita las imágenes del panel anterior; files agrega las del nuevo (si tiene).
  const body = { embeds: panel.embeds, components: panel.components, files: panel.files ?? [], attachments: [], allowedMentions: { parse: [] } };
  if (i.isMessageComponent()) await i.update(body);
  else if (i.isFromMessage()) await i.update(body);
  else await i.reply({ embeds: body.embeds, components: body.components, files: body.files, allowedMentions: body.allowedMentions, flags: MessageFlags.Ephemeral });
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T {
  if (!value || !allowed.includes(value as T)) throw new GameError('Opción inválida.');
  return value as T;
}

function qtyModal(customId: string, title: string, placeholder: string): ModalBuilder {
  return new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('qty').setLabel('Cantidad').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(8).setPlaceholder(placeholder),
    ),
  );
}

function parseQty(raw: string, allowAll: boolean): number | 'all' {
  const t = raw.toLowerCase().replace(/[.\s]/g, '');
  if (allowAll && ['todo', 'todos', 'all', 't'].includes(t)) return 'all';
  if (!/^\d{1,7}$/.test(t)) throw new GameError(`Cantidad inválida: escribí un número${allowAll ? ' o "todo"' : ''}.`);
  const n = Number(t);
  if (n < 1) throw new GameError('La cantidad debe ser al menos 1.');
  return n;
}

function requirePerm(i: Ix, perm: bigint, name: string): void {
  if (!i.member.permissions.has(perm)) throw new GameError(`Necesitás el permiso **${name}**.`);
}

// ───────────────────────── granja ─────────────────────────

const farmHandler: Handler = async (app, i, id) => {
  const { ctx } = app;
  const v = viewerOf(i.member);
  switch (id.act) {
    case 'farm': {
      const r = farm(ctx, v.guildId, v.userId);
      const cfg = gameConfig(ctx, v.guildId);
      const notice = r.gain.levelUp ? levelUpNotice('granja', r.gain.levelUp.to, r.gain.levelUp.coins, r.gain.levelUp.reachedMax, cfg.currency.emoji) : undefined;
      const extra = outcomeLines(r.outcome).join('\n');
      await update(i, farmPanel(ctx, v, [notice, extra].filter(Boolean).join('\n') || undefined, r));
      void app.afterAction?.(i.member);
      return;
    }
    case 'view':
      return update(i, farmPanel(ctx, v));
    case 'zone': {
      const zone = setFarmZone(ctx, v.guildId, v.userId, values(i)[0]);
      return update(i, farmPanel(ctx, v, `📍 Ahora trabajás en ${zone.emoji} **${zone.name}**.`));
    }
    case 'use': {
      const res = useConsumable(ctx, v.guildId, v.userId, values(i)[0]);
      return update(i, farmPanel(ctx, v, res.message));
    }
    default:
      throw new GameError('Acción desconocida.');
  }
};

// ───────────────────────── pesca ─────────────────────────

/**
 * El Lago: cada casilla es un botón "tirar acá"; "Pescar" tira en una al azar.
 * Sin espera ni límite de clics: cualquier aviso (p. ej. sin carnada) aparece dentro del mismo panel.
 */
const fishHandler: Handler = async (app, i, id) => {
  const { ctx } = app;
  const v = viewerOf(i.member);
  const details = id.act === 'view' ? id.args[0] === 'd' : id.args[id.act === 'cast' ? 1 : 0] === 'd';
  switch (id.act) {
    case 'view':
      return update(i, fishPanel(ctx, v, { details }));
    case 'fish':
    case 'cast': {
      const raw = id.act === 'fish' ? 'r' : id.args[0];
      const index = raw === 'r' ? 'random' : Number(raw);
      try {
        const r = castAt(ctx, v.guildId, v.userId, index);
        await update(i, fishPanel(ctx, v, { result: r, details }));
        void app.afterAction?.(i.member);
      } catch (err) {
        if (!(err instanceof GameError)) throw err;
        await update(i, fishPanel(ctx, v, { notice: `⚠️ ${err.message}`, details }));
      }
      return;
    }
    case 'bait': {
      // Compra rápida desde el HUD: mismo camino que el Mercado (precio, rebajas, cooldown, logros).
      const cfg = gameConfig(ctx, v.guildId);
      try {
        const r = purchase(ctx, v.guildId, v.userId, `supply:${cfg.fishing.baitItemId}`, 10);
        await update(i, fishPanel(ctx, v, { details, notice: resultNotice(`${r.message} ${cfg.currency.emoji} −${fmt(r.cost)}`, r.outcome) }));
        void app.afterAction?.(i.member);
      } catch (err) {
        if (!(err instanceof GameError)) throw err;
        await update(i, fishPanel(ctx, v, { details, notice: `⚠️ ${err.message}` }));
      }
      return;
    }
    default:
      throw new GameError('Este botón es de una versión anterior. Abrí el panel de nuevo con /pesca.');
  }
};

// ───────────────────────── mercado ─────────────────────────

const SHOP_PROVIDERS = ['rod', 'equip', 'supply', 'zone', 'upgrade'] as const;

const marketHandler: Handler = async (app, i, id) => {
  const { ctx } = app;
  const v = viewerOf(i.member);
  const cfg = gameConfig(ctx, v.guildId);
  const offerId = () => `${oneOf(id.args[0], SHOP_PROVIDERS)}:${id.args[1] ?? ''}`;
  const sectionOf = (prov: string) => ({ rod: 'canas', equip: 'equipo', supply: 'suministros', zone: 'permisos', upgrade: 'mejoras' } as const)[prov as (typeof SHOP_PROVIDERS)[number]];
  const afterAction = (outcome?: ActionOutcome) => {
    if (outcome?.achievements.length || outcome?.activity) void app.afterAction?.(i.member);
  };

  switch (id.act) {
    case 'sec':
      return update(i, marketPanel(ctx, v, oneOf<MarketSection>(values(i)[0], MARKET_SECTIONS)));
    case 'open':
      return update(i, marketPanel(ctx, v, oneOf<MarketSection>(id.args[0], MARKET_SECTIONS), { page: Number(id.args[1]) || 0 }));

    // ── Tienda ──
    case 'pick': {
      const [prov, key] = (values(i)[0] ?? '').split('|');
      oneOf(prov, SHOP_PROVIDERS);
      return update(i, marketPanel(ctx, v, sectionOf(prov), { offer: `${prov}:${key ?? ''}` }));
    }
    case 'buy': {
      const oid = offerId();
      const qty = Number(id.args[2] ?? 1);
      if (!Number.isSafeInteger(qty) || qty < 1 || qty > 50) throw new GameError('Cantidad inválida.');
      const r = purchase(ctx, v.guildId, v.userId, oid, qty);
      await update(i, marketPanel(ctx, v, r.offer.section, {
        offer: r.offer.bulk ? oid : undefined,
        notice: resultNotice(`${r.message} ${cfg.currency.emoji} −${fmt(r.cost)}`, r.outcome),
      }));
      afterAction(r.outcome);
      return;
    }
    case 'buyq': {
      const o = getOffer(ctx, v.guildId, v.userId, offerId());
      if (!i.isMessageComponent()) return;
      return i.showModal(qtyModal(cid('mk', 'buyqty', v.userId, id.args[0], id.args[1]), quantityModalTitle('buy', o.name), 'Ej: 25'));
    }
    case 'buyqty': {
      const qty = parseQty(field(i, 'qty'), false) as number;
      const r = purchase(ctx, v.guildId, v.userId, offerId(), qty);
      await update(i, marketPanel(ctx, v, r.offer.section, { offer: r.offer.id, notice: resultNotice(`${r.message} ${cfg.currency.emoji} −${fmt(r.cost)}`, r.outcome) }));
      afterAction(r.outcome);
      return;
    }
    case 'equip': {
      const rod = equipRod(ctx, v.guildId, v.userId, id.args[0] ?? '');
      return update(i, marketPanel(ctx, v, 'canas', { notice: `🎣 Equipaste ${rod.emoji} **${rod.name}**.` }));
    }

    // ── Venta ──
    case 'sellpick': {
      const itemId = values(i)[0] ?? '';
      if (!getItem(cfg, itemId)) throw new GameError('Ese objeto no existe.');
      return update(i, marketPanel(ctx, v, 'vender', { sellItem: itemId, page: Number(id.args[0]) || 0 }));
    }
    case 'sell': {
      const mode = id.args[1] === 'all' ? 'all' : id.args[1] === 'half' ? 'half' : 1;
      const r = sellItem(ctx, v.guildId, v.userId, id.args[0] ?? '', mode);
      await update(i, marketPanel(ctx, v, 'vender', {
        sellItem: r.item.id,
        notice: resultNotice(`💰 Vendiste ${fmt(r.qty)}× ${r.item.emoji} **${r.item.name}** por ${cfg.currency.emoji} **${fmt(r.quote.total)}**.`, r.outcome),
      }));
      afterAction(r.outcome);
      return;
    }
    case 'sellq': {
      const item = getItem(cfg, id.args[0] ?? '');
      if (!item) throw new GameError('Ese objeto no existe.');
      if (!i.isMessageComponent()) return;
      const owned = getQty(ctx, v.guildId, v.userId, item.id);
      return i.showModal(qtyModal(cid('mk', 'sellqty', v.userId, item.id), quantityModalTitle('sell', item.name), `Número (tenés ${owned}) o "todo"`));
    }
    case 'sellqty': {
      const r = sellItem(ctx, v.guildId, v.userId, id.args[0] ?? '', parseQty(field(i, 'qty'), true));
      await update(i, marketPanel(ctx, v, 'vender', {
        sellItem: r.item.id,
        notice: resultNotice(`💰 Vendiste ${fmt(r.qty)}× ${r.item.emoji} **${r.item.name}** por ${cfg.currency.emoji} **${fmt(r.quote.total)}**.`, r.outcome),
      }));
      afterAction(r.outcome);
      return;
    }
    case 'bulk':
      return update(i, marketPanel(ctx, v, 'vender', { bulk: oneOf<BulkFilter>(id.args[0], ['comunes', 'cultivos', 'peces']) }));
    case 'bulkok': {
      const r = sellBulk(ctx, v.guildId, v.userId, oneOf<BulkFilter>(id.args[0], ['comunes', 'cultivos', 'peces']));
      await update(i, marketPanel(ctx, v, 'vender', { notice: resultNotice(`💰 Vendiste ${r.lines.length} tipos de objeto por ${cfg.currency.emoji} **${fmt(r.total)}**.`, r.outcome) }));
      afterAction(r.outcome);
      return;
    }
    default:
      throw new GameError('Este botón es de una versión anterior del mercado. Abrilo de nuevo con /mercado.');
  }
};

// ───────────────────────── mochila, ayuda, navegación ─────────────────────────

const inventoryHandler: Handler = async (app, i, id) => {
  const v = viewerOf(i.member);
  if (id.act === 'filter') return update(i, inventoryPanel(app.ctx, v, oneOf<InvFilter>(values(i)[0], INV_FILTER_IDS)));
  if (id.act === 'page') return update(i, inventoryPanel(app.ctx, v, oneOf<InvFilter>(id.args[0], INV_FILTER_IDS), Number(id.args[1]) || 0));
  throw new GameError('Acción desconocida.');
};

const helpHandler: Handler = async (app, i) => {
  await update(i, helpPanel(app.ctx, viewerOf(i.member), oneOf<HelpPage>(values(i)[0], HELP_PAGE_IDS)));
};

const navHandler: Handler = async (app, i, id) => {
  const v = viewerOf(i.member);
  const target = oneOf<NavTarget>(id.act, ['granja', 'pesca', 'mercado', 'inventario', 'perfil']);
  const panels: Record<NavTarget, () => Panel> = {
    granja: () => farmPanel(app.ctx, v),
    pesca: () => fishPanel(app.ctx, v),
    mercado: () => marketPanel(app.ctx, v, 'equipo'),
    inventario: () => inventoryPanel(app.ctx, v),
    perfil: () => profilePanel(app.ctx, v, v),
  };
  await update(i, panels[target]());
};

// ───────────────────────── ajustes (admin) ─────────────────────────

const settingsHandler: Handler = async (app, i, id) => {
  requirePerm(i, PermissionFlagsBits.ManageGuild, 'Gestionar servidor');
  const { ctx } = app;
  const g = i.guild;
  switch (id.act) {
    case 'sec':
      return update(i, settingsPanel(ctx, g.id, i.user.id, oneOf(values(i)[0] ?? id.args[0], TUNABLE_SECTIONS)));
    case 'edit': {
      const def = getTunable(values(i)[0]);
      if (!def || !i.isMessageComponent()) throw new GameError('Ajuste desconocido.');
      const modal = new ModalBuilder().setCustomId(cid('st', 'val', i.user.id, def.key)).setTitle(def.label.slice(0, 45)).addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('value').setLabel(`Valor (${def.min} a ${def.max})`)
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12)),
      );
      return i.showModal(modal);
    }
    case 'val': {
      const def = getTunable(id.args[0] ?? '');
      if (!def) throw new GameError('Ajuste desconocido.');
      const raw = field(i, 'value').replace(',', '.');
      if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new GameError('Escribí un número (podés usar decimales).');
      const saved = setTunable(ctx, g.id, def.key, Number(raw));
      await update(i, settingsPanel(ctx, g.id, i.user.id, def.section, `✅ **${def.label}** ahora vale \`${saved}\`.`));
      await logSystem(ctx, g, `⚙️ <@${i.user.id}> cambió **${def.label}** (\`${def.key}\`) a \`${saved}\`.`);
      return;
    }
    case 'prefix': {
      if (!i.isMessageComponent()) return;
      return i.showModal(new ModalBuilder().setCustomId(cid('st', 'pfx', i.user.id)).setTitle('Cambiar prefijo').addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('prefix').setLabel('Nuevo prefijo (1-5 caracteres)')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(5).setValue(getSettings(ctx, g.id).prefix)),
      ));
    }
    case 'pfx': {
      const before = getSettings(ctx, g.id).prefix;
      const saved = setPrefix(ctx, g.id, field(i, 'prefix'));
      await update(i, settingsPanel(ctx, g.id, i.user.id, 'Vigor', `✅ Prefijo actualizado: \`${saved}\``));
      await logSystem(ctx, g, `⌨️ <@${i.user.id}> cambió el prefijo de \`${before}\` a \`${saved}\`.`);
      return;
    }
    case 'logmsg': {
      const cfg = getLogConfig(ctx, g.id);
      saveLogConfig(ctx, g.id, { ...cfg, logSentMessages: !cfg.logSentMessages });
      await update(i, settingsPanel(ctx, g.id, i.user.id, oneOf(id.args[0], TUNABLE_SECTIONS), `📝 Registro de mensajes enviados: **${!cfg.logSentMessages ? 'activado' : 'desactivado'}**.`));
      await logSystem(ctx, g, `📝 <@${i.user.id}> ${!cfg.logSentMessages ? 'activó' : 'desactivó'} el registro de mensajes enviados.`);
      return;
    }
    case 'reset':
      return update(i, settingsPanel(ctx, g.id, i.user.id, oneOf(id.args[0], TUNABLE_SECTIONS), '⚠️ Esto vuelve **todos** los valores del juego a los de fábrica.', true));
    case 'resetok':
      resetTunable(ctx, g.id, 'all');
      await update(i, settingsPanel(ctx, g.id, i.user.id, 'Vigor', '♻️ Todos los valores volvieron a los de fábrica.'));
      await logSystem(ctx, g, `♻️ <@${i.user.id}> restableció todos los valores del juego.`);
      return;
    default:
      throw new GameError('Acción desconocida.');
  }
};

// ───────────────────────── roles: administración ─────────────────────────

async function refreshPublished(app: App, i: Ix, groupId: number): Promise<void> {
  const g = getGroup(app.ctx, i.guild.id, groupId);
  if (!g.channel_id || !g.message_id) return;
  const ch = i.guild.channels.cache.get(g.channel_id);
  if (!ch?.isTextBased()) return;
  await ch.messages.edit(g.message_id, { ...publicGroupMessage(i.guild, g), allowedMentions: { parse: [] } }).catch(() => undefined);
}

const rolesAdminHandler: Handler = async (app, i, id) => {
  requirePerm(i, PermissionFlagsBits.ManageRoles, 'Gestionar roles');
  const { ctx } = app;
  const guild = i.guild;
  const owner = i.user.id;
  const gid = Number(id.args[0]);
  const show = (view: Parameters<typeof rolesAdminPanel>[3], notice?: string) => update(i, rolesAdminPanel(ctx, guild, owner, view, notice));

  switch (id.act) {
    case 'home':
      return show({ kind: 'home' });
    case 'group':
      return show({ kind: 'group', id: Number(values(i)[0] ?? id.args[0]) });
    case 'new':
    case 'edit': {
      if (!i.isMessageComponent()) return;
      const g = id.act === 'edit' ? getGroup(ctx, guild.id, gid) : null;
      const input = (cidName: string, label: string, style: TextInputStyle, max: number, value: string, required: boolean) => {
        const t = new TextInputBuilder().setCustomId(cidName).setLabel(label).setStyle(style).setMaxLength(max).setRequired(required);
        if (value) t.setValue(value);
        return new ActionRowBuilder<TextInputBuilder>().addComponents(t);
      };
      return i.showModal(new ModalBuilder().setCustomId(g ? cid('ra', 'save', owner, g.id) : cid('ra', 'create', owner)).setTitle(g ? 'Editar grupo' : 'Nuevo grupo de roles')
        .addComponents(
          input('name', 'Nombre', TextInputStyle.Short, 60, g?.name ?? '', true),
          input('desc', 'Descripción (opcional)', TextInputStyle.Paragraph, 300, g?.description ?? '', false),
          input('level', 'Nivel total mínimo (0 = ninguno)', TextInputStyle.Short, 3, String(g?.min_total_level ?? 0), false),
        ));
    }
    case 'create': {
      const g = createGroup(ctx, guild.id, field(i, 'name'), field(i, 'desc'), Number(field(i, 'level') || 0));
      await logSystem(ctx, guild, `🎭 <@${owner}> creó el grupo de roles **${g.name}**.`);
      return show({ kind: 'group', id: g.id }, '✅ Grupo creado. Ahora agregale roles y publicalo en un canal.');
    }
    case 'save': {
      updateGroupText(ctx, guild.id, gid, field(i, 'name'), field(i, 'desc'), Number(field(i, 'level') || 0));
      await show({ kind: 'group', id: gid }, '✅ Grupo actualizado.');
      return refreshPublished(app, i, gid);
    }
    case 'mode': {
      const g = toggleMode(ctx, guild.id, gid);
      await show({ kind: 'group', id: gid }, `🔁 Modo cambiado a **${g.mode}**.`);
      return refreshPublished(app, i, gid);
    }
    case 'addroles': {
      const accepted: string[] = [];
      const rejected: string[] = [];
      for (const roleId of values(i)) {
        const problem = roleProblem(guild, guild.roles.cache.get(roleId));
        if (problem) rejected.push(`<@&${roleId}>: ${problem}`);
        else accepted.push(roleId);
      }
      if (accepted.length) addRolesToGroup(ctx, guild.id, gid, accepted);
      await show({ kind: 'group', id: gid }, [accepted.length ? `✅ ${accepted.length} rol(es) agregados.` : '', rejected.length ? `⛔ Rechazados:\n${rejected.join('\n')}` : ''].filter(Boolean).join('\n'));
      return refreshPublished(app, i, gid);
    }
    case 'rmrole': {
      removeRoleFromGroup(ctx, guild.id, gid, values(i)[0]);
      await show({ kind: 'group', id: gid }, '🗑️ Rol quitado del grupo.');
      return refreshPublished(app, i, gid);
    }
    case 'publish': {
      const g = getGroup(ctx, guild.id, gid);
      if (!g.roles.length) throw new GameError('Agregá al menos un rol antes de publicar.');
      const ch = guild.channels.cache.get(values(i)[0]);
      if (!ch || (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement)) throw new GameError('Elegí un canal de texto.');
      const me = guild.members.me!;
      if (!ch.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        throw new GameError(`No puedo enviar mensajes con embeds en <#${ch.id}>.`);
      }
      const payload = { ...publicGroupMessage(guild, g), allowedMentions: { parse: [] } };
      let messageId: string | null = null;
      if (g.channel_id === ch.id && g.message_id) {
        messageId = await (ch as TextChannel | NewsChannel).messages.edit(g.message_id, payload).then((m) => m.id).catch(() => null);
      }
      if (!messageId) {
        const sent = await (ch as TextChannel | NewsChannel).send(payload);
        messageId = sent.id;
        if (g.channel_id && g.message_id) {
          const old = guild.channels.cache.get(g.channel_id);
          if (old?.isTextBased()) await old.messages.delete(g.message_id).catch(() => undefined);
        }
      }
      setPublished(ctx, guild.id, gid, ch.id, messageId);
      await logSystem(ctx, guild, `📢 <@${owner}> publicó el grupo **${g.name}** en <#${ch.id}>.`);
      return show({ kind: 'group', id: gid }, `📢 Panel publicado en <#${ch.id}>.`);
    }
    case 'del':
      return show({ kind: 'group', id: gid, confirmDelete: true }, '⚠️ ¿Seguro? Se borra el grupo y su panel publicado. Los miembros conservan sus roles.');
    case 'delok': {
      const g = deleteGroup(ctx, guild.id, gid);
      if (g.channel_id && g.message_id) {
        const ch = guild.channels.cache.get(g.channel_id);
        if (ch?.isTextBased()) await ch.messages.delete(g.message_id).catch(() => undefined);
      }
      await logSystem(ctx, guild, `🗑️ <@${owner}> eliminó el grupo de roles **${g.name}**.`);
      return show({ kind: 'home' }, `🗑️ Grupo **${g.name}** eliminado.`);
    }
    case 'rewards':
      return show({ kind: 'rewards' });
    case 'rwadd': {
      if (!i.isMessageComponent()) return;
      const roleId = values(i)[0];
      const problem = roleProblem(guild, guild.roles.cache.get(roleId));
      if (problem) throw new GameError(`No puedo usar ese rol como distinción: ${problem}.`);
      return i.showModal(new ModalBuilder().setCustomId(cid('ra', 'rwsave', owner, roleId)).setTitle('Distinción por nivel').addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('skill').setLabel('Habilidad: granja, pesca, total o actividad')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10).setPlaceholder('total')),
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('level').setLabel('Nivel requerido (o puntos, si es actividad)')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10).setPlaceholder('20 · o 2000 para actividad')),
      ));
    }
    case 'rwsave': {
      const roleId = id.args[0] ?? '';
      const problem = roleProblem(guild, guild.roles.cache.get(roleId));
      if (problem) throw new GameError(`No puedo usar ese rol como distinción: ${problem}.`);
      const skill = field(i, 'skill').toLowerCase() as RewardSkill;
      setReward(ctx, guild.id, roleId, skill, Number(field(i, 'level').replace(/[.\s]/g, '')));
      await logSystem(ctx, guild, `🏅 <@${owner}> configuró la distinción <@&${roleId}> (${skill} nv. ${field(i, 'level')}).`);
      return show({ kind: 'rewards' }, '✅ Distinción guardada. Se entrega al subir de nivel o al abrir el perfil.');
    }
    case 'rwdel':
      removeReward(ctx, guild.id, values(i)[0]);
      return show({ kind: 'rewards' }, '🗑️ Distinción quitada (nadie pierde el rol que ya tenía).');
    default:
      throw new GameError('Acción desconocida.');
  }
};

// ───────────────────────── roles: panel público ─────────────────────────

const rolesPublicHandler: Handler = async (app, i, id) => {
  const { ctx } = app;
  const g = getGroup(ctx, i.guild.id, Number(id.args[0]));
  const member = i.member;

  if (g.min_total_level > 0) {
    const p = ensureProfile(ctx, i.guild.id, member.id);
    if (totalLevel(p) < g.min_total_level) {
      throw new GameError(`Este grupo requiere nivel total **${g.min_total_level}** en El Valle (tenés ${totalLevel(p)}). ¡Seguí jugando con \`/granja\` y \`/pesca\`!`);
    }
  }

  if (id.act === 'open') {
    const panel = rolePicker(i.guild, member, g);
    await i.reply({ ...panel, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }

  const usable = g.roles.filter((r) => roleProblem(i.guild, i.guild.roles.cache.get(r)) === null);
  let desired: string[];
  if (id.act === 'pick') desired = values(i).filter((r) => usable.includes(r));
  else if (id.act === 'clear') desired = [];
  else throw new GameError('Acción desconocida.');
  if (g.mode === 'unico' && desired.length > 1) desired = desired.slice(0, 1);

  const toAdd = desired.filter((r) => !member.roles.cache.has(r));
  const toRemove = usable.filter((r) => member.roles.cache.has(r) && !desired.includes(r));
  let updated = member;
  if (toRemove.length) updated = await updated.roles.remove(toRemove, `Panel de roles: ${g.name}`);
  if (toAdd.length) updated = await updated.roles.add(toAdd, `Panel de roles: ${g.name}`);
  const notice = toAdd.length || toRemove.length
    ? `✅ Listo.${toAdd.length ? ` Agregados: ${toAdd.map((r) => `<@&${r}>`).join(' ')}.` : ''}${toRemove.length ? ` Quitados: ${toRemove.map((r) => `<@&${r}>`).join(' ')}.` : ''}`
    : 'Sin cambios.';
  await update(i, rolePicker(i.guild, updated, g, notice));
};

const topHandler: Handler = async (app, i) => {
  await update(i, await topPanel(app.ctx, i.guild, viewerOf(i.member), oneOf<TopCategory>(values(i)[0], TOP_CATEGORIES)));
};

// ───────────────────────── eventos ─────────────────────────

const eventsHandler: Handler = async (app, i, id) => {
  const { ctx } = app;
  const guild = i.guild;

  if (id.act === 'join') {
    // Anti cuentas alternativas: antigüedad de la cuenta y del ingreso al servidor (datos de Discord).
    const t = gameConfig(ctx, guild.id).tuning.events;
    const member = i.member;
    if (member.user.bot) throw new GameError('Los bots no participan.');
    const accountDays = (Date.now() - member.user.createdTimestamp) / 86_400_000;
    if (accountDays < t.minAccountDays) throw new GameError(`Tu cuenta de Discord tiene que tener al menos ${t.minAccountDays} días para participar.`);
    const memberHours = member.joinedTimestamp ? (Date.now() - member.joinedTimestamp) / 3_600_000 : 0;
    if (memberHours < t.minMemberHours) throw new GameError(`Tenés que llevar al menos ${t.minMemberHours} horas en el servidor para participar.`);
    const eventId = Number(id.args[0]);
    if (!Number.isSafeInteger(eventId)) throw new GameError('Evento inválido.');
    const r = joinEvent(ctx, eventId, guild.id, member.id);
    await i.reply({ content: `🎁 ¡Estás participando! Ya son **${r.participants}**. El sorteo cierra <t:${Math.ceil(r.endsAt / 1000)}:R>.`, flags: MessageFlags.Ephemeral });
    return;
  }

  requirePerm(i, PermissionFlagsBits.ManageGuild, 'Gestionar servidor');
  const owner = i.user.id;
  switch (id.act) {
    case 'view':
      return update(i, eventsAdminPanel(ctx, guild, owner));
    case 'chan': {
      const ch = guild.channels.cache.get(values(i)[0] ?? '');
      if (!ch || !ch.isTextBased()) throw new GameError('Elegí un canal de texto.');
      const me = guild.members.me!;
      if (!ch.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        throw new GameError(`No puedo escribir mensajes con embeds en <#${ch.id}>.`);
      }
      setEventChannel(ctx, guild.id, ch.id);
      await update(i, eventsAdminPanel(ctx, guild, owner, `📢 Los eventos se publicarán en <#${ch.id}>.`));
      await logSystem(ctx, guild, `🎉 <@${owner}> eligió <#${ch.id}> como canal de eventos.`);
      return;
    }
    case 'toggle': {
      const conf = setEventsEnabled(ctx, guild.id, !getEventConfig(ctx, guild.id).enabled);
      await update(i, eventsAdminPanel(ctx, guild, owner, conf.enabled ? '▶️ Eventos activados.' : '⏸️ Eventos desactivados.'));
      await logSystem(ctx, guild, `🎉 <@${owner}> ${conf.enabled ? 'activó' : 'desactivó'} los eventos automáticos.`);
      return;
    }
    case 'launch': {
      const e = await launchEvent(app, guild.id, true);
      const msg = !e ? 'No se pudo crear el evento.' : e.state === 'cancelled' ? '⚠️ El evento no se pudo publicar: revisá los permisos del canal.' : e.kind === 'marea' ? '🌅 ¡Salió una Marea dorada para todo el servidor!' : '🎁 Sorteo publicado.';
      await update(i, eventsAdminPanel(ctx, guild, owner, msg));
      return;
    }
    default:
      throw new GameError('Acción desconocida.');
  }
};

// ───────────────────────── logros ─────────────────────────

const profileHandler: Handler = async (app, i, id) => {
  const v = viewerOf(i.member);
  if (id.act === 'ach') return update(i, achievementsPanel(app.ctx, v, oneOf<AchFilter>(id.args[0] ?? 'todos', ACH_FILTERS), Number(id.args[1]) || 0));
  if (id.act === 'achf') return update(i, achievementsPanel(app.ctx, v, oneOf<AchFilter>(values(i)[0], ACH_FILTERS)));
  throw new GameError('Acción desconocida.');
};

// ───────────────────────── historial de avatares/banners ─────────────────────────

const mediaHandler: Handler = async (app, i, id) => {
  const kind = oneOf<'avatar' | 'banner'>(id.args[0], ['avatar', 'banner']);
  if (id.act === 'stats') {
    // Botón público: cada uno ve SUS estadísticas, en privado.
    await i.reply({ embeds: [mediaStats(app.ctx, i.user)], flags: MessageFlags.Ephemeral });
    return;
  }
  if (id.act !== 'sel') throw new GameError('Acción desconocida.');
  const userId = id.args[1] ?? '';
  if (!/^\d{17,20}$/.test(userId)) throw new GameError('Usuario inválido.');
  const user = app.client.users.cache.get(userId) ?? (await app.client.users.fetch(userId).catch(() => null));
  if (!user) throw new GameError('No encontré a ese usuario.');
  const choice = values(i)[0] ?? 'c';
  const view = choice === 'c' ? 'collage' : Number(choice);
  if (view !== 'collage' && (!Number.isInteger(view) || view < 0 || view > 63)) throw new GameError('Opción inválida.');
  if (!i.isMessageComponent()) return;
  await i.deferUpdate();
  const panel = await mediaPanel(app.ctx, i.user.id, user, kind, view, kind === 'avatar' ? user.avatar : user.banner ?? null);
  await i.editReply({ embeds: panel.embeds, components: panel.components, files: panel.files ?? [], attachments: [] });
};

// ───────────────────────── kiss: corresponder / rechazar ─────────────────────────

const kissHandler: Handler = async (app, i, id) => {
  const [authorId = '', targetId = ''] = id.args;
  if (!/^\d{17,20}$/.test(authorId) || !/^\d{17,20}$/.test(targetId)) throw new GameError('Botón inválido.');
  if (i.user.id !== targetId) {
    await i.reply({ content: `💌 Solo <@${targetId}> puede responder este beso.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }
  if (!i.isMessageComponent()) return;
  const author = await i.guild.members.fetch(authorId).catch(() => null);
  const authorName = author?.displayName ?? 'alguien';
  const targetName = i.member.displayName;
  if (id.act === 'back') {
    // Marca + beso de vuelta en una transacción: un doble clic no suma dos veces.
    const r = kissBack(app.ctx, i.message.id, i.guild.id, targetId, authorId);
    await i.deferUpdate();
    const gif = await randomKissGif();
    await i.editReply({
      embeds: [kissEmbed({ authorName: targetName, targetName: authorName, authorId: targetId, targetId: authorId, result: r, gif, back: true })],
      components: [kissAnsweredRow('correspondido')],
    });
    return;
  }
  if (id.act === 'no') {
    claimKissReply(app.ctx, i.message.id, i.guild.id, targetId, 'rechazado');
    const old = i.message.embeds[0] ? EmbedBuilder.from(i.message.embeds[0]) : new EmbedBuilder();
    old.setColor(0x80848e).setDescription(`${old.data.description ?? ''}\n\n💔 **${targetName}** rechazó el beso.`.slice(0, 4000));
    await i.update({ embeds: [old], components: [kissAnsweredRow('rechazado')] });
    return;
  }
  throw new GameError('Este beso ya fue respondido. 💌');
};

// ───────────────────────── premium: confirmar limpiezas ─────────────────────────

const premiumHandler: Handler = async (app, i, id) => {
  if (id.act === 'cancel') {
    await i.update({ embeds: [new EmbedBuilder().setColor(0x80848e).setDescription('Cancelado. No se borró nada.')], components: [] });
    return;
  }
  if (id.act !== 'clear') throw new GameError('Acción desconocida.');
  const kind = oneOf<ClearKind>(id.args[0], ['avatars', 'names', 'tags']);
  const info = clearInfo(kind);
  // Se vuelve a verificar el nivel al confirmar (pudo vencer entre medio).
  requireTier(app.ctx, i.user.id, info.tier, info.cmd);
  const n = kind === 'avatars' ? clearMedia(app.ctx, i.user.id, ['avatar', 'banner'])
    : kind === 'names' ? clearNames(app.ctx, i.user.id, ['username', 'display', 'nick'])
      : clearNames(app.ctx, i.user.id, ['tag']);
  // Lo actual se vuelve a registrar como único punto de partida.
  await fetchAndRecord(app, i.user.id, i.guild.id);
  if (kind === 'names' && i.member.nickname) recordName(app.ctx, i.user.id, 'nick', i.member.nickname, i.guild.id);
  await i.update({ embeds: [new EmbedBuilder().setColor(0x57f287).setDescription(`🗑️ Listo: borré ${n} registro${n === 1 ? '' : 's'} de tu historial de ${info.label}.`)], components: [] });
};

export const HANDLERS: Record<string, Handler> = {
  pr: premiumHandler,
  ks: kissHandler,
  av: mediaHandler,
  pf: profileHandler,
  ev: eventsHandler,
  tp: topHandler,
  fa: farmHandler,
  fi: fishHandler,
  mk: marketHandler,
  iv: inventoryHandler,
  hp: helpHandler,
  nav: navHandler,
  st: settingsHandler,
  ra: rolesAdminHandler,
  rp: rolesPublicHandler,
};
