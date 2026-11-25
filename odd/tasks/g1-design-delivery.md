# G1 prototype review chain
Target: `dev`; tracking issue: [#112](https://github.com/risaavedraf/firewatch/issues/112).
This is a design reference, not a production frontend replacement. Future integration waits for the issue approval and completed child reviews.

## Review order

Each review compares to its immediate parent. Counts are from the original source ranges; the delivery preserves those commits and limits the aggregate paths to `design/` and this design project's existing task file.

| Slice | Source range | Changed lines | Review focus |
|---|---|---:|---|
| 1 | `4acbad7..e656f1c` | 5,989 | Visual baseline and initial prototype directions |
| 2 | `e656f1c..e95bf42` | 4,999 | Terrain viewer and prevention/access prototype sources |
| 3 | `e95bf42..b84bb12` | 3,397 | Decision, alerts, field, and export prototype sources |
| 4 | `b84bb12..0ef52a8` | 753 | Quick actions on the aerial map |
| 5 | `0ef52a8..d94beae` | 30,032 | Gallery builder and its generated snapshots; review source and sampled boards and verify the complete output deterministically |
| 6 | `d94beae..d651459` | 2,870 | Synthetic model data and consumption by the model/sector boards |

The gallery cut exceeds the review guideline because its generated snapshots travel with the builder that creates them. Do not hand-edit snapshots or drop source, tests, or documentation to reduce the line count. Use each child's focused checks and inspect the dependency diff before reviewing it. The uncommitted navigation/layout and documentation batch is outside these six committed baselines and requires its own review before inclusion.

```text
dev <- design tracker <- 01 baseline <- 02 terrain <- 03 workflows <- 04 quick actions <- 05 gallery <- 06 synthetic data
```
