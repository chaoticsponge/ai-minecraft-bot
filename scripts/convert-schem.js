'use strict'

const fs = require('node:fs')
const path = require('node:path')
const nbt = require('prismarine-nbt')
const registry = require('prismarine-registry')('1.21.11')

const FALLBACK_BLOCKS = {
  grass: 'short_grass',
  chain: 'iron_chain',
  polished_cinnabar_slab: 'polished_tuff_slab',
  polished_cinnabar_stairs: 'polished_tuff_stairs'
}
const ITEM_FOR_BLOCK = {
  cave_vines: 'glow_berries',
  cave_vines_plant: 'glow_berries',
  tripwire: 'string',
  wall_torch: 'torch',
  soul_wall_torch: 'soul_torch',
  redstone_wall_torch: 'redstone_torch'
}
const REPLACE_BLOCK = {
  water_cauldron: 'cauldron',
  potted_blue_orchid: 'flower_pot',
  potted_azure_bluet: 'flower_pot',
  potted_flowering_azalea_bush: 'flower_pot',
  potted_dandelion: 'flower_pot',
  potted_poppy: 'flower_pot'
}
const OMIT_BLOCKS = new Set(['air', 'water', 'seagrass', 'tall_seagrass', 'potatoes', 'carrots', 'wheat'])
const TERRAIN_BLOCKS = new Set(['dirt', 'grass_block', 'farmland'])

function usage() {
  console.error('Usage: npm run convert:schem -- <input.schem> <output.json> [--min-y N] [--trim-terrain]')
  process.exit(2)
}

function parseArgs(argv) {
  const positional = []
  let minY = 0
  let trimTerrain = false
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--min-y') minY = Number(argv[++index])
    else if (argv[index] === '--trim-terrain') trimTerrain = true
    else positional.push(argv[index])
  }
  if (positional.length !== 2 || !Number.isInteger(minY) || minY < 0) usage()
  return { input: positional[0], output: positional[1], minY, trimTerrain }
}

function decodeVarInts(data, expected) {
  const values = []
  for (let offset = 0; offset < data.length;) {
    let value = 0
    let shift = 0
    let byte
    do {
      byte = data[offset++]
      value |= (byte & 0x7f) << shift
      shift += 7
      if (shift > 35) throw new Error('invalid block-data VarInt')
    } while (byte & 0x80)
    values.push(value >>> 0)
  }
  if (values.length !== expected) throw new Error(`decoded ${values.length} blocks; expected ${expected}`)
  return values
}

function parseState(raw) {
  const match = raw.match(/^(?:minecraft:)?([^\[]+)(?:\[(.*)\])?$/)
  if (!match) throw new Error(`unsupported palette state ${raw}`)
  const properties = {}
  if (match[2]) {
    for (const field of match[2].split(',')) {
      const equals = field.indexOf('=')
      if (equals < 1) throw new Error(`invalid block property in ${raw}`)
      properties[field.slice(0, equals)] = field.slice(equals + 1)
    }
  }
  return { block: match[1], properties }
}

function itemForBlock(block) {
  if (ITEM_FOR_BLOCK[block]) return ITEM_FOR_BLOCK[block]
  if (block.endsWith('_wall_hanging_sign')) return block.replace('_wall_hanging_sign', '_hanging_sign')
  if (block.endsWith('_wall_sign')) return block.replace('_wall_sign', '_sign')
  if (block.endsWith('_wall_banner')) return block.replace('_wall_banner', '_banner')
  if (block.endsWith('_wall_skull')) return block.replace('_wall_skull', '_skull')
  if (block.endsWith('_wall_head')) return block.replace('_wall_head', '_head')
  return block
}

function compatibleEntry(raw, trimTerrain, substitutions) {
  const parsed = parseState(raw)
  let block = FALLBACK_BLOCKS[parsed.block] || REPLACE_BLOCK[parsed.block] || parsed.block
  if (block !== parsed.block) substitutions.set(parsed.block, block)
  if (OMIT_BLOCKS.has(block) || (trimTerrain && TERRAIN_BLOCKS.has(block))) return null
  if (!registry.blocksByName[block]) throw new Error(`Minecraft 1.21.11 has no block named ${block}`)
  const properties = REPLACE_BLOCK[parsed.block] ? {} : parsed.properties
  const item = itemForBlock(block)
  if (!registry.itemsByName[item]) throw new Error(`Minecraft 1.21.11 has no placeable item for ${block}`)
  return {
    block,
    ...(item !== block ? { item } : {}),
    ...(Object.keys(properties).length ? { properties } : {})
  }
}

function symbol(index) {
  return String.fromCharCode(0xe000 + index)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const parsed = await nbt.parse(fs.readFileSync(options.input))
  const simplified = nbt.simplify(parsed.parsed)
  const schematic = simplified.Schematic || simplified
  const blocks = schematic.Blocks || schematic
  const width = Number(schematic.Width)
  const height = Number(schematic.Height)
  const length = Number(schematic.Length)
  if (![width, height, length].every(Number.isInteger) || options.minY >= height) {
    throw new Error('schematic dimensions or --min-y are invalid')
  }
  const ids = decodeVarInts(blocks.Data || blocks.BlockData, width * height * length)
  const stateById = Object.fromEntries(Object.entries(blocks.Palette || schematic.Palette).map(([state, id]) => [id, state]))
  const substitutions = new Map()
  const entryById = new Map()
  for (const [id, raw] of Object.entries(stateById)) {
    entryById.set(Number(id), compatibleEntry(raw, options.trimTerrain, substitutions))
  }

  const palette = { '.': 'air' }
  const symbolByEntry = new Map()
  const rowsByLayer = []
  let placedBlocks = 0
  for (let sourceY = options.minY; sourceY < height; sourceY += 1) {
    const rows = []
    for (let z = 0; z < length; z += 1) {
      let row = ''
      for (let x = 0; x < width; x += 1) {
        const id = ids[x + z * width + sourceY * width * length]
        const entry = entryById.get(id)
        if (!entry) {
          row += '.'
          continue
        }
        const key = JSON.stringify(entry)
        if (!symbolByEntry.has(key)) {
          const token = symbol(symbolByEntry.size)
          symbolByEntry.set(key, token)
          palette[token] = entry
        }
        row += symbolByEntry.get(key)
        placedBlocks += 1
      }
      rows.push(row)
    }
    rowsByLayer.push({ y: sourceY - options.minY, rows })
  }

  const name = path.basename(options.output, '.json').toLowerCase().replace(/[^a-z0-9_]+/g, '_')
  const output = {
    format: 'mineflayer-blueprint-v2',
    name,
    description: `Converted from ${path.basename(options.input)}`,
    size: { x: width, y: height - options.minY, z: length },
    anchor: { x: Math.floor(width / 2), y: 0, z: 0, description: 'Front-center ground block' },
    palette,
    layers: rowsByLayer,
    importNotes: {
      sourceFormatVersion: schematic.Version ?? null,
      sourceDataVersion: schematic.DataVersion ?? null,
      sourceMinY: options.minY,
      terrainTrimmed: options.trimTerrain,
      omittedBlocks: [...new Set(Object.values(stateById).map((raw) => parseState(raw).block))]
        .filter((block) => block !== 'air' && OMIT_BLOCKS.has(block)),
      placedBlocks,
      omittedBlockEntities: blocks.BlockEntities?.length || 0,
      omittedEntities: schematic.Entities?.length || 0,
      substitutions: Object.fromEntries(substitutions)
    }
  }
  fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true })
  fs.writeFileSync(options.output, `${JSON.stringify(output, null, 2)}\n`)
  console.log(`Converted ${options.input} to ${options.output}`)
  console.log(`${width}x${height - options.minY}x${length}; ${placedBlocks} placed blocks; ${Object.keys(palette).length - 1} block states`)
  if (output.importNotes.omittedBlockEntities || output.importNotes.omittedEntities) {
    console.log(`Omitted NBT for ${output.importNotes.omittedBlockEntities} block entities and ${output.importNotes.omittedEntities} entities`)
  }
  if (substitutions.size) console.log(`Substitutions: ${JSON.stringify(output.importNotes.substitutions)}`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Conversion failed: ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { itemForBlock, parseState }
