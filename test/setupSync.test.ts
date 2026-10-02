import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LOG_CHANNELS, normalizeChannelName, planSetup, type ExistingChannel, type LogConfig } from '../src/services/logConfig';
import { planVoiceSync, type VoiceExisting } from '../src/services/tempVoice';
import { getSetupVersion, LAYOUT_VERSIONS, markSetupVersion, outdatedGuilds } from '../src/services/setupVersions';
import { G, makeWorld } from './helpers';

const empty: LogConfig = { categoryId: null, staffRoleId: null, logSentMessages: true, channels: {} };

describe('sincronizar registros (/setup)', () => {
  it('reconoce los canales aunque cambien emojis, mayúsculas o acentos', () => {
    assert.equal(normalizeChannelName('📝・Mensajes'), 'mensajes');
    assert.equal(normalizeChannelName('🛡️・moderación'), 'moderacion');
    assert.equal(normalizeChannelName('🚪・entradas-salidas'), 'entradas-salidas');
  });

  it('base perdida y nombres viejos: adopta todo (sin crear duplicados) y marca lo que sobra', () => {
    const existing: ExistingChannel[] = [
      { id: 'cat', name: 'REGISTROS', type: 'category', parentId: null },
      { id: 'cat2', name: '📋 Registros', type: 'category', parentId: null },
      { id: 'm', name: 'mensajes', type: 'text', parentId: 'cat' },
      { id: 'e', name: 'entradas', type: 'text', parentId: 'cat' }, // nombre de una versión anterior
      { id: 's', name: '🤖・sistema-bot', type: 'text', parentId: 'cat2' }, // en la otra categoría de registros
      { id: 'm2', name: '📝・mensajes', type: 'text', parentId: 'cat2' }, // duplicado
      { id: 'general', name: 'mensajes', type: 'text', parentId: null }, // fuera de las categorías: no se toca
    ];
    const plan = planSetup(empty, existing);
    assert.deepEqual(plan.category, { kind: 'adopt', id: 'cat' });
    const by = Object.fromEntries(plan.steps.map((s) => [s.key, s]));
    assert.deepEqual(by.mensajes, { kind: 'adopt', key: 'mensajes', channelId: 'm' });
    assert.deepEqual(by.entradas, { kind: 'adopt', key: 'entradas', channelId: 'e' });
    assert.deepEqual(by.sistema, { kind: 'adopt', key: 'sistema', channelId: 's' });
    assert.equal(plan.steps.filter((s) => s.kind === 'create').length, LOG_CHANNELS.length - 3);
    assert.deepEqual(plan.duplicates, ['m2']);
    assert.deepEqual(plan.duplicateCategories, ['cat2']);
  });

  it('con todo guardado no hay sobrantes', () => {
    const existing: ExistingChannel[] = [{ id: 'cat', name: '📋 Registros', type: 'category', parentId: null }];
    const channels: LogConfig['channels'] = {};
    LOG_CHANNELS.forEach((c, i) => {
      existing.push({ id: `c${i}`, name: c.name, type: 'text', parentId: 'cat' });
      channels[c.key] = `c${i}`;
    });
    const plan = planSetup({ ...empty, categoryId: 'cat', channels }, existing);
    assert.ok(plan.steps.every((s) => s.kind === 'keep'));
    assert.deepEqual(plan.duplicates, []);
    assert.deepEqual(plan.duplicateCategories, []);
  });
});

describe('sincronizar voz temporal (/voz)', () => {
  const v = (id: string, name: string, type: VoiceExisting['type'], parentId: string | null, members = 0): VoiceExisting => ({ id, name, type, parentId, members });

  it('base perdida: adopta categoría, hub e interfaz por nombre y marca huérfanos vacíos', () => {
    const existing = [
      v('cat', 'Canales temporales', 'category', null),
      v('hub', 'Crear canal', 'voice', 'cat'),
      v('if', 'interfaz', 'text', 'cat'),
      v('if2', '🎛️・interfaz', 'text', 'cat'), // panel repetido
      v('old', 'Sala de Juan', 'voice', 'cat'), // sala temporal huérfana y vacía
      v('busy', 'Sala de Ana', 'voice', 'cat', 2), // huérfana pero con gente: no se toca
      v('live', 'Sala de Leo', 'voice', 'cat'), // registrada como temporal: no se toca
      v('afuera', 'Crear canal', 'voice', null), // fuera de la categoría: no se toca
    ];
    const plan = planVoiceSync({ categoryId: null, hubChannelId: null, interfaceChannelId: null }, existing, new Set(['live']));
    assert.deepEqual(plan.category, { kind: 'adopt', id: 'cat' });
    assert.deepEqual(plan.hub, { kind: 'adopt', id: 'hub' });
    assert.equal(plan.iface.kind, 'adopt');
    const usedIface = (plan.iface as { id: string }).id;
    assert.deepEqual(plan.duplicates.sort(), ['old', usedIface === 'if' ? 'if2' : 'if'].sort());
  });

  it('con IDs guardados los conserva aunque estén renombrados', () => {
    const existing = [v('cat', 'Mis voces', 'category', null), v('hub', 'Entrá acá', 'voice', 'cat'), v('if', 'botones', 'text', 'cat')];
    const plan = planVoiceSync({ categoryId: 'cat', hubChannelId: 'hub', interfaceChannelId: 'if' }, existing, new Set());
    assert.deepEqual([plan.category, plan.hub, plan.iface], [{ kind: 'keep', id: 'cat' }, { kind: 'keep', id: 'hub' }, { kind: 'keep', id: 'if' }]);
    assert.deepEqual(plan.duplicates, []);
  });
});

describe('versión del diseño', () => {
  it('los servidores ya configurados con versión vieja se sincronizan una vez', () => {
    const w = makeWorld();
    w.ctx.db.run("INSERT INTO log_config (guild_id, category_id, staff_role_id, log_sent_messages, updated_at) VALUES (?, 'cat', NULL, 1, 0)", G);
    assert.deepEqual(outdatedGuilds(w.ctx, 'logs'), [G]);
    assert.deepEqual(outdatedGuilds(w.ctx, 'voice'), [], 'sin voz configurada no se toca');
    markSetupVersion(w.ctx, G, 'logs');
    assert.equal(getSetupVersion(w.ctx, G, 'logs'), LAYOUT_VERSIONS.logs);
    assert.deepEqual(outdatedGuilds(w.ctx, 'logs'), []);
  });
});
