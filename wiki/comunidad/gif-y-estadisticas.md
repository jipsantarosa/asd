# !gif y estadísticas de juegos

## !gif

Convierte fotos **PNG o JPG** en GIF (para guardarlas como GIF favorito en Discord).

* `!gif` con una foto adjunta, o respondiendo a un mensaje que tenga una foto.
* `!gif @usuario` usa el avatar de esa persona.
* Con **varias fotos** (hasta 10) arma un GIF animado, una detrás de otra.
* `/gif` tiene opciones para adjuntar hasta 3 fotos o elegir un usuario.

## !uservalo (Valorant)

`!uservalo Nombre#TAG` muestra nivel, región, rango actual con RR, mejor rango y las últimas 5 partidas (agente, mapa, K/D/A, headshots y si ganó), con un botón para abrir el perfil completo en **Tracker.gg**. Sin clave de API, muestra directo el botón de Tracker.gg.

{% hint style="info" %}
Usa la API de **HenrikDev** (Riot no tiene una API pública para esto). El dueño del bot pide una clave gratis en su Discord ([docs.henrikdev.xyz](https://docs.henrikdev.xyz)) y la pone en el `.env` como `HENRIK_API_KEY=...`.
{% endhint %}

## !cs2 (Counter-Strike 2)

`!cs2` con el enlace de tu perfil de Steam (`steamcommunity.com/id/...` o `/profiles/...`), tu SteamID64 o tu nombre personalizado. Muestra K/D, % de headshots, precisión, horas jugadas, partidas ganadas y MVPs (totales que publica Steam), con botones a **CSRep.gg** (reputación y partidas recientes) y al perfil de Steam. Sin clave de API, muestra directo los botones (para CSRep.gg hace falta el enlace `/profiles/...` o el SteamID64).

{% hint style="info" %}
Necesita una clave gratis de Steam ([steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey)) en el `.env` como `STEAM_API_KEY=...`, y que el perfil y los **detalles del juego** estén en público.
{% endhint %}
