# Tienda y tickets (/tienda)

Productos con un mensaje lindo y un botón **🛒 Comprar**. Al tocarlo, el bot abre un **ticket**: un canal privado entre quien compra y el staff, donde se arregla la venta.

## Armar un producto

1. `/tienda` (necesitás **Gestionar servidor**) → **➕ Nuevo producto**.
2. **✏️ Textos e imagen:** título, descripción (acepta **negrita**, `> citas`, emojis), imagen (enlace `https://…`), color (`#RRGGBB`) y el texto del botón.
3. **💲 Precio y stock:** precio en pesos, en dólares (los que dejes vacíos no se muestran) y stock (vacío = sin límite).
4. Andá al canal donde lo quieras mostrar, abrí `/tienda`, elegí el producto y tocá **📢 Publicar aquí**.

Cada vez que editás algo, la publicación se actualiza sola. **Mover aquí** lo publica en otro canal y borra la publicación vieja.

## Tickets

En `/tienda` → **🎫 Tickets** elegís:

* **Categoría** donde se crean los canales de los tickets.
* **Rol del staff** que los ve y atiende.
* **Canal de registro**: aperturas, ventas y la transcripción de cada ticket al cerrarlo.

En cada ticket hay dos botones:

* **✅ Marcar vendido** (solo staff): registra la venta y baja 1 el stock. Con stock 0 el botón del producto pasa a **Agotado**.
* **🔒 Cerrar ticket** (quien compró o el staff): pide confirmación, guarda la transcripción en el registro y borra el canal.

Cada persona puede tener hasta **3 tickets abiertos**, y uno solo por producto (si toca **Comprar** otra vez, el bot le muestra el que ya tiene).

{% hint style="warning" %}
El bot no cobra ni entrega nada: solo abre el canal para que hablen. Vendé únicamente cosas propias y legítimas, y respetá los Términos de Discord.
{% endhint %}
