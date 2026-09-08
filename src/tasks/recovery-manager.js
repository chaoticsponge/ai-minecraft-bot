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
  if (/stuck|no path|path.*timeout|took too long|timed out|goal was changed|unreachable|no player-reachable placement stance/.test(message)) return 'navigation'
  if (/socket|disconnected|unloaded|chunk|blockupdate.*did not fire|placement acknowledgement|schematic placement mismatch/.test(message)) return 'transient_world'
  if (/missing|need .* (?:to|for)|no .*inventory|no available recipe|no usable|no dirt or stone blocks|replacement materials|ran out/.test(message)) return 'missing_resource'
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
    // Large builds encounter occasional late/dropped block acknowledgements.
    // They are idempotent and audited on every pass, so tolerate a few local
    // transient retries without asking the LLM to rediscover the same plan.
    const maxRetries = ['build_schematic', 'repair_schematic'].includes(action.type)
      ? 3
      : SAFE_RETRY_ACTIONS.has(action.type) ? 1 : 0
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController()
      const abort = () => controller.abort()
      parentSignal.addEventListener('abort', abort, { once: true })
      const monitor = this.monitor(controller, action, task)
      try {
        task.detail.attempt = attempt + 1
        return await Promise.race([operation(controller.signal), monitor.failure])
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
          let result
          if (error.category === 'transient_world') {
            await new Promise((resolve, reject) => {
              if (parentSignal.aborted) return reject(Object.assign(new Error('Task cancelled'), { name: 'AbortError' }))
              const finish = () => {
                parentSignal.removeEventListener('abort', abort)
                resolve()
              }
              const abort = () => {
                clearTimeout(timer)
                reject(Object.assign(new Error('Task cancelled'), { name: 'AbortError' }))
              }
              const timer = setTimeout(finish, 500)
              parentSignal.addEventListener('abort', abort, { once: true })
            })
            result = 'waited for the world and inventory state to settle'
          } else {
            const recoveryController = new AbortController()
            const abortRecovery = () => recoveryController.abort()
            parentSignal.addEventListener('abort', abortRecovery, { once: true })
            let recoveryTimedOut = false
            const timeout = setTimeout(() => {
              recoveryTimedOut = true
              recoveryController.abort()
              this.executor.stop?.()
            }, this.stallMs)
            try {
              result = await Promise.race([
                this.executor.recoverStuck(monitor.startPosition, recoveryController.signal),
                new Promise((resolve, reject) => recoveryController.signal.addEventListener('abort', () => {
                  reject(Object.assign(new Error('recovery movement timed out'), { name: 'AbortError' }))
                }, { once: true }))
              ])
            } catch (recoveryError) {
              if (!recoveryTimedOut || parentSignal.aborted) throw recoveryError
              result = 'cancelled stalled recovery movement and will re-audit the action'
            } finally {
              clearTimeout(timeout)
              parentSignal.removeEventListener('abort', abortRecovery)
            }
          }
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
    const currentDetail = () => JSON.stringify(task.activeLeaf?.()?.detail || task.detail)
    let lastDetail = currentDetail()
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
    let rejectFailure
    const failure = new Promise((resolve, reject) => { rejectFailure = reject })
    const state = {
      stalled: false,
      startPosition,
      failure,
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
      const detail = currentDetail()
      if (position.distanceTo(lastPosition) > 0.3 || detail !== lastDetail) {
        lastPosition = position.clone()
        lastDetail = detail
        lastProgressAt = Date.now()
        return
      }
      // Large schematic path searches legitimately run near the configured
      // pathfinder think timeout and can spend several seconds bridging or
      // awaiting a placement acknowledgement without changing position. The
      // generic active timeout was shorter than that search, causing false
      // recoveries and expensive full blueprint re-audits.
      const buildMultiplier = ['build_schematic', 'repair_schematic'].includes(action.type) ? 2 : 1
      const timeout = (active ? this.stallMs : this.stallMs * 2) * buildMultiplier
      if (!state.stalled && !ignoresInactivity && Date.now() - lastProgressAt >= timeout) {
        state.stalled = true
        const leaf = task.activeLeaf?.()
        const target = leaf?.detail?.current
        const targetText = target
          ? ` while handling ${target.block} at ${target.x},${target.y},${target.z}`
          : ''
        const activityText = this.executor.activity ? `; activity=${this.executor.activity}` : ''
        const message = `Progress watchdog: ${action.type} made no observable progress for ${Math.max(1, Math.round(timeout / 1000))}s ` +
          `at ${Math.floor(position.x)}, ${Math.floor(position.y)}, ${Math.floor(position.z)} ` +
          `(pathfinder ${active ? 'active' : 'inactive'}${activityText})${targetText}`
        console.warn(message)
        controller.abort()
        rejectFailure(new Error(message))
      }
    }, pollMs)
    timer.unref?.()
    return state
  }
}

module.exports = { RecoveryManager, classifyFailure, SAFE_RETRY_ACTIONS }
