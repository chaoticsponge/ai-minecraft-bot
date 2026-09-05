'use strict'

require('dotenv').config({ quiet: true })

const path = require('node:path')
const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const { plugin: collectBlock } = require('mineflayer-collectblock')
const { loadConfig } = require('./config')
const { BotController } = require('./controller/bot-controller')
const { AutoDisposer } = require('./controller/auto-disposer')
const { acquireProcessLock } = require('./process-lock')
const { installToolCompatibility } = require('./controller/tool-compatibility')

const config = loadConfig()
let releaseProcessLock
try {
  releaseProcessLock = acquireProcessLock(path.resolve(__dirname, '../.bot.pid'))
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
process.once('exit', releaseProcessLock)
let bot
let controller
let autoDisposer
let reconnectTimer
let memoryTimer
let memoryRestarting = false
let shuttingDown = false
let reconnectAttempt = 0
let lastHealthLogAt = 0

function formatError(value) {
  if (value instanceof AggregateError) return value.errors.map((error) => error.message).join('; ')
  if (value instanceof Error) return value.message || value.code || value.name
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

function connect() {
  clearTimeout(reconnectTimer)
  clearInterval(memoryTimer)
  memoryRestarting = false
  const options = config.minecraft
  console.log(
    `Connecting to ${options.host}:${options.port} as ${options.username} ` +
    `(${options.auth}, Minecraft ${options.version})...`
  )

  bot = mineflayer.createBot(options)
  bot.loadPlugin(pathfinder)
  bot.loadPlugin(collectBlock)

  bot.once('spawn', () => {
    reconnectAttempt = 0
    bot.pathfinder.thinkTimeout = config.limits.pathThinkTimeoutMs
    bot.pathfinder.searchRadius = config.limits.pathSearchRadius
    bot.collectBlock.movements.allowParkour = false
    bot.collectBlock.movements.allow1by1towers = false
    bot.pathfinder.movements.canOpenDoors = true
    bot.collectBlock.movements.canOpenDoors = true
    installToolCompatibility(bot)
    const { x, y, z } = bot.entity.position
    controller = new BotController(bot, config)
    autoDisposer = new AutoDisposer(bot, config.autoDisposeItems)
    autoDisposer.start()
    bot.on('whisper', (username, message) => {
      controller.handleWhisper(username, message).catch((error) => console.error('Whisper handler failed:', error))
    })
    if (config.publicChatCommands) {
      bot.on('chat', (username, message) => {
        controller.handleWhisper(username, message).catch((error) => console.error('Chat handler failed:', error))
      })
    }
    console.log(`Spawned as ${bot.username} at ${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`)
    console.log(`AI: ${config.ai.model} at ${config.ai.baseURL}`)
    const commandPrefix = config.commandPrefix ? `${config.commandPrefix} ` : ''
    console.log(`Whisper commands: /w ${bot.username} ${commandPrefix}<goal>`)
    if (config.publicChatCommands) console.log(`Public chat commands: ${commandPrefix}<goal>`)
    if (config.autoDisposeItems.size > 0) {
      console.log(`Auto-dispose: ${[...config.autoDisposeItems].join(', ')}`)
    }
    memoryTimer = setInterval(() => {
      const memory = process.memoryUsage()
      const heapMb = Math.round(memory.heapUsed / 1024 / 1024)
      const rssMb = Math.round(memory.rss / 1024 / 1024)
      const position = bot.entity?.position
      const coordinates = position
        ? `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
        : 'unspawned'
      const action = controller?.active?.action?.type || controller?.taskRunner?.activeLeaf()?.kind || 'none'
      const pathState = bot.pathfinder?.isMining?.()
        ? 'mining'
        : bot.pathfinder?.isBuilding?.()
          ? 'building'
          : bot.pathfinder?.isMoving?.()
            ? 'moving'
            : 'still'
      if (Date.now() - lastHealthLogAt >= 60000) {
        lastHealthLogAt = Date.now()
        console.log(
          `Runtime health: heap ${heapMb}MB, RSS ${rssMb}MB, ` +
          `phase ${controller?.active?.phase || 'idle'}, action ${action}, at ${coordinates}, path ${pathState}`
        )
      }
      if (!memoryRestarting && (heapMb >= config.limits.memoryRestartMb || rssMb >= config.limits.memoryRestartMb)) {
        memoryRestarting = true
        console.error(
          `Memory guard: heap ${heapMb}MB / RSS ${rssMb}MB reached the ` +
          `${config.limits.memoryRestartMb}MB limit; reconnecting before an out-of-memory crash`
        )
        if (controller?.active?.requester) {
          bot.whisper(controller.active.requester, 'Memory cleanup needed; reconnecting safely. I will resume after reconnecting.')
        }
        controller?.stop(false)
        bot.quit('Memory guard restart')
      }
    }, 5000)
    memoryTimer.unref?.()
  })

  bot.on('kicked', (reason) => console.error(`Kicked: ${formatError(reason)}`))
  bot.on('error', (error) => console.error(`Connection error: ${formatError(error)}`))
  bot.once('end', (reason) => {
    clearInterval(memoryTimer)
    controller?.shutdown()
    autoDisposer?.stop()
    controller = null
    autoDisposer = null
    bot = null
    global.gc?.()
    console.log(`Disconnected: ${formatError(reason)}`)
    if (!shuttingDown && config.autoReconnect) {
      const delay = Math.min(
        config.reconnectMaxDelayMs,
        config.reconnectDelayMs * (2 ** Math.min(reconnectAttempt, 8))
      )
      reconnectAttempt += 1
      console.log(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt})...`)
      reconnectTimer = setTimeout(connect, delay)
    }
  })
}

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  clearTimeout(reconnectTimer)
  clearInterval(memoryTimer)
  controller?.shutdown()
  autoDisposer?.stop()
  console.log(`Received ${signal}; shutting down...`)
  if (bot) bot.quit('Bot shutting down')
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))

connect()
