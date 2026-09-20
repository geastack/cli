# @geastack/create-geastack

Project scaffolder for GeaStack apps. It is the `create-geastack` command
behind `npm create geastack`.

```sh
npm create geastack@latest my-app
cd my-app
npm install
gea build --target web
```

The scaffolder offers the bundled counter starter, a blank application, and the
GitHub-backed example gallery for web, embedded, GeaOS, iOS, macOS and Android
apps. Every generated project carries a `.gea/boards.json` so `gea` can find
its boards.

Useful flags:

```sh
npx create-geastack my-panel --dir ./my-panel --dry-run
```

The package is a thin binary: it depends on `@geastack/cli` and calls its
`create` entry point, so the same command is also available as `gea create`.
See the `@geastack/cli` README for the full command reference.

## License

Apache-2.0. See `LICENSE`.
