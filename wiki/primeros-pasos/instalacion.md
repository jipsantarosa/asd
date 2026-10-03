# Instalación

## 1. Crear la aplicación en Discord

1. Entrá a [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**.
2. En **Bot** → **Reset Token** y copiá el token (va en `DISCORD_TOKEN`).
3. En **Bot → Privileged Gateway Intents** activá **Server Members Intent** y **Message Content Intent**.
4. En **OAuth2 → URL Generator** elegí los scopes `bot` y `applications.commands` y estos permisos:

| Para | Permisos |
|---|---|
| Básico | Ver canales, Enviar mensajes, Insertar enlaces, Adjuntar archivos, Leer el historial |
| Registros y roles | Gestionar canales, Gestionar roles, Ver el registro de auditoría |
| Voz temporal | Conectar, Mover miembros |
| Moderación | Gestionar mensajes, Moderar miembros, Expulsar miembros, Banear miembros |
| `!steal` | Crear expresiones (o Gestionar expresiones) |
| Anti-webhooks | Gestionar webhooks |

{% hint style="info" %}
Ubicá el **rol del bot por encima** de los roles que va a entregar y de los roles de quienes va a moderar.
{% endhint %}

## 2. Instalar y arrancar

{% tabs %}
{% tab title="Windows" %}
1. Instalá [Node.js 22 o más nuevo](https://nodejs.org).
2. Abrí **`configurar.bat`** y pegá el token del bot (y, si querés, los IDs de los dueños).
3. Abrí **`iniciar.bat`**: instala, compila y arranca el bot. Si se cae, se reinicia solo.
{% endtab %}

{% tab title="Linux / macOS" %}
```bash
npm install
cp .env.example .env      # completá DISCORD_TOKEN
npm run build
npm start
```
{% endtab %}
{% endtabs %}

Los comandos de barra (`/`) se registran solos al conectarse.

## Variables del `.env`

| Variable | Qué es |
|---|---|
| `DISCORD_TOKEN` | Token del bot (obligatorio) |
| `CLIENT_ID` | Application ID (opcional: se deduce del token) |
| `DEV_GUILD_ID` | Servidor de pruebas: los comandos aparecen ahí al instante |
| `DATABASE_PATH` | Base de datos (por defecto `./data/valle.db`) |
| `DEFAULT_PREFIX` | Prefijo inicial de cada servidor (por defecto `!`) |
| `OWNER_IDS` | Dueños del bot, separados por coma (el dueño de la aplicación se detecta solo) |

{% hint style="danger" %}
Nunca compartas ni subas a internet tu `DISCORD_TOKEN`. Si se filtra, reseteálo en el Developer Portal.
{% endhint %}

