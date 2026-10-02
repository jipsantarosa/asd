import { EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import type { GameContext } from '../../services/context';
import { getSettings } from '../../services/guildSettings';
import { row, type Panel, type Viewer } from '../app';
import { cid } from './ids';
import { COLORS } from './theme';

export type HelpPage = 'inicio' | 'juegos' | 'economia' | 'torneos' | 'justo' | 'comunidad' | 'voz' | 'moderacion' | 'comandos';
const HELP_PAGES: { id: HelpPage; label: string; emoji: string }[] = [
  { id: 'inicio', label: 'Primeros pasos', emoji: '🧭' },
  { id: 'juegos', label: 'Juegos', emoji: '🎲' },
  { id: 'economia', label: 'Coins y progreso', emoji: '🪙' },
  { id: 'torneos', label: 'Torneos', emoji: '🏆' },
  { id: 'justo', label: 'Juego justo', emoji: '🔐' },
  { id: 'comunidad', label: 'Comunidad', emoji: '💬' },
  { id: 'voz', label: 'Canales de voz', emoji: '🔊' },
  { id: 'moderacion', label: 'Moderación', emoji: '🛡️' },
  { id: 'comandos', label: 'Comandos', emoji: '⌨️' },
];
export const HELP_PAGE_IDS = HELP_PAGES.map((h) => h.id);

export function helpPanel(ctx: GameContext, v: Viewer, page: HelpPage = 'inicio'): Panel {
  const p = getSettings(ctx, v.guildId).prefix;
  const text: Record<HelpPage, string> = {
    inicio: [
      'Bienvenido al **🎰 Casino**. Todo se juega con **Coins 🪙**, una moneda **virtual** del bot:',
      '**no se compra, no se retira y no se cambia por dinero real** (ni por nada fuera del bot).',
      '',
      `1. \`${p}balance\` — tu saldo (empezás con Coins de regalo).`,
      `2. \`${p}daily\` y \`${p}weekly\` — bonos gratis. Chatear también suma Coins (con límites).`,
      `3. \`${p}casino\` — el lobby con todos los juegos. Escribí un juego sin apuesta (\`${p}crash\`) para ver sus reglas.`,
      `4. Apostá: \`${p}crash 500 2.5x\`, \`${p}ruleta 200 rojo\`, \`${p}minas 100 5\`…`,
      `5. \`${p}perfil\`, \`${p}top\` y \`${p}torneo\` para ver tu progreso y competir.`,
      '',
      '-# Las apuestas aceptan `1000`, `1.000`, `1k`, `2.5k`, `1m`, `mitad` o `todo`.',
    ].join('\n'),
    juegos: [
      `🃏 **Blackjack** \`${p}bj 100\` — pedí, plantate, doblá o dividí. Blackjack paga 3:2.`,
      `🎡 **Ruleta** \`${p}ruleta 100 rojo\` — europea: color, par/impar, mitades, docenas, columnas, plenos, listas y rangos.`,
      `🎰 **Slots** \`${p}slots 100\` — tres rodillos, comodín ⭐ y **jackpot progresivo** con 7️⃣7️⃣7️⃣.`,
      `🚀 **Crash** \`${p}crash 100 [2x]\` — retirá antes de que explote. Retiro automático opcional.`,
      `🔵 **Plinko** \`${p}plinko 100 [bajo|medio|alto] [8-16]\` — la bola cae y elige tu premio.`,
      `💣 **Minas** \`${p}minas 100 [1-24]\` — destapá casillas sin pisar una mina.`,
      `🐔 **Pollo** \`${p}pollo 100 [fácil|normal|difícil]\` — cruzá carriles y retirate a tiempo.`,
      `🎈 **Globos** \`${p}globos 100\` — un globo por nivel; cada nivel tiene más agujas.`,
      `🔮 **Hilo** \`${p}hilo 100\` — ¿más alta o más baja? Lo menos probable paga más.`,
      `🐉 **Dragon Tower** \`${p}dragon 100 [fácil|medio|difícil|experto]\` — subí 9 pisos sin despertar al dragón.`,
      '',
      '• Los botones son **solo tuyos** y no se pueden tocar dos veces. Si el bot se reinicia, la partida sigue (o se te devuelve la apuesta).',
      '• Una partida que dejás sin tocar se resuelve sola: cobra lo que ya habías ganado, se planta, o te devuelve la apuesta.',
      '• 🔁 **Repetir** juega otra ronda con la misma apuesta.',
    ].join('\n'),
    economia: [
      '🪙 **Coins** — la misma billetera en todos los servidores. No hay transferencias entre personas.',
      `• **Bonos:** \`${p}daily\` (con racha), \`${p}weekly\`, y \`${p}rescate\` si te quedaste casi sin nada.`,
      '• **Actividad:** chatear suma unas pocas Coins por mensaje, con espera, tope diario y rendimiento decreciente. Spam, mensajes repetidos o muy cortos no cuentan.',
      '• **Nivel:** sube con el **total apostado** (no con lo ganado) y cada nivel da una recompensa. Los rangos van de 🥉 Bronce a 👑 Leyenda.',
      `• **Logros** (\`${p}logros\`): premios únicos por hitos.`,
      `• **Estadísticas:** \`${p}stats [juego]\` e \`${p}history [juego]\`.`,
      '• Cada juego tiene apuesta mínima y máxima, y hay un premio máximo por ronda.',
      '',
      '-# Jugá por diversión: es un juego con moneda virtual. Si sentís que las apuestas reales te afectan, pedí ayuda en tu país.',
    ].join('\n'),
    torneos: [
      '🏆 **Torneos automáticos:** uno **diario** y uno **semanal**, con premios fijos en Coins. Participás solo con jugar.',
      '• Cada torneo puntúa algo distinto: **ganancia neta**, **total apostado**, **mejor multiplicador** o **rondas ganadas**.',
      '• Para cobrar premio hace falta un mínimo de rondas jugadas durante el torneo.',
      '• El dueño del bot puede crear **torneos especiales**, también de un solo juego (por ejemplo "Plinko Weekend"), con apuesta mínima o entrada.',
      `• \`${p}torneo\` lista los torneos y \`${p}torneo <id>\` muestra el ranking y tu puesto.`,
    ].join('\n'),
    justo: [
      '🔐 **Azar verificable (provably fair).** Ningún resultado se elige a mano ni con `Math.random()`.',
      '• Antes de jugar ves el **hash** de la semilla del servidor (secreta). Cada ronda usa esa semilla, tu **semilla de cliente** y un **nonce** que sube de a uno.',
      '• Los números salen de `HMAC-SHA256(semilla_servidor, "semilla_cliente:nonce:bloque")`.',
      `• \`${p}fairness rotar [semilla]\` revela la semilla anterior (podés comprobar que su SHA-256 es el hash que viste) y crea una nueva.`,
      `• \`${p}fairness verificar <ronda>\` recalcula el resultado de una ronda con la semilla revelada.`,
      '• El retorno al jugador (RTP) de cada juego se muestra en sus reglas.',
    ].join('\n'),
    comunidad: [
      `• \`${p}kiss @usuario\` — un beso con GIF de anime y la cuenta de besos entre ustedes. \`${p}besos\` muestra tus estadísticas.`,
      `• \`${p}avs @usuario\` / \`${p}banners @usuario\` — avatar o banner actual y el historial que el bot vio.`,
      `• \`${p}names @usuario\` — historial de nombres.`,
      `• \`${p}steal\` respondiendo a un mensaje — copia sus emojis o su sticker a este servidor (necesitás **Gestionar expresiones**). También en el menú del mensaje → Apps → **Robar emoji o sticker**.`,
      `• 💎 **Premium** (\`${p}premium\`): \`${p}tags\`, \`${p}clearavatars\`, \`${p}clearnames\`, \`${p}cleartags\`, \`${p}mstats\`, \`${p}ghostmode\` y \`${p}botperfil\`. No da ventajas en el casino.`,
    ].join('\n'),
    voz: [
      '🔊 **Canales de voz temporales:** entrá al canal **➕ Crear canal** y el bot te arma tu propio canal y te mueve ahí. Cuando queda vacío, se borra solo.',
      '',
      '• Manejalo desde el canal de **interfaz**, desde el chat de tu canal o con `/canal`:',
      '  ✏️ nombre · 👥 límite · 🔒 privado · 👻 oculto · 🌍 región · ✅ permitir · ➖ quitar acceso · 📨 invitar · 👢 expulsar · 🚫 bloquear · ♻️ desbloquear · 👑 reclamar · 🔁 transferir · 🗑️ eliminar · ℹ️ info.',
      '• Tus ajustes se guardan para la próxima vez. Si quien creó el canal se va, cualquiera adentro puede **👑 Reclamar**.',
      '',
      '**Admins:** `/voz` crea o repara la categoría, el canal para crear y la interfaz.',
    ].join('\n'),
    moderacion: [
      `🛡️ **Sanciones** (\`/mod …\` o por prefijo): \`${p}warn\`, \`${p}timeout @x 10m\`, \`${p}untimeout\`, \`${p}kick\`, \`${p}ban\`, \`${p}unban ID\`.`,
      '• Cada sanción crea un **caso numerado** con motivo, moderador y fecha, y le llega un MD a la persona.',
      `• \`${p}modlogs @x\` muestra sus casos; \`${p}caso 12\` abre uno para **editar el motivo** o **anularlo**.`,
      '• **Escalado**, **automod** (spam, flood, enlaces, invitaciones) y **antiraid** se configuran con `/automod`.',
      `• \`${p}m @x 100\` borra mensajes recientes de esa persona en el canal.`,
    ].join('\n'),
    comandos: [
      `Prefijo de este servidor: \`${p}\` (también podés mencionarme).`,
      '',
      `**Casino:** \`${p}casino\` · \`${p}balance\` · \`${p}daily\` · \`${p}weekly\` · \`${p}rescate\``,
      `**Juegos:** \`${p}bj\` · \`${p}ruleta\` · \`${p}slots\` · \`${p}crash\` · \`${p}plinko\` · \`${p}minas\` · \`${p}pollo\` · \`${p}globos\` · \`${p}hilo\` · \`${p}dragon\``,
      `**Progreso:** \`${p}perfil\` · \`${p}top [categoría] [página]\` · \`${p}rank\` · \`${p}stats [juego]\` · \`${p}history [juego]\` · \`${p}logros\` · \`${p}fairness\` · \`${p}torneo\``,
      `**Comunidad:** \`${p}kiss\` · \`${p}besos\` · \`${p}avs\` · \`${p}banners\` · \`${p}names\` · \`${p}steal\` · \`${p}premium\``,
      '',
      '**Moderación:** `/mod warn|timeout|untimeout|kick|ban|unban|historial|caso` (o por prefijo).',
      '**Administración:** `/setup` (registros), `/roles` (paneles de roles y distinciones por nivel), `/ajustes` (prefijo y canales del casino), `/voz`, `/automod`.',
      '**Dueño del bot:** `!casino config|enable|disable|minbet|maxbet|edge|cooldown|set`, `!balance add|remove|set`, `!torneo create|edit|start|stop|cancel|list|leaderboard`.',
    ].join('\n'),
  };
  const meta = HELP_PAGES.find((h) => h.id === page)!;
  const embed = new EmbedBuilder().setColor(COLORS.help).setTitle(`${meta.emoji} ${meta.label}`).setDescription(text[page]);
  return {
    embeds: [embed],
    components: [
      row(new StringSelectMenuBuilder().setCustomId(cid('hp', 'page', v.userId)).setPlaceholder('Tema…')
        .addOptions(HELP_PAGES.map((h) => new StringSelectMenuOptionBuilder().setValue(h.id).setLabel(h.label).setEmoji(h.emoji).setDefault(h.id === page)))),
    ],
  };
}
