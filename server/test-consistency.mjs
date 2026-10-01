/**
 * 结算 / 租约归还 / 越站历史修复 一致性验证（幂等 + 赛季数据一致）
 *
 * 用法：node server/test-consistency.mjs
 * 在临时目录里起一份独立 DB 与独立端口的真实服务，跑完即销毁，不污染开发库。
 */
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { mkdtempSync, cpSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log(`  ✅ ${name}`) }
const eq = (name, a, b) => { assert.equal(a, b, `${name}（期望 ${b}，实际 ${a}）`); pass++; console.log(`  ✅ ${name}`) }

function api(port, p, opts) { return fetch(`http://127.0.0.1:${port}${p}`, opts).then(r => r.json()) }
const post = (port, p, b) => api(port, p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })

function makeSandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sky-test-'))
  cpSync(path.join(__dirname, 'db.js'), path.join(dir, 'db.js'))
  cpSync(path.join(__dirname, 'index.js'), path.join(dir, 'index.js'))
  symlinkSync(path.join(__dirname, '..', 'node_modules'), path.join(dir, 'node_modules'), 'dir')
  return dir
}
// 起一份全新服务：完成首次建表 + seed（不做脏修复），随即停服，返回直连 DB 供注入脏数据
async function bootSeeded(dir, port) {
  const proc = spawn('node', ['index.js'], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' })
  let state = null
  for (let i = 0; i < 100; i++) {
    try { state = await api(port, '/api/state'); if (state && state.team && state.circuits.length) break }
    catch { /* 还没起：表可能尚未建完 */ }
    await sleep(80)
  }
  if (!state || !state.team) { proc.kill('SIGKILL'); throw new Error('seed server 未就绪') }
  proc.kill('SIGKILL'); await sleep(150)
  return new DatabaseSync(path.join(dir, 'sky.db'))
}
function startServer(dir, port) {
  return spawn('node', ['index.js'], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' })
}
async function waitReady(port) {
  for (let i = 0; i < 100; i++) {
    try { const s = await api(port, '/api/state'); if (s?.team) return s } catch { /* wait */ }
    await sleep(80)
  }
  throw new Error('server not ready')
}

// 造一条指定赛站、指定结果/租约快照的「已结算」越站记录及配套流水、赛站完赛标记
function injectSettledRace(dbh, { circuitId, rank, money, wear, repGain, pts, rentalId, rentalName }) {
  const pilot = dbh.prepare('SELECT * FROM pilots ORDER BY (skill+courage) DESC LIMIT 1').get()
  const record = {
    v: 1, season: 1,
    circuit: { id: circuitId },
    factors: {
      rental: rentalId ? { id: rentalId, name: rentalName } : null,
      pilot: { id: pilot.id, name: pilot.name, skill: pilot.skill, courage: pilot.courage, exp: pilot.exp, mood: pilot.mood }
    },
    result: { rank, pts, money, wear, repGain }
  }
  const r = dbh.prepare(`INSERT INTO races (circuit_id,season,status,settled,record,watch_el,created_at,settled_at,rank,pts,money,wear,rep_gain)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    circuitId, 1, 'settled', 1, JSON.stringify(record), 99, 't0', 't1', rank, pts, money, wear, repGain)
  dbh.prepare('INSERT INTO race_log (circuit_id,race_id,season,rank,pts,money,note,ts) VALUES (?,?,?,?,?,?,?,?)')
    .run(circuitId, Number(r.lastInsertRowid), 1, rank, pts, money, '越站脏流水', 't1')
  dbh.prepare('UPDATE circuits SET finished=1, rank=? WHERE id=?').run(rank, circuitId)
  return { raceId: Number(r.lastInsertRowid), pilotExpBefore: pilot.exp, pilotMoodBefore: pilot.mood }
}

/* ============ 场景 A：租约艇越站比赛「已结算 + 已归还」→ 重启修复，磨损费必须补退 ============ */
async function scenarioA() {
  console.log('\n[场景 A] 已归还租约的越站记录被作废：奖励冲回 + 磨损费补退')
  const PORT = 4401
  const dir = makeSandbox()
  let proc
  try {
    const dbh = await bootSeeded(dir, PORT)
    const team0 = dbh.prepare('SELECT * FROM team WHERE id=1').get()
    const own0 = dbh.prepare('SELECT * FROM airships LIMIT 1').get()
    const pilot0 = dbh.prepare('SELECT * FROM pilots ORDER BY (skill+courage) DESC LIMIT 1').get()

    // 租约艇型「猎鹰·巡航者」：押金 4500 / 租金 1200 / 费率 50
    const deposit = 4500, rentFee = 1200, rate = 50
    // 两场越站比赛磨损 8、6（归还按累计 14 计费）；名次/奖金/积分各不相同
    const r1 = { circuitId: 4, rank: 2, pts: 18, money: 1400, wear: 8, repGain: 5 }
    const r2 = { circuitId: 5, rank: 4, pts: 12, money: 900, wear: 6, repGain: 3 }
    const insA = dbh.prepare(`INSERT INTO rentals (ship_id,name,speed,turn,acc,dur,deposit,rent_fee,wear_rate,max_races,
      races_used,parts_dur,wear_total,status,wear_fee,refund,created_at,returned_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(2, '猎鹰·巡航者', 76, 72, 74, 80, deposit, rentFee, rate, 3, 2, 100 - 14, 14,
        'returned', 14 * rate, deposit - 14 * rate, 't0', 't1')
    const rid = Number(insA.lastInsertRowid)
    const a = injectSettledRace(dbh, { ...r1, rentalId: rid, rentalName: '猎鹰·巡航者' })
    const b = injectSettledRace(dbh, { ...r2, rentalId: rid, rentalName: '猎鹰·巡航者' })
    // 模拟「已发奖」：积分/奖金/声望已加，押金净额已退（20000-5700+3800=18100）；
    // 两场均为前 4 名，机师经验 +3×2、心情 -2×2（与 settleRace 口径一致）
    dbh.prepare('UPDATE pilots SET exp=exp+?, mood=mood-? WHERE id=?').run(6, 4, pilot0.id)
    dbh.prepare('UPDATE team SET money=?, season_pts=?, rep=? WHERE id=1')
      .run(team0.money - (deposit + rentFee) + (deposit - 14 * rate) + r1.money + r2.money,
        team0.season_pts + r1.pts + r2.pts, team0.rep + r1.repGain + r2.repGain)
    dbh.close()

    proc = startServer(dir, PORT)
    await waitReady(PORT)
    const s = await api(PORT, '/api/state')
    proc.kill('SIGKILL'); await sleep(120)

    const t = s.team
    // 奖励全部冲回，押金按剩余磨损（0）重算 → 全押金 4500；相对已退 3800 补退 700
    eq('奖金冲回后资金回到「扣押金+租金+退全押金」=-租金', t.money, team0.money - rentFee)
    eq('赛季积分回到修复前', t.season_pts, team0.season_pts)
    eq('声望回到修复前', t.rep, team0.rep)
    eq('越站赛站4重置未完成', s.circuits[3].finished, 0)
    eq('越站赛站5重置未完成', s.circuits[4].finished, 0)
    eq('越站记录不出现在历史战绩', s.races.filter(x => x.id === a.raceId || x.id === b.raceId).length, 0)
    eq('越站流水已删除', s.log.filter(l => l.race_id === a.raceId || l.race_id === b.raceId).length, 0)
    // 合约（races 口径）进度只数未作废的已结算比赛：越站记录作废后进度清零、无合约兑现
    eq('越站作废后全部合约进度归零', s.sponsors.reduce((z, x) => z + (x.progress || 0), 0), 0)
    eq('越站作废后无合约处于已兑现', s.sponsors.filter(x => x.earned).length, 0)

    const rt = s.rentalHistory.find(x => x.id === rid)
    ok('归还记录仍在历史（回写而非删除）', !!rt)
    eq('租约累计磨损清零', rt.wear_total, 0)
    eq('租约磨损费重算为 0', rt.wear_fee, 0)
    eq('押金退款重算为全押金', rt.refund, deposit)
    eq('租约已用场次回滚', rt.races_used, 0)

    const dbh2 = new DatabaseSync(path.join(dir, 'sky.db'))
    const ownAfter = dbh2.prepare('SELECT parts_dur,hp FROM airships LIMIT 1').get()
    eq('自有艇 parts_dur 未被误扣/误恢复', ownAfter.parts_dur, own0.parts_dur)
    eq('自有艇 hp 未被误扣/误恢复', ownAfter.hp, own0.hp)
    const pilotAfter = dbh2.prepare('SELECT exp,mood FROM pilots WHERE id=?').get(pilot0.id)
    const expBack = (r1.rank <= 4 ? 3 : 1) + (r2.rank <= 4 ? 3 : 1)
    eq('机师经验回滚', pilotAfter.exp, pilot0.exp)
    eq('机师经验冲回额度=3+3', expBack, 6)
    void pilotAfter // 心情同步恢复（前4名心情 -2/场）
    eq('机师心情回滚到修复前', pilotAfter.mood, pilot0.mood)
    const voids = dbh2.prepare("SELECT COUNT(*) c FROM races WHERE status='void'").get().c
    eq('两场越站记录均置 void', voids, 2)
    dbh2.close()
  } finally { if (proc) proc.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }) }
}

/* ============ 场景 B：租约在履（active）越站已结算 → 修复，磨损/场次回滚到租约、不动钱 ============ */
async function scenarioB() {
  console.log('\n[场景 B] 在履租约的越站记录被作废：磨损回滚租约，押金未结算故不动钱')
  const PORT = 4402
  const dir = makeSandbox()
  let proc
  try {
    const dbh = await bootSeeded(dir, PORT)
    const team0 = dbh.prepare('SELECT * FROM team WHERE id=1').get()
    const r1 = { circuitId: 3, rank: 1, pts: 25, money: 1700, wear: 10, repGain: 6 }
    const insB = dbh.prepare(`INSERT INTO rentals (ship_id,name,speed,turn,acc,dur,deposit,rent_fee,wear_rate,max_races,
      races_used,parts_dur,wear_total,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(1, '雨燕·轻竞技', 66, 62, 72, 64, 2400, 600, 35, 2, 1, 90, 10, 'active', 't0')
    const rid = Number(insB.lastInsertRowid)
    const a = injectSettledRace(dbh, { ...r1, rentalId: rid, rentalName: '雨燕·轻竞技' })
    dbh.prepare('UPDATE pilots SET exp=exp+3, mood=mood-2 WHERE id=?').run(dbh.prepare('SELECT id FROM pilots ORDER BY (skill+courage) DESC LIMIT 1').get().id)
    dbh.prepare('UPDATE team SET money=?, season_pts=?, rep=? WHERE id=1')
      .run(team0.money - 3000 + r1.money, team0.season_pts + r1.pts, team0.rep + r1.repGain)
    dbh.close()

    proc = startServer(dir, PORT)
    await waitReady(PORT)
    const s = await api(PORT, '/api/state')
    proc.kill('SIGKILL'); await sleep(120)

    const t = s.team
    eq('奖金冲回，资金仅保留「扣押金+租金」（押金未退）', t.money, team0.money - 3000)
    eq('积分回到修复前', t.season_pts, team0.season_pts)
    eq('声望回到修复前', t.rep, team0.rep)
    const rt = s.rental
    ok('租约仍为 active（未被修复误置 returned）', !!rt && rt.id === rid)
    eq('租约累计磨损回滚为 0', rt.wear_total, 0)
    eq('租约部件健康恢复 100', rt.parts_dur, 100)
    eq('租约已用场次回滚为 0', rt.races_used, 0)
    eq('refund 仍为空（押金未结算）', rt.refund, null)
    eq('越站记录不进历史', s.races.filter(x => x.id === a.raceId).length, 0)
  } finally { if (proc) proc.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }) }
}

/* ============ 场景 C：正向链路 结算→归还，磨损归租约、自有艇封存，接口幂等 ============ */
async function scenarioC() {
  console.log('\n[场景 C] 正常结算→归还：磨损只记租约，退款幂等不重复')
  const PORT = 4403
  const dir = makeSandbox()
  let proc
  try {
    proc = startServer(dir, PORT)
    await waitReady(PORT)
    const s0 = await api(PORT, '/api/state')
    const ownPdBefore = s0.airship.parts_dur
    const moneyBefore = s0.team.money

    const rent = await post(PORT, '/api/rentals/rent', { id: 1 }) // 雨燕：押金2400 租金600 费率35
    ok('签约成功', rent.ok)
    const s1 = await api(PORT, '/api/state')
    eq('签约即扣 押金+租金=3000', s1.team.money, moneyBefore - 3000)

    const started = await post(PORT, '/api/races/start/1', {})
    ok('开赛成功', started.ok && started.race.id)
    const raceId = started.race.id
    const wear = started.race.record.result.wear
    const settled1 = await post(PORT, `/api/races/${raceId}/settle`, {})
    ok('首次结算成功', settled1.ok && !settled1.already)
    await api(PORT, '/api/state')
    // 重复结算：幂等，不再发奖/不再计磨损
    const settled2 = await post(PORT, `/api/races/${raceId}/settle`, {})
    ok('重复结算返回幂等结果', settled2.ok && settled2.already)

    const s3 = await api(PORT, '/api/state')
    eq('租约累计磨损只记一次', s3.rental.wear_total, wear)
    eq('租约已用场次只记一次', s3.rental.races_used, 1)
    // payload 的 airship 在租约期间镜像租约艇（fleetStats 以租约为准）
    eq('出赛艇（租约）部件健康=100−磨损', s3.rental.parts_dur, 100 - wear)
    eq('出赛艇（租约）部件健康=100−磨损', s3.airship.parts_dur, 100 - wear)
    const expectMoney = moneyBefore - 3000 + started.race.record.result.money +
      s3.sponsors.filter(x => x.earned).reduce((a, x) => a + x.reward, 0) // 结算事务内达标赞助奖励
    eq('奖金（含同事务达标赞助奖励）只发一次', s3.team.money, expectMoney)

    // 重复归还：仅一次退款
    const ret1 = await post(PORT, '/api/rentals/return', {})
    const expectedFee = wear * 35
    const expectedRefund = Math.max(0, 2400 - expectedFee)
    ok('首次归还成功', ret1.ok && !ret1.already)
    eq('磨损费=累计磨损×费率', ret1.wearFee, expectedFee)
    eq('退款=押金−磨损费', ret1.refund, expectedRefund)
    const ret2 = await post(PORT, '/api/rentals/return', {})
    ok('重复归还返回幂等结果、不二次退款', ret2.ok && ret2.already && ret2.refund === expectedRefund)
    const s4 = await api(PORT, '/api/state')
    eq('归还后资金只加一次退款', s4.team.money, expectMoney + expectedRefund)
    eq('归还后无在履租约', s4.rental, null)
    eq('自有艇仍未磨损', s4.airship.parts_dur, ownPdBefore)

    // 再开新赛站：租约场次用尽分支之外的正常路径（归还后可用自有艇）
    const started2 = await post(PORT, '/api/races/start/2', {})
    ok('归还后可继续用自有艇参赛', started2.ok)
    proc.kill('SIGKILL'); await sleep(120)
    // 直连 DB 确认：整个租约周期里自有艇始终封存（parts_dur/hp 从未被结算/归还触碰）
    const dbh = new DatabaseSync(path.join(dir, 'sky.db'))
    const own = dbh.prepare('SELECT parts_dur,hp FROM airships LIMIT 1').get()
    eq('DB 内自有艇 parts_dur 全程封存未磨损', own.parts_dur, ownPdBefore)
    eq('DB 内自有艇 hp 全程封存未磨损', own.hp, ownPdBefore)
    dbh.close()
  } finally { if (proc) proc.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }) }
}

/* ============ 场景 D：修复幂等——连续重启两次，第二次不产生任何二次回滚/退款 ============ */
async function scenarioD() {
  console.log('\n[场景 D] 历史修复幂等：二次重启资金/磨损不再变化')
  const PORT = 4404
  const dir = makeSandbox()
  let proc
  try {
    const dbh = await bootSeeded(dir, PORT)
    const team0 = dbh.prepare('SELECT * FROM team WHERE id=1').get()
    const r1 = { circuitId: 6, rank: 3, pts: 15, money: 1200, wear: 12, repGain: 4 }
    const insD = dbh.prepare(`INSERT INTO rentals (ship_id,name,speed,turn,acc,dur,deposit,rent_fee,wear_rate,max_races,
      races_used,parts_dur,wear_total,status,wear_fee,refund,created_at,returned_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(4, '星凰·旗舰', 97, 91, 93, 90, 11000, 3200, 85, 4, 1, 88, 12,
        'returned', 12 * 85, 11000 - 12 * 85, 't0', 't1')
    const rid = Number(insD.lastInsertRowid)
    injectSettledRace(dbh, { ...r1, rentalId: rid, rentalName: '星凰·旗舰' })
    dbh.prepare('UPDATE team SET money=?, season_pts=?, rep=? WHERE id=1')
      .run(team0.money - 14200 + (11000 - 1020) + r1.money, team0.season_pts + r1.pts, team0.rep + r1.repGain)
    dbh.close()

    proc = startServer(dir, PORT); await waitReady(PORT)
    const sFirst = await api(PORT, '/api/state'); proc.kill('SIGKILL'); proc = null; await sleep(180)
    proc = startServer(dir, PORT); await waitReady(PORT)
    const sSecond = await api(PORT, '/api/state'); proc.kill('SIGKILL'); proc = null; await sleep(180)
    eq('二次重启资金不变（幂等）', sSecond.team.money, sFirst.team.money)
    eq('二次重启积分不变', sSecond.team.season_pts, sFirst.team.season_pts)
    eq('二次重启声望不变', sSecond.team.rep, sFirst.team.rep)
    const rt1 = sFirst.rentalHistory.find(x => x.id === rid)
    const rt2 = sSecond.rentalHistory.find(x => x.id === rid)
    eq('二次重启租约退款不再变化', rt2.refund, rt1.refund)
    eq('重算退款=全押金（磨损费清零）', rt2.refund, 11000)
  } finally { if (proc) proc.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }) }
}

/* ============ 场景 E：赛季合约正向链路——按天气/名次/租赁艇累计，达标一次性兑现，幂等 ============ */
// 把一条 running 比赛记录的玩家名次改成第 1 名（同步改 pts/money 与 racer 排序无关键引用）
function forcePlayerFirst(dbh, raceId) {
  const row = dbh.prepare('SELECT record FROM races WHERE id=?').get(raceId)
  const rec = JSON.parse(row.record)
  rec.racers.forEach(r => { r.isPlayer = false })
  const fastest = rec.racers.reduce((a, b) => (a.total <= b.total ? a : b))
  fastest.isPlayer = true
  fastest.name = '苍穹疾风战队'
  Object.assign(rec.result, { rank: 1, pts: 25 })
  dbh.prepare('UPDATE races SET record=? WHERE id=?').run(JSON.stringify(rec), raceId)
  return rec
}
async function scenarioE() {
  console.log('\n[场景 E] 可配置赛季合约：条件累计 + 达标一次性兑现 + 结算幂等 + 归还后不丢进度')
  const PORT = 4405
  const dir = makeSandbox()
  let proc
  try {
    proc = startServer(dir, PORT)
    let s = await waitReady(PORT)
    const money0 = s.team.money
    const byName = Object.fromEntries(s.sponsors.map(x => [x.name, x]))
    eq('云帆合约目标=2 场（雾天完赛）', byName['云帆工坊'].spec.goal, 2)
    eq('星罗合约目标=2 场（恶劣天气前3）', byName['星罗航空'].spec.goal, 2)
    eq('流风合约目标=2 场（租赁艇登台）', byName['流风动力'].spec.goal, 2)
    eq('苍穹合约目标=4 场（前3名）', byName['苍穹商会'].spec.goal, 4)
    eq('全新库合约初始进度=0', s.sponsors.reduce((a, x) => a + x.progress, 0), 0)
    eq('全新库初始均未兑现', s.sponsors.filter(x => x.earned).length, 0)

    // 第 1 站「晨雾浮岛」雾：云帆 +1、星罗 +1（前3）、苍穹 +1
    let st = await post(PORT, '/api/races/start/1', {})
    s = await waitReady(PORT)
    {
      const dbh = new DatabaseSync(path.join(dir, 'sky.db'))
      forcePlayerFirst(dbh, st.race.id); dbh.close()
    }
    let r = await post(PORT, `/api/races/${st.race.id}/settle`, {})
    ok('第1站结算成功', r.ok && !r.already)
    ok('第1站无当场兑现合约', r.contracts.justClaimed.length === 0)
    eq('第1站有 3 条合约累计到进度', r.contracts.gain.length, 3)
    s = await api(PORT, '/api/state')
    let sp = Object.fromEntries(s.sponsors.map(x => [x.name, x]))
    eq('云帆进度 1/2', sp['云帆工坊'].progress, 1)
    eq('星罗进度 1/2', sp['星罗航空'].progress, 1)
    eq('苍穹进度 1/4', sp['苍穹商会'].progress, 1)
    eq('流风进度 0（自有艇）', sp['流风动力'].progress, 0)
    eq('第1站未发任何合约奖励', s.team.money, money0 + st.race.record.result.money)

    // 第 2 站「雷鸣云谷」雷暴：星罗 +1（达标兑现 8000/15）、苍穹 +1；云帆不计（非雾）
    st = await post(PORT, '/api/races/start/2', {})
    {
      const dbh = new DatabaseSync(path.join(dir, 'sky.db'))
      forcePlayerFirst(dbh, st.race.id); dbh.close()
    }
    r = await post(PORT, `/api/races/${st.race.id}/settle`, {})
    eq('第2站当场兑现 1 条（星罗）', r.contracts.justClaimed.map(x => x.name).join(','), '星罗航空')
    eq('当场兑现金额=8000', r.contracts.justClaimed[0].reward, 8000)
    eq('第2站推进但未兑现=苍穹 1 条', r.contracts.gain.map(x => x.name).join(','), '苍穹商会')
    s = await api(PORT, '/api/state')
    sp = Object.fromEntries(s.sponsors.map(x => [x.name, x]))
    eq('星罗已兑现', sp['星罗航空'].earned, 1)
    eq('星罗好感+10', sp['星罗航空'].affinity, 70)
    const moneyAfter2 = s.team.money

    // 重复结算：合约兑现幂等，不二次发奖
    r = await post(PORT, `/api/races/${st.race.id}/settle`, {})
    ok('重复结算返回幂等', r.ok && r.already)
    s = await api(PORT, '/api/state')
    eq('重复结算资金不变（合约不二次兑现）', s.team.money, moneyAfter2)
    eq('星罗仍只兑现一次', s.sponsors.find(x => x.name === '星罗航空').earned, 1)

    // 第 3 站「翡翠群岛」晴：仅苍穹 +1
    st = await post(PORT, '/api/races/start/3', {})
    {
      const dbh = new DatabaseSync(path.join(dir, 'sky.db'))
      forcePlayerFirst(dbh, st.race.id); dbh.close()
    }
    await post(PORT, `/api/races/${st.race.id}/settle`, {})

    // 签约雨燕（押金2400+租金600=3000，2 场）跑第 4 站「风暴裂谷」雨：流风 +1、星罗已兑现不再提示、苍穹 +1
    const rent = await post(PORT, '/api/rentals/rent', { id: 1 })
    ok('租艇签约成功', rent.ok)
    st = await post(PORT, '/api/races/start/4', {})
    eq('第4站为租赁艇出赛（开赛快照）', !!st.race.record.factors.rental, true)
    {
      const dbh = new DatabaseSync(path.join(dir, 'sky.db'))
      forcePlayerFirst(dbh, st.race.id); dbh.close()
    }
    await post(PORT, `/api/races/${st.race.id}/settle`, {})
    s = await api(PORT, '/api/state')
    sp = Object.fromEntries(s.sponsors.map(x => [x.name, x]))
    eq('流风进度 1/2（租赁艇登台）', sp['流风动力'].progress, 1)
    eq('苍穹进度 4/4 已兑现 22000', sp['苍穹商会'].progress, 4)
    eq('苍穹已兑现标记=1', sp['苍穹商会'].earned, 1)
    eq('星罗已 3/2（达标后进度继续累计）', sp['星罗航空'].progress, 3)

    // 第 5 站「极光穹顶」风（租约第 2 场）：流风 +1 达标兑现 14000
    st = await post(PORT, '/api/races/start/5', {})
    {
      const dbh = new DatabaseSync(path.join(dir, 'sky.db'))
      forcePlayerFirst(dbh, st.race.id); dbh.close()
    }
    r = await post(PORT, `/api/races/${st.race.id}/settle`, {})
    eq('第5站当场兑现流风', r.contracts.justClaimed.map(x => x.name).join(','), '流风动力')

    // 归还租艇（磨损小，押金退款）不影响已累计的合约进度
    const ret = await post(PORT, '/api/rentals/return', {})
    ok('归还成功', ret.ok)
    s = await api(PORT, '/api/state')
    sp = Object.fromEntries(s.sponsors.map(x => [x.name, x]))
    eq('归还后流风进度保留 2/2', sp['流风动力'].progress, 2)
    eq('归还后流风仍已兑现', sp['流风动力'].earned, 1)

    // 第 6 站「星界之巅」雾（自有艇）：云帆 +1 达标兑现 4000
    st = await post(PORT, '/api/races/start/6', {})
    {
      const dbh = new DatabaseSync(path.join(dir, 'sky.db'))
      forcePlayerFirst(dbh, st.race.id); dbh.close()
    }
    r = await post(PORT, `/api/races/${st.race.id}/settle`, {})
    eq('第6站当场兑现云帆', r.contracts.justClaimed.map(x => x.name).join(','), '云帆工坊')
    s = await api(PORT, '/api/state')
    eq('全季 6 站完赛', s.seasonDone, 6)
    const claimed = s.sponsors.filter(x => x.earned)
    eq('四条合约全部兑现', claimed.length, 4)
    const contractMoney = claimed.reduce((a, x) => a + x.reward, 0)
    eq('合约兑现总额=4000+8000+14000+22000', contractMoney, 48000)
    // 资金守恒：初始 + 6 场奖金 + 合约奖励 −（押金+租金）+ 归还退款
    const bonuses = s.log.reduce((a, x) => a + x.money, 0)
    const expected = money0 + bonuses + 48000 - 3000 + ret.refund
    eq('资金账目与合约一次性兑现一致', Math.round(s.team.money), Math.round(expected))
    const repGain = claimed.reduce((a, x) => a + x.rep, 0)
    eq('声望含合约兑现加成（+8+15+22+32=77）', repGain, 77)
    proc.kill('SIGKILL'); await sleep(120)
  } finally { if (proc) proc.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }) }
}

/* ============ 场景 F：老固定积分型赞助启动迁移（metric=pts，兑现/回滚口径不变） ============ */
async function scenarioF() {
  console.log('\n[场景 F] 老库固定积分型赞助迁移：spec=pts 积分口径，已兑现状态与奖励保持一致')
  const PORT = 4406
  const dir = makeSandbox()
  let proc
  try {
    const dbh = await bootSeeded(dir, PORT)
    // 抹掉新列并恢复成老 sponsors 结构语义：target/earned/reward/rep
    dbh.prepare('UPDATE sponsors SET spec=NULL, progress=0').run()
    const legacy = [['云帆工坊', 12, 0], ['星罗航空', 22, 0], ['流风动力', 32, 1], ['苍穹商会', 45, 1]]
    legacy.forEach(([n, t, e]) => dbh.prepare('UPDATE sponsors SET target=?, earned=? WHERE name=?').run(t, e, n))
    // 老口径：积分 35 → target=32 已兑现（流风），45 未达标但标记已兑现（苍穹）需冲回
    dbh.prepare('UPDATE team SET season_pts=?, money=money+?, rep=rep+? WHERE id=1').run(35, 14000, 22)
    dbh.close()

    proc = startServer(dir, PORT)
    const s = await waitReady(PORT)
    proc.kill('SIGKILL'); proc = null; await sleep(120)
    const sp = Object.fromEntries(s.sponsors.map(x => [x.name, x]))
    eq('迁移后云帆为 pts 口径', sp['云帆工坊'].spec.metric, 'pts')
    eq('迁移后云帆进度=当前积分 35', sp['云帆工坊'].progress, 35)
    eq('云帆 35>=12 已兑现', sp['云帆工坊'].earned, 1)
    eq('星罗 35>=22 已兑现', sp['星罗航空'].earned, 1)
    eq('流风维持已兑现（迁移前已发奖不重复）', sp['流风动力'].earned, 1)
    eq('苍穹 35<45 未达标 → 冲回为未兑现', sp['苍穹商会'].earned, 0)
    eq('苍穹进度=35/45', sp['苍穹商会'].progress, 35)
    // 冲回苍穹 22000/32，补发云帆 4000/8、星罗 8000/15；流风不动
    const dbh2 = new DatabaseSync(path.join(dir, 'sky.db'))
    const t = dbh2.prepare('SELECT money,rep FROM team WHERE id=1').get()
    eq('资金=35分基线+14000 +4000+8000−22000', t.money, 20000 + 14000 + 4000 + 8000 - 22000)
    eq('声望=50+22 +8+15−32', t.rep, 50 + 22 + 8 + 15 - 32)
    dbh2.close()
  } finally { if (proc) proc.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }) }
}

const run = async () => {
  await scenarioA(); await scenarioB(); await scenarioC(); await scenarioD()
  await scenarioE(); await scenarioF()
  console.log(`\n🎉 全部 ${pass} 项断言通过：结算 / 归还 / 越站回滚边界统一，幂等且赛季数据一致`)
}
run().catch(e => { console.error('\n❌ 验证失败：', e); process.exit(1) })
