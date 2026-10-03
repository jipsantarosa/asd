# Juegos

| Juego | Comando | Tipo |
|---|---|---|
| 🃏 [Blackjack](blackjack.md) | `!bj` · `!blackjack` | decisiones |
| 🎡 [Ruleta](ruleta.md) | `!ruleta` · `!rl` | instantáneo |
| 🎰 [Slots](slots.md) | `!slots` | instantáneo, con jackpot |
| 🚀 [Crash](crash.md) | `!crash` | en vivo |
| 🔵 [Plinko](plinko.md) | `!plinko` | instantáneo |
| 💣 [Minas](minas.md) | `!minas` · `!mines` | decisiones |
| 🐔 [Pollo](pollo.md) | `!pollo` · `!chicken` | decisiones |
| 🎈 [Globos](globos.md) | `!globos` | decisiones |
| 🔮 [Hilo](hilo.md) | `!hilo` | decisiones |
| 🐉 [Dragon Tower](dragon-tower.md) | `!dragon` · `!tower` | decisiones |

Todos tienen también versión de barra (`/crash`, `/minas`…).

## Reglas comunes

* **Los botones son solo tuyos** y no se pueden tocar dos veces: un doble clic o un mensaje viejo no hacen nada.
* **Una partida abierta por juego.** Si querés empezar otra, el bot te ofrece **▶️ Retomar partida**.
* **Si el bot se reinicia**, la partida sigue donde estaba (o se te devuelve la apuesta).
* Una partida que dejás **30 minutos sin tocar** se resuelve sola: cobra lo que ya habías ganado, se planta o te devuelve la apuesta.
* Cada juego tiene apuesta mínima y máxima, y hay un premio máximo por ronda.
* En los juegos con multiplicador creciente (Crash, Minas, Pollo, Globos, Hilo, Dragon Tower) **cobrar en cualquier momento vale lo mismo en promedio**: el multiplicador es RTP ÷ probabilidad de llegar.

{% hint style="info" %}
El dueño del servidor puede limitar los juegos a ciertos canales desde `/ajustes`.
{% endhint %}

