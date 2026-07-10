# Data-Plane Trajectory — seeds / mulch / plot

**Status:** Direction, not commitment. A record of how the bundled os-eco
data-plane tools are expected to evolve inside warren, to inform design choices
(esp. how much to invest in each seam). Timelines are deliberately vague.

---

Warren bundles five os-eco tools as opt-in features (canopy, mulch, seeds, sapling,
plot). Long term, these are **context integrations behind clean seams**, not warren
fundamentals — the same boundary discipline as the runtime contract, so any one is a
connector swap, not a domain rewrite.

| Tool | Trajectory | Design implication now |
|---|---|---|
| **plot** | **First to go.** Feels sloppy in this system; earliest deprecation candidate. | Do **not** gold-plate plot anywhere it touches the migration — keep its `finalize()` mirror delta thin and disposable. Minimize new plot surface. |
| **seeds** | Task tracking migrates toward **Jira / Linear with native connectors**, once enterprise repos/teams arrive. Not soon. | Invest in the seeds seam as a **connector shape** (swappable tracker), not a hard dependency. seeds-mirror in `finalize()` is worth doing properly. |
| **mulch** | Fine as-is; no harm. The memory layer gets **re-thought at enterprise scale** (dozens of repos, hundreds of engineers) — far out. | Steady. mulch-mirror in `finalize()` gets real effort. No near-term change. |
| **canopy / sapling** | No stated change. | Unaffected. |

**Throughline:** treat seeds/mulch/plot as data-plane adapters behind boundaries, so
swapping seeds→Linear or replacing the memory layer later is a seam change. Right now
that means: plot minimal, seeds connector-shaped, mulch solid.
