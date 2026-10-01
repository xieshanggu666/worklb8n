<script setup>
import { computed } from 'vue'
import { useSkyStore } from '@/store/sky'
const store = useSkyStore()
const emit = defineEmits(['close', 'replay'])
const wIco = { '晴': '🌤️', '风': '🌬️', '雨': '🌧️', '雾': '🌫️', '雷暴': '⛈️' }
// 历史战绩按「赛季 → 航线赛站顺序」排列；已结算的比赛记录自带完整过程，可点击回放
const rows = computed(() => {
  const order = new Map(store.circuits.map((c, i) => [c.id, i]))
  return (store.raceHistory || [])
    .map(r => ({ ...r, seq: order.get(r.record?.circuit?.id) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => (b.record.season - a.record.season) || (a.seq - b.seq) || b.id - a.id)
})
function stationName(seq) { return seq < 0 || seq >= store.circuits.length ? '' : `第 ${seq + 1} 站` }

// 赞助合约统一视图：spec 由服务端配置下发（races 条件累计 / pts 积分累计）
const sponsors = computed(() => (store.state?.sponsors || []).map(s => {
  const spec = s.spec || { metric: 'pts', goal: s.target || 0, cond: {} }
  const goal = spec.goal || s.target || 0
  const progress = Math.min(goal, Number(s.progress) || 0)
  return {
    ...s, spec, goal,
    progress,
    done: !!s.earned,
    unit: spec.metric === 'pts' ? '分' : '场',
    pct: goal ? Math.min(100, progress / goal * 100) : 0,
    chips: contractChips(spec.cond || {})
  }
}))
// 把 AND 条件翻译成标签：天气白名单 / 名次上限 / 租赁艇出赛
function contractChips(cond) {
  const chips = []
  if (Array.isArray(cond.weather) && cond.weather.length) {
    chips.push(cond.weather.map(w => `${wIco[w] || ''}${w}`).join(' / '))
  }
  if (cond.rankMax !== undefined && cond.rankMax !== null) chips.push(`前 ${cond.rankMax} 名`)
  if (cond.rental === true) chips.push('🛟 租赁艇出赛')
  if (cond.rental === false) chips.push('✈️ 自有艇出赛')
  return chips
}
</script>

<template>
  <div class="drawer-mask" @click.self="emit('close')">
    <aside class="drawer">
      <header class="d-h">
        <div><h3>🏆 赛季之巅</h3><div class="d-sub">完成赛季合约条件，结算时一次性兑现赞助</div></div>
        <button class="d-x" @click="emit('close')">✕</button>
      </header>

      <div class="d-body">
        <!-- 赛季积分大数 -->
        <div class="pts-card">
          <div class="pts-num mono">{{ store.team.season_pts }}</div>
          <div class="pts-label">本赛季积分</div>
        </div>

        <!-- 赛季赞助合约：按天气/名次/租赁艇等条件累计进度，达标一次性兑现 -->
        <section>
          <div class="sec-h"><b>🚩 赛季赞助合约 <span class="d-sub">符合条件的完赛自动累计 · 达标结算时兑现</span></b></div>
          <div v-for="s in sponsors" :key="s.id" class="sp-card" :class="{ done: s.done }">
            <div class="sp-top">
              <b>{{ s.name }}</b>
              <span class="tag" :class="s.done ? 'm' : 'o'">
                {{ s.done ? '✔ 已兑现' : `${s.progress} / ${s.goal} ${s.unit}` }}
              </span>
            </div>
            <div class="sp-title">{{ s.spec.title }}</div>
            <div v-if="s.chips.length" class="sp-conds">
              <span v-for="(c, i) in s.chips" :key="i" class="tag b ct-chip">{{ c }}</span>
            </div>
            <div class="hbar sp-bar"><i :style="{ width: s.pct + '%' }"></i></div>
            <div class="sp-reward">
              <span>一次性奖励</span>
              <span class="row gap8"><span class="tag o">¥{{ s.reward }}</span><span class="tag v">声望+{{ s.rep }}</span></span>
            </div>
          </div>
        </section>

        <!-- 战绩：点击「回放」用该场比赛记录重放动画，不再次结算 -->
        <section>
          <div class="sec-h"><b>🏁 历史战绩</b><span class="d-sub">点击回放全场</span></div>
          <div v-if="rows.length" class="race-rows">
            <div v-for="l in rows" :key="l.id" class="race-row replay-row">
              <span class="rname">
                <em class="rseq">{{ stationName(l.seq) }}</em>{{ l.record.circuit.name }}
                <em class="rweather">{{ wIco[l.record.circuit.weather] }} {{ l.record.circuit.weather }}</em>
              </span>
              <span class="rmedal" :class="'m' + l.rank">{{ l.rank <= 3 ? ['🥇','🥈','🥉'][l.rank-1] : '🌊' }}</span>
              <span class="rpts mono">+{{ l.pts }} 分</span>
              <button class="btn ghost sm" @click="emit('replay', l)">↻ 回放</button>
            </div>
          </div>
          <div v-else class="empty" style="color:var(--muted)">尚未参赛，去浮岛赛道开赛吧！</div>
        </section>
      </div>
    </aside>
  </div>
</template>
