'use strict'

const CONTAINER_NAMES = new Set(['chest', 'trapped_chest', 'barrel'])

class ContainerTracker {
  constructor(bot) {
    this.bot = bot
    this.known = new Map()
    this.onBlockUpdate = (oldBlock, newBlock) => {
      const block = newBlock || oldBlock
      if (!block?.position) return
      if (!newBlock || !CONTAINER_NAMES.has(newBlock.name)) this.known.delete(block.position.toString())
    }
    bot.on?.('blockUpdate', this.onBlockUpdate)
  }

  record(block, container) {
    const contents = {}
    for (const item of container.containerItems()) contents[item.name] = (contents[item.name] || 0) + item.count
    this.known.set(block.position.toString(), {
      type: block.name,
      position: { x: block.position.x, y: block.position.y, z: block.position.z },
      contents,
      inspectedAt: Date.now()
    })
  }

  summary(origin, maxDistance = 64) {
    return [...this.known.values()]
      .map((entry) => ({
        ...entry,
        distance: Math.round(Math.hypot(
          entry.position.x - origin.x,
          entry.position.y - origin.y,
          entry.position.z - origin.z
        ) * 10) / 10
      }))
      .filter((entry) => entry.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 8)
  }

  shutdown() {
    this.bot.off?.('blockUpdate', this.onBlockUpdate)
    this.known.clear()
  }
}

module.exports = { ContainerTracker, CONTAINER_NAMES }
