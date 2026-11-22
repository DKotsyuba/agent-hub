# Agent Hub terminal

`agent-hub [--live | --demo] [--server URL] [--pool ID] [PROJECT]`

Live mode is the default and connects to `/run/agent-hub-http/http.sock`.
Use `--server https://hub.<tailnet>.ts.net` for a remote Hub. An explicit
`http://127.0.0.1:PORT` origin is supported for the fixture server.

Run source settings now belong to Hub Server configuration. Migrate old
`--home`, `--socket`, `--broker-uid`, and `AGENT_RUN_HOME` settings there.
The project argument matches a source-reported stable project ID or path.
The terminal keeps synthetic data behind the explicit `--demo` option.
A live connection retries the configured Hub after disconnection.

The standalone Linux x64 build includes OpenTUI. Run `npm run build:binary
--workspace agent-hub-terminal` from the repository root.
