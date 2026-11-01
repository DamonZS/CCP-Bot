# Third-party notices

This repository is a fork of **OpenBot** (MIT, `github.com/CopilotKit/OpenBot`); the upstream baseline
here is commit `5899bd4` ("baseline: OpenBot before zh-CN localization and CCP-Bot rebrand"). Copyright
in the upstream code belongs to CopilotKit and its contributors. The root `LICENSE` carries MIT for this
repository's own code.

## DS-Bot (Apache-2.0)

Parts of this repository are adapted from **DS-Bot** (`github.com/Fei2411/DS-Bot`), component `ds-bot`,
version 0.2.3, licensed **Apache-2.0**. A verbatim copy of that licence is kept at
`docs/third-party/ds-bot-LICENSE.txt`.

What was verified about the DS-Bot checkout on 2026-11-01 (read-only inspection):

- `ds-bot/package.json` declares `"license": "Apache-2.0"`, and `ds-bot/LICENSE` holds the full
  Apache-2.0 text.
- That checkout has **no root `NOTICE`** and **no per-file SPDX or copyright header** (no file matched
  `SPDX-License-Identifier`). There is therefore no upstream notice text to reproduce; this file records
  the origin facts rather than inventing one.
- Three of DS-Bot's shell files adapt DeepSeek Harness Desktop (MIT) and point at a `NOTICE` file that is
  absent from that checkout: `app/src/host.mjs:4`, `app/engine/cordis.patch.yml:7`, `app/README.md:157`.

### Rules for files ported from DS-Bot into this repository

1. A file copied **unchanged** keeps its contents as they are, and is listed in the table below with its
   source path.
2. A file copied **and modified** carries a prominent notice at its top, in the file's own comment
   syntax: `Adapted from DS-Bot <source path> (Apache-2.0, Fei2411/DS-Bot); modified for CCP-Bot.`
   Apache-2.0 §4(b) requires this for every changed file.
3. Ported files stay Apache-2.0. Being placed in this repository does not relicense them as MIT.
4. The root `LICENSE` (MIT) describes this repository's own code, not the ported files.

### Ported files

| Source (DS-Bot) | Destination (this repository) | Changed? |
|---|---|---|
| `ds-bot/client.js` (generated bundle, 1,146,111 bytes, sha256 `cef1e2808ef4767defd97d18641750f8f0523c34b5a42b65dc8f59fcbe996fed`) | `app/vendor/ds-bot/client.js` | No — byte for byte, so it keeps its own generated header and needs no adapted-from notice |