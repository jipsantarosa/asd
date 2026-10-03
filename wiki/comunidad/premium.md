# Premium

Lo da el **dueño del bot** y vale en todos los servidores. **No da ventajas en el casino.**

| Nivel | Incluye |
|---|---|
| 💎 Tier 1 (Booster) | `!clearavatars`, `!clearnames`, `!tags` |
| 🌟 Tier 2 | Todo lo del 1 + `!cleartags` + `!mstats` parcial |
| 👑 Tier 3 | Todo lo del 2 + `!mstats` completo (las últimas 10 personas que miraron tus historiales) |
| 🔮 Tier 4 | Todo lo del 3 + `!ghostmode` + `!botperfil` (apodo, avatar y banner del bot en hasta 3 servidores) |

* `!premium` o `!premium @usuario` — ver el nivel.
* Dueño: `!premium dar @usuario <1-4> [días]` · `!premium quitar @usuario` · `!premium lista`.

## Roles premium

`/rolespremium crear` crea un rol por nivel (**Premium Booster**, **Premium Tier 2**, **Premium Tier 3** y **Premium Tier 4**) y los configura. Desde ahí son automáticos:

* al dar premium con `!premium dar`, la persona recibe el rol de su nivel en todos los servidores que tengan roles premium;
* si cambia de nivel, se le cambia el rol; si se lo quitan o se vence, se le quita (el bot revisa cada 10 minutos);
* si entra a un servidor después, lo recibe al entrar.

Otros comandos: `/rolespremium set nivel rol` (usar un rol que ya tenés), `/rolespremium sync` (revisar a todos ahora), `/rolespremium estado` y `/rolespremium off`. Requiere **Gestionar roles**. `/setupdiscord` ya los deja creados.
