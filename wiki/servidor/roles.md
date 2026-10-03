# Roles y distinciones

`/roles` (Gestionar roles):

* **Grupos de roles:** los miembros eligen sus roles desde un panel publicado. Modo **libre** (varios) o **único** (uno por grupo). Se puede exigir un **nivel mínimo del casino**.
* **Distinciones:** roles automáticos al llegar a un **nivel del casino**. Se entregan al subir de nivel y al abrir `!profile`. Nunca se quitan solas.

Por seguridad se rechazan @everyone, los roles de integraciones, los que están por encima del bot y los que tienen permisos de moderación o administración.

## Autoroles: personas y bots por separado

| Comando | Qué hace |
| --- | --- |
| `/autorol miembros rol:@Miembro` · `!autorol @Miembro` | Rol que recibe cada **persona** que entra |
| `/autorol bots rol:@Bots` · `!autorol bots @Bots` | Rol que recibe cada **bot** que se agrega |
| `/autorol aplicar` | Se los da a los que ya estaban |
| `/autorol off [tipo]` · `/autorol estado` | Desactivar (uno o los dos) y ver |

Se separan solos: el bot mira si quien entra es un bot o una persona. Con la verificación de reglas de Discord activa, el rol de personas se da cuando aceptan las reglas. En modo raid no se dan roles a personas. Requiere **Gestionar roles**, y el rol tiene que estar por debajo del rol del bot y no tener permisos de moderación.
