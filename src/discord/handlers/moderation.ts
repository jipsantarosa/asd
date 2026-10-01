import { ActionRowBuilder, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle } from 'discord.js';
import { GameError } from '../../services/context';
import {
  AUTOMOD_NUMBERS, REASON_MAX, getAutomod, getCase, getRaidUntil, normalizeDomains, revokeCase, saveAutomod, setAutomodNumber, setCaseReason,
  setModRoles, setRaidUntil, type AutomodNumberKey, type LinkMode, type RaidAction,
} from '../../services/moderation';
import { logSystem } from '../logging/sender';
import { canModerate, refreshCaseLog, requireModerator } from '../moderation/actions';
import { cid } from '../ui/ids';
import { AUTOMOD_SECTIONS, automodPanel, casePanel, historyPanel, type AutomodSection } from '../ui/modPanels';
import { COLORS } from '../ui/theme';
import { field, update, values, type Handler } from './util';

const SNOWFLAKE = /^\d{17,20}$/;

// ───────────────────────── Historial y casos ─────────────────────────

export const modHandler: Handler = async (app, i, id) => {
  const { ctx } = app;
  const guild = i.guild;
  const viewer = i.user.id;
  switch (id.act) {
    case 'hist': {
      requireModerator(app, i.member, 'history');
      const targetId = id.args[0] ?? '';
      if (!SNOWFLAKE.test(targetId)) throw new GameError('Usuario inválido.');
      const user = await app.client.users.fetch(targetId).catch(() => null);
      const member = guild.members.cache.get(targetId);
      return update(i, historyPanel(ctx, guild.id, viewer, {
        id: targetId, name: member?.displayName ?? user?.username ?? targetId, avatar: user?.displayAvatarURL({ size: 64 }) ?? null,
      }, Number(id.args[1]) || 0));
    }
    case 'case': {
      requireModerator(app, i.member, 'history');
      const c = getCase(ctx, guild.id, Number(values(i)[0]));
      if (!c) throw new GameError('Ese caso ya no existe.');
      return update(i, casePanel(c, viewer, canModerate(app, i.member, 'editcase')));
    }
    case 'reason': {
      requireModerator(app, i.member, 'editcase');
      const c = getCase(ctx, guild.id, Number(id.args[0]));
      if (!c || !i.isButton()) throw new GameError('Ese caso ya no existe.');
      await i.showModal(new ModalBuilder().setCustomId(cid('md', 'reasonsave', viewer, c.number)).setTitle(`Caso #${c.number}`).addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Motivo')
          .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(REASON_MAX).setValue(c.reason.slice(0, REASON_MAX))),
      ));
      return;
    }
    case 'reasonsave': {
      requireModerator(app, i.member, 'editcase');
      const c = setCaseReason(ctx, guild.id, Number(id.args[0]), field(i, 'reason'));
      await refreshCaseLog(app, guild, c);
      await update(i, casePanel(c, viewer, true, '✏️ Motivo actualizado (también en el registro de moderación).'));
      await logSystem(ctx, guild, `✏️ <@${viewer}> editó el motivo del caso #${c.number}.`);
      return;
    }
    case 'revoke': {
      requireModerator(app, i.member, 'editcase');
      const c = revokeCase(ctx, guild.id, Number(id.args[0]), viewer);
      let extra = '';
      if (c.action === 'timeout') {
        // Anular un aislamiento que sigue vigente también lo levanta.
        const m = await guild.members.fetch(c.targetId).catch(() => null);
        if (m?.isCommunicationDisabled()) {
          const ok = await m.timeout(null, `Caso #${c.number} anulado por ${i.user.username}`).then(() => true).catch(() => false);
          extra = ok ? ' También le quité el aislamiento.' : ' ⚠️ No pude quitarle el aislamiento (revisá mis permisos).';
        }
      } else if (c.action === 'ban') {
        extra = ' El baneo sigue vigente: para levantarlo usá `/mod unban`.';
      } else if (c.action === 'warn') {
        extra = ' Esa advertencia ya no cuenta para las sanciones automáticas.';
      }
      await refreshCaseLog(app, guild, c);
      await update(i, casePanel(c, viewer, true, `🚫 Caso #${c.number} anulado.${extra}`));
      await logSystem(ctx, guild, `🚫 <@${viewer}> anuló el caso #${c.number} (${c.action} a <@${c.targetId}>).`);
      return;
    }
    default:
      throw new GameError('Acción desconocida.');
  }
};

// ───────────────────────── /automod ─────────────────────────

const EDIT_FIELDS: Record<'spam' | 'flood' | 'raid' | 'advertencias', AutomodNumberKey[]> = {
  spam: ['spam.maxMessages', 'spam.perSeconds', 'spam.timeoutMinutes'],
  flood: ['flood.maxDuplicates', 'flood.maxMentions', 'flood.maxLines', 'strikesToWarn'],
  raid: ['raid.joins', 'raid.perSeconds', 'raid.accountDays', 'raid.minutes'],
  advertencias: ['warns.expireDays', 'warns.timeoutAt', 'warns.timeoutMinutes', 'warns.kickAt', 'warns.banAt'],
};

function readNumber(cfg: object, key: AutomodNumberKey): number {
  const [a, b] = key.split('.');
  const v = (cfg as Record<string, unknown>)[a];
  return (b ? (v as Record<string, number>)[b] : v) as number;
}

export const automodHandler: Handler = async (app, i, id) => {
  if (!i.member.permissions.has(PermissionFlagsBits.ManageGuild)) throw new GameError('Necesitás el permiso **Gestionar servidor**.');
  const { ctx } = app;
  const guild = i.guild;
  const owner = i.user.id;
  const show = (section: AutomodSection, notice?: string) => update(i, automodPanel(ctx, guild, owner, section, notice));
  const audit = (text: string) => logSystem(ctx, guild, `🛡️ <@${owner}> ${text}`);
  const cfg = structuredClone(getAutomod(ctx, guild.id));

  switch (id.act) {
    case 'sec': {
      const section = values(i)[0] as AutomodSection;
      if (!AUTOMOD_SECTIONS.includes(section)) throw new GameError('Sección inválida.');
      return show(section);
    }
    case 'view':
      return show('resumen');
    case 'toggle': {
      const key = id.args[0];
      if (key === 'spam') cfg.spam.enabled = !cfg.spam.enabled;
      else if (key === 'flood') cfg.flood.enabled = !cfg.flood.enabled;
      else if (key === 'raid') cfg.raid.enabled = !cfg.raid.enabled;
      else if (key === 'dm') cfg.dmOnAction = !cfg.dmOnAction;
      else throw new GameError('Opción inválida.');
      saveAutomod(ctx, guild.id, cfg);
      const section: AutomodSection = key === 'dm' ? 'advertencias' : (key as AutomodSection);
      await show(section, '✅ Guardado.');
      await audit(`cambió el automod (${key}).`);
      return;
    }
    case 'edit': {
      if (!i.isButton()) return;
      const section = id.args[0];
      if (section === 'enlaces') {
        await i.showModal(new ModalBuilder().setCustomId(cid('am', 'save', owner, 'enlaces')).setTitle('Dominios permitidos').addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('allow').setLabel('Dominios, separados por coma o espacio')
            .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1500).setValue(cfg.links.allow.join(', ')).setPlaceholder('youtube.com, tenor.com')),
        ));
        return;
      }
      const keys = EDIT_FIELDS[section as keyof typeof EDIT_FIELDS];
      if (!keys) throw new GameError('Sección inválida.');
      await i.showModal(new ModalBuilder().setCustomId(cid('am', 'save', owner, section)).setTitle('Automod').addComponents(
        ...keys.map((k) => new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(k)
          .setLabel(AUTOMOD_NUMBERS[k].label.slice(0, 45)).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(6)
          .setPlaceholder(`${AUTOMOD_NUMBERS[k].min}–${AUTOMOD_NUMBERS[k].max}`).setValue(String(readNumber(cfg, k))))),
      ));
      return;
    }
    case 'save': {
      const section = id.args[0];
      if (section === 'enlaces') {
        const raw = field(i, 'allow');
        cfg.links.allow = normalizeDomains(raw);
        saveAutomod(ctx, guild.id, cfg);
        await show('enlaces', `✅ ${cfg.links.allow.length} dominios permitidos.`);
        await audit('cambió los dominios permitidos.');
        return;
      }
      const keys = EDIT_FIELDS[section as keyof typeof EDIT_FIELDS];
      if (!keys) throw new GameError('Sección inválida.');
      // Se validan todos antes de guardar: o se guarda todo, o nada.
      const parsed = keys.map((k) => {
        const raw = field(i, k).replace(/[.\s]/g, '');
        const n = Number(raw);
        const def = AUTOMOD_NUMBERS[k];
        if (!/^\d{1,6}$/.test(raw) || n < def.min || n > def.max) throw new GameError(`**${def.label}**: tiene que ser un número entre ${def.min} y ${def.max}.`);
        return [k, n] as const;
      });
      ctx.db.transaction(() => { for (const [k, n] of parsed) setAutomodNumber(ctx, guild.id, k, n); });
      await show(section as AutomodSection, '✅ Valores guardados.');
      await audit(`cambió los valores de ${section} del automod.`);
      return;
    }
    case 'linkmode': {
      const mode = values(i)[0] as LinkMode;
      if (!['off', 'invites', 'all'].includes(mode)) throw new GameError('Modo inválido.');
      cfg.links.mode = mode;
      saveAutomod(ctx, guild.id, cfg);
      await show('enlaces', '✅ Filtro de enlaces actualizado.');
      await audit(`cambió el filtro de enlaces a "${mode}".`);
      return;
    }
    case 'raidact': {
      const action = values(i)[0] as RaidAction;
      if (!['alert', 'timeout', 'kick'].includes(action)) throw new GameError('Acción inválida.');
      cfg.raid.action = action;
      saveAutomod(ctx, guild.id, cfg);
      await show('raid', '✅ Acción del modo raid actualizada.');
      await audit(`cambió la acción del modo raid a "${action}".`);
      return;
    }
    case 'raidnow': {
      const on = getRaidUntil(ctx, guild.id) > Date.now();
      setRaidUntil(ctx, guild.id, on ? null : Date.now() + cfg.raid.minutes * 60_000);
      await show('resumen', on ? '✅ Modo raid terminado.' : `🚨 Modo raid activado por ${cfg.raid.minutes} minutos.`);
      await logSystem(ctx, guild, `🚨 <@${owner}> ${on ? 'terminó' : 'activó'} el modo raid manualmente.`, on ? COLORS.ok : COLORS.error);
      return;
    }
    case 'modroles': {
      const level = id.args[0] === 'admin' ? 'admin' : 'mod';
      const saved = setModRoles(ctx, guild.id, level, values(i));
      await show('roles', `✅ ${saved.length} rol(es) de ${level === 'admin' ? 'administrador' : 'moderador'}.`);
      await audit(`cambió los roles de ${level === 'admin' ? 'administrador' : 'moderador'} del bot: ${saved.map((r) => `<@&${r}>`).join(' ') || 'ninguno'}.`);
      return;
    }
    case 'exroles':
      cfg.exemptRoles = values(i);
      saveAutomod(ctx, guild.id, cfg);
      await show('roles', '✅ Roles exentos actualizados.');
      await audit('cambió los roles exentos del automod.');
      return;
    case 'exchans':
      cfg.exemptChannels = values(i);
      saveAutomod(ctx, guild.id, cfg);
      await show('roles', '✅ Canales exentos actualizados.');
      await audit('cambió los canales exentos del automod.');
      return;
    default:
      throw new GameError('Acción desconocida.');
  }
};
