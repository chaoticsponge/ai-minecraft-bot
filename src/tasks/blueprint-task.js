'use strict'

const { Vec3 } = require('vec3')
const { AcquireItemTask } = require('./acquire-item-task')
const { goals } = require('mineflayer-pathfinder')

const FACING_VECTOR = {
  north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1),
  east: new Vec3(1, 0, 0), west: new Vec3(-1, 0, 0)
}
const SCAFFOLD_BLOCKS = new Set([
  'dirt', 'cobblestone', 'stone', 'cobbled_deepslate', 'netherrack',
  'tuff', 'andesite', 'diorite', 'granite', 'calcite', 'sandstone', 'smooth_sandstone'
])
const OPTIONAL_DECOR = new Set([
  'anvil', 'barrel', 'beehive', 'bookshelf', 'brewing_stand', 'cake', 'campfire',
  'cauldron', 'chest', 'chiseled_bookshelf', 'composter', 'crafting_table',
  'decorated_pot', 'fletching_table', 'flower_pot', 'furnace', 'loom',
  'scaffolding', 'smithing_table', 'turtle_egg'
])
const OPTIONAL_PLANTS = new Set([
  'allium', 'azure_bluet', 'blue_orchid', 'cornflower', 'dandelion', 'large_fern',
  'lilac', 'lily_of_the_valley', 'oxeye_daisy', 'peony', 'poppy', 'rose_bush',
  'sea_pickle', 'sunflower', 'wildflowers', 'wither_rose'
])

function isDeferrableBuildNavigation(error) {
  return /no player-reachable placement stance|no path to the goal|placement-aware approach.*failed/i
    .test(String(error?.message || error))
}

function nearDeferredBuildPocket(position, phase, pockets) {
  return pockets.some((entry) => entry.phase === phase &&
    Math.abs(entry.position.y - position.y) <= 1 &&
    Math.max(
      Math.abs(entry.position.x - position.x),
      Math.abs(entry.position.z - position.z)
    ) <= 2)
}

class BlueprintTask {
  constructor(bot, executor, loader) {
    this.bot = bot
    this.executor = executor
    this.loader = loader
    this.acquire = new AcquireItemTask(bot, executor)
  }

  concreteMaterial(name) {
    if (name !== 'any_planks') return name
    const plank = this.bot.inventory.items().find((item) => item.name.endsWith('_planks'))
    if (plank) return plank.name
    const log = this.bot.inventory.items().find((item) => item.name.endsWith('_log'))
    return log ? log.name.replace(/^stripped_/, '').replace(/_log$/, '_planks') : 'oak_planks'
  }

  async collectMaterials(name, signal, rootTask, onProgress) {
    const blueprint = this.loader.load(name)
    const materials = this.loader.materials(blueprint)
    for (const [material, quantity] of Object.entries(materials)) {
      await this.acquire.run(material, quantity, signal, rootTask, onProgress)
    }
    const resolved = Object.fromEntries(Object.keys(materials).map((material) => [material, this.concreteMaterial(material)]))
    return `Ready to build ${name}: ${Object.entries(materials).map(([item, count]) => `${count} ${resolved[item]}`).join(', ')}`
  }

  anchor(action, blueprint) {
    return new Vec3(Math.floor(action.x), Math.floor(action.y), Math.floor(action.z))
  }

  rotate(local, facing) {
    if (facing === 'north') return new Vec3(-local.x, local.y, -local.z)
    if (facing === 'east') return new Vec3(local.z, local.y, -local.x)
    if (facing === 'west') return new Vec3(-local.z, local.y, local.x)
    return local
  }

  rotateProperties(properties, facing) {
    const turns = { east: 1, north: 2, west: 3 }[facing] || 0
    if (!properties || turns === 0) return properties
    const directions = ['south', 'east', 'north', 'west']
    const rotated = { ...properties }
    const index = directions.indexOf(properties.facing)
    if (index >= 0) rotated.facing = directions[(index + turns) % 4]
    if (turns % 2 === 1 && ['x', 'z'].includes(properties.axis)) {
      rotated.axis = properties.axis === 'x' ? 'z' : 'x'
    }
    if (directions.some((direction) => Object.hasOwn(properties, direction))) {
      for (let target = 0; target < directions.length; target += 1) {
        const source = (target - turns + directions.length) % directions.length
        if (Object.hasOwn(properties, directions[source])) rotated[directions[target]] = properties[directions[source]]
      }
    }
    return rotated
  }

  matchesEntry(block, entry, concrete = null) {
    const expectedBlock = entry.block || concrete || entry.material
    const nameMatches = entry.material === 'any_planks'
      ? block?.name.endsWith('_planks')
      : block?.name === expectedBlock
    if (!nameMatches) return false
    const actual = block?.getProperties?.() || {}
    // Compare only states controlled by where/how the player clicks. Walls,
    // fences, panes, leaves, redstone, waterlogging, and similar blocks expose
    // derived properties that legitimately change as neighbors load or are
    // placed. Treating those as structural mismatches makes resume repeatedly
    // tear out correct blocks and can never converge on a large schematic.
    const strictProperties = new Set(['facing', 'axis', 'half'])
    if (expectedBlock?.endsWith('_bed')) strictProperties.add('part')
    if (expectedBlock?.endsWith('_slab')) strictProperties.add('type')
    if (/(?:_door|_trapdoor|_fence_gate)$/.test(expectedBlock)) strictProperties.add('open')
    if (['lantern', 'soul_lantern'].includes(expectedBlock)) strictProperties.add('hanging')
    if (expectedBlock?.endsWith('_candle')) strictProperties.add('candles')
    if (expectedBlock === 'sea_pickle') strictProperties.add('pickles')
    if (expectedBlock === 'turtle_egg') strictProperties.add('eggs')
    if (['pink_petals', 'wildflowers'].includes(expectedBlock)) strictProperties.add('flower_amount')
    return Object.entries(entry.properties || {})
      .filter(([name]) => strictProperties.has(name))
      .every(([name, value]) => String(actual[name]) === String(value))
  }

  entryItemCount(entry) {
    return this.loader.itemCount?.(entry) || 1
  }

  structureLandmarkName(schematic) {
    return `blueprint_${schematic}`
  }

  layout(action, blueprint = this.loader.load(action.schematic)) {
    const facing = action.facing || 'south'
    const anchor = this.anchor(action, blueprint)
    const originOffset = new Vec3(blueprint.anchor?.x || 0, blueprint.anchor?.y || 0, blueprint.anchor?.z || 0)
    return this.loader.blocks(blueprint).sort((a, b) => a.y - b.y).map((entry) => {
      const local = new Vec3(entry.x, entry.y, entry.z).minus(originOffset)
      return {
        ...entry,
        properties: this.rotateProperties(entry.properties, facing),
        position: anchor.plus(this.rotate(local, facing))
      }
    })
  }

  audit(action, blueprint = this.loader.load(action.schematic)) {
    const blocks = this.layout(action, blueprint)
    const remaining = {}
    let alreadyPlaced = 0
    for (const entry of blocks) {
      if (this.matchesEntry(this.bot.blockAt(entry.position), entry)) alreadyPlaced += 1
      else remaining[entry.material] = (remaining[entry.material] || 0) + this.entryItemCount(entry)
    }
    return { blocks, remaining, alreadyPlaced }
  }

  rememberStructure(action) {
    if (!this.executor.landmarks) return null
    const position = new Vec3(Math.floor(action.x), Math.floor(action.y), Math.floor(action.z))
    return this.executor.landmarks.remember(
      this.structureLandmarkName(action.schematic),
      position,
      this.bot.game?.dimension,
      'blueprint',
      { schematic: action.schematic, facing: action.facing || 'south' }
    )
  }

  savedPartialBuild(action, blueprint) {
    const landmark = this.executor.landmarks?.get(this.structureLandmarkName(action.schematic))
    if (!landmark || landmark.type !== 'blueprint' || landmark.schematic !== action.schematic) return null
    const dimension = this.bot.game?.dimension
    if (landmark.dimension && dimension && landmark.dimension !== dimension) return null
    const saved = {
      ...action, x: landmark.x, y: landmark.y, z: landmark.z,
      facing: landmark.facing || action.facing || 'south'
    }
    const audit = this.audit(saved, blueprint)
    const minimumEvidence = Math.min(3, audit.blocks.length)
    if (audit.alreadyPlaced < minimumEvidence || audit.alreadyPlaced === audit.blocks.length) return null
    console.log(
      `Resuming saved ${action.schematic} site at ${saved.x}, ${saved.y}, ${saved.z}, ` +
      `facing ${saved.facing} (${audit.alreadyPlaced}/${audit.blocks.length} blocks present)`
    )
    return saved
  }

  async repair(action, signal, rootTask, onProgress) {
    const landmark = this.executor.landmarks?.get(this.structureLandmarkName(action.schematic))
    if (!landmark || landmark.type !== 'blueprint' || landmark.schematic !== action.schematic) {
      throw new Error(`no saved ${action.schematic} build to repair`)
    }
    const dimension = this.bot.game?.dimension
    if (landmark.dimension && dimension && landmark.dimension !== dimension) {
      throw new Error(`saved ${action.schematic} is in ${landmark.dimension}, not ${dimension}`)
    }
    const buildAction = {
      type: 'build_schematic', schematic: action.schematic,
      x: landmark.x, y: landmark.y, z: landmark.z, facing: landmark.facing || 'south'
    }
    const audit = this.audit(buildAction)
    if (audit.alreadyPlaced === audit.blocks.length) return `${action.schematic} is already complete`
    return this.build(buildAction, signal, rootTask, onProgress)
  }

  buildSupplyBatch(material, remaining) {
    const concrete = this.concreteMaterial(material)
    const stackSize = this.bot.registry?.itemsByName?.[concrete]?.stackSize || 64
    return Math.max(1, Math.min(remaining, stackSize))
  }

  buildPhase(entry) {
    const name = entry.block || entry.material
    if (OPTIONAL_DECOR.has(name) || OPTIONAL_PLANTS.has(name) ||
        /(?:_bed|_carpet|_candle|_banner|_flower|_sapling|_shelf|_tulip)$/.test(name) ||
        name.startsWith('potted_')) return 2
    if (/(?:_door|_trapdoor|_button|_pressure_plate|_torch)$/.test(name) ||
        ['torch', 'soul_torch', 'lantern', 'soul_lantern', 'ladder', 'lever'].includes(name)) return 1
    return 0
  }

  buildPlacementRank(entry) {
    const name = entry.block || entry.material
    // Multi-block items must be placed from the half that owns the inventory
    // item. Minecraft creates the other half automatically.
    if (name?.endsWith('_door')) return entry.properties?.half === 'upper' ? 2 : 0
    if (name?.endsWith('_bed')) return entry.properties?.part === 'head' ? 2 : 0
    return 1
  }

  multiBlockOwnerPosition(entry) {
    const name = entry.block || entry.material
    if (name?.endsWith('_door') && entry.properties?.half === 'upper') {
      return entry.position.offset(0, -1, 0)
    }
    if (name?.endsWith('_bed') && entry.properties?.part === 'head') {
      const facing = FACING_VECTOR[entry.properties?.facing]
      return facing ? entry.position.minus(facing) : entry.position
    }
    return entry.position
  }

  multiBlockPartnerPosition(entry) {
    const name = entry.block || entry.material
    if (name?.endsWith('_door') && entry.properties?.half === 'lower') {
      return entry.position.offset(0, 1, 0)
    }
    if (name?.endsWith('_bed') && entry.properties?.part === 'foot') {
      const facing = FACING_VECTOR[entry.properties?.facing]
      return facing ? entry.position.plus(facing) : null
    }
    return null
  }

  pendingPlacements(blocks) {
    const expectedAt = new Map(blocks.map((entry) => [entry.position.toString(), entry]))
    const groups = new Map()
    for (const entry of blocks) {
      const ownerPosition = this.multiBlockOwnerPosition(entry)
      const owner = expectedAt.get(ownerPosition.toString()) || entry
      const key = owner.position.toString()
      if (!groups.has(key)) groups.set(key, { owner, components: [] })
      groups.get(key).components.push(entry)
    }
    const pending = []
    for (const { owner, components } of groups.values()) {
      const mismatched = components.filter((entry) => !this.matchesEntry(this.bot.blockAt(entry.position), entry))
      if (!mismatched.length) continue
      const partner = this.multiBlockPartnerPosition(owner)
      pending.push({
        ...owner,
        progressCredit: mismatched.length,
        ...(partner ? {
          repairCoupled: true,
          coupledPositions: components
            .filter((entry) => !entry.position.equals(owner.position))
            .map((entry) => entry.position)
        } : {})
      })
    }
    const feet = this.bot.entity?.position?.floored?.()
    const occupiesBot = (entry) => feet &&
      (entry.position.equals(feet) || entry.position.equals(feet.offset(0, 1, 0)))
    return pending.sort((a, b) => this.buildPhase(a) - this.buildPhase(b) ||
      Number(occupiesBot(a)) - Number(occupiesBot(b)) || a.y - b.y ||
      this.buildPlacementRank(a) - this.buildPlacementRank(b))
  }

  async ensureBuildSupply(material, remaining, signal, optional = false, neededNow = 1) {
    const carried = this.acquire.count(material)
    if (carried >= neededNow) return carried
    await this.executor.inventoryPolicy?.freeTrashSlots?.(1)
    if ((this.executor.inventoryTracker?.freeSlots?.() ?? 1) < 1) {
      const reserved = this.executor.inventoryPolicy?.reservedItems?.() || new Map()
      await this.executor.ensureTaskInventorySpace?.('building', signal, {
        preserveItems: new Set([material, ...reserved.keys()]), minimumFreeSlots: 1
      })
    }
    const quantity = Math.max(neededNow - carried, this.buildSupplyBatch(material, remaining))
    await this.executor.tryWithdrawFromNearby(material, quantity, signal)
    const available = this.acquire.count(material)
    if (available < neededNow && optional) return 0
    if (available < neededNow) {
      throw new Error(
        `missing build supply ${material}; need ${Math.max(neededNow, remaining)} remaining for this build, ` +
        `put some in a nearby chest or barrel`
      )
    }
    return available
  }

  preflightBuildSite(blocks) {
    let unloaded = null
    let obstructed = null
    let obstructionCount = 0
    const obstructionTypes = new Map()
    const requiredNames = new Set(blocks.flatMap((entry) =>
      [entry.block, entry.material].filter((name) => name && name !== 'any_planks')
    ))
    for (const entry of blocks) {
      if (this.buildPhase(entry) === 2) continue
      const current = this.bot.blockAt(entry.position)
      if (!current) {
        unloaded ||= entry.position
        continue
      }
      if (this.matchesEntry(current, entry) || this.executor.canClearBuildObstruction(current) ||
          (current.diggable && requiredNames.has(current.name))) continue
      obstructed ||= { position: entry.position, block: current.name }
      obstructionCount += 1
      const key = `${current.name}@Y${entry.position.y}`
      obstructionTypes.set(key, (obstructionTypes.get(key) || 0) + 1)
    }
    if (unloaded) throw new Error(`build site has unloaded blocks near ${unloaded}; move closer and retry`)
    if (obstructed) {
      const summary = [...obstructionTypes]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([name, count]) => `${count} ${name}`)
        .join(', ')
      throw new Error(
        `build site is not clear: ${obstructionCount} required positions are obstructed (${summary}); first is ${obstructed.block} at ${obstructed.position}`
      )
    }
    return true
  }

  async clearBuildPosition(position, signal, reclaimMaterial = false) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = this.bot.blockAt(position)
      if (!current || current.boundingBox === 'empty') return true
      await this.executor.clearBuildObstruction(position, signal, reclaimMaterial)
      const after = this.bot.blockAt(position)
      if (!after || after.boundingBox === 'empty') return true
      if (attempt === 0) {
        console.warn(`Build target ${position} restored ${after.name} after cleanup; clearing it once more`)
      }
    }
    return false
  }

  canRaiseAboveGround(blocks, baseY) {
    const baseCollisions = []
    for (const entry of blocks) {
      if (this.buildPhase(entry) === 2) continue
      if (entry.position.y !== baseY) continue
      const current = this.bot.blockAt(entry.position)
      if (!current || this.matchesEntry(current, entry) || this.executor.canClearBuildObstruction(current)) continue
      baseCollisions.push(current)
    }
    return baseCollisions.length > 0 && baseCollisions.every((block) => this.validBuildGround(block))
  }

  footprintColumns(action, blueprint) {
    const anchor = this.anchor(action, blueprint)
    const origin = new Vec3(blueprint.anchor?.x || 0, 0, blueprint.anchor?.z || 0)
    const columns = []
    for (let z = 0; z < blueprint.size.z; z += 1) {
      for (let x = 0; x < blueprint.size.x; x += 1) {
        const local = new Vec3(x, 0, z).minus(origin)
        const position = anchor.plus(this.rotate(local, action.facing || 'south'))
        columns.push(new Vec3(position.x, 0, position.z))
      }
    }
    return columns
  }

  validBuildGround(block) {
    if (!block || block.boundingBox === 'empty' || this.executor.isLiquid?.(block)) return false
    // A tree canopy, trunk, container, or workstation is not terrain, even when
    // its top happens to line up with the rest of the footprint.
    return !/(?:_leaves|_log|_wood|_stem|_hyphae|chest|barrel|crafting_table|furnace|shulker_box)$/.test(block.name)
  }

  cachedBlockAt(position, cache) {
    if (!cache) return this.bot.blockAt(position)
    const key = position.toString()
    if (!cache.has(key)) cache.set(key, this.bot.blockAt(position))
    return cache.get(key)
  }

  flatSiteFloor(action, blueprint, cache = null) {
    if (!blueprint.size || !Number.isInteger(blueprint.size.x) || !Number.isInteger(blueprint.size.z)) return null
    const aroundY = Math.floor(action.y)
    const columns = this.footprintColumns(action, blueprint)
    const surfaces = []
    for (const column of columns) {
      let surface = null
      for (let y = aroundY + 3; y >= aroundY - 4; y -= 1) {
        const block = this.cachedBlockAt(new Vec3(column.x, y, column.z), cache)
        if (!block) return null
        if (block.boundingBox !== 'empty' && !this.executor.isLiquid?.(block)) {
          if (!this.validBuildGround(block)) return null
          surface = y
          break
        }
      }
      if (surface === null) return null
      surfaces.push(surface)
    }
    const lowest = Math.min(...surfaces)
    const highest = Math.max(...surfaces)
    if (lowest !== highest) return null
    const floorY = highest + 1
    for (const column of columns) {
      for (let y = floorY; y < floorY + 4; y += 1) {
        const block = this.cachedBlockAt(new Vec3(column.x, y, column.z), cache)
        if (!block || !this.executor.canClearBuildObstruction(block)) return null
      }
    }
    return floorY
  }

  nearbySiteOffsets(radius, step = 4) {
    const offsets = [{ dx: 0, dz: 0, distance: 0 }]
    for (let dx = -radius; dx <= radius; dx += step) {
      for (let dz = -radius; dz <= radius; dz += step) {
        if (dx === 0 && dz === 0) continue
        if ((dx * dx) + (dz * dz) > radius * radius) continue
        offsets.push({ dx, dz, distance: Math.hypot(dx, dz) })
      }
    }
    return offsets.sort((a, b) => a.distance - b.distance || a.dx - b.dx || a.dz - b.dz)
  }

  findNearestFlatBuildSite(action, blueprint) {
    const radius = this.executor.limits?.buildSiteSearchRadius ?? 24
    if (radius < 4 || !blueprint.size) return null
    const directions = ['north', 'east', 'south', 'west']
    const preferredIndex = directions.indexOf(action.facing || 'south')
    const facings = [
      directions[preferredIndex],
      directions[(preferredIndex + 1) % 4],
      directions[(preferredIndex + 3) % 4],
      directions[(preferredIndex + 2) % 4]
    ]
    const surveyCache = new Map()
    for (const offset of this.nearbySiteOffsets(radius)) {
      for (const facing of facings) {
        if (offset.distance === 0 && facing === action.facing) continue
        const candidate = {
          ...action, facing,
          x: Math.floor(action.x) + offset.dx,
          z: Math.floor(action.z) + offset.dz
        }
        const floorY = this.flatSiteFloor(candidate, blueprint, surveyCache)
        if (floorY === null) continue
        candidate.y = floorY
        try {
          this.preflightBuildSite(this.layout(candidate, blueprint))
          console.log(
            `Selected nearest flat ${action.schematic} site at ${candidate.x}, ${candidate.y}, ${candidate.z}, ` +
            `facing ${candidate.facing} (${Math.round(offset.distance)} blocks from requested anchor)`
          )
          return candidate
        } catch {}
      }
    }
    return null
  }

  buildApproaches(action, blueprint) {
    const floorY = Math.floor(action.y)
    const footprint = this.footprintColumns(action, blueprint)
    const xs = footprint.map((position) => position.x)
    const zs = footprint.map((position) => position.z)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minZ = Math.min(...zs)
    const maxZ = Math.max(...zs)
    const candidates = []
    const seen = new Set()
    const add = (x, z, outside) => {
      const position = new Vec3(x, floorY, z)
      const key = position.toString()
      if (seen.has(key)) return
      seen.add(key)
      const below = this.bot.blockAt(position.offset(0, -1, 0))
      const feet = this.bot.blockAt(position)
      const head = this.bot.blockAt(position.offset(0, 1, 0))
      if (!this.validBuildGround(below) || !feet || !head) return
      if (!this.executor.canClearBuildObstruction(feet) || !this.executor.canClearBuildObstruction(head)) return
      candidates.push({ position, outside })
    }
    for (let x = minX - 1; x <= maxX + 1; x += 1) {
      add(x, minZ - 1, true)
      add(x, maxZ + 1, true)
    }
    for (let z = minZ; z <= maxZ; z += 1) {
      add(minX - 1, z, true)
      add(maxX + 1, z, true)
    }
    // An excavated plot may have an unwalkable retaining wall directly around
    // it. In that case, entering the still-empty footprint is a safe fallback.
    for (const position of footprint) add(position.x, position.z, false)
    return candidates.sort((a, b) =>
      Number(b.outside) - Number(a.outside) ||
      this.bot.entity.position.distanceTo(a.position) - this.bot.entity.position.distanceTo(b.position)
    ).map((candidate) => candidate.position)
  }

  async walkToBuildSite(action, blueprint, signal, established = false) {
    const current = this.bot.entity.position.floored()
    const footprint = this.footprintColumns(action, blueprint)
    const xs = footprint.map((position) => position.x)
    const zs = footprint.map((position) => position.z)
    const insideEstablishedSite = current.x >= Math.min(...xs) - 1 && current.x <= Math.max(...xs) + 1 &&
      current.z >= Math.min(...zs) - 1 && current.z <= Math.max(...zs) + 1 &&
      current.y >= Math.floor(action.y) && current.y <= Math.floor(action.y) + (blueprint.size?.y || 1) + 1
    // A resumed builder may be standing safely on an upper floor or tracked
    // scaffold inside completed exterior walls. Forcing it back to the initial
    // ground-level edge can be impossible and adds no safety value.
    if (established && insideEstablishedSite) return current

    const approaches = this.buildApproaches(action, blueprint)
    let failure = null
    for (const position of approaches.slice(0, 12)) {
      if (this.bot.entity.position.distanceTo(position) <= 1.5) return position
      try {
        await this.executor.gotoBounded(
          new goals.GoalNear(position.x, position.y, position.z, 1),
          signal,
          this.executor.limits?.pathSearchRadius || 32
        )
        return position
      } catch (error) {
        if (error.name === 'AbortError') throw error
        failure = error
      }
    }
    throw new Error(`could not walk to a safe edge of the selected build site${failure ? `: ${failure.message}` : ''}`)
  }

  resolveBuildPlacement(action, blueprint) {
    const blocks = this.layout(action, blueprint)
    try {
      this.preflightBuildSite(blocks)
      return action
    } catch (original) {
      const baseY = Math.floor(action.y)
      let failure = original
      if (this.canRaiseAboveGround(blocks, baseY)) {
        const raised = { ...action, y: baseY + 1 }
        try {
          this.preflightBuildSite(this.layout(raised, blueprint))
          console.log(`Build site surface occupies Y ${baseY}; raised ${action.schematic} floor to Y ${raised.y}`)
          return raised
        } catch (raisedFailure) {
          failure = raisedFailure
        }
      }
      // Never relocate a partially built structure. Existing matching blocks
      // identify an intentional anchor that must remain resumable in place.
      if (blocks.some((entry) => this.matchesEntry(this.bot.blockAt(entry.position), entry))) throw failure
      const nearby = this.findNearestFlatBuildSite(action, blueprint)
      if (nearby) return nearby
      throw failure
    }
  }

  async build(action, signal, rootTask, onProgress) {
    const blueprint = this.loader.load(action.schematic)
    const requestedY = Math.floor(action.y)
    const resolved = this.savedPartialBuild(action, blueprint) || this.resolveBuildPlacement(action, blueprint)
    // Keep the plan/checkpoint action object synchronized with a surveyed or
    // resumed anchor. A restart must not survey a new site beside partial work.
    Object.assign(action, resolved)
    const facing = action.facing || 'south'
    const anchor = this.anchor(action, blueprint)
    const forward = FACING_VECTOR[facing]
    const staging = anchor.minus(forward.scaled(2))
    this.rememberStructure(action)
    const { blocks, remaining, alreadyPlaced } = this.audit(action, blueprint)
    const pending = this.pendingPlacements(blocks)
    const deferredPlacements = new Map()
    const deferredPockets = []
    const buildApproach = await this.walkToBuildSite(action, blueprint, signal, alreadyPlaced > 0)
    const task = rootTask.child('build', `build ${action.schematic}`, { placed: alreadyPlaced, total: blocks.length })
    task.start()
    const materials = {}
    const requiredNames = new Set(blocks.flatMap((entry) =>
      [entry.block, entry.material].filter((name) => name && name !== 'any_planks')
    ))
    const unavailableOptional = new Set()
    const skippedOptional = {}
    const unreachableRequired = []
    let activePhase = -1
    const scaffolds = new Map()
    const expectedAt = new Map(blocks.map((entry) => [entry.position.toString(), entry]))
    const footprint = this.footprintColumns(action, blueprint)
    const xs = footprint.map((position) => position.x)
    const zs = footprint.map((position) => position.z)
    const topY = Math.floor(action.y) + Math.max(0, (blueprint.size?.y || 1) - 1)
    for (let y = Math.floor(action.y); y <= topY; y += 1) {
      for (let x = Math.min(...xs); x <= Math.max(...xs); x += 1) {
        for (let z = Math.min(...zs); z <= Math.max(...zs); z += 1) {
          const position = new Vec3(x, y, z)
          const block = this.bot.blockAt(position)
          const expected = expectedAt.get(position.toString())
          if (block && SCAFFOLD_BLOCKS.has(block.name) && (!expected || !this.matchesEntry(block, expected))) {
            scaffolds.set(position.toString(), position)
          }
        }
      }
    }
    const movements = this.bot.pathfinder.movements
    const previousTower = movements.allow1by1towers
    const previousScaffolds = [...movements.scafoldingBlocks]
    const scaffold = this.executor.scaffoldItem()
    if (scaffold) {
      if (!movements.scafoldingBlocks.includes(scaffold.type)) movements.scafoldingBlocks.push(scaffold.type)
      movements.allow1by1towers = true
    }
    const trackScaffold = (oldBlock, newBlock) => {
      if (newBlock && SCAFFOLD_BLOCKS.has(newBlock.name) && this.bot.pathfinder.isBuilding?.()) {
        scaffolds.set(newBlock.position.toString(), newBlock.position.clone())
      }
    }
    this.bot.on('blockUpdate', trackScaffold)
    let buildCompleted = false
    try {
      for (const entry of pending) {
        if (signal.aborted) throw Object.assign(new Error('Task cancelled'), { name: 'AbortError' })
        task.detail.current = {
          block: entry.block || entry.material,
          x: entry.position.x,
          y: entry.position.y,
          z: entry.position.z
        }
        const phase = this.buildPhase(entry)
        if (phase !== activePhase) {
          activePhase = phase
          task.detail.phase = ['structure', 'functional blocks', 'optional decor'][phase]
          onProgress?.(task)
        }
        const position = entry.position
        let current = this.bot.blockAt(position)
        if (this.matchesEntry(current, entry) && !entry.repairCoupled && !scaffolds.has(position.toString())) {
          task.detail.placed += entry.progressCredit || 1
          remaining[entry.material] = Math.max(0,
            (remaining[entry.material] || this.entryItemCount(entry)) - this.entryItemCount(entry))
          continue
        }
        if (phase === 2 && unavailableOptional.has(entry.material)) {
          skippedOptional[entry.material] = (skippedOptional[entry.material] || 0) + 1
          continue
        }
        const deferredKey = position.toString()
        if (!deferredPlacements.has(deferredKey) &&
            nearDeferredBuildPocket(position, phase, deferredPockets)) {
          deferredPlacements.set(deferredKey, 1)
          pending.push(entry)
          console.warn(
            `Deferred nearby ${entry.block || entry.material} at ${position} with an inaccessible build pocket`
          )
          continue
        }
        // Verify supplies before walking to and dismantling a scaffold at the
        // destination. The exception is a block of the required material in
        // the wrong state (for example, a bottom slab where a top slab is
        // required): reclaiming it can provide the item needed for replacement.
        const currentCanSupply = current && current.boundingBox !== 'empty' && (
          current.name === entry.material || current.name === entry.block ||
          (entry.material === 'any_planks' && current.name.endsWith('_planks'))
        )
        let available = null
        if (!currentCanSupply) {
          available = await this.ensureBuildSupply(
            entry.material, remaining[entry.material] || 1, signal, phase === 2,
            this.entryItemCount(entry)
          )
          if (available <= 0) {
            unavailableOptional.add(entry.material)
            skippedOptional[entry.material] = (skippedOptional[entry.material] || 0) + 1
            continue
          }
        }
        // A door or bed cannot have one half placed independently. Clear its
        // generated partner first, then place the owner half once so Minecraft
        // recreates the complete object with consistent state.
        for (const coupledPosition of entry.coupledPositions || []) {
          const coupled = this.bot.blockAt(coupledPosition)
          if (coupled && coupled.boundingBox !== 'empty') {
            await this.clearBuildPosition(coupledPosition, signal, requiredNames.has(coupled.name))
          }
        }
        current = this.bot.blockAt(position)
        if (current && current.boundingBox !== 'empty') {
          const wasTemporaryScaffold = scaffolds.delete(position.toString())
          const reclaimed = wasTemporaryScaffold || requiredNames.has(current.name)
          await this.clearBuildPosition(position, signal, reclaimed)
        }
        const cleared = this.bot.blockAt(position)
        if (!cleared || cleared.boundingBox !== 'empty') {
          if (phase === 2) {
            skippedOptional[entry.material] = (skippedOptional[entry.material] || 0) + 1
            continue
          }
          throw new Error(`build site is obstructed by ${current?.name || 'unloaded terrain'} at ${position}`)
        }
        available ??= await this.ensureBuildSupply(
          entry.material, remaining[entry.material] || 1, signal, phase === 2,
          this.entryItemCount(entry)
        )
        if (available <= 0) {
          unavailableOptional.add(entry.material)
          skippedOptional[entry.material] = (skippedOptional[entry.material] || 0) + 1
          continue
        }
        const blockName = entry.material === 'any_planks'
          ? this.bot.inventory.items().filter((item) => item.name.endsWith('_planks')).sort((a, b) => b.count - a.count)[0]?.name
          : (materials[entry.material] ||= this.concreteMaterial(entry.material))
        if (!blockName) throw new Error(`ran out of ${entry.material} while building`)
        const below = this.bot.blockAt(position.offset(0, -1, 0))
        if (entry.y === 0 && (!below || below.boundingBox === 'empty')) {
          await this.executor.repairStairFloor(position.offset(0, -1, 0), signal)
        }
        try {
          await this.executor.place({
            type: 'place', block: blockName, x: position.x, y: position.y, z: position.z,
            expectedBlock: entry.block || blockName,
            verifyState: true,
            buildBounds: {
              minX: Math.min(...xs), maxX: Math.max(...xs),
              minZ: Math.min(...zs), maxZ: Math.max(...zs),
              baseY: Math.floor(action.y), topY
            },
            trackTemporaryScaffold: (scaffoldPosition) => {
              scaffolds.set(scaffoldPosition.toString(), scaffoldPosition.clone())
            },
            untrackTemporaryScaffold: (scaffoldPosition) => {
              scaffolds.delete(scaffoldPosition.toString())
            },
            ...(entry.properties ? { properties: entry.properties } : {})
          }, signal)
        } catch (error) {
          const key = position.toString()
          const attempts = deferredPlacements.get(key) || 0
          if (isDeferrableBuildNavigation(error) && attempts < 2) {
            deferredPlacements.set(key, attempts + 1)
            if (attempts === 0) deferredPockets.push({ position: position.clone(), phase })
            pending.push(entry)
            console.warn(
              `Deferred ${entry.block || blockName} at ${position} after inaccessible placement; ` +
              `will retry after other build work`
            )
            continue
          }
          if (isDeferrableBuildNavigation(error)) {
            if (phase === 2) {
              skippedOptional[entry.material] = (skippedOptional[entry.material] || 0) + 1
              console.warn(`Skipped inaccessible optional ${entry.block || blockName} at ${position}`)
            } else {
              unreachableRequired.push({
                block: entry.block || blockName,
                position: position.clone()
              })
              console.warn(
                `Could not reach required ${entry.block || blockName} at ${position}; ` +
                `continuing with the rest of the build`
              )
            }
            continue
          }
          throw error
        }
        task.detail.placed += entry.progressCredit || 1
        remaining[entry.material] = Math.max(0,
          (remaining[entry.material] || this.entryItemCount(entry)) - this.entryItemCount(entry))
        if (task.detail.placed % 8 === 0 || task.detail.placed === task.detail.total) onProgress?.(task)
      }
      if (unreachableRequired.length) {
        task.detail.unreachable = unreachableRequired.map(({ block, position }) => ({
          block, x: position.x, y: position.y, z: position.z
        }))
        onProgress?.(task)
        const examples = unreachableRequired.slice(0, 5)
          .map(({ block, position }) => `${block} at ${position}`)
          .join(', ')
        const error = new Error(
          `build access blocked for ${unreachableRequired.length} required placement` +
          `${unreachableRequired.length === 1 ? '' : 's'} after completing all reachable work; ${examples}` +
          `${unreachableRequired.length > 5 ? `, and ${unreachableRequired.length - 5} more` : ''}`
        )
        error.category = 'build_access'
        throw error
      }
      const skippedCount = Object.values(skippedOptional).reduce((total, count) => total + count, 0)
      task.detail.skippedOptional = skippedOptional
      task.complete(`placed ${task.detail.placed}/${task.detail.total}; skipped ${skippedCount} optional`)
      buildCompleted = true
      const skipped = Object.entries(skippedOptional)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([item, count]) => `${count} ${item}`)
        .join(', ')
      return skipped
        ? `Built ${action.schematic} at Y ${action.y}; optional decor still needed: ${skipped}`
        : `Built ${action.schematic} at Y ${action.y} with ${task.detail.placed} blocks${action.y !== requestedY ? ' after raising it above the terrain' : ''}`
    } catch (error) {
      task.fail(error)
      throw error
    } finally {
      this.bot.off('blockUpdate', trackScaffold)
      movements.allow1by1towers = previousTower
      movements.scafoldingBlocks.splice(0, movements.scafoldingBlocks.length, ...previousScaffolds)
      // Keep access scaffolds in place while a build is paused or fails. A
      // player would not dismantle the route merely because one placement or
      // supply step needs attention, and doing so moves the bot away from its
      // resumable work. The next audit recognizes these scaffolds, and the
      // successful final pass removes them all.
      if (!signal.aborted && buildCompleted && scaffolds.size) {
        try {
          await this.executor.returnFromTreeAndRecoverScaffolds(buildApproach || staging, scaffolds, signal)
        } catch (error) {
          console.warn(`Could not recover all build scaffolding: ${error.message}`)
        }
      }
      if (buildCompleted) this.executor.landmarks?.forget('active_build_access')
    }
  }
}

module.exports = { BlueprintTask, isDeferrableBuildNavigation, nearDeferredBuildPocket }
