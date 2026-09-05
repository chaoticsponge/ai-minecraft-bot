'use strict'

const path = require('node:path')

function readInteger(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`)
  }
  return value
}

function readBoolean(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  if (raw.toLowerCase() === 'true') return true
  if (raw.toLowerCase() === 'false') return false
  throw new Error(`${name} must be true or false`)
}

function loadConfig() {
  const auth = (process.env.MC_AUTH || 'offline').toLowerCase()
  if (!['offline', 'microsoft'].includes(auth)) {
    throw new Error('MC_AUTH must be either offline or microsoft')
  }

  const commandPrefix = process.env.AI_COMMAND_PREFIX ?? ''
  const publicChatCommands = readBoolean('PUBLIC_CHAT_COMMANDS', false)
  if (publicChatCommands && !commandPrefix.trim()) {
    throw new Error('AI_COMMAND_PREFIX must be set when PUBLIC_CHAT_COMMANDS=true')
  }

  return {
    minecraft: {
      host: process.env.MC_HOST || 'localhost',
      port: readInteger('MC_PORT', 49615, { min: 1, max: 65535 }),
      username: process.env.MC_USERNAME || 'MineflayerBot',
      auth,
      version: process.env.MC_VERSION || '1.21.11',
      profilesFolder: path.resolve(process.env.PROFILES_FOLDER || '.auth'),
      logErrors: false
    },
    ai: {
      baseURL: (process.env.AI_BASE_URL || 'http://127.0.0.1:8080/v1').replace(/\/$/, ''),
      apiKey: process.env.AI_API_KEY || 'local-not-required',
      model: process.env.AI_MODEL || 'gemma-4-26b-a4b-it',
      timeoutMs: readInteger('AI_TIMEOUT_MS', 120000, { min: 1000, max: 600000 })
    },
    allowedUsers: new Set(
      (process.env.ALLOWED_USERS || '')
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean)
    ),
    autoDisposeItems: new Set(
      (process.env.AUTO_DISPOSE_ITEMS || '')
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean)
    ),
    commandPrefix,
    publicChatCommands,
    checkpointFile: path.resolve(process.env.BOT_CHECKPOINT_FILE || '.state/active-goal.json'),
    landmarksFile: path.resolve(process.env.BOT_LANDMARKS_FILE || '.state/landmarks.json'),
    schematicsDirectory: path.resolve(process.env.SCHEMATICS_DIRECTORY || 'schematics'),
    autoReconnect: readBoolean('AUTO_RECONNECT', true),
    reconnectDelayMs: readInteger('RECONNECT_DELAY_MS', 5000, { min: 0, max: 300000 }),
    reconnectMaxDelayMs: readInteger('RECONNECT_MAX_DELAY_MS', 60000, { min: 1000, max: 600000 }),
    limits: {
      maxActions: readInteger('MAX_ACTIONS_PER_PLAN', 8, { min: 1, max: 20 }),
      maxGoalPlans: readInteger('MAX_PLANS_PER_GOAL', 6, { min: 1, max: 20 }),
      maxPlannerFailures: readInteger('MAX_CONSECUTIVE_AI_FAILURES', 6, { min: 1, max: 20 }),
      maxMoveDistance: readInteger('MAX_MOVE_DISTANCE', 128, { min: 8, max: 512 }),
      maxExpeditionDistance: readInteger('MAX_EXPEDITION_DISTANCE', 2048, { min: 128, max: 10000 }),
      observationDistance: readInteger('OBSERVATION_DISTANCE', 16, { min: 4, max: 64 }),
      pathThinkTimeoutMs: readInteger('PATHFINDER_THINK_TIMEOUT_MS', 15000, {
        min: 1000,
        max: 60000
      }),
      pathSearchRadius: readInteger('PATHFINDER_SEARCH_RADIUS', 32, { min: 8, max: 128 }),
      localPathSearchRadius: readInteger('LOCAL_PATHFINDER_SEARCH_RADIUS', 10, { min: 4, max: 32 }),
      buildSiteSearchRadius: readInteger('BUILD_SITE_SEARCH_RADIUS', 24, { min: 0, max: 64 }),
      taskStallMs: readInteger('TASK_STALL_MS', 12000, { min: 5000, max: 60000 }),
      collectSearchDistance: readInteger('COLLECT_SEARCH_DISTANCE', 64, { min: 8, max: 128 }),
      collectMaxPathFailures: readInteger('COLLECT_MAX_PATH_FAILURES', 4, { min: 1, max: 20 }),
      equipmentRequestWaitMs: readInteger('EQUIPMENT_REQUEST_WAIT_MS', 60000, {
        min: 5000,
        max: 300000
      }),
      maxAutonomousTunnelLength: readInteger('MAX_AUTONOMOUS_TUNNEL_LENGTH', 1024, {
        min: 64,
        max: 4096
      }),
      memoryRestartMb: readInteger('MEMORY_RESTART_MB', 1536, { min: 512, max: 8192 })
    }
  }
}

module.exports = { loadConfig }
