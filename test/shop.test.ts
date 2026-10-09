import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GameError } from '../src/services/context';
import {
  closeTicket, createProduct, deleteProduct, getProduct, getShopConfig, listProducts, markSold, openTicketsOf, parseHexColor, parseStock,
  reserveTicket, saveShopConfig, setTicketChannel, SHOP_LIMITS, updateProductPrice, updateProductTexts,
} from '../src/services/shop';
import { productEmbed } from '../src/discord/commands/shop';
import { G, U, U2, makeWorld } from './helpers';

const expectGameError = (fn: () => unknown, re?: RegExp) => assert.throws(fn, (e: unknown) => e instanceof GameError && (!re || re.test(e.message)));
const texts = { title: 'Mi producto', description: '**Algo lindo**', imageUrl: 'https://x/img.png', color: '#FF8800', button: 'Comprar ya' };

describe('tienda: productos', () => {
  it('se crea con textos de ejemplo y se edita todo', () => {
    const w = makeWorld();
    const p = createProduct(w.ctx, G);
    assert.equal(p.stock, null);
    const e = updateProductTexts(w.ctx, G, p.id, texts);
    assert.equal(e.color, 0xff8800);
    assert.equal(e.button, 'Comprar ya');
    const pr = updateProductPrice(w.ctx, G, p.id, { ars: '399.00', usd: '1.00', stock: '367' });
    assert.deepEqual([pr.priceArs, pr.priceUsd, pr.stock], ['399.00', '1.00', 367]);
    const d = productEmbed(pr).toJSON().description!;
    assert.match(d, /ARS\$399\.00/);
    assert.match(d, /\$1\.00 USD/);
    assert.match(d, /Stock: \*\*367\*\*/);
  });

  it('valida los datos', () => {
    const w = makeWorld();
    const p = createProduct(w.ctx, G);
    expectGameError(() => updateProductTexts(w.ctx, G, p.id, { ...texts, title: '' }), /título/);
    expectGameError(() => updateProductTexts(w.ctx, G, p.id, { ...texts, imageUrl: 'javascript:alert(1)' }), /https/);
    expectGameError(() => parseHexColor('rojo'), /color/);
    expectGameError(() => parseStock('-5'), /stock/);
    assert.equal(parseStock(''), null);
    assert.equal(parseStock('1.000'), 1000);
    // Otro servidor no ve ni toca el producto.
    expectGameError(() => getProduct(w.ctx, '100000000000000099', p.id), /no existe/);
  });

  it('límite de productos por servidor y borrar', () => {
    const w = makeWorld();
    for (let i = 0; i < SHOP_LIMITS.products; i++) createProduct(w.ctx, G);
    expectGameError(() => createProduct(w.ctx, G), /Máximo/);
    deleteProduct(w.ctx, G, listProducts(w.ctx, G)[0].id);
    assert.equal(listProducts(w.ctx, G).length, SHOP_LIMITS.products - 1);
  });
});

describe('tienda: tickets', () => {
  it('un ticket por producto, máximo 3 abiertos, y numeración por servidor', () => {
    const w = makeWorld();
    const ids = [1, 2, 3, 4].map(() => createProduct(w.ctx, G).id);
    const a = reserveTicket(w.ctx, G, U, ids[0]);
    assert.equal(a.existing, false);
    assert.equal(a.ticket.number, 1);
    assert.equal(reserveTicket(w.ctx, G, U, ids[0]).existing, true, 'el mismo producto reutiliza el ticket');
    reserveTicket(w.ctx, G, U, ids[1]);
    reserveTicket(w.ctx, G, U, ids[2]);
    expectGameError(() => reserveTicket(w.ctx, G, U, ids[3]), /3 tickets/);
    assert.equal(reserveTicket(w.ctx, G, U2, ids[3]).ticket.number, 4);
    closeTicket(w.ctx, a.ticket.id, U);
    assert.equal(openTicketsOf(w.ctx, G, U).length, 2);
  });

  it('sin stock no abre tickets; vender descuenta una vez y nunca deja negativo', () => {
    const w = makeWorld();
    const p = createProduct(w.ctx, G);
    updateProductPrice(w.ctx, G, p.id, { ars: '', usd: '', stock: '1' });
    const t = reserveTicket(w.ctx, G, U, p.id).ticket;
    setTicketChannel(w.ctx, t.id, '300000000000000001');
    const r = markSold(w.ctx, G, t.id);
    assert.equal(r.product!.stock, 0);
    expectGameError(() => markSold(w.ctx, G, t.id), /ya está marcado/);
    expectGameError(() => reserveTicket(w.ctx, G, U2, p.id), /stock/);
    const t2 = reserveTicket(w.ctx, G, U, p.id); // el de U sigue abierto: se reutiliza
    assert.equal(t2.existing, true);
  });

  it('configuración de tickets', () => {
    const w = makeWorld();
    saveShopConfig(w.ctx, G, { categoryId: '300000000000000005', staffRoleId: '300000000000000006' });
    assert.deepEqual(getShopConfig(w.ctx, G), { categoryId: '300000000000000005', staffRoleId: '300000000000000006', logChannelId: null });
    expectGameError(() => saveShopConfig(w.ctx, G, { logChannelId: 'nope' }), /inválido/);
  });
});
