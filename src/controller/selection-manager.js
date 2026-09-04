'use strict'

const { Vec3 } = require('vec3')

function lookVector(entity) {
  const yaw = Number(entity?.yaw) || 0
  const pitch = Number(entity?.pitch) || 0
  const horizontal = Math.cos(pitch)
  return new Vec3(-Math.sin(yaw) * horizontal, -Math.sin(pitch), Math.cos(yaw) * horizontal)
}

function rayAabbDistance(origin, direction, minimum, maximum, maxDistance) {
  let near = 0
  let far = maxDistance
  for (const axis of ['x', 'y', 'z']) {
    if (Math.abs(direction[axis]) < 1e-8) {
      if (origin[axis] < minimum[axis] || origin[axis] > maximum[axis]) return null
      continue
    }
    let first = (minimum[axis] - origin[axis]) / direction[axis]
    let second = (maximum[axis] - origin[axis]) / direction[axis]
    if (first > second) [first, second] = [second, first]
    near = Math.max(near, first)
    far = Math.min(far, second)
    if (near > far) return null
  }
  return near >= 0 && near <= maxDistance ? near : null
}

class SelectionManager {
  constructor(bot) {
    this.bot = bot
  }

  playerEntity(username) {
    const normalized = String(username || '').toLowerCase()
    return Object.entries(this.bot.players || {})
      .find(([name, player]) => name.toLowerCase() === normalized && player?.entity)?.[1]?.entity || null
  }

  selectedBlock(username, maxDistance = 6) {
    const player = this.playerEntity(username)
    if (!player || typeof this.bot.blockAt !== 'function') return null
    const origin = player.position.offset(0, Number(player.eyeHeight) || 1.62, 0)
    const direction = lookVector(player)
    let lastKey = null
    for (let distance = 0.2; distance <= maxDistance; distance += 0.2) {
      const position = origin.plus(direction.scaled(distance)).floored()
      const key = position.toString()
      if (key === lastKey) continue
      lastKey = key
      const block = this.bot.blockAt(position)
      if (!block) return null
      const liquid = block.name?.includes('water') || block.name?.includes('lava')
      if (block.boundingBox !== 'empty' || liquid) {
        return { block, distance, origin, direction }
      }
    }
    return null
  }

  selectedEntity(username, maxDistance = 16) {
    const player = this.playerEntity(username)
    if (!player) return null
    const origin = player.position.offset(0, Number(player.eyeHeight) || 1.62, 0)
    const direction = lookVector(player)
    const blockDistance = this.selectedBlock(username, Math.min(6, maxDistance))?.distance ?? Infinity
    return Object.values(this.bot.entities || {})
      .filter((entity) => entity?.position && entity !== player && entity !== this.bot.entity)
      .map((entity) => {
        const halfWidth = Math.max(0.3, Number(entity.width) || 0.6) / 2 + 0.2
        const height = Math.max(0.3, Number(entity.height) || 1.8)
        const minimum = entity.position.offset(-halfWidth, 0, -halfWidth)
        const maximum = entity.position.offset(halfWidth, height, halfWidth)
        return { entity, distance: rayAabbDistance(origin, direction, minimum, maximum, maxDistance) }
      })
      .filter((candidate) => candidate.distance !== null && candidate.distance > 0.2 &&
        candidate.distance <= blockDistance + 0.1)
      .sort((a, b) => a.distance - b.distance)[0]?.entity || null
  }

  snapshot(username) {
    const selected = this.selectedBlock(username)
    const entity = this.selectedEntity(username)
    return {
      block: selected ? {
        name: selected.block.name,
        x: selected.block.position.x,
        y: selected.block.position.y,
        z: selected.block.position.z,
        distance: Math.round(selected.distance * 10) / 10
      } : null,
      entity: entity ? {
        id: entity.id,
        name: entity.name || entity.displayName || entity.type,
        type: entity.type
      } : null
    }
  }
}

module.exports = { SelectionManager, lookVector, rayAabbDistance }
