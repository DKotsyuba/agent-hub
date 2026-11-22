# Third-party material in the Linux terminal

Agent Hub's own code is covered by the repository's [MIT license](../LICENSE).
Third-party components retain their own licenses and notices. The standalone
build command produces the executable only; the license texts for the bundled
components are collected in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)
and are shipped with each release next to the executable.

The Linux executable embeds Bun 1.4.4, the OpenTUI 0.8.2 native library and the
Rust observer. A distribution bundle retains (all included in
`THIRD_PARTY_NOTICES.md`):

- Bun's exact [versioned license and third-party notices](https://github.com/oven-sh/bun/blob/bun-v1.4.4/LICENSE.md).
- The OpenTUI native package's `LICENSE*`, `AUTHORS*`, `PATENTS*` and
  `FFMPEG-SOURCE.md` files, plus notices from the other runtime npm packages
  in `package-lock.json`.
- Applicable notices from the locked Rust observer dependencies in
  `terminal/observer/Cargo.lock`.

The native OpenTUI package documents its static FFmpeg build, source URL,
source hash and rebuild configuration in `FFMPEG-SOURCE.md`. Bun's license
documents its WebKit/JavaScriptCore source and relinking information. The
current Hub checks include re-embedding an altered OpenTUI library; they do
not establish a complete modified-source rebuild or redistribution compliance
for Bun, WebKit or FFmpeg.

The separate [shadcn notice](SHADCN-LICENSE.md) applies to the desktop source
retained in this repository, not to the terminal-only artifact by implication.
