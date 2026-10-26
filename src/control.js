// Controle local (127.0.0.1): status, pausar, continuar, objetivo, encerrar. Usado pelo ctl.ps1 e pelo MCP.
const http = require('http')
const fs = require('fs')
const path = require('path')
const config = require('./config')
const memory = require('./memory')
const log = require('./log')

function start (controller, getBot, shutdown) {
  const routes = {
    'GET /status': () => controller.status(),
    'POST /pause': () => { controller.pause(); return { ok: true } },
    'POST /resume': () => { controller.resume(); return { ok: true } },
    'POST /stop': () => { setTimeout(shutdown, 200); return { ok: true } },
    'POST /goal': (body) => { memory.state.goal = String(body.goal || '').slice(0, 200); memory.save(); memory.decision(`objetivo manual: ${memory.state.goal}`); return { ok: true } },
    'POST /say': (body) => {
      const t = String(body.text || '').slice(0, 100)
      if (!t || t.startsWith('/login') || t.startsWith('/register')) return { ok: false }
      getBot()?.chat(t)
      return { ok: true }
    },
    'POST /step/reset': (body) => { delete memory.state.steps[body.step]; memory.save(); return { ok: true } },
    'GET /inventory': () => (getBot()?.inventory.items() || []).map(i => `${i.name} x${i.count}`)
  }
  routes['GET /view'] = () => require('./view').build(controller, getBot())
  routes['GET /stock'] = () => require('./stock').view(getBot())
  routes['POST /stock/check'] = () => {
    if (!getBot()?.entity) return { ok: false, motivo: 'offline' }
    const ok = controller.queue('estoque', 'conferindo baús', (bot, signal) => require('./skills/storage').checkChests(bot, signal))
    return { ok, motivo: ok ? 'na fila: o bot vai até os baús e atualiza o estoque' : 'já está na fila' }
  }
  routes['POST /cmd'] = (body) => getBot()?.entity ? require('./commands').run(getBot(), body.cmd) : { ok: false, motivo: 'offline' }
  routes['POST /action/home'] = () => {
    if (!getBot()?.entity) return { ok: false, motivo: 'offline agora' }
    const ok = controller.queue('home', 'voltando pra base', (bot) => require('./commands').tryHome(bot))
    return { ok, motivo: ok ? 'na fila: /home base (só de dia e se estiver longe)' : 'já está na fila' }
  }
  // sai do servidor por N minutos (ataque de saqueadores, área perigosa) e volta sozinho
  routes['POST /away'] = (body) => {
    const b = getBot()
    const min = Math.max(1, Math.min(60, Number(body.min) || 10))
    if (!b?.quitWith) return { ok: false, motivo: 'offline' }
    log.warn(`fora do servidor por ${min} min (pedido no painel)`)
    b.quitWith(`escape:${min * 60000}`)
    return { ok: true, motivo: `saindo por ${min} min` }
  }
  routes['GET /chat'] = () => require('./chat').recentChat(40)
  // Diagnóstico: blocos em volta do bot (x/z ±2, y -1..+2) e o goal atual do pathfinder.
  routes['GET /debug/near'] = () => {
    const b = getBot()
    if (!b?.entity) return null
    const p = b.entity.position.floored()
    const out = {}
    for (let y = -1; y <= 2; y++) {
      const rows = []
      for (let z = -2; z <= 2; z++) {
        const row = []
        for (let x = -2; x <= 2; x++) row.push((b.blockAt(p.offset(x, y, z))?.name || '?').replace(/_/g, '').slice(0, 8))
        rows.push(row.join(' '))
      }
      out[`y${y >= 0 ? '+' : ''}${y}`] = rows
    }
    return { pos: p, moving: b.pathfinder?.isMoving(), goal: b.pathfinder?.goal?.constructor?.name, near: out }
  }
  // Diagnóstico: pula para frente na direção dada (yaw em graus mineflayer) e devolve antes/depois.
  routes['POST /debug/jump'] = async (body) => {
    const b = getBot()
    if (!b?.entity) return null
    const before = b.entity.position.clone()
    b.pathfinder?.setGoal(null)
    controller.pause()
    await b.look((body.yaw || 0) * Math.PI / 180, 0, true)
    let maxY = before.y
    let corrections = 0
    let lastCorrection = null
    const onPos = (p) => { corrections++; lastCorrection = p }
    b._client.on('position', onPos)
    const t = setInterval(() => { maxY = Math.max(maxY, b.entity.position.y) }, 25)
    if (body.forward !== false) b.setControlState('forward', true)
    if (body.jump !== false) b.setControlState('jump', true)
    await new Promise(r => setTimeout(r, body.ms || 900))
    b.clearControlStates()
    await new Promise(r => setTimeout(r, 400))
    clearInterval(t)
    b._client.removeListener('position', onPos)
    return { before, after: b.entity.position, maxY, corrections, lastCorrection, onGround: b.entity.onGround, physics: b.physicsEnabled }
  }
  // blocos e entidades em coordenadas dadas: { points: [[x, y, z], ...] }
  routes['POST /debug/blocks'] = (body) => {
    const b = getBot()
    if (!b?.entity) return null
    const { Vec3 } = require('./skills/util')
    return (body.points || []).slice(0, 40).map(([x, y, z]) => {
      const blk = b.blockAt(new Vec3(x, y, z))
      const ents = Object.values(b.entities).filter(e => e.position && Math.abs(e.position.x - (x + 0.5)) < 1.2 && Math.abs(e.position.z - (z + 0.5)) < 1.2 && Math.abs(e.position.y - y) < 2).map(e => e.name)
      return { p: [x, y, z], block: blk?.name, box: blk?.boundingBox, ents }
    })
  }
  routes['POST /debug/bucket'] = async () => {
    const b = getBot()
    if (!b?.entity) return null
    const { Vec3, sleep } = require('./skills/util')
    const nav = require('./skills/nav')
    controller.pause()
    const out = {}
    const spots = b.findBlocks({ matching: [b.registry.blocksByName.water.id], maxDistance: 64, count: 30, useExtraInfo: x => x.metadata === 0 && b.blockAt(x.position.offset(0, 1, 0))?.name === 'air' })
    out.spots = spots.slice(0, 3).map(p => p.toString())
    const p = spots[0]
    if (!p) return { ...out, erro: 'sem agua' }
    await nav.goto(b, nav.nearXZ(p.x, p.z, 5), { timeout: 60000 }).catch(e => { out.nav = e.message })
    await nav.goto(b, new nav.goals.GoalLookAtBlock(p, b.world, { reach: 4 }), { timeout: 30000 }).catch(e => { out.nav2 = e.message })
    const bucket = b.inventory.items().find(i => i.name === 'bucket')
    out.temBalde = !!bucket
    if (!bucket) return out
    await b.equip(bucket, 'hand')
    out.mao = b.heldItem?.name
    out.dist = b.entity.position.offset(0, 1.62, 0).distanceTo(p.offset(0.5, 1, 0.5)).toFixed(2)
    await b.lookAt(p.offset(0.5, 0.9, 0.5), true)
    await sleep(300)
    out.yawPitch = [b.entity.yaw.toFixed(2), b.entity.pitch.toFixed(2)]
    out.mira = b.blockAtCursor(5)?.name
    b.activateItem()
    await sleep(800)
    out.depois = b.heldItem?.name
    out.temAguaBalde = b.inventory.items().some(i => i.name === 'water_bucket')
    controller.resume()
    return out
  }
  routes['GET /debug/attrs'] = () => getBot()?.entity?.attributes || null
  routes['POST /plan'] = (body) => require('./planner').plan(controller, getBot(), body.question)
  const page = path.join(__dirname, '..', 'public', 'index.html')
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      return fs.createReadStream(page).on('error', () => { res.statusCode = 404; res.end('sem painel') }).pipe(res)
    }
    let raw = ''
    req.on('data', d => { raw += d })
    req.on('end', async () => {
      const fn = routes[`${req.method} ${req.url}`]
      res.setHeader('content-type', 'application/json')
      if (!fn) { res.statusCode = 404; return res.end('{"error":"rota desconhecida"}') }
      try { res.end(JSON.stringify(await fn(raw ? JSON.parse(raw) : {}))) } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })) }
    })
  })
  // Painel na rede local (sem PIN, por escolha do dono). PANEL_HOST=127.0.0.1 restringe ao PC.
  server.listen(config.controlPort, config.panelHost, () => {
    const lan = Object.values(require('os').networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => `http://${i.address}:${config.controlPort}`)
    log.info(`painel: http://127.0.0.1:${config.controlPort} ${config.panelHost === '0.0.0.0' ? '· celular: ' + lan.join(' ') : ''}`)
  })
  return server
}

module.exports = { start }
