import {
  ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, EmbedBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder, type Guild,
} from 'discord.js';
import type { GameContext } from '../../services/context';
import {
  AUTOMOD_NUMBERS, CASE_META, caseSummary, countCases, formatDuration, getAutomod, getRaidUntil, listCases, listModRoles, type AutomodConfig, type ModCase,
} from '../../services/moderation';
import { row, type Panel, type Row } from '../app';
import { cid } from './ids';
import { COLORS, clean, truncate } from './theme';

const REVOKED_COLOR = 0x80848e;
export const HISTORY_PAGE = 8;

const ts = (ms: number, style: 'R' | 'f' | 'd' = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;

/** Ficha de un caso (log de moderación, /mod caso y el MD a quien recibe la sanción). */
export function caseEmbed(c: ModCase): EmbedBuilder {
  const m = CASE_META[c.action];
  const e = new EmbedBuilder()
    .setColor(c.active ? m.color : REVOKED_COLOR)
    .setTitle(`${m.emoji} ${m.label} · Caso #${c.number}${c.active ? '' : ' (anulado)'}`)
    .addFields(
      { name: 'Usuario', value: `<@${c.targetId}> (\`${c.targetId}\`)`, inline: true },
      { name: 'Moderador', value: c.auto ? '🤖 Automod' : `<@${c.moderatorId}>`, inline: true },
    )
    .setTimestamp(c.createdAt);
  if (c.durationMs) e.addFields({ name: 'Duración', value: `${formatDuration(c.durationMs)} · hasta ${ts(c.createdAt + c.durationMs, 'f')}`, inline: true });
  if (c.action === 'warn' && c.expiresAt && c.active) e.addFields({ name: 'Vence', value: ts(c.expiresAt), inline: true });
  e.addFields({ name: 'Motivo', value: truncate(c.reason || 'Sin motivo', 1024) });
  if (!c.active && c.revokedBy) e.addFields({ name: 'Anulado', value: `por <@${c.revokedBy}> ${c.revokedAt ? ts(c.revokedAt) : ''}` });
  return e;
}

/** MD a quien recibe la sanción (sin datos del moderador: solo el servidor, el motivo y el número de caso). */
export function sanctionDm(c: ModCase, guildName: string, activeWarns?: number): EmbedBuilder {
  const m = CASE_META[c.action];
  const verb: Record<string, string> = {
    warn: 'Recibiste una advertencia', timeout: 'Fuiste aislado', untimeout: 'Se terminó tu aislamiento', kick: 'Fuiste expulsado', ban: 'Fuiste baneado', unban: 'Se levantó tu baneo',
  };
  const e = new EmbedBuilder().setColor(m.color).setTitle(`${m.emoji} ${verb[c.action]} en ${truncate(guildName, 200)}`)
    .addFields({ name: 'Motivo', value: truncate(c.reason, 1024) });
  if (c.durationMs) e.addFields({ name: 'Duración', value: `${formatDuration(c.durationMs)} (hasta ${ts(c.createdAt + c.durationMs, 'f')})` });
  if (c.action === 'warn' && activeWarns !== undefined) e.addFields({ name: 'Advertencias activas', value: String(activeWarns), inline: true });
  return e.setFooter({ text: `Caso #${c.number} · Si creés que es un error, hablá con el staff del servidor.` }).setTimestamp(c.createdAt);
}

export interface TargetView {
  id: string;
  name: string;
  avatar: string | null;
}

/** /mod historial: resumen y casos de una persona, paginado. */
export function historyPanel(ctx: GameContext, guildId: string, viewerId: string, target: TargetView, page = 0): Panel {
  const s = caseSummary(ctx, guildId, target.id);
  const pageCount = Math.max(1, Math.ceil(countCases(ctx, guildId, target.id) / HISTORY_PAGE));
  const pg = Math.min(Math.max(0, page), pageCount - 1);
  const cases = listCases(ctx, guildId, target.id, HISTORY_PAGE, pg * HISTORY_PAGE);
  const line = (c: ModCase) => {
    const m = CASE_META[c.action];
    const text = `**#${c.number}** ${m.emoji} ${m.label}${c.durationMs ? ` (${formatDuration(c.durationMs)})` : ''} — ${clean(truncate(c.reason, 80))} · ${ts(c.createdAt)}${c.auto ? ' · 🤖' : ''}`;
    return c.active ? text : `~~${text}~~ *(anulado)*`;
  };
  const e = new EmbedBuilder()
    .setColor(s.activeWarns ? CASE_META.warn.color : COLORS.settings)
    .setAuthor({ name: `Historial de moderación de ${target.name}`, iconURL: target.avatar ?? undefined })
    .setDescription([
      `⚠️ **${s.activeWarns}** advertencias activas · ⏱️ ${s.byAction.timeout} aislamientos · 👢 ${s.byAction.kick} expulsiones · 🔨 ${s.byAction.ban} baneos`,
      '',
      cases.length ? cases.map(line).join('\n') : '*Sin casos. ¡Expediente limpio!* ✨',
    ].join('\n'))
    .setFooter({ text: `${pageCount > 1 ? `Página ${pg + 1}/${pageCount} · ` : ''}ID ${target.id}` });
  const rows: Row[] = [];
  if (cases.length) {
    rows.push(row(new StringSelectMenuBuilder().setCustomId(cid('md', 'case', viewerId)).setPlaceholder('Ver un caso…')
      .addOptions(cases.map((c) => new StringSelectMenuOptionBuilder().setValue(String(c.number))
        .setLabel(truncate(`#${c.number} · ${CASE_META[c.action].label}${c.active ? '' : ' (anulado)'}`, 100))
        .setDescription(truncate(c.reason, 100)).setEmoji(CASE_META[c.action].emoji)))));
  }
  if (pageCount > 1) {
    rows.push(row(
      new ButtonBuilder().setCustomId(cid('md', 'hist', viewerId, target.id, pg - 1)).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(pg === 0),
      new ButtonBuilder().setCustomId(cid('md', 'hist', viewerId, target.id, pg + 1)).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(pg >= pageCount - 1),
    ));
  }
  return { embeds: [e], components: rows };
}

/** /mod caso: ficha con acciones (editar motivo, anular) para quien puede editarlos. */
export function casePanel(c: ModCase, viewerId: string, canEdit: boolean, notice?: string): Panel {
  const e = caseEmbed(c);
  if (notice) e.setDescription(notice);
  const buttons = [
    new ButtonBuilder().setCustomId(cid('md', 'hist', viewerId, c.targetId, 0)).setLabel('Historial').setEmoji('📜').setStyle(ButtonStyle.Secondary),
  ];
  if (canEdit) {
    buttons.unshift(
      new ButtonBuilder().setCustomId(cid('md', 'reason', viewerId, c.number)).setLabel('Editar motivo').setEmoji('✏️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(cid('md', 'revoke', viewerId, c.number)).setLabel('Anular').setEmoji('🚫').setStyle(ButtonStyle.Danger).setDisabled(!c.active),
    );
  }
  return { embeds: [e], components: [row(...buttons)] };
}

// ───────────────────────── /automod ─────────────────────────

export const AUTOMOD_SECTIONS = ['resumen', 'spam', 'flood', 'enlaces', 'raid', 'advertencias', 'roles'] as const;
export type AutomodSection = (typeof AUTOMOD_SECTIONS)[number];

const SECTION_META: Record<AutomodSection, { label: string; emoji: string; description: string }> = {
  resumen: { label: 'Resumen', emoji: '🛡️', description: 'Estado de todo el sistema' },
  spam: { label: 'Antispam', emoji: '🚫', description: 'Ráfagas de mensajes → aislamiento' },
  flood: { label: 'Antiflood', emoji: '🌊', description: 'Repetidos, menciones y paredes de texto' },
  enlaces: { label: 'Enlaces', emoji: '🔗', description: 'Invitaciones y enlaces permitidos' },
  raid: { label: 'Antiraid', emoji: '🚨', description: 'Muchas entradas juntas' },
  advertencias: { label: 'Advertencias', emoji: '⚠️', description: 'Vencimiento y sanciones automáticas' },
  roles: { label: 'Roles y exenciones', emoji: '👮', description: 'Quién modera y a quién no se le aplica' },
};

const onOff = (b: boolean) => (b ? '🟢 activado' : '🔴 desactivado');
const LINK_MODE = { off: '🔓 Sin filtro', invites: '📨 Solo invitaciones a otros servidores', all: '🔗 Todos los enlaces (salvo los permitidos)' } as const;
const RAID_ACTION = { alert: '📣 Solo avisar', timeout: '⏱️ Aislar cuentas nuevas', kick: '👢 Expulsar cuentas nuevas' } as const;

function warnRules(cfg: AutomodConfig): string {
  const w = cfg.warns;
  const rules = [
    w.timeoutAt ? `${w.timeoutAt} → aislar ${formatDuration(w.timeoutMinutes * 60_000)}` : '',
    w.kickAt ? `${w.kickAt} → expulsar` : '',
    w.banAt ? `${w.banAt}+ → banear` : '',
  ].filter(Boolean);
  return rules.length ? rules.join(' · ') : 'sin sanciones automáticas';
}

export function automodPanel(ctx: GameContext, guild: Guild, owner: string, section: AutomodSection = 'resumen', notice?: string): Panel {
  const cfg = getAutomod(ctx, guild.id);
  const raidUntil = getRaidUntil(ctx, guild.id);
  const raidOn = raidUntil > Date.now();
  const meta = SECTION_META[section];
  const e = new EmbedBuilder().setColor(raidOn ? COLORS.error : COLORS.settings).setTitle(`${meta.emoji} Automod · ${meta.label}`);
  const head = notice ? `${notice}\n\n` : '';
  const btn = (act: string, label: string, emoji: string, style = ButtonStyle.Secondary, ...args: string[]) =>
    new ButtonBuilder().setCustomId(cid('am', act, owner, ...args)).setLabel(label).setEmoji(emoji).setStyle(style);
  const toggle = (key: 'spam' | 'flood' | 'raid' | 'dm', on: boolean) => btn('toggle', on ? 'Desactivar' : 'Activar', on ? '⏸️' : '▶️', on ? ButtonStyle.Danger : ButtonStyle.Success, key);
  const rows: Row[] = [row(new StringSelectMenuBuilder().setCustomId(cid('am', 'sec', owner)).setPlaceholder('Sección…')
    .addOptions(AUTOMOD_SECTIONS.map((s) => new StringSelectMenuOptionBuilder().setValue(s).setLabel(SECTION_META[s].label)
      .setEmoji(SECTION_META[s].emoji).setDescription(SECTION_META[s].description).setDefault(s === section))))];
  const num = (k: keyof typeof AUTOMOD_NUMBERS, v: number) => `${AUTOMOD_NUMBERS[k].label}: **${v}**`;

  switch (section) {
    case 'resumen': {
      const roles = listModRoles(ctx, guild.id);
      e.setDescription(head + [
        raidOn ? `🚨 **MODO RAID ACTIVO** hasta ${ts(raidUntil)}.` : '',
        `🚫 **Antispam:** ${onOff(cfg.spam.enabled)} · más de ${cfg.spam.maxMessages} mensajes en ${cfg.spam.perSeconds} s → aislar ${cfg.spam.timeoutMinutes} min`,
        `🌊 **Antiflood:** ${onOff(cfg.flood.enabled)} · ${cfg.flood.maxDuplicates} repetidos · ${cfg.flood.maxMentions} menciones · ${cfg.flood.maxLines} líneas`,
        `🔗 **Enlaces:** ${LINK_MODE[cfg.links.mode]}`,
        `🚨 **Antiraid:** ${onOff(cfg.raid.enabled)} · ${cfg.raid.joins} entradas en ${cfg.raid.perSeconds} s → ${RAID_ACTION[cfg.raid.action]}`,
        `⚠️ **Advertencias:** ${cfg.strikesToWarn ? `${cfg.strikesToWarn} infracciones del automod = 1 advertencia` : 'el automod no advierte'} · ${warnRules(cfg)}`,
        `👮 **Roles de moderación:** ${roles.length ? roles.map((r) => `<@&${r.roleId}> (${r.level})`).join(' ') : '*ninguno (alcanzan los permisos de Discord)*'}`,
        `📬 **MD al sancionar:** ${cfg.dmOnAction ? 'sí' : 'no'}`,
        '',
        '-# El staff (Administrador, Gestionar servidor o Gestionar mensajes), los roles de moderación y lo que esté en exenciones nunca pasan por el automod.',
      ].filter((x) => x !== '').join('\n'));
      rows.push(row(
        btn('raidnow', raidOn ? 'Terminar modo raid' : `Activar modo raid (${cfg.raid.minutes} min)`, '🚨', raidOn ? ButtonStyle.Success : ButtonStyle.Danger),
        btn('view', 'Actualizar', '🔄'),
      ));
      break;
    }
    case 'spam':
      e.setDescription(head + [
        `**Estado:** ${onOff(cfg.spam.enabled)}`,
        num('spam.maxMessages', cfg.spam.maxMessages), num('spam.perSeconds', cfg.spam.perSeconds), num('spam.timeoutMinutes', cfg.spam.timeoutMinutes),
        '',
        '-# Si alguien manda más mensajes que el máximo dentro de esa ventana, se borran esos mensajes y se lo aísla (queda un caso).',
      ].join('\n'));
      rows.push(row(toggle('spam', cfg.spam.enabled), btn('edit', 'Editar valores', '✏️', ButtonStyle.Primary, 'spam')));
      break;
    case 'flood':
      e.setDescription(head + [
        `**Estado:** ${onOff(cfg.flood.enabled)}`,
        num('flood.maxDuplicates', cfg.flood.maxDuplicates), num('flood.maxMentions', cfg.flood.maxMentions), num('flood.maxLines', cfg.flood.maxLines),
        num('strikesToWarn', cfg.strikesToWarn),
        '',
        '-# El mensaje se borra con un aviso corto. Varias infracciones en 10 minutos (flood o enlaces) suman una advertencia.',
      ].join('\n'));
      rows.push(row(toggle('flood', cfg.flood.enabled), btn('edit', 'Editar valores', '✏️', ButtonStyle.Primary, 'flood')));
      break;
    case 'enlaces':
      e.setDescription(head + [
        `**Modo:** ${LINK_MODE[cfg.links.mode]}`,
        `**Dominios permitidos:** ${cfg.links.allow.length ? cfg.links.allow.map((d) => `\`${d}\``).join(' ') : '*ninguno*'}`,
        '',
        '-# Los enlaces de Discord (mensajes, adjuntos) siempre se permiten. Los subdominios de un dominio permitido también.',
      ].join('\n'));
      rows.push(row(new StringSelectMenuBuilder().setCustomId(cid('am', 'linkmode', owner)).setPlaceholder('Modo del filtro…')
        .addOptions((Object.keys(LINK_MODE) as (keyof typeof LINK_MODE)[]).map((k) => new StringSelectMenuOptionBuilder().setValue(k).setLabel(LINK_MODE[k].slice(3)).setEmoji(LINK_MODE[k].slice(0, 2)).setDefault(cfg.links.mode === k)))));
      rows.push(row(btn('edit', 'Dominios permitidos', '✏️', ButtonStyle.Primary, 'enlaces')));
      break;
    case 'raid':
      e.setDescription(head + [
        `**Estado:** ${onOff(cfg.raid.enabled)}${raidOn ? ` · 🚨 **activo** hasta ${ts(raidUntil)}` : ''}`,
        num('raid.joins', cfg.raid.joins), num('raid.perSeconds', cfg.raid.perSeconds), num('raid.accountDays', cfg.raid.accountDays), num('raid.minutes', cfg.raid.minutes),
        `**Acción durante el modo raid:** ${RAID_ACTION[cfg.raid.action]}`,
        '',
        '-# Al detectar un raid se avisa en los registros y, durante el modo raid, se aplica la acción a las cuentas nuevas que entren.',
      ].join('\n'));
      rows.push(row(new StringSelectMenuBuilder().setCustomId(cid('am', 'raidact', owner)).setPlaceholder('Acción durante el raid…')
        .addOptions((Object.keys(RAID_ACTION) as (keyof typeof RAID_ACTION)[]).map((k) => new StringSelectMenuOptionBuilder().setValue(k).setLabel(RAID_ACTION[k].slice(3)).setEmoji(RAID_ACTION[k].slice(0, 2)).setDefault(cfg.raid.action === k)))));
      rows.push(row(toggle('raid', cfg.raid.enabled), btn('edit', 'Editar valores', '✏️', ButtonStyle.Primary, 'raid'),
        btn('raidnow', raidOn ? 'Terminar modo raid' : 'Activar ahora', '🚨', raidOn ? ButtonStyle.Success : ButtonStyle.Danger)));
      break;
    case 'advertencias':
      e.setDescription(head + [
        num('warns.expireDays', cfg.warns.expireDays), num('warns.timeoutAt', cfg.warns.timeoutAt), num('warns.timeoutMinutes', cfg.warns.timeoutMinutes),
        num('warns.kickAt', cfg.warns.kickAt), num('warns.banAt', cfg.warns.banAt),
        `**MD al sancionar:** ${cfg.dmOnAction ? 'sí' : 'no'}`,
        '',
        `-# Escalado actual: ${warnRules(cfg)}. Las advertencias anuladas o vencidas no cuentan.`,
      ].join('\n'));
      rows.push(row(btn('edit', 'Editar valores', '✏️', ButtonStyle.Primary, 'advertencias'), toggle('dm', cfg.dmOnAction).setLabel(cfg.dmOnAction ? 'No avisar por MD' : 'Avisar por MD').setEmoji('📬')));
      break;
    case 'roles': {
      const roles = listModRoles(ctx, guild.id);
      const mods = roles.filter((r) => r.level === 'mod').map((r) => r.roleId);
      const admins = roles.filter((r) => r.level === 'admin').map((r) => r.roleId);
      e.setDescription(head + [
        `👮 **Moderadores** (advertir, aislar, ver historial): ${mods.map((r) => `<@&${r}>`).join(' ') || '*ninguno*'}`,
        `🛡️ **Administradores** (además expulsar, banear y editar casos): ${admins.map((r) => `<@&${r}>`).join(' ') || '*ninguno*'}`,
        `🙈 **Roles exentos del automod:** ${cfg.exemptRoles.map((r) => `<@&${r}>`).join(' ') || '*ninguno*'}`,
        `🙈 **Canales exentos:** ${cfg.exemptChannels.map((c) => `<#${c}>`).join(' ') || '*ninguno*'}`,
        '',
        '-# Quien tenga los permisos de Discord (Moderar miembros, Expulsar, Banear) puede usar los comandos aunque no tenga estos roles. Para limpiar una lista, abrí el menú y deseleccioná todo.',
      ].join('\n'));
      rows.push(
        row(new RoleSelectMenuBuilder().setCustomId(cid('am', 'modroles', owner, 'mod')).setPlaceholder('Roles de moderador…').setMinValues(0).setMaxValues(10).setDefaultRoles(mods.slice(0, 10))),
        row(new RoleSelectMenuBuilder().setCustomId(cid('am', 'modroles', owner, 'admin')).setPlaceholder('Roles de administrador…').setMinValues(0).setMaxValues(10).setDefaultRoles(admins.slice(0, 10))),
        row(new RoleSelectMenuBuilder().setCustomId(cid('am', 'exroles', owner)).setPlaceholder('Roles exentos del automod…').setMinValues(0).setMaxValues(25).setDefaultRoles(cfg.exemptRoles)),
        row(new ChannelSelectMenuBuilder().setCustomId(cid('am', 'exchans', owner)).setPlaceholder('Canales o categorías exentos…').setMinValues(0).setMaxValues(25)
          .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildCategory, ChannelType.GuildVoice).setDefaultChannels(cfg.exemptChannels)),
      );
      break;
    }
  }
  return { embeds: [e], components: rows };
}
