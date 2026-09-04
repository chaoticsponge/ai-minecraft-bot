'use strict'

const TOOL_TYPES = ['pickaxe', 'axe', 'shovel', 'hoe', 'sword']
const TOOL_RANK = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite']

class InventoryPolicy {
  constructor(bot, autoDisposeItems = new Set()) {
    this.bot = bot
    this.autoDisposeItems = autoDisposeItems
  }

  reservedItems() {
    const reserved = new Map()
    if (this.bot.inventory.items().some((item) => item.name === 'crafting_table')) reserved.set('crafting_table', 1)
    if (this.bot.inventory.items().some((item) => item.name === 'stick')) reserved.set('stick', 8)
    if (this.bot.inventory.items().some((item) => item.name === 'torch')) reserved.set('torch', 16)
    if (this.bot.inventory.items().some((item) => item.name === 'shield')) reserved.set('shield', 1)
    for (const tool of TOOL_TYPES) {
      const suffix = `_${tool}`
      const best = this.bot.inventory.items()
        .filter((item) => item.name.endsWith(suffix))
        .filter((item) => !item.maxDurability || item.maxDurability - (item.durabilityUsed || 0) > 0)
        .sort((a, b) => TOOL_RANK.indexOf(b.name.slice(0, -suffix.length)) -
          TOOL_RANK.indexOf(a.name.slice(0, -suffix.length)) ||
          ((b.maxDurability || Infinity) - (b.durabilityUsed || 0)) -
          ((a.maxDurability || Infinity) - (a.durabilityUsed || 0)))[0]
      if (best) reserved.set(best.name, Math.max(reserved.get(best.name) || 0, 1))
    }
    return reserved
  }

  disposableStacks() {
    const reserved = this.reservedItems()
    const retained = new Map()
    return this.bot.inventory.items().flatMap((item) => {
      if (!this.autoDisposeItems.has(item.name)) return []
      const kept = retained.get(item.name) || 0
      const mustKeep = Math.max(0, (reserved.get(item.name) || 0) - kept)
      const keeping = Math.min(item.count, mustKeep)
      retained.set(item.name, kept + keeping)
      const quantity = item.count - keeping
      return quantity > 0 ? [{ item, quantity }] : []
    })
  }

  async freeTrashSlots(minimumFreeSlots = 1) {
    const freeSlots = () => Math.max(0, 36 - this.bot.inventory.items().length)
    if (freeSlots() >= minimumFreeSlots) return 0
    let discarded = 0
    for (const { item, quantity } of this.disposableStacks()) {
      if (quantity === item.count) await this.bot.tossStack(item)
      else await this.bot.toss(item.type, item.metadata ?? null, quantity)
      discarded += quantity
      console.log(`Inventory pressure: discarded ${quantity} configured trash item(s) ${item.name}`)
      if (freeSlots() >= minimumFreeSlots) break
    }
    return discarded
  }
}

module.exports = { InventoryPolicy }
