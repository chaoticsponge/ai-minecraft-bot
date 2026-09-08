'use strict'

const isScaffoldMaterial = (name) => name === 'dirt' || name === 'cobblestone'
const legacy = new Set([
  'cobbled_deepslate', 'stone', 'netherrack', 'tuff', 'andesite',
  'diorite', 'granite', 'calcite', 'sandstone', 'smooth_sandstone'
])
const isRecoverableScaffold = (name) => isScaffoldMaterial(name) || legacy.has(name) || /_planks$/.test(name || '')

function scaffoldItemIds(bot) {
  return Object.values(bot.registry.itemsByName).filter((item) => isScaffoldMaterial(item.name)).map((item) => item.id)
}

module.exports = { isScaffoldMaterial, isRecoverableScaffold, scaffoldItemIds }
