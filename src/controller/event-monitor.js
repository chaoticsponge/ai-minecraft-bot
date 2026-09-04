'use strict'

const { EventEmitter } = require('node:events')

const HOSTILE_MOBS = new Set([
  'blaze', 'bogged', 'breeze', 'cave_spider', 'creeper', 'drowned', 'elder_guardian',
  'endermite', 'evoker', 'ghast', 'guardian', 'hoglin', 'husk', 'magma_cube',
  'phantom', 'piglin_brute', 'pillager', 'ravager', 'shulker', 'silverfish', 'skeleton',
  'slime', 'stray', 'vex', 'vindicator', 'warden', 'witch', 'wither',
  'wither_skeleton', 'zoglin', 'zombie', 'zombie_villager'
])

const HOSTILE_DETECTION_RANGES = new Map([
  ['blaze', 14], ['bogged', 12], ['breeze', 14], ['elder_guardian', 18],
  ['evoker', 12], ['ghast', 24], ['guardian', 14], ['phantom', 16],
  ['pillager', 14], ['shulker', 14], ['skeleton', 14], ['stray', 14],
  ['warden', 20], ['witch', 12], ['wither', 24]
])
const CONDITIONAL_HOSTILES = new Set(['enderman', 'spider', 'zombified_piglin'])

function nearestThreat(bot, radius = 6, { includeConditional = false } = {}) {
  if (!bot.entity) return null
  return Object.values(bot.entities)
    .filter((entity) => entity?.position && (
      HOSTILE_MOBS.has(entity.name) || (includeConditional && CONDITIONAL_HOSTILES.has(entity.name))
    ))
    .map((entity) => ({ entity, distance: bot.entity.position.distanceTo(entity.position) }))
    .filter(({ entity, distance }) => distance <= Math.max(radius, HOSTILE_DETECTION_RANGES.get(entity.name) || 0))
    .sort((a, b) => a.distance - b.distance)[0] || null
}

function suffocatingBlock(bot) {
  if (!bot.entity?.position || !bot.blockAt) return null
  const headPosition = bot.entity.position.offset(0, 1.62, 0).floored()
  const block = bot.blockAt(headPosition)
  if (!block || block.boundingBox === 'empty') return null
  if (['water', 'lava', 'bubble_column'].includes(block.name)) return null
  return block
}

class EventMonitor extends EventEmitter {
  constructor(bot) {
    super()
    this.bot = bot
    this.lastHealth = bot.health
    this.lastThreatId = null
    this.lastThreatAt = 0
    this.lastFoodAt = 0
    this.lastHazardAt = new Map()
    this.fireStartedAt = null
    this.fallStartY = bot.entity?.position?.y ?? null
    this.fallInterrupted = false
    this.handleHealth = () => {
      const previous = this.lastHealth
      this.lastHealth = bot.health
      const damage = Math.max(0, previous - bot.health)
      if (damage > 0 && (damage >= 6 || bot.health <= 6)) {
        this.emit('interrupt', {
          type: 'serious_damage',
          damage,
          health: bot.health,
          food: bot.food
        })
      }
    }
    this.handleDeath = () => {
      this.emit('interrupt', {
        type: 'death',
        position: bot.entity?.position ? {
          x: bot.entity.position.x,
          y: bot.entity.position.y,
          z: bot.entity.position.z
        } : null,
        dimension: bot.game?.dimension || null,
        inventory: bot.inventory.items().map((item) => ({ name: item.name, count: item.count }))
      })
    }
    bot.on('health', this.handleHealth)
    bot.on('death', this.handleDeath)
    this.timer = setInterval(() => {
      this.scanThreats()
      this.scanFood()
      this.scanHazards()
    }, 500)
    this.timer.unref?.()
  }

  scanThreats() {
    const threat = nearestThreat(this.bot)
    if (!threat) {
      this.lastThreatId = null
      return
    }
    const now = Date.now()
    if (threat.entity.id === this.lastThreatId && now - this.lastThreatAt < 10000) return
    this.lastThreatId = threat.entity.id
    this.lastThreatAt = now
    this.emit('interrupt', {
      type: 'enemy_threat',
      entityId: threat.entity.id,
      entity: threat.entity.name,
      distance: Math.round(threat.distance * 10) / 10
    })
  }

  scanFood() {
    if (this.bot.food > 8 || Date.now() - this.lastFoodAt < 30000) return
    const hasFood = this.bot.inventory.items().some((item) => this.bot.registry.foodsByName[item.name])
    this.lastFoodAt = Date.now()
    this.emit('interrupt', { type: 'needs_food', food: this.bot.food, health: this.bot.health, hasFood })
  }

  emitHazard(type, detail = {}, cooldown = 10000) {
    const now = Date.now()
    if (now - (this.lastHazardAt.get(type) || 0) < cooldown) return
    this.lastHazardAt.set(type, now)
    this.emit('interrupt', { type, ...detail })
  }

  scanHazards() {
    const entity = this.bot.entity
    if (!entity || this.bot.isAlive === false) return
    if (entity.isInLava) {
      this.emitHazard('lava', { health: this.bot.health, position: entity.position.floored() }, 5000)
    } else if (entity.isInWater && this.bot.oxygenLevel <= 5) {
      this.emitHazard('drowning', { oxygen: this.bot.oxygenLevel, position: entity.position.floored() }, 8000)
    }

    const sharedFlags = entity.metadata?.[0]
    const onFire = !entity.isInLava && Number.isInteger(sharedFlags) && (sharedFlags & 0x01)
    if (onFire) {
      this.fireStartedAt ??= Date.now()
      if (this.bot.health <= 6 || Date.now() - this.fireStartedAt >= 1500) {
        this.emitHazard('on_fire', { health: this.bot.health, position: entity.position.floored() }, 5000)
      }
    } else {
      this.fireStartedAt = null
    }

    const obstruction = suffocatingBlock(this.bot)
    if (obstruction) {
      this.emitHazard('suffocating', {
        health: this.bot.health,
        block: obstruction.name,
        position: obstruction.position
      }, 5000)
    }

    if (entity.onGround || entity.isInWater || entity.isInLava) {
      this.fallStartY = entity.position.y
      this.fallInterrupted = false
      return
    }
    this.fallStartY = Math.max(this.fallStartY ?? entity.position.y, entity.position.y)
    const fallen = this.fallStartY - entity.position.y
    if (!this.fallInterrupted && fallen >= 6 && entity.velocity?.y < -0.45) {
      this.fallInterrupted = true
      this.emitHazard('dangerous_fall', {
        distance: Math.round(fallen * 10) / 10,
        position: entity.position.floored()
      }, 3000)
    }
  }

  shutdown() {
    clearInterval(this.timer)
    this.bot.off('health', this.handleHealth)
    this.bot.off('death', this.handleDeath)
    this.removeAllListeners()
  }
}

module.exports = {
  EventMonitor,
  HOSTILE_MOBS,
  CONDITIONAL_HOSTILES,
  HOSTILE_DETECTION_RANGES,
  nearestThreat,
  suffocatingBlock
}
