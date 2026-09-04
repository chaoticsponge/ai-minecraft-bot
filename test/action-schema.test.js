'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { ActionSchema, createPlanSchema } = require('../src/controller/action-schema')
const { extractJson, normalizeLocalPlan } = require('../src/ai/planner')

test('accepts supported high-level actions', () => {
  assert.equal(ActionSchema.parse({ type: 'collect', block: 'oak_log', quantity: 16 }).type, 'collect')
  assert.equal(ActionSchema.parse({ type: 'mine_block', x: 1, y: 64, z: 2 }).type, 'mine_block')
  assert.equal(ActionSchema.parse({ type: 'follow', player: 'Steve' }).type, 'follow')
  assert.equal(ActionSchema.parse({ type: 'remember_location', name: 'home' }).type, 'remember_location')
  assert.equal(ActionSchema.parse({ type: 'go_to_location', name: 'home' }).type, 'go_to_location')
  assert.equal(ActionSchema.parse({ type: 'return_to_surface' }).type, 'return_to_surface')
  assert.equal(ActionSchema.parse({ type: 'wait', seconds: 2.5 }).type, 'wait')
  assert.equal(ActionSchema.parse({ type: 'pickup', item: 'diamond', quantity: 1 }).type, 'pickup')
  assert.equal(ActionSchema.parse({ type: 'give', item: 'bread', quantity: 2, player: 'Steve' }).type, 'give')
  assert.equal(ActionSchema.parse({ type: 'equip_tool', tool: 'pickaxe' }).type, 'equip_tool')
  assert.equal(ActionSchema.parse({ type: 'sleep' }).type, 'sleep')
  assert.equal(ActionSchema.parse({ type: 'farm', crop: 'wheat', radius: 16 }).type, 'farm')
  assert.equal(ActionSchema.parse({
    type: 'create_farm', crop: 'wheat', x: 1, y: 64, z: 2, radius: 2
  }).type, 'create_farm')
  assert.equal(ActionSchema.parse({ type: 'interact_block', x: 1, y: 64, z: 2 }).type, 'interact_block')
  assert.equal(ActionSchema.parse({
    type: 'place', block: 'oak_stairs', x: 1, y: 64, z: 2, properties: { facing: 'north', half: 'bottom' }
  }).properties.facing, 'north')
  assert.equal(ActionSchema.parse({
    type: 'strip_mine', direction: 'north', length: 32, target: 'diamond',
    branchSpacing: 3, branchDepth: 16
  }).type, 'strip_mine')
  assert.equal(ActionSchema.parse({
    type: 'mine_resource', resource: 'diamond', quantity: 30, direction: 'east',
    branchSpacing: 3, branchDepth: 32
  }).type, 'mine_resource')
  assert.equal(ActionSchema.parse({
    type: 'staircase_to', target: 'diamond', direction: 'north'
  }).type, 'staircase_to')
  assert.equal(ActionSchema.parse({
    type: 'staircase_to_y', y: 20, direction: 'east'
  }).type, 'staircase_to_y')
  assert.equal(ActionSchema.parse({ type: 'acquire_item', item: 'stone_pickaxe', quantity: 1 }).type, 'acquire_item')
  assert.equal(ActionSchema.parse({ type: 'collect_build_materials', schematic: 'starter_home' }).type, 'collect_build_materials')
  assert.equal(ActionSchema.parse({
    type: 'build_schematic', schematic: 'starter_home', x: 1, y: 64, z: 2, facing: 'south'
  }).type, 'build_schematic')
  assert.equal(ActionSchema.parse({ type: 'repair_schematic', schematic: 'starter_home' }).type, 'repair_schematic')
  assert.equal(ActionSchema.parse({ type: 'deposit', item: 'cobblestone', quantity: 64 }).type, 'deposit')
  assert.equal(ActionSchema.parse({ type: 'withdraw', item: 'torch', quantity: 16 }).type, 'withdraw')
})

test('rejects unsafe quantities and unknown fields', () => {
  assert.throws(() => ActionSchema.parse({ type: 'collect', block: 'oak_log', quantity: 1000 }))
  assert.throws(() => ActionSchema.parse({ type: 'say', message: 'hi', command: '/op Bot' }))
})

test('enforces the configured plan length', () => {
  const schema = createPlanSchema(2)
  const action = { type: 'wait', seconds: 1 }
  assert.throws(() => schema.parse({ reply: 'Working', actions: [action, action, action] }))
})

test('accepts deterministic goal completion conditions', () => {
  const schema = createPlanSchema(2)
  const plan = schema.parse({
    reply: 'Gathering a stack',
    actions: [{ type: 'collect', block: 'any_log', quantity: 64 }],
    completion: { type: 'inventory_count', item: 'oak_log', quantity: 64 }
  })
  assert.equal(plan.completion.type, 'inventory_count')
  assert.deepEqual(schema.parse({ reply: 'Done', actions: [] }).completion, {
    type: 'action_sequence'
  })
})

test('extracts JSON from local-model Markdown wrappers', () => {
  assert.deepEqual(extractJson('```json\n{"reply":"ok","actions":[]}\n```'), {
    reply: 'ok', actions: []
  })
  assert.deepEqual(extractJson('{"reply":"first","actions":[]} trailing {"reply":"second"}'), {
    reply: 'first', actions: []
  })
})

test('removes only Gemma redundant target from explicit-Y staircases', () => {
  assert.deepEqual(normalizeLocalPlan({
    reply: 'Descending',
    actions: [{ type: 'staircase_to_y', y: 20, direction: 'north', target: 'Y 20' }],
    completion: { type: 'action_sequence' }
  }).actions[0], { type: 'staircase_to_y', y: 20, direction: 'north' })
})

test('repairs safe local-model aliases and invalid completion material', () => {
  const normalized = normalizeLocalPlan({
    reply: 'Working',
    actions: [{ type: 'craft', item: 'cobblestone_pickaxe', quantity: 1 }],
    completion: { type: 'tool_set', material: 'copper' }
  })
  assert.equal(normalized.actions[0].item, 'stone_pickaxe')
  assert.deepEqual(normalized.completion, { type: 'action_sequence' })
})
