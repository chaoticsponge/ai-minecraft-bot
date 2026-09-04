'use strict'

const SAFE_RETRY_ACTIONS = new Set([
  'move_to', 'mine_block', 'acquire_item', 'collect_build_materials', 'build_schematic', 'repair_schematic',
  'mine_resource', 'strip_mine', 'staircase_to', 'staircase_to_y', 'go_to_location', 'farm', 'create_farm',
  'return_to_surface', 'interact_block', 'sleep'
])

function classifyFailure(error) {
  if (error?.name === 'AbortError') return 'cancelled'
  const message = String(error?.message || error).toLowerCase()
  if (/inventory full|cannot carry more/.test(message)) return 'inventory_full'
  if (/container.*(?:full|accepted only)/.test(message)) return 'container_full'
  if (/no reachable (?:chest|barrel)|nearest container has/.test(message)) return 'container_unavailable'
  if (/stuck|no path|path.*timeout|took too long|timed out|goal was changed|unreachable/.test(message)) return 'navigation'
  if (/socket|disconnected|unloaded|chunk/.test(message)) return 'transient_world'
  if (/missing|need .* (?:to|for)|no .*inventory|no available recipe|no usable|replacement materials|ran out/.test(message)) return 'missing_resource'
  if (/obstructed|unbreakable|unsafe|lava|water|not empty|not diggable/.test(message)) return 'unsafe_or_blocked'
  return 'skill_error'
}

class RecoveryManager {
  constructor(bot, executor, { stallMs = 12000 } = {}) {
    this.bot = bot
    this.executor = executor
    this.stallMs = stallMs
  }

  async run(action, parentSignal, task, operation) {
    const maxRetries = SAFE_RETRY_ACTIONS.has(action.type) ? 1 : 0
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController()
      const abort = () => controller.abort()
      parentSignal.addEventListener('abort', abort, { once: true })
      const monitor = this.monitor(controller, action, task)
      try {
        task.detail.attempt = attempt + 1
        return await operation(controller.signal)
      } catch (original) {
        if (parentSignal.aborted) throw original
        const error = monitor.stalled
          ? Object.assign(new Error(`stuck for ${Math.round(this.stallMs / 1000)} seconds without movement`), { cause: original })
          : original
        error.category = error.category || classifyFailure(error)
        error.retryCount = attempt
        if (attempt >= maxRetries || !['navigation', 'transient_world'].includes(error.category)) throw error
        const recovery = task.child('recovery', `recover from ${error.category}`, { attempt: attempt + 1, error: error.message })
        recovery.start()
        try {
          const result = await this.executor.recoverStuck(monitor.startPosition, parentSignal)
          recovery.complete(result)
          task.currentChild = null
        } catch (recoveryError) {
          recovery.fail(recoveryError)
          throw error
        }
      } finally {
        monitor.stop()
        parentSignal.removeEventListener('abort', abort)
      }
    }
  }

  monitor(controller, action, task) {
    const startPosition = this.bot.entity.position.clone()
    let lastPosition = startPosition.clone()
    let lastProgressAt = Date.now()
    let lastDetail = JSON.stringify(task.detail)
    const ignoresInactivity = action.type === 'wait'
    const markProgress = () => { lastProgressAt = Date.now() }
    const markNearbyBlockProgress = (oldBlock, newBlock) => {
      const changed = newBlock || oldBlock
      if (changed?.position && this.bot.entity.position.distanceTo(changed.position) <= 8) markProgress()
    }
    const markOwnCollection = (collector) => {
      if (collector === this.bot.entity || collector?.username === this.bot.username) markProgress()
    }
    this.bot.on?.('blockUpdate', markNearbyBlockProgress)
    this.bot.on?.('playerCollect', markOwnCollection)
    this.bot.inventory?.on?.('updateSlot', markProgress)
    const state = {
      stalled: false,
      startPosition,
      stop: () => {
        clearInterval(timer)
        this.bot.off?.('blockUpdate', markNearbyBlockProgress)
        this.bot.off?.('playerCollect', markOwnCollection)
        this.bot.inventory?.off?.('updateSlot', markProgress)
      }
    }
    const pollMs = Math.min(1000, Math.max(25, Math.floor(this.stallMs / 4)))
    const timer = setInterval(() => {
      const active = this.bot.pathfinder.isMoving?.() || this.bot.pathfinder.isMining?.() || this.bot.pathfinder.isBuilding?.()
      const position = this.bot.entity.position
      const detail = JSON.stringify(task.detail)
      if (position.distanceTo(lastPosition) > 0.3 || detail !== lastDetail) {
        lastPosition = position.clone()
        lastDetail = detail
        lastProgressAt = Date.now()
        return
      }
      const timeout = active ? this.stallMs : this.stallMs * 2
      if (!ignoresInactivity && Date.now() - lastProgressAt >= timeout) {
        state.stalled = true
        console.warn(
          `Progress watchdog: ${action.type} made no observable progress for ${Math.max(1, Math.round(timeout / 1000))}s ` +
          `at ${Math.floor(position.x)}, ${Math.floor(position.y)}, ${Math.floor(position.z)} ` +
          `(pathfinder ${active ? 'active' : 'inactive'})`
        )
        controller.abort()
      }
    }, pollMs)
    timer.unref?.()
    return state
  }
}

module.exports = { RecoveryManager, classifyFailure, SAFE_RETRY_ACTIONS }
