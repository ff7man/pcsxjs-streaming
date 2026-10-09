var Module;
if (!Module) Module = {};
Module.setStatus = function (s) {
	postMessage({
		cmd: "print",
		txt: s
	});
};

function cout_print(s) {
	postMessage({
		cmd: "print",
		txt: s
	});
}

/* Keep the Emscripten error channel available to EM_JS code and fetch errors. */
Module.printErr = function (s) {
	postMessage({
		cmd: "print",
		txt: "[error] " + s
	});
};

function set_progress(k, r) {
	postMessage({
		cmd: "setUI",
		key: k + "_progress",
		properties: r
	});
}


function show_error(prefix) {
	return function (evt) {
		cout_print(prefix);
		cout_print(String(evt.target.error));
	}
}

Module['print'] = cout_print;
var vram_ptr, soundbuffer_ptr, isMute_ptr;
var vram_dels = 0,
	vram_cres = 0;
var vram_arrs = [];
var render = function (x, y, sx, sy, dx, dy, rgb24) {
	var vram_arr;
	var vram_src = HEAPU8.subarray(vram_ptr, vram_ptr + 1024 * 2048);
	while (vram_arrs.length > 10) {
		vram_arrs.pop();
		vram_dels++;
		//cout_print("delete vram "+vram_dels+"\n");
	}
	if (vram_arrs.length > 0) {
		vram_arr = vram_arrs.pop();
		vram_arr.set(vram_src);
	} else {
		vram_cres++;
		//cout_print("create vram "+vram_cres+"\n");
		vram_arr = new Uint8Array(vram_src);
	}
	postMessage({
		cmd: "render",
		x: x,
		y: y,
		sx: sx,
		sy: sy,
		dx: dx,
		dy: dy,
		rgb24: rgb24,
		vram: vram_arr
	}, [vram_arr.buffer]);
}
var pSound_arrs = [];
var SendSound = function (pSound_ptr, lBytes) {
	var pSound_arr;
	var pSound_src = HEAPU8.subarray(pSound_ptr, pSound_ptr + lBytes);
	while (pSound_arrs.length > 50) {
		pSound_arrs.pop();
	}
	if (pSound_arrs.length > 0) {
		pSound_arr = pSound_arrs.pop();
	} else {
		pSound_arr = new Uint8Array(4800);
	}

	pSound_arr.set(pSound_src);
	postMessage({
		cmd: "SoundFeedStreamData",
		pSound: pSound_arr,
		lBytes: lBytes
	}, [pSound_arr.buffer]);
}


function pcsx_mainloop() {
	_one_iter();

}
var pcsx_init = Module.cwrap("pcsx_init", "number", ["string", "string"])
var cdrIsoSetStreamURL = Module.cwrap("cdrIsoSetStreamURL", "number", ["string"])
var pcsxClose = Module.cwrap("pcsx_close", "number", [])
var ls = Module.cwrap("ls", "null", ["string"])
var padStatus1;
var isoDB;
var stdout_array;
var remote_running = false;
var emulator_started = false;
var load_serial = 0;
var MEMORY_CARD_SIZE = 1024 * 8 * 16;
var BIOS_SIZE = 512 * 1024;
var BIOS_PATH = '/bios.bin';
var STATE_PATH = '/home/web_user/.pcsx/pcsxjs-state.gz';

function stop_current_game() {
	load_serial++;
	Module.emuRunning = false;
	if (emulator_started) {
		try { pcsxClose(); } catch (error) { Module.printErr('[core] close failed: ' + error.message); }
		emulator_started = false;
		remote_running = false;
	}
}

function export_memory_cards(download) {
	var cards = [];
	for (var card = 1; card <= 2; card++) {
		var source = HEAPU8.subarray(_pcsx_get_mcd_ptr(card), _pcsx_get_mcd_ptr(card) + MEMORY_CARD_SIZE);
		cards.push(new Uint8Array(source));
	}
	postMessage({ cmd: "memory_cards", cards: cards, download: !!download }, cards.map(function (card) { return card.buffer; }));
}

function import_memory_cards(cards) {
	if (!cards) return;
	for (var card = 1; card <= 2; card++) {
		if (!cards[card - 1]) continue;
		var destination = _pcsx_get_mcd_ptr(card);
		HEAPU8.set(new Uint8Array(cards[card - 1]), destination);
	}
}

function export_state(download) {
	var result = _pcsx_save_state_default();
	if (result !== 0) throw new Error('save state failed (' + result + ')');
	var state = FS.readFile(STATE_PATH);
	postMessage({ cmd: "state_data", state: state, download: !!download }, [state.buffer]);
}

function import_state(state) {
	if (!state) throw new Error('save state data is missing');
	FS.writeFile(STATE_PATH, new Uint8Array(state));
	var result = _pcsx_load_state_default();
	if (result !== 0) throw new Error('load state failed (' + result + ')');
}

/*
 * Start the WASM core without placing the disc image in MEMFS. The C CD-ROM
 * backend requests aligned ranges from this URL as sectors are needed.
 */
var load_or_fetch = function (url) {
	stop_current_game();
	var serial = load_serial;
	Module.setStatus('starting streamed disc');
	cout_print('streaming ' + url);
	if (cdrIsoSetStreamURL(url) !== 0) {
		Module.setStatus('unable to configure streamed disc');
		return;
	}

	/*
	 * pcsx_init() performs synchronous boot-sector discovery before the
	 * emulated CD-ROM loop can retry a pending read. Fetch the first aligned
	 * range here so CheckCdrom()/LoadCdrom() see valid sector data during boot.
	 */
	var stream = Module.psxRangeStream;
	if (!stream.chunks) stream.chunks = new Map();
	var prefetchChunk = function (chunkIndex) {
		if (stream.chunks.has(chunkIndex)) return Promise.resolve();
		var start = chunkIndex * stream.chunkSize;
		var end = start + stream.chunkSize - 1;
		return fetch(url, { headers: { Range: 'bytes=' + start + '-' + end } })
			.then(function (response) {
				if (response.status !== 206) {
					throw new Error('stream request returned HTTP ' + response.status + '; byte ranges are required');
				}
				return response.arrayBuffer();
			})
		.then(function (buffer) {
			stream.chunks.set(chunkIndex, new Uint8Array(buffer));
			if (chunkIndex === 0 || chunkIndex === 1 || chunkIndex === 15) {
				cout_print('[CDR stream] prefetched chunk ' + chunkIndex + ' (' + buffer.byteLength + ' bytes)');
			}
		});
	};
	var readRawSector = function (lba) {
		var byteOffset = lba * 2352;
		var chunkIndex = Math.floor(byteOffset / stream.chunkSize);
		var chunk = stream.chunks.get(chunkIndex);
		if (!chunk) return null;
		var offset = byteOffset - chunkIndex * stream.chunkSize + 12;
		return chunk.subarray(offset, offset + 2340);
	};
	var readIsoSector = function (lba) {
		var raw = readRawSector(lba);
		return raw && raw.subarray(12, 2060);
	};
	var directoryEntries = function (data, size) {
		var entries = [];
		for (var offset = 0; offset < size;) {
			var length = data[offset];
			if (!length) {
				offset = (Math.floor(offset / 2048) + 1) * 2048;
				continue;
			}
			if (length < 34 || offset + length > size) {
				throw new Error('invalid ISO directory record at offset ' + offset);
			}
			var extent = data[offset + 2] |
				(data[offset + 3] << 8) |
				(data[offset + 4] << 16) |
				(data[offset + 5] << 24);
			var nameLength = data[offset + 32];
			var name = new TextDecoder().decode(data.subarray(offset + 33, offset + 33 + nameLength));
			entries.push({ name: name, extent: extent >>> 0 });
			offset += length;
		}
		return entries;
	};
	var locateBootChunk = function () {
		var pvd = readIsoSector(16);
		if (!pvd) throw new Error('ISO primary volume descriptor is unavailable');
		var root = 156;
		var rootExtent = pvd[root + 2] | (pvd[root + 3] << 8) |
			(pvd[root + 4] << 16) | (pvd[root + 5] << 24);
		var rootSize = pvd[root + 10] | (pvd[root + 11] << 8) |
			(pvd[root + 12] << 16) | (pvd[root + 13] << 24);
		var rootData = new Uint8Array(rootSize);
		for (var i = 0; i < Math.ceil(rootSize / 2048); i++) {
			var sector = readIsoSector(rootExtent + i);
			if (!sector) throw new Error('ISO root directory is unavailable');
			rootData.set(sector.subarray(0, Math.min(2048, rootSize - i * 2048)), i * 2048);
		}
		var entries = directoryEntries(rootData, rootSize);
		var system = entries.find(function (entry) { return entry.name.toUpperCase() === 'SYSTEM.CNF;1'; });
		if (!system) throw new Error('SYSTEM.CNF;1 was not found');
		return prefetchChunk(Math.floor((system.extent * 2352) / stream.chunkSize)).then(function () {
			var systemData = readIsoSector(system.extent);
			if (!systemData) throw new Error('SYSTEM.CNF;1 is unavailable');
			var systemText = new TextDecoder().decode(systemData);
			var bootMatch = systemText.match(/BOOT\s*=\s*cdrom:[\\\\\/]*([^\r\n]+)/i);
			if (!bootMatch) throw new Error('BOOT entry was not found in SYSTEM.CNF;1');
			var bootName = bootMatch[1].trim().toUpperCase();
			var boot = entries.find(function (entry) { return entry.name.toUpperCase() === bootName; });
			if (!boot) throw new Error(bootName + ' was not found in the root directory');
			return prefetchChunk(Math.floor((boot.extent * 2352) / stream.chunkSize)).then(function () {
				return Math.floor((boot.extent * 2352) / stream.chunkSize);
			});
		});
	};

	/* HLE boot reads the directory and executable synchronously. Prime the
	 * directory, locate the boot file, then fetch only its startup chunk. */
	Promise.resolve()
		.then(function () { return prefetchChunk(0); })
		.then(function () { return prefetchChunk(1); })
		.then(locateBootChunk)
		.then(function () {
			if (serial !== load_serial) throw new Error('stream load superseded');
			var result = pcsx_init('stream://remote', BIOS_PATH);
			if (result !== 0) {
				throw new Error('unable to initialize streamed disc');
			}
			padStatus1 = _get_ptr(-2);
			vram_ptr = _get_ptr(-1);
			soundbuffer_ptr = _get_ptr(7);
			isMute_ptr = _get_ptr(8);
			remote_running = true;
			emulator_started = true;
			Module.emuRunning = true;
			Module.setStatus('running streamed disc');
			pcsx_mainloop();
		})
		.catch(function (error) {
			if (serial !== load_serial) return;
			Module.printErr('[CDR stream] ' + error.message);
			Module.setStatus('stream error: ' + error.message);
		});
};

var readfile_and_run = function (iso_name, blob) {
	stop_current_game();
	var serial = load_serial;
	var run_arr = function (arr) {
		if (serial !== load_serial) return;
		FS.writeFile("/" + iso_name, arr);
		stdout_array = arr;
		Module.setStatus('Running!');
		pcsx_init("/" + iso_name, BIOS_PATH);
		emulator_started = true;
		Module.emuRunning = true;
		padStatus1 = _get_ptr(-2);
		vram_ptr = _get_ptr(-1);
		soundbuffer_ptr = _get_ptr(7);
		isMute_ptr = _get_ptr(8);
		cout_print("before mainloop\n");
		pcsx_mainloop();
	}
	cout_print("readfile and run ");
	var reader = new FileReader();
	Module.setStatus("reading file");
	reader.onprogress = function (e) {
		if (e.lengthComputable) {
			//cout_print(Math.round((e.loaded / e.total) * 100) + "%");
			set_progress('readfile', {
				value: e.loaded,
				max: e.total,
				hidden: false
			});
		} else
			cout_print(e.loaded + "bytes")
		//document.getElementById("start").disabled=false		
	}
	reader.onload = function (e) {
		cout_print("" + iso_name + " loaded");
		set_progress('readfile', {
			value: 1,
			max: 1,
			hidden: false
		});
		run_arr(new Uint8Array(this.result))
	}
	reader.readAsArrayBuffer(blob);
}

/* Mount every selected local disc file before initializing the CUE entry. */
var readfiles_and_run = function (files) {
	stop_current_game();
	var serial = load_serial;
	var cueFile = files.find(function (file) { return /\.cue$/i.test(file.name); });
	var entryFile = cueFile || files.find(function (file) { return /\.(bin|iso|img)$/i.test(file.name); }) || files[0];
	var index = 0;
	var readNext = function () {
		if (serial !== load_serial) return;
		if (index >= files.length) {
			stdout_array = null;
			Module.setStatus('Running!');
			pcsx_init('/' + entryFile.name, BIOS_PATH);
			emulator_started = true;
			Module.emuRunning = true;
			padStatus1 = _get_ptr(-2);
			vram_ptr = _get_ptr(-1);
			soundbuffer_ptr = _get_ptr(7);
			isMute_ptr = _get_ptr(8);
			cout_print('before mainloop\\n');
			pcsx_mainloop();
			return;
		}
		var file = files[index++];
		var reader = new FileReader();
		reader.onload = function () {
			FS.writeFile('/' + file.name, new Uint8Array(reader.result));
			readNext();
		};
		reader.onerror = function () { Module.printErr('unable to read ' + file.name); };
		reader.readAsArrayBuffer(file);
	};
	Module.setStatus('reading local disc files');
	readNext();
};

var event_history = [];
var clear_event_history = function () {
	self.onmessage = main_onmessage;
	for (var i in event_history) {
		main_onmessage(event_history[i]);
	}
	event_history = [];
	Module.setStatus = function (s) {
		postMessage({
			cmd: "setStatus",
			txt: s
		});
	};
	setTimeout("Module.setStatus('Open an iso file using the above button(worker ready!).')", 1);
}
var pre_onmessage = function (event) {
	if (event.data.cmd != 'soundBytes') {
		event_history.push(event);
		cout_print("push event" + event.data.cmd);
	}
}
self.onmessage = pre_onmessage;
var main_onmessage = function (event) {
	var data = event.data;
	switch (data.cmd) {

		case "padStatus":
			HEAPU8.set(data.states, padStatus1);
			postMessage({
				cmd: "return_states",
				states: data.states
			}, [data.states.buffer]);
			//Module.setValue(soundbuffer_ptr, data.soundbuffer, "i32");
			break;

		case "soundBytes":
			Module.setValue(soundbuffer_ptr, Module.getValue(soundbuffer_ptr, "i32") - data.lBytes, "i32");
			break;

		case "return_vram":
			vram_arrs.push(data.vram)
			break;

		case "return_pSound":
			pSound_arrs.push(data.pSound)
			break;

		case "export_memory_cards":
			export_memory_cards(data.download);
			break;

		case "import_memory_cards":
			import_memory_cards(data.cards);
			break;

		case "save_state":
			try { export_state(data.download); }
			catch (error) { Module.printErr('[state] ' + error.message); }
			break;

		case "load_state":
			try { import_state(data.state); }
			catch (error) { Module.printErr('[state] ' + error.message); }
			break;

		case "ls":
			ls(data.dir);
			break;
		case "loadfile":
			Module.setStatus('Downloading...');
			cout_print(data.file.name)
			readfile_and_run(data.file.name, data.file);
			break;
		case "loadbios":
			if (!data.bios || data.bios.byteLength !== BIOS_SIZE) {
				Module.setStatus('BIOS must be exactly 512 KiB');
				break;
			}
			FS.writeFile(BIOS_PATH, new Uint8Array(data.bios));
			Module.setStatus('BIOS loaded; start or reload a game to use it');
			break;
		case "loadfiles":
			cout_print('loading local disc files');
			readfiles_and_run(data.files);
			break;

		case "loadurl":
			cout_print("load..." + data.iso);

			load_or_fetch(data.iso)

			break;

		default:
			postMessage({
				cmd: "print",
				txt: "unknown command " + data.cmd
			})
	}
}
cout_print("worker started\n");
onerror = function (event) {
	// TODO: do not warn on ok events like simulating an infinite loop or exitStatus	
	Module.setStatus('Exception thrown, see JavaScript console ' + String(event));
};
