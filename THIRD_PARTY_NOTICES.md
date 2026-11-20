# Third-party notices

## LoneWriter

Three features follow ideas from LoneWriter; their prompt texts, JSON formats and code in
Novelmaker are new:

- The continuity check (`shared/src/continuity.ts`) follows the rules of LoneWriter's
  "Oracle": the codex is the truth, no style critique, and a sparse entry is not an error.
- The codex proposals (`shared/src/codexProposals.ts`) follow LoneWriter's "MPC": the AI
  proposes entries for named things missing from the codex, and the author accepts or
  ignores each one.
- The possible-duplicates check (`shared/src/codex/duplicates.ts`) follows LoneWriter's
  duplicate detection: Jaro-Winkler similarity and grouping of related entries.

Source: https://github.com/sergio-snchez/LoneWriter

```
MIT License

Copyright (c) 2026 Sergio Sánchez

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
