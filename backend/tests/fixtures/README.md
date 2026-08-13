# Test fixtures

`sample.doc` and `sample.xls` are real Office 97-2003 binaries, used by
`tests/oleCfb.test.js`. Parsing those formats is entirely a matter of byte
offsets into a compound-file container, so a hand-built mock would only test
the mock — these have to be genuine files written by a real producer.

They contain **neutral placeholder content only** (no real documents from
this repository), and are deliberately tiny: 11 KB and 6 KB.

## Regenerating them

They were produced with LibreOffice headless from flat-ODF sources. To
recreate them, save the two XML documents below and convert:

```bash
soffice --headless --convert-to doc --outdir . neutral.fodt
soffice --headless --convert-to xls --outdir . neutral.fods
```

Then rename `neutral.doc` → `sample.doc` and `neutral.xls` → `sample.xls`.

The content that the tests assert on:

- **`neutral.fodt`** — a heading (`Legacy Extraction Test Document`), a prose
  paragraph, a line of accented Latin text, a line of curly punctuation, a
  2×3 table whose cells are `AlphaCell`…`ZetaCell`, and a closing paragraph.
  The table is the point: it proves cell marks become whitespace rather than
  being dropped, which is what stops `AlphaCell` and `BetaCell` fusing into
  one nonsense token.
- **`neutral.fods`** — two sheets, `FirstSheet` and `SecondSheet`, with
  cells `HeaderAlpha`/`HeaderBeta`/`HeaderGamma`, `ValueDelta`, a numeric
  cell, and `SecondSheetContent`. This exercises the shared string table and
  sheet-name records.

## No `.ppt` fixture

PowerPoint records are built inline in the test instead. A real `.ppt` for
two slides of text is ~450 KB, almost all of it embedded font data — not
worth carrying in the repository when the record format can be constructed
in a few lines.
