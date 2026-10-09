# PCSXjs-stream

PCSXjs-stream is a browser-based PlayStation emulator based on
[tjwei/pcsxjs](https://github.com/tjwei/pcsxjs). It adds range-streamed CD-ROM
loading, a responsive controller UI, cloud game catalogs, save-state tools, and
memory-card tools.

Live demo: [PCSXjs-stream on GitHub Pages](https://ff7man.github.io/pcsxjs-streaming/)

<img width="1377" height="803" alt="shot1" src="https://github.com/user-attachments/assets/a0109906-1c94-4c1b-b733-5e5a243e6e67" />
<img width="1302" height="651" alt="shot2" src="https://github.com/user-attachments/assets/024849f2-bd3d-4d1f-9db0-a8c4ff827a33" />

## Why this was made

Some browsers have a strict memory limit. In particular, Microsoft Edge on Xbox
can be limited to roughly 1 GB of memory for a page. Loading a complete BIN
image into JavaScript and WebAssembly can exceed that limit before a game even
starts.

PCSXjs-stream requests only the parts of the disc that the emulator needs. A
small JavaScript cache keeps recently used sectors available while old chunks
can be released. This makes larger games practical on Xbox and other
memory-constrained browsers, while keeping the original emulator architecture.

## Features

- Play PlayStation games in a browser using WebAssembly.
- Stream raw BIN disc images with HTTP range requests instead of downloading the
  entire image into browser memory.
- Load games from a CUE catalog hosted by the included server.
- Load local CUE/BIN files, including multi-file selections.
- Responsive 4:3 display with mobile virtual controls.
- Keyboard controls and browser Gamepad API support for Xbox and other
  compatible controllers.
- Local memory cards and save states.
- Download and upload memory cards and save states.
- Optional cloud storage for a memory card and save state.
- User-provided BIOS loading from a local upload or the configured cloud server.
- Configurable cloud/game server, including GitHub Pages deployments.

## Quick start

### Requirements

- A modern browser with WebAssembly support.
- Emscripten, if rebuilding the emulator.
- Go, if using the included server.

### Build the emulator

With Emscripten installed:

```sh
EM_CACHE=/tmp/pcsxjs-em-cache make
```

This generates `pcsx_worker.js` and `pcsx_ww.js`.

Note: this build does not yet use the [WebAssembly PS1 JIT](https://github.com/kblood/psx-wasm-jit-libretro)
from `kblood/psx-wasm-jit-libretro` for faster emulation, so the PS1 CPU runs
through the interpreter.

### Run the combined server

The included `server.go` serves the emulator frontend, game files, catalog, and
cloud save endpoints from one port:

```sh
go run server.go
```

The default address is:

```text
http://localhost:8000/pcsx_ww.html
```

The server defaults to a `games` directory. Create a symlink or pass a custom
directory:

```sh
go run server.go -games ./games
```

Useful options:

```sh
go run server.go -host 0.0.0.0 -port 8000 -games ./games -cloud ./cloud-data
```

To make BIOS files available from the cloud server, place the user's own 512 KiB
BIOS dumps in the configured games directory using the name `bios.bin` or a
case-insensitive `scph*.bin` name, such as `scph5501.bin`. With the default
layout from this repository, that is `../enge-js/games/` when running from
`pcsxjs-streaming`. The Cloud menu lists the discovered BIOS files. The Menu
also supports uploading a local BIOS; it is retained in the browser's local
storage and used for the next game start.

The server supports CORS, HTTP range requests, and logs each request. If
`games.csv` does not exist, it scans for CUE files and creates the catalog.

## Game files

For cloud loading, put each game in the configured games directory. A typical
layout is:

```text
games/
  Digimon World (USA)/
    Digimon World (USA).cue
    Digimon World (USA).bin
```

The CUE file is the catalog entry. Its referenced BIN files must be available
at the paths declared by the CUE file. Multi-track CUE files can reference
additional BIN or audio tracks.

Cloud games are streamed in small parts as needed. The entire disc does not
need to fit in browser memory, which is what enables larger games to run within
Microsoft Edge’s Xbox memory limit.

For local loading, choose the CUE file and all BIN files it references in the
file picker. Local CUE support depends on the referenced files being supplied
to the browser together.

## Using a separate server or GitHub Pages

The frontend can be hosted as a static GitHub Pages site while the Go server
hosts games and cloud data elsewhere. Open the Cloud menu and enter the backend
URL in the Server field, for example:

```text
https://games.example.com:8000
```

The setting is saved in local storage. A shareable URL can specify the server
without opening the menu first:

```text
https://your-user.github.io/your-repo/pcsx_ww.html?server=games.example.com:8000
```

An HTTPS GitHub Pages site requires the backend to be reachable over HTTPS;
browsers block HTTP requests from an HTTPS page as mixed content. The backend
must also provide CORS headers and return `206 Partial Content` for valid range
requests.

## Controls

Keyboard defaults:

- D-pad: Arrow Keys
- Select: C
- Start: Enter
- L1: W
- R1: R
- L2: E
- R2: T
- Triangle: D
- Circle: X
- Cross: Z
- Square: S

The included mobile controls provide a virtual analog-style directional pad and
PlayStation face, shoulder, Select, and Start buttons. Compatible Xbox and
Bluetooth controllers are handled through the browser Gamepad API.

## Save data

Memory cards and save states are stored locally in the browser. The Menu offers
download/upload actions, and the Cloud menu offers optional server upload and
download actions. The included server stores cloud data in the directory passed
with `-cloud`.

## Project layout

- `pcsx_ww.html` — emulator page and responsive UI.
- `pcsx.css` — desktop and mobile styling.
- `pcsx_ui.js` — browser controls, catalogs, cloud actions, and persistence.
- `worker_funcs.js` — streamed disc access and worker-side file handling.
- `server.go` — combined frontend, range-file, catalog, and cloud server.
- `libpcsxcore/cdriso.c` — CD image and CUE handling.
- `plugins/sdlinput/` — keyboard and browser controller input.

## License and upstream

This project is derived from PCSXjs and retains the upstream project’s license
and source headers. See the source tree and upstream repository for the original
license information.

- Upstream: <https://github.com/tjwei/pcsxjs>
