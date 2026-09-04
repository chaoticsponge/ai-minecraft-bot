'use strict'

const fs = require('node:fs')
const path = require('node:path')

class CheckpointStore {
  constructor(file) {
    this.file = file
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`Ignoring invalid goal checkpoint: ${error.message}`)
      return null
    }
  }

  save(checkpoint) {
    const directory = path.dirname(this.file)
    fs.mkdirSync(directory, { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, this.file)
  }

  clear() {
    try { fs.unlinkSync(this.file) } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`Could not clear goal checkpoint: ${error.message}`)
    }
  }
}

module.exports = { CheckpointStore }
