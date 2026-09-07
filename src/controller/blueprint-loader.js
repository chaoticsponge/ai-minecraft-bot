'use strict'

const fs = require('node:fs')
const path = require('node:path')

const NAME = /^[a-z0-9_]+$/

class BlueprintLoader {
  constructor(directory) {
    this.directory = path.resolve(directory)
  }

  list() {
    try {
      return fs.readdirSync(this.directory)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -5))
        .filter((name) => NAME.test(name))
    } catch { return [] }
  }

  load(name) {
    if (!NAME.test(name)) throw new Error('invalid schematic name')
    const file = path.resolve(this.directory, `${name}.json`)
    if (path.dirname(file) !== this.directory) throw new Error('schematic path escaped its directory')
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    this.validate(data, name)
    return data
  }

  validate(data, expectedName) {
    if (!['mineflayer-blueprint-v1', 'mineflayer-blueprint-v2'].includes(data?.format) || data.name !== expectedName) {
      throw new Error(`invalid blueprint header for ${expectedName}`)
    }
    const { x, y, z } = data.size || {}
    if (![x, y, z].every((value) => Number.isInteger(value) && value >= 1 && value <= 64)) {
      throw new Error('blueprint dimensions must be integers from 1 to 64')
    }
    if (x * y * z > 32768) throw new Error('blueprint is too large')
    if (!data.palette || Object.keys(data.palette).some((key) => key.length !== 1)) {
      throw new Error('blueprint palette keys must be one character')
    }
    for (const value of Object.values(data.palette)) {
      const validString = typeof value === 'string' && NAME.test(value)
      const validObject = value && typeof value === 'object' && NAME.test(value.block) &&
        (!value.item || NAME.test(value.item)) &&
        (!value.properties || (typeof value.properties === 'object' && !Array.isArray(value.properties)))
      if (!validString && !validObject) throw new Error('blueprint palette values must name a block or stateful block entry')
    }
    const seenY = new Set()
    for (const layer of data.layers || []) {
      if (!Number.isInteger(layer.y) || layer.y < 0 || layer.y >= y || seenY.has(layer.y)) {
        throw new Error('blueprint has an invalid or duplicate layer')
      }
      seenY.add(layer.y)
      if (!Array.isArray(layer.rows) || layer.rows.length !== z ||
          layer.rows.some((row) => typeof row !== 'string' || row.length !== x)) {
        throw new Error(`blueprint layer ${layer.y} does not match ${x}x${z}`)
      }
      for (const row of layer.rows) {
        for (const symbol of row) if (!Object.hasOwn(data.palette, symbol)) throw new Error(`unknown palette symbol ${symbol}`)
      }
    }
  }

  blocks(blueprint) {
    const blocks = []
    for (const layer of blueprint.layers) {
      for (let z = 0; z < layer.rows.length; z += 1) {
        for (let x = 0; x < layer.rows[z].length; x += 1) {
          const paletteEntry = blueprint.palette[layer.rows[z][x]]
          const block = typeof paletteEntry === 'string' ? paletteEntry : paletteEntry.block
          const material = typeof paletteEntry === 'object' && paletteEntry.item ? paletteEntry.item : block
          if (block !== 'air') blocks.push({
            x, y: layer.y, z, material,
            ...(block !== material ? { block } : {}),
            ...(typeof paletteEntry === 'object' && paletteEntry.properties ? { properties: paletteEntry.properties } : {})
          })
        }
      }
    }
    return blocks
  }

  materials(blueprint) {
    const counts = {}
    for (const block of this.blocks(blueprint)) {
      counts[block.material] = (counts[block.material] || 0) + this.itemCount(block)
    }
    return counts
  }

  itemCount(entry) {
    const block = entry.block || entry.material
    // Doors and beds occupy two world cells but are placed from one inventory
    // item. Their upper/head entries are results of placing the owner half.
    if (block?.endsWith('_door') && entry.properties?.half === 'upper') return 0
    if (block?.endsWith('_bed') && entry.properties?.part === 'head') return 0
    if (block?.endsWith('_slab') && entry.properties?.type === 'double') return 2
    const property = block?.endsWith('_candle') ? 'candles'
      : block === 'sea_pickle' ? 'pickles'
        : block === 'turtle_egg' ? 'eggs'
          : ['pink_petals', 'wildflowers'].includes(block) ? 'flower_amount'
            : null
    const count = property ? Number(entry.properties?.[property]) : 1
    return Number.isInteger(count) && count >= 1 && count <= 4 ? count : 1
  }
}

module.exports = { BlueprintLoader }
