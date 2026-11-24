# pumpfun-paper-sprint-hifikun

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/HifiKun/pumpfun-paper-sprint-hifikun/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/HifiKun/pumpfun-paper-sprint-hifikun/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Fresh-flow sniper for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty. One program, `main.ts` on Node 22, paper-trades pump.fun bonding curves on a 6-hour replay: it buys only when fresh buy pressure is accelerating (net SOL inflow, several distinct buyers, price rising but not yet vertical), pyramids a little into strength, and exits on take-profit, stop-loss, trailing stop, inflow fade, or a time limit. Tiny probe round-trips keep the run above the 20-coin guardrail bar when the momentum signal goes quiet. Paper trading only — no real funds, ever.

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/replay/v2` on stdin/stdout via `vendor/makefun-bot.ts` (the kit's SDK shim, zero dependencies). It reads one `hello` / `batch` / `done` JSON line at a time, answers each batch with at most one reply of orders, and never reads the clock, the environment, or randomness — every decision is deterministic from the harness stream.

---

<sub>Entered on [make.fun](https://make.fun/?ref=6a1ay90r&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
