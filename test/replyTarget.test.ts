import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildContext } from '../src/discord/commands/types';

/** Discord simulado: solo lo que usa buildContext para resolver personas. */
function fake(args: string[], replyTo: string | null) {
  const member = (id: string) => ({ id, user: { id, bot: false }, displayName: `m${id}` });
  const guild = { members: { fetch: async (id: string) => member(id) } };
  const self = { ...member('100000000000000001'), guild };
  const replied = replyTo ? { author: { id: replyTo }, member: member(replyTo) } : null;
  let fetches = 0;
  const message = {
    reference: replyTo ? { messageId: '900000000000000001' } : null,
    fetchReference: async () => { fetches += 1; return replied; },
  };
  const app = { client: { users: { fetch: async (id: string) => ({ id }) } } };
  const c = buildContext({ app: app as never, member: self as never, viewer: {} as never, prefix: '!', message: message as never, args });
  return { c, fetches: () => fetches };
}

describe('responder a alguien con un comando', () => {
  it('"!kiss" respondiendo a un mensaje apunta al autor de ese mensaje (una sola búsqueda)', async () => {
    const { c, fetches } = fake([], '200000000000000002');
    assert.equal((await c.member_('usuario', 0))?.id, '200000000000000002');
    assert.equal((await c.user_('usuario', 0))?.id, '200000000000000002');
    assert.equal(fetches(), 1);
  });

  it('una mención explícita tiene prioridad sobre la respuesta', async () => {
    const { c } = fake(['<@300000000000000003>'], '200000000000000002');
    assert.equal((await c.member_('usuario', 0))?.id, '300000000000000003');
  });

  it('si en esa posición hay otra cosa (p. ej. un motivo), no se usa la respuesta', async () => {
    const { c } = fake(['spam'], '200000000000000002');
    assert.equal(await c.member_('usuario', 0), null);
  });

  it('sin responder y sin mención, no hay persona', async () => {
    const { c } = fake([], null);
    assert.equal(await c.member_('usuario', 0), null);
  });
});
