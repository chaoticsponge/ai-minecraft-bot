'use strict'

require('dotenv').config({ quiet: true })

const { loadConfig } = require('../src/config')
const { Planner } = require('../src/ai/planner')

async function main() {
  const config = loadConfig()
  const planner = new Planner({ ...config.ai, maxActions: config.limits.maxActions })
  const goal = process.argv.slice(2).join(' ') || 'Say hello to Alex'
  const plan = await planner.plan({
    goal,
    requester: 'Alex',
    observation: {
      position: { x: 0, y: 64, z: 0 },
      health: 20,
      food: 20,
      heldItem: null,
      dimension: 'overworld',
      timeOfDay: 1000,
      isRaining: false,
      inventory: [],
      nearbyPlayers: [{ username: 'Alex', distance: 2, position: { x: 2, y: 64, z: 0 } }],
      nearbyEntities: [],
      nearbyBlocks: { grass_block: 10, dirt: 8 }
    },
    memory: [],
    trigger: { type: 'player_instruction' },
    signal: new AbortController().signal
  })
  console.log(JSON.stringify(plan, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
