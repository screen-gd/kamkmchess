# Dependency and asset inventory

Inventory for [Establish the React/TypeScript application and build checks](https://linear.app/kamkm/issue/KHA-26/establish-the-reacttypescript-application-and-build-checks), updated 2026-10-18. `package.json` pins direct versions and `pnpm-lock.yaml` locks the complete graph, including platform-specific optional build packages. The project, including original application code, is licensed under [GPL-3.0-or-later](../LICENSE). The owner adopted this license on 2026-10-18. Earlier MIT grants remain valid, and the [previous MIT notice](licenses/kamkmchess-MIT.txt) is retained in the source and generated distribution notices.

## Distributed runtime code

| Package | Locked version | License | Source / copyright |
| --- | --- | --- | --- |
| chessops | 0.15.1 | GPL-3.0-or-later | Niklas Fiekas and contributors. [chessops source](https://github.com/niklasf/chessops). |
| @badrap/result | 0.3.1 | MIT | [Source](https://github.com/badrap/result). |
| chess.js | 1.4.0 | BSD-2-Clause | Jeff Hlywa. [chess.js source](https://github.com/jhlywa/chess.js). |
| @lichess-org/chessground | 10.4.2 | GPL-3.0-or-later | Lichess team. [Chessground source](https://github.com/lichess-org/chessground). |
| react | 19.3.1 | MIT | [React source](https://github.com/facebook/react), Meta Platforms, Inc. and affiliates. |
| react-dom | 19.3.1 | MIT | [React source](https://github.com/facebook/react), Meta Platforms, Inc. and affiliates. |
| scheduler | 0.28.0 | MIT | [React source](https://github.com/facebook/react), Meta Platforms, Inc. and affiliates. |
| @base-ui/react | 1.9.0 | MIT | [Base UI](https://base-ui.com), the primitives beneath Quartz controls. |
| @fortawesome/free-solid-svg-icons | 7.3.1 | CC BY 4.0 (SVGs), MIT (code) | [Font Awesome Free license](https://fontawesome.com/license/free). |
| @fontsource-variable/inter-tight | 5.3.0 | OFL-1.1 | [Inter Tight](https://fontsource.org/fonts/inter-tight), self-hosted Latin subset. |
| @fontsource/instrument-serif | 5.3.0 | OFL-1.1 | [Instrument Serif](https://fontsource.org/fonts/instrument-serif), self-hosted regular Latin subset. |
| @fontsource-variable/space-grotesk | 5.3.0 | OFL-1.1 | [Space Grotesk](https://fontsource.org/fonts/space-grotesk), retained from earlier design work; not bundled. |
| class-variance-authority | 0.7.1 | Apache-2.0 | [CVA](https://cva.style), Quartz control variants. |
| clsx | 2.1.1 | MIT | [clsx source](https://github.com/lukeed/clsx). |
| tailwind-merge | 3.7.0 | MIT | [tailwind-merge source](https://github.com/dcastil/tailwind-merge). |
| @clerk/clerk-js | 6.39.1 | MIT | [Clerk JavaScript source](https://github.com/clerk/javascript), optional account client loaded only when accounts are configured. |
| @clerk/ui | 1.40.2 | MIT | [Clerk JavaScript source](https://github.com/clerk/javascript), lazy-loaded sign-in components supplied to the SDK. |

`pnpm build` reads actual installed runtime package versions, checks them against the lockfile, and copies each full license text into `dist/THIRD_PARTY_NOTICES.txt`. It copies the original-code license to `dist/LICENSE.txt`. Missing license text or a runtime version mismatch fails the build. Ship these files with the assets.

The generated inventory includes the Clerk client's transitive dependencies. `pnpm-workspace.yaml` explicitly denies the reviewed `browser-tabs-lock` and `core-js` install scripts, which only print funding banners and are not required to build. Application TypeScript remains strict, including exact optional properties. `skipLibCheck` skips third-party declaration-file checking because this Clerk release includes incompatible declarations; application adapter code still typechecks.

Notice collection accepts both `LICENSE` and `LICENCE` filenames. The pinned `glob-to-regexp@0.4.1` release includes its complete BSD-2-Clause copyright, conditions and disclaimer in the final License section of its distributed README. The generator includes that section verbatim; it still fails for an unreviewed missing license.

The UI dependencies include `jsesc@3.1.0`, whose full MIT terms are in `LICENSE-MIT.txt`.
Two other pinned MIT packages omit license text from their npm archives. The
retained [toggle-selection notice](licenses/toggle-selection-MIT.txt) is from
upstream Git blob `4a7395ee831dc1617bf5195dcb353c5bbd89afcd`, SHA-256
`771e50e27b24269923639e8e0cc650e7187ffeab5726f6a6f47d9ea83865089d`.
The [input-otp notice](licenses/input-otp-MIT.txt) is from upstream Git blob
`3d8feae905f69bb4279c5abe93d005c7ccc5bdf7`, SHA-256
`079031192fea535a245aa64a637d8433c406b82a14f91c3606b1d63e41c00152`.
Notice generation permits these copies only for `toggle-selection@1.0.6` and
`input-otp@1.4.2`; new versions still require review.

The build also writes `dist/DEPENDENCY_INVENTORY.json` with every locked package path, version, declared license, tooling/runtime scope and optional flag. This includes optional packages for other operating systems, not a claim that they are all installed or bundled. Review the lockfile and this inventory on changes. Tooling is not copied as a browser runtime dependency. The Vite module-preload polyfill is disabled for the selected modern targets.

## Direct build and verification tools

| Package | Pinned version | Declared license |
| --- | --- | --- |
| @eslint/js | 10.0.1 | MIT |
| @playwright/test | 1.64.1 | Apache-2.0 |
| @types/node | 24.19.2 | MIT |
| @types/react | 19.3.0 | MIT |
| @types/react-dom | 19.3.0 | MIT |
| @vitejs/plugin-react | 6.1.2 | MIT |
| @tailwindcss/vite | 4.3.3 | MIT |
| eslint | 10.12.0 | MIT |
| eslint-plugin-react-hooks | 7.1.1 | MIT |
| eslint-plugin-react-refresh | 0.5.7 | MIT |
| fake-indexeddb | 6.2.5 | Apache-2.0 |
| globals | 17.13.0 | MIT |
| tailwindcss | 4.3.3 | MIT |
| typescript | 6.0.3 | Apache-2.0 |
| typescript-eslint | 8.71.2 | MIT |
| vite | 8.3.4 | MIT |
| vitest | 5.0.5 | MIT |

The optional developer subpackage in `supabase/tests/local/` has its own lockfile. It pins `@electric-sql/pglite` 0.5.10 (Apache-2.0) and vendors pgTAP 1.3.3's extension SQL/control bundle (revised FreeBSD license, retained in the SQL). These tools run embedded PostgreSQL for offline fixtures. They are not dependencies of the application package or browser bundle. The [runner guide](../supabase/tests/local/README.md) records source provenance and checksums.

TypeScript 6.0.3 stays within typescript-eslint 8.71.2's declared `>=4.8.4 <6.1.0` support. The current TypeScript 7 release is not selected. Vite 8 and its React plugin's declared peer versions agree. The verified build runtime is Node 24.22.0 with npm 11.19.1. Dependency installation reported zero known vulnerabilities on 2026-10-16; this does not certify future registry advisories or application security.

## Artwork and later dependencies

The landing page adds original AI-generated chess artwork, self-hosted Inter Tight and Instrument Serif fonts, and Font Awesome icons. Quartz source is MIT licensed, copyright (c) 2026 Arlan Marat; its [notice](design/QUARTZ-LICENSE.txt) is retained in distribution notices. The animated overlay uses Grim's Dither Kit by ripgrim, pinned at `1e7faee9aa252e499651e6736ed65f7a07d9a6bd`; its provenance is recorded in `src/components/grim-dither-kit/UPSTREAM.md`. The earlier, unused James Greenaway image-dithering core retains its MIT license at `src/components/dither-kit/LICENSE`. The project remains GPL-3.0-or-later, and these assets retain their individual terms. [Landing notes](design/landing.md) record sources and adaptations.

This build uses Chessground, chessops and system fonts. The owner authorized replacing cm-chessboard with Chessground on 2026-10-18, superseding the original board choice and GPL exclusion for this dependency. The project and combined browser application are distributed under GPL-3.0-or-later. Ship exact corresponding source from https://github.com/Kamkmgamer/kamkmchess for the deployed version and the generated dependency license notices. The disposable prototype's application code is not included; the extracted theme values are identified below.

The chessops **0.15.1**, chess.js **1.4.0** (legacy offline proof tools), and @lichess-org/chessground **10.4.2** dependencies are pinned. The match board, promotion panel, position editor and landing preview use the Kaneo pieces by Kadagaden, inspired by the Neo pieces of chess.com, under CC BY 4.0 ([Kaneo-CC-BY-4.0.txt](licenses/Kaneo-CC-BY-4.0.txt)). Each image in `src/ui/pieces/` records the source and license. The Wikimedia Commons standard pieces by Cburnett and Rfc1394 (CC BY-SA 3.0) remain only in the unreferenced `src/ui/pieces/standard.svg` sprite, extracted from cm-chessboard **8.15.3** with its original attribution. The generated THIRD_PARTY_NOTICES.txt repeats both attributions and licenses. The separately licensed NonCommercial Staunty sprite is not used.

The selectable T3 Code palette values in src/ui/t3-palettes.ts were extracted from packages/shared/src/themePalettes.ts at commit 9503155da67add4fbd7fbc51c99ec19a0c8c4a2c, SHA-256 82385050b8b691ff280efc0e93ea9dd8a4bbfd64a4c50cf8536b5c15d1e74479. The prototype bundle's original source hash was verified against the owner-attached KHA-12 bundle (1631a48a909168bbc63bbb84164e5da2c0912f8fcb1c3f78faea87a797103ddf). The T3 Code MIT notice is retained at [T3-Code-MIT.txt](licenses/T3-Code-MIT.txt) and included in generated distribution notices. Palette data and board colors are the only extracted presentation inputs; prototype application code is not included.

Exclude the optional NonCommercial piece set, research-only replay packages and the unsafe stock solver from production. Experiment lockfiles and bundles are not production dependencies or distribution assets. Artwork licensing remains separate from the code licenses. Complete `OPS-05` requires the final game distribution and asset review, not just this foundation inventory.

## Browser chess engines

The application includes `stockfish@19.0.1` under GPL-3.0. Its single-threaded Lite and full WebAssembly builds are served on demand from the application origin. Preserve their upstream headers and `Copying.txt`, included in the generated production notices. Source and build instructions: [Stockfish.js](https://github.com/nmrugg/stockfish.js), pinned npm release [19.0.1](https://www.npmjs.com/package/stockfish/v/19.0.1). Distributors must provide the exact corresponding source and build instructions required by GPL. Engine weights and runtime are included in these builds.
