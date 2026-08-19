# Changelog

## 0.2.3 — 2026-07-17

### Fixed

- Loading HUD no longer inherits spinner styles on every nested element.
- Removed the obsolete decorative three-dot loader layer.
- GPU failures no longer leave the operation stuck at 0%.
- CPU fallback now uses the same streamed progress and verbose pipeline.
- Missing, empty or corrupt indexes return typed errors and terminate cleanly.
- Status requests remain available when the local index JSON is corrupt.
- WebGPU availability is no longer disabled merely because a project has not been indexed.
- Progress state is monotonic, single-owner and dismissed when the overlay closes.

### Added

- Index-required action guard that redirects users to the Project screen before invalid searches.
- Safe `suprememind gui stop` command for closing an existing local instance.
- Friendly port reuse detection when another SupremeMind instance is already active.
- Windows CI smoke tests, PowerShell syntax validation and package dry-run validation.
- Integration coverage for no-index GPU requests, corrupt indexes, stream termination and asset ordering.

### Changed

- GUI and package version updated to 0.2.3.
- GPU code exposes an explicit query API instead of installing a second fetch interceptor.
- The live-progress controller is now the only owner of action transport and fallback state.

## 0.2.2 — 2026-07-16

### Added

- Real NDJSON progress streaming for GUI actions.
- Percentage values tied to completed files, bytes, graph nodes, edges, memories or search candidates.
- Collapsible **Mostrar mais** panel with verbose logs in real time.
- Current stage, current file/item, completed/total counters and elapsed time.
- Real per-file progress for indexing and incremental updates.
- Streaming CPU search with per-file BM25 and semantic ranking logs.
- Real progress for context assembly, impact, orbit, Galaxy, recall, memory, doctor and benchmark.
- WebGPU progress events for matrix loading, query planning, shader execution, ranking and response serialization.
- Log retention limits to keep the browser responsive on very large projects.

### Changed

- Removed the decorative three-dot percentage indicator.
- Progress never moves backwards when an operation changes internal phase.
- Unmeasurable GPU or serialization phases keep the last confirmed percentage and are explicitly marked as internally unmeasured.
- GUI version updated to 0.2.2.

## 0.2.1 — 2026-07-16

### Added

- Optional WebGPU compute path for semantic vector ranking.
- High-performance GPU adapter selection in compatible browsers.
- Cached vector matrix uploaded once to GPU memory and reused between searches.
- GPU status card showing active compute, visual-only mode or CPU fallback.
- Hardware-accelerated compositor hints for panels, animations, canvas and iframe rendering.
- Local GPU query-planning endpoints with BM25, exact-path, centrality and memory factors.
- Automatic CPU fallback when WebGPU is unavailable, lost or rejected by the driver.
- GPU event tracking in the session activity stream.
- Test coverage for injected GPU assets, vector matrix and query planning.

### Changed

- GUI version updated to 0.2.1.
- Browser search now uses a hybrid pipeline: lexical factors on the local server and semantic dot products on WebGPU.
- Query vectors and the indexed vector matrix use compact Float32 buffers.
- Loading indicators remain honest and do not report a fabricated percentage.

### Notes

- File walking, parsing, hashing, Git analysis and graph construction remain CPU/disk workloads.
- WebGPU acceleration primarily benefits semantic ranking and graphical fluency.

## Unreleased

### Added

- Complete in-app **Ajuda e treinamento** center.
- Visual eight-step workflow from project loading to persistent memory.
- Explanations for every GUI module and metric.
- Visible examples for search, AI context, impact analysis and memory.
- Token-budget reference table and hybrid-score explanation.
- Glossary for graph, retrieval and context concepts.
- Daily operational checklist.
- Expandable troubleshooting and security guidance.
- Quick navigation buttons that open the corresponding SupremeMind modules.
- Automated GUI test coverage for the help page and its stylesheet.

## 0.2.0 — 2026-07-16

### Added

- SupremeMind Control Core graphical interface.
- Visual project selector with Windows folder picker.
- Dashboard for files, symbols, edges, basins, Git and memories.
- Graphical initialization, indexing, incremental update and forced rebuild.
- Hybrid code search with graphical relevance cards.
- Token-budgeted context generator with copy and Markdown download.
- Embedded SupremeMind Galaxy workspace.
- Impact and orbit inspectors.
- Indexed file explorer and safe source viewer.
- Persistent memory editor and browser.
- Visual configuration editor.
- Doctor and benchmark panels.
- Session activity stream and operation logs.
- Restricted local GUI API with path confinement and action allowlist.
- One-click Windows launcher and desktop shortcut.
- GUI integration tests.

### Changed

- GUI is now the primary recommended workflow.
- Package version updated to 0.2.0.
- Installer now creates a desktop shortcut for the Control Core.
- CLI remains available for automation and advanced use.

## 0.1.0 — 2026-07-16

### Added

- Incremental repository index using SHA-256.
- Lightweight parsers for C/C++, C#, JavaScript, TypeScript, Python, JSON, Markdown, XML and configuration files.
- Dependency, call and Git co-change graph.
- PageRank centrality and attraction basins.
- Hybrid retrieval with BM25, local semantic vectors, centrality and persistent memory.
- Token-budgeted context assembly.
- Orbit and impact analysis.
- SupremeMind Galaxy HTML report.
- Local HTTP and MCP/JSON-RPC adapter.
- Codex Skill and Windows installer.
- End-to-end tests and GitHub Actions CI.
