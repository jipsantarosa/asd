# Anti-webhooks

Protege contra la creación o el uso malicioso de **webhooks**.

**Para qué sirve:** frenar bots automáticos, proteger los canales y cortar el spam por webhooks.

## Activar

```
/anti-webhooks setup
```

## Qué hace

* Si alguien **sin permiso crea un webhook**, el bot lo **borra** y lo deja en el registro de moderación.
* Si lo creó un **bot**, además lo **expulsa** (se puede desactivar).
* Borra los **mensajes de webhooks** con @everyone/@here o invitaciones a otros servidores.
* Si un webhook manda **spam** (más de 5 mensajes en 5 s), lo borra entero.
* Las respuestas de comandos de otros bots y los anuncios de canales seguidos no se tocan.

**Pueden crear webhooks:** el dueño del servidor, los administradores (configurable) y los roles permitidos.

## Comandos

| Comando | Qué hace |
|---|---|
| `/anti-webhooks setup` · `off` | Activar o desactivar |
| `/anti-webhooks status` | Ver la configuración |
| `/anti-webhooks allow rol:@rol` · `disallow` | Permitir o quitar un rol |
| `/anti-webhooks admins permitir:sí/no` | ¿Los admins pueden crear webhooks? |
| `/anti-webhooks bots expulsar:sí/no` | ¿Expulsar bots que creen webhooks sin permiso? |

{% hint style="info" %}
El bot necesita **Gestionar webhooks**, **Ver el registro de auditoría** y **Gestionar mensajes** (y **Expulsar miembros** para expulsar bots).
{% endhint %}

## Relacionado

* [Automod y antiraid](automod.md)
