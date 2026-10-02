import {
  ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, EmbedBuilder, RoleSelectMenuBuilder,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, type Guild, type GuildMember,
} from 'discord.js';
import type { GameContext } from '../../services/context';
import { getGroup, listGroups, listRewards, type RoleGroup } from '../../services/roles';
import { row, type Panel, type Row } from '../app';
import { roleProblem } from '../roleSafety';
import { cid } from './ids';
import { COLORS, clean, truncate } from './theme';

export type RolesView = { kind: 'home' } | { kind: 'group'; id: number; confirmDelete?: boolean } | { kind: 'rewards' };

const MODE_TEXT = { libre: '🧩 Libre (varios a la vez)', unico: '🎯 Único (uno por grupo)' } as const;

function roleLine(guild: Guild, roleId: string): string {
  const role = guild.roles.cache.get(roleId);
  const problem = roleProblem(guild, role);
  return problem ? `⚠️ ${role ? `<@&${roleId}>` : `\`${roleId}\``} — ${problem}` : `• <@&${roleId}>`;
}

export function rolesAdminPanel(ctx: GameContext, guild: Guild, owner: string, view: RolesView, notice?: string): Panel {
  const embed = new EmbedBuilder().setColor(COLORS.roles).setAuthor({ name: 'Centro de roles' });
  const rows: Row[] = [];
  const head = notice ? `${notice}\n\n` : '';

  if (view.kind === 'home') {
    const groups = listGroups(ctx, guild.id);
    embed.setTitle('🎭 Grupos de roles')
      .setDescription(`${head}Creá **grupos** de roles que los miembros eligen desde un panel propio (con su selección actual ya marcada). ` +
        'Cada grupo puede ser **libre** o **único** y exigir un nivel mínimo del casino.\n\n' +
        (groups.length
          ? groups.map((g) => `**${clean(g.name)}** · ${MODE_TEXT[g.mode]} · ${g.roles.length} roles${g.min_total_level ? ` · nv. ${g.min_total_level}+` : ''}${g.channel_id ? ` · publicado en <#${g.channel_id}>` : ' · sin publicar'}`).join('\n')
          : '*Todavía no hay grupos.*'));
    if (groups.length) {
      rows.push(row(new StringSelectMenuBuilder().setCustomId(cid('ra', 'group', owner)).setPlaceholder('Administrar un grupo…')
        .addOptions(groups.map((g) => new StringSelectMenuOptionBuilder().setValue(String(g.id)).setLabel(truncate(g.name, 100))
          .setDescription(`${g.roles.length} roles · ${g.mode}`)))));
    }
    rows.push(row(
      new ButtonBuilder().setCustomId(cid('ra', 'new', owner)).setLabel('Nuevo grupo').setEmoji('➕').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(cid('ra', 'rewards', owner)).setLabel('Distinciones por nivel').setEmoji('🏅').setStyle(ButtonStyle.Primary),
    ));
    return { embeds: [embed], components: rows };
  }

  if (view.kind === 'rewards') {
    const rewards = listRewards(ctx, guild.id);
    embed.setTitle('🏅 Distinciones')
      .setDescription(`${head}Roles que se otorgan **automáticamente** al alcanzar un **nivel del casino** (el nivel sube con el total apostado, no con lo ganado). ` +
        'Se entregan al subir de nivel y al abrir el perfil. Nunca se quitan solas.\n\n' +
        (rewards.length ? rewards.map((r) => `${roleLine(guild, r.role_id)} — **nivel ${r.level}**`).join('\n') : '*No hay distinciones configuradas.*'));
    rows.push(row(new RoleSelectMenuBuilder().setCustomId(cid('ra', 'rwadd', owner)).setPlaceholder('Agregar o editar una distinción…').setMinValues(1).setMaxValues(1)));
    if (rewards.length) {
      rows.push(row(new StringSelectMenuBuilder().setCustomId(cid('ra', 'rwdel', owner)).setPlaceholder('Quitar una distinción…')
        .addOptions(rewards.map((r) => new StringSelectMenuOptionBuilder().setValue(r.role_id)
          .setLabel(truncate(guild.roles.cache.get(r.role_id)?.name ?? r.role_id, 100)).setDescription(`Nivel ${r.level}`)))));
    }
    rows.push(row(new ButtonBuilder().setCustomId(cid('ra', 'home', owner)).setLabel('Volver').setEmoji('↩️').setStyle(ButtonStyle.Secondary)));
    return { embeds: [embed], components: rows };
  }

  const g = getGroup(ctx, guild.id, view.id);
  embed.setTitle(`🎭 ${clean(g.name)}`)
    .setDescription(`${head}${g.description ? `${clean(g.description)}\n\n` : ''}**Modo:** ${MODE_TEXT[g.mode]}\n**Nivel mínimo del casino:** ${g.min_total_level || 'ninguno'}\n` +
      `**Publicado en:** ${g.channel_id ? `<#${g.channel_id}>` : 'todavía no'}\n\n**Roles (${g.roles.length}/25):**\n${g.roles.map((r) => roleLine(guild, r)).join('\n') || '*Agregá roles con el menú de abajo.*'}`)
    .setFooter({ text: 'Los roles con permisos de moderación, gestionados por bots o por encima del bot se rechazan automáticamente.' });

  if (view.confirmDelete) {
    rows.push(row(
      new ButtonBuilder().setCustomId(cid('ra', 'delok', owner, g.id)).setLabel('Sí, eliminar grupo').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(cid('ra', 'group', owner, g.id)).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
    ));
    return { embeds: [embed], components: rows };
  }
  rows.push(row(new RoleSelectMenuBuilder().setCustomId(cid('ra', 'addroles', owner, g.id)).setPlaceholder('Agregar roles al grupo…').setMinValues(1).setMaxValues(25)));
  if (g.roles.length) {
    rows.push(row(new StringSelectMenuBuilder().setCustomId(cid('ra', 'rmrole', owner, g.id)).setPlaceholder('Quitar un rol del grupo…')
      .addOptions(g.roles.slice(0, 25).map((id) => new StringSelectMenuOptionBuilder().setValue(id).setLabel(truncate(guild.roles.cache.get(id)?.name ?? id, 100))))));
  }
  rows.push(row(new ChannelSelectMenuBuilder().setCustomId(cid('ra', 'publish', owner, g.id))
    .setPlaceholder(g.channel_id ? 'Republicar / mover el panel a…' : 'Publicar el panel en…').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)));
  rows.push(row(
    new ButtonBuilder().setCustomId(cid('ra', 'mode', owner, g.id)).setLabel(g.mode === 'libre' ? 'Cambiar a único' : 'Cambiar a libre').setEmoji('🔁').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('ra', 'edit', owner, g.id)).setLabel('Editar texto y nivel').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('ra', 'del', owner, g.id)).setLabel('Eliminar').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cid('ra', 'home', owner)).setLabel('Volver').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
  ));
  return { embeds: [embed], components: rows };
}

/** Mensaje público del grupo: un solo botón que abre un selector personal. */
export function publicGroupMessage(guild: Guild, g: RoleGroup): Panel {
  const available = g.roles.filter((id) => guild.roles.cache.has(id));
  const embed = new EmbedBuilder()
    .setColor(COLORS.roles)
    .setTitle(`🎭 ${clean(g.name)}`)
    .setDescription(`${g.description ? `${clean(g.description)}\n\n` : ''}${available.map((id) => `• <@&${id}>`).join('\n') || '*Sin roles disponibles.*'}`)
    .setFooter({ text: `${g.mode === 'libre' ? 'Podés elegir varios.' : 'Solo podés tener uno.'}${g.min_total_level ? ` Requiere nivel ${g.min_total_level} del casino.` : ''}` });
  return {
    embeds: [embed],
    components: [row(new ButtonBuilder().setCustomId(cid('rp', 'open', '0', g.id)).setLabel('Elegir mis roles').setEmoji('🎭').setStyle(ButtonStyle.Primary))],
  };
}

/** Selector personal (efímero) con los roles actuales del miembro ya marcados. */
export function rolePicker(guild: Guild, member: GuildMember, g: RoleGroup, notice?: string): Panel {
  const usable = g.roles.map((id) => guild.roles.cache.get(id)).filter((r) => r && roleProblem(guild, r) === null).map((r) => r!);
  const embed = new EmbedBuilder().setColor(COLORS.roles).setTitle(`🎭 ${clean(g.name)}`)
    .setDescription(`${notice ? `${notice}\n\n` : ''}${usable.length ? 'Marcá los roles que querés tener y desmarcá los que no. El cambio se aplica al cerrar el menú.' : '*Este grupo no tiene roles disponibles ahora mismo.*'}`);
  if (!usable.length) return { embeds: [embed], components: [] };
  // En modo único solo puede haber un valor por defecto (si no, Discord rechaza el menú).
  let defaults = 0;
  const maxDefaults = g.mode === 'libre' ? usable.length : 1;
  const select = new StringSelectMenuBuilder().setCustomId(cid('rp', 'pick', member.id, g.id))
    .setPlaceholder(g.mode === 'libre' ? 'Elegí tus roles…' : 'Elegí un rol…')
    .setMinValues(0).setMaxValues(g.mode === 'libre' ? usable.length : 1)
    .addOptions(usable.map((r) => new StringSelectMenuOptionBuilder().setValue(r.id).setLabel(truncate(r.name, 100)).setDefault(member.roles.cache.has(r.id) && defaults++ < maxDefaults)));
  return {
    embeds: [embed],
    components: [
      row(select),
      row(new ButtonBuilder().setCustomId(cid('rp', 'clear', member.id, g.id)).setLabel('Quitarme todos').setEmoji('🧹').setStyle(ButtonStyle.Secondary)),
    ],
  };
}
