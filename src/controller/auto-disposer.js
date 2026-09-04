'use strict'

const { InventoryPolicy } = require('./inventory-policy')

class AutoDisposer {
  constructor(bot, itemNames) {
    this.bot = bot
    this.itemNames = itemNames
    this.policy = new InventoryPolicy(bot, itemNames)
    this.timer = null
    this.running = false
    this.handleCollect = (collector) => {
      if (collector === this.bot.entity || collector.username === this.bot.username) this.schedule()
    }
  }

  start() {
    if (this.itemNames.size === 0) return
    this.bot.on('playerCollect', this.handleCollect)
    this.schedule(1000)
  }

  stop() {
    clearTimeout(this.timer)
    this.bot.off('playerCollect', this.handleCollect)
  }

  schedule(delay = 500) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.dispose().catch((error) => {
      console.error(`Auto-dispose failed: ${error.message}`)
    }), delay)
  }

  async dispose() {
    if (this.running) return this.schedule()
    if (this.bot.currentWindow) return this.schedule(500)
    this.running = true
    try {
      const trash = this.policy.disposableStacks()
      for (const { item, quantity } of trash) {
        if (quantity === item.count) await this.bot.tossStack(item)
        else await this.bot.toss(item.type, item.metadata ?? null, quantity)
        console.log(`Auto-disposed ${quantity} ${item.name}`)
      }
    } finally {
      this.running = false
    }
  }
}

module.exports = { AutoDisposer }
