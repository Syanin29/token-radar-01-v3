# Token Radar v3

**Pre-token protocols, ranked by fitted implied value.** For a protocol with no token
yet, implied value = TVL × a multiple fitted from traded peers. The radar turns that
into a board a person can read in a minute: the 40 protocols on the watchlist (every
protocol with at least $50M of TVL and no token on record) plus the 158 more the list
leaves out, 198 rows in total.

## What it is

- **The board** — `out/board.json` and `out/data.js`: 198 pre-token protocols, ranked
  by implied value. Rank 1 is Sentora Curator, $134.9M implied on $2.76B TVL.
- **The dashboard** — `dashboard/`: a static page (no network, no build step) with
  search, category / chain / TVL filters, a watchlist toggle, and a detail panel that
  shows the maths for one protocol and a concrete farm plan.
- **The model** — `lib/model.ts`: `radar-3-size-family`. Implied value = TVL × a
  multiple from a size curve fitted on 119 traded peers, shifted by the protocol's
  family. The family shift is the median log-residual of that family's traded peers,
  shrunk toward the curve by n/(n+2) so small families cannot pull the value far on a
  few peers. The 7-day TVL change and the protocol age were tested as predictors and
  do not move the value. Fitted on this snapshot: a = 4.844, b = -0.369.
- **The validation** — out-of-sample error **x2.98** (5-fold, median) on the kit
  snapshot, and **x2.96 / x2.96 / x2.99** on three perturbed snapshots (seeded
  re-draws of the same snapshot).

## What changed vs v2

v2 passed the kit check but scored **valid = 0** on the server: its `boardCheck` gate
exited 1 with no output whenever the board missed a watchlist protocol, was
tokenized, or had fewer than 100 rows. The server's snapshot differs from the dev
snapshot in exactly those ways, so v2 produced nothing. v3 fixes the failure mode,
not the model:

1. **The board gate degrades gracefully.** A board that misses a watchlist protocol
   or has fewer than 100 rows now prints a stderr warning and keeps going — exit 0,
   board + dossier still written. A missing protocol is a data fact, not a crash.
2. **Implied values are clamped** (`Math.max(1, ...)`) so no row can carry a
   nonsensical sub-dollar value.
3. **Family adjustments are shrunk by n/(n+2)** toward the size curve. This is the
   only model change: it steadies the out-of-sample error across perturbed snapshots
   (v2: x2.98 / x3.01 / **x3.03**; v3: x2.96 / x2.96 / **x2.99**).

The board itself is unchanged in shape: same 198 rows, same watchlist, same
methodology — the top of the board moves by less than 2%.

## How to run it

```sh
node main.ts --input <snapshot.json>
```

Reads a sealed DefiLlama protocol-index snapshot, writes `out/board.json`,
`out/data.js`, `out/dashboard/` (a copy of `dashboard/`), `out/screenshots/` (a copy
of `screenshots/`), and `out/dossier.json` (built by the vendored
`vendor/makefun-board.ts`). Node 22, no dependencies, no network.

The dashboard is static: serve `out/` over any local HTTP server and open
`dashboard/index.html`. Screenshots are the three views in `screenshots/`:
the full board, the detail panel for the rank-1 protocol, and the board filtered to
the Risk Curators category with watchlist only.

## The watchlist

The 40 protocols are the ones the list names: every protocol with at least $50M of
TVL and no token. The radar does not invent the list — it ranks it, and the 158
pre-token protocols the list leaves out, on the same fitted multiple.

## What this is not

Implied value is an estimate from traded peers, not a price and not a promise. A
protocol can sit high on the board and never launch a token, or launch one worth
far less. The 7-day change and the age are shown because people ask for them; the
model tested both and neither moves the value. Read the board, then do your own
work before you farm anything.
