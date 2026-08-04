# Development

Internal notes for developing the `@swifttui/web` and `@swifttui/build`
workspace. Consumers never need this file: apps install the published npm
packages and need neither Bun nor the Swift toolchain.

Use the commands below to develop these packages. An app needs only the
`npm install` command above. It does not need Bun or the Swift toolchain.

```bash
bun install
bun test
bun run build:packages   # compile both packages to dist/ (tsdown: ESM + .d.ts)
bun run build:web        # bundle the in-repo browser demo to dist-demo/
bun run ci               # frozen install + test + build:packages + build:web
```

`build:packages` creates the publishable artifacts in the compiled `dist/`
directories. Each package uses `prepublishOnly` to run the build again before
`npm publish`. The `package.json` `exports` fields point to `dist/*`. Published
packages do not contain raw TypeScript source. Run `bun run pack:web` or
`bun run pack:build` to generate release tarballs. `bun pm pack` replaces the
internal `workspace:*` dependency with a concrete version. Thus, the published
`@swifttui/build` package depends on a published `@swifttui/web` version.

The host-wire corpus in `Fixtures/Transport/conformance-*` is a byte-identical
copy of the canonical `swift-tui` corpus. `bun test` makes sure that its
manifest and body hashes match. It rejects missing or extra bodies. It also
sends each active Canvas and DOM scenario through the real decoder and painter
paths. If a fixture names a different host, keep the copy complete. The
organization fixture gate makes sure that the repositories contain equal bytes.

Per-package development commands live in `packages/web/AGENTS.md` and
`packages/build/AGENTS.md`.
