'use strict'

const { Vec3 } = require('vec3')
const { AcquireItemTask } = require('./acquire-item-task')
const { goals } = require('mineflayer-pathfinder')
const { isRecoverableScaffold } = require('../controller/scaffold-policy')

const FACING_VECTOR = {
  north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1),
  east: new Vec3(1, 0, 0), west: new Vec3(-1, 0, 0)
}
const SCAFFOLD_BLOCKS = { has: isRecoverableScaffold }
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
const FALLING_BUILD_BLOCKS = /(?:^|_)(?:sand|gravel|concrete_powder|anvil)$/

function isDeferrableBuildNavigation(error) {
  return /no player-reachable placement stance|no path to the goal|placement-aware approach.*failed|cannot (?:reach|clear) (?:staircase break|build obstruction)|scaffold placement failed/i
    .test(String(error?.message || error))
}

function isDeferrableBuildPlacement(error) {
  return isDeferrableBuildNavigation(error) ||
    /blockupdate.*did not fire|schematic placement mismatch|placement context .*target=|(?:tool selection|digging).*timed out/i
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
    if (expectedBlock?.endsWith('_button') || expectedBlock === 'lever') strictProperties.add('face')
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

  buildCellIsEmpty(block) {
    return !block || ['air', 'cave_air', 'void_air'].includes(block.name)
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

  auditScaffoldCleanup(blocks, scaffolds) {
    const protectedPositions = new Set(blocks.map((entry) => entry.position.toString()))
    // The ledger includes exterior ramps as well as supports inside the house.
    // Inspect highest first, comparing coordinates against the rotated layout.
    // Even a wrong-state schematic block belongs to repair, never demolition.
    const ordered = [...scaffolds.values()].sort((a, b) => b.y - a.y)
    for (const position of ordered) {
      const key = position.toString()
      const current = this.bot.blockAt(position)
      if (protectedPositions.has(key) || (current && !SCAFFOLD_BLOCKS.has(current.name))) {
        scaffolds.delete(key)
      }
    }
    return (position) => protectedPositions.has(position.toString())
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
    const terrain = new Set(['dirt', 'grass_block', 'stone', 'sand', 'gravel', 'podzol', 'coarse_dirt', 'bedrock'])
    const structuralEvidence = audit.blocks.filter((entry) =>
      !terrain.has(entry.block || entry.material) && this.matchesEntry(this.bot.blockAt(entry.position), entry)
    ).length
    if (structuralEvidence < minimumEvidence || audit.alreadyPlaced === audit.blocks.length) return null
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
    const scaffolds = this.executor.landmarks?.get(`build_scaffolds_${action.schematic}`)
    if (audit.alreadyPlaced === audit.blocks.length && !scaffolds?.positions?.length) {
      return `${action.schematic} is already complete`
    }
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

  buildSpatialCompare(a, b) {
    const positionA = a.position || a
    const positionB = b.position || b
    if (positionA.z !== positionB.z) return positionA.z - positionB.z
    // Sweep alternate rows in opposite directions. This avoids walking back
    // across the full footprint at every row boundary while remaining stable
    // and predictable across reconnects.
    const direction = Math.abs(positionA.z) % 2 === 0 ? 1 : -1
    return direction * (positionA.x - positionB.x)
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

  pendingPlacements(blocks, resumeY = null) {
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
    return pending.sort((a, b) => {
      const phaseA = this.buildPhase(a)
      const phaseB = this.buildPhase(b)
      const optionalA = Number(phaseA === 2)
      const optionalB = Number(phaseB === 2)
      // Build required components like a player: finish the supports and
      // usable fixtures on one level before climbing to the next. Building
      // the complete shell first can seal the ground floor before its doors,
      // trapdoors, buttons, and lighting are installed. Optional decoration
      // remains a final pass and can never block structural completion.
      const resumeDistanceA = Number.isFinite(resumeY) ? Math.abs(a.position.y - resumeY) : 0
      const resumeDistanceB = Number.isFinite(resumeY) ? Math.abs(b.position.y - resumeY) : 0
      return optionalA - optionalB || resumeDistanceA - resumeDistanceB || a.y - b.y || phaseA - phaseB ||
        Number(occupiesBot(a)) - Number(occupiesBot(b)) ||
        this.buildPlacementRank(a) - this.buildPlacementRank(b) ||
        this.buildSpatialCompare(a, b)
    })
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
      if (this.buildCellIsEmpty(current)) return true
      await this.executor.clearBuildObstruction(position, signal, reclaimMaterial)
      const after = this.bot.blockAt(position)
      if (this.buildCellIsEmpty(after)) return true
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
    // Re-audit and retry after useful work changed the house. Never ask the
    // LLM to rediscover a deterministic blueprint, or loop forever without
    // reducing the verified remaining work.
    let previousRemaining = Infinity
    for (let pass = 1; pass <= 3; pass += 1) {
      try {
        return await this.buildPass(action, signal, rootTask, onProgress)
      } catch (error) {
        if (signal.aborted || error.name === 'AbortError' || error.category !== 'build_incomplete') throw error
        const audit = this.audit(action)
        const remaining = audit.blocks.length - audit.alreadyPlaced
        if (pass === 3 || remaining >= previousRemaining) throw error
        previousRemaining = remaining
        this.executor.blockTracker?.clearUnreachable?.()
        console.log(`Build verification: ${audit.alreadyPlaced}/${audit.blocks.length}; starting repair pass ${pass + 1}`)
      }
    }
  }

  async buildPass(action, signal, rootTask, onProgress) {
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
    // A new structure is still built bottom-up. On a resumed structure, start
    // on the floor where the bot is already standing and fan out to adjacent
    // floors. This avoids climbing down through a nearly complete shell for a
    // low fixture, then immediately rebuilding another route to the roof.
    const pending = this.pendingPlacements(
      blocks, alreadyPlaced > 0 ? this.bot.entity.position.floored().y : null
    )
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
    const unresolvedRequired = []
    const blockedBuildSupplies = new Map()
    let activePhase = -1
    const scaffolds = new Map()
    const scaffoldLedgerName = `build_scaffolds_${action.schematic}`
    const queuedAccessRepairs = new Set()
    const accessOpenings = new Map()
    const expectedAt = new Map(blocks.map((entry) => [entry.position.toString(), entry]))
    const footprint = this.footprintColumns(action, blueprint)
    const xs = footprint.map((position) => position.x)
    const zs = footprint.map((position) => position.z)
    const topY = Math.floor(action.y) + Math.max(0, (blueprint.size?.y || 1) - 1)
    const savedScaffolds = this.executor.landmarks?.get(scaffoldLedgerName)
    const savedLedgerMatches = savedScaffolds?.type === 'build_scaffolds' &&
      savedScaffolds.schematic === action.schematic &&
      savedScaffolds.x === Math.floor(action.x) && savedScaffolds.y === Math.floor(action.y) &&
      savedScaffolds.z === Math.floor(action.z) &&
      (!savedScaffolds.facing || savedScaffolds.facing === facing) &&
      (!savedScaffolds.dimension || savedScaffolds.dimension === this.bot.game?.dimension)
    if (savedLedgerMatches) {
      for (const point of savedScaffolds.positions || []) {
        if (![point?.x, point?.y, point?.z].every(Number.isFinite)) continue
        const position = new Vec3(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z))
        const block = this.bot.blockAt(position)
        const expected = expectedAt.get(position.toString())
        if (!block || (SCAFFOLD_BLOCKS.has(block.name) && (!expected || !this.matchesEntry(block, expected)))) {
          scaffolds.set(position.toString(), position)
        }
      }
    }
    // Only persisted bot placements are owned supports. Inferring ownership
    // from stone/dirt in the schematic's empty cells can excavate a fresh
    // site's terrain or a player's landscaping during final cleanup.
    // The access landmark predates the scaffold ledger and may include an
    // exterior staircase outside the schematic footprint. Its route records
    // player foot cells; the temporary support is directly beneath each one.
    const access = this.executor.landmarks?.get('active_build_access')
    const sameAccessSite = (!access?.dimension || access.dimension === this.bot.game?.dimension) &&
      access?.x >= Math.min(...xs) - 16 && access?.x <= Math.max(...xs) + 16 &&
      access?.z >= Math.min(...zs) - 16 && access?.z <= Math.max(...zs) + 16 &&
      access?.y >= action.y - 1 && access?.y <= topY + 2
    for (const point of sameAccessSite ? access.route || [] : []) {
      if (![point?.x, point?.y, point?.z].every(Number.isFinite)) continue
      const position = new Vec3(Math.floor(point.x), Math.floor(point.y) - 1, Math.floor(point.z))
      const block = this.bot.blockAt(position)
      const expected = expectedAt.get(position.toString())
      if (block && SCAFFOLD_BLOCKS.has(block.name) && (!expected || !this.matchesEntry(block, expected))) {
        scaffolds.set(position.toString(), position)
      }
    }
    const persistScaffolds = () => {
      if (!this.executor.landmarks) return
      if (!scaffolds.size) {
        this.executor.landmarks.forget(scaffoldLedgerName)
        return
      }
      this.executor.landmarks.remember(
        scaffoldLedgerName, anchor, this.bot.game?.dimension, 'build_scaffolds', {
          schematic: action.schematic, facing,
          positions: [...scaffolds.values()].map(({ x, y, z }) => ({ x, y, z }))
        }
      )
    }
    persistScaffolds()
    const handlePlacementFailure = (entry, position, phase, blockName, error) => {
      const key = position.toString()
      const attempts = deferredPlacements.get(key) || 0
      const navigationFailure = isDeferrableBuildNavigation(error)
      const transientPlacementFailure = !navigationFailure && isDeferrableBuildPlacement(error)
      const resourceFailure = /missing build supply|restocking .* timed out/i.test(String(error?.message || error))
      if (!navigationFailure && !transientPlacementFailure && !resourceFailure) return false
      if (attempts < 2) {
        deferredPlacements.set(key, attempts + 1)
        if (navigationFailure && attempts === 0) deferredPockets.push({ position: position.clone(), phase })
        pending.push(entry)
        console.warn(
          `Deferred ${entry.block || blockName} at ${position} after ` +
          `${resourceFailure ? 'unavailable material' : navigationFailure ? 'inaccessible' : 'unconfirmed'} placement; ` +
          `will retry after other build work`
        )
        return true
      }
      if (phase === 2) {
        skippedOptional[entry.material] = (skippedOptional[entry.material] || 0) + 1
        console.warn(`Skipped unresolved optional ${entry.block || blockName} at ${position}`)
      } else {
        unresolvedRequired.push({
          block: entry.block || blockName,
          position: position.clone(),
          reason: resourceFailure ? 'material unavailable' : navigationFailure ? 'unreachable' : 'placement not confirmed'
        })
        console.warn(
          `Could not finish required ${entry.block || blockName} at ${position}; ` +
          `continuing with the rest of the build`
        )
      }
      return true
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
        persistScaffolds()
      } else if (oldBlock?.position && newBlock &&
                 !SCAFFOLD_BLOCKS.has(newBlock.name) && scaffolds.delete(oldBlock.position.toString())) {
        persistScaffolds()
      }
    }
    this.bot.on('blockUpdate', trackScaffold)
    let buildCompleted = false
    try {
      // A bottom slab can leave the pathfinder start node embedded in a
      // collision shape. Reclaim only a blueprint-owned slab over a full
      // solid block: the bot settles half a block onto that support. Restore
      // the exact slab at the end, after the work area has been left.
      const feet = this.bot.entity.position.floored()
      const feetBlock = this.bot.blockAt(feet)
      const floor = this.bot.blockAt(feet.offset(0, -1, 0))
      const expectedFeet = expectedAt.get(feet.toString())
      if (expectedFeet && this.matchesEntry(feetBlock, expectedFeet) &&
          feetBlock.name.endsWith('_slab') && feetBlock.getProperties?.().type === 'bottom' &&
          floor?.shapes?.some((shape) => shape[0] === 0 && shape[1] === 0 && shape[2] === 0 &&
            shape[3] === 1 && shape[4] === 1 && shape[5] === 1) && !this.executor.isLiquid(floor)) {
        if (await this.clearBuildPosition(feet, signal, true)) {
          pending.push({ ...expectedFeet, progressCredit: 1 })
          queuedAccessRepairs.add(feet.toString())
          console.log(`Reclaimed starting slab at ${feet} for full-block footing; queued its restoration`)
        }
      }
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
        if (this.matchesEntry(current, entry)) queuedAccessRepairs.delete(position.toString())
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
        const currentCanSupply = !this.buildCellIsEmpty(current) && (
          current.name === entry.material || current.name === entry.block ||
          (entry.material === 'any_planks' && current.name.endsWith('_planks'))
        )
        let available = null
        if (!currentCanSupply) {
          try {
            const blockedAt = blockedBuildSupplies.get(entry.material)
            if (blockedAt && this.acquire.count(entry.material) < this.entryItemCount(entry) &&
                this.bot.entity.position.distanceTo(blockedAt) <= 4) {
              throw new Error(`missing build supply ${entry.material}; storage is unreachable from this work area`)
            }
            available = await this.ensureBuildSupply(
              entry.material, remaining[entry.material] || 1, signal, phase === 2,
              this.entryItemCount(entry)
            )
            blockedBuildSupplies.delete(entry.material)
          } catch (error) {
            if (error.name === 'AbortError') throw error
            if (/missing build supply|restocking .* timed out/i.test(error.message)) {
              blockedBuildSupplies.set(entry.material, this.bot.entity.position.clone())
            }
            if (handlePlacementFailure(entry, position, phase, entry.block || entry.material, error)) continue
            throw error
          }
          if (available <= 0) {
            unavailableOptional.add(entry.material)
            skippedOptional[entry.material] = (skippedOptional[entry.material] || 0) + 1
            continue
          }
        }
        // A door or bed cannot have one half placed independently. Clear its
        // generated partner first, then place the owner half once so Minecraft
        // recreates the complete object with consistent state.
        let preparationFailure = null
        try {
          for (const coupledPosition of entry.coupledPositions || []) {
            const coupled = this.bot.blockAt(coupledPosition)
            if (!this.buildCellIsEmpty(coupled)) {
              const cleared = await this.clearBuildPosition(
                coupledPosition, signal, requiredNames.has(coupled.name)
              )
              if (!cleared) throw new Error(`cannot clear build obstruction at ${coupledPosition}`)
            }
          }
          current = this.bot.blockAt(position)
          if (!this.buildCellIsEmpty(current)) {
            const wasTemporaryScaffold = scaffolds.delete(position.toString())
            if (wasTemporaryScaffold) persistScaffolds()
            const reclaimed = wasTemporaryScaffold || requiredNames.has(current.name)
            const cleared = await this.clearBuildPosition(position, signal, reclaimed)
            if (!cleared) throw new Error(`cannot clear build obstruction at ${position}`)
          }
        } catch (error) {
          if (error.name === 'AbortError') throw error
          preparationFailure = error
        }
        if (preparationFailure) {
          if (handlePlacementFailure(entry, position, phase, entry.block || entry.material, preparationFailure)) continue
          throw preparationFailure
        }
        const cleared = this.bot.blockAt(position)
        if (!this.buildCellIsEmpty(cleared)) {
          if (phase === 2) {
            skippedOptional[entry.material] = (skippedOptional[entry.material] || 0) + 1
            continue
          }
          throw new Error(`build site is obstructed by ${current?.name || 'unloaded terrain'} at ${position}`)
        }
        if (available == null) {
          try {
            available = await this.ensureBuildSupply(
              entry.material, remaining[entry.material] || 1, signal, phase === 2,
              this.entryItemCount(entry)
            )
          } catch (error) {
            if (error.name === 'AbortError') throw error
            if (/missing build supply|restocking .* timed out/i.test(error.message)) {
              blockedBuildSupplies.set(entry.material, this.bot.entity.position.clone())
            }
            if (handlePlacementFailure(entry, position, phase, entry.block || entry.material, error)) continue
            throw error
          }
        }
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
              persistScaffolds()
            },
            untrackTemporaryScaffold: (scaffoldPosition) => {
              scaffolds.delete(scaffoldPosition.toString())
              persistScaffolds()
            },
            openTemporaryBuildAccess: async (accessPosition) => {
              const key = accessPosition.toString()
              const expected = expectedAt.get(key)
              const currentAccessBlock = this.bot.blockAt(accessPosition)
              // Limit outstanding damage and prevent reopening the same wall
              // indefinitely after its repair has already been attempted.
              if (queuedAccessRepairs.size >= 8 || (accessOpenings.get(key) || 0) >= 2) return false
              if (!expected || this.buildPhase(expected) === 2 ||
                  FALLING_BUILD_BLOCKS.test(currentAccessBlock?.name || '') ||
                  !currentAccessBlock?.diggable ||
                  !this.matchesEntry(currentAccessBlock, expected)) return false
              const cleared = await this.clearBuildPosition(accessPosition, signal, true)
              if (!cleared) return false
              accessOpenings.set(key, (accessOpenings.get(key) || 0) + 1)
              if (!queuedAccessRepairs.has(key)) {
                queuedAccessRepairs.add(key)
                pending.push({ ...expected, progressCredit: 1 })
              }
              console.log(`Opened temporary build access at ${accessPosition}; queued blueprint repair`)
              return true
            },
            ...(entry.properties ? { properties: entry.properties } : {})
          }, signal)
        } catch (error) {
          if (handlePlacementFailure(entry, position, phase, blockName, error)) continue
          throw error
        }
        task.detail.placed += entry.progressCredit || 1
        queuedAccessRepairs.delete(position.toString())
        remaining[entry.material] = Math.max(0,
          (remaining[entry.material] || this.entryItemCount(entry)) - this.entryItemCount(entry))
        if (task.detail.placed % 8 === 0 || task.detail.placed === task.detail.total) {
          task.detail.placed = this.audit(action, blueprint).alreadyPlaced
          task.detail.accessRepairsRemaining = queuedAccessRepairs.size
          onProgress?.(task)
        }
      }
      // A deferred target can become correct through a coupled placement or
      // later repair. Report only failures still present in the actual world.
      for (let index = unresolvedRequired.length - 1; index >= 0; index -= 1) {
        const failed = unresolvedRequired[index]
        const expected = expectedAt.get(failed.position.toString())
        if (expected && this.matchesEntry(this.bot.blockAt(failed.position), expected)) unresolvedRequired.splice(index, 1)
      }
      task.detail.placed = this.audit(action, blueprint).alreadyPlaced
      task.detail.accessRepairsRemaining = queuedAccessRepairs.size
      onProgress?.(task)
      if (unresolvedRequired.length) {
        task.detail.unresolved = unresolvedRequired.map(({ block, position, reason }) => ({
          block, x: position.x, y: position.y, z: position.z, reason
        }))
        onProgress?.(task)
        const examples = unresolvedRequired.slice(0, 5)
          .map(({ block, position, reason }) => `${block} at ${position} (${reason})`)
          .join(', ')
        const error = new Error(
          `build could not finish ${unresolvedRequired.length} required placement` +
          `${unresolvedRequired.length === 1 ? '' : 's'} after completing all other work; ${examples}` +
          `${unresolvedRequired.length > 5 ? `, and ${unresolvedRequired.length - 5} more` : ''}`
        )
        error.category = 'build_incomplete'
        throw error
      }
      const protectPosition = this.auditScaffoldCleanup(blocks, scaffolds)
      persistScaffolds()
      if (scaffolds.size) {
        task.detail.phase = 'scaffold cleanup'
        task.detail.scaffoldsRemaining = scaffolds.size
        onProgress?.(task)
        for (let attempt = 0; attempt < 2 && scaffolds.size; attempt += 1) {
          if (attempt > 0) this.executor.blockTracker?.clearUnreachable?.()
          await this.executor.returnFromTreeAndRecoverScaffolds(buildApproach || staging, scaffolds, signal, {
            protectPosition, strictTopDown: true
          })
          persistScaffolds()
          task.detail.scaffoldsRemaining = scaffolds.size
          onProgress?.(task)
        }
        if (scaffolds.size) {
          const examples = [...scaffolds.values()].slice(0, 5).map(String).join(', ')
          const error = new Error(
            `scaffold cleanup could not reach ${scaffolds.size} temporary block` +
            `${scaffolds.size === 1 ? '' : 's'}; first locations: ${examples}`
          )
          error.category = 'build_cleanup'
          throw error
        }
      }
      const skippedCount = Object.values(skippedOptional).reduce((total, count) => total + count, 0)
      // Placement counters are estimates: gravity, dependent blocks and
      // temporary access can invalidate earlier work. Completion requires a
      // fresh world audit after every scaffold has been removed.
      const finalAudit = this.audit(action, blueprint)
      const missingRequired = finalAudit.blocks.filter((entry) =>
        this.buildPhase(entry) !== 2 && !this.matchesEntry(this.bot.blockAt(entry.position), entry)
      )
      task.detail.placed = finalAudit.alreadyPlaced
      if (missingRequired.length) {
        const error = new Error(`build verification found ${missingRequired.length} required blocks missing or in the wrong state after cleanup`)
        error.category = 'build_incomplete'
        throw error
      }
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
      // Keep the ledger and access route while paused or failed. Successful
      // completion is only reported after the dedicated cleanup pass empties
      // the ledger, so no temporary build blocks are silently abandoned.
      persistScaffolds()
      if (buildCompleted) {
        this.executor.landmarks?.forget('active_build_access')
        this.executor.landmarks?.forget(scaffoldLedgerName)
      }
    }
  }
}

module.exports = {
  BlueprintTask, isDeferrableBuildNavigation, isDeferrableBuildPlacement,
  nearDeferredBuildPocket
}
