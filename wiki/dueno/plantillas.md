# Servidor del bot y plantillas

{% hint style="warning" %}
Solo los **dueños del bot** (el dueño de la aplicación en el portal de Discord y los IDs de `OWNER_IDS`) pueden usar estos comandos.
{% endhint %}

## `/setupdiscord`: el servidor oficial del bot

1. Creá un servidor nuevo en Discord e invitá al bot con permiso de **Administrador** (para que pueda copiar todos los permisos).
2. Escribí `/setupdiscord` (o `!setupdiscord`).
3. Revisá la vista previa y tocá **✅ Crear todo**.

Arma un servidor listo para promocionar el bot:

| Categoría | Canales |
| --- | --- |
| 📌 Información | 👋 bienvenida (canal del sistema), 📜 reglas, 📢 anuncios, 🆕 novedades, 🔗 invitar-bot (con botón de invitación), 🎭 roles (autorroles), 🚀 boosts |
| 🎰 Casino | 🎲 casino, 💼 trabajos, 🏆 torneos, 🎁 sorteos |
| 💬 Comunidad | 💬 general, 🤖 comandos, 📸 media, 💡 sugerencias (foro), 🤝 partners |
| 🆘 Soporte | 📖 preguntas-frecuentes, ❓ soporte, 🐛 reportar-bugs (foro) |
| 🔊 Voz | General, Gaming, Música, Soporte por voz |
| 🛡️ Staff (privada) | staff-chat, avisos-discord, pruebas-bot, voz del staff |

**Roles:** 👑 Fundador (te lo da a vos), 🛠️ Staff, 🧰 Soporte, 🤝 Partner, 💎 VIP, 🤖 Bots, 👤 Miembro y los de notificaciones que cada uno elige en 🎭 roles: 📢 Anuncios, 🆕 Novedades, 🏆 Torneos, 🎁 Sorteos y 🧪 Beta tester.

**Además:**
* publica los mensajes de bienvenida, reglas, anuncio de apertura, novedades, invitación y preguntas frecuentes;
* activa la **Comunidad** de Discord, así 📢 anuncios y 🆕 novedades quedan como canales de anuncios que otros servidores pueden **seguir**;
* sube la verificación a *media*, filtra contenido explícito y pone las notificaciones en *solo menciones*;
* configura los registros (`/setup`), la voz temporal (`/voz`) y el boost tracker.

{% hint style="info" %}
**Nunca borra ni edita nada que ya exista.** Lo que tenga el mismo nombre (sin importar emojis ni mayúsculas) se reutiliza y solo se crea lo que falta. Podés volver a correrlo sin duplicar canales; los mensajes se publican solo en los canales que se crean en ese momento.
{% endhint %}

## `/plantilla`: copiar y pegar servidores

| Comando | Qué hace |
| --- | --- |
| `/plantilla copiar nombre:mi-server` | Guarda roles, categorías, canales, temas, slowmode y permisos por rol del servidor actual. También te manda el `.json` |
| `/plantilla pegar nombre:mi-server` | Vista previa y, al confirmar, crea en este servidor lo que falte |
| `/plantilla importar archivo:… [nombre]` | Guarda una plantilla desde un `.json` (por ejemplo, una que editaste a mano) |
| `/plantilla archivo nombre:…` | Descarga el `.json` (también el de la plantilla incluida `bot`, para usarla de base) |
| `/plantilla lista` · `/plantilla borrar nombre:…` | Ver y borrar plantillas guardadas (borrar una plantilla no toca ningún servidor) |

Por prefijo: `!plantilla copiar mi-server`, `!plantilla pegar mi-server`, `!plantilla importar mi-server` con el archivo adjunto, etc. Para pisar una guardada: `!plantilla copiar mi-server reemplazar`.

No se copian mensajes, miembros ni permisos de personas puntuales; tampoco los roles de bots e integraciones.

## Formato del `.json`

```json
{
  "format": "casino-template",
  "version": 1,
  "name": "Mi servidor",
  "roles": [
    { "name": "🛠️ Staff", "color": 15158332, "hoist": true, "permissions": ["KickMembers", "ManageMessages"] },
    { "name": "📢 Anuncios", "mentionable": true, "selfAssign": true }
  ],
  "channels": [],
  "categories": [
    {
      "name": "📌 Información",
      "channels": [
        {
          "name": "📜・reglas", "type": "text", "role": "rules",
          "overwrites": [{ "role": "@everyone", "deny": ["SendMessages"] }],
          "messages": [{ "title": "Reglas", "description": "Leé {#📜・reglas} y elegí roles en {#🎭・roles}.", "buttons": [{ "label": "Invitar a {bot}", "url": "{invite}" }] }]
        }
      ]
    }
  ],
  "settings": { "verification": "medium", "contentFilter": "all", "notifications": "mentions", "community": true },
  "bot": { "logs": true, "tempVoice": true, "selfRolesTitle": "Notificaciones" }
}
```

* `type`: `text`, `voice`, `announcement`, `forum` o `stage`.
* `role` de un canal: `system` (bienvenidas), `rules`, `modUpdates` (avisos de Discord para moderadores), `boost` (boost tracker) o `selfRoles` (panel de autorroles).
* Permisos: los nombres de Discord (`ViewChannel`, `SendMessages`, `ManageMessages`, `Administrator`…).
* Variables en los mensajes: `{server}`, `{bot}`, `{invite}` (enlace para invitar al bot), `{prefix}`, `{user}`, `{#canal}` y `{@&rol}`.

Si el archivo tiene un error, el bot dice exactamente dónde (por ejemplo *"categoría 2 › Info › type"*).
