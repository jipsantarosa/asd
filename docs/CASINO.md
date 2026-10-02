# 🎰 El Valle Casino — arquitectura

Documento de diseño de la reestructuración: el bot pasa de granja y pesca a un **casino virtual**. Toda la economía es de moneda interna (**Coins 🪙**): no se compra, no se retira y no se cambia por dinero real.

## 1. Auditoría del proyecto anterior

| Área | Antes | Decisión |
|---|---|---|
| Lenguaje y framework | TypeScript 5, discord.js 14.27, Node 22 | Se conserva |
| Base de datos | SQLite (better-sqlite3 o `node:sqlite`), migraciones versionadas | Se conserva; migración 10 para el casino |
| Comandos | `Command` con slash y prefijo, botones ruteados por `customId` (`g:mod:acción:dueño:args`) | Se conserva y se amplía (subcomandos, comandos solo por prefijo, menú contextual) |
| Economía | `profiles.coins` **por servidor**, libro contable `ledger` simple, atada a granja y pesca | **Se reemplaza** por una billetera global con transacciones auditables |
| Actividad | Puntos por cosechar y pescar (`services/activity.ts`) | **Se reemplaza** por recompensas por participación real, con filtros anti-farming |
| Ranking | Niveles de granja y pesca por servidor (`services/leaderboard.ts`) | **Se reemplaza** por el ranking de riqueza del casino |
| Granja, pesca, mercado, inventario, cañas, potenciadores, consumibles, logros de pesca | ≈4.400 líneas en `game/` y `services/` | **Se elimina** |
| Actividad web (`activity/`, `src/activity/`) | Juego web de granja y pesca | **Se elimina** (era de granja y pesca, y además era superficie de ataque) |
| `!autoplay` (premium) | Farmeaba solo cada 10 min | **Se elimina** (es farming automático) |
| Sorteos automáticos | Premios de granja | **Se reemplazan** por torneos y eventos del casino |
| Moderación, automod, voz temporal, besos, historiales, premium, registros, roles, purga, backups | Desacoplados de la granja | **Se conservan** |
| Distinciones (roles por nivel) | Por nivel de granja y pesca | **Se adaptan** al nivel del casino |

**Datos viejos:** las tablas de la granja **no se borran** (las migraciones nunca destruyen datos). Al abrir su cuenta del casino, quien tenía monedas de El Valle recibe un **bono de bienvenida** (1 Coin cada 100 monedas viejas, con tope de 25.000). Así se reconoce a los veteranos sin importar la inflación de la economía anterior.

## 2. Principios

1. **Un solo punto de cambio de saldo.** `casino/economy.ts → applyTx()` es la única función que modifica una billetera. Valida enteros seguros, no permite saldos negativos ni por encima del tope, registra saldo anterior y nuevo, y acepta una **clave de idempotencia** única (un pago repetido devuelve la transacción original en lugar de pagar dos veces).
2. **Todo lo crítico es una transacción SQLite sincrónica.** Una apuesta y su liquidación (débito, crédito, estadísticas, torneos, logros) ocurren dentro de una sola transacción. En Node no hay otro código que pueda ejecutarse en medio.
3. **El servidor decide todo.** Los botones solo llevan el id de la ronda, su **versión** y el índice elegido. Una versión vieja (doble clic, botón repetido) se rechaza.
4. **Azar verificable.** Ningún resultado usa `Math.random()`. Cada ronda sale de una semilla del servidor (secreta, con su hash publicado), una semilla del cliente y un nonce (sección 6).
5. **Las reglas son puras.** Los juegos son funciones sin Discord ni base de datos. Se prueban solos, y su RTP se calcula exactamente en los tests.
6. **Discord es solo la pantalla.** Primero se resuelve y guarda el resultado; después se muestra la animación. Si Discord falla, el dinero ya está en un estado correcto.

## 3. Estructura

```
src/
├─ casino/                     núcleo (sin discord.js)
│  ├─ config.ts                CasinoConfig: valores, rangos seguros, guardado y caché
│  ├─ economy.ts               billeteras y transacciones (applyTx) + auditoría
│  ├─ rng.ts                   provably fair: semillas, HMAC-SHA256, flotantes, mezcla
│  ├─ users.ts                 perfil del jugador, estadísticas, rachas, niveles y rangos
│  ├─ engine.ts                CasinoGame + ciclo de ronda: apostar, actuar, liquidar, devolver, abandonar
│  ├─ leaderboard.ts           top por categoría (global o por servidor) y posición personal
│  ├─ achievements.ts          catálogo y desbloqueo (con recompensa idempotente)
│  ├─ tournaments.ts           torneos: creación, puntuación, cierre y premios
│  ├─ bonus.ts                 diario (con racha), semanal y rescate
│  ├─ activity.ts              recompensas por mensajes (anti-farming)
│  ├─ events.ts                lluvias de monedas y boost de actividad
│  ├─ jackpot.ts               pozo progresivo de Slots
│  ├─ guilds.ts                ajustes del casino por servidor (anuncios, canales de juego, actividad)
│  ├─ admin.ts                 ajustes de saldo del dueño y registro administrativo
│  └─ games/                   un archivo por juego + utilidades compartidas
│     ├─ cards.ts  blackjack.ts  roulette.ts  slots.ts  crash.ts  plinko.ts
│     ├─ mines.ts  chicken.ts  balloons.ts  hilo.ts  tower.ts
│     └─ index.ts              registro de juegos (agregar uno = un archivo + una línea)
└─ discord/
   ├─ casino/                  capa de Discord del casino
   │  ├─ commands.ts           juegos (slash y prefijo con el mismo código), lobby, billetera, perfil, top, stats…
   │  ├─ tournamentCommands.ts !torneo (lista, tabla, unirse; create/edit/start/stop/cancel del dueño)
   │  ├─ admin.ts              !casino … y !balance add|remove|set (dueño del bot)
   │  ├─ handlers.ts           botones, menús y ventanas (juegos, lobby, perfil, top, fairness, torneos, lluvias, config)
   │  ├─ play.ts               flujo de juego: apostar, animar, repetir, Crash en vivo (cola de ediciones), recuperación
   │  ├─ screen.ts             pantallas (embeds o Components V2) y cómo enviarlas/editarlas
   │  ├─ format.ts             apuestas escritas a mano, encabezados, resultado y botones comunes
   │  ├─ games/                pantalla y reglas de cada juego (estado → pantalla)
   │  ├─ ui/                   lobby, billetera, perfil, top, fairness, torneos y paneles de administración
   │  ├─ announce.ts           anuncios en el canal de cada servidor (torneos)
   │  ├─ scheduler.ts          latido, Crash interrumpidos, partidas abandonadas, torneos y lluvias vencidas
   │  └─ activity.ts           escucha de mensajes para la actividad
   ├─ commands/steal.ts        !steal, /steal y el menú contextual "Robar emoji o sticker"
   └─ expressions/steal.ts     reglas de !steal (permisos, lugares, formatos, descarga del CDN)
```

### Agregar un juego nuevo

Un juego implementa `CasinoGame`:

```ts
interface CasinoGame<P, S> {
  id: GameId; name: string; emoji: string; kind: 'instant' | 'interactive';
  parseParams(raw: string[]): P;                         // valida los parámetros propios (además de la apuesta)
  play?(c: PlayContext<P>): Settlement;                  // instantáneos: resultado completo
  start?(c: PlayContext<P>): Step<S>;                    // con decisiones: TODO el azar se decide acá
  act?(state: S, action: GameAction, c: ActContext): Step<S>;   // decisiones del jugador (sin azar)
  resolveAbandoned?(state: S, c: ActContext): Settlement | 'refund';  // partida abandonada o interrumpida
  fairSummary(rng: FairRng, params: P): string;          // lo que se puede verificar con la semilla
}
```

El motor se encarga del resto: validar la apuesta, cobrarla, reservar el nonce, guardar el estado, la versión anti-replay, liquidar con tope de premio, las estadísticas por juego, el historial, los torneos, los logros, los niveles, el jackpot y las devoluciones. Un Dice, un Keno o un Limbo serían un archivo de reglas, una pantalla y una línea en el registro.

## 4. Economía

**Moneda:** Coins 🪙, global (la misma billetera en todos los servidores donde está el bot). La tabla de billeteras tiene la columna `currency` para sumar otras monedas en el futuro (fichas de torneo, temporadas).

| Entradas (se crean Coins) | Por defecto |
|---|---|
| Saldo inicial | 5.000 |
| Bono diario (`!daily`) | 1.000 + 10 % por día de racha (hasta +100 %) |
| Bono semanal (`!weekly`) | 7.500 |
| Rescate (`!rescate`) | 500 si tenés menos de 100 y ninguna partida abierta, cada 8 h |
| Actividad (mensajes) | 4 a 12 por mensaje válido, espera de 60 s, tope de 600 por día, rendimiento decreciente |
| Subida de nivel | 20 × nivel |
| Logros | 250 a 25.000, una sola vez |
| Torneos automáticos | diario 30.000 · semanal 150.000 (pozos fijos) |
| Juegos ganados | según el RTP de cada juego |

| Salidas (se destruyen Coins) | |
|---|---|
| Ventaja de la casa | ≈1–4 % de todo lo apostado (es la salida principal y escala con la actividad) |
| Entradas a torneos especiales | configurable por torneo |
| Futuras: cosméticos, temporadas | la billetera ya soporta más tipos de transacción |

**Decisiones contra la inflación y el abuso:**
- **No hay transferencias entre jugadores.** Es la decisión más importante: sin `!pay`, las cuentas alternativas no pueden juntar bonos en una cuenta principal.
- Los bonos tienen esperas por persona (no por servidor): tener muchos servidores no multiplica nada.
- La actividad tiene filtros de calidad, tope diario y rendimiento decreciente (sección 7).
- Hay un premio máximo por ronda (5.000.000), apuestas mínima y máxima por juego, y un tope duro de saldo (10¹⁵, muy por debajo de 2⁵³).
- El jackpot sale del 1 % de las apuestas de Slots, no se crea de la nada (solo la semilla inicial).

**RTP por juego (configurable por el dueño):** Crash, Plinko, Minas, Pollo, Globos, Hilo y Dragon Tower usan multiplicadores calculados como `RTP / probabilidad`: el valor esperado es el RTP en cualquier punto donde cobres. Slots escala su tabla de pagos al RTP configurado. Ruleta (europea, 2,7 % por el 0) y Blackjack (≈0,5 % con estas reglas) tienen la ventaja en sus propias reglas.

## 5. Ciclo de una ronda

```
apostar ─┬─ instantáneo (ruleta, slots, plinko) ── jugar ── liquidar          (una transacción)
         └─ interactivo ── estado guardado ── acción(versión) … ── liquidar   (una transacción por paso)
                                   │
                                   ├─ abandono (30 min sin tocar) → cobrar lo ganado / plantarse / devolver
                                   └─ reinicio del bot → los botones siguen funcionando (el estado está en la base)
```

- **Apostar:** valida el juego habilitado, la apuesta (entero, mínimo, máximo, saldo), la espera del juego y que no haya otra partida abierta del **mismo juego** (índice único parcial). Cobra con `BET`, reserva el nonce y crea la ronda.
- **Liquidar:** `payout = min(floor(apuesta × multiplicador), premio máximo)`. Si ganó, registra `WIN` o `PUSH`; si perdió, `LOSS` por 0 (cada ronda tiene exactamente una liquidación, garantizada por una clave única `settle:<ronda>`). También actualiza las estadísticas globales y por juego, la racha, el nivel (con su recompensa), los torneos activos, los logros y el jackpot.
- **Doblar y dividir (blackjack):** son apuestas extra (`BET`) dentro de la misma ronda. Sin saldo suficiente, la acción se rechaza sin cambiar nada.
- **Crash tras un reinicio:** si había retiro automático y el cohete llegaba, se paga. Si el cohete ya había explotado mientras el bot estaba prendido (según el último latido guardado), cuenta como pérdida. Si no, se **devuelve la apuesta** (el jugador no pudo retirar).
- **Nunca queda dinero ambiguo:** toda apuesta cobrada termina en un pago, una pérdida registrada o una devolución.

## 6. Azar verificable (provably fair)

- Cada jugador tiene un par activo: **semilla del servidor** (32 bytes de `crypto.randomBytes`, secreta, con su SHA-256 publicado), **semilla del cliente** (editable) y **nonce** (sube con cada apuesta).
- Los flotantes de una ronda son `HMAC-SHA256(semillaServidor, "semillaCliente:nonce:bloque")`, en bloques de 32 bytes que dan 8 enteros de 32 bits; cada flotante es `uint32 / 2³²`.
- Las mezclas (mazos, minas, globos, torre) usan Fisher-Yates con esos flotantes. Plinko usa un flotante por fila (< 0,5 = izquierda). Crash usa `max(1, floor(100 × RTP / (1 − f)) / 100)`, que da `P(llegar a x) = RTP / x`.
- `!fairness` muestra el hash activo, la semilla del cliente y el nonce. `!fairness rotar` revela la semilla anterior y crea una nueva (no se puede con partidas abiertas: revelaría resultados pendientes). `!fairness verificar <ronda>` recalcula el resultado con la semilla revelada.

## 7. Actividad (anti-farming)

Un mensaje da Coins solo si:
- no es un comando;
- tiene al menos 6 letras y 2 palabras;
- no repite uno de tus últimos mensajes;
- pasaron 60 s desde tu última recompensa;
- tu cuenta tiene más de 7 días y llevás más de 1 h en el servidor;
- el servidor tiene la actividad activada.

El monto es de 4 a 12 Coins por mensaje:
- **Rendimiento decreciente:** desde el mensaje recompensado 30 del día paga la mitad, y desde el 60, un cuarto.
- **Racha:** suma +5 % por día seguido con actividad (hasta +50 %).
- **Tope diario:** 600 Coins. El automod corre antes: el spam nunca paga.

## 8. Datos (migración 10)

| Entidad pedida | Tabla |
|---|---|
| User | `casino_users` (estadísticas acumuladas, racha, nivel, bonos, flags) |
| Wallet | `casino_wallets` (`user_id`, `currency`, `balance ≥ 0`) |
| Transaction | `casino_transactions` (CHECK `balance_after = balance_before + amount`, `idempotency_key` único) |
| GameSession + GameHistory | `casino_rounds` (una fila por ronda: activa = sesión; liquidada = historial) |
| UserGameStats | `casino_game_stats` |
| Achievement / UserAchievement | catálogo en código + `casino_achievements` |
| Tournament / Participant / Score | `casino_tournaments` + `casino_tournament_entries` (la puntuación vive en la inscripción) |
| DailyReward | columnas de bonos en `casino_users` + `casino_activity` (por día) |
| CasinoConfig | `casino_config` (JSON validado con rangos seguros) |
| Extras | `casino_seeds`, `casino_pools` (jackpot), `casino_user_guilds` (top por servidor), `casino_guild_settings`, `casino_role_rewards`, `casino_drops`, `casino_drop_claims`, `casino_admin_log`, `casino_meta` (latido) |

## 9. Comandos

- **Juegos:** `!blackjack` `!ruleta` `!slots` `!crash` `!plinko` `!minas` `!pollo` `!globos` `!hilo` `!dragon`. Sin argumentos muestran las reglas y la tabla de pagos.
- **Economía:** `!balance` `!daily` `!weekly` `!rescate`.
- **Perfil y social:** `!perfil` `!top [categoría] [página]` `!rank` `!stats [juego]` `!history [juego]` `!logros` `!fairness`.
- **Torneos:** `!torneo` (lista, ranking y unirse).
- **Dueño del bot:**
  - `!torneo create|edit|start|stop|cancel|list|leaderboard`;
  - `!casino config|enable|disable|minbet|maxbet|edge|cooldown|set|drop|boost|hide|block`;
  - `!balance add|remove|set`.
- **Servidor** (Gestionar servidor): `/ajustes` → canal de anuncios, canales de juego y actividad.
- **Utilidades:** `!steal` (respondiendo a un mensaje), `/steal` y el menú contextual "Robar emoji o sticker".
- **Moderación:** el historial por prefijo pasa a `!modlogs` (libera `!history` para el casino).
