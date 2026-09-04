'use strict'

class EntityTracker {
  constructor(bot) {
    this.bot = bot
    this.entities = new Map(Object.values(bot.entities || {}).map((entity) => [entity.id, entity]))
    this.handleSpawn = (entity) => this.entities.set(entity.id, entity)
    this.handleGone = (entity) => this.entities.delete(entity.id)
    bot.on?.('entitySpawn', this.handleSpawn)
    bot.on?.('entityGone', this.handleGone)
  }

  droppedItems(name, maxDistance) {
    return [...this.entities.values()]
      .map((entity) => ({ entity, item: entity.getDroppedItem?.() }))
      .filter(({ item }) => item && (!name || item.name === name))
      .filter(({ entity }) => this.bot.entity.position.distanceTo(entity.position) <= maxDistance)
      .sort((a, b) => this.bot.entity.position.distanceTo(a.entity.position) -
        this.bot.entity.position.distanceTo(b.entity.position))
  }

  player(username) {
    const match = Object.values(this.bot.players || {})
      .find((entry) => entry.username?.toLowerCase() === username.toLowerCase())
    return match?.entity || null
  }

  shutdown() {
    this.bot.off?.('entitySpawn', this.handleSpawn)
    this.bot.off?.('entityGone', this.handleGone)
    this.entities.clear()
  }
}

module.exports = { EntityTracker }
