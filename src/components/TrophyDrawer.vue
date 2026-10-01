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
</script>

<template>
  <div class="drawer-mask" @click.self="emit('close')">
    <aside class="drawer">
      <header class="d-h">
        <div><h3>🏆 赛季之巅</h3><div class="d-sub">追赶积分目标，赢取赞助荣耀</div></div>
        <button class="d-x" @click="emit('close')">✕</button>
      </header>

      <div class="d-body">
        <!-- 赛季积分大数 -->
        <div class="pts-card">
          <div class="pts-num mono">{{ store.team.season_pts }}</div>
          <div class="pts-label">本赛季积分</div>
        </div>

        <!-- 赞助商 -->
        <section>
          <div class="sec-h"><b>🚩 赞助商 <span class="d-sub">达标即解锁资金与声望</span></b></div>
          <div v-for="s in store.state?.sponsors || []" :key="s.id" class="sp-card" :class="{ done: s.earned }">
            <div class="sp-top">
              <b>{{ s.name }}</b>
              <span class="tag" :class="s.earned ? 'm' : 'o'">{{ s.earned ? '✔ 已达标' : '目标 ' + s.target + ' 分' }}</span>
            </div>
            <div class="hbar sp-bar"><i :style="{ width: Math.min(100, store.team.season_pts / s.target * 100) + '%' }"></i></div>
            <div class="sp-reward"><span>奖励</span><span class="row gap8"><span class="tag o">¥{{ s.reward }}</span><span class="tag v">声望+{{ s.rep }}</span></span></div>
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
