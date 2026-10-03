# Juego justo (provably fair)

Ningún resultado se elige a mano ni con `Math.random()`. Cada ronda sale de tres datos:

* **Semilla del servidor:** secreta mientras está activa, pero su **hash (SHA-256)** se muestra **antes** de jugar.
* **Semilla del cliente:** la podés cambiar vos.
* **Nonce:** sube de a uno con cada apuesta.

Los números de la ronda son `HMAC-SHA256(semilla_servidor, "semilla_cliente:nonce:bloque")`. Cada bloque da 8 números de 32 bits, y cada número ÷ 2³² es un azar entre 0 y 1. Las mezclas (cartas, minas, torre) usan Fisher-Yates con esos números.

## Verificar una ronda

1. `!fairness` — anotá el hash de la semilla activa.
2. Jugá.
3. `!fairness rotar` — revela la semilla anterior. Comprobá que su SHA-256 sea el hash que anotaste.
4. `!fairness verificar <número de ronda>` — el bot recalcula el resultado con la semilla revelada.

{% hint style="info" %}
No se puede rotar la semilla con partidas abiertas: revelaría resultados que todavía no se jugaron.
{% endhint %}

