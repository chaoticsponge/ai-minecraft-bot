'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { ActionExecutor } = require('../src/controller/action-executor')
const { Vec3 } = require('vec3')

test('uses the brighter of block and sky light', () => {
  const bot = {
    blockAt: () => ({ light: 0, skyLight: 7 }),
    inventory: { items: () => [] }
  }
  const executor = new ActionExecutor(bot, {})
  assert.equal(executor.lightLevelAt({}), 7)
})

test('recognizes total darkness', () => {
  const bot = {
    blockAt: () => ({ light: 0, skyLight: 0 }),
    inventory: { items: () => [] }
  }
  const executor = new ActionExecutor(bot, {})
  assert.equal(executor.lightLevelAt({}), 0)
})

test('tunnel lighting can make charcoal before crafting torches', async () => {
  const items = []
  const executor = Object.create(ActionExecutor.prototype)
  executor.lastTorchCraftAttemptAt = 0
  executor.bot = { inventory: { items: () => items } }
  executor.inventoryCount = (name) => items.filter((item) => item.name === name).reduce((n, item) => n + item.count, 0)
  executor.toolManager = {
    makeCharcoal: async () => { items.push({ name: 'charcoal', count: 1 }); return true },
    ensureSticks: async () => { items.push({ name: 'stick', count: 1 }); return true },
    craftItem: async () => { items.push({ name: 'torch', count: 4 }); return true }
  }
  assert.equal(await executor.ensureTunnelTorches(new AbortController().signal), true)
  assert.equal(executor.inventoryCount('torch'), 4)
})

test('excavates four blocks of vertical staircase clearance', async () => {
  const bot = {
    blockAt: (position) => ({
      name: 'stone', boundingBox: 'block', diggable: true, position
    }),
    inventory: { items: () => [] }
  }
  const executor = new ActionExecutor(bot, {})
  const dug = []
  executor.digTunnelBlock = async (position) => dug.push(position.y)
  await executor.excavateMiningStep(new Vec3(0, 20, 0), new AbortController().signal, 4)
  assert.deepEqual(dug, [23, 22, 21, 20])
})

test('clears a bounded stack of falling gravel from a tunnel cell', async () => {
  let gravelRemaining = 2
  const bot = {
    blockAt: (position) => {
      if (position.y === 19) return { name: 'stone', boundingBox: 'block', position }
      if (position.y === 21 && gravelRemaining > 0) {
        return { name: 'gravel', boundingBox: 'block', position }
      }
      return { name: 'air', boundingBox: 'empty', position }
    },
    inventory: { items: () => [] }
  }
  const executor = new ActionExecutor(bot, {})
  const dug = []
  executor.digTunnelBlock = async (position) => {
    dug.push(position.y)
    if (position.y === 21 && gravelRemaining > 0) gravelRemaining -= 1
  }
  await executor.excavateMiningStep(new Vec3(0, 20, 0), new AbortController().signal, 2)
  assert.deepEqual(dug, [21, 21, 20])
})

test('repairs a one-block floor gap before advancing the mine', async () => {
  const bot = {
    blockAt: (position) => ({
      name: position.y === 19 ? 'air' : 'stone',
      boundingBox: position.y === 19 ? 'empty' : 'block',
      position
    }),
    inventory: { items: () => [] }
  }
  const executor = new ActionExecutor(bot, {})
  let repaired = null
  executor.repairStairFloor = async (position) => { repaired = position }
  executor.digTunnelBlock = async () => {}
  await executor.excavateMiningStep(new Vec3(0, 20, 0), new AbortController().signal, 2)
  assert.ok(repaired.equals(new Vec3(0, 19, 0)))
})

test('does not report a partially completed strip mine as successful', async () => {
  const bot = {
    entity: { position: new Vec3(0, -59, 0) },
    inventory: { items: () => [] }
  }
  const executor = new ActionExecutor(bot, {})
  executor.runStripTunnel = async () => ({ completed: 14, reason: 'Bot does not have a harvestable tool!' })
  await assert.rejects(
    executor.stripMine({
      type: 'strip_mine', direction: 'south', length: 60, target: 'general',
      branchSpacing: 3, branchDepth: 16
    }, new AbortController().signal),
    (error) => error.category === 'missing_tool' && /14\/60/.test(error.message)
  )
})

test('spaces tunnel torches even while client light updates lag', async () => {
  let placements = 0
  const bot = {
    game: { dimension: 'overworld' },
    entities: {},
    players: {},
    blockAt: (position) => ({
      name: position.y === 9 ? 'air' : 'stone',
      light: 0,
      skyLight: 0,
      boundingBox: position.y === 9 ? 'empty' : 'block',
      position
    }),
    inventory: { items: () => [{ name: 'torch', count: 16 }] },
    equip: async () => {},
    placeBlock: async () => { placements += 1 }
  }
  const executor = new ActionExecutor(bot, {})
  assert.equal(await executor.placeTunnelTorch(new Vec3(0, 9, 0), new AbortController().signal), true)
  assert.equal(await executor.placeTunnelTorch(new Vec3(1, 9, 0), new AbortController().signal), false)
  assert.equal(await executor.placeTunnelTorch(new Vec3(8, 9, 0), new AbortController().signal), true)
  assert.equal(placements, 2)
})

test('scheduled tunnel lighting does not depend on a stale high light value', async () => {
  let placements = 0
  const bot = {
    game: { dimension: 'overworld' },
    entities: {},
    players: {},
    blockAt: (position) => ({
      name: position.y === 9 ? 'air' : 'stone',
      light: 15,
      skyLight: 0,
      boundingBox: position.y === 9 ? 'empty' : 'block',
      position
    }),
    inventory: { items: () => [{ name: 'torch', count: 16 }] },
    equip: async () => {},
    placeBlock: async () => { placements += 1 }
  }
  const executor = new ActionExecutor(bot, {})
  assert.equal(await executor.placeTunnelTorch(
    new Vec3(8, 9, 0),
    new AbortController().signal,
    { force: true }
  ), true)
  assert.equal(placements, 1)
})

test('falls back to another excavated floor position for tunnel torches', async () => {
  let placedOn = null
  const blocked = new Vec3(8, 9, 0)
  const fallback = new Vec3(7, 9, 0)
  const bot = {
    game: { dimension: 'overworld' },
    entities: {},
    players: {},
    blockAt: (position) => ({
      name: position.equals(blocked) ? 'stone' : (position.y === 9 ? 'air' : 'stone'),
      light: 0,
      skyLight: 0,
      boundingBox: position.equals(blocked) || position.y !== 9 ? 'block' : 'empty',
      position
    }),
    inventory: { items: () => [{ name: 'torch', count: 16 }] },
    equip: async () => {},
    placeBlock: async (support) => { placedOn = support.position }
  }
  const executor = new ActionExecutor(bot, {})
  assert.equal(await executor.placeTunnelTorch(
    blocked,
    new AbortController().signal,
    { fallbackPositions: [fallback] }
  ), true)
  assert.ok(placedOn.equals(fallback.offset(0, -1, 0)))
})

test('scheduled lighting respects torches already present in the tunnel', async () => {
  const registry = require('prismarine-registry')('1.21.11')
  const existing = new Vec3(3, 9, 0)
  let placements = 0
  const bot = {
    registry,
    game: { dimension: 'overworld' }, entities: {}, players: {},
    entity: { position: new Vec3(8, 9, 0) },
    findBlocks: () => [existing],
    blockAt: (position) => ({
      name: position.equals(existing) ? 'torch' : (position.y === 9 ? 'air' : 'stone'),
      type: position.equals(existing) ? registry.blocksByName.torch.id : 1,
      light: 0, skyLight: 0,
      boundingBox: position.y === 9 ? 'empty' : 'block', position
    }),
    inventory: { items: () => [{ name: 'torch', count: 16 }] },
    equip: async () => {}, placeBlock: async () => { placements += 1 }
  }
  const executor = new ActionExecutor(bot, {})
  assert.equal(await executor.placeTunnelTorch(
    new Vec3(8, 9, 0), new AbortController().signal, { force: true }
  ), false)
  assert.equal(placements, 0)
})

test('a delayed placement acknowledgement does not create a duplicate fallback torch', async () => {
  const target = new Vec3(8, 9, 0)
  const fallback = new Vec3(7, 9, 0)
  let placed = false
  let attempts = 0
  const bot = {
    game: { dimension: 'overworld' }, entities: {}, players: {},
    blockAt: (position) => ({
      name: placed && position.equals(target) ? 'torch' : (position.y === 9 ? 'air' : 'stone'),
      light: 0, skyLight: 0,
      boundingBox: position.y === 9 ? 'empty' : 'block', position
    }),
    inventory: { items: () => [{ name: 'torch', count: 16 }] },
    equip: async () => {},
    placeBlock: async () => {
      attempts += 1
      placed = true
      throw new Error('blockUpdate acknowledgement timed out')
    }
  }
  const executor = new ActionExecutor(bot, {})
  assert.equal(await executor.placeTunnelTorch(
    target, new AbortController().signal, { fallbackPositions: [fallback] }
  ), true)
  assert.equal(attempts, 1)
})
