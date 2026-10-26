const path = require('path')
// Usa o mesmo vec3 do mineflayer para evitar instâncias diferentes.
const { Vec3 } = require(require.resolve('vec3', { paths: [path.dirname(require.resolve('mineflayer'))] }))

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

class StepError extends Error {
  constructor (code, message) { super(message || code); this.code = code }
}

function withTimeout (promise, ms, code = 'timeout') {
  let t
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((resolve, reject) => { t = setTimeout(() => reject(new StepError(code, `${code} após ${ms}ms`)), ms) })
  ])
}

const count = (bot, test) => bot.inventory.items()
  .filter(i => typeof test === 'string' ? i.name === test : test.test(i.name))
  .reduce((n, i) => n + i.count, 0)

const has = (bot, test, n = 1) => count(bot, test) >= n

const LOGS = /_(log|stem)$/
const PLANKS = /_planks$/
const FOODS = new Set(['bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon',
  'baked_potato', 'carrot', 'apple', 'golden_carrot', 'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'sweet_berries', 'melon_slice', 'cookie', 'pumpkin_pie', 'beetroot', 'potato', 'dried_kelp'])

// Sinal de abortar da etapa/tarefa atual, visível em qualquer await abaixo dela (o controlador roda
// cada etapa dentro de task.run). Etapa interrompida não consegue mais trocar o destino do pathfinder.
const task = new (require('async_hooks').AsyncLocalStorage)()

module.exports = { Vec3, sleep, withTimeout, StepError, count, has, LOGS, PLANKS, FOODS, task }
