# Hub server

Package B owns this workspace. The canonical native observer moves from
`terminal/observer/` to `server/observer/` with its Cargo lockfile in B.
Until that move the Terminal build and tests continue to use the original path.
Package A's synthetic HTTP implementation lives in `packages/client/fixtures/`.
