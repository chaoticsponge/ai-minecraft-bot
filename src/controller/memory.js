'use strict'

class Memory {
  constructor(limit = 20) {
    this.limit = limit
    this.entries = []
  }

  add(kind, detail) {
    this.entries.push({ at: new Date().toISOString(), kind, detail })
    if (this.entries.length > this.limit) this.entries.shift()
  }

  recent(count = 12) {
    return this.entries.slice(-count)
  }
}

module.exports = { Memory }
