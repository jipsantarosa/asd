# Torneos especiales

```
!torneo create Plinko Weekend juego=plinko metrica=multiplicador duracion=2d premios=50k,25k,10k minbet=100 rondas=20 | Descripción opcional
```

| Opción | Valores |
|---|---|
| `juego` | un juego o `todos` |
| `metrica` | `beneficio`, `apostado`, `multiplicador`, `victorias` |
| `duracion` | `90m`, `12h`, `3d` |
| `inicio` | `+2h` o `2026-10-05T20:00` (si es futuro, queda programado) |
| `fin` | `+1d` o una fecha |
| `premios` | de 1 a 10 montos separados por coma (obligatorio) |
| `minbet` · `maxbet` | apuesta mínima y máxima que cuenta |
| `entrada` · `pozo` | costo de inscripción y si suma a los premios (`si`/`no`) |
| `rondas` | rondas mínimas para cobrar |
| `nombre` | al editar, con `_` en lugar de espacios |

## Ciclo de vida

| Comando | Qué hace |
|---|---|
| `!torneo start <id>` | Empieza ya (y se anuncia) |
| `!torneo schedule <id>` | Lo programa para su fecha |
| `!torneo edit <id> premios=… fin=+1d` | Edita (en curso: nombre, descripción, premios y extender el fin) |
| `!torneo stop <id>` | Termina y reparte premios (una sola vez) |
| `!torneo cancel <id>` | Cancela y devuelve las entradas |
| `!torneo list` | Incluye borradores |
