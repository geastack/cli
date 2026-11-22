# create-geastack

Project scaffolder for GeaStack apps. It is the `create-geastack` command
behind `npm create geastack`.

```sh
npm create geastack@latest my-app
cd my-app
npx gea setup
```

Run without options, it asks what you want to build: a blank application (for
the web browser, an ESP32 or RP2350 board, GeaOS, macOS, iOS, tvOS, Android or
Windows) or an application from the example gallery. The gallery lists the
bundled Component Counter first, then the GitHub examples for web, ESP32,
RP2350, GeaOS, iOS, macOS, Android and Windows. In an interactive terminal it
installs the npm dependencies; otherwise the closing line tells you to run
`npm install` first.

What comes next depends on what you created. The project's own `README.md`
lists its commands:

```sh
# Web app: development server with HMR, then a static build
npx gea dev
npx gea build --target web

# Board app (the Component Counter is ESP32-only): register the board, then flash it
npx gea setup
npx gea flash --board <alias> --monitor
```

`npx gea setup` registers the board and prints the exact `gea flash` line,
with `<alias>` being the name you give the board there.

Options:

```sh
--starter counter|blank|example   skip the first question
--example <example-id>            gallery entry to copy (with --starter example)
--no-install                      do not run npm install
```

Automation options:

```sh
--dir <path>                      directory to create (default: the app name)
--id <app-id>                     app id (default: derived from the name)
--name <display-name>             display name
--examples-repo <git-url-or-local-path>
--examples-ref <git-ref>
--targets web,esp32,rp2350,geaos,macos,ios,tvos,android,windows
--core-dependency <specifier>     version of @geastack/core to depend on
--cli-dependency <specifier>      version of @geastack/cli to depend on
--install                         run npm install even without a terminal
--dry-run                         print the example fetch and npm install instead of running them
--yes                             answer every question with its default
--force                           write into a non-empty directory
```

Without a terminal, or with `--yes`, the scaffolder creates the Component
Counter unless `--starter` says otherwise; `--starter example` then needs
`--example <id>`. For example:

```sh
npx create-geastack my-web-app --starter blank --targets web
npx create-geastack watch-demo --starter example --example watch
```

Every generated project carries a `.gea/boards.json`, so `gea setup` saves its
board aliases in the project.

The package is a thin binary: it depends on `@geastack/cli` and calls its
`create` entry point, so the same command is also available as `gea create`.
See the `@geastack/cli` README for the full command reference. It needs
Node.js 22 or later.

## License

Apache-2.0. See `LICENSE`.
