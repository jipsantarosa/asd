/**
 * Traducciones del bot (!setlang es / !setlang en). Cada texto tiene su versión en los dos idiomas;
 * `{nombre}` se reemplaza con las variables. Un texto que falte en inglés cae en español (nunca rompe).
 */

export type Lang = 'es' | 'en';

const ES = {
  'lang.set': '🌐 Listo: el bot ahora habla **Español** en este servidor.',
  'lang.current': '🌐 Idioma de este servidor: **{lang}**. Cambialo con `{p}setlang es` (Español) o `{p}setlang en` (English).',
  'lang.partial': '-# Los juegos y algunos paneles todavía están solo en español.',

  'profile.level': 'Nivel',
  'profile.rank': 'Puesto',
  'profile.richest': '#{rank} en más ricos',
  'profile.unranked': 'sin puesto',
  'profile.stats': 'Estadísticas',
  'profile.wallet': 'Billetera',
  'profile.coins': 'Coins',
  'profile.kissesGiven': 'Besos dados',
  'profile.kissesReceived': 'Besos recibidos',
  'profile.achievements': 'Logros',
  'profile.games': 'Partidas',
  'profile.shifts': 'Turnos trabajados',
  'profile.streak': 'Racha diaria',
  'profile.marriage': 'Matrimonio',
  'profile.single': 'Sin pareja',
  'profile.since': 'desde {date}',
  'profile.registered': 'Registrado el {date}',
  'profile.casinoStats': 'Estadísticas del casino',
  'profile.toNext': '{left} Coins apostadas para el nivel {next}',
  'profile.bot': 'Los bots no tienen perfil.',

  'marry.usage': 'Uso: `{p}marry @usuario` (o respondé a su mensaje con `{p}marry`).',
  'marry.bot': 'No te podés casar con un bot. 🤖',
  'marry.title': '💍 Propuesta de casamiento',
  'marry.ask': '{proposer} le propone casamiento a {target}. 💕\n\n{target}, ¿aceptás?',
  'marry.expires': 'La propuesta vence {when}.',
  'marry.accept': 'Acepto',
  'marry.reject': 'Rechazar',
  'marry.cancel': 'Cancelar',
  'marry.accepted': '💒 ¡{a} y {b} se casaron! Felicidades. 🎉',
  'marry.rejected': '💔 {target} rechazó la propuesta de {proposer}.',
  'marry.cancelled': '🚫 {proposer} retiró la propuesta.',
  'marry.status': '💍 {user} está casado/a con **{partner}** {since}.',
  'marry.single': '💔 {user} no está casado/a.',
  'divorce.done': '💔 Te divorciaste de **{partner}**.',
  'divorce.confirm': '¿Seguro que querés divorciarte de **{partner}**?',
  'divorce.yes': 'Sí, divorciarme',

  'boost.setup': '🚀 Listo: los boosts se anuncian en {channel}. Personalizalo con `/boosttracker edit` y probalo con `/boosttracker test`.',
  'boost.saved': '✅ Mensaje de boost actualizado. Así se ve:',
  'boost.off': '⏸️ Mensajes de boost desactivados.',
  'boost.notSetup': 'Primero configurá el canal: `/boosttracker setup #canal`.',
  'boost.preview': 'Vista previa (con vos como ejemplo):',
  'boost.status': '🚀 **Boost tracker:** {state} · canal {channel}\nVariables: `{user}` `{username}` `{server}` `{boosts}` `{tier}`',
  'boost.on': 'activado',
  'boost.offState': 'desactivado',
  'boost.noChannel': 'sin canal',
  'boost.cantWrite': 'No puedo enviar mensajes con embeds en {channel}.',

  'wh.status': '🪝 **Anti-webhooks:** {state}\n• Administradores pueden crear webhooks: {admins}\n• Expulsar bots que creen webhooks sin permiso: {kick}\n• Roles permitidos: {roles}',
  'wh.on': '🟢 activado',
  'wh.off': '🔴 desactivado',
  'wh.yes': 'sí',
  'wh.no': 'no',
  'wh.none': 'ninguno',
  'wh.enabled': '🛡️ Anti-webhooks activado. Solo el dueño, los administradores y los roles permitidos pueden crear webhooks; los demás se borran solos, y los mensajes de webhooks con @everyone, invitaciones o spam se eliminan.',
  'wh.disabled': '⏸️ Anti-webhooks desactivado.',
  'wh.missing': 'Me faltan permisos: **{perms}**.',
  'wh.deleted': '🪝 Borré un webhook creado por {who} en {channel} (no tenía permiso).',
  'wh.kicked': '👢 Expulsé al bot {who} por crear un webhook sin permiso.',
  'wh.msg': '🪝 Borré un mensaje del webhook **{name}** en {channel}: {why}.',
  'wh.flood': '🪝 Borré el webhook **{name}** en {channel}: mandaba spam.',

  'common.needManageGuild': 'Necesitás el permiso **Gestionar servidor**.',
  'common.unknown': 'Opción desconocida.',
} as const;

export type TKey = keyof typeof ES;

const EN: Partial<Record<TKey, string>> = {
  'lang.set': '🌐 Done: the bot now speaks **English** in this server.',
  'lang.current': '🌐 This server\'s language: **{lang}**. Change it with `{p}setlang es` (Español) or `{p}setlang en` (English).',
  'lang.partial': '-# Games and some panels are still only in Spanish.',

  'profile.level': 'Level',
  'profile.rank': 'Rank',
  'profile.richest': '#{rank} richest',
  'profile.unranked': 'unranked',
  'profile.stats': 'Stats',
  'profile.wallet': 'Wallet',
  'profile.coins': 'Coins',
  'profile.kissesGiven': 'Kisses given',
  'profile.kissesReceived': 'Kisses received',
  'profile.achievements': 'Achievements',
  'profile.games': 'Games',
  'profile.shifts': 'Work shifts',
  'profile.streak': 'Daily streak',
  'profile.marriage': 'Marriage',
  'profile.single': 'Single',
  'profile.since': 'since {date}',
  'profile.registered': 'Registered on {date}',
  'profile.casinoStats': 'Casino stats',
  'profile.toNext': '{left} Coins wagered to reach level {next}',
  'profile.bot': 'Bots don\'t have a profile.',

  'marry.usage': 'Usage: `{p}marry @user` (or reply to their message with `{p}marry`).',
  'marry.bot': 'You can\'t marry a bot. 🤖',
  'marry.title': '💍 Marriage proposal',
  'marry.ask': '{proposer} is proposing to {target}. 💕\n\n{target}, do you accept?',
  'marry.expires': 'The proposal expires {when}.',
  'marry.accept': 'I do',
  'marry.reject': 'Decline',
  'marry.cancel': 'Cancel',
  'marry.accepted': '💒 {a} and {b} just got married! Congratulations. 🎉',
  'marry.rejected': '💔 {target} declined {proposer}\'s proposal.',
  'marry.cancelled': '🚫 {proposer} withdrew the proposal.',
  'marry.status': '💍 {user} is married to **{partner}** {since}.',
  'marry.single': '💔 {user} is not married.',
  'divorce.done': '💔 You divorced **{partner}**.',
  'divorce.confirm': 'Are you sure you want to divorce **{partner}**?',
  'divorce.yes': 'Yes, divorce',

  'boost.setup': '🚀 Done: boosts will be announced in {channel}. Customize it with `/boosttracker edit` and try it with `/boosttracker test`.',
  'boost.saved': '✅ Boost message updated. This is how it looks:',
  'boost.off': '⏸️ Boost messages disabled.',
  'boost.notSetup': 'Set the channel first: `/boosttracker setup #channel`.',
  'boost.preview': 'Preview (using you as an example):',
  'boost.status': '🚀 **Boost tracker:** {state} · channel {channel}\nVariables: `{user}` `{username}` `{server}` `{boosts}` `{tier}`',
  'boost.on': 'enabled',
  'boost.offState': 'disabled',
  'boost.noChannel': 'no channel',
  'boost.cantWrite': 'I can\'t send embeds in {channel}.',

  'wh.status': '🪝 **Anti-webhooks:** {state}\n• Administrators can create webhooks: {admins}\n• Kick bots that create webhooks without permission: {kick}\n• Allowed roles: {roles}',
  'wh.on': '🟢 enabled',
  'wh.off': '🔴 disabled',
  'wh.yes': 'yes',
  'wh.no': 'no',
  'wh.none': 'none',
  'wh.enabled': '🛡️ Anti-webhooks enabled. Only the owner, administrators and allowed roles can create webhooks; the rest are deleted automatically, and webhook messages with @everyone, invites or spam are removed.',
  'wh.disabled': '⏸️ Anti-webhooks disabled.',
  'wh.missing': 'I\'m missing permissions: **{perms}**.',
  'wh.deleted': '🪝 Deleted a webhook created by {who} in {channel} (not allowed).',
  'wh.kicked': '👢 Kicked the bot {who} for creating a webhook without permission.',
  'wh.msg': '🪝 Deleted a message from webhook **{name}** in {channel}: {why}.',
  'wh.flood': '🪝 Deleted the webhook **{name}** in {channel}: it was spamming.',

  'common.needManageGuild': 'You need the **Manage Server** permission.',
  'common.unknown': 'Unknown option.',
};

export function t(lang: Lang, key: TKey, vars: Record<string, string | number> = {}): string {
  const raw = (lang === 'en' ? EN[key] : undefined) ?? ES[key];
  return raw.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Para los tests: todas las claves tienen versión en inglés. */
export function missingEnglish(): string[] {
  return (Object.keys(ES) as TKey[]).filter((k) => !EN[k]);
}
