# Third-Party Notices

> Open-source citation practice: this plugin **inlines the following
> third-party components at source level** into the single-file
> `dist/index.js` bundle and distributes them together with it. Each
> component is registered here with version, copyright and license, and
> the full license texts are appended below.
>
> The component list was verified in full on 2026-08-30 (cross-check of
> `frontend/package.json` dependencies × bundle inline markers × frontend
> source import surface).

中文版：[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

## Component list

| Component | Version | License | Copyright | Purpose | Upstream |
|-----------|---------|---------|-----------|---------|----------|
| three.js | 0.185.1 | MIT | © 2010-2026 three.js authors | WebGL rendering (3D knowledge-graph scene / camera / lights / fog) | [mrdoob/three.js](https://github.com/mrdoob/three.js) |
| 3d-force-graph | 1.80.0 | MIT | © 2017 Vasco Asturiano | 3D force-directed layout + orbit interaction (zoom / drag / rotate) | [vasturiano/3d-force-graph](https://github.com/vasturiano/3d-force-graph) |
| three-spritetext | 1.10.0 | MIT | © 2018 Vasco Asturiano | 3D node text labels (SpriteText) | [vasturiano/three-spritetext](https://github.com/vasturiano/three-spritetext) |
| fflate | 0.8.3 | MIT | © 2026 Arjun Barrett | xlsx file preview (zlib inflate, replacing a 400KB-class SheetJS dependency) | [nodeca/fflate](https://github.com/nodeca/fflate) |
| lucide (icon path data) | 2026-08 snapshot | ISC | © lucide contributors | Four-level tool-execution-security icons (Ban / AlertTriangle / Shield / CircleCheck; SVG path data inlined, zero runtime dependency) | [lucide-icons/lucide](https://github.com/lucide-icons/lucide) |

**Version alignment**: three.js / 3d-force-graph / three-spritetext are
identical to the QwenPaw 2.2 official console's `console/package.json`
(the behavioral alignment baseline for the 3D knowledge graph; upstream is
[agentscope-ai/QwenPaw](https://github.com/agentscope-ai/QwenPaw)).

## Distribution form

- The code above is inlined as a **compiled artifact** (minified) inside
  `dist/index.js`, not as separately distributed files. The host's
  blob-URL loading environment does not support dynamic import, hence the
  static inlining.
- The 3D graph UI labels its engine provenance on the card
  ("Engine: 3d-force-graph (MIT) + three.js (MIT)").
- The 2D knowledge graph is a custom SVG force-directed implementation
  with no third-party dependency.
- For lucide, only the SVG path data is taken (equivalent to what the
  official lucide-react components render); its runtime is not included.
- Note: bundles up to 0.5.0-beta.8 had their third-party license header
  comments stripped by build-time minify — this file is authoritative for
  copyright and license. From 0.5.0-beta.9 onward the build keeps an
  attribution banner at the **top** of the bundle (listing all components
  + copyright + license); some upstream license headers are partially
  preserved by minify — this file remains authoritative.

## Full license texts

### MIT License

three.js / 3d-force-graph / three-spritetext / fflate are all MIT-licensed,
with the copyright holders listed in the table above. MIT license full
text (common to all four components):

```
The MIT License (MIT)

Copyright (c) <see copyright column above, per component>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### ISC License

The lucide icon path data is ISC-licensed, full text:

```
Copyright (c) lucide contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH ALL IMPLIED WARRANTIES INCLUDING MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```
