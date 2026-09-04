'use strict'

const { z } = require('zod')

const registryName = z.string().min(1).max(64).regex(/^[a-z0-9_]+$/)
const coordinate = z.number().finite().min(-30000000).max(30000000)

const CompletionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('action_sequence') }).strict(),
  z.object({
    type: z.literal('inventory_count'),
    item: registryName,
    quantity: z.number().int().min(1).max(2304)
  }).strict(),
  z.object({
    type: z.literal('tool_set'),
    material: z.enum(['wooden', 'stone', 'iron', 'diamond', 'netherite'])
  }).strict(),
  z.object({
    type: z.literal('resource_count'),
    resource: z.enum(['diamond', 'iron', 'copper', 'coal', 'gold', 'redstone']),
    quantity: z.number().int().min(1).max(64)
  }).strict(),
  z.object({ type: z.literal('persistent') }).strict()
])

const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('move_to'), x: coordinate, y: coordinate, z: coordinate }).strict(),
  z.object({
    type: z.literal('acquire_item'),
    item: registryName,
    quantity: z.number().int().min(1).max(2304)
  }).strict(),
  z.object({ type: z.literal('follow'), player: z.string().min(1).max(32) }).strict(),
  z.object({ type: z.literal('remember_location'), name: registryName }).strict(),
  z.object({ type: z.literal('go_to_location'), name: registryName }).strict(),
  z.object({ type: z.literal('return_to_surface') }).strict(),
  z.object({
    type: z.literal('collect'),
    block: registryName,
    quantity: z.number().int().min(1).max(64)
  }).strict(),
  z.object({
    type: z.literal('mine_block'),
    x: coordinate, y: coordinate, z: coordinate
  }).strict(),
  z.object({
    type: z.literal('pickup'),
    item: registryName,
    quantity: z.number().int().min(1).max(64)
  }).strict(),
  z.object({
    type: z.literal('craft'),
    item: registryName,
    quantity: z.number().int().min(1).max(64)
  }).strict(),
  z.object({
    type: z.literal('place'),
    block: registryName,
    x: coordinate,
    y: coordinate,
    z: coordinate,
    properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
  }).strict(),
  z.object({ type: z.literal('attack'), entityId: z.number().int().nonnegative() }).strict(),
  z.object({
    type: z.literal('interact_block'), x: coordinate, y: coordinate, z: coordinate
  }).strict(),
  z.object({ type: z.literal('sleep') }).strict(),
  z.object({
    type: z.literal('farm'),
    crop: z.enum(['wheat', 'carrots', 'potatoes', 'beetroots', 'nether_wart']),
    radius: z.number().int().min(2).max(32)
  }).strict(),
  z.object({
    type: z.literal('create_farm'),
    crop: z.enum(['wheat', 'carrots', 'potatoes', 'beetroots']),
    x: coordinate, y: coordinate, z: coordinate,
    radius: z.number().int().min(1).max(4)
  }).strict(),
  z.object({ type: z.literal('equip'), item: registryName }).strict(),
  z.object({
    type: z.literal('equip_tool'),
    tool: z.enum(['pickaxe', 'axe', 'shovel', 'hoe', 'sword'])
  }).strict(),
  z.object({
    type: z.literal('drop'),
    item: registryName,
    quantity: z.number().int().min(1).max(64)
  }).strict(),
  z.object({
    type: z.literal('give'),
    item: registryName,
    quantity: z.number().int().min(1).max(64),
    player: z.string().min(1).max(32)
  }).strict(),
  z.object({
    type: z.literal('deposit'),
    item: registryName,
    quantity: z.number().int().min(1).max(2304)
  }).strict(),
  z.object({
    type: z.literal('withdraw'),
    item: registryName,
    quantity: z.number().int().min(1).max(2304)
  }).strict(),
  z.object({
    type: z.literal('strip_mine'),
    direction: z.enum(['north', 'south', 'east', 'west']),
    length: z.number().int().min(1).max(4096),
    target: z.enum(['general', 'diamond', 'iron', 'copper', 'coal', 'gold', 'redstone']),
    branchSpacing: z.number().int().min(2).max(8),
    branchDepth: z.number().int().min(1).max(32)
  }).strict(),
  z.object({
    type: z.literal('mine_resource'),
    resource: z.enum(['diamond', 'iron', 'copper', 'coal', 'gold', 'redstone']),
    quantity: z.number().int().min(1).max(64),
    direction: z.enum(['north', 'south', 'east', 'west']),
    branchSpacing: z.number().int().min(2).max(8),
    branchDepth: z.number().int().min(1).max(32)
  }).strict(),
  z.object({
    type: z.literal('staircase_to'),
    target: z.enum(['diamond', 'iron', 'copper', 'coal', 'gold', 'redstone']),
    direction: z.enum(['north', 'south', 'east', 'west'])
  }).strict(),
  z.object({
    type: z.literal('staircase_to_y'),
    y: z.number().int().min(-64).max(320),
    direction: z.enum(['north', 'south', 'east', 'west'])
  }).strict(),
  z.object({ type: z.literal('collect_build_materials'), schematic: registryName }).strict(),
  z.object({ type: z.literal('repair_schematic'), schematic: registryName }).strict(),
  z.object({
    type: z.literal('build_schematic'),
    schematic: registryName,
    x: coordinate,
    y: coordinate,
    z: coordinate,
    facing: z.enum(['north', 'south', 'east', 'west'])
  }).strict(),
  z.object({ type: z.literal('eat') }).strict(),
  z.object({ type: z.literal('say'), message: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal('wait'), seconds: z.number().min(0).max(30) }).strict()
])

function createPlanSchema(maxActions) {
  return z.object({
    reply: z.string().min(1).max(200),
    actions: z.array(ActionSchema).max(maxActions),
    completion: CompletionSchema.optional().default({ type: 'action_sequence' })
  }).strict()
}

module.exports = { ActionSchema, CompletionSchema, createPlanSchema }
