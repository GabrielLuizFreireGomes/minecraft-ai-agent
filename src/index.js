// Processo principal: reconexão com backoff, retomada do checkpoint, controle local.
const config = require('./config')
const memory = require('./memory')
const log = require('./log')
const control = require('./control')
const { Controller } = require('./controller')
const { connect } = require('./agent')
const { sleep } = require('./skills/util')

const controller = new Controller(config.mission)
// agente avaliador: chama a IA quando o bot entra em loop/morre (src/critic.js)
new (require('./critic').Critic)(controller)
let current = null
let stopping = false

async function shutdown () {
  if (stopping) return
  stopping = true
  log.info('encerrando')
  controller.stop()
  memory.save(true)
  try { current?.quit('encerrado') } catch {}
  setTimeout(() => process.exit(0), 1500)
}

async function main () {
  log.info(`agente iniciando — missão ${config.mission}, retomando etapas: ${JSON.stringify(Object.keys(memory.state.steps))}`)
  memory.history('agente iniciado')
  control.start(controller, () => current, shutdown)
  let backoff = 10000
  let alreadyOnline = 0
  let playerNear = 0
  // fora do servidor de propósito: o painel mostra o motivo e até quando
  const away = async (ms, why) => {
    memory.state.offline = { until: Date.now() + ms, why }
    await sleep(ms)
    memory.state.offline = null
  }
  let deathLoops = 0
  while (!stopping) {
    const started = Date.now()
    const { bot, ended } = connect(controller)
    current = bot
    const reason = String(await ended)
    current = null
    if (stopping) break
    if (Date.now() - started > 5 * 60000) backoff = 10000
    if (/já está online|already (logged|online|connected)/i.test(reason)) {
      if (++alreadyOnline >= 10) { log.error('conta já está online há 10 tentativas, encerrando'); break }
      log.warn('conta em uso por outra sessão; nova tentativa em 60s')
      await away(60000, 'conta em uso (você logado?)')
      continue
    }
    // noite sem poder dormir: offline até amanhecer (mobs daqui tiram 16 de vida por golpe)
    if (reason.startsWith('night_off:')) {
      const ms = Math.min(15 * 60000, Math.max(60000, +reason.split(':')[1] || 0))
      log.info(`noite: offline por ${Math.round(ms / 60000)} min até amanhecer`)
      await away(ms, 'noite: offline até amanhecer')
      continue
    }
    if (reason.startsWith('escape:')) {
      await away(+reason.split(':')[1] || 120000, 'fugindo de mob (sem armadura)')
      continue
    }
    if (reason.startsWith('player_near')) {
      playerNear++
      const wait = Math.min(15, 2 + playerNear * 2)
      log.info(`área com jogador; voltando em ${wait} min`)
      await away(wait * 60000, `jogador perto (${reason.split(':')[1] || '?'})`)
      continue
    }
    playerNear = 0
    // laço de mortes: sai, espera a noite/mobs passarem e volta (até 4x seguidas; depois para de vez)
    if (reason === 'fatal:death_loop') {
      if (++deathLoops > 4) { memory.error('laço de mortes', 'repetiu 4x seguidas; agente parado'); break }
      log.warn(`laço de mortes: voltando em 12 min (${deathLoops}/4)`)
      await away(12 * 60000, 'muitas mortes seguidas: esperando')
      continue
    }
    if (Date.now() - started > 30 * 60000) deathLoops = 0
    if (reason.startsWith('fatal:')) { memory.error('login impossível', reason); break }
    if (/banid|banned|whitelist/i.test(reason)) { memory.error('desconexão permanente', reason); break }
    log.info(`reconectando em ${backoff / 1000}s`)
    await away(backoff, 'reconectando')
    backoff = Math.min(backoff * 2, 5 * 60000)
  }
  await shutdown()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e?.stack || String(e)))
// erro dentro do tick de física (ex.: pathfinder com placingBlock indefinido) derrubava o processo:
// registra, cancela o caminho atual e segue (o supervisor ainda cobre o caso de cair de vez)
process.on('uncaughtException', (e) => {
  log.error('uncaughtException', (e?.stack || String(e)).slice(0, 600))
  try { current?.pathfinder?.setGoal(null) } catch {}
})
main()
