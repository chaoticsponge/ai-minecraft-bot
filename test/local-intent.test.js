'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { LocalIntentCompiler, facingFromYaw, parseQuantityAndThing } = require('../src/controller/local-intent')

function compiler(yaw = 0) {
  const registry = require('prismarine-registry')('1.21.11')
  const bot = { registry, entity: { yaw, position: new Vec3(10.8, 64, 20.2) } }
  return new LocalIntentCompiler(bot, 8, { list: () => ['starter_home'] })
}

test('parses stack and numeric quantities conservatively', () => {
  assert.deepEqual(parseQuantityAndThing('a stack of oak logs'), { quantity: 64, thing: 'oak logs' })
  assert.deepEqual(parseQuantityAndThing('30 diamonds'), { quantity: 30, thing: 'diamonds' })
  assert.deepEqual(parseQuantityAndThing('a stone pickaxe'), { quantity: 1, thing: 'stone pickaxe' })
})

test('compiles common acquisition and ore goals without AI', () => {
  const local = compiler()
  const wood = local.compile('get me a stack of wood', 'KawaiiSponge')
  assert.deepEqual(wood.actions, [{ type: 'acquire_item', item: 'any_log', quantity: 64 }])
  assert.deepEqual(wood.completion, { type: 'inventory_count', item: 'any_log', quantity: 64 })
  assert.deepEqual(local.compile('collect 16 oak logs', 'KawaiiSponge').actions, [
    { type: 'acquire_item', item: 'oak_log', quantity: 16 }
  ])

  const tool = local.compile('make me a stone pickaxe', 'KawaiiSponge')
  assert.deepEqual(tool.actions, [{ type: 'acquire_item', item: 'stone_pickaxe', quantity: 1 }])

  const diamonds = local.compile('get 30 diamonds', 'KawaiiSponge')
  assert.equal(diamonds.actions[0].type, 'mine_resource')
  assert.equal(diamonds.actions[0].quantity, 30)
  assert.deepEqual(diamonds.completion, { type: 'resource_count', resource: 'diamond', quantity: 30 })
})

test('compiles long local strip mines up to the autonomous safety limit', () => {
  const local = compiler()
  const plan = local.compile('start a stripmine here for 500 blocks', 'KawaiiSponge')
  assert.deepEqual(plan.actions, [{
    type: 'strip_mine', direction: 'south', length: 500,
    target: 'general', branchSpacing: 3, branchDepth: 16
  }])
})

test('compiles strip-mine continuation and resource-level follow-ups without AI', () => {
  const local = compiler()
  assert.deepEqual(local.compile('continue the strip mine', 'KawaiiSponge').actions, [{
    type: 'strip_mine', direction: 'south', length: 64,
    target: 'general', branchSpacing: 3, branchDepth: 16
  }])
  assert.deepEqual(local.compile('extend the strip mine by 120 blocks for diamonds', 'KawaiiSponge').actions, [{
    type: 'strip_mine', direction: 'south', length: 120,
    target: 'diamond', branchSpacing: 3, branchDepth: 16
  }])

  const resource = local.compile('create a strip mine here and get 30 diamonds', 'KawaiiSponge')
  assert.deepEqual(resource.actions, [{
    type: 'mine_resource', resource: 'diamond', quantity: 30,
    direction: 'south', branchSpacing: 3, branchDepth: 16
  }])
  assert.deepEqual(resource.completion, { type: 'resource_count', resource: 'diamond', quantity: 30 })

  assert.deepEqual(local.compile('make a stairway to diamond level', 'KawaiiSponge').actions, [{
    type: 'staircase_to', target: 'diamond', direction: 'south'
  }])
})

test('compiles maintained tool sets and persistent following', () => {
  const local = compiler()
  const tools = local.compile('get me iron tools', 'KawaiiSponge')
  assert.deepEqual(tools.actions.map((action) => action.item), [
    'iron_pickaxe', 'iron_axe', 'iron_shovel', 'iron_hoe'
  ])
  assert.deepEqual(tools.completion, { type: 'tool_set', material: 'iron' })

  const follow = local.compile('follow me', 'KawaiiSponge')
  assert.deepEqual(follow.actions, [{ type: 'follow', player: 'KawaiiSponge' }])
  assert.deepEqual(follow.completion, { type: 'persistent' })

  const guard = local.compile('guard me', 'KawaiiSponge')
  assert.deepEqual(guard.actions, [{ type: 'follow', player: 'KawaiiSponge' }])
  assert.deepEqual(guard.completion, { type: 'persistent' })
})

test('locally targets the nearest explicitly requested hostile', () => {
  const local = compiler()
  local.bot.entities = {
    7: { id: 7, name: 'zombie', type: 'mob', position: new Vec3(14, 64, 23) },
    8: { id: 8, name: 'zombie', type: 'mob', position: new Vec3(11, 64, 23) }
  }
  assert.deepEqual(local.compile('kill the nearest zombie', 'KawaiiSponge').actions, [
    { type: 'attack', entityId: 8 }
  ])
})

test('compiles landmarks, sleeping, and farming without AI', () => {
  const local = compiler()
  assert.deepEqual(local.compile('this is my home', 'KawaiiSponge').actions, [
    { type: 'remember_location', name: 'home' }
  ])
  assert.deepEqual(local.compile('go home', 'KawaiiSponge').actions, [
    { type: 'go_to_location', name: 'home' }
  ])
  assert.deepEqual(local.compile('get back to the surface', 'KawaiiSponge').actions, [
    { type: 'return_to_surface' }
  ])
  assert.deepEqual(local.compile('sleep through the night', 'KawaiiSponge').actions, [
    { type: 'sleep' }
  ])
  assert.deepEqual(local.compile('harvest and replant wheat', 'KawaiiSponge').actions, [
    { type: 'farm', crop: 'wheat', radius: 16 }
  ])
  assert.deepEqual(local.compile('create a wheat farm here', 'KawaiiSponge').actions, [
    { type: 'create_farm', crop: 'wheat', x: 10, y: 64, z: 23, radius: 2 }
  ])
})

test('anchors local schematic builds in the bot facing direction', () => {
  const local = compiler(0)
  assert.equal(facingFromYaw(0), 'south')
  const build = local.compile('build the starter home here', 'KawaiiSponge')
  assert.deepEqual(build.actions[0], { type: 'collect_build_materials', schematic: 'starter_home' })
  assert.deepEqual(build.actions[1], {
    type: 'build_schematic', schematic: 'starter_home', x: 10, y: 64, z: 22, facing: 'south'
  })
  const materials = local.compile('collect materials for the starter home', 'KawaiiSponge')
  assert.deepEqual(materials.actions, [{ type: 'collect_build_materials', schematic: 'starter_home' }])
  assert.deepEqual(local.compile('repair the starter home', 'KawaiiSponge').actions, [
    { type: 'repair_schematic', schematic: 'starter_home' }
  ])
})

test('schematic builds prefer the requesting player facing over incidental bot yaw', () => {
  const local = compiler(0)
  local.bot.players = { KawaiiSponge: { entity: { yaw: -Math.PI / 2 } } }
  const build = local.compile('build the starter home here', 'KawaiiSponge')
  assert.deepEqual(build.actions[1], {
    type: 'build_schematic', schematic: 'starter_home', x: 12, y: 64, z: 20, facing: 'east'
  })
})

test('large schematic builds stream supplies instead of collecting everything first', () => {
  const local = compiler(0)
  local.blueprints.load = () => ({})
  local.blueprints.materials = () => Object.fromEntries(
    Array.from({ length: 31 }, (_, index) => [`test_material_${index}`, 1])
  )
  assert.deepEqual(local.compile('build the starter home here', 'KawaiiSponge').actions, [{
    type: 'build_schematic', schematic: 'starter_home', x: 10, y: 64, z: 22, facing: 'south'
  }])
})

test('falls back to AI for ambiguous conversation', () => {
  assert.equal(compiler().compile('do something useful around here', 'KawaiiSponge'), null)
})

test('answers simple social whispers without invoking the AI', () => {
  const local = compiler()
  assert.deepEqual(local.compile('hi', 'KawaiiSponge').actions, [
    { type: 'say', message: 'Hi KawaiiSponge!' }
  ])
  assert.equal(local.compile('thanks!', 'KawaiiSponge').actions[0].message, "You're welcome.")
  assert.match(local.compile('what can you do?', 'KawaiiSponge').actions[0].message, /gather, craft, mine/)
})

test('compiles explicit nearby storage requests without AI', () => {
  const local = compiler()
  assert.deepEqual(local.compile('put 32 cobblestone in the nearest chest', 'KawaiiSponge').actions, [
    { type: 'deposit', item: 'cobblestone', quantity: 32 }
  ])
  assert.deepEqual(local.compile('take a stack of torches from the barrel', 'KawaiiSponge').actions, [
    { type: 'withdraw', item: 'torch', quantity: 64 }
  ])
})
