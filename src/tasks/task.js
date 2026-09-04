'use strict'

class Task {
  constructor(type, label, detail = {}) {
    this.type = type
    this.label = label
    this.detail = detail
    this.status = 'pending'
    this.startedAt = null
    this.finishedAt = null
    this.result = null
    this.error = null
    this.children = []
    this.currentChild = null
  }

  start() {
    if (!this.startedAt) this.startedAt = Date.now()
    this.status = 'running'
  }

  child(type, label, detail = {}) {
    const task = new Task(type, label, detail)
    this.children.push(task)
    this.currentChild = task
    return task
  }

  complete(result) {
    this.result = result
    this.status = 'completed'
    this.finishedAt = Date.now()
    this.currentChild = null
  }

  fail(error) {
    this.error = error?.message || String(error)
    this.status = 'failed'
    this.finishedAt = Date.now()
  }

  activeLeaf() {
    return this.currentChild?.activeLeaf() || this
  }

  snapshot() {
    return {
      type: this.type,
      label: this.label,
      detail: this.detail,
      status: this.status,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      result: this.result,
      error: this.error,
      children: this.children.map((child) => child.snapshot())
    }
  }
}

module.exports = { Task }
