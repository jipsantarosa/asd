import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { backupNow } from '../src/db/backup';
import { runMigrations } from '../src/db/migrations';
import { openDatabase } from '../src/db/sqlite';

describe('copias de seguridad', () => {
  it('genera una copia consistente por día y conserva solo las últimas 7', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valle-bk-'));
    const file = path.join(dir, 'valle.db');
    const db = openDatabase(file);
    runMigrations(db, 0);
    db.run("INSERT INTO kiss_pairs (guild_id, user_a, user_b, count, last_at) VALUES ('g', 'a', 'b', 9, 0)");
    const first = backupNow(db, file, 7, new Date('2026-10-01T12:00:00Z'))!;
    assert.ok(fs.existsSync(first));
    assert.equal(backupNow(db, file, 7, new Date('2026-10-01T18:00:00Z')), first, 'una sola copia por día');
    const copy = openDatabase(first);
    assert.equal(copy.get<{ count: number }>('SELECT count FROM kiss_pairs')!.count, 9, 'la copia tiene los datos');
    copy.close();
    for (let d = 2; d <= 10; d++) backupNow(db, file, 7, new Date(`2026-10-${String(d).padStart(2, '0')}T12:00:00Z`));
    const kept = fs.readdirSync(path.join(dir, 'backups')).sort();
    assert.equal(kept.length, 7);
    assert.equal(kept[0], 'valle-2026-10-04.db', 'se borran las más viejas');
    db.close();
    assert.equal(backupNow(db, ':memory:'), null);
  });
});
