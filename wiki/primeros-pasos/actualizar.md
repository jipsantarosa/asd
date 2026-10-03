# Actualizar el bot

Toda la configuración (canales de registros, voz temporal, roles, casino, boost tracker, idioma, saldos, matrimonios...) vive en la base de datos `data/valle.db`, y el token en `.env`. **Si actualizás en la misma carpeta sin borrar esas dos cosas, no tenés que configurar nada de nuevo.**

## Opción fácil: `actualizar.bat` (Windows)

Hacé doble clic en `actualizar.bat`, en la misma carpeta del bot. Hace todo solo:

1. Cierra el bot si está corriendo.
2. Guarda una copia de la base en `data/backups/antes-de-actualizar-<fecha>.db`.
3. Baja la versión nueva desde GitHub y reemplaza **solo el código** (nunca `data/` ni `.env`).
4. Instala dependencias y compila.
5. Vuelve a abrir `iniciar.bat`.

Si algo falla, no arranca nada raro: tu `data/` y tu `.env` quedan intactos y podés abrir `iniciar.bat` con la versión que tenías.

De dónde baja el código se configura en el `.env`:

| Variable | Para qué |
| --- | --- |
| `UPDATE_REPO` | Repositorio de GitHub (por defecto `jipsantarosa/asd`) |
| `UPDATE_BRANCH` | Rama a bajar. Cuando la versión se fusione a `main`, cambiala a `main` |
| `GITHUB_TOKEN` | Solo si el repositorio es privado: token de GitHub de solo lectura. Nunca lo compartas |

Si la carpeta es un clon de git, `actualizar.bat` usa `git fetch` + `git merge --ff-only` en lugar de bajar el zip.

## Opción manual

1. Detené el bot.
2. Reemplazá los archivos del bot por la versión nueva **sin borrar la carpeta `data/` ni el `.env`**.
3. Volvé a abrir `iniciar.bat` (o `npm install && npm run build && npm start`).

## Qué pasa al arrancar

* Las **migraciones** de la base se aplican solas y nunca borran datos.
* Si la versión nueva cambió el diseño de los canales de **registros** o de **voz temporal**, el bot los **actualiza solo** en cada servidor (renombra, mueve y corrige permisos, sin borrar nada) y deja un resumen en `#sistema-bot`.
* Los comandos de barra nuevos se registran solos.

{% hint style="success" %}
Ya no hace falta borrar canales a mano. Si quedaron canales repetidos de instalaciones viejas, `/setup` y `/voz` muestran el botón **🧹 Borrar sobrantes**.
{% endhint %}

## Copias de seguridad

Todos los días se guarda una copia en `data/backups/` (se conservan 7), además de la que hace `actualizar.bat` antes de cada actualización. Para restaurar: detené el bot, copiá la que quieras como `data/valle.db` y borrá `valle.db-wal` y `valle.db-shm`.
