import type { Db } from './types';

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

/**
 * Migraciones versionadas. NUNCA edites una migración ya aplicada en producción:
 * agregá una nueva con el siguiente id.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'esquema_inicial',
    sql: `
CREATE TABLE guild_settings (
  guild_id   TEXT PRIMARY KEY,
  prefix     TEXT NOT NULL,
  tunables   TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE profiles (
  guild_id           TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  coins              INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0),
  vigor              REAL NOT NULL,
  vigor_updated_at   INTEGER NOT NULL,
  fatigue            REAL NOT NULL DEFAULT 0,
  fatigue_updated_at INTEGER NOT NULL,
  farm_level         INTEGER NOT NULL DEFAULT 1,
  farm_xp            INTEGER NOT NULL DEFAULT 0,
  fish_level         INTEGER NOT NULL DEFAULT 1,
  fish_xp            INTEGER NOT NULL DEFAULT 0,
  farm_zone          TEXT NOT NULL,
  fish_spot          TEXT NOT NULL,
  bait_id            TEXT NOT NULL,
  fertilizer         INTEGER NOT NULL DEFAULT 0 CHECK (fertilizer >= 0),
  farms_total        INTEGER NOT NULL DEFAULT 0,
  catches_total      INTEGER NOT NULL DEFAULT 0,
  last_farm_json     TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE inventory (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  item_id  TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  PRIMARY KEY (guild_id, user_id, item_id)
);

CREATE TABLE equipment (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  slot     TEXT NOT NULL,
  tier     INTEGER NOT NULL CHECK (tier >= 0),
  PRIMARY KEY (guild_id, user_id, slot)
);

CREATE TABLE upgrades (
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  upgrade_id TEXT NOT NULL,
  level      INTEGER NOT NULL CHECK (level >= 0),
  PRIMARY KEY (guild_id, user_id, upgrade_id)
);

CREATE TABLE unlocks (
  guild_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  unlock_id   TEXT NOT NULL,
  unlocked_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, unlock_id)
);

CREATE TABLE cooldowns (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  action   TEXT NOT NULL,
  ready_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, action)
);

CREATE TABLE daily_counters (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  counter  TEXT NOT NULL,
  day      TEXT NOT NULL,
  count    INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, counter, day)
);

CREATE TABLE fish_log (
  guild_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  fish_id     TEXT NOT NULL,
  caught      INTEGER NOT NULL,
  best_weight REAL NOT NULL,
  first_at    INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, fish_id)
);

CREATE TABLE milestones (
  guild_id     TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  milestone_id TEXT NOT NULL,
  claimed_at   INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, milestone_id)
);

CREATE TABLE fishing_sessions (
  id         TEXT PRIMARY KEY,
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  spot_id    TEXT NOT NULL,
  fish_id    TEXT NOT NULL,
  weight     REAL NOT NULL,
  bait_id    TEXT NOT NULL,
  tension    REAL NOT NULL,
  progress   REAL NOT NULL,
  round      INTEGER NOT NULL,
  behavior   TEXT NOT NULL,
  hint       TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('active','caught','escaped','snapped','expired','released')),
  last_event TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
-- Una sola sesión activa por usuario: la base de datos lo garantiza aunque lleguen clics simultáneos.
CREATE UNIQUE INDEX ux_fishing_one_active ON fishing_sessions (guild_id, user_id) WHERE state = 'active';
CREATE INDEX ix_fishing_expiry ON fishing_sessions (state, expires_at);

CREATE TABLE market_supply (
  guild_id   TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  units      REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, item_id)
);

CREATE TABLE ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  delta      INTEGER NOT NULL,
  balance    INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX ix_ledger_user ON ledger (guild_id, user_id, created_at);

CREATE TABLE role_groups (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id        TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  mode            TEXT NOT NULL CHECK (mode IN ('libre','unico')),
  min_total_level INTEGER NOT NULL DEFAULT 0,
  channel_id      TEXT,
  message_id      TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX ix_role_groups_guild ON role_groups (guild_id);

CREATE TABLE role_group_entries (
  group_id INTEGER NOT NULL REFERENCES role_groups(id) ON DELETE CASCADE,
  role_id  TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, role_id)
);

CREATE TABLE role_rewards (
  guild_id TEXT NOT NULL,
  role_id  TEXT NOT NULL,
  skill    TEXT NOT NULL CHECK (skill IN ('granja','pesca','total')),
  level    INTEGER NOT NULL CHECK (level >= 1),
  PRIMARY KEY (guild_id, role_id)
);

CREATE TABLE log_config (
  guild_id          TEXT PRIMARY KEY,
  category_id       TEXT,
  staff_role_id     TEXT,
  log_sent_messages INTEGER NOT NULL DEFAULT 1,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE log_channels (
  guild_id   TEXT NOT NULL,
  log_key    TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, log_key)
);
`,
  },
  {
    id: 2,
    name: 'pesca_simple_canas_buffs_eventos',
    sql: `
-- ── Pesca nueva: caña equipada y racha de la suerte ──
ALTER TABLE profiles ADD COLUMN rod_id TEXT NOT NULL DEFAULT 'junco';
ALTER TABLE profiles ADD COLUMN fish_pity INTEGER NOT NULL DEFAULT 0;

CREATE TABLE rods_owned (
  guild_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  rod_id      TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, rod_id)
);

-- ── Potenciadores temporales (user_id = '*' → buff de todo el servidor) ──
CREATE TABLE buffs (
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  buff_id    TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  source     TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id, buff_id)
);
CREATE INDEX ix_buffs_expires ON buffs (expires_at);

-- ── Eventos automáticos ──
CREATE TABLE event_config (
  guild_id   TEXT PRIMARY KEY,
  channel_id TEXT,
  enabled    INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  message_id  TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('sorteo', 'marea')),
  reward_json TEXT NOT NULL,
  winners     INTEGER NOT NULL DEFAULT 1,
  state       TEXT NOT NULL CHECK (state IN ('open', 'closed', 'cancelled')),
  created_at  INTEGER NOT NULL,
  ends_at     INTEGER NOT NULL,
  result_json TEXT
);
-- Nunca dos sorteos abiertos a la vez en el mismo servidor (ni con dos procesos ni tras un reinicio).
CREATE UNIQUE INDEX ux_events_one_open ON events (guild_id) WHERE state = 'open';
CREATE INDEX ix_events_due ON events (state, ends_at);

CREATE TABLE event_entries (
  event_id  INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE event_wins (
  event_id    INTEGER NOT NULL,
  guild_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  day         TEXT NOT NULL,
  reward_json TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX ix_event_wins_day ON event_wins (guild_id, user_id, day);

-- ── Conversión de datos de la pesca anterior (sin borrar nada) ──
-- 1) La caña vieja (tier 1..5) se convierte en las cañas nuevas equivalentes.
INSERT OR IGNORE INTO rods_owned (guild_id, user_id, rod_id, acquired_at)
  SELECT guild_id, user_id, 'sauce', 0 FROM equipment WHERE slot = 'cana' AND tier >= 1;
INSERT OR IGNORE INTO rods_owned (guild_id, user_id, rod_id, acquired_at)
  SELECT guild_id, user_id, 'tejedora', 0 FROM equipment WHERE slot = 'cana' AND tier >= 2;
INSERT OR IGNORE INTO rods_owned (guild_id, user_id, rod_id, acquired_at)
  SELECT guild_id, user_id, 'coral', 0 FROM equipment WHERE slot = 'cana' AND tier >= 3;
INSERT OR IGNORE INTO rods_owned (guild_id, user_id, rod_id, acquired_at)
  SELECT guild_id, user_id, 'brujula', 0 FROM equipment WHERE slot = 'cana' AND tier >= 4;
INSERT OR IGNORE INTO rods_owned (guild_id, user_id, rod_id, acquired_at)
  SELECT guild_id, user_id, 'abismo', 0 FROM equipment WHERE slot = 'cana' AND tier >= 5;
UPDATE profiles SET rod_id = COALESCE((
  SELECT CASE MIN(e.tier, 5) WHEN 1 THEN 'sauce' WHEN 2 THEN 'tejedora' WHEN 3 THEN 'coral' WHEN 4 THEN 'brujula' WHEN 5 THEN 'abismo' ELSE 'junco' END
  FROM equipment e WHERE e.guild_id = profiles.guild_id AND e.user_id = profiles.user_id AND e.slot = 'cana'
), 'junco');

-- 2) Los carretes ya no existen: se reintegra lo pagado.
CREATE TEMP TABLE refunds (guild_id TEXT, user_id TEXT, amount INTEGER, reason TEXT);
INSERT INTO refunds
  SELECT guild_id, user_id,
    CASE MIN(tier, 4) WHEN 1 THEN 2500 WHEN 2 THEN 22500 WHEN 3 THEN 132500 WHEN 4 THEN 582500 ELSE 0 END,
    'reintegro de carrete (nueva pesca)'
  FROM equipment WHERE slot = 'carrete' AND tier >= 1;
-- 3) Los permisos de lugares de pesca ya no existen: se reintegran (y el mapa usado para la fosa se devuelve).
INSERT INTO refunds
  SELECT guild_id, user_id,
    CASE unlock_id WHEN 'lugar:lago' THEN 3000 WHEN 'lugar:delta' THEN 22000 WHEN 'lugar:mar_abierto' THEN 110000 WHEN 'lugar:fosa_abisal' THEN 480000 ELSE 0 END,
    'reintegro de permiso ' || unlock_id
  FROM unlocks WHERE unlock_id LIKE 'lugar:%';
DELETE FROM refunds WHERE amount <= 0;
UPDATE profiles SET coins = coins + COALESCE((SELECT SUM(r.amount) FROM refunds r WHERE r.guild_id = profiles.guild_id AND r.user_id = profiles.user_id), 0);
INSERT INTO ledger (guild_id, user_id, delta, balance, reason, created_at)
  SELECT r.guild_id, r.user_id, r.amount, p.coins, r.reason, CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM refunds r JOIN profiles p ON p.guild_id = r.guild_id AND p.user_id = r.user_id;
INSERT INTO inventory (guild_id, user_id, item_id, quantity)
  SELECT guild_id, user_id, 'mapa_corrientes', 1 FROM unlocks WHERE unlock_id = 'lugar:fosa_abisal'
  ON CONFLICT (guild_id, user_id, item_id) DO UPDATE SET quantity = quantity + 1;
DROP TABLE refunds;

-- 4) Las peleas del minijuego anterior quedan cerradas.
UPDATE fishing_sessions SET state = 'expired', last_event = 'migracion' WHERE state = 'active';
`,
  },
  {
    id: 3,
    name: 'logros_actividad_tienda',
    sql: `
-- ── Puntos de actividad (para distinciones por actividad y ranking) ──
ALTER TABLE profiles ADD COLUMN activity_points INTEGER NOT NULL DEFAULT 0;

-- ── Contadores acumulados por jugador (métricas de logros) ──
CREATE TABLE player_stats (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  stat     TEXT NOT NULL,
  value    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id, stat)
);

-- ── Logros desbloqueados + estado del aviso por DM ──
CREATE TABLE achievements_unlocked (
  guild_id       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  achievement_id TEXT NOT NULL,
  unlocked_at    INTEGER NOT NULL,
  dm_status      TEXT NOT NULL DEFAULT 'pendiente' CHECK (dm_status IN ('pendiente','enviando','enviado','bloqueado','fallido')),
  dm_attempts    INTEGER NOT NULL DEFAULT 0,
  notified_at    INTEGER,
  PRIMARY KEY (guild_id, user_id, achievement_id)
);
CREATE INDEX ix_ach_pending ON achievements_unlocked (dm_status, unlocked_at);

-- ── Distinciones: se agrega la "habilidad" actividad (umbral = puntos) ──
CREATE TABLE role_rewards_new (
  guild_id TEXT NOT NULL,
  role_id  TEXT NOT NULL,
  skill    TEXT NOT NULL CHECK (skill IN ('granja','pesca','total','actividad')),
  level    INTEGER NOT NULL CHECK (level >= 1),
  PRIMARY KEY (guild_id, role_id)
);
INSERT INTO role_rewards_new SELECT guild_id, role_id, skill, level FROM role_rewards;
DROP TABLE role_rewards;
ALTER TABLE role_rewards_new RENAME TO role_rewards;

-- ── Cañas nuevas intermedias: quien ya tenía una caña superior recibe las nuevas que quedaron por debajo ──
INSERT OR IGNORE INTO rods_owned (guild_id, user_id, rod_id, acquired_at)
  SELECT DISTINCT guild_id, user_id, 'corcho', 0 FROM rods_owned WHERE rod_id IN ('sauce','tejedora','coral','relampago','brujula','abismo','astro');
INSERT OR IGNORE INTO rods_owned (guild_id, user_id, rod_id, acquired_at)
  SELECT DISTINCT guild_id, user_id, 'boya_roja', 0 FROM rods_owned WHERE rod_id IN ('coral','relampago','brujula','abismo','astro');
INSERT OR IGNORE INTO rods_owned (guild_id, user_id, rod_id, acquired_at)
  SELECT DISTINCT guild_id, user_id, 'marea_azul', 0 FROM rods_owned WHERE rod_id IN ('relampago','brujula','abismo','astro');
INSERT OR IGNORE INTO rods_owned (guild_id, user_id, rod_id, acquired_at)
  SELECT DISTINCT guild_id, user_id, 'camuflaje', 0 FROM rods_owned WHERE rod_id IN ('brujula','abismo','astro');

-- ── Estadísticas reconstruidas a partir de datos existentes (los veteranos no empiezan de cero) ──
INSERT INTO player_stats (guild_id, user_id, stat, value)
  SELECT guild_id, user_id, 'stat:rare_caught', SUM(caught) FROM fish_log WHERE fish_id IN ('trucha_arcoiris','surubi','manguruyu','atun_rojo','pulpo_dumbo','bagre_albino','anguila_plateada','tortuga_delta','tiburon_azul','medusa_abisal','esturion_dorado','pez_luna','celacanto','koi_eclipse','leviatan_cristal') GROUP BY guild_id, user_id;
INSERT INTO player_stats (guild_id, user_id, stat, value)
  SELECT guild_id, user_id, 'stat:epic_caught', SUM(caught) FROM fish_log WHERE fish_id IN ('bagre_albino','anguila_plateada','tortuga_delta','tiburon_azul','medusa_abisal','esturion_dorado','pez_luna','celacanto','koi_eclipse','leviatan_cristal') GROUP BY guild_id, user_id;
INSERT INTO player_stats (guild_id, user_id, stat, value)
  SELECT guild_id, user_id, 'stat:legend_caught', SUM(caught) FROM fish_log WHERE fish_id IN ('esturion_dorado','pez_luna','celacanto','koi_eclipse','leviatan_cristal') GROUP BY guild_id, user_id;
INSERT INTO player_stats (guild_id, user_id, stat, value)
  SELECT guild_id, user_id, 'stat:ultra_caught', SUM(caught) FROM fish_log WHERE fish_id IN ('koi_eclipse','leviatan_cristal') GROUP BY guild_id, user_id;
INSERT INTO player_stats (guild_id, user_id, stat, value)
  SELECT guild_id, user_id, 'stat:coins_from_sales', SUM(delta) FROM ledger WHERE reason LIKE 'venta %' AND delta > 0 GROUP BY guild_id, user_id;
INSERT INTO player_stats (guild_id, user_id, stat, value)
  SELECT guild_id, user_id, 'stat:items_sold', COUNT(*) FROM ledger WHERE reason LIKE 'venta %' AND delta > 0 GROUP BY guild_id, user_id;
INSERT INTO player_stats (guild_id, user_id, stat, value)
  SELECT guild_id, user_id, 'stat:coins_spent', -SUM(delta) FROM ledger
  WHERE delta < 0 AND (reason LIKE 'compra %' OR reason LIKE 'equipo %' OR reason LIKE 'caña %' OR reason LIKE 'permiso %' OR reason LIKE 'mejora %')
  GROUP BY guild_id, user_id;
INSERT INTO player_stats (guild_id, user_id, stat, value)
  SELECT guild_id, user_id, 'stat:purchases', COUNT(*) FROM ledger
  WHERE delta <= -50 AND (reason LIKE 'compra %' OR reason LIKE 'equipo %' OR reason LIKE 'caña %' OR reason LIKE 'permiso %' OR reason LIKE 'mejora %')
  GROUP BY guild_id, user_id;
INSERT INTO player_stats (guild_id, user_id, stat, value)
  SELECT guild_id, user_id, 'stat:events_won', COUNT(*) FROM event_wins GROUP BY guild_id, user_id;
`,
  },
  {
    id: 4,
    name: 'avatares_banners_kiss',
    sql: `
-- ── Historial de avatares y banners detectados por el bot (desde que existe esta tabla) ──
-- Una fila por imagen distinta: si alguien vuelve a una imagen anterior, se actualiza last_seen_at.
CREATE TABLE user_media (
  user_id       TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('avatar', 'banner')),
  hash          TEXT NOT NULL,
  url           TEXT NOT NULL,
  guild_id      TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, hash)
);
CREATE INDEX ix_user_media_recent ON user_media (user_id, kind, last_seen_at DESC);

-- ── Besos: contador por pareja (clave canónica user_a < user_b) y totales por persona ──
CREATE TABLE kiss_pairs (
  guild_id TEXT NOT NULL,
  user_a   TEXT NOT NULL,
  user_b   TEXT NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  last_at  INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_a, user_b),
  CHECK (user_a < user_b)
);
CREATE TABLE kiss_stats (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  given    INTEGER NOT NULL DEFAULT 0,
  received INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);
`,
  },
  {
    id: 5,
    name: 'lago_de_pesca',
    sql: `
-- ── El lago de cada jugador: las casillas se guardan en el servidor (no se pueden falsificar desde un botón) ──
CREATE TABLE fishing_lakes (
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  layout     TEXT NOT NULL,
  seq        INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
`,
  },
  {
    id: 6,
    name: 'kiss_respuestas',
    sql: `
-- ── Respuestas a un beso (Corresponder / Rechazar): una sola por mensaje, aunque se toque dos veces ──
CREATE TABLE kiss_replies (
  message_id TEXT PRIMARY KEY,
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  response   TEXT NOT NULL CHECK (response IN ('correspondido', 'rechazado')),
  created_at INTEGER NOT NULL
);
`,
  },
  {
    id: 7,
    name: 'premium_nombres_tags_vistas',
    sql: `
-- ── Premium: un nivel por usuario (lo da solo el dueño del bot). expires_at NULL = sin vencimiento ──
CREATE TABLE premium (
  user_id    TEXT PRIMARY KEY,
  tier       INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 4),
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  ghost_mode INTEGER NOT NULL DEFAULT 0
);

-- ── Historial de nombres y tags (solo lo que el bot ve desde ahora) ──
-- kind: username (@usuario), display (nombre visible), nick (apodo en un servidor), tag (tag de servidor).
-- scope: '' para lo global; id del servidor para apodos; id del servidor del tag para tags.
CREATE TABLE user_names (
  user_id       TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('username', 'display', 'nick', 'tag')),
  scope         TEXT NOT NULL DEFAULT '',
  value         TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, scope, value)
);
CREATE INDEX ix_user_names_recent ON user_names (user_id, kind, last_seen_at DESC);

-- ── Quién miró los historiales de quién (para !mstats). Con ghostmode no se registra al que mira ──
CREATE TABLE history_views (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id  TEXT NOT NULL,
  viewer_id  TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('avatar', 'banner', 'names', 'tags')),
  guild_id   TEXT,
  viewed_at  INTEGER NOT NULL
);
CREATE INDEX ix_history_views_target ON history_views (target_id, viewed_at DESC);

-- ── Tier 4: servidores donde el usuario personalizó el perfil del bot ──
CREATE TABLE bot_profile_slots (
  user_id    TEXT NOT NULL,
  guild_id   TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, guild_id)
);
CREATE UNIQUE INDEX ux_bot_profile_guild ON bot_profile_slots (guild_id);
`,
  },
  {
    id: 8,
    name: 'autoplay_y_servidores_premium',
    sql: `
-- ── !autoplay (Tier 2+): el bot pesca y farmea por vos cada cierto tiempo, en el servidor donde lo activaste ──
CREATE TABLE autoplay (
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  next_at    INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  harvests   INTEGER NOT NULL DEFAULT 0,
  catches    INTEGER NOT NULL DEFAULT 0,
  runs       INTEGER NOT NULL DEFAULT 0,
  last_at    INTEGER,
  last_note  TEXT,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX ix_autoplay_due ON autoplay (enabled, next_at);

-- ── Tier 4: cuántos servidores puede personalizar cada persona con !botperfil (lo elige el dueño) ──
ALTER TABLE premium ADD COLUMN bot_slots INTEGER NOT NULL DEFAULT 3;
`,
  },
  {
    id: 9,
    name: 'besos_v2_voz_temporal_moderacion',
    sql: `
-- ── Besos: cada beso enviado tiene su fila. Los botones llevan solo el id del beso y el estado se
--    cambia con un UPDATE condicional (open → returned/rejected): un doble clic o dos procesos no
--    pueden responder dos veces ni sumar dos veces al contador. ──
CREATE TABLE kisses (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id         TEXT NOT NULL,
  author_id        TEXT NOT NULL,
  target_id        TEXT NOT NULL,
  author_name      TEXT NOT NULL,
  target_name      TEXT NOT NULL,
  channel_id       TEXT,
  message_id       TEXT,
  gif_url          TEXT,
  state            TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'returned', 'rejected')),
  created_at       INTEGER NOT NULL,
  answered_at      INTEGER,
  reply_message_id TEXT,
  CHECK (author_id <> target_id)
);
CREATE INDEX ix_kisses_author ON kisses (guild_id, author_id, created_at);

-- ── Canales de voz temporales ("unirse para crear") ──
CREATE TABLE voice_config (
  guild_id             TEXT PRIMARY KEY,
  enabled              INTEGER NOT NULL DEFAULT 1,
  category_id          TEXT,
  hub_channel_id       TEXT,
  interface_channel_id TEXT,
  interface_message_id TEXT,
  name_template        TEXT NOT NULL DEFAULT 'Canal de {usuario}',
  default_limit        INTEGER NOT NULL DEFAULT 0 CHECK (default_limit BETWEEN 0 AND 99),
  updated_at           INTEGER NOT NULL
);
-- Un canal temporal por dueño y servidor: la base de datos lo garantiza aunque entre y salga del hub muy rápido.
CREATE TABLE temp_voice_channels (
  channel_id TEXT PRIMARY KEY,
  guild_id   TEXT NOT NULL,
  owner_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_temp_voice_owner ON temp_voice_channels (guild_id, owner_id);
-- Preferencias de cada dueño: se aplican al crear su próximo canal.
CREATE TABLE voice_profiles (
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  name       TEXT,
  user_limit INTEGER CHECK (user_limit IS NULL OR user_limit BETWEEN 0 AND 99),
  locked     INTEGER NOT NULL DEFAULT 0,
  hidden     INTEGER NOT NULL DEFAULT 0,
  region     TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
-- Personas con acceso permitido (trust) o bloqueadas (block) en los canales de un dueño. Nunca las dos cosas.
CREATE TABLE voice_access (
  guild_id   TEXT NOT NULL,
  owner_id   TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('trust', 'block')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, owner_id, target_id)
);

-- ── Moderación: casos numerados por servidor ──
CREATE TABLE mod_cases (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id       TEXT NOT NULL,
  case_number    INTEGER NOT NULL,
  action         TEXT NOT NULL CHECK (action IN ('warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban')),
  target_id      TEXT NOT NULL,
  moderator_id   TEXT NOT NULL,
  reason         TEXT NOT NULL DEFAULT '',
  duration_ms    INTEGER,
  auto           INTEGER NOT NULL DEFAULT 0,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER,
  revoked_by     TEXT,
  revoked_at     INTEGER,
  log_channel_id TEXT,
  log_message_id TEXT,
  UNIQUE (guild_id, case_number)
);
CREATE INDEX ix_mod_cases_target ON mod_cases (guild_id, target_id, created_at);

-- Roles con permisos del bot: mod = advertir, aislar e historial · admin = además expulsar, banear y editar casos.
CREATE TABLE mod_roles (
  guild_id TEXT NOT NULL,
  role_id  TEXT NOT NULL,
  level    TEXT NOT NULL CHECK (level IN ('mod', 'admin')),
  PRIMARY KEY (guild_id, role_id)
);

-- Automod: configuración validada (JSON) y modo raid activo hasta raid_until.
CREATE TABLE automod_config (
  guild_id   TEXT PRIMARY KEY,
  config     TEXT NOT NULL DEFAULT '{}',
  raid_until INTEGER,
  updated_at INTEGER NOT NULL
);
`,
  },
  {
    id: 10,
    name: 'casino',
    sql: `
-- ══════════════════════════ EL VALLE CASINO ══════════════════════════
-- Economía global (una billetera por persona en todos los servidores). Las tablas de la granja
-- y la pesca quedan intactas: no se usan más, pero no se borra ningún dato.

-- ── Jugadores: estadísticas acumuladas, bonos y progreso ──
CREATE TABLE casino_users (
  user_id                 TEXT PRIMARY KEY,
  total_wagered           INTEGER NOT NULL DEFAULT 0 CHECK (total_wagered >= 0),
  total_payout            INTEGER NOT NULL DEFAULT 0 CHECK (total_payout >= 0),
  total_won               INTEGER NOT NULL DEFAULT 0 CHECK (total_won >= 0),
  total_lost              INTEGER NOT NULL DEFAULT 0 CHECK (total_lost >= 0),
  net_profit              INTEGER NOT NULL DEFAULT 0,
  rounds                  INTEGER NOT NULL DEFAULT 0,
  wins                    INTEGER NOT NULL DEFAULT 0,
  losses                  INTEGER NOT NULL DEFAULT 0,
  pushes                  INTEGER NOT NULL DEFAULT 0,
  biggest_bet             INTEGER NOT NULL DEFAULT 0,
  biggest_payout          INTEGER NOT NULL DEFAULT 0,
  biggest_multiplier      REAL    NOT NULL DEFAULT 0,
  current_streak          INTEGER NOT NULL DEFAULT 0,
  best_streak             INTEGER NOT NULL DEFAULT 0,
  tournaments_played      INTEGER NOT NULL DEFAULT 0,
  tournaments_won         INTEGER NOT NULL DEFAULT 0,
  bonus_total             INTEGER NOT NULL DEFAULT 0,
  level_rewarded          INTEGER NOT NULL DEFAULT 1,
  daily_streak            INTEGER NOT NULL DEFAULT 0,
  last_daily_at           INTEGER,
  last_weekly_at          INTEGER,
  last_rescue_at          INTEGER,
  activity_streak         INTEGER NOT NULL DEFAULT 0,
  last_activity_day       TEXT,
  last_activity_reward_at INTEGER,
  flags                   INTEGER NOT NULL DEFAULT 0,
  created_at              INTEGER NOT NULL,
  last_active_at          INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);
CREATE INDEX ix_casino_users_won     ON casino_users (total_won DESC);
CREATE INDEX ix_casino_users_wagered ON casino_users (total_wagered DESC);
CREATE INDEX ix_casino_users_payout  ON casino_users (biggest_payout DESC);
CREATE INDEX ix_casino_users_mult    ON casino_users (biggest_multiplier DESC);
CREATE INDEX ix_casino_users_tour    ON casino_users (tournaments_won DESC);
CREATE INDEX ix_casino_users_rounds  ON casino_users (rounds DESC);
CREATE INDEX ix_casino_users_profit  ON casino_users (net_profit DESC);

-- ── Billeteras (currency permite sumar otras monedas virtuales en el futuro) ──
CREATE TABLE casino_wallets (
  user_id    TEXT NOT NULL REFERENCES casino_users(user_id),
  currency   TEXT NOT NULL DEFAULT 'coins',
  balance    INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, currency)
);
CREATE INDEX ix_casino_wallets_rich ON casino_wallets (currency, balance DESC);

-- ── Transacciones: todo cambio de saldo, con saldo anterior y nuevo (la base verifica la cuenta) ──
CREATE TABLE casino_transactions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id           TEXT NOT NULL UNIQUE,
  user_id         TEXT NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'coins',
  amount          INTEGER NOT NULL,
  balance_before  INTEGER NOT NULL CHECK (balance_before >= 0),
  balance_after   INTEGER NOT NULL CHECK (balance_after >= 0),
  type            TEXT NOT NULL CHECK (type IN ('STARTER','BET','WIN','LOSS','PUSH','REFUND','BONUS','ACTIVITY','LEVEL_REWARD',
                    'ACHIEVEMENT_REWARD','TOURNAMENT_REWARD','TOURNAMENT_ENTRY','JACKPOT','DROP','ADMIN_ADJUSTMENT')),
  game            TEXT,
  round_id        INTEGER,
  guild_id        TEXT,
  idempotency_key TEXT UNIQUE,
  metadata        TEXT,
  created_at      INTEGER NOT NULL,
  CHECK (balance_after = balance_before + amount)
);
CREATE INDEX ix_casino_tx_user  ON casino_transactions (user_id, id DESC);
CREATE INDEX ix_casino_tx_round ON casino_transactions (round_id) WHERE round_id IS NOT NULL;

-- ── Provably fair: semilla del servidor (secreta hasta rotarla), semilla del cliente y nonce ──
CREATE TABLE casino_seeds (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          TEXT NOT NULL,
  server_seed      TEXT NOT NULL,
  server_seed_hash TEXT NOT NULL UNIQUE,
  client_seed      TEXT NOT NULL,
  nonce            INTEGER NOT NULL DEFAULT 0 CHECK (nonce >= 0),
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  revealed_at      INTEGER
);
CREATE UNIQUE INDEX ux_casino_seeds_active ON casino_seeds (user_id) WHERE active = 1;
CREATE INDEX ix_casino_seeds_user ON casino_seeds (user_id, id DESC);

-- ── Rondas: activa = sesión de juego; liquidada = historial ──
CREATE TABLE casino_rounds (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES casino_users(user_id),
  guild_id    TEXT,
  channel_id  TEXT,
  message_id  TEXT,
  game        TEXT NOT NULL,
  bet         INTEGER NOT NULL CHECK (bet > 0),
  total_bet   INTEGER NOT NULL CHECK (total_bet >= bet),
  payout      INTEGER NOT NULL DEFAULT 0 CHECK (payout >= 0),
  multiplier  REAL NOT NULL DEFAULT 0,
  -- RTP con el que empezó la ronda: un cambio de configuración no afecta partidas en curso, y la verificación lo usa.
  rtp         REAL NOT NULL CHECK (rtp > 0 AND rtp <= 1),
  status      TEXT NOT NULL CHECK (status IN ('active', 'won', 'lost', 'push', 'refunded')),
  params      TEXT NOT NULL DEFAULT '{}',
  state       TEXT,
  result      TEXT,
  summary     TEXT,
  version     INTEGER NOT NULL DEFAULT 0,
  seed_id     INTEGER NOT NULL REFERENCES casino_seeds(id),
  nonce       INTEGER NOT NULL,
  rebet_used  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  settled_at  INTEGER
);
-- Una partida abierta por juego y persona (la base lo garantiza aunque lleguen dos comandos a la vez).
CREATE UNIQUE INDEX ux_casino_rounds_active ON casino_rounds (user_id, game) WHERE status = 'active';
-- Un nonce nunca se usa dos veces con la misma semilla.
CREATE UNIQUE INDEX ux_casino_rounds_nonce ON casino_rounds (seed_id, nonce);
CREATE INDEX ix_casino_rounds_user ON casino_rounds (user_id, id DESC);
CREATE INDEX ix_casino_rounds_game ON casino_rounds (game, id DESC);
CREATE INDEX ix_casino_rounds_open ON casino_rounds (updated_at) WHERE status = 'active';

-- ── Estadísticas por juego ──
CREATE TABLE casino_game_stats (
  user_id            TEXT NOT NULL,
  game               TEXT NOT NULL,
  rounds             INTEGER NOT NULL DEFAULT 0,
  wins               INTEGER NOT NULL DEFAULT 0,
  losses             INTEGER NOT NULL DEFAULT 0,
  pushes             INTEGER NOT NULL DEFAULT 0,
  wagered            INTEGER NOT NULL DEFAULT 0,
  payout             INTEGER NOT NULL DEFAULT 0,
  won                INTEGER NOT NULL DEFAULT 0,
  lost               INTEGER NOT NULL DEFAULT 0,
  biggest_payout     INTEGER NOT NULL DEFAULT 0,
  biggest_multiplier REAL NOT NULL DEFAULT 0,
  biggest_bet        INTEGER NOT NULL DEFAULT 0,
  last_played_at     INTEGER,
  PRIMARY KEY (user_id, game)
);

-- ── Logros (el catálogo vive en el código) ──
CREATE TABLE casino_achievements (
  user_id        TEXT NOT NULL,
  achievement_id TEXT NOT NULL,
  reward         INTEGER NOT NULL DEFAULT 0,
  unlocked_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, achievement_id)
);

-- ── Torneos ──
CREATE TABLE casino_tournaments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL CHECK (kind IN ('daily', 'weekly', 'special')),
  metric       TEXT NOT NULL CHECK (metric IN ('profit', 'wagered', 'multiplier', 'wins')),
  game         TEXT,
  min_bet      INTEGER NOT NULL DEFAULT 0 CHECK (min_bet >= 0),
  max_bet      INTEGER CHECK (max_bet IS NULL OR max_bet > 0),
  entry_fee    INTEGER NOT NULL DEFAULT 0 CHECK (entry_fee >= 0),
  fees_to_pool INTEGER NOT NULL DEFAULT 1,
  prizes       TEXT NOT NULL DEFAULT '[]',
  min_rounds   INTEGER NOT NULL DEFAULT 0 CHECK (min_rounds >= 0),
  status       TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'active', 'finished', 'cancelled')),
  starts_at    INTEGER NOT NULL,
  ends_at      INTEGER NOT NULL,
  auto_key     TEXT UNIQUE,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  CHECK (ends_at > starts_at)
);
CREATE INDEX ix_casino_tour_status ON casino_tournaments (status, ends_at);
CREATE TABLE casino_tournament_entries (
  tournament_id   INTEGER NOT NULL REFERENCES casino_tournaments(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  score           REAL NOT NULL DEFAULT 0,
  rounds          INTEGER NOT NULL DEFAULT 0,
  wins            INTEGER NOT NULL DEFAULT 0,
  wagered         INTEGER NOT NULL DEFAULT 0,
  profit          INTEGER NOT NULL DEFAULT 0,
  best_multiplier REAL NOT NULL DEFAULT 0,
  fee_paid        INTEGER NOT NULL DEFAULT 0,
  final_rank      INTEGER,
  prize           INTEGER NOT NULL DEFAULT 0,
  joined_at       INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (tournament_id, user_id)
);
CREATE INDEX ix_casino_tour_score ON casino_tournament_entries (tournament_id, score DESC, updated_at);

-- ── Actividad por día (recompensas por mensajes) ──
CREATE TABLE casino_activity (
  user_id  TEXT NOT NULL,
  day      TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  coins    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- ── Configuración global del casino (JSON validado), pozos y datos internos ──
CREATE TABLE casino_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE casino_pools (
  pool       TEXT PRIMARY KEY,
  amount     INTEGER NOT NULL CHECK (amount >= 0),
  updated_at INTEGER NOT NULL
);
CREATE TABLE casino_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ── En qué servidores jugó cada persona (para el top del servidor) ──
CREATE TABLE casino_user_guilds (
  user_id   TEXT NOT NULL,
  guild_id  TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (user_id, guild_id)
);
CREATE INDEX ix_casino_user_guilds ON casino_user_guilds (guild_id, user_id);

-- ── Ajustes del casino en cada servidor (los configura el staff del servidor) ──
CREATE TABLE casino_guild_settings (
  guild_id            TEXT PRIMARY KEY,
  announce_channel_id TEXT,
  game_channels       TEXT NOT NULL DEFAULT '[]',
  activity_enabled    INTEGER NOT NULL DEFAULT 1,
  updated_at          INTEGER NOT NULL
);

-- ── Distinciones por nivel del casino (reemplazan a las de granja/pesca) ──
CREATE TABLE casino_role_rewards (
  guild_id TEXT NOT NULL,
  role_id  TEXT NOT NULL,
  level    INTEGER NOT NULL CHECK (level >= 1),
  PRIMARY KEY (guild_id, role_id)
);

-- ── Eventos: lluvia de monedas ──
CREATE TABLE casino_drops (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id         TEXT NOT NULL,
  channel_id       TEXT NOT NULL,
  message_id       TEXT,
  amount_each      INTEGER NOT NULL CHECK (amount_each > 0),
  max_claims       INTEGER NOT NULL CHECK (max_claims > 0),
  claims           INTEGER NOT NULL DEFAULT 0,
  min_account_days INTEGER NOT NULL DEFAULT 7,
  status           TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  created_by       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  CHECK (claims <= max_claims)
);
CREATE TABLE casino_drop_claims (
  drop_id    INTEGER NOT NULL REFERENCES casino_drops(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (drop_id, user_id)
);

-- ── Registro de acciones administrativas ──
CREATE TABLE casino_admin_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   TEXT NOT NULL,
  action     TEXT NOT NULL,
  target_id  TEXT,
  details    TEXT,
  guild_id   TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX ix_casino_admin_log ON casino_admin_log (created_at DESC);
`,
  },
  {
    id: 11,
    name: 'casino_trabajos',
    sql: `
-- ── !work: tipos de movimiento WORK (sueldo) y FINE (multa) ──
-- SQLite no permite cambiar un CHECK: se recrea la tabla copiando todos los movimientos tal cual.
CREATE TABLE casino_transactions_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id           TEXT NOT NULL UNIQUE,
  user_id         TEXT NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'coins',
  amount          INTEGER NOT NULL,
  balance_before  INTEGER NOT NULL CHECK (balance_before >= 0),
  balance_after   INTEGER NOT NULL CHECK (balance_after >= 0),
  type            TEXT NOT NULL CHECK (type IN ('STARTER','BET','WIN','LOSS','PUSH','REFUND','BONUS','ACTIVITY','LEVEL_REWARD',
                    'ACHIEVEMENT_REWARD','TOURNAMENT_REWARD','TOURNAMENT_ENTRY','JACKPOT','DROP','ADMIN_ADJUSTMENT','WORK','FINE')),
  game            TEXT,
  round_id        INTEGER,
  guild_id        TEXT,
  idempotency_key TEXT UNIQUE,
  metadata        TEXT,
  created_at      INTEGER NOT NULL,
  CHECK (balance_after = balance_before + amount)
);
INSERT INTO casino_transactions_new SELECT * FROM casino_transactions;
DROP TABLE casino_transactions;
ALTER TABLE casino_transactions_new RENAME TO casino_transactions;
CREATE INDEX ix_casino_tx_user  ON casino_transactions (user_id, id DESC);
CREATE INDEX ix_casino_tx_round ON casino_transactions (round_id) WHERE round_id IS NOT NULL;

-- ── Experiencia de trabajo y turnos por día ──
ALTER TABLE casino_users ADD COLUMN work_shifts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE casino_users ADD COLUMN last_work_at INTEGER;
CREATE TABLE casino_work (
  user_id TEXT NOT NULL,
  day     TEXT NOT NULL,
  shifts  INTEGER NOT NULL DEFAULT 0,
  earned  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- ── Economía más dura: si el dueño ya había guardado una configuración, se bajan solo los ingresos gratis
-- (bonos, actividad, niveles y premios de torneos automáticos). Lo demás (juegos, apuestas, ventajas) queda igual. ──
UPDATE casino_config SET value = json_set(value,
  '$.startingBalance', 1000,
  '$.daily.amount', 100, '$.daily.streakPct', 5, '$.daily.streakMaxDays', 6,
  '$.weekly.amount', 400,
  '$.rescue.amount', 100, '$.rescue.below', 20, '$.rescue.cooldownHours', 24,
  '$.activity.min', 1, '$.activity.max', 3, '$.activity.cooldownSeconds', 120, '$.activity.dailyCap', 50,
  '$.activity.minLetters', 8, '$.activity.minWords', 3, '$.activity.decayAfter', 15, '$.activity.streakPct', 3,
  '$.activity.streakMaxDays', 5, '$.activity.minAccountDays', 14, '$.activity.minMemberHours', 24,
  '$.levels.rewardPerLevel', 3,
  '$.tournaments.daily.prizes', json('[1500,900,600]'), '$.tournaments.daily.minRounds', 15,
  '$.tournaments.weekly.prizes', json('[6000,4000,2500,1500,1000]'), '$.tournaments.weekly.minRounds', 50
) WHERE key = 'main';
`,
  },
  {
    id: 12,
    name: 'versiones_de_configuracion',
    sql: `
-- Versión del diseño de los canales del bot (registros, voz temporal) aplicada en cada servidor.
-- Al arrancar una versión nueva del bot, los servidores con una versión vieja se sincronizan solos.
CREATE TABLE setup_versions (
  guild_id   TEXT NOT NULL,
  system     TEXT NOT NULL,
  version    INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, system)
);
`,
  },
  {
    id: 13,
    name: 'perfil_casamientos_boosts_webhooks_idioma',
    sql: `
-- ── Casamientos (globales: una pareja por persona). user_a < user_b para que no haya dos filas por pareja ──
CREATE TABLE marriages (
  user_a     TEXT NOT NULL,
  user_b     TEXT NOT NULL,
  guild_id   TEXT,
  married_at INTEGER NOT NULL,
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)
);
CREATE UNIQUE INDEX ux_marriages_a ON marriages (user_a);
CREATE UNIQUE INDEX ux_marriages_b ON marriages (user_b);
CREATE TABLE marriage_proposals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL,
  proposer_id TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'rejected', 'expired', 'cancelled')),
  created_at  INTEGER NOT NULL,
  answered_at INTEGER
);
CREATE INDEX ix_marriage_proposals ON marriage_proposals (proposer_id, status);

-- ── Mensajes de boost ──
CREATE TABLE boost_config (
  guild_id    TEXT PRIMARY KEY,
  enabled     INTEGER NOT NULL DEFAULT 1,
  channel_id  TEXT,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  color       INTEGER NOT NULL,
  image_url   TEXT,
  footer      TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
);

-- ── Anti-webhooks ──
CREATE TABLE webhook_guard (
  guild_id     TEXT PRIMARY KEY,
  enabled      INTEGER NOT NULL DEFAULT 1,
  allow_admins INTEGER NOT NULL DEFAULT 1,
  kick_bots    INTEGER NOT NULL DEFAULT 1,
  allow_roles  TEXT NOT NULL DEFAULT '[]',
  updated_at   INTEGER NOT NULL
);

-- ── Idioma del bot en cada servidor ──
ALTER TABLE guild_settings ADD COLUMN language TEXT NOT NULL DEFAULT 'es';
`,
  },
];

export function runMigrations(db: Db, now: number = Date.now()): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  const applied = new Set(db.all<{ id: number }>('SELECT id FROM schema_migrations').map((r) => r.id));
  const done: number[] = [];
  for (const m of [...MIGRATIONS].sort((a, b) => a.id - b.id)) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', m.id, m.name, now);
    });
    done.push(m.id);
  }
  return done;
}
