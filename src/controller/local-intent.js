'use strict'

const { Vec3 } = require('vec3')
const { createPlanSchema } = require('./action-schema')
const { HOSTILE_MOBS, CONDITIONAL_HOSTILES } = require('./event-monitor')

const RESOURCES = new Set(['diamond', 'iron', 'copper', 'coal', 'gold', 'redstone'])
const TOOL_TYPES = ['pickaxe', 'axe', 'shovel', 'hoe']

function facingFromYaw(yaw = 0) {
  const vector = { x: -Math.sin(yaw), z: Math.cos(yaw) }
  if (Math.abs(vector.x) > Math.abs(vector.z)) return vector.x > 0 ? 'east' : 'west'
  return vector.z > 0 ? 'south' : 'north'
}

function directionVector(direction) {
  if (direction === 'north') return new Vec3(0, 0, -1)
  if (direction === 'east') return new Vec3(1, 0, 0)
  if (direction === 'west') return new Vec3(-1, 0, 0)
  return new Vec3(0, 0, 1)
}

function parseQuantityAndThing(raw) {
  let text = raw.trim().toLowerCase().replace(/[?.!]+$/g, '')
  let quantity = 1
  let match = text.match(/^(\d+)\s+(.+)$/)
  if (match) return { quantity: Math.max(1, Math.min(2304, Number(match[1]))), thing: match[2] }
  match = text.match(/^(?:(?:a|one)\s+)?stack(?:\s+of)?\s+(.+)$/)
  if (match) return { quantity: 64, thing: match[1] }
  text = text.replace(/^(?:a|an|some|the|my)\s+/, '')
  return { quantity, thing: text }
}

function singularize(name) {
  return name
    .replace(/pickaxes$/, 'pickaxe')
    .replace(/axes$/, 'axe')
    .replace(/shovels$/, 'shovel')
    .replace(/hoes$/, 'hoe')
    .replace(/diamonds$/, 'diamond')
    .replace(/ingots$/, 'ingot')
    .replace(/ores$/, 'ore')
    .replace(/torches$/, 'torch')
    .replace(/sticks$/, 'stick')
    .replace(/tables$/, 'table')
    .replace(/furnaces$/, 'furnace')
    .replace(/blocks$/, 'block')
}

function resolveItem(phrase, registry) {
  const cleaned = singularize(phrase.trim().toLowerCase())
  const aliases = {
    wood: 'any_log', log: 'any_log', logs: 'any_log', tree: 'any_log', trees: 'any_log',
    plank: 'any_planks', planks: 'any_planks', wooden_plank: 'any_planks', wooden_planks: 'any_planks',
    cobble: 'cobblestone', crafting_table: 'crafting_table', workbench: 'crafting_table'
  }
  const name = cleaned.replace(/[ -]+/g, '_').replace(/^minecraft:/, '')
  const resolved = aliases[name] || name
  if (['any_log', 'any_planks'].includes(resolved)) return resolved
  if (registry.itemsByName[resolved] || registry.blocksByName[resolved]) return resolved
  const candidates = [
    resolved.replace(/_logs$/, '_log'),
    resolved.replace(/_blocks$/, '_block'),
    resolved.replace(/_block$/, ''),
    resolved.replace(/s$/, '')
  ]
  for (const candidate of candidates) {
    if (registry.itemsByName[candidate] || registry.blocksByName[candidate]) return candidate
  }
  return null
}

function schematicFromGoal(goal, available) {
  const normalized = goal.toLowerCase().replace(/[_-]+/g, ' ')
  const exact = available.find((name) => normalized.includes(name.replace(/_/g, ' ')))
  if (exact) return exact
  if (available.length === 1 && /\b(?:house|home|schematic|blueprint|build)\b/.test(normalized)) return available[0]
  return null
}

class LocalIntentCompiler {
  constructor(bot, maxActions, blueprintLoader, maxTunnelLength = 1024, selection = null) {
    this.bot = bot
    this.schema = createPlanSchema(maxActions)
    this.blueprints = blueprintLoader
    this.maxTunnelLength = maxTunnelLength
    this.selection = selection
  }

  compile(rawGoal, requester) {
    const goal = rawGoal.trim().toLowerCase().replace(/\s+/g, ' ')
    const requesterYaw = this.bot.players?.[requester]?.entity?.yaw
    const direction = facingFromYaw(Number.isFinite(requesterYaw) ? requesterYaw : this.bot.entity.yaw)

    if (/^(?:hi|hello|hey|hiya|howdy)(?:\s+(?:bot|there))?[!.?]*$/.test(goal)) {
      return this.plan('Local greeting', [{ type: 'say', message: `Hi ${requester}!` }])
    }
    if (/^(?:thanks|thank you|ty)(?:\s+(?:bot|mate))?[!.?]*$/.test(goal)) {
      return this.plan('Local thanks response', [{ type: 'say', message: "You're welcome." }])
    }
    if (/^(?:who are you|what can you do)[?.!]*$/.test(goal)) {
      return this.plan('Local capability response', [{
        type: 'say',
        message: 'I can gather, craft, mine, build, farm, manage items, follow, and guard you.'
      }])
    }

    if (/^(?:please\s+)?(?:mine|break|dig)\s+(?:this|that)(?:\s+block)?[?.!]*$/.test(goal)) {
      const selected = this.selection?.selectedBlock(requester)?.block
      if (!selected) return this.plan('No selected block', [])
      return this.plan(`Mine selected ${selected.name}`, [{
        type: 'mine_block', x: selected.position.x, y: selected.position.y, z: selected.position.z
      }])
    }

    if (/^(?:please\s+)?(?:use|open|activate|press|toggle)\s+(?:this|that)(?:\s+(?:block|door|chest|button|lever))?[?.!]*$/.test(goal)) {
      const selected = this.selection?.selectedBlock(requester)?.block
      if (!selected) return this.plan('No selected block', [])
      return this.plan(`Interact with selected ${selected.name}`, [{
        type: 'interact_block', x: selected.position.x, y: selected.position.y, z: selected.position.z
      }])
    }

    if (/^(?:please\s+)?(?:attack|kill|fight)\s+(?:this|that)(?:\s+(?:mob|entity|monster))?[?.!]*$/.test(goal)) {
      const selected = this.selection?.selectedEntity(requester)
      if (!selected || selected.type === 'player') return this.plan('No selected non-player entity', [])
      return this.plan(`Attack selected ${selected.name || selected.type}`, [{ type: 'attack', entityId: selected.id }])
    }

    let locationMatch = goal.match(/^(?:remember|mark|save)(?: this| here)? as (?:my |the )?([a-z0-9_ -]{1,32})$/)
    if (!locationMatch) locationMatch = goal.match(/^this is (?:my |the )?([a-z0-9_ -]{1,32})$/)
    if (locationMatch) {
      const name = locationMatch[1].trim().replace(/[ -]+/g, '_')
      return this.plan(`Remember ${name}`, [{ type: 'remember_location', name }])
    }
    locationMatch = goal.match(/^(?:go|return|head|take me) (?:to )?(?:my |the )?([a-z0-9_ -]{1,32})$/)
    if (locationMatch) {
      const name = locationMatch[1].trim().replace(/[ -]+/g, '_')
      return this.plan(`Go to ${name}`, [{ type: 'go_to_location', name }])
    }
    if (/^(?:please\s+)?(?:return|go|get|head|take me) (?:back )?(?:up )?(?:to )?(?:the )?surface$/.test(goal) ||
        /^(?:please\s+)?(?:leave|exit|get out of) (?:the )?(?:mine|mineshaft|cave)$/.test(goal)) {
      return this.plan('Return to the surface', [{ type: 'return_to_surface' }])
    }

    const schematic = schematicFromGoal(goal, this.blueprints.list())
    if (schematic && /\b(?:repair|fix|restore|rebuild)\b/.test(goal)) {
      return this.plan(`Repair local schematic: ${schematic}`, [
        { type: 'repair_schematic', schematic }
      ], { type: 'action_sequence' })
    }
    if (schematic && /\b(?:build|construct|house|home|schematic|blueprint|materials?)\b/.test(goal)) {
      const wantsBuild = /\b(?:build|construct|make|place)\b/.test(goal) && !/\b(?:materials?|resources?)\s+(?:for|needed)\b/.test(goal)
      const explicitlyWantsMaterials = /\b(?:collect|gather|get|fetch|materials?|resources?)\b/.test(goal)
      const wantsMaterials = explicitlyWantsMaterials || (wantsBuild && this.schematicFitsInventory(schematic))
      const actions = []
      if (wantsMaterials) actions.push({ type: 'collect_build_materials', schematic })
      if (wantsBuild) {
        const anchor = this.bot.entity.position.floored().plus(directionVector(direction).scaled(2))
        actions.push({ type: 'build_schematic', schematic, x: anchor.x, y: anchor.y, z: anchor.z, facing: direction })
      }
      if (actions.length) return this.plan(`Local schematic task: ${schematic}`, actions, { type: 'action_sequence' })
    }

    let match = goal.match(/^(?:please\s+)?follow(?:\s+|\s+behind\s+)(me|[a-z0-9_]{1,32})$/i)
    if (match) {
      const player = match[1] === 'me' ? requester : match[1]
      return this.plan(`Following ${player}`, [{ type: 'follow', player }], { type: 'persistent' })
    }

    match = goal.match(/^(?:please\s+)?(?:guard|protect|defend)\s+(me|[a-z0-9_]{1,32})$/i)
    if (match) {
      const player = match[1] === 'me' ? requester : match[1]
      return this.plan(`Guarding ${player}`, [{ type: 'follow', player }], { type: 'persistent' })
    }

    match = goal.match(/^(?:please\s+)?(?:attack|kill|fight)\s+(?:the\s+)?(?:nearest\s+)?([a-z0-9_ ]+)$/i)
    if (match) {
      const requested = match[1].trim().replace(/\s+/g, '_')
        .replace(/zombies$/, 'zombie').replace(/skeletons$/, 'skeleton')
        .replace(/creepers$/, 'creeper').replace(/spiders$/, 'spider')
      const generic = ['mob', 'hostile', 'enemy', 'monster'].includes(requested)
      const candidates = Object.values(this.bot.entities)
        .filter((entity) => entity?.position && entity.type !== 'player' &&
          (generic
            ? HOSTILE_MOBS.has(entity.name) || CONDITIONAL_HOSTILES.has(entity.name)
            : entity.name === requested))
        .sort((a, b) => this.bot.entity.position.distanceTo(a.position) -
          this.bot.entity.position.distanceTo(b.position))
      if (candidates[0]) {
        return this.plan(`Attack ${candidates[0].name}`, [{ type: 'attack', entityId: candidates[0].id }])
      }
      return this.plan(`No visible ${requested}`, [])
    }

    match = goal.match(/^(?:please\s+)?(?:make|create|dig)\s+(?:a\s+)?(?:stairway|staircase|stairs)\s+(?:down\s+)?to\s+(?:y\s*)?(-?\d+)$/)
    if (match) {
      const y = Number(match[1])
      if (y >= -64 && y <= 320) {
        return this.plan(`Staircase to Y ${y}`, [{ type: 'staircase_to_y', y, direction }], { type: 'action_sequence' })
      }
    }

    match = goal.match(/^(?:please\s+)?(?:make|create|dig)\s+(?:a\s+)?(?:stairway|staircase|stairs)\s+(?:down\s+)?to\s+(?:the\s+)?(diamond|iron|copper|coal|gold|redstone)(?:\s+(?:level|depth))?$/)
    if (match) {
      return this.plan(`Staircase to ${match[1]} level`, [{
        type: 'staircase_to', target: match[1], direction
      }], { type: 'action_sequence' })
    }

    match = goal.match(/^(?:please\s+)?(?:create|start|make|dig)\s+(?:a\s+)?(?:strip|branch)[ -]?mine(?:\s+here)?\s+(?:and|then)\s+(?:get|mine|collect|find)\s+(\d+)\s+(diamonds?|iron|copper|coal|gold|redstone)$/)
    if (match) {
      const quantity = Math.min(64, Number(match[1]))
      const resource = singularize(match[2])
      return this.plan(`Mine ${quantity} ${resource}`, [{
        type: 'mine_resource', resource, quantity, direction, branchSpacing: 3, branchDepth: 16
      }], { type: 'resource_count', resource, quantity })
    }

    if (/^(?:please\s+)?(?:continue|resume|extend|keep(?:\s+going\s+with)?)\s+(?:the\s+)?(?:strip[ -]?min(?:e|ing)|branch[ -]?min(?:e|ing)|mining tunnel)/.test(goal)) {
      const lengthMatch = goal.match(/(?:for|by|another)\s+(\d+)\s+blocks?/) || goal.match(/\b(\d+)\s+blocks?\b/)
      const targetMatch = goal.match(/\b(diamond|iron|copper|coal|gold|redstone)s?\b/)
      const length = Math.min(this.maxTunnelLength, lengthMatch ? Number(lengthMatch[1]) : 64)
      return this.plan('Continue local strip mine', [{
        type: 'strip_mine', direction, length, target: targetMatch?.[1] || 'general',
        branchSpacing: 3, branchDepth: 16
      }], { type: 'action_sequence' })
    }

    match = goal.match(/^(?:please\s+)?(?:(?:start|make|create|dig)\s+)?(?:a\s+)?(?:strip|branch)[ -]?mine(?:\s+here)?(?:\s+(?:for|of))?\s+(\d+)\s+blocks?(?:\s+for\s+(diamond|iron|copper|coal|gold|redstone))?$/)
    if (match) {
      const length = Math.min(this.maxTunnelLength, Number(match[1]))
      return this.plan('Local strip-mine task', [{
        type: 'strip_mine', direction, length, target: match[2] || 'general', branchSpacing: 3, branchDepth: 16
      }], { type: 'action_sequence' })
    }

    match = goal.match(/^(?:please\s+)?(?:get|make|craft|acquire)\s+(?:me\s+)?(?:a\s+)?(wooden|stone|iron|diamond|netherite)\s+(?:set\s+of\s+)?tools?$/)
    if (match) {
      const material = match[1]
      const actions = TOOL_TYPES.map((tool) => ({ type: 'acquire_item', item: `${material}_${tool}`, quantity: 1 }))
      return this.plan(`Local ${material} tool-set task`, actions, { type: 'tool_set', material })
    }

    match = goal.match(/^(?:please\s+)?pick\s*up\s+(.+)$/)
    if (match) {
      const { quantity, thing } = parseQuantityAndThing(match[1])
      const item = resolveItem(thing, this.bot.registry)
      if (item && !item.startsWith('any_')) return this.plan(`Pick up ${item}`, [{ type: 'pickup', item, quantity: Math.min(64, quantity) }])
    }

    match = goal.match(/^(?:please\s+)?(?:put|deposit|store)\s+(.+?)\s+(?:in|into)\s+(?:the\s+)?(?:nearest\s+)?(?:chest|barrel|container)$/)
    if (match) {
      const { quantity, thing } = parseQuantityAndThing(match[1])
      const item = resolveItem(thing, this.bot.registry)
      if (item) return this.plan(`Deposit ${item}`, [{ type: 'deposit', item, quantity }])
    }

    match = goal.match(/^(?:please\s+)?(?:take|withdraw|get)\s+(.+?)\s+from\s+(?:the\s+)?(?:nearest\s+)?(?:chest|barrel|container)$/)
    if (match) {
      const { quantity, thing } = parseQuantityAndThing(match[1])
      const item = resolveItem(thing, this.bot.registry)
      if (item) return this.plan(`Withdraw ${item}`, [{ type: 'withdraw', item, quantity }])
    }

    match = goal.match(/^(?:please\s+)?drop\s+(.+)$/)
    if (match) {
      const { quantity, thing } = parseQuantityAndThing(match[1])
      const item = resolveItem(thing, this.bot.registry)
      if (item && !item.startsWith('any_')) return this.plan(`Drop ${item}`, [{ type: 'drop', item, quantity: Math.min(64, quantity) }])
    }

    match = goal.match(/^(?:please\s+)?give\s+(me|[a-z0-9_]{1,32})\s+(.+)$/i)
    if (match) {
      const player = match[1] === 'me' ? requester : match[1]
      const { quantity, thing } = parseQuantityAndThing(match[2])
      const item = resolveItem(thing, this.bot.registry)
      if (item && !item.startsWith('any_') && quantity <= 64) {
        return this.plan(`Acquire and give ${item}`, [
          { type: 'acquire_item', item, quantity }, { type: 'give', item, quantity, player }
        ])
      }
    }

    if (/^(?:please\s+)?(?:eat|have some food|feed yourself)$/.test(goal)) {
      return this.plan('Eat safe food', [{ type: 'eat' }])
    }

    if (/^(?:please\s+)?(?:sleep|go to sleep|sleep through the night)$/.test(goal)) {
      return this.plan('Sleep in a nearby bed', [{ type: 'sleep' }])
    }

    match = goal.match(/^(?:please\s+)?(?:farm|harvest|harvest and replant)\s+(wheat|carrots?|potatoes?|beetroots?|nether wart)(?:\s+(?:nearby|here))?$/)
    if (match) {
      const crop = match[1].replace(/^carrot$/, 'carrots').replace(/^potato$/, 'potatoes')
        .replace(/^beetroot$/, 'beetroots').replace('nether wart', 'nether_wart')
      return this.plan(`Farm ${crop}`, [{ type: 'farm', crop, radius: 16 }])
    }

    match = goal.match(/^(?:please\s+)?(?:create|make|plant)\s+(?:a\s+)?(wheat|carrot|potato|beetroot)\s+farm(?:\s+here)?$/)
    if (match) {
      const crop = match[1].replace('carrot', 'carrots').replace('potato', 'potatoes').replace('beetroot', 'beetroots')
      const center = this.bot.entity.position.floored().plus(directionVector(direction).scaled(3))
      return this.plan(`Create ${crop} farm`, [{
        type: 'create_farm', crop, x: center.x, y: center.y, z: center.z, radius: 2
      }])
    }

    match = goal.match(/^(?:please\s+)?(?:get|collect|gather|fetch|acquire|make|craft)\s+(?:me\s+)?(.+)$/)
    if (match) {
      const { quantity, thing } = parseQuantityAndThing(match[1])
      const normalizedResource = singularize(thing.replace(/\s+ore$/, ''))
      if (RESOURCES.has(normalizedResource)) {
        return this.plan(`Mine ${quantity} ${normalizedResource}`, [{
          type: 'mine_resource', resource: normalizedResource, quantity: Math.min(64, quantity),
          direction, branchSpacing: 3, branchDepth: 16
        }], { type: 'resource_count', resource: normalizedResource, quantity: Math.min(64, quantity) })
      }
      const item = resolveItem(thing, this.bot.registry)
      if (item) return this.plan(`Acquire ${quantity} ${item}`, [{ type: 'acquire_item', item, quantity }], {
        type: 'inventory_count', item, quantity
      })
    }

    return null
  }

  schematicFitsInventory(name, usableSlots = 30) {
    try {
      const materials = this.blueprints.materials(this.blueprints.load(name))
      const slots = Object.entries(materials).reduce((total, [item, quantity]) => {
        const concrete = item === 'any_planks' ? 'oak_planks' : item
        const stackSize = this.bot.registry.itemsByName[concrete]?.stackSize || 64
        return total + Math.ceil(quantity / stackSize)
      }, 0)
      return slots <= usableSlots
    } catch {
      // Custom loader adapters used by integrations may expose names only.
      // Keep the established small-blueprint behavior when size is unknown.
      return true
    }
  }

  plan(reply, actions, completion = { type: 'action_sequence' }) {
    return this.schema.parse({ reply, actions, completion })
  }
}

module.exports = { LocalIntentCompiler, facingFromYaw, parseQuantityAndThing, resolveItem, schematicFromGoal }
