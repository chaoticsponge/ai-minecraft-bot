'use strict'

const { Task } = require('./task')
const { AcquireItemTask } = require('./acquire-item-task')
const { BlueprintTask } = require('./blueprint-task')
const { ActionSchema } = require('../controller/action-schema')
const { RecoveryManager, classifyFailure } = require('./recovery-manager')

class TaskRunner {
  constructor(bot, executor, blueprintLoader) {
    this.bot = bot
    this.executor = executor
    this.acquire = new AcquireItemTask(bot, executor)
    this.blueprint = new BlueprintTask(bot, executor, blueprintLoader)
    this.recovery = new RecoveryManager(bot, executor, { stallMs: executor.limits.taskStallMs || 12000 })
    this.root = null
    this.currentAction = null
    this.currentIndex = -1
  }

  activeLeaf() {
    return this.root?.activeLeaf() || null
  }

  snapshot() {
    return this.root?.snapshot() || null
  }

  async run(actions, signal, context = {}, startIndex = 0, hooks = {}) {
    this.root = new Task('sequence', context.goal || 'action sequence', { total: actions.length, completed: startIndex })
    this.root.start()
    try {
      for (let index = startIndex; index < actions.length; index += 1) {
        const action = ActionSchema.parse(actions[index])
        const task = this.root.child('action', this.label(action), { action, index })
        task.start()
        this.currentAction = action
        this.currentIndex = index
        try {
          hooks.onActionStart?.(action, index, task)
          const result = await this.recovery.run(action, signal, task, async (attemptSignal) => {
            // Preparation can include navigation, storage unloading, sleeping,
            // eating, workstation placement, and tool crafting. Keep it inside
            // the same watchdog/recovery boundary as the action itself.
            await this.executor.prepareForAction(action, attemptSignal)
            if (action.type === 'acquire_item') {
              return this.acquire.run(action.item, action.quantity, attemptSignal, task, hooks.onTaskProgress)
            }
            if (action.type === 'collect_build_materials') {
              return this.blueprint.collectMaterials(action.schematic, attemptSignal, task, hooks.onTaskProgress)
            }
            if (action.type === 'build_schematic') {
              return this.blueprint.build(action, attemptSignal, task, hooks.onTaskProgress)
            }
            if (action.type === 'repair_schematic') {
              return this.blueprint.repair(action, attemptSignal, task, hooks.onTaskProgress)
            }
            return this.executor.execute(action, attemptSignal, {
              ...context,
              onProgress: (progress) => {
                task.detail.progress = progress
                hooks.onTaskProgress?.(task)
              }
            })
          })
          task.complete(result)
          this.root.detail.completed = index + 1
          hooks.onActionComplete?.(action, index, result, task)
        } catch (error) {
          task.fail(error)
          error.category = error.category || classifyFailure(error)
          error.action = action
          error.actionIndex = index
          throw error
        }
      }
      this.root.complete(`completed ${actions.length} actions`)
      return this.root.result
    } catch (error) {
      this.root.fail(error)
      throw error
    } finally {
      this.currentAction = null
      this.currentIndex = -1
    }
  }

  label(action) {
    if (action.type === 'acquire_item') return `acquire ${action.quantity} ${action.item}`
    if (action.type === 'collect_build_materials') return `collect materials for ${action.schematic}`
    if (action.type === 'build_schematic') return `build ${action.schematic}`
    if (action.type === 'repair_schematic') return `repair ${action.schematic}`
    if (action.type === 'mine_resource') return `mine ${action.quantity} ${action.resource}`
    if (action.type === 'collect') return `collect ${action.quantity} ${action.block}`
    if (action.type === 'deposit') return `deposit ${action.quantity} ${action.item}`
    if (action.type === 'withdraw') return `withdraw ${action.quantity} ${action.item}`
    return action.type.replaceAll('_', ' ')
  }
}

module.exports = { TaskRunner }
