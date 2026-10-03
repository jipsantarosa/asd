# Boost tracker

Manda un mensaje especial cuando alguien **boostea** el servidor.

**Para qué sirve:** agradecer a los boosters, darles reconocimiento público y motivar más boosts.

## Activar

```
/boosttracker setup canal:#bienvenidos
```

## Personalizar

```
/boosttracker edit color:Oro
/boosttracker edit titulo:¡Gracias por el boost! descripcion:{user} hizo brillar a {server} ✨
```

Por prefijo: `!boosttracker edit color Oro`, `!boosttracker edit titulo ¡Gracias!`.

| Campo | Detalle |
|---|---|
| **Título** | hasta 256 caracteres |
| **Descripción** | hasta 2.000 caracteres |
| **Color** | `Oro`, `Rosa`, `Morado`, `Azul`, `Celeste`, `Verde`, `Rojo`, `Naranja`, `Blanco`, `Negro` o `#RRGGBB` |
| **Imagen** | enlace `https` a una imagen o GIF (`no` para quitarla) |
| **Footer** | hasta 200 caracteres (`no` para quitarlo) |

### Variables

| Variable | Se reemplaza por |
|---|---|
| `{user}` | mención de quien boosteó |
| `{username}` | su nombre |
| `{server}` | nombre del servidor |
| `{boosts}` | cantidad de boosts |
| `{tier}` | nivel de mejoras |

## Otros comandos

| Comando | Qué hace |
|---|---|
| `/boosttracker test` | Vista previa con vos de ejemplo |
| `/boosttracker reset` | Vuelve al mensaje por defecto |
| `/boosttracker off` | Desactiva |
| `/boosttracker status` | Muestra la configuración |

{% hint style="info" %}
Requiere **Gestionar servidor**. El mismo boost no se anuncia dos veces.
{% endhint %}

