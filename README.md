# 🌾 El Valle — bot de Discord

Granja, pesca de un botón con rarezas, 12 cañas y carnada, logros con insignias y aviso por DM, puntos de actividad, potenciadores temporales, sorteos automáticos, mercado con demanda dinámica, roles interactivos y registros del servidor.
Todo se maneja con paneles (botones, menús y ventanas) dentro de un mismo mensaje, como una app.

Stack: Node.js 22+, TypeScript, discord.js 14, SQLite (better-sqlite3).

---

## 1. Crear la aplicación en Discord

1. Entrá a <https://discord.com/developers/applications> → **New Application**.
2. En **Bot** → **Reset Token** y copiá el token (va en `DISCORD_TOKEN`).
3. En **Bot → Privileged Gateway Intents** activá:
   - **Server Members Intent**: entradas y salidas, y distinciones.
   - **Message Content Intent**: comandos con prefijo y registro de mensajes.
4. (Opcional) En **General Information** está el **Application ID** (`CLIENT_ID`). No hace falta copiarlo: el bot lo saca del token.
5. Invitá al bot con **OAuth2 → URL Generator**:
   - Scopes: `bot` y `applications.commands`.
   - Permisos: Ver canales, Enviar mensajes, Insertar enlaces, Adjuntar archivos, Leer el historial de mensajes, Gestionar canales, Gestionar roles y Ver el registro de auditoría.
   - Ubicá el **rol del bot por encima** de los roles que va a entregar (paneles de roles y distinciones).

## 2. Instalación

```bash
npm install
cp .env.example .env              # completá DISCORD_TOKEN (CLIENT_ID es opcional)
npm run build
npm run deploy                    # registra los comandos de barra
npm start
```

Para desarrollo:

- Poné `DEV_GUILD_ID` en `.env`: los comandos aparecen al instante en ese servidor. Sin esa variable se registran globalmente y pueden tardar unos minutos.
- `npm run deploy:dev` registra los comandos y `npm run dev` recarga el bot al guardar cambios.

Variables de `.env`:

| Variable | Qué es |
|---|---|
| `DISCORD_TOKEN` | Token del bot |
| `CLIENT_ID` | Application ID (opcional: si falta, se deduce del token) |
| `DEV_GUILD_ID` | (opcional) servidor de pruebas para registrar comandos al instante |
| `DATABASE_PATH` | Archivo SQLite (por defecto `./data/valle.db`) |
| `GAME_CONFIG_PATH` | Ajustes globales del juego (por defecto `./game.config.json`) |
| `DEFAULT_PREFIX` | Prefijo inicial de cada servidor (por defecto `!`) |

## 3. Base de datos y migraciones

- **Motor de SQLite:** el bot usa `better-sqlite3` si funciona en tu PC. Si no (por ejemplo, con Node 24 en Windows sin binario compilado), usa automáticamente el SQLite que ya trae Node (22.13 o superior). No hace falta compilar nada, y el archivo de datos es el mismo con cualquiera de los dos.
- Las migraciones se aplican **solas al iniciar** y se pueden ejecutar varias veces sin romper nada. Cada una se registra en la tabla `schema_migrations`.
- **Copia de seguridad:** detené el bot y copiá los archivos `valle.db`, `valle.db-wal` y `valle.db-shm`.
- **Migración 2 (nueva pesca):** convierte la caña que tenía cada jugador en las cañas nuevas equivalentes (tier 1 → Sauce, 2 → Tejedora, 3 → Coral, 4 → Brújula, 5 → Abismo, con todas las anteriores incluidas). Los **carretes** y los **permisos de lugares de pesca** ya no existen, así que se **reintegra en monedas** lo pagado (queda registrado en el libro contable) y se devuelve el Mapa de corrientes a quien había abierto la Fosa. Inventario, peces, colección, niveles, XP, granja y monedas se conservan tal cual.
- **Migración 3 (logros, actividad y tienda):** agrega los puntos de actividad, las estadísticas de logros y la habilidad `actividad` en las distinciones (las ya configuradas se conservan). Reconstruye las estadísticas de los jugadores existentes a partir del registro de pesca, el libro contable y los sorteos ganados, para que los veteranos reciban los logros que ya tenían en su próxima acción (los avisos por DM salen de a 5). A quien ya tenía una caña superior le regala las cañas nuevas intermedias (Corcho, Boya roja, Marea azul, Sigilo).
- **Migración 6 (respuestas a besos):** crea `kiss_replies`: cada beso se puede corresponder o rechazar una sola vez.
- **Migración 5 (el lago):** crea `fishing_lakes`, con el lago de cada jugador. No toca datos existentes.
- **Migración 4 (comunidad):** crea las tablas del historial de avatares y banners (`user_media`) y de los besos (`kiss_pairs`, `kiss_stats`). No toca datos existentes.
- **Para actualizar:** reemplazá el código, corré `npm install && npm run build && npm run deploy` y reiniciá el bot. Las migraciones nuevas se aplican al arrancar.
- El bot está pensado para **un solo proceso**. Las protecciones contra carreras (transacciones SQLite y candados en memoria) asumen un único proceso. Para usar *sharding* con varios procesos, primero hay que pasar la base de datos a Postgres.

## 4. Configuración del juego

Hay dos niveles de configuración:

1. **Global**, con un archivo `game.config.json` (opcional). Mirá `game.config.example.json`. Pisa cualquier parte del contenido por defecto que está en `src/game/defaults.ts`: moneda, kit inicial, zonas, peces, equipo, precios y valores de `tuning`. Se valida al arrancar, y si hay un valor inválido el bot no inicia y dice cuál es.
2. **Por servidor**, con `/ajustes` (requiere *Gestionar servidor*). Ahí se cambian unos 50 valores numéricos dentro de rangos seguros: vigor, esperas, multiplicadores de XP y cosecha, cansancio, **pesca** (suerte, vigor por lance y por línea, esperas, líneas máximas, racha de la suerte, precio de la carnada), **eventos** (intervalo mínimo y máximo, duración del sorteo, ganadores, probabilidad de marea dorada, requisitos anti cuentas alternativas y tope de premios por día), curva de niveles, mercado y antispam. También se cambia el prefijo y se activa o desactiva el registro de mensajes enviados. Todo se guarda en la base de datos y sobrevive a los reinicios.

### Pesca, cañas, carnada, potenciadores y eventos

Todo esto vive en `src/game/defaults.ts` (`fishing`, `buffs`, `events`, `consumables`) y se puede cambiar desde `game.config.json`.

- **El lago (el juego de pesca):** el panel muestra 12 casillas de agua, cada una un botón. Tocás dónde tirar (o **🎣 Pescar** para una al azar) y después de cada tiro el lago cambia. Tipos de casilla (configurables en `fishing.tiles`): 🌊 agua (normal), 🫧 burbujas (+25 % suerte, +10 % XP), 🌿 algas (−10 % suerte, 35 % de abono), 🪨 roca (+10 % suerte y objetos perdidos) y 🌀 remolino (máx. 1 por lago: +80 % suerte y Ultralegendario ×2, pero cada línea tiene 35 % de cortarse). Las casillas se guardan en el servidor: un botón modificado no puede inventarse un remolino.
- **Sin freno anti spam:** la pesca no tiene espera, ni límite de clics, ni el aviso de "procesando". Cada tiro es una transacción de SQLite, así que aunque lleguen muchos clics seguidos, la carnada, el inventario y el saldo quedan exactos. Por defecto tampoco gasta vigor: la carnada es su único costo. Si algún día querés volver a frenarla, en `/ajustes` → **Pesca** se reactivan la espera (`Multiplicador de espera`, `Espera mínima`) y el vigor (`Vigor fijo por pesca`, `Vigor por línea`).
- **Tiros:** cada tiro lanza tantas **líneas** como permita la caña (más buffs). Cada línea gasta **1 carnada** (salvo ahorro) y hace **una tirada de rareza**. Si falta carnada, se tiran menos líneas; nunca se gasta lo que no hay.
- **Rarezas por línea (sin suerte):** Común 60 % · No común 26 % · Raro 10 % · Épico 3,2 % · Legendario 0,75 % · **Ultralegendario 0,05 % (1 cada 2.000)**. La suerte multiplica cada rareza por `1 + suerte × factor` (factores 0 / 0,5 / 1 / 1,5 / 2 / 2,5), con un tope de suerte de 0,8: el Ultralegendario llega como mucho a 1 cada 824 tiradas (1 cada 515 con la Caña del abismo).
- **Aguas:** los peces se desbloquean por nivel de pesca (1, 8, 20, 36, 58). Los nuevos valen más y pesan más en el sorteo, pero los viejos siguen apareciendo.
- **Carnada:** sale farmeando (0,3–0,6 por cosecha), se compra en el Mercado (el precio sube con el nivel de pesca) y se gana en eventos. Se vende a 1, así que comprarla nunca es negocio por sí sola.
- **Economía sin límite de clics:** cada tiro deja ganancia neta (el pez esperado vale más que la carnada), así que el ingreso depende de cuánto se pesque. Lo frena la demanda del mercado: vender mucho del mismo pez baja su precio hasta que se recupera. `npm run balance` muestra la ganancia por carnada en cada etapa.
- **Cañas** (`/mercado` → Cañas), 12 en total, cada una con su sprite en **pixel art** (32×32, con sus colores y su señuelo propio: pececito, rana, boya, cuchara, calamar o estrella):

  | Caña | Precio | Pesca nv. | Líneas | Suerte | Ahorro | Espera | Especial |
  |---|---|---|---|---|---|---|---|
  | Junco | gratis | 1 | 1 | 0 % | 0 % | 12 s | |
  | Corcho | 800 | 3 | 1 | 3 % | 8 % | 11 s | |
  | Sauce llorón | 2.000 | 5 | 2 | 3 % | 0 % | 13 s | |
  | Tejedora | 6.000 | 9 | 2 | 6 % | 12 % | 12 s | |
  | Boya roja | 15.000 | 14 | 2 | 9 % | 20 % | 11 s | ahorro |
  | Coral | 35.000 | 19 | 3 | 10 % | 8 % | 12 s | |
  | Marea azul | 70.000 | 25 | 3 | 14 % | 12 % | 11 s | |
  | Relámpago | 120.000 | 30 | 3 | 12 % | 10 % | 7 s | velocidad |
  | Sigilo del juncal | 220.000 | 37 | 4 | 18 % | 12 % | 11 s | |
  | Brújula de marea | 400.000 | 45 | 4 | 22 % | 15 % | 10 s | eco 4 % |
  | Abismo | 800.000 + Mapa | 55 | 5 | 26 % | 15 % | 11 s | ultra ×1,6 |
  | Astro hundido | 1.800.000 + Celacanto | 70 | 5 | 30 % | 20 % | 9 s | eco 6 % |

  Cada paso sube como mucho +1 línea y +8 % de suerte, y ningún precio salta más de ×3 respecto del anterior.
- **Potenciadores:** Carnada rendidora, Destello, Festín, Marea alta, Manos rápidas, Rebaja del mercado y Marea dorada (de servidor). Repetirlos **extiende la duración hasta un tope**, nunca apila la potencia. Los de tienda se encarecen con el nivel total y tienen límite diario de compra y de uso.
- **Racha de la suerte:** 120 tiradas seguidas sin Épico o superior garantizan un Épico.
- **Colecciones:** premio único al registrar todas las especies de una rareza (de 1.500 a 400.000).
- **Eventos (`/eventos`):** elegí el canal y activalos. Cada 100–140 min (al azar, configurable) sale un **sorteo** con botón *Participar* (5 min, de 1 a 3 ganadores elegidos solos) o, con un 15 %, una **Marea dorada** para todo el servidor. Premios: monedas (escalan con el nivel), carnada, potenciadores, rebaja del mercado, XP, abono, esencias o un Mapa de corrientes.
- **Anti abuso en eventos:** cuenta de Discord con 14+ días, 24+ h en el servidor, nivel total 3+, máximo 2 premios por persona por día, una entrada por persona (clave única), un solo sorteo abierto por servidor (índice único) y cierre idempotente: reinicios o ticks repetidos no duplican premios.

**Verificación matemática:** `npm run balance` calcula valores esperados **exactos** (no simulados). Resumen con el catálogo por defecto:

| Etapa | Caña | Monedas netas por vigor, pesca / granja | XP de pesca por hora |
|---|---|---|---|
| Nivel 1 | Junco | 3,2 / 3,7 (0,86×) | ~730 |
| Nivel 10 | Tejedora | 9,6 / 11,7 (0,82×) | ~2.350 |
| Nivel 20 | Coral | 29,2 / 40,4 (0,72×) | ~5.800 |
| Nivel 36 | Relámpago | 60,5 / 84,7 (0,71×) | ~5.800 |
| Nivel 45 | Brújula | 74,9 / 84,7 (0,88×) | ~14.000 |
| Nivel 58 | Abismo | 361 / 499 (0,72×) | ~31.000 |
| Nivel 80 | Astro | 384 / 602 (0,64×) | ~33.000 |

Pescar **nunca rinde más monedas que farmear**, así que no hay un bucle de dinero infinito; a cambio da unas 3 veces más XP y los objetos raros. Todo está limitado por el vigor. Pagar cada caña lleva entre ~3 y ~95 horas de pesca. Los 29 logros juntos pagan ~800.000 monedas una sola vez (unas 16 h de pesca de nivel alto).

### Tienda, venta, logros y actividad

- **Tienda unificada** (`src/services/shop.ts`): cada tipo de artículo (cañas, suministros, equipo, permisos, mejoras) es un *proveedor* con `listar` y `comprar`. El precio que se muestra y el que se cobra salen del mismo cálculo (rebajas incluidas), y toda compra pasa por el mismo camino. Para agregar un tipo de artículo nuevo alcanza con un proveedor nuevo.
- **Vender:** elegís un objeto y ves cuánto pagan por 1, la mitad o todo. La cantidad se resuelve contra el inventario real dentro de la transacción: un doble clic o un panel viejo nunca venden de más. La venta en lote no toca Épicos o mejores, carnada ni materiales de cañas.
- **Logros** (`achievements` en `defaults.ts`): 29 logros, cada uno con insignia propia en **pixel art** en `assets/badges/`. La forma y el metal indican el nivel (bronce → diamante), el color la categoría, y el ícono (dibujado a mano, 16×16) es único. Al desbloquear uno, el bot manda un **DM** con la insignia, la descripción, la recompensa y el progreso. Con los MD cerrados queda marcado y se ve en `/perfil` → **Logros**. Los errores temporales se reintentan hasta 3 veces, y un barrido cada minuto entrega lo pendiente (también tras un reinicio). Para agregar logros o cañas, editá `defaults.ts` (y el ícono o la paleta en `scripts/pixel-art.py`) y regenerá las imágenes con `python3 scripts/pixel-art.py` (instrucciones en el script).
- **Actividad:** pescar (2), farmear (2), vender (1), comprar (2), ganar un sorteo (5) y los logros suman puntos. Hay topes diarios: 120 por pesca, 120 por granja, 40 por comercio y 250 en total. Compras y ventas de menos de 50 monedas no suman. Todo se ajusta en `/ajustes` → **Actividad**.
- **Distinciones por actividad:** en `/roles` → Distinciones, usá la habilidad `actividad` y un umbral en puntos (por ejemplo `2000`). Se entregan solas después de cada acción. El ranking tiene la categoría 🔥 **Actividad**.

### Comandos de barra y permisos

- **Registro automático:** al arrancar, el bot compara sus comandos de barra con los últimos registrados y, si cambiaron, los registra solo. Ya no hace falta borrar `data\.comandos-registrados` ni correr `npm run deploy`. Sin `DEV_GUILD_ID`, se registran en **todos** los servidores donde está el bot.
- **Permisos del bot en cada canal:** Ver canal, Enviar mensajes, Insertar enlaces, Adjuntar archivos y Leer el historial. Si falta alguno, el bot ya no ignora el comando en silencio: avisa en el canal qué permiso falta o, si no puede escribir, te lo manda por DM.

### Premium (VIP)

Solo el **dueño del bot** puede darlo: el dueño de la aplicación en el portal de Discord (o los miembros de su equipo), más los IDs en `OWNER_IDS` del `.env`, separados por coma. Quien tiene premium ve **(VIP)** en su `/perfil`.

- `!premium dar @usuario <1-4> [días]` · `!premium quitar @usuario` · `!premium lista` · `!premium servidores @usuario <n>` (solo el dueño). El premium es **por persona**: lo das desde cualquier servidor y vale en todos los servidores donde esté el bot.
- `!premium` o `!premium @usuario` muestra el nivel y la tabla de niveles (cualquiera).

| Nivel | Incluye |
|---|---|
| 💎 Tier 1 (Booster) | `!clearavatars` (borra tu historial de avatares y banners), `!clearnames`, `!tags` (historial de tags de servidor) |
| 🌟 Tier 2 | Todo lo del 1 + `!cleartags` + `!mstats` parcial (cuántas personas miraron tus historiales) + `!autoplay` (cada 10 min el bot cosecha y pesca una vez por vos en ese servidor, usando tu vigor y tu carnada; se apaga solo si vence el premium) |
| 👑 Tier 3 | Todo lo del 2 + `!mstats` completo (las últimas 10 personas que miraron tus avatares, banners, nombres o tags) |
| 🔮 Tier 4 | Todo lo del 3 + `!ghostmode` (tus vistas a historiales ajenos no se registran y se borran las anteriores) + `!botperfil` (apodo, avatar y banner del bot en hasta 3 servidores donde tengas **Gestionar servidor**; el dueño puede cambiar la cantidad por persona con `!premium servidores`; cada servidor lo personaliza una sola persona) |

- Las limpiezas piden confirmación con botones. Lo actual se vuelve a registrar como único punto de partida.
- `!mstats`: mirarte a vos mismo no cuenta, y la misma persona mirando lo mismo cuenta una vez cada 10 minutos.
- **`!names @usuario`** (gratis): historial de @usuario, nombre visible y apodos en el servidor. Los tags de servidor se registran solos (necesitan discord.js 14.21 o superior, que es lo que instala `npm install`).
- **Migración 8:** tabla `autoplay` y cantidad de servidores de `!botperfil` por persona.
- **Migración 7:** tablas `premium`, `user_names`, `history_views` y `bot_profile_slots`. No toca datos existentes.

### Comunidad y moderación

- **`!kiss @usuario`:** "**A** se besa con **B**.", con un GIF de anime (apto para todo público, desde nekos.best o, si falla, waifu.pics) y el nombre del anime abajo. Botones **💘 Corresponder** (devuelve el beso y suma al contador) y **❌ Rechazar**: solo los puede usar quien recibió el beso, y una sola vez (queda guardado en la base). Lleva el contador **💋 Besos entre @A y @B** por servidor. La pareja se guarda en orden canónico, así que da igual quién lo mande, y el contador sube con un UPSERT atómico dentro de una transacción: sobrevive reinicios y no se duplica ni se pierde con comandos simultáneos. También muestra cuántos besos dio el autor y cuántos recibió el otro. Espera de 5 s por persona; no se puede besar a uno mismo ni a bots. Si la API de GIFs no responde, el beso cuenta igual.
- **`!avs @usuario` / `!banners @usuario`:** muestran un **collage** con todo el historial detectado (el más reciente arriba a la izquierda), un menú para ver cada imagen en grande con su fecha, y **📊 Mis estadísticas** (privado, para quien lo toca). El collage se arma en el bot con un codificador PNG propio, sin librerías nativas. El historial es **solo lo que el bot detectó** desde que existe esta función: cambios de avatar al escribir mensajes, al entrar al servidor o cuando Discord avisa (intent *Server Members*), y banners cuando alguien usa el comando (Discord solo manda el banner si se pide explícitamente). Se guarda el ID del usuario, el hash de la imagen, su URL y las fechas. Las imágenes viejas pueden dejar de estar disponibles en la CDN de Discord con el tiempo.
- **`!m @usuario 1000`:** borra en el canal actual hasta 1000 mensajes recientes de esa persona (también `/purgar`). Requiere **Gestionar mensajes** en ese canal; no permite limpiar a alguien con un rol igual o superior al tuyo (salvo el dueño). Revisa el historial de a 100 mensajes (hasta 10.000) y borra en bloques de hasta 100. Discord **no permite borrar en bloque mensajes de más de 14 días**: el comando se detiene ahí y lo informa. Nunca borra mensajes fijados. Una sola limpieza a la vez por canal. Queda registrado en el canal de logs.
- **Permisos del bot:** para `!m`, el rol del bot necesita **Gestionar mensajes** y **Leer el historial de mensajes** en el canal.

## 5. Comandos

| Slash | Prefijo | Quién | Qué hace |
|---|---|---|---|
| `/granja` | `!granja` `!g` | todos | Panel de la granja |
| `/pesca` | `!pesca` `!p` | todos | Panel de pesca: un botón **🎣 Pescar** |
| `/mercado [seccion]` | `!mercado` `!tienda` `!shop` | todos | Equipo, suministros, permisos, mejoras, vender |
| `/inventario` | `!inv` | todos | Mochila con filtros |
| `/perfil [usuario]` | `!perfil [@usuario]` | todos | Niveles, equipo, colección, distinciones |
| `/eventos` | `!eventos` | Gestionar servidor | Sorteos automáticos: canal, activar/desactivar, lanzar uno ahora |
| `/kiss usuario` | `!kiss` `!beso` | todos | Beso con GIF de anime y botones **Corresponder** / **Rechazar**; cuenta los besos de la pareja y los que diste |
| `/avatares [usuario]` | `!avs` `!avatars` | todos | Collage con el historial de avatares detectados, menú para ver cada uno y **Mis estadísticas** |
| `/banners [usuario]` | `!banners` `!bns` | todos | Banner actual e historial de banners detectados por el bot |
| `/purgar usuario cantidad` | `!m @usuario 1000` · `!c` | Gestionar mensajes | Borra hasta 1000 mensajes recientes de esa persona en el canal (con aviso "Buscando mensajes…") |
| `/top [categoria]` | `!top` | todos | Ranking del servidor (nivel total, granja, pesca, fortuna, colección) |
| `/jugar` | `!jugar` | todos | Abre El Valle como juego (granja, pesca y top) |
| `/ayuda` | `!ayuda` | todos | Guía por temas |
| `/prefijo [nuevo]` | `!prefijo [nuevo]` | ver: todos · cambiar: Gestionar servidor | Prefijo por servidor |
| `/ajustes` | `!ajustes` | Gestionar servidor | Valores del juego y prefijo |
| `/roles` | `!roles` | Gestionar roles | Grupos de roles y distinciones |
| `/setup [rol_staff] [registrar_mensajes]` | `!setup [@rol] [si/no]` | Administrador | Crea o repara los registros |

Mencionar al bot funciona igual que el prefijo (`@El Valle granja`).

## 6. Registros (`/setup`)

`/setup` crea la categoría **📋 Registros** con estos canales:

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
- Dos `/setup` simultáneos en el mismo servidor no se pisan: el segundo espera su turno.
- Si alguien borra un canal de registro, el bot lo olvida y avisa en #sistema.

## 7. Roles (`/roles`)

- **Grupos:** conjuntos de roles que los miembros eligen solos. Se publican en un canal como un mensaje con un botón, que abre un selector privado con los roles actuales de cada miembro ya marcados.
  - Modo **libre**: se pueden elegir varios roles.
  - Modo **único**: se puede tener uno solo.
  - Se puede exigir un **nivel total mínimo** del juego.
- **Distinciones:** roles automáticos por nivel de granja, de pesca o total. Se entregan al subir de nivel y al abrir `/perfil`. Nunca se quitan solas.
- **Seguridad:** se rechazan @everyone, los roles gestionados por integraciones, los roles por encima del bot y los que tienen permisos de moderación o administración.

## 8. El Valle como juego (Actividad dentro de Discord)

Además de los paneles con botones, El Valle se puede jugar como una **Actividad**: un juego visual que se abre dentro de Discord y tiene tres secciones.

- **🌾 Granja:** un campo animado donde las plantas crecen mientras corre la espera, y el botón Farmear. Incluye zonas con sus requisitos, granero, objetos (mate y abono) y equipo.
- **🎣 Pesca:** un lago animado con un solo botón **Pescar**. Muestra carnada, vigor, racha de la suerte, potenciadores activos y las capturas de cada lance. Pestañas: **Suerte** (probabilidad de cada rareza con tu suerte actual), **Cañas** (equipar las tuyas) y **Colección** (especies descubiertas y premios por rareza).
- **🏆 Top:** el ranking del servidor por nivel total, granja, pesca, fortuna y colección, con podio y tu posición. Muestra también las **distinciones** (roles por nivel), con tu progreso hacia la próxima.

Todo usa **la misma base de datos y las mismas reglas** que el bot:

- Las esperas, el vigor, el antispam y el candado por usuario son compartidos entre la Actividad y los botones.
- El servidor decide todos los resultados. Durante la pelea nunca se envía qué pez es: solo el tamaño de su sombra.
- Al subir de nivel en la Actividad se entregan los roles de distinción.

Cómo se abre:

- Con `/jugar`, que la abre directamente.
- Desde un canal de voz: tocá el ícono del cohete (**Actividades**) y elegí la app.
- Desde el perfil de la app, con el botón **Iniciar**, que aparece cuando las Actividades están habilitadas.

### Configuración (una sola vez)

1. **Client Secret:** en el Developer Portal, andá a **OAuth2** → **Reset Secret** y copialo en `.env`:
   ```
   CLIENT_SECRET=tu_client_secret
   ACTIVITY_PORT=3000
   ```
2. **Redirect:** en **OAuth2 → Redirects**, agregá `https://127.0.0.1`. Discord pide al menos uno, aunque la Actividad no lo use.
3. **Túnel HTTPS:** Discord solo carga Actividades por HTTPS público. Desde tu PC podés usar Cloudflare Tunnel:
   ```powershell
   winget install --id Cloudflare.cloudflared
   cloudflared tunnel --url http://localhost:3000
   ```
   Copiá la dirección que muestra, por ejemplo `https://algo-raro.trycloudflare.com`.
4. **URL Mapping:** en **Activities → URL Mappings**, poné `/` en *Prefix* y `algo-raro.trycloudflare.com` en *Target*, sin `https://`.
5. **Activar:** en **Activities → Settings**, activá **Enable Activities**. Discord crea solo un comando de lanzamiento, y `npm run deploy` lo conserva.
6. **Instalación:** en **Installation**, dejá habilitado *Guild Install*.
7. **Compilar y arrancar:**
   ```powershell
   npm install
   npm run build          # compila el bot y la Actividad
   npm run deploy
   npm start
   ```
   En la consola tiene que aparecer `Actividad de granja escuchando en http://localhost:3000`.

Para abrirla, usá `/jugar` o entrá a un canal de voz → **Actividades** (el ícono del cohete) → tu app.

**Si al tocar la app solo ves su tarjeta de perfil (nombre, etiquetas, un link) y no hay botón "Iniciar", las Actividades no están habilitadas.** Revisá los pasos 4 a 6: primero tiene que existir el URL Mapping y después hay que activar *Enable Activities*. Después de activarlas, cerrá y volvé a abrir Discord (Ctrl + R).

**Importante:** el túnel rápido de Cloudflare cambia de dirección cada vez que lo reiniciás, y en ese caso tenés que actualizar el URL Mapping. Para tener una dirección fija, creá un túnel con nombre en tu cuenta de Cloudflare (gratis) o hosteá el bot en un servidor con dominio propio.

Si usás pm2, podés dejar corriendo el bot y el túnel:

```powershell
pm2 start dist/index.js --name valle
pm2 start cloudflared --interpreter none --name tunel -- tunnel --url http://localhost:3000
pm2 logs tunel     # para ver la dirección del túnel
```

### Seguridad de la Actividad

- El inicio de sesión usa OAuth2 de Discord. El servidor verifica la cuenta con Discord y entrega un token de sesión propio, que vence a las 12 horas.
- En cada acción se verifica con el bot que el usuario sea miembro del servidor. Mandar un ID de servidor ajeno da error 403.
- Hay límite de tamaño y de formato en cada solicitud, antispam compartido con el bot y protección contra leer archivos fuera de la carpeta pública.
- Si `CLIENT_SECRET` está vacío, la Actividad no se inicia y el bot funciona igual que siempre.

## 9. Tests

```bash
npm test
```

Son 133 tests sobre la lógica sin Discord (juego, pesca, tienda, venta, logros, actividad, eventos, migraciones y API de la Actividad). Cubren:

- migraciones repetidas;
- persistencia del prefijo y los ajustes tras reiniciar;
- doble clic en granja, compras y pesca;
- saldo nunca negativo y nivel máximo;
- el lago: la casilla sale del servidor, índices inválidos, sin carnada no cambia nada, un solo remolino por lago y su tasa de corte; 30 clics seguidos cuadran exacto con la carnada; la espera y el vigor funcionan si se reactivan;
- pesca: sin carnada o poca carnada, racha de la suerte, colecciones pagadas una sola vez y distribución real de rarezas;
- potenciadores que vencen, se extienden hasta un tope y no apilan potencia; rebaja aplicada al cobro;
- eventos duplicados, cierres repetidos, reinicios a mitad de sorteo, tope diario de victorias y eventos huérfanos;
- la migración de datos de la pesca anterior (conversión de cañas y reintegros) y la migración 3 (estadísticas reconstruidas, distinciones por actividad);
- tienda: precio mostrado = cobrado (también con rebaja), doble clic, ids manipulados, cantidades y límites diarios;
- venta: mitad y todo, doble "vender todo", panel desactualizado, más de 9.999 unidades, protecciones de la venta en lote y persistencia en el libro contable;
- logros pagados una sola vez; avisos por DM sin duplicados, MD cerrados, reintentos y recuperación tras un reinicio; insignias e imágenes presentes;
- actividad con topes diarios contra el spam, distinciones por puntos y ranking de actividad;
- besos: el primero muestra 1, el contador es el mismo sin importar quién besa, sobrevive a un reinicio, no pierde ni duplica con 50 besos seguidos y respeta la espera;
- historial de avatares y banners sin duplicados, sin historial inventado y con URLs correctas (GIF si es animado);
- `!m` contra un canal simulado con las reglas de la API: solo el usuario indicado, tope de 1000, bloques de 100, corte a los 14 días, fijados y el propio comando intactos;
- saturación del mercado y límites diarios;
- aislamiento entre servidores;
- el planificador de `/setup` (servidor limpio, repetido, canal borrado, movido o renombrado, base de datos perdida);
- el antispam y la matemática de balance (probabilidades, rendimiento pesca/granja, precios crecientes de las cañas).

## 10. Checklist de verificación en un servidor de prueba

- [ ] `npm run deploy` y los 17 comandos aparecen (incluye `/eventos`, `/kiss`, `/avatares`, `/banners` y `/purgar`).
- [ ] `/pesca`: aparece el lago con 12 casillas; tocar varias casillas seguidas pesca cada vez, sin esperas ni avisos de "procesando", y el lago cambia después de cada tiro.
- [ ] `/granja` → **Farmear**: suben la XP y la cosecha, baja el vigor. Un doble clic rápido no cosecha dos veces.
- [ ] Otra persona toca tu panel y recibe "Este panel es de otra persona".
- [ ] `/pesca` → **🎣 Pescar**: baja la carnada, aparece la captura con su rareza y el pez está en `/inventario`.
- [ ] Clic muy rápido dos veces en **Pescar**: la segunda dice cuándo estará disponible.
- [ ] `/mercado` → **Cañas**: elegir la Caña de corcho, ver su imagen y la comparación, comprarla y recibir el DM del logro **Buena madera**.
- [ ] `/mercado` → **Vender**: elegir un pez → **Vender 1**, **Mitad** y **Todo**. El saldo cambia en el pie del panel; tocar dos veces rápido **Todo** no vende dos veces.
- [ ] Con los MD cerrados, desbloquear un logro: no llega el DM, y `/perfil` → **Logros** muestra el aviso 📭.
- [ ] `/roles` → Distinciones: agregar una con habilidad `actividad` y `50` puntos; pescar/farmear hasta pasarlos y verificar que el rol llega solo.
- [ ] `/top` → categoría 🔥 Actividad.
- [ ] `!premium dar @alguien 4` (con tu cuenta de dueño) → `/perfil` de esa persona muestra **(VIP)**; con otra cuenta, `!premium dar` responde que solo el dueño puede.
- [ ] `!names @alguien`, `!tags @alguien` (Tier 1), `!mstats` (Tier 2/3), `!autoplay on` (Tier 2: a los pocos minutos `!autoplay` muestra el primer turno), `!ghostmode` y `!botperfil nombre Prueba` (Tier 4).
- [ ] `/pesca`: el botón **+10 carnada** compra sin salir del HUD; **Cañas** y **Cebos** abren el Mercado, y **Pesca** vuelve.
- [ ] `!kiss @alguien` muestra 1; que la otra persona responda con `!kiss` y muestre 2.
- [ ] `!avs @alguien` y `!banners @alguien` muestran la imagen actual; si cambia el avatar y escribe un mensaje, aparece en el historial.
- [ ] `!m @alguien 5` en un canal de pruebas: borra 5 de sus mensajes y el aviso se borra solo a los 8 s.
- [ ] `/mercado` → **Suministros**: comprar un Señuelo brillante, usarlo desde la granja y ver **Destello** en `/pesca`.
- [ ] `/eventos`: elegir canal → **Lanzar uno ahora** → **Participar** con otra cuenta → a los 5 min se anuncian los ganadores.
- [ ] Durante una pelea, reiniciar el bot y tocar un botón: la pelea continúa (o expira si pasó el tiempo).
- [ ] `/mercado`: comprar equipo sin plata o sin nivel da error claro. Vender mucho de lo mismo baja el precio (📉).
- [ ] `/prefijo ?` → `?granja` funciona. Reiniciar el bot y el prefijo sigue siendo `?`.
- [ ] `/ajustes` → cambiar "Espera entre cosechas" y ver el cambio al instante. Queda registrado en #sistema.
- [ ] `/setup` con el bot sin "Gestionar canales": dice qué permiso falta y no crea nada.
- [ ] `/setup` dos veces seguidas: la segunda no crea canales nuevos.
- [ ] Borrar #eliminados y mover #baneos fuera de la categoría → `/setup` recrea uno y devuelve el otro.
- [ ] Una cuenta sin permisos no ve la categoría 📋 Registros. Un admin sí, pero no puede escribir.
- [ ] Editar y borrar un mensaje, cambiar un apodo, dar un rol, aislar a alguien: cada cosa aparece en su canal.
- [ ] `/roles` → crear un grupo, agregar roles e intentar agregar un rol con permisos de admin (debe rechazarlo). Publicarlo y elegir roles desde otra cuenta.
- [ ] Configurar una distinción de nivel total 2 y subir de nivel: el rol se asigna solo.
- [ ] Nivel máximo: `/ajustes` → Nivel máximo = 10, farmear hasta llegar. Muestra 👑 y no acumula XP.
- [ ] Hacer clic muy rápido y muchas veces: aparece "Vas muy rápido" y, si se insiste, un aviso en #sistema.
- [ ] Actividad: abrirla desde un canal de voz, autorizar y cosechar. El panel `/granja` del bot muestra la misma cosecha.
- [ ] Actividad: con la espera activa, el botón muestra "Creciendo…" y las plantas crecen hasta estar listas.
- [ ] Actividad: tocar Farmear en el panel del bot y en la Actividad casi a la vez. Solo una cosecha cuenta.
- [ ] Actividad: elegir una zona bloqueada muestra los requisitos que faltan. Una desbloqueada se puede seleccionar.
- [ ] Reiniciar el túnel: actualizar el URL Mapping y confirmar que la Actividad vuelve a abrir.
- [ ] `/jugar` abre el juego. Pestaña **Pesca**: **Pescar**, ver las capturas y revisar las pestañas Suerte, Cañas y Colección.
- [ ] Pestaña **Top**: aparecés en el ranking y cambiar de categoría actualiza el podio. Las distinciones muestran tu progreso.
- [ ] `/top` en el chat muestra el mismo ranking y el menú cambia de categoría.
