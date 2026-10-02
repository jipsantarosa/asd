import {
  ActionRowBuilder, type AttachmentBuilder, type Client, type EmbedBuilder, type GuildMember, type MessageActionRowComponentBuilder,
} from 'discord.js';
import type { KeyedLock, RateLimiter } from '../services/antispam';
import type { GameContext } from '../services/context';

export interface App {
  client: Client;
  ctx: GameContext;
  limiter: RateLimiter;
  /** Evita acciones simultáneas del mismo usuario. */
  userLock: KeyedLock;
  /** Evita dos /setup simultáneos en el mismo servidor. */
  guildLock: KeyedLock;
  /** Tras una ronda: distinciones por nivel, anuncios de grandes premios y logros (lo asigna index.ts). */
  afterRound?: (member: GuildMember) => Promise<void>;
}

/** Quién está mirando un panel. */
export interface Viewer {
  guildId: string;
  userId: string;
  name: string;
  avatar: string;
}

export function viewerOf(member: GuildMember): Viewer {
  return { guildId: member.guild.id, userId: member.id, name: member.displayName, avatar: member.displayAvatarURL({ size: 64 }) };
}

export type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;

export interface Panel {
  embeds: EmbedBuilder[];
  components: Row[];
  /** Imágenes adjuntas (se referencian desde el embed como attachment://nombre.png). */
  files?: AttachmentBuilder[];
}

export function row(...components: MessageActionRowComponentBuilder[]): Row {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...components);
}
