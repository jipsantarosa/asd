import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, type AttachmentBuilder, type Client, type EmbedBuilder, type GuildMember,
  type MessageActionRowComponentBuilder,
} from 'discord.js';
import type { KeyedLock, RateLimiter } from '../services/antispam';
import type { GameContext } from '../services/context';
import { cid } from './ui/ids';

export interface App {
  client: Client;
  ctx: GameContext;
  limiter: RateLimiter;
  /** Evita acciones simultáneas del mismo usuario. */
  userLock: KeyedLock;
  /** Evita dos /setup simultáneos en el mismo servidor. */
  guildLock: KeyedLock;
  /** Tras una acción de juego: distinciones y avisos de logros (lo asigna index.ts). */
  afterAction?: (member: GuildMember) => Promise<void>;
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

export type NavTarget = 'granja' | 'pesca' | 'mercado' | 'inventario' | 'perfil';

const NAV: Record<NavTarget, { label: string; emoji: string }> = {
  granja: { label: 'Granja', emoji: '🌾' },
  pesca: { label: 'Pesca', emoji: '🎣' },
  mercado: { label: 'Mercado', emoji: '🛒' },
  inventario: { label: 'Mochila', emoji: '🎒' },
  perfil: { label: 'Perfil', emoji: '👤' },
};

/** Fila de navegación entre módulos: todo ocurre en el mismo mensaje, como una app. */
export function navRow(owner: string, current: NavTarget | null): Row {
  const buttons = (Object.keys(NAV) as NavTarget[])
    .filter((t) => t !== current)
    .slice(0, 5)
    .map((t) => new ButtonBuilder().setCustomId(cid('nav', t, owner)).setLabel(NAV[t].label).setEmoji(NAV[t].emoji).setStyle(ButtonStyle.Secondary));
  return row(...buttons);
}
