# Auditoría y rediseño de El Valle

Revisión completa del bot (≈15.000 líneas: `src/`, `activity/`, `test/`, scripts y lanzadores) antes de tocar nada, y lista de lo que se cambió. Cada problema tiene su impacto, dónde estaba y cómo quedó resuelto. Lo que no se cambió está al final, con el motivo.

## Resumen

| | Antes | Ahora |
|---|---|---|
| Compila | ❌ `tsc` fallaba: `iniciar.bat` no arrancaba | ✅ |
| Tests | 155 | 207 (todos pasan) |
| Besos | La respuesta editaba el mensaje original | Mensaje nuevo en respuesta, GIF distinto, botones desactivados, estado en la base |
| Canales temporales | No existían | Sistema completo con interfaz de 15 botones, menús y ventanas |
| Moderación | Solo `!m` (borrar mensajes) y registros | Casos, advertencias con escalado, aislar, expulsar, banear, historial, roles, automod y antiraid |
| Seguridad | Crash remoto en la Actividad | Corregido, con test |
| Datos | Sin copias de seguridad | Copia diaria, se guardan 7 |

## 1. Problemas encontrados

### 🔴 Crítico

**1. El bot no compilaba.**
`src/discord/handlers/components.ts:667` y `:681` llamaban a `i.update()` sobre `Ix`, que también incluye `ModalSubmitInteraction` (no tiene `update`). Es el error de la captura (TS2339), y por eso `iniciar.bat` se cortaba en "Compilando".
*Arreglo:* guarda `i.isMessageComponent()` en `premiumHandler`. Además ese handler llamaba a `fetchAndRecord` (un pedido a la API de Discord) antes de responder; ahora difiere primero (`deferUpdate`).

**2. Cualquiera podía tirar abajo el bot desde internet.**
El servidor de la Actividad (`src/activity/server.ts`) hacía `decodeURIComponent(route)` sin `try/catch` dentro del manejador HTTP. Una petición como `GET /%E0%A4%A` a la URL del túnel lanzaba un `URIError` no capturado y terminaba el proceso: el bot entero se desconectaba. Lo reproduje antes de corregirlo.
*Arreglo:* decodificación segura (400), rechazo de bytes nulos, `try/catch` alrededor de la parte estática, error en el stream de archivos y test de regresión (`test/activity.test.ts`).

### 🟠 Alto

**3. Botones que podían fallar con "La interacción falló".**
Discord da 3 s para responder. Varios handlers hablaban con la API antes de responder: cambiar roles en un panel público (`rolesPublicHandler`), publicar un panel de roles, lanzar un evento desde `/eventos` y las limpiezas premium. Con la cola de la API cargada, el usuario veía un error y volvía a tocar (acción doble).
*Arreglo:* `deferPanel()` antes de esas operaciones. `update()` edita la respuesta diferida.

**4. Besos: la experiencia no era la pedida y el contador se podía inflar.**
- "Corresponder" editaba el mensaje original en lugar de crear uno nuevo en respuesta.
- El botón llevaba el autor y el destinatario en el `customId`.
- Solo había una espera de 5 s por persona: dos amigos podían inflar el contador mandándose besos.
- Corresponder usaba la misma espera que un beso nuevo, así que fallaba con un mensaje confuso si la persona acababa de besar a otra.

*Arreglo:* rediseño completo (ver sección 3).

**5. No había moderación.** Solo `!m` (borrar mensajes) y los registros de auditoría. No había advertencias, casos, aislamientos, expulsiones ni baneos con historial, automod ni detección de raids. Implementado (sección 5).

**6. El lanzador no instalaba dependencias nuevas.**
`iniciar.bat` solo corría `npm install` si no existía `node_modules`. Una actualización que agregara una dependencia rompía el arranque.
*Arreglo:* corre `npm install` siempre; cuando no hay nada nuevo tarda segundos.

**7. Sin copias de seguridad.** Todo el progreso de los jugadores vive en un archivo SQLite.
*Arreglo:* `src/db/backup.ts` hace una copia diaria con `VACUUM INTO` (consistente aunque el bot esté escribiendo; funciona con los dos motores de SQLite) en `data/backups/` y guarda las últimas 7.

### 🟡 Medio

| # | Problema | Dónde | Arreglo |
|---|---|---|---|
| 8 | `!botperfil` descargaba cualquier URL `https` desde la PC del bot (se podía usar para pedir cosas a la red interna) | `commands/premium.ts` | Solo la CDN de Discord, sin redirecciones |
| 9 | `/api/token` sin límite (se podía martillar la API OAuth de Discord a través del bot) y `fetch` sin tope de tiempo (pedidos colgados) | `activity/server.ts` | 10 intentos por minuto por IP y tope de 10 s |
| 10 | Listeners de registros sin `try/catch` (entradas, salidas, voz, canal y rol borrados) | `logging/events.ts` | `try/catch` en todos, y `uncaughtException` registrado |
| 11 | Respaldo de adjuntos: hasta 10 × 8 MB = 80 MB por mensaje, más que el límite de subida, así que fallaba siempre | `logging/events.ts` | Tope de 9 MB por mensaje; el resto va como enlace |
| 12 | `ACTIVITY_PORT` inválido daba `NaN` y fallaba al escuchar | `env.ts` | Valida y usa 3000 |
| 13 | Error después de una respuesta diferida: el "pensando…" quedaba colgado | `handlers/interactions.ts` | Se borra y el error va en privado |
| 14 | `permissionOverwrites.edit(id)` lanza si la persona no está en caché | (código nuevo) | `type` explícito en cada edición |

### 🟢 Bajo / deuda técnica (sin cambios, con motivo)

- **Tablas que crecen sin límite** (`history_views`, `user_media`, `user_names`, `ledger`, `mod_cases`). Con SQLite y la escala de un servidor comunitario no es un problema. Si el bot crece, conviene una retención (por ejemplo, vistas de más de 90 días).
- **Un solo proceso.** Los candados (`KeyedLock`), el antispam y los detectores del automod viven en memoria. Ya estaba documentado. Para *sharding* hacen falta Postgres y Redis.
- **`components.ts` era muy grande** (700 líneas). Los módulos nuevos están en archivos propios (`handlers/voice.ts`, `handlers/moderation.ts`, `handlers/util.ts`). Falta separar igual granja, pesca y mercado; no lo hice para no tocar lógica que funciona y está testeada.
- **La pesca no tiene límite de clics** (decisión de diseño documentada en el README): cada tiro es una transacción y la economía cuadra, pero un autoclicker genera carga.
- **`/mod` no tiene `default_member_permissions`** a propósito: si lo tuviera, los roles de moderación configurados en el bot no lo verían. Aparece en la lista para todos y el bot valida cada uso. Es un solo comando con subcomandos, así que suma una sola entrada a la lista.
- **Registros con `console`**: no hay niveles por entorno ni rotación de archivos (pm2 o el servicio se encargan).

## 2. Arquitectura

```
src/
├─ db/            migraciones versionadas, motor SQLite (better-sqlite3 o node:sqlite), copias
├─ services/      reglas y datos, SIN discord.js → se prueban con una base en memoria
│  ├─ social.ts        besos (contadores, estado de cada beso, estadísticas)
│  ├─ tempVoice.ts     canales temporales (config, dueños, preferencias, listas, validaciones)
│  ├─ moderation.ts    casos, duraciones, roles de moderación, config del automod, escalado
│  └─ automod.ts       detectores puros (enlaces, ráfagas, repetidos, raids)
└─ discord/       adaptadores a Discord
   ├─ commands/        definición de comandos (slash + prefijo con el mismo código)
   ├─ handlers/        botones, menús y ventanas, ruteados por customId
   ├─ ui/              embeds y paneles (sin efectos)
   ├─ voice/           motor de canales temporales (eventos de voz, creación, barrido)
   └─ moderation/      acciones (warn/timeout/kick/ban) y automod en vivo
```

**Principios:**
- **Las reglas viven en `services/` y Discord es un adaptador.** Todo lo que decide (quién puede, cuánto suma, qué está permitido) se prueba sin Discord.
- **La base de datos es la verdad.** Lo importante (besos respondidos, dueños de canales, casos) se cambia con `UPDATE … WHERE estado = esperado` o con índices únicos dentro de transacciones. Un doble clic, dos procesos o un reinicio no duplican nada.
- **Cada botón se vuelve a validar.** El `customId` (`g:<módulo>:<acción>:<dueño>:<args>`) solo identifica. El servidor verifica permisos, pertenencia y estado en cada interacción.
- **Nunca se pasan los 3 s de Discord.** Lo que habla con la API se difiere antes, y los cambios que Discord puede demorar (renombres) tienen un tope de tiempo con aviso.

## 3. Sistema de besos

```
salo besa a h.                         ← nombres en negrita
-# salo y h se han besado 9 veces.     ← texto chico (subtexto de Discord)
[GIF]
Anime: Toradora!                       ← pie del embed
[💋 Corresponder] [💔 Rechazar]
```

- **Corresponder** (solo quien recibió el beso):
  1. En una transacción, el beso pasa de `open` a `returned` con un UPDATE condicional y se suma el beso de vuelta. Si dos clics llegan juntos, solo uno cambia la fila.
  2. Se desactivan los botones del original al instante: `💞 Correspondido` y `💔 Rechazar`, los dos grises.
  3. Se busca un GIF **distinto** al original (nekos.best trae 8 y se descarta el usado).
  4. Mensaje nuevo **en respuesta** al original: `¡h besa a salo de vuelta!` + `-# h y salo se han besado 10 veces.` + GIF + anime. Si el bot no puede escribir en el canal, usa el seguimiento de la interacción, que no necesita permisos.
- **Rechazar:** el original pasa a gris con `-# 💔 h rechazó el beso.` y los botones quedan desactivados. No resta del contador.
- **Anti abuso:** 5 s entre besos de una persona y 15 s entre besos de la misma pareja (en cualquier sentido). Corresponder no tiene espera (es una respuesta única por beso). No se puede besar a uno mismo ni a bots.
- **Si la API de GIFs falla,** el beso cuenta igual y el pie lo dice.
- **Botones viejos** (de antes de esta versión) siguen funcionando con la marca por mensaje.
- **Estadísticas persistentes por pareja** (`kiss_pairs`) y por persona (`kiss_stats`). `/besos [usuario]` muestra dados, recibidos, pendientes y el top 5 de parejas.

## 4. Canales de voz temporales

**Instalación:** `/voz` → **Configurar / reparar**. Crea o recupera, sin duplicar, la categoría **🔊 Canales temporales**, el canal **➕ Crear canal** (sin voz ni video) y **🎛️・interfaz** (solo lectura) con el panel.

**Uso:** al entrar a ➕ Crear canal, el bot crea tu canal con tus preferencias guardadas y te mueve. En el chat del canal publica el panel. Cuando queda sin personas, lo borra.

**Interfaz** (en el canal de interfaz, en el chat de tu canal o con `/canal`). Botones de solo ícono, como en tu captura, con leyenda:

| | | | | |
|---|---|---|---|---|
| ✏️ Nombre (ventana) | 👥 Límite (ventana) | 🔒 Privado (alterna) | 👻 Ocultar (alterna) | 🌍 Región (menú) |
| ✅ Permitir (menú de usuarios) | ➖ Quitar acceso (menú) | 📨 Invitar (menú + MD con botón) | 👢 Expulsar (menú de los que están adentro) | ℹ️ Info |
| 🚫 Bloquear (menú) | ♻️ Desbloquear (menú) | 👑 Reclamar | 🔁 Transferir (menú) | 🗑️ Eliminar (con confirmación) |

**Reglas y casos límite:**
- **Un dueño, un canal** (índice único). Si ya tenés uno y entrás al hub, te lleva al tuyo.
- **Carreras:** candado por persona al crear, 10 s entre creaciones, y si el dueño sale del hub antes de que el canal esté listo, el canal se borra. Si dos creaciones casi simultáneas pasan igual, el índice único rechaza la segunda y se borra el canal sobrante.
- **Tope de 50 canales temporales por servidor.**
- **Renombres:** Discord permite 2 cada 10 minutos. El bot lleva la cuenta y avisa cuándo se puede de nuevo, en lugar de dejar el botón "pensando" hasta 10 minutos. Todos los cambios tienen un tope de 8 s con aviso.
- **Permisos:** el dueño nunca recibe permisos de gestión: todo pasa por el bot, que valida cada acción. El bot solo otorga los permisos que tiene. Los permisos de la categoría se heredan.
- **Staff protegido:** quien tiene Administrador, Gestionar canales, Moderar miembros o Mover miembros no puede ser expulsado ni bloqueado desde la interfaz, y puede manejar cualquier canal temporal.
- **Reclamar:** solo si el dueño no está adentro y vos sí. Es condicional sobre el dueño anterior: si dos personas reclaman a la vez, gana una.
- **Ocultar** da acceso explícito a quienes ya están adentro, para que Discord no los desconecte.
- **Preferencias** (nombre, límite, privado, oculto, región, permitidos y bloqueados) se guardan solo cuando actúa el dueño. Un moderador que cambia un canal ajeno no pisa los ajustes de esa persona.
- **Reinicios:** al arrancar y cada 2 minutos, el bot olvida canales que ya no existen y borra los que quedaron vacíos mientras estaba apagado.
- **Si alguien borra** el hub, la interfaz o la categoría, el bot lo detecta, se desactiva y avisa en #sistema.

## 5. Moderación

**Comandos:**
- Slash: `/mod warn | timeout | untimeout | kick | ban | unban | historial | caso`. Es un solo comando, así que la lista de comandos no se llena.
- Prefijo: `!warn`, `!timeout @x 10m motivo` (`!mute`, `!aislar`), `!untimeout`, `!kick`, `!ban`, `!unban ID`, `!historial @x`, `!caso 12`.

**Casos:** cada sanción es un caso numerado por servidor (#1, #2…). El número sale de `MAX()+1` en una transacción con índice único, así que nunca se repite. El caso guarda motivo, moderador (o 🤖 Automod), duración y fecha, y se publica en #moderacion. `/mod caso N` permite editar el motivo (también en el registro) o anular el caso:
- un aislamiento vigente se levanta;
- una advertencia deja de contar;
- un baneo sigue vigente (para levantarlo, `/mod unban`).

**MD a quien recibe la sanción:** servidor, motivo, duración y número de caso. En expulsiones y baneos se manda antes de aplicarlos, porque después Discord no lo entrega.

**Jerarquía:** nunca a uno mismo, al dueño ni al bot. El moderador y el bot tienen que estar por encima del objetivo. No se puede aislar a un administrador. Hay un candado por objetivo: dos moderadores no lo sancionan dos veces a la vez.

**Permisos por roles** (`/automod` → Roles):

| Nivel | Puede | También lo puede quien tiene en Discord |
|---|---|---|
| 👮 Moderador | advertir, aislar, ver historial y casos | Moderar miembros |
| 🛡️ Administrador | además expulsar, banear, desbanear, editar y anular casos | Expulsar / Banear / Gestionar servidor |

**Escalado por advertencias** (configurable): las advertencias vencen a los 30 días.
- Al llegar a 3 activas, aislar 60 min.
- Expulsar y banear están apagados por defecto.

Aislar y expulsar se disparan al llegar justo al umbral; banear, desde el umbral en adelante.

**Automod** (`/automod`; el staff, los roles de moderación y lo que esté exento nunca pasan por él):

| Regla | Por defecto | Qué hace |
|---|---|---|
| Antispam | más de 6 mensajes en 5 s | Borra la ráfaga (en todos los canales) y aísla 5 min, con caso |
| Antiflood | más de 4 repetidos en 30 s, más de 6 menciones, más de 30 líneas | Borra el mensaje y avisa (el aviso se borra solo) |
| Enlaces | solo invitaciones (modo "todos" con lista blanca) | Borra el mensaje y avisa; también revisa ediciones |
| Infracciones | 3 en 10 min | Pasan a ser una advertencia (que puede escalar) |
| Antiraid | 10 entradas en 30 s | Modo raid por 15 min: avisa, aísla o expulsa cuentas de menos de 7 días, con un resumen agrupado en el registro. Se activa o termina a mano desde `/automod` |

## 6. Base de datos (migración 9)

| Tabla | Para qué | Garantía |
|---|---|---|
| `kisses` | cada beso enviado y su estado | `CHECK (author_id <> target_id)`, estado con UPDATE condicional |
| `voice_config` | categoría, hub, interfaz, plantilla y límite por servidor | `CHECK` de límite 0–99 |
| `temp_voice_channels` | canales vivos y su dueño | índice único `(guild_id, owner_id)` |
| `voice_profiles` | preferencias de cada dueño | — |
| `voice_access` | permitidos y bloqueados por dueño | PK `(guild, owner, target)`: nadie está en las dos listas |
| `mod_cases` | casos de moderación | `UNIQUE (guild_id, case_number)`, `CHECK` de acción |
| `mod_roles` | roles de moderador o administrador del bot | `CHECK` de nivel |
| `automod_config` | configuración (JSON validado) y fin del modo raid | se normaliza al leer: un JSON roto nunca rompe el bot |

Las migraciones se aplican solas al arrancar y no tocan datos existentes.

## 7. Pruebas

207 tests (`npm test`), 52 nuevos:
- **Besos:** 9 → 10 al corresponder; doble clic; solo el destinatario; rechazo; id de otro servidor; corresponder sin espera; espera por pareja (sin filas a medias); botones viejos; estadísticas. También quedó probado el rollback de un intento fallido.
- **Canales temporales:** config por servidor; un dueño, un canal; carrera de creación; tope por servidor; transferir y reclamar condicionales; preferencias; listas que se excluyen con tope; nombres (invitaciones, enlaces, @everyone, largo); plantillas; límites; 2 renombres cada 10 min. Además, permisos del canal nuevo con un servidor simulado: hereda la categoría, privacidad, permitidos y bloqueados, no otorga lo que el bot no tiene y el dueño nunca recibe permisos de gestión.
- **Moderación:** numeración sin repetidos y aislada por servidor; motivos; advertencias que vencen o se anulan; historial; duraciones (`1h30m`, `2 horas`, máximo 28 días); roles por nivel; configuración normalizada desde JSON roto; modo raid; escalado exacto.
- **Automod:** invitaciones con y sin esquema; lista blanca y subdominios; dominios parecidos; texto común que no es enlace (correos, versiones, horas); ventanas de ráfagas; repetidos; memoria acotada; infracciones; raids por servidor; cuentas nuevas.
- **Seguridad y datos:** URL mal codificada → 400 sin caída; límite de inicios de sesión; copia diaria con retención.

**Verificado a mano en esta sesión:** compila (`npm run build`), los 32 comandos de barra pasan las validaciones de Discord (largos, nombres, opciones) y todos los paneles nuevos se construyen y serializan (filas, botones, menús).

**No probado contra Discord real:** no hay un servidor de pruebas en este entorno. Ver la checklist del README antes de usarlo en producción.

## 8. Mejoras futuras (por valor)

1. **Tickets de soporte** con transcripción, que se integren con los casos de moderación.
2. **Verificación de miembros nuevos** (botón o captcha) combinada con el modo raid.
3. **Retención configurable** de historiales (`history_views`, `user_media`) y exportación de casos a CSV.
4. **Panel web** de moderación y configuración (reusando el servidor de la Actividad, con el mismo OAuth).
5. **Postgres + Redis** si hace falta *sharding* (los candados y detectores pasarían a Redis).
6. **Separar `components.ts`** en un archivo por módulo, como ya están voz y moderación.
7. **Registro estructurado** (JSON) con rotación, y métricas (latencia de interacciones, errores por comando).
