# Changelog

## [1.0.1] - 2026-11-04

- Add a screenshot section to the README and a gallery preview image
  (`pi.image`) for <https://pi.dev/packages>.
- README: replace the KaTeX `\color` dots with emoji so the peak/off-peak
  bullets render on npm as well as GitHub.

## [1.0.0] - 2026-11-04

- Initial release.
- DeepSeek account balance inline on the footer usage line.
- Green / orange peak indicator, flipped automatically at every pricing boundary.
- DeepSeek peak rules: 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri, excluding
  Chinese public holidays; everything else off-peak.
- Off-peak cost re-pricing for assistant messages and cache-warm usage entries.
- Balance refresh on session start, `/balance`, and 10 s after a chat settles
  (`settleRefreshDelayMs`) so DeepSeek has posted the spend.
- Configurable via `~/.pi/agent/peakseek.json`.
