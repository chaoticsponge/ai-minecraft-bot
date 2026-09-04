'use strict'

function round(value) {
  return Math.round(value * 10) / 10
}

function countByName(values) {
  const counts = {}
  for (const value of values) counts[value] = (counts[value] || 0) + 1
  return counts
}

function observe(bot, distance) {
  if (!bot.entity) throw new Error('The bot has not spawned yet')
  const origin = bot.entity.position
  const currentBlock = bot.blockAt(origin.floored())
  const headBlock = bot.blockAt(origin.offset(0, 1.62, 0).floored())

  const inventory = bot.inventory.items().map((item) => ({ name: item.name, count: item.count }))
  const players = Object.entries(bot.players)
    .filter(([, player]) => player.entity && player.username !== bot.username)
    .map(([username, player]) => ({
      username,
      distance: round(origin.distanceTo(player.entity.position)),
      position: {
        x: round(player.entity.position.x),
        y: round(player.entity.position.y),
        z: round(player.entity.position.z)
      }
    }))
    .filter((player) => player.distance <= distance * 4)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 16)

  const entities = Object.values(bot.entities)
    .filter((entity) => entity !== bot.entity && entity.position)
    .map((entity) => ({
      id: entity.id,
      name: entity.name || entity.displayName || entity.type,
      type: entity.type,
      distance: round(origin.distanceTo(entity.position))
    }))
    .filter((entity) => entity.distance <= distance)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 24)

  const droppedItems = Object.values(bot.entities)
    .filter((entity) => typeof entity.getDroppedItem === 'function')
    .map((entity) => {
      const item = entity.getDroppedItem()
      if (!item) return null
      return {
        entityId: entity.id,
        item: item.name,
        count: item.count,
        distance: round(origin.distanceTo(entity.position))
      }
    })
    .filter((item) => item && item.distance <= distance)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 24)

  const nearbyBlockObjects = bot.findBlocks({
    matching: (block) => block && block.name !== 'air' && block.boundingBox !== 'empty',
    maxDistance: distance,
    count: 128
  }).map((position) => bot.blockAt(position)).filter(Boolean)
  const blockNames = nearbyBlockObjects.map((block) => block.name)
  const interactiveBlocks = nearbyBlockObjects.filter((block) =>
    /(_door|_trapdoor|_fence_gate|_button|_bed|chest|barrel)$/.test(block.name) ||
    ['lever', 'bell', 'crafting_table', 'furnace'].includes(block.name)
  ).map((block) => ({
    name: block.name,
    x: block.position.x, y: block.position.y, z: block.position.z,
    distance: round(origin.distanceTo(block.position))
  })).sort((a, b) => a.distance - b.distance).slice(0, 24)

  return {
    position: { x: round(origin.x), y: round(origin.y), z: round(origin.z) },
    health: round(bot.health),
    food: bot.food,
    oxygen: bot.oxygenLevel,
    isInWater: Boolean(bot.entity.isInWater),
    isInLava: Boolean(bot.entity.isInLava),
    isOnFire: Boolean(Number.isInteger(bot.entity.metadata?.[0]) && (bot.entity.metadata[0] & 0x01)),
    isSuffocating: Boolean(headBlock && headBlock.boundingBox !== 'empty' &&
      !['water', 'lava', 'bubble_column'].includes(headBlock.name)),
    heldItem: bot.heldItem?.name || null,
    dimension: bot.game?.dimension || null,
    timeOfDay: bot.time?.timeOfDay ?? null,
    isRaining: Boolean(bot.isRaining),
    light: currentBlock ? {
      level: Math.max(currentBlock.light ?? 0, currentBlock.skyLight ?? 0),
      block: currentBlock.light ?? 0,
      sky: currentBlock.skyLight ?? 0
    } : null,
    inventory,
    nearbyPlayers: players,
    nearbyEntities: entities,
    droppedItems,
    nearbyBlocks: countByName(blockNames),
    interactiveBlocks
  }
}

module.exports = { observe }
