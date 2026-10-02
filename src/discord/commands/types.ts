import {
  MessageFlags, type ChatInputCommandInteraction, type Guild, type GuildMember, type Message,
  type RESTPostAPIChatInputApplicationCommandsJSONBody, type Role, type User,
} from 'discord.js';
import type { App, Panel, Viewer } from '../app';

export interface CommandContext {
  app: App;
  guild: Guild;
  member: GuildMember;
  viewer: Viewer;
  /** Prefijo efectivo (para mensajes de ayuda). */
  prefix: string;
  interaction: ChatInputCommandInteraction<'cached'> | null;
  message: Message<true> | null;
  /** Argumentos crudos del comando por prefijo. */
  args: string[];
  /** Responde y devuelve el mensaje cuando Discord lo informa (siempre por prefijo; en slash, si la respuesta estaba diferida). */
  reply(payload: Partial<Panel> & { content?: string }, opts?: { ephemeral?: boolean }): Promise<Message | null>;
  defer(ephemeral?: boolean): Promise<void>;
  /** Opción de texto: slash por nombre, prefijo por posición. */
  str(name: string, index: number): string | null;
  /** Texto libre: slash por nombre; por prefijo, todo lo que viene desde esa posición (p. ej. un motivo con espacios). */
  text(name: string, index: number): string | null;
  /** Número entero: slash por nombre, prefijo por posición (acepta "1.000"). */
  int(name: string, index: number): number | null;
  bool(name: string, index: number): boolean | null;
  /** Miembro: mención o ID. Por prefijo, si falta y el mensaje responde a otro, el autor de ese mensaje. */
  member_(name: string, index: number): Promise<GuildMember | null>;
  /** Usuario (aunque ya no esté en el servidor): mención o ID. Por prefijo, si falta y el mensaje responde a otro, el autor de ese mensaje. */
  user_(name: string, index: number): Promise<User | null>;
  role(name: string, index: number): Role | null;
}

export interface Command {
  name: string;
  aliases: string[];
  /** false = solo slash (p. ej. si necesita opciones complejas). */
  prefix: boolean;
  /** Permiso requerido tanto en slash como por prefijo. */
  permission?: bigint;
  permissionName?: string;
  /** Definición del comando de barra. Sin ella, el comando es solo por prefijo (p. ej. !warn, que en slash es /mod warn). */
  data?: { toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  run(c: CommandContext): Promise<void>;
}

const MENTION = /^<@!?(\d{17,20})>$|^(\d{17,20})$/;
const ROLE_MENTION = /^<@&(\d{17,20})>$|^(\d{17,20})$/;

export function buildContext(opts: {
  app: App;
  member: GuildMember;
  viewer: Viewer;
  prefix: string;
  interaction?: ChatInputCommandInteraction<'cached'>;
  message?: Message<true>;
  args?: string[];
}): CommandContext {
  const { interaction, message } = opts;
  const args = opts.args ?? [];
  // Si el comando por prefijo responde a un mensaje y no nombra a nadie en esa posición, la persona es el autor
  // del mensaje respondido (p. ej. responder a alguien con "!kiss"). Se busca una sola vez.
  let replied: Promise<Message | null> | null = null;
  const repliedMessage = () => {
    if (!message?.reference?.messageId) return Promise.resolve(null);
    replied ??= message.fetchReference().catch(() => null);
    return replied;
  };
  return {
    app: opts.app,
    guild: opts.member.guild,
    member: opts.member,
    viewer: opts.viewer,
    prefix: opts.prefix,
    interaction: interaction ?? null,
    message: message ?? null,
    args,
    async reply(payload, o) {
      const body = { content: payload.content, embeds: payload.embeds ?? [], components: payload.components ?? [], files: payload.files ?? [], allowedMentions: { parse: [] } };
      if (interaction) {
        if (interaction.deferred || interaction.replied) return interaction.editReply(body);
        await interaction.reply({ ...body, flags: o?.ephemeral ? MessageFlags.Ephemeral : undefined });
        return null;
      }
      if (message) return message.reply({ ...body, allowedMentions: { parse: [], repliedUser: false } });
      return null;
    },
    async defer(ephemeral) {
      if (interaction && !interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: ephemeral ? MessageFlags.Ephemeral : undefined });
      } else if (message && message.channel.isSendable()) {
        await message.channel.sendTyping().catch(() => undefined);
      }
    },
    str(name, index) {
      if (interaction) return interaction.options.getString(name);
      return args[index] ?? null;
    },
    text(name, index) {
      if (interaction) return interaction.options.getString(name);
      const t = args.slice(index).join(' ').trim();
      return t || null;
    },
    int(name, index) {
      if (interaction) return interaction.options.getInteger(name);
      const raw = args[index]?.replace(/\./g, '');
      if (!raw || !/^-?\d{1,12}$/.test(raw)) return null;
      return Number(raw);
    },
    bool(name, index) {
      if (interaction) return interaction.options.getBoolean(name);
      const raw = args[index]?.toLowerCase();
      if (!raw) return null;
      if (['si', 'sí', 'true', 'on', '1'].includes(raw)) return true;
      if (['no', 'false', 'off', '0'].includes(raw)) return false;
      return null;
    },
    async member_(name, index) {
      if (interaction) return interaction.options.getMember(name);
      const m = args[index]?.match(MENTION);
      const id = m?.[1] ?? m?.[2];
      if (id) return opts.member.guild.members.fetch(id).catch(() => null);
      if (args[index] !== undefined) return null;
      const ref = await repliedMessage();
      return ref ? ref.member ?? (await opts.member.guild.members.fetch(ref.author.id).catch(() => null)) : null;
    },
    async user_(name, index) {
      if (interaction) return interaction.options.getUser(name);
      const m = args[index]?.match(MENTION);
      const id = m?.[1] ?? m?.[2];
      if (id) return opts.app.client.users.fetch(id).catch(() => null);
      if (args[index] !== undefined) return null;
      return (await repliedMessage())?.author ?? null;
    },
    role(name, index) {
      if (interaction) return interaction.options.getRole(name);
      const m = args[index]?.match(ROLE_MENTION);
      const id = m?.[1] ?? m?.[2];
      return id ? opts.member.guild.roles.cache.get(id) ?? null : null;
    },
  };
}
