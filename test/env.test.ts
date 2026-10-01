import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clientIdFromToken } from '../src/tokenId';

describe('CLIENT_ID opcional', () => {
  it('saca el ID de la aplicación de la primera parte del token', () => {
    const id = '1368123456789012345';
    const first = Buffer.from(id).toString('base64').replace(/=+$/, ''); // los tokens no llevan relleno "="
    assert.equal(clientIdFromToken(`${first}.GaBcDe.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`), id);
  });

  it('acepta IDs de 17 a 20 dígitos y base64 "url" (- y _)', () => {
    for (const id of ['80351110224678912', '123456789012345678', '12345678901234567890']) {
      const first = Buffer.from(id).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
      assert.equal(clientIdFromToken(`${first}.a.b`), id);
    }
  });

  it('con un token raro devuelve null (y el bot pide CLIENT_ID con un mensaje claro)', () => {
    assert.equal(clientIdFromToken('no-es-un-token'), null);
    assert.equal(clientIdFromToken(''), null);
    assert.equal(clientIdFromToken(`${Buffer.from('hola').toString('base64')}.a.b`), null);
  });
});
