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
  reply(payload: Partial<Panel> & { content?: string }, opts?: { ephemeral?: boolean }): Promise<void>;
  defer(ephemeral?: boolean): Promise<void>;
  /** Opción de texto: slash por nombre, prefijo por posición. */
  str(name: string, index: number): string | null;
  bool(name: string, index: number): boolean | null;
  member_(name: string, index: number): Promise<GuildMember | null>;
  /** Usuario (aunque ya no esté en el servidor): mención o ID. */
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
  data: { toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
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
        if (interaction.deferred || interaction.replied) await interaction.editReply(body);
        else await interaction.reply({ ...body, flags: o?.ephemeral ? MessageFlags.Ephemeral : undefined });
      } else if (message) {
        await message.reply({ ...body, allowedMentions: { parse: [], repliedUser: false } });
      }
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
      return id ? opts.member.guild.members.fetch(id).catch(() => null) : null;
    },
    async user_(name, index) {
      if (interaction) return interaction.options.getUser(name);
      const m = args[index]?.match(MENTION);
      const id = m?.[1] ?? m?.[2];
      return id ? opts.app.client.users.fetch(id).catch(() => null) : null;
    },
    role(name, index) {
      if (interaction) return interaction.options.getRole(name);
      const m = args[index]?.match(ROLE_MENTION);
      const id = m?.[1] ?? m?.[2];
      return id ? opts.member.guild.roles.cache.get(id) ?? null : null;
    },
  };
}
