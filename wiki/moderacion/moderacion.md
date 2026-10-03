# Moderación

| Prefijo | Barra | Qué hace |
|---|---|---|
| `!warn @x motivo` | `/mod warn` | Advertencia |
| `!timeout @x 10m motivo` | `/mod timeout` | Aislamiento (`10m`, `1h30m`, `2 horas`, máximo 28 días) |
| `!untimeout @x` | `/mod untimeout` | Quita el aislamiento |
| `!kick @x motivo` | `/mod kick` | Expulsión |
| `!ban @x motivo` | `/mod ban` | Baneo (también por ID) |
| `!unban ID` | `/mod unban` | Desbaneo |
| `!modlogs @x` | `/mod historial` | Casos de una persona |
| `!caso 12` | `/mod caso` | Ver, editar el motivo o anular un caso |

* Cada sanción crea un **caso numerado** con motivo, moderador y fecha, se publica en el registro de moderación y le llega un MD a la persona.
* Respondiendo al mensaje de alguien con `!warn`, `!timeout`, `!kick` o `!ban` (sin mencionarlo), se aplica a esa persona.
* Nadie puede sancionar a alguien con un rol igual o más alto, ni al dueño ni al bot.
* **Escalado:** las advertencias vencen a los 30 días; por defecto, 3 activas aíslan 60 minutos.
* `!m @x 100` (o `/purgar`) borra mensajes recientes de esa persona en el canal (hasta 1.000, de menos de 14 días).
