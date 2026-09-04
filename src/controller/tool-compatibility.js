'use strict'

function safeEnchantments(item) {
  try {
    return Array.isArray(item?.enchants) ? item.enchants : []
  } catch {
    return []
  }
}

function digTime(bot, block, item) {
  return block.digTime(
    item?.type ?? null,
    false,
    false,
    false,
    safeEnchantments(item),
    bot.entity.effects || {}
  )
}

function installToolCompatibility(bot) {
  if (!bot.tool || !bot.pathfinder) return false

  // mineflayer-tool 1.2 reads legacy NBT Enchantments directly. Modern
  // component-based items can expose a non-array value there, which crashes
  // block.digTime. prismarine-item's `enchants` accessor is version-aware.
  bot.tool.getDigTime = (block, item) => digTime(bot, block, item)

  // Mineflayer's own dig() calls bot.digTime after a tool is equipped. Its
  // modern component accessor can currently return an enchantment map rather
  // than the array prismarine-block expects, so normalize both hand and helmet.
  bot.digTime = (block) => {
    const held = bot.heldItem
    const headSlot = bot.getEquipmentDestSlot?.('head')
    const helmet = Number.isInteger(headSlot) ? bot.inventory.slots?.[headSlot] : null
    const enchantments = [...safeEnchantments(held), ...safeEnchantments(helmet)]
    return block.digTime(
      held?.type ?? null,
      bot.game?.gameMode === 'creative',
      ['water', 'flowing_water'].includes(bot._getBlockAtEyeLevel?.()?.name),
      !bot.entity.onGround,
      enchantments,
      bot.entity.effects || {}
    )
  }

  bot.pathfinder.bestHarvestTool = (block) => {
    let fastest = Number.MAX_VALUE
    let best = null
    for (const item of bot.inventory.items()) {
      const duration = digTime(bot, block, item)
      if (duration < fastest) {
        fastest = duration
        best = item
      }
    }
    // Pathfinder 2.4 re-parses the returned item's legacy NBT before digging.
    // A slot-preserving shallow copy avoids that obsolete path; equip only
    // requires the inventory slot from this object.
    return best ? {
      type: best.type,
      slot: best.slot,
      name: best.name,
      metadata: best.metadata,
      count: best.count,
      stackSize: best.stackSize,
      nbt: null
    } : null
  }
  return true
}

module.exports = { installToolCompatibility, safeEnchantments, digTime }
