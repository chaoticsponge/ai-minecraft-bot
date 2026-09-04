'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { SelectionManager, lookVector } = require('../src/controller/selection-manager')
const { LocalIntentCompiler } = require('../src/controller/local-intent')

function selectionBot() {
  const player = { id: 2, type: 'player', position: new Vec3(0, 64, 0), yaw: 0, pitch: 0, height: 1.8, width: 0.6 }
  const target = new Vec3(0, 65, 3)
  return {
    username: 'MineflayerBot',
    entity: { id: 1, position: new Vec3(1, 64, 0) },
    players: { KawaiiSponge: { entity: player } },
    entities: { 1: null, 2: player },
    blockAt: (position) => position.equals(target)
      ? { name: 'stone', type: 4, position, boundingBox: 'block', diggable: true }
      : { name: 'air', type: 0, position, boundingBox: 'empty' }
  }
}

test('selection follows player yaw and resolves usernames case-insensitively', () => {
  assert.ok(lookVector({ yaw: 0, pitch: 0 }).equals(new Vec3(0, 0, 1)))
  const selection = new SelectionManager(selectionBot())
  const selected = selection.selectedBlock('kawaiisponge')
  assert.equal(selected.block.name, 'stone')
  assert.ok(selected.block.position.equals(new Vec3(0, 65, 3)))
})

test('entity selection uses the sight line and rejects mobs hidden behind a block', () => {
  const bot = selectionBot()
  const visible = { id: 7, name: 'zombie', type: 'mob', position: new Vec3(0, 64, 2), height: 1.8, width: 0.6 }
  const hidden = { id: 8, name: 'skeleton', type: 'mob', position: new Vec3(0, 64, 4), height: 1.8, width: 0.6 }
  bot.entities = { 7: visible, 8: hidden }
  const selection = new SelectionManager(bot)
  assert.equal(selection.selectedEntity('KawaiiSponge').id, 7)
  bot.entities = { 8: hidden }
  assert.equal(selection.selectedEntity('KawaiiSponge'), null)
})

test('local intent compiles crosshair references without an AI request', () => {
  const registry = require('prismarine-registry')('1.21.11')
  const block = { name: 'stone', position: new Vec3(2, 64, 3) }
  const entity = { id: 9, name: 'zombie', type: 'mob' }
  const selection = {
    selectedBlock: () => ({ block }),
    selectedEntity: () => entity
  }
  const bot = { registry, entity: { yaw: 0, position: new Vec3(0, 64, 0) }, entities: {} }
  const local = new LocalIntentCompiler(bot, 8, { list: () => [] }, 1024, selection)
  assert.deepEqual(local.compile('mine that block', 'KawaiiSponge').actions, [
    { type: 'mine_block', x: 2, y: 64, z: 3 }
  ])
  assert.deepEqual(local.compile('open that chest', 'KawaiiSponge').actions, [
    { type: 'interact_block', x: 2, y: 64, z: 3 }
  ])
  assert.deepEqual(local.compile('attack that mob', 'KawaiiSponge').actions, [
    { type: 'attack', entityId: 9 }
  ])
})
