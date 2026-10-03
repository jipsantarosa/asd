import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COMMANDS, findCommand } from '../src/discord/commands';

describe('comandos', () => {
  it('ningún nombre ni alias está repetido (si no, el registro de comandos falla al importar)', () => {
    const seen = new Set<string>();
    for (const c of COMMANDS) {
      for (const n of [c.name, ...c.aliases]) {
        assert.ok(!seen.has(n), `repetido: ${n}`);
        seen.add(n);
      }
    }
  });

  it('existen los comandos pedidos (casino, juegos, progreso, comunidad y moderación)', () => {
    for (const t of [
      'casino', 'balance', 'daily', 'weekly', 'rescate', 'perfil', 'profile', 'top', 'rank', 'stats', 'history', 'logros', 'fairness', 'torneo', 'tournament',
      'blackjack', 'ruleta', 'slots', 'crash', 'plinko', 'minas', 'pollo', 'globos', 'hilo', 'dragon',
      'steal', 'marry', 'divorce', 'setlang', 'boosttracker', 'anti-webhooks', 'work', 'm', 'avs', 'banners', 'kiss', 'besos', 'voz', 'canal', 'warn', 'timeout', 'kick', 'ban', 'unban', 'modlogs', 'caso', 'automod',
    ]) assert.ok(findCommand(t), `falta ${t}`);
    for (const gone of ['granja', 'pesca', 'mercado', 'inventario', 'autoplay', 'jugar', 'eventos']) assert.equal(findCommand(gone), undefined, `sigue existiendo ${gone}`);
  });

  it('los comandos de barra son válidos para Discord (nombres, descripciones, opciones) y no pasan el límite de 100', () => {
    const slash = COMMANDS.filter((c) => c.data).map((c) => c.data!.toJSON());
    assert.ok(slash.length <= 100, `${slash.length} comandos de barra`);
    for (const j of slash) {
      assert.match(j.name, /^[\p{Ll}\p{N}_-]{1,32}$/u, j.name);
      assert.ok(j.description.length >= 1 && j.description.length <= 100, `${j.name}: descripción de ${j.description.length}`);
      assert.ok((j.options?.length ?? 0) <= 25);
    }
  });
});
