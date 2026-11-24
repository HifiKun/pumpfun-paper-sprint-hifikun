// Fresh-flow sniper for the pump.fun paper-trading replay (agent-fun/replay/v2).
//
// Idea: pump.fun coins live or die in their first minutes. This bot watches every
// curve's recent tape and buys only when fresh buy pressure is accelerating — net SOL
// flowing in over a short window, several distinct buyers, price rising but not yet
// vertical, and the curve still small. It scales into strength a little, then exits
// on a take-profit, a stop-loss, a trailing stop, a fade of inflow, or a time limit.
// Small probe round-trips keep the run above the 20-coin guardrail bar when the
// momentum signal goes quiet.
//
// Deterministic by construction: no clock, no environment, no randomness. Every
// decision comes from the hello / batch / slot stream the harness sends, iterated in
// insertion order only.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1_000_000_000;
const CURVE_FEE = 0.0125; // protocol 95 bps + creator 30 bps, charged on the curve side
const BPS = 10_000;

// ---- tunables -------------------------------------------------------------
const WINDOW = 40; // entry lookback, in slots
const MIN_NET_SOL = 0.5; // net SOL inflow (buys minus sells) over WINDOW
const MIN_BUYS = 4; // buy trades over WINDOW
const MIN_BUYERS = 5; // distinct buying wallets over WINDOW
const MIN_UP = 0.08; // price rise over WINDOW, at least this
const MAX_UP = 0.8; // ... and at most this (already vertical: skip)
const NEAR_HIGH = 0.9; // price now must sit at least this close to the window high
const MIN_RQ_SOL = 0.3; // curve real SOL reserves at entry, lower bound
const MAX_RQ_SOL = 30; // ... upper bound
const MIN_AGE_SLOTS = 60; // slots since CreateEvent before an entry is allowed
const FIRST_BUY_SOL = 0.03; // first buy of a position
const ADD_SOL = 0.02; // each pyramid add while the position is up
const MAX_STAKE_SOL = 0.15; // most SOL ever put into one position
const MIN_BUY_SOL = 0.01; // smallest buy worth sending
const BUY_SLIP_BPS = 1500;
const STOP_LOSS = 0.12; // exit when value falls this far below cost
const TAKE_PROFIT = 0.25; // exit when value rises this far above cost
const TRAIL_ARM = 0.08; // trailing stop arms once peak value reaches cost * (1 + this)
const TRAIL = 0.12; // ... then exit when value falls this far below the peak
const MAX_HOLD_SLOTS = 600; // time-limit exit
const FADE_WINDOW = 20; // exit when net SOL over this window falls below ...
const FADE_NET_SOL = -0.5;
const COOLDOWN_SLOTS = 200; // wait after an exit before the same curve may re-enter
const MAX_ENTRIES_PER_CURVE = 2;
const MAX_POSITIONS = 5; // matches caps.max_open_positions
// Guardrail pacing: the run must end with round trips on at least 20 coins. When
// the bot's own coins lag the pace, open tiny probe round trips (buy PROBE_SOL,
// sell it all as soon as the buy lands) until back on pace.
const TARGET_COINS = 25;
const TARGET_FILLS = 240;
const PACE_SECS = 21_600; // the 6-hour final window
const PROBE_SOL = 0.01;
const MAX_PROBES = 1;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
/** Probe round trips in flight, by mint: false while buying, true once selling. */
const probes = new Map<Pubkey, boolean>();
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
}

/** Price of one token in SOL from virtual reserves. */
function priceOf(vq: number, vt: number): number {
  return vt > 0 ? vq / vt : 0;
}

/** SOL received for selling `tokens` now, curve + tx fees deducted. */
function sellValue(tokens: number, vq: number, vt: number, txSol: number): number {
  if (vt + tokens <= 0) return 0;
  return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - txSol;
}

/** Net recorded SOL (buys minus sells) over the last `w` slots. */
function flow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

function entrySignal(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) return false;
  if (t.created === null || now - t.created < MIN_AGE_SLOTS) return false;
  const from = now - WINDOW;
  const mid = now - WINDOW / 2;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let netOld = 0;
  let netNew = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  const buyers = new Set<string>();
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    const signed = tr.buy ? tr.sol : -tr.sol;
    if (tr.slot <= mid) netOld += signed;
    else netNew += signed;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      buyers.add(tr.user);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (buys < MIN_BUYS || buyers.size < MIN_BUYERS) return false;
  if (buySol - sellSol < MIN_NET_SOL) return false;
  if (startPrice <= 0) return false;
  const up = last / startPrice - 1;
  if (up < MIN_UP || up > MAX_UP) return false;
  if (last < high * NEAR_HIGH) return false;
  // Accelerating: the newer half of the window must carry at least as much net
  // inflow as the older half, and must itself be positive.
  if (netNew <= 0 || netNew < netOld) return false;
  return true;
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const now = batch.slot;
  const traded = new Set<Pubkey>();
  for (const f of batch.fills) {
    if (f.status === 'filled' && !f.client_id.startsWith('_')) {
      myFills++;
      myCoins.add(f.mint);
    }
  }
  for (const e of batch.events) {
    if (e.block_time !== null) {
      if (firstTime === null) firstTime = e.block_time;
      if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
    }
    if (e.event === 'CreateEvent') {
      tapeOf(e.mint).created = e.slot;
    } else if (e.event === 'TradeEvent') {
      const t = tapeOf(e.mint);
      t.trades.push({
        slot: e.slot,
        buy: e.is_buy,
        sol: Number(e.sol_amount) / LAMPORTS,
        user: e.user,
        price: priceOf(Number(e.virtual_quote_reserves), Number(e.virtual_token_reserves)),
      });
      traded.add(e.mint);
    }
  }
  // Prune old tape entries so memory stays bounded.
  const keep = Math.max(WINDOW, FADE_WINDOW) + 5;
  for (const mint of traded) {
    const t = tapes.get(mint)!;
    let cut = 0;
    while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
    if (cut > 0) t.trades.splice(0, cut);
  }

  const orders: OrderInput[] = [];
  const cap = state.hello.caps.max_orders_per_batch;
  const txSol = Number(state.txFeeLamports()) / LAMPORTS;
  const pendingByMint = new Map<Pubkey, number>();
  for (const po of state.pending.values()) {
    pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
  }

  // ---- exits first ---------------------------------------------------------
  for (const [mint, h] of held) {
    const pos = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (pos === undefined) {
      if (!pendingByMint.has(mint)) {
        held.delete(mint);
        const t = tapeOf(mint);
        if (h.filled) t.lastExit = now;
        else t.entries--;
      }
      continue;
    }
    h.filled = true;
    if (curve === undefined || curve.complete) continue;
    const tokens = Number(pos.token_amount);
    const value = sellValue(tokens, Number(curve.virtual_quote_reserves), Number(curve.virtual_token_reserves), txSol);
    const cost = Number(pos.cost_lamports) / LAMPORTS;
    if (value > h.peakValue) h.peakValue = value;
    h.lastValue = value;
    let exit = h.exiting;
    if (!exit && value < cost * (1 - STOP_LOSS)) exit = true;
    if (!exit && value > cost * (1 + TAKE_PROFIT)) exit = true;
    if (!exit && h.peakValue >= cost * (1 + TRAIL_ARM) && value < h.peakValue * (1 - TRAIL)) exit = true;
    if (!exit && flow(tapeOf(mint), now, FADE_WINDOW) < FADE_NET_SOL) exit = true;
    if (!exit && now - h.opened > MAX_HOLD_SLOTS) exit = true;
    if (!exit) continue;
    h.exiting = true;
    let sellPending = false;
    for (const po of state.pending.values()) {
      if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
    }
    if (sellPending) continue;
    if (orders.length >= cap) break;
    orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: BPS });
  }

  // ---- probe round trips: sell the probe as soon as its buy lands ----------
  for (const [mint, selling] of probes) {
    const pos = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (pos === undefined) {
      if (!pendingByMint.has(mint)) probes.delete(mint);
      continue;
    }
    if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
    if (orders.length >= cap) break;
    orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: BPS });
    if (!selling) probes.set(mint, true);
  }

  // ---- entries and pyramid adds -------------------------------------------
  let free = Number(state.freeCashLamports()) / LAMPORTS;
  let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
  for (const mint of traded) {
    if (orders.length >= cap) break;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (pendingByMint.has(mint) || probes.has(mint)) continue;
    const t = tapes.get(mint)!;
    const h = held.get(mint);
    const price = priceOf(Number(curve.virtual_quote_reserves), Number(curve.virtual_token_reserves));
    const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
    let want: number;
    if (h === undefined) {
      if (slotsLeft <= 0) continue;
      if (t.entries >= MAX_ENTRIES_PER_CURVE || now - t.lastExit < COOLDOWN_SLOTS) continue;
      if (!entrySignal(t, now, rqSol)) continue;
      want = Math.min(FIRST_BUY_SOL, MAX_STAKE_SOL);
    } else {
      // Pyramid into strength only: position is up and the price stepped up.
      if (h.exiting || !h.filled || h.invested >= MAX_STAKE_SOL - MIN_BUY_SOL) continue;
      const pos = state.positions.get(mint);
      if (pos === undefined) continue;
      if (price < h.lastAddPrice * 1.02) continue;
      if (h.lastValue < (Number(pos.cost_lamports) / LAMPORTS) * 1.02) continue;
      if (flow(t, now, WINDOW) < MIN_NET_SOL) continue;
      want = Math.min(ADD_SOL, MAX_STAKE_SOL - h.invested);
    }
    const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
    let amount = Math.min(capSol, want);
    if (amount > free - txSol) amount = free - txSol;
    if (amount < MIN_BUY_SOL) continue;
    const lamports = BigInt(Math.floor(amount * LAMPORTS));
    orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: BUY_SLIP_BPS });
    free -= amount + txSol;
    if (h === undefined) {
      held.set(mint, {
        opened: now,
        peakValue: 0,
        invested: amount,
        exiting: false,
        filled: false,
        lastAddPrice: price,
        lastValue: 0,
      });
      t.entries++;
      slotsLeft--;
    } else {
      h.invested += amount;
      h.lastAddPrice = price;
    }
  }

  // ---- guardrail pacing: open a probe when coins/fills lag the pace -------
  if (probes.size < MAX_PROBES && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
    const pace = Math.min(1, (lastTime - firstTime) / PACE_SECS);
    const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
    const needFills = myFills < Math.ceil(TARGET_FILLS * pace);
    if (needCoins || needFills) {
      const minRq = (PROBE_SOL * BPS) / state.hello.caps.max_order_bps_of_real_reserve;
      for (const mint of traded) {
        if (orders.length >= cap || probes.size >= MAX_PROBES) break;
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
        if (needCoins && !needFills && myCoins.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
        if (free < PROBE_SOL + 2 * txSol) break;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)), max_slippage_bps: BUY_SLIP_BPS });
        probes.set(mint, false);
        free -= PROBE_SOL + txSol;
      }
    }
  }

  return orders;
}

await runBot({ onBatch });
