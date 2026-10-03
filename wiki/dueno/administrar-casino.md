# Administrar el casino

Solo el **dueño del bot** (el dueño de la aplicación y los IDs de `OWNER_IDS`). Todo queda en el registro administrativo (`!casino log`).

## Saldos

| Comando | Ejemplo |
|---|---|
| Dar | `!balance add @usuario 500 ganó el evento` |
| Sacar | `!balance remove @usuario 200 abuso de bug` |
| Fijar | `!balance set @usuario 1000` |

Nunca deja un saldo negativo. Acepta `1000`, `1.000`, `5k`, `1.5m`.

## Juegos y economía

| Comando | Qué hace |
|---|---|
| `!casino config` | Panel con toda la configuración y edición por juego |
| `!casino enable\|disable <juego\|all>` | Abrir o cerrar juegos |
| `!casino minbet\|maxbet <juego\|all> <n>` | Apuestas mínima y máxima |
| `!casino edge <juego> <%>` | Ventaja de la casa |
| `!casino cooldown <juego> <ms>` | Espera entre rondas |
| `!casino set <ruta> <valor>` | Cualquier valor numérico (ej: `daily.amount 150`, `work.cooldownMinutes 60`) |
| `!casino auto daily\|weekly on\|off\|metric\|prizes\|rounds` | Torneos automáticos |

## Eventos y control

| Comando | Qué hace |
|---|---|
| `!casino drop <monto> <personas> [minutos]` | Lluvia de monedas en el canal |
| `!casino boost <x> <horas>` | Multiplica las Coins por actividad |
| `!casino hide\|unhide @x` | Ocultar de los rankings |
| `!casino block\|unblock @x` | Suspender del casino |
| `!casino audit` | Comprueba que la economía cuadre |
| `!casino log [@x]` | Registro administrativo |
