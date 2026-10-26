// Missão 1: começar do zero e montar uma fonte sustentável de esmeraldas (gravetos -> flecheiros).
// Cada etapa: done() verifica de forma determinística; run() executa localmente sem IA.
const { count, has, LOGS, StepError, Vec3 } = require('../skills/util')
const gather = require('../skills/gather')
const craft = require('../skills/craft')
const survival = require('../skills/survival')
const villager = require('../skills/villager')
const storage = require('../skills/storage')
const nav = require('../skills/nav')
const commands = require('../commands')
const memory = require('../memory')

// Tem a ferramenta (no inventário ou equipada) de pedra ou melhor.
const owns = (bot, name) => bot.inventory.slots.some(i => i && i.name === name)
const tier = (bot, kind) => ['stone', 'iron', 'diamond', 'netherite'].some(m => owns(bot, `${m}_${kind}`))
const stoneTools = (bot) => tier(bot, 'pickaxe') && tier(bot, 'axe') && tier(bot, 'sword')
// Kit inicial do dono: diamantes viram ferramentas + armadura (33 diamantes).
// armadura e espada primeiro: se faltar diamante, o que fica sem fazer é pá/machado
const KIT = ['diamond_chestplate', 'diamond_leggings', 'diamond_helmet', 'diamond_boots', 'diamond_sword', 'diamond_pickaxe', 'diamond_axe', 'diamond_shovel']
const KIT_COST = { diamond_pickaxe: 3, diamond_sword: 2, diamond_axe: 3, diamond_shovel: 1, diamond_helmet: 5, diamond_chestplate: 8, diamond_leggings: 7, diamond_boots: 4 }
const village = () => memory.state.places.filter(p => p.name === 'aldeia' && !p.noFletcher).at(-1)
// Aldeias já descartadas (sem flecheiro e sem desempregado) não contam de novo.
const discarded = (pos) => memory.state.places.some(p => p.name === 'aldeia' && p.noFletcher && Math.hypot(p.x - pos.x, p.z - pos.z) < 112)
const fletchers = () => Object.values(memory.state.villagers).filter(v => v.fletcher)

module.exports = {
  name: 'emeralds',
  title: 'fonte sustentável de esmeraldas (gravetos → flecheiros)',
  steps: [
    {
      id: 'stash',
      desc: 'guardando minhas coisas',
      done: (bot) => !storage.needsStash(bot),
      run: (bot) => storage.stashValuables(bot)
    },
    {
      id: 'restock',
      desc: 'pegando comida no baú',
      done: (bot) => survival.foodCount(bot) >= 8 || !memory.state.stash || memory.state.steps.restock?.empty,
      run: async (bot) => { if (!await storage.restockFood(bot)) { memory.state.steps.restock.empty = true; memory.save() } }
    },
    {
      id: 'kit',
      desc: 'montando kit de diamante',
      done: (bot) => KIT.every(n => owns(bot, n)) || memory.state.steps.kit?.noDiamonds,
      run: async (bot) => {
        const missing = KIT.filter(n => !owns(bot, n))
        const need = missing.reduce((t, n) => t + KIT_COST[n], 0) - count(bot, 'diamond')
        if (need > 0 && await storage.withdraw(bot, 'diamond', need) < need && count(bot, 'diamond') < 2) {
          memory.state.steps.kit.noDiamonds = true
          memory.save()
          return
        }
        if (count(bot, LOGS) < 2 && count(bot, /_planks$/) < 8) await gather.logs(bot, 3)
        for (const n of missing) {
          if (count(bot, 'diamond') < KIT_COST[n]) break
          await craft.craft(bot, n)
        }
        memory.history(`kit de diamante: ${KIT.filter(n => owns(bot, n)).join(', ')}`)
      }
    },
    {
      id: 'wood',
      outdoor: true,
      desc: 'pegando madeira',
      done: (bot) => stoneTools(bot) || has(bot, 'wooden_pickaxe') || count(bot, LOGS) >= 6,
      run: (bot, { signal }) => gather.logs(bot, 8, signal)
    },
    {
      id: 'wooden_pickaxe',
      desc: 'fazendo picareta de madeira',
      done: (bot) => has(bot, 'wooden_pickaxe') || tier(bot, 'pickaxe'),
      run: (bot) => craft.craft(bot, 'wooden_pickaxe')
    },
    {
      id: 'stone_tools',
      outdoor: true,
      desc: 'fazendo ferramentas de pedra',
      done: stoneTools,
      run: async (bot, { signal }) => {
        if (count(bot, LOGS) < 2 && count(bot, /_planks$/) < 6) await gather.logs(bot, 3, signal)
        const need = ['stone_pickaxe', 'stone_axe', 'stone_sword'].filter(n => !has(bot, n))
        await gather.stone(bot, need.length * 3 + 1, signal)
        for (const n of need) await craft.craft(bot, n)
        memory.history('ferramentas de pedra prontas')
      }
    },
    {
      id: 'food',
      outdoor: true,
      desc: 'caçando comida',
      done: (bot) => survival.foodCount(bot) >= 4 || bot.food >= 18,
      run: (bot, { signal }) => survival.hunt(bot, 6, signal)
    },
    {
      id: 'find_village',
      outdoor: true,
      desc: 'procurando aldeia',
      done: () => !!village(),
      run: async (bot, { signal }) => {
        const s = memory.state
        s.explore = s.explore || { angle: Math.floor(Math.random() * 360), legs: 0 }
        for (let i = 0; i < 6; i++) {
          const found = villager.villageHere(bot)
          if (found && !discarded(found)) {
            memory.addPlace('aldeia', found, bot.game.dimension, `${villager.villagers(bot, 80).length} aldeões`)
            memory.history(`aldeia encontrada em ${Math.round(found.x)} ${Math.round(found.z)}`)
            return
          }
          if (s.explore.legs % 5 === 4) s.explore.angle = (s.explore.angle + 72) % 360
          s.explore.legs++
          memory.save()
          await nav.wander(bot, 96, s.explore.angle, { signal }).catch(e => { if (e.code === 'aborted') throw e })
        }
        throw new StepError('searching', 'ainda procurando aldeia')
      }
    },
    {
      id: 'go_village',
      outdoor: true,
      desc: 'indo pra aldeia',
      done: (bot) => { const v = village(); return v && bot.entity.position.distanceTo(new Vec3(v.x, v.y, v.z)) < 48 },
      run: async (bot, { signal }) => {
        const v = village()
        if (await commands.tryHome(bot, v)) return
        await nav.goto(bot, nav.nearXZ(v.x, v.z, 8), { timeout: 600000, signal })
      }
    },
    {
      id: 'base',
      outdoor: true,
      desc: 'montando base na aldeia',
      done: () => !!memory.state.base?.chest,
      run: async (bot, { signal }) => {
        if (count(bot, LOGS) < 2 && count(bot, /_planks$/) < 8) await gather.logs(bot, 3, signal)
        await storage.ensureBaseChest(bot)
        await commands.trySetHome(bot)
      }
    },
    {
      id: 'fletcher',
      outdoor: true,
      desc: 'achando flecheiro',
      done: () => fletchers().length > 0,
      run: async (bot, { signal }) => {
        if (count(bot, 'stick') < 32) {
          await gather.logs(bot, Math.max(count(bot, LOGS), 8), signal)
          await craft.ensureSticks(bot, 32)
        }
        await villager.sellSticks(bot, { signal })
        if (fletchers().length) return
        try {
          await villager.makeFletcher(bot, { signal })
          villager.remember(villager.villagers(bot, 8)[0], { fletcher: true })
        } catch (e) {
          if (e.code !== 'no_jobless') throw e
          const v = village()
          const seen = villager.villagers(bot, 80).map(x => villager.profession(x)).join(', ') || 'nenhum'
          v.noFletcher = true
          memory.save()
          memory.history(`aldeia em ${v.x} ${v.z} sem flecheiro nem desempregado (aldeões: ${seen}); vou procurar outra`)
          memory.knowledge('Mecânicas', `aldeia ${v.x} ${v.z}: profissões vistas ${seen}`)
        }
      }
    },
    {
      id: 'trade_loop',
      outdoor: true,
      desc: 'farmando esmeralda com graveto',
      repeat: true,
      done: () => false,
      run: async (bot, { signal, setWait }) => {
        // 1) estoque de gravetos (16 troncos -> 128 gravetos)
        if (count(bot, 'stick') < 64) {
          await gather.logs(bot, 16, signal)
          await craft.ensureSticks(bot, Math.min(192, count(bot, LOGS) * 8 + count(bot, 'stick')))
        }
        // 2) volta pra aldeia e vende
        const v = village()
        if (bot.entity.position.distanceTo(new Vec3(v.x, v.y, v.z)) > 48) {
          if (!await commands.tryHome(bot, v)) await nav.goto(bot, nav.nearXZ(v.x, v.z, 8), { timeout: 600000, signal })
        }
        const got = await villager.sellSticks(bot, { signal })
        // 3) guarda esmeraldas
        if (count(bot, 'emerald') >= 16) await storage.deposit(bot, 'emerald', 0).catch(() => {})
        // 4) flecheiros esgotados -> espera reabastecer (dia do jogo) em vez de repetir à toa
        if (got === 0 && count(bot, 'stick') >= 64) setWait(5 * 60000, 'esperando aldeão reabastecer')
      }
    }
  ]
}
