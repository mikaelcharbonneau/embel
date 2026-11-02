# Bundled brand fonts

The unmodified normal variable fonts in this folder are used to render brand
assets. Their original SIL Open Font License notices are included beside each
font. Generated brand packs provide font links and do not include font binaries.

Lora, Fraunces, Manrope and the Noto Sans families come from the official Google Fonts repository, pinned
to commit `6157dfaa640ca5738b4d1a7070fe389c3036d7fc`. Geist and Geist Mono come from
the installed, locked `geist@1.7.2` package. `provenance.json` records exact source
URLs, original package paths, file hashes, license hashes, variable axes and
character coverage inspected from these bytes.

The Noto additions cover Latin, Greek, Cyrillic, Japanese, Simplified and
Traditional Chinese, Korean, Arabic, Hebrew, Devanagari, Bengali, Gurmukhi,
Gujarati, Tamil, Telugu, Kannada, Malayalam, Sinhala, Thai, Lao, Myanmar, Khmer,
Armenian, Georgian and Ethiopic scripts. Each new `characterRanges` list records
only Unicode cmap entries mapped to a nonzero glyph; the font contract tests
compare it with the real font bytes. This is broad multilingual coverage, not a
claim that every language, character or script combination is supported.

Generation offers only families that cover the entire frozen brand name,
including any Latin text in the same name. Unsupported emoji, combining or
variation sequences with uncovered characters, control characters and names that cannot fit one
bundled family's coverage are rejected before generation. Ordinary Arabic,
Persian and Indic joiners are retained where supported. Rare Han characters and
unbundled scripts may remain unsupported. CJK families retain their distinct
regional glyph forms; the selected family is used exactly, without silently
substituting another regional face.

Only families actually used by the selected artwork are fetched. Each fetch is
bounded to its recorded byte length (at most 20 MiB) and verified by SHA-256
before browser FontFace loading. The 23 Noto files total 61,466,284 bytes; the
largest, Noto Sans SC, is 17,772,300 bytes. They are unmodified upstream files,
not subsets. Browser Canvas supplies script shaping and bidirectional layout;
Arabic/Hebrew names use the natural first-letter direction in both PNG and SVG.
The layout and template labels remain in English.

PNG downloads use these verified bundled fonts. Editable SVGs retain the selected
family and Unicode text; install the linked fonts before opening or editing
them. Font binaries are not embedded in SVGs or included in the ZIP.

Public family Manrope is the variable family containing the font's original
`Manrope ExtraLight` default instance. Rendering sets the requested weight within
its actual 200–800 range. Lora supports 400–700. The other bundled families support
100–900. Only normal style is supported in generated brand assets.
