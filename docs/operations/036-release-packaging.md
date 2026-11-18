# 036. Release packaging

`alba release` runs the game's engine build tool directly. It packages and audits local files without creating a work order. Build on a host with the engine, its license where required, and the target's build support installed.

## Configure the project

```yaml
engine: unity  # unity, unreal, or godot
release:
  output: builds/release
  version: 1.2.0
  targets: [windows-x64]
  unity:
    # editor: tools/unity/Unity
    scripting_backend: il2cpp
    stripping: high
    # build_method: Demo.Build.Release
  unreal:
    # engine_root: tools/UnrealEngine
    configuration: Shipping
    encrypt_pak: true
    sign_pak: true
  godot:
    # executable: godot
    preset: {windows-x64: Windows Desktop}
    # encryption_key_env: DEMO_GODOT_KEY
  audit:
    fail_on: [mono-assemblies, unencrypted-pak, secrets, debug-symbols, il2cpp-backup]
    allow: []  # e.g. [{id: debug-symbols, reason: Internal symbol build}]
    extra_secret_patterns: []  # JavaScript regular expression sources
  # vesper: {app_id: demo.game}
```

`output` is relative to the project root and defaults to `builds/release`. `--version` overrides `release.version`, which defaults to `0.0.0`. Set `release.targets` or pass one or more `--target` flags. CLI targets replace the config list. Supported identifiers are `windows-x64`, `linux-x64`, `macos-arm64`, `macos-x64`, and `web-wasm32`. Unreal has no WebGL target. The selected engine uses its own settings block.

- **Unity.** Set `release.unity.editor` or use a Unity Hub installation. Alba looks for the version in `ProjectSettings/ProjectVersion.txt` first, then uses the newest discovered editor. `scripting_backend` defaults to `il2cpp` and also accepts `mono`. WebGL always uses IL2CPP. `stripping` defaults to `high` and also accepts `medium`, `low`, and `minimal`. Install the supplied Unity 6 editor script or set `build_method` to a project-owned static method. A custom method receives `-albaTarget`, `-albaOutput`, `-albaStripping`, and, outside WebGL, `-albaBackend`. The supplied script sets the target's player settings and builds all enabled scenes.
- **Unreal.** Set `release.unreal.engine_root` or use the newest discovered installation. Keep exactly one `.uproject` at the project root. `configuration` defaults to `Shipping` and also accepts `Development`. In **Project Settings > Crypto**, configure project keys and enable pak encryption and signing. Alba checks `Config/DefaultCrypto.ini` for the main encryption key with index, all asset, or ini encryption enabled, and for RSA signing settings with signing enabled. `encrypt_pak: false` and `sign_pak: false` waive the corresponding preflight requirements. The engine still applies its project Crypto settings. The audit checks the pak index and IoStore flags.
- **Godot.** Set `release.godot.executable` or make `godot` or `godot4` available on `PATH`. Set `preset` to an export preset name or a map of target to preset. The preset controls platform and architecture. For encryption, enable directory encryption in the preset, use export templates built with your key, and name a variable holding the 64-hex key in `encryption_key_env`. Alba maps it to `GODOT_SCRIPT_ENCRYPTION_KEY` in the Godot child. macOS exports use `.app` bundles so the contents can be audited in place. For bundles exported from Windows, restore executable permissions on a Unix host before distribution.

The release config accepts environment variable names for key references and rejects literal key fields. Set `audit.allow` with an ID and a reason to keep a finding visible as a warning. `audit.fail_on` replaces the default failure list. Use the project's config history to record the reason for engine setting changes that have no audit finding.

## Run and inspect a release

```sh
alba --project alba.yaml release init-unity
alba --project alba.yaml release plan --target windows-x64 --target linux-x64
alba release build --project alba.yaml --version 1.2.0
alba release build --project alba.yaml --target windows-x64 --dry-run
alba release audit builds/release/1.2.0/windows-x64/game --json
```

`init-unity` copies `AlbaReleaseBuild.cs` into `Assets/Editor/Alba/`. Run it again to confirm the current template or pass `--force` to replace an edited copy. `plan` and `build --dry-run` print a JSON array of executable paths, argument vectors, working and output paths, hardening settings, and notices without running tools or creating folders. Environment references appear as `<from $NAME>`.

Each target gets `<output>/<version>/<target>/game/` for the shipping files, with `build.log` and `release.json` beside it. The report records engine arguments, UTC timestamps, engine exit code, audit, and selected hardening. Alba keeps failed releases for inspection and refuses to reuse a target directory. Move the directory aside or use a new version for another attempt. The build command exits `1` if any target build or audit fails. An explicit `--skip-audit` prints a warning and records `audit.skipped` in the report.

Audit can run on any existing build directory without a project. Pass `--engine` to override detection or `--project` to use that project's audit policy. JSON output contains `engine` (or `null` for an unrecognized layout), `findings`, and `summary` counts of failure and warning IDs. Finding paths are relative to the audited directory. Audit exits `1` when it finds a failure.

## Audit findings

| ID | Default | Meaning |
| --- | --- | --- |
| `mono-assemblies` | Fail | Unity Mono runtime or game DLLs in `*_Data/Managed` without a matching IL2CPP layout. |
| `unencrypted-pak` | Fail | Unreal pak index or IoStore container encryption flag is clear. |
| `secrets` | Fail | Secret-bearing filename or matching string. Excerpts are masked. |
| `debug-symbols` | Fail | Debug symbols or Unreal `Manifest_DebugFiles_*.txt`. |
| `il2cpp-backup` | Fail | Unity IL2CPP backup or Burst debug information folder. |
| `unsigned-pak` | Warn | A pak lacks a matching `.sig` while signature checking is enabled. |
| `godot-unencrypted-pck` | Warn | A recognized PCK has directory encryption disabled. Add the ID to `fail_on` to require encryption. |
| `pak-unreadable` | Always warn | An Unreal pak or IoStore header is truncated, invalid, or unsupported. |
| `web-build` | Always warn | Unity WebGL assets and metadata can be extracted from the build data. |

The audit scans known text types and text-like files under 5 MB, plus printable stretches of binaries under 200 MB. It checks PEM headers, common API token shapes, `.env` files and key file extensions. Binaries use bounded chunks and overlap. Very long binary matches or encodings outside the scan can escape detection. The audit skips symlinks, examines archives without unpacking them, and checks for the presence of signatures.

### Archive layouts

- **Unreal pak v8–v11.** The little-endian `FPakInfo` trailer starts with a 16-byte key GUID and a one-byte encrypted-index flag. Magic `0x5A6F12E1` is at trailer offset 17, followed by the 32-bit version, 64-bit index offset, 64-bit index size, and 20-byte index hash. Alba checks 189- and 221-byte trailers for v8 (four or five 32-byte compression names), the 222-byte v9 trailer (one extra frozen-index byte), and 221-byte trailers for v10 and v11. It bounds-checks the index against the trailer. See [Epic's FPakInfo reference](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/PakFile/FPakInfo) and [CUE4Parse's format reader](https://github.com/FabianFG/CUE4Parse/blob/master/CUE4Parse/UE4/Pak/Objects/FPakInfo.cs).
- **Unreal IoStore.** Alba reads the `.utoc` header magic `-==--==--==--==-`, the little-endian header size at offset 20, and bit `0x02` of the container flags byte at offset 80. See the [IoStore header reader](https://github.com/FabianFG/CUE4Parse/blob/master/CUE4Parse/UE4/IO/Objects/FIoStoreTocHeader.cs).
- **Godot PCK.** The little-endian header starts with `GDPC` and a 32-bit format version. Format 1 has no directory encryption flag. Formats 2–4 carry flags at byte 20 after three 32-bit engine version fields. Bit 0 marks an encrypted directory. Embedded packs use an end trailer with the 64-bit PCK size and `GDPC`, and the same header at `file size - 12 - PCK size`. See the [Godot PCK loader](https://github.com/godotengine/godot/blob/4.5-stable/core/io/file_access_pack.cpp).

## Protection limits

IL2CPP raises the cost of recovering managed code. Tools can still read `global-metadata.dat` unless it is obfuscated. High stripping removes more unused code and can require preserve rules for reflection. Pak index encryption protects archive listings, and payload encryption protects selected files. Pak signing helps the engine detect tampering. Unreal and Godot clients need access to their decryption keys, which can be recovered from a shipped executable or at runtime. WebGL supplies its assets and metadata to the browser. A determined reverse engineer can inspect any build they can run. Keep credentials and trusted game logic server-side.

## Vesper hand-off

Set `release.vesper.app_id` to print a `vesper pack` command for a successful target. `--vesper-pack` runs that local pack step when `vesper` is on `PATH`. The input is the `game` payload directory, the output is `game-vesper`, and the release tag is `v<version>-<target>`. A requested pack step that fails or cannot start makes the build command exit `1`. Store publication is a separate operation.
