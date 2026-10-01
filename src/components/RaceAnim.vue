<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useSkyStore } from '@/store/sky'
const store = useSkyStore()
// race：服务器落库的比赛记录（动画 / 实时排名 / 最终奖励共用同一份）；mode: live=开赛/续看，replay=历史回放
const props = defineProps({ race: { type: Object, required: true }, mode: { type: String, default: 'live' } })
const emit = defineEmits(['back'])

const wIco = { '晴': '🌤️', '风': '🌬️', '雨': '🌧️', '雾': '🌫️', '雷暴': '⛈️' }
const rec = computed(() => props.race.record)
const isLive = computed(() => props.mode === 'live')

/* ---------- 由同一份比赛记录派生的播放状态 ---------- */
const now = ref(0)
const showSettle = ref(false)
const settling = ref(false)
const showFactors = ref(false)
let settleCalled = false
let lastSaved = -1
let raf = null
let lastTs = 0

// 每艘艇在全局时间 t 下的位置：按分段 entry/times 线性推进，完赛后停在终点线前
function frameAt(t) {
  return rec.value.racers.map(r => {
    const done = t >= r.total
    let frac
    if (done) frac = 1
    else {
      let si = 0
      for (let k = 0; k < 3; k++) { if (t >= r.entry[k + 1]) si = k + 1 }
      const u = (t - r.entry[si]) / r.times[si]
      frac = (si + Math.min(1, Math.max(0, u))) / 3
    }
    return { ...r, frac, done, x: +(6 + frac * 88).toFixed(2) }
  })
}
const live = computed(() => frameAt(now.value))
// 实时排名只来自这份记录：分段进度降序，并列时总用时（最终名次）优先
const rankLive = computed(() => [...live.value].sort((a, b) =>
  (b.frac - a.frac) || (a.total - b.total)))
// 当前所处分段（以玩家艇时间轴为准）
const player = computed(() => rec.value.racers.find(r => r.isPlayer))
const curSeg = computed(() => {
  const t = now.value, e = player.value.entry
  if (t >= e[2]) return 2
  if (t >= e[1]) return 1
  return 0
})
// 当前应弹出的事件（超车 / 天气氛围），2.4s 展示窗
const activeEvent = computed(() => {
  let ev = null
  for (const e of rec.value.events) { if (e.t <= now.value + 0.02) ev = e; else break }
  return ev && now.value - ev.t < 2.4 ? ev : null
})
const result = computed(() => rec.value.result)
// 赛道分段几何：可行驶区间 6% → 94%（宽 88%），三等分
const TRACK_L = 6, TRACK_W = 88
const segDividers = [1, 2].map(i => +(TRACK_L + TRACK_W / 3 * i).toFixed(2))
const segMids = [0, 1, 2].map(i => +(TRACK_L + TRACK_W / 3 * (i + 0.5)).toFixed(2))

function tick(n) {
  if (!lastTs) lastTs = n
  const dt = Math.min(0.05, (n - lastTs) / 1000) // 切后台 rAF 暂停，用增量时间避免瞬移
  lastTs = n
  now.value = Math.min(rec.value.duration, now.value + dt)
  // live 模式节流上报观赛进度，作为「中断续看」锚点（与结算无关）
  if (isLive.value && now.value - lastSaved >= 0.8) {
    lastSaved = now.value
    store.saveProgress(props.race.id, now.value)
  }
  if (now.value >= rec.value.duration) {
    cancelAnimationFrame(raf); raf = null
    finish()
    return
  }
  raf = requestAnimationFrame(tick)
}

async function finish() {
  if (!isLive.value) { showSettle.value = true; return }
  if (settleCalled) return
  settleCalled = true                       // 防重复结算：前端只发一次
  settling.value = true
  // 结算以服务器比赛记录为唯一依据；接口本身幂等，断线重放也不会重复发奖
  const r = await store.settleRace(props.race.id)
  settling.value = false
  if (r.ok) showSettle.value = true
  else {
    settleCalled = false
    store.tip(r.msg || '结算失败，请重试')
    // 记录可能已被重启时的历史修复作废：拉取最新状态，使航线/资源/战绩回到服务器口径
    await store.refresh()
  }
}
function skipToEnd() {
  if (raf) cancelAnimationFrame(raf)
  raf = null
  now.value = rec.value.duration
  finish()
}
function replay() {
  now.value = 0; showSettle.value = false; lastSaved = -1; lastTs = 0
  raf = requestAnimationFrame(tick)
}
async function goBack() {
  if (settling.value) return
  if (raf) cancelAnimationFrame(raf)
  if (isLive.value && !settleCalled) store.saveProgress(props.race.id, now.value) // 中途退出：保存续看点
  emit('back')
}

onMounted(() => {
  // live 续看：从上次观赛位置开始；replay：从头回放
  const start = isLive.value ? Math.min(props.race.watch_el || 0, rec.value.duration - 0.05) : 0
  now.value = start
  if (isLive.value && start > 0.5) store.tip(`已为你从 ${start.toFixed(1)}s 处续看`)
  // 退出时动画恰好已播完：直接走结算，避免停在一条静止赛道上无处可点
  if (start >= rec.value.duration - 0.05) { finish(); return }
  raf = requestAnimationFrame(tick)
})
onUnmounted(() => { if (raf) cancelAnimationFrame(raf) })
</script>

<template>
  <div class="race-ov">
    <div class="race-sky">
      <button class="race-back" @click="goBack" :disabled="settling">← 退出{{ isLive ? '（自动续看）' : '回放' }}</button>
      <div class="race-mode" :class="isLive ? 'live' : 'rep'">{{ isLive ? '● LIVE 实况' : '↻ 历史回放' }}</div>

      <div class="race-title">
        <h3>🏁 {{ rec.circuit.name }} · {{ rec.segments[curSeg].name }}</h3>
        <div class="sub2">
          {{ wIco[rec.circuit.weather] }} {{ rec.circuit.weather }} · 难度 {{ '★'.repeat(rec.circuit.diff) }}
          · 分段赛制 3 段 · 你的总用时 {{ player.total.toFixed(2) }}s
        </div>
      </div>

      <!-- 天气 / 改装 / 人员状态：本场所依据的快照因素（与记录同源，可展开明细） -->
      <div class="factor-strip" @click="showFactors = !showFactors">
        <span class="fx-chip"><b>{{ wIco[rec.factors.weather] }}</b> {{ rec.factors.weather }}
          <em>×{{ rec.factors.weatherCoeff }}</em></span>
        <span class="fx-chip" v-for="(s, i) in rec.segments" :key="s.key" :class="{ on: i === curSeg }">
          {{ s.name }} 天气<em>×{{ player.segW[i] }}</em>
        </span>
        <span class="fx-chip">🔩 部件健康 <em>{{ rec.factors.parts_dur }}%</em></span>
        <span class="fx-chip" v-if="rec.factors.rental">🛟 租约艇 <em>{{ rec.factors.rental.name }}</em></span>
        <span class="fx-chip">🧑‍✈️ {{ rec.factors.pilot ? rec.factors.pilot.name : '无机师' }}</span>
        <span class="fx-chip">🔧 {{ rec.factors.mech ? rec.factors.mech.name : '无技工' }}</span>
        <span class="fx-more">{{ showFactors ? '收起 ▲' : '影响明细 ▼' }}</span>
      </div>
      <transition name="pop">
        <div v-if="showFactors" class="factor-detail">
          <div class="fd-block">
            <div class="fd-h">🧩 已装备改装（{{ rec.factors.mods.length }}）</div>
            <span v-for="m in rec.factors.mods" :key="m.id" class="tag b">+{{ m.bonus }} {{ m.name }}</span>
            <span v-if="!rec.factors.mods.length" class="d-sub">本场未装备任何改装件</span>
          </div>
          <div class="fd-block">
            <div class="fd-h">🧑‍✈️ 机师状态</div>
            <span v-if="rec.factors.pilot" class="d-sub">
              技巧 {{ rec.factors.pilot.skill }} · 胆识 {{ rec.factors.pilot.courage }}（天气抗性 {{ Math.round(rec.factors.detail.grit * 100) }}%）
              · 经验 {{ rec.factors.pilot.exp }} · 心情 {{ rec.factors.pilot.mood }} · 带队加成 +{{ rec.factors.detail.lead }}
            </span>
            <span v-else class="d-sub">无机师，带队加成按基础值 +20 计算</span>
          </div>
          <div class="fd-block">
            <div class="fd-h">🔧 技工状态</div>
            <span v-if="rec.factors.mech" class="d-sub">
              {{ rec.factors.mech.name }} · 技能 {{ rec.factors.mech.skill }} · 心情 {{ rec.factors.mech.mood }}
              · 调校加成 +{{ rec.factors.detail.mech }}
            </span>
            <span v-else class="d-sub">无技工，调校加成按基础值 +10 计算</span>
          </div>
        </div>
      </transition>

      <!-- 赛道：分段分隔线与分段名同样取自比赛记录 -->
      <div class="track seg-track">
        <div class="startline">起</div>
        <div class="seg-divider" v-for="(x, i) in segDividers" :key="'d' + i"
          :style="{ left: x + '%' }"></div>
        <div class="seg-label" v-for="(s, i) in rec.segments" :key="'l' + s.key"
          :style="{ left: segMids[i] + '%' }">{{ s.name }}</div>
        <div class="finishline">冲线</div>
        <div v-for="(r, i) in live" :key="r.id" class="lane" :style="{ top: (8 + i * 14.8) + '%' }">
          <div class="lane-ratio">
            <div class="ship" :class="{ player: r.isPlayer, done: r.done }"
              :style="{ left: r.x + '%', background: 'linear-gradient(120deg,' + r.color + ',' + r.color + 'cc)' }">
              <span class="s-icon">✈️</span>{{ r.name }}
            </div>
          </div>
          <div class="pos" :class="{ 'pos-p': r.isPlayer }">{{ r.done ? '🏁' : rankLive.indexOf(r) + 1 }}</div>
        </div>

        <!-- 分段事件横幅：超车 / 天气 -->
        <transition name="pop">
          <div v-if="activeEvent" class="race-event" :class="activeEvent.type">
            {{ activeEvent.type === 'overtake' ? '🔥 ' : '🌦️ ' }}{{ activeEvent.text }}
          </div>
        </transition>
      </div>

      <!-- 实时排位榜（LIVE）：每帧由同一份记录的分段进度排序 -->
      <div class="board">
        <div class="board-h">{{ isLive ? 'LIVE 实时排名' : 'REPLAY 排名' }}</div>
        <div v-for="(r, k) in rankLive" :key="r.id" class="board-row" :class="{ 'board-p': r.isPlayer }">
          <span class="bpos">{{ k + 1 }}</span>{{ r.name }}
          <span v-if="r.isPlayer" class="you">你</span>
          <span v-else-if="r.done" class="fin">🏁</span>
        </div>
      </div>

      <!-- 操作条 -->
      <div class="race-actions">
        <button v-if="isLive && !showSettle" class="btn ghost sm" :disabled="settling" @click="skipToEnd">
          ⏩ 跳过动画直接结算
        </button>
      </div>

      <!-- 结算卡：数字全部来自这份比赛记录；live 才触发结算，replay 仅展示 -->
      <transition name="pop">
        <div v-if="showSettle" class="settle">
          <div class="s-tag">{{ isLive ? '比赛结算' : '历史回放 · 本场结果' }}</div>
          <div class="medal">{{ result.rank <= 3 ? ['🥇', '🥈', '🥉'][result.rank - 1] : '🌊' }}</div>
          <div class="s-title">第 {{ result.rank }} 名</div>
          <div class="s-row"><span>积分</span><b>+{{ result.pts }}</b></div>
          <div class="s-row"><span>奖金</span><b>+¥{{ result.money }}</b></div>
          <div class="s-row" v-if="rec.factors.rental">
            <span>租艇磨损（{{ rec.factors.rental.name }}）</span><b style="color:#ff9fb0">-{{ result.wear }} · 记入租约</b>
          </div>
          <div class="s-row" v-else><span>部件磨损</span><b style="color:#ff9fb0">-{{ result.wear }}</b></div>
          <div class="s-row"><span>声望</span><b>+{{ result.repGain }}</b></div>
          <div class="s-row"><span>总用时</span><b>{{ player.total.toFixed(2) }}s</b></div>
          <div v-if="isLive" class="s-note">奖励已一次性结算到车队账户</div>
          <button class="btn primary s-btn" @click="goBack">{{ isLive ? '返回航线 ▶' : '返回 ✕' }}</button>
          <button v-if="!isLive" class="btn ghost s-btn" @click="replay">↻ 重新回放</button>
        </div>
      </transition>

      <!-- 结算中遮罩（等待幂等结算返回，杜绝重复点击） -->
      <div v-if="settling" class="settle-mask"><div class="settle-spin">🏁 正在按比赛记录结算…</div></div>
    </div>
  </div>
</template>
