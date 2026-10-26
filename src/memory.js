// Memória em duas camadas:
// - data/state.json: estado operacional frequente (checkpoint do controlador).
// - vault Obsidian: conhecimento durável, escrito só em eventos relevantes.
const fs = require('fs')
const path = require('path')
const { dataDir, vaultDir } = require('./config')
const log = require('./log')

const stateFile = path.join(dataDir, 'state.json')

const defaults = () => ({
  mission: null,
  steps: {},
  paused: false,
  goal: '',
  base: null,
  places: [],
  villagers: {},
  deaths: [],
  stats: { emeraldsEarned: 0, sticksTraded: 0, deaths: 0, sessions: 0 },
  server: { commands: {}, plugins: [] },
  lastDeath: null,
  updatedAt: null
})

let state = load()

function load () {
  try {
    return { ...defaults(), ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }
  } catch {
    return defaults()
  }
}

let saveTimer = null
function save (now = false) {
  state.updatedAt = new Date().toISOString()
  const write = () => {
    saveTimer = null
    fs.mkdirSync(dataDir, { recursive: true })
    const tmp = stateFile + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1))
    fs.renameSync(tmp, stateFile)
  }
  if (now) { clearTimeout(saveTimer); return write() }
  if (!saveTimer) saveTimer = setTimeout(write, 2000)
}

// ---------- vault ----------
const today = () => new Date().toISOString().slice(0, 10)
const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ')

function vpath (rel) { return path.join(vaultDir, rel) }

function writeNote (rel, content) {
  try {
    fs.mkdirSync(path.dirname(vpath(rel)), { recursive: true })
    fs.writeFileSync(vpath(rel), content)
  } catch (e) { log.warn('vault write', rel, e.message) }
}

function appendNote (rel, line, header) {
  try {
    const p = vpath(rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    if (!fs.existsSync(p)) fs.writeFileSync(p, header || `# ${path.basename(rel, '.md')}\n\n`)
    fs.appendFileSync(p, line.endsWith('\n') ? line : line + '\n')
  } catch (e) { log.warn('vault append', rel, e.message) }
}

function readNote (rel) {
  try { return fs.readFileSync(vpath(rel), 'utf8') } catch { return null }
}

// Eventos duráveis -> vault
const history = (text) => appendNote(`Histórico/${today()}.md`, `- ${stamp()} ${text}`, `# Histórico ${today()}\n\nVoltar: [[Índice]]\n\n`)
const error = (problem, detail = '', solution = '') => appendNote('Erros/Registro.md', `- ${stamp()} **${problem}** ${detail}${solution ? ` → solução: ${solution}` : ''}`)
const decision = (text) => appendNote('Decisões/Decisões.md', `- ${stamp()} ${text}`)
const knowledge = (topic, line) => appendNote(`Conhecimento/${topic}.md`, `- ${line}`)
const serverNote = (line) => appendNote('Servidor/Servidor.md', `- ${stamp()} ${line}`)

function addPlace (name, pos, dim, note = '') {
  const p = { name, x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), dim, note, at: new Date().toISOString() }
  const near = state.places.find(q => q.name === name && q.dim === dim && Math.hypot(q.x - p.x, q.z - p.z) < 48)
  if (near) return near
  state.places.push(p)
  save()
  appendNote('Mundo/Locais.md', `- **${name}** ${p.x} ${p.y} ${p.z} (${dim}) ${note}`)
  return p
}

let lastStateNote = 0
function snapshot (bot, controller, force = false) {
  if (!bot?.entity) return
  if (!force && Date.now() - lastStateNote < 120000) return
  lastStateNote = Date.now()
  const inv = {}
  for (const it of bot.inventory.items()) inv[it.name] = (inv[it.name] || 0) + it.count
  const eq = [bot.heldItem?.name, ...[5, 6, 7, 8].map(s => bot.inventory.slots[s]?.name)].filter(Boolean)
  const p = bot.entity.position
  writeNote('Estado/Atual.md', `---
atualizado: ${new Date().toISOString()}
---
# Estado atual

Voltar: [[Índice]]

- posição: ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}
- dimensão: ${bot.game?.dimension}
- vida: ${Math.round(bot.health)} / comida: ${bot.food}
- missão: ${state.mission} — etapa: ${controller?.current || '-'}
- objetivo: ${controller?.describe?.() || state.goal || '-'}
- equipado: ${eq.join(', ') || 'nada'}
- base: ${state.base ? `${state.base.x} ${state.base.y} ${state.base.z}` : 'ainda n'}
- esmeraldas ganhas: ${state.stats.emeraldsEarned}

## Inventário
${Object.entries(inv).map(([k, v]) => `- ${k}: ${v}`).join('\n') || '- vazio'}
`)
}

module.exports = {
  get state () { return state },
  save, load, writeNote, appendNote, readNote,
  history, error, decision, knowledge, serverNote, addPlace, snapshot
}
