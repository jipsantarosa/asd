# 🎰 El Valle Casino — bot de Discord

Casino **virtual** para servidores de Discord: 10 juegos con botones y animaciones, economía central con estadísticas completas, ranking, torneos automáticos y especiales, logros, azar verificable (*provably fair*) y recompensas por actividad con filtros anti-farming.

> 🪙 **Toda la economía usa Coins, una moneda interna del bot.** No existe compra, retiro, conversión ni intercambio por dinero real (ni por nada fuera del bot). Los premios, las apuestas, los torneos y los saldos son únicamente virtuales.

Además conserva lo útil del bot anterior: **besos** con respuesta y contador, **canales de voz temporales** con interfaz, **moderación completa** (casos, escalado, automod y antiraid), **registros** del servidor, **paneles de roles**, historiales de avatares y nombres, **premium** y `!steal` para copiar emojis y stickers.

> 📖 **Wiki para usuarios y admins** (lista para GitBook): carpeta [`wiki/`](wiki/README.md).
>
> 📐 La arquitectura del casino (economía, motor de juegos, azar verificable, datos y decisiones) está en [`docs/CASINO.md`](docs/CASINO.md). La auditoría anterior, en [`docs/AUDITORIA.md`](docs/AUDITORIA.md).

Stack: Node.js 22+, TypeScript, discord.js 14 (≥ 14.19, por Components V2), SQLite (better-sqlite3 o el SQLite de Node).

---

## 1. Crear la aplicación en Discord

1. Entrá a <https://discord.com/developers/applications> → **New Application**.
2. En **Bot** → **Reset Token** y copiá el token (va en `DISCORD_TOKEN`).
3. En **Bot → Privileged Gateway Intents** activá:
   - **Server Members Intent**: entradas y salidas, y distinciones.
   - **Message Content Intent**: comandos con prefijo, actividad del casino y registro de mensajes.
4. Invitá al bot con **OAuth2 → URL Generator**:
   - Scopes: `bot` y `applications.commands`.
   - Permisos: Ver canales, Enviar mensajes, Insertar enlaces, Adjuntar archivos, Leer el historial de mensajes, Gestionar canales, Gestionar roles y Ver el registro de auditoría.
   - Para `!steal`: además **Crear expresiones** (o Gestionar expresiones).
   - Para **canales de voz temporales**: además Conectar y Mover miembros.
   - Para **moderación y automod**: además Gestionar mensajes, Moderar miembros, Expulsar miembros y Banear miembros.
   - Ubicá el **rol del bot por encima** de los roles que va a entregar y de los roles de quienes va a moderar.

## 2. Instalación

En Windows alcanza con abrir **`iniciar.bat`**: instala, compila y arranca el bot (y lo reinicia si se cae). `configurar.bat` guarda el token y los dueños en `.env`.

A mano:

```bash
npm install
cp .env.example .env              # completá DISCORD_TOKEN
npm run build
npm start                         # los comandos de barra se registran solos al conectarse
```

Para desarrollo: poné `DEV_GUILD_ID` en `.env` (los comandos aparecen al instante en ese servidor) y usá `npm run dev`.

| Variable | Qué es |
|---|---|
| `DISCORD_TOKEN` | Token del bot |
| `CLIENT_ID` | Application ID (opcional: si falta, se deduce del token) |
| `DEV_GUILD_ID` | (opcional) servidor de pruebas para registrar comandos al instante |
| `DATABASE_PATH` | Archivo SQLite (por defecto `./data/valle.db`) |
| `DEFAULT_PREFIX` | Prefijo inicial de cada servidor (por defecto `!`) |
| `OWNER_IDS` | (opcional) dueños del bot: configuran el casino, los saldos, los torneos y el premium. El dueño de la aplicación se detecta solo |

### Actualizar sin configurar todo de nuevo

La configuración y los saldos están en `data/valle.db` y el token en `.env`. Para actualizar, hacé doble clic en **`actualizar.bat`** en la misma carpeta: cierra el bot, respalda la base en `data/backups/`, baja la versión nueva de GitHub reemplazando **solo el código** (nunca `data/`, `.env` ni `node_modules/`) y abre `iniciar.bat`. La lógica está en `scripts/actualizar.mjs` (Node, sin dependencias). Se configura con `UPDATE_REPO` y `UPDATE_BRANCH` en el `.env`. Si el repo es **privado**, hace falta Git instalado (pide iniciar sesión en GitHub una vez) o un `GITHUB_TOKEN` de solo lectura.

## 3. Base de datos y migraciones

> 🔄 **Al actualizar el bot no hace falta borrar canales a mano.** Si una versión nueva cambia el diseño de los canales de registros o de voz temporal, al arrancar el bot los actualiza solo en cada servidor donde estaban configurados (renombra, mueve y corrige permisos, sin borrar nada) y deja un resumen en el canal de sistema. Lo que sobre de instalaciones viejas se borra con un botón desde `/setup` o `/voz`. Para que esto funcione con los datos, **no borres la carpeta `data/`** al actualizar.

- **Motor:** `better-sqlite3` si funciona en tu PC; si no, el SQLite que trae Node (22.13+). El archivo es el mismo con cualquiera de los dos.
- Las migraciones se aplican **solas al iniciar** y se pueden ejecutar varias veces sin romper nada (tabla `schema_migrations`).
- **Migración 13:** casamientos, mensajes de boost, anti-webhooks e idioma por servidor.
- **Migración 14:** plantillas de servidor guardadas (`/plantilla`).
- **Migración 15:** autoroles (personas y bots).
- **Migración 16:** roles premium por servidor.
- **Migración 12:** guarda la versión del diseño de los canales del bot aplicada en cada servidor (para actualizarlos solos).
- **Migración 11:** trabajos (`!work`) y economía más dura.
- **Migración 10 (casino):** crea billeteras, transacciones, rondas, semillas, estadísticas por juego, logros, torneos, actividad, configuración, pozos, ajustes por servidor, distinciones por nivel, lluvias de monedas y el registro administrativo. **No borra nada**: las tablas de la granja y la pesca quedan intactas (aunque ya no se usan). Quien tenía monedas en la granja recibe, al abrir su cuenta del casino, un **bono de bienvenida** único (1 Coin cada 1.000 monedas viejas, sumando servidores, con tope de 2.500).
- Las migraciones 1 a 9 (granja, pesca, comunidad, premium, besos, voz temporal y moderación) siguen en el código para que cualquier base vieja pueda actualizarse.
- **Copia de seguridad automática** diaria en `data/backups/valle-AAAA-MM-DD.db` (se guardan 7). Para restaurar: detené el bot, copiá la que quieras como `data/valle.db` y borrá `valle.db-wal` y `valle.db-shm`.
- El bot está pensado para **un solo proceso** (transacciones SQLite y candados en memoria).

## 4. El casino

### Economía

- **Coins 🪙**, una billetera por persona que vale en todos los servidores donde está el bot. **No hay transferencias entre personas** (así las cuentas alternativas no pueden juntar bonos en una principal).
- Cada cambio de saldo es una **transacción** con saldo anterior y nuevo, tipo (`BET`, `WIN`, `LOSS`, `PUSH`, `REFUND`, `BONUS`, `ACTIVITY`, `LEVEL_REWARD`, `ACHIEVEMENT_REWARD`, `TOURNAMENT_REWARD`, `TOURNAMENT_ENTRY`, `JACKPOT`, `DROP`, `ADMIN_ADJUSTMENT`…) y, cuando corresponde, una **clave única** que impide pagar dos veces. La base verifica con `CHECK` que cada movimiento cuadre y que ningún saldo sea negativo. `!casino audit` comprueba que la suma de los saldos sea igual a la suma de las transacciones.
- **La economía está pensada para ser difícil de farmear** (todo configurable por el dueño): saldo inicial 1.000 · `!daily` 50 + 10 % por día de racha (hasta +70 %) · `!weekly` 500 · `!rescate` 100 si tenés menos de 20 (cada 24 h) · actividad 1–3 por mensaje (tope 50/día) · subir de nivel 3 × nivel · logros 25 a 2.500 · torneos.
- **`!work` — trabajos con riesgo:** cada trabajo tiene su espera de **1 hora** (mientras, se pueden hacer otros), una probabilidad de salir bien, un rango de sueldo y, los más caros, una **fianza** que se pierde si sale mal. Cupo de **3.000 Coins por día** y **racha** de días seguidos (+2 % por día, hasta +20 %). Cuentas de Discord de menos de 14 días no pueden trabajar.

  | Trabajo | Riesgo | Sale bien | Sueldo | Fianza |
  |---|---|---|---|---|
  | 🗑️ **Cirujeando** | 🟢 Seguro | 100 % | 10–30 | — |
  | 🛵 **Pedidos Ya** | 🟢 Seguro | 100 % | 15–35 | — |
  | 🧽 **Lavacoches** | 🟢 Seguro | 100 % | 20–40 | — |
  | 🐕 **Paseador de perros** | 🟡 Moderado | 90 % | 25–55 | — |
  | 🥬 **Verdulero** | 🟡 Moderado | 85 % | 40–90 | 10 |
  | 🔧 **Plomero** | 🟡 Moderado | 75 % | 75–165 | 20 |
  | 📄 **Vender informes** | 🟡 Moderado | 70 % | 110–240 | 30 |
  | 🎧 **DJ de fiestas** | 🟡 Moderado | 60 % | 200–420 | 60 |
  | 💻 **Hacker** | 🔴 Arriesgado | 45 % | 450–1.000 | 150 |
  | 🎟️ **Revendedor de entradas** | 🔴 Arriesgado | 40 % | 600–1.400 | 200 |
  | 🗺️ **Cazatesoros** | 🔴 Arriesgado | 35 % | 1.100–2.500 | 300 |
- **Salidas:** la ventaja de la casa de cada juego (≈0,5–3,9 %) y las entradas a torneos especiales. El jackpot de Slots sale del 1 % de sus apuestas.
- **Nivel y rango:** el nivel sube con el **total apostado** (no con lo ganado) y cada nivel paga una recompensa. Rangos: 🥉 Bronce, 🥈 Plata, 🥇 Oro, 💠 Platino, 💎 Diamante, 👑 Leyenda.
- **Estadísticas por persona:** saldo, total ganado, perdido y apostado, mayor apuesta, mayor premio, mayor multiplicador, partidas, victorias, derrotas, beneficio histórico, racha actual y mejor racha, torneos jugados y ganados, bonos recibidos, fechas de creación y de última actividad; y las mismas por juego.

### Juegos

| Juego | Comando | Reglas |
|---|---|---|
| 🃏 Blackjack | `!bj 100` | 6 mazos, crupier se planta en 17 blando, blackjack 3:2, doblar y dividir |
| 🎡 Ruleta | `!ruleta 100 rojo` | Europea; color, par/impar, mitades, docenas, columnas, plenos, listas (`7,17,23`) y rangos (`5-12`) |
| 🎰 Slots | `!slots 100` | 3 rodillos, comodín ⭐, jackpot progresivo con 7️⃣7️⃣7️⃣ |
| 🚀 Crash | `!crash 500 2.5x` | El multiplicador sube hasta explotar; retiro manual o automático; historial de vuelos recientes |
| 🔵 Plinko | `!plinko 100 alto 16` | Riesgo bajo/medio/alto, 8 a 16 filas |
| 💣 Minas | `!minas 100 5` | Tablero 5×5 con 1 a 24 minas (Components V2) |
| 🐔 Pollo | `!pollo 100 difícil` | 10 carriles cada vez más peligrosos |
| 🎈 Globos | `!globos 100` | 8 niveles de 6 globos con cada vez más agujas |
| 🔮 Hilo | `!hilo 100` | Más alta o más baja con mazos reales; lo menos probable paga más; saltar carta |
| 🐉 Dragon Tower | `!dragon 100 experto` | 9 pisos; fácil, medio, difícil o experto |

- Sin apuesta (`!crash`) muestran las **reglas, la tabla de pagos, los límites y el RTP**. Las apuestas aceptan `1000`, `1.000`, `1k`, `2.5k`, `1m`, `mitad` y `todo`.
- En los juegos con multiplicador creciente (Crash, Minas, Pollo, Globos, Hilo, Dragon Tower) el multiplicador es **RTP ÷ probabilidad de llegar**: cobrar en cualquier momento vale lo mismo en promedio. Ruleta y Blackjack tienen la ventaja en sus reglas.
- **Seguridad de las partidas:** cada botón lleva la ronda y su versión; un doble clic o un mensaje viejo no hacen nada. Una sola partida abierta por juego y persona (garantizado por la base). El servidor valida todo: apuesta (entero, mínimo, máximo, saldo), acciones y casillas.
- **Recuperación:** el estado vive en la base, así que los botones siguen funcionando tras un reinicio. Un Crash en vuelo se resuelve al volver (paga el retiro automático si se alcanzaba; si explotó con el bot prendido, pierde; si no, devuelve). Una partida sin tocar 30 minutos se resuelve sola (cobra lo ganado, se planta o devuelve la apuesta).
- **Repetir:** los botones 🔁, ×2 y ½ juegan otra ronda igual (una vez por mensaje).
- **Agregar un juego** (Dice, Baccarat, Keno, Limbo…): un archivo de reglas en `src/casino/games`, su pantalla en `src/discord/casino/games` y una línea en cada registro. Ver `docs/CASINO.md`.

### Azar verificable

Cada ronda sale de `HMAC-SHA256(semilla_del_servidor, "semilla_del_cliente:nonce:bloque")`. El hash de la semilla del servidor se muestra **antes** de jugar; `!fairness rotar` la revela (con partidas abiertas no se puede) y `!fairness verificar <ronda>` recalcula el resultado. No se usa `Math.random()` para nada que afecte un resultado.

### Torneos

- **Automáticos:** uno **diario** y uno **semanal**, con premios fijos y un mínimo de rondas para cobrar. Participás con solo jugar.
- **Especiales** (dueño del bot): `!torneo create Plinko Weekend juego=plinko metrica=multiplicador duracion=2d premios=50k,25k,10k minbet=100 rondas=20 | descripción`, y luego `!torneo start|edit|stop|cancel|list|leaderboard <id>`. Métricas: beneficio, apostado, multiplicador o victorias. Pueden tener **entrada** (que suma al pozo) y fecha de inicio (`inicio=+2h`).
- Cerrar un torneo reparte premios una sola vez aunque se repita el cierre. Cancelar devuelve las entradas. Los inicios y cierres se anuncian en el canal de anuncios de cada servidor.

### Actividad (anti-farming)

Un mensaje paga (1 a 3 Coins) solo si no es un comando, tiene al menos 8 letras y 3 palabras reales, no repite (ni casi repite) tus últimos mensajes, no estás mandando ráfagas, pasaron 2 min desde tu última recompensa, tu cuenta tiene más de 14 días y llevás más de 24 h en el servidor. Desde el mensaje 15 del día paga la mitad y desde el 30 un cuarto; la racha de días seguidos suma hasta +15 %; el tope es de 50 por día. El automod corre antes: el spam nunca paga.

### Administración

- **Dueño del bot** (global):
  - `!casino config` (panel con todo y edición por juego) · `enable|disable <juego|all>` · `minbet|maxbet <juego|all> <n>` · `edge <juego> <%>` · `cooldown <juego> <ms>` · `set <ruta> <valor>`;
  - `!casino auto daily|weekly on|off|metric|prizes|rounds` · `drop <monto> <personas> [minutos]` (lluvia de monedas) · `boost <x> <horas>`;
  - `!casino hide|unhide|block|unblock @x` · `audit` · `log [@x]`;
  - `!balance add|remove|set @x <cantidad> [motivo]`.
  - Todo queda en el registro administrativo (`!casino log`).
- **Staff de cada servidor** (`/ajustes`, Gestionar servidor): prefijo, registro de mensajes, **canal de anuncios** del casino (grandes premios, torneos), **canales de juego** (vacío = cualquiera) y Coins por actividad on/off.

## 5. Comandos

| Comando | Quién | Qué hace |
|---|---|---|
| `/casino` · `!casino` | todos | Lobby: saldo, jackpot, torneos y juegos con sus reglas |
| `/blackjack` `/ruleta` `/slots` `/crash` `/plinko` `/minas` `/pollo` `/globos` `/hilo` `/dragon` | todos | Los 10 juegos (también por prefijo, con alias como `!bj`, `!rl`, `!mines`, `!tower`) |
| `/balance [usuario]` · `!bal` | todos | Billetera, bonos disponibles y actividad del día |
| `/work [trabajo]` · `!work` | todos | 11 trabajos con riesgo, sueldo y fianza; cada uno una vez por hora |
| `/daily` · `/weekly` · `/rescate` | todos | Bonos (chicos) |
| `/profile [usuario]` · `!profile` · `!perfil` | todos | Tarjeta de perfil: nivel, puesto, besos, logros, billetera y matrimonio; botón a las estadísticas del casino |
| `/marry [usuario]` · `!marry @x` (o respondiendo) · `/divorce` | todos | Propuesta de casamiento con botones (una pareja por persona, vence a los 10 min) y divorcio con confirmación |
| `/boosttracker setup·edit·test·reset·off·status` | Gestionar servidor | Mensaje especial cuando alguien boostea: canal, título, descripción, color (Oro, Rosa, Morado…, o #RRGGBB), imagen y footer. Variables `{user}` `{username}` `{server}` `{boosts}` `{tier}` |
| `/anti-webhooks setup·off·status·allow·disallow·admins·bots` | Gestionar servidor | Borra webhooks creados por quien no tiene permiso (y expulsa al bot que los creó), y borra mensajes de webhooks con @everyone, invitaciones o spam |
| `!setlang es` · `!setlang en` | ver: todos · cambiar: Gestionar servidor | Idioma del bot en el servidor |
| `/setupdiscord` · `!setupdiscord` | dueño del bot | Arma el servidor oficial del bot (anuncios, novedades, invitación, reglas, casino, comunidad, soporte, staff, roles y autorroles). Muestra una vista previa; sin emojis, con autorol Miembro/Bots |
| `/plantilla copiar·pegar·importar·archivo·lista·borrar` | dueño del bot | Copia la estructura de un servidor (roles, categorías, canales y permisos) y la pega en otro; también como archivo `.json` editable. Al pegar se elige: crear sin borrar nada, o borrar todos los canales y crear (con doble confirmación y respaldo automático `respaldo-…`) |
| `/rolespremium crear·set·sync·off·estado` · `!rolespremium crear` | Gestionar roles | Un rol por nivel premium (Booster, Tier 2, Tier 3, Tier 4): el bot se lo da a quien tiene premium, se lo cambia si cambia de nivel y se lo quita si lo pierde o vence |
| `/autorol miembros·bots·aplicar·off·estado` · `!autorol @rol` · `!autorol bots @rol` | Gestionar roles | Roles automáticos al entrar, separados: uno para personas y otro para bots |
| `/top [categoria] [pagina] [servidor]` · `!top 2` · `!top ganancias` | todos | **💰 Richest Players** (por saldo) y categorías secundarias, global o del servidor |
| `/rank [usuario]` | todos | Puesto en cada ranking |
| `/stats [juego]` · `/history [juego] [pagina]` | todos | Estadísticas por juego e historial de rondas o movimientos |
| `/logros` · `/fairness` · `/torneo [id]` | todos | Logros, azar verificable y torneos |
| `/steal` · `!steal` (respondiendo a un mensaje) · menú **Robar emoji o sticker** | Crear expresiones | Copia emojis o stickers a este servidor |
| `/kiss` · `/besos` · `/avatares` · `/banners` · `!names` | todos | Comunidad |
| `/canal` · `/voz` | todos · Gestionar servidor | Canales de voz temporales |
| `/mod …` · `!warn` `!timeout` `!kick` `!ban` `!unban` `!modlogs` `!caso` · `/automod` | moderación | Moderación |
| `/purgar` · `!m @x 100` | Gestionar mensajes | Borra mensajes recientes de alguien |
| `/ajustes` · `/roles` · `/setup` · `/prefijo` · `/ayuda` | según el comando | Configuración y ayuda |
| `!premium …` | dueño / todos | Premium |

Mencionar al bot funciona igual que el prefijo.

**Idioma:** `!setlang en` pasa a inglés la ayuda, el perfil, los casamientos, el boost tracker y el anti-webhooks de ese servidor; los juegos y el resto de los paneles siguen en español por ahora.

**Responder en lugar de mencionar:** en los comandos por prefijo que apuntan a alguien (`!kiss`, `!besos`, `!avs`, `!banners`, `!names`, `!perfil`, `!balance`, `!stats`…), si respondés a un mensaje y no mencionás a nadie, el comando usa al autor de ese mensaje. Ejemplo: responderle a alguien con `!kiss`.

## 6. Comunidad y premium

- **`!kiss @usuario`:** "**salo** besa a **h**." y abajo, en chico, "salo y h se han besado 9 veces."; después el GIF de anime (apto para todo público, de nekos.best o, si falla, waifu.pics), el nombre del anime y los botones **💋 Corresponder** y **💔 Rechazar** (solo los usa quien recibió el beso).
  - **Corresponder** crea un **mensaje nuevo que responde al original**: "¡h besa a salo de vuelta!", el contador actualizado y **otro GIF**. Los botones del original quedan desactivados.
  - Cada beso tiene su fila en la base y pasa de "abierto" a "correspondido" o "rechazado" con un UPDATE condicional en la misma transacción que el contador: un doble clic, un panel viejo o un reinicio nunca suman dos veces.
  - Espera de 5 s por persona y de 15 s por pareja (no se puede inflar el contador). Corresponder no tiene espera. No se puede besar a uno mismo ni a bots. Si la API de GIFs no responde, el beso cuenta igual.
  - `/besos [usuario]`: besos dados, recibidos, pendientes de respuesta y con quién más.
- **`!avs @usuario` / `!banners @usuario`:** muestran un **collage** con todo el historial detectado (el más reciente arriba a la izquierda), un menú para ver cada imagen en grande con su fecha, y **📊 Mis estadísticas** (privado, para quien lo toca). El collage se arma en el bot con un codificador PNG propio, sin librerías nativas. El historial es **solo lo que el bot detectó** desde que existe esta función: cambios de avatar al escribir mensajes, al entrar al servidor o cuando Discord avisa (intent *Server Members*), y banners cuando alguien usa el comando (Discord solo manda el banner si se pide explícitamente). Se guarda el ID del usuario, el hash de la imagen, su URL y las fechas. Las imágenes viejas pueden dejar de estar disponibles en la CDN de Discord con el tiempo.
- **`!m @usuario 1000`:** borra en el canal actual hasta 1000 mensajes recientes de esa persona (también `/purgar`). Requiere **Gestionar mensajes** en ese canal; no permite limpiar a alguien con un rol igual o superior al tuyo (salvo el dueño). Revisa el historial de a 100 mensajes (hasta 10.000) y borra en bloques de hasta 100. Discord **no permite borrar en bloque mensajes de más de 14 días**: el comando se detiene ahí y lo informa. Nunca borra mensajes fijados. Una sola limpieza a la vez por canal. Queda registrado en el canal de logs.
- **Permisos del bot:** para `!m`, el rol del bot necesita **Gestionar mensajes** y **Leer el historial de mensajes** en el canal.
- **`!steal`:** respondé a un mensaje con `!steal` (o pegá los emojis: `!steal <:pepe:123…> [nombre]`). Si hay varios, aparece un menú para elegir hasta 10. Requiere **Crear expresiones** (la persona y el bot), respeta los lugares libres según las mejoras del servidor y descarga solo del CDN de Discord. Los stickers **Lottie** y los oficiales de Discord no se pueden subir (Discord no lo permite): el bot lo avisa en lugar de intentarlo. Copiá solo lo que tengas permiso de usar.

**Premium** (lo da el dueño del bot; vale en todos los servidores y **no da ventajas en el casino**): `!premium dar @x <1-4> [días]` · `!premium quitar @x` · `!premium lista` · `!premium servidores @x <n>`.

| Nivel | Incluye |
|---|---|
| 💎 Tier 1 (Booster) | `!clearavatars`, `!clearnames`, `!tags` |
| 🌟 Tier 2 | Todo lo del 1 + `!cleartags` + `!mstats` parcial |
| 👑 Tier 3 | Todo lo del 2 + `!mstats` completo |
| 🔮 Tier 4 | Todo lo del 3 + `!ghostmode` + `!botperfil` |

- Las limpiezas piden confirmación con botones. Lo actual se vuelve a registrar como único punto de partida.
- `!mstats`: mirarte a vos mismo no cuenta, y la misma persona mirando lo mismo cuenta una vez cada 10 minutos.
- **`!names @usuario`** (gratis): historial de @usuario, nombre visible y apodos en el servidor. Los tags de servidor se registran solos (necesitan discord.js 14.21 o superior, que es lo que instala `npm install`).

## 7. Registros (`/setup`)

`/setup` crea la categoría **Registros** con estos canales:

| Canal | Qué registra |
|---|---|
| mensajes | enviados y editados |
| eliminados | incluye borrados masivos con transcripción |
| adjuntos | con respaldo de archivos de hasta 8 MB |
| baneos | baneos y desbaneos |
| expulsiones | expulsiones |
| entradas | entradas y salidas de miembros |
| apodos | cambios de apodo |
| roles | cambios de roles de miembros y del servidor |
| moderacion | aislamientos, silencios, movimientos en voz, limpiezas |
| voz | entradas, salidas y cambios de canal de voz |
| servidor | canales, permisos, invitaciones, webhooks, emojis, bots |
| sistema | avisos del propio bot |

Qué hace al ejecutarse:

- **Valida los permisos** del bot antes de tocar nada, y si falta alguno dice cuál.
- **Permisos de los canales:** @everyone no los ve. Los roles con Administrador o Gestionar servidor y el rol de staff opcional pueden leer pero no escribir. El bot tiene permiso explícito para escribir.
- **No duplica.** Guarda los IDs en la base de datos y, al repetirse, verifica y corrige:
  - un canal borrado se recrea;
  - un canal sacado de la categoría se devuelve;
  - un canal renombrado se conserva, porque se identifica por su ID;
  - si se perdió la base de datos, adopta los canales existentes de la categoría por nombre.
- **Actualiza:** además de reparar, deja cada canal con el nombre, la descripción, la categoría y los permisos de la versión actual del bot. Los reconoce aunque hayan cambiado emojis, mayúsculas o nombres de versiones anteriores (si alguien los renombró, vuelven al nombre oficial). Nunca los borra: se conserva el historial.
- **Sobrantes:** si quedaron canales o categorías de registros de instalaciones anteriores, `/setup` los lista y ofrece **🧹 Borrar sobrantes** (con confirmación). Solo toca canales de las categorías de registros que el bot no usa.
- **♻️ Reinstalar desde cero** (doble confirmación): borra los canales de registro del bot y los vuelve a crear. Se pierde su historial; normalmente no hace falta.
- Dos `/setup` simultáneos en el mismo servidor no se pisan: el segundo espera su turno.
- Si alguien borra un canal de registro, el bot lo olvida y avisa en #sistema.

## 8. Roles (`/roles`)

- **Grupos:** conjuntos de roles que los miembros eligen solos desde un panel publicado (modo **libre** o **único**). Se puede exigir un **nivel mínimo del casino**.
- **Distinciones:** roles automáticos al llegar a un **nivel del casino**. Se entregan al subir de nivel y al abrir `/perfil`. Nunca se quitan solas.
- **Seguridad:** se rechazan @everyone, los roles gestionados por integraciones, los roles por encima del bot y los que tienen permisos de moderación o administración.

## 9. Canales de voz temporales (`/voz`)

1. `/voz` → **Configurar / reparar**. Crea (o recupera, sin duplicar) la categoría **creator**, el canal de voz **Crear voice** y el canal de texto **interfaz** con el panel de botones (los nombres viejos se renombran solos al actualizar).
2. Al entrar a **Crear voice**, el bot crea tu canal (con tus ajustes guardados) y te mueve ahí. En el chat de ese canal publica el mismo panel.
3. Cuando el canal queda sin personas, se borra solo. Si el bot estuvo apagado, al volver borra los que quedaron vacíos.

**Interfaz** (canal de interfaz, chat de tu canal o `/canal`):

| ✏️ Nombre | 👥 Límite | 🔒 Privado | 👻 Ocultar | 🌍 Región |
|---|---|---|---|---|
| **✅ Permitir** | **➖ Quitar acceso** | **📨 Invitar** (con MD) | **👢 Expulsar** | **ℹ️ Info** |
| **🚫 Bloquear** | **♻️ Desbloquear** | **👑 Reclamar** | **🔁 Transferir** | **🗑️ Eliminar** |

- Nombre y límite se cambian con una ventana; privado y oculto alternan; región, permitir, invitar, expulsar, bloquear y transferir usan menús.
- Tus preferencias (nombre, límite, privado, oculto, región, permitidos y bloqueados) se guardan para tus próximos canales.
- **Reclamar:** si quien creó el canal se va, cualquiera que esté adentro puede tomarlo.
- **Staff:** quien tiene Administrador, Gestionar canales, Moderar miembros o Mover miembros puede manejar cualquier canal temporal y no puede ser expulsado ni bloqueado desde la interfaz.
- **Límites:** un canal por persona, 50 por servidor y 10 s entre creaciones. Discord solo deja renombrar un canal 2 veces cada 10 minutos: el bot avisa cuándo se puede de nuevo.
- **Nombre y límite por defecto:** `/voz` → **Nombre y límite** (`{usuario}` = nombre de quien lo crea).
- **Configurar / reparar también actualiza:** recupera la categoría, el canal para crear y la interfaz aunque se haya perdido la base, les pone el nombre y los permisos del bot de esta versión (sin borrar los permisos que agregó el staff) y deja **un solo panel** en la interfaz (borra los paneles viejos del bot). Las salas temporales huérfanas que quedaron vacías y los hubs o interfaces repetidos aparecen como sobrantes con **🧹 Borrar sobrantes**; las salas con gente nunca se tocan. **♻️ Reinstalar desde cero** recrea el hub y la interfaz.

## 10. Moderación (`/mod`, `/automod`)

- **Sanciones:** `/mod warn`, `/mod timeout usuario 10m`, `/mod untimeout`, `/mod kick`, `/mod ban` (también por ID, con opción de borrar mensajes recientes) y `/mod unban ID`. Por prefijo: `!warn @x motivo`, `!timeout @x 1h30m motivo`, `!kick`, `!ban`, `!unban`.
- **Casos:** cada sanción crea un caso numerado (#1, #2…) con motivo, moderador, duración y fecha. Se publica en el registro de **moderacion** y le llega un MD a la persona: en expulsiones y baneos, antes de aplicarlos.
- **Historial:** `/mod historial usuario` (por prefijo `!modlogs @x`) muestra advertencias activas, aislamientos, expulsiones y baneos, paginado. `/mod caso 12` abre un caso para **editar el motivo** o **anularlo**: un aislamiento vigente se levanta, y una advertencia anulada deja de contar.
- **Jerarquía:** nadie puede sancionar a alguien con un rol igual o más alto, ni al dueño ni al bot. Dos moderadores no pueden sancionar a la misma persona a la vez.
- **Permisos por roles** (`/automod` → Roles y exenciones):
  - **Moderador:** advertir, aislar e historial.
  - **Administrador:** además expulsar, banear y editar casos.
  - Quien tenga los permisos equivalentes de Discord también puede.
- **Escalado:** las advertencias vencen a los 30 días. Por defecto, 3 activas aíslan 60 minutos; también se puede expulsar o banear al llegar a N.
- **Automod** (no se aplica al staff, a los roles de moderación ni a roles o canales exentos):
  - **Antispam:** más de 6 mensajes en 5 s → borra la ráfaga y aísla 5 min.
  - **Antiflood:** mensajes repetidos, demasiadas menciones o paredes de texto → borra y avisa.
  - **Enlaces:** apagado, solo invitaciones a otros servidores (por defecto) o todos menos una lista blanca. También revisa mensajes editados.
  - **Infracciones:** 3 en 10 minutos se convierten en una advertencia.
- **Antiraid:** 10 entradas en 30 s activan el **modo raid** por 15 min. Según lo que elijas, avisa, aísla o expulsa las cuentas de menos de 7 días, con un resumen en el registro. Se activa o termina a mano desde `/automod`.
- Todos los valores se cambian en `/automod` con rangos seguros, y los cambios quedan en #sistema.

## 11. Tests

```bash
npm test
```

Son 204 tests sin Discord real. Cubren, entre otros:

- **invariantes de la economía:** suma de saldos = suma de transacciones, ningún saldo negativo, cada ronda con un único cierre, lo apostado y lo pagado de cada ronda igual a sus movimientos, y las estadísticas de cada persona iguales a la suma de sus rondas — verificado también con **1.500 rondas al azar** de los 10 juegos;
- `applyTx`: enteros seguros, signo según el tipo, fondos insuficientes sin cambios, idempotencia y `CHECK` de la base;
- **doble interacción y botones viejos** (versión de la ronda), partidas de otra persona, una sola partida abierta por juego (también desde dos servidores), espera entre rondas, validación de apuestas y juego cerrado;
- **devoluciones** (una sola vez, con apuestas extra), partidas abandonadas, Crash interrumpido por un reinicio y retiro tardío;
- RTP de cada juego: ruleta 36/37, tabla de Slots escalada, P(Crash ≥ x) = RTP/x, tablas de Plinko, valor esperado de cada escalón en Minas, Pollo, Globos y Dragon Tower, Hilo y una simulación de Blackjack;
- azar verificable (determinismo, rotación, hash, recálculo de rondas reales), tope de premio, jackpot, "repetir" una sola vez;
- torneos: creación automática idempotente, puntuación, entradas, cancelación con devolución, cierre que paga una sola vez y rondas mínimas;
- casamientos (una pareja por persona, propuestas cruzadas, vencimiento), boost tracker, anti-webhooks e idioma (todos los textos nuevos tienen inglés);
- `!work`: los 5 trabajos ordenados por sueldo, espera compartida, tope diario, desbloqueo por experiencia, multa del hacker sin saldo negativo, cuentas nuevas o suspendidas;
- bonos (racha, espera, rescate), actividad anti-farming (cortos, repetidos, ráfagas, espera, tope, rendimiento decreciente, cuentas nuevas, mismo mensaje), lluvias de monedas, rankings y ajustes;
- **todas las pantallas y paneles** contra los límites de Discord (embeds, filas, botones, `customId` y el máximo de 40 componentes en Components V2);
- sincronización de `/setup` y `/voz`: base perdida, nombres viejos, otra categoría repetida, sobrantes, huérfanos vacíos (y los que tienen gente o están fuera de la categoría no se tocan), versión del diseño;
- migraciones (una base vieja con granja sube sin perder datos), comandos sin nombres repetidos y slash válidos, `!steal`, besos, voz temporal, moderación, automod, historiales, premium, `/setup` y copias de seguridad.

## 12. Checklist de verificación en un servidor de prueba

- [ ] El bot arranca y registra los comandos (aparecen `/casino`, los 10 juegos, `/top`, `/torneo`, `/steal` y el menú **Apps → Robar emoji o sticker**).
- [ ] `!balance`: 1.000 Coins. `!daily` (100) dos veces: la segunda dice cuándo volver. `!weekly` (400).
- [ ] `!work`: lista de trabajos; elegir Pedidos Ya → cobra; elegir otro enseguida → "Estás cansado"; Verdulero, Informes y Hacker aparecen con 🔒.
- [ ] `!casino`: lobby con saldo, jackpot y torneos diario y semanal en curso. El menú muestra las reglas de cada juego.
- [ ] `!ruleta 100 rojo`, `!slots 100` y `!plinko 100 alto 16`: animación editando el mismo mensaje y resultado con saldo, nivel y logros. **🔁 Repetir** juega otra; tocarlo de nuevo en el mensaje viejo dice que ya se usó.
- [ ] `!crash 100`: el multiplicador sube; **Retirar** paga. `!crash 100 1.5x`: retira solo en 1,50x. Reiniciar el bot en pleno vuelo con retiro automático: al volver, el mensaje muestra el resultado.
- [ ] `!minas 100 3`: tablero 5×5; destapar, cobrar; con otra cuenta tocar el tablero → "es de otra persona".
- [ ] `!bj 100`: pedir, plantarse, doblar y dividir (con un par). Doble clic en **Pedir** no pide dos cartas.
- [ ] `!pollo`, `!globos`, `!hilo` y `!dragon experto`: avanzar y cobrar; dejar una partida abierta 30 min → se resuelve sola.
- [ ] `!minas 100` con una partida de minas abierta → ofrece **Retomar partida**.
- [ ] `!perfil`, `!top`, `!top 2`, `!top ganancias`, botón **Solo este servidor**, `!rank`, `!stats crash`, `!history minas`, `!logros`.
- [ ] `!fairness` → anotar el hash → jugar → `!fairness rotar` → la semilla revelada tiene ese SHA-256 → `!fairness verificar <ronda>` recalcula el resultado.
- [ ] Chatear con una cuenta de más de 7 días: `!balance` muestra Coins por actividad; mensajes cortos o repetidos no suman.
- [ ] `/ajustes`: elegir canal de anuncios y un canal de juegos; jugar en otro canal → indica dónde se juega.
- [ ] Dueño: `!casino config`, `!casino minbet slots 50`, `!casino disable crash` (→ "cerrado"), `!casino enable crash`, `!casino drop 100 3 5` (otra cuenta agarra), `!balance add @x 1000 premio`, `!casino audit` (✅ cuadra), `!casino log`.
- [ ] Dueño: `!torneo create Plinko Weekend juego=plinko metrica=multiplicador duracion=1h premios=5000,2500 rondas=2`, `!torneo start <id>`, jugar Plinko, `!torneo <id>`, `!torneo stop <id>` → se anuncia y paga una sola vez.
- [ ] Sin ser dueño: `!casino config` muestra el lobby y `!balance add` responde que solo el dueño puede.
- [ ] `!steal` respondiendo a un mensaje con 2 emojis de otro servidor → menú → se agregan. Un sticker Lottie → aviso claro.
- [ ] `/roles` → distinción de nivel 2 del casino → apostar hasta subir → el rol llega solo.
- [ ] `!kiss @alguien` → **Corresponder** desde la otra cuenta. `/voz` y un canal temporal. `/mod warn` y `!modlogs @x`.
- [ ] Clic muy rápido en un juego: hasta 20 acciones cada 10 s; más que eso → "Vas muy rápido".
