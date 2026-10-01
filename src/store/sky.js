import { defineStore } from 'pinia'

const j = (p, o) => fetch(p, o).then(r => r.json())
const post = (p, b) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })

export const useSkyStore = defineStore('sky', {
  state: () => ({ state: null, loaded: false, toast: '' }),
  getters: {
    team: s => s.state?.team || {},
    airship: s => s.state?.airship || {},
    circuits: s => s.state?.circuits || [],
    upgrades: s => s.state?.upgrades || [],
    // 零件商店目录（价格/属性来自服务端配置，客户端不可改写）
    shop: s => s.state?.shop || [],
    // 进行中（可中断续看）的比赛记录
    activeRace: s => s.state?.activeRace || null,
    // 历史比赛（已结算，可回放）
    raceHistory: s => s.state?.races || [],
    // 当前生效的租约（null = 自有艇出赛）
    rental: s => s.state?.rental || null,
    // 租赁艇型目录（性能/押金/租金/场次/费率均为服务端配置）
    rentalShop: s => s.state?.rentalShop || [],
    // 最近归还结算记录
    rentalHistory: s => s.state?.rentalHistory || []
  },
  actions: {
    async init() { this.state = await j('/api/state'); this.loaded = true },
    async refresh() { this.state = await j('/api/state') },
    tip(msg) { this.toast = msg; setTimeout(() => this.toast = '', 2600) },
    // 下单只提交商品 id；价格、属性与加成一律由服务端按商品配置核定
    async shop(id) { const r = await post('/api/shop', { id }); await this.refresh(); if (!r.ok) this.tip(r.msg); return r },
    async equip(id) { await post('/api/equip/' + id); await this.refresh() },
    async unequip(id) { await post('/api/unequip/' + id); await this.refresh() },
    async hirePilot() { const r = await post('/api/hire_pilot'); await this.refresh(); this.tip(r.msg) },
    async hireMech() { const r = await post('/api/hire_mech'); await this.refresh(); this.tip(r.msg) },
    async train(id) { const r = await post('/api/train', { id }); await this.refresh(); if (r.ok) this.tip(r.msg); else this.tip(r.msg) },
    async maintain() { const r = await post('/api/maintain'); await this.refresh(); if (!r.ok) this.tip(r.msg); else this.tip('维护完成，耗资 ' + r.cost) },
    // 签约租艇：只提交艇型 id；押金/租金/性能由服务端按目录核定，签约即扣款
    async rentShip(id) { const r = await post('/api/rentals/rent', { id }); await this.refresh(); if (!r.ok) this.tip(r.msg); return r },
    // 归还租艇：按租约结算磨损费并退还押金；幂等，重复调用只结算一次
    async returnShip() { const r = await post('/api/rentals/return'); await this.refresh(); this.tip(r.msg); return r },
    // 开赛：生成完整比赛记录（分段过程+奖励已定）；已有 running 记录时返回同一份用于续看
    async startRace(cid) { return await post('/api/races/start/' + cid) },
    // 上报观赛进度（中断续看锚点）
    async saveProgress(raceId, el) {
      try { await post(`/api/races/${raceId}/progress`, { el }) } catch (e) { /* 进度丢失不影响比赛 */ }
    },
    // 结算：幂等，重复调用只发一次奖
    async settleRace(raceId) { return await post(`/api/races/${raceId}/settle`) },
    async reset() { await post('/api/reset'); await this.init() }
  }
})
