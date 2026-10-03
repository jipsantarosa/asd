# 🎡 Ruleta

```
!ruleta 100 rojo
```

Ruleta **europea** (un solo cero). Cada apuesta paga **36 ÷ cantidad de números cubiertos**.

| Apuesta | Ejemplo | Paga |
|---|---|---|
| Pleno | `!ruleta 100 17` | 36x |
| Varios números | `!ruleta 100 7,17,23` | 12x (36 ÷ 3) |
| Rango | `!ruleta 100 5-12` | 4,5x |
| Docena / columna | `d1` `d2` `d3` · `c1` `c2` `c3` | 3x |
| Color, par/impar, mitades | `rojo` `negro` `par` `impar` `bajo` `alto` | 2x |

El 0 hace perder todo lo que no lo incluya: esa es la ventaja de la casa (2,7 %).
