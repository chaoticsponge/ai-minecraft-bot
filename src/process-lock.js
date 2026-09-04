'use strict'

const fs = require('node:fs')

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

function acquireProcessLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx')
      fs.writeFileSync(descriptor, String(process.pid))
      fs.closeSync(descriptor)

      let released = false
      return () => {
        if (released) return
        released = true
        try {
          if (fs.readFileSync(lockPath, 'utf8').trim() === String(process.pid)) {
            fs.unlinkSync(lockPath)
          }
        } catch (error) {
          if (error.code !== 'ENOENT') console.error(`Could not release process lock: ${error.message}`)
        }
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let existingPid = 0
      try { existingPid = Number(fs.readFileSync(lockPath, 'utf8').trim()) } catch {}
      if (Number.isInteger(existingPid) && existingPid > 0 && processIsAlive(existingPid)) {
        throw new Error(`MineflayerBot is already running with PID ${existingPid}`)
      }
      fs.unlinkSync(lockPath)
    }
  }
  throw new Error('Could not acquire the bot process lock')
}

module.exports = { acquireProcessLock }
