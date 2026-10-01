import { ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { getEquipLine, getItem } from '../../game/config';
import type { ItemCategory } from '../../game/types';
import type { GameContext } from '../../services/context';
import { collectionProgress, fishingLoadout, getFishLog } from '../../services/fishing';
import { CATEGORY_META, TIER_META, achievementProgress } from '../../services/achievements';
import { activityToday } from '../../services/activity';
import { describeReward } from '../../services/rewards';
import type { AchievementDef } from '../../game/types';
import { badgeImage } from '../assets';
import { TIERS, getPremium, tierOf } from '../../services/premium';
import { premiumBadge } from '../commands/premium';
import { gameConfig, getSettings } from '../../services/guildSettings';
import { listInventory } from '../../services/inventory';
import { ensureProfile, getEquipTiers, getUpgradeLevels, SLOTS, totalLevel, vigorState } from '../../services/player';
import { xpToNext } from '../../services/progression';
import { eligibleRewards, listRewards, rewardValue } from '../../services/roles';
import { navRow, row, type Panel, type Viewer } from '../app';
import { cid } from './ids';
import { COLORS, bar, money, num } from './theme';

// ───────────────────────── Mochila ─────────────────────────

export type InvFilter = 'todo' | ItemCategory;
const FILTERS: { id: InvFilter; label: string; emoji: string }[] = [
  { id: 'todo', label: 'Todo', emoji: '🎒' },
  { id: 'cultivo', label: 'Cultivos', emoji: '🌾' },
  { id: 'pez', label: 'Peces', emoji: '🐟' },
  { id: 'cebo', label: 'Cebos', emoji: '🪱' },
  { id: 'consumible', label: 'Consumibles', emoji: '🧪' },
  { id: 'reliquia', label: 'Reliquias', emoji: '🗝️' },
  { id: 'chatarra', label: 'Chatarra', emoji: '🥾' },
];
const INV_PAGE = 15;

export function inventoryPanel(ctx: GameContext, v: Viewer, filter: InvFilter = 'todo', page = 0): Panel {
  const p = ensureProfile(ctx, v.guildId, v.userId);
  const cfg = gameConfig(ctx, v.guildId);
  const items = listInventory(ctx, v.guildId, v.userId)
    .map((r) => ({ qty: r.quantity, item: getItem(cfg, r.item_id)! }))
    .filter((x) => filter === 'todo' || x.item.category === filter)
    .sort((a, b) => cfg.rarities[b.item.rarity].rank - cfg.rarities[a.item.rarity].rank || a.item.name.localeCompare(b.item.name));
  const pages = Math.max(1, Math.ceil(items.length / INV_PAGE));
  const pg = Math.min(Math.max(0, page), pages - 1);
  const lines = items.slice(pg * INV_PAGE, (pg + 1) * INV_PAGE).map(({ qty, item }) =>
    `${cfg.rarities[item.rarity].emoji} ${item.emoji} **${item.name}** ×${num(qty)}${item.sellPrice ? ` · ${num(item.sellPrice)} c/u` : ''}`);
  const worth = items.reduce((s, x) => s + x.item.sellPrice * x.qty, 0);
  const embed = new EmbedBuilder()
    .setColor(COLORS.inventory)
    .setAuthor({ name: `Mochila de ${v.name}`, iconURL: v.avatar })
    .setDescription(lines.join('\n') || '*Vacío. ¡Salí a farmear o a pescar!*')
    .setFooter({ text: `Página ${pg + 1}/${pages} · Valor base ${cfg.currency.emoji} ${num(worth)} · Saldo ${cfg.currency.emoji} ${num(p.coins)}` });

  const rows = [
    row(new StringSelectMenuBuilder().setCustomId(cid('iv', 'filter', v.userId)).setPlaceholder('Filtrar…')
      .addOptions(FILTERS.map((f) => new StringSelectMenuOptionBuilder().setValue(f.id).setLabel(f.label).setEmoji(f.emoji).setDefault(f.id === filter)))),
  ];
  if (pages > 1) {
    rows.push(row(
      new ButtonBuilder().setCustomId(cid('iv', 'page', v.userId, filter, pg - 1)).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(pg === 0),
      new ButtonBuilder().setCustomId(cid('iv', 'page', v.userId, filter, pg + 1)).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(pg >= pages - 1),
    ));
  }
  rows.push(navRow(v.userId, 'inventario'));
  return { embeds: [embed], components: rows };
}

// ───────────────────────── Perfil ─────────────────────────

export function profilePanel(ctx: GameContext, viewer: Viewer, target: Viewer): Panel {
  const p = ensureProfile(ctx, target.guildId, target.userId);
  const cfg = gameConfig(ctx, target.guildId);
  const max = cfg.tuning.progression.maxLevel;
  const levels = getUpgradeLevels(ctx, target.guildId, target.userId);
  const vigor = vigorState(cfg, p, levels, ctx.now());
  const tiers = getEquipTiers(ctx, target.guildId, target.userId);
  const log = getFishLog(ctx, target.guildId, target.userId);
  const species = new Set(cfg.fishing.fish.map((f) => f.itemId));
  const rod = fishingLoadout(ctx, target.guildId, target.userId, p).rod;
  const collections = collectionProgress(ctx, target.guildId, target.userId);
  const skill = (name: string, emoji: string, lvl: number, xp: number) =>
    lvl >= max ? `${emoji} **${name} nv. ${lvl}** · 👑 máximo` : `${emoji} **${name} nv. ${lvl}** ${bar(xp, xpToNext(cfg, lvl))} \`${num(xp)}/${num(xpToNext(cfg, lvl))}\``;

  const rewards = listRewards(ctx, target.guildId);
  const earned = new Set(eligibleRewards(rewards, p).map((r) => r.role_id));
  const next = rewards.filter((r) => !earned.has(r.role_id))
    .sort((a, b) => rewardValue(b.skill, p) / b.level - rewardValue(a.skill, p) / a.level).slice(0, 3)
    .map((r) => `<@&${r.role_id}> — ${r.skill === 'actividad' ? `${num(rewardValue(r.skill, p))}/${num(r.level)} pts de actividad` : `${r.skill} ${rewardValue(r.skill, p)}/${r.level}`}`);
  const ach = achievementProgress(ctx, target.guildId, target.userId);
  const achUnlocked = ach.filter((a) => a.unlocked).length;
  const today = activityToday(ctx, target.guildId, target.userId);

  const embed = new EmbedBuilder()
    .setColor(COLORS.profile)
    .setAuthor({ name: `Perfil de ${target.name}${premiumBadge(tierOf(ctx, target.userId))}`, iconURL: target.avatar })
    .setDescription([
      skill('Granja', '🌾', p.farm_level, p.farm_xp),
      skill('Pesca', '🎣', p.fish_level, p.fish_xp),
      `⭐ **Nivel total ${totalLevel(p)}** · ${money(cfg, p.coins)}`,
      `⚡ Vigor ${Math.floor(vigor.current)}/${vigor.max}`,
      `🔥 **Actividad ${num(p.activity_points)} pts** · hoy ${num(today.today)}/${num(today.cap)}`,
      `🏅 **Logros ${achUnlocked}/${ach.length}** \`${bar(achUnlocked, ach.length, 8)}\``,
    ].join('\n'))
    .addFields(
      { name: '🧰 Equipo', value: [...SLOTS.map((s) => { const t = getEquipLine(cfg, s).tiers[tiers[s]]; return `${t.emoji} ${t.name}`; }), `${rod.emoji} ${rod.name}`].join('\n'), inline: true },
      { name: '⬆️ Mejoras', value: cfg.upgrades.map((u) => `${u.emoji} ${u.name} ${levels[u.id]}/${u.maxLevel}`).join('\n'), inline: true },
      { name: '📊 Historial', value: `🌾 ${num(p.farms_total)} cosechas\n🎣 ${num(p.catches_total)} capturas\n📖 ${[...species].filter((s) => log.has(s)).length}/${species.size} especies`, inline: true },
      { name: '📚 Colecciones de pesca', value: collections.map((c) => `${cfg.rarities[c.rarity].emoji} ${cfg.rarities[c.rarity].label} ${c.found}/${c.total}${c.claimed ? ' ✅' : ''}`).join('\n'), inline: false },
    );
  if (rewards.length) {
    embed.addFields({ name: '🏅 Distinciones', value: `${earned.size ? [...earned].map((id) => `<@&${id}>`).join(' ') : '*Ninguna todavía*'}${next.length ? `\n**Próximas:**\n${next.join('\n')}` : ''}` });
  }
  const vip = getPremium(ctx, target.userId);
  if (vip) {
    embed.addFields({ name: `${TIERS[vip.tier].emoji} VIP`, value: `Premium **${TIERS[vip.tier].name}**${vip.expires_at ? ` · vence <t:${Math.floor(vip.expires_at / 1000)}:R>` : ''}` });
  }
  const recent = ach.filter((a) => a.unlocked).sort((a, b) => (b.unlockedAt ?? 0) - (a.unlockedAt ?? 0)).slice(0, 5);
  if (recent.length) embed.addFields({ name: '🏅 Últimos logros', value: recent.map((a) => `${TIER_META[a.def.tier].emoji} ${a.def.emoji} ${a.def.name}`).join('\n') });
  const own = viewer.userId === target.userId;
  return {
    embeds: [embed],
    components: [
      ...(own ? [row(new ButtonBuilder().setCustomId(cid('pf', 'ach', viewer.userId, 'todos', 0)).setLabel('Logros').setEmoji('🏅').setStyle(ButtonStyle.Primary))] : []),
      navRow(viewer.userId, 'perfil'),
    ],
  };
}

// ───────────────────────── Logros ─────────────────────────

export type AchFilter = 'todos' | AchievementDef['category'];
export const ACH_FILTERS: AchFilter[] = ['todos', 'pesca', 'granja', 'economia', 'progresion', 'canas', 'eventos'];
const ACH_PAGE = 6;

/** Álbum de logros: progreso de cada uno, con la insignia del más reciente o del que se está por lograr. */
export function achievementsPanel(ctx: GameContext, v: Viewer, filter: AchFilter = 'todos', page = 0): Panel {
  const cfg = gameConfig(ctx, v.guildId);
  const all = achievementProgress(ctx, v.guildId, v.userId);
  const list = all.filter((a) => filter === 'todos' || a.def.category === filter)
    .sort((a, b) => Number(b.unlocked) - Number(a.unlocked) || b.value / b.def.goal - a.value / a.def.goal);
  const pages = Math.max(1, Math.ceil(list.length / ACH_PAGE));
  const pg = Math.min(Math.max(0, page), pages - 1);
  const slice = list.slice(pg * ACH_PAGE, (pg + 1) * ACH_PAGE);
  const done = all.filter((a) => a.unlocked).length;
  const blocked = all.some((a) => a.dmStatus === 'bloqueado');
  const lines = slice.map((a) => {
    const tier = TIER_META[a.def.tier];
    const status = a.unlocked
      ? `✅ <t:${Math.floor((a.unlockedAt ?? 0) / 1000)}:d>`
      : `\`${bar(a.value, a.def.goal, 8)}\` ${num(a.value)}/${num(a.def.goal)}`;
    return `${tier.emoji} ${a.def.emoji} **${a.def.name}** — ${status}\n-# ${a.def.description} · ${describeReward(ctx, v.guildId, a.def.reward)}${a.def.activity ? ` · 🔥 ${a.def.activity}` : ''}`;
  });
  const focus = slice.find((a) => a.unlocked) ?? slice[0];
  const embed = new EmbedBuilder()
    .setColor(focus ? TIER_META[focus.def.tier].color : COLORS.profile)
    .setAuthor({ name: `Logros de ${v.name}`, iconURL: v.avatar })
    .setDescription([
      `**${done}/${all.length}** desbloqueados \`${bar(done, all.length, 12)}\``,
      blocked ? '📭 *Tenés los MD cerrados: los logros se guardan igual, pero no te podemos avisar por mensaje privado.*' : '',
      '',
      lines.join('\n') || '*Nada por acá.*',
    ].filter((x, i) => x !== '' || i === 2).join('\n'))
    .setFooter({ text: `${pages > 1 ? `Página ${pg + 1}/${pages} · ` : ''}🥉 Bronce · 🥈 Plata · 🥇 Oro · 💠 Platino · 💎 Diamante` });
  const img = focus ? badgeImage(focus.def) : null;
  if (img) embed.setThumbnail(img.url);
  const catLabel = (f: AchFilter) => (f === 'todos' ? 'Todos' : CATEGORY_META[f].label);
  const catEmoji = (f: AchFilter) => (f === 'todos' ? '🏅' : CATEGORY_META[f].emoji);
  const rows = [
    row(new StringSelectMenuBuilder().setCustomId(cid('pf', 'achf', v.userId)).setPlaceholder('Categoría…')
      .addOptions(ACH_FILTERS.map((f) => new StringSelectMenuOptionBuilder().setValue(f).setLabel(catLabel(f)).setEmoji(catEmoji(f)).setDefault(f === filter)))),
  ];
  if (pages > 1) {
    rows.push(row(
      new ButtonBuilder().setCustomId(cid('pf', 'ach', v.userId, filter, pg - 1)).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(pg === 0),
      new ButtonBuilder().setCustomId(cid('pf', 'ach', v.userId, filter, pg + 1)).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(pg >= pages - 1),
    ));
  }
  rows.push(navRow(v.userId, null));
  void cfg;
  return { embeds: [embed], components: rows, files: img ? [img.file] : [] };
}

// ───────────────────────── Ayuda ─────────────────────────

export type HelpPage = 'inicio' | 'granja' | 'pesca' | 'mercado' | 'progreso' | 'comunidad' | 'comandos';
const HELP_PAGES: { id: HelpPage; label: string; emoji: string }[] = [
  { id: 'inicio', label: 'Primeros pasos', emoji: '🧭' },
  { id: 'granja', label: 'Granja', emoji: '🌾' },
  { id: 'pesca', label: 'Pesca', emoji: '🎣' },
  { id: 'mercado', label: 'Mercado', emoji: '🛒' },
  { id: 'progreso', label: 'Progresión', emoji: '📈' },
  { id: 'comunidad', label: 'Comunidad', emoji: '💬' },
  { id: 'comandos', label: 'Comandos', emoji: '⌨️' },
];

export function helpPanel(ctx: GameContext, v: Viewer, page: HelpPage = 'inicio'): Panel {
  const prefix = getSettings(ctx, v.guildId).prefix;
  const text: Record<HelpPage, string> = {
    inicio: [
      'Bienvenido a **El Valle**: cultivá, pescá, vendé y mejorá tu equipo para llegar a lugares cada vez más difíciles.',
      '',
      '1. Abrí tu granja con `/granja` y tocá **Farmear**.',
      '2. Cada acción gasta ⚡ **vigor**, que se recupera solo con el tiempo.',
      '3. Farmear da lombrices 🪱: son el cebo básico para `/pesca`.',
      '4. Vendé en el `/mercado` y comprá mejor equipo y permisos para zonas nuevas.',
      '5. Todo sucede en el mismo mensaje: usá los botones de abajo para moverte.',
    ].join('\n'),
    granja: [
      '• **Farmear** cosecha la zona elegida. El equipo multiplica la cosecha y puede dar tiradas extra.',
      '• **Cosecha dorada** 🌟: a veces la cosecha se duplica (y la XP también).',
      '• **Abono** 🌿: se pesca en el agua y potencia tus próximas cosechas.',
      '• **Hallazgos raros** ✨: reliquias que desbloquean zonas nuevas. La suerte y los accesorios ayudan.',
      '• **Ritmo**: si encadenás demasiadas acciones seguidas te cansás y rendís menos. Descansar lo recupera.',
    ].join('\n'),
    pesca: [
      '🏞️ **El lago**: 12 casillas de agua. Tocá una para tirar ahí, o **🎣 Pescar** para una al azar. Después de cada tiro los peces se mueven.',
      '• 🌊 **Agua**: normal · 🫧 **Burbujas**: más suerte · 🌿 **Algas**: sale abono · 🪨 **Roca**: objetos perdidos · 🌀 **Remolino**: suerte enorme, pero se puede cortar la línea.',
      '• 🪱 Cada línea gasta una **carnada** (comprala con el botón **+10** o en el Mercado). No hay espera: pescá todo lo que quieras.',
      '• Cada captura muestra pez, rareza, peso y valor. **ℹ️** muestra las probabilidades de cada casilla con tu suerte.',
      '• 🎣 **Cañas** (Mercado): más líneas por tiro, más suerte y ahorro de carnada.',
      '• 🧵 **Racha de la suerte**: muchas tiradas sin Épico garantizan uno. 📚 **Colecciones**: premio por completar cada rareza.',
    ].join('\n'),
    mercado: [
      '• **Cañas**: 12 cañas, de la de junco a la del astro hundido. Elegí una para ver su ficha, la comparación con la tuya y lo que te falta.',
      '• **Suministros**: carnada, potenciadores (con límite diario) y consumibles. Se compran de a 1, 10, 50 o la cantidad que quieras.',
      '• **Equipo**, **Permisos** y **Mejoras**: granja, zonas nuevas y bonificaciones permanentes.',
      '• **Vender**: elegí un objeto y vendé 1, la mitad o todo. La demanda es de todo el servidor: si todos venden lo mismo, baja el precio.',
      '• La venta en lote nunca vende Épicos o mejores, carnada ni materiales para cañas.',
    ].join('\n'),
    comunidad: [
      `• \`${prefix}kiss @usuario\` — un beso con GIF de anime. Lleva la cuenta de besos entre ustedes dos (da igual quién lo mande) y de los que diste.`,
      `• \`${prefix}avs @usuario\` — avatar actual e historial de avatares que el bot vio desde que registra (no inventa cambios anteriores).`,
      `• \`${prefix}banners @usuario\` — lo mismo con el banner de perfil.`,
      `• \`${prefix}m @usuario 100\` — *moderación:* borra hasta 1000 mensajes recientes de esa persona en el canal. Requiere **Gestionar mensajes**; Discord no deja borrar en bloque mensajes de más de 14 días.`,
      `• \`${prefix}names @usuario\` — historial de nombres: @usuario, nombre visible y apodos en este servidor.`,
      `• 💎 **Premium** (\`${prefix}premium\`): \`${prefix}tags\`, \`${prefix}clearavatars\`, \`${prefix}clearnames\`, \`${prefix}cleartags\`, \`${prefix}mstats\` (quién miró tus historiales), \`${prefix}autoplay\` (pesca y farmea por vos), \`${prefix}ghostmode\` y \`${prefix}botperfil\`. Lo da el dueño del bot y vale en todos los servidores.`,
      'Todos tienen versión slash: `/kiss`, `/avatares`, `/banners`, `/names`, `/purgar`, `/premium`…',
    ].join('\n'),
    progreso: [
      '• Granja y pesca suben de nivel por separado; la suma es tu **nivel total**.',
      '• Cada nivel pide bastante más XP que el anterior.',
      '• Quedarte en zonas muy por debajo de tu nivel da menos XP: hay que avanzar.',
      '• Al subir de nivel ganás monedas. Algunos servidores dan **distinciones** (roles) por nivel o por actividad.',
      '• 🔥 **Actividad**: pescar, farmear, vender, comprar y ganar sorteos suman puntos (con tope diario, así que el spam no sirve).',
      '• 🏅 **Logros**: 29 logros con insignia propia y premio único. Te avisamos por mensaje privado; si tenés los MD cerrados, igual quedan en `/perfil` → Logros.',
    ].join('\n'),
    comandos: [
      `Prefijo de este servidor: \`${prefix}\` (también podés mencionarme).`,
      '',
      `\`/granja\` · \`${prefix}granja\` — tu granja`,
      `\`/pesca\` · \`${prefix}pesca\` — pescar`,
      `\`/mercado\` · \`${prefix}mercado\` — comprar y vender`,
      `\`/inventario\` · \`${prefix}inv\` — tu mochila`,
      `\`/perfil\` · \`${prefix}perfil [@usuario]\` — niveles y logros`,
      `\`/top\` · \`${prefix}top\` — ranking del servidor`,
      '`/jugar` — abre El Valle como juego (granja, pesca y top)',
      `\`/prefijo\` · \`${prefix}prefijo [nuevo]\` — ver o cambiar el prefijo`,
      '',
      '**Administración:** `/setup` (registros), `/roles` (paneles de roles y distinciones), `/ajustes` (valores del juego).',
    ].join('\n'),
  };
  const meta = HELP_PAGES.find((h) => h.id === page)!;
  const embed = new EmbedBuilder().setColor(COLORS.help).setTitle(`${meta.emoji} ${meta.label}`).setDescription(text[page]);
  return {
    embeds: [embed],
    components: [
      row(new StringSelectMenuBuilder().setCustomId(cid('hp', 'page', v.userId)).setPlaceholder('Tema…')
        .addOptions(HELP_PAGES.map((h) => new StringSelectMenuOptionBuilder().setValue(h.id).setLabel(h.label).setEmoji(h.emoji).setDefault(h.id === page)))),
      navRow(v.userId, null),
    ],
  };
}

export const HELP_PAGE_IDS = HELP_PAGES.map((h) => h.id);
export const INV_FILTER_IDS = FILTERS.map((f) => f.id);
