'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  completionSatisfied,
  hasToolSet,
  inventoryCount,
  resourceCount,
  isProgressQuestion,
  isResumeRequest,
  abortableDelay,
  plannerRetryDelay,
  actionFingerprint,
  worldProgressFingerprint,
  applyTaskProgressResume,
  missingEquipmentForFailure,
  missingBuildMaterialForFailure,
  missingBuildQuantityForFailure,
  isBuildSupplyAcknowledgement
} = require('../src/controller/bot-controller')

function botWith(items) {
  return { inventory: { items: () => items } }
}

test('checks inventory completion without model inference', () => {
  const bot = botWith([
    { name: 'oak_log', count: 40 },
    { name: 'birch_log', count: 24 },
    { name: 'stick', count: 2 }
  ])
  assert.equal(inventoryCount(bot, 'any_log'), 64)
  assert.equal(completionSatisfied(bot, { type: 'inventory_count', item: 'any_log', quantity: 64 }), true)
  assert.equal(completionSatisfied(bot, { type: 'inventory_count', item: 'oak_log', quantity: 64 }), false)
})

test('accepts an equal or better complete tool set', () => {
  const bot = botWith(['pickaxe', 'axe', 'shovel', 'hoe'].map((tool) => ({
    name: `iron_${tool}`, count: 1
  })))
  assert.equal(hasToolSet(bot, 'stone'), true)
  assert.equal(hasToolSet(bot, 'diamond'), false)
})

test('action sequences complete only after the batch runs', () => {
  const bot = botWith([])
  const completion = { type: 'action_sequence' }
  assert.equal(completionSatisfied(bot, completion), false)
  assert.equal(completionSatisfied(bot, completion, true), true)
})

test('resource totals include raw and smelted items while persistent tasks stay active', () => {
  const bot = botWith([{ name: 'raw_iron', count: 4 }, { name: 'iron_ingot', count: 3 }])
  assert.equal(resourceCount(bot, 'iron'), 7)
  assert.equal(completionSatisfied(bot, { type: 'resource_count', resource: 'iron', quantity: 7 }), true)
  assert.equal(completionSatisfied(bot, { type: 'persistent' }, true), false)
})

test('completion counts materials placed in task storage', () => {
  const bot = botWith([{ name: 'oak_log', count: 16 }])
  const stored = (name) => name === 'any_log' ? 48 : 0
  assert.equal(completionSatisfied(
    bot, { type: 'inventory_count', item: 'any_log', quantity: 64 }, false, stored
  ), true)
})

test('recognizes natural progress questions without invoking the planner', () => {
  assert.equal(isProgressQuestion("what's going on?"), true)
  assert.equal(isProgressQuestion('whats the progrress'), true)
  assert.equal(isProgressQuestion('how far are you'), true)
  assert.equal(isProgressQuestion('update the house roof with oak'), false)
})

test('recognizes only short explicit checkpoint resume requests', () => {
  assert.equal(isResumeRequest('resume'), true)
  assert.equal(isResumeRequest('Keep going!'), true)
  assert.equal(isResumeRequest('continue the strip mine'), false)
})

test('infers equipment requests only from actionable missing-resource failures', () => {
  assert.equal(missingEquipmentForFailure({
    category: 'missing_resource',
    action: { type: 'strip_mine' },
    error: 'Mining preparation failed: no usable pickaxe or replacement materials'
  }), 'pickaxe')
  assert.equal(missingEquipmentForFailure({
    category: 'missing_resource',
    action: { type: 'create_farm' },
    error: 'farm preparation failed'
  }), 'hoe')
  assert.equal(missingEquipmentForFailure({
    category: 'navigation',
    action: { type: 'strip_mine' },
    error: 'path timed out'
  }), null)
})

test('extracts missing schematic materials for deterministic player assistance', () => {
  assert.equal(missingBuildMaterialForFailure({
    category: 'missing_resource',
    action: { type: 'build_schematic' },
    error: 'missing build supply polished_andesite; put some in a nearby chest or barrel'
  }), 'polished_andesite')
  assert.equal(missingBuildMaterialForFailure({
    category: 'missing_resource', action: { type: 'collect' }, error: 'missing build supply stone'
  }), null)
  assert.equal(missingBuildQuantityForFailure({
    error: 'missing build supply packed_mud; need 4 remaining for this build, put some in a nearby chest'
  }), 4)
  assert.equal(missingBuildQuantityForFailure({ error: 'cannot support floating build block' }), null)
})

test('recognizes build-supply updates without treating them as replacement goals', () => {
  assert.equal(isBuildSupplyAcknowledgement('packed mud in chest for you', 'packed_mud'), true)
  assert.equal(isBuildSupplyAcknowledgement("it's in", 'packed_mud'), true)
  assert.equal(isBuildSupplyAcknowledgement('I added the blocks', 'packed_mud'), true)
  assert.equal(isBuildSupplyAcknowledgement('build me a mud house', 'packed_mud'), false)
  assert.equal(isBuildSupplyAcknowledgement('packed mud is interesting', 'packed_mud'), false)
})

test('planner retries use bounded exponential backoff and remain interruptible', async () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 10].map(plannerRetryDelay), [2000, 4000, 8000, 16000, 32000, 60000, 60000])
  const controller = new AbortController()
  const waiting = abortableDelay(10000, controller.signal)
  controller.abort()
  await assert.rejects(waiting, { name: 'AbortError' })
})

test('repeated-action fingerprints change only when meaningful world progress occurs', () => {
  const action = { type: 'staircase_to_y', y: -59, direction: 'north' }
  assert.equal(actionFingerprint(action), actionFingerprint({ direction: 'north', y: -59, type: 'staircase_to_y' }))
  const bot = {
    entity: { position: { floored: () => ({ x: 1, y: 20, z: 3 }) } },
    health: 20,
    food: 20,
    inventory: { items: () => [{ name: 'cobblestone', count: 3 }, { name: 'cobblestone', count: 2 }] }
  }
  const before = worldProgressFingerprint(bot)
  bot.inventory.items = () => [{ name: 'cobblestone', count: 5 }]
  assert.equal(worldProgressFingerprint(bot), before)
  bot.inventory.items = () => [{ name: 'cobblestone', count: 6 }]
  assert.notEqual(worldProgressFingerprint(bot), before)
})

test('strip-mine checkpoints resume only the unfinished tunnel length', () => {
  const plan = {
    reply: 'mine',
    actions: [{
      type: 'strip_mine', direction: 'north', length: 500, target: 'general', branchSpacing: 3, branchDepth: 4
    }],
    completion: { type: 'action_sequence' }
  }
  const task = {
    children: [{ detail: { index: 0, progress: { completed: 128, total: 500 } } }]
  }
  const resumed = applyTaskProgressResume(plan, 0, task)
  assert.equal(resumed.actionIndex, 0)
  assert.equal(resumed.plan.actions[0].length, 372)
  assert.equal(plan.actions[0].length, 500)
})

test('collection checkpoints resume only the unfinished quantity', () => {
  const plan = {
    reply: 'collect', actions: [{ type: 'collect', block: 'oak_log', quantity: 64 }],
    completion: { type: 'action_sequence' }
  }
  const task = { children: [{ detail: { index: 0, progress: { completed: 24, total: 64 } } }] }
  const resumed = applyTaskProgressResume(plan, 0, task)
  assert.equal(resumed.plan.actions[0].quantity, 40)
})
