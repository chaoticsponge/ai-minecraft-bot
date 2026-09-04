'use strict'

const SMELTING = {
  iron_ingot: 'raw_iron',
  copper_ingot: 'raw_copper',
  gold_ingot: 'raw_gold',
  charcoal: 'any_log',
  glass: 'sand',
  stone: 'cobblestone',
  smooth_stone: 'stone',
  cooked_beef: 'beef',
  cooked_porkchop: 'porkchop',
  cooked_chicken: 'chicken',
  cooked_mutton: 'mutton',
  cooked_rabbit: 'rabbit',
  cooked_cod: 'cod',
  cooked_salmon: 'salmon',
  baked_potato: 'potato',
  dried_kelp: 'kelp'
}

const SOURCE_BLOCKS = {
  cobblestone: 'stone',
  cobbled_deepslate: 'deepslate',
  raw_iron: 'iron_ore',
  raw_copper: 'copper_ore',
  raw_gold: 'gold_ore',
  diamond: 'diamond_ore',
  redstone: 'redstone_ore',
  coal: 'coal_ore',
  charcoal: 'any_log'
}

class AcquireItemTask {
  constructor(bot, executor) {
    this.bot = bot
    this.executor = executor
  }

  count(name) {
    if (name === 'any_log') {
      return this.bot.inventory.items().filter((item) => item.name.endsWith('_log')).reduce((n, item) => n + item.count, 0)
    }
    if (name === 'any_planks') {
      return this.bot.inventory.items().filter((item) => item.name.endsWith('_planks')).reduce((n, item) => n + item.count, 0)
    }
    return this.bot.inventory.items().filter((item) => item.name === name).reduce((n, item) => n + item.count, 0)
  }

  effectiveCount(name) {
    return this.count(name) + (name === this.activeGoalItem ? this.executor.goalStoredCount(name) : 0)
  }

  resolveGroup(name) {
    if (name !== 'any_planks') return name
    const plank = this.bot.inventory.items().find((item) => item.name.endsWith('_planks'))
    if (plank) return plank.name
    const log = this.bot.inventory.items().find((item) => item.name.endsWith('_log'))
    return log ? log.name.replace(/^stripped_/, '').replace(/_log$/, '_planks') : 'oak_planks'
  }

  async run(item, quantity, signal, rootTask, onProgress) {
    const previousGoalItem = this.activeGoalItem
    const previousProgress = this.onProgress
    this.activeGoalItem = item
    this.onProgress = onProgress
    try {
      await this.ensure(item, quantity, signal, rootTask, new Set())
      const count = this.effectiveCount(item)
      if (count < quantity) throw new Error(`acquire_item produced ${count}/${quantity} ${item}`)
      return `Acquired ${count}/${quantity} ${item} across inventory and task storage`
    } finally {
      this.activeGoalItem = previousGoalItem
      this.onProgress = previousProgress
    }
  }

  checkpoint(task, requested, quantity) {
    task.detail.current = this.effectiveCount(requested)
    this.onProgress?.(task)
  }

  async ensure(requested, quantity, signal, parent, ancestry) {
    if (signal.aborted) throw Object.assign(new Error('Task cancelled'), { name: 'AbortError' })
    if (this.effectiveCount(requested) >= quantity) return
    await this.executor.tryWithdrawFromNearby(requested, quantity - this.count(requested), signal)
    if (this.effectiveCount(requested) >= quantity) return
    if (requested === 'any_planks' && this.count('any_planks') < quantity) {
      if (!this.bot.inventory.items().some((item) => item.name.endsWith('_log'))) {
        await this.ensure('any_log', Math.ceil((quantity - this.count('any_planks')) / 4), signal, parent, ancestry)
      }
      const concrete = this.resolveGroup(requested)
      const concreteTarget = this.count(concrete) + quantity - this.count('any_planks')
      await this.ensure(concrete, concreteTarget, signal, parent, ancestry)
      this.onProgress?.(parent)
      return
    }
    const itemName = this.resolveGroup(requested)
    if (ancestry.has(itemName)) throw new Error(`recipe cycle while acquiring ${itemName}`)
    const nextAncestry = new Set(ancestry).add(itemName)
    const task = parent.child('acquire', `acquire ${quantity} ${requested}`, {
      item: requested, target: quantity, current: this.count(requested)
    })
    task.start()
    try {
      if (SMELTING[itemName]) {
        const missing = quantity - this.count(itemName)
        let inputTarget = missing
        if (itemName === 'charcoal') {
          const currentLog = this.bot.inventory.items().find((entry) => entry.name.endsWith('_log'))
          if (!this.executor.toolManager.findFuel(missing, currentLog?.name)) {
            const fuelPlanks = Math.ceil(missing / 1.5)
            const plankDeficit = Math.max(0, fuelPlanks - this.count('any_planks'))
            inputTarget += Math.ceil(plankDeficit / 4)
          }
        }
        await this.ensure(SMELTING[itemName], inputTarget, signal, task, nextAncestry)
        const furnaceType = this.bot.registry.blocksByName.furnace
        const hasFurnace = this.count('furnace') > 0 ||
          (furnaceType && this.bot.findBlock({ matching: furnaceType.id, maxDistance: 6 }))
        if (!hasFurnace) await this.ensure('cobblestone', 8, signal, task, nextAncestry)
        const inputName = SMELTING[itemName] === 'any_log'
          ? this.bot.inventory.items().find((entry) => entry.name.endsWith('_log'))?.name
          : SMELTING[itemName]
        if (!this.executor.toolManager.findFuel(missing, inputName)) {
          if (itemName === 'charcoal') {
            await this.ensure('any_planks', Math.ceil(missing / 1.5), signal, task, nextAncestry)
          } else {
            await this.ensure('coal', Math.ceil(missing / 8), signal, task, nextAncestry)
          }
        }
        await this.executor.toolManager.smelt(itemName, missing, signal)
      } else {
        const item = this.bot.registry.itemsByName[itemName]
        const recipes = item ? this.bot.recipesAll(item.id, null, true) : []
        const recipe = this.chooseRecipe(recipes)
        if (recipe) {
          const missing = quantity - this.count(itemName)
          const crafts = Math.ceil(missing / Math.max(1, recipe.result.count))
          for (const ingredient of recipe.delta.filter((entry) => entry.count < 0)) {
            const ingredientName = this.bot.registry.items[ingredient.id]?.name
            if (!ingredientName) throw new Error(`unknown recipe ingredient ${ingredient.id}`)
            await this.ensure(ingredientName, -ingredient.count * crafts, signal, task, nextAncestry)
          }
          if (recipe.requiresTable) {
            const crafted = await this.executor.toolManager.withCraftingTable(
              (table) => this.bot.craft(recipe, crafts, table).then(() => true),
              signal
            )
            if (!crafted) throw new Error(`could not prepare a crafting table for ${itemName}`)
          } else {
            await this.bot.craft(recipe, crafts, null)
          }
        } else {
          await this.collectBase(itemName, quantity, signal, task, nextAncestry)
        }
      }
      this.checkpoint(task, requested, quantity)
      task.complete(`${task.detail.current}/${quantity}`)
    } catch (error) {
      task.fail(error)
      throw error
    }
  }

  chooseRecipe(recipes) {
    return recipes.slice().sort((a, b) => this.recipeScore(a) - this.recipeScore(b))[0] || null
  }

  recipeScore(recipe) {
    let score = recipe.requiresTable ? 2 : 0
    const preferredPlank = this.preferredPlank()
    for (const ingredient of recipe.delta.filter((entry) => entry.count < 0)) {
      const name = this.bot.registry.items[ingredient.id]?.name
      const have = name ? this.count(name) : 0
      if (have >= -ingredient.count) continue
      if (name === preferredPlank) score += 1
      else score += (name?.endsWith('_planks') || name?.endsWith('_log') ? 3 : 8)
    }
    return score
  }

  preferredPlank() {
    const plank = this.bot.inventory.items().find((item) => item.name.endsWith('_planks'))
    if (plank) return plank.name
    const log = this.bot.inventory.items().find((item) => item.name.endsWith('_log'))
    if (log) return log.name.replace(/^stripped_/, '').replace(/_log$/, '_planks')
    const logTypes = this.executor.resolveBlockTypes('any_log')
    const position = this.executor.blockTracker.find(
      logTypes.map((block) => block.id),
      Math.min(this.executor.limits.collectSearchDistance, this.executor.limits.maxMoveDistance),
      1
    )[0]
    const nearby = position && this.bot.blockAt(position)
    return nearby ? nearby.name.replace(/^stripped_/, '').replace(/_log$/, '_planks') : 'oak_planks'
  }

  async collectBase(itemName, quantity, signal, task, ancestry) {
    let block = SOURCE_BLOCKS[itemName] || itemName
    if (itemName.endsWith('_log')) block = itemName
    if (!this.executor.resolveBlockTypes(block).length) throw new Error(`no deterministic source or recipe for ${itemName}`)

    if ((block === 'stone' || block === 'deepslate' || block.endsWith('_ore')) && !this.executor.toolManager.bestTool('pickaxe')) {
      await this.ensure('wooden_pickaxe', 1, signal, task, ancestry)
    }
    if (['raw_iron', 'raw_copper'].includes(itemName) &&
        (this.executor.toolManager.toolTier(this.executor.toolManager.bestTool('pickaxe') || { name: '' }, 'pickaxe') < 3)) {
      await this.ensure('stone_pickaxe', 1, signal, task, ancestry)
    }
    if (['raw_gold', 'diamond', 'redstone'].includes(itemName) &&
        (this.executor.toolManager.toolTier(this.executor.toolManager.bestTool('pickaxe') || { name: '' }, 'pickaxe') < 4)) {
      await this.ensure('iron_pickaxe', 1, signal, task, ancestry)
    }
    let attemptedSurfaceReturn = false
    while (this.effectiveCount(itemName) < quantity) {
      const before = this.effectiveCount(itemName)
      try {
        await this.executor.collect(
          { type: 'collect', block, quantity: Math.min(64, quantity - before) },
          signal,
          { preserveItems: itemName === this.activeGoalItem ? new Set() : new Set([itemName]) }
        )
      } catch (error) {
        const needsSurfaceWood = itemName === 'any_log' || itemName.endsWith('_log')
        if (!attemptedSurfaceReturn && needsSurfaceWood && this.bot.entity.position.y < 32 &&
            ['missing_resource', 'navigation', 'skill_error'].includes(error.category || 'skill_error')) {
          attemptedSurfaceReturn = true
          await this.executor.returnToSurface(signal)
          continue
        }
        throw error
      }
      if (this.effectiveCount(itemName) <= before) throw new Error(`collecting ${block} did not produce ${itemName}`)
    }
  }
}

module.exports = { AcquireItemTask, SMELTING, SOURCE_BLOCKS }
