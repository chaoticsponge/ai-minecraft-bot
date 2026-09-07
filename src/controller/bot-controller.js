'use strict'

const { Planner } = require('../ai/planner')
const { ActionExecutor } = require('./action-executor')
const { EventMonitor } = require('./event-monitor')
const { Memory } = require('./memory')
const { observe } = require('./world-state')
const { CheckpointStore } = require('./checkpoint-store')
const { BlueprintLoader } = require('./blueprint-loader')
const { TaskRunner } = require('../tasks/task-runner')
const { LocalIntentCompiler } = require('./local-intent')
const { LandmarkStore } = require('./landmark-store')
const { SelectionManager } = require('./selection-manager')

const TOOL_MATERIAL_RANK = ['wooden', 'stone', 'iron', 'diamond', 'netherite']
const REQUIRED_TOOLS = ['pickaxe', 'axe', 'shovel', 'hoe']
const RESOURCE_ITEMS = {
  diamond: ['diamond'], redstone: ['redstone'], coal: ['coal'],
  iron: ['raw_iron', 'iron_ingot'], copper: ['raw_copper', 'copper_ingot'],
  gold: ['raw_gold', 'gold_ingot']
}
const INTERRUPT_PRIORITY = {
  needs_food: 1,
  enemy_threat: 2,
  serious_damage: 3,
  dangerous_fall: 4,
  on_fire: 5,
  drowning: 6,
  suffocating: 7,
  lava: 7,
  death: 8
}

function inventoryCount(bot, requestedName) {
  return bot.inventory.items().reduce((total, item) => {
    if (requestedName === 'any_log') return total + (item.name.endsWith('_log') ? item.count : 0)
    if (requestedName === 'any_planks') return total + (item.name.endsWith('_planks') ? item.count : 0)
    return total + (item.name === requestedName ? item.count : 0)
  }, 0)
}

function hasToolSet(bot, requestedMaterial) {
  const requiredRank = TOOL_MATERIAL_RANK.indexOf(requestedMaterial)
  return REQUIRED_TOOLS.every((tool) => bot.inventory.items().some((item) => {
    if (!item.name.endsWith(`_${tool}`)) return false
    const material = item.name.slice(0, -(tool.length + 1))
    return TOOL_MATERIAL_RANK.indexOf(material) >= requiredRank
  }))
}

function resourceCount(bot, resource) {
  const names = new Set(RESOURCE_ITEMS[resource] || [resource])
  return bot.inventory.items().filter((item) => names.has(item.name)).reduce((total, item) => total + item.count, 0)
}

function completionSatisfied(bot, completion, actionsCompleted = false, storedCount = () => 0) {
  switch (completion.type) {
    case 'action_sequence': return actionsCompleted
    case 'inventory_count': return inventoryCount(bot, completion.item) + storedCount(completion.item) >= completion.quantity
    case 'tool_set': return hasToolSet(bot, completion.material)
    case 'resource_count': return resourceCount(bot, completion.resource) + storedCount(completion.resource) >= completion.quantity
    case 'persistent': return false
    default: return false
  }
}

function isProgressQuestion(message) {
  const text = message.trim().toLowerCase().replace(/[?.!]+$/g, '')
  if (text.length > 80) return false
  return text === 'status' || text === 'update' || /\b(progress|progr+ess|going on|what are you doing|how is it going|how's it going|how far)\b/.test(text)
}

function isResumeRequest(message) {
  return /^(?:continue|resume|carry on|keep going)[?.!]*$/i.test(message.trim())
}

function isBuildSupplyAcknowledgement(message, material) {
  if (!material) return false
  const text = message.trim().toLowerCase().replace(/[?.!]+$/g, '')
  if (text.length > 120) return false
  const readableMaterial = material.replaceAll('_', ' ')
  const mentionsSupply = text.includes(readableMaterial) ||
    /\b(?:it|them|supplies|materials?|blocks?)\b/.test(text)
  const reportsArrival = /\b(?:add(?:ed)?|put|placed?|left|stock(?:ed)?|suppl(?:y|ied)|ready|done|for you)\b/.test(text) ||
    /\b(?:in|inside) (?:the )?(?:chest|barrel|storage)\b/.test(text) ||
    /\bit'?s in\b/.test(text)
  return mentionsSupply && reportsArrival
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      const error = new Error('Task cancelled')
      error.name = 'AbortError'
      reject(error)
      return
    }
    const finish = () => {
      signal.removeEventListener('abort', cancel)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    const cancel = () => {
      clearTimeout(timer)
      const error = new Error('Task cancelled')
      error.name = 'AbortError'
      reject(error)
    }
    signal.addEventListener('abort', cancel, { once: true })
  })
}

function plannerRetryDelay(failures) {
  return Math.min(60000, 2000 * (2 ** Math.min(Math.max(0, failures - 1), 5)))
}

function missingEquipmentForFailure(failure) {
  if (failure?.category !== 'missing_resource') return null
  const message = String(failure.error || '').toLowerCase().replaceAll('_', ' ')
  const explicit = [
    ['pickaxe', /\bpickaxe\b/], ['shovel', /\bshovel\b/], ['axe', /\baxe\b/],
    ['hoe', /\bhoe\b/], ['sword', /\bsword\b/], ['shield', /\bshield\b/],
    ['crafting_table', /\b(?:crafting table|workbench)\b/], ['furnace', /\bfurnace\b/],
    ['water_bucket', /\bwater bucket\b/]
  ]
  const named = explicit.find(([, pattern]) => pattern.test(message))
  if (named) return named[0]
  const action = failure.action || {}
  if (['strip_mine', 'mine_resource', 'staircase_to', 'staircase_to_y'].includes(action.type)) return 'pickaxe'
  if (action.type === 'create_farm') return 'hoe'
  if (action.type === 'collect') {
    if (action.block === 'any_log' || action.block?.endsWith('_log')) return 'axe'
    if (action.block === 'dirt' || /(?:dirt|sand|gravel|clay)$/.test(action.block || '')) return 'shovel'
    if (action.block === 'any_ore' || action.block?.endsWith('_ore')) return 'pickaxe'
  }
  return null
}

function missingBuildMaterialForFailure(failure) {
  if (failure?.category !== 'missing_resource' ||
      !['build_schematic', 'repair_schematic'].includes(failure.action?.type)) return null
  const message = String(failure.error || '').toLowerCase()
  if (/no dirt or stone blocks|cannot support floating build block/.test(message)) return 'build_scaffold'
  return message.match(/missing build supply ([a-z0-9_]+)/)?.[1] || null
}

function buildMaterialLabel(material) {
  if (material === 'build_scaffold') {
    return 'scaffold blocks (dirt, cobblestone, stone, tuff, andesite, diorite, granite, calcite, or sandstone)'
  }
  return material.replaceAll('_', ' ')
}

function missingBuildQuantityForFailure(failure) {
  if (!failure?.error) return null
  const match = String(failure.error).toLowerCase().match(/need ([0-9]+) remaining for this build/)
  return match ? Number(match[1]) : null
}

function equipmentLabel(equipment) {
  return equipment.replaceAll('_', ' ')
}

function actionFingerprint(action) {
  return JSON.stringify(action, Object.keys(action).sort())
}

function worldProgressFingerprint(bot) {
  const position = bot.entity?.position?.floored?.()
  const counts = new Map()
  for (const item of bot.inventory.items()) counts.set(item.name, (counts.get(item.name) || 0) + item.count)
  const inventory = [...counts].sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify({
    position: position ? [position.x, position.y, position.z] : null,
    health: Math.ceil(bot.health || 0),
    food: Math.ceil(bot.food || 0),
    inventory
  })
}

function applyTaskProgressResume(plan, actionIndex, taskSnapshot) {
  if (!plan?.actions?.[actionIndex] || !taskSnapshot?.children) return { plan, actionIndex }
  const action = plan.actions[actionIndex]
  const actionTask = taskSnapshot.children.find((child) => child?.detail?.index === actionIndex)
  const completed = actionTask?.detail?.progress?.completed
  if (!['strip_mine', 'collect'].includes(action.type) || !Number.isInteger(completed) || completed <= 0) {
    return { plan, actionIndex }
  }
  const total = action.type === 'strip_mine' ? action.length : action.quantity
  if (completed >= total) return { plan, actionIndex: actionIndex + 1 }
  const actions = plan.actions.slice()
  actions[actionIndex] = action.type === 'strip_mine'
    ? { ...action, length: action.length - completed }
    : { ...action, quantity: action.quantity - completed }
  return { plan: { ...plan, actions }, actionIndex }
}

class BotController {
  constructor(bot, config) {
    this.bot = bot
    this.config = config
    this.memory = new Memory()
    this.landmarks = new LandmarkStore(config.landmarksFile)
    this.executor = new ActionExecutor(bot, config.limits, {
      autoDisposeItems: config.autoDisposeItems,
      landmarks: this.landmarks
    })
    this.blueprints = new BlueprintLoader(config.schematicsDirectory)
    this.selection = new SelectionManager(bot)
    this.taskRunner = new TaskRunner(bot, this.executor, this.blueprints)
    this.localIntents = new LocalIntentCompiler(
      bot,
      config.limits.maxActions,
      this.blueprints,
      config.limits.maxAutonomousTunnelLength,
      this.selection
    )
    this.checkpoints = new CheckpointStore(config.checkpointFile)
    this.planner = new Planner({ ...config.ai, maxActions: config.limits.maxActions })
    this.monitor = new EventMonitor(bot)
    this.active = null
    this.goalRun = null
    this.closed = false
    this.maintenanceTimer = null
    this.maintenanceAbort = null
    this.maintenanceRun = null
    this.idleSafetyRun = null
    this.idleSafetyAbort = null
    this.idleSafetyTrigger = null
    this.handleCollectedItem = (collector) => {
      if ((collector === this.bot.entity || collector?.username === this.bot.username) && !this.active) {
        this.scheduleMaintenance()
      }
    }
    this.handleInterrupt = (trigger) => {
      const state = this.active
      if (!state || state.goalAbort.signal.aborted) {
        this.runIdleSafety(trigger).catch((error) => {
          if (error.name !== 'AbortError') console.warn(`Idle safety response failed: ${error.message}`)
        })
        return
      }
      const currentPriority = INTERRUPT_PRIORITY[state.pendingTrigger?.type] || 0
      const newPriority = INTERRUPT_PRIORITY[trigger.type] || 0
      if (!state.pendingTrigger || newPriority >= currentPriority) state.pendingTrigger = trigger
      if (trigger.type === 'death') {
        state.recovery = trigger
        const checkpoint = this.checkpoints.load()
        if (checkpoint) this.checkpoints.save({ ...checkpoint, recovery: trigger, updatedAt: Date.now() })
      }
      state.skillAbort?.abort()
      const response = trigger.type === 'needs_food'
        ? (this.executor.stop(), 'Paused current task to eat')
        : this.executor.beginEmergencyResponse(trigger)
      this.memory.add('controller_event', { ...trigger, response })
      console.warn(`Controller interrupt: ${trigger.type} — ${response}`)
    }
    this.bot.on('playerCollect', this.handleCollectedItem)
    this.monitor.on('interrupt', this.handleInterrupt)
    this.scheduleMaintenance(1500)
    this.resumeTimer = setTimeout(() => {
      this.resumeCheckpoint().catch((error) => console.error(`Checkpoint resume failed: ${error.message}`))
    }, 2000)
    this.resumeTimer.unref?.()
  }

  async resumeCheckpoint() {
    if (this.active) return
    const checkpoint = this.checkpoints.load()
    if (!checkpoint?.goal || !checkpoint?.requester || !this.canCommand(checkpoint.requester)) return
    console.log(`Resuming checkpoint for ${checkpoint.requester}: ${checkpoint.goal}`)
    const run = this.runGoal(checkpoint.requester, checkpoint.goal, checkpoint)
    this.goalRun = run
    try { await run } catch (error) { console.error(`Checkpoint resume failed: ${error.message}`) } finally {
      if (this.goalRun === run) this.goalRun = null
    }
  }

  canCommand(username) {
    return this.config.allowedUsers.size === 0 || this.config.allowedUsers.has(username.toLowerCase())
  }

  whisper(username, message) {
    this.bot.whisper(username, String(message).replace(/\s+/g, ' ').slice(0, 220))
  }

  whisperLong(username, message, prefix = '') {
    const words = String(message).replace(/\s+/g, ' ').trim().split(' ')
    let line = prefix
    for (const word of words) {
      if (`${line}${line ? ' ' : ''}${word}`.length > 210) {
        if (line) this.whisper(username, line)
        line = word
      } else {
        line += `${line ? ' ' : ''}${word}`
      }
    }
    if (line) this.whisper(username, line)
  }

  progressMessage() {
    const state = this.active
    const health = Math.ceil(this.bot.health || 0)
    const food = Math.ceil(this.bot.food || 0)
    const oxygen = Number.isFinite(this.bot.oxygenLevel) ? `, air ${this.bot.oxygenLevel}/20` : ''
    const position = this.bot.entity?.position
    const location = position
      ? ` at ${Math.floor(position.x)}, ${Math.floor(position.y)}, ${Math.floor(position.z)}`
      : ''
    if (!state) {
      if (this.idleSafetyRun) return `Handling an immediate safety problem${location} (health ${health}/20, food ${food}/20${oxygen}).`
      return `I am idle${location} (health ${health}/20, food ${food}/20${oxygen}).`
    }
    const elapsed = Math.max(0, Math.round((Date.now() - state.startedAt) / 1000))
    if (state.phase === 'survival') {
      return `Handling ${state.survivalAction?.replaceAll('_', ' ') || 'a safety problem'} before resuming "${state.goal}" (health ${health}/20, food ${food}/20${oxygen}).`
    }
    if (state.phase === 'planning') {
      return `Still planning "${state.goal}" (${elapsed}s elapsed).`
    }
    if (state.phase === 'waiting_ai') {
      const remaining = Math.max(0, Math.ceil(((state.plannerRetryAt || Date.now()) - Date.now()) / 1000))
      return `The AI planner is unavailable; retrying in ${remaining}s. Your goal is still checkpointed (health ${health}/20, food ${food}/20${oxygen}).`
    }
    if (state.phase === 'waiting_equipment') {
      return `Waiting for ${state.waitingForEquipment?.replaceAll('_', ' ') || 'missing equipment'} from you${location}; the current action will resume automatically when I receive it.`
    }
    if (state.phase === 'waiting_resource') {
      return `Waiting for ${state.waitingForResource?.replaceAll('_', ' ') || 'a missing build material'} in nearby storage${location}; the build will resume automatically when I find it.`
    }
    const action = state.action
    const leaf = this.taskRunner.activeLeaf()
    if (!action && !leaf) return `Working on "${state.goal}" (${elapsed}s elapsed).`
    const actionElapsed = Math.max(0, Math.round((Date.now() - state.actionStartedAt) / 1000))
    const y = Math.floor(this.bot.entity.position.y)
    if (this.executor.activity) {
      return `${this.executor.activity} before resuming "${state.goal}" (${actionElapsed}s on this step).`
    }
    if (action?.type === 'mine_resource') {
      const total = this.executor.resourceCount(action.resource) + this.executor.goalStoredCount(action.resource)
      return `Mining ${action.resource}: ${total}/${action.quantity}, currently Y ${y} (${actionElapsed}s on this step).`
    }
    if (action?.type === 'acquire_item') {
      const total = this.executor.inventoryTracker.count(action.item) + this.executor.goalStoredCount(action.item)
      return `Acquiring ${action.item}: ${total}/${action.quantity}; ${this.executor.inventoryTracker.freeSlots()} inventory slots free (${actionElapsed}s).`
    }
    if (['build_schematic', 'repair_schematic'].includes(action?.type) && leaf?.detail) {
      const verb = action.type === 'repair_schematic' ? 'Repairing' : 'Building'
      const phase = leaf.detail.phase ? `, ${leaf.detail.phase}` : ''
      return `${verb} ${action.schematic}: ${leaf.detail.placed || 0}/${leaf.detail.total || '?'} blocks placed${phase} (${actionElapsed}s).`
    }
    if (action?.type === 'deposit' || action?.type === 'withdraw') {
      return `${action.type === 'deposit' ? 'Depositing' : 'Withdrawing'} ${action.quantity} ${action.item} using the nearest chest or barrel (${actionElapsed}s).`
    }
    if (action?.type === 'staircase_to') {
      return `Building the ${action.target} staircase, currently Y ${y} (${actionElapsed}s on this step).`
    }
    if (action?.type === 'staircase_to_y') {
      return `Building the staircase to Y ${action.y}, currently Y ${y} (${actionElapsed}s on this step).`
    }
    if (action?.type === 'strip_mine') {
      return `Strip-mining ${action.direction} for ${action.length} blocks, currently at Y ${y} (${actionElapsed}s on this step).`
    }
    if (leaf && (!action || leaf.label !== action.type.replaceAll('_', ' '))) {
      const detail = leaf.detail || {}
      const count = Number.isFinite(detail.current) && Number.isFinite(detail.target)
        ? ` (${detail.current}/${detail.target})`
        : Number.isFinite(detail.placed) && Number.isFinite(detail.total)
          ? ` (${detail.placed}/${detail.total})`
          : ''
      return `${leaf.label}${count} is in progress (${actionElapsed}s on this step; ${elapsed}s total).`
    }
    return `${action?.type?.replaceAll('_', ' ') || leaf.label} is in progress (${actionElapsed}s on this step; ${elapsed}s total).`
  }

  scheduleMaintenance(delay = 750) {
    if (this.closed) return
    clearTimeout(this.maintenanceTimer)
    this.maintenanceTimer = setTimeout(async () => {
      if (this.active || this.closed) return
      this.maintenanceAbort = new AbortController()
      const run = this.executor.maintainToolSet(this.maintenanceAbort.signal)
      this.maintenanceRun = run
      try {
        await run
      } catch (error) {
        if (error.name !== 'AbortError') console.warn(`Background tool maintenance: ${error.message}`)
      } finally {
        if (this.maintenanceRun === run) this.maintenanceRun = null
        this.maintenanceAbort = null
      }
    }, delay)
  }

  async cancelMaintenance() {
    clearTimeout(this.maintenanceTimer)
    this.maintenanceAbort?.abort()
    const run = this.maintenanceRun
    if (!run) return
    try {
      await run
    } catch (error) {
      if (error.name !== 'AbortError') console.warn(`Stopping background tool maintenance: ${error.message}`)
    }
  }

  async runIdleSafety(trigger) {
    if (this.closed) return
    if (this.idleSafetyRun) {
      if ((INTERRUPT_PRIORITY[trigger.type] || 0) > (INTERRUPT_PRIORITY[this.idleSafetyTrigger?.type] || 0)) {
        this.idleSafetyTrigger = trigger
        this.idleSafetyAbort?.abort()
      }
      return this.idleSafetyRun
    }
    await this.cancelMaintenance()
    this.idleSafetyTrigger = trigger
    const controller = new AbortController()
    this.idleSafetyAbort = controller
    this.executor.beginEmergencyResponse(trigger)
    const run = this.executor.respondToInterrupt(trigger, controller.signal)
    this.idleSafetyRun = run
    try {
      await run
    } finally {
      if (this.idleSafetyRun === run) {
        this.idleSafetyRun = null
        this.idleSafetyAbort = null
        const followup = this.idleSafetyTrigger !== trigger ? this.idleSafetyTrigger : null
        this.idleSafetyTrigger = null
        if (followup && !this.closed) {
          await this.runIdleSafety(followup)
        } else {
          this.scheduleMaintenance()
        }
      }
    }
  }

  async respondToSafetyChain(state, firstTrigger) {
    let trigger = firstTrigger
    let last = firstTrigger
    for (let count = 0; trigger && count < 4 && !state.goalAbort.signal.aborted; count += 1) {
      last = trigger
      state.phase = 'survival'
      state.survivalAction = trigger.type
      try {
        await this.executor.respondToInterrupt(trigger, state.goalAbort.signal)
        if (trigger.type === 'death') state.recovery = null
      } catch (error) {
        if (error.name === 'AbortError') throw error
        console.warn(`Safety response ${trigger.type} did not complete: ${error.message}`)
      }
      trigger = this.takePendingTrigger(state)
    }
    state.survivalAction = null
    return last
  }

  async handleWhisper(username, message) {
    if (username === this.bot.username || !this.canCommand(username)) return
    const prefix = this.config.commandPrefix
    const trimmed = message.trim()
    if (trimmed.toLowerCase() === 'stop') {
      this.stop()
      this.whisper(username, 'stopped')
      return
    }
    if (prefix && trimmed !== prefix && !trimmed.startsWith(`${prefix} `)) return
    const request = prefix ? trimmed.slice(prefix.length).trim() : trimmed

    if (!request || request === 'help') {
      const command = prefix ? `${prefix} ` : ''
      this.whisper(username, `${command}<goal> | ${command}status | ${command}stop`)
      return
    }
    if (isProgressQuestion(request)) {
      this.whisper(username, this.progressMessage())
      return
    }
    if (this.active?.waitingForResource &&
        isBuildSupplyAcknowledgement(request, this.active.waitingForResource)) {
      this.whisper(username, 'Thanks — checking the nearby storage now.')
      this.executor.notifyBuildSupplyChanged()
      return
    }
    if (request === 'stop') {
      this.stop()
      this.whisper(username, 'stopped')
      return
    }
    if (request.length > 500) {
      this.whisper(username, 'goal is too long (500 character maximum)')
      return
    }

    this.whisper(username, 'Got it.')
    const saved = isResumeRequest(request) ? this.checkpoints.load() : null
    if (saved?.goal && saved?.requester?.toLowerCase() === username.toLowerCase()) {
      if (this.active) {
        const previous = this.goalRun
        this.stop(false)
        await previous?.catch(() => {})
      }
      const run = this.runGoal(username, saved.goal, saved)
      this.goalRun = run
      try {
        await run
      } finally {
        if (this.goalRun === run) this.goalRun = null
      }
      return
    }
    if (this.active) {
      const previous = this.goalRun
      this.stop()
      await previous?.catch(() => {})
    }

    const run = this.runGoal(username, request)
    this.goalRun = run
    try {
      await run
    } finally {
      if (this.goalRun === run) this.goalRun = null
    }
  }

  observe(requester = null) {
    const observation = observe(this.bot, this.config.limits.observationDistance)
    observation.autoDisposeItems = [...this.config.autoDisposeItems]
    observation.availableSchematics = this.blueprints.list()
    observation.rememberedLocations = this.landmarks.list().slice(0, 32)
    observation.goalItemsStored = this.executor.goalStoredSnapshot()
    observation.selectedTarget = requester ? this.selection.snapshot(requester) : null
    observation.knownContainers = this.executor.containerTracker.summary(
      this.bot.entity.position,
      this.config.limits.observationDistance * 4
    )
    return observation
  }

  normalizeActions(goal, plan) {
    const followRequested = /\b(follow|trail|accompany|stay with|come with|guard|protect|defend)\b/i.test(goal)
    const authorized = plan.actions.filter((action) => action.type !== 'follow' || followRequested)
    if (authorized.length !== plan.actions.length) {
      this.memory.add('plan_adjustment', 'Removed an unrequested follow action')
    }
    const ordinary = authorized.filter((action) => action.type !== 'follow')
    const follow = authorized.filter((action) => action.type === 'follow').slice(-1)
    return [...ordinary, ...follow]
  }

  validateAction(goal, action) {
    if (action.type === 'attack' && !/\b(attack|kill|fight|hit|defend|guard|protect|combat)\b/i.test(goal)) {
      throw new Error('attack rejected because the player did not explicitly request combat')
    }
    if (action.type === 'strip_mine' && !/\b(strip[ -]?min(?:e|ing)|branch[ -]?min(?:e|ing)|mining tunnel)\b/i.test(goal)) {
      throw new Error('strip_mine rejected because the player did not explicitly request a mining tunnel')
    }
    if (action.type === 'strip_mine' && action.length > this.config.limits.maxAutonomousTunnelLength) {
      throw new Error(`strip_mine length exceeds the configured ${this.config.limits.maxAutonomousTunnelLength}-block limit`)
    }
    if (action.type === 'mine_resource' && !/\b(mine|find|get|collect|gather|dig)\b/i.test(goal)) {
      throw new Error('mine_resource rejected because the player did not request mining resources')
    }
    if (action.type === 'staircase_to' && !/\b(stair|stairway|staircase|descend|descent|go down|dig down|level)\b/i.test(goal)) {
      throw new Error('staircase_to rejected because the player did not request a descent')
    }
    if (action.type === 'staircase_to_y' && !/\b(stair|stairway|staircase|descend|descent|go down|dig down|level|\by\s*-?\d+)\b/i.test(goal)) {
      throw new Error('staircase_to_y rejected because the player did not request a descent')
    }
  }

  takePendingTrigger(state) {
    const trigger = state.pendingTrigger
    state.pendingTrigger = null
    return trigger
  }

  async runGoal(requester, goal, resume = null) {
    this.executor.stop()
    await this.cancelMaintenance()
    this.idleSafetyAbort?.abort()
    const state = {
      requester,
      goal,
      goalAbort: new AbortController(),
      skillAbort: null,
      pendingTrigger: null,
      action: null,
      phase: 'starting',
      survivalAction: null,
      recovery: resume?.recovery || null,
      planCount: 0,
      plannerFailures: 0,
      plannerRetryAt: null,
      waitingForEquipment: null,
      waitingForResource: null,
      requestedEquipment: new Set(),
      requestedResources: new Set(),
      failedActions: new Map(),
      startedAt: Date.now(),
      actionStartedAt: null
    }
    this.active = state
    this.executor.beginGoalStorage(resume?.storedItems)
    this.memory.add('goal', `${requester}: ${goal}`)
    let trigger = { type: 'player_instruction' }
    let resumePlan = resume?.plan || null
    let resumeIndex = Number.isInteger(resume?.actionIndex) ? resume.actionIndex : 0
    if (resumePlan && resume?.task) {
      const resumed = applyTaskProgressResume(resumePlan, resumeIndex, resume.task)
      resumePlan = resumed.plan
      resumeIndex = resumed.actionIndex
    }
    this.checkpoints.save({
      requester,
      goal,
      plan: resumePlan,
      actionIndex: resumeIndex,
      ...(resume?.recovery ? { recovery: resume.recovery } : {}),
      storedItems: this.executor.goalStoredSnapshot(),
      updatedAt: Date.now()
    })

    try {
      if (resume?.recovery) {
        trigger = await this.respondToSafetyChain(state, resume.recovery)
        this.checkpoints.save({ requester, goal, plan: resumePlan, actionIndex: resumeIndex, storedItems: this.executor.goalStoredSnapshot(), updatedAt: Date.now() })
      }
      while (!state.goalAbort.signal.aborted && state.planCount < this.config.limits.maxGoalPlans) {
        const skillAbort = new AbortController()
        state.skillAbort = skillAbort
        const abortSkill = () => skillAbort.abort()
        state.goalAbort.signal.addEventListener('abort', abortSkill, { once: true })

        try {
          state.phase = 'planning'
          const localPlan = !resumePlan && trigger.type === 'player_instruction'
            ? this.localIntents.compile(goal, requester)
            : null
          let plan = resumePlan || localPlan
          if (!plan) {
            try {
              plan = await this.planner.plan({
                goal,
                requester,
                trigger,
                observation: this.observe(requester),
                memory: this.memory.recent(),
                signal: skillAbort.signal
              })
              state.planCount += 1
              state.plannerFailures = 0
              state.plannerRetryAt = null
            } catch (error) {
              if (skillAbort.signal.aborted || error.name === 'AbortError') throw error
              state.plannerFailures += 1
              const delay = plannerRetryDelay(state.plannerFailures)
              state.phase = 'waiting_ai'
              state.plannerRetryAt = Date.now() + delay
              this.memory.add('planner_error', {
                attempt: state.plannerFailures,
                retryInMs: delay,
                error: error.message
              })
              const maxFailures = this.config.limits.maxPlannerFailures ?? 6
              if (state.plannerFailures >= maxFailures) {
                state.phase = 'waiting_ai'
                state.plannerRetryAt = null
                console.warn(`AI planner paused after ${state.plannerFailures} consecutive failures; checkpoint retained`)
                this.whisper(
                  requester,
                  `paused — the AI planner failed ${state.plannerFailures} times. Your goal is saved; say resume when the AI is available.`
                )
                return
              }
              console.warn(`AI planning failed: ${error.message}; retrying in ${Math.round(delay / 1000)}s`)
              await abortableDelay(delay, skillAbort.signal)
              trigger = { type: 'planner_retry', error: error.message, attempt: state.plannerFailures }
              continue
            }
          }
          if (skillAbort.signal.aborted) throw new Error('Planning interrupted')

          this.memory.add('plan', { source: resumePlan ? 'checkpoint' : localPlan ? 'local_intent' : 'ai', trigger, ...plan })
          console.log(`Plan source: ${resumePlan ? 'checkpoint' : localPlan ? 'local intent' : 'AI'}`)
          if (completionSatisfied(this.bot, plan.completion, false, (item) => this.executor.goalStoredCount(item))) {
            this.checkpoints.clear()
            this.whisper(requester, `done — ${goal}`)
            return
          }

          const actions = this.normalizeActions(goal, plan)
          if (actions.length === 0) {
            this.checkpoints.clear()
            this.whisper(requester, `blocked — ${plan.reply}`)
            return
          }

          const startIndex = resumePlan ? Math.min(resumeIndex, actions.length) : 0
          resumePlan = null
          resumeIndex = 0
          const checkpointPlan = { ...plan, actions }
          this.checkpoints.save({
            requester, goal, plan: checkpointPlan, actionIndex: startIndex,
            storedItems: this.executor.goalStoredSnapshot(),
            ...(state.recovery ? { recovery: state.recovery } : {}), updatedAt: Date.now()
          })

          state.phase = 'executing'
          let failed = null
          try {
            await this.taskRunner.run(actions, skillAbort.signal, { whisperTo: requester, goal }, startIndex, {
              onActionStart: (action, index) => {
                state.action = action
                state.actionIndex = index
                state.actionStartedAt = Date.now()
                this.validateAction(goal, action)
                const prior = state.failedActions.get(actionFingerprint(action))
                if (prior && prior.world === worldProgressFingerprint(this.bot)) {
                  const error = new Error(
                    `repeated unchanged ${action.type} rejected after its previous failure; choose a different approach`
                  )
                  error.category = 'repeated_action'
                  throw error
                }
              },
              onActionComplete: (action, index, result) => {
                state.failedActions.delete(actionFingerprint(action))
                this.memory.add('action_result', { action, ok: true, result })
                console.log(`Action ${action.type}: ${result}`)
                if (['build_schematic', 'repair_schematic'].includes(action.type) &&
                    String(result).includes('optional decor still needed:')) {
                  this.whisperLong(requester, result)
                }
                this.checkpoints.save({
                  requester, goal, plan: checkpointPlan, actionIndex: index + 1,
                  storedItems: this.executor.goalStoredSnapshot(),
                  ...(state.recovery ? { recovery: state.recovery } : {}), updatedAt: Date.now()
                })
              },
              onTaskProgress: () => {
                this.checkpoints.save({
                  requester,
                  goal,
                  plan: checkpointPlan,
                  actionIndex: state.actionIndex,
                  task: this.taskRunner.snapshot(),
                  storedItems: this.executor.goalStoredSnapshot(),
                  ...(state.recovery ? { recovery: state.recovery } : {}),
                  updatedAt: Date.now()
                })
              }
            })
          } catch (error) {
            if (!skillAbort.signal.aborted) {
              const action = error.action || state.action
              const key = action && actionFingerprint(action)
              if (key) {
                const world = worldProgressFingerprint(this.bot)
                const prior = state.failedActions.get(key)
                state.failedActions.set(key, {
                  world,
                  count: prior?.world === world ? prior.count + 1 : 1,
                  error: error.message
                })
              }
              failed = {
                type: 'skill_failed', action, error: error.message,
                category: error.category || 'skill_error', retries: error.retryCount || 0
              }
              this.memory.add('action_result', { ...failed, ok: false, task: this.taskRunner.snapshot() })
              console.warn(`Action ${action?.type || 'unknown'} failed [${failed.category}]: ${error.message}`)
            }
          }
          if (state.goalAbort.signal.aborted) return

          if (!failed && plan.completion.type === 'persistent') {
            const persistentIndex = Math.max(0, actions.findLastIndex((action) => action.type === 'follow'))
            state.phase = 'persistent'
            state.action = actions[persistentIndex]
            state.actionIndex = persistentIndex
            state.actionStartedAt = state.actionStartedAt || Date.now()
            this.checkpoints.save({
              requester, goal, plan: checkpointPlan, actionIndex: persistentIndex,
              storedItems: this.executor.goalStoredSnapshot(),
              ...(state.recovery ? { recovery: state.recovery } : {}), updatedAt: Date.now()
            })
            await new Promise((resolve) => {
              if (skillAbort.signal.aborted) return resolve()
              skillAbort.signal.addEventListener('abort', resolve, { once: true })
            })
            if (state.goalAbort.signal.aborted) return
            const persistentInterrupt = this.takePendingTrigger(state)
            if (persistentInterrupt) {
              await this.respondToSafetyChain(state, persistentInterrupt)
              resumePlan = checkpointPlan
              resumeIndex = persistentIndex
              trigger = persistentInterrupt
              continue
            }
          }

          state.action = null
          state.actionStartedAt = null

          const interrupt = this.takePendingTrigger(state)
          if (interrupt) {
            await this.respondToSafetyChain(state, interrupt)
            resumePlan = checkpointPlan
            resumeIndex = Math.max(startIndex, state.actionIndex || 0)
            trigger = interrupt
            continue
          }
          if (failed) {
            const material = missingBuildMaterialForFailure(failed)
            if (material) {
              const quantity = missingBuildQuantityForFailure(failed)
              const requestedSupply = quantity && material !== 'build_scaffold'
                ? `${quantity} ${buildMaterialLabel(material)}`
                : buildMaterialLabel(material)
              const requestKey = `${failed.action?.type || 'build'}:${material}`
              if (!state.requestedResources.has(requestKey)) {
                state.requestedResources.add(requestKey)
                state.phase = 'waiting_resource'
                state.waitingForResource = material
                const position = this.bot.entity.position.floored()
                this.whisper(
                  requester,
                  `I'm stuck and need ${requestedSupply} for the build. Put some in a nearby chest or barrel; I'll keep checking. I'm at ${position.x}, ${position.y}, ${position.z}.`
                )
                resumePlan = checkpointPlan
                resumeIndex = Number.isInteger(state.actionIndex) ? state.actionIndex : startIndex
                let received = false
                try {
                  received = await this.executor.waitForBuildSupply(
                    material, skillAbort.signal, null
                  )
                } finally {
                  state.waitingForResource = null
                }
                if (received) {
                  state.requestedResources.delete(requestKey)
                  if (failed.action) state.failedActions.delete(actionFingerprint(failed.action))
                  this.whisper(requester, `Thanks — I found ${buildMaterialLabel(material)}. Resuming now.`)
                  trigger = { type: 'build_supply_received', material }
                  continue
                }
                this.whisper(requester, `I still need ${buildMaterialLabel(material)}; the build remains checkpointed.`)
                return
              }
            }
            const equipment = missingEquipmentForFailure(failed)
            const requestKey = equipment && `${failed.action?.type || 'action'}:${equipment}`
            if (equipment && !state.requestedEquipment.has(requestKey)) {
              state.requestedEquipment.add(requestKey)
              state.phase = 'waiting_equipment'
              state.waitingForEquipment = equipment
              const position = this.bot.entity.position.floored()
              this.whisper(
                requester,
                `I'm stuck and need a usable ${equipmentLabel(equipment)} that I couldn't acquire. Please bring or drop one near me; I'm at ${position.x}, ${position.y}, ${position.z}.`
              )
              resumePlan = checkpointPlan
              resumeIndex = Number.isInteger(state.actionIndex) ? state.actionIndex : startIndex
              let received
              try {
                received = await this.executor.waitForEquipment(
                  requester,
                  equipment,
                  skillAbort.signal,
                  this.config.limits.equipmentRequestWaitMs
                )
              } catch (error) {
                state.requestedEquipment.delete(requestKey)
                throw error
              } finally {
                state.waitingForEquipment = null
              }
              if (received) {
                state.requestedEquipment.delete(requestKey)
                if (failed.action) state.failedActions.delete(actionFingerprint(failed.action))
                this.whisper(requester, `Thanks — I received the ${equipmentLabel(equipment)}. Resuming now.`)
                trigger = { type: 'equipment_received', equipment }
                continue
              }
              resumePlan = null
              resumeIndex = 0
              this.whisper(requester, `I still need a ${equipmentLabel(equipment)}; the task remains checkpointed.`)
            }
            if (failed.category === 'build_access' &&
                ['build_schematic', 'repair_schematic'].includes(failed.action?.type)) {
              state.phase = 'blocked_build_access'
              this.whisperLong(
                requester,
                `I placed everything I can reach, but ${failed.error}. ` +
                `The build is checkpointed—clear or open access around those spots, then tell me "resume".`
              )
              return
            }
            trigger = failed
            continue
          }
          if (completionSatisfied(this.bot, plan.completion, true, (item) => this.executor.goalStoredCount(item))) {
            this.checkpoints.clear()
            this.whisper(requester, `done — ${goal}`)
            return
          }
          trigger = {
            type: 'skill_completed',
            completion: plan.completion,
            current: plan.completion.type === 'inventory_count'
              ? inventoryCount(this.bot, plan.completion.item)
              : plan.completion.type === 'resource_count'
                ? resourceCount(this.bot, plan.completion.resource)
              : undefined
          }
        } catch (error) {
          if (state.goalAbort.signal.aborted) return
          const interrupt = this.takePendingTrigger(state)
          if (skillAbort.signal.aborted && interrupt) {
            trigger = await this.respondToSafetyChain(state, interrupt)
            continue
          }
          throw error
        } finally {
          state.goalAbort.signal.removeEventListener('abort', abortSkill)
          if (state.skillAbort === skillAbort) state.skillAbort = null
        }
      }

      if (!state.goalAbort.signal.aborted) {
        this.checkpoints.clear()
        this.whisper(requester, `stopped after ${state.planCount} planning attempts; give me a new goal to retry`)
      }
    } catch (error) {
      if (error.name !== 'AbortError' && !state.goalAbort.signal.aborted) {
        this.checkpoints.clear()
        console.error('Goal failed:', error)
        this.whisper(requester, `I couldn't finish — ${error.message}`)
      }
    } finally {
      if (this.active === state) this.active = null
      this.scheduleMaintenance()
    }
  }

  stop(clearCheckpoint = true) {
    const state = this.active
    state?.goalAbort.abort()
    state?.skillAbort?.abort()
    this.executor.stop()
    if (clearCheckpoint) this.checkpoints.clear()
    if (this.active === state) this.active = null
  }

  shutdown() {
    this.closed = true
    this.stop(false)
    clearTimeout(this.resumeTimer)
    clearTimeout(this.maintenanceTimer)
    this.maintenanceAbort?.abort()
    this.idleSafetyAbort?.abort()
    this.bot.off('playerCollect', this.handleCollectedItem)
    this.monitor.off('interrupt', this.handleInterrupt)
    this.monitor.shutdown()
    this.executor.shutdown()
  }
}

module.exports = {
  BotController,
  completionSatisfied,
  hasToolSet,
  inventoryCount,
  resourceCount,
  isProgressQuestion,
  isResumeRequest,
  abortableDelay,
  plannerRetryDelay,
  actionFingerprint,
  worldProgressFingerprint,
  applyTaskProgressResume,
  missingEquipmentForFailure,
  missingBuildMaterialForFailure,
  missingBuildQuantityForFailure,
  isBuildSupplyAcknowledgement
}
