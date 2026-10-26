// Injeta os dados 26.2 (PrismarineJS/minecraft-data PR #1339) no pacote npm minecraft-data,
// que ainda só publica até 26.1. Roda no postinstall.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const root = path.join(__dirname, '..')
const src = path.join(root, 'vendor', 'minecraft-data', 'data')
const pkg = path.join(root, 'node_modules', 'minecraft-data')
const dst = path.join(pkg, 'minecraft-data', 'data')

if (!fs.existsSync(src)) {
  console.error('vendor/minecraft-data ausente: rode scripts\\setup.ps1')
  process.exit(1)
}
fs.rmSync(dst, { recursive: true, force: true })
fs.cpSync(src, dst, { recursive: true })
execFileSync(process.execPath, [path.join(pkg, 'bin', 'generate_data.js')], { cwd: pkg, stdio: 'inherit' })
// Libs prismarine com tabelas fixas de versão: 26.2 usa a mesma implementação de 26.1.
function patch (rel, fn) {
  const f = path.join(root, 'node_modules', rel)
  if (!fs.existsSync(f)) return
  const src = fs.readFileSync(f, 'utf8')
  const out = fn(src)
  if (out !== src) { fs.writeFileSync(f, out); console.log('patch:', rel) }
}
patch('prismarine-chunk/src/index.js', s => s.includes("'26.2'") ? s : s.replace("26.1: require('./pc/1.18/chunk')", "26.1: require('./pc/1.18/chunk'),\n    '26.2': require('./pc/1.18/chunk')"))
patch('prismarine-physics/lib/features.json', s => s.replace(/"26\.1"\]/g, '"26.1", "26.2"]'))
patch('minecraft-protocol/src/version.js', s => s.includes("'26.2'") ? s : s.replace("'1.21.11', '26.1']", "'1.21.11', '26.1', '26.2']"))
delete require.cache[require.resolve('minecraft-data')]
const ok = require('minecraft-data')('26.2')
console.log('minecraft-data 26.2:', ok ? `protocol ${ok.version.version}` : 'FALHOU')
