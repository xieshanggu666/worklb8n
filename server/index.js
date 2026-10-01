import express from 'express'
import { db, run, all, get } from './db.js'

const app = express()
app.use(express.json())
const PORT = Number(process.env.PORT) || 4180
const PTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1]
// 天气对整场比赛的总体系数（用于部件磨损判定等）
const WEATHER = { '晴': 1.0, '风': 0.96, '雨': 0.9, '雾': 0.84, '雷暴': 0.78 }
// 天气对三个分段的发挥系数：雾/雷暴在「中段云流」「冲线段」压制更大
const SEG_WEATHER = {
  '晴':   [1.00, 1.00, 1.00],
  '风':   [0.99, 0.94, 0.96],
  '雨':   [0.94, 0.89, 0.91],
  '雾':   [0.92, 0.80, 0.85],
  '雷暴': [0.88, 0.72, 0.78]
}
// 三个分段：名称 + 四项性能在该段的权重（启航拼加速、中段拼极速转向、冲线拼极速爆发）
const SEGMENTS = [
  { key: 'start', name: '启航段', w: { speed: 0.28, turn: 0.14, acc: 0.30, dur: 0.10 } },
  { key: 'mid', name: '中段云流', w: { speed: 0.38, turn: 0.20, acc: 0.16, dur: 0.14 } },
  { key: 'finish', name: '冲线段', w: { speed: 0.40, turn: 0.14, acc: 0.20, dur: 0.14 } }
]
const SEG_K = 260           // 分段用时换算系数：t = SEG_K / pace（秒）
const AI_NAMES = ['苍穹极光', '翡翠之翼', '雷鸣环驾', '暮色猎手', '星尘漂流']
const AI_COLORS = ['#7ecbff', '#b19cff', '#6fe7d0', '#ff9fb0', '#ffb85c']
const PLAYER_COLOR = '#ffcf5c'
const FLAVOR = {
  '晴': ['晴空暖流，各艇全速巡航', '上升气流托举艇身，编队顺畅通航', '云絮拂面，引擎工况极佳'],
  '风': ['侧风突袭，舵面负荷加大！', '一阵横切气流扫过航线，队形被打乱', '逆风段来临，飞艇纷纷压低航向'],
  '雨': ['雨幕遮蔽视野，编队整体减速', '冰晶打在护甲上噼啪作响', '积雨云边缘湿滑，过弯需格外谨慎'],
  '雾': ['浓雾中能见度骤降，只能凭仪表飞行', '乳白雾气吞没了半个编队', '领航员紧盯着罗盘穿出雾团'],
  '雷暴': ['一道惊雷掠过，护甲承受冲击！', '雷暴电场干扰仪表，航向微微偏移', '闪电点亮云谷，众艇冒死突进']
}
const now = () => new Date().toLocaleString('zh-CN')
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
// 确定性伪随机：同一场比赛的分段过程与事件只生成一次，之后回放永远一致
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ================= 零件商店：商品配置（服务端唯一事实来源） =================
 * 客户端只能按 id 下单；名称、槽位、加成项、加成数值与价格一律由服务端从这份配置取值，
 * 请求体中夹带的 price/bonus/stat/slot/name 一律忽略，杜绝「1 元购入 +9999 性能件」
 * 之类越权改写经济与比赛性能的请求。
 */
const VALID_SLOTS = ['引擎', '翼板', '氮气', '龙骨', '护甲']
const VALID_STATS = ['speed', 'turn', 'acc', 'dur']
const SHOP_ITEMS = [
  { id: 1, name: '竞速涡轮', slot: '引擎', stat: 'speed', bonus: 14, price: 2600 },
  { id: 2, name: '流线翼板', slot: '翼板', stat: 'speed', bonus: 9, price: 1800 },
  { id: 3, name: '氮气助推', slot: '氮气', stat: 'acc', bonus: 16, price: 2200 },
  { id: 4, name: '回旋舵', slot: '龙骨', stat: 'turn', bonus: 12, price: 2000 },
  { id: 5, name: '云母护甲', slot: '护甲', stat: 'dur', bonus: 15, price: 2400 },
  { id: 6, name: '轻量合金', slot: '翼板', stat: 'acc', bonus: 11, price: 1900 },
  { id: 7, name: '蓝纹喷射引擎', slot: '引擎', stat: 'speed', bonus: 20, price: 3200 },
  { id: 8, name: '硬壳鳞甲', slot: '护甲', stat: 'dur', bonus: 22, price: 3400 }
]
const SHOP_MAP = new Map(SHOP_ITEMS.map(i => [i.id, i]))
// 启动即自检：非法商品配置应在上线前暴露，而不是等玩家下单
for (const it of SHOP_ITEMS) {
  const ok = VALID_SLOTS.includes(it.slot) && VALID_STATS.includes(it.stat) &&
    Number.isInteger(it.bonus) && it.bonus > 0 && it.bonus <= 100 &&
    Number.isInteger(it.price) && it.price > 0 && typeof it.name === 'string' && it.name.trim()
  if (!ok) throw new Error('[SKY] 商店商品配置非法：' + JSON.stringify(it))
}

/* ================= 飞艇租赁：艇型目录（服务端唯一事实来源） =================
 * 与商店同口径：客户端只能按 id 签约；性能、押金、租金、租约场次与磨损费率一律以这份
 * 配置为准，请求体夹带的任何价格/性能字段都不被采信。押金+租金在签约时一次扣除，
 * 归还时按「累计磨损 × 磨损费率」从押金中结算退款（租金不退）。
 */
const RENTAL_SHIPS = [
  { id: 1, name: '雨燕·轻竞技', speed: 66, turn: 62, acc: 72, dur: 64, deposit: 2400, rent: 600, maxRaces: 2, wearRate: 35 },
  { id: 2, name: '猎鹰·巡航者', speed: 76, turn: 72, acc: 74, dur: 80, deposit: 4500, rent: 1200, maxRaces: 3, wearRate: 50 },
  { id: 3, name: '雷霆·竞速型', speed: 88, turn: 76, acc: 88, dur: 70, deposit: 7200, rent: 2000, maxRaces: 3, wearRate: 65 },
  { id: 4, name: '星凰·旗舰', speed: 97, turn: 91, acc: 93, dur: 90, deposit: 11000, rent: 3200, maxRaces: 4, wearRate: 85 }
]
const RENTAL_MAP = new Map(RENTAL_SHIPS.map(s => [s.id, s]))
for (const s of RENTAL_SHIPS) {
  const ok = ['speed', 'turn', 'acc', 'dur', 'deposit', 'rent', 'maxRaces', 'wearRate']
    .every(k => Number.isInteger(s[k]) && s[k] > 0) && typeof s.name === 'string' && s.name.trim()
  if (!ok) throw new Error('[SKY] 租赁艇型配置非法：' + JSON.stringify(s))
}

function seed() {
  if (get('SELECT COUNT(*) c FROM team').c > 0) return
  run('INSERT INTO team (name) VALUES (?)', '苍穹疾风战队')
  run('INSERT INTO airships (name) VALUES (?)', '云雀·I').lastInsertRowid
  run('INSERT INTO pilots (name,skill,courage,exp,wage,mood) VALUES (?,?,?,?,?,?)', '奥罗·晨曦', 62, 58, 20, 80, 75)
  run('INSERT INTO pilots (name,skill,courage,exp,wage,mood) VALUES (?,?,?,?,?,?)', '莉娜·云涛', 55, 65, 8, 55, 82)
  run('INSERT INTO mechanics (name,skill,wage,mood) VALUES (?,?,?,?)', '格蕾丝·铆钉', 58, 45, 78)
  const ups = SHOP_ITEMS.map(i => [i.name, i.slot, i.stat, i.bonus, i.price])
  ups.forEach(([n, slot, stat, bonus, price]) => run('INSERT INTO upgrades (name,slot,stat,bonus,price) VALUES (?,?,?,?,?)', n, slot, stat, bonus, price))
  const cir = [['晨雾浮岛','1','雾'],['雷鸣云谷','2','雷暴'],['翡翠群岛','3','晴'],['风暴裂谷','3','雨'],['极光穹顶','4','风'],['星界之巅','5','雾']]
  cir.forEach(([n, d, w]) => run('INSERT INTO circuits (name,diff,weather,bonus_pts) VALUES (?,?,?,?)', n, Number(d), w, Number(d) * 4))
  const spo = [['云帆工坊', 12, 4000, 8], ['星罗航空', 22, 8000, 15], ['流风动力', 32, 14000, 22], ['苍穹商会', 45, 22000, 32]]
  spo.forEach(([n, t, r, rep]) => run('INSERT INTO sponsors (name,target,reward,rep) VALUES (?,?,?,?)', n, t, r, rep))
}
export function teamCore() { return get('SELECT * FROM team WHERE id=1') }
export function airship() { return all('SELECT * FROM airships')[0] || { speed: 60, dur: 80, turn: 55, acc: 60, parts_dur: 100, hp: 100, name: '云雀·I', id: 1 } }
// 当前生效的租约（每车队同时仅一份；null = 使用自有艇）
function activeRental() { return get("SELECT * FROM rentals WHERE status='active' ORDER BY id DESC LIMIT 1") || null }
// 比赛开赛快照中本场出赛艇的租约（不区分 active/returned）。
// 结算与回滚的磨损归属、退款口径永远以这份快照为唯一依据，而不是「此刻是否在履租约」——
// 否则租约归还后再结算/回滚，会错扣自有艇磨损或漏退已钱货两讫的磨损费。
function raceRental(rec) {
  const rtId = rec?.factors?.rental?.id
  return rtId ? get('SELECT * FROM rentals WHERE id=?', rtId) : null
}
export function fleetStats() {
  // 租约期间车队以租赁艇出赛：基础四项与部件健康取自租约快照，自有艇入库封存不磨损
  const rt = activeRental()
  const a = rt || airship()
  const up = all('SELECT * FROM upgrades WHERE equipped=1')
  const s = { speed: a.speed, dur: a.dur, turn: a.turn, acc: a.acc, name: a.name, id: a.id, parts_dur: a.parts_dur, hp: a.hp ?? 100 }
  up.forEach(u => { s[u.stat] = (s[u.stat] || 0) + u.bonus })
  if (rt) s.rental = { id: rt.id, name: rt.name, racesLeft: rt.max_races - rt.races_used, maxRaces: rt.max_races, wearTotal: rt.wear_total }
  return s
}
function leadPilot() { return all('SELECT * FROM pilots ORDER BY (skill+courage) DESC')[0] || null }
function topMech() { return all('SELECT * FROM mechanics ORDER BY skill DESC')[0] || null }
function leadership(p) {
  if (!p) return 20
  return (p.skill + p.courage) / 2 * 0.4 + p.exp * 0.15 + (p.mood - 50) * 0.08
}
function mechBonus(m) {
  if (!m) return 10
  return m.skill * 0.12 + (m.mood - 50) * 0.06
}
// 赛站必须按 id（航线下行→上行）顺序参赛，前一站未完赛前后续赛站一律锁定
function orderedCircuits() { return all('SELECT * FROM circuits ORDER BY id ASC') }
// 当前唯一允许参赛的赛站：航线上第一个未完成的赛站；全部完赛时为 null
function nextCircuit() { return orderedCircuits().find(c => !c.finished) || null }

/* ================= 比赛记录：动画 / 实时排名 / 最终奖励共用的唯一事实来源 ================= */

// 某分段内「性能发挥」→ pace：受天气、改装（已含在 st）、部件健康、机师/技工状态共同影响
function playerPace(st, seg, wF, lead, mech, grit, rng) {
  const statPts = st.speed * seg.w.speed + st.turn * seg.w.turn + st.acc * seg.w.acc + st.dur * seg.w.dur
  const parts = clamp(st.parts_dur / 100, 0.62, 1.12)
  const wEff = 1 - (1 - wF) * grit                    // 机师胆识越高，越能扛住坏天气
  const raw = (statPts * parts * wEff + lead + mech)
  return raw * (1 + (rng() * 0.22 - 0.11))
}
function aiPace(ai, seg, wF, rng) {
  const grit = 0.5 + ai.courage / 200                // 对手机师的天气抗性（与玩家同口径）
  const wEff = 1 - (1 - wF) * grit
  const statPts = 57 + 6 * ai.diff + ai.skill * 0.07
  const crew = ai.skill * 0.17 + ai.courage * 0.06 + (ai.mood - 50) * 0.04
  const profile = ai.profile[SEGMENTS.indexOf(seg)]  // 每艘 AI 艇的分段特长
  return (statPts + crew) * wEff * profile * (1 + (rng() * 0.18 - 0.09))
}

// 生成完整比赛记录（结果在开赛瞬间即确定，后续只是对这份记录的播放与结算）
function buildRace(c) {
  const t = teamCore()
  const st = fleetStats()
  const pilot = leadPilot()
  const mech = topMech()
  const mods = all('SELECT * FROM upgrades WHERE equipped=1').map(u => ({ id: u.id, name: u.name, slot: u.slot, stat: u.stat, bonus: u.bonus }))
  const lead = leadership(pilot)
  const mechB = mechBonus(mech)
  const grit = 0.5 + (pilot?.courage || 50) / 200
  const segW = SEG_WEATHER[c.weather] || [1, 1, 1]
  const rng = mulberry32((Date.now() & 0xffffffff) ^ (c.id * 2654435761))

  // 5 名对手，共 6 艇竞技；各自带机师状态与分段特长，档位参差保证每场有慢艇也有快车
  const ais = AI_NAMES.map((name, i) => ({
    name, color: AI_COLORS[i], diff: c.diff,
    skill: 48 + c.diff * 4 + Math.floor(rng() * 10) + (-17 + Math.floor(rng() * 40)),
    courage: 40 + Math.floor(rng() * 40),
    mood: 58 + Math.floor(rng() * 38),
    profile: [0.97 + rng() * 0.06, 0.97 + rng() * 0.06, 0.97 + rng() * 0.06]
  }))

  const racers = [{ id: 'p', name: t.name, color: PLAYER_COLOR, isPlayer: true, paces: [], segW: [], times: [], entry: [0] }]
  ais.forEach(ai => racers.push({ id: 'ai' + ai.name, name: ai.name, color: ai.color, isPlayer: false, ai, skill: ai.skill, courage: ai.courage, mood: ai.mood, paces: [], segW: [], times: [], entry: [0] }))

  SEGMENTS.forEach((seg, si) => {
    racers.forEach(r => {
      const gritP = r.isPlayer ? grit : (0.5 + r.ai.courage / 200)
      const wF = segW[si]                            // 同一场天气对所有艇一致，差异只在机师抗性
      const wEff = 1 - (1 - wF) * gritP
      const pace = r.isPlayer
        ? playerPace(st, seg, wF, lead, mechB, grit, rng) * (1 + c.diff * 0.006)
        : aiPace(r.ai, seg, wF, rng)
      const time = SEG_K / Math.max(1, pace)
      r.paces.push(Math.round(pace * 100) / 100)
      r.segW.push(Math.round(wEff * 1000) / 1000)
      r.times.push(Math.round(time * 1000) / 1000)
      r.entry.push(Math.round((r.entry[si] + time) * 1000) / 1000)
    })
  })
  racers.forEach(r => { r.total = r.entry[3] })

  // 总用时排序得最终名次（玩家名次），动画、LIVE 榜、奖励全部以此为准
  const order = [...racers].sort((a, b) => a.total - b.total)
  const rank = order.findIndex(r => r.isPlayer) + 1
  const pts = PTS[rank - 1] || 1
  const money = Math.round((600 + (7 - rank) * 180) * (1 + c.diff * 0.05))
  const wear = 5 + c.diff * 3 + (WEATHER[c.weather] < 0.9 ? 4 : 0)
  const repGain = Math.max(1, 5 - rank + c.diff)

  // 分段事件：分段节点的名次变化（超车）+ 天气氛围事件，计时锚点取玩家艇自身时间轴
  const events = []
  const flavors = FLAVOR[c.weather] || FLAVOR['晴']
  let prevRank = null
  SEGMENTS.forEach((seg, si) => {
    const segOrder = [...racers].sort((a, b) => a.entry[si + 1] - b.entry[si + 1])
    const pRank = segOrder.findIndex(r => r.isPlayer) + 1
    const tEnd = racers[0].entry[si + 1]
    if (prevRank && pRank < prevRank) {
      const behind = segOrder[pRank] // segOrder 为 0 基；玩家位于 pRank-1，紧随其后的即索引 pRank
      events.push({ t: +(tEnd - 0.35).toFixed(2), type: 'overtake', text: `你在「${seg.name}」超越 ${behind ? behind.name : '对手'}，升至第 ${pRank} 位！` })
    }
    events.push({ t: +(racers[0].entry[si] + racers[0].times[si] * 0.5).toFixed(2), type: 'flavor', text: flavors[Math.floor(rng() * flavors.length)] })
    prevRank = pRank
  })
  events.sort((a, b) => a.t - b.t)

  racers.forEach(r => { delete r.ai }) // ai 仅引擎内部使用，其字段已展开到记录顶层
  const duration = Math.max(...racers.map(r => r.total)) + 0.15
  return {
    v: 1,
    circuit: { id: c.id, name: c.name, diff: c.diff, weather: c.weather },
    season: t.season,
    segments: SEGMENTS.map(s => ({ key: s.key, name: s.name })),
    factors: {
      weather: c.weather,
      weatherCoeff: WEATHER[c.weather] || 1,
      segWeather: segW,
      base: { speed: st.speed - mods.filter(m => m.stat === 'speed').reduce((a, m) => a + m.bonus, 0),
        turn: st.turn - mods.filter(m => m.stat === 'turn').reduce((a, m) => a + m.bonus, 0),
        acc: st.acc - mods.filter(m => m.stat === 'acc').reduce((a, m) => a + m.bonus, 0),
        dur: st.dur - mods.filter(m => m.stat === 'dur').reduce((a, m) => a + m.bonus, 0) },
      parts_dur: st.parts_dur,
      // 本场出赛租约快照：结算时磨损记入该租约；null = 自有艇出赛
      rental: st.rental ? { id: st.rental.id, name: st.rental.name } : null,
      mods,
      pilot: pilot ? { id: pilot.id, name: pilot.name, skill: pilot.skill, courage: pilot.courage, exp: pilot.exp, mood: pilot.mood } : null,
      mech: mech ? { id: mech.id, name: mech.name, skill: mech.skill, mood: mech.mood } : null,
      detail: { parts: +clamp(st.parts_dur / 100, 0.62, 1.12).toFixed(2), lead: +lead.toFixed(1), mech: +mechB.toFixed(1), grit: +grit.toFixed(2) }
    },
    racers,
    events,
    result: { rank, pts, money, wear, repGain },
    duration: +duration.toFixed(2)
  }
}

// 读取/解析比赛记录
const parseRace = r => (r ? { ...r, settled: !!r.settled, record: JSON.parse(r.record) } : null)
function getRaceRow(id) { return get('SELECT * FROM races WHERE id=?', Number(id)) }
// 单场已结算比赛的发奖口径（与 settleRace 完全一致）；历史修复按此逐项反向回滚
function raceEffect(row, c) {
  let rec = null
  try { rec = JSON.parse(row.record) } catch (e) { rec = null }
  const rank = row.rank ?? rec?.result?.rank ?? c?.rank ?? 6
  const pts = row.pts ?? rec?.result?.pts ?? (PTS[rank - 1] || 1)
  const money = row.money ?? rec?.result?.money ?? 0
  const wear = row.wear ?? rec?.result?.wear ?? 0
  const repGain = row.rep_gain ?? rec?.result?.repGain ?? Math.max(1, 5 - rank + (c?.diff || 0))
  return { row, rec, rank, pts, money, wear, repGain }
}
// 反向回滚单场已结算比赛：部件磨损（parts_dur/hp）与机师经验、心情同积分奖金一道冲回，
// 保证「资源状态」与「战绩」始终一致。维护等操作若已介入，恢复值以 100 为上限，不会溢出。
//
// 磨损归属以开赛快照为准（raceRental），与 settleRace 完全对称：
//  - 租约仍在履行：磨损与场次回滚到租约，不动钱（押金尚未结算）；
//  - 租约已归还：归还时已按累计磨损计费钱货两讫——先回滚累计磨损/场次，再按「本场磨损对应的
//    边际磨损费」补退（押金−磨损费的下限 0 效应按重算结果保留），并回写 wear_fee/refund，
//    使租约行与比赛结果重新自洽；自有艇封存未磨损，绝不回错对象；
//  - 无租约（自有艇出赛）：恢复自有艇 parts_dur/hp。
// 返回 refundAdd（需要在调用方统一补给车队资金的退款），资金改动只在单一边界发生，保证幂等。
function reverseSettledRace(row, c) {
  const g = raceEffect(row, c)
  const rt = raceRental(g.rec)
  let refundAdd = 0
  if (rt && rt.status === 'active') {
    // 该场为租约艇出赛且租约仍在履行：磨损与已用场次一并回滚到租约（恢复以 100 为上限）
    run('UPDATE rentals SET parts_dur=MIN(100,parts_dur+?), wear_total=MAX(0,wear_total-?), races_used=MAX(0,races_used-1) WHERE id=?',
      g.wear, g.wear, rt.id)
  } else if (rt && rt.status === 'returned') {
    // 归还已结算：把本场磨损从「已计费基数」中剔除，按剩余磨损重算边际磨损费与押金退款
    const wearTotal2 = Math.max(0, (rt.wear_total || 0) - g.wear)
    const wearFee2 = wearTotal2 * rt.wear_rate
    const refund2 = Math.max(0, (rt.deposit || 0) - wearFee2)
    refundAdd = Math.max(0, refund2 - (rt.refund || 0))
    run('UPDATE rentals SET parts_dur=MIN(100,parts_dur+?), wear_total=?, races_used=MAX(0,races_used-1), wear_fee=?, refund=? WHERE id=?',
      g.wear, wearTotal2, wearFee2, refund2, rt.id)
  } else if (!rt) {
    // 自有艇出赛：恢复自有艇磨损
    const a = airship()
    run('UPDATE airships SET parts_dur=MIN(100,parts_dur+?), hp=MIN(100,hp+?) WHERE id=?', g.wear, g.wear, a.id)
  }
  // 租约记录缺失：无归属可回（数据已不在），保持与正向口径一致，不动任何部件与资金
  const pilotId = g.rec?.factors?.pilot?.id
  if (pilotId) {
    const expGain = g.rank <= 4 ? 3 : 1   // 与 settleRace 的发奖口径逐字对应
    const moodLoss = g.rank > 8 ? 6 : 2
    run('UPDATE pilots SET exp=MAX(0,exp-?), mood=MIN(100,MAX(0,mood+?)) WHERE id=?',
      expGain, moodLoss, pilotId)
  }
  return { ...g, refundAdd }
}
function settleRace(id) {
  const row = getRaceRow(id)
  if (!row) return { ok: false, status: 404, msg: '比赛记录不存在' }
  if (row.status === 'void') return { ok: false, status: 409, msg: '该比赛已在历史修复中作废，不能再次结算' }
  if (row.settled) return { ok: true, already: true, race: parseRace(row) } // 幂等：重复结算直接返回，不重复发奖

  const rec = JSON.parse(row.record)
  const c = get('SELECT * FROM circuits WHERE id=?', row.circuit_id)
  let result
  db.exec('BEGIN')
  try {
    // 事务内二次确认闸门：同步执行下杜绝并发/重放造成的重复发奖
    const again = getRaceRow(id)
    if (again.status === 'void') {
      result = { ok: false, status: 409, msg: '该比赛已在历史修复中作废，不能再次结算' }
    } else if (again.settled) {
      result = { ok: true, already: true, race: parseRace(again) }
    } else if (c?.finished) {
      // 极端兜底：赛站已被另一场比赛结算 → 本条记录作废，绝不重复发奖，也不混入历史战绩
      run("UPDATE races SET status='void', settled=0, voided_at=? WHERE id=?", now(), row.id)
      result = { ok: false, status: 409, msg: '该赛站已完赛，此条比赛记录已作废' }
    } else {
      // 顺序闸门：仅当前待赛站可结算；running 记录正常必然命中，越站脏数据在此被拦截
      const cur = nextCircuit()
      if (!cur || cur.id !== row.circuit_id) {
        result = { ok: false, status: 409, msg: '前置赛站尚未完赛，该比赛暂不能结算' }
      } else {
        const { rank, pts, money, wear, repGain } = rec.result
        // 磨损归属以开赛快照为唯一依据（与 reverseSettledRace 对称）：
        //  - 租约仍 active：磨损记入租约（归还时按 wear_total 计费）并计一场次，自有艇不磨损；
        //  - 租约已 returned：归还时磨损已钱货两讫，本场不再重复计费，更不得回扣封存的自有艇；
        //  - 无租约：自有艇出赛，正常磨损。
        const rt = raceRental(rec)
        if (rt && rt.status === 'active') {
          run('UPDATE rentals SET parts_dur=MAX(10,parts_dur-?), wear_total=wear_total+?, races_used=races_used+1 WHERE id=?',
            wear, wear, rt.id)
        } else if (!rt) {
          const a = airship()
          const newPd = Math.max(10, a.parts_dur - wear)
          run('UPDATE airships SET parts_dur=?, hp=? WHERE id=?', newPd, Math.max(20, a.hp - wear), a.id)
        }
        if (rec.factors.pilot) {
          run('UPDATE pilots SET exp=exp+?, mood=MIN(100,MAX(0,mood-?)) WHERE id=?',
            rank <= 4 ? 3 : 1, rank > 8 ? 6 : 2, rec.factors.pilot.id)
        }
        run('UPDATE team SET money=money+?, rep=rep+?, season_pts=season_pts+? WHERE id=1', money, repGain, pts)
        const ranksDone = all('SELECT rank FROM circuits WHERE finished=1')
        const best = Math.min(rank, ...ranksDone.map(r => r.rank))
        run('UPDATE team SET season_pos=? WHERE id=1', Math.max(1, best))
        run('UPDATE circuits SET finished=1, rank=? WHERE id=?', rank, row.circuit_id)
        const note = rec.factors.weather === '晴' ? `晴空万里，${rec.circuit.name}` : `${rec.factors.weather}天，${rec.circuit.name}`
        run('INSERT INTO race_log (circuit_id, race_id, season, rank, pts, money, note, ts) VALUES (?,?,?,?,?,?,?,?)',
          row.circuit_id, row.id, rec.season, rank, pts, money, note, now())
        run("UPDATE races SET status='settled', settled=1, rank=?, pts=?, money=?, wear=?, rep_gain=?, settled_at=? WHERE id=?",
          rank, pts, money, wear, repGain, now(), row.id)
        reconcileSponsors() // 同一事务内对账赞助商
        result = { ok: true, already: false, race: parseRace(getRaceRow(id)) }
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return result
}
// 赞助商对账：以当前赛季积分为唯一事实来源，earned 与是否达标保持一致
function reconcileSponsors() {
  const pts = Number(teamCore().season_pts) || 0
  all('SELECT * FROM sponsors').forEach(s => {
    if (!s.reward) return
    const reached = pts >= (Number(s.target) || 0)
    const earned = !!s.earned
    if (reached && !earned) {
      run('UPDATE team SET money=money+?, rep=rep+? WHERE id=1', s.reward, s.rep)
      run('UPDATE sponsors SET earned=1, affinity=affinity+10 WHERE id=?', s.id)
    } else if (!reached && earned) {
      run('UPDATE team SET money=money-?, rep=rep-? WHERE id=1', s.reward, s.rep)
      run('UPDATE sponsors SET earned=0, affinity=affinity-10 WHERE id=?', s.id)
    }
  })
}

// 历史数据兼容（迁移补偿）：修复「跳站参赛」产生的脏数据——首个未完成赛站之后的
// 完赛记录一律视为越站。在同一事务内：
//   1) 按各场记录的发奖口径，回滚积分/奖金/声望/部件磨损（parts_dur、hp）/机师经验与心情；
//      租约艇比赛按开赛快照归属回滚：在履租约回滚磨损/场次（不动钱），已归还租约重算磨损费
//      并补退押金差额（与 settleRace / 归还结算共用同一磨损归属边界）；
//   2) 删除对应 race_log 流水（含无记录关联的老版残留流水）；
//   3) 将这些赛站的 races 记录一律置为 void（作废，不再出现在历史战绩、不能续看或再结算）；
//   4) 重置赛站，再统一重算赞助商对账与赛季名次。
// 所有资金改动（奖金冲回、押金补退、赞助对账）在同一事务边界一次完成；函数天然幂等：
// 已作废的记录与已删流水在重启时不会被再次统计，已回写的租约退款也不会二次补退。
function reconcileLegacySkips() {
  const cs = orderedCircuits()
  const firstOpen = cs.findIndex(c => !c.finished)
  if (firstOpen === -1) return
  const skipped = cs.slice(firstOpen + 1).filter(c => c.finished)
  if (!skipped.length) return

  db.exec('BEGIN')
  try {
    let ptsBack = 0, moneyBack = 0, repBack = 0, refundBack = 0, racesVoided = 0
    skipped.forEach(c => {
      // 已被 races 记录认领的流水 id：其数额随记录回滚，兜底循环里不得再统计，避免双重回滚
      const claimedLogIds = new Set()
      // 该越站赛站的全部比赛记录：已结算的按记录反向回滚；running 仅作废（从未发奖）
      all('SELECT * FROM races WHERE circuit_id=? ORDER BY id ASC', c.id).forEach(rw => {
        if (rw.settled || rw.status === 'settled') {
          const g = reverseSettledRace(rw, c)
          ptsBack += g.pts; moneyBack += g.money; repBack += g.repGain
          refundBack += g.refundAdd   // 已归还租约需补退的磨损费（回写租约行，由这里统一给钱）
          if (rw.id) all('SELECT id FROM race_log WHERE race_id=?', rw.id).forEach(l => claimedLogIds.add(l.id))
        }
        run("UPDATE races SET status='void', settled=0, voided_at=? WHERE id=?", now(), rw.id)
        racesVoided += 1
      })
      // 兜底：早期版本可能留下无 races 关联（或关联未结算记录）的流水，按其自身数额补偿，
      // 声望缺失时按名次/难度重算；已被上面的比赛记录认领的流水一律跳过，确保每条只回滚一次
      all('SELECT * FROM race_log WHERE circuit_id=?', c.id).forEach(l => {
        if (claimedLogIds.has(l.id)) { run('DELETE FROM race_log WHERE id=?', l.id); return }
        ptsBack += l.pts || 0
        moneyBack += l.money || 0
        repBack += Math.max(1, 5 - (l.rank || c.rank || 6) + c.diff)
        run('DELETE FROM race_log WHERE id=?', l.id)
      })
      console.log(`[SKY] 历史修复：赛站《${c.name}》在前置赛站未完成时已完赛（名次 ${c.rank}），回滚战绩、奖励、磨损与人员经验`)
      run('UPDATE circuits SET finished=0, rank=NULL WHERE id=?', c.id)
    })
    // 奖金/声望冲回，押金磨损费补退（refundBack）——全部资金改动在同一边界一次完成
    const netMoney = moneyBack - refundBack
    if (ptsBack || netMoney || repBack) {
      run('UPDATE team SET season_pts=MAX(0,season_pts-?), money=money-?, rep=MAX(0,rep-?) WHERE id=1',
        ptsBack, netMoney, repBack)
    }

    reconcileSponsors()
    const ranks = orderedCircuits().filter(x => x.finished && x.rank).map(x => x.rank)
    run('UPDATE team SET season_pos=? WHERE id=1', ranks.length ? Math.max(1, Math.min(...ranks)) : 1)
    db.exec('COMMIT')
    console.log(`[SKY] 历史修复完成：作废 ${racesVoided} 条越站比赛记录（${skipped.length} 个赛站），` +
      `积分 -${ptsBack}，奖金 -${moneyBack}，声望 -${repBack}` +
      (refundBack ? `，补退已归还租约磨损费 +${refundBack}` : '') +
      '，部件磨损与人员经验已按记录冲回')
  } catch (e) {
    db.exec('ROLLBACK')
    console.error('[SKY] 历史修复失败，已回滚本次迁移补偿', e)
    throw e
  }
}
seed()
reconcileLegacySkips()

/* ---------- 共享响应 ---------- */
const payload = () => {
  const t = teamCore()
  const st = fleetStats()
  const upgrades = all('SELECT * FROM upgrades')
  const pilots = all('SELECT * FROM pilots')
  const mechanics = all('SELECT * FROM mechanics')
  const circuits = orderedCircuits()
  const sponsors = all('SELECT * FROM sponsors')
  const log = all('SELECT * FROM race_log ORDER BY id DESC')
  const done = circuits.filter(c => c.finished).length
  // 中断续看：当前未结算的比赛（每场仅一场 running）；history 供历史回放
  const activeRow = get("SELECT * FROM races WHERE status='running' ORDER BY id DESC LIMIT 1")
  const raceRows = all("SELECT * FROM races WHERE status='settled' ORDER BY id DESC")
  return {
    team: t, airship: st, upgrades, pilots, mechanics, circuits, sponsors, log,
    shop: SHOP_ITEMS,
    // 租赁：当前生效租约（null=自有艇出赛）、艇型目录与最近归还记录
    rental: activeRental(),
    rentalShop: RENTAL_SHIPS,
    rentalHistory: all("SELECT * FROM rentals WHERE status='returned' ORDER BY id DESC LIMIT 5"),
    activeRace: parseRace(activeRow),
    races: raceRows.map(parseRace),
    seasonDone: done, seasonTotal: circuits.length
  }
}

app.get('/api/state', (_, res) => res.json(payload()))
app.get('/api/overview', (_, res) => res.json(payload()))

// 商品目录（服务端配置，供前端渲染商店）：价格/属性均不在客户端可写
app.get('/api/shop', (_, res) => res.json({ ok: true, items: SHOP_ITEMS }))

// 购买改装件：客户端只能提交商品 id；名称、槽位、加成项、加成数值与价格全部以服务端
// SHOP_ITEMS 配置为准，请求体里任何 price/bonus/stat/slot/name 都不会被采信。
app.post('/api/shop', (req, res) => {
  const rawId = req.body?.id
  // 必须是 JSON 数值（拒绝字符串/布尔等可被 Number() 隐式转换的类型），且为正整数
  if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId <= 0) {
    return res.status(400).json({ ok: false, msg: '商品编号无效' })
  }
  const item = SHOP_MAP.get(rawId)
  if (!item) return res.status(400).json({ ok: false, msg: '该商品不存在' })

  // 扣款与入库放在同一事务（BEGIN IMMEDIATE 立即取写锁）：余额检查与扣款原子完成，
  // 并发请求不会在「检查通过→实际扣款」之间把资金扣成负数
  let result
  db.exec('BEGIN IMMEDIATE')
  try {
    const t = teamCore()
    if (t.money < item.price) {
      result = { status: 400, body: { ok: false, msg: '资金不足', price: item.price } }
    } else {
      run('UPDATE team SET money=money-? WHERE id=1', item.price)
      const r = run('INSERT INTO upgrades (name,slot,stat,bonus,price,level) VALUES (?,?,?,?,?,1)',
        item.name, item.slot, item.stat, item.bonus, item.price)
      result = { status: 200, body: { ok: true, msg: `已购入「${item.name}」`, id: Number(r.lastInsertRowid), price: item.price } }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    console.error('[SKY] 购买失败', e)
    result = { status: 500, body: { ok: false, msg: '购买失败，请重试' } }
  }
  return res.status(result.status).json(result.body)
})
// 装备/卸下
app.post('/api/equip/:id', (req, res) => {
  const up = get('SELECT * FROM upgrades WHERE id=?', Number(req.params.id))
  // 同槽位卸下其他
  all('SELECT id FROM upgrades WHERE slot=? AND equipped=1 AND id!=?', up.slot, up.id).forEach(u => run('UPDATE upgrades SET equipped=0 WHERE id=?', u.id))
  run('UPDATE upgrades SET equipped=1 WHERE id=?', up.id)
  res.json({ ok: true })
})
app.post('/api/unequip/:id', (req, res) => {
  run('UPDATE upgrades SET equipped=0 WHERE id=?', Number(req.params.id))
  res.json({ ok: true })
})

// 人员
app.post('/api/hire_pilot', (req, res) => {
  const t = teamCore(); const cost = 1500
  if (t.money < cost) return res.json({ ok: false, msg: '资金不足' })
  const names = ['鹰眼·鸦', '风歌·岚', '铁羽·矶', '晨星·曦']
  const n = names[Math.floor(Math.random() * names.length)]
  run('UPDATE team SET money=money-? WHERE id=1', cost)
  run('INSERT INTO pilots (name,skill,courage,wage,mood) VALUES (?,?,?,?,?)', n, 45 + Math.floor(Math.random() * 20), 48 + Math.floor(Math.random() * 18), 60, 72)
  res.json({ ok: true, msg: `已招募 ${n}` })
})
app.post('/api/hire_mech', (req, res) => {
  const t = teamCore(); const cost = 1000
  if (t.money < cost) return res.json({ ok: false, msg: '资金不足' })
  const n = '工匠·' + ['铁锤', '螺丝', '风箱', '砧台'][Math.floor(Math.random() * 4)]
  run('UPDATE team SET money=money-? WHERE id=1', cost)
  run('INSERT INTO mechanics (name,skill,wage,mood) VALUES (?,?,?,?)', n, 40 + Math.floor(Math.random() * 20), 40, 74)
  res.json({ ok: true, msg: `已招募 ${n}` })
})
app.post('/api/train', (req, res) => {
  const t = teamCore(); const cost = 800
  if (t.money < cost) return res.json({ ok: false, msg: '资金不足' })
  run('UPDATE team SET money=money-? WHERE id=1', cost)
  run('UPDATE pilots SET skill=skill+2, mood=mood+2 WHERE id=?', Number(req.body.id) || all('SELECT id FROM pilots LIMIT 1')[0].id)
  res.json({ ok: true, msg: '完成特训，技巧+2' })
})

// 维护
app.post('/api/maintain', (req, res) => {
  // 租约期间租赁艇由出租方整备（磨损在归还时计费），自有艇封存，均不可自行维护
  if (activeRental()) return res.json({ ok: false, msg: '租约期间飞艇由出租方整备，归还租艇后方可维护自有艇' })
  const t = teamCore(); const a = airship()
  const cost = Math.round((100 - a.parts_dur) * 25)
  if (cost < 200 || t.money < 200) return res.status(200).json({ ok: false, cost, msg: cost < 200 ? '部件状态良好，无需维护' : '资金不足' })
  run('UPDATE team SET money=money-? WHERE id=1', cost)
  run('UPDATE airships SET parts_dur=100, hp=100 WHERE id=?', a.id)
  res.json({ ok: true, cost })
})

/* ---------- 飞艇租赁：签约（扣押金+租金）/ 归还（按磨损结算退款，幂等） ---------- */

// 租赁目录与当前租约（目录为服务端配置，客户端不可改写）
app.get('/api/rentals', (_, res) => res.json({
  ok: true,
  items: RENTAL_SHIPS,
  active: activeRental(),
  history: all("SELECT * FROM rentals WHERE status='returned' ORDER BY id DESC LIMIT 5")
}))

// 签约租艇：客户端只提交艇型 id；押金、租金、性能与场次以服务端目录核定。
// 同一事务（BEGIN IMMEDIATE）内完成「无在履租约 → 资金校验 → 扣款 → 建约」，
// 并发/重复点击不会重复扣款或叠加多份租约。
app.post('/api/rentals/rent', (req, res) => {
  const rawId = req.body?.id
  if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId <= 0) {
    return res.status(400).json({ ok: false, msg: '艇型编号无效' })
  }
  const cfg = RENTAL_MAP.get(rawId)
  if (!cfg) return res.status(400).json({ ok: false, msg: '该艇型不存在' })

  let result
  db.exec('BEGIN IMMEDIATE')
  try {
    const cur = activeRental()
    if (cur) {
      result = { status: 409, body: { ok: false, msg: `已有进行中的租约《${cur.name}》，归还后方可再租` } }
    } else if (get("SELECT id FROM races WHERE status='running' LIMIT 1")) {
      // 比赛进行中签约会中途切换出赛艇，破坏比赛记录的唯一事实来源，一律拒绝
      result = { status: 409, body: { ok: false, msg: '比赛进行中，完赛结算后方可签约租艇' } }
    } else {
      const t = teamCore()
      const cost = cfg.deposit + cfg.rent
      if (t.money < cost) {
        result = { status: 400, body: { ok: false, msg: '资金不足，无法支付押金与租金', cost } }
      } else {
        run('UPDATE team SET money=money-? WHERE id=1', cost)
        const r = run(`INSERT INTO rentals (ship_id,name,speed,turn,acc,dur,deposit,rent_fee,wear_rate,max_races,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          cfg.id, cfg.name, cfg.speed, cfg.turn, cfg.acc, cfg.dur, cfg.deposit, cfg.rent, cfg.wearRate, cfg.maxRaces, now())
        result = { status: 200, body: { ok: true, msg: `已签约租用「${cfg.name}」（押金 ¥${cfg.deposit} + 租金 ¥${cfg.rent}）`, id: Number(r.lastInsertRowid) } }
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    console.error('[SKY] 租艇签约失败', e)
    result = { status: 500, body: { ok: false, msg: '签约失败，请重试' } }
  }
  return res.status(result.status).json(result.body)
})

// 归还租艇：按租约结算——磨损费 = 累计磨损 × 费率，退款 = 押金 − 磨损费（下限 0）。
// 以 status='active' 为唯一闸门（事务内判定并置 returned），重复请求/断线重放只结算一次；
// 已归还时返回同一份结算结果（幂等），绝不二次退款。
app.post('/api/rentals/return', (req, res) => {
  let result
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = activeRental()
    if (!r) {
      const last = get("SELECT * FROM rentals WHERE status='returned' ORDER BY id DESC LIMIT 1")
      if (last) {
        result = { status: 200, body: { ok: true, already: true, msg: `租约《${last.name}》已结算归还，不会重复退款`, refund: last.refund, wearFee: last.wear_fee, name: last.name } }
      } else {
        result = { status: 400, body: { ok: false, msg: '当前没有进行中的租约' } }
      }
    } else if (get("SELECT id FROM races WHERE status='running' LIMIT 1")) {
      result = { status: 409, body: { ok: false, msg: '比赛进行中，完赛结算后方可归还租艇' } }
    } else {
      const wearFee = r.wear_total * r.wear_rate
      const refund = Math.max(0, r.deposit - wearFee)
      run('UPDATE team SET money=money+? WHERE id=1', refund)
      run("UPDATE rentals SET status='returned', wear_fee=?, refund=?, returned_at=? WHERE id=?", wearFee, refund, now(), r.id)
      result = { status: 200, body: { ok: true, already: false, msg: `已归还「${r.name}」：磨损费 ¥${wearFee}，退还押金 ¥${refund}`, refund, wearFee, name: r.name } }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    console.error('[SKY] 归还结算失败', e)
    result = { status: 500, body: { ok: false, msg: '归还结算失败，请重试' } }
  }
  return res.status(result.status).json(result.body)
})

/* ---------- 分段比赛：开赛（生成记录）/ 续看 / 进度 / 结算（幂等） ---------- */

// 开赛：仅允许按航线顺序挑战当前未完成的第一站；比赛记录在这一刻完整生成并落库
app.post('/api/races/start/:cid', (req, res) => {
  const cid = Number(req.params.cid)
  // 已有进行中的比赛 → 直接返回原记录用于「中断续看」，绝不重开、不重复结算
  const active = get("SELECT * FROM races WHERE status='running' ORDER BY id DESC LIMIT 1")
  if (active) return res.json({ ok: true, resumed: true, race: parseRace(active) })

  const c = get('SELECT * FROM circuits WHERE id=?', cid)
  if (!c) return res.json({ ok: false, msg: '该赛站不存在' })
  if (c.finished) return res.json({ ok: false, msg: '该站已完赛' })
  // 租约联动：场次用尽的租约须先在机库归还结算，才能继续参赛（自有艇或再租）
  const rt = activeRental()
  if (rt && rt.races_used >= rt.max_races) {
    return res.json({ ok: false, msg: `租约《${rt.name}》场次已用完（${rt.races_used}/${rt.max_races}），请先在机库归还租艇` })
  }
  const cur = nextCircuit()
  if (!cur) return res.json({ ok: false, msg: '本赛季已全部完赛' })
  if (cur.id !== cid) {
    const idx = orderedCircuits().findIndex(x => x.id === cid) + 1
    return res.json({ ok: false, msg: `请先完成第 ${orderedCircuits().findIndex(x => x.id === cur.id) + 1} 站《${cur.name}》，第 ${idx} 站尚未解锁` })
  }

  const record = buildRace(c)
  const r = run('INSERT INTO races (circuit_id, season, status, settled, record, watch_el, created_at) VALUES (?,?,?,?,?,?,?)',
    c.id, record.season, 'running', 0, JSON.stringify(record), 0, now())
  res.json({ ok: true, resumed: false, race: parseRace(getRaceRow(Number(r.lastInsertRowid))) })
})

// 单场比赛记录（历史回放 / 刷新续看进度）
app.get('/api/races/:id', (req, res) => {
  const row = getRaceRow(req.params.id)
  if (!row) return res.status(404).json({ ok: false, msg: '比赛记录不存在' })
  res.json({ ok: true, race: parseRace(row) })
})

// 上报观赛进度（中断续看锚点），只影响播放位置，与结算无关
app.post('/api/races/:id/progress', (req, res) => {
  const row = getRaceRow(req.params.id)
  if (!row) return res.status(404).json({ ok: false, msg: '比赛记录不存在' })
  if (row.settled) return res.json({ ok: true }) // 已结算无需再记进度
  const el = clamp(Number(req.body?.el) || 0, 0, JSON.parse(row.record).duration)
  run('UPDATE races SET watch_el=? WHERE id=?', el, row.id)
  res.json({ ok: true, watch_el: el })
})

// 结算：以比赛记录为唯一依据；幂等，重复/断线重放都只发一次奖；已作废记录返回 409
app.post('/api/races/:id/settle', (req, res) => {
  try {
    const r = settleRace(Number(req.params.id))
    if (r.status === 404) return res.status(404).json(r)
    if (r.status === 409) return res.status(409).json(r)
    res.json(r)
  } catch (e) {
    console.error('[SKY] 结算失败', e)
    res.status(500).json({ ok: false, msg: '结算失败，请重试' })
  }
})

// 重置（重置数据到初始种子）
app.post('/api/reset', (_, res) => {
  ['race_log', 'races', 'rentals', 'sponsors', 'circuits', 'upgrades', 'mechanics', 'pilots', 'airships', 'team'].forEach(t => { try { run(`DELETE FROM ${t}`) } catch (e) {} })
  try { run('DELETE FROM sqlite_sequence') } catch (e) {}
  seed()
  res.json({ ok: true })
})

app.listen(PORT, () => console.log(`[SKY] API running at http://localhost:${PORT}`))
