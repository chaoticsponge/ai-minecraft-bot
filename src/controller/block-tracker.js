'use strict'

class BlockTracker {
  constructor(bot, { cacheMs = 10000, moveThreshold = 8, unreachableMs = 120000 } = {}) {
    this.bot = bot
    this.cacheMs = cacheMs
    this.moveThreshold = moveThreshold
    this.unreachableMs = unreachableMs
    this.cache = new Map()
    this.unreachable = new Map()
    this.onBlockUpdate = (oldBlock, newBlock) => {
      const key = (newBlock || oldBlock)?.position?.toString()
      if (!key) return
      this.unreachable.delete(key)
      for (const entry of this.cache.values()) entry.positions.delete(key)
      if (newBlock && newBlock.boundingBox !== 'empty') {
        const entry = this.cache.get(newBlock.type)
        entry?.positions.set(key, newBlock.position.clone())
      }
    }
    bot.on?.('blockUpdate', this.onBlockUpdate)
  }

  markUnreachable(position, reason) {
    this.unreachable.set(position.toString(), { until: Date.now() + this.unreachableMs, reason })
  }

  isUnreachable(position) {
    const entry = this.unreachable.get(position.toString())
    if (!entry) return false
    if (entry.until <= Date.now()) {
      this.unreachable.delete(position.toString())
      return false
    }
    return true
  }

  clearUnreachable(position = null) {
    if (position) return this.unreachable.delete(position.toString())
    this.unreachable.clear()
    return true
  }

  find(typeIds, maxDistance, count = 512) {
    const origin = this.bot.entity.position
    const now = Date.now()
    const positions = new Map()
    const missing = []
    for (const type of typeIds) {
      const cached = this.cache.get(type)
      const stale = !cached || now - cached.scannedAt > this.cacheMs ||
        cached.origin.distanceTo(origin) > this.moveThreshold || cached.maxDistance < maxDistance
      if (stale) missing.push(type)
      else for (const [key, position] of cached.positions) positions.set(key, position)
    }
    if (missing.length) {
      const found = this.bot.findBlocks({
        matching: (block) => block && missing.includes(block.type),
        maxDistance,
        count
      })
      for (const type of missing) {
        const matching = new Map()
        for (const position of found) {
          const block = this.bot.blockAt(position)
          if (block?.type === type) matching.set(position.toString(), position.clone())
        }
        this.cache.set(type, { scannedAt: now, origin: origin.clone(), maxDistance, positions: matching })
        for (const [key, position] of matching) positions.set(key, position)
      }
    }
    return [...positions.values()]
      .filter((position) => !this.isUnreachable(position) && origin.distanceTo(position) <= maxDistance)
      .sort((a, b) => origin.distanceTo(a) - origin.distanceTo(b))
      .slice(0, count)
  }

  shutdown() {
    this.bot.off?.('blockUpdate', this.onBlockUpdate)
    this.cache.clear()
    this.unreachable.clear()
  }
}

module.exports = { BlockTracker }
