# Registros (/setup)

`/setup` (Administrador) crea la categoría **Registros**:

| Canal | Qué registra |
|---|---|
| mensajes | enviados y editados |
| eliminados | individuales y en masa |
| adjuntos | copia de imágenes y archivos |
| baneos · expulsiones | baneos, desbaneos y expulsiones |
| entradas-salidas · apodos · roles | miembros, apodos y roles |
| moderacion · voz · servidor | sanciones, voz, cambios del servidor |
| sistema-bot | avisos del propio bot |

* @everyone no ve los registros; los admins y el rol de staff opcional (`/setup rol_staff:@rol`) pueden leer pero no escribir.
* **No duplica nada:** se puede ejecutar cuantas veces quieras. Encuentra sus canales por ID o, si se perdió la base, por nombre (también nombres viejos).
* **Actualiza:** deja cada canal con el nombre, la descripción, la categoría y los permisos de la versión actual.
* **🧹 Borrar sobrantes:** si quedaron canales repetidos de instalaciones viejas, los borra con confirmación.
* **♻️ Reinstalar desde cero:** borra y recrea los canales (se pierde el historial; doble confirmación).

{% hint style="info" %}
Al actualizar el bot, los registros se sincronizan solos. `/ajustes` permite dejar de registrar los mensajes enviados.
{% endhint %}

