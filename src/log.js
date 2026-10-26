const fs = require('fs')
const path = require('path')
const { dataDir } = require('./config')

fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true })
// arquivo por dia (calculado a cada linha: processo que vira a noite muda de arquivo sozinho)
const file = () => path.join(dataDir, 'logs', `agent-${new Date().toISOString().slice(0, 10)}.log`)

const ring = []

// Linha do tempo para o painel: só o que o dono precisa saber, em português simples.
// Persistida em data/events.json (últimos 200) para sobreviver a reinícios.
const EVENTS = path.join(dataDir, 'events.json')
let events = []
try { events = JSON.parse(fs.readFileSync(EVENTS, 'utf8')) } catch {}
const KINDS = [
  ['avaliador', /^avaliador:/],
  ['morte', /^servidor: NapoLtz (?!joined|left)|^laço de mortes/],
  ['túmulo', /recuperou seu túmulo|^túmulo[: ]|túmulo perigoso/],
  ['combate', /^combate:|^fuga:/],
  ['noite', /^noite: (dormindo|offline|abrigo)/],
  ['falha', /^etapa \S+ falhou|bloqueada/],
  ['etapa', /^etapa \S+: /],
  ['estoque', /^(restock|stash|baú|estoque|kits|inventário: guardei)|guardei/],
  ['craft', /^craft: /],
  ['obra', /^(casa|fazenda): .*(colocad|plantad|pronta)|^minério: |^fornalha: /],
  ['viagem', /^home: |^nav: na superfície/],
  ['chat', /^chat -> /],
  ['conexão', /^conectado em|^desconectado|^agente iniciando/]
]
let saveTimer = null
function event (level, msg) {
  const kind = level === 'error' ? 'erro' : (KINDS.find(([, re]) => re.test(msg)) || [null])[0]
  if (!kind) return
  const text = msg.replace(/^servidor: /, '').replace(/^etapa (\S+): /, '')
    .replace(/^agente iniciando.*/, 'agente iniciado').replace(/^conectado em .*/, 'entrou no servidor')
    .replace(/^desconectado: (.*)/, 'saiu do servidor ($1)').slice(0, 160)
  const last = events[events.length - 1]
  if (last && last.kind === kind && last.text === text) { last.n = (last.n || 1) + 1; last.t = Date.now() } else events.push({ t: Date.now(), kind, text })
  if (events.length > 200) events = events.slice(-200)
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => fs.writeFile(EVENTS, JSON.stringify(events), () => {}), 3000)
}

function log (level, ...args) {
  const line = `${new Date().toISOString()} [${level}] ${args.map(a => typeof a === 'string' ? a : (a instanceof Error ? a.message : JSON.stringify(a))).join(' ')}`
  console.log(line)
  const msg = line.replace(/^\S+ \[\w+\] /, '')
  ring.push({ t: Date.now(), level, msg })
  if (ring.length > 60) ring.shift()
  event(level, msg)
  fs.appendFile(file(), line + '\n', () => {})
}

module.exports = {
  info: (...a) => log('info', ...a),
  warn: (...a) => log('warn', ...a),
  error: (...a) => log('error', ...a),
  recent: (n = 30) => ring.slice(-n),
  events: (n = 60) => events.slice(-n)
}
