import { PermissionFlagsBits, type Message } from 'discord.js';
import { logger } from '../../logger';
import { GameError } from '../../services/context';
import { gameConfig, getSettings } from '../../services/guildSettings';
import { viewerOf, type App } from '../app';
import { findCommand } from '../commands';
import { buildContext } from '../commands/types';
import { logSystem } from '../logging/sender';
import { COLORS } from '../ui/theme';

/** Comandos de texto: prefijo propio de cada servidor (persistente) o mención al bot. */
export function onMessage(app: App) {
  return async (msg: Message): Promise<void> => {
    if (!msg.inGuild() || msg.author.bot || msg.webhookId || !app.client.user) return;
    const prefix = getSettings(app.ctx, msg.guildId).prefix;
    const mention = new RegExp(`^<@!?${app.client.user.id}>\\s*`);
    const content = msg.content.trim();

    let body: string | null = null;
    if (content.startsWith(prefix)) body = content.slice(prefix.length);
    else if (mention.test(content)) body = content.replace(mention, '');
    if (body === null) return;

    const args = body.trim().split(/\s+/).filter(Boolean);
    const name = args.shift();

    // Antes, si al bot le faltaba un permiso en el canal, ignoraba el comando en silencio ("no me deja").
    // Ahora avisa qué falta: en el canal (texto plano) o, si ni siquiera puede escribir, por DM.
    const me = msg.guild.members.me;
    const perms = me ? msg.channel.permissionsFor(me) : null;
    const NEEDED: [bigint, string][] = [
      [PermissionFlagsBits.SendMessages, 'Enviar mensajes'],
      [PermissionFlagsBits.EmbedLinks, 'Insertar enlaces'],
      [PermissionFlagsBits.AttachFiles, 'Adjuntar archivos'],
      [PermissionFlagsBits.ReadMessageHistory, 'Leer el historial de mensajes'],
    ];
    const missing = NEEDED.filter(([flag]) => !perms?.has(flag)).map(([, label]) => label);
    if (missing.length) {
      const wanted = name ? findCommand(name) : null;
      if (name && (!wanted || !wanted.prefix)) return; // no era un comando nuestro
      const text = `⚠️ No puedo responder en <#${msg.channel.id}>: me falta el permiso **${missing.join('**, **')}**. Pedile a un admin que se lo dé a mi rol en ese canal.`;
      if (perms?.has(PermissionFlagsBits.SendMessages)) {
        await msg.channel.send({ content: text, allowedMentions: { parse: [] } }).catch(() => undefined);
      } else {
        logger.warn(`Sin permisos para responder en #${msg.channel.id} (${msg.guild.name}): ${missing.join(', ')}`);
        await msg.author.send({ content: `${text}\n-# Servidor: ${msg.guild.name}` }).catch(() => undefined);
      }
      return;
    }
    if (!name) {
      // Solo mencionaron al bot: recordar el prefijo.
      await msg.reply({ content: `👋 Mi prefijo acá es \`${prefix}\`. Probá \`${prefix}ayuda\` o \`/ayuda\`.`, allowedMentions: { repliedUser: false } });
      return;
    }
    const cmd = findCommand(name);
    if (!cmd || !cmd.prefix) return;

    const member = msg.member ?? (await msg.guild.members.fetch(msg.author.id).catch(() => null));
    if (!member) return;
    const say = (text: string) => msg.reply({ content: text, allowedMentions: { parse: [], repliedUser: false } }).catch(() => undefined);

    try {
      if (cmd.permission && !member.permissions.has(cmd.permission)) throw new GameError(`Necesitás el permiso **${cmd.permissionName}** para usar este comando.`);
      const a = gameConfig(app.ctx, msg.guildId).tuning.antispam;
      const rl = app.limiter.check(`${msg.guildId}:${msg.author.id}`, a.actionsPerWindow, a.windowSeconds * 1000, a.flagThreshold);
      if (rl !== 'ok') {
        if (rl === 'flag') await logSystem(app.ctx, msg.guild, `🚨 Actividad sospechosa: <@${msg.author.id}> superó el límite de comandos repetidamente.`, COLORS.warn);
        return; // en texto se ignora en silencio para no sumar spam
      }
      const c = buildContext({ app, member, viewer: viewerOf(member), prefix, message: msg, args });
      const res = await app.userLock.run(`${msg.guildId}:${msg.author.id}`, () => cmd.run(c));
      if (!res.ran) await say('⏳ Estoy procesando tu acción anterior, esperá un segundo.');
    } catch (err) {
      if (err instanceof GameError) await say(`⚠️ ${err.message}`);
      else await say(`❌ Error inesperado (código \`${logger.incident(err, `${prefix}${name}`)}\`).`);
    }
  };
}
