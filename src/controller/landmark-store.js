'use strict'

const fs = require('node:fs')
const path = require('node:path')

class LandmarkStore {
  constructor(file) {
    this.file = file
    this.landmarks = new Map()
    if (file) this.load()
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      for (const entry of data.landmarks || []) {
        if (!entry?.name || !Number.isFinite(entry.x) || !Number.isFinite(entry.y) || !Number.isFinite(entry.z)) continue
        this.landmarks.set(entry.name.toLowerCase(), entry)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`Ignoring invalid landmarks: ${error.message}`)
    }
  }

  save() {
    if (!this.file) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    const body = { landmarks: [...this.landmarks.values()] }
    fs.writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, this.file)
  }

  remember(name, position, dimension, type = 'location', extra = {}) {
    const entry = {
      name: name.toLowerCase(), type, dimension: dimension || null,
      x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z),
      ...extra,
      updatedAt: Date.now()
    }
    this.landmarks.set(entry.name, entry)
    this.save()
    return entry
  }

  get(name) {
    return this.landmarks.get(name.toLowerCase()) || null
  }

  forget(name) {
    const removed = this.landmarks.delete(name.toLowerCase())
    if (removed) this.save()
    return removed
  }

  list(type = null) {
    return [...this.landmarks.values()].filter((entry) => !type || entry.type === type)
  }
}

module.exports = { LandmarkStore }
