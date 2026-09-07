'use strict'

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { ActionSchema } = require('./action-schema')
const { ToolManager } = require('./tool-manager')
const { nearestThreat, HOSTILE_MOBS, suffocatingBlock } = require('./event-monitor')
const { BlockTracker } = require('./block-tracker')
const { InventoryTracker } = require('./inventory-tracker')
const { EntityTracker } = require('./entity-tracker')
const { InventoryPolicy } = require('./inventory-policy')
const { ContainerTracker, CONTAINER_NAMES } = require('./container-tracker')

const UNSAFE_FOODS = new Set([
  'chorus_fruit', 'pufferfish', 'poisonous_potato', 'rotten_flesh', 'spider_eye', 'raw_chicken'
])
const TOOL_RANK = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite']
const SOIL_BLOCKS = new Set([
  'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
  'mud', 'sand', 'red_sand', 'gravel', 'clay'
])
const FALLING_BLOCKS = new Set(['sand', 'red_sand', 'gravel'])
const CARDINAL_DIRECTIONS = {
  north: new Vec3(0, 0, -1),
  south: new Vec3(0, 0, 1),
  east: new Vec3(1, 0, 0),
  west: new Vec3(-1, 0, 0)
}
const SCAFFOLD_PRIORITY = [
  'dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'netherrack',
  'tuff', 'andesite', 'diorite', 'granite', 'calcite', 'sandstone', 'smooth_sandstone'
]
const SCAFFOLD_BLOCKS = new Set(SCAFFOLD_PRIORITY)
const SCAFFOLD_RESTOCK_PRIORITY = [
  'cobbled_deepslate', 'cobblestone', 'dirt', 'stone', 'netherrack',
  'tuff', 'andesite', 'diorite', 'granite', 'calcite', 'sandstone', 'smooth_sandstone'
]
const MINING_STORAGE_ITEMS = new Set([
  'stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'tuff', 'calcite',
  'granite', 'diorite', 'andesite', 'gravel', 'flint', 'dirt', 'sand', 'red_sand'
])
const MINING_RESOURCE_ITEMS = new Set([
  'coal', 'charcoal', 'diamond', 'emerald', 'lapis_lazuli', 'redstone', 'quartz',
  'raw_iron', 'raw_gold', 'raw_copper', 'iron_ingot', 'gold_ingot', 'copper_ingot',
  'iron_nugget', 'gold_nugget', 'amethyst_shard'
])
const FORAGING_STORAGE_ITEMS = new Set([
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip',
  'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower',
  'lily_of_the_valley', 'wither_rose', 'sunflower', 'lilac', 'rose_bush',
  'peony', 'torchflower', 'pitcher_plant', 'pink_petals', 'wildflowers',
  'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'vine',
  'wheat', 'wheat_seeds', 'carrot', 'potato', 'beetroot', 'beetroot_seeds', 'poisonous_potato'
])
const CROP_INFO = {
  wheat: { seed: 'wheat_seeds', maxAge: 7 },
  carrots: { seed: 'carrot', maxAge: 7 },
  potatoes: { seed: 'potato', maxAge: 7 },
  beetroots: { seed: 'beetroot_seeds', maxAge: 3 },
  nether_wart: { seed: 'nether_wart', maxAge: 3 }
}
const PASSIVE_FOOD_MOBS = new Set(['cow', 'pig', 'sheep', 'rabbit'])
const COOKED_FOOD = {
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken',
  mutton: 'cooked_mutton', rabbit: 'cooked_rabbit', cod: 'cooked_cod',
  salmon: 'cooked_salmon', potato: 'baked_potato', kelp: 'dried_kelp'
}
const HOSTILE_PROJECTILES = new Set(['arrow', 'spectral_arrow', 'trident', 'small_fireball', 'fireball', 'wind_charge'])
const DEFENDABLE_HOSTILES = new Set([
  'zombie', 'zombie_villager', 'husk', 'cave_spider', 'silverfish', 'endermite',
  'slime', 'magma_cube', 'vex', 'zombified_piglin'
])
const REPLACEABLE_BUILD_BLOCKS = new Set([
  'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'vine',
  'snow', 'lily_pad', 'seagrass', 'tall_seagrass', 'kelp',
  ...FORAGING_STORAGE_ITEMS
])
const RESOURCE_LEVELS = { diamond: -59, redstone: -59, gold: -16, iron: 16, copper: 48, coal: 96 }
const RESOURCE_ITEMS = {
  diamond: ['diamond'],
  redstone: ['redstone'],
  gold: ['raw_gold', 'gold_ingot'],
  iron: ['raw_iron', 'iron_ingot'],
  copper: ['raw_copper', 'copper_ingot'],
  coal: ['coal']
}

function abortError() {
  const error = new Error('Task cancelled')
  error.name = 'AbortError'
  return error
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    const finish = () => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function cancellable(promise, signal, cancel) {
  if (signal.aborted) throw abortError()
  let onAbort
  const cancelled = new Promise((resolve, reject) => {
    onAbort = () => {
      try { cancel() } catch {}
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, cancelled])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

class ActionExecutor {
  constructor(bot, limits, { autoDisposeItems = new Set(), landmarks = null } = {}) {
    this.bot = bot
    this.limits = limits
    this.toolManager = new ToolManager(bot)
    this.blockTracker = new BlockTracker(bot)
    this.inventoryTracker = new InventoryTracker(bot)
    this.entityTracker = new EntityTracker(bot)
    this.inventoryPolicy = new InventoryPolicy(bot, autoDisposeItems)
    this.containerTracker = new ContainerTracker(bot)
    this.landmarks = landmarks
    this.goalDeposits = new Map()
    this.activity = null
    this.lastTorchCraftAttemptAt = 0
    this.lastTunnelTorch = null
    this.emergencyWaterPromise = null
    this.emergencyWaterPosition = null
    this.buildSupplyWake = null
    this.lastStorageScaffoldAttemptAt = 0
  }

  async maintainToolSet(signal) {
    return this.toolManager.maintainToolSet(signal)
  }

  beginGoalStorage(storedItems = null) {
    this.goalDeposits = new Map(Object.entries(storedItems || {}).filter(([, count]) => Number.isFinite(count) && count > 0))
  }

  goalStoredSnapshot() {
    return Object.fromEntries(this.goalDeposits)
  }

  recordGoalDeposit(name, quantity) {
    this.goalDeposits.set(name, (this.goalDeposits.get(name) || 0) + quantity)
  }

  recordGoalWithdrawal(name, quantity) {
    const remaining = Math.max(0, (this.goalDeposits.get(name) || 0) - quantity)
    if (remaining > 0) this.goalDeposits.set(name, remaining)
    else this.goalDeposits.delete(name)
  }

  goalStoredCount(requested) {
    const names = RESOURCE_ITEMS[requested] || null
    let total = 0
    for (const [name, count] of this.goalDeposits) {
      if (requested === 'any_log' ? name.endsWith('_log')
        : requested === 'any_planks' ? name.endsWith('_planks')
          : names ? names.includes(name) : name === requested) total += count
    }
    return total
  }

  async ensureCollectBlockSlot(context) {
    await this.inventoryPolicy.freeTrashSlots(1)
    if (this.inventoryTracker.freeSlots() < 1) {
      throw new Error(`inventory full; collect-block needs one empty slot before ${context}`)
    }
  }

  stop() {
    this.bot.pathfinder.setGoal(null)
    this.bot.clearControlStates()
    this.bot.collectBlock.cancelTask().catch(() => {})
  }

  shutdown() {
    this.stop()
    this.blockTracker.shutdown()
    this.inventoryTracker.shutdown()
    this.entityTracker.shutdown()
    this.containerTracker.shutdown()
  }

  beginEmergencyResponse(trigger = {}) {
    this.stop()
    if (trigger.type === 'drowning') {
      this.bot.setControlState('jump', true)
      return 'Swimming toward the surface'
    }
    if (trigger.type === 'lava') {
      this.bot.setControlState('jump', true)
      this.emergencyWaterPromise = this.placeEmergencyWater()
        .catch((error) => {
          console.warn(`Emergency water failed: ${error.message}`)
          return false
        })
      return 'Escaping lava'
    }
    if (trigger.type === 'on_fire') {
      return 'Waiting briefly for residual flames to expire'
    }
    if (trigger.type === 'dangerous_fall') {
      this.clutchFall().catch((error) => console.warn(`Fall clutch failed: ${error.message}`))
      return 'Attempting a water-bucket fall clutch'
    }
    if (trigger.type === 'suffocating') {
      this.bot.setControlState('jump', true)
      return `Digging out of ${trigger.block || 'a solid block'}`
    }
    if (trigger.type === 'death') return 'Waiting to respawn'
    const threat = nearestThreat(this.bot, 10, { includeConditional: trigger.type === 'serious_damage' })
    if (threat) {
      if (this.shouldDefendAgainst(threat)) return `Preparing to defend against ${threat.entity.name}`
      const origin = this.bot.entity.position
      const dx = origin.x - threat.entity.position.x
      const dz = origin.z - threat.entity.position.z
      const length = Math.max(0.1, Math.hypot(dx, dz))
      const x = Math.floor(origin.x + (dx / length) * 10)
      const z = Math.floor(origin.z + (dz / length) * 10)
      this.bot.pathfinder.setGoal(new goals.GoalNear(x, Math.floor(origin.y), z, 2))
      return `Retreating from ${threat.entity.name}`
    }
    if (this.bot.food < 18) {
      return 'Paused current task to eat available safe food'
    }
    return 'Paused movement and checked surroundings'
  }

  async respondToInterrupt(trigger, signal) {
    this.stop()
    if (trigger.type === 'death') return this.recoverAfterDeath(trigger, signal)
    if (trigger.type === 'drowning') {
      return this.escapeDrowning(signal)
    }
    if (trigger.type === 'suffocating') return this.escapeSuffocation(signal)
    if (trigger.type === 'lava' || trigger.type === 'on_fire') {
      return this.escapeFireOrLava(trigger.type, signal)
    }
    if (trigger.type === 'dangerous_fall') {
      const deadline = Date.now() + 6000
      while (!this.bot.entity.onGround && !this.bot.entity.isInWater && this.bot.isAlive !== false && Date.now() < deadline) {
        await wait(100, signal)
      }
      return this.bot.isAlive === false ? 'Fall was fatal; waiting for death recovery' : 'Fall ended'
    }
    if (trigger.type === 'enemy_threat' || trigger.type === 'serious_damage') {
      const threat = nearestThreat(this.bot, 12, { includeConditional: trigger.type === 'serious_damage' })
      if (threat) {
        if (this.shouldDefendAgainst(threat)) {
          try {
            return await this.attack({ type: 'attack', entityId: threat.entity.id }, signal)
          } catch (error) {
            if (error.name === 'AbortError') throw error
            console.warn(`Defensive combat failed; retreating instead: ${error.message}`)
          }
        }
        const origin = this.bot.entity.position
        const dx = origin.x - threat.entity.position.x
        const dz = origin.z - threat.entity.position.z
        const length = Math.max(0.1, Math.hypot(dx, dz))
        const target = origin.offset((dx / length) * 10, 0, (dz / length) * 10)
        try {
          await this.gotoBounded(new goals.GoalNear(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z), 2), signal, 16)
        } catch (error) {
          if (error.name === 'AbortError') throw error
          console.warn(`Safety retreat could not find a route: ${error.message}`)
        }
      }
    }
    if (this.bot.food < 18) {
      try {
        await this.eat()
      } catch (error) {
        console.warn(`Safety eating needs supplies: ${error.message}`)
        try { await this.acquireEmergencyFood(signal) } catch (acquireError) {
          console.warn(`Emergency food acquisition failed: ${acquireError.message}`)
        }
      }
    }
    return 'Safety response completed'
  }

  async placeEmergencyWater() {
    if (String(this.bot.game?.dimension).includes('nether')) return false
    const bucket = this.bot.inventory.items().find((item) => item.name === 'water_bucket')
    if (!bucket) return false
    const feet = this.bot.entity.position.floored()
    let support = null
    for (let depth = 1; depth <= 5; depth += 1) {
      const candidate = this.bot.blockAt(feet.offset(0, -depth, 0))
      if (candidate && candidate.boundingBox !== 'empty' && !this.isLiquid(candidate)) {
        support = candidate
        break
      }
    }
    if (!support || this.bot.entity.position.distanceTo(support.position) > 5) return false
    await this.bot.equip(bucket, 'hand')
    await this.bot.activateBlock(support, new Vec3(0, 1, 0))
    this.emergencyWaterPosition = support.position.offset(0, 1, 0)
    return true
  }

  async recoverEmergencyWater() {
    const position = this.emergencyWaterPosition
    this.emergencyWaterPosition = null
    if (!position || String(this.bot.game?.dimension).includes('nether')) return false
    const water = this.bot.blockAt(position)
    const bucket = this.bot.inventory.items().find((item) => item.name === 'bucket')
    if (!water || !water.name.includes('water') || !bucket || this.bot.entity.position.distanceTo(position) > 5) return false
    await this.bot.equip(bucket, 'hand')
    await this.bot.lookAt(position.offset(0.5, 0.5, 0.5), true)
    this.bot.activateItem()
    await wait(250, new AbortController().signal)
    this.bot.deactivateItem()
    console.log(`Recovered emergency water at ${position}`)
    return true
  }

  safeEscapePositions(radius = 6) {
    const origin = this.bot.entity.position.floored()
    const candidates = []
    for (let dy = -2; dy <= 4; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          if (dx === 0 && dz === 0 && dy === 0) continue
          if (Math.hypot(dx, dz) > radius) continue
          const feet = origin.offset(dx, dy, dz)
          const floor = this.bot.blockAt(feet.offset(0, -1, 0))
          if (!floor || this.isPassable(floor) || this.isLiquid(floor)) continue
          if (!this.isPassable(this.bot.blockAt(feet)) || !this.isPassable(this.bot.blockAt(feet.offset(0, 1, 0)))) continue
          candidates.push(feet)
        }
      }
    }
    return candidates.sort((a, b) => {
      const score = (position) => origin.distanceTo(position) + Math.max(0, origin.y - position.y) * 2
      return score(a) - score(b)
    })
  }

  async moveDirectlyToward(position, signal, hazardous, timeoutMs = 6000) {
    await cancellable(
      this.bot.lookAt(position.offset(0.5, 1, 0.5), true),
      signal,
      () => this.bot.clearControlStates()
    )
    this.bot.setControlState('forward', true)
    this.bot.setControlState('sprint', true)
    this.bot.setControlState('jump', true)
    try {
      const deadline = Date.now() + timeoutMs
      while (hazardous() && this.bot.isAlive !== false && Date.now() < deadline) await wait(100, signal)
    } finally {
      this.bot.clearControlStates()
    }
    return !hazardous()
  }

  async clearDrowningCeiling(signal) {
    const origin = this.bot.entity.position.floored()
    for (let dy = 2; dy <= 3; dy += 1) {
      const block = this.bot.blockAt(origin.offset(0, dy, 0))
      if (!block || this.isPassable(block) || this.isLiquid(block)) continue
      if (!block.diggable || FALLING_BLOCKS.has(block.name)) return false
      if (this.adjacentFluids(block.position).some((fluid) => fluid.name.includes('lava'))) return false
      await this.bot.tool.equipForBlock(block, { requireHarvest: false, getFromChest: false })
      await cancellable(this.bot.dig(block, true), signal, () => this.bot.stopDigging())
      return true
    }
    return false
  }

  async escapeSuffocation(signal) {
    this.bot.clearControlStates()
    this.bot.setControlState('jump', true)
    let cleared = 0
    try {
      const deadline = Date.now() + 8000
      while (Date.now() < deadline && this.bot.isAlive !== false) {
        if (signal.aborted) throw abortError()
        const block = suffocatingBlock(this.bot)
        if (!block) return `Dug out after clearing ${cleared} obstructing block(s)`
        if (!block.diggable) return `Trapped in unbreakable ${block.name}`
        await this.bot.tool.equipForBlock(block, { requireHarvest: false, getFromChest: false })
        await cancellable(this.bot.dig(block, true), signal, () => this.bot.stopDigging())
        cleared += 1
        await wait(100, signal)
      }
    } finally {
      this.bot.clearControlStates()
    }
    return `Suffocation escape timed out after clearing ${cleared} block(s)`
  }

  async escapeDrowning(signal) {
    const target = this.safeEscapePositions(6)[0]
    if (target) {
      const escaped = await this.moveDirectlyToward(
        target,
        signal,
        () => this.bot.entity.isInWater && this.bot.oxygenLevel < 18,
        5000
      )
      if (escaped) return 'Reached a nearby breathable space'
    }
    this.bot.setControlState('jump', true)
    try {
      await this.clearDrowningCeiling(signal).catch((error) => {
        if (error.name === 'AbortError') throw error
        console.warn(`Could not clear drowning ceiling: ${error.message}`)
      })
      const deadline = Date.now() + 6000
      while (this.bot.entity.isInWater && this.bot.oxygenLevel < 18 && Date.now() < deadline) await wait(100, signal)
    } finally {
      this.bot.clearControlStates()
    }
    return this.bot.entity.isInWater && this.bot.oxygenLevel < 18
      ? 'Drowning escape timed out'
      : 'Reached breathable air'
  }

  async escapeFireOrLava(type, signal) {
    const hazardous = () => type === 'lava'
      ? Boolean(this.bot.entity.isInLava)
      : Boolean(Number.isInteger(this.bot.entity.metadata?.[0]) && (this.bot.entity.metadata[0] & 0x01))
    if (type === 'on_fire' && this.bot.health > 6) {
      const graceDeadline = Date.now() + 1500
      while (hazardous() && Date.now() < graceDeadline) await wait(100, signal)
      if (!hazardous()) return 'Residual post-lava flames expired'
    }
    const emergencyWater = this.emergencyWaterPromise || this.placeEmergencyWater()
    this.emergencyWaterPromise = null
    await emergencyWater.catch((error) => {
      if (error.name === 'AbortError') throw error
      console.warn(`Emergency water failed: ${error.message}`)
    })
    if (!hazardous()) {
      this.bot.clearControlStates()
      await this.recoverEmergencyWater().catch((error) => console.warn(`Could not recover emergency water: ${error.message}`))
      return `Extinguished ${type === 'lava' ? 'lava exposure' : 'fire'}`
    }
    const target = type === 'lava'
      ? this.safeEscapePositions(6)[0]
      : this.nearbyWaterPositions(6)[0]
    if (target) await this.moveDirectlyToward(target, signal, hazardous)
    if (hazardous() && type === 'lava') {
      try { await this.recoverStuck(this.bot.entity.position, signal) } catch (error) {
        if (error.name === 'AbortError') throw error
        console.warn(`Lava path recovery failed: ${error.message}`)
      }
    }
    this.bot.clearControlStates()
    if (!hazardous()) await this.recoverEmergencyWater().catch((error) => console.warn(`Could not recover emergency water: ${error.message}`))
    return hazardous()
      ? `${type === 'lava' ? 'Lava' : 'Fire'} escape timed out`
      : type === 'lava' ? 'Escaped lava toward safe footing' : 'Extinguished fire in nearby water'
  }

  nearbyWaterPositions(radius = 6) {
    const origin = this.bot.entity.position.floored()
    const positions = []
    for (let dy = -2; dy <= 3; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          if (Math.hypot(dx, dz) > radius) continue
          const position = origin.offset(dx, dy, dz)
          const block = this.bot.blockAt(position)
          if (block?.name === 'water' || block?.name === 'bubble_column') positions.push(position)
        }
      }
    }
    return positions.sort((a, b) => origin.distanceTo(a) - origin.distanceTo(b))
  }

  async clutchFall() {
    if (this.bot.entity.onGround || this.bot.entity.isInWater) return false
    return this.placeEmergencyWater()
  }

  async waitForRespawn(signal, timeoutMs = 30000) {
    if (this.bot.isAlive !== false && this.bot.health > 0) return
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer)
        this.bot.off('spawn', onSpawn)
        signal.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve()
      }
      const onSpawn = () => finish()
      const onAbort = () => finish(abortError())
      const timer = setTimeout(() => finish(new Error('respawn timed out')), timeoutMs)
      this.bot.once('spawn', onSpawn)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  threatNearPosition(position, radius = 10) {
    return Object.values(this.bot.entities).some((entity) => entity?.position &&
      HOSTILE_MOBS.has(entity.name) && entity.position.distanceTo(position) <= radius)
  }

  async recoverAfterDeath(trigger, signal) {
    await this.waitForRespawn(signal)
    await wait(750, signal)
    if (!trigger.position || (trigger.dimension && trigger.dimension !== this.bot.game?.dimension)) {
      return 'Respawned; death location is unavailable or in another dimension'
    }
    const position = new Vec3(trigger.position.x, trigger.position.y, trigger.position.z)
    const distance = this.bot.entity.position.distanceTo(position)
    if (distance > this.limits.maxMoveDistance) return `Respawned ${Math.round(distance)} blocks from the death location`
    if (this.threatNearPosition(position, 10)) return 'Respawned; skipped item recovery because hostiles remain at the death location'
    try {
      await this.gotoBounded(new goals.GoalNear(position.x, position.y, position.z, 3), signal, this.limits.pathSearchRadius || 32)
    } catch (error) {
      if (error.name === 'AbortError') throw error
      return `Respawned; could not safely return to the death location: ${error.message}`
    }
    const ownedNames = new Set((trigger.inventory || []).map((item) => item.name))
    const drops = this.entityTracker.droppedItems(null, 12)
      .filter(({ entity, item }) => entity.position.distanceTo(position) <= 8 && ownedNames.has(item.name))
      .map(({ entity }) => entity)
    if (!drops.length) return 'Respawned and returned; no matching dropped inventory remained'
    await this.ensureCollectBlockSlot('recovering dropped inventory')
    const reached = await this.collectDroppedEntities(drops, signal)
    return `Respawned and reached ${reached}/${drops.length} dropped inventory stack(s)`
  }

  async recoverStuck(startPosition, signal) {
    this.stop()
    this.bot.pathfinder.movements.clearCollisionIndex()
    const current = this.bot.entity.position.floored()
    const targetY = Math.floor(startPosition.y)
    if (targetY - current.y >= 2) {
      const scaffold = this.scaffoldItem()
      if (scaffold) {
        const movements = this.bot.pathfinder.movements
        const previousTower = movements.allow1by1towers
        const previousScaffolds = [...movements.scafoldingBlocks]
        if (!movements.scafoldingBlocks.includes(scaffold.type)) movements.scafoldingBlocks.push(scaffold.type)
        movements.allow1by1towers = true
        try {
          await this.gotoBounded(new goals.GoalY(targetY), signal, 12)
          return `towered out of a ${targetY - current.y}-block fall`
        } finally {
          movements.allow1by1towers = previousTower
          movements.scafoldingBlocks.splice(0, movements.scafoldingBlocks.length, ...previousScaffolds)
        }
      }
    }

    const candidates = []
    for (let radius = 1; radius <= 3; radius += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue
          const feet = current.offset(dx, 0, dz)
          const floor = this.bot.blockAt(feet.offset(0, -1, 0))
          if (floor && !this.isPassable(floor) && !this.isLiquid(floor) &&
              this.isPassable(this.bot.blockAt(feet)) && this.isPassable(this.bot.blockAt(feet.offset(0, 1, 0)))) {
            candidates.push(new goals.GoalBlock(feet.x, feet.y, feet.z))
          }
        }
      }
    }
    if (!candidates.length) throw new Error('no safe adjacent space for unstuck recovery')
    await this.gotoBounded(new goals.GoalCompositeAny(candidates), signal, 8)
    return 'moved to a nearby safe block and cleared the path cache'
  }

  assertNearby(position) {
    const distance = this.bot.entity.position.distanceTo(position)
    if (distance > this.limits.maxMoveDistance) {
      throw new Error(`Target is ${distance.toFixed(1)} blocks away; limit is ${this.limits.maxMoveDistance}`)
    }
  }

  async gotoBounded(goal, signal, searchRadius = this.limits.localPathSearchRadius || 10) {
    const previousRadius = this.bot.pathfinder.searchRadius
    const movements = this.bot.pathfinder.movements
    const previousCanDig = movements?.canDig
    this.bot.pathfinder.searchRadius = searchRadius
    // Navigation should walk through the world, not silently reshape it.
    // Mining/building skills excavate or scaffold their intended cells first.
    if (movements) movements.canDig = false
    try {
      return await cancellable(
        this.bot.pathfinder.goto(goal),
        signal,
        () => this.bot.pathfinder.stop()
      )
    } finally {
      if (movements) movements.canDig = previousCanDig
      this.bot.pathfinder.searchRadius = previousRadius
      this.bot.pathfinder.movements.clearCollisionIndex()
    }
  }

  async collectBlockBounded(target, signal, searchRadius = 16, preferredTool = null) {
    let block = this.bot.blockAt(target.position)
    if (!block || block.type !== target.type) return false
    const center = block.position.offset(0.5, 0.5, 0.5)
    const inReach = () => this.bot.entity.position.distanceTo(center) <= 5.2 &&
      (typeof this.bot.canSeeBlock !== 'function' || this.bot.canSeeBlock(block))
    if (!inReach()) {
      await this.gotoBounded(
        new goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z),
        signal,
        Math.min(searchRadius, this.limits.pathSearchRadius || 32)
      )
      block = this.bot.blockAt(target.position)
      if (!block || block.type !== target.type) return false
    }
    if (!inReach()) throw new Error(`no safe player-reachable stance for ${block.name}`)
    if (!block.diggable) throw new Error(`${block.name} cannot be dug`)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (preferredTool) {
        const tool = await this.toolManager.ensureTool(preferredTool, signal)
        if (!tool) throw new Error(`no usable ${preferredTool} or replacement materials for ${block.name}`)
      }
      await this.bot.tool.equipForBlock(block, { requireHarvest: true, getFromChest: false })
      if (block.harvestTools && !block.canHarvest(this.bot.heldItem?.type)) {
        throw new Error(`no suitable tool for ${block.name}`)
      }
      await cancellable(this.bot.dig(block, true), signal, () => this.bot.stopDigging())
      await wait(200, signal)
      const remaining = this.bot.blockAt(target.position)
      if (!remaining || remaining.type !== target.type) return true
      block = remaining
      if (!preferredTool || attempt === 1) break
      console.log(`${preferredTool} dig did not finish ${block.name}; preparing a replacement and retrying once`)
    }
    throw new Error(`${block.name} remained after a bounded dig attempt`)
  }

  async execute(rawAction, signal, context = {}) {
    const action = ActionSchema.parse(rawAction)
    if (signal.aborted) throw abortError()

    switch (action.type) {
      case 'move_to': return this.moveTo(action, signal)
      case 'follow': return this.follow(action)
      case 'remember_location': return this.rememberLocation(action)
      case 'go_to_location': return this.goToLocation(action, signal)
      case 'return_to_surface': return this.returnToSurface(signal)
      case 'collect': return this.collect(action, signal, { onProgress: context.onProgress })
      case 'mine_block': return this.mineSelectedBlock(action, signal)
      case 'pickup': return this.pickup(action, signal)
      case 'craft': return this.craft(action, signal)
      case 'place': return this.place(action, signal)
      case 'attack': return this.attack(action, signal)
      case 'interact_block': return this.interactBlock(action, signal)
      case 'sleep': return this.sleep(signal)
      case 'farm': return this.farm(action, signal, context.onProgress)
      case 'create_farm': return this.createFarm(action, signal, context.onProgress)
      case 'equip': return this.equip(action)
      case 'equip_tool': return this.equipTool(action)
      case 'drop': return this.drop(action)
      case 'give': return this.give(action, signal)
      case 'deposit': return this.deposit(action, signal)
      case 'withdraw': return this.withdraw(action, signal)
      case 'strip_mine': return this.stripMine(action, signal, context.onProgress)
      case 'mine_resource': return this.mineResource(action, signal)
      case 'staircase_to': return this.staircaseTo(action, signal)
      case 'staircase_to_y': return this.staircaseToY(action, signal)
      case 'eat': return this.eat(signal)
      case 'say':
        if (action.message.trimStart().startsWith('/')) {
          throw new Error('Chat commands are not allowed')
        }
        if (!context.whisperTo) throw new Error('Private message recipient is required')
        this.bot.whisper(context.whisperTo, action.message.replace(/\s+/g, ' ').slice(0, 220))
        return `Whispered to ${context.whisperTo}: ${action.message}`
      case 'wait':
        await wait(action.seconds * 1000, signal)
        return `Waited ${action.seconds} seconds`
    }
  }

  preferredToolForBlock(block) {
    const name = block?.name || ''
    if (name.endsWith('_log') || name.endsWith('_wood') || /(?:planks|bookshelf|chest|barrel)$/.test(name)) return 'axe'
    if (SOIL_BLOCKS.has(name) || /(?:snow|concrete_powder)$/.test(name)) return 'shovel'
    if (name.endsWith('_ore') || /(?:stone|deepslate|netherrack|blackstone|obsidian|brick)/.test(name)) return 'pickaxe'
    return null
  }

  async mineSelectedBlock(action, signal) {
    const position = new Vec3(Math.floor(action.x), Math.floor(action.y), Math.floor(action.z))
    this.assertNearby(position)
    const block = this.bot.blockAt(position)
    if (!block) throw new Error(`No loaded block at ${position}`)
    if (this.isPassable(block) || this.isLiquid(block)) throw new Error(`${block.name} is not a mineable selected block`)
    if (!block.diggable) throw new Error(`${block.name} cannot be dug`)
    const name = block.name
    const dropNames = (block.drops || []).map((id) => this.bot.registry.items[id]?.name).filter(Boolean)
    await this.ensureCollectBlockSlot(`mining selected ${name}`)
    await this.collectBlockBounded(block, signal, 10, this.preferredToolForBlock(block))
    await this.collectDropsNear(position, signal, dropNames, 4, 250)
    return `Mined selected ${name} at ${position}`
  }

  async moveTo(action, signal) {
    const target = new Vec3(action.x, action.y, action.z)
    this.assertNearby(target)
    await this.gotoBounded(
      new goals.GoalNear(action.x, action.y, action.z, 1), signal,
      this.limits.pathSearchRadius || 32
    )
    return `Moved near ${action.x}, ${action.y}, ${action.z}`
  }

  follow(action) {
    const entity = this.findPlayer(action.player)
    if (!entity) throw new Error(`Player ${action.player} is not visible`)
    this.assertNearby(entity.position)
    this.bot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true)
    return `Now following ${action.player}`
  }

  rememberLocation(action) {
    if (!this.landmarks) throw new Error('Persistent landmark storage is unavailable')
    const entry = this.landmarks.remember(action.name, this.bot.entity.position, this.bot.game?.dimension)
    return `Remembered ${action.name} at ${entry.x}, ${entry.y}, ${entry.z}`
  }

  async gotoPositionSegmented(destination, signal, tolerance = 2) {
    const start = this.bot.entity.position.clone()
    const distance = start.distanceTo(destination)
    if (distance > (this.limits.maxExpeditionDistance || 2048)) {
      throw new Error(`Remembered destination is ${distance.toFixed(1)} blocks away; expedition limit is ${this.limits.maxExpeditionDistance || 2048}`)
    }
    const segments = Math.max(1, Math.ceil(distance / 12))
    for (let index = 1; index <= segments; index += 1) {
      if (signal.aborted) throw abortError()
      const ratio = index / segments
      const waypoint = new Vec3(
        Math.floor(start.x + (destination.x - start.x) * ratio),
        Math.floor(start.y + (destination.y - start.y) * ratio),
        Math.floor(start.z + (destination.z - start.z) * ratio)
      )
      await this.gotoBounded(
        new goals.GoalNear(waypoint.x, waypoint.y, waypoint.z, index === segments ? tolerance : 3),
        signal,
        this.limits.pathSearchRadius || 32
      )
    }
  }

  async goToLocation(action, signal) {
    const entry = this.landmarks?.get(action.name)
    if (!entry) throw new Error(`No remembered location named ${action.name}`)
    if (entry.dimension && entry.dimension !== this.bot.game?.dimension) {
      throw new Error(`${action.name} is in ${entry.dimension}; portal travel is not available`)
    }
    const route = Array.isArray(entry.route)
      ? entry.route.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z))
      : []
    if (route.length && this.bot.entity.position.distanceTo(new Vec3(route[0].x, route[0].y, route[0].z)) <= 24) {
      for (const point of route) {
        await this.gotoBounded(new goals.GoalNear(point.x, point.y, point.z, 2), signal, this.limits.pathSearchRadius || 32)
      }
    } else {
      await this.gotoPositionSegmented(new Vec3(entry.x, entry.y, entry.z), signal)
    }
    return `Reached remembered location ${action.name}`
  }

  isAtSurface() {
    const feet = this.bot.entity.position.floored()
    const head = this.bot.blockAt(feet.offset(0, 1, 0))
    return Number(head?.skyLight || 0) > 0
  }

  async returnToSurface(signal) {
    if (this.isAtSurface()) return 'Already at the surface'
    const startY = this.bot.entity.position.y
    const entrance = this.landmarks?.get('last_mine_entrance')
    if (entrance && (!entrance.dimension || entrance.dimension === this.bot.game?.dimension) &&
        entrance.y > startY + 2) {
      try {
        await this.goToLocation({ type: 'go_to_location', name: 'last_mine_entrance' }, signal)
        if (this.isAtSurface() || this.bot.entity.position.y >= entrance.y - 2) {
          return `Returned along the remembered mine route to Y ${Math.floor(this.bot.entity.position.y)}`
        }
      } catch (error) {
        if (error.name === 'AbortError') throw error
        console.warn(`Remembered mine route was unavailable; searching for a walkable ascent: ${error.message}`)
      }
    }

    const galleryOrigin = this.landmarks?.get('last_strip_mine_origin')
    if (galleryOrigin && (!galleryOrigin.dimension || galleryOrigin.dimension === this.bot.game?.dimension) &&
        this.bot.entity.position.distanceTo(new Vec3(galleryOrigin.x, galleryOrigin.y, galleryOrigin.z)) > 3) {
      try {
        await this.goToLocation({ type: 'go_to_location', name: 'last_strip_mine_origin' }, signal)
      } catch (error) {
        if (error.name === 'AbortError') throw error
        console.warn(`Could not return to strip-mine origin before seeking the surface: ${error.message}`)
      }
    }

    let climbed = 0
    const movements = this.bot.pathfinder.movements
    const previousCanDig = movements.canDig
    const previousTower = movements.allow1by1towers
    movements.canDig = false
    movements.allow1by1towers = false
    try {
      for (let attempt = 0; attempt < 12 && !this.isAtSurface(); attempt += 1) {
        if (signal.aborted) throw abortError()
        const beforeY = this.bot.entity.position.y
        const targetY = Math.min(319, Math.floor(beforeY) + 10)
        let ascended = false
        for (const radius of [24, 40, 64]) {
          try {
            await this.gotoBounded(new goals.GoalY(targetY), signal, radius)
            ascended = true
            break
          } catch (error) {
            if (error.name === 'AbortError') throw error
          }
        }
        if (!ascended) break
        const gain = this.bot.entity.position.y - beforeY
        if (gain < 2) break
        climbed += gain
      }
    } finally {
      movements.canDig = previousCanDig
      movements.allow1by1towers = previousTower
    }
    if (!this.isAtSurface()) {
      const error = new Error(`no walkable mine exit was found after climbing ${Math.floor(climbed)} blocks`)
      error.category = 'missing_route'
      throw error
    }
    const position = this.bot.entity.position.floored()
    this.landmarks?.remember('last_mine_exit', position, this.bot.game?.dimension, 'mine_entrance')
    return `Found a walkable route to the surface at ${position.x}, ${position.y}, ${position.z}`
  }

  async equipBestArmor() {
    const materialRank = { leather: 1, golden: 2, chainmail: 3, iron: 4, diamond: 5, netherite: 6 }
    const pieces = [
      ['head', 'helmet'], ['torso', 'chestplate'], ['legs', 'leggings'], ['feet', 'boots']
    ]
    for (const [destination, suffix] of pieces) {
      const score = (item) => {
        if (!item) return -1
        const material = item.name.slice(0, -(`_${suffix}`.length))
        const durability = this.remainingItemDurability(item)
        if (durability <= 0) return -1
        return (materialRank[material] || 0) * 100000 + Math.min(99999, durability)
      }
      const best = this.bot.inventory.items()
        .filter((item) => item.name.endsWith(`_${suffix}`))
        .filter((item) => score(item) >= 0)
        .sort((a, b) => score(b) - score(a))[0]
      const slot = this.bot.getEquipmentDestSlot?.(destination)
      const equipped = Number.isInteger(slot) ? this.bot.inventory.slots?.[slot] : null
      if (best && score(best) > score(equipped)) await this.bot.equip(best, destination)
    }
  }

  async prepareForAction(action, signal) {
    await this.equipBestArmor()
    if (this.bot.food < 18) {
      try {
        await this.eat()
      } catch {
        if (this.bot.food <= 8) await this.acquireEmergencyFood(signal)
      }
    }
    const timeOfDay = this.bot.time?.timeOfDay
    const longOutdoorTask = ['collect', 'farm', 'create_farm', 'build_schematic', 'repair_schematic', 'collect_build_materials', 'go_to_location'].includes(action.type)
    if (action.type !== 'sleep' && longOutdoorTask && Number.isFinite(timeOfDay) && timeOfDay >= 12542 && timeOfDay <= 23460) {
      try { await this.sleep(signal) } catch {}
    }
    if (['strip_mine', 'mine_resource', 'staircase_to', 'staircase_to_y'].includes(action.type)) {
      await this.ensureTaskInventorySpace('mining', signal)
      await this.tryRestockMiningSupplies(signal)
      if (this.inventoryCount('torch') === 0 && this.knownStoredChoice(['torch'])) {
        await this.tryWithdrawFromNearby('torch', 32, signal)
      }
      if (this.inventoryCount('crafting_table') === 0 && this.knownStoredChoice(['crafting_table'])) {
        await this.tryWithdrawFromNearby('crafting_table', 1, signal)
      }
      await this.toolManager.ensureSticks(8, signal)
      await this.toolManager.ensureCraftingTableItem(signal)
      const pickaxe = await this.toolManager.ensureTool('pickaxe', signal, 1)
      if (!pickaxe) throw new Error('Mining preparation failed: no usable pickaxe or replacement materials')
      await this.ensureTunnelTorches(signal)
    } else if (action.type === 'attack') {
      await this.toolManager.ensureTool('sword', signal, 16)
      await this.toolManager.ensureShield(signal)
    } else if (action.type === 'collect') {
      const strategy = this.collectionStrategy(action.block)
      if (strategy === 'tree_bottom_up') await this.toolManager.ensureTool('axe', signal)
      if (strategy === 'surface_layers') await this.toolManager.ensureTool('shovel', signal)
      if (strategy === 'vein_nearest') await this.toolManager.ensureTool('pickaxe', signal)
    } else if (action.type === 'create_farm') {
      const hoe = await this.toolManager.ensureTool('hoe', signal, 16)
      if (!hoe) throw new Error('Farm preparation failed: no usable hoe')
    }
  }

  async collect(action, signal, { preserveItems = new Set(), onProgress = null } = {}) {
    const blockTypes = this.resolveBlockTypes(action.block)
    if (blockTypes.length === 0) throw new Error(`Unknown block or block group: ${action.block}`)
    const blockTypeIds = new Set(blockTypes.map((block) => block.id))
    let collected = 0
    let consecutiveFailures = 0
    const failures = []
    const attempted = new Set()
    const strategyState = { layerY: null }
    const strategy = this.collectionStrategy(action.block)
    const previousTowerSetting = this.bot.collectBlock.movements.allow1by1towers
    const previousPathfinderTower = this.bot.pathfinder.movements.allow1by1towers
    const placedScaffolds = new Map()
    const trackScaffold = (oldBlock, newBlock) => {
      if (
        strategy === 'tree_bottom_up' && oldBlock?.boundingBox === 'empty' &&
        newBlock && SCAFFOLD_BLOCKS.has(newBlock.name) &&
        this.bot.entity.position.distanceTo(newBlock.position) <= 3
      ) {
        placedScaffolds.set(newBlock.position.toString(), newBlock.position.clone())
      }
    }
    if (strategy === 'tree_bottom_up') {
      this.bot.collectBlock.movements.allow1by1towers = true
      this.bot.pathfinder.movements.allow1by1towers = true
      this.bot.on('blockUpdate', trackScaffold)
    }

    try {
      while (
        (collected < action.quantity || (strategy === 'tree_bottom_up' && strategyState.activeTree?.size > 0)) &&
        consecutiveFailures < this.limits.collectMaxPathFailures
      ) {
      if (signal.aborted) throw abortError()
      await this.ensureTaskInventorySpace(
        strategy === 'tree_bottom_up'
          ? 'woodcutting'
          : (strategy === 'surface_layers' || strategy === 'vein_nearest' ? 'mining' : 'foraging'),
        signal,
        { preserveItems }
      )
      strategyState.finishOnly = collected >= action.quantity
      const selection = this.findCollectionTarget(
        blockTypeIds,
        attempted,
        strategy,
        strategyState
      )
      const block = selection?.block

      if (!block) break
      await this.ensureCollectBlockSlot(`collecting ${action.block}`)
      const dropNames = (block.drops || [])
        .map((id) => this.bot.registry.items[id]?.name)
        .filter(Boolean)
      if (!this.inventoryTracker.canAccept(dropNames)) {
        throw new Error(`inventory full; no configured trash could be discarded before collecting ${action.block}`)
      }
      attempted.add(block.position.toString())
      console.log(`Collect target ${block.name} at ${block.position} (${selection.tier})`)
      try {
        const tool = selection.strategy === 'tree_bottom_up'
          ? 'axe'
          : selection.strategy === 'surface_layers'
            ? 'shovel'
            : selection.strategy === 'vein_nearest'
              ? 'pickaxe'
              : null
        if (tool) await this.toolManager.ensureTool(tool, signal)
        await this.collectBlockBounded(block, signal, 16, tool)
        if (this.bot.blockAt(block.position)?.type === block.type) {
          throw new Error('target was not mined from a safe position')
        }
        if (strategy !== 'tree_bottom_up') {
          await this.collectDropsNear(block.position, signal, dropNames, 4, 0)
        }
        strategyState.activeTree?.delete(block.position.toString())
        collected += 1
        if (collected % 8 === 0 || collected >= action.quantity) {
          onProgress?.({ completed: collected, total: action.quantity, position: {
            x: block.position.x, y: block.position.y, z: block.position.z
          } })
        }
        consecutiveFailures = 0
      } catch (error) {
        if (error.name === 'AbortError') throw error
        consecutiveFailures += 1
        failures.push(`${block.position}: ${error.message}`)
        this.blockTracker.markUnreachable(block.position, error.message)
        console.warn(`Skipping unreachable ${action.block} at ${block.position}: ${error.message}`)
      }
      }
    } finally {
      this.bot.off('blockUpdate', trackScaffold)
      try {
        if (strategy === 'tree_bottom_up') {
          await this.returnFromTreeAndRecoverScaffolds(strategyState.treeBase, placedScaffolds, signal)
        }
      } finally {
        this.bot.collectBlock.movements.allow1by1towers = previousTowerSetting
        this.bot.pathfinder.movements.allow1by1towers = previousPathfinderTower
      }
    }
    if (collected === 0) {
      const error = new Error(`Could not reach any ${action.block}: ${failures[0] || 'none are loaded nearby'}`)
      if (failures.length === 0) error.category = 'missing_resource'
      throw error
    }
    if (collected < action.quantity) {
      const error = new Error(`Collected ${collected}/${action.quantity} ${action.block}; no more reachable targets nearby`)
      error.category = 'missing_resource'
      throw error
    }
    return `Collected ${collected} ${action.block} block(s)`
  }

  resolveBlockTypes(name) {
    const blocks = Object.values(this.bot.registry.blocksByName)
    if (name === 'any_log') {
      return blocks.filter((block) => block.name.endsWith('_log') && !block.name.startsWith('stripped_'))
    }
    if (name === 'any_ore') {
      return blocks.filter((block) => block.name.endsWith('_ore'))
    }
    if (name === 'dirt') {
      return ['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium']
        .map((blockName) => this.bot.registry.blocksByName[blockName])
        .filter(Boolean)
    }
    const exact = this.bot.registry.blocksByName[name]
    if (!exact) return []
    if (name.endsWith('_ore') && !name.startsWith('deepslate_')) {
      const deepslateVariant = this.bot.registry.blocksByName[`deepslate_${name}`]
      return deepslateVariant ? [exact, deepslateVariant] : [exact]
    }
    return [exact]
  }

  collectionStrategy(name) {
    if (name === 'dirt' || SOIL_BLOCKS.has(name)) return 'surface_layers'
    if (name === 'any_log' || name.endsWith('_log')) return 'tree_bottom_up'
    if (name === 'any_ore' || name.endsWith('_ore')) return 'vein_nearest'
    return 'nearest'
  }

  findCollectionTarget(blockTypeIds, attempted, strategy, state) {
    const origin = this.bot.entity.position
    const originChunkX = Math.floor(origin.x / 16)
    const originChunkZ = Math.floor(origin.z / 16)
    const blocks = this.blockTracker.find(
      [...blockTypeIds],
      Math.min(this.limits.collectSearchDistance, this.limits.maxMoveDistance),
      512
    ).map((position) => this.bot.blockAt(position))
      .filter((block) => block && !attempted.has(block.position.toString()))
      .sort((a, b) => origin.distanceTo(a.position) - origin.distanceTo(b.position))

    const chunkOffset = (block) => ({
      x: Math.floor(block.position.x / 16) - originChunkX,
      z: Math.floor(block.position.z / 16) - originChunkZ
    })
    const tiers = [
      {
        name: 'current chunk',
        blocks: blocks.filter((block) => {
          const offset = chunkOffset(block)
          return offset.x === 0 && offset.z === 0
        })
      },
      {
        name: 'surrounding 3x3 chunks',
        blocks: blocks.filter((block) => {
          const offset = chunkOffset(block)
          return Math.abs(offset.x) <= 1 && Math.abs(offset.z) <= 1
        })
      },
      { name: 'nearest loaded match', blocks }
    ]

    if (strategy === 'tree_bottom_up' && state.activeTree?.size > 0) {
      const activeBlocks = []
      for (const [key, position] of state.activeTree) {
        const block = this.bot.blockAt(position)
        if (!block || !blockTypeIds.has(block.type)) {
          state.activeTree.delete(key)
        } else if (!attempted.has(key)) {
          activeBlocks.push(block)
        }
      }
      activeBlocks.sort((a, b) => a.position.y - b.position.y ||
        origin.distanceTo(a.position) - origin.distanceTo(b.position))
      if (activeBlocks[0]) {
        return { block: activeBlocks[0], tier: 'active tree, bottom-up', strategy }
      }
      if (state.activeTree.size > 0) return null
    }
    if (strategy === 'tree_bottom_up' && state.finishOnly) return null
    if (strategy === 'surface_layers') {
      const feet = origin.floored()
      const safeSurfaceBlocks = (blocksToFilter) => blocksToFilter.filter((block) => {
        const above = this.bot.blockAt(block.position.offset(0, 1, 0))
        const underBot = block.position.x === feet.x && block.position.z === feet.z && block.position.y < feet.y
        return !underBot && above && above.boundingBox === 'empty' && !this.isLiquid(above)
      })

      if (state.layerY !== null) {
        for (const tier of tiers) {
          const sameLayer = safeSurfaceBlocks(tier.blocks)
            .filter((block) => block.position.y === state.layerY)
          if (sameLayer.length > 0) {
            sameLayer.sort((a, b) => {
              const horizontalA = Math.hypot(a.position.x - origin.x, a.position.z - origin.z)
              const horizontalB = Math.hypot(b.position.x - origin.x, b.position.z - origin.z)
              return horizontalA - horizontalB
            })
            return {
              block: sameLayer[0],
              tier: `${tier.name}, ${strategy}, Y ${state.layerY}`,
              strategy
            }
          }
        }
        state.layerY = null
      }

      for (const tier of tiers) {
        const candidates = safeSurfaceBlocks(tier.blocks)
        if (candidates.length === 0) continue
        const preferredY = feet.y - 1
        const levels = [...new Set(candidates.map((block) => block.position.y))]
          .sort((a, b) => Math.abs(a - preferredY) - Math.abs(b - preferredY) || b - a)
        state.layerY = levels[0]
        const layer = candidates.filter((block) => block.position.y === state.layerY)
        layer.sort((a, b) => {
          const horizontalA = Math.hypot(a.position.x - origin.x, a.position.z - origin.z)
          const horizontalB = Math.hypot(b.position.x - origin.x, b.position.z - origin.z)
          return horizontalA - horizontalB
        })
        return { block: layer[0], tier: `${tier.name}, ${strategy}, Y ${state.layerY}`, strategy }
      }
      return null
    }

    const tier = tiers.find((candidate) => candidate.blocks.length > 0)
    if (!tier) return null
    let candidates = tier.blocks
    if (strategy === 'tree_bottom_up') {
      const anchor = candidates[0]
      const tree = this.bot.collectBlock.findFromVein(anchor, 128, 10, 1)
        .filter((block) => blockTypeIds.has(block.type))
      state.activeTree = new Map(tree.map((block) => [block.position.toString(), block.position.clone()]))
      state.treeBase = tree.reduce((lowest, block) => {
        return !lowest || block.position.y < lowest.y ? block.position.clone() : lowest
      }, null)
      candidates = tree.sort((a, b) => a.position.y - b.position.y ||
        origin.distanceTo(a.position) - origin.distanceTo(b.position))
    }

    return candidates[0] ? { block: candidates[0], tier: `${tier.name}, ${strategy}`, strategy } : null
  }

  async returnFromTreeAndRecoverScaffolds(treeBase, scaffolds, signal) {
    const pathMovements = this.bot.pathfinder.movements
    const collectMovements = this.bot.collectBlock.movements
    const previousPathTower = pathMovements.allow1by1towers
    const previousCollectTower = collectMovements.allow1by1towers
    const previousPathScaffolds = [...pathMovements.scafoldingBlocks]
    const previousCollectScaffolds = [...collectMovements.scafoldingBlocks]
    // Cleanup must only walk and dig. Letting either pathfinder place blocks
    // here can fail when no scaffold is held or create another support while
    // attempting to remove the previous one.
    pathMovements.allow1by1towers = false
    collectMovements.allow1by1towers = false
    pathMovements.scafoldingBlocks.splice(0)
    collectMovements.scafoldingBlocks.splice(0)
    try {
      if ((this.inventoryTracker?.freeSlots?.() ?? 1) < 1) {
        try {
          const reserved = this.inventoryPolicy?.reservedItems?.() || new Map()
          await this.ensureTaskInventorySpace('building', signal, {
            preserveItems: new Set(reserved.keys()), minimumFreeSlots: 1
          })
        } catch (error) {
          if (error.name === 'AbortError') throw error
          console.warn(`Could not free a slot before scaffold cleanup: ${error.message}`)
        }
      }
      if (treeBase && !signal.aborted) {
        try {
          await this.gotoBounded(
            new goals.GoalNear(treeBase.x, treeBase.y, treeBase.z, 3), signal,
            this.limits.pathSearchRadius || 32
          )
        } catch (error) {
          if (error.name === 'AbortError') throw error
          console.warn(`Could not path back to the tree base: ${error.message}`)
        }
      }

      const positions = [...scaffolds.values()].sort((a, b) => b.y - a.y)
      for (const position of positions) {
        if (signal.aborted) throw abortError()
        const block = this.bot.blockAt(position)
        if (!block || !SCAFFOLD_BLOCKS.has(block.name)) continue
        try {
          await this.ensureCollectBlockSlot('recovering temporary scaffolding')
          await this.toolManager.ensureTool(
            block.name === 'dirt' ? 'shovel' : 'pickaxe',
            signal
          )
          await this.collectBlockBounded(block, signal, 10)
          console.log(`Recovered tree scaffold ${block.name} at ${position}`)
        } catch (error) {
          if (error.name === 'AbortError') throw error
          console.warn(`Could not recover tree scaffold at ${position}: ${error.message}`)
        }
      }
      if (treeBase && !signal.aborted) {
        await this.collectDropsNear(treeBase, signal, null, 8, 500)
      }
    } finally {
      pathMovements.allow1by1towers = previousPathTower
      collectMovements.allow1by1towers = previousCollectTower
      pathMovements.scafoldingBlocks.splice(0, pathMovements.scafoldingBlocks.length, ...previousPathScaffolds)
      collectMovements.scafoldingBlocks.splice(0, collectMovements.scafoldingBlocks.length, ...previousCollectScaffolds)
    }
  }

  isLiquid(block) {
    return block && (block.name.includes('lava') || block.name.includes('water'))
  }

  isPassable(block) {
    return block && block.boundingBox === 'empty' && !this.isLiquid(block)
  }

  adjacentFluids(position) {
    const offsets = [
      new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0),
      new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)
    ]
    return offsets.map((offset) => this.bot.blockAt(position.plus(offset))).filter((block) => this.isLiquid(block))
  }

  async createFluidSump(fluid, signal) {
    const sumpPosition = fluid.position.offset(0, -1, 0)
    const feet = this.bot.entity.position.floored()
    if (sumpPosition.x === feet.x && sumpPosition.z === feet.z && sumpPosition.y < feet.y) {
      throw new Error(`cannot safely dig a sump beneath the bot for ${fluid.name}`)
    }
    const sump = this.bot.blockAt(sumpPosition)
    if (!sump || this.isLiquid(sump) || this.isPassable(sump)) return
    if (!sump.diggable) throw new Error(`cannot contain ${fluid.name}; sump block is unbreakable`)

    await this.toolManager.ensureTool('pickaxe', signal)
    await this.bot.tool.equipForBlock(sump, { requireHarvest: false, getFromChest: false })
    await cancellable(this.bot.dig(sump, true), signal, () => this.bot.stopDigging())
    console.log(`Created fluid sump at ${sumpPosition} beneath ${fluid.name}`)
  }

  async digTunnelBlock(position, signal) {
    let block = this.bot.blockAt(position)
    if (!block) throw new Error(`unloaded block at ${position}`)
    if (this.isPassable(block)) return
    if (this.isLiquid(block)) {
      await this.createFluidSump(block, signal)
      throw new Error(`${block.name} was diverted into a sump at ${position}`)
    }
    if (!block.diggable) throw new Error(`${block.name} cannot be mined at ${position}`)

    const fluids = this.adjacentFluids(position)
    for (const fluid of fluids) await this.createFluidSump(fluid, signal)
    if (fluids.some((fluid) => fluid.name.includes('lava'))) {
      throw new Error(`lava beside ${position} was contained; tunnel stopped before entering it`)
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let pickaxe = await this.toolManager.ensureTool('pickaxe', signal)
      if (!pickaxe) {
        await this.toolManager.maintainToolSet(signal)
        pickaxe = await this.toolManager.ensureTool('pickaxe', signal)
      }
      if (!pickaxe) throw new Error(`no usable pickaxe or replacement materials for ${block.name}`)
      await this.bot.tool.equipForBlock(block, { requireHarvest: true, getFromChest: false })
      if (block.harvestTools && !block.canHarvest(this.bot.heldItem?.type)) {
        throw new Error(`no suitable tool for ${block.name}`)
      }
      await cancellable(
        this.bot.dig(block, true),
        signal,
        () => this.bot.stopDigging()
      )
      const remaining = this.bot.blockAt(position)
      if (!remaining || remaining.type !== block.type) return
      if (attempt === 1) break
      block = remaining
      console.log(`Mining tool did not finish ${block.name}; preparing a replacement and retrying once`)
    }
    throw new Error(`${block.name} remained after replacing the mining tool`)
  }

  oreBlockTypes(target = 'general') {
    const ores = this.resolveBlockTypes('any_ore')
    if (!target || target === 'general') return ores
    return ores.filter((block) => block.name === `${target}_ore` || block.name === `deepslate_${target}_ore`)
  }

  async collectExposedOres(signal, attempted, target = 'general') {
    const oreIds = new Set(this.oreBlockTypes(target).map((block) => block.id))
    const airOffsets = [
      new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0),
      new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)
    ]
    const ores = this.blockTracker.find([...oreIds], 4, 16).map((position) => this.bot.blockAt(position)).filter((block) => {
      if (!block || attempted.has(block.position.toString())) return false
      return airOffsets.some((offset) => this.isPassable(this.bot.blockAt(block.position.plus(offset))))
    })

    const returnPosition = this.bot.entity.position.floored()
    for (const ore of ores) {
      if (signal.aborted) throw abortError()
      try {
        await this.mineConnectedOreVein(ore, oreIds, signal, attempted, returnPosition)
      } catch (error) {
        if (error.name === 'AbortError') throw error
        if (/inventory full/i.test(error.message)) {
          console.warn(`Stopped exposed-ore collection: ${error.message}`)
          break
        }
        console.warn(`Could not collect exposed ${ore.name}: ${error.message}`)
      }
    }
    if (!signal.aborted && this.bot.entity.position.distanceTo(returnPosition) > 1.5) {
      await this.gotoBounded(new goals.GoalNear(returnPosition.x, returnPosition.y, returnPosition.z, 1), signal, 10)
    }
  }

  canStandAt(position) {
    const floor = this.bot.blockAt(position.offset(0, -1, 0))
    return floor && !this.isPassable(floor) && !this.isLiquid(floor) &&
      this.isPassable(this.bot.blockAt(position)) && this.isPassable(this.bot.blockAt(position.offset(0, 1, 0)))
  }

  hasClearVerticalOreReach(position) {
    const feet = this.bot.entity.position.floored()
    if (position.x !== feet.x || position.z !== feet.z || position.y < feet.y + 2) return false
    if (this.bot.entity.position.distanceTo(position.offset(0.5, 0.5, 0.5)) > 5.2) return false
    for (let y = feet.y + 1; y < position.y; y += 1) {
      if (!this.isPassable(this.bot.blockAt(new Vec3(position.x, y, position.z)))) return false
    }
    return true
  }

  canReachVisibleOre(ore) {
    const inReach = this.bot.entity.position.distanceTo(ore.position.offset(0.5, 0.5, 0.5)) <= 5.2
    const visible = typeof this.bot.canSeeBlock !== 'function' || this.bot.canSeeBlock(ore) ||
      this.hasClearVerticalOreReach(ore.position)
    return inReach && visible
  }

  oreMiningStances(position, cavities, returnPosition) {
    const candidates = [this.bot.entity.position.floored(), returnPosition, ...cavities]
    for (let dy = -2; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          if (dx === 0 && dz === 0 && dy >= 0) continue
          candidates.push(position.offset(dx, dy, dz))
        }
      }
    }
    const unique = new Map()
    for (const candidate of candidates) {
      if (!candidate || candidate.distanceTo(position) > 5 || !this.canStandAt(candidate)) continue
      if (candidate.x === position.x && candidate.z === position.z && candidate.y > position.y) continue
      unique.set(candidate.toString(), candidate)
    }
    return [...unique.values()].sort((a, b) =>
      this.bot.entity.position.distanceTo(a) - this.bot.entity.position.distanceTo(b)
    )
  }

  excavatableOreStances(position, oreIds, returnPosition) {
    const feet = this.bot.entity.position.floored()
    const levels = new Set([feet.y, returnPosition?.y, position.y + 1].filter(Number.isFinite))
    const candidates = []
    for (const y of levels) {
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          if (dx === 0 && dz === 0) continue
          const stand = new Vec3(position.x + dx, y, position.z + dz)
          if (this.bot.entity.position.distanceTo(stand.offset(0.5, 0.5, 0.5)) > 5.2) continue
          const floor = this.bot.blockAt(stand.offset(0, -1, 0))
          const body = [this.bot.blockAt(stand), this.bot.blockAt(stand.offset(0, 1, 0))]
          if (!floor || this.isPassable(floor) || this.isLiquid(floor) || oreIds.has(floor.type)) continue
          if (body.some((block) => !block || this.isLiquid(block) || oreIds.has(block.type) ||
            (!this.isPassable(block) && !block.diggable))) continue
          if (body.every((block) => this.isPassable(block))) continue
          candidates.push(stand)
        }
      }
    }
    const unique = new Map(candidates.map((stand) => [stand.toString(), stand]))
    return [...unique.values()]
      .sort((a, b) => this.bot.entity.position.distanceTo(a) - this.bot.entity.position.distanceTo(b))
      .slice(0, 4)
  }

  async enterOreStance(stand, position, signal) {
    if (!this.bot.entity.position.floored().equals(stand)) {
      const movements = this.bot.pathfinder.movements
      const previousCanDig = movements.canDig
      movements.canDig = false
      try {
        await this.gotoBounded(new goals.GoalBlock(stand.x, stand.y, stand.z), signal, 8)
      } finally {
        movements.canDig = previousCanDig
      }
    }
    const ore = this.bot.blockAt(position)
    return ore && this.canReachVisibleOre(ore) ? ore : null
  }

  async moveToOreStance(position, cavities, returnPosition, oreIds, signal) {
    for (const stand of this.oreMiningStances(position, cavities, returnPosition)) {
      if (this.bot.entity.position.floored().equals(stand)) continue
      try {
        const ore = await this.enterOreStance(stand, position, signal)
        if (ore) return ore
      } catch (error) {
        if (error.name === 'AbortError') throw error
      }
    }

    for (const stand of this.excavatableOreStances(position, oreIds, returnPosition)) {
      try {
        // Open headroom before the feet block so falling gravel cannot trap
        // the bot while it creates the side pocket.
        for (const offset of [new Vec3(0, 1, 0), new Vec3(0, 0, 0)]) {
          const block = this.bot.blockAt(stand.plus(offset))
          if (!this.isPassable(block)) await this.digTunnelBlock(block.position, signal)
        }
        if (!this.canStandAt(stand)) continue
        const ore = await this.enterOreStance(stand, position, signal)
        if (ore) {
          console.log(`Opened safe ore access pocket at ${stand} for vein block ${position}`)
          return ore
        }
      } catch (error) {
        if (error.name === 'AbortError') throw error
        console.warn(`Could not open ore access pocket at ${stand}: ${error.message}`)
      }
    }
    return null
  }

  async mineConnectedOreVein(seed, oreIds, signal, attempted, returnPosition, maxBlocks = 128) {
    const neighbors = []
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          if (dx !== 0 || dy !== 0 || dz !== 0) neighbors.push(new Vec3(dx, dy, dz))
        }
      }
    }
    const queue = [{ position: seed.position.clone(), deferrals: 0 }]
    const queued = new Set([seed.position.toString()])
    const cavities = []
    let mined = 0
    while (queue.length && mined < maxBlocks) {
      if (signal.aborted) throw abortError()
      const entry = queue.shift()
      const position = entry.position
      const key = position.toString()
      if (attempted.has(key)) continue
      let ore = this.bot.blockAt(position)
      if (!ore || !oreIds.has(ore.type)) continue

      for (const offset of neighbors) {
        const adjacentPosition = position.plus(offset)
        const adjacentKey = adjacentPosition.toString()
        if (queued.has(adjacentKey) || attempted.has(adjacentKey)) continue
        const adjacent = this.bot.blockAt(adjacentPosition)
        if (adjacent && oreIds.has(adjacent.type)) {
          queue.push({ position: adjacentPosition, deferrals: 0 })
          queued.add(adjacentKey)
        }
      }

      const feet = this.bot.entity.position.floored()
      const belowFeet = position.x === feet.x && position.z === feet.z && position.y < feet.y
      if (belowFeet || !this.canReachVisibleOre(ore)) {
        ore = await this.moveToOreStance(position, cavities, returnPosition, oreIds, signal)
      }
      if (!ore || !this.canReachVisibleOre(ore)) {
        if (entry.deferrals < 2 && queue.length > 0) {
          queue.push({ position, deferrals: entry.deferrals + 1 })
          continue
        }
        attempted.add(key)
        console.log(`Deferred exposed ${ore?.name || seed.name} at ${position}; no safe vein-mining stance`)
        continue
      }

      if (this.inventoryTracker?.freeSlots?.() < 2) await this.ensureTaskInventorySpace('mining', signal)
      await this.ensureCollectBlockSlot('collecting exposed ore')
      await this.digTunnelBlock(position, signal)
      attempted.add(key)
      cavities.push(position.clone())
      mined += 1
      console.log(`Strip mine directly mined ${ore.name} vein block ${mined} at ${position}`)
    }
    if (mined >= maxBlocks && queue.length) console.warn(`Ore vein capped at ${maxBlocks} blocks near ${seed.position}`)
    if (mined > 0) await this.collectDropsNear(seed.position, signal, null, 8, 500)
    if (this.bot.entity.position.distanceTo(returnPosition) > 1.5) {
      await this.gotoBounded(new goals.GoalNear(returnPosition.x, returnPosition.y, returnPosition.z, 1), signal, 10)
    }
    return mined
  }

  async stripMine(action, signal, onProgress) {
    const startY = this.bot.entity.position.floored().y
    const start = this.bot.entity.position.floored()
    const directionName = this.chooseStripMineDirection(action.direction, action.length)
    const effectiveAction = { ...action, direction: directionName }
    const direction = CARDINAL_DIRECTIONS[directionName]
    this.landmarks?.remember('last_mine', this.bot.entity.position, this.bot.game?.dimension, 'mine')
    this.landmarks?.remember('last_strip_mine_origin', start, this.bot.game?.dimension, 'mine_gallery', { route: [start] })
    if (RESOURCE_LEVELS[action.target] !== undefined && Math.abs(startY - RESOURCE_LEVELS[action.target]) > 12) {
      throw new Error(
        `${action.target} strip mining requires Y ${RESOURCE_LEVELS[action.target]} ±12; current Y is ${startY}`
      )
    }
    const recordProgress = (progress) => {
      const route = []
      for (let step = progress.completed; step >= 0; step -= Math.min(8, Math.max(1, step))) {
        const point = start.plus(direction.scaled(step))
        route.push({ x: point.x, y: point.y, z: point.z })
        if (step === 0) break
      }
      this.landmarks?.remember(
        'last_strip_mine_origin', start, this.bot.game?.dimension, 'mine_gallery', { route }
      )
      onProgress?.(progress)
    }
    const result = await this.runStripTunnel(effectiveAction, signal, () => false, recordProgress)
    if (result.completed === 0) throw new Error(`Could not start strip mine: ${result.reason || 'blocked'}`)
    if (result.reason || result.completed < action.length) {
      const error = new Error(
        `Strip mine incomplete after ${result.completed}/${action.length} main-tunnel blocks: ${result.reason || 'stopped early'}`
      )
      error.category = /tool|harvest/i.test(result.reason || '') ? 'missing_tool' : 'transient_world'
      throw error
    }
    return `Strip-mined ${result.completed} blocks ${directionName} with player-style branches and collected exposed ores`
  }

  isExistingTunnelCell(feet) {
    const floor = this.bot.blockAt(feet.offset(0, -1, 0))
    return Boolean(
      floor && !this.isPassable(floor) && !this.isLiquid(floor) &&
      this.isPassable(this.bot.blockAt(feet)) &&
      this.isPassable(this.bot.blockAt(feet.offset(0, 1, 0)))
    )
  }

  stripMineOverlapScore(start, direction, length) {
    const side = new Vec3(-direction.z, 0, direction.x)
    const runs = { center: 0, left: 0, right: 0 }
    let score = 0
    for (let step = 1; step <= Math.min(length, 16); step += 1) {
      const feet = start.plus(direction.scaled(step))
      const states = {
        center: this.isExistingTunnelCell(feet),
        left: this.isExistingTunnelCell(feet.plus(side)),
        right: this.isExistingTunnelCell(feet.minus(side))
      }
      for (const key of Object.keys(runs)) {
        runs[key] = states[key] ? runs[key] + 1 : 0
        // A single open cell is probably an ordinary crossing or small cave.
        // Consecutive open cells reveal a retraced or one-block-adjacent mine.
        if (runs[key] === 1) score += 1
        else if (runs[key] >= 2) score += key === 'center' ? 20 : 12
      }
    }
    return score
  }

  chooseStripMineDirection(requested, length) {
    if (typeof this.bot.blockAt !== 'function') return requested
    const start = this.bot.entity.position.floored()
    const order = [requested, ...Object.keys(CARDINAL_DIRECTIONS).filter((name) => name !== requested)]
    const scored = order.map((name) => ({
      name,
      score: this.stripMineOverlapScore(start, CARDINAL_DIRECTIONS[name], length)
    })).sort((a, b) => a.score - b.score || order.indexOf(a.name) - order.indexOf(b.name))
    const requestedScore = scored.find((entry) => entry.name === requested)?.score ?? 0
    const best = scored[0]
    if (requestedScore < 12 || best.score + 4 >= requestedScore) return requested
    console.log(`Strip mine avoiding overlap: changed ${requested} to ${best.name} (score ${requestedScore} -> ${best.score})`)
    return best.name
  }

  async runStripTunnel(action, signal, shouldStop = () => false, onProgress = null) {
    const direction = CARDINAL_DIRECTIONS[action.direction]
    const start = this.bot.entity.position.floored()
    const oreAttempts = new Set()
    let completed = 0
    let reason = null
    for (let step = 1; step <= action.length; step += 1) {
      if (signal.aborted) throw abortError()
      if (shouldStop()) break
      const feet = start.plus(direction.scaled(step))
      try {
        await this.ensureTaskInventorySpace('mining', signal)
        await this.advanceMiningStep(feet, signal)
        completed += 1
        await this.collectExposedOres(signal, oreAttempts, action.target)
        await this.placeTunnelTorch(feet.minus(direction), signal, {
          // Do not depend entirely on client light updates. They can lag behind
          // freshly excavated blocks, so guarantee regular tunnel lighting.
          force: completed % 8 === 0,
          fallbackPositions: [feet.minus(direction.scaled(2)), feet.minus(direction.scaled(3))]
        })
        if (completed % action.branchSpacing === 0) {
          await this.digSideProbes(feet, direction, action.branchDepth, signal, oreAttempts, shouldStop, action.target)
        }
        if (completed % 8 === 0 || completed === action.length) {
          onProgress?.({ completed, total: action.length, position: { x: feet.x, y: feet.y, z: feet.z } })
        }
      } catch (error) {
        if (error.name === 'AbortError') throw error
        reason = error.message
        console.warn(`Strip mine stopped after ${completed} blocks: ${reason}`)
        break
      }
    }
    return { completed, reason }
  }

  async advanceMiningStep(feet, signal, clearance = 2) {
    await this.excavateMiningStep(feet, signal, clearance)
    await this.gotoBounded(new goals.GoalBlock(feet.x, feet.y, feet.z), signal)
  }

  async excavateMiningStep(feet, signal, clearance = 2) {
    const floor = this.bot.blockAt(feet.offset(0, -1, 0))
    if (!floor) throw new Error(`unloaded floor below tunnel at ${feet}`)
    if (this.isPassable(floor) || this.isLiquid(floor)) {
      await this.repairStairFloor(feet.offset(0, -1, 0), signal)
    }
    for (let y = clearance - 1; y >= 0; y -= 1) {
      const position = feet.offset(0, y, 0)
      // Gravel and sand can repeatedly fall into the same tunnel cell. Clear a
      // bounded column just as a player would, without risking an endless dig.
      for (let falling = 0; falling < 12; falling += 1) {
        const before = this.bot.blockAt(position)
        await this.digTunnelBlock(position, signal)
        if (!before || !FALLING_BLOCKS.has(before.name)) break
        await wait(100, signal)
        const replacement = this.bot.blockAt(position)
        if (this.isPassable(replacement)) break
        if (!replacement || !FALLING_BLOCKS.has(replacement.name)) {
          throw new Error(`${replacement?.name || 'unknown block'} still blocks tunnel at ${position}`)
        }
        if (falling === 11) throw new Error(`falling-block column exceeds 12 blocks at ${position}`)
      }
    }
  }

  scaffoldItem() {
    const items = this.bot.inventory.items()
    return SCAFFOLD_PRIORITY
      .map((name) => items.find((item) => item.name === name))
      .find(Boolean) || null
  }

  async ensurePlacementScaffold(signal, preserveItem = null) {
    let scaffold = this.scaffoldItem()
    if (scaffold) return scaffold
    await this.inventoryPolicy?.freeTrashSlots?.(1)
    if ((this.inventoryTracker?.freeSlots?.() ?? 1) < 1) {
      const reserved = this.inventoryPolicy?.reservedItems?.() || new Map()
      await this.ensureTaskInventorySpace('building', signal, {
        preserveItems: new Set([preserveItem, ...reserved.keys()].filter(Boolean)),
        minimumFreeSlots: 1
      })
    }
    for (const name of SCAFFOLD_RESTOCK_PRIORITY) {
      // Building access routes routinely consume more than sixteen supports.
      // Prefer one full-stack restock so the bot does not revisit the same
      // chest several times while climbing a roof or tall schematic floor.
      await this.tryWithdrawFromNearby(name, 64, signal)
      scaffold = this.scaffoldItem()
      if (scaffold) {
        console.log(`Restocked ${scaffold.count} ${scaffold.name} for construction support`)
        return scaffold
      }
    }
    return null
  }

  async createPlacementSupport(position, signal, preserveItem = null, maxDepth = 6) {
    const created = []
    const repairWithRestock = async (candidate) => {
      try {
        return await this.repairStairFloor(candidate, signal)
      } catch (error) {
        if (error.name === 'AbortError') throw error
        if (/cannot reach staircase break/.test(error.message)) {
          await this.gotoBounded(new goals.GoalNear(candidate.x, candidate.y, candidate.z, 2), signal, 10)
          return this.repairStairFloor(candidate, signal)
        }
        if (/no dirt or stone blocks/.test(error.message)) {
          const scaffold = await this.ensurePlacementScaffold(signal, preserveItem)
          if (!scaffold) throw error
          return this.repairStairFloor(candidate, signal)
        }
        throw error
      }
    }
    const build = async (candidate, depth) => {
      const existing = this.bot.blockAt(candidate)
      if (existing && !this.isPassable(existing) && !this.isLiquid(existing)) return
      try {
        const placed = await repairWithRestock(candidate)
        if (placed) created.push(candidate.clone())
        return
      } catch (error) {
        if (error.name === 'AbortError' || !/no solid face available/.test(error.message) || depth >= maxDepth) throw error
      }
      const below = candidate.offset(0, -1, 0)
      const belowBlock = this.bot.blockAt(below)
      if (!belowBlock || this.isLiquid(belowBlock)) {
        throw new Error(`cannot support floating build block at ${position}; unsafe column below ${below}`)
      }
      await build(below, depth + 1)
      const placed = await repairWithRestock(candidate)
      if (placed) created.push(candidate.clone())
    }
    await build(position, 0)
    return created
  }

  async createPlacementStaircase(stance, signal, preserveItem = null, trackScaffold = null) {
    const start = this.bot.entity.position.floored()
    const rise = stance.y - start.y
    const dx = stance.x - start.x
    const dz = stance.z - start.z
    const steps = Math.max(Math.abs(dx), Math.abs(dz))
    // Large schematics can leave the bot at ground level after a recovery
    // while the next unfinished block is several floors up.  A six-block
    // ascent limit made otherwise safe, gently-rising scaffold stairs appear
    // unreachable and handed the deterministic build back to the LLM. Keep
    // the 1:1 maximum slope, but permit a local staircase across the full
    // placement-search radius.
    if (rise < 1 || rise > 12 || steps < rise || steps > 16) return false
    const route = [start.clone()]
    for (let index = 1; index <= steps; index += 1) {
      const feet = new Vec3(
        start.x + Math.round(dx * index / steps),
        start.y + Math.min(index, rise),
        start.z + Math.round(dz * index / steps)
      )
      const feetBlock = this.bot.blockAt(feet)
      const headBlock = this.bot.blockAt(feet.offset(0, 1, 0))
      if (!this.isPassable(feetBlock) || !this.isPassable(headBlock) ||
          this.isLiquid(feetBlock) || this.isLiquid(headBlock)) return false
      const floor = feet.offset(0, -1, 0)
      const floorBlock = this.bot.blockAt(floor)
      if (!floorBlock || this.isPassable(floorBlock)) {
        const created = await this.createPlacementSupport(floor, signal, preserveItem)
        for (const position of created) trackScaffold?.(position)
      } else if (this.isLiquid(floorBlock)) {
        return false
      }
      try {
        await this.gotoBounded(new goals.GoalBlock(feet.x, feet.y, feet.z), signal, 10)
      } catch (error) {
        if (error.name === 'AbortError') throw error
        return false
      }
      if (this.bot.entity.position.distanceTo(feet) > 0.9) return false
      route.push(feet.clone())
    }
    const reached = this.bot.entity.position.distanceTo(stance) <= 0.9
    if (reached && rise >= 3 && trackScaffold && this.landmarks) {
      this.landmarks.remember(
        'active_build_access', route[0], this.bot.game?.dimension, 'build_access',
        { route: route.map(({ x, y, z }) => ({ x, y, z })) }
      )
      console.log(`Remembered reusable build staircase with ${route.length - 1} steps`)
    }
    return reached
  }

  async createPlacementWalkway(stance, signal, preserveItem = null, trackScaffold = null) {
    const start = this.bot.entity.position.floored()
    const dx = stance.x - start.x
    const dy = stance.y - start.y
    const dz = stance.z - start.z
    const steps = Math.max(Math.abs(dx), Math.abs(dz))
    if (steps < 1 || steps > 20 || Math.abs(dy) > 2) return false
    const movements = this.bot.pathfinder?.movements
    const previousDrop = movements?.maxDropDown
    if (movements) movements.maxDropDown = 1
    try {
      for (let index = 1; index <= steps; index += 1) {
        const feet = new Vec3(
          start.x + Math.round(dx * index / steps),
          start.y + Math.round(dy * index / steps),
          start.z + Math.round(dz * index / steps)
        )
        const feetBlock = this.bot.blockAt(feet)
        const headBlock = this.bot.blockAt(feet.offset(0, 1, 0))
        if (!this.isPassable(feetBlock) || !this.isPassable(headBlock) ||
            this.isLiquid(feetBlock) || this.isLiquid(headBlock)) return false
        const floor = feet.offset(0, -1, 0)
        const floorBlock = this.bot.blockAt(floor)
        if (!floorBlock || this.isPassable(floorBlock)) {
          const created = await this.createPlacementSupport(floor, signal, preserveItem)
          for (const position of created) trackScaffold?.(position)
        } else if (this.isLiquid(floorBlock)) {
          return false
        }
        try {
          await this.gotoBounded(new goals.GoalBlock(feet.x, feet.y, feet.z), signal, 10)
        } catch (error) {
          if (error.name === 'AbortError') throw error
          return false
        }
        if (this.bot.entity.position.distanceTo(feet) > 0.9) return false
      }
      return this.bot.entity.position.distanceTo(stance) <= 0.9
    } finally {
      if (movements) movements.maxDropDown = previousDrop
    }
  }

  async createExteriorPlacementStaircase(stance, bounds, signal, preserveItem = null, trackScaffold = null) {
    if (!bounds || !Number.isFinite(bounds.baseY)) return false
    const currentY = this.bot.entity.position.floored().y
    // The cleared build pad may sit well below the surrounding natural
    // terrain. Scan a useful vertical band instead of assuming the exterior
    // has the same floor Y as the schematic anchor.
    const groundLevels = [...new Set([
      currentY, currentY - 1, currentY + 1,
      ...Array.from({ length: 14 }, (_, index) => bounds.baseY + index - 1)
    ])]
    const rise = Math.max(1, stance.y - Math.min(...groundLevels))
    const run = Math.min(12, rise + 2)
    const bases = []
    for (const offset of [run, -run, 0]) {
      bases.push(
        new Vec3(bounds.minX - 1, 0, stance.z + offset),
        new Vec3(bounds.maxX + 1, 0, stance.z + offset),
        new Vec3(stance.x + offset, 0, bounds.minZ - 1),
        new Vec3(stance.x + offset, 0, bounds.maxZ + 1)
      )
    }
    const unique = new Map()
    for (const base of bases) {
      for (const y of groundLevels) {
        const candidate = new Vec3(base.x, y, base.z)
        if (this.canStandAt(candidate)) unique.set(candidate.toString(), candidate)
      }
    }
    const approaches = [...unique.values()].sort((a, b) =>
      this.bot.entity.position.distanceTo(a) - this.bot.entity.position.distanceTo(b)
    )
    if (!approaches.length) {
      console.warn(`No standable exterior staging surface around build footprint for upper placement at ${stance}`)
      return false
    }
    let navigationFailures = 0
    for (const base of approaches.slice(0, 16)) {
      try {
        await this.gotoBounded(new goals.GoalBlock(base.x, base.y, base.z), signal, 32)
      } catch (error) {
        if (error.name === 'AbortError') throw error
        navigationFailures += 1
        continue
      }
      if (await this.createPlacementStaircase(
        stance, signal, preserveItem, trackScaffold
      )) return true
    }
    if (navigationFailures) {
      console.warn(`Could not reach ${navigationFailures}/${Math.min(16, approaches.length)} exterior staging surfaces for ${stance}`)
    }
    return false
  }

  interiorBuildStagingPositions(target, bounds, limit = 64) {
    if (!bounds) return []
    const current = this.bot.entity.position
    const candidates = []
    const minY = Math.max(bounds.baseY + 1, target.y - 5)
    const maxY = Math.min(bounds.topY + 1, target.y + 1)
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
        for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) {
          const position = new Vec3(x, y, z)
          if (position.distanceTo(target) <= 3 || !this.canStandAt(position)) continue
          candidates.push(position)
        }
      }
    }
    return candidates.sort((a, b) =>
      Math.abs(target.y - a.y) - Math.abs(target.y - b.y) ||
      current.distanceTo(a) - current.distanceTo(b) ||
      a.distanceTo(target) - b.distanceTo(target)
    ).slice(0, limit)
  }

  async repairStairFloor(position, signal) {
    const existing = this.bot.blockAt(position)
    if (existing && !this.isPassable(existing) && !this.isLiquid(existing)) return false
    const scaffold = this.scaffoldItem()
    if (!scaffold) throw new Error(`cannot repair staircase at ${position}; no dirt or stone blocks`)
    if (this.bot.entity.position.distanceTo(position) > 4.5) {
      throw new Error(`cannot reach staircase break at ${position}`)
    }
    const faces = [
      new Vec3(0, 1, 0), new Vec3(0, -1, 0), new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)
    ]
    const face = faces.find((candidate) => {
      const reference = this.bot.blockAt(position.minus(candidate))
      return reference && reference.boundingBox !== 'empty' && !this.isLiquid(reference)
    })
    if (!face) throw new Error(`no solid face available to repair staircase at ${position}`)
    if (signal.aborted) throw abortError()
    await this.bot.equip(scaffold, 'hand')
    let placementError = null
    try {
      await this.bot.placeBlock(this.bot.blockAt(position.minus(face)), face)
    } catch (error) {
      if (error.name === 'AbortError') throw error
      placementError = error
    }
    const deadline = Date.now() + (placementError ? 1500 : 400)
    let repaired = this.bot.blockAt(position)
    while ((!repaired || this.isPassable(repaired) || this.isLiquid(repaired)) && Date.now() < deadline) {
      await wait(100, signal)
      repaired = this.bot.blockAt(position)
    }
    if (placementError && repaired && !this.isPassable(repaired) && !this.isLiquid(repaired)) {
      console.log(`Confirmed delayed staircase floor repair at ${position}`)
    }
    if (placementError && (!repaired || this.isPassable(repaired) || this.isLiquid(repaired))) throw placementError
    if (!repaired || this.isPassable(repaired) || this.isLiquid(repaired)) {
      throw new Error(`staircase repair did not place at ${position}`)
    }
    console.log(`Repaired staircase floor with ${scaffold.name} at ${position}`)
    return true
  }

  async recoverFromStaircaseFall(expectedFeet, side, signal) {
    const fallen = this.bot.entity.position.floored()
    const depth = expectedFeet.y - fallen.y
    if (depth <= 0) return false
    if (depth > 16) throw new Error(`fell ${depth} blocks below the staircase; recovery depth limit is 16`)
    const scaffold = this.scaffoldItem()
    if (!scaffold) throw new Error(`fell ${depth} blocks and has no dirt or stone for recovery`)

    const movements = this.bot.pathfinder.movements
    const previousTowerSetting = movements.allow1by1towers
    const previousScaffolds = [...movements.scafoldingBlocks]
    if (!movements.scafoldingBlocks.includes(scaffold.type)) movements.scafoldingBlocks.push(scaffold.type)
    movements.allow1by1towers = true
    try {
      await this.gotoBounded(
        new goals.GoalBlock(expectedFeet.x, expectedFeet.y, expectedFeet.z),
        signal,
        Math.max(16, this.limits.localPathSearchRadius || 10)
      )
    } finally {
      movements.allow1by1towers = previousTowerSetting
      movements.scafoldingBlocks.splice(0, movements.scafoldingBlocks.length, ...previousScaffolds)
    }

    await this.repairStairFloor(expectedFeet.offset(0, -1, 0), signal)
    await this.repairStairFloor(expectedFeet.plus(side).offset(0, -1, 0), signal)
    console.log(`Recovered from a ${depth}-block staircase fall and repaired the floor`)
    return true
  }

  async returnAlongExcavatedRoute(route, signal) {
    if (!route.length) return
    const movements = this.bot.pathfinder.movements
    const previousCanDig = movements.canDig
    movements.canDig = false
    try {
      const waypoints = []
      // Four-block hops keep path searches tiny while avoiding a separate A*
      // request for every block in a straight, already excavated passage.
      for (let index = route.length - 5; index > 0; index -= 4) waypoints.push(route[index])
      waypoints.push(route[0])
      for (const point of waypoints) {
        if (signal.aborted) throw abortError()
        if (this.bot.entity.position.floored().equals(point)) continue
        await this.gotoBounded(
          new goals.GoalBlock(point.x, point.y, point.z), signal,
          Math.max(8, this.limits.localPathSearchRadius || 10)
        )
      }
    } finally {
      movements.canDig = previousCanDig
    }
  }

  async digSideProbes(mainFeet, direction, depth, signal, oreAttempts, shouldStop, target = 'general') {
    const sides = [new Vec3(-direction.z, 0, direction.x), new Vec3(direction.z, 0, -direction.x)]
    for (const side of sides) {
      let completed = 0
      let branchError = null
      const route = [mainFeet.clone()]
      try {
        for (let distance = 1; distance <= depth; distance += 1) {
          if (shouldStop()) break
          const feet = mainFeet.plus(side.scaled(distance))
          await this.advanceMiningStep(feet, signal)
          completed = distance
          route.push(feet.clone())
          await this.collectExposedOres(signal, oreAttempts, target)
          await this.placeTunnelTorch(feet.minus(side), signal, {
            force: distance % 8 === 0 || distance === depth,
            fallbackPositions: [feet.minus(side.scaled(2))]
          })
        }
      } catch (error) {
        if (error.name === 'AbortError') throw error
        branchError = error
      } finally {
        // A side branch is optional. Always return to the main gallery and let
        // the main tunnel continue when one branch meets lava or hard terrain.
        await this.returnAlongExcavatedRoute(route, signal)
      }
      if (branchError) console.warn(`Side branch stopped after ${completed}/${depth} blocks: ${branchError.message}`)
    }
  }

  resourceCount(resource) {
    return RESOURCE_ITEMS[resource].reduce((total, item) => total + this.inventoryCount(item), 0)
  }

  staircaseDirectionHazardScore(start, targetY, direction) {
    let score = 0
    const canBridgeDryGaps = Boolean(this.bot.inventory?.items?.().some((item) => SCAFFOLD_BLOCKS.has(item.name)))
    const side = new Vec3(-direction.z, 0, direction.x)
    const previewSteps = Math.min(12, Math.max(0, start.y - targetY))
    for (let step = 1; step <= previewSteps; step += 1) {
      const feet = start.plus(direction.scaled(step)).offset(0, -step, 0)
      for (const lane of [feet, feet.plus(side)]) {
        const floor = this.bot.blockAt(lane.offset(0, -1, 0))
        if (!floor) score += 50
        else if (this.isLiquid(floor)) score += 100
        else if (this.isPassable(floor)) score += canBridgeDryGaps ? 0 : 12
        for (let y = 0; y < 4; y += 1) {
          const block = this.bot.blockAt(lane.offset(0, y, 0))
          if (!block) score += 50
          else if (this.isLiquid(block)) score += 100
          else if (!this.isPassable(block) && block.diggable === false) score += 100
        }
      }
    }
    return score
  }

  chooseStraightStaircaseDirection(start, targetY, requested) {
    if (typeof this.bot.blockAt !== 'function') return requested
    const order = [requested, ...Object.keys(CARDINAL_DIRECTIONS).filter((name) => name !== requested)]
    const scored = order.map((name) => ({
      name,
      score: this.staircaseDirectionHazardScore(start, targetY, CARDINAL_DIRECTIONS[name])
    })).sort((a, b) => a.score - b.score || order.indexOf(a.name) - order.indexOf(b.name))
    const chosen = scored[0]
    if (chosen.name !== requested) {
      console.log(`Staircase preflight changed ${requested} to ${chosen.name} (hazard ${scored.find((entry) => entry.name === requested).score} -> ${chosen.score})`)
    }
    return chosen.name
  }

  async descendStaircase(targetY, directionName, signal, targetResource = null) {
    let current = this.bot.entity.position.floored()
    const entrance = current.clone()
    const route = [{ x: current.x, y: current.y, z: current.z }]
    this.landmarks?.remember('last_mine_entrance', entrance, this.bot.game?.dimension, 'mine_entrance')
    if (current.y < targetY - 12) {
      throw new Error(`current Y ${current.y} is already below the target mining level ${targetY}`)
    }
    directionName = this.chooseStraightStaircaseDirection(current, targetY, directionName)
    const direction = CARDINAL_DIRECTIONS[directionName]
    const side = new Vec3(-direction.z, 0, direction.x)
    let steps = 0
    while (current.y > targetY) {
      if (signal.aborted) throw abortError()
      const next = current.plus(direction).offset(0, -1, 0)
      try {
        await this.excavateMiningStep(next, signal, 4)
        await this.excavateMiningStep(next.plus(side), signal, 4)
        try {
          await this.gotoBounded(new goals.GoalBlock(next.x, next.y, next.z), signal)
        } catch (error) {
          if (error.name === 'AbortError') throw error
          if (this.bot.entity.position.floored().y >= next.y) throw error
          await this.recoverFromStaircaseFall(next, side, signal)
        }
        current = this.bot.entity.position.floored()
        steps += 1
        if (steps % 4 === 0 || current.y <= targetY) route.push({ x: current.x, y: current.y, z: current.z })
        if (steps % 4 === 0 || current.y <= targetY) {
          console.log(`Staircase progress: ${steps} steps, current Y ${current.y}, target Y ${targetY}`)
        }
        if (targetResource) await this.collectExposedOres(signal, new Set(), targetResource)
        await this.placeTunnelTorch(current.minus(direction), signal)
      } catch (error) {
        if (error.name === 'AbortError') throw error
        throw new Error(`straight staircase ${directionName} blocked after ${steps} steps: ${error.message}`)
      }
    }
    const reverseRoute = route.slice().reverse()
    this.landmarks?.remember('last_mine', current, this.bot.game?.dimension, 'mine', { route })
    this.landmarks?.remember('last_mine_entrance', entrance, this.bot.game?.dimension, 'mine_entrance', { route: reverseRoute })
    return { steps, directionName }
  }

  async mineResource(action, signal) {
    const targetY = RESOURCE_LEVELS[action.resource]
    const progressCount = () => this.resourceCount(action.resource) + this.goalStoredCount(action.resource)
    const before = progressCount()
    if (before >= action.quantity) return `Already have ${before} ${action.resource}`

    const staircase = await this.descendStaircase(targetY, action.direction, signal, action.resource)
    let tunneled = 0
    let directionName = staircase.directionName
    let lastReason = null
    const directionNames = ['north', 'east', 'south', 'west']
    const startDirectionIndex = directionNames.indexOf(directionName)

    while (
      progressCount() < action.quantity &&
      tunneled < this.limits.maxAutonomousTunnelLength
    ) {
      await this.ensureTaskInventorySpace('mining', signal)
      if (!this.inventoryTracker.canAccept(RESOURCE_ITEMS[action.resource])) {
        throw new Error(`inventory full; cannot carry more ${action.resource}`)
      }
      const remaining = this.limits.maxAutonomousTunnelLength - tunneled
      const segmentLength = Math.min(64, remaining)
      directionName = this.chooseStripMineDirection(directionName, segmentLength)
      const result = await this.runStripTunnel({
        ...action,
        type: 'strip_mine',
        target: action.resource,
        direction: directionName,
        length: segmentLength
      }, signal, () => progressCount() >= action.quantity)
      tunneled += result.completed
      lastReason = result.reason
      if (progressCount() >= action.quantity) break
      if (!result.reason && result.completed === segmentLength) continue

      const turnOffset = ((directionNames.indexOf(directionName) - startDirectionIndex + 1) % 4)
      if (turnOffset >= 4) break
      directionName = directionNames[(directionNames.indexOf(directionName) + 1) % 4]
      console.log(`Autonomous mine turning ${directionName} after obstacle: ${result.reason || 'blocked'}`)
      if (result.completed === 0 && directionName === action.direction) break
    }

    const finalCount = progressCount()
    if (finalCount < action.quantity) {
      return `Mined staircase ${staircase.steps} and tunnel ${tunneled} blocks; found ${finalCount}/${action.quantity} ${action.resource}. Stopped at safety limit${lastReason ? `: ${lastReason}` : ''}`
    }
    return `Reached ${finalCount} ${action.resource} after ${staircase.steps} staircase and ${tunneled} tunnel blocks`
  }

  async staircaseTo(action, signal) {
    const targetY = RESOURCE_LEVELS[action.target]
    const staircase = await this.descendStaircase(targetY, action.direction, signal)
    return `Built a 2-wide, 4-high, ${staircase.steps}-step staircase to ${action.target} level Y ${targetY}`
  }

  async staircaseToY(action, signal) {
    const staircase = await this.descendStaircase(action.y, action.direction, signal)
    return `Built a 2-wide, 4-high, ${staircase.steps}-step staircase to Y ${action.y}`
  }

  lightLevelAt(position) {
    const block = this.bot.blockAt(position)
    if (!block) return null
    return Math.max(block.light ?? 0, block.skyLight ?? 0)
  }

  async ensureTunnelTorches(signal) {
    if (this.inventoryCount('torch') > 0) return true
    const now = Date.now()
    if (now - this.lastTorchCraftAttemptAt < 5000) return false
    this.lastTorchCraftAttemptAt = now
    if (signal?.aborted) throw abortError()
    if (this.inventoryCount('coal') + this.inventoryCount('charcoal') === 0) {
      try {
        if (!await this.toolManager.makeCharcoal(signal)) return false
      } catch (error) {
        if (error.name === 'AbortError') throw error
        console.warn(`Could not prepare charcoal for tunnel torches: ${error.message}`)
        return false
      }
    }
    await this.toolManager.ensureSticks(1, signal)
    if (this.inventoryCount('stick') === 0) return false
    const crafted = await this.toolManager.craftItem('torch', 4, null)
    if (crafted) console.log(`Strip mine crafted torches; inventory now has ${this.inventoryCount('torch')}`)
    return crafted && this.inventoryCount('torch') > 0
  }

  isTunnelTorch(block) {
    return block && ['torch', 'wall_torch', 'soul_torch', 'soul_wall_torch'].includes(block.name)
  }

  nearbyTunnelTorch(position, radius = 7.5) {
    const dimension = this.bot.game?.dimension || null
    if (this.lastTunnelTorch?.dimension === dimension &&
        this.lastTunnelTorch.position.distanceTo(position) < radius) return this.lastTunnelTorch.position
    const names = ['torch', 'wall_torch', 'soul_torch', 'soul_wall_torch']
    const ids = names.map((name) => this.bot.registry?.blocksByName?.[name]?.id).filter(Number.isFinite)
    if (!ids.length || typeof this.bot.findBlocks !== 'function') return null
    return this.blockTracker.find(ids, Math.ceil(radius + 1), 24)
      .find((torchPosition) => torchPosition.distanceTo(position) < radius) || null
  }

  rememberTunnelTorch(position) {
    this.lastTunnelTorch = {
      dimension: this.bot.game?.dimension || null,
      position: position.clone()
    }
  }

  async placeTunnelTorch(position, signal, { force = false, fallbackPositions = [] } = {}) {
    const lightLevel = this.lightLevelAt(position)
    // Low-light placement is proactive; forced placement provides deterministic
    // eight-block spacing when the server has not recalculated tunnel light yet.
    if (!force && (lightLevel === null || lightLevel > 2)) return false
    if (this.nearbyTunnelTorch(position)) return false
    if (!await this.ensureTunnelTorches(signal)) return false
    const torch = this.bot.inventory.items().find((item) => item.name === 'torch')
    if (!torch) return false
    const candidates = [position, ...fallbackPositions]
    for (const candidate of candidates) {
      const target = this.bot.blockAt(candidate)
      const support = this.bot.blockAt(candidate.offset(0, -1, 0))
      if (this.isTunnelTorch(target)) {
        this.rememberTunnelTorch(candidate)
        return false
      }
      if (!this.isPassable(target) || !support || support.boundingBox === 'empty' || this.isLiquid(support)) continue
      try {
        await this.bot.equip(torch, 'hand')
        await this.bot.placeBlock(support, new Vec3(0, 1, 0))
        this.rememberTunnelTorch(candidate)
        console.log(`Placed strip-mine torch at ${candidate} (sampled light ${lightLevel}${force ? ', scheduled' : ''})`)
        return true
      } catch (error) {
        // Mineflayer can time out waiting for blockUpdate even though the
        // server accepted the placement. Confirm the world before retrying an
        // adjacent square and creating duplicate torches.
        if (this.isTunnelTorch(this.bot.blockAt(candidate))) {
          this.rememberTunnelTorch(candidate)
          console.log(`Confirmed strip-mine torch at ${candidate} after delayed placement acknowledgement`)
          return true
        }
        console.warn(`Could not place strip-mine torch at ${candidate}: ${error.message}`)
      }
    }
    console.warn(`Could not find a valid floor position for a strip-mine torch near ${position}`)
    return false
  }

  isWoodcuttingStorageItem(name) {
    return name.endsWith('_log') || name.endsWith('_wood') || name.endsWith('_planks') ||
      name.endsWith('_sapling') || FORAGING_STORAGE_ITEMS.has(name)
  }

  isPreservedForTask(name, preserveItems) {
    return [...preserveItems].some((requested) => this.itemMatchesGroup({ name }, requested))
  }

  overflowCandidates(context, preserveItems = new Set()) {
    const candidates = []
    let scaffoldToKeep = context === 'mining' ? 64 : 0
    for (const item of this.bot.inventory.items()) {
      if (this.isPreservedForTask(item.name, preserveItems)) continue
      const eligible = context === 'building'
        ? Boolean(this.bot.registry?.blocksByName?.[item.name])
        : context === 'mining'
        ? MINING_STORAGE_ITEMS.has(item.name) || MINING_RESOURCE_ITEMS.has(item.name)
        : this.isWoodcuttingStorageItem(item.name)
      if (!eligible) continue

      let quantity = item.count
      if (context === 'mining' && SCAFFOLD_BLOCKS.has(item.name) && scaffoldToKeep > 0) {
        const keeping = Math.min(quantity, scaffoldToKeep)
        scaffoldToKeep -= keeping
        quantity -= keeping
      }
      if (quantity > 0) candidates.push({ item, quantity })
    }
    return candidates
  }

  storageCategories(name) {
    const categories = new Set()
    if (MINING_STORAGE_ITEMS.has(name) && !['dirt', 'sand', 'red_sand', 'gravel', 'flint'].includes(name)) {
      categories.add('stone')
    }
    if (name.endsWith('_log') || name.endsWith('_wood') || name.endsWith('_planks') ||
        name.endsWith('_sapling') || ['stick', 'bamboo'].includes(name)) categories.add('wood')
    if (MINING_RESOURCE_ITEMS.has(name) || name.endsWith('_ore')) categories.add('ores')
    if (['diamond', 'emerald', 'gold_ingot', 'gold_nugget', 'amethyst_shard'].includes(name)) {
      categories.add('valuables')
    }
    if (['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'mud'].includes(name)) {
      categories.add('dirt')
    }
    if (name.includes('sand') || ['gravel', 'flint', 'clay'].includes(name)) categories.add('sand')
    if (FORAGING_STORAGE_ITEMS.has(name) || name.endsWith('_sapling')) categories.add('plants')
    if (this.bot.registry?.foodsByName?.[name]) categories.add('food')
    if (/_(pickaxe|axe|shovel|hoe|sword)$/.test(name)) categories.add('tools')
    return categories
  }

  itemFrameMarker(entity) {
    if (!entity || !['item_frame', 'glow_item_frame'].includes(entity.name)) return null
    const keys = this.bot.registry?.entitiesByName?.[entity.name]?.metadataKeys || []
    const index = keys.indexOf('item')
    const item = index >= 0 ? entity.metadata?.[index] : null
    if (!item) return null
    if (item.name) return item.name
    const type = item.type ?? item.itemId ?? item.item?.id
    return this.bot.registry?.items?.[type]?.name || null
  }

  markerBelongsToContainer(markerPosition, containerPosition) {
    const targetCenter = containerPosition.offset(0.5, 0.5, 0.5)
    const targetDistance = markerPosition.distanceTo(targetCenter)
    const center = markerPosition.floored()
    for (let dx = -2; dx <= 2; dx += 1) {
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dz = -2; dz <= 2; dz += 1) {
          const candidate = this.bot.blockAt(center.offset(dx, dy, dz))
          if (!candidate?.position || !CONTAINER_NAMES.has(candidate.name) ||
              candidate.position.equals(containerPosition)) continue
          const distance = markerPosition.distanceTo(candidate.position.offset(0.5, 0.5, 0.5))
          if (distance + 0.1 < targetDistance) return false
        }
      }
    }
    return true
  }

  storageMarkers(block) {
    if (!block?.position) return []
    const markers = []
    for (let dx = -2; dx <= 2; dx += 1) {
      for (let dy = -1; dy <= 2; dy += 1) {
        for (let dz = -2; dz <= 2; dz += 1) {
          const nearby = this.bot.blockAt(block.position.offset(dx, dy, dz))
          if (!nearby?.name?.includes('sign') || nearby.position.distanceTo(block.position) > 2.25 ||
              !this.markerBelongsToContainer(nearby.position.offset(0.5, 0.5, 0.5), block.position)) continue
          try {
            const sides = typeof nearby.getSignText === 'function'
              ? nearby.getSignText()
              : [nearby.signText]
            for (const side of sides || []) {
              if (side && String(side).trim()) markers.push({ type: 'sign', value: String(side) })
            }
          } catch {}
        }
      }
    }
    for (const entity of Object.values(this.bot.entities || {})) {
      if (!entity?.position || entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > 2.25 ||
          !this.markerBelongsToContainer(entity.position, block.position)) continue
      const item = this.itemFrameMarker(entity)
      if (item) markers.push({ type: 'item_frame', value: item })
    }
    return markers
  }

  markerMatchesItem(marker, itemName) {
    const normalized = String(marker.value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    if (!normalized) return 0
    if (normalized === itemName || normalized.includes(itemName) ||
        normalized.includes(itemName.replaceAll('_', ''))) return marker.type === 'item_frame' ? 500 : 450
    if (marker.type === 'item_frame') return 0
    const words = new Set(normalized.split('_'))
    for (const category of this.storageCategories(itemName)) {
      const aliases = {
        stone: ['stone', 'rock', 'blocks', 'cobble', 'deepslate'], wood: ['wood', 'logs', 'planks', 'timber'],
        ores: ['ore', 'ores', 'mining', 'minerals'], valuables: ['valuable', 'valuables', 'gems', 'treasure'],
        dirt: ['dirt', 'soil'], sand: ['sand', 'gravel'], plants: ['plant', 'plants', 'flowers', 'saplings'],
        food: ['food', 'foods'], tools: ['tool', 'tools', 'equipment']
      }[category] || [category]
      if (aliases.some((alias) => words.has(alias))) return 400
    }
    if (['dump', 'overflow', 'misc', 'mixed', 'general'].some((word) => words.has(word))) return 25
    return 0
  }

  containerAffinity(container, block, itemName, markers = null) {
    const contents = typeof container?.containerItems === 'function' ? container.containerItems() : []
    if (contents.some((item) => item.name === itemName)) return 300
    return (markers || this.storageMarkers(block)).reduce(
      (score, marker) => Math.max(score, this.markerMatchesItem(marker, itemName)), 0
    )
  }

  async createExpeditionStorage(signal) {
    if (this.inventoryCount('chest') === 0) {
      const plankCount = this.bot.inventory.items()
        .filter((item) => item.name.endsWith('_planks'))
        .reduce((total, item) => total + item.count, 0)
      if (plankCount < 8) return null
      const crafted = await this.toolManager.withCraftingTable(
        (table) => this.toolManager.craftItem('chest', 1, table), signal
      )
      if (!crafted || this.inventoryCount('chest') === 0) return null
    }
    const chest = await this.toolManager.placeInventoryBlock('chest', signal)
    if (!chest) return null
    this.landmarks?.remember(
      `expedition_chest_${chest.position.x}_${chest.position.y}_${chest.position.z}`,
      chest.position, this.bot.game?.dimension, 'container', { contents: {} }
    )
    console.log(`Inventory pressure: placed expedition chest at ${chest.position}`)
    return chest
  }

  async ensureTaskInventorySpace(context, signal, { preserveItems = new Set(), minimumFreeSlots = 2 } = {}) {
    await this.inventoryPolicy.freeTrashSlots(minimumFreeSlots)
    if (this.inventoryTracker.freeSlots() >= minimumFreeSlots) return 0

    const workPosition = this.bot.entity.position.floored()
    const candidates = this.overflowCandidates(context, preserveItems)
    if (candidates.length === 0) {
      throw new Error(`inventory full; no ${context} bulk items can be stored without losing required supplies`)
    }

    let deposited = 0
    const previousActivity = this.activity
    this.activity = `unloading ${context} materials`
    console.log(`Inventory pressure: pausing ${context} work to unload at a nearby container`)
    const unloadInto = (matchingOnly) => async (container, block = null) => {
      const before = deposited
      const currentCandidates = this.overflowCandidates(context, preserveItems)
      const markers = matchingOnly ? this.storageMarkers(block) : []
      const selected = matchingOnly
        ? currentCandidates.filter(({ item }) => this.containerAffinity(container, block, item.name, markers) >= 100)
        : currentCandidates
      for (const { item, quantity } of selected) {
        if (signal.aborted) throw abortError()
        const inventoryBefore = this.inventoryCount(item.name)
        let succeeded = false
        try {
          await container.deposit(item.type, item.metadata ?? null, quantity, item.nbt ?? null)
          succeeded = true
        } catch (error) {
          console.warn(`Container could not accept ${quantity} ${item.name}: ${error.message}`)
        }
        const observed = Math.max(0, inventoryBefore - this.inventoryCount(item.name))
        const moved = succeeded ? quantity : Math.min(quantity, observed)
        if (moved > 0) {
          deposited += moved
          this.recordGoalDeposit(item.name, moved)
          console.log(`Inventory pressure: stored ${moved} ${item.name}`)
        }
      }
      return {
        done: this.overflowCandidates(context, preserveItems).length === 0,
        progressed: deposited > before
      }
    }
    const finished = () => this.overflowCandidates(context, preserveItems).length === 0
    const tryContainers = async (operation) => {
      try {
        await this.withNearestContainer(signal, operation, this.limits.pathSearchRadius || 32, true)
      } catch (localError) {
        if (localError.name === 'AbortError') throw localError
        console.log(`No usable local container; trying remembered storage: ${localError.message}`)
        await this.withRememberedContainer(signal, operation, null, true)
      }
    }
    try {
      try {
        // First visit chests that advertise an item through a sign, item frame,
        // or existing contents. A second pass puts anything unmatched into
        // ordinary available storage instead of abandoning the job.
        await tryContainers(unloadInto(true))
      } catch (sortingError) {
        if (sortingError.name === 'AbortError') throw sortingError
        console.log(`No matching sorted storage for all items; using overflow storage: ${sortingError.message}`)
      }
      if (!finished()) {
        try {
          await tryContainers(unloadInto(false))
        } catch (overflowError) {
          if (overflowError.name === 'AbortError') throw overflowError
          if (context !== 'mining') throw overflowError
          let placedAny = false
          for (let attempt = 0; attempt < 3 && this.inventoryTracker.freeSlots() < minimumFreeSlots; attempt += 1) {
            const chest = await this.createExpeditionStorage(signal)
            if (!chest) break
            placedAny = true
            const container = await cancellable(
              this.bot.openContainer(chest), signal, () => this.bot.currentWindow?.close?.()
            )
            try {
              await unloadInto(false)(container, chest)
              this.containerTracker.record(chest, container)
              const contents = {}
              for (const item of container.containerItems()) contents[item.name] = (contents[item.name] || 0) + item.count
              this.landmarks?.remember(
                `expedition_chest_${chest.position.x}_${chest.position.y}_${chest.position.z}`,
                chest.position, this.bot.game?.dimension, 'container', { contents }
              )
            } finally {
              container.close()
            }
          }
          if (!placedAny) throw overflowError
        }
      }
    } finally {
      try {
        if (!signal.aborted && this.bot.entity.position.distanceTo(workPosition) > 2) {
          const distance = Math.ceil(this.bot.entity.position.distanceTo(workPosition))
          if (distance <= (this.limits.pathSearchRadius || 32)) {
            await this.gotoBounded(
              new goals.GoalNear(workPosition.x, workPosition.y, workPosition.z, 1), signal,
              Math.min(this.limits.pathSearchRadius || 32, Math.max(16, distance + 4))
            )
          } else {
            await this.gotoPositionSegmented(workPosition, signal, 1)
          }
          console.log(`Inventory pressure: returned to ${context} work at ${workPosition}`)
        }
      } finally {
        this.activity = previousActivity
      }
    }

    if (deposited === 0 || this.inventoryTracker.freeSlots() < minimumFreeSlots) {
      throw new Error('inventory full; nearby containers had no usable capacity')
    }
    return deposited
  }

  hasKnownNearbyStorage(radius = this.limits.maxExpeditionDistance || 2048) {
    const origin = this.bot.entity.position
    const dimension = this.bot.game?.dimension
    const tracked = this.containerTracker.summary(origin, radius).length > 0
    const persisted = this.landmarks?.list('container').some((entry) =>
      (!entry.dimension || entry.dimension === dimension) &&
      origin.distanceTo(new Vec3(entry.x, entry.y, entry.z)) <= radius
    )
    return tracked || persisted
  }

  knownStoredChoice(preferredNames) {
    const known = [
      ...this.containerTracker.summary(this.bot.entity.position, this.limits.maxExpeditionDistance || 2048),
      ...(this.landmarks?.list('container') || [])
    ]
    return preferredNames.find((requested) => known.some((entry) =>
      Object.entries(entry.contents || {}).some(([name, count]) => count > 0 && this.itemMatchesGroup({ name }, requested))
    )) || null
  }

  hasUninspectedLoadedStorage(radius = this.limits.pathSearchRadius || 32) {
    const ids = [...CONTAINER_NAMES]
      .map((name) => this.bot.registry.blocksByName[name]?.id)
      .filter(Number.isFinite)
    if (!ids.length) return false
    return this.blockTracker.find(ids, radius, 8)
      .some((position) => !this.containerTracker.known.has(position.toString()))
  }

  async tryRestockMiningSupplies(signal) {
    const needsPickaxe = !this.toolManager.bestTool('pickaxe', 1)
    const needsTorches = this.inventoryCount('torch') === 0
    const needsTable = this.inventoryCount('crafting_table') === 0
    if (!needsPickaxe && !needsTorches && !needsTable) return 0

    const workPosition = this.bot.entity.position.floored()
    const previousActivity = this.activity
    this.activity = 'checking storage for mining supplies'
    let withdrawn = 0
    const take = async (container) => {
      const before = withdrawn
      const items = container.containerItems()
      if (needsPickaxe) {
        const rank = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe']
        const pickaxe = rank.map((name) => items.find((item) => item.name === name)).find(Boolean)
        if (pickaxe) {
          await container.withdraw(pickaxe.type, pickaxe.metadata ?? null, 1, pickaxe.nbt ?? null)
          withdrawn += 1
        }
      }
      if (needsTorches) {
        const torch = container.containerItems().find((item) => item.name === 'torch')
        if (torch) {
          const count = Math.min(32, torch.count)
          await container.withdraw(torch.type, torch.metadata ?? null, count, torch.nbt ?? null)
          withdrawn += count
        }
      }
      if (needsTable) {
        const table = container.containerItems().find((item) => item.name === 'crafting_table')
        if (table) {
          await container.withdraw(table.type, table.metadata ?? null, 1, table.nbt ?? null)
          withdrawn += 1
        }
      }
      return withdrawn > before
    }
    try {
      try {
        await this.withNearestContainer(signal, take, this.limits.pathSearchRadius || 32, true)
      } catch (localError) {
        if (localError.name === 'AbortError') throw localError
        await this.withRememberedContainer(signal, take, null, true)
      }
    } catch (error) {
      if (error.name === 'AbortError') throw error
      console.log(`No mining supplies available from storage: ${error.message}`)
    } finally {
      try {
        if (!signal.aborted && this.bot.entity.position.distanceTo(workPosition) > 2) {
          await this.gotoPositionSegmented(workPosition, signal, 1)
        }
      } finally {
        this.activity = previousActivity
      }
    }
    if (withdrawn) console.log(`Restocked ${withdrawn} mining supply item(s) from storage`)
    return withdrawn
  }

  async tryWithdrawFromNearby(
    itemName, quantity, signal,
    { forceInspect = false, stayAtStorageWhenEmpty = false } = {}
  ) {
    if (quantity <= 0) return 0
    const initiallyKnown = this.knownStoredChoice([itemName])
    const inspectLocal = this.hasUninspectedLoadedStorage()
    if (!initiallyKnown && !inspectLocal && !forceInspect) return 0
    const workPosition = this.bot.entity.position.floored()
    const previousActivity = this.activity
    const movements = this.bot.pathfinder?.movements
    const previousTower = movements?.allow1by1towers
    // Storage is infrastructure, not a placement target. Inheriting a build
    // task's tower permission makes chest searches scatter scaffold columns
    // around the site. Use existing doors, stairs, and saved access routes.
    if (movements) movements.allow1by1towers = false
    this.activity = `restocking ${itemName} from storage`
    let withdrawn = 0
    const withdrawFrom = async (container) => {
      const before = withdrawn
      const candidates = container.containerItems().filter((item) => this.itemMatchesGroup(item, itemName))
      for (const item of candidates) {
        if (withdrawn >= quantity) break
        const count = Math.min(quantity - withdrawn, item.count)
        await container.withdraw(item.type, item.metadata ?? null, count, item.nbt ?? null)
        withdrawn += count
        this.recordGoalWithdrawal(item.name, count)
      }
      return { done: withdrawn >= quantity, progressed: withdrawn > before }
    }
    try {
      let walkingStorageError = null
      try {
        await this.withNearestContainer(signal, withdrawFrom, this.limits.pathSearchRadius || 32, true)
      } catch (localError) {
        if (localError.name === 'AbortError') throw localError
        walkingStorageError = localError
      }
      if (withdrawn < quantity && walkingStorageError && previousTower &&
          Date.now() - (this.lastStorageScaffoldAttemptAt || 0) >= 60000) {
        // A roof-level builder may be separated from ground storage by one or
        // two unfinished walkway gaps. First try existing stairs above; only
        // after that fails, permit the build task's tracked scaffold movement
        // for one bounded attempt. The resulting access is retained/reused.
        this.lastStorageScaffoldAttemptAt = Date.now()
        this.blockTracker?.clearUnreachable?.()
        if (movements) movements.allow1by1towers = true
        try {
          await this.withNearestContainer(signal, withdrawFrom, this.limits.pathSearchRadius || 32, true)
          console.log(`Reached storage for ${itemName} using tracked build-access repairs`)
        } catch (scaffoldError) {
          if (scaffoldError.name === 'AbortError') throw scaffoldError
        } finally {
          if (movements) movements.allow1by1towers = false
        }
      }
      const knownAfterInspection = this.knownStoredChoice([itemName])
      if (withdrawn < quantity && (initiallyKnown || knownAfterInspection)) {
        try {
          await this.withRememberedContainer(
            signal,
            withdrawFrom,
            (entry) => Object.entries(entry.contents || {}).some(([name, count]) =>
              count > 0 && this.itemMatchesGroup({ name }, itemName)
            ),
            true
          )
        } catch (rememberedError) {
          if (rememberedError.name === 'AbortError') throw rememberedError
        }
      }
    } catch (error) {
      if (error.name === 'AbortError') throw error
      console.log(`Known storage did not supply ${itemName}: ${error.message}`)
    } finally {
      try {
        if (!signal.aborted && (!stayAtStorageWhenEmpty || withdrawn > 0) &&
            this.bot.entity.position.distanceTo(workPosition) > 2) {
          try { await this.gotoPositionSegmented(workPosition, signal, 1) } catch (error) {
            if (error.name === 'AbortError') throw error
            try {
              const returned = await this.returnViaBuildAccess(workPosition, signal)
              if (!returned) console.warn(`Could not return after storage restock: ${error.message}`)
            } catch (accessError) {
              if (accessError.name === 'AbortError') throw accessError
              console.warn(
                `Could not return after storage restock directly (${error.message}) or via saved build stairs (${accessError.message})`
              )
            }
          }
        }
      } finally {
        this.activity = previousActivity
        if (movements) movements.allow1by1towers = previousTower
      }
    }
    if (withdrawn) console.log(`Restocked ${withdrawn} ${itemName} from nearby storage`)
    return withdrawn
  }

  async returnViaBuildAccess(workPosition, signal) {
    const access = this.landmarks?.get('active_build_access')
    const dimension = this.bot.game?.dimension
    if (!access || access.type !== 'build_access' || !Array.isArray(access.route) || access.route.length < 2) return false
    if (access.dimension && dimension && access.dimension !== dimension) return false
    const route = access.route
      .filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y) && Number.isFinite(point?.z))
      .map((point) => new Vec3(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z)))
    if (route.length < 2) return false
    const forwardDistance = route.at(-1).distanceTo(workPosition)
    const reverseDistance = route[0].distanceTo(workPosition)
    if (Math.min(forwardDistance, reverseDistance) > 24) return false
    if (reverseDistance < forwardDistance) route.reverse()
    await this.gotoPositionSegmented(route[0], signal, 1)
    const movements = this.bot.pathfinder?.movements
    const previousDrop = movements?.maxDropDown
    if (movements) movements.maxDropDown = 1
    try {
      for (const point of route.slice(1)) {
        if (signal.aborted) throw abortError()
        await this.gotoBounded(new goals.GoalBlock(point.x, point.y, point.z), signal, 8)
      }
      await this.gotoPositionSegmented(workPosition, signal, 1)
    } finally {
      if (movements) movements.maxDropDown = previousDrop
    }
    console.log(`Returned from storage via saved ${route.length - 1}-step build staircase`)
    return true
  }

  async waitForBuildSupply(itemName, signal, waitMs = 60000) {
    const previousActivity = this.activity
    const waitingPosition = this.bot.entity?.position?.floored?.() || null
    this.activity = `waiting for ${itemName} in nearby storage`
    try {
      const hasSupply = () => itemName === 'build_scaffold'
        ? Boolean(this.scaffoldItem())
        : this.inventoryCount(itemName) > 0
      if (hasSupply()) return true
      const persistent = waitMs == null
      const deadline = persistent ? Infinity : Date.now() + waitMs
      while (persistent || Date.now() < deadline) {
        if (signal.aborted) throw abortError()
        try {
          if (itemName === 'build_scaffold') await this.ensurePlacementScaffold(signal)
          // A single-item withdrawal creates a pathological loop for repeated
          // wall/roof materials: resume, place once, return to the chest, and
          // re-audit the entire blueprint. Pull a normal stack when available.
          else await this.tryWithdrawFromNearby(itemName, 64, signal, {
            forceInspect: persistent,
            stayAtStorageWhenEmpty: persistent
          })
        } catch (error) {
          if (error.name === 'AbortError') throw error
          console.warn(`Could not check storage for supplied ${itemName}: ${error.message}`)
        }
        if (hasSupply()) {
          if (persistent && waitingPosition && this.bot.entity.position.distanceTo(waitingPosition) > 2) {
            try {
              await this.gotoPositionSegmented(waitingPosition, signal, 1)
            } catch (error) {
              if (error.name === 'AbortError') throw error
              try { await this.returnViaBuildAccess(waitingPosition, signal) } catch {}
            }
          }
          return true
        }
        const pollDelay = persistent
          ? 15000
          : Math.min(3000, Math.max(1, deadline - Date.now()))
        if (!persistent) {
          await wait(pollDelay, signal)
          continue
        }
        await new Promise((resolve, reject) => {
          let settled = false
          const finish = () => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            signal.removeEventListener('abort', abort)
            if (this.buildSupplyWake === finish) this.buildSupplyWake = null
            resolve()
          }
          const abort = () => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (this.buildSupplyWake === finish) this.buildSupplyWake = null
            reject(abortError())
          }
          const timer = setTimeout(finish, pollDelay)
          this.buildSupplyWake = finish
          signal.addEventListener('abort', abort, { once: true })
        })
      }
      return hasSupply()
    } finally {
      this.activity = previousActivity
    }
  }

  notifyBuildSupplyChanged() {
    this.buildSupplyWake?.()
  }

  async pickup(action, signal) {
    await this.ensureCollectBlockSlot(`picking up ${action.item}`)
    if (!this.inventoryTracker.canAccept([action.item])) {
      throw new Error(`inventory full; no configured trash could be discarded before picking up ${action.item}`)
    }
    const candidates = this.entityTracker.droppedItems(action.item, Math.min(32, this.limits.maxMoveDistance || 32))

    const targets = []
    let expectedCount = 0
    for (const candidate of candidates) {
      targets.push(candidate.entity)
      expectedCount += candidate.item.count
      if (expectedCount >= action.quantity) break
    }
    if (targets.length === 0) throw new Error(`No nearby dropped ${action.item} items were found`)

    const before = this.inventoryCount(action.item)
    await this.collectDroppedEntities(targets, signal)
    const pickedUp = this.inventoryCount(action.item) - before
    if (pickedUp <= 0) throw new Error(`Could not safely reach dropped ${action.item}`)
    if (pickedUp < action.quantity) {
      const error = new Error(`Picked up ${pickedUp}/${action.quantity} ${action.item}; no more reachable drops remained`)
      error.category = 'missing_resource'
      throw error
    }
    return `Picked up ${pickedUp} ${action.item}`
  }

  async collectDroppedEntities(entities, signal) {
    let reached = 0
    for (const original of entities) {
      if (signal.aborted) throw abortError()
      let entity = this.bot.entities[original.id]
      if (!entity?.position) continue
      try {
        const deadline = Date.now() + 2500
        for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt += 1) {
          entity = this.bot.entities[original.id]
          if (!entity?.position) break
          const horizontalDistance = Math.hypot(
            this.bot.entity.position.x - entity.position.x,
            this.bot.entity.position.z - entity.position.z
          )
          if (horizontalDistance <= 1.5 && entity.position.y > this.bot.entity.position.y + 1.2) {
            // Drops from a ceiling vein are initially reported at the broken
            // block. Stand underneath and let gravity bring them into pickup
            // range instead of asking pathfinder to stand in mid-air.
            const settleUntil = Math.min(deadline, Date.now() + 700)
            while (this.bot.entities[original.id]?.position &&
                   this.bot.entities[original.id].position.y > this.bot.entity.position.y + 1.2 &&
                   Date.now() < settleUntil) await wait(100, signal)
            entity = this.bot.entities[original.id]
            if (!entity?.position) break
          }
          if (this.bot.entity.position.distanceTo(entity.position) > 1.2) {
            try {
              await this.gotoBounded(new goals.GoalNear(
                Math.floor(entity.position.x), Math.floor(entity.position.y), Math.floor(entity.position.z), 1
              ), signal, 16)
            } catch (error) {
              if (error.name === 'AbortError') throw error
              if (attempt >= 2) throw error
              await wait(200, signal)
              continue
            }
          }
          const waitUntil = Math.min(deadline, Date.now() + 500)
          while (this.bot.entities[original.id]?.position && Date.now() < waitUntil) await wait(100, signal)
        }
        if (!this.bot.entities[original.id]?.position) reached += 1
        else console.warn(`Reached dropped item ${original.id}, but it was not picked up after three approaches`)
      } catch (error) {
        if (error.name === 'AbortError') throw error
        console.warn(`Skipped unreachable dropped item ${entity.id}: ${error.message}`)
      }
    }
    return reached
  }

  async collectDropsNear(position, signal, names = null, radius = 5, settleMs = 700) {
    if (!this.entityTracker?.droppedItems) return 0
    const allowed = names ? new Set(names) : null
    const deadline = Date.now() + settleMs
    const attempted = new Set()
    let collected = 0
    do {
      const drops = this.entityTracker.droppedItems(null, Math.max(radius + 2, 8))
        .filter(({ entity, item }) => entity?.position && entity.position.distanceTo(position) <= radius &&
          (!allowed || allowed.has(item.name)))
        .map(({ entity }) => entity)
        .filter((entity) => !attempted.has(entity.id))
      if (drops.length) {
        drops.forEach((entity) => attempted.add(entity.id))
        collected += await this.collectDroppedEntities(drops, signal)
      }
      if (Date.now() >= deadline) break
      await wait(100, signal)
    } while (true)
    return collected
  }

  async craft(action, signal) {
    const itemType = this.bot.registry.itemsByName[action.item]
    if (!itemType) throw new Error(`Unknown item: ${action.item}`)
    const available = this.inventoryCount(action.item)
    if (available >= action.quantity) return `Already have ${available}/${action.quantity} ${action.item}`
    const missing = action.quantity - available
    const inventoryRecipes = this.bot.recipesFor(itemType.id, null, missing, null)
    if (inventoryRecipes.length > 0) {
      const recipe = inventoryRecipes[0]
      const crafts = Math.ceil(missing / Math.max(1, recipe.result.count))
      await this.bot.craft(recipe, crafts, null)
      return `Crafted ${missing} needed ${action.item}; inventory target is ${action.quantity}`
    }

    const crafted = await this.toolManager.withCraftingTable(
      (table) => this.toolManager.craftItem(action.item, missing, table),
      signal
    )
    if (!crafted) throw new Error(`No available recipe or usable crafting table for ${missing} ${action.item}`)
    return `Crafted ${missing} needed ${action.item}; inventory target is ${action.quantity}`
  }

  async place(action, signal) {
    const target = new Vec3(Math.floor(action.x), Math.floor(action.y), Math.floor(action.z))
    const gotoPlacement = async (goal, radius) => {
      const movements = this.bot.pathfinder?.movements
      const previousTower = movements?.allow1by1towers
      const previousDrop = movements?.maxDropDown
      const previousStepExclusions = movements ? [...movements.exclusionAreasStep] : null
      // Once an upper-floor target has been reached, do not let A* choose a
      // superficially cheap route that walks or drops all the way back to the
      // build pad. Small two-block variations remain available for stairs and
      // split-level interiors; larger gaps use the tracked walkway fallback.
      const currentFeetY = this.bot.entity.position.floored().y
      const minimumFeetY = action.buildBounds && target.y >= action.buildBounds.baseY + 4 &&
        currentFeetY >= target.y - 2
        ? Math.min(currentFeetY - 2, target.y - 3)
        : null
      if (movements) {
        movements.allow1by1towers = false
        if (minimumFeetY != null) {
          movements.maxDropDown = 1
          movements.exclusionAreasStep = [
            ...previousStepExclusions,
            (block) => block?.position?.y + 1 < minimumFeetY ? 100 : 0
          ]
        }
      }
      try {
        try {
          return await this.gotoBounded(goal, signal, radius)
        } catch (error) {
          if (error.name === 'AbortError' || !action.trackTemporaryScaffold) throw error
          console.warn(`Walking-only placement approach failed; trying tracked scaffolding: ${error.message}`)
          if (movements) movements.allow1by1towers = previousTower
          return await this.gotoBounded(goal, signal, radius)
        }
      } finally {
        if (movements) {
          movements.allow1by1towers = previousTower
          movements.maxDropDown = previousDrop
          movements.exclusionAreasStep = previousStepExclusions
        }
      }
    }
    this.assertNearby(target)
    const targetBlock = this.bot.blockAt(target)
    if (!targetBlock || (targetBlock.name !== 'air' && targetBlock.boundingBox !== 'empty')) {
      throw new Error(`Placement target ${target} is not empty`)
    }
    const item = this.bot.inventory.items().find((entry) => entry.name === action.block)
    if (!item) throw new Error(`No ${action.block} in inventory`)
    const facingVectors = {
      north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1),
      east: new Vec3(1, 0, 0), west: new Vec3(-1, 0, 0)
    }
    const expectedBlock = action.expectedBlock || action.block
    const desiredFacing = facingVectors[action.properties?.facing]
    const facesWithPlayer = /(?:_stairs|_door|_bed)$/.test(expectedBlock) && !expectedBlock.endsWith('_trapdoor') ||
      ['campfire', 'soul_campfire', 'decorated_pot'].includes(expectedBlock)
    const facesAwayFromPlayer = /(?:_trapdoor|_chest|_furnace|_barrel|_beehive|_bookshelf|_shelf|_loom)$/.test(expectedBlock)
    const orientationByYaw = facesWithPlayer || facesAwayFromPlayer
    const yawDirection = desiredFacing && orientationByYaw
      ? (facesAwayFromPlayer ? desiredFacing.scaled(-1) : desiredFacing)
      : null
    if (desiredFacing) {
      // Stairs, doors, beds, and campfires follow the player's look direction;
      // containers and top-placed trapdoors face back toward the player.
      const stanceDirection = yawDirection ? yawDirection.scaled(-1) : desiredFacing
      const stances = [2, 3, 1].flatMap((distance) => [
        target.plus(stanceDirection.scaled(distance)),
        target.plus(stanceDirection.scaled(distance)).offset(0, 1, 0)
      ])
      const stance = stances.find((candidate) => this.canStandAt(candidate))
      let reachedStance = Boolean(stance && this.bot.entity.position.distanceTo(stance) <= 0.75)
      if (stance && this.bot.entity.position.distanceTo(stance) > 0.75) {
        try {
          await gotoPlacement(new goals.GoalBlock(stance.x, stance.y, stance.z), 10)
          reachedStance = this.bot.entity.position.distanceTo(stance) <= 0.75
        } catch (error) {
          if (error.name === 'AbortError') throw error
          // A geometrically valid stance can be sealed off by the partial
          // structure. The final cardinal yaw lock is enough when the block is
          // already within reach from the bot's current position.
          console.warn(`Canonical ${action.block} stance is unreachable; using current reachable position`)
        }
      }
      if (reachedStance) {
        await this.bot.lookAt(target.offset(0.5, 0.5, 0.5), !orientationByYaw)
      } else if (orientationByYaw) {
        // Facing is based on yaw, not on which side of the block the player
        // occupies. Dense builds often have no free canonical stance, so aim
        // along the required cardinal direction from the current position.
        const eye = this.bot.entity.position.offset(0, 1.62, 0)
        await this.bot.lookAt(eye.plus(yawDirection.scaled(4)), true)
      }
    }
    const horizontalFaces = [
      new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)
    ]
    // Prefer a floor, then a side that can be clicked from a normal standing
    // position. An overhead reference is valid protocol-wise but is often
    // rejected when the bot is beneath/inside the destination cell.
    let faces = [new Vec3(0, 1, 0), ...horizontalFaces, new Vec3(0, -1, 0)]
    const wallMounted = expectedBlock.startsWith('wall_') || expectedBlock.includes('_wall_')
    if (wallMounted && desiredFacing) faces = [desiredFacing, ...faces.filter((face) => !face.equals(desiredFacing))]
    const needsUpperHalfClick = action.properties?.half === 'top' || action.properties?.type === 'top'
    if (needsUpperHalfClick) {
      // A top stair/slab cannot be produced by clicking the top of the block
      // below: Minecraft always interprets that as a bottom-half placement.
      // Click the upper half of a side instead, or the underside of a block
      // above. Keeping the floor face out of this list also makes scaffold
      // recovery create a useful side support rather than retrying the same
      // impossible placement.
      faces = [...horizontalFaces, new Vec3(0, -1, 0)]
    }
    if (expectedBlock.endsWith('_trapdoor') && desiredFacing) {
      // A trapdoor placed against a side derives its facing from the clicked
      // face, not merely player yaw. Falling back to any available neighbor
      // repeatedly produced the neighbor's direction and could never satisfy
      // the schematic. Create support on the exact requested side if needed.
      faces = [desiredFacing]
    }
    if (['lantern', 'soul_lantern'].includes(expectedBlock) && action.properties?.hanging != null) {
      faces = String(action.properties.hanging) === 'true'
        ? [new Vec3(0, -1, 0)]
        : [new Vec3(0, 1, 0)]
    }
    // Logs and pillars derive their axis exclusively from the clicked face.
    // Falling back to another face silently creates a permanently wrong state.
    if (action.properties?.axis === 'x') faces = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0)]
    if (action.properties?.axis === 'y') faces = [new Vec3(0, 1, 0), new Vec3(0, -1, 0)]
    if (action.properties?.axis === 'z') faces = [new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
    let face = faces.find((candidate) => {
      const reference = this.bot.blockAt(target.minus(candidate))
      return reference && reference.boundingBox !== 'empty'
    })
    if (!face) {
      const scaffold = await this.ensurePlacementScaffold(signal, action.block)
      if (!scaffold) {
        throw new Error(`No solid neighboring block at ${target}, and no dirt or stone scaffold was available in inventory or nearby storage`)
      }
      if (this.bot.entity.position.distanceTo(target) > 4) {
        await gotoPlacement(new goals.GoalNear(target.x, target.y, target.z, 3), 16)
      }
      const supportPositions = [
        ...(desiredFacing && faces.some((face) => face.equals(desiredFacing))
          ? [target.minus(desiredFacing)]
          : []),
        ...faces.map((candidate) => target.minus(candidate)),
        // Ordinary blocks are most cheaply supported from the floor. Upper-
        // half stairs/slabs deliberately exclude it because it cannot create
        // the requested state.
        ...(needsUpperHalfClick ? [] : [target.offset(0, -1, 0)])
      ]
      const attempted = new Set()
      let supportFailure = null
      for (const supportPosition of supportPositions) {
        if (attempted.has(supportPosition.toString())) continue
        attempted.add(supportPosition.toString())
        const current = this.bot.blockAt(supportPosition)
        if (!current || !this.isPassable(current) || this.isLiquid(current)) continue
        try {
          const created = await this.createPlacementSupport(supportPosition, signal, action.block)
          if (!created.length) continue
          for (const scaffoldPosition of created) action.trackTemporaryScaffold?.(scaffoldPosition)
          face = faces.find((candidate) => {
            const reference = this.bot.blockAt(target.minus(candidate))
            return reference && reference.boundingBox !== 'empty'
          })
          if (face) break
        } catch (error) {
          if (error.name === 'AbortError') throw error
          supportFailure = error
        }
      }
      if (!face && supportFailure) {
        throw new Error(`No solid neighboring block at ${target}; scaffold placement failed: ${supportFailure.message}`)
      }
    }
    if (!face) throw new Error(`No solid neighboring block to place against at ${target}; no scaffold support was possible`)
    const placementInReach = () => {
      const eye = this.bot.entity.position.offset(0, 1.62, 0)
      const clickPoint = target.offset(0.5, 0.5, 0.5)
      const reference = this.bot.blockAt(target.minus(face))
      return eye.distanceTo(clickPoint) <= 4.5 && reference &&
        (typeof this.bot.canSeeBlock !== 'function' || this.bot.canSeeBlock(reference))
    }
    if (!placementInReach()) {
      const reachGoal = this.bot.world?.getBlock && goals.GoalPlaceBlock
        ? new goals.GoalPlaceBlock(target, this.bot.world, { range: 4.5, faces: [face.scaled(-1)] })
        : new goals.GoalNear(target.x, target.y, target.z, 2)
      try {
        await gotoPlacement(reachGoal, 16)
      } catch (error) {
        if (error.name === 'AbortError') throw error
        console.warn(`Placement-aware approach failed for ${action.block} at ${target}: ${error.message}`)
      }
    }
    if (!placementInReach()) {
      const currentPosition = this.bot.entity.position
      const exactStances = []
      const scaffoldableStances = []
      for (const y of [target.y, target.y - 1, target.y + 1, target.y - 2]) {
        for (let radius = 1; radius <= 3; radius += 1) {
          for (let dx = -radius; dx <= radius; dx += 1) {
            for (let dz = -radius; dz <= radius; dz += 1) {
              if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue
              const stance = new Vec3(target.x + dx, y, target.z + dz)
              const eye = stance.offset(0.5, 1.62, 0.5)
              if (eye.distanceTo(target.offset(0.5, 0.5, 0.5)) > 4.5) continue
              const feetBlock = this.bot.blockAt(stance)
              const headBlock = this.bot.blockAt(stance.offset(0, 1, 0))
              if (this.isPassable(feetBlock) && this.isPassable(headBlock) &&
                  !this.isLiquid(feetBlock) && !this.isLiquid(headBlock)) {
                scaffoldableStances.push(stance)
                if (this.canStandAt(stance)) exactStances.push(stance)
              }
            }
          }
        }
      }
      exactStances.sort((a, b) => currentPosition.distanceTo(a) - currentPosition.distanceTo(b))
      let stanceFailure = null
      const exactCandidates = exactStances.slice(0, 16)
      if (exactCandidates.length) {
        try {
          await gotoPlacement(new goals.GoalCompositeAny(
            exactCandidates.map((stance) => new goals.GoalBlock(stance.x, stance.y, stance.z))
          ), 16)
        } catch (error) {
          if (error.name === 'AbortError') throw error
          stanceFailure = error
        }
      }
      // A plugin/server can occasionally resolve a composite goal without the
      // bot actually satisfying any member. Only in that false-completion case
      // fall back to individual stances; genuine no-path results stay bounded
      // to the single composite search.
      if (!placementInReach() && !stanceFailure) {
        for (const stance of exactCandidates) {
          try {
            await gotoPlacement(new goals.GoalBlock(stance.x, stance.y, stance.z), 16)
            if (placementInReach()) break
          } catch (error) {
            if (error.name === 'AbortError') throw error
            stanceFailure = error
            break
          }
        }
      }
      if (!placementInReach() && stanceFailure) {
        console.warn(`Exact placement stances failed for ${action.block} at ${target}: ${stanceFailure.message}`)
      }
      let reachedInteriorStaging = false
      const elevatedBuildPlacement = action.buildBounds && target.y >= action.buildBounds.baseY + 3
      if (!placementInReach() && elevatedBuildPlacement) {
        // A completed staircase may terminate on an upper landing elsewhere
        // in a large house. Search all standable upper-floor cells in one A*
        // request, then retry the short target approach from that landing.
        const staging = this.interiorBuildStagingPositions(target, action.buildBounds)
        if (staging.length) {
          try {
            await gotoPlacement(new goals.GoalCompositeAny(
              staging.map((position) => new goals.GoalBlock(position.x, position.y, position.z))
            ), 32)
            reachedInteriorStaging = true
            console.log(`Reached interior upper-floor staging at ${this.bot.entity.position.floored()} for ${target}`)
            const fromLanding = [...exactStances].sort((a, b) =>
              this.bot.entity.position.distanceTo(a) - this.bot.entity.position.distanceTo(b)
            ).slice(0, 16)
            if (fromLanding.length) {
              try {
                await gotoPlacement(new goals.GoalCompositeAny(
                  fromLanding.map((stance) => new goals.GoalBlock(stance.x, stance.y, stance.z))
                ), 16)
              } catch (error) {
                if (error.name === 'AbortError') throw error
              }
            }
            if (!placementInReach()) {
              const fromUpperLanding = [...scaffoldableStances].sort((a, b) =>
                this.bot.entity.position.distanceTo(a) - this.bot.entity.position.distanceTo(b)
              )
              for (const stance of fromUpperLanding.slice(0, 24)) {
                const crossed = await this.createPlacementWalkway(
                  stance, signal, action.block, action.trackTemporaryScaffold
                )
                if (crossed && placementInReach()) break
              }
            }
          } catch (error) {
            if (error.name === 'AbortError') throw error
            console.warn(`No completed interior route reached an upper landing for ${target}: ${error.message}`)
          }
        }
      }
      if (!placementInReach()) {
        scaffoldableStances.sort((a, b) => currentPosition.distanceTo(a) - currentPosition.distanceTo(b))
        for (const stance of scaffoldableStances.slice(0, 24)) {
          const climbed = await this.createPlacementStaircase(
            stance, signal, action.block, action.trackTemporaryScaffold
          )
          if (climbed && placementInReach()) break
        }
      }
      if (!placementInReach() && elevatedBuildPlacement && !reachedInteriorStaging) {
        // If the bot was returned to ground level inside a partially enclosed
        // structure, straight ramps often collide with walls or roof pieces.
        // Walk outside the footprint and approach the upper floor on a tracked
        // scaffold ramp, like a player building from exterior staging.
        for (const stance of scaffoldableStances.slice(0, 24)) {
          const climbed = await this.createExteriorPlacementStaircase(
            stance, action.buildBounds, signal, action.block, action.trackTemporaryScaffold
          )
          if (climbed && placementInReach()) break
        }
      }
    }
    if (!placementInReach()) {
      throw new Error(
        `no player-reachable placement stance for ${action.block} at ${target}; ` +
        `feet=${this.bot.entity.position.floored()}`
      )
    }
    // Support placement and final approach navigation may move the bot into the
    // destination after the initial target check. Step clear at the last moment.
    const botFeet = this.bot.entity.position.floored()
    if (botFeet.equals(target) || botFeet.offset(0, 1, 0).equals(target)) {
      const directions = Object.values(facingVectors)
      const stanceLevels = [...new Set([botFeet.y, target.y, target.y + 1])]
      const escapeStances = [2, 1, 3].flatMap((distance) => directions.flatMap((direction) =>
        stanceLevels.map((y) => new Vec3(
          target.x + direction.x * distance, y, target.z + direction.z * distance
        ))
      )).filter((candidate) => this.canStandAt(candidate))
      let escaped = false
      let escapeFailure = null
      for (const escape of escapeStances) {
        try {
          // This branch means the bot is physically inside the destination,
          // often one block down in a build-site gap. Use the normal movements
          // here so pathfinder may tower out with a tracked scaffold. The
          // ordinary final approach still disables tower construction.
          await this.gotoBounded(new goals.GoalBlock(escape.x, escape.y, escape.z), signal, 10)
          const movedFeet = this.bot.entity.position.floored()
          if (!movedFeet.equals(target) && !movedFeet.offset(0, 1, 0).equals(target)) {
            escaped = true
            break
          }
        } catch (error) {
          if (error.name === 'AbortError') throw error
          escapeFailure = error
        }
      }
      if (!escaped) {
        throw new Error(
          `could not move body clear of placement target ${target}` +
          (escapeFailure ? `: ${escapeFailure.message}` : '')
        )
      }
      if (desiredFacing) await this.bot.lookAt(target.offset(0.5, 0.5, 0.5), !orientationByYaw)
    }
    // Stop every placement approach—not only yaw-sensitive ones—and wait for
    // its last movement/build packet before inspecting the destination. A late
    // pathfinder tower packet can otherwise replace the intended schematic
    // block with its scaffold after placement begins.
    this.bot.pathfinder?.setGoal?.(null)
    this.bot.clearControlStates?.()
    await wait(100, signal)
    const finalTarget = this.bot.blockAt(target)
    if (!finalTarget || (finalTarget.name !== 'air' && finalTarget.boundingBox !== 'empty')) {
      if (finalTarget?.diggable && SCAFFOLD_BLOCKS.has(finalTarget.name)) {
        await this.clearBuildObstruction(target, signal, true)
        action.untrackTemporaryScaffold?.(target)
      } else {
        throw new Error(`placement target changed to ${finalTarget?.name || 'unloaded'} at ${target}`)
      }
    }
    // Creating support equips the scaffold block, so the intended item must be
    // equipped only after all support work and movement have finished.
    // Pathfinder movement also changes yaw, so directional blocks must lock
    // their cardinal aim here, immediately before the placement packet.
    if (yawDirection) {
      // In this Mineflayer version force-look updates the desired yaw, while
      // the actual player-look packet is emitted on the next physics tick.
      const eye = this.bot.entity.position.offset(0, 1.62, 0)
      await this.bot.lookAt(eye.plus(yawDirection.scaled(4)), true)
      await wait(75, signal)
    }
    // `item` was resolved before pathfinding. Long approaches, scaffold work,
    // delayed server inventory updates, or an automatic restock can consume or
    // replace that stack object. Resolve it again at the actual placement
    // boundary instead of asking Mineflayer to equip a stale empty stack.
    const placementItem = this.bot.inventory.items().find((entry) => entry.name === action.block)
    if (!placementItem || placementItem.count <= 0) {
      const error = new Error(
        `missing build supply ${action.block}; the carried stack was depleted while approaching ${target}`
      )
      error.category = 'missing_resource'
      throw error
    }
    await this.bot.equip(placementItem, 'hand')
    const placementOptions = {
      swingArm: 'right', forceLook: orientationByYaw ? 'ignore' : true,
      ...(['top', 'bottom'].includes(action.properties?.half) ? { half: action.properties.half } : {}),
      ...(['top', 'bottom'].includes(action.properties?.type) ? { half: action.properties.type } : {})
    }
    const attemptPlacement = async () => {
      if (typeof this.bot._placeBlockWithOptions === 'function') {
        await this.bot._placeBlockWithOptions(this.bot.blockAt(target.minus(face)), face, placementOptions)
      } else {
        await this.bot.placeBlock(this.bot.blockAt(target.minus(face)), face)
      }
    }
    let placementError = null
    try {
      await attemptPlacement()
    } catch (error) {
      if (error.name === 'AbortError') throw error
      placementError = error
    }
    // Some servers apply the placement but acknowledge blockUpdate after
    // Mineflayer's internal five-second wait expires. Trust the observed world
    // state for a short grace period instead of aborting a large build.
    const confirmationDeadline = Date.now() + (placementError ? 1500 : 400)
    let placed = this.bot.blockAt(target)
    while (placed?.name !== expectedBlock && Date.now() < confirmationDeadline) {
      await wait(100, signal)
      placed = this.bot.blockAt(target)
    }
    if (placementError && this.isPassable(placed)) {
      // A busy server can drop an otherwise valid placement altogether, not
      // merely its acknowledgement. Retry once only after the grace period has
      // proved the destination is still empty, preventing accidental doubles.
      const retryItem = this.bot.inventory.items().find((entry) => entry.name === action.block)
      const retryReference = this.bot.blockAt(target.minus(face))
      if (retryItem && retryReference && retryReference.boundingBox !== 'empty') {
        await wait(200, signal)
        await this.bot.equip(retryItem, 'hand')
        try {
          await attemptPlacement()
          placementError = null
        } catch (error) {
          if (error.name === 'AbortError') throw error
          placementError = error
        }
        const retryDeadline = Date.now() + (placementError ? 1500 : 400)
        placed = this.bot.blockAt(target)
        while (placed?.name !== expectedBlock && Date.now() < retryDeadline) {
          await wait(100, signal)
          placed = this.bot.blockAt(target)
        }
        if (placed?.name === expectedBlock) console.log(`Schematic placement retry succeeded at ${target}`)
      }
    }
    if (placementError && placed?.name === expectedBlock) {
      console.log(`Confirmed delayed schematic placement at ${target}`)
    } else if (placementError) {
      const reference = this.bot.blockAt(target.minus(face))
      const feet = this.bot.entity.position.floored()
      const remaining = this.bot.inventory.items()
        .filter((entry) => entry.name === action.block)
        .reduce((total, entry) => total + entry.count, 0)
      throw new Error(
        `${placementError.message}; placement context item=${action.block} remaining=${remaining}, ` +
        `face=${face}, reference=${reference?.name || 'unloaded'} at ${target.minus(face)}, ` +
        `feet=${feet}, target=${placed?.name || 'unloaded'}`
      )
    }
    placed = await this.configurePlacedBlockState(action, target, placed, signal)
    const actual = placed?.getProperties?.() || {}
    const mismatches = []
    if (placed?.name !== expectedBlock) mismatches.push(`block=${placed?.name || 'unloaded'} instead of ${expectedBlock}`)
    const strictProperties = new Set(['facing', 'axis', 'half'])
    if (expectedBlock.endsWith('_bed')) strictProperties.add('part')
    if (expectedBlock.endsWith('_slab')) strictProperties.add('type')
    if (/(?:_door|_trapdoor|_fence_gate)$/.test(expectedBlock)) strictProperties.add('open')
    if (['lantern', 'soul_lantern'].includes(expectedBlock)) strictProperties.add('hanging')
    if (expectedBlock.endsWith('_candle')) strictProperties.add('candles')
    if (expectedBlock === 'sea_pickle') strictProperties.add('pickles')
    if (expectedBlock === 'turtle_egg') strictProperties.add('eggs')
    if (['pink_petals', 'wildflowers'].includes(expectedBlock)) strictProperties.add('flower_amount')
    for (const [name, expected] of Object.entries(action.properties || {})) {
      if (String(actual[name]) !== String(expected)) {
        console.warn(`Placed ${action.block} at ${target} with ${name}=${actual[name]} instead of requested ${expected}`)
        if (action.verifyState && strictProperties.has(name)) {
          mismatches.push(`${name}=${actual[name]} instead of ${expected}`)
        }
      }
    }
    if (action.verifyState && mismatches.length) {
      try {
        if (placed?.diggable) {
          await this.clearBuildObstruction(target, signal, true)
          if (!action.stateRepairAttempted && placed.name === expectedBlock) {
            // The server occasionally applies a valid click to stale block
            // state (most visibly merging a slab into a double slab). Repair
            // the result locally once instead of abandoning the entire build.
            await wait(500, signal)
            const recoveredItem = this.bot.inventory.items().some((entry) => entry.name === action.block)
            if (recoveredItem && this.isPassable(this.bot.blockAt(target))) {
              console.warn(`Retrying ${action.block} at ${target} after state mismatch`)
              return this.place({ ...action, stateRepairAttempted: true }, signal)
            }
          }
        }
      } catch (cleanupError) {
        console.warn(`Could not remove mismatched schematic block at ${target}: ${cleanupError.message}`)
      }
      throw new Error(`schematic placement mismatch at ${target}: ${mismatches.join(', ')}`)
    }
    return `Placed ${action.block} at ${target.x}, ${target.y}, ${target.z}`
  }

  async configurePlacedBlockState(action, target, initialBlock, signal) {
    const expectedBlock = action.expectedBlock || action.block
    let placed = initialBlock
    const waitForProperty = async (name, expected, timeout = 1200) => {
      const deadline = Date.now() + timeout
      do {
        placed = this.bot.blockAt(target)
        if (String(placed?.getProperties?.()?.[name]) === String(expected)) return true
        if (Date.now() >= deadline) return false
        await wait(100, signal)
      } while (true)
    }

    if (expectedBlock.endsWith('_slab') && action.properties?.type === 'double' &&
        placed?.getProperties?.()?.type !== 'double') {
      const secondSlab = this.bot.inventory.items().find((entry) => entry.name === action.block)
      if (secondSlab) {
        await this.bot.equip(secondSlab, 'hand')
        await this.bot.activateBlock(placed)
        await waitForProperty('type', 'double')
      }
    }

    if (/(?:_door|_trapdoor|_fence_gate)$/.test(expectedBlock) && action.properties?.open != null) {
      const expectedOpen = String(action.properties.open)
      if (String(placed?.getProperties?.()?.open) !== expectedOpen) {
        await this.bot.activateBlock(placed)
        await waitForProperty('open', expectedOpen)
      }
    }

    const countProperty = expectedBlock.endsWith('_candle') ? 'candles'
      : expectedBlock === 'sea_pickle' ? 'pickles'
        : expectedBlock === 'turtle_egg' ? 'eggs'
          : ['pink_petals', 'wildflowers'].includes(expectedBlock) ? 'flower_amount'
            : null
    const expectedCount = countProperty ? Number(action.properties?.[countProperty]) : 1
    if (countProperty && Number.isInteger(expectedCount) && expectedCount > 1) {
      let actualCount = Number(placed?.getProperties?.()?.[countProperty]) || 1
      while (actualCount < expectedCount) {
        const item = this.bot.inventory.items().find((entry) => entry.name === action.block)
        if (!item) break
        await this.bot.equip(item, 'hand')
        await this.bot.activateBlock(placed)
        const changed = await waitForProperty(countProperty, actualCount + 1)
        const nextCount = Number(placed?.getProperties?.()?.[countProperty]) || actualCount
        if (!changed || nextCount <= actualCount) break
        actualCount = nextCount
      }
    }
    return this.bot.blockAt(target)
  }

  canClearBuildObstruction(block) {
    return !block || this.isPassable(block) || (REPLACEABLE_BUILD_BLOCKS.has(block.name) && block.diggable)
  }

  async clearBuildObstruction(position, signal, reclaimRequiredMaterial = false) {
    const block = this.bot.blockAt(position)
    if (!block || this.isPassable(block)) return true
    if (!this.canClearBuildObstruction(block) && !(reclaimRequiredMaterial && block.diggable)) return false
    let cleared = false
    let lastDigError = null
    for (let attempt = 0; attempt < 2 && !cleared; attempt += 1) {
      const current = this.bot.blockAt(position)
      if (!current || this.isPassable(current)) {
        cleared = true
        break
      }
      await this.bot.tool.equipForBlock(current, { requireHarvest: false, getFromChest: false })
      lastDigError = null
      try {
        await cancellable(this.bot.dig(current, true), signal, () => this.bot.stopDigging())
      } catch (error) {
        if (error.name === 'AbortError') throw error
        lastDigError = error
      }
      // Require a short continuous empty observation. On busy servers a slab
      // can briefly appear as air client-side and then snap back; immediately
      // placing another slab in that window creates an unintended double slab.
      const confirmationDeadline = Date.now() + (lastDigError ? 1500 : 700)
      let clearSince = null
      while (Date.now() < confirmationDeadline) {
        if (this.isPassable(this.bot.blockAt(position))) {
          clearSince ||= Date.now()
          if (Date.now() - clearSince >= 250) {
            cleared = true
            break
          }
        } else {
          clearSince = null
        }
        await wait(50, signal)
      }
      if (!cleared && attempt === 0) console.warn(`Build obstruction reappeared at ${position}; retrying removal once`)
    }
    if (lastDigError && cleared) console.log(`Confirmed delayed obstruction removal at ${position}`)
    if (lastDigError && !cleared) throw lastDigError
    if (cleared && reclaimRequiredMaterial) {
      await this.collectDropsNear(position, signal, null, 4, 500)
      console.log(`Reclaimed misplaced ${block.name} from build site at ${position}`)
    }
    return cleared
  }

  remainingItemDurability(item) {
    if (!item?.maxDurability) return Infinity
    return item.maxDurability - (item.durabilityUsed || 0)
  }

  bestWeapon() {
    const rank = { wooden: 1, golden: 2, stone: 3, iron: 4, diamond: 5, netherite: 6 }
    return this.bot.inventory.items().filter((item) =>
      /_(sword|axe)$/.test(item.name) && this.remainingItemDurability(item) > 0
    ).sort((a, b) => {
      const score = (item) => (rank[item.name.split('_')[0]] || 0) * 1000 +
        (item.name.endsWith('_sword') ? 100 : 0) + Math.min(99, this.remainingItemDurability(item))
      return score(b) - score(a)
    })[0] || null
  }

  shouldDefendAgainst(threat) {
    if (!threat?.entity || threat.distance > 5 || this.bot.health < 12 || this.bot.food < 8) return false
    if (!DEFENDABLE_HOSTILES.has(threat.entity.name)) return false
    return Boolean(this.bestWeapon())
  }

  incomingProjectile(radius = 7) {
    const origin = this.bot.entity.position
    return Object.values(this.bot.entities).map((entity) => {
      if (!entity?.position || !HOSTILE_PROJECTILES.has(entity.name) || !entity.velocity) return null
      const toBot = origin.minus(entity.position)
      const distance = toBot.norm()
      if (distance > radius || distance < 0.1) return null
      const closingSpeed = entity.velocity.dot(toBot.scaled(1 / distance))
      return closingSpeed > 0.08 ? { entity, distance, closingSpeed } : null
    }).filter(Boolean).sort((a, b) => a.distance - b.distance)[0] || null
  }

  async dodgeProjectile(signal) {
    const projectile = this.incomingProjectile()
    if (!projectile) return false
    const velocity = projectile.entity.velocity
    const left = velocity.x * velocity.z >= 0
    const control = left ? 'left' : 'right'
    this.bot.setControlState(control, true)
    this.bot.setControlState('sprint', true)
    try {
      await wait(300, signal)
    } finally {
      this.bot.setControlState(control, false)
      this.bot.setControlState('sprint', false)
    }
    return true
  }

  async attack(action, signal) {
    let entity = this.bot.entities[action.entityId]
    if (!entity) throw new Error(`Entity ${action.entityId} is no longer visible`)
    this.assertNearby(entity.position)
    const weapon = this.bestWeapon()
    if (weapon) await this.bot.equip(weapon, 'hand')
    const shield = this.bot.inventory.items().find((item) => item.name === 'shield')
    if (shield) await this.bot.equip(shield, 'off-hand')
    const deadline = Date.now() + 30000
    let hits = 0
    const ranged = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'blaze', 'witch'])
    try {
      while ((entity = this.bot.entities[action.entityId]) && Date.now() < deadline) {
        if (signal.aborted) throw abortError()
        if (this.bot.health <= 6) throw new Error(`combat retreat: health fell to ${this.bot.health}`)
        if (!shield) await this.dodgeProjectile(signal)
        const distance = this.bot.entity.position.distanceTo(entity.position)
        if (entity.name === 'creeper' && distance < 3.5) {
          if (distance <= 3.2) {
            await this.bot.lookAt(entity.position.offset(0, entity.height || 1, 0), true)
            this.bot.attack(entity)
            hits += 1
          }
          const dx = this.bot.entity.position.x - entity.position.x
          const dz = this.bot.entity.position.z - entity.position.z
          const length = Math.max(0.1, Math.hypot(dx, dz))
          await this.gotoBounded(new goals.GoalNear(
            Math.floor(this.bot.entity.position.x + dx / length * 5),
            Math.floor(this.bot.entity.position.y),
            Math.floor(this.bot.entity.position.z + dz / length * 5), 1
          ), signal, 8)
          await wait(500, signal)
          continue
        }
        if (distance > 3.2) {
          if (shield && ranged.has(entity.name)) this.bot.activateItem(true)
          await this.gotoBounded(new goals.GoalFollow(entity, 2.5), signal, 16)
          if (shield && ranged.has(entity.name)) this.bot.deactivateItem()
          continue
        }
        await this.bot.lookAt(entity.position.offset(0, entity.height || 1, 0), true)
        this.bot.attack(entity)
        hits += 1
        if (shield) this.bot.activateItem(true)
        await wait(weapon?.name.endsWith('_axe') ? 1000 : 650, signal)
        if (shield) this.bot.deactivateItem()
      }
    } finally {
      if (shield) this.bot.deactivateItem()
      this.bot.setControlState?.('left', false)
      this.bot.setControlState?.('right', false)
      this.bot.setControlState?.('sprint', false)
    }
    if (entity) throw new Error(`combat timed out after ${hits} hit(s)`)
    return `Defeated entity ${action.entityId} with ${hits} timed hit(s)`
  }

  async interactBlock(action, signal) {
    const position = new Vec3(Math.floor(action.x), Math.floor(action.y), Math.floor(action.z))
    this.assertNearby(position)
    if (this.bot.entity.position.distanceTo(position) > 4) {
      await this.gotoBounded(new goals.GoalGetToBlock(position.x, position.y, position.z), signal, 16)
    }
    const block = this.bot.blockAt(position)
    if (!block) throw new Error(`No loaded block at ${position}`)
    if (CONTAINER_NAMES.has(block.name)) {
      const container = await cancellable(
        this.bot.openContainer(block), signal, () => this.bot.currentWindow?.close?.()
      )
      try {
        this.containerTracker.record(block, container)
        const count = container.containerItems().reduce((total, item) => total + item.count, 0)
        return `Inspected ${block.name} at ${position}; it contains ${count} item(s)`
      } finally {
        container.close()
      }
    }
    if (!/(_door|_trapdoor|_fence_gate|_button)$/.test(block.name) && !['lever', 'bell'].includes(block.name)) {
      throw new Error(`${block.name} is not an approved interaction block`)
    }
    await this.bot.activateBlock(block)
    return `Interacted with ${block.name} at ${position}`
  }

  async sleep(signal) {
    if (this.bot.isSleeping) return 'Already sleeping'
    const bedIds = Object.values(this.bot.registry.blocksByName)
      .filter((block) => block.name.endsWith('_bed')).map((block) => block.id)
    const position = this.blockTracker.find(bedIds, 32, 1)[0]
    if (!position) throw new Error('No nearby bed was found')
    const bed = this.bot.blockAt(position)
    if (this.bot.entity.position.distanceTo(position) > 3) {
      await this.gotoBounded(new goals.GoalNear(position.x, position.y, position.z, 2), signal, 24)
    }
    await cancellable(this.bot.sleep(bed), signal, () => this.bot.wake?.())
    const deadline = Date.now() + 15000
    while (this.bot.isSleeping && Date.now() < deadline) {
      if (signal.aborted) throw abortError()
      if (Number.isFinite(this.bot.time?.timeOfDay) && this.bot.time.timeOfDay < 12542) break
      await wait(500, signal)
    }
    if (this.bot.isSleeping && this.bot.wake) await this.bot.wake()
    return `Slept in ${bed.name}`
  }

  cropIsMature(block, crop) {
    const age = Number(block.getProperties?.().age)
    return block.name === crop && Number.isFinite(age) && age >= CROP_INFO[crop].maxAge
  }

  async farm(action, signal, onProgress) {
    const info = CROP_INFO[action.crop]
    const type = this.bot.registry.blocksByName[action.crop]
    if (!type) throw new Error(`Unknown crop ${action.crop}`)
    const positions = this.blockTracker.find([type.id], action.radius, 128)
    let harvested = 0
    let replanted = 0
    for (const position of positions) {
      if (signal.aborted) throw abortError()
      let crop = this.bot.blockAt(position)
      if (!crop || !this.cropIsMature(crop, action.crop)) continue
      if (this.bot.entity.position.distanceTo(position) > 4.5) {
        await this.gotoBounded(new goals.GoalNear(position.x, position.y, position.z, 3), signal, 16)
        crop = this.bot.blockAt(position)
      }
      if (!crop || !this.cropIsMature(crop, action.crop)) continue
      await cancellable(this.bot.dig(crop, true), signal, () => this.bot.stopDigging())
      harvested += 1
      await wait(150, signal)
      await this.collectDropsNear(position, signal, [info.seed, action.crop.replace(/s$/, '')], 4, 500)
      const seed = this.bot.inventory.items().find((item) => item.name === info.seed)
      const soil = this.bot.blockAt(position.offset(0, -1, 0))
      if (seed && soil && this.isPassable(this.bot.blockAt(position))) {
        await this.bot.equip(seed, 'hand')
        await cancellable(this.bot.placeBlock(soil, new Vec3(0, 1, 0)), signal, () => {})
        replanted += 1
      }
      if (harvested % 8 === 0) onProgress?.({ completed: harvested, total: positions.length })
      await this.ensureTaskInventorySpace('foraging', signal, { preserveItems: new Set([info.seed]) })
    }
    if (!harvested) throw new Error(`No mature ${action.crop} found within ${action.radius} blocks`)
    onProgress?.({ completed: harvested, total: harvested })
    return `Harvested ${harvested} ${action.crop} and replanted ${replanted}`
  }

  async createFarm(action, signal, onProgress) {
    const center = new Vec3(Math.floor(action.x), Math.floor(action.y), Math.floor(action.z))
    this.assertNearby(center)
    const info = CROP_INFO[action.crop]
    const waterPosition = center.offset(0, -1, 0)
    if (this.bot.entity.position.distanceTo(waterPosition) > 4) {
      await this.gotoBounded(new goals.GoalNear(center.x, center.y, center.z, 3), signal, 16)
    }
    let waterCell = this.bot.blockAt(waterPosition)
    const waterReady = this.isLiquid(waterCell)
    const waterBucket = this.bot.inventory.items().find((item) => item.name === 'water_bucket')
    if (!waterReady && !waterBucket) throw new Error('Need a water_bucket to irrigate a new farm')
    if (waterCell && !this.isPassable(waterCell) && !this.isLiquid(waterCell)) {
      if (!waterCell.diggable) throw new Error(`Cannot make irrigation hole through ${waterCell.name}`)
      await this.bot.tool.equipForBlock(waterCell, { requireHarvest: false, getFromChest: false })
      await cancellable(this.bot.dig(waterCell, true), signal, () => this.bot.stopDigging())
    }
    if (!waterReady) {
      const waterSupport = this.bot.blockAt(waterPosition.offset(0, -1, 0))
      if (!waterSupport || this.isPassable(waterSupport) || this.isLiquid(waterSupport)) {
        throw new Error('Irrigation hole has no safe solid bottom')
      }
      await this.bot.equip(waterBucket, 'hand')
      await this.bot.activateBlock(waterSupport, new Vec3(0, 1, 0))
      waterCell = this.bot.blockAt(waterPosition)
      if (!this.isLiquid(waterCell)) throw new Error('Water bucket did not create the irrigation source')
    }

    let tilled = 0
    let planted = 0
    let existing = 0
    for (let dx = -action.radius; dx <= action.radius; dx += 1) {
      for (let dz = -action.radius; dz <= action.radius; dz += 1) {
        if (dx === 0 && dz === 0) continue
        if (signal.aborted) throw abortError()
        const cropPosition = center.offset(dx, 0, dz)
        let ground = this.bot.blockAt(cropPosition.offset(0, -1, 0))
        const above = this.bot.blockAt(cropPosition)
        if (above?.name === action.crop && ground?.name === 'farmland') {
          tilled += 1
          existing += 1
          continue
        }
        if (!ground || !above || !this.isPassable(above)) continue
        if (this.bot.entity.position.distanceTo(cropPosition) > 4.5) {
          await this.gotoBounded(new goals.GoalNear(cropPosition.x, cropPosition.y, cropPosition.z, 3), signal, 12)
          ground = this.bot.blockAt(cropPosition.offset(0, -1, 0))
        }
        if (['dirt', 'grass_block', 'dirt_path'].includes(ground?.name)) {
          const hoe = await this.toolManager.ensureTool('hoe', signal, 1)
          await this.bot.equip(hoe, 'hand')
          await this.bot.activateBlock(ground)
          await wait(100, signal)
          ground = this.bot.blockAt(cropPosition.offset(0, -1, 0))
        }
        if (ground?.name !== 'farmland') continue
        tilled += 1
        const currentSeed = this.bot.inventory.items().find((item) => item.name === info.seed)
        if (!currentSeed) continue
        await this.bot.equip(currentSeed, 'hand')
        await this.bot.placeBlock(ground, new Vec3(0, 1, 0))
        planted += 1
        if (planted % 8 === 0) onProgress?.({ completed: planted, total: (action.radius * 2 + 1) ** 2 - 1 })
      }
    }
    if (!tilled) throw new Error('No suitable dirt or farmland was found around the farm center')
    if (!planted && !existing && !this.bot.inventory.items().some((item) => item.name === info.seed)) {
      throw new Error(`Need ${info.seed} to plant the ${action.crop} farm`)
    }
    onProgress?.({ completed: planted, total: tilled })
    return `Created irrigated ${action.crop} farm: ${existing} already planted, tilled ${tilled}, planted ${planted}`
  }

  async equip(action) {
    const item = this.bot.inventory.items().find((entry) => entry.name === action.item)
    if (!item) throw new Error(`No ${action.item} in inventory`)
    await this.bot.equip(item, 'hand')
    return `Equipped ${action.item}`
  }

  async equipTool(action) {
    const suffix = `_${action.tool}`
    const tools = this.bot.inventory.items().filter((item) => item.name.endsWith(suffix))
    if (tools.length === 0) throw new Error(`No ${action.tool} in inventory`)
    tools.sort((a, b) => {
      const materialA = a.name.slice(0, -suffix.length)
      const materialB = b.name.slice(0, -suffix.length)
      return TOOL_RANK.indexOf(materialB) - TOOL_RANK.indexOf(materialA)
    })
    await this.bot.equip(tools[0], 'hand')
    return `Equipped ${tools[0].name}`
  }

  inventoryCount(itemName) {
    return this.bot.inventory.items()
      .filter((item) => item.name === itemName)
      .reduce((total, item) => total + item.count, 0)
  }

  inventoryMatchingCount(itemName) {
    return this.bot.inventory.items()
      .filter((item) => this.itemMatchesGroup(item, itemName))
      .reduce((total, item) => total + item.count, 0)
  }

  async drop(action) {
    const item = this.bot.inventory.items().find((entry) => entry.name === action.item)
    const available = this.inventoryCount(action.item)
    if (!item || available < action.quantity) {
      throw new Error(`Need ${action.quantity} ${action.item}, but inventory has ${available}`)
    }
    await this.bot.toss(item.type, null, action.quantity)
    return `Dropped ${action.quantity} ${action.item}`
  }

  findPlayer(username) {
    return this.entityTracker.player(username)
  }

  equipmentItemMatches(item, equipment) {
    if (['pickaxe', 'axe', 'shovel', 'hoe', 'sword'].includes(equipment)) {
      return item.name.endsWith(`_${equipment}`) && this.remainingItemDurability(item) > 0
    }
    return item.name === equipment
  }

  hasEquipment(equipment) {
    if (['pickaxe', 'axe', 'shovel', 'hoe', 'sword'].includes(equipment)) {
      return Boolean(this.toolManager.bestTool(equipment, 1))
    }
    return this.bot.inventory.items().some((item) => this.equipmentItemMatches(item, equipment))
  }

  async approachPlayerForHelp(username, signal) {
    const player = this.findPlayer(username)
    if (!player?.position) return false
    if (this.bot.entity.position.distanceTo(player.position) > 3) {
      this.assertNearby(player.position)
      await this.gotoBounded(new goals.GoalFollow(player, 2), signal, this.limits.pathSearchRadius || 32)
    }
    return this.bot.entity.position.distanceTo(player.position) <= 4
  }

  async collectSuppliedEquipment(equipment, signal) {
    const drops = this.entityTracker.droppedItems(null, 12)
      .filter(({ item }) => this.equipmentItemMatches(item, equipment))
      .map(({ entity }) => entity)
    if (!drops.length) return 0
    await this.ensureCollectBlockSlot(`receiving ${equipment} from the player`)
    return this.collectDroppedEntities(drops, signal)
  }

  async waitForEquipment(username, equipment, signal, waitMs = 60000) {
    const previousActivity = this.activity
    this.activity = `waiting for ${username} to supply ${equipment}`
    try {
      if (this.hasEquipment(equipment)) return true
      try {
        await this.approachPlayerForHelp(username, signal)
      } catch (error) {
        if (error.name === 'AbortError') throw error
        console.warn(`Could not approach ${username} for ${equipment}: ${error.message}`)
      }
      const deadline = Date.now() + waitMs
      while (Date.now() < deadline) {
        if (signal.aborted) throw abortError()
        if (this.hasEquipment(equipment)) return true
        try {
          await this.collectSuppliedEquipment(equipment, signal)
        } catch (error) {
          if (error.name === 'AbortError') throw error
          console.warn(`Could not collect supplied ${equipment}: ${error.message}`)
        }
        if (this.hasEquipment(equipment)) return true
        await wait(Math.min(500, Math.max(1, deadline - Date.now())), signal)
      }
      return this.hasEquipment(equipment)
    } finally {
      this.activity = previousActivity
    }
  }

  async give(action, signal) {
    const player = this.findPlayer(action.player)
    if (!player) throw new Error(`Player ${action.player} is not visible`)
    this.assertNearby(player.position)
    const available = this.inventoryCount(action.item)
    const item = this.bot.inventory.items().find((entry) => entry.name === action.item)
    if (!item || available < action.quantity) {
      throw new Error(`Need ${action.quantity} ${action.item}, but inventory has ${available}`)
    }
    if (this.bot.entity.position.distanceTo(player.position) > 3) {
      await this.gotoBounded(new goals.GoalFollow(player, 2), signal, 16)
    }
    await this.bot.lookAt(player.position.offset(0, player.height || 1.6, 0), true)
    await this.bot.toss(item.type, null, action.quantity)
    return `Dropped ${action.quantity} ${action.item} for ${action.player}`
  }

  itemMatchesGroup(item, requested) {
    if (requested === 'any_log') return item.name.endsWith('_log')
    if (requested === 'any_planks') return item.name.endsWith('_planks')
    return item.name === requested
  }

  async openNearestContainer(signal, maxDistance = null, excluded = new Set()) {
    const searchDistance = Math.min(
      maxDistance || this.limits.collectSearchDistance || 64,
      this.limits.maxMoveDistance || 128
    )
    const types = [...CONTAINER_NAMES]
      .map((name) => this.bot.registry.blocksByName[name]?.id)
      .filter((id) => id !== undefined)
    const positions = this.blockTracker.find(
      types,
      searchDistance,
      32
    ).filter((position) => !excluded.has(position.toString()))
    const failures = []
    for (const position of positions) {
      if (signal.aborted) throw abortError()
      const block = this.bot.blockAt(position)
      if (!block || !CONTAINER_NAMES.has(block.name)) continue
      try {
        if (this.bot.entity.position.distanceTo(position) > 4) {
          const distance = Math.ceil(this.bot.entity.position.distanceTo(position))
          await this.gotoBounded(
            new goals.GoalGetToBlock(position.x, position.y, position.z),
            signal,
            Math.min(this.limits.pathSearchRadius || 32, Math.max(16, distance + 4))
          )
        }
        const container = await cancellable(
          this.bot.openContainer(this.bot.blockAt(position)),
          signal,
          () => this.bot.currentWindow?.close?.()
        )
        this.landmarks?.remember(
          `container_${position.x}_${position.y}_${position.z}`,
          position,
          this.bot.game?.dimension,
          'container'
        )
        return { block: this.bot.blockAt(position), container }
      } catch (error) {
        if (error.name === 'AbortError') throw error
        failures.push(error.message)
        this.blockTracker.markUnreachable(position, error.message)
      }
    }
    throw new Error(`no reachable chest or barrel nearby${failures[0] ? `: ${failures[0]}` : ''}`)
  }

  async withNearestContainer(signal, operation, maxDistance = null, requireTruthyResult = false) {
    const failures = []
    const excluded = new Set()
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const handle = await this.openNearestContainer(signal, maxDistance, excluded)
      let result
      try {
        result = await operation(handle.container, handle.block)
      } finally {
        try { this.containerTracker.record(handle.block, handle.container) } catch {}
        try {
          const contents = {}
          for (const item of handle.container.containerItems()) contents[item.name] = (contents[item.name] || 0) + item.count
          this.landmarks?.remember(
            `container_${handle.block.position.x}_${handle.block.position.y}_${handle.block.position.z}`,
            handle.block.position, this.bot.game?.dimension, 'container', { contents }
          )
        } catch {}
        handle.container.close()
      }
      const done = result && typeof result === 'object' && 'done' in result ? result.done : Boolean(result)
      if (!requireTruthyResult || done) return result
      failures.push(`container at ${handle.block.position} made no progress`)
      this.excludeContainerFootprint(excluded, handle.block)
      if (!(result && typeof result === 'object' && 'progressed' in result)) {
        this.blockTracker.markUnreachable(handle.block.position, 'container operation made no progress')
      }
    }
    throw new Error(`nearby containers had no usable capacity${failures[0] ? `: ${failures[0]}` : ''}`)
  }

  excludeContainerFootprint(excluded, block) {
    if (!block?.position) return excluded
    excluded.add(block.position.toString())
    if (!['chest', 'trapped_chest'].includes(block.name)) return excluded
    for (const offset of [
      new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1), new Vec3(0, 0, -1)
    ]) {
      const neighbor = this.bot.blockAt?.(block.position.plus(offset))
      if (neighbor?.name === block.name) excluded.add(neighbor.position.toString())
    }
    return excluded
  }

  async withRememberedContainer(
    signal,
    operation,
    predicate = null,
    requireTruthyResult = false,
    maxDistance = null
  ) {
    const dimension = this.bot.game?.dimension
    const origin = this.bot.entity.position
    const limit = Math.min(
      this.limits.maxExpeditionDistance || 2048,
      maxDistance || Infinity
    )
    const entries = (this.landmarks?.list('container') || [])
      .filter((entry) => !entry.dimension || entry.dimension === dimension)
      .filter((entry) => !predicate || predicate(entry))
      .filter((entry) => !this.blockTracker?.isUnreachable?.(new Vec3(entry.x, entry.y, entry.z)))
      .map((entry) => ({ entry, distance: origin.distanceTo(new Vec3(entry.x, entry.y, entry.z)) }))
      .filter(({ distance }) => distance <= limit)
      .sort((a, b) => a.distance - b.distance)
    const failures = []
    for (const { entry } of entries) {
      try {
        const position = new Vec3(entry.x, entry.y, entry.z)
        await this.gotoPositionSegmented(position, signal, 3)
        const block = this.bot.blockAt(position)
        if (!block || !CONTAINER_NAMES.has(block.name)) {
          this.landmarks?.forget(entry.name)
          throw new Error('remembered container is missing; removed stale landmark')
        }
        const container = await cancellable(
          this.bot.openContainer(block), signal, () => this.bot.currentWindow?.close?.()
        )
        try {
          const result = await operation(container, block)
          const done = result && typeof result === 'object' && 'done' in result ? result.done : Boolean(result)
          if (!requireTruthyResult || done) return result
        } finally {
          try { this.containerTracker.record(block, container) } catch {}
          try {
            const contents = {}
            for (const item of container.containerItems()) contents[item.name] = (contents[item.name] || 0) + item.count
            this.landmarks?.remember(entry.name, position, this.bot.game?.dimension, 'container', { contents })
          } catch {}
          container.close()
        }
      } catch (error) {
        if (error.name === 'AbortError') throw error
        failures.push(error.message)
        const position = new Vec3(entry.x, entry.y, entry.z)
        this.blockTracker?.markUnreachable?.(position, error.message)
      }
    }
    throw new Error(`no reachable remembered container${failures[0] ? `: ${failures[0]}` : ''}`)
  }

  async deposit(action, signal) {
    const available = this.inventoryMatchingCount(action.item)
    if (available < action.quantity) throw new Error(`need ${action.quantity} ${action.item}, but inventory has ${available}`)
    let remaining = action.quantity
    const transfer = async (container) => {
      const beforeContainer = remaining
      for (const item of this.bot.inventory.items().filter((entry) => this.itemMatchesGroup(entry, action.item))) {
        if (remaining <= 0) break
        const count = Math.min(remaining, item.count)
        const before = this.inventoryMatchingCount(action.item)
        let succeeded = false
        try {
          await container.deposit(item.type, item.metadata ?? null, count, item.nbt ?? null)
          succeeded = true
        } catch (error) {
          console.warn(`Container partially accepted or rejected ${action.item}: ${error.message}`)
        }
        const observed = Math.max(0, before - this.inventoryMatchingCount(action.item))
        const moved = succeeded ? count : Math.min(count, observed)
        remaining -= Math.min(remaining, moved)
      }
      return remaining <= 0 || remaining < beforeContainer
    }
    try {
      await this.withNearestContainer(signal, async (container) => {
        await transfer(container)
        return remaining <= 0
      }, this.limits.collectSearchDistance || 64, true)
    } catch (error) {
      if (error.name === 'AbortError') throw error
      if (remaining > 0) {
        try {
          await this.withRememberedContainer(
            signal,
            async (container) => {
              await transfer(container)
              return remaining <= 0
            },
            null,
            true,
            this.limits.collectSearchDistance || 64
          )
        } catch (rememberedError) {
          if (rememberedError.name === 'AbortError') throw rememberedError
        }
      }
    }
    if (remaining > 0) throw new Error(`container accepted only ${action.quantity - remaining}/${action.quantity} ${action.item}`)
    return `Deposited ${action.quantity} ${action.item} across nearby container storage`
  }

  async withdraw(action, signal) {
    await this.inventoryPolicy.freeTrashSlots(1)
    let withdrawn = 0
    const transfer = async (container) => {
      const candidates = container.containerItems().filter((item) => this.itemMatchesGroup(item, action.item))
      for (const item of candidates) {
        if (withdrawn >= action.quantity) break
        const count = Math.min(action.quantity - withdrawn, item.count)
        const before = this.inventoryMatchingCount(action.item)
        let succeeded = false
        try {
          await container.withdraw(item.type, item.metadata ?? null, count, item.nbt ?? null)
          succeeded = true
        } catch (error) {
          console.warn(`Container partially supplied or rejected ${action.item}: ${error.message}`)
        }
        const observed = Math.max(0, this.inventoryMatchingCount(action.item) - before)
        withdrawn += succeeded ? count : Math.min(count, observed)
      }
      return withdrawn >= action.quantity
    }
    try {
      await this.withNearestContainer(
        signal, transfer, this.limits.collectSearchDistance || 64, true
      )
    } catch (error) {
      if (error.name === 'AbortError') throw error
      if (withdrawn < action.quantity) {
        try {
          await this.withRememberedContainer(
            signal,
            transfer,
            (entry) => Object.entries(entry.contents || {}).some(([name, count]) =>
              count > 0 && this.itemMatchesGroup({ name }, action.item)
            ),
            true,
            this.limits.collectSearchDistance || 64
          )
        } catch (rememberedError) {
          if (rememberedError.name === 'AbortError') throw rememberedError
        }
      }
    }
    if (withdrawn < action.quantity) {
      throw new Error(`nearby containers supplied only ${withdrawn}/${action.quantity} ${action.item}`)
    }
    return `Withdrew ${withdrawn} ${action.item} from the nearest container`
  }

  async cookCarriedFood(signal) {
    if (!signal || this.bot.food <= 8) return null
    const raw = this.bot.inventory.items()
      .filter((item) => COOKED_FOOD[item.name] && item.count > 0)
      .sort((a, b) => {
        const cookedPoints = (item) => this.bot.registry.foodsByName[COOKED_FOOD[item.name]]?.foodPoints || 0
        return cookedPoints(b) - cookedPoints(a)
      })[0]
    if (!raw) return null
    const fuel = this.toolManager.findFuel(Math.min(raw.count, 4), raw.name)
    const furnaceType = this.bot.registry.blocksByName.furnace
    const hasFurnace = this.inventoryCount('furnace') > 0 ||
      (furnaceType && this.bot.findBlock({ matching: furnaceType.id, maxDistance: 6 }))
    if (!fuel || (!hasFurnace && this.inventoryCount('cobblestone') < 8)) return null
    const output = COOKED_FOOD[raw.name]
    const amount = Math.min(raw.count, 4)
    await this.toolManager.smelt(output, amount, signal)
    return output
  }

  async eat(signal = null) {
    if (this.bot.food >= 20) return 'Already full'
    if (this.bot.food > 8 && signal) {
      try { await this.cookCarriedFood(signal) } catch (error) {
        if (error.name === 'AbortError') throw error
        console.warn(`Could not cook carried food before eating: ${error.message}`)
      }
    }
    const food = this.bot.inventory.items()
      .filter((item) => this.bot.registry.foodsByName[item.name] && !UNSAFE_FOODS.has(item.name))
      .sort((a, b) => {
        const score = (item) => {
          const food = this.bot.registry.foodsByName[item.name]
          return (food.foodPoints || 0) * 10 + (food.saturation || 0)
        }
        return score(b) - score(a)
      })[0]
    if (!food) throw new Error('No safe food in inventory')
    await this.bot.equip(food, 'hand')
    await this.bot.consume()
    return `Ate ${food.name}`
  }

  async acquireEmergencyFood(signal) {
    const cropOrder = ['carrots', 'potatoes', 'beetroots', 'wheat']
    for (const crop of cropOrder) {
      try {
        await this.farm({ type: 'farm', crop, radius: 16 }, signal)
        if (crop === 'wheat' && this.inventoryCount('wheat') >= 3) {
          await this.toolManager.craftItem('bread', 1, null)
        }
        await this.eat()
        return `Gathered ${crop} and ate`
      } catch (error) {
        if (error.name === 'AbortError') throw error
      }
    }

    const animal = Object.values(this.bot.entities)
      .filter((entity) => entity?.position && PASSIVE_FOOD_MOBS.has(entity.name) &&
        this.bot.entity.position.distanceTo(entity.position) <= 16)
      .sort((a, b) => this.bot.entity.position.distanceTo(a.position) -
        this.bot.entity.position.distanceTo(b.position))[0]
    if (!animal) throw new Error('No crops, safe food, or nearby food animal available')
    const deathPosition = animal.position.clone()
    await this.attack({ type: 'attack', entityId: animal.id }, signal)
    await this.ensureCollectBlockSlot('collecting hunted food')
    await this.collectDropsNear(deathPosition, signal, null, 5, 1000)
    await this.eat()
    return `Hunted ${animal.name} and ate`
  }
}

module.exports = { ActionExecutor }
