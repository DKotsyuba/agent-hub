# Agent Hub

This project belongs to the Agent MCP family. Repository technical prose and code comments are English. Product strings are localized Russian.

The owner approved the visual prototype on 2026-10-20 and authorized real read-only tool integration, a macOS Tauri 2 application build, and English/Russian interface localization. Preserve the accepted split view at desktop widths of 1024 px and above, full-screen details at narrower widths, and Back behavior. Fixture mode remains an explicit development/testing option, never a silent fallback for live data. The application must not launch agents/models, mutate pools/worktrees, change service configuration or perform management operations. Do not add placeholder management buttons. The only exception is the web Quota "Сбросить" action that redeems one banked reset credit through Agent Quota; the observer and terminal client stay read-only.

Use npm and the committed lockfile. Root alone provisions dependencies. Delegates must not install, fetch, upgrade packages or browsers, alter package manifests, start a dev server, or modify generated upstream src/components/ui files. Use the prepared node_modules. Root owns package.json, lockfile, Vite/TS configuration, test automation and dependency provenance.

Read document-code and the relevant frontend skills. Document first-party named declarations. Do not hand-edit vendored shadcn/ui source. Tests and screenshots are evidence, never live-service qualification. Preserve other contributors' changes.

All temporary files, caches, browser profiles, logs and screenshots must be under the designated task temporary directory (for example `~/projects/tmp/agent-hub`; docs write it `<tmp-root>/agent-hub`). Set TMPDIR, TMP and TEMP to that directory and npm_config_cache to its `npm-cache` subdirectory. Do not use /tmp.

Required prototype checks: npm run typecheck, npm run build, browser interaction in light/dark at 1440x900 and 1100x720, keyboard/focus, overflow and data states. No pushes, merges, application installation or live configuration changes are implicit. Root coordinates any scoped source checkpoint and reviewed activation; delegates do not stage or commit.
