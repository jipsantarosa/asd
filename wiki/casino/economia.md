# Economía y Coins

{% hint style="warning" %}
Las Coins 🪙 son **solo virtuales**: no se compran, no se retiran y no se cambian por dinero real.
{% endhint %}

* Hay **una sola billetera por persona**, que vale en todos los servidores donde está el bot.
* **No hay transferencias entre personas** (así las cuentas alternativas no pueden juntar Coins en una principal).
* Todo movimiento queda registrado: lo ves con **`!history tx`**.

## Cómo conseguir Coins

La economía está pensada para ser **difícil de farmear**.

| Fuente | Cuánto | Límite |
|---|---|---|
| Saldo inicial | 1.000 | una vez |
| [`!work`](trabajos.md) | 10 a 2.500 por turno según el trabajo (los caros tienen riesgo y fianza) | cada trabajo 1 vez por hora, cupo de 3.000 por día |
| `!daily` | 50 (+10 % por día de racha, hasta +70 %) | una vez por día |
| `!weekly` | 500 | cada 7 días |
| `!rescate` | 100 | solo con menos de 20 Coins y sin partidas abiertas, cada 24 h |
| Chatear | 1 a 3 por mensaje | cada 2 min, tope 50 por día |
| Subir de nivel | 3 × nivel | una vez por nivel |
| [Logros](ranking-y-logros.md) | 25 a 2.500 | una vez cada uno |
| [Torneos](torneos.md) | premios fijos | |

### Coins por chatear

Un mensaje solo paga si:

* no es un comando;
* tiene al menos 8 letras y 3 palabras de verdad (menciones, enlaces y emojis no cuentan);
* no repite (ni casi repite) tus últimos mensajes y no estás mandando ráfagas;
* tu cuenta de Discord tiene más de 14 días y llevás más de 24 h en el servidor.

Desde el mensaje 15 del día paga la mitad, y desde el 30, un cuarto.

## Comandos

| Comando | Qué hace |
|---|---|
| `!balance` | Tu billetera, los bonos disponibles y lo ganado hoy |
| `!balance @usuario` | El saldo de otra persona |
| `!daily` · `!weekly` · `!rescate` | Bonos |
| `!history` | Tus últimas rondas; `!history tx` muestra los movimientos de la billetera |
