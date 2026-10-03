import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { otherInstance, STALE_MS, writeLock } from '../src/instanceLock';

describe('una sola copia del bot', () => {
  const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-')), '.bot.lock');

  it('sin archivo, o con el de esta misma copia, puede arrancar', () => {
    const f = file();
    assert.equal(otherInstance(f, 1000, 111), null);
    writeLock(f, 1000, 111);
    assert.equal(otherInstance(f, 2000, 111), null);
  });

  it('si otra copia está viva y latiendo, no arranca', () => {
    const f = file();
    writeLock(f, 1000, 222);
    assert.equal(otherInstance(f, 1000 + 10_000, 111, () => true), 222);
  });

  it('si la otra copia se cerró o dejó de latir, arranca igual', () => {
    const f = file();
    writeLock(f, 1000, 222);
    assert.equal(otherInstance(f, 1000 + 10_000, 111, () => false), null);
    assert.equal(otherInstance(f, 1000 + STALE_MS + 1, 111, () => true), null);
    fs.writeFileSync(f, 'basura');
    assert.equal(otherInstance(f, 1000, 111, () => true), null);
  });
});
