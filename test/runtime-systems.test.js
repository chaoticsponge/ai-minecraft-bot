'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { Vec3 } = require('vec3')
const { BlueprintLoader } = require('../src/controller/blueprint-loader')
const { BlockTracker } = require('../src/controller/block-tracker')
const { CheckpointStore } = require('../src/controller/checkpoint-store')
const { Task } = require('../src/tasks/task')
const { TaskRunner } = require('../src/tasks/task-runner')
const { AcquireItemTask, SMELTING } = require('../src/tasks/acquire-item-task')
const { ToolManager } = require('../src/controller/tool-manager')
const { RecoveryManager, classifyFailure } = require('../src/tasks/recovery-manager')
const { InventoryTracker } = require('../src/controller/inventory-tracker')
const { EntityTracker } = require('../src/controller/entity-tracker')
const { InventoryPolicy } = require('../src/controller/inventory-policy')
const { ContainerTracker } = require('../src/controller/container-tracker')
const { ActionExecutor } = require('../src/controller/action-executor')
const { EventMonitor, nearestThreat, suffocatingBlock } = require('../src/controller/event-monitor')
const { installToolCompatibility, safeEnchantments } = require('../src/controller/tool-compatibility')
const { LandmarkStore } = require('../src/controller/landmark-store')
const { BlueprintTask } = require('../src/tasks/blueprint-task')
const { BotController } = require('../src/controller/bot-controller')
const { itemForBlock } = require('../scripts/convert-schem')

test('validates and counts the starter home blueprint', () => {
  const loader = new BlueprintLoader(path.resolve(__dirname, '../schematics'))
  const blueprint = loader.load('starter_home')
  assert.deepEqual(loader.materials(blueprint), { any_planks: 168 })
  assert.throws(() => loader.load('../starter_home'))
})

test('blueprint materials count stacked decorative block items', () => {
  const loader = new BlueprintLoader(path.resolve(__dirname, '../schematics'))
  const materials = loader.materials(loader.load('elven_house_2'))
  assert.equal(materials.white_candle, 3)
  assert.equal(materials.sea_pickle, 3)
  assert.equal(materials.turtle_egg, 4)
  assert.equal(materials.wildflowers, 8)
  assert.ok(materials.mangrove_slab >= 2)
})

test('blueprint double slabs consume two slab items', () => {
  const loader = new BlueprintLoader('.')
  assert.equal(loader.itemCount({
    block: 'mangrove_slab', properties: { type: 'double' }
  }), 2)
})

test('blueprint materials count one item for two-block doors and beds', () => {
  const loader = new BlueprintLoader('.')
  const blueprint = {
    layers: [
      { y: 0, rows: ['DB'] },
      { y: 1, rows: ['D.'] }
    ],
    palette: {
      '.': 'air',
      D: { block: 'oak_door', properties: { half: 'lower' } },
      B: { block: 'green_bed', properties: { part: 'foot', facing: 'east' } }
    }
  }
  // Represent the generated halves explicitly, as a converted .schem does.
  blueprint.layers[1].rows[0] = 'UH'
  blueprint.palette.U = { block: 'oak_door', properties: { half: 'upper' } }
  blueprint.palette.H = { block: 'green_bed', properties: { part: 'head', facing: 'east' } }
  assert.deepEqual(loader.materials(blueprint), { oak_door: 1, green_bed: 1 })
})

test('blueprint placement orders door and bed owner halves before generated halves', () => {
  const task = new BlueprintTask({}, {}, {})
  assert.ok(task.buildPlacementRank({ block: 'oak_door', properties: { half: 'lower' } }) <
    task.buildPlacementRank({ block: 'oak_door', properties: { half: 'upper' } }))
  assert.ok(task.buildPlacementRank({ block: 'green_bed', properties: { part: 'foot' } }) <
    task.buildPlacementRank({ block: 'green_bed', properties: { part: 'head' } }))
})

test('schematic repair rebuilds a missing generated bed half from the foot', () => {
  const foot = new Vec3(4, 64, 7)
  const head = foot.offset(1, 0, 0)
  const task = new BlueprintTask({
    blockAt: (position) => position.equals(foot)
      ? { name: 'green_bed', getProperties: () => ({ facing: 'east', part: 'foot' }) }
      : { name: 'air', boundingBox: 'empty', getProperties: () => ({}) }
  }, {}, {})
  const pending = task.pendingPlacements([
    { position: foot, x: 0, y: 0, z: 0, block: 'green_bed', material: 'green_bed', properties: { facing: 'east', part: 'foot' } },
    { position: head, x: 1, y: 0, z: 0, block: 'green_bed', material: 'green_bed', properties: { facing: 'east', part: 'head' } }
  ])
  assert.equal(pending.length, 1)
  assert.equal(pending[0].position.toString(), foot.toString())
  assert.equal(pending[0].repairCoupled, true)
  assert.equal(pending[0].progressCredit, 1)
  assert.deepEqual(pending[0].coupledPositions.map(String), [head.toString()])
})

test('schematic repair rebuilds a missing upper door from the lower half', () => {
  const lower = new Vec3(2, 70, 3)
  const upper = lower.offset(0, 1, 0)
  const task = new BlueprintTask({
    blockAt: (position) => position.equals(lower)
      ? { name: 'oak_door', getProperties: () => ({ facing: 'south', half: 'lower' }) }
      : { name: 'air', boundingBox: 'empty', getProperties: () => ({}) }
  }, {}, {})
  const pending = task.pendingPlacements([
    { position: lower, x: 0, y: 0, z: 0, block: 'oak_door', material: 'oak_door', properties: { facing: 'south', half: 'lower' } },
    { position: upper, x: 0, y: 1, z: 0, block: 'oak_door', material: 'oak_door', properties: { facing: 'south', half: 'upper' } }
  ])
  assert.equal(pending.length, 1)
  assert.equal(pending[0].position.toString(), lower.toString())
  assert.deepEqual(pending[0].coupledPositions.map(String), [upper.toString()])
})

test('schematic construction defers a block intersecting the bot body', () => {
  const feet = new Vec3(2, 64, 2)
  const head = feet.offset(0, 1, 0)
  const other = new Vec3(3, 65, 2)
  const task = new BlueprintTask({
    entity: { position: feet.clone() },
    blockAt: (position) => ({ name: 'air', boundingBox: 'empty', position, getProperties: () => ({}) })
  }, {}, {})
  const pending = task.pendingPlacements([
    { position: head, x: 0, y: 1, z: 0, block: 'glass_pane', material: 'glass_pane' },
    { position: other, x: 1, y: 1, z: 0, block: 'glass_pane', material: 'glass_pane' }
  ])
  assert.equal(pending[0].position.toString(), other.toString())
  assert.equal(pending[1].position.toString(), head.toString())
})

test('blueprint bed matching verifies head and foot state', () => {
  const task = new BlueprintTask({}, {}, {})
  const block = {
    name: 'green_bed',
    getProperties: () => ({ facing: 'east', part: 'head' })
  }
  assert.equal(task.matchesEntry(block, {
    block: 'green_bed', material: 'green_bed', properties: { facing: 'east', part: 'foot' }
  }), false)
})

test('schematic conversion resolves inventory items for wall-mounted variants', () => {
  assert.equal(itemForBlock('white_wall_banner'), 'white_banner')
  assert.equal(itemForBlock('oak_wall_sign'), 'oak_sign')
  assert.equal(itemForBlock('spruce_wall_hanging_sign'), 'spruce_hanging_sign')
  assert.equal(itemForBlock('skeleton_wall_skull'), 'skeleton_skull')
  assert.equal(itemForBlock('zombie_wall_head'), 'zombie_head')
  assert.equal(itemForBlock('soul_wall_torch'), 'soul_torch')
})

test('block tracker caches scans and cools down unreachable targets', () => {
  class Bot extends EventEmitter {}
  const bot = new Bot()
  bot.entity = { position: new Vec3(0, 64, 0) }
  let scans = 0
  const position = new Vec3(2, 63, 0)
  bot.findBlocks = () => { scans += 1; return [position] }
  bot.blockAt = (at) => ({ type: 1, position: at, boundingBox: 'block' })
  const tracker = new BlockTracker(bot)
  assert.equal(tracker.find([1], 16).length, 1)
  assert.equal(tracker.find([1], 16).length, 1)
  assert.equal(scans, 1)
  tracker.markUnreachable(position, 'no path')
  assert.equal(tracker.find([1], 16).length, 0)
  tracker.shutdown()
})

test('checkpoint store round-trips and clears resumable goals', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-checkpoint-'))
  const store = new CheckpointStore(path.join(directory, 'goal.json'))
  const checkpoint = { requester: 'KawaiiSponge', goal: 'get wood', actionIndex: 1 }
  store.save(checkpoint)
  assert.deepEqual(store.load(), checkpoint)
  store.clear()
  assert.equal(store.load(), null)
  fs.rmSync(directory, { recursive: true })
})

test('landmarks persist named locations and types', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-landmarks-'))
  const file = path.join(directory, 'landmarks.json')
  const store = new LandmarkStore(file)
  store.remember('Home', new Vec3(12.8, 64.2, -3.1), 'overworld', 'base')
  const reloaded = new LandmarkStore(file)
  assert.deepEqual(reloaded.get('home'), {
    name: 'home', type: 'base', dimension: 'overworld', x: 12, y: 64, z: -4,
    updatedAt: reloaded.get('home').updatedAt
  })
  assert.equal(reloaded.forget('HOME'), true)
  assert.equal(new LandmarkStore(file).get('home'), null)
  fs.rmSync(directory, { recursive: true })
})

test('temporary workstations are recovered only after the dropped block returns to inventory', async () => {
  const position = new Vec3(1, 64, 0)
  const items = []
  let present = true
  const manager = new ToolManager({
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => items },
    blockAt: () => present ? { name: 'crafting_table', position } : { name: 'air', position },
    tool: { equipForBlock: async () => {} },
    dig: async () => {
      present = false
      setTimeout(() => items.push({ name: 'crafting_table', count: 1 }), 20)
    }
  })
  assert.equal(await manager.recoverTemporaryBlock(
    position, 'crafting_table', new AbortController().signal
  ), true)
  assert.equal(manager.count('crafting_table'), 1)
})

test('inventory block placement accepts a delayed server acknowledgement after timeout', async () => {
  const feet = new Vec3(0, 64, 0)
  const target = new Vec3(1, 64, 0)
  let placed = false
  let placements = 0
  const manager = new ToolManager({
    entity: { position: feet },
    inventory: { items: () => [{ name: 'chest', count: 1 }] },
    blockAt: (position) => {
      if (position.equals(target)) {
        return placed
          ? { name: 'chest', position, boundingBox: 'block' }
          : { name: 'air', position, boundingBox: 'empty' }
      }
      if (position.equals(target.offset(0, -1, 0))) {
        return { name: 'deepslate', position, boundingBox: 'block' }
      }
      return { name: 'deepslate', position, boundingBox: 'block' }
    },
    equip: async () => {},
    placeBlock: async () => {
      placements += 1
      setTimeout(() => { placed = true }, 25)
      throw new Error('Event blockUpdate did not fire within timeout')
    }
  })
  const block = await manager.placeInventoryBlock('chest', new AbortController().signal)
  assert.equal(block.name, 'chest')
  assert.equal(placements, 1)
})

test('surface return prefers a remembered mine route', async () => {
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    entity: { position: new Vec3(0, -59, 0) },
    game: { dimension: 'overworld' },
    blockAt: () => ({ skyLight: executor.bot.entity.position.y > 60 ? 15 : 0 })
  }
  executor.landmarks = {
    get: () => ({ name: 'last_mine_entrance', x: 10, y: 70, z: 10, dimension: 'overworld' }),
    remember: () => {}
  }
  let usedRoute = false
  executor.goToLocation = async () => {
    usedRoute = true
    executor.bot.entity.position = new Vec3(10, 70, 10)
  }
  const result = await executor.returnToSurface(new AbortController().signal)
  assert.equal(usedRoute, true)
  assert.match(result, /remembered mine route/)
})

test('stateful blueprint palettes validate and rotate facing properties', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-blueprint-'))
  const blueprint = {
    format: 'mineflayer-blueprint-v2', name: 'stateful', size: { x: 1, y: 1, z: 1 },
    palette: { S: { block: 'oak_stairs', properties: { facing: 'south', half: 'bottom' } } },
    layers: [{ y: 0, rows: ['S'] }]
  }
  fs.writeFileSync(path.join(directory, 'stateful.json'), `${JSON.stringify(blueprint)}\n`)
  const loader = new BlueprintLoader(directory)
  assert.deepEqual(loader.blocks(loader.load('stateful'))[0].properties, { facing: 'south', half: 'bottom' })
  const task = new BlueprintTask({}, {}, loader)
  assert.deepEqual(task.rotateProperties({ facing: 'south', half: 'bottom' }, 'east'), {
    facing: 'east', half: 'bottom'
  })
  assert.deepEqual(task.rotateProperties({ axis: 'x', north: 'none', east: 'true', south: 'none', west: 'false' }, 'east'), {
    axis: 'z', north: 'true', east: 'none', south: 'false', west: 'none'
  })
  fs.rmSync(directory, { recursive: true })
})

test('blueprints can carry one item that becomes a different placed block', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-blueprint-item-'))
  const blueprint = {
    format: 'mineflayer-blueprint-v2', name: 'attached', size: { x: 1, y: 1, z: 1 },
    palette: { T: { block: 'wall_torch', item: 'torch', properties: { facing: 'east' } } },
    layers: [{ y: 0, rows: ['T'] }]
  }
  fs.writeFileSync(path.join(directory, 'attached.json'), `${JSON.stringify(blueprint)}\n`)
  const loader = new BlueprintLoader(directory)
  assert.deepEqual(loader.blocks(loader.load('attached'))[0], {
    x: 0, y: 0, z: 0, material: 'torch', block: 'wall_torch', properties: { facing: 'east' }
  })
  assert.deepEqual(loader.materials(loader.load('attached')), { torch: 1 })
  fs.rmSync(directory, { recursive: true })
})

test('schematic repair delegates missing blocks to staged construction at the saved build', async () => {
  const blueprint = {
    anchor: { x: 0, y: 0, z: 0 },
    blocks: [
      { x: 0, y: 0, z: 0, material: 'any_planks' },
      { x: 1, y: 0, z: 0, material: 'any_planks' },
      { x: 2, y: 0, z: 0, material: 'any_planks' }
    ]
  }
  const loader = { load: () => blueprint, blocks: (value) => value.blocks.map((entry) => ({ ...entry })) }
  const bot = {
    game: { dimension: 'overworld' },
    inventory: { items: () => [] },
    blockAt: (position) => {
      if (position.equals(new Vec3(10, 64, 20))) return { name: 'birch_planks', getProperties: () => ({}) }
      if (position.equals(new Vec3(11, 64, 20))) return { name: 'air', getProperties: () => ({}) }
      return { name: 'stone', getProperties: () => ({}) }
    }
  }
  const executor = {
    landmarks: {
      get: () => ({
        name: 'blueprint_starter_home', type: 'blueprint', schematic: 'starter_home',
        dimension: 'overworld', x: 10, y: 64, z: 20, facing: 'south'
      })
    }
  }
  const task = new BlueprintTask(bot, executor, loader)
  const acquired = []
  task.acquire.run = async (material, quantity) => acquired.push({ material, quantity })
  let resumedBuild = null
  task.build = async (action) => { resumedBuild = action; return 'repaired' }
  assert.equal(await task.repair(
    { type: 'repair_schematic', schematic: 'starter_home' },
    new AbortController().signal,
    new Task('sequence', 'repair')
  ), 'repaired')
  assert.deepEqual(acquired, [])
  assert.deepEqual(resumedBuild, {
    type: 'build_schematic', schematic: 'starter_home', x: 10, y: 64, z: 20, facing: 'south'
  })
})

test('schematic builds remember their anchor before construction', () => {
  const remembered = []
  const task = new BlueprintTask(
    { game: { dimension: 'overworld' } },
    { landmarks: { remember: (...args) => remembered.push(args) } },
    {}
  )
  task.rememberStructure({
    type: 'build_schematic', schematic: 'starter_home', x: 10.8, y: 64.2, z: -3.1, facing: 'east'
  })
  assert.equal(remembered[0][0], 'blueprint_starter_home')
  assert.deepEqual(remembered[0][1], new Vec3(10, 64, -4))
  assert.equal(remembered[0][2], 'overworld')
  assert.equal(remembered[0][3], 'blueprint')
  assert.deepEqual(remembered[0][4], { schematic: 'starter_home', facing: 'east' })
})

test('schematic builds recognize and resume an incomplete saved site', () => {
  const blueprint = {
    anchor: { x: 0, y: 0, z: 0 },
    blocks: [0, 1, 2, 3].map((x) => ({ x, y: 0, z: 0, material: 'spruce_planks' }))
  }
  const savedBlocks = new Set(['10, 64, 20', '11, 64, 20', '12, 64, 20'])
  const bot = {
    game: { dimension: 'overworld' },
    blockAt: (position) => ({
      name: savedBlocks.has(`${position.x}, ${position.y}, ${position.z}`) ? 'spruce_planks' : 'air',
      boundingBox: savedBlocks.has(`${position.x}, ${position.y}, ${position.z}`) ? 'block' : 'empty',
      getProperties: () => ({})
    })
  }
  const task = new BlueprintTask(bot, {
    landmarks: { get: () => ({
      type: 'blueprint', schematic: 'test', dimension: 'overworld',
      x: 10, y: 64, z: 20, facing: 'south'
    }) }
  }, { blocks: (value) => value.blocks.map((entry) => ({ ...entry })) })
  const resumed = task.savedPartialBuild({
    type: 'build_schematic', schematic: 'test', x: 0, y: 64, z: 0, facing: 'north'
  }, blueprint)
  assert.deepEqual(
    { x: resumed.x, y: resumed.y, z: resumed.z, facing: resumed.facing },
    { x: 10, y: 64, z: 20, facing: 'south' }
  )
})

test('large schematic construction withdraws one supply stack when carried material runs out', async () => {
  const items = []
  const requests = []
  const bot = {
    registry: { itemsByName: { mangrove_planks: { stackSize: 64 } } },
    inventory: { items: () => items }
  }
  const executor = {
    inventoryPolicy: { freeTrashSlots: async () => 0 },
    tryWithdrawFromNearby: async (material, quantity) => {
      requests.push({ material, quantity })
      items.push({ name: material, count: quantity })
      return quantity
    }
  }
  const task = new BlueprintTask(bot, executor, {})
  assert.equal(await task.ensureBuildSupply(
    'mangrove_planks', 202, new AbortController().signal
  ), 64)
  assert.deepEqual(requests, [{ material: 'mangrove_planks', quantity: 64 }])
})

test('large schematic construction names an exhausted chest supply precisely', async () => {
  const bot = {
    registry: { itemsByName: { lantern: { stackSize: 64 } } },
    inventory: { items: () => [] }
  }
  const task = new BlueprintTask(bot, {
    inventoryPolicy: { freeTrashSlots: async () => 0 },
    tryWithdrawFromNearby: async () => 0
  }, {})
  await assert.rejects(
    task.ensureBuildSupply('lantern', 11, new AbortController().signal),
    /missing build supply lantern/
  )
})

test('schematic construction prioritizes structure and treats decor as optional', async () => {
  const bot = {
    registry: { itemsByName: { cake: { stackSize: 1 } } },
    inventory: { items: () => [] }
  }
  const task = new BlueprintTask(bot, {
    inventoryPolicy: { freeTrashSlots: async () => 0 },
    tryWithdrawFromNearby: async () => 0
  }, {})
  assert.equal(task.buildPhase({ material: 'spruce_planks' }), 0)
  assert.equal(task.buildPhase({ material: 'spruce_door' }), 1)
  assert.equal(task.buildPhase({ material: 'cake' }), 2)
  assert.equal(task.buildPhase({ material: 'green_carpet' }), 2)
  assert.equal(await task.ensureBuildSupply(
    'cake', 1, new AbortController().signal, true
  ), 0)
})

test('schematic resume ignores neighbor-derived state but preserves placed orientation', () => {
  const task = new BlueprintTask({ inventory: { items: () => [] } }, {}, {})
  const wall = {
    name: 'tuff_brick_wall',
    getProperties: () => ({ north: 'low', east: 'none', south: 'tall', west: 'low', up: true })
  }
  assert.equal(task.matchesEntry(wall, {
    material: 'tuff_brick_wall',
    properties: { north: 'tall', east: 'tall', south: 'none', west: 'none', up: false }
  }), true)
  const stair = {
    name: 'stone_brick_stairs',
    getProperties: () => ({ facing: 'south', half: 'bottom', shape: 'straight', waterlogged: false })
  }
  assert.equal(task.matchesEntry(stair, {
    material: 'stone_brick_stairs', properties: { facing: 'south', half: 'bottom', shape: 'inner_left' }
  }), true)
  assert.equal(task.matchesEntry(stair, {
    material: 'stone_brick_stairs', properties: { facing: 'north', half: 'bottom' }
  }), false)
  assert.equal(task.matchesEntry({
    name: 'spruce_trapdoor', getProperties: () => ({ facing: 'north', half: 'top', open: false })
  }, {
    material: 'spruce_trapdoor', properties: { facing: 'north', half: 'top', open: 'true' }
  }), false)
})

test('schematic preflight rejects required solid obstructions but ignores optional decor positions', () => {
  const stone = { name: 'stone', boundingBox: 'block', diggable: true }
  const task = new BlueprintTask({ blockAt: () => stone }, {
    canClearBuildObstruction: () => false
  }, {})
  assert.throws(() => task.preflightBuildSite([
    { material: 'spruce_planks', position: new Vec3(2, 64, 3) },
    { material: 'cake', position: new Vec3(3, 64, 3) }
  ]), /1 required positions.*stone at \(2, 64, 3\)/)
  assert.equal(task.preflightBuildSite([
    { material: 'cake', position: new Vec3(3, 64, 3) }
  ]), true)
})

test('schematic preflight permits a misplaced required material to be reclaimed', () => {
  const task = new BlueprintTask({
    blockAt: (position) => position.x === 0
      ? { name: 'spruce_planks', boundingBox: 'block', diggable: true }
      : { name: 'air', boundingBox: 'empty', diggable: false }
  }, { canClearBuildObstruction: (block) => block.boundingBox === 'empty' }, {})
  assert.equal(task.preflightBuildSite([
    { material: 'stone_bricks', position: new Vec3(0, 64, 0) },
    { material: 'spruce_planks', position: new Vec3(1, 64, 0) }
  ]), true)
})

test('schematic construction retries a target restored after obstruction cleanup', async () => {
  const target = new Vec3(2, 64, 3)
  let solid = true
  let attempts = 0
  const bot = {
    inventory: { items: () => [] },
    blockAt: (position) => solid
      ? { name: 'spruce_slab', boundingBox: 'block', position, diggable: true }
      : { name: 'air', boundingBox: 'empty', position }
  }
  const task = new BlueprintTask(bot, {
    clearBuildObstruction: async () => {
      attempts += 1
      // The first server-side removal appears to succeed and then restores;
      // the second one is durable.
      if (attempts > 1) solid = false
      return true
    }
  }, {})
  assert.equal(await task.clearBuildPosition(
    target, new AbortController().signal, true
  ), true)
  assert.equal(attempts, 2)
})

test('schematic placement raises its floor one block above flat natural terrain', () => {
  const blueprint = {
    anchor: { x: 0, y: 0, z: 0 },
    blocks: [
      { x: 0, y: 0, z: 0, material: 'spruce_planks' },
      { x: 1, y: 0, z: 0, material: 'spruce_planks' },
      { x: 0, y: 1, z: 0, material: 'spruce_planks' }
    ]
  }
  const loader = { blocks: (value) => value.blocks.map((entry) => ({ ...entry })) }
  const bot = {
    blockAt: (position) => position.y === 88
      ? { name: 'dirt', boundingBox: 'block', diggable: true, getProperties: () => ({}) }
      : { name: 'air', boundingBox: 'empty', diggable: false, getProperties: () => ({}) }
  }
  const task = new BlueprintTask(bot, {
    canClearBuildObstruction: (block) => block.boundingBox === 'empty'
  }, loader)
  const resolved = task.resolveBuildPlacement({
    type: 'build_schematic', schematic: 'test', x: 0, y: 88, z: 0, facing: 'south'
  }, blueprint)
  assert.equal(resolved.y, 89)
})

test('schematic placement does not raise past an obstruction above the terrain', () => {
  const blueprint = {
    anchor: { x: 0, y: 0, z: 0 },
    blocks: [
      { x: 0, y: 0, z: 0, material: 'spruce_planks' },
      { x: 0, y: 1, z: 0, material: 'spruce_planks' }
    ]
  }
  const loader = { blocks: (value) => value.blocks.map((entry) => ({ ...entry })) }
  const bot = {
    blockAt: (position) => position.y === 88
      ? { name: 'dirt', boundingBox: 'block', diggable: true, getProperties: () => ({}) }
      : position.y === 90
        ? { name: 'oak_log', boundingBox: 'block', diggable: true, getProperties: () => ({}) }
        : { name: 'air', boundingBox: 'empty', diggable: false, getProperties: () => ({}) }
  }
  const task = new BlueprintTask(bot, {
    canClearBuildObstruction: (block) => block.boundingBox === 'empty'
  }, loader)
  assert.throws(() => task.resolveBuildPlacement({
    type: 'build_schematic', schematic: 'test', x: 0, y: 88, z: 0, facing: 'south'
  }, blueprint), /oak_log at \(0, 90, 0\)/)
})

test('schematic placement deterministically selects the nearest fully flat site', () => {
  const blueprint = {
    size: { x: 1, y: 2, z: 1 }, anchor: { x: 0, y: 0, z: 0 },
    blocks: [
      { x: 0, y: 0, z: 0, material: 'spruce_planks' },
      { x: 0, y: 1, z: 0, material: 'spruce_planks' }
    ]
  }
  const loader = { blocks: (value) => value.blocks.map((entry) => ({ ...entry })) }
  const bot = {
    blockAt: (position) => {
      if (position.x === -4 && position.z === 0) {
        return position.y === 88
          ? { name: 'dirt', boundingBox: 'block', getProperties: () => ({}) }
          : { name: 'air', boundingBox: 'empty', getProperties: () => ({}) }
      }
      if (position.x === 0 && position.z === 0) {
        if (position.y === 88) return { name: 'dirt', boundingBox: 'block', getProperties: () => ({}) }
        if (position.y === 89) return { name: 'oak_log', boundingBox: 'block', getProperties: () => ({}) }
        return { name: 'air', boundingBox: 'empty', getProperties: () => ({}) }
      }
      return null
    }
  }
  const task = new BlueprintTask(bot, {
    limits: { buildSiteSearchRadius: 4 },
    isLiquid: () => false,
    canClearBuildObstruction: (block) => block.boundingBox === 'empty'
  }, loader)
  const resolved = task.resolveBuildPlacement({
    type: 'build_schematic', schematic: 'test', x: 0, y: 88, z: 0, facing: 'south'
  }, blueprint)
  assert.deepEqual({ x: resolved.x, y: resolved.y, z: resolved.z }, { x: -4, y: 89, z: 0 })
})

test('schematic site survey never treats the top of a tree as buildable ground', () => {
  const blueprint = {
    size: { x: 1, y: 1, z: 1 }, anchor: { x: 0, y: 0, z: 0 },
    blocks: [{ x: 0, y: 0, z: 0, material: 'spruce_planks' }]
  }
  const bot = {
    blockAt: (position) => position.y === 89
      ? { name: 'spruce_log', boundingBox: 'block', getProperties: () => ({}) }
      : { name: 'air', boundingBox: 'empty', getProperties: () => ({}) }
  }
  const task = new BlueprintTask(bot, {
    limits: { buildSiteSearchRadius: 0 },
    isLiquid: () => false,
    canClearBuildObstruction: (block) => block.boundingBox === 'empty'
  }, { blocks: (value) => value.blocks.map((entry) => ({ ...entry })) })
  assert.throws(() => task.resolveBuildPlacement({
    type: 'build_schematic', schematic: 'test', x: 0, y: 89, z: 0, facing: 'south'
  }, blueprint), /spruce_log/)
})

test('schematic site survey rotates at the requested anchor before moving away', () => {
  const blueprint = {
    size: { x: 1, y: 1, z: 2 }, anchor: { x: 0, y: 0, z: 0 },
    blocks: [
      { x: 0, y: 0, z: 0, material: 'spruce_planks' },
      { x: 0, y: 0, z: 1, material: 'spruce_planks' }
    ]
  }
  const loader = { blocks: (value) => value.blocks.map((entry) => ({ ...entry })) }
  const bot = {
    blockAt: (position) => {
      const isSouthPlot = position.z >= 0
      if (position.y === 88) return { name: 'dirt', boundingBox: 'block', getProperties: () => ({}) }
      if (position.y > 88 && isSouthPlot) return { name: 'air', boundingBox: 'empty', getProperties: () => ({}) }
      if (position.y > 88) return { name: 'spruce_leaves', boundingBox: 'block', getProperties: () => ({}) }
      return null
    }
  }
  const task = new BlueprintTask(bot, {
    limits: { buildSiteSearchRadius: 4 },
    isLiquid: () => false,
    canClearBuildObstruction: (block) => block.boundingBox === 'empty'
  }, loader)
  const resolved = task.resolveBuildPlacement({
    type: 'build_schematic', schematic: 'test', x: 0, y: 88, z: 0, facing: 'north'
  }, blueprint)
  assert.deepEqual(
    { x: resolved.x, y: resolved.y, z: resolved.z, facing: resolved.facing },
    { x: 0, y: 89, z: 0, facing: 'east' }
  )
})

test('resumed schematic accepts a safe stance inside completed walls', async () => {
  const blueprint = { size: { x: 8, y: 12, z: 8 }, anchor: { x: 0, y: 0, z: 0 } }
  const current = new Vec3(4, 69, 4)
  let moved = false
  const task = new BlueprintTask({
    entity: { position: current },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' })
  }, {
    canStandAt: (position) => position.equals(current),
    gotoBounded: async () => { moved = true }
  }, {})
  const result = await task.walkToBuildSite(
    { x: 0, y: 64, z: 0, facing: 'south' }, blueprint, new AbortController().signal, true
  )
  assert.deepEqual(result, current)
  assert.equal(moved, false)
})

test('schematic wall blocks choose their wall support and verify the resulting state', async () => {
  const target = new Vec3(0, 64, 0)
  let placed = false
  let usedFace = null
  let usedOptions = null
  const air = { name: 'air', boundingBox: 'empty', position: target }
  const support = (position) => ({ name: 'stone', boundingBox: 'block', position })
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { maxMoveDistance: 64 }
  executor.assertNearby = () => {}
  executor.canStandAt = () => true
  executor.gotoBounded = async () => {}
  executor.bot = {
    entity: { position: new Vec3(2, 64, 0) },
    inventory: { items: () => [{ name: 'torch', type: 1, count: 1 }] },
    blockAt: (position) => {
      if (position.equals(target)) {
        return placed
          ? { name: 'wall_torch', boundingBox: 'empty', position, getProperties: () => ({ facing: 'east' }) }
          : air
      }
      return support(position)
    },
    equip: async () => {},
    lookAt: async () => {},
    _placeBlockWithOptions: async (reference, face, options) => {
      usedFace = face
      usedOptions = options
      placed = true
    }
  }
  await executor.place({
    type: 'place', block: 'torch', expectedBlock: 'wall_torch', verifyState: true,
    x: 0, y: 64, z: 0, properties: { facing: 'east' }
  }, new AbortController().signal)
  assert.deepEqual(usedFace, new Vec3(1, 0, 0))
  assert.equal(usedOptions.forceLook, true)
})

test('directional schematic blocks can use an elevated stance above the foundation', async () => {
  const target = new Vec3(0, 64, 0)
  let placed = false
  let stance = null
  let looked = false
  let forcedLook = null
  let placementOptions = null
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { maxMoveDistance: 64 }
  executor.assertNearby = () => {}
  executor.canStandAt = (position) => position.y === 65
  executor.gotoBounded = async (goal) => { stance = new Vec3(goal.x, goal.y, goal.z) }
  executor.bot = {
    entity: { position: new Vec3(4, 64, 0) },
    inventory: { items: () => [{ name: 'spruce_stairs', type: 1, count: 1 }] },
    blockAt: (position) => {
      if (position.equals(target)) return placed
        ? { name: 'spruce_stairs', boundingBox: 'block', position, getProperties: () => ({ facing: 'north' }) }
        : { name: 'air', boundingBox: 'empty', position }
      return { name: 'stone', boundingBox: 'block', position }
    },
    equip: async () => {},
    lookAt: async (point, force) => {
      looked = true
      forcedLook = force
    },
    _placeBlockWithOptions: async (reference, face, options) => {
      placementOptions = options
      placed = true
    }
  }
  await executor.place({
    type: 'place', block: 'spruce_stairs', expectedBlock: 'spruce_stairs', verifyState: true,
    x: 0, y: 64, z: 0, properties: { facing: 'north' }
  }, new AbortController().signal)
  assert.deepEqual(stance, new Vec3(0, 65, 2))
  assert.equal(looked, true)
  assert.equal(forcedLook, true)
  assert.equal(placementOptions.forceLook, 'ignore')
})

test('directional schematic blocks use explicit yaw when their canonical stance is blocked', async () => {
  const target = new Vec3(0, 65, 0)
  const start = new Vec3(0, 64, -2)
  let placed = false
  let lookedAt = null
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { maxMoveDistance: 64 }
  executor.assertNearby = () => {}
  executor.canStandAt = () => false
  executor.bot = {
    entity: { position: start },
    inventory: { items: () => [{ name: 'stone_brick_stairs', type: 1, count: 1 }] },
    blockAt: (position) => {
      if (position.equals(target)) return placed
        ? { name: 'stone_brick_stairs', boundingBox: 'block', position, getProperties: () => ({ facing: 'east', half: 'bottom' }) }
        : { name: 'air', boundingBox: 'empty', position }
      return { name: 'stone', boundingBox: 'block', position }
    },
    equip: async () => {},
    lookAt: async (point) => { lookedAt = point },
    _placeBlockWithOptions: async () => { placed = true }
  }
  await executor.place({
    type: 'place', block: 'stone_brick_stairs', expectedBlock: 'stone_brick_stairs', verifyState: true,
    x: 0, y: 65, z: 0, properties: { facing: 'east', half: 'bottom' }
  }, new AbortController().signal)
  assert.ok(lookedAt.x > start.x + 3)
  assert.equal(placed, true)
})

test('directional schematic blocks tolerate an unreachable canonical stance when already in reach', async () => {
  const target = new Vec3(0, 65, 0)
  let placed = false
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { maxMoveDistance: 64 }
  executor.assertNearby = () => {}
  executor.canStandAt = () => true
  executor.gotoBounded = async () => { throw new Error('No path to the goal!') }
  executor.bot = {
    entity: { position: new Vec3(0, 64, -2) },
    pathfinder: { movements: { allow1by1towers: true } },
    inventory: { items: () => [{ name: 'stone_brick_stairs', type: 1, count: 1 }] },
    blockAt: (position) => position.equals(target)
      ? (placed
          ? { name: 'stone_brick_stairs', boundingBox: 'block', position, getProperties: () => ({ facing: 'east', half: 'bottom' }) }
          : { name: 'air', boundingBox: 'empty', position })
      : { name: 'stone', boundingBox: 'block', position },
    equip: async () => {},
    lookAt: async () => {},
    _placeBlockWithOptions: async () => { placed = true }
  }
  await executor.place({
    type: 'place', block: 'stone_brick_stairs', expectedBlock: 'stone_brick_stairs', verifyState: true,
    trackTemporaryScaffold: () => {},
    x: 0, y: 65, z: 0, properties: { facing: 'east', half: 'bottom' }
  }, new AbortController().signal)
  assert.equal(placed, true)
})

test('schematic top slabs use a horizontal upper-half placement click', async () => {
  const target = new Vec3(0, 64, 0)
  let placed = false
  let usedFace = null
  let usedOptions = null
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { maxMoveDistance: 64 }
  executor.assertNearby = () => {}
  executor.canStandAt = () => false
  executor.bot = {
    entity: { position: new Vec3(0, 64, -2) },
    inventory: { items: () => [{ name: 'oak_slab', type: 1, count: 1 }] },
    blockAt: (position) => {
      if (position.equals(target)) return placed
        ? { name: 'oak_slab', boundingBox: 'block', position, getProperties: () => ({ type: 'top' }) }
        : { name: 'air', boundingBox: 'empty', position }
      return { name: 'stone', boundingBox: 'block', position }
    },
    equip: async () => {},
    _placeBlockWithOptions: async (reference, face, options) => {
      usedFace = face
      usedOptions = options
      placed = true
    }
  }
  await executor.place({
    type: 'place', block: 'oak_slab', expectedBlock: 'oak_slab', verifyState: true,
    x: 0, y: 64, z: 0, properties: { type: 'top' }
  }, new AbortController().signal)
  assert.equal(usedFace.y, 0)
  assert.equal(usedOptions.half, 'top')
})

test('schematic top stairs scaffold a side instead of clicking the floor', async () => {
  const target = new Vec3(0, 64, 0)
  const floor = target.offset(0, -1, 0)
  let placed = false
  let scaffoldPosition = null
  let usedFace = null
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { maxMoveDistance: 64 }
  executor.assertNearby = () => {}
  executor.canStandAt = () => true
  executor.gotoBounded = async () => {}
  executor.ensurePlacementScaffold = async () => ({ name: 'cobblestone' })
  executor.repairStairFloor = async (position) => {
    scaffoldPosition = position.clone()
    return true
  }
  executor.bot = {
    entity: { position: new Vec3(0, 64, -2) },
    pathfinder: { movements: { allow1by1towers: true } },
    inventory: { items: () => [{ name: 'stone_brick_stairs', type: 1, count: 1 }] },
    blockAt: (position) => {
      if (position.equals(target)) return placed
        ? { name: 'stone_brick_stairs', boundingBox: 'block', position, getProperties: () => ({ facing: 'north', half: 'top' }) }
        : { name: 'air', boundingBox: 'empty', position }
      if (position.equals(floor)) return { name: 'stone_bricks', boundingBox: 'block', position }
      if (scaffoldPosition?.equals(position)) return { name: 'cobblestone', boundingBox: 'block', position }
      return { name: 'air', boundingBox: 'empty', position }
    },
    equip: async () => {},
    lookAt: async () => {},
    _placeBlockWithOptions: async (reference, face) => {
      usedFace = face
      placed = true
    }
  }
  await executor.place({
    type: 'place', block: 'stone_brick_stairs', expectedBlock: 'stone_brick_stairs', verifyState: true,
    x: 0, y: 64, z: 0, properties: { facing: 'north', half: 'top' }
  }, new AbortController().signal)
  assert.notEqual(scaffoldPosition?.toString(), floor.toString())
  assert.equal(usedFace.y, 0)
})

test('schematic blocks prefer reachable side support over a ceiling', async () => {
  const target = new Vec3(0, 64, 0)
  let placed = false
  let usedFace = null
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { maxMoveDistance: 64 }
  executor.assertNearby = () => {}
  executor.canStandAt = () => true
  executor.gotoBounded = async () => {}
  executor.bot = {
    entity: { position: new Vec3(0, 64, -2) },
    pathfinder: { movements: { allow1by1towers: true } },
    inventory: { items: () => [{ name: 'tuff_brick_wall', type: 1, count: 1 }] },
    blockAt: (position) => {
      if (position.equals(target)) return placed
        ? { name: 'tuff_brick_wall', boundingBox: 'block', position, getProperties: () => ({}) }
        : { name: 'air', boundingBox: 'empty', position }
      if (position.equals(target.offset(-1, 0, 0)) || position.equals(target.offset(0, 1, 0))) {
        return { name: 'stone', boundingBox: 'block', position }
      }
      return { name: 'air', boundingBox: 'empty', position }
    },
    equip: async () => {},
    _placeBlockWithOptions: async (reference, face) => {
      usedFace = face
      placed = true
    }
  }
  await executor.place({
    type: 'place', block: 'tuff_brick_wall', expectedBlock: 'tuff_brick_wall', verifyState: true,
    x: 0, y: 64, z: 0
  }, new AbortController().signal)
  assert.deepEqual(usedFace, new Vec3(1, 0, 0))
})

test('schematic hanging lanterns place against the block above', async () => {
  const target = new Vec3(0, 64, 0)
  let placed = false
  let usedFace = null
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { maxMoveDistance: 64 }
  executor.assertNearby = () => {}
  executor.canStandAt = () => false
  executor.bot = {
    entity: { position: new Vec3(0, 64, -2) },
    inventory: { items: () => [{ name: 'lantern', type: 1, count: 1 }] },
    blockAt: (position) => {
      if (position.equals(target)) return placed
        ? { name: 'lantern', boundingBox: 'empty', position, getProperties: () => ({ hanging: true }) }
        : { name: 'air', boundingBox: 'empty', position }
      if (position.equals(target.offset(0, 1, 0))) return { name: 'stone', boundingBox: 'block', position }
      return { name: 'air', boundingBox: 'empty', position }
    },
    equip: async () => {},
    _placeBlockWithOptions: async (reference, face) => { usedFace = face; placed = true }
  }
  await executor.place({
    type: 'place', block: 'lantern', expectedBlock: 'lantern', verifyState: true,
    x: 0, y: 64, z: 0, properties: { hanging: 'true' }
  }, new AbortController().signal)
  assert.deepEqual(usedFace, new Vec3(0, -1, 0))
})

test('schematic placement toggles blocks to their requested open state', async () => {
  const target = new Vec3(0, 64, 0)
  let placed = false
  let open = false
  let activations = 0
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { maxMoveDistance: 64 }
  executor.assertNearby = () => {}
  executor.canStandAt = () => false
  executor.bot = {
    entity: { position: new Vec3(0, 64, -2) },
    inventory: { items: () => [{ name: 'spruce_trapdoor', type: 1, count: 1 }] },
    blockAt: (position) => position.equals(target)
      ? (placed
          ? { name: 'spruce_trapdoor', boundingBox: 'empty', position, getProperties: () => ({ facing: 'north', half: 'top', open }) }
          : { name: 'air', boundingBox: 'empty', position })
      : { name: 'stone', boundingBox: 'block', position },
    equip: async () => {},
    lookAt: async () => {},
    activateBlock: async () => { activations += 1; open = true },
    _placeBlockWithOptions: async () => { placed = true }
  }
  await executor.place({
    type: 'place', block: 'spruce_trapdoor', expectedBlock: 'spruce_trapdoor', verifyState: true,
    x: 0, y: 64, z: 0, properties: { facing: 'north', half: 'top', open: 'true' }
  }, new AbortController().signal)
  assert.equal(activations, 1)
  assert.equal(open, true)
})

test('schematic placement stacks candles to the requested count', async () => {
  const target = new Vec3(0, 64, 0)
  let placed = false
  let candles = 0
  let activations = 0
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { maxMoveDistance: 64 }
  executor.assertNearby = () => {}
  executor.canStandAt = () => false
  executor.bot = {
    entity: { position: new Vec3(0, 64, -2) },
    inventory: { items: () => [{ name: 'white_candle', type: 1, count: 3 }] },
    blockAt: (position) => position.equals(target)
      ? (placed
          ? { name: 'white_candle', boundingBox: 'empty', position, getProperties: () => ({ candles }) }
          : { name: 'air', boundingBox: 'empty', position })
      : { name: 'stone', boundingBox: 'block', position },
    equip: async () => {},
    activateBlock: async () => { activations += 1; candles += 1 },
    _placeBlockWithOptions: async () => { placed = true; candles = 1 }
  }
  await executor.place({
    type: 'place', block: 'white_candle', expectedBlock: 'white_candle', verifyState: true,
    x: 0, y: 64, z: 0, properties: { candles: '3' }
  }, new AbortController().signal)
  assert.equal(activations, 2)
  assert.equal(candles, 3)
})

test('schematic placement merges two slab items for a requested double slab', async () => {
  const target = new Vec3(0, 64, 0)
  let placed = false
  let type = 'bottom'
  let activations = 0
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { maxMoveDistance: 64 }
  executor.assertNearby = () => {}
  executor.canStandAt = () => false
  executor.bot = {
    entity: { position: new Vec3(0, 64, -2) },
    inventory: { items: () => [{ name: 'mangrove_slab', type: 1, count: 2 }] },
    blockAt: (position) => position.equals(target)
      ? (placed
          ? { name: 'mangrove_slab', boundingBox: 'block', position, getProperties: () => ({ type }) }
          : { name: 'air', boundingBox: 'empty', position })
      : { name: 'stone', boundingBox: 'block', position },
    equip: async () => {},
    activateBlock: async () => { activations += 1; type = 'double' },
    _placeBlockWithOptions: async () => { placed = true }
  }
  await executor.place({
    type: 'place', block: 'mangrove_slab', expectedBlock: 'mangrove_slab', verifyState: true,
    x: 0, y: 64, z: 0, properties: { type: 'double' }
  }, new AbortController().signal)
  assert.equal(activations, 1)
  assert.equal(type, 'double')
})

test('schematic placement repairs one server-side state mismatch locally', async () => {
  const target = new Vec3(0, 64, 0)
  let state = 'air'
  let placements = 0
  let clears = 0
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { maxMoveDistance: 64 }
  executor.assertNearby = () => {}
  executor.canStandAt = () => false
  executor.clearBuildObstruction = async () => { clears += 1; state = 'air'; return true }
  executor.bot = {
    entity: { position: new Vec3(0, 64, -2) },
    inventory: { items: () => [{ name: 'spruce_slab', type: 1, count: 2 }] },
    blockAt: (position) => {
      if (position.equals(target)) return state === 'air'
        ? { name: 'air', boundingBox: 'empty', position }
        : { name: 'spruce_slab', boundingBox: 'block', diggable: true, position, getProperties: () => ({ type: state }) }
      return { name: 'stone', boundingBox: 'block', position }
    },
    equip: async () => {},
    _placeBlockWithOptions: async () => {
      placements += 1
      state = placements === 1 ? 'double' : 'bottom'
    }
  }
  await executor.place({
    type: 'place', block: 'spruce_slab', expectedBlock: 'spruce_slab', verifyState: true,
    x: 0, y: 64, z: 0, properties: { type: 'bottom' }
  }, new AbortController().signal)
  assert.equal(placements, 2)
  assert.equal(clears, 1)
  assert.equal(state, 'bottom')
})

test('schematic placement accepts a delayed server acknowledgement', async () => {
  const target = new Vec3(0, 64, 0)
  let placed = false
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { maxMoveDistance: 64 }
  executor.assertNearby = () => {}
  executor.canStandAt = () => false
  executor.bot = {
    entity: { position: new Vec3(0, 64, -2) },
    inventory: { items: () => [{ name: 'coarse_dirt', type: 1, count: 1 }] },
    blockAt: (position) => {
      if (position.equals(target)) return placed
        ? { name: 'coarse_dirt', boundingBox: 'block', position, getProperties: () => ({}) }
        : { name: 'air', boundingBox: 'empty', position }
      return { name: 'stone', boundingBox: 'block', position }
    },
    equip: async () => {},
    _placeBlockWithOptions: async () => {
      setTimeout(() => { placed = true }, 25)
      throw new Error('Event blockUpdate did not fire within timeout')
    }
  }
  await executor.place({
    type: 'place', block: 'coarse_dirt', expectedBlock: 'coarse_dirt', verifyState: true,
    x: 0, y: 64, z: 0
  }, new AbortController().signal)
  assert.equal(placed, true)
})

test('schematic placement retries once when the server leaves the target empty', async () => {
  const target = new Vec3(0, 64, 0)
  let placed = false
  let attempts = 0
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { maxMoveDistance: 64 }
  executor.assertNearby = () => {}
  executor.canStandAt = () => false
  executor.bot = {
    entity: { position: new Vec3(0, 64, -2) },
    inventory: { items: () => [{ name: 'stone_bricks', type: 1, count: 1 }] },
    blockAt: (position) => {
      if (position.equals(target)) return placed
        ? { name: 'stone_bricks', boundingBox: 'block', position, getProperties: () => ({}) }
        : { name: 'air', boundingBox: 'empty', position }
      return { name: 'stone', boundingBox: 'block', position }
    },
    equip: async () => {},
    _placeBlockWithOptions: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('Event blockUpdate did not fire within timeout')
      placed = true
    }
  }
  await executor.place({
    type: 'place', block: 'stone_bricks', expectedBlock: 'stone_bricks', verifyState: true,
    x: 0, y: 64, z: 0
  }, new AbortController().signal)
  assert.equal(attempts, 2)
  assert.equal(placed, true)
})

test('schematic obstruction removal accepts a delayed server acknowledgement', async () => {
  const target = new Vec3(0, 64, 0)
  let removed = false
  let collected = false
  const executor = Object.create(ActionExecutor.prototype)
  executor.collectDropsNear = async () => { collected = true }
  executor.bot = {
    blockAt: (position) => removed
      ? { name: 'air', boundingBox: 'empty', position }
      : { name: 'stone_bricks', boundingBox: 'block', position, diggable: true },
    tool: { equipForBlock: async () => {} },
    dig: async () => {
      setTimeout(() => { removed = true }, 25)
      throw new Error('Event blockUpdate did not fire within timeout')
    },
    stopDigging: () => {}
  }
  assert.equal(await executor.clearBuildObstruction(
    target, new AbortController().signal, true
  ), true)
  assert.equal(removed, true)
  assert.equal(collected, true)
})

test('schematic obstruction removal retries a block that briefly snaps back', async () => {
  const target = new Vec3(0, 64, 0)
  let state = 'slab'
  let digs = 0
  const executor = Object.create(ActionExecutor.prototype)
  executor.collectDropsNear = async () => 0
  executor.bot = {
    blockAt: (position) => state === 'air'
      ? { name: 'air', boundingBox: 'empty', position }
      : { name: 'spruce_slab', boundingBox: 'block', position, diggable: true },
    tool: { equipForBlock: async () => {} },
    dig: async () => {
      digs += 1
      state = 'air'
      if (digs === 1) setTimeout(() => { state = 'slab' }, 100)
    },
    stopDigging: () => {}
  }
  assert.equal(await executor.clearBuildObstruction(
    target, new AbortController().signal, true
  ), true)
  assert.equal(digs, 2)
  assert.equal(state, 'air')
})

test('schematic placement steps out of its own target cell', async () => {
  const target = new Vec3(0, 64, 0)
  let placed = false
  let movedTo = null
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { maxMoveDistance: 64 }
  executor.assertNearby = () => {}
  executor.canStandAt = (position) => position.equals(new Vec3(0, 64, -2))
  executor.gotoBounded = async (goal) => {
    movedTo = new Vec3(goal.x, goal.y, goal.z)
    executor.bot.entity.position = movedTo.clone()
  }
  executor.bot = {
    entity: { position: target.clone() },
    inventory: { items: () => [{ name: 'spruce_planks', type: 1, count: 1 }] },
    blockAt: (position) => position.equals(target)
      ? (placed
          ? { name: 'spruce_planks', boundingBox: 'block', position, getProperties: () => ({}) }
          : { name: 'air', boundingBox: 'empty', position })
      : { name: 'stone', boundingBox: 'block', position },
    equip: async () => {},
    _placeBlockWithOptions: async () => { placed = true }
  }
  await executor.place({
    type: 'place', block: 'spruce_planks', expectedBlock: 'spruce_planks', verifyState: true,
    x: 0, y: 64, z: 0
  }, new AbortController().signal)
  assert.deepEqual(movedTo, new Vec3(0, 64, -2))
  assert.equal(placed, true)
})

test('schematic placement verifies interaction reach after navigation', async () => {
  const target = new Vec3(8, 65, 0)
  let placed = false
  let moved = false
  let cancelledPath = false
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { maxMoveDistance: 64 }
  executor.assertNearby = () => {}
  executor.canStandAt = () => false
  executor.gotoBounded = async () => {
    moved = true
    executor.bot.entity.position = new Vec3(6, 64, 0)
  }
  executor.bot = {
    entity: { position: new Vec3(0, 64, 0) },
    pathfinder: { setGoal: (goal) => { if (goal === null) cancelledPath = true } },
    inventory: { items: () => [{ name: 'stone', type: 1, count: 1 }] },
    blockAt: (position) => position.equals(target)
      ? (placed
          ? { name: 'stone', boundingBox: 'block', position, getProperties: () => ({}) }
          : { name: 'air', boundingBox: 'empty', position })
      : { name: 'stone', boundingBox: 'block', position },
    equip: async () => {},
    _placeBlockWithOptions: async () => { placed = true }
  }
  await executor.place({
    type: 'place', block: 'stone', expectedBlock: 'stone', x: target.x, y: target.y, z: target.z
  }, new AbortController().signal)
  assert.equal(moved, true)
  assert.equal(cancelledPath, true)
  assert.equal(placed, true)
})

test('schematic placement falls back to an exact reachable stance after a false goal completion', async () => {
  const target = new Vec3(8, 65, 0)
  const exactStance = new Vec3(7, 65, 0)
  let placed = false
  let moves = 0
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { maxMoveDistance: 64 }
  executor.assertNearby = () => {}
  executor.canStandAt = (position) => position.equals(exactStance)
  executor.gotoBounded = async (goal) => {
    moves += 1
    if (goal.x === 7 && goal.y === 65 && goal.z === 0) executor.bot.entity.position = new Vec3(7, 65, 0)
  }
  executor.bot = {
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [{ name: 'stone', type: 1, count: 1 }] },
    blockAt: (position) => position.equals(target)
      ? (placed
          ? { name: 'stone', boundingBox: 'block', position, getProperties: () => ({}) }
          : { name: 'air', boundingBox: 'empty', position })
      : (position.equals(exactStance) || position.equals(exactStance.offset(0, 1, 0)))
          ? { name: 'air', boundingBox: 'empty', position }
      : { name: 'stone', boundingBox: 'block', position },
    equip: async () => {},
    _placeBlockWithOptions: async () => { placed = true }
  }
  await executor.place({
    type: 'place', block: 'stone', expectedBlock: 'stone', x: target.x, y: target.y, z: target.z
  }, new AbortController().signal)
  assert.ok(moves >= 2)
  assert.equal(placed, true)
})

test('schematic placement verifies escape movement before placing', async () => {
  const target = new Vec3(0, 64, 0)
  let placed = false
  let moves = 0
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { maxMoveDistance: 64 }
  executor.assertNearby = () => {}
  executor.canStandAt = () => true
  executor.gotoBounded = async (goal) => {
    moves += 1
    // Simulate pathfinder resolving its first tiny goal without moving, which
    // occurs around dense partial structures.
    if (moves > 1) executor.bot.entity.position = new Vec3(goal.x, goal.y, goal.z)
  }
  executor.bot = {
    entity: { position: new Vec3(0, 63, 0) },
    pathfinder: { movements: { allow1by1towers: true } },
    inventory: { items: () => [{ name: 'tuff_brick_wall', type: 1, count: 1 }] },
    blockAt: (position) => position.equals(target)
      ? (placed
          ? { name: 'tuff_brick_wall', boundingBox: 'block', position, getProperties: () => ({}) }
          : { name: 'air', boundingBox: 'empty', position })
      : { name: 'stone', boundingBox: 'block', position },
    equip: async () => {},
    _placeBlockWithOptions: async () => { placed = true }
  }
  await executor.place({
    type: 'place', block: 'tuff_brick_wall', expectedBlock: 'tuff_brick_wall', verifyState: true,
    x: 0, y: 64, z: 0
  }, new AbortController().signal)
  assert.equal(moves, 2)
  assert.equal(placed, true)
})

test('floating schematic blocks create and register temporary support', async () => {
  const target = new Vec3(0, 65, 0)
  const supportPosition = target.offset(0, -1, 0)
  let scaffoldPlaced = false
  let targetPlaced = false
  let tracked = null
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { maxMoveDistance: 64 }
  executor.assertNearby = () => {}
  executor.bot = {
    entity: { position: new Vec3(0, 65, -2) },
    inventory: { items: () => [
      { name: 'dirt', type: 1, count: 8 },
      { name: 'spruce_leaves', type: 2, count: 8 }
    ] },
    blockAt: (position) => {
      if (position.equals(target)) return targetPlaced
        ? { name: 'spruce_leaves', boundingBox: 'block', position, getProperties: () => ({}) }
        : { name: 'air', boundingBox: 'empty', position }
      if (position.equals(supportPosition)) return scaffoldPlaced
        ? { name: 'dirt', boundingBox: 'block', position }
        : { name: 'air', boundingBox: 'empty', position }
      if (position.equals(supportPosition.offset(0, -1, 0))) {
        return { name: 'stone', boundingBox: 'block', position }
      }
      return { name: 'air', boundingBox: 'empty', position }
    },
    equip: async () => {},
    placeBlock: async () => { scaffoldPlaced = true },
    _placeBlockWithOptions: async () => { targetPlaced = true }
  }
  await executor.place({
    type: 'place', block: 'spruce_leaves', expectedBlock: 'spruce_leaves', verifyState: true,
    x: target.x, y: target.y, z: target.z,
    trackTemporaryScaffold: (position) => { tracked = position }
  }, new AbortController().signal)
  assert.deepEqual(tracked, supportPosition)
  assert.equal(targetPlaced, true)
})

test('floating schematic support grows a bounded column from solid ground', async () => {
  const top = new Vec3(0, 67, 0)
  const placed = new Set()
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    blockAt: (position) => ({
      name: position.y <= 64 || placed.has(position.toString()) ? 'stone' : 'air',
      boundingBox: position.y <= 64 || placed.has(position.toString()) ? 'block' : 'empty',
      position
    })
  }
  executor.isPassable = (block) => block.boundingBox === 'empty'
  executor.isLiquid = () => false
  executor.repairStairFloor = async (position) => {
    const neighbors = [
      position.offset(0, -1, 0), position.offset(0, 1, 0),
      position.offset(1, 0, 0), position.offset(-1, 0, 0),
      position.offset(0, 0, 1), position.offset(0, 0, -1)
    ]
    if (!neighbors.some((neighbor) => executor.bot.blockAt(neighbor).boundingBox !== 'empty')) {
      throw new Error(`no solid face available to repair staircase at ${position}`)
    }
    placed.add(position.toString())
    return true
  }
  const created = await executor.createPlacementSupport(top, new AbortController().signal)
  assert.deepEqual(created.map((position) => position.y), [65, 66, 67])
})

test('floating schematic support restocks when its scaffold stack is exhausted', async () => {
  const target = new Vec3(0, 65, 0)
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    blockAt: (position) => ({ name: 'air', boundingBox: 'empty', position })
  }
  executor.isPassable = () => true
  executor.isLiquid = () => false
  let attempts = 0
  let restocks = 0
  executor.repairStairFloor = async () => {
    attempts += 1
    if (attempts === 1) throw new Error(`cannot repair staircase at ${target}; no dirt or stone blocks`)
    return true
  }
  executor.ensurePlacementScaffold = async (_signal, preserveItem) => {
    assert.equal(preserveItem, 'spruce_leaves')
    restocks += 1
    return { name: 'cobbled_deepslate', count: 16 }
  }
  const created = await executor.createPlacementSupport(
    target, new AbortController().signal, 'spruce_leaves'
  )
  assert.equal(restocks, 1)
  assert.deepEqual(created.map(String), [target.toString()])
})

test('building creates a tracked temporary staircase to a sealed upper placement stance', async () => {
  const start = new Vec3(0, 64, 0)
  const stance = new Vec3(3, 67, 0)
  const solid = new Set()
  const tracked = []
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    entity: { position: start.clone() },
    blockAt: (position) => ({
      name: solid.has(position.toString()) ? 'cobblestone' : 'air',
      boundingBox: solid.has(position.toString()) ? 'block' : 'empty',
      position
    })
  }
  executor.isPassable = (block) => block.boundingBox === 'empty'
  executor.isLiquid = () => false
  executor.createPlacementSupport = async (position) => {
    solid.add(position.toString())
    return [position.clone()]
  }
  executor.gotoBounded = async (goal) => {
    executor.bot.entity.position = new Vec3(goal.x, goal.y, goal.z)
  }
  const climbed = await executor.createPlacementStaircase(
    stance, new AbortController().signal, 'smooth_sandstone',
    (position) => tracked.push(position.toString())
  )
  assert.equal(climbed, true)
  assert.deepEqual(tracked, ['(1, 64, 0)', '(2, 65, 0)', '(3, 66, 0)'])
})

test('construction restocks scaffold blocks before placing floating blocks', async () => {
  const items = []
  const requested = []
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = { inventory: { items: () => items } }
  executor.inventoryTracker = { freeSlots: () => 2 }
  executor.inventoryPolicy = { freeTrashSlots: async () => 0 }
  executor.tryWithdrawFromNearby = async (name, quantity) => {
    requested.push({ name, quantity })
    if (name === 'cobbled_deepslate') items.push({ name, count: quantity })
    return name === 'cobbled_deepslate' ? quantity : 0
  }
  const scaffold = await executor.ensurePlacementScaffold(new AbortController().signal, 'spruce_leaves')
  assert.equal(scaffold.name, 'cobbled_deepslate')
  assert.deepEqual(requested, [{ name: 'cobbled_deepslate', quantity: 16 }])
})

test('construction falls back to safe stone variants for scaffolding', () => {
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    inventory: { items: () => [
      { name: 'smooth_sandstone', count: 32 },
      { name: 'andesite', count: 8 }
    ] }
  }
  assert.equal(executor.scaffoldItem().name, 'andesite')
})

test('vertical schematic logs refuse horizontal support and scaffold below', async () => {
  const target = new Vec3(0, 65, 0)
  const below = target.offset(0, -1, 0)
  let scaffoldPlaced = false
  let usedFace = null
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { maxMoveDistance: 64 }
  executor.assertNearby = () => {}
  executor.bot = {
    entity: { position: new Vec3(0, 65, -2) },
    inventory: { items: () => [
      { name: 'dirt', type: 1, count: 8 },
      { name: 'stripped_dark_oak_log', type: 2, count: 1 }
    ] },
    blockAt: (position) => {
      if (position.equals(target)) return usedFace
        ? { name: 'stripped_dark_oak_log', boundingBox: 'block', position, getProperties: () => ({ axis: 'y' }) }
        : { name: 'air', boundingBox: 'empty', position }
      if (position.equals(below)) return scaffoldPlaced
        ? { name: 'dirt', boundingBox: 'block', position }
        : { name: 'air', boundingBox: 'empty', position }
      if (position.equals(below.offset(0, -1, 0)) || position.equals(target.offset(1, 0, 0))) {
        return { name: 'stone', boundingBox: 'block', position }
      }
      return { name: 'air', boundingBox: 'empty', position }
    },
    equip: async () => {},
    placeBlock: async () => { scaffoldPlaced = true },
    _placeBlockWithOptions: async (reference, face) => { usedFace = face }
  }
  await executor.place({
    type: 'place', block: 'stripped_dark_oak_log', expectedBlock: 'stripped_dark_oak_log', verifyState: true,
    x: target.x, y: target.y, z: target.z, properties: { axis: 'y' }
  }, new AbortController().signal)
  assert.equal(scaffoldPlaced, true)
  assert.deepEqual(usedFace, new Vec3(0, 1, 0))
})

test('task tree reports its deepest active subtask', () => {
  const root = new Task('sequence', 'goal')
  root.start()
  const action = root.child('action', 'acquire tools')
  action.start()
  const leaf = action.child('acquire', 'collect cobblestone', { current: 2, target: 8 })
  leaf.start()
  assert.equal(root.activeLeaf(), leaf)
  leaf.complete('8/8')
  assert.equal(root.snapshot().children[0].children[0].status, 'completed')
})

test('recipe selection follows the locally available wood family', () => {
  const registry = require('prismarine-registry')('1.21.11')
  const Recipe = require('prismarine-recipe')(registry).Recipe
  const birch = registry.blocksByName.birch_log
  const bot = {
    registry,
    inventory: { items: () => [] },
    blockAt: (position) => ({ ...birch, position })
  }
  const executor = {
    limits: { collectSearchDistance: 64, maxMoveDistance: 128 },
    resolveBlockTypes: () => [birch],
    blockTracker: { find: () => [new Vec3(1, 64, 1)] }
  }
  const acquire = new AcquireItemTask(bot, executor)
  const recipes = Recipe.find(registry.itemsByName.wooden_pickaxe.id)
  const chosen = acquire.chooseRecipe(recipes)
  const ingredients = chosen.delta
    .filter((entry) => entry.count < 0)
    .map((entry) => registry.items[entry.id].name)
  assert.ok(ingredients.includes('birch_planks'))
})

test('recursive acquisition emits a resumable progress checkpoint', async () => {
  const inventory = []
  const itemType = { id: 1, name: 'test_item' }
  const recipe = { result: { count: 1 }, delta: [], requiresTable: false }
  const bot = {
    registry: { itemsByName: { test_item: itemType }, items: { 1: itemType } },
    inventory: { items: () => inventory },
    recipesAll: () => [recipe],
    craft: async () => inventory.push({ name: 'test_item', type: 1, count: 1 })
  }
  const executor = {
    goalStoredCount: () => 0,
    tryWithdrawFromNearby: async () => 0,
    toolManager: {}
  }
  const root = new Task('action', 'acquire test item')
  root.start()
  let snapshot
  const result = await new AcquireItemTask(bot, executor).run(
    'test_item', 1, new AbortController().signal, root, (task) => { snapshot = task.snapshot() }
  )
  assert.match(result, /Acquired 1\/1/)
  assert.equal(snapshot.detail.current, 1)
})

test('deterministic smelting covers food, glass, stone, and charcoal without burning its input', () => {
  assert.equal(SMELTING.cooked_beef, 'beef')
  assert.equal(SMELTING.glass, 'sand')
  assert.equal(SMELTING.stone, 'cobblestone')
  assert.equal(SMELTING.charcoal, 'any_log')
  const manager = new ToolManager({
    inventory: { items: () => [
      { name: 'oak_log', count: 8 },
      { name: 'oak_planks', count: 8 }
    ] }
  })
  assert.equal(manager.findFuel(8, 'oak_log').item.name, 'oak_planks')
})

test('moderate hunger cooks carried food while critical hunger skips the furnace', async () => {
  const items = [
    { name: 'beef', type: 1, count: 2 }, { name: 'coal', type: 2, count: 1 },
    { name: 'furnace', type: 3, count: 1 }
  ]
  let cooked = 0
  let equipped = null
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    food: 12,
    registry: {
      blocksByName: { furnace: { id: 9 } },
      foodsByName: { beef: { foodPoints: 3 }, cooked_beef: { foodPoints: 8 } }
    },
    inventory: { items: () => items },
    equip: async (item) => { equipped = item.name },
    consume: async () => {},
    findBlock: () => null
  }
  executor.inventoryCount = (name) => items.filter((item) => item.name === name).reduce((n, item) => n + item.count, 0)
  executor.toolManager = {
    findFuel: () => ({ item: items[1], needed: 1 }),
    smelt: async () => { cooked += 1; items.push({ name: 'cooked_beef', type: 4, count: 2 }) }
  }
  await executor.eat(new AbortController().signal)
  assert.equal(cooked, 1)
  assert.equal(equipped, 'cooked_beef')
  executor.bot.food = 6
  items.splice(3)
  cooked = 0
  await executor.eat(new AbortController().signal)
  assert.equal(cooked, 0)
})

test('equipment assistance waits for a usable supplied tool and then resumes', async () => {
  const items = []
  const executor = Object.create(ActionExecutor.prototype)
  executor.activity = null
  executor.bot = { inventory: { items: () => items } }
  executor.toolManager = {
    bestTool: (tool) => items.find((item) => item.name.endsWith(`_${tool}`)) || null
  }
  executor.approachPlayerForHelp = async (username) => {
    assert.equal(username, 'KawaiiSponge')
    return true
  }
  let checks = 0
  executor.collectSuppliedEquipment = async (equipment) => {
    assert.equal(equipment, 'pickaxe')
    checks += 1
    if (checks === 1) items.push({ name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 0 })
    return 1
  }
  const received = await executor.waitForEquipment(
    'KawaiiSponge', 'pickaxe', new AbortController().signal, 1000
  )
  assert.equal(received, true)
  assert.equal(executor.activity, null)
})

test('equipment matching rejects broken tools', () => {
  const executor = Object.create(ActionExecutor.prototype)
  assert.equal(executor.equipmentItemMatches({
    name: 'stone_pickaxe', maxDurability: 131, durabilityUsed: 131
  }, 'pickaxe'), false)
  assert.equal(executor.equipmentItemMatches({
    name: 'stone_pickaxe', maxDurability: 131, durabilityUsed: 130
  }, 'pickaxe'), true)
})

test('classifies routine failures and retries safe navigation once', async () => {
  assert.equal(classifyFailure(new Error('Took too long to decide path to goal')), 'navigation')
  assert.equal(classifyFailure(new Error('build site is obstructed by stone')), 'unsafe_or_blocked')
  assert.equal(classifyFailure(new Error('no usable pickaxe or replacement materials')), 'missing_resource')
  assert.equal(classifyFailure(new Error('Event blockUpdate:(1, 2, 3) did not fire within timeout')), 'transient_world')
  assert.equal(classifyFailure(new Error('schematic placement mismatch: type=double instead of bottom')), 'transient_world')
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    pathfinder: { isMoving: () => false, isMining: () => false, isBuilding: () => false }
  }
  let recoveries = 0
  const manager = new RecoveryManager(bot, {
    recoverStuck: async () => { recoveries += 1; return 'recovered' }
  }, { stallMs: 5000 })
  const task = new Task('action', 'move')
  task.start()
  let attempts = 0
  const result = await manager.run(
    { type: 'move_to' },
    new AbortController().signal,
    task,
    async () => {
      attempts += 1
      if (attempts === 1) throw new Error('No path to target')
      return 'arrived'
    }
  )
  assert.equal(result, 'arrived')
  assert.equal(attempts, 2)
  assert.equal(recoveries, 1)
})

test('schematic builds retry transient placement loss locally without AI replanning', async () => {
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    pathfinder: { isMoving: () => false, isMining: () => false, isBuilding: () => false }
  }
  const manager = new RecoveryManager(bot, {}, { stallMs: 5000 })
  const task = new Task('action', 'build test')
  task.start()
  let attempts = 0
  const result = await manager.run(
    { type: 'build_schematic' },
    new AbortController().signal,
    task,
    async () => {
      attempts += 1
      if (attempts < 3) throw new Error('Event blockUpdate:(1, 2, 3) did not fire within timeout of 5000ms')
      return 'continued build'
    }
  )
  assert.equal(result, 'continued build')
  assert.equal(attempts, 3)
})

test('recovery preserves a skill-provided failure category', async () => {
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    pathfinder: { isMoving: () => false, isMining: () => false, isBuilding: () => false }
  }
  const manager = new RecoveryManager(bot, {}, { stallMs: 5000 })
  const task = new Task('action', 'collect absent resource')
  task.start()
  const error = Object.assign(new Error('none are loaded nearby'), { category: 'missing_resource' })
  await assert.rejects(
    manager.run({ type: 'collect' }, new AbortController().signal, task, async () => { throw error }),
    (caught) => caught.category === 'missing_resource'
  )
})

test('task preparation failures receive the same typed classification as execution failures', async () => {
  const runner = new TaskRunner(
    { entity: { position: new Vec3(0, 64, 0) } },
    {
      limits: {},
      prepareForAction: async () => { throw new Error('no usable pickaxe or replacement materials') }
    },
    {}
  )
  await assert.rejects(
    runner.run([{ type: 'eat' }], new AbortController().signal),
    (error) => error.category === 'missing_resource' && error.action.type === 'eat'
  )
})

test('task preparation stalls are watched and strip mining retries after recovery', async () => {
  class Bot extends EventEmitter {}
  const bot = new Bot()
  bot.entity = { position: new Vec3(0, -59, 0) }
  bot.inventory = new EventEmitter()
  bot.pathfinder = { isMoving: () => false, isMining: () => false, isBuilding: () => false }
  let preparations = 0
  let recoveries = 0
  const executor = {
    limits: { taskStallMs: 30 },
    prepareForAction: async (action, signal) => {
      preparations += 1
      if (preparations > 1) return
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('unloading path cancelled'), { name: 'AbortError' }))
      }, { once: true }))
    },
    recoverStuck: async () => { recoveries += 1; return 'cleared stale storage route' },
    execute: async () => 'strip mine resumed'
  }
  const runner = new TaskRunner(bot, executor, {})
  await runner.run([{
    type: 'strip_mine', direction: 'east', length: 8,
    target: 'general', branchSpacing: 3, branchDepth: 16
  }], new AbortController().signal)
  assert.equal(preparations, 2)
  assert.equal(recoveries, 1)
})

test('starting foreground work waits for aborted background maintenance to settle', async () => {
  const controller = Object.create(BotController.prototype)
  controller.maintenanceTimer = setTimeout(() => {}, 10000)
  controller.maintenanceAbort = new AbortController()
  let settled = false
  controller.maintenanceRun = new Promise((resolve, reject) => {
    controller.maintenanceAbort.signal.addEventListener('abort', () => {
      setImmediate(() => {
        settled = true
        reject(Object.assign(new Error('maintenance cancelled'), { name: 'AbortError' }))
      })
    }, { once: true })
  })
  await controller.cancelMaintenance()
  assert.equal(controller.maintenanceAbort.signal.aborted, true)
  assert.equal(settled, true)
})

test('watchdog escapes a plugin promise that ignores cancellation after movement stops', async () => {
  class Bot extends EventEmitter {}
  const bot = new Bot()
  bot.entity = { position: new Vec3(0, 64, 0) }
  bot.inventory = new EventEmitter()
  bot.pathfinder = { isMoving: () => false, isMining: () => false, isBuilding: () => false }
  let recoveries = 0
  const manager = new RecoveryManager(bot, {
    recoverStuck: async () => { recoveries += 1; return 'recovered' }
  }, { stallMs: 40 })
  const task = new Task('action', 'move')
  task.start()
  let attempts = 0
  const result = await manager.run(
    { type: 'move_to' },
    new AbortController().signal,
    task,
    async () => {
      attempts += 1
      if (attempts > 1) return 'arrived after watchdog recovery'
      await new Promise(() => {})
    }
  )
  assert.equal(result, 'arrived after watchdog recovery')
  assert.equal(attempts, 2)
  assert.equal(recoveries, 1)
})

test('navigation retry escapes a recovery path that also ignores cancellation', async () => {
  class Bot extends EventEmitter {}
  const bot = new Bot()
  bot.entity = { position: new Vec3(0, 64, 0) }
  bot.inventory = new EventEmitter()
  bot.pathfinder = { isMoving: () => false, isMining: () => false, isBuilding: () => false }
  let attempts = 0
  let stopped = 0
  const manager = new RecoveryManager(bot, {
    stop: () => { stopped += 1 },
    recoverStuck: async () => new Promise(() => {})
  }, { stallMs: 30 })
  const task = new Task('action', 'move')
  task.start()
  const result = await manager.run(
    { type: 'move_to' }, new AbortController().signal, task,
    async () => {
      attempts += 1
      if (attempts === 1) throw new Error('No path to target')
      return 'retried after recovery timeout'
    }
  )
  assert.equal(result, 'retried after recovery timeout')
  assert.equal(stopped, 1)
})

test('inventory and entity trackers maintain queryable local state', () => {
  class Inventory extends EventEmitter {
    constructor() { super(); this.content = [{ name: 'oak_log', count: 3 }] }
    items() { return this.content }
  }
  class Bot extends EventEmitter {}
  const bot = new Bot()
  bot.inventory = new Inventory()
  bot.entity = { position: new Vec3(0, 64, 0) }
  bot.entities = {}
  bot.players = { Steve: { username: 'Steve', entity: { id: 2, position: new Vec3(1, 64, 0) } } }
  const inventory = new InventoryTracker(bot)
  assert.equal(inventory.count('any_log'), 3)
  bot.inventory.content.push({ name: 'birch_planks', count: 4 })
  bot.inventory.emit('updateSlot')
  assert.equal(inventory.count('any_planks'), 4)
  assert.equal(inventory.recent(0).at(-1).changes[0].delta, 4)

  const entities = new EntityTracker(bot)
  const drop = {
    id: 3, position: new Vec3(2, 64, 0),
    getDroppedItem: () => ({ name: 'diamond', count: 1 })
  }
  bot.emit('entitySpawn', drop)
  assert.equal(entities.droppedItems('diamond', 8)[0].entity, drop)
  assert.equal(entities.player('steve').id, 2)
  bot.emit('entityGone', drop)
  assert.equal(entities.droppedItems('diamond', 8).length, 0)
  inventory.shutdown()
  entities.shutdown()
})

test('inventory policy preserves the maintained table and best tools', () => {
  const items = [
    { name: 'crafting_table', type: 1, count: 2 },
    { name: 'iron_pickaxe', type: 2, count: 1 },
    { name: 'rotten_flesh', type: 3, count: 4 }
  ]
  const bot = { inventory: { items: () => items } }
  const policy = new InventoryPolicy(bot, new Set(['crafting_table', 'iron_pickaxe', 'rotten_flesh']))
  assert.deepEqual(policy.disposableStacks().map(({ item, quantity }) => [item.name, quantity]), [
    ['crafting_table', 1], ['rotten_flesh', 4]
  ])
})

test('inventory trash policy keeps minimum crafting and combat supplies', () => {
  const items = [
    { name: 'stick', type: 1, count: 12 },
    { name: 'torch', type: 2, count: 20 },
    { name: 'shield', type: 3, count: 2 }
  ]
  const policy = new InventoryPolicy(
    { inventory: { items: () => items } }, new Set(['stick', 'torch', 'shield'])
  )
  assert.deepEqual(policy.disposableStacks().map(({ item, quantity }) => [item.name, quantity]), [
    ['stick', 4], ['torch', 4], ['shield', 1]
  ])
})

test('mining overflow keeps one scaffold stack and selects mined resources for sorted storage', () => {
  const inventory = new EventEmitter()
  inventory.items = () => [
    { name: 'cobblestone', type: 1, count: 64 },
    { name: 'cobbled_deepslate', type: 2, count: 64 },
    { name: 'gravel', type: 3, count: 32 },
    { name: 'diamond', type: 4, count: 8 },
    { name: 'iron_pickaxe', type: 5, count: 1 }
  ]
  const bot = new EventEmitter()
  Object.assign(bot, { inventory, entities: {}, players: {} })
  const executor = new ActionExecutor(bot, {})
  assert.deepEqual(executor.overflowCandidates('mining').map(({ item, quantity }) => [item.name, quantity]), [
    ['cobbled_deepslate', 64], ['gravel', 32], ['diamond', 8]
  ])
})

test('woodcutting overflow stores wood and plants but preserves requested logs', () => {
  const inventory = new EventEmitter()
  inventory.items = () => [
    { name: 'oak_log', type: 1, count: 64 },
    { name: 'oak_planks', type: 2, count: 32 },
    { name: 'oak_sapling', type: 3, count: 8 },
    { name: 'poppy', type: 4, count: 6 },
    { name: 'iron_axe', type: 5, count: 1 }
  ]
  const bot = new EventEmitter()
  Object.assign(bot, { inventory, entities: {}, players: {} })
  const executor = new ActionExecutor(bot, {})
  assert.deepEqual(
    executor.overflowCandidates('woodcutting', new Set(['any_log']))
      .map(({ item, quantity }) => [item.name, quantity]),
    [['oak_planks', 32], ['oak_sapling', 8], ['poppy', 6]]
  )
})

test('inventory pressure unloads bulk and valuable mining stacks into storage', async () => {
  const registry = require('prismarine-registry')('1.21.11')
  const makeItem = (name, count = 64) => ({
    ...registry.itemsByName[name], type: registry.itemsByName[name].id,
    name, count, metadata: null, nbt: null
  })
  const items = [makeItem('cobblestone'), makeItem('cobbled_deepslate'), makeItem('gravel')]
  for (let index = 0; items.length < 36; index += 1) {
    const name = ['diamond', 'coal', 'redstone', 'raw_iron', 'raw_gold'][index % 5]
    items.push(makeItem(name, 1))
  }
  const inventory = new EventEmitter()
  inventory.items = () => items
  const bot = new EventEmitter()
  Object.assign(bot, {
    registry, inventory, entities: {}, players: {},
    entity: { position: new Vec3(0, -59, 0) },
    pathfinder: { setGoal: () => {} },
    collectBlock: { cancelTask: async () => {} },
    clearControlStates: () => {}
  })
  const executor = new ActionExecutor(bot, { maxMoveDistance: 128 })
  const deposited = []
  executor.withNearestContainer = async (signal, operation) => operation({
    deposit: async (type, metadata, quantity) => {
      const index = items.findIndex((item) => item.type === type)
      deposited.push([items[index].name, quantity])
      items.splice(index, 1)
    }
  })
  const count = await executor.ensureTaskInventorySpace('mining', new AbortController().signal)
  assert.equal(count, 161)
  assert.deepEqual(deposited.slice(0, 2), [['cobbled_deepslate', 64], ['gravel', 64]])
  assert.ok(deposited.some(([name]) => name === 'diamond'))
  assert.equal(executor.inventoryTracker.freeSlots(), 35)
  executor.shutdown()
})

test('inventory pressure carries partial chest deposits into another chest', async () => {
  const registry = require('prismarine-registry')('1.21.11')
  const makeItem = (name, count = 64) => ({
    ...registry.itemsByName[name], type: registry.itemsByName[name].id,
    name, count, metadata: null, nbt: null
  })
  const items = [makeItem('cobblestone'), makeItem('cobbled_deepslate'), makeItem('gravel')]
  while (items.length < 36) items.push(makeItem('diamond', 1))
  const inventory = new EventEmitter()
  inventory.items = () => items
  const bot = new EventEmitter()
  Object.assign(bot, {
    registry, inventory, entities: {}, players: {},
    entity: { position: new Vec3(0, -59, 0) },
    pathfinder: { setGoal: () => {} },
    collectBlock: { cancelTask: async () => {} },
    clearControlStates: () => {}
  })
  const executor = new ActionExecutor(bot, { maxMoveDistance: 128 })
  const remove = (type, count) => {
    const index = items.findIndex((entry) => entry.type === type && entry.count > 0)
    items[index].count -= count
    if (items[index].count === 0) items.splice(index, 1)
  }
  let firstCapacity = 10
  const containers = [{
    deposit: async (type, metadata, count) => {
      const moved = Math.min(firstCapacity, count)
      if (moved) remove(type, moved)
      firstCapacity -= moved
      if (moved < count) throw new Error('destination full')
    }
  }, {
    deposit: async (type, metadata, count) => remove(type, count)
  }]
  let visits = 0
  executor.withNearestContainer = async (signal, operation) => {
    for (const container of containers) {
      visits += 1
      const result = await operation(container)
      if (result?.done ?? result) return result
    }
    throw new Error('no more containers')
  }
  executor.withRememberedContainer = async () => { throw new Error('local containers should be enough') }
  const deposited = await executor.ensureTaskInventorySpace('mining', new AbortController().signal)
  assert.equal(deposited, 161)
  assert.equal(visits, 4)
  assert.equal(executor.inventoryTracker.freeSlots(), 35)
  executor.shutdown()
})

test('storage markers recognize sign categories and exact item frames', () => {
  const registry = require('prismarine-registry')('1.21.11')
  const chestPosition = new Vec3(0, 64, 0)
  const neighboringChestPosition = new Vec3(1, 64, 0)
  const signPosition = new Vec3(0, 65, -1)
  const frameKeys = registry.entitiesByName.item_frame.metadataKeys
  const frameMetadata = []
  frameMetadata[frameKeys.indexOf('item')] = { type: registry.itemsByName.diamond.id }
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    registry,
    entities: {
      4: { name: 'item_frame', position: new Vec3(0.5, 64.5, 1), metadata: frameMetadata }
    },
    blockAt: (position) => position.equals(signPosition)
      ? { name: 'oak_wall_sign', position, getSignText: () => ['Stone Chest', ''] }
      : [chestPosition, neighboringChestPosition].some((chest) => position.equals(chest))
          ? { name: 'chest', position, boundingBox: 'block' }
          : { name: 'air', position, boundingBox: 'empty' }
  }
  const chest = { name: 'chest', position: chestPosition }
  const markers = executor.storageMarkers(chest)
  assert.equal(executor.containerAffinity({ containerItems: () => [] }, chest, 'cobblestone', markers), 400)
  assert.equal(executor.containerAffinity({ containerItems: () => [] }, chest, 'diamond', markers), 500)
  assert.equal(executor.containerAffinity({ containerItems: () => [] }, chest, 'oak_log', markers), 0)
  assert.deepEqual(executor.storageMarkers({ name: 'chest', position: neighboringChestPosition }), [])
})

test('inventory pressure sorts items into chests that already contain the same item', async () => {
  const registry = require('prismarine-registry')('1.21.11')
  const makeItem = (name, count) => ({
    ...registry.itemsByName[name], type: registry.itemsByName[name].id,
    name, count, metadata: null, nbt: null
  })
  const items = [makeItem('cobblestone', 64), makeItem('cobblestone', 64), makeItem('diamond', 8)]
  while (items.length < 36) items.push(makeItem('torch', 1))
  const inventory = new EventEmitter()
  inventory.items = () => items
  const bot = new EventEmitter()
  Object.assign(bot, {
    registry, inventory, entities: {}, players: {},
    entity: { position: new Vec3(0, 64, 0) },
    pathfinder: { setGoal: () => {} }, collectBlock: { cancelTask: async () => {} },
    clearControlStates: () => {}, blockAt: (position) => ({ name: 'air', position, boundingBox: 'empty' })
  })
  const executor = new ActionExecutor(bot, { pathSearchRadius: 32 })
  const moved = { stone: [], gems: [] }
  const remove = (type, count) => {
    const index = items.findIndex((item) => item.type === type)
    items[index].count -= count
    if (items[index].count === 0) items.splice(index, 1)
  }
  const destinations = [
    {
      block: { name: 'chest', position: new Vec3(1, 64, 0) },
      container: {
        containerItems: () => [makeItem('cobblestone', 1)],
        deposit: async (type, metadata, count) => { moved.stone.push(registry.items[type].name); remove(type, count) }
      }
    },
    {
      block: { name: 'chest', position: new Vec3(2, 64, 0) },
      container: {
        containerItems: () => [makeItem('diamond', 1)],
        deposit: async (type, metadata, count) => { moved.gems.push(registry.items[type].name); remove(type, count) }
      }
    }
  ]
  executor.withNearestContainer = async (signal, operation) => {
    for (const destination of destinations) {
      const result = await operation(destination.container, destination.block)
      if (result?.done ?? result) return result
    }
    throw new Error('no more containers')
  }
  executor.withRememberedContainer = async () => { throw new Error('local sorted storage should complete') }
  const deposited = await executor.ensureTaskInventorySpace('mining', new AbortController().signal)
  assert.equal(deposited, 72)
  assert.deepEqual(moved, { stone: ['cobblestone'], gems: ['diamond'] })
  assert.deepEqual(items.filter((item) => ['cobblestone', 'diamond'].includes(item.name)).map((item) => item.name), [
    'cobblestone'
  ])
  executor.shutdown()
})

test('mining preflight discovers and restocks an untracked nearby chest in one visit', async () => {
  const carried = []
  const stored = [
    { name: 'iron_pickaxe', type: 1, count: 1 },
    { name: 'torch', type: 2, count: 20 },
    { name: 'crafting_table', type: 3, count: 1 }
  ]
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { pathSearchRadius: 32 }
  executor.activity = null
  executor.bot = {
    entity: { position: new Vec3(0, -59, 0) },
    inventory: { items: () => carried }
  }
  executor.toolManager = { bestTool: () => null }
  executor.inventoryCount = (name) => carried.filter((item) => item.name === name).reduce((n, item) => n + item.count, 0)
  let visits = 0
  const container = {
    containerItems: () => stored,
    withdraw: async (type, metadata, count) => {
      const item = stored.find((entry) => entry.type === type)
      item.count -= count
      carried.push({ ...item, count })
    }
  }
  executor.withNearestContainer = async (signal, operation) => { visits += 1; return operation(container) }
  executor.withRememberedContainer = async () => { throw new Error('should not need remembered storage') }
  executor.gotoPositionSegmented = async () => {}
  const count = await executor.tryRestockMiningSupplies(new AbortController().signal)
  assert.equal(visits, 1)
  assert.equal(count, 22)
  assert.deepEqual(carried.map((item) => item.name), ['iron_pickaxe', 'torch', 'crafting_table'])
})

test('mining can place a local expedition chest when no storage is reachable', async () => {
  const carried = [{ name: 'oak_planks', type: 1, count: 12 }]
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    inventory: { items: () => carried },
    game: { dimension: 'overworld' }
  }
  executor.inventoryCount = (name) => carried.filter((item) => item.name === name).reduce((n, item) => n + item.count, 0)
  const position = new Vec3(2, -59, 0)
  executor.toolManager = {
    withCraftingTable: async (operation) => operation({ name: 'crafting_table' }),
    craftItem: async () => { carried.push({ name: 'chest', type: 2, count: 1 }); return true },
    placeInventoryBlock: async () => ({ name: 'chest', position })
  }
  let remembered
  executor.landmarks = { remember: (...args) => { remembered = args } }
  const chest = await executor.createExpeditionStorage(new AbortController().signal)
  assert.equal(chest.name, 'chest')
  assert.equal(remembered[3], 'container')
})

test('mining rolls over to another expedition chest when the first cannot free enough slots', async () => {
  const items = [
    { name: 'cobbled_deepslate', type: 1, count: 64 },
    { name: 'gravel', type: 2, count: 64 },
    { name: 'tuff', type: 3, count: 64 }
  ]
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { pathSearchRadius: 32 }
  executor.activity = null
  executor.bot = {
    entity: { position: new Vec3(0, -59, 0) },
    inventory: { items: () => items },
    game: { dimension: 'overworld' },
    openContainer: async () => containers[opened++],
    currentWindow: null
  }
  executor.inventoryPolicy = { freeTrashSlots: async () => {} }
  executor.inventoryTracker = { freeSlots: () => 3 - items.length }
  executor.inventoryCount = (name) => items
    .filter((item) => item.name === name)
    .reduce((total, item) => total + item.count, 0)
  executor.overflowCandidates = () => items.map((item) => ({ item, quantity: item.count }))
  executor.withNearestContainer = async () => { throw new Error('no local storage') }
  executor.withRememberedContainer = async () => { throw new Error('no remembered storage') }
  executor.recordGoalDeposit = () => {}
  executor.containerTracker = { record: () => {} }
  executor.landmarks = { remember: () => {} }
  let created = 0
  executor.createExpeditionStorage = async () => ({
    name: 'chest', position: new Vec3(++created, -59, 0)
  })
  const remove = (type) => {
    const index = items.findIndex((item) => item.type === type)
    if (index >= 0) items.splice(index, 1)
  }
  let firstAccepted = false
  const containers = [{
    deposit: async (type) => {
      if (firstAccepted) throw new Error('destination full')
      firstAccepted = true
      remove(type)
    },
    containerItems: () => [], close: () => {}
  }, {
    deposit: async (type) => remove(type),
    containerItems: () => [], close: () => {}
  }]
  let opened = 0
  const deposited = await executor.ensureTaskInventorySpace(
    'mining', new AbortController().signal, { minimumFreeSlots: 2 }
  )
  assert.equal(created, 2)
  assert.equal(opened, 2)
  assert.equal(deposited, 192)
  assert.equal(executor.inventoryTracker.freeSlots(), 3)
})

test('side-branch retreat follows short excavated waypoints without digging', async () => {
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { localPathSearchRadius: 10 }
  executor.bot = {
    entity: { position: new Vec3(16, -59, 0) },
    pathfinder: { movements: { canDig: true } }
  }
  const visited = []
  executor.gotoBounded = async (goal) => {
    assert.equal(executor.bot.pathfinder.movements.canDig, false)
    const point = new Vec3(goal.x, goal.y, goal.z)
    visited.push(point)
    executor.bot.entity.position = point
  }
  const route = Array.from({ length: 17 }, (_, x) => new Vec3(x, -59, 0))
  await executor.returnAlongExcavatedRoute(route, new AbortController().signal)
  assert.deepEqual(visited.map((point) => point.x), [12, 8, 4, 0])
  assert.equal(executor.bot.pathfinder.movements.canDig, true)
  assert.ok(executor.bot.entity.position.equals(route[0]))
})

test('strip mining changes direction rather than widening a parallel tunnel', () => {
  const start = new Vec3(0, -59, 0)
  const parallel = new Set()
  for (let x = 1; x <= 8; x += 1) {
    parallel.add(new Vec3(x, -59, -1).toString())
    parallel.add(new Vec3(x, -58, -1).toString())
  }
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    entity: { position: start },
    blockAt: (position) => parallel.has(position.toString())
      ? { name: 'air', position, boundingBox: 'empty' }
      : { name: 'deepslate', position, boundingBox: 'block' }
  }
  const eastScore = executor.stripMineOverlapScore(start, new Vec3(1, 0, 0), 16)
  assert.ok(eastScore >= 12)
  assert.notEqual(executor.chooseStripMineDirection('east', 16), 'east')
})

test('strip mining permits a single-cell crossing of an existing tunnel', () => {
  const start = new Vec3(0, -59, 0)
  const crossing = new Set([
    new Vec3(3, -59, 0).toString(), new Vec3(3, -58, 0).toString()
  ])
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    entity: { position: start },
    blockAt: (position) => crossing.has(position.toString())
      ? { name: 'air', position, boundingBox: 'empty' }
      : { name: 'deepslate', position, boundingBox: 'block' }
  }
  assert.equal(executor.chooseStripMineDirection('east', 16), 'east')
})

test('bounded general navigation cannot dig an unintended shortcut', async () => {
  let cleared = 0
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { localPathSearchRadius: 10 }
  executor.bot = {
    pathfinder: {
      searchRadius: 32,
      movements: { canDig: true, clearCollisionIndex: () => { cleared += 1 } },
      goto: async () => { assert.equal(executor.bot.pathfinder.movements.canDig, false) },
      stop: () => {}
    }
  }
  await executor.gotoBounded({ isEnd: () => true }, new AbortController().signal)
  assert.equal(executor.bot.pathfinder.movements.canDig, true)
  assert.equal(executor.bot.pathfinder.searchRadius, 32)
  assert.equal(cleared, 1)
})

test('staircase preflight chooses one clear heading before excavation', () => {
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    blockAt: (position) => position.z > 0
      ? { name: 'lava', position, boundingBox: 'empty', diggable: false }
      : { name: 'deepslate', position, boundingBox: 'block', diggable: true }
  }
  assert.equal(
    executor.chooseStraightStaircaseDirection(new Vec3(0, 20, 0), 8, 'south'),
    'north'
  )
})

test('staircase preflight keeps a straight heading across dry gaps when scaffold is carried', () => {
  const gaps = new Set([
    new Vec3(0, 18, 1).toString(), new Vec3(-1, 18, 1).toString()
  ])
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    inventory: { items: () => [{ name: 'cobbled_deepslate', type: 4, count: 16 }] },
    blockAt: (position) => gaps.has(position.toString())
      ? { name: 'air', position, boundingBox: 'empty' }
      : { name: 'deepslate', position, boundingBox: 'block', diggable: true }
  }
  assert.equal(
    executor.chooseStraightStaircaseDirection(new Vec3(0, 20, 0), 8, 'south'),
    'south'
  )
})

test('staircase floor repair accepts a delayed placement acknowledgement', async () => {
  const target = new Vec3(1, 63, 0)
  const reference = new Vec3(0, 63, 0)
  let placed = false
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [{ name: 'dirt', type: 3, count: 8 }] },
    blockAt: (position) => {
      if (position.equals(target)) {
        return placed
          ? { name: 'dirt', position, boundingBox: 'block' }
          : { name: 'air', position, boundingBox: 'empty' }
      }
      if (position.equals(reference)) return { name: 'stone', position, boundingBox: 'block' }
      return { name: 'air', position, boundingBox: 'empty' }
    },
    equip: async () => {},
    placeBlock: async () => {
      setTimeout(() => { placed = true }, 25)
      throw new Error('Event blockUpdate did not fire within timeout')
    }
  }
  assert.equal(await executor.repairStairFloor(target, new AbortController().signal), true)
  assert.equal(placed, true)
})

test('staircase descent stays straight and stops instead of turning around an obstacle', async () => {
  const start = new Vec3(0, 10, 0)
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    entity: { position: start.clone() },
    game: { dimension: 'overworld' },
    blockAt: (position) => ({ name: 'deepslate', position, boundingBox: 'block', diggable: true })
  }
  executor.landmarks = { remember: () => {} }
  const excavated = []
  executor.excavateMiningStep = async (position) => {
    excavated.push(position.clone())
    if (position.equals(new Vec3(0, 7, 3))) throw new Error('lava ahead')
  }
  executor.gotoBounded = async (goal) => {
    executor.bot.entity.position = new Vec3(goal.x, goal.y, goal.z)
  }
  executor.placeTunnelTorch = async () => {}
  await assert.rejects(
    executor.descendStaircase(6, 'south', new AbortController().signal),
    /straight staircase south blocked after 2 steps: lava ahead/
  )
  assert.deepEqual(excavated.map((position) => [position.x, position.y, position.z]), [
    [0, 9, 1], [-1, 9, 1],
    [0, 8, 2], [-1, 8, 2],
    [0, 7, 3]
  ])
})

test('container tracker records inspected contents and removes broken containers', () => {
  class Bot extends EventEmitter {}
  const bot = new Bot()
  const tracker = new ContainerTracker(bot)
  const position = new Vec3(3, 64, 4)
  const block = { name: 'chest', position }
  tracker.record(block, {
    containerItems: () => [{ name: 'cobblestone', count: 32 }, { name: 'torch', count: 8 }]
  })
  assert.deepEqual(tracker.summary(new Vec3(0, 64, 0))[0].contents, { cobblestone: 32, torch: 8 })
  bot.emit('blockUpdate', block, { name: 'air', position })
  assert.equal(tracker.summary(new Vec3(0, 64, 0)).length, 0)
  tracker.shutdown()
})

test('nearby container opening creates one window and remains abortable', async () => {
  const position = new Vec3(1, 64, 0)
  let opens = 0
  const container = { close: () => {} }
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { collectSearchDistance: 64, maxMoveDistance: 128, pathSearchRadius: 32 }
  executor.bot = {
    registry: { blocksByName: { chest: { id: 5 } } },
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: () => ({ name: 'chest', position }),
    openContainer: async () => { opens += 1; return container },
    currentWindow: null
  }
  executor.blockTracker = { find: () => [position], markUnreachable: () => {} }
  executor.landmarks = null
  const result = await executor.openNearestContainer(new AbortController().signal)
  assert.equal(result.container, container)
  assert.equal(opens, 1)
})

test('automatic storage skips a full nearby chest and tries the next chest', async () => {
  const positions = [new Vec3(1, 64, 0), new Vec3(2, 64, 0)]
  let opened = 0
  const cooledDown = []
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = { game: { dimension: 'overworld' } }
  executor.landmarks = null
  executor.containerTracker = { record: () => {} }
  executor.blockTracker = { markUnreachable: (position) => cooledDown.push(position.clone()) }
  executor.openNearestContainer = async () => {
    const position = positions[opened]
    const useful = opened === 1
    opened += 1
    return {
      block: { name: 'chest', position },
      container: { useful, containerItems: () => [], close: () => {} }
    }
  }
  const result = await executor.withNearestContainer(
    new AbortController().signal,
    async (container) => container.useful,
    32,
    true
  )
  assert.equal(result, true)
  assert.equal(opened, 2)
  assert.equal(cooledDown.length, 1)
  assert.ok(cooledDown[0].equals(positions[0]))
})

test('remembered storage forgets missing chests and continues to a useful chest', async () => {
  const missing = { name: 'missing', type: 'container', x: 1, y: 64, z: 0 }
  const useful = { name: 'useful', type: 'container', x: 2, y: 64, z: 0 }
  const forgotten = []
  let opens = 0
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { maxExpeditionDistance: 128 }
  executor.bot = {
    game: { dimension: 'overworld' },
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: (position) => position.x === 1
      ? { name: 'air', position }
      : { name: 'chest', position },
    openContainer: async () => {
      opens += 1
      return { containerItems: () => [{ name: 'torch', count: 8 }], close: () => {} }
    },
    currentWindow: null
  }
  executor.gotoPositionSegmented = async () => {}
  executor.landmarks = {
    list: () => [missing, useful],
    forget: (name) => forgotten.push(name),
    remember: () => {}
  }
  executor.containerTracker = { record: () => {} }
  executor.blockTracker = { markUnreachable: () => {} }
  const result = await executor.withRememberedContainer(
    new AbortController().signal,
    async (container) => container.containerItems().some((item) => item.name === 'torch'),
    null,
    true
  )
  assert.equal(result, true)
  assert.deepEqual(forgotten, ['missing'])
  assert.equal(opens, 1)
})

test('dropped-item collection waits for the server pickup instead of assuming success', async () => {
  const item = { id: 7, position: new Vec3(0.5, 64, 0.5) }
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    entity: { position: new Vec3(0, 64, 0) },
    entities: { 7: item }
  }
  setTimeout(() => { delete executor.bot.entities[7] }, 20)
  const result = await executor.collectDroppedEntities([item], new AbortController().signal)
  assert.equal(result, 1)
})

test('ceiling ore drops are allowed to fall before pathfinding is attempted', async () => {
  const item = { id: 8, position: new Vec3(0.5, 67, 0.5) }
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    entities: { 8: item }
  }
  let paths = 0
  executor.gotoBounded = async () => { paths += 1 }
  setTimeout(() => { item.position = new Vec3(0.5, 64.5, 0.5) }, 20)
  setTimeout(() => { delete executor.bot.entities[8] }, 40)
  const result = await executor.collectDroppedEntities([item], new AbortController().signal)
  assert.equal(result, 1)
  assert.equal(paths, 0)
})

test('explicit pickup reports a partial result instead of claiming the requested quantity', async () => {
  const executor = Object.create(ActionExecutor.prototype)
  let carried = 0
  executor.limits = { maxMoveDistance: 32 }
  executor.ensureCollectBlockSlot = async () => {}
  executor.inventoryTracker = { canAccept: () => true }
  executor.entityTracker = {
    droppedItems: () => [{
      entity: { id: 4, position: new Vec3(1, 64, 0) },
      item: { name: 'oak_log', count: 1 }
    }]
  }
  executor.inventoryCount = () => carried
  executor.collectDroppedEntities = async () => { carried = 1; return 1 }
  await assert.rejects(
    executor.pickup(
      { type: 'pickup', item: 'oak_log', quantity: 2 }, new AbortController().signal
    ),
    (error) => error.category === 'missing_resource' && /1\/2/.test(error.message)
  )
})

test('deposit and withdraw transfer exact validated quantities', async () => {
  const registry = require('prismarine-registry')('1.21.11')
  const cobblestone = {
    ...registry.itemsByName.cobblestone,
    type: registry.itemsByName.cobblestone.id,
    count: 40,
    metadata: null,
    nbt: null
  }
  const inventory = new EventEmitter()
  inventory.items = () => [cobblestone]
  const bot = new EventEmitter()
  Object.assign(bot, {
    registry,
    inventory,
    entities: {},
    players: {},
    entity: { position: new Vec3(0, 64, 0) },
    pathfinder: { setGoal: () => {} },
    collectBlock: { cancelTask: async () => {} },
    clearControlStates: () => {}
  })
  const executor = new ActionExecutor(bot, { maxMoveDistance: 64, collectSearchDistance: 64 })
  const transfers = []
  executor.withNearestContainer = async (signal, operation) => operation({
    containerItems: () => [{ ...cobblestone, count: 20 }],
    deposit: async (type, metadata, count) => transfers.push(['deposit', type, count]),
    withdraw: async (type, metadata, count) => transfers.push(['withdraw', type, count])
  })
  await executor.deposit({ item: 'cobblestone', quantity: 12 }, new AbortController().signal)
  await executor.withdraw({ item: 'cobblestone', quantity: 16 }, new AbortController().signal)
  assert.deepEqual(transfers, [
    ['deposit', cobblestone.id, 12], ['withdraw', cobblestone.id, 16]
  ])
  executor.shutdown()
})

test('explicit storage transfers continue exact remainders across multiple containers', async () => {
  const item = { name: 'cobblestone', type: 4, count: 12, metadata: null, nbt: null }
  let inventoryItems = [item]
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { collectSearchDistance: 64 }
  executor.bot = { inventory: { items: () => inventoryItems } }
  executor.inventoryPolicy = { freeTrashSlots: async () => 0 }
  executor.withRememberedContainer = async () => { throw new Error('local containers should complete transfer') }

  const runAcross = async (operation, containers) => {
    for (const container of containers) {
      if (await operation(container)) return true
    }
    throw new Error('no more local containers')
  }
  const firstDeposit = {
    deposit: async (type, metadata, count) => {
      const moved = Math.min(5, count)
      item.count -= moved
      throw new Error('destination full')
    }
  }
  const secondDeposit = {
    deposit: async (type, metadata, count) => { item.count -= count }
  }
  executor.withNearestContainer = async (signal, operation) =>
    runAcross(operation, [firstDeposit, secondDeposit])
  await executor.deposit({ item: 'cobblestone', quantity: 12 }, new AbortController().signal)
  assert.equal(item.count, 0)

  inventoryItems = []
  const stored = [{ count: 5 }, { count: 7 }]
  const withdrawContainers = stored.map((stack) => ({
    containerItems: () => stack.count
      ? [{ name: 'cobblestone', type: 4, count: stack.count, metadata: null, nbt: null }]
      : [],
    withdraw: async (type, metadata, count) => {
      stack.count -= count
      const carried = inventoryItems.find((entry) => entry.name === 'cobblestone')
      if (carried) carried.count += count
      else inventoryItems.push({ name: 'cobblestone', type: 4, count })
    }
  }))
  executor.withNearestContainer = async (signal, operation) =>
    runAcross(operation, withdrawContainers)
  await executor.withdraw({ item: 'cobblestone', quantity: 12 }, new AbortController().signal)
  assert.equal(executor.inventoryMatchingCount('cobblestone'), 12)
  assert.deepEqual(stored.map((stack) => stack.count), [0, 0])
})

test('event monitor emits immediate environmental hazard interrupts', () => {
  class Bot extends EventEmitter {}
  const bot = new Bot()
  Object.assign(bot, {
    health: 20,
    food: 20,
    oxygenLevel: 4,
    isAlive: true,
    entities: {},
    game: { dimension: 'overworld' },
    registry: { foodsByName: {} },
    inventory: { items: () => [{ name: 'iron_pickaxe', count: 1 }] },
    entity: {
      position: new Vec3(0, 64, 0),
      velocity: new Vec3(0, 0, 0),
      isInWater: true,
      isInLava: false,
      onGround: false,
      metadata: [0]
    }
  })
  const monitor = new EventMonitor(bot)
  const interrupts = []
  monitor.on('interrupt', (event) => interrupts.push(event))

  monitor.scanHazards()
  assert.equal(interrupts.at(-1).type, 'drowning')

  bot.entity.isInWater = false
  bot.entity.isInLava = true
  monitor.scanHazards()
  assert.equal(interrupts.at(-1).type, 'lava')

  bot.entity.isInLava = false
  bot.entity.position.y = 56
  bot.entity.velocity.y = -0.8
  monitor.fallStartY = 64
  monitor.scanHazards()
  assert.equal(interrupts.at(-1).type, 'dangerous_fall')

  bot.entity.onGround = true
  bot.entity.metadata[0] = 1
  const beforeResidualFire = interrupts.length
  monitor.scanHazards()
  assert.equal(interrupts.length, beforeResidualFire)
  monitor.fireStartedAt = Date.now() - 1600
  monitor.scanHazards()
  assert.equal(interrupts.at(-1).type, 'on_fire')
  monitor.shutdown()
})

test('hunger interrupt fires even when food must be acquired', () => {
  class Bot extends EventEmitter {}
  const bot = new Bot()
  Object.assign(bot, {
    health: 20, food: 8, oxygenLevel: 20, isAlive: true,
    entity: { position: new Vec3(0, 64, 0), onGround: true, metadata: [] },
    inventory: { items: () => [] }, registry: { foodsByName: {} }, entities: {},
    blockAt: () => ({ name: 'air', boundingBox: 'empty' })
  })
  const monitor = new EventMonitor(bot)
  let trigger = null
  monitor.on('interrupt', (value) => { if (value.type === 'needs_food') trigger = value })
  monitor.scanFood()
  assert.equal(trigger.hasFood, false)
  monitor.shutdown()
})

test('event monitor checkpoints death position and carried inventory', () => {
  class Bot extends EventEmitter {}
  const bot = new Bot()
  Object.assign(bot, {
    health: 0,
    food: 12,
    oxygenLevel: 20,
    entities: {},
    game: { dimension: 'overworld' },
    registry: { foodsByName: {} },
    inventory: { items: () => [{ name: 'diamond', count: 3 }] },
    entity: {
      position: new Vec3(8.5, -54, -2.5),
      velocity: new Vec3(0, 0, 0),
      isInWater: false,
      isInLava: false,
      onGround: true,
      metadata: [0]
    }
  })
  const monitor = new EventMonitor(bot)
  let death
  monitor.on('interrupt', (event) => { death = event })
  bot.emit('death')
  assert.deepEqual(death, {
    type: 'death',
    position: { x: 8.5, y: -54, z: -2.5 },
    dimension: 'overworld',
    inventory: [{ name: 'diamond', count: 3 }]
  })
  monitor.shutdown()
})

test('environmental escape selects nearby dry footing instead of an arbitrary heading', () => {
  const inventory = new EventEmitter()
  inventory.items = () => []
  const bot = new EventEmitter()
  Object.assign(bot, {
    inventory,
    entities: {},
    players: {},
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: (position) => {
      if (position.x === -1 && position.z === 0 && position.y === 64) {
        return { name: 'water', boundingBox: 'empty', position }
      }
      const isEscapeAir = position.x === 2 && position.z === 0 && (position.y === 64 || position.y === 65)
      return {
        name: isEscapeAir ? 'air' : 'stone',
        boundingBox: isEscapeAir ? 'empty' : 'block',
        position
      }
    }
  })
  const executor = new ActionExecutor(bot, {})
  assert.deepEqual(executor.safeEscapePositions(3)[0], new Vec3(2, 64, 0))
  assert.deepEqual(executor.nearbyWaterPositions(3)[0], new Vec3(-1, 64, 0))
  executor.shutdown = () => {}
})

test('threat scan sees ranged attackers early but ignores conditionally neutral mobs', () => {
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    entities: {
      1: { id: 1, name: 'enderman', position: new Vec3(2, 64, 0) },
      2: { id: 2, name: 'skeleton', position: new Vec3(11, 64, 0) }
    }
  }
  assert.equal(nearestThreat(bot).entity.id, 2)
  bot.entities = { 1: bot.entities[1] }
  assert.equal(nearestThreat(bot), null)
  assert.equal(nearestThreat(bot, 6, { includeConditional: true }).entity.id, 1)
})

test('suffocation recovery repeatedly clears the block intersecting the bot head', async () => {
  let trapped = true
  let dug = 0
  const inventory = new EventEmitter()
  inventory.items = () => []
  const bot = new EventEmitter()
  Object.assign(bot, {
    inventory,
    entities: {},
    players: {},
    isAlive: true,
    entity: { position: new Vec3(0.5, 64, 0.5) },
    blockAt: (position) => trapped && position.y === 65
      ? { name: 'gravel', boundingBox: 'block', diggable: true, position }
      : { name: 'air', boundingBox: 'empty', diggable: false, position },
    tool: { equipForBlock: async () => {} },
    dig: async () => { dug += 1; trapped = false },
    stopDigging: () => {},
    clearControlStates: () => {},
    setControlState: () => {}
  })
  assert.equal(suffocatingBlock(bot).name, 'gravel')
  const executor = new ActionExecutor(bot, {})
  const result = await executor.escapeSuffocation(new AbortController().signal)
  assert.match(result, /clearing 1/)
  assert.equal(dug, 1)
  assert.equal(suffocatingBlock(bot), null)
})

test('modern item components cannot crash compatible tool selection', () => {
  const brokenEnchantItem = {
    name: 'iron_pickaxe', type: 2, slot: 9, nbt: { legacy: true },
    get enchants() { throw new TypeError('enchantments is not iterable') }
  }
  const hand = { name: 'stick', type: 1, slot: 10, nbt: null, enchants: [] }
  const bot = {
    entity: { effects: {}, onGround: true },
    inventory: { items: () => [hand, brokenEnchantItem], slots: [] },
    tool: {},
    pathfinder: {},
    heldItem: brokenEnchantItem,
    game: { gameMode: 'survival' },
    getEquipmentDestSlot: () => 5,
    _getBlockAtEyeLevel: () => ({ name: 'air' })
  }
  const block = {
    digTime: (type, creative, water, airborne, enchantments) => {
      assert.ok(Array.isArray(enchantments))
      return type === 2 ? 100 : 1000
    }
  }
  assert.deepEqual(safeEnchantments(brokenEnchantItem), [])
  assert.equal(installToolCompatibility(bot), true)
  assert.equal(bot.tool.getDigTime(block, brokenEnchantItem), 100)
  assert.equal(bot.digTime(block), 100)
  const selected = bot.pathfinder.bestHarvestTool(block)
  assert.equal(selected.slot, 9)
  assert.equal(selected.nbt, null)
})

test('targeted mining ignores unrelated exposed ores', () => {
  const registry = require('prismarine-registry')('1.21.11')
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = { registry }
  const diamonds = executor.oreBlockTypes('diamond').map((block) => block.name).sort()
  assert.deepEqual(diamonds, ['deepslate_diamond_ore', 'diamond_ore'])
  assert.ok(executor.oreBlockTypes('general').length > diamonds.length)
  assert.equal(executor.oreBlockTypes('diamond').some((block) => block.name.includes('copper')), false)
})

test('exposed ore mining digs reachable blocks directly without collectBlock pathfinding', async () => {
  const orePosition = new Vec3(2, -58, 0)
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { maxMoveDistance: 128 }
  executor.bot = {
    entity: { position: new Vec3(0, -59, 0) },
    blockAt: (position) => position.equals(orePosition)
      ? { name: 'deepslate_redstone_ore', type: 7, position, boundingBox: 'block' }
      : { name: 'air', type: 0, position, boundingBox: 'empty' },
    canSeeBlock: () => true,
    collectBlock: {
      collect: () => { throw new Error('collectBlock must not be used for exposed ore') }
    }
  }
  executor.blockTracker = { find: () => [orePosition] }
  executor.oreBlockTypes = () => [{ id: 7 }]
  executor.ensureCollectBlockSlot = async () => {}
  const dug = []
  executor.digTunnelBlock = async (position) => dug.push(position.clone())
  await executor.collectExposedOres(new AbortController().signal, new Set(), 'redstone')
  assert.equal(dug.length, 1)
  assert.ok(dug[0].equals(orePosition))
})

test('exposed ore mining defers blocks outside normal player reach', async () => {
  const orePosition = new Vec3(6, -59, 0)
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    entity: { position: new Vec3(0, -59, 0) },
    blockAt: (position) => position.equals(orePosition)
      ? { name: 'diamond_ore', type: 8, position, boundingBox: 'block' }
      : { name: 'air', type: 0, position, boundingBox: 'empty' },
    canSeeBlock: () => true
  }
  executor.blockTracker = { find: () => [orePosition] }
  executor.oreBlockTypes = () => [{ id: 8 }]
  executor.ensureCollectBlockSlot = async () => {}
  let dug = false
  executor.digTunnelBlock = async () => { dug = true }
  await executor.collectExposedOres(new AbortController().signal, new Set(), 'diamond')
  assert.equal(dug, false)
})

test('connected ore mining follows an exposed vein without general pathfinding', async () => {
  const first = new Vec3(2, -58, 0)
  const second = new Vec3(3, -57, 1)
  const oreKeys = new Set([first.toString(), second.toString()])
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    entity: { position: new Vec3(0, -59, 0) },
    blockAt: (position) => oreKeys.has(position.toString())
      ? { name: 'diamond_ore', type: 8, position, boundingBox: 'block' }
      : { name: 'air', type: 0, position, boundingBox: 'empty' },
    canSeeBlock: () => true
  }
  executor.ensureCollectBlockSlot = async () => {}
  executor.digTunnelBlock = async (position) => { oreKeys.delete(position.toString()) }
  const mined = await executor.mineConnectedOreVein(
    { name: 'diamond_ore', type: 8, position: first }, new Set([8]),
    new AbortController().signal, new Set(), new Vec3(0, -59, 0)
  )
  assert.equal(mined, 2)
})

test('connected ore mining reaches a ceiling ore when the direct vertical shaft is clear', async () => {
  const orePosition = new Vec3(0, -57, 0)
  let present = true
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    entity: { position: new Vec3(0, -59, 0) },
    blockAt: (position) => present && position.equals(orePosition)
      ? { name: 'deepslate_diamond_ore', type: 8, position, boundingBox: 'block' }
      : { name: 'air', type: 0, position, boundingBox: 'empty' },
    // Mineflayer can miss the underside of a close ceiling block because its
    // ray length is measured to the block corner instead of the hit face.
    canSeeBlock: () => false
  }
  executor.ensureCollectBlockSlot = async () => {}
  executor.digTunnelBlock = async (position) => {
    assert.ok(position.equals(orePosition))
    present = false
  }
  const mined = await executor.mineConnectedOreVein(
    { name: 'deepslate_diamond_ore', type: 8, position: orePosition }, new Set([8]),
    new AbortController().signal, new Set(), new Vec3(0, -59, 0)
  )
  assert.equal(mined, 1)
})

test('connected ore mining steps aside before digging an ore under its feet', async () => {
  const orePosition = new Vec3(0, -60, 0)
  const safeStance = new Vec3(1, -59, 0)
  let present = true
  const air = (position) => ({ name: 'air', type: 0, position, boundingBox: 'empty' })
  const stone = (position) => ({ name: 'deepslate', type: 2, position, boundingBox: 'block' })
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    entity: { position: new Vec3(0, -59, 0) },
    blockAt: (position) => {
      if (present && position.equals(orePosition)) {
        return { name: 'deepslate_diamond_ore', type: 8, position, boundingBox: 'block' }
      }
      if (position.equals(safeStance) || position.equals(safeStance.offset(0, 1, 0))) return air(position)
      if (position.equals(safeStance.offset(0, -1, 0))) return stone(position)
      if (position.equals(new Vec3(0, -59, 0)) || position.equals(new Vec3(0, -58, 0))) return air(position)
      return stone(position)
    },
    canSeeBlock: () => executor.bot.entity.position.equals(safeStance),
    pathfinder: { movements: { canDig: true } }
  }
  executor.gotoBounded = async (goal) => {
    executor.bot.entity.position = new Vec3(goal.x, goal.y, goal.z)
  }
  executor.ensureCollectBlockSlot = async () => {}
  executor.digTunnelBlock = async (position) => {
    assert.ok(executor.bot.entity.position.equals(safeStance))
    assert.ok(position.equals(orePosition))
    present = false
  }
  const mined = await executor.mineConnectedOreVein(
    { name: 'deepslate_diamond_ore', type: 8, position: orePosition }, new Set([8]),
    new AbortController().signal, new Set(), new Vec3(0, -59, 0)
  )
  assert.equal(mined, 1)
})

test('connected ore mining carves a safe side pocket to reach an ore under its feet', async () => {
  const orePosition = new Vec3(0, -60, 0)
  const start = new Vec3(0, -59, 0)
  const safeStance = new Vec3(1, -59, 0)
  const pocketFeet = safeStance.clone()
  const pocketHead = safeStance.offset(0, 1, 0)
  const pocketFloor = safeStance.offset(0, -1, 0)
  const cleared = new Set([start.toString(), start.offset(0, 1, 0).toString()])
  let present = true
  const air = (position) => ({ name: 'air', type: 0, position, boundingBox: 'empty' })
  const stone = (position, diggable = true) => ({
    name: diggable ? 'deepslate' : 'bedrock',
    type: diggable ? 2 : 3,
    position,
    boundingBox: 'block',
    diggable
  })
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    entity: { position: start.clone() },
    blockAt: (position) => {
      if (present && position.equals(orePosition)) {
        return { name: 'deepslate_diamond_ore', type: 8, position, boundingBox: 'block', diggable: true }
      }
      if (cleared.has(position.toString())) return air(position)
      if (position.equals(pocketFloor) || position.equals(pocketFeet) || position.equals(pocketHead)) {
        return stone(position)
      }
      return stone(position, false)
    },
    canSeeBlock: () => executor.bot.entity.position.equals(safeStance),
    pathfinder: { movements: { canDig: true } }
  }
  executor.gotoBounded = async (goal) => {
    executor.bot.entity.position = new Vec3(goal.x, goal.y, goal.z)
  }
  executor.ensureCollectBlockSlot = async () => {}
  const dug = []
  executor.digTunnelBlock = async (position) => {
    dug.push(position.clone())
    if (position.equals(orePosition)) {
      assert.ok(executor.bot.entity.position.equals(safeStance))
      present = false
    } else {
      cleared.add(position.toString())
    }
  }
  const mined = await executor.mineConnectedOreVein(
    { name: 'deepslate_diamond_ore', type: 8, position: orePosition }, new Set([8]),
    new AbortController().signal, new Set(), start
  )
  assert.equal(mined, 1)
  assert.equal(dug.length, 3)
  assert.ok(dug[0].equals(pocketHead))
  assert.ok(dug[1].equals(pocketFeet))
  assert.ok(dug[2].equals(orePosition))
})

test('connected ore mining leaves an underfoot ore when there is no safe adjacent stance', async () => {
  const orePosition = new Vec3(0, -60, 0)
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    entity: { position: new Vec3(0, -59, 0) },
    blockAt: (position) => position.equals(orePosition)
      ? { name: 'diamond_ore', type: 8, position, boundingBox: 'block' }
      : { name: 'deepslate', type: 2, position, boundingBox: 'block' },
    canSeeBlock: () => true,
    pathfinder: { movements: { canDig: true } }
  }
  executor.ensureCollectBlockSlot = async () => {}
  let dug = false
  executor.digTunnelBlock = async () => { dug = true }
  const mined = await executor.mineConnectedOreVein(
    { name: 'diamond_ore', type: 8, position: orePosition }, new Set([8]),
    new AbortController().signal, new Set(), new Vec3(0, -59, 0)
  )
  assert.equal(mined, 0)
  assert.equal(dug, false)
})

test('ordinary collection digs from a bounded player stance without collectBlock planning', async () => {
  const position = new Vec3(2, 64, 0)
  let present = true
  let dug = 0
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { pathSearchRadius: 32 }
  executor.bot = {
    entity: { position: new Vec3(0, 64, 0) },
    heldItem: { type: 4 },
    blockAt: () => present
      ? { name: 'oak_log', type: 7, position, diggable: true, harvestTools: null }
      : { name: 'air', type: 0, position, boundingBox: 'empty' },
    canSeeBlock: () => true,
    tool: { equipForBlock: async () => {} },
    dig: async () => { dug += 1; present = false },
    stopDigging: () => {},
    collectBlock: { collect: () => { throw new Error('general collectBlock planner must not run') } }
  }
  await executor.collectBlockBounded(
    { name: 'oak_log', type: 7, position }, new AbortController().signal, 16
  )
  assert.equal(dug, 1)
})

test('bounded collection replaces a broken tool and retries the same block once', async () => {
  const position = new Vec3(2, 64, 0)
  let present = true
  let digs = 0
  let toolChecks = 0
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { pathSearchRadius: 32 }
  executor.toolManager = {
    ensureTool: async (tool) => {
      assert.equal(tool, 'pickaxe')
      toolChecks += 1
      return { name: 'stone_pickaxe' }
    }
  }
  executor.bot = {
    entity: { position: new Vec3(0, 64, 0) },
    heldItem: { type: 4 },
    blockAt: () => present
      ? { name: 'stone', type: 7, position, diggable: true, harvestTools: null }
      : { name: 'air', type: 0, position, boundingBox: 'empty' },
    canSeeBlock: () => true,
    tool: { equipForBlock: async () => {} },
    dig: async () => { digs += 1; if (digs === 2) present = false },
    stopDigging: () => {}
  }
  await executor.collectBlockBounded(
    { name: 'stone', type: 7, position }, new AbortController().signal, 16, 'pickaxe'
  )
  assert.equal(digs, 2)
  assert.equal(toolChecks, 2)
})

test('farming harvests only mature crops and replants seed', async () => {
  const position = new Vec3(1, 64, 0)
  let planted = true
  let replanted = 0
  const seed = { name: 'wheat_seeds', type: 10, count: 8 }
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    registry: { blocksByName: { wheat: { id: 7 } } },
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [seed] },
    blockAt: (at) => {
      if (at.equals(position)) return planted
        ? { name: 'wheat', type: 7, position: at, boundingBox: 'empty', getProperties: () => ({ age: 7 }) }
        : { name: 'air', type: 0, position: at, boundingBox: 'empty' }
      if (at.equals(position.offset(0, -1, 0))) return { name: 'farmland', position: at, boundingBox: 'block' }
      return { name: 'air', position: at, boundingBox: 'empty' }
    },
    dig: async () => { planted = false },
    equip: async () => {},
    placeBlock: async () => { planted = true; replanted += 1 }
  }
  executor.blockTracker = { find: () => [position] }
  let preserved
  executor.ensureTaskInventorySpace = async (context, signal, options) => {
    preserved = options.preserveItems
    return 0
  }
  const result = await executor.farm({ type: 'farm', crop: 'wheat', radius: 16 }, new AbortController().signal)
  assert.match(result, /Harvested 1 wheat and replanted 1/)
  assert.equal(replanted, 1)
  assert.equal(preserved.has('wheat_seeds'), true)
})

test('combat uses a weapon until the target is defeated', async () => {
  const target = { id: 9, name: 'zombie', height: 1.8, position: new Vec3(2, 64, 0) }
  const entities = { 9: target }
  let hits = 0
  const executor = Object.create(ActionExecutor.prototype)
  executor.limits = { maxMoveDistance: 128 }
  executor.bot = {
    entities, health: 20,
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [{ name: 'iron_sword', type: 1, count: 1 }] },
    equip: async () => {}, lookAt: async () => {},
    attack: () => { hits += 1; delete entities[9] }
  }
  const result = await executor.attack({ type: 'attack', entityId: 9 }, new AbortController().signal)
  assert.match(result, /Defeated entity 9/)
  assert.equal(hits, 1)
})

test('combat detects only projectiles moving toward the bot', () => {
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    entity: { position: new Vec3(0, 64, 0) },
    entities: {
      1: { id: 1, name: 'arrow', position: new Vec3(5, 64, 0), velocity: new Vec3(-1, 0, 0) },
      2: { id: 2, name: 'arrow', position: new Vec3(2, 64, 0), velocity: new Vec3(1, 0, 0) }
    }
  }
  assert.equal(executor.incomingProjectile().entity.id, 1)
})

test('automatic defense fights only nearby low-risk hostiles when healthy and armed', () => {
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    health: 20, food: 20,
    inventory: { items: () => [{ name: 'iron_sword', maxDurability: 250, durabilityUsed: 0 }] }
  }
  assert.equal(executor.shouldDefendAgainst({
    entity: { name: 'zombie' }, distance: 3
  }), true)
  assert.equal(executor.shouldDefendAgainst({
    entity: { name: 'creeper' }, distance: 2
  }), false)
  executor.bot.health = 8
  assert.equal(executor.shouldDefendAgainst({
    entity: { name: 'zombie' }, distance: 3
  }), false)
})

test('craft actions are idempotent inventory targets', async () => {
  const executor = Object.create(ActionExecutor.prototype)
  executor.bot = {
    registry: { itemsByName: { torch: { id: 1 } } },
    inventory: { items: () => [{ name: 'torch', type: 1, count: 16 }] },
    recipesFor: () => { throw new Error('recipe lookup should not run when target is satisfied') }
  }
  const result = await executor.craft({ type: 'craft', item: 'torch', quantity: 16 }, new AbortController().signal)
  assert.match(result, /Already have 16\/16/)
})
