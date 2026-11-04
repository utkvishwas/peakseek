# peakseek

DeepSeek account balance, a live **peak / off-peak indicator**, and **off-peak
price adjustment** — all inline on Pi's footer usage line.

```text
~/code/project (main)
↑12.4k ↓3.1k R88k CH87.2% $0.004 bal $1.62 ● off-peak 5.0%/1.0M (auto)  deepseek-flash • high
```
<img width="1468" height="720" alt="image" src="https://github.com/user-attachments/assets/a333df4a-9bad-4296-be7a-659cee6a7406" />

- **`bal $1.62`** — remaining DeepSeek balance, on the same line as tokens/cost.
- **$\color{#22c55e}\bullet$ `off-peak` (green)** / **$\color{#f97316}\bullet$ `peak` (orange)** — the current DeepSeek pricing
  window, updated automatically at every boundary. No interaction needed.
- **Cost is re-priced** with the off-peak discount when a response finishes
  off-peak, so the footer, session totals and exported sessions show what you
  were actually charged.
- **`/balance`** prints total / granted / topped-up and refreshes immediately.

## Install

```bash
# latest
pi install npm:peakseek

# pinned
pi install npm:peakseek@1.0.0

# from git
pi install git:github.com/utkvishwas/peakseek@v1.0.0

# from a local checkout
pi install ./peakseek
```

Restart Pi or run `/reload`.

Remove it with `pi remove npm:peakseek`.

> Make sure you do not also keep a loose copy in `~/.pi/agent/extensions/`.
> Auto-discovery and the package would both load it (duplicate footer and
> double cost adjustments).

Requires a DeepSeek API key in Pi — either `DEEPSEEK_API_KEY` or added via
`/login`. Without a key the balance is simply hidden; nothing errors.

## Peak hours

DeepSeek's pricing page (<https://api-docs.deepseek.com/quick_start/pricing>):

> Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and
> 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays.
> All other hours are off-peak, including weekends and Chinese public holidays
> in full.

|              | UTC                         |
| ------------ | --------------------------- |
| **Peak**     | 01:00–04:00 and 06:00–10:00 |
| **Off-peak** | everything else             |

Peak applies only Monday–Friday (China time) and not on Chinese public
holidays. Weekends and whole holidays are off-peak.

The dot flips by itself: green → orange at 01:00/06:00 UTC, orange → green at
04:00/10:00 UTC, and Friday 10:00 UTC → green until Monday 01:00 UTC.

### Holidays

The 2026 Chinese public holiday calendar (33 days off, from the State Council
notice) is built in and also written to your config file:

| Holiday         | Days off  |
| --------------- | --------- |
| New Year        | Jan 1–3   |
| Spring Festival | Feb 15–23 |
| Qingming        | Apr 4–6   |
| Labour Day      | May 1–5   |
| Dragon Boat     | Jun 19–21 |
| Mid-Autumn      | Sep 25–27 |
| National Day    | Oct 1–7   |

Update the `holidays` array in the config when the next year's schedule is
published (usually early November). Data source: the State Council notice, or
[`NateScarlet/holiday-cn`](https://github.com/NateScarlet/holiday-cn).

Makeup workdays (e.g. a Saturday that is a working day) are treated as
off-peak, because the documentation says weekends are off-peak in full. To
change that, list those dates in a separate setting of your own build — they are
deliberately not modelled here.

## Balance refresh timing

The balance is read **only**:

| When                                | Behavior                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Session start (launch, new, resume) | immediately                                                                                                                        |
| After a chat run settles            | **10 s later** (`settleRefreshDelayMs`) — DeepSeek posts the spend a moment after the response ends, so an immediate read is stale |
| `/balance`                          | immediately, and cancels any pending delayed read                                                                                  |
| New run starts                      | cancels the pending delayed read                                                                                                   |

There is no polling. Requests in flight are coalesced. If no DeepSeek key is
configured the balance is hidden and no further calls are made.

## Configuration

Optional file: `~/.pi/agent/peakseek.json`. Everything is optional; the
defaults below are used when the file is missing. Edit then `/reload`.

```json
{
  "baseUrl": "https://api.deepseek.com",
  "peakWindowsUtc": [
    ["01:00", "04:00"],
    ["06:00", "10:00"]
  ],
  "peakWeekdays": ["Mon", "Tue", "Wed", "Thu", "Fri"],
  "holidays": ["2026-01-01", "..."],
  "offPeakMultiplier": 0.5,
  "modelMultipliers": { "deepseek-flash": 0.5, "deepseek-v4-pro": 0.5 },
  "settleRefreshDelayMs": 10000
}
```

| Key                    | Meaning                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| `baseUrl`              | DeepSeek API root (balance endpoint is `${baseUrl}/user/balance`) |
| `peakWindowsUtc`       | Peak time-of-day ranges in UTC; everything outside is off-peak    |
| `peakWeekdays`         | Weekdays that can have peak hours (weekends never do)             |
| `holidays`             | Asia/Shanghai calendar dates that are off-peak for the whole day  |
| `offPeakMultiplier`    | Cost multiplier while off-peak, `0.5` = pay 50 %                  |
| `modelMultipliers`     | Per-model override of `offPeakMultiplier`                         |
| `settleRefreshDelayMs` | Delay before the post-chat balance read (`0` = immediate)         |

## How the cost adjustment works

Responses are re-priced in the `message_end` hook: when a DeepSeek assistant
message finishes off-peak, its `usage.cost` (input, output, cache read/write,
total) is multiplied by the discount. Because this happens before Pi persists
the message, every consumer agrees — footer, `/session`, exports.

Cache-warm / bookkeeping `usage` entries never pass through `message_end`, so
they are re-priced at render time using their own timestamp.

Not adjusted: compaction and branch-summary usage. Those session entries do not
record which provider/model produced the summary, so their cost stays at list
price (a fraction of a cent per compaction, and only if it ran off-peak).

## Limitations

- Replaces the built-in footer. The virtual-model `→ physical model` routing
  indicator is not available to extensions and is therefore not reproduced.
  Normal (non-virtual) models are unaffected.
- The `(auto)` compaction badge is derived from `compaction.enabled` in
  `~/.pi/agent/settings.json` at session start, so toggling auto-compaction
  mid-session can lag until `/reload`.

## Development

```bash
pi install ./peakseek   # local dir, loaded in place
# in Pi: /reload
```

The extension is plain TypeScript, loaded by Pi via jiti; there is no build step.
Type-checking against Pi's published types works with any standard `tsconfig`
(`strict` passes).

## License

MIT
