# Actualizar el bot

1. Detené el bot.
2. Reemplazá los archivos del bot por la versión nueva **sin borrar la carpeta `data/`** (ahí está la base de datos y las copias de seguridad).
3. Volvé a abrir `iniciar.bat` (o `npm install && npm run build && npm start`).

Al arrancar:

* Las **migraciones** de la base se aplican solas y nunca borran datos.
* Si la versión nueva cambió el diseño de los canales de **registros** o de **voz temporal**, el bot los **actualiza solo** en cada servidor (renombra, mueve y corrige permisos, sin borrar nada) y deja un resumen en `#sistema-bot`.
* Los comandos de barra nuevos se registran solos.

{% hint style="success" %}
Ya no hace falta borrar canales a mano. Si quedaron canales repetidos de instalaciones viejas, `/setup` y `/voz` muestran el botón **🧹 Borrar sobrantes**.
{% endhint %}

## Copias de seguridad

Todos los días se guarda una copia en `data/backups/` (se conservan 7). Para restaurar: detené el bot, copiá la que quieras como `data/valle.db` y borrá `valle.db-wal` y `valle.db-shm`.
