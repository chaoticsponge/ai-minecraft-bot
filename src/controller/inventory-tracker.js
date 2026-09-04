'use strict'

class InventoryTracker {
  constructor(bot) {
    this.bot = bot
    this.history = []
    this.counts = this.snapshotCounts()
    this.handleUpdate = () => this.captureChanges()
    bot.inventory.on?.('updateSlot', this.handleUpdate)
  }

  snapshotCounts() {
    const counts = new Map()
    for (const item of this.bot.inventory.items()) counts.set(item.name, (counts.get(item.name) || 0) + item.count)
    return counts
  }

  captureChanges() {
    const next = this.snapshotCounts()
    const names = new Set([...this.counts.keys(), ...next.keys()])
    const changes = []
    for (const name of names) {
      const delta = (next.get(name) || 0) - (this.counts.get(name) || 0)
      if (delta) changes.push({ name, delta })
    }
    if (changes.length) {
      this.history.push({ at: Date.now(), changes })
      if (this.history.length > 50) this.history.shift()
    }
    this.counts = next
  }

  count(name) {
    if (name === 'any_log') return [...this.counts].filter(([item]) => item.endsWith('_log')).reduce((n, [, count]) => n + count, 0)
    if (name === 'any_planks') return [...this.counts].filter(([item]) => item.endsWith('_planks')).reduce((n, [, count]) => n + count, 0)
    return this.counts.get(name) || 0
  }

  freeSlots() {
    return Math.max(0, 36 - this.bot.inventory.items().length)
  }

  canAccept(itemNames) {
    const names = new Set(itemNames)
    if (this.freeSlots() > 0) return true
    return this.bot.inventory.items().some((item) => names.has(item.name) && item.count < item.stackSize)
  }

  recent(since, limit = 8) {
    return this.history.filter((entry) => entry.at >= since).slice(-limit)
  }

  shutdown() {
    this.bot.inventory.off?.('updateSlot', this.handleUpdate)
  }
}

module.exports = { InventoryTracker }
