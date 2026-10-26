// Segue o log do agente (polling; `tail -F` não entrega eventos no Git Bash do Windows) e imprime só
// as linhas que batem com o padrão. Uso: node scripts/watch-log.js "regex"
const fs = require('fs')
const path = require('path')
const re = new RegExp(process.argv[2] || 'evento death|\\[error\\]')
const file = () => path.join(__dirname, '..', 'data', 'logs', `agent-${new Date().toISOString().slice(0, 10)}.log`)
let name = file()
let pos = fs.existsSync(name) ? fs.statSync(name).size : 0
setInterval(() => {
  if (file() !== name) { name = file(); pos = 0 }
  if (!fs.existsSync(name)) return
  const size = fs.statSync(name).size
  if (size <= pos) return
  const fd = fs.openSync(name, 'r')
  const buf = Buffer.alloc(size - pos)
  fs.readSync(fd, buf, 0, buf.length, pos)
  fs.closeSync(fd)
  pos = size
  for (const line of buf.toString('utf8').split('\n')) if (re.test(line)) console.log(line.slice(11, 180))
}, 2000)
