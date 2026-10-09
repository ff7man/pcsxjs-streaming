"use strict";

var do_iter = true;

var Module = {
  /* Xbox Edge owns the long-press Start/Menu escape gesture. Do not let the
     Emscripten SDL keyboard bridge install document-wide event handlers there. */
  doNotCaptureKeyboard: (function () {
    var platformText = ((navigator.userAgentData && navigator.userAgentData.platform) || '') + ' ' +
      (navigator.platform || '') + ' ' + (navigator.userAgent || '');
    if (/xbox/i.test(platformText)) return true;
    var mobileLike = /Android|iPhone|iPad|iPod|Windows Phone/i.test(platformText);
    return Number(navigator.maxTouchPoints || 0) >= 4 && !mobileLike && !!navigator.getGamepads;
  }()),
  preRun: [],
  postRun: [],
  print: (function () {
    return function (text) {
      if (arguments.length > 1) text = Array.prototype.slice.call(arguments).join(' ');
      console.log(text);
    };
  })(),
  printErr: function (text) {
    if (arguments.length > 1) text = Array.prototype.slice.call(arguments).join(' ');
    console.error(text);
  },
  canvas: (function () {
    var canvas = document.getElementById('canvas');

    // As a default initial behavior, pop up an alert when webgl context is lost. To make your
    // application robust, you may want to override this behavior before shipping!
    // See http://www.khronos.org/registry/webgl/specs/latest/1.0/#5.15.2
    canvas.addEventListener("webglcontextlost", function (e) { alert('WebGL context lost. You will need to reload the page.'); e.preventDefault(); }, false);

    return canvas;
  })(),


  goFullscreen: function () {
    var canvas = Module['canvas'];
    if (xbox_browser) {
      var nativeFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
      if (nativeFullscreen) {
        var nativeExit = document.exitFullscreen || document.webkitExitFullscreen;
        if (nativeExit) nativeExit.call(document);
        return;
      }
      var nativeRequest = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
      if (nativeRequest) {
        try {
          var requestResult = nativeRequest.call(document.documentElement);
          if (requestResult && requestResult.then) {
            requestResult.then(update_fullscreen_viewport).catch(toggle_xbox_pseudo_fullscreen);
          } else {
            update_fullscreen_viewport();
          }
        } catch (error) {
          toggle_xbox_pseudo_fullscreen();
        }
      } else {
        toggle_xbox_pseudo_fullscreen();
      }
      return;
    }
    if (Browser.isFullscreen) return canvas.exitFullscreen();
    Browser.lockPointer = false;
    Browser.resizeCanvas = false;
    Browser.vrDevice = null;
    function fullscreenChange() {
      Browser.isFullscreen = false;
      var canvasContainer = canvas.parentNode;
      if ((document['fullscreenElement'] || document['mozFullScreenElement'] ||
        document['msFullscreenElement'] || document['webkitFullscreenElement'] ||
        document['webkitCurrentFullScreenElement']) === canvasContainer) {
        canvas.exitFullscreen = document['exitFullscreen'] ||
          document['cancelFullScreen'] ||
          document['mozCancelFullScreen'] ||
          document['msExitFullscreen'] ||
          document['webkitCancelFullScreen'] ||
          function () { };
        canvas.exitFullscreen = canvas.exitFullscreen.bind(document);
        if (Browser.lockPointer) canvas.requestPointerLock();
        Browser.isFullscreen = true;
        if (Browser.resizeCanvas) Browser.setFullscreenCanvasSize();
      } else {
        if (Browser.resizeCanvas) Browser.setWindowedCanvasSize();
      }
      if (Module['onFullScreen']) Module['onFullScreen'](Browser.isFullscreen);
      if (Module['onFullscreen']) Module['onFullscreen'](Browser.isFullscreen);
      Browser.updateCanvasDimensions(canvas);
    }

    if (!Browser.fullscreenHandlersInstalled) {
      Browser.fullscreenHandlersInstalled = true;
      document.addEventListener('fullscreenchange', fullscreenChange, false);
      document.addEventListener('mozfullscreenchange', fullscreenChange, false);
      document.addEventListener('webkitfullscreenchange', fullscreenChange, false);
      document.addEventListener('MSFullscreenChange', fullscreenChange, false);
    }

    // create a new parent to ensure the canvas has no siblings. this allows browsers to optimize full screen performance when its parent is the full screen root
    var canvasContainer = canvas.parentNode;
    /*document.createElement("div");
    canvas.parentNode.insertBefore(canvasContainer, canvas);
    canvasContainer.appendChild(canvas);*/

    // use parent of canvas as full screen root to allow aspect ratio correction (Firefox stretches the root to screen size)
    canvasContainer.requestFullscreen = canvasContainer['requestFullscreen'] ||
      canvasContainer['mozRequestFullScreen'] ||
      canvasContainer['msRequestFullscreen'] ||
      (canvasContainer['webkitRequestFullscreen'] ? function () { canvasContainer['webkitRequestFullscreen'](Element['ALLOW_KEYBOARD_INPUT']) } : null) ||
      (canvasContainer['webkitRequestFullScreen'] ? function () { canvasContainer['webkitRequestFullScreen'](Element['ALLOW_KEYBOARD_INPUT']) } : null);

    canvasContainer.requestFullscreen();
  },
  setStatus: function (text) {
    if (!Module.setStatus.last) Module.setStatus.last = { time: Date.now(), text: '' };
    if (text === Module.setStatus.text) return;
    var m = text.match(/([^(]+)\((\d+(\.\d+)?)\/(\d+)\)/);
    var now = Date.now();
    var status = document.getElementById('status');
    if (status) status.innerHTML = text;
    cout_print("setStatus: "+text);
  },
  totalDependencies: 0,
  monitorRunDependencies: function (left) {
    this.totalDependencies = Math.max(this.totalDependencies, left);
    Module.setStatus(left ? 'Preparing... (' + (this.totalDependencies - left) + '/' + this.totalDependencies + ')' : 'All downloads complete.');
  }
};

window.onerror = function (event) {
  // TODO: do not warn on ok events like simulating an infinite loop or exitStatus
  Module.setStatus('Exception thrown, '+String(event));
  Module.setStatus = function (text) {
    if (text) Module.printErr('[post-exception status] ' + text);
  };
};

var img_data32;
function my_SDL_LockSurface(surf) {
  var surfData = SDL.surfaces[surf];
  surfData.locked++;
  if (surfData.locked > 1) return 0;

  if (!surfData.buffer) {
    surfData.buffer = _malloc(surfData.width * surfData.height * 4);
    cout_print("malloc " + surfData.buffer + "\n");
    HEAP32[(((surf) + (20)) >> 2)] = surfData.buffer;
  }

  // Mark in C/C++-accessible SDL structure
  // SDL_Surface has the following fields: Uint32 flags, SDL_PixelFormat *format; int w, h; Uint16 pitch; void *pixels; ...
  // So we have fields all of the same size, and 5 of them before us.
  // TODO: Use macros like in library.js
  HEAP32[(((surf) + (20)) >> 2)] = surfData.buffer;
  if (!surfData.image) {
    surfData.image = surfData.ctx.getImageData(0, 0, surfData.width, surfData.height);
  }
  return 0;
}
function my_SDL_UnlockSurface(surf) {
  assert(!SDL.GL); // in GL mode we do not keep around 2D canvases and contexts

  var surfData = SDL.surfaces[surf];

  if (!surfData.locked || --surfData.locked > 0) {
    return;
  }
  var data = surfData.image.data;
  var src = surfData.buffer >> 2;
  // Copy pixel data to image
  if (!img_data32)
  { img_data32 = new Uint32Array(data.buffer); }
  img_data32.set(HEAP32.subarray(src, src + img_data32.length));

  surfData.ctx.putImageData(surfData.image, 0, 0);
  // Note that we save the image, so future writes are fast. But, memory is not yet released
}


var padStatus1;
var padStatus2;
var vram_ptr;
var cout_print = Module.print;
var pcsx_worker;
var SoundFeedStreamData;
var first_frame_logged = false;
var current_disc_url = '';
var state_ready = false;
var active_game_button = null;
var memory_card_timer;
var virtual_pad_mask = 0xffff;
var virtual_stick_pointer = null;
var browser_gamepad_indices = [null, null];
var browser_gamepad_active = false;
var keyboard_proxy_mask = 0xffff;
var xbox_browser = (function () {
  var platformText = ((navigator.userAgentData && navigator.userAgentData.platform) || '') + ' ' +
    (navigator.platform || '') + ' ' + (navigator.userAgent || '');
  if (/xbox/i.test(platformText)) return true;
  var mobileLike = /Android|iPhone|iPad|iPod|Windows Phone/i.test(platformText);
  return Number(navigator.maxTouchPoints || 0) >= 4 && !mobileLike && !!navigator.getGamepads;
}());
var bios_state = 'unknown';

var keyboard_proxy_bits = {
  Enter: 3, c: 0, ArrowUp: 4, ArrowRight: 5, ArrowDown: 6, ArrowLeft: 7,
  e: 8, t: 9, w: 10, r: 11, d: 12, x: 13, z: 14, s: 15
};
function update_keyboard_proxy(event, pressed) {
  var bit = keyboard_proxy_bits[event.key];
  if (bit === undefined) return;
  if (pressed) keyboard_proxy_mask &= ~(1 << bit);
  else keyboard_proxy_mask |= 1 << bit;
}
window.addEventListener('keydown', function (event) { update_keyboard_proxy(event, true); });
window.addEventListener('keyup', function (event) { update_keyboard_proxy(event, false); });

function toggle_xbox_pseudo_fullscreen() {
  document.documentElement.classList.toggle('xbox-pseudo-fullscreen');
  update_fullscreen_viewport();
}

function update_fullscreen_viewport() {
  var viewport = window.visualViewport;
  var width = viewport ? viewport.width : window.innerWidth;
  var height = viewport ? viewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--fullscreen-width', width + 'px');
  document.documentElement.style.setProperty('--fullscreen-height', height + 'px');
}

document.addEventListener('fullscreenchange', update_fullscreen_viewport);
window.addEventListener('resize', function () {
  if (document.fullscreenElement || document.documentElement.classList.contains('xbox-pseudo-fullscreen')) {
    update_fullscreen_viewport();
  }
});

function set_bios_status(state, message) {
  bios_state = state;
  var indicator = document.getElementById('bios-status');
  if (indicator) {
    indicator.dataset.state = state;
    indicator.textContent = 'BIOS: ' + message;
  }
}

function cloud_mixed_content_message() {
  return 'Blocked: an HTTPS page cannot load an HTTP server. Use an HTTPS server URL.';
}

function cloud_is_mixed_content() {
  if (window.location.protocol !== 'https:') return false;
  try { return new URL(pcsx_cloud_origin()).protocol === 'http:'; }
  catch (error) { return false; }
}

function cloud_error_message(error) {
  if (cloud_is_mixed_content()) return cloud_mixed_content_message();
  return error && error.message ? error.message : String(error);
}

function configure_touch_controls() {
  var platform = (navigator.userAgentData && navigator.userAgentData.platform) || '';
  var userAgent = navigator.userAgent || '';
  var xboxBrowser = xbox_browser;
  var mobileBrowser = /Android|iPhone|iPad|iPod|Windows Phone/i.test(userAgent);
  var actualTouch = Number(navigator.maxTouchPoints || 0) > 0 && mobileBrowser;
  document.body.classList.toggle('touch-device', actualTouch && !xboxBrowser);
}

configure_touch_controls();

function browser_gamepad_button(buttons, index) {
  return !!(buttons && buttons[index] && buttons[index].pressed);
}

function browser_gamepad_mask(pad) {
  if (!pad) return null;
  var lo = 0xffff;
  var hi = 0xffff;
  var axes = pad.axes || [];
  var pressed = function (index) { return browser_gamepad_button(pad.buttons, index); };
  var axis = function (index) { return Number(axes[index] || 0); };

  if (axis(0) < -0.4 || pressed(14)) lo &= ~0x80;
  if (axis(0) > 0.4 || pressed(15)) lo &= ~0x20;
  if (axis(1) < -0.4 || pressed(12)) lo &= ~0x10;
  if (axis(1) > 0.4 || pressed(13)) lo &= ~0x40;
  if (pressed(8)) lo &= ~0x01; // select / view
  if (pressed(9)) lo &= ~0x08; // start / menu

  if (pressed(3)) hi &= ~0x10; // triangle / Y
  if (pressed(1)) hi &= ~0x20; // circle / B
  if (pressed(0)) hi &= ~0x40; // cross / A
  if (pressed(2)) hi &= ~0x80; // square / X
  if (pressed(4)) hi &= ~0x04; // L1 / LB
  if (pressed(6)) hi &= ~0x01; // L2 / LT
  if (pressed(5)) hi &= ~0x08; // R1 / RB
  if (pressed(7)) hi &= ~0x02; // R2 / RT
  return { lo: lo, hi: hi };
}

function browser_gamepad_update() {
  if (!navigator.getGamepads) {
    document.body.classList.remove('gamepad-device');
    return null;
  }
  var pads = navigator.getGamepads() || [];
  var selected = null;
  for (var slot = 0; slot < browser_gamepad_indices.length; slot++) {
    var index = browser_gamepad_indices[slot];
    var existing = index === null ? null : pads[index];
    if (existing && existing.connected !== false) {
      if (!selected) selected = existing;
      continue;
    }
    browser_gamepad_indices[slot] = null;
  }
  for (var i = 0; i < pads.length && i < browser_gamepad_indices.length; i++) {
    if (pads[i] && pads[i].connected !== false && browser_gamepad_indices.indexOf(i) < 0) {
      var free = browser_gamepad_indices.indexOf(null);
      if (free >= 0) browser_gamepad_indices[free] = i;
      if (!selected) selected = pads[i];
    }
  }
  document.body.classList.toggle('gamepad-device', !!selected);
  return selected;
}

window.addEventListener('gamepadconnected', function (event) {
  var slot = browser_gamepad_indices.indexOf(null);
  if (slot >= 0) browser_gamepad_indices[slot] = event.gamepad.index;
  document.body.classList.add('gamepad-device');
});

window.addEventListener('gamepaddisconnected', function (event) {
  var slot = browser_gamepad_indices.indexOf(event.gamepad.index);
  if (slot >= 0) browser_gamepad_indices[slot] = null;
  if (!browser_gamepad_indices.some(function (index) { return index !== null; })) {
    document.body.classList.remove('gamepad-device');
  }
});

function bytes_to_base64(bytes) {
  var binary = '';
  var block = 0x8000;
  for (var offset = 0; offset < bytes.length; offset += block) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(offset + block, bytes.length)));
  }
  return btoa(binary);
}

function base64_to_bytes(value) {
  var binary = atob(value);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function save_memory_cards_locally(cards) {
  localStorage.setItem('pcsxjs-memory-card-1', bytes_to_base64(cards[0]));
  localStorage.setItem('pcsxjs-memory-card-2', bytes_to_base64(cards[1]));
}

function restore_memory_cards() {
  var cards = [1, 2].map(function (number) {
    var value = localStorage.getItem('pcsxjs-memory-card-' + number);
    return value ? base64_to_bytes(value).buffer : null;
  });
  if (cards[0] || cards[1]) pcsx_worker.postMessage({ cmd: 'import_memory_cards', cards: cards }, cards.filter(Boolean));
}

function request_memory_cards() {
  if (pcsx_worker) pcsx_worker.postMessage({ cmd: 'export_memory_cards', download: false });
}

function update_state_controls() {
  ['save-state', 'load-state', 'download-state'].forEach(function (id) {
    var button = document.getElementById(id);
    if (button) button.disabled = !state_ready;
  });
}

function download_bytes(bytes, name, type) {
  var link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([bytes], { type: type }));
  link.download = name;
  link.click();
  setTimeout(function () { URL.revokeObjectURL(link.href); }, 0);
}

function var_setup() {
  SoundFeedStreamData = Module.cwrap("SoundFeedStreamData", "null", ["number", "number"]);
  vram_ptr = _get_ptr(0);
  padStatus1 = _get_ptr(1);
  padStatus2 = _get_ptr(2);  
  SDL.defaults.copyOnLock = false;
  SDL.defaults.opaqueFrontBuffer = false;
  cout_print("start worker")
  // Bump this when worker logic changes so browsers do not reuse an older
  // cached bundle while testing streaming or local-disc fixes.
  pcsx_worker = new Worker("pcsx_worker.js?v=20261009-cdda-fix-1");
  pcsx_worker.onmessage = pcsx_worker_onmessage;
  document.getElementById('iso_opener').disabled=false;
  var spinner = document.getElementById('spinner');
  if (spinner && spinner.parentElement) spinner.parentElement.removeChild(spinner);
  setTimeout("Module.setStatus('open an iso file using the above button.')", 2);
  restore_memory_cards();
  restore_bios();
  memory_card_timer = setInterval(request_memory_cards, 2000);
  update_state_controls();
}

function resume_browser_audio() {
  if (typeof SDL === 'undefined' || !SDL.audioContext || SDL.audioContext.state !== 'suspended') return;
  var context = SDL.audioContext;
  try {
    var buffer = context.createBuffer(1, 1, context.sampleRate);
    var source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(0);
  } catch (error) {
    cout_print('[audio] warm-up failed: ' + error.message);
  }
  var resume = context.resume();
  if (resume && resume.catch) resume.catch(function (error) {
    cout_print('[audio] resume failed: ' + error.message);
  });
}

['pointerdown', 'touchstart', 'click'].forEach(function (type) {
  document.addEventListener(type, resume_browser_audio, true);
});

function send_bios(bytes, source, name) {
  if (!bytes || bytes.length !== 512 * 1024) {
    set_bios_status('error', 'invalid file; BIOS must be exactly 512 KiB');
    Module.setStatus('BIOS must be exactly 512 KiB');
    return false;
  }
  var buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  set_bios_status('loading', 'valid 512 KiB image received; saving…');
  pcsx_worker.postMessage({ cmd: 'loadbios', bios: buffer, source: source || 'browser', name: name || 'bios.bin' }, [buffer]);
  return true;
}

function restore_bios() {
  var encoded = localStorage.getItem('pcsxjs-bios');
  if (encoded) send_bios(base64_to_bytes(encoded), 'saved browser BIOS', localStorage.getItem('pcsxjs-bios-name') || 'saved BIOS');
  else set_bios_status('none', 'not loaded; upload or choose a server BIOS');
}

function pcsx_upload_bios(input) {
  var file = input.files && input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function () {
    var bios = new Uint8Array(reader.result);
    if (send_bios(bios, 'uploaded BIOS', file.name)) {
      localStorage.setItem('pcsxjs-bios', bytes_to_base64(bios));
      localStorage.setItem('pcsxjs-bios-name', file.name);
    }
    input.value = '';
  };
  reader.readAsArrayBuffer(file);
}

if (window.File && window.FileReader && window.FileList && window.Blob) {
} else {
  alert('The File APIs are not fully supported in this browser.')
  cout_print('The File APIs are not fully supported in this browser.');
}
/* // for future wakelock api
navigator.wakeLock.request("display")
  .then(() => cout_print("Display wakeLock OK\n"))
  .catch(() => cout_print("Display wakeLock failed\n"));
  
navigator.wakeLock.request("system")
  .then(() => cout_print("System wakeLock OK\n"))
  .catch(() => cout_print("System wakeLock failed\n"));
*/
var states_arrs = [];
var check_controller = function () {
  // The worker publishes padStatus1 after the BIOS/core has initialized.
  // Remote streaming can take a moment, so do not dereference the pointer
  // while the worker is still starting or after a failed load.
  if (!padStatus1 || typeof HEAPU8 === 'undefined') {
    setTimeout("check_controller()", 10);
    return;
  }
  _CheckJoy();
  _CheckKeyboard();
  var browserPad = browser_gamepad_update();
  var states_src = HEAPU8.subarray(padStatus1, padStatus1 + 48);
  var states_arr;
  while (states_arrs.length > 50) {
    states_arrs.pop();
  }
  if (states_arrs.length > 0) {
    states_arr = states_arrs.pop();
    states_arr.set(states_src);
  }
  else {
    states_arr = new Uint8Array(states_src);
  }
  /* PADSTATE starts with the SDL joystick pointer, then PadMode/PadID.
   * KeyStatus is at bytes 6-7 and JoyKeyStatus at bytes 8-9.
   * Keep keyboard/touch input independent from browser focus, and replace
   * the browser gamepad state every tick so disconnects cannot latch a bit. */
  var keyboardMask = Module.doNotCaptureKeyboard ? keyboard_proxy_mask : (states_arr[6] | (states_arr[7] << 8));
  states_arr[6] = keyboardMask & 0xff;
  states_arr[7] = (keyboardMask >>> 8) & 0xff;
  apply_virtual_pad(states_arr);
  var gamepadMask = browser_gamepad_mask(browserPad);
  browser_gamepad_active = !!gamepadMask;
  states_arr[8] = gamepadMask ? gamepadMask.lo : 0xff;
  states_arr[9] = gamepadMask ? gamepadMask.hi : 0xff;
  //if(stat!=65535)  cout_print(stat);
  pcsx_worker.postMessage({ cmd: "padStatus", states: states_arr }, [states_arr.buffer]);
  setTimeout("check_controller()", 10);
}

function set_virtual_button(bit, pressed) {
  if (pressed) virtual_pad_mask &= ~(1 << bit);
  else virtual_pad_mask |= (1 << bit);
}

function apply_virtual_pad(states) {
  /* PADSTATE.KeyStatus is the active-low 16-bit field at offset 6. */
  var keyboardMask = states[6] | (states[7] << 8);
  var combined = keyboardMask & virtual_pad_mask;
  states[6] = combined & 0xff;
  states[7] = (combined >>> 8) & 0xff;
}

function install_virtual_controls() {
  document.querySelectorAll('[data-virtual-bit]').forEach(function (button) {
    var bit = Number(button.dataset.virtualBit);
    var press = function (event) { event.preventDefault(); button.setPointerCapture(event.pointerId); set_virtual_button(bit, true); button.classList.add('is-pressed'); };
    var release = function (event) { event.preventDefault(); set_virtual_button(bit, false); button.classList.remove('is-pressed'); };
    button.addEventListener('pointerdown', press);
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', release);
  });
  var stick = document.querySelector('[data-virtual-stick]');
  var knob = stick && stick.querySelector('.touch-stick-knob');
  if (!stick) return;
  var releaseStick = function (event) {
    if (virtual_stick_pointer !== null && (!event || event.pointerId === virtual_stick_pointer)) {
      if (event) event.preventDefault();
      [4, 5, 6, 7].forEach(function (bit) { set_virtual_button(bit, false); });
      if (knob) knob.style.transform = '';
      virtual_stick_pointer = null;
    }
  };
  stick.addEventListener('pointerdown', function (event) { event.preventDefault(); virtual_stick_pointer = event.pointerId; stick.setPointerCapture(event.pointerId); moveStick(event); });
  stick.addEventListener('pointermove', moveStick);
  stick.addEventListener('pointerup', releaseStick);
  stick.addEventListener('pointercancel', releaseStick);
  function moveStick(event) {
    if (virtual_stick_pointer !== event.pointerId) return;
    var rect = stick.getBoundingClientRect();
    var x = event.clientX - (rect.left + rect.width / 2);
    var y = event.clientY - (rect.top + rect.height / 2);
    var radius = rect.width / 2;
    var distance = Math.min(Math.hypot(x, y), radius);
    var angle = Math.atan2(y, x);
    if (knob) knob.style.transform = 'translate(' + (Math.cos(angle) * distance) + 'px,' + (Math.sin(angle) * distance) + 'px)';
    [4, 5, 6, 7].forEach(function (bit) { set_virtual_button(bit, false); });
    if (Math.abs(x) > radius * .25) set_virtual_button(x < 0 ? 7 : 5, true);
    if (Math.abs(y) > radius * .25) set_virtual_button(y < 0 ? 4 : 6, true);
  }
}

document.addEventListener('DOMContentLoaded', install_virtual_controls);

var file_list;
var pcsx_readfile = function (controller) {
  document.getElementById('iso_opener').disabled=true;  
  cout_print("pcsx_readfile\n");
  file_list = Array.prototype.slice.call(controller.files || []);
  if (!file_list.length) return;
  _InitBrowserAudio();
  resume_browser_audio();
  _InitBrowserVideo();
  pcsx_worker.postMessage({ cmd: "loadfiles", files: file_list });
  setTimeout("check_controller()", 10);
  return;
}

var pcsx_loadurl = function (requestedURL) {
  var url = requestedURL && requestedURL.trim();
  if (!url) return;
  current_disc_url = url;
  state_ready = false;
  update_state_controls();
  document.getElementById('iso_opener').disabled = true;
  cout_print('pcsx_loadurl ' + url);
  _InitBrowserAudio();
  resume_browser_audio();
  _InitBrowserVideo();
  pcsx_worker.postMessage({ cmd: "loadurl", iso: url });
  setTimeout("check_controller()", 10);
};

function pcsx_worker_onmessage(event) {
  var data = event.data
  // cout_print("onmessage: "+data.cmd)
  switch (data.cmd) {
    case "print":
      cout_print("> " + data.txt);
      break
    case "setStatus":
      cout_print("cmd setStatus")
      Module.setStatus(data.txt);
      if (data.txt === 'running streamed disc' || data.txt === 'Running!') {
        state_ready = true;
        update_state_controls();
        if (active_game_button) {
          var loadedButton = active_game_button.button;
          var loadedName = active_game_button.name;
          loadedButton.disabled = false;
          loadedButton.textContent = 'Loaded';
          setTimeout(function () { loadedButton.textContent = loadedName; }, 1200);
          active_game_button = null;
        }
      } else if (data.txt.indexOf('stream error:') === 0 && active_game_button) {
        active_game_button.button.disabled = false;
        active_game_button.button.textContent = active_game_button.name;
        active_game_button = null;
      }
      break
    case "bios_ready":
      set_bios_status('ready', (data.name || 'BIOS') + ' loaded and ready; used on the next game start');
      break
    case "setUI":
      var el = document.getElementById(data.key);
      if (!el) break;
      for (var k in data.properties) {
          el[k] = data.properties[k];
        }
      break
    case "render":
      var vram_arr = data.vram;
      if (!first_frame_logged) {
        first_frame_logged = true;
        cout_print('[GPU] first frame ' + data.dx + 'x' + data.dy);
      }
      HEAPU8.set(vram_arr, vram_ptr);
      pcsx_worker.postMessage({ cmd: "return_vram", vram: vram_arr }, [vram_arr.buffer]);
      _render(data.x, data.y, data.sx, data.sy, data.dx, data.dy, data.rgb24);
      break
    case "return_states":
      states_arrs.push(data.states)
      break;
    case "memory_cards":
      save_memory_cards_locally(data.cards);
      if (data.download) download_bytes(data.cards[0], 'pcsxjs-memory-card-1.mcr', 'application/octet-stream');
      break;
    case "memory_cards":
      save_memory_cards_locally(data.cards);
      break;
    case "state_data":
      localStorage.setItem('pcsxjs-state', bytes_to_base64(data.state));
      localStorage.setItem('pcsxjs-state-disc', current_disc_url);
      if (data.download) download_bytes(data.state, 'pcsxjs-state.gz', 'application/gzip');
      break;
    case "SoundFeedStreamData":
      var pSound_arr = data.pSound;
      var pSound_ptr = Module._malloc(pSound_arr.length);
      HEAPU8.set(pSound_arr, pSound_ptr);
      SoundFeedStreamData(pSound_ptr, data.lBytes);
      Module._free(pSound_ptr);
      break
    default:
      cout_print("unknown worker cmd " + data.cmd)
  }
}

function pcsx_save_state_to_storage() {
  if (state_ready) pcsx_worker.postMessage({ cmd: 'save_state' });
}

function pcsx_load_state_from_storage() {
  var savedDisc = localStorage.getItem('pcsxjs-state-disc');
  var savedState = localStorage.getItem('pcsxjs-state');
  if (!state_ready) return;
  if (savedDisc && current_disc_url && savedDisc !== current_disc_url) {
    Module.setStatus('state belongs to a different disc');
    return;
  }
  if (savedState) {
    var state = base64_to_bytes(savedState);
    pcsx_worker.postMessage({ cmd: 'load_state', state: state.buffer }, [state.buffer]);
  }
}

function pcsx_download_state() {
  if (state_ready) pcsx_worker.postMessage({ cmd: 'save_state', download: true });
}

function pcsx_download_memory_card() {
  if (pcsx_worker) pcsx_worker.postMessage({ cmd: 'export_memory_cards', download: true });
}

function pcsx_upload_memory_card(input) {
  var file = input.files && input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function () {
    var card = new Uint8Array(reader.result);
    if (card.length !== 131072) {
      Module.setStatus('memory card must be 128 KiB');
      return;
    }
    localStorage.setItem('pcsxjs-memory-card-1', bytes_to_base64(card));
    restore_memory_cards();
    Module.setStatus('memory card uploaded');
  };
  reader.readAsArrayBuffer(file);
}

function pcsx_cloud_origin() {
  var configured = localStorage.getItem('pcsxjs-cloud-url');
  if (!configured) {
    var queryServer = new URLSearchParams(window.location.search).get('server');
    if (queryServer) configured = queryServer;
  }
  if (configured) {
    try {
      /* Accept either https://host:port or host:port for GitHub Pages links. */
      var value = configured.trim();
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = window.location.protocol + '//' + value;
      return new URL(value).origin;
    } catch (error) {
      cout_print('[cloud] invalid server URL: ' + configured);
    }
  }
  /* The combined Go server uses port 8000. This keeps phones that open the
   * static page through the older 8081 host pointed at the game catalog/API. */
  var origin = window.location.origin;
  if (window.location.hostname && window.location.port && window.location.port !== '8000') {
    origin = window.location.protocol + '//' + window.location.hostname + ':8000';
  }
  return origin;
}

function pcsx_cloud_url(path) {
  return pcsx_cloud_origin() + path;
}

function pcsx_cloud_server_save() {
  var input = document.getElementById('cloud-server-url');
  if (!input) return;
  var value = input.value.trim();
  if (!value) {
    localStorage.removeItem('pcsxjs-cloud-url');
  } else {
    try {
      var candidate = value;
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = window.location.protocol + '//' + candidate;
      var parsed = new URL(candidate);
      if (window.location.protocol === 'https:' && parsed.protocol === 'http:') {
        set_bios_status('blocked', cloud_mixed_content_message());
        Module.setStatus(cloud_mixed_content_message());
        if (document.getElementById('cloud-status')) document.getElementById('cloud-status').textContent = cloud_mixed_content_message();
        return;
      }
      localStorage.setItem('pcsxjs-cloud-url', value);
    } catch (error) {
      Module.setStatus('invalid cloud server URL');
      return;
    }
  }
  var list = document.getElementById('game-list');
  if (list) {
    list.replaceChildren();
    delete list.dataset.loaded;
  }
  pcsx_cloud_status();
  pcsx_load_game_catalog();
}

function pcsx_cloud_server_reset() {
  localStorage.removeItem('pcsxjs-cloud-url');
  var input = document.getElementById('cloud-server-url');
  if (input) input.value = '';
  var list = document.getElementById('game-list');
  if (list) {
    list.replaceChildren();
    delete list.dataset.loaded;
  }
  pcsx_cloud_status();
  pcsx_load_game_catalog();
}

function pcsx_cloud_status() {
  var status = document.getElementById('cloud-status');
  if (cloud_is_mixed_content()) {
    var blocked = cloud_mixed_content_message();
    if (status) status.textContent = blocked;
    set_bios_status('blocked', blocked);
    return;
  }
  fetch(pcsx_cloud_url('/api/status')).then(function (response) {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  }).then(function (result) {
    status.textContent = 'Cloud connected' + (result.bios ? ' · BIOS file available' : '') + (result.state ? ' · state available' : '') + (result.memorycard ? ' · memory card available' : '');
  }).catch(function (error) {
    var message = cloud_error_message(error);
    status.textContent = message;
    if (cloud_is_mixed_content()) set_bios_status('blocked', message);
    cout_print('[cloud] ' + message);
  });
}

function pcsx_parse_csv(text) {
  var rows = [];
  var row = [];
  var field = '';
  var quoted = false;
  for (var index = 0; index < text.length; index += 1) {
    var character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some(function (value) { return value.trim(); })) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (field || row.length) {
    row.push(field);
    if (row.some(function (value) { return value.trim(); })) rows.push(row);
  }
  if (!rows.length) return [];
  var headers = rows.shift().map(function (value) { return value.trim().toLowerCase(); });
  var nameIndex = headers.indexOf('name');
  var urlIndex = headers.indexOf('url');
  if (nameIndex < 0 || urlIndex < 0) throw new Error('games.csv must have name and url columns');
  return rows.map(function (values) {
    return { name: (values[nameIndex] || '').trim(), url: (values[urlIndex] || '').trim() };
  }).filter(function (game) { return game.name && game.url; });
}

function pcsx_load_game_catalog() {
  var list = document.getElementById('game-list');
  var status = document.getElementById('game-list-status');
  if (!list || list.dataset.loaded === 'true') return;
  status.textContent = 'Loading games...';
  fetch(pcsx_cloud_url('/games.csv'), { cache: 'no-store' })
    .then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.text();
    })
    .then(function (text) {
      var games = pcsx_parse_csv(text);
      list.replaceChildren();
      games.forEach(function (game) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'app-button';
        button.textContent = game.name;
        button.addEventListener('click', function () {
          pcsx_load_catalog_game(game.url, button);
        });
        var item = document.createElement('div');
        item.append(button);
        list.append(item);
      });
      list.dataset.loaded = 'true';
      status.textContent = games.length ? '' : 'No CUE games found';
      status.hidden = games.length > 0;
    })
    .catch(function (error) {
      status.hidden = false;
      var message = cloud_error_message(error);
      status.textContent = 'Unable to load games: ' + message;
      if (cloud_is_mixed_content()) set_bios_status('blocked', message);
      cout_print('[games] ' + message);
  });
}

/*
 * The current PCSX streaming backend accepts a raw BIN URL, while eNGE's
 * backend accepts a CUE URL and resolves all of its tracks. Resolve the first
 * FILE entry here so catalog entries can remain compatible with eNGE's
 * generated games.csv. A future multi-track backend can remove this adapter.
 */
function pcsx_load_catalog_game(path, button) {
  var cueURL = new URL(path, pcsx_cloud_url('/')).href;
  var originalText = button.textContent;
  active_game_button = { button: button, name: originalText };
  button.disabled = true;
  button.textContent = 'Loading...';
  Module.setStatus('loading game catalog entry');
  fetch(cueURL, { cache: 'no-store' })
    .then(function (response) {
      if (!response.ok) throw new Error('unable to fetch CUE: HTTP ' + response.status);
      return response.text();
    })
    .then(function (cueText) {
      var match = cueText.match(/^\s*FILE\s+(?:"([^"]+)"|(\S+))\s+/im);
      if (!match) throw new Error('CUE has no FILE entry');
      pcsx_loadurl(new URL(match[1] || match[2], cueURL).href);
      button.textContent = 'Loading game...';
      if (typeof closePcsxCloud === 'function') closePcsxCloud();
    })
    .catch(function (error) {
      active_game_button = null;
      button.disabled = false;
      button.textContent = originalText;
      Module.setStatus('game load failed: ' + error.message);
      cout_print('[games] ' + error.message);
    });
}

function pcsx_cloud_upload_state() {
  var encoded = localStorage.getItem('pcsxjs-state');
  if (!encoded) { Module.setStatus('no local save state available'); return; }
  fetch(pcsx_cloud_url('/api/state'), { method: 'PUT', body: base64_to_bytes(encoded) })
    .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); Module.setStatus('state uploaded to cloud'); })
    .catch(function (error) { Module.setStatus('cloud upload failed: ' + error.message); });
}

function pcsx_cloud_download_state() {
  fetch(pcsx_cloud_url('/api/state')).then(function (response) {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.arrayBuffer();
  }).then(function (buffer) {
    var state = new Uint8Array(buffer);
    localStorage.setItem('pcsxjs-state', bytes_to_base64(state));
    localStorage.setItem('pcsxjs-state-disc', current_disc_url);
    if (state_ready) pcsx_worker.postMessage({ cmd: 'load_state', state: state.buffer }, [state.buffer]);
    Module.setStatus('state downloaded from cloud');
  }).catch(function (error) { Module.setStatus('cloud download failed: ' + error.message); });
}

function pcsx_cloud_upload_memory_card() {
  var encoded = localStorage.getItem('pcsxjs-memory-card-1');
  if (!encoded) { Module.setStatus('no local memory card available'); return; }
  fetch(pcsx_cloud_url('/api/memorycard'), { method: 'PUT', body: base64_to_bytes(encoded) })
    .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); Module.setStatus('memory card uploaded to cloud'); })
    .catch(function (error) { Module.setStatus('cloud upload failed: ' + error.message); });
}

function pcsx_cloud_download_memory_card() {
  fetch(pcsx_cloud_url('/api/memorycard')).then(function (response) {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.arrayBuffer();
  }).then(function (buffer) {
    var card = new Uint8Array(buffer);
    if (card.length !== 131072) throw new Error('cloud memory card is not 128 KiB');
    localStorage.setItem('pcsxjs-memory-card-1', bytes_to_base64(card));
    restore_memory_cards();
    Module.setStatus('memory card downloaded from cloud');
  }).catch(function (error) { Module.setStatus('cloud download failed: ' + error.message); });
}

function pcsx_load_bios_catalog() {
  var list = document.getElementById('bios-list');
  var status = document.getElementById('bios-list-status');
  if (!list || !status) return;
  if (cloud_is_mixed_content()) {
    status.hidden = false;
    status.textContent = cloud_mixed_content_message();
    set_bios_status('blocked', cloud_mixed_content_message());
    return;
  }
  status.hidden = false;
  status.textContent = 'Loading BIOS files...';
  list.replaceChildren();
  fetch(pcsx_cloud_url('/api/bios'), { cache: 'no-store' }).then(function (response) {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  }).then(function (biosFiles) {
    biosFiles.forEach(function (entry) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'app-button';
      button.textContent = entry.name;
      button.addEventListener('click', function () {
        pcsx_cloud_download_bios(entry.name, button);
      });
      var item = document.createElement('div');
      item.append(button);
      list.append(item);
    });
    status.textContent = biosFiles.length ? '' : 'No 512 KiB BIOS files found';
    status.hidden = biosFiles.length > 0;
  }).catch(function (error) {
    var message = cloud_error_message(error);
    status.textContent = 'Unable to load BIOS files: ' + message;
    if (cloud_is_mixed_content()) set_bios_status('blocked', message);
    cout_print('[bios] ' + message);
  });
}

function pcsx_cloud_download_bios(name, button) {
  if (!name) return;
  if (cloud_is_mixed_content()) {
    set_bios_status('blocked', cloud_mixed_content_message());
    Module.setStatus(cloud_mixed_content_message());
    return;
  }
  set_bios_status('loading', 'downloading ' + name + '…');
  if (button) {
    button.disabled = true;
    button.textContent = 'Loading...';
  }
  fetch(pcsx_cloud_url('/api/bios/' + encodeURIComponent(name)), { cache: 'no-store' }).then(function (response) {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.arrayBuffer();
  }).then(function (buffer) {
    var bios = new Uint8Array(buffer);
    if (!send_bios(bios, 'cloud BIOS', name)) {
      throw new Error('cloud BIOS is not 512 KiB');
    }
    localStorage.setItem('pcsxjs-bios', bytes_to_base64(bios));
    localStorage.setItem('pcsxjs-bios-name', name);
  }).catch(function (error) {
    var message = cloud_error_message(error);
    set_bios_status(cloud_is_mixed_content() ? 'blocked' : 'error', 'cloud load failed: ' + message);
    Module.setStatus('cloud BIOS load failed: ' + message);
  }).then(function () {
    if (button) {
      button.disabled = false;
      button.textContent = name;
    }
  });
}
