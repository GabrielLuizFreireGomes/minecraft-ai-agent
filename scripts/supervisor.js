// Mantém o agente rodando: se o processo cair (crash, /stop para reiniciar após uma melhoria), sobe
// de novo em 5 s. Só para de verdade com data/stop.flag (ctl.bat stop). Uma instância por vez.
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const data = path.join(root, 'data')
const pidFile = path.join(data, 'supervisor.pid')
const stopFlag = path.join(data, 'stop.flag')
const logFile = path.join(data, 'supervisor.log')
const say = (m) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`)

try {
  const old = +fs.readFileSync(pidFile, 'utf8')
  if (old && old !== process.pid) { process.kill(old, 0); say(`já existe supervisor (pid ${old}), saindo`); process.exit(0) }
} catch {}
fs.writeFileSync(pidFile, String(process.pid))
try { fs.unlinkSync(stopFlag) } catch {}

let starts = []
function run () {
  if (fs.existsSync(stopFlag)) { say('stop.flag: encerrando supervisor'); try { fs.unlinkSync(pidFile) } catch {} ; process.exit(0) }
  starts = starts.filter(t => t > Date.now() - 10 * 60000)
  starts.push(Date.now())
  const out = fs.openSync(path.join(data, 'run.out'), 'a')
  const err = fs.openSync(path.join(data, 'run.err'), 'a')
  const child = spawn(process.execPath, ['--env-file=.env', 'src/index.js'], { cwd: root, stdio: ['ignore', out, err], windowsHide: true })
  say(`agente iniciado (pid ${child.pid})`)
  child.on('exit', (code) => {
    say(`agente saiu (código ${code})`)
    // caindo em loop (10 subidas em 10 min): espera mais antes de tentar de novo
    setTimeout(run, starts.length >= 10 ? 120000 : 5000)
  })
}
run()
