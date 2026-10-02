import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GuildPremiumTier, StickerFormatType } from 'discord.js';
import { cleanEmojiName, cleanStickerName, emojiSlots, expressionUrl, parseCustomEmojis, stickerSlots } from '../src/discord/expressions/steal';

describe('!steal', () => {
  it('encuentra emojis personalizados (estáticos y animados) sin repetir', () => {
    const got = parseCustomEmojis('hola <:pepe:123456789012345678> y <a:baila:223456789012345678> otra vez <:pepe:123456789012345678> 😀 <@123456789012345678>');
    assert.deepEqual(got.map((e) => [e.name, e.animated]), [['pepe', false], ['baila', true]]);
  });

  it('nombres válidos para Discord y lugares según las mejoras del servidor', () => {
    assert.equal(cleanEmojiName('café con leche!'), 'cafe_con_leche_');
    assert.equal(cleanEmojiName('x'), 'emoji_x');
    assert.ok(cleanEmojiName('a'.repeat(50)).length <= 32);
    assert.equal(cleanStickerName('  @hola  '), 'hola');
    assert.equal(emojiSlots(GuildPremiumTier.None), 50);
    assert.equal(emojiSlots(GuildPremiumTier.Tier3), 250);
    assert.equal(stickerSlots(GuildPremiumTier.Tier2), 30);
  });

  it('las imágenes salen solo del CDN de Discord', () => {
    assert.match(expressionUrl({ kind: 'emoji', id: '123456789012345678', name: 'x', animated: true }), /^https:\/\/cdn\.discordapp\.com\/emojis\/123456789012345678\.gif/);
    assert.match(expressionUrl({ kind: 'sticker', id: '123456789012345678', name: 'x', format: StickerFormatType.PNG, guildId: '1', tags: null }), /^https:\/\/media\.discordapp\.net\/stickers\//);
  });
});
