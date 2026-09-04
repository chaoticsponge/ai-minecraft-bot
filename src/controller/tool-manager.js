'use strict'

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')

const TOOL_ORDER = ['pickaxe', 'axe', 'shovel', 'hoe']
const TOOL_COST = { pickaxe: 3, axe: 3, shovel: 1, hoe: 2, sword: 2 }
const TIER_RANK = { wooden: 1, golden: 2, stone: 3, iron: 4, diamond: 5, netherite: 6 }
const FUEL_VALUE = { coal: 8, charcoal: 8, coal_block: 80, blaze_rod: 12, stick: 0.5 }
const SMELT_INPUT = {
  iron_ingot: 'raw_iron', copper_ingot: 'raw_copper', gold_ingot: 'raw_gold',
  charcoal: 'any_log', glass: 'sand', stone: 'cobblestone', smooth_stone: 'stone',
  cooked_beef: 'beef', cooked_porkchop: 'porkchop', cooked_chicken: 'chicken',
  cooked_mutton: 'mutton', cooked_rabbit: 'rabbit', cooked_cod: 'cod',
  cooked_salmon: 'salmon', baked_potato: 'potato', dried_kelp: 'kelp'
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Task cancelled'), { name: 'AbortError' }))
    const finish = () => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(Object.assign(new Error('Task cancelled'), { name: 'AbortError' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

class ToolManager {
  constructor(bot) {
    this.bot = bot
    this.activeMaintenance = null
  }

  count(name) {
    return this.bot.inventory.items()
      .filter((item) => item.name === name)
      .reduce((total, item) => total + item.count, 0)
  }

  countWhere(predicate) {
    return this.bot.inventory.items().filter(predicate).reduce((total, item) => total + item.count, 0)
  }

  remainingDurability(item) {
    if (!item.maxDurability) return Infinity
    return item.maxDurability - (item.durabilityUsed || 0)
  }

  toolTier(item, tool) {
    if (!item.name.endsWith(`_${tool}`)) return 0
    const material = item.name.slice(0, -(`_${tool}`.length))
    return TIER_RANK[material] || 0
  }

  bestTool(tool, minimumDurability = 1) {
    return this.bot.inventory.items()
      .filter((item) => this.toolTier(item, tool) > 0 && this.remainingDurability(item) >= minimumDurability)
      .sort((a, b) => this.toolTier(b, tool) - this.toolTier(a, tool) ||
        this.remainingDurability(b) - this.remainingDurability(a))[0] || null
  }

  async maintainToolSet(signal) {
    if (this.activeMaintenance) return this.activeMaintenance
    this.activeMaintenance = this.doMaintainToolSet(signal).finally(() => {
      this.activeMaintenance = null
    })
    return this.activeMaintenance
  }

  async doMaintainToolSet(signal) {
    await this.ensureCraftingTableItem(signal)
    await this.smeltIronForUpgrades(signal)
    await this.ensureSticks(8, signal)
    for (const tool of TOOL_ORDER) {
      if (signal?.aborted) throw Object.assign(new Error('Task cancelled'), { name: 'AbortError' })
      await this.ensureTool(tool, signal)
    }
  }

  async ensureTool(tool, signal, minimumDurability = 1) {
    const existingTool = this.bestTool(tool, 1)
    const goodTool = this.bestTool(tool, minimumDurability)
    const cost = TOOL_COST[tool]
    if (goodTool && this.toolTier(goodTool, tool) >= TIER_RANK.iron) return goodTool

    let material = null
    if (this.count('iron_ingot') >= cost) material = 'iron'
    else if (goodTool) return goodTool
    else if (this.count('cobblestone') >= cost) material = 'stone'
    else if (this.countWhere((item) => item.name.endsWith('_planks')) >= cost) material = 'wooden'
    if (!material) return existingTool

    await this.ensureSticks(2, signal)
    if (this.count('stick') < 2) return goodTool
    const craftedOk = await this.withCraftingTable(
      (table) => this.craftItem(`${material}_${tool}`, 1, table),
      signal
    )
    if (!craftedOk) return goodTool || existingTool
    const crafted = this.bestTool(tool, minimumDurability) || this.bestTool(tool, 1)
    if (crafted) console.log(`Tool maintenance: ready ${crafted.name}`)
    return crafted
  }

  async ensureSticks(quantity, signal) {
    if (this.count('stick') >= quantity) return true
    await this.ensurePlanks(4, signal)
    const needed = quantity - this.count('stick')
    if (needed > 0) await this.craftItem('stick', needed, null)
    return this.count('stick') >= quantity
  }

  async ensurePlanks(quantity) {
    if (this.countWhere((item) => item.name.endsWith('_planks')) >= quantity) return true
    const log = this.bot.inventory.items().find((item) => item.name.endsWith('_log'))
    if (!log) return false
    const plankName = log.name.replace(/_log$/, '_planks').replace(/^stripped_/, '')
    await this.craftItem(plankName, quantity, null)
    return this.countWhere((item) => item.name.endsWith('_planks')) >= quantity
  }

  async ensureCraftingTableItem(signal) {
    if (this.count('crafting_table') > 0) return true
    await this.ensurePlanks(4, signal)
    if (this.countWhere((item) => item.name.endsWith('_planks')) < 4) return false
    await this.craftItem('crafting_table', 1, null)
    return this.count('crafting_table') > 0
  }

  async ensureShield(signal) {
    const existing = this.bot.inventory.items().find((item) => item.name === 'shield')
    if (existing) return existing
    if (this.count('iron_ingot') < 1) return null
    await this.ensurePlanks(6, signal)
    if (this.countWhere((item) => item.name.endsWith('_planks')) < 6) return null
    const crafted = await this.withCraftingTable((table) => this.craftItem('shield', 1, table), signal)
    return crafted ? this.bot.inventory.items().find((item) => item.name === 'shield') || null : null
  }

  async craftItem(name, quantity, craftingTable) {
    const itemType = this.bot.registry.itemsByName[name]
    if (!itemType) return false
    const recipes = this.bot.recipesFor(itemType.id, null, quantity, craftingTable)
    if (recipes.length === 0) return false
    const recipe = recipes[0]
    const crafts = Math.ceil(quantity / Math.max(1, recipe.result.count))
    await this.bot.craft(recipe, crafts, craftingTable)
    return true
  }

  async gotoNearby(position, signal, searchRadius = 24, tolerance = 3) {
    if (signal?.aborted) throw Object.assign(new Error('Task cancelled'), { name: 'AbortError' })
    const previousRadius = this.bot.pathfinder.searchRadius
    let onAbort
    const cancelled = new Promise((resolve, reject) => {
      onAbort = () => {
        this.bot.pathfinder.stop()
        reject(Object.assign(new Error('Task cancelled'), { name: 'AbortError' }))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    this.bot.pathfinder.searchRadius = searchRadius
    const movements = this.bot.pathfinder.movements
    const previousCanDig = movements.canDig
    const previousTower = movements.allow1by1towers
    movements.canDig = false
    movements.allow1by1towers = false
    try {
      await Promise.race([
        this.bot.pathfinder.goto(new goals.GoalNear(position.x, position.y, position.z, tolerance)),
        cancelled
      ])
    } finally {
      signal?.removeEventListener('abort', onAbort)
      movements.canDig = previousCanDig
      movements.allow1by1towers = previousTower
      this.bot.pathfinder.searchRadius = previousRadius
      this.bot.pathfinder.movements.clearCollisionIndex()
    }
  }

  async recoverTemporaryBlock(position, name, signal) {
    const before = this.count(name)
    const block = this.bot.blockAt(position)
    if (block?.name === name) {
      await this.bot.tool.equipForBlock(block, { requireHarvest: false, getFromChest: false })
      await this.bot.dig(block, true)
    }

    if (this.count(name) <= before && this.bot.entity.position.distanceTo(position) > 1.4) {
      await this.gotoNearby(position, signal, 8, 1)
    }
    const deadline = Date.now() + 1500
    while (this.count(name) <= before && Date.now() < deadline) await delay(100, signal)
    return this.count(name) > before
  }

  async placeInventoryBlock(name, signal) {
    if (this.count(name) === 0) return null
    const feet = this.bot.entity.position.floored()
    const offsets = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
    for (const offset of offsets) {
      const target = feet.plus(offset)
      let targetBlock = this.bot.blockAt(target)
      const support = this.bot.blockAt(target.offset(0, -1, 0))
      if (!targetBlock || targetBlock.boundingBox !== 'empty' || !support || support.boundingBox === 'empty') continue
      let placementError = null
      try {
        if (!['air', 'cave_air', 'void_air'].includes(targetBlock.name)) {
          if (!targetBlock.diggable) continue
          if (signal?.aborted) throw Object.assign(new Error('Task cancelled'), { name: 'AbortError' })
          await this.bot.dig(targetBlock, true)
          targetBlock = this.bot.blockAt(target)
          if (!targetBlock || !['air', 'cave_air', 'void_air'].includes(targetBlock.name)) continue
        }
        const item = this.bot.inventory.items().find((entry) => entry.name === name)
        await this.bot.equip(item, 'hand')
        await this.bot.placeBlock(support, new Vec3(0, 1, 0))
      } catch (error) {
        if (error.name === 'AbortError') throw error
        placementError = error
      }
      // blockUpdate may arrive just after Mineflayer's placement promise times
      // out. Confirm the world for a short window before consuming another
      // placement candidate or crafting a duplicate workstation/chest.
      const confirmationDeadline = Date.now() + (placementError ? 1500 : 400)
      let placed = this.bot.blockAt(target)
      while (placed?.name !== name && Date.now() < confirmationDeadline) {
        await delay(100, signal)
        placed = this.bot.blockAt(target)
      }
      if (placed?.name === name) {
        if (placementError) console.log(`Confirmed delayed ${name} placement at ${target}`)
        console.log(`Tool maintenance: temporarily placed ${name} at ${target}`)
        return placed
      }
      if (placementError) console.warn(`Could not place ${name} at ${target}: ${placementError.message}`)
    }
    return null
  }

  async withCraftingTable(operation, signal) {
    await this.ensureCraftingTableItem(signal)
    const tableType = this.bot.registry.blocksByName.crafting_table
    let nearby = tableType ? this.bot.findBlock({ matching: tableType.id, maxDistance: 64 }) : null
    if (nearby) {
      try {
        if (this.bot.entity.position.distanceTo(nearby.position) > 4) {
          await this.gotoNearby(nearby.position, signal)
        }
        return await operation(nearby)
      } catch (error) {
        console.warn(`Nearest crafting table was unreachable: ${error.message}`)
        nearby = null
      }
    }

    const temporary = await this.placeInventoryBlock('crafting_table', signal)
    if (!temporary) return false
    try {
      return await operation(temporary)
    } finally {
      try {
        const recovered = await this.recoverTemporaryBlock(temporary.position, 'crafting_table', signal)
        if (!recovered) throw new Error('crafting table item did not return to inventory')
        console.log('Tool maintenance: recovered temporary crafting table')
      } catch (error) {
        console.error(`Could not recover temporary crafting table: ${error.message}`)
      }
    }
  }

  async ensureFurnace(signal) {
    const blockType = this.bot.registry.blocksByName.furnace
    let block = blockType ? this.bot.findBlock({ matching: blockType.id, maxDistance: 6 }) : null
    if (block) return { block, temporary: false }

    if (this.count('furnace') === 0) {
      await this.withCraftingTable((table) => this.craftItem('furnace', 1, table), signal)
    }
    block = await this.placeInventoryBlock('furnace', signal)
    return block ? { block, temporary: true } : null
  }

  async ensureWorkstation(name, signal) {
    if (name === 'crafting_table') {
      const blockType = this.bot.registry.blocksByName.crafting_table
      return blockType ? this.bot.findBlock({ matching: blockType.id, maxDistance: 6 }) : null
    }
    const blockType = this.bot.registry.blocksByName[name]
    let block = blockType ? this.bot.findBlock({ matching: blockType.id, maxDistance: 6 }) : null
    if (block) return block

    if (this.count(name) === 0) {
      if (name === 'crafting_table') {
        await this.ensurePlanks(4, signal)
        await this.craftItem('crafting_table', 1, null)
      } else if (name === 'furnace') {
        await this.withCraftingTable((table) => this.craftItem('furnace', 1, table), signal)
      }
    }
    if (this.count(name) === 0) return null

    return this.placeInventoryBlock(name, signal)
  }

  findFuel(requiredOperations, excludedName = null) {
    return this.bot.inventory.items().map((item) => {
      if (item.name === excludedName) return { item, value: 0 }
      let value = FUEL_VALUE[item.name]
      if (!value && (item.name.endsWith('_planks') || item.name.endsWith('_log'))) value = 1.5
      return { item, value: value || 0 }
    }).filter(({ value }) => value > 0)
      .sort((a, b) => b.value - a.value)
      .map(({ item, value }) => ({ item, value, needed: Math.ceil(requiredOperations / value) }))
      .find(({ item, needed }) => item.count >= needed) || null
  }

  async smeltIronForUpgrades(signal) {
    const desiredIron = TOOL_ORDER.reduce((total, tool) => {
      const current = this.bestTool(tool, 1)
      return current && this.toolTier(current, tool) >= TIER_RANK.iron ? total : total + TOOL_COST[tool]
    }, 0)
    const missing = Math.max(0, desiredIron - this.count('iron_ingot'))
    const rawIron = this.bot.inventory.items().find((item) => item.name === 'raw_iron')
    if (missing === 0 || !rawIron) return
    const amount = Math.min(missing, rawIron.count)
    const fuel = this.findFuel(amount)
    if (!fuel) return
    await this.smelt('iron_ingot', amount, signal)
  }

  async makeCharcoal(signal) {
    if (this.count('charcoal') > 0) return true
    let log = this.bot.inventory.items().find((item) => item.name.endsWith('_log'))
    if (!log) return false
    if (!this.findFuel(1, log.name)) {
      if (this.countWhere((item) => item.name.endsWith('_log')) < 2) return false
      await this.ensurePlanks(1, signal)
      log = this.bot.inventory.items().find((item) => item.name.endsWith('_log'))
    }
    if (!log || !this.findFuel(1, log.name)) return false
    const furnaceType = this.bot.registry.blocksByName.furnace
    const hasFurnace = this.count('furnace') > 0 ||
      (furnaceType && this.bot.findBlock({ matching: furnaceType.id, maxDistance: 6 }))
    if (!hasFurnace && this.count('cobblestone') < 8) return false
    await this.smelt('charcoal', 1, signal)
    return this.count('charcoal') > 0
  }

  async smelt(outputName, amount, signal) {
    const inputName = SMELT_INPUT[outputName]
    if (!inputName) throw new Error(`unsupported smelting output ${outputName}`)
    const input = this.bot.inventory.items().find((item) =>
      inputName === 'any_log' ? item.name.endsWith('_log') : item.name === inputName
    )
    if (!input || input.count < amount) throw new Error(`need ${amount} ${inputName} to smelt ${outputName}`)
    const fuel = this.findFuel(amount, input.name)
    if (!fuel) throw new Error(`need fuel to smelt ${outputName}`)
    const furnaceHandle = await this.ensureFurnace(signal)
    if (!furnaceHandle) throw new Error('could not prepare a furnace')

    const furnace = await this.bot.openFurnace(furnaceHandle.block)
    try {
      if (furnace.outputItem()) await furnace.takeOutput()
      if (furnace.inputItem()) {
        const recovered = await furnace.takeInput()
        console.log(`Recovered ${recovered.count} ${recovered.name} from occupied furnace input`)
      }
      await furnace.putInput(input.type, null, amount)
      if (!furnace.fuelItem() || furnace.fuelItem().count < fuel.needed) {
        await furnace.putFuel(fuel.item.type, null, fuel.needed)
      }
      const deadline = Date.now() + amount * 12000 + 5000
      while (Date.now() < deadline) {
        if ((furnace.outputItem()?.count || 0) >= amount) break
        await delay(500, signal)
      }
      if (furnace.outputItem()) {
        const output = await furnace.takeOutput()
        console.log(`Smelted ${output.count} ${output.name}`)
      } else {
        throw new Error(`smelting ${outputName} timed out`)
      }
    } finally {
      furnace.close()
      if (furnaceHandle.temporary) {
        try {
          await delay(250, signal)
          const recovered = await this.recoverTemporaryBlock(furnaceHandle.block.position, 'furnace', signal)
          if (!recovered) throw new Error('furnace item did not return to inventory')
          console.log('Tool maintenance: recovered temporary furnace')
        } catch (error) {
          console.error(`Could not recover temporary furnace: ${error.message}`)
        }
      }
    }
    return true
  }
}

module.exports = { ToolManager }
