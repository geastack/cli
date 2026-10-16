# Native Linux board deployment

`linux-native` is a separate board adapter for `raspberry-pi-os`. It does not
reinterpret an existing `geaos-linux` alias. Registration is local only:

```
gea boards add <new-alias> --linux-config <absolute-reviewed-registration.json>
gea boards show <new-alias> --json
gea flash --board <new-alias> --app <app-id> --dry-run
```

Real-board deployment is not yet covered by tests.

## Registration authority

The JSON entry must declare `target` and `appPlatform` as `raspberry-pi-os`, and
`adapter` as `linux-native`. `transports.ssh` contains explicit `host`, `user`,
integer `port`, `hostKeyAlias`, absolute `knownHosts`, and absolute `identityFile`.
The public known-hosts file has exactly one ordinary key entry for that alias.
The local files must be owned regular files, not group/world writable; the
identity file must be private. Host identity comes from an independently trusted
key, never `ssh-keyscan` acceptance or a first-connection prompt.

`linuxDeployment` contains:

- `releaseRoot`: explicit canonical remote directory owned by the registered
  user, mode0700. It may be freshly created under a safe existing parent. No
  filesystem-root staging or symlink ancestors are admitted.
- `hookSource`: absolute local reviewed Python transaction implementation.
- `hookSha256`: exact hash of that source. Those bytes are streamed and stored
  in the transaction, so a newly preinstalled board hook is not required.
- `profile`: explicit product/board authority consumed by that implementation.
  `audioOff:true`, `quiet:true` and absolute `stateDirectory` are mandatory for
  this currently bounded deployment mode. This is a deployment admission, not a
  permanent restriction on user-enabled product audio. Service, display/session,
  storage helper, protected mount identities, backup/preimages, namespace and
  rollback expectations belong in the reviewed profile/handler, not CLI guesses.
  The schema requires a service unit name, `storage:{program,sha256}`, and
  `session:{uid,runtimeDirectory,type,display}` with actual x11/wayland authority.
  Their shape is validated locally; only the reviewed handler's real observations
  can establish that those identities and the session exist on the board.

An existing alias cannot be overwritten by registration. `boards set` validates
an entire native Linux entry before writing it. Files in the registration remain
local authority; do not publish private-key bytes in a project or receipt.

## Build and release authority

`gea flash` performs the actual native Linux SDK build. There is no `--no-build`
artifact shortcut. The executable comes from the SDK's existing
`dist/raspberry-pi-os/<app>/<app>` path; resources come only from the adjacent
`resources` directory. Output overrides are not supported by this deployment
route. The release manifest includes every regular resource, exact bytes, mode,
size and SHA; symlinks and special files are refused. Bounds are4096 files,
64MiB per file and128MiB total. Empty directories are not release artifacts.

Before opening SSH the ELF gate uses explicitly supplied absolute
`GEA_NATIVE_READELF` and `GEA_NATIVE_NM`: ELF64 little-endian AArch64 executable
with interpreter, actual SDL2 dependency/imports and defined SDK presentation
producers. WebKit/WebView/JavaScriptCore coexistence is refused. This structural
gate does not establish visual, input, audio or full application acceptance.

The SSH invocation ignores ambient config, proxy/jump, multiplexing, forwarding
and password/interactive authentication. It uses the registered identity only,
`StrictHostKeyChecking=yes`, explicit `HostKeyAlias`, explicit known-hosts file,
and no global known-hosts fallback. Every resume establishes the same pinned
identity again. `--host` override and `gea run`/monitor are refused.

## Streamed transaction protocol

The generic transport is `src/linux/transaction.py`, invoked through SSH with
JSON input. It never selects a systemd service, changes protection, opens a
picker, starts the app or reboots on its own. The reviewed streamed handler is
executed as Python in isolated mode with the selected phase argument and bounded
JSON context on stdin. It has only PATH/LANG environment. The registered profile
must provide all nine `phaseTimeoutSeconds` (prepare, quiesce, backup, activate,
verify, protect, observe, rollback, inspect), each an integer from1 through600,
and `transferTimeoutSeconds` from1 through300. The SSH outer budget is the sum
of those phase budgets, transfer budget and30 seconds. Products must choose
budgets covering their real stop, inventory and archive bounds; a product's own
handler may require longer explicit minima. Timeout kills and waits for the hook process
group; the local regression additionally verifies its authored child disappears. A handler which schedules an
intentional later reboot must return its pending receipt before the connection
is lost. There is no successful receipt inferred from SSH disconnect.

Context binds `protocol:1`, transaction UUID, release hash, app id, exact profile,
hook hash, current phase, staged release directory, complete manifest and previous
phase receipts. Each response must repeat protocol/transaction/release/phase and
supply actual observed `bootId`. The mandatory sequence is:

| Phase | Required response fields |
| --- | --- |
| prepare | `maintenance_required`, or `maintenance_ready` with `profileVerified:true` and `rollbackReady:true` |
| quiesce | `ok`, `processReaped:true`, `flushed:true` |
| backup | `ok`, `backupVerified:true`, exact `backupSha256` |
| activate | `ok`; the handler must preserve a durable rollback before changes |
| verify | `ok`, `releaseVerified:true`, `statePreserved:true`, `sessionVerified:true` |
| protect | `ok`, `rebootRequired:true`; this is pending, not installed acceptance |
| observe | `protected`, a different bootId, release/state/session verification true |
| inspect | `inspection`, `readOnly:true`; retained product state, no mutation |
| rollback | separate explicit recovery: `rolled_back`, `statePreserved:true`, `rollbackVerified:true` |

These fields are a handler contract, not independent proof from booleans. The
handler/profile must retain concrete externally reviewable hashes, process and
storage observations and actual backup/rollback receipts. A handler that merely
prints those fields is not a product installation profile.

Transport stores each phase's inflight marker before invoking the handler, then
fsyncs the state and parent directory. Interrupted/inflight or failed transactions
cannot automatically retry mutation. Their retained state requires explicit
recovery. It never silently deletes the old release, backup or failed candidate.
Release bytes and binding are checked again on resume. Canonical private
transaction directories, one release-root nonblocking flock and durable active
transaction ownership prevent competing UUIDs during pending or failed phases.
Product handlers must independently serialize their canonical service/state
authority, including aliases using different release roots.
Trust is the registered remote account; adversarial same-UID modification is not
claimed to be prevented.

Pending maintenance, candidate acceptance, exact transition review and protected
boot return status2 and retain a local
transaction receipt. Resume through the same CLI/board with
`gea flash --board <alias> --app <app-id> --transaction <uuid>` after the reviewed
maintenance/protect operation. The build and release must still match. `complete`
is returned only after the handler's subsequent protected-boot observation.

## Tests

Run `node --test test/linux-deploy.test.mjs` and the existing
`test/linux-target.test.mjs` separately. The former uses actual local Python
transport and isolated authored files, plus a pure ELF-inspection oracle; it never
opens SSH or executes systemd/storage programs. Every write-capable CLI test
requires an explicit boards config inside its own fixture before invocation.

## Inspection and explicit recovery

`gea flash --board <alias> --app <app-id> --transaction <uuid> --inspect-transaction`
uses the stored manifest, profile and pinned hook; it does not rebuild or require
replacement artifacts. Its local receipt includes the exact transport-state SHA
and product observation. It never treats inspection as successful installation.

`--rollback --authorization <absolute-json>` is a separate recovery invocation.
The exact bounded authorization bytes and SHA are preserved. The object binds
transaction, release, hook, `phase:"rollback"` and the inspected
`transportStateSHA256`; a product handler may additionally require the inspected
`productRecordSHA256` and any exact lifecycle state delta. Wrong or stale state
pins refuse before the recovery hook.

Errors and timeouts preserve the failed inflight phase and active ownership;
there is no automatic rollback or retry of uncertain work. Only verified terminal
rollback or protected completion releases ownership. Prepare/verify/observe may
pause for review without advancing mutation phases. A phase-specific authorization
is passed only to its exact phase, and byte/hash/JSON disagreement refuses before
invoking any hook.
