var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
(function() {
  "use strict";
  function assertExists(value, optMsg) {
    if (value === null || value === void 0) {
      throw new Error("Value is null or undefined");
    }
    return value;
  }
  function assertTrue(value, optMsg) {
    if (!value) {
      throw new Error("Failed assertion");
    }
  }
  function getDefaultExportFromCjs(x) {
    return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, "default") ? x["default"] : x;
  }
  var trace_processor_memory64 = { exports: {} };
  var hasRequiredTrace_processor_memory64;
  function requireTrace_processor_memory64() {
    if (hasRequiredTrace_processor_memory64) return trace_processor_memory64.exports;
    hasRequiredTrace_processor_memory64 = 1;
    (function(module, exports) {
      var trace_processor_memory64_wasm = /* @__PURE__ */ (() => {
        return (async function(moduleArg = {}) {
          var moduleRtn;
          var Module = moduleArg;
          var readyPromiseResolve, readyPromiseReject;
          var readyPromise = new Promise((resolve, reject) => {
            readyPromiseResolve = resolve;
            readyPromiseReject = reject;
          });
          var arguments_ = [];
          var thisProgram = "./this.program";
          var quit_ = (status, toThrow) => {
            throw toThrow;
          };
          var _scriptName;
          {
            _scriptName = self.location.href;
          }
          var scriptDirectory = "";
          function locateFile(path) {
            if (Module["locateFile"]) {
              return Module["locateFile"](path, scriptDirectory);
            }
            return scriptDirectory + path;
          }
          var readAsync, readBinary;
          {
            try {
              scriptDirectory = new URL(".", _scriptName).href;
            } catch {
            }
            if (!(typeof window == "object" || typeof WorkerGlobalScope != "undefined")) throw new Error("not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)");
            {
              {
                readBinary = (url) => {
                  var xhr = new XMLHttpRequest();
                  xhr.open("GET", url, false);
                  xhr.responseType = "arraybuffer";
                  xhr.send(null);
                  return new Uint8Array(
                    /** @type{!ArrayBuffer} */
                    xhr.response
                  );
                };
              }
              readAsync = async (url) => {
                assert(!isFileURI(url), "readAsync does not work with file:// URLs");
                var response = await fetch(url, {
                  credentials: "same-origin"
                });
                if (response.ok) {
                  return response.arrayBuffer();
                }
                throw new Error(response.status + " : " + response.url);
              };
            }
          }
          var out = console.log.bind(console);
          var err = console.error.bind(console);
          assert(true, "web environment detected but not enabled at build time.  Add `web` to `-sENVIRONMENT` to enable.");
          assert(true, "node environment detected but not enabled at build time.  Add `node` to `-sENVIRONMENT` to enable.");
          assert(true, "shell environment detected but not enabled at build time.  Add `shell` to `-sENVIRONMENT` to enable.");
          var wasmBinary;
          if (typeof WebAssembly != "object") {
            err("no native wasm support detected");
          }
          var wasmMemory;
          var ABORT = false;
          var EXITSTATUS;
          function assert(condition, text) {
            if (!condition) {
              abort("Assertion failed" + (text ? ": " + text : ""));
            }
          }
          var HEAP8, HEAPU8, HEAP16, HEAP32, HEAPU32, HEAP64, HEAPU64, HEAPF64;
          var runtimeInitialized = false;
          var isFileURI = (filename) => filename.startsWith("file://");
          function writeStackCookie() {
            var max = _emscripten_stack_get_end();
            assert((max & 3) == 0);
            if (max == 0) {
              max += 4;
            }
            HEAPU32[max / 4] = 34821223;
            HEAPU32[(max + 4) / 4] = 2310721022;
            HEAPU32[0 / 4] = 1668509029;
          }
          function checkStackCookie() {
            if (ABORT) return;
            var max = _emscripten_stack_get_end();
            if (max == 0) {
              max += 4;
            }
            var cookie1 = HEAPU32[max / 4];
            var cookie2 = HEAPU32[(max + 4) / 4];
            if (cookie1 != 34821223 || cookie2 != 2310721022) {
              abort(`Stack overflow! Stack cookie has been overwritten at ${ptrToString(max)}, expected hex dwords 0x89BACDFE and 0x2135467, but received ${ptrToString(cookie2)} ${ptrToString(cookie1)}`);
            }
            if (HEAPU32[0 / 4] != 1668509029) {
              abort("Runtime error: The application has corrupted its heap memory area (address zero)!");
            }
          }
          (() => {
            var h16 = new Int16Array(1);
            var h8 = new Int8Array(h16.buffer);
            h16[0] = 25459;
            if (h8[0] !== 115 || h8[1] !== 99) throw "Runtime error: expected the system to be little-endian! (Run with -sSUPPORT_BIG_ENDIAN to bypass)";
          })();
          function consumedModuleProp(prop) {
            if (!Object.getOwnPropertyDescriptor(Module, prop)) {
              Object.defineProperty(Module, prop, {
                configurable: true,
                set() {
                  abort(`Attempt to set \`Module.${prop}\` after it has already been processed.  This can happen, for example, when code is injected via '--post-js' rather than '--pre-js'`);
                }
              });
            }
          }
          function ignoredModuleProp(prop) {
            if (Object.getOwnPropertyDescriptor(Module, prop)) {
              abort(`\`Module.${prop}\` was supplied but \`${prop}\` not included in INCOMING_MODULE_JS_API`);
            }
          }
          function isExportedByForceFilesystem(name) {
            return name === "FS_createPath" || name === "FS_createDataFile" || name === "FS_createPreloadedFile" || name === "FS_unlink" || name === "addRunDependency" || // The old FS has some functionality that WasmFS lacks.
            name === "FS_createLazyFile" || name === "FS_createDevice" || name === "removeRunDependency";
          }
          function missingLibrarySymbol(sym) {
            unexportedRuntimeSymbol(sym);
          }
          function unexportedRuntimeSymbol(sym) {
            if (!Object.getOwnPropertyDescriptor(Module, sym)) {
              Object.defineProperty(Module, sym, {
                configurable: true,
                get() {
                  var msg = `'${sym}' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the Emscripten FAQ)`;
                  if (isExportedByForceFilesystem(sym)) {
                    msg += ". Alternatively, forcing filesystem support (-sFORCE_FILESYSTEM) can export this for you";
                  }
                  abort(msg);
                }
              });
            }
          }
          function updateMemoryViews() {
            var b = wasmMemory.buffer;
            HEAP8 = new Int8Array(b);
            HEAP16 = new Int16Array(b);
            Module["HEAPU8"] = HEAPU8 = new Uint8Array(b);
            HEAP32 = new Int32Array(b);
            HEAPU32 = new Uint32Array(b);
            HEAPF64 = new Float64Array(b);
            HEAP64 = new BigInt64Array(b);
            HEAPU64 = new BigUint64Array(b);
          }
          assert(typeof Int32Array != "undefined" && typeof Float64Array !== "undefined" && Int32Array.prototype.subarray != void 0 && Int32Array.prototype.set != void 0, "JS engine does not provide full typed array support");
          function preRun() {
            if (Module["preRun"]) {
              if (typeof Module["preRun"] == "function") Module["preRun"] = [Module["preRun"]];
              while (Module["preRun"].length) {
                addOnPreRun(Module["preRun"].shift());
              }
            }
            consumedModuleProp("preRun");
            callRuntimeCallbacks(onPreRuns);
          }
          function initRuntime() {
            assert(!runtimeInitialized);
            runtimeInitialized = true;
            checkStackCookie();
            wasmExports["__wasm_call_ctors"]();
          }
          function preMain() {
            checkStackCookie();
          }
          function postRun() {
            checkStackCookie();
            if (Module["postRun"]) {
              if (typeof Module["postRun"] == "function") Module["postRun"] = [Module["postRun"]];
              while (Module["postRun"].length) {
                addOnPostRun(Module["postRun"].shift());
              }
            }
            consumedModuleProp("postRun");
            callRuntimeCallbacks(onPostRuns);
          }
          var runDependencies = 0;
          var dependenciesFulfilled = null;
          var runDependencyTracking = {};
          var runDependencyWatcher = null;
          function addRunDependency(id) {
            var _a;
            runDependencies++;
            (_a = Module["monitorRunDependencies"]) == null ? void 0 : _a.call(Module, runDependencies);
            {
              assert(!runDependencyTracking[id]);
              runDependencyTracking[id] = 1;
              if (runDependencyWatcher === null && typeof setInterval != "undefined") {
                runDependencyWatcher = setInterval(() => {
                  if (ABORT) {
                    clearInterval(runDependencyWatcher);
                    runDependencyWatcher = null;
                    return;
                  }
                  var shown = false;
                  for (var dep in runDependencyTracking) {
                    if (!shown) {
                      shown = true;
                      err("still waiting on run dependencies:");
                    }
                    err(`dependency: ${dep}`);
                  }
                  if (shown) {
                    err("(end of list)");
                  }
                }, 1e4);
              }
            }
          }
          function removeRunDependency(id) {
            var _a;
            runDependencies--;
            (_a = Module["monitorRunDependencies"]) == null ? void 0 : _a.call(Module, runDependencies);
            {
              assert(runDependencyTracking[id]);
              delete runDependencyTracking[id];
            }
            if (runDependencies == 0) {
              if (runDependencyWatcher !== null) {
                clearInterval(runDependencyWatcher);
                runDependencyWatcher = null;
              }
              if (dependenciesFulfilled) {
                var callback = dependenciesFulfilled;
                dependenciesFulfilled = null;
                callback();
              }
            }
          }
          function abort(what) {
            var _a;
            (_a = Module["onAbort"]) == null ? void 0 : _a.call(Module, what);
            what = "Aborted(" + what + ")";
            err(what);
            ABORT = true;
            var e = new WebAssembly.RuntimeError(what);
            readyPromiseReject(e);
            throw e;
          }
          var FS = {
            error() {
              abort("Filesystem support (FS) was not included. The problem is that you are using files from JS, but files were not used from C/C++, so filesystem support was not auto-included. You can force-include filesystem support with -sFORCE_FILESYSTEM");
            },
            init() {
              FS.error();
            },
            createDataFile() {
              FS.error();
            },
            createPreloadedFile() {
              FS.error();
            },
            createLazyFile() {
              FS.error();
            },
            open() {
              FS.error();
            },
            mkdev() {
              FS.error();
            },
            registerDevice() {
              FS.error();
            },
            analyzePath() {
              FS.error();
            },
            ErrnoError() {
              FS.error();
            }
          };
          function createExportWrapper(name, nargs) {
            return (...args) => {
              assert(runtimeInitialized, `native function \`${name}\` called before runtime initialization`);
              var f = wasmExports[name];
              assert(f, `exported native function \`${name}\` not found`);
              assert(args.length <= nargs, `native function \`${name}\` called with ${args.length} args but expects ${nargs}`);
              return f(...args);
            };
          }
          var wasmBinaryFile;
          function findWasmBinary() {
            return locateFile("trace_processor_memory64.wasm");
          }
          function getBinarySync(file) {
            if (file == wasmBinaryFile && wasmBinary) {
              return new Uint8Array(wasmBinary);
            }
            if (readBinary) {
              return readBinary(file);
            }
            throw "both async and sync fetching of the wasm failed";
          }
          async function getWasmBinary(binaryFile) {
            if (!wasmBinary) {
              try {
                var response = await readAsync(binaryFile);
                return new Uint8Array(response);
              } catch {
              }
            }
            return getBinarySync(binaryFile);
          }
          async function instantiateArrayBuffer(binaryFile, imports) {
            try {
              var binary = await getWasmBinary(binaryFile);
              var instance = await WebAssembly.instantiate(binary, imports);
              return instance;
            } catch (reason) {
              err(`failed to asynchronously prepare wasm: ${reason}`);
              if (isFileURI(wasmBinaryFile)) {
                err(`warning: Loading from a file URI (${wasmBinaryFile}) is not supported in most browsers. See https://emscripten.org/docs/getting_started/FAQ.html#how-do-i-run-a-local-webserver-for-testing-why-does-my-program-stall-in-downloading-or-preparing`);
              }
              abort(reason);
            }
          }
          async function instantiateAsync(binary, binaryFile, imports) {
            if (!binary && typeof WebAssembly.instantiateStreaming == "function") {
              try {
                var response = fetch(binaryFile, {
                  credentials: "same-origin"
                });
                var instantiationResult = await WebAssembly.instantiateStreaming(response, imports);
                return instantiationResult;
              } catch (reason) {
                err(`wasm streaming compile failed: ${reason}`);
                err("falling back to ArrayBuffer instantiation");
              }
            }
            return instantiateArrayBuffer(binaryFile, imports);
          }
          function getWasmImports() {
            return {
              "env": wasmImports,
              "wasi_snapshot_preview1": wasmImports
            };
          }
          async function createWasm() {
            function receiveInstance(instance, module2) {
              wasmExports = instance.exports;
              wasmExports = applySignatureConversions(wasmExports);
              wasmMemory = wasmExports["memory"];
              assert(wasmMemory, "memory not found in wasm exports");
              updateMemoryViews();
              wasmTable = wasmExports["__indirect_function_table"];
              assert(wasmTable, "table not found in wasm exports");
              removeRunDependency("wasm-instantiate");
              return wasmExports;
            }
            addRunDependency("wasm-instantiate");
            var trueModule = Module;
            function receiveInstantiationResult(result2) {
              assert(Module === trueModule, "the Module object should not be replaced during async compilation - perhaps the order of HTML elements is wrong?");
              trueModule = null;
              return receiveInstance(result2["instance"]);
            }
            var info = getWasmImports();
            if (Module["instantiateWasm"]) {
              return new Promise((resolve, reject) => {
                try {
                  Module["instantiateWasm"](info, (mod, inst) => {
                    resolve(receiveInstance(mod, inst));
                  });
                } catch (e) {
                  err(`Module.instantiateWasm callback failed with error: ${e}`);
                  reject(e);
                }
              });
            }
            wasmBinaryFile ?? (wasmBinaryFile = findWasmBinary());
            try {
              var result = await instantiateAsync(wasmBinary, wasmBinaryFile, info);
              var exports2 = receiveInstantiationResult(result);
              return exports2;
            } catch (e) {
              readyPromiseReject(e);
              return Promise.reject(e);
            }
          }
          class ExitStatus {
            constructor(status) {
              __publicField(this, "name", "ExitStatus");
              this.message = `Program terminated with exit(${status})`;
              this.status = status;
            }
          }
          var callRuntimeCallbacks = (callbacks) => {
            while (callbacks.length > 0) {
              callbacks.shift()(Module);
            }
          };
          var onPostRuns = [];
          var addOnPostRun = (cb) => onPostRuns.push(cb);
          var onPreRuns = [];
          var addOnPreRun = (cb) => onPreRuns.push(cb);
          var noExitRuntime = true;
          var ptrToString = (ptr) => {
            assert(typeof ptr === "number");
            return "0x" + ptr.toString(16).padStart(8, "0");
          };
          var stackRestore = (val) => __emscripten_stack_restore(val);
          var stackSave = () => _emscripten_stack_get_current();
          var warnOnce = (text) => {
            warnOnce.shown || (warnOnce.shown = {});
            if (!warnOnce.shown[text]) {
              warnOnce.shown[text] = 1;
              err(text);
            }
          };
          var UTF8Decoder = typeof TextDecoder != "undefined" ? new TextDecoder() : void 0;
          var UTF8ArrayToString = (heapOrArray, idx = 0, maxBytesToRead = NaN) => {
            var endIdx = idx + maxBytesToRead;
            var endPtr = idx;
            while (heapOrArray[endPtr] && !(endPtr >= endIdx)) ++endPtr;
            if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) {
              return UTF8Decoder.decode(heapOrArray.subarray(idx, endPtr));
            }
            var str = "";
            while (idx < endPtr) {
              var u0 = heapOrArray[idx++];
              if (!(u0 & 128)) {
                str += String.fromCharCode(u0);
                continue;
              }
              var u1 = heapOrArray[idx++] & 63;
              if ((u0 & 224) == 192) {
                str += String.fromCharCode((u0 & 31) << 6 | u1);
                continue;
              }
              var u2 = heapOrArray[idx++] & 63;
              if ((u0 & 240) == 224) {
                u0 = (u0 & 15) << 12 | u1 << 6 | u2;
              } else {
                if ((u0 & 248) != 240) warnOnce("Invalid UTF-8 leading byte " + ptrToString(u0) + " encountered when deserializing a UTF-8 string in wasm memory to a JS string!");
                u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | heapOrArray[idx++] & 63;
              }
              if (u0 < 65536) {
                str += String.fromCharCode(u0);
              } else {
                var ch = u0 - 65536;
                str += String.fromCharCode(55296 | ch >> 10, 56320 | ch & 1023);
              }
            }
            return str;
          };
          var UTF8ToString = (ptr, maxBytesToRead) => {
            assert(typeof ptr == "number", `UTF8ToString expects a number (got ${typeof ptr})`);
            return ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead) : "";
          };
          var INT53_MAX = 9007199254740992;
          var INT53_MIN = -9007199254740992;
          var bigintToI53Checked = (num) => num < INT53_MIN || num > INT53_MAX ? NaN : Number(num);
          function ___syscall_chmod(path, mode) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function ___syscall_faccessat(dirfd, path, amode, flags) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          var ___syscall_fchmod = (fd, mode) => {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          };
          var ___syscall_fchown32 = (fd, owner, group) => {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          };
          function ___syscall_fcntl64(fd, cmd, varargs) {
            return 0;
          }
          function ___syscall_fstat64(fd, buf) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function ___syscall_ftruncate64(fd, length) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function ___syscall_getcwd(buf, size) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function ___syscall_ioctl(fd, op, varargs) {
            return 0;
          }
          function ___syscall_lstat64(path, buf) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function ___syscall_mkdirat(dirfd, path, mode) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function ___syscall_newfstatat(dirfd, path, buf, flags) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function ___syscall_openat(dirfd, path, flags, varargs) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function ___syscall_readlinkat(dirfd, path, buf, bufsize) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function ___syscall_rmdir(path) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function ___syscall_stat64(path, buf) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function ___syscall_unlinkat(dirfd, path, flags) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function ___syscall_utimensat(dirfd, path, times, flags) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          var __abort_js = () => abort("native code called abort()");
          function __gmtime_js(time, tmPtr) {
            time = bigintToI53Checked(time);
            tmPtr = bigintToI53Checked(tmPtr);
            var date = new Date(time * 1e3);
            HEAP32[tmPtr / 4] = date.getUTCSeconds();
            HEAP32[(tmPtr + 4) / 4] = date.getUTCMinutes();
            HEAP32[(tmPtr + 8) / 4] = date.getUTCHours();
            HEAP32[(tmPtr + 12) / 4] = date.getUTCDate();
            HEAP32[(tmPtr + 16) / 4] = date.getUTCMonth();
            HEAP32[(tmPtr + 20) / 4] = date.getUTCFullYear() - 1900;
            HEAP32[(tmPtr + 24) / 4] = date.getUTCDay();
            var start = Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
            var yday = (date.getTime() - start) / (1e3 * 60 * 60 * 24) | 0;
            HEAP32[(tmPtr + 28) / 4] = yday;
          }
          var isLeapYear = (year) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
          var MONTH_DAYS_LEAP_CUMULATIVE = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
          var MONTH_DAYS_REGULAR_CUMULATIVE = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
          var ydayFromDate = (date) => {
            var leap = isLeapYear(date.getFullYear());
            var monthDaysCumulative = leap ? MONTH_DAYS_LEAP_CUMULATIVE : MONTH_DAYS_REGULAR_CUMULATIVE;
            var yday = monthDaysCumulative[date.getMonth()] + date.getDate() - 1;
            return yday;
          };
          function __localtime_js(time, tmPtr) {
            time = bigintToI53Checked(time);
            tmPtr = bigintToI53Checked(tmPtr);
            var date = new Date(time * 1e3);
            HEAP32[tmPtr / 4] = date.getSeconds();
            HEAP32[(tmPtr + 4) / 4] = date.getMinutes();
            HEAP32[(tmPtr + 8) / 4] = date.getHours();
            HEAP32[(tmPtr + 12) / 4] = date.getDate();
            HEAP32[(tmPtr + 16) / 4] = date.getMonth();
            HEAP32[(tmPtr + 20) / 4] = date.getFullYear() - 1900;
            HEAP32[(tmPtr + 24) / 4] = date.getDay();
            var yday = ydayFromDate(date) | 0;
            HEAP32[(tmPtr + 28) / 4] = yday;
            HEAP64[(tmPtr + 40) / 8] = BigInt(-(date.getTimezoneOffset() * 60));
            var start = new Date(date.getFullYear(), 0, 1);
            var summerOffset = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
            var winterOffset = start.getTimezoneOffset();
            var dst = (summerOffset != winterOffset && date.getTimezoneOffset() == Math.min(winterOffset, summerOffset)) | 0;
            HEAP32[(tmPtr + 32) / 4] = dst;
          }
          function __mmap_js(len, prot, flags, fd, offset, allocated, addr) {
            return -52;
          }
          function __munmap_js(addr, len, prot, flags, fd, offset) {
          }
          var __timegm_js = function(tmPtr) {
            tmPtr = bigintToI53Checked(tmPtr);
            var ret = (() => {
              var time = Date.UTC(HEAP32[(tmPtr + 20) / 4] + 1900, HEAP32[(tmPtr + 16) / 4], HEAP32[(tmPtr + 12) / 4], HEAP32[(tmPtr + 8) / 4], HEAP32[(tmPtr + 4) / 4], HEAP32[tmPtr / 4], 0);
              var date = new Date(time);
              HEAP32[(tmPtr + 24) / 4] = date.getUTCDay();
              var start = Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
              var yday = (date.getTime() - start) / (1e3 * 60 * 60 * 24) | 0;
              HEAP32[(tmPtr + 28) / 4] = yday;
              return date.getTime() / 1e3;
            })();
            return BigInt(ret);
          };
          var stringToUTF8Array = (str, heap, outIdx, maxBytesToWrite) => {
            assert(typeof str === "string", `stringToUTF8Array expects a string (got ${typeof str})`);
            if (!(maxBytesToWrite > 0)) return 0;
            var startIdx = outIdx;
            var endIdx = outIdx + maxBytesToWrite - 1;
            for (var i = 0; i < str.length; ++i) {
              var u = str.charCodeAt(i);
              if (u >= 55296 && u <= 57343) {
                var u1 = str.charCodeAt(++i);
                u = 65536 + ((u & 1023) << 10) | u1 & 1023;
              }
              if (u <= 127) {
                if (outIdx >= endIdx) break;
                heap[outIdx++] = u;
              } else if (u <= 2047) {
                if (outIdx + 1 >= endIdx) break;
                heap[outIdx++] = 192 | u >> 6;
                heap[outIdx++] = 128 | u & 63;
              } else if (u <= 65535) {
                if (outIdx + 2 >= endIdx) break;
                heap[outIdx++] = 224 | u >> 12;
                heap[outIdx++] = 128 | u >> 6 & 63;
                heap[outIdx++] = 128 | u & 63;
              } else {
                if (outIdx + 3 >= endIdx) break;
                if (u > 1114111) warnOnce("Invalid Unicode code point " + ptrToString(u) + " encountered when serializing a JS string to a UTF-8 string in wasm memory! (Valid unicode code points should be in range 0-0x10FFFF).");
                heap[outIdx++] = 240 | u >> 18;
                heap[outIdx++] = 128 | u >> 12 & 63;
                heap[outIdx++] = 128 | u >> 6 & 63;
                heap[outIdx++] = 128 | u & 63;
              }
            }
            heap[outIdx] = 0;
            return outIdx - startIdx;
          };
          var stringToUTF8 = (str, outPtr, maxBytesToWrite) => {
            assert(typeof maxBytesToWrite == "number", "stringToUTF8(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!");
            return stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite);
          };
          var lengthBytesUTF8 = (str) => {
            var len = 0;
            for (var i = 0; i < str.length; ++i) {
              var c = str.charCodeAt(i);
              if (c <= 127) {
                len++;
              } else if (c <= 2047) {
                len += 2;
              } else if (c >= 55296 && c <= 57343) {
                len += 4;
                ++i;
              } else {
                len += 3;
              }
            }
            return len;
          };
          var __tzset_js = function(timezone, daylight, std_name, dst_name) {
            timezone = bigintToI53Checked(timezone);
            daylight = bigintToI53Checked(daylight);
            std_name = bigintToI53Checked(std_name);
            dst_name = bigintToI53Checked(dst_name);
            var currentYear = (/* @__PURE__ */ new Date()).getFullYear();
            var winter = new Date(currentYear, 0, 1);
            var summer = new Date(currentYear, 6, 1);
            var winterOffset = winter.getTimezoneOffset();
            var summerOffset = summer.getTimezoneOffset();
            var stdTimezoneOffset = Math.max(winterOffset, summerOffset);
            HEAPU64[timezone / 8] = BigInt(stdTimezoneOffset * 60);
            HEAP32[daylight / 4] = Number(winterOffset != summerOffset);
            var extractZone = (timezoneOffset) => {
              var sign = timezoneOffset >= 0 ? "-" : "+";
              var absOffset = Math.abs(timezoneOffset);
              var hours = String(Math.floor(absOffset / 60)).padStart(2, "0");
              var minutes = String(absOffset % 60).padStart(2, "0");
              return `UTC${sign}${hours}${minutes}`;
            };
            var winterName = extractZone(winterOffset);
            var summerName = extractZone(summerOffset);
            assert(winterName);
            assert(summerName);
            assert(lengthBytesUTF8(winterName) <= 16, `timezone name truncated to fit in TZNAME_MAX (${winterName})`);
            assert(lengthBytesUTF8(summerName) <= 16, `timezone name truncated to fit in TZNAME_MAX (${summerName})`);
            if (summerOffset < winterOffset) {
              stringToUTF8(winterName, std_name, 17);
              stringToUTF8(summerName, dst_name, 17);
            } else {
              stringToUTF8(winterName, dst_name, 17);
              stringToUTF8(summerName, std_name, 17);
            }
          };
          var _emscripten_get_now = () => performance.now();
          var _emscripten_date_now = () => Date.now();
          var checkWasiClock = (clock_id) => clock_id >= 0 && clock_id <= 3;
          function _clock_time_get(clk_id, ignored_precision, ptime) {
            ptime = bigintToI53Checked(ptime);
            if (!checkWasiClock(clk_id)) {
              return 28;
            }
            var now;
            if (clk_id === 0) {
              now = _emscripten_date_now();
            } else {
              now = _emscripten_get_now();
            }
            var nsec = Math.round(now * 1e3 * 1e3);
            HEAP64[ptime / 8] = BigInt(nsec);
            return 0;
          }
          var readEmAsmArgsArray = [];
          var readEmAsmArgs = (sigPtr, buf) => {
            assert(Array.isArray(readEmAsmArgsArray));
            assert(buf % 16 == 0);
            readEmAsmArgsArray.length = 0;
            var ch;
            while (ch = HEAPU8[sigPtr++]) {
              var chr = String.fromCharCode(ch);
              var validChars = ["d", "f", "i", "p"];
              validChars.push("j");
              assert(validChars.includes(chr), `Invalid character ${ch}("${chr}") in readEmAsmArgs! Use only [${validChars}], and do not specify "v" for void return argument.`);
              var wide = ch != 105;
              buf += wide && buf % 8 ? 4 : 0;
              readEmAsmArgsArray.push(
                // Special case for pointers under wasm64 or CAN_ADDRESS_2GB mode.
                ch == 112 ? Number(HEAPU64[buf / 8]) : ch == 106 ? HEAP64[buf / 8] : ch == 105 ? HEAP32[buf / 4] : HEAPF64[buf / 8]
              );
              buf += wide ? 8 : 4;
            }
            return readEmAsmArgsArray;
          };
          var runEmAsmFunction = (code, sigPtr, argbuf) => {
            var args = readEmAsmArgs(sigPtr, argbuf);
            assert(ASM_CONSTS.hasOwnProperty(code), `No EM_ASM constant found at address ${code}.  The loaded WebAssembly file is likely out of sync with the generated JavaScript.`);
            return ASM_CONSTS[code](...args);
          };
          function _emscripten_asm_const_int(code, sigPtr, argbuf) {
            code = bigintToI53Checked(code);
            sigPtr = bigintToI53Checked(sigPtr);
            argbuf = bigintToI53Checked(argbuf);
            return runEmAsmFunction(code, sigPtr, argbuf);
          }
          function _emscripten_err(str) {
            str = bigintToI53Checked(str);
            return err(UTF8ToString(str));
          }
          function _emscripten_errn(str, len) {
            str = bigintToI53Checked(str);
            len = bigintToI53Checked(len);
            return err(UTF8ToString(str, len));
          }
          var getHeapMax = () => 17179869184;
          var _emscripten_get_heap_max = () => BigInt(getHeapMax());
          var _emscripten_pc_get_function = function(pc) {
            var ret = (() => {
              abort("Cannot use emscripten_pc_get_function without -sUSE_OFFSET_CONVERTER");
              return 0;
            })();
            return BigInt(ret);
          };
          var alignMemory = (size, alignment) => {
            assert(alignment, "alignment argument is required");
            return Math.ceil(size / alignment) * alignment;
          };
          var growMemory = (size) => {
            var b = wasmMemory.buffer;
            var pages = (size - b.byteLength + 65535) / 65536 | 0;
            try {
              wasmMemory.grow(BigInt(pages));
              updateMemoryViews();
              return 1;
            } catch (e) {
              err(`growMemory: Attempted to grow heap from ${b.byteLength} bytes to ${size} bytes, but got error: ${e}`);
            }
          };
          function _emscripten_resize_heap(requestedSize) {
            requestedSize = bigintToI53Checked(requestedSize);
            var oldSize = HEAPU8.length;
            assert(requestedSize > oldSize);
            var maxHeapSize = getHeapMax();
            if (requestedSize > maxHeapSize) {
              err(`Cannot enlarge memory, requested ${requestedSize} bytes, but the limit is ${maxHeapSize} bytes!`);
              return false;
            }
            for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
              var overGrownHeapSize = oldSize * (1 + 0.2 / cutDown);
              overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
              var newSize = Math.min(maxHeapSize, alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536));
              var replacement = growMemory(newSize);
              if (replacement) {
                return true;
              }
            }
            err(`Failed to grow the heap from ${oldSize} bytes to ${newSize} bytes, not enough memory!`);
            return false;
          }
          var convertFrameToPC = (frame) => {
            abort("Cannot use convertFrameToPC (needed by __builtin_return_address) without -sUSE_OFFSET_CONVERTER");
            return 0;
          };
          var UNWIND_CACHE = {};
          var saveInUnwindCache = (callstack) => {
            callstack.forEach((frame) => {
              convertFrameToPC();
            });
          };
          var jsStackTrace = () => new Error().stack.toString();
          var _emscripten_stack_snapshot = function() {
            var ret = (() => {
              var callstack = jsStackTrace().split("\n");
              if (callstack[0] == "Error") {
                callstack.shift();
              }
              saveInUnwindCache(callstack);
              UNWIND_CACHE.last_addr = convertFrameToPC(callstack[3]);
              UNWIND_CACHE.last_stack = callstack;
              return UNWIND_CACHE.last_addr;
            })();
            return BigInt(ret);
          };
          function _emscripten_stack_unwind_buffer(addr, buffer, count) {
            addr = bigintToI53Checked(addr);
            buffer = bigintToI53Checked(buffer);
            var stack;
            if (UNWIND_CACHE.last_addr == addr) {
              stack = UNWIND_CACHE.last_stack;
            } else {
              stack = jsStackTrace().split("\n");
              if (stack[0] == "Error") {
                stack.shift();
              }
              saveInUnwindCache(stack);
            }
            var offset = 3;
            while (stack[offset] && convertFrameToPC(stack[offset]) != addr) {
              ++offset;
            }
            for (var i = 0; i < count && stack[i + offset]; ++i) {
              HEAP32[(buffer + i * 4) / 4] = convertFrameToPC(stack[i + offset]);
            }
            return i;
          }
          var ENV = {};
          var getExecutableName = () => thisProgram || "./this.program";
          var getEnvStrings = () => {
            if (!getEnvStrings.strings) {
              var lang = (typeof navigator == "object" && navigator.languages && navigator.languages[0] || "C").replace("-", "_") + ".UTF-8";
              var env = {
                "USER": "web_user",
                "LOGNAME": "web_user",
                "PATH": "/",
                "PWD": "/",
                "HOME": "/home/web_user",
                "LANG": lang,
                "_": getExecutableName()
              };
              for (var x in ENV) {
                if (ENV[x] === void 0) delete env[x];
                else env[x] = ENV[x];
              }
              var strings = [];
              for (var x in env) {
                strings.push(`${x}=${env[x]}`);
              }
              getEnvStrings.strings = strings;
            }
            return getEnvStrings.strings;
          };
          function _environ_get(__environ, environ_buf) {
            __environ = bigintToI53Checked(__environ);
            environ_buf = bigintToI53Checked(environ_buf);
            var bufSize = 0;
            var envp = 0;
            for (var string of getEnvStrings()) {
              var ptr = environ_buf + bufSize;
              HEAPU64[(__environ + envp) / 8] = BigInt(ptr);
              bufSize += stringToUTF8(string, ptr, Infinity) + 1;
              envp += 8;
            }
            return 0;
          }
          function _environ_sizes_get(penviron_count, penviron_buf_size) {
            penviron_count = bigintToI53Checked(penviron_count);
            penviron_buf_size = bigintToI53Checked(penviron_buf_size);
            var strings = getEnvStrings();
            HEAPU64[penviron_count / 8] = BigInt(strings.length);
            var bufSize = 0;
            for (var string of strings) {
              bufSize += lengthBytesUTF8(string) + 1;
            }
            HEAPU64[penviron_buf_size / 8] = BigInt(bufSize);
            return 0;
          }
          var runtimeKeepaliveCounter = 0;
          var keepRuntimeAlive = () => noExitRuntime || runtimeKeepaliveCounter > 0;
          var _proc_exit = (code) => {
            var _a;
            EXITSTATUS = code;
            if (!keepRuntimeAlive()) {
              (_a = Module["onExit"]) == null ? void 0 : _a.call(Module, code);
              ABORT = true;
            }
            quit_(code, new ExitStatus(code));
          };
          var exitJS = (status, implicit) => {
            EXITSTATUS = status;
            checkUnflushedContent();
            if (keepRuntimeAlive() && !implicit) {
              var msg = `program exited (with status: ${status}), but keepRuntimeAlive() is set (counter=${runtimeKeepaliveCounter}) due to an async operation, so halting execution but not exiting the runtime or preventing further async execution (you can use emscripten_force_exit, if you want to force a true shutdown)`;
              readyPromiseReject(msg);
              err(msg);
            }
            _proc_exit(status);
          };
          var _exit = exitJS;
          var _fd_close = (fd) => {
            abort("fd_close called without SYSCALLS_REQUIRE_FILESYSTEM");
          };
          function _fd_fdstat_get(fd, pbuf) {
            pbuf = bigintToI53Checked(pbuf);
            var rightsBase = 0;
            var rightsInheriting = 0;
            var flags = 0;
            {
              assert(fd == 0 || fd == 1 || fd == 2);
              var type = 2;
              if (fd == 0) {
                rightsBase = 2;
              } else if (fd == 1 || fd == 2) {
                rightsBase = 64;
              }
              flags = 1;
            }
            HEAP8[pbuf] = type;
            HEAP16[(pbuf + 2) / 2] = flags;
            HEAP64[(pbuf + 8) / 8] = BigInt(rightsBase);
            HEAP64[(pbuf + 16) / 8] = BigInt(rightsInheriting);
            return 0;
          }
          function _fd_read(fd, iov, iovcnt, pnum) {
            abort("fd_read called without SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function _fd_seek(fd, offset, whence, newOffset) {
            return 70;
          }
          var _fd_sync = (fd) => {
            abort("fd_sync called without SYSCALLS_REQUIRE_FILESYSTEM");
          };
          var printCharBuffers = [null, [], []];
          var printChar = (stream, curr) => {
            var buffer = printCharBuffers[stream];
            assert(buffer);
            if (curr === 0 || curr === 10) {
              (stream === 1 ? out : err)(UTF8ArrayToString(buffer));
              buffer.length = 0;
            } else {
              buffer.push(curr);
            }
          };
          var flush_NO_FILESYSTEM = () => {
            _fflush(0);
            if (printCharBuffers[1].length) printChar(1, 10);
            if (printCharBuffers[2].length) printChar(2, 10);
          };
          function _fd_write(fd, iov, iovcnt, pnum) {
            iov = bigintToI53Checked(iov);
            iovcnt = bigintToI53Checked(iovcnt);
            pnum = bigintToI53Checked(pnum);
            var num = 0;
            for (var i = 0; i < iovcnt; i++) {
              var ptr = Number(HEAPU64[iov / 8]);
              var len = Number(HEAPU64[(iov + 8) / 8]);
              iov += 16;
              for (var j = 0; j < len; j++) {
                printChar(fd, HEAPU8[ptr + j]);
              }
              num += len;
            }
            HEAPU64[pnum / 8] = BigInt(num);
            return 0;
          }
          var handleException = (e) => {
            if (e instanceof ExitStatus || e == "unwind") {
              return EXITSTATUS;
            }
            checkStackCookie();
            if (e instanceof WebAssembly.RuntimeError) {
              if (_emscripten_stack_get_current() <= 0) {
                err("Stack overflow detected.  You can try increasing -sSTACK_SIZE (currently set to 2097152)");
              }
            }
            quit_(1, e);
          };
          var stackAlloc = (sz) => __emscripten_stack_alloc(sz);
          var stringToUTF8OnStack = (str) => {
            var size = lengthBytesUTF8(str) + 1;
            var ret = stackAlloc(size);
            stringToUTF8(str, ret, size);
            return ret;
          };
          var getCFunc = (ident) => {
            var func = Module["_" + ident];
            assert(func, "Cannot call unknown function " + ident + ", make sure it is exported");
            return func;
          };
          var writeArrayToMemory = (array, buffer) => {
            assert(array.length >= 0, "writeArrayToMemory array must have a length (should be an array or typed array)");
            HEAP8.set(array, buffer);
          };
          var ccall = (ident, returnType, argTypes, args, opts) => {
            var toC = {
              "pointer": (p) => BigInt(p),
              "string": (str) => {
                var ret2 = 0;
                if (str !== null && str !== void 0 && str !== 0) {
                  ret2 = stringToUTF8OnStack(str);
                }
                return BigInt(ret2);
              },
              "array": (arr) => {
                var ret2 = stackAlloc(arr.length);
                writeArrayToMemory(arr, ret2);
                return BigInt(ret2);
              }
            };
            function convertReturnValue(ret2) {
              if (returnType === "string") {
                return UTF8ToString(Number(ret2));
              }
              if (returnType === "pointer") return Number(ret2);
              if (returnType === "boolean") return Boolean(ret2);
              return ret2;
            }
            var func = getCFunc(ident);
            var cArgs = [];
            var stack = 0;
            assert(returnType !== "array", 'Return type should not be "array".');
            if (args) {
              for (var i = 0; i < args.length; i++) {
                var converter = toC[argTypes[i]];
                if (converter) {
                  if (stack === 0) stack = stackSave();
                  cArgs[i] = converter(args[i]);
                } else {
                  cArgs[i] = args[i];
                }
              }
            }
            var ret = func(...cArgs);
            function onDone(ret2) {
              if (stack !== 0) stackRestore(stack);
              return convertReturnValue(ret2);
            }
            ret = onDone(ret);
            return ret;
          };
          var uleb128Encode = (n, target) => {
            assert(n < 16384);
            if (n < 128) {
              target.push(n);
            } else {
              target.push(n % 128 | 128, n >> 7);
            }
          };
          var sigToWasmTypes = (sig) => {
            var typeNames = {
              "i": "i32",
              "j": "i64",
              "f": "f32",
              "d": "f64",
              "e": "externref",
              "p": "i64"
            };
            var type = {
              parameters: [],
              results: sig[0] == "v" ? [] : [typeNames[sig[0]]]
            };
            for (var i = 1; i < sig.length; ++i) {
              assert(sig[i] in typeNames, "invalid signature char: " + sig[i]);
              type.parameters.push(typeNames[sig[i]]);
            }
            return type;
          };
          var generateFuncType = (sig, target) => {
            var sigRet = sig.slice(0, 1);
            var sigParam = sig.slice(1);
            var typeCodes = {
              "i": 127,
              // i32
              "p": 126,
              // i64
              "j": 126,
              // i64
              "f": 125,
              // f32
              "d": 124,
              // f64
              "e": 111
            };
            target.push(96);
            uleb128Encode(sigParam.length, target);
            for (var paramType of sigParam) {
              assert(paramType in typeCodes, `invalid signature char: ${paramType}`);
              target.push(typeCodes[paramType]);
            }
            if (sigRet == "v") {
              target.push(0);
            } else {
              target.push(1, typeCodes[sigRet]);
            }
          };
          var convertJsFunctionToWasm = (func, sig) => {
            if (typeof WebAssembly.Function == "function") {
              return new WebAssembly.Function(sigToWasmTypes(sig), func);
            }
            var typeSectionBody = [1];
            generateFuncType(sig, typeSectionBody);
            var bytes = [
              0,
              97,
              115,
              109,
              // magic ("\0asm")
              1,
              0,
              0,
              0,
              // version: 1
              1
            ];
            uleb128Encode(typeSectionBody.length, bytes);
            bytes.push(...typeSectionBody);
            bytes.push(
              2,
              7,
              // import section
              // (import "e" "f" (func 0 (type 0)))
              1,
              1,
              101,
              1,
              102,
              0,
              0,
              7,
              5,
              // export section
              // (export "f" (func 0 (type 0)))
              1,
              1,
              102,
              0,
              0
            );
            var module2 = new WebAssembly.Module(new Uint8Array(bytes));
            var instance = new WebAssembly.Instance(module2, {
              "e": {
                "f": func
              }
            });
            var wrappedFunc = instance.exports["f"];
            return wrappedFunc;
          };
          var wasmTableMirror = [];
          var wasmTable;
          var getWasmTableEntry = (funcPtr) => {
            funcPtr = Number(funcPtr);
            var func = wasmTableMirror[funcPtr];
            if (!func) {
              wasmTableMirror[funcPtr] = func = wasmTable.get(BigInt(funcPtr));
            }
            assert(wasmTable.get(BigInt(funcPtr)) == func, "JavaScript-side Wasm function table mirror is out of date!");
            return func;
          };
          var updateTableMap = (offset, count) => {
            if (functionsInTableMap) {
              for (var i = offset; i < offset + count; i++) {
                var item = getWasmTableEntry(i);
                if (item) {
                  functionsInTableMap.set(item, i);
                }
              }
            }
          };
          var functionsInTableMap;
          var getFunctionAddress = (func) => {
            if (!functionsInTableMap) {
              functionsInTableMap = /* @__PURE__ */ new WeakMap();
              updateTableMap(0, Number(wasmTable.length));
            }
            return functionsInTableMap.get(func) || 0;
          };
          var freeTableIndexes = [];
          var getEmptyTableSlot = () => {
            if (freeTableIndexes.length) {
              return freeTableIndexes.pop();
            }
            try {
              wasmTable.grow(BigInt(1));
            } catch (err2) {
              if (!(err2 instanceof RangeError)) {
                throw err2;
              }
              throw "Unable to grow wasm table. Set ALLOW_TABLE_GROWTH.";
            }
            return Number(wasmTable.length) - 1;
          };
          var setWasmTableEntry = (idx, func) => {
            wasmTable.set(BigInt(idx), func);
            wasmTableMirror[idx] = wasmTable.get(BigInt(idx));
          };
          var addFunction = (func, sig) => {
            assert(typeof func != "undefined");
            var rtn = getFunctionAddress(func);
            if (rtn) {
              return rtn;
            }
            var ret = getEmptyTableSlot();
            try {
              setWasmTableEntry(ret, func);
            } catch (err2) {
              if (!(err2 instanceof TypeError)) {
                throw err2;
              }
              assert(typeof sig != "undefined", "Missing signature argument to addFunction: " + func);
              var wrapped = convertJsFunctionToWasm(func, sig);
              setWasmTableEntry(ret, wrapped);
            }
            functionsInTableMap.set(func, ret);
            return ret;
          };
          {
            if (Module["noExitRuntime"]) noExitRuntime = Module["noExitRuntime"];
            if (Module["print"]) out = Module["print"];
            if (Module["printErr"]) err = Module["printErr"];
            if (Module["wasmBinary"]) wasmBinary = Module["wasmBinary"];
            Module["FS_createDataFile"] = FS.createDataFile;
            Module["FS_createPreloadedFile"] = FS.createPreloadedFile;
            checkIncomingModuleAPI();
            if (Module["arguments"]) arguments_ = Module["arguments"];
            if (Module["thisProgram"]) thisProgram = Module["thisProgram"];
            assert(typeof Module["memoryInitializerPrefixURL"] == "undefined", "Module.memoryInitializerPrefixURL option was removed, use Module.locateFile instead");
            assert(typeof Module["pthreadMainPrefixURL"] == "undefined", "Module.pthreadMainPrefixURL option was removed, use Module.locateFile instead");
            assert(typeof Module["cdInitializerPrefixURL"] == "undefined", "Module.cdInitializerPrefixURL option was removed, use Module.locateFile instead");
            assert(typeof Module["filePackagePrefixURL"] == "undefined", "Module.filePackagePrefixURL option was removed, use Module.locateFile instead");
            assert(typeof Module["read"] == "undefined", "Module.read option was removed");
            assert(typeof Module["readAsync"] == "undefined", "Module.readAsync option was removed (modify readAsync in JS)");
            assert(typeof Module["readBinary"] == "undefined", "Module.readBinary option was removed (modify readBinary in JS)");
            assert(typeof Module["setWindowTitle"] == "undefined", "Module.setWindowTitle option was removed (modify emscripten_set_window_title in JS)");
            assert(typeof Module["TOTAL_MEMORY"] == "undefined", "Module.TOTAL_MEMORY has been renamed Module.INITIAL_MEMORY");
            assert(typeof Module["ENVIRONMENT"] == "undefined", "Module.ENVIRONMENT has been deprecated. To force the environment, use the ENVIRONMENT compile-time option (for example, -sENVIRONMENT=web or -sENVIRONMENT=node)");
            assert(typeof Module["STACK_SIZE"] == "undefined", "STACK_SIZE can no longer be set at runtime.  Use -sSTACK_SIZE at link time");
            assert(typeof Module["wasmMemory"] == "undefined", "Use of `wasmMemory` detected.  Use -sIMPORTED_MEMORY to define wasmMemory externally");
            assert(typeof Module["INITIAL_MEMORY"] == "undefined", "Detected runtime INITIAL_MEMORY setting.  Use -sIMPORTED_MEMORY to define wasmMemory dynamically");
          }
          Module["callMain"] = callMain;
          Module["ccall"] = ccall;
          Module["addFunction"] = addFunction;
          var missingLibrarySymbols = ["writeI53ToI64", "writeI53ToI64Clamped", "writeI53ToI64Signaling", "writeI53ToU64Clamped", "writeI53ToU64Signaling", "readI53FromI64", "readI53FromU64", "convertI32PairToI53", "convertI32PairToI53Checked", "convertU32PairToI53", "getTempRet0", "setTempRet0", "zeroMemory", "strError", "inetPton4", "inetNtop4", "inetPton6", "inetNtop6", "readSockaddr", "writeSockaddr", "emscriptenLog", "runMainThreadEmAsm", "jstoi_q", "listenOnce", "autoResumeAudioContext", "getDynCaller", "dynCall", "runtimeKeepalivePush", "runtimeKeepalivePop", "callUserCallback", "maybeExit", "asmjsMangle", "asyncLoad", "mmapAlloc", "HandleAllocator", "getNativeTypeSize", "addOnInit", "addOnPostCtor", "addOnPreMain", "addOnExit", "STACK_SIZE", "STACK_ALIGN", "POINTER_SIZE", "ASSERTIONS", "cwrap", "removeFunction", "reallyNegative", "unSign", "strLen", "reSign", "formatString", "intArrayFromString", "intArrayToString", "AsciiToString", "stringToAscii", "UTF16ToString", "stringToUTF16", "lengthBytesUTF16", "UTF32ToString", "stringToUTF32", "lengthBytesUTF32", "stringToNewUTF8", "registerKeyEventCallback", "maybeCStringToJsString", "findEventTarget", "getBoundingClientRect", "fillMouseEventData", "registerMouseEventCallback", "registerWheelEventCallback", "registerUiEventCallback", "registerFocusEventCallback", "fillDeviceOrientationEventData", "registerDeviceOrientationEventCallback", "fillDeviceMotionEventData", "registerDeviceMotionEventCallback", "screenOrientation", "fillOrientationChangeEventData", "registerOrientationChangeEventCallback", "fillFullscreenChangeEventData", "registerFullscreenChangeEventCallback", "JSEvents_requestFullscreen", "JSEvents_resizeCanvasForFullscreen", "registerRestoreOldStyle", "hideEverythingExceptGivenElement", "restoreHiddenElements", "setLetterbox", "softFullscreenResizeWebGLRenderTarget", "doRequestFullscreen", "fillPointerlockChangeEventData", "registerPointerlockChangeEventCallback", "registerPointerlockErrorEventCallback", "requestPointerLock", "fillVisibilityChangeEventData", "registerVisibilityChangeEventCallback", "registerTouchEventCallback", "fillGamepadEventData", "registerGamepadEventCallback", "registerBeforeUnloadEventCallback", "fillBatteryEventData", "battery", "registerBatteryEventCallback", "setCanvasElementSize", "getCanvasElementSize", "getCallstack", "convertPCtoSourceLocation", "wasiRightsToMuslOFlags", "wasiOFlagsToMuslOFlags", "initRandomFill", "randomFill", "safeSetTimeout", "setImmediateWrapped", "safeRequestAnimationFrame", "clearImmediateWrapped", "registerPostMainLoop", "registerPreMainLoop", "getPromise", "makePromise", "idsToPromises", "makePromiseCallback", "ExceptionInfo", "findMatchingCatch", "Browser_asyncPrepareDataCounter", "arraySum", "addDays", "getSocketFromFD", "getSocketAddress", "heapObjectForWebGLType", "toTypedArrayIndex", "webgl_enable_ANGLE_instanced_arrays", "webgl_enable_OES_vertex_array_object", "webgl_enable_WEBGL_draw_buffers", "webgl_enable_WEBGL_multi_draw", "webgl_enable_EXT_polygon_offset_clamp", "webgl_enable_EXT_clip_control", "webgl_enable_WEBGL_polygon_mode", "emscriptenWebGLGet", "computeUnpackAlignedImageSize", "colorChannelsInGlTextureFormat", "emscriptenWebGLGetTexPixelData", "emscriptenWebGLGetUniform", "webglGetUniformLocation", "webglPrepareUniformLocationsBeforeFirstUse", "webglGetLeftBracePos", "emscriptenWebGLGetVertexAttrib", "__glGetActiveAttribOrUniform", "writeGLArray", "registerWebGlEventCallback", "runAndAbortIfError", "ALLOC_NORMAL", "ALLOC_STACK", "allocate", "writeStringToMemory", "writeAsciiToMemory", "demangle", "stackTrace"];
          missingLibrarySymbols.forEach(missingLibrarySymbol);
          var unexportedSymbols = ["run", "addRunDependency", "removeRunDependency", "out", "err", "abort", "wasmMemory", "wasmExports", "HEAPF32", "HEAPF64", "HEAP8", "HEAP16", "HEAPU16", "HEAP32", "HEAPU32", "HEAP64", "HEAPU64", "writeStackCookie", "checkStackCookie", "INT53_MAX", "INT53_MIN", "bigintToI53Checked", "stackSave", "stackRestore", "stackAlloc", "ptrToString", "exitJS", "getHeapMax", "growMemory", "ENV", "ERRNO_CODES", "DNS", "Protocols", "Sockets", "timers", "warnOnce", "readEmAsmArgsArray", "readEmAsmArgs", "runEmAsmFunction", "getExecutableName", "handleException", "keepRuntimeAlive", "alignMemory", "wasmTable", "noExitRuntime", "addOnPreRun", "addOnPostRun", "getCFunc", "uleb128Encode", "sigToWasmTypes", "generateFuncType", "convertJsFunctionToWasm", "freeTableIndexes", "functionsInTableMap", "getEmptyTableSlot", "updateTableMap", "getFunctionAddress", "setValue", "getValue", "PATH", "PATH_FS", "UTF8Decoder", "UTF8ArrayToString", "UTF8ToString", "stringToUTF8Array", "stringToUTF8", "lengthBytesUTF8", "UTF16Decoder", "stringToUTF8OnStack", "writeArrayToMemory", "JSEvents", "specialHTMLTargets", "findCanvasEventTarget", "currentFullscreenStrategy", "restoreOldWindowedStyle", "jsStackTrace", "UNWIND_CACHE", "ExitStatus", "getEnvStrings", "checkWasiClock", "flush_NO_FILESYSTEM", "emSetImmediate", "emClearImmediate_deps", "emClearImmediate", "promiseMap", "uncaughtExceptionCount", "exceptionLast", "exceptionCaught", "Browser", "getPreloadedImageData__data", "wget", "MONTH_DAYS_REGULAR", "MONTH_DAYS_LEAP", "MONTH_DAYS_REGULAR_CUMULATIVE", "MONTH_DAYS_LEAP_CUMULATIVE", "isLeapYear", "ydayFromDate", "SYSCALLS", "tempFixedLengthArray", "miniTempWebGLFloatBuffers", "miniTempWebGLIntBuffers", "GL", "AL", "GLUT", "EGL", "GLEW", "IDBStore", "SDL", "SDL_gfx", "allocateUTF8", "allocateUTF8OnStack", "print", "printErr", "jstoi_s"];
          unexportedSymbols.forEach(unexportedRuntimeSymbol);
          function checkIncomingModuleAPI() {
            ignoredModuleProp("fetchSettings");
          }
          var ASM_CONSTS = {
            4937824: () => typeof wasmOffsetConverter !== "undefined"
          };
          function HaveOffsetConverter() {
            return typeof wasmOffsetConverter !== "undefined";
          }
          var wasmImports = {
            /** @export */
            HaveOffsetConverter,
            /** @export */
            __syscall_chmod: ___syscall_chmod,
            /** @export */
            __syscall_faccessat: ___syscall_faccessat,
            /** @export */
            __syscall_fchmod: ___syscall_fchmod,
            /** @export */
            __syscall_fchown32: ___syscall_fchown32,
            /** @export */
            __syscall_fcntl64: ___syscall_fcntl64,
            /** @export */
            __syscall_fstat64: ___syscall_fstat64,
            /** @export */
            __syscall_ftruncate64: ___syscall_ftruncate64,
            /** @export */
            __syscall_getcwd: ___syscall_getcwd,
            /** @export */
            __syscall_ioctl: ___syscall_ioctl,
            /** @export */
            __syscall_lstat64: ___syscall_lstat64,
            /** @export */
            __syscall_mkdirat: ___syscall_mkdirat,
            /** @export */
            __syscall_newfstatat: ___syscall_newfstatat,
            /** @export */
            __syscall_openat: ___syscall_openat,
            /** @export */
            __syscall_readlinkat: ___syscall_readlinkat,
            /** @export */
            __syscall_rmdir: ___syscall_rmdir,
            /** @export */
            __syscall_stat64: ___syscall_stat64,
            /** @export */
            __syscall_unlinkat: ___syscall_unlinkat,
            /** @export */
            __syscall_utimensat: ___syscall_utimensat,
            /** @export */
            _abort_js: __abort_js,
            /** @export */
            _gmtime_js: __gmtime_js,
            /** @export */
            _localtime_js: __localtime_js,
            /** @export */
            _mmap_js: __mmap_js,
            /** @export */
            _munmap_js: __munmap_js,
            /** @export */
            _timegm_js: __timegm_js,
            /** @export */
            _tzset_js: __tzset_js,
            /** @export */
            clock_time_get: _clock_time_get,
            /** @export */
            emscripten_asm_const_int: _emscripten_asm_const_int,
            /** @export */
            emscripten_date_now: _emscripten_date_now,
            /** @export */
            emscripten_err: _emscripten_err,
            /** @export */
            emscripten_errn: _emscripten_errn,
            /** @export */
            emscripten_get_heap_max: _emscripten_get_heap_max,
            /** @export */
            emscripten_get_now: _emscripten_get_now,
            /** @export */
            emscripten_pc_get_function: _emscripten_pc_get_function,
            /** @export */
            emscripten_resize_heap: _emscripten_resize_heap,
            /** @export */
            emscripten_stack_snapshot: _emscripten_stack_snapshot,
            /** @export */
            emscripten_stack_unwind_buffer: _emscripten_stack_unwind_buffer,
            /** @export */
            environ_get: _environ_get,
            /** @export */
            environ_sizes_get: _environ_sizes_get,
            /** @export */
            exit: _exit,
            /** @export */
            fd_close: _fd_close,
            /** @export */
            fd_fdstat_get: _fd_fdstat_get,
            /** @export */
            fd_read: _fd_read,
            /** @export */
            fd_seek: _fd_seek,
            /** @export */
            fd_sync: _fd_sync,
            /** @export */
            fd_write: _fd_write,
            /** @export */
            proc_exit: _proc_exit
          };
          var wasmExports = await createWasm();
          Module["_trace_processor_rpc_init"] = createExportWrapper("trace_processor_rpc_init", 2);
          Module["_trace_processor_on_rpc_request"] = createExportWrapper("trace_processor_on_rpc_request", 1);
          var _main = Module["_main"] = createExportWrapper("__main_argc_argv", 2);
          Module["_SynqPerfettoParseAlloc"] = createExportWrapper("SynqPerfettoParseAlloc", 2);
          Module["_SynqPerfettoParseFree"] = createExportWrapper("SynqPerfettoParseFree", 2);
          Module["_SynqPerfettoParse"] = createExportWrapper("SynqPerfettoParse", 3);
          Module["_SynqPerfettoGetToken"] = createExportWrapper("SynqPerfettoGetToken", 3);
          Module["_synq_extent_on_shift"] = createExportWrapper("synq_extent_on_shift", 3);
          Module["_synq_extent_on_reduce"] = createExportWrapper("synq_extent_on_reduce", 2);
          Module["_SynqPerfettoParseInit"] = createExportWrapper("SynqPerfettoParseInit", 2);
          Module["_SynqPerfettoParseFinalize"] = createExportWrapper("SynqPerfettoParseFinalize", 1);
          Module["_SynqPerfettoParseFallback"] = createExportWrapper("SynqPerfettoParseFallback", 1);
          Module["_SynqPerfettoParseExpectedTokens"] = createExportWrapper("SynqPerfettoParseExpectedTokens", 3);
          Module["_SynqPerfettoParseCompletionContext"] = createExportWrapper("SynqPerfettoParseCompletionContext", 1);
          var _fflush = createExportWrapper("fflush", 1);
          var _emscripten_stack_get_end = wasmExports["emscripten_stack_get_end"];
          wasmExports["emscripten_stack_get_base"];
          var _emscripten_stack_init = wasmExports["emscripten_stack_init"];
          wasmExports["emscripten_stack_get_free"];
          var __emscripten_stack_restore = wasmExports["_emscripten_stack_restore"];
          var __emscripten_stack_alloc = wasmExports["_emscripten_stack_alloc"];
          var _emscripten_stack_get_current = wasmExports["emscripten_stack_get_current"];
          function applySignatureConversions(wasmExports2) {
            wasmExports2 = Object.assign({}, wasmExports2);
            var makeWrapper___PP = (f) => (a0, a1, a2) => f(a0, BigInt(a1 ? a1 : 0), BigInt(a2 ? a2 : 0));
            var makeWrapper__p = (f) => (a0) => f(BigInt(a0));
            var makeWrapper_p = (f) => () => Number(f());
            var makeWrapper_pp = (f) => (a0) => Number(f(BigInt(a0)));
            wasmExports2["__main_argc_argv"] = makeWrapper___PP(wasmExports2["__main_argc_argv"]);
            wasmExports2["fflush"] = makeWrapper__p(wasmExports2["fflush"]);
            wasmExports2["emscripten_stack_get_end"] = makeWrapper_p(wasmExports2["emscripten_stack_get_end"]);
            wasmExports2["emscripten_stack_get_base"] = makeWrapper_p(wasmExports2["emscripten_stack_get_base"]);
            wasmExports2["_emscripten_stack_restore"] = makeWrapper__p(wasmExports2["_emscripten_stack_restore"]);
            wasmExports2["_emscripten_stack_alloc"] = makeWrapper_pp(wasmExports2["_emscripten_stack_alloc"]);
            wasmExports2["emscripten_stack_get_current"] = makeWrapper_p(wasmExports2["emscripten_stack_get_current"]);
            return wasmExports2;
          }
          var calledRun;
          function callMain(args = []) {
            assert(runDependencies == 0, 'cannot call main when async dependencies remain! (listen on Module["onRuntimeInitialized"])');
            assert(typeof onPreRuns === "undefined" || onPreRuns.length == 0, "cannot call main when preRun functions remain to be called");
            var entryFunction = _main;
            args.unshift(thisProgram);
            var argc = args.length;
            var argv = stackAlloc((argc + 1) * 8);
            var argv_ptr = argv;
            args.forEach((arg) => {
              HEAPU64[argv_ptr / 8] = BigInt(stringToUTF8OnStack(arg));
              argv_ptr += 8;
            });
            HEAPU64[argv_ptr / 8] = BigInt(0);
            try {
              var ret = entryFunction(argc, BigInt(argv));
              exitJS(
                ret,
                /* implicit = */
                true
              );
              return ret;
            } catch (e) {
              return handleException(e);
            }
          }
          function stackCheckInit() {
            _emscripten_stack_init();
            writeStackCookie();
          }
          function run(args = arguments_) {
            if (runDependencies > 0) {
              dependenciesFulfilled = run;
              return;
            }
            stackCheckInit();
            preRun();
            if (runDependencies > 0) {
              dependenciesFulfilled = run;
              return;
            }
            function doRun() {
              var _a;
              assert(!calledRun);
              calledRun = true;
              Module["calledRun"] = true;
              if (ABORT) return;
              initRuntime();
              preMain();
              readyPromiseResolve(Module);
              (_a = Module["onRuntimeInitialized"]) == null ? void 0 : _a.call(Module);
              consumedModuleProp("onRuntimeInitialized");
              var noInitialRun = Module["noInitialRun"] || false;
              if (!noInitialRun) callMain(args);
              postRun();
            }
            if (Module["setStatus"]) {
              Module["setStatus"]("Running...");
              setTimeout(() => {
                setTimeout(() => Module["setStatus"](""), 1);
                doRun();
              }, 1);
            } else {
              doRun();
            }
            checkStackCookie();
          }
          function checkUnflushedContent() {
            var oldOut = out;
            var oldErr = err;
            var has = false;
            out = err = (x) => {
              has = true;
            };
            try {
              flush_NO_FILESYSTEM();
            } catch (e) {
            }
            out = oldOut;
            err = oldErr;
            if (has) {
              warnOnce("stdio streams had content in them that was not flushed. you should set EXIT_RUNTIME to 1 (see the Emscripten FAQ), or make sure to emit a newline when you printf etc.");
              warnOnce("(this may also be due to not including full filesystem support - try building with -sFORCE_FILESYSTEM)");
            }
          }
          function preInit() {
            if (Module["preInit"]) {
              if (typeof Module["preInit"] == "function") Module["preInit"] = [Module["preInit"]];
              while (Module["preInit"].length > 0) {
                Module["preInit"].shift()();
              }
            }
            consumedModuleProp("preInit");
          }
          preInit();
          run();
          moduleRtn = readyPromise;
          for (const prop of Object.keys(Module)) {
            if (!(prop in moduleArg)) {
              Object.defineProperty(moduleArg, prop, {
                configurable: true,
                get() {
                  abort(`Access to module property ('${prop}') is no longer possible via the module constructor argument; Instead, use the result of the module constructor.`);
                }
              });
            }
          }
          return moduleRtn;
        });
      })();
      {
        module.exports = trace_processor_memory64_wasm;
        module.exports.default = trace_processor_memory64_wasm;
      }
    })(trace_processor_memory64);
    return trace_processor_memory64.exports;
  }
  var trace_processor_memory64Exports = requireTrace_processor_memory64();
  const TraceProcessor64 = /* @__PURE__ */ getDefaultExportFromCjs(trace_processor_memory64Exports);
  var trace_processor = { exports: {} };
  var hasRequiredTrace_processor;
  function requireTrace_processor() {
    if (hasRequiredTrace_processor) return trace_processor.exports;
    hasRequiredTrace_processor = 1;
    (function(module, exports) {
      var trace_processor_wasm = /* @__PURE__ */ (() => {
        return (async function(moduleArg = {}) {
          var moduleRtn;
          var Module = moduleArg;
          var readyPromiseResolve, readyPromiseReject;
          var readyPromise = new Promise((resolve, reject) => {
            readyPromiseResolve = resolve;
            readyPromiseReject = reject;
          });
          var arguments_ = [];
          var thisProgram = "./this.program";
          var quit_ = (status, toThrow) => {
            throw toThrow;
          };
          var _scriptName;
          {
            _scriptName = self.location.href;
          }
          var scriptDirectory = "";
          function locateFile(path) {
            if (Module["locateFile"]) {
              return Module["locateFile"](path, scriptDirectory);
            }
            return scriptDirectory + path;
          }
          var readAsync, readBinary;
          {
            try {
              scriptDirectory = new URL(".", _scriptName).href;
            } catch {
            }
            if (!(typeof window == "object" || typeof WorkerGlobalScope != "undefined")) throw new Error("not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)");
            {
              {
                readBinary = (url) => {
                  var xhr = new XMLHttpRequest();
                  xhr.open("GET", url, false);
                  xhr.responseType = "arraybuffer";
                  xhr.send(null);
                  return new Uint8Array(
                    /** @type{!ArrayBuffer} */
                    xhr.response
                  );
                };
              }
              readAsync = async (url) => {
                assert(!isFileURI(url), "readAsync does not work with file:// URLs");
                var response = await fetch(url, {
                  credentials: "same-origin"
                });
                if (response.ok) {
                  return response.arrayBuffer();
                }
                throw new Error(response.status + " : " + response.url);
              };
            }
          }
          var out = console.log.bind(console);
          var err = console.error.bind(console);
          assert(true, "web environment detected but not enabled at build time.  Add `web` to `-sENVIRONMENT` to enable.");
          assert(true, "node environment detected but not enabled at build time.  Add `node` to `-sENVIRONMENT` to enable.");
          assert(true, "shell environment detected but not enabled at build time.  Add `shell` to `-sENVIRONMENT` to enable.");
          var wasmBinary;
          if (typeof WebAssembly != "object") {
            err("no native wasm support detected");
          }
          var wasmMemory;
          var ABORT = false;
          var EXITSTATUS;
          function assert(condition, text) {
            if (!condition) {
              abort("Assertion failed" + (text ? ": " + text : ""));
            }
          }
          var HEAP8, HEAPU8, HEAP16, HEAP32, HEAPU32, HEAP64, HEAPF64;
          var runtimeInitialized = false;
          var isFileURI = (filename) => filename.startsWith("file://");
          function writeStackCookie() {
            var max = _emscripten_stack_get_end();
            assert((max & 3) == 0);
            if (max == 0) {
              max += 4;
            }
            HEAPU32[max >>> 2 >>> 0] = 34821223;
            HEAPU32[max + 4 >>> 2 >>> 0] = 2310721022;
            HEAPU32[0 >>> 2 >>> 0] = 1668509029;
          }
          function checkStackCookie() {
            if (ABORT) return;
            var max = _emscripten_stack_get_end();
            if (max == 0) {
              max += 4;
            }
            var cookie1 = HEAPU32[max >>> 2 >>> 0];
            var cookie2 = HEAPU32[max + 4 >>> 2 >>> 0];
            if (cookie1 != 34821223 || cookie2 != 2310721022) {
              abort(`Stack overflow! Stack cookie has been overwritten at ${ptrToString(max)}, expected hex dwords 0x89BACDFE and 0x2135467, but received ${ptrToString(cookie2)} ${ptrToString(cookie1)}`);
            }
            if (HEAPU32[0 >>> 2 >>> 0] != 1668509029) {
              abort("Runtime error: The application has corrupted its heap memory area (address zero)!");
            }
          }
          (() => {
            var h16 = new Int16Array(1);
            var h8 = new Int8Array(h16.buffer);
            h16[0] = 25459;
            if (h8[0] !== 115 || h8[1] !== 99) throw "Runtime error: expected the system to be little-endian! (Run with -sSUPPORT_BIG_ENDIAN to bypass)";
          })();
          function consumedModuleProp(prop) {
            if (!Object.getOwnPropertyDescriptor(Module, prop)) {
              Object.defineProperty(Module, prop, {
                configurable: true,
                set() {
                  abort(`Attempt to set \`Module.${prop}\` after it has already been processed.  This can happen, for example, when code is injected via '--post-js' rather than '--pre-js'`);
                }
              });
            }
          }
          function ignoredModuleProp(prop) {
            if (Object.getOwnPropertyDescriptor(Module, prop)) {
              abort(`\`Module.${prop}\` was supplied but \`${prop}\` not included in INCOMING_MODULE_JS_API`);
            }
          }
          function isExportedByForceFilesystem(name) {
            return name === "FS_createPath" || name === "FS_createDataFile" || name === "FS_createPreloadedFile" || name === "FS_unlink" || name === "addRunDependency" || // The old FS has some functionality that WasmFS lacks.
            name === "FS_createLazyFile" || name === "FS_createDevice" || name === "removeRunDependency";
          }
          function missingLibrarySymbol(sym) {
            unexportedRuntimeSymbol(sym);
          }
          function unexportedRuntimeSymbol(sym) {
            if (!Object.getOwnPropertyDescriptor(Module, sym)) {
              Object.defineProperty(Module, sym, {
                configurable: true,
                get() {
                  var msg = `'${sym}' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the Emscripten FAQ)`;
                  if (isExportedByForceFilesystem(sym)) {
                    msg += ". Alternatively, forcing filesystem support (-sFORCE_FILESYSTEM) can export this for you";
                  }
                  abort(msg);
                }
              });
            }
          }
          function updateMemoryViews() {
            var b = wasmMemory.buffer;
            HEAP8 = new Int8Array(b);
            HEAP16 = new Int16Array(b);
            Module["HEAPU8"] = HEAPU8 = new Uint8Array(b);
            HEAP32 = new Int32Array(b);
            HEAPU32 = new Uint32Array(b);
            HEAPF64 = new Float64Array(b);
            HEAP64 = new BigInt64Array(b);
            new BigUint64Array(b);
          }
          assert(typeof Int32Array != "undefined" && typeof Float64Array !== "undefined" && Int32Array.prototype.subarray != void 0 && Int32Array.prototype.set != void 0, "JS engine does not provide full typed array support");
          function preRun() {
            if (Module["preRun"]) {
              if (typeof Module["preRun"] == "function") Module["preRun"] = [Module["preRun"]];
              while (Module["preRun"].length) {
                addOnPreRun(Module["preRun"].shift());
              }
            }
            consumedModuleProp("preRun");
            callRuntimeCallbacks(onPreRuns);
          }
          function initRuntime() {
            assert(!runtimeInitialized);
            runtimeInitialized = true;
            checkStackCookie();
            wasmExports["__wasm_call_ctors"]();
          }
          function preMain() {
            checkStackCookie();
          }
          function postRun() {
            checkStackCookie();
            if (Module["postRun"]) {
              if (typeof Module["postRun"] == "function") Module["postRun"] = [Module["postRun"]];
              while (Module["postRun"].length) {
                addOnPostRun(Module["postRun"].shift());
              }
            }
            consumedModuleProp("postRun");
            callRuntimeCallbacks(onPostRuns);
          }
          var runDependencies = 0;
          var dependenciesFulfilled = null;
          var runDependencyTracking = {};
          var runDependencyWatcher = null;
          function addRunDependency(id) {
            var _a;
            runDependencies++;
            (_a = Module["monitorRunDependencies"]) == null ? void 0 : _a.call(Module, runDependencies);
            {
              assert(!runDependencyTracking[id]);
              runDependencyTracking[id] = 1;
              if (runDependencyWatcher === null && typeof setInterval != "undefined") {
                runDependencyWatcher = setInterval(() => {
                  if (ABORT) {
                    clearInterval(runDependencyWatcher);
                    runDependencyWatcher = null;
                    return;
                  }
                  var shown = false;
                  for (var dep in runDependencyTracking) {
                    if (!shown) {
                      shown = true;
                      err("still waiting on run dependencies:");
                    }
                    err(`dependency: ${dep}`);
                  }
                  if (shown) {
                    err("(end of list)");
                  }
                }, 1e4);
              }
            }
          }
          function removeRunDependency(id) {
            var _a;
            runDependencies--;
            (_a = Module["monitorRunDependencies"]) == null ? void 0 : _a.call(Module, runDependencies);
            {
              assert(runDependencyTracking[id]);
              delete runDependencyTracking[id];
            }
            if (runDependencies == 0) {
              if (runDependencyWatcher !== null) {
                clearInterval(runDependencyWatcher);
                runDependencyWatcher = null;
              }
              if (dependenciesFulfilled) {
                var callback = dependenciesFulfilled;
                dependenciesFulfilled = null;
                callback();
              }
            }
          }
          function abort(what) {
            var _a;
            (_a = Module["onAbort"]) == null ? void 0 : _a.call(Module, what);
            what = "Aborted(" + what + ")";
            err(what);
            ABORT = true;
            var e = new WebAssembly.RuntimeError(what);
            readyPromiseReject(e);
            throw e;
          }
          var FS = {
            error() {
              abort("Filesystem support (FS) was not included. The problem is that you are using files from JS, but files were not used from C/C++, so filesystem support was not auto-included. You can force-include filesystem support with -sFORCE_FILESYSTEM");
            },
            init() {
              FS.error();
            },
            createDataFile() {
              FS.error();
            },
            createPreloadedFile() {
              FS.error();
            },
            createLazyFile() {
              FS.error();
            },
            open() {
              FS.error();
            },
            mkdev() {
              FS.error();
            },
            registerDevice() {
              FS.error();
            },
            analyzePath() {
              FS.error();
            },
            ErrnoError() {
              FS.error();
            }
          };
          function createExportWrapper(name, nargs) {
            return (...args) => {
              assert(runtimeInitialized, `native function \`${name}\` called before runtime initialization`);
              var f = wasmExports[name];
              assert(f, `exported native function \`${name}\` not found`);
              assert(args.length <= nargs, `native function \`${name}\` called with ${args.length} args but expects ${nargs}`);
              return f(...args);
            };
          }
          var wasmBinaryFile;
          function findWasmBinary() {
            return locateFile("trace_processor.wasm");
          }
          function getBinarySync(file) {
            if (file == wasmBinaryFile && wasmBinary) {
              return new Uint8Array(wasmBinary);
            }
            if (readBinary) {
              return readBinary(file);
            }
            throw "both async and sync fetching of the wasm failed";
          }
          async function getWasmBinary(binaryFile) {
            if (!wasmBinary) {
              try {
                var response = await readAsync(binaryFile);
                return new Uint8Array(response);
              } catch {
              }
            }
            return getBinarySync(binaryFile);
          }
          async function instantiateArrayBuffer(binaryFile, imports) {
            try {
              var binary = await getWasmBinary(binaryFile);
              var instance = await WebAssembly.instantiate(binary, imports);
              return instance;
            } catch (reason) {
              err(`failed to asynchronously prepare wasm: ${reason}`);
              if (isFileURI(wasmBinaryFile)) {
                err(`warning: Loading from a file URI (${wasmBinaryFile}) is not supported in most browsers. See https://emscripten.org/docs/getting_started/FAQ.html#how-do-i-run-a-local-webserver-for-testing-why-does-my-program-stall-in-downloading-or-preparing`);
              }
              abort(reason);
            }
          }
          async function instantiateAsync(binary, binaryFile, imports) {
            if (!binary && typeof WebAssembly.instantiateStreaming == "function") {
              try {
                var response = fetch(binaryFile, {
                  credentials: "same-origin"
                });
                var instantiationResult = await WebAssembly.instantiateStreaming(response, imports);
                return instantiationResult;
              } catch (reason) {
                err(`wasm streaming compile failed: ${reason}`);
                err("falling back to ArrayBuffer instantiation");
              }
            }
            return instantiateArrayBuffer(binaryFile, imports);
          }
          function getWasmImports() {
            return {
              "env": wasmImports,
              "wasi_snapshot_preview1": wasmImports
            };
          }
          async function createWasm() {
            function receiveInstance(instance, module2) {
              wasmExports = instance.exports;
              wasmExports = applySignatureConversions(wasmExports);
              wasmMemory = wasmExports["memory"];
              assert(wasmMemory, "memory not found in wasm exports");
              updateMemoryViews();
              wasmTable = wasmExports["__indirect_function_table"];
              assert(wasmTable, "table not found in wasm exports");
              removeRunDependency("wasm-instantiate");
              return wasmExports;
            }
            addRunDependency("wasm-instantiate");
            var trueModule = Module;
            function receiveInstantiationResult(result2) {
              assert(Module === trueModule, "the Module object should not be replaced during async compilation - perhaps the order of HTML elements is wrong?");
              trueModule = null;
              return receiveInstance(result2["instance"]);
            }
            var info = getWasmImports();
            if (Module["instantiateWasm"]) {
              return new Promise((resolve, reject) => {
                try {
                  Module["instantiateWasm"](info, (mod, inst) => {
                    resolve(receiveInstance(mod, inst));
                  });
                } catch (e) {
                  err(`Module.instantiateWasm callback failed with error: ${e}`);
                  reject(e);
                }
              });
            }
            wasmBinaryFile ?? (wasmBinaryFile = findWasmBinary());
            try {
              var result = await instantiateAsync(wasmBinary, wasmBinaryFile, info);
              var exports2 = receiveInstantiationResult(result);
              return exports2;
            } catch (e) {
              readyPromiseReject(e);
              return Promise.reject(e);
            }
          }
          class ExitStatus {
            constructor(status) {
              __publicField(this, "name", "ExitStatus");
              this.message = `Program terminated with exit(${status})`;
              this.status = status;
            }
          }
          var callRuntimeCallbacks = (callbacks) => {
            while (callbacks.length > 0) {
              callbacks.shift()(Module);
            }
          };
          var onPostRuns = [];
          var addOnPostRun = (cb) => onPostRuns.push(cb);
          var onPreRuns = [];
          var addOnPreRun = (cb) => onPreRuns.push(cb);
          var noExitRuntime = true;
          var ptrToString = (ptr) => {
            assert(typeof ptr === "number");
            return "0x" + ptr.toString(16).padStart(8, "0");
          };
          var stackRestore = (val) => __emscripten_stack_restore(val);
          var stackSave = () => _emscripten_stack_get_current();
          var warnOnce = (text) => {
            warnOnce.shown || (warnOnce.shown = {});
            if (!warnOnce.shown[text]) {
              warnOnce.shown[text] = 1;
              err(text);
            }
          };
          var UTF8Decoder = typeof TextDecoder != "undefined" ? new TextDecoder() : void 0;
          var UTF8ArrayToString = (heapOrArray, idx = 0, maxBytesToRead = NaN) => {
            idx >>>= 0;
            var endIdx = idx + maxBytesToRead;
            var endPtr = idx;
            while (heapOrArray[endPtr] && !(endPtr >= endIdx)) ++endPtr;
            if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) {
              return UTF8Decoder.decode(heapOrArray.subarray(idx, endPtr));
            }
            var str = "";
            while (idx < endPtr) {
              var u0 = heapOrArray[idx++];
              if (!(u0 & 128)) {
                str += String.fromCharCode(u0);
                continue;
              }
              var u1 = heapOrArray[idx++] & 63;
              if ((u0 & 224) == 192) {
                str += String.fromCharCode((u0 & 31) << 6 | u1);
                continue;
              }
              var u2 = heapOrArray[idx++] & 63;
              if ((u0 & 240) == 224) {
                u0 = (u0 & 15) << 12 | u1 << 6 | u2;
              } else {
                if ((u0 & 248) != 240) warnOnce("Invalid UTF-8 leading byte " + ptrToString(u0) + " encountered when deserializing a UTF-8 string in wasm memory to a JS string!");
                u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | heapOrArray[idx++] & 63;
              }
              if (u0 < 65536) {
                str += String.fromCharCode(u0);
              } else {
                var ch = u0 - 65536;
                str += String.fromCharCode(55296 | ch >> 10, 56320 | ch & 1023);
              }
            }
            return str;
          };
          var UTF8ToString = (ptr, maxBytesToRead) => {
            assert(typeof ptr == "number", `UTF8ToString expects a number (got ${typeof ptr})`);
            ptr >>>= 0;
            return ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead) : "";
          };
          var INT53_MAX = 9007199254740992;
          var INT53_MIN = -9007199254740992;
          var bigintToI53Checked = (num) => num < INT53_MIN || num > INT53_MAX ? NaN : Number(num);
          function ___syscall_chmod(path, mode) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function ___syscall_faccessat(dirfd, path, amode, flags) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          var ___syscall_fchmod = (fd, mode) => {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          };
          var ___syscall_fchown32 = (fd, owner, group) => {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          };
          function ___syscall_fcntl64(fd, cmd, varargs) {
            return 0;
          }
          function ___syscall_fstat64(fd, buf) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function ___syscall_ftruncate64(fd, length) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function ___syscall_getcwd(buf, size) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function ___syscall_ioctl(fd, op, varargs) {
            return 0;
          }
          function ___syscall_lstat64(path, buf) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function ___syscall_mkdirat(dirfd, path, mode) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function ___syscall_newfstatat(dirfd, path, buf, flags) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function ___syscall_openat(dirfd, path, flags, varargs) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function ___syscall_readlinkat(dirfd, path, buf, bufsize) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function ___syscall_rmdir(path) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function ___syscall_stat64(path, buf) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function ___syscall_unlinkat(dirfd, path, flags) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function ___syscall_utimensat(dirfd, path, times, flags) {
            abort("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
          }
          var __abort_js = () => abort("native code called abort()");
          function __gmtime_js(time, tmPtr) {
            time = bigintToI53Checked(time);
            tmPtr >>>= 0;
            var date = new Date(time * 1e3);
            HEAP32[tmPtr >>> 2 >>> 0] = date.getUTCSeconds();
            HEAP32[tmPtr + 4 >>> 2 >>> 0] = date.getUTCMinutes();
            HEAP32[tmPtr + 8 >>> 2 >>> 0] = date.getUTCHours();
            HEAP32[tmPtr + 12 >>> 2 >>> 0] = date.getUTCDate();
            HEAP32[tmPtr + 16 >>> 2 >>> 0] = date.getUTCMonth();
            HEAP32[tmPtr + 20 >>> 2 >>> 0] = date.getUTCFullYear() - 1900;
            HEAP32[tmPtr + 24 >>> 2 >>> 0] = date.getUTCDay();
            var start = Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
            var yday = (date.getTime() - start) / (1e3 * 60 * 60 * 24) | 0;
            HEAP32[tmPtr + 28 >>> 2 >>> 0] = yday;
          }
          var isLeapYear = (year) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
          var MONTH_DAYS_LEAP_CUMULATIVE = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
          var MONTH_DAYS_REGULAR_CUMULATIVE = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
          var ydayFromDate = (date) => {
            var leap = isLeapYear(date.getFullYear());
            var monthDaysCumulative = leap ? MONTH_DAYS_LEAP_CUMULATIVE : MONTH_DAYS_REGULAR_CUMULATIVE;
            var yday = monthDaysCumulative[date.getMonth()] + date.getDate() - 1;
            return yday;
          };
          function __localtime_js(time, tmPtr) {
            time = bigintToI53Checked(time);
            tmPtr >>>= 0;
            var date = new Date(time * 1e3);
            HEAP32[tmPtr >>> 2 >>> 0] = date.getSeconds();
            HEAP32[tmPtr + 4 >>> 2 >>> 0] = date.getMinutes();
            HEAP32[tmPtr + 8 >>> 2 >>> 0] = date.getHours();
            HEAP32[tmPtr + 12 >>> 2 >>> 0] = date.getDate();
            HEAP32[tmPtr + 16 >>> 2 >>> 0] = date.getMonth();
            HEAP32[tmPtr + 20 >>> 2 >>> 0] = date.getFullYear() - 1900;
            HEAP32[tmPtr + 24 >>> 2 >>> 0] = date.getDay();
            var yday = ydayFromDate(date) | 0;
            HEAP32[tmPtr + 28 >>> 2 >>> 0] = yday;
            HEAP32[tmPtr + 36 >>> 2 >>> 0] = -(date.getTimezoneOffset() * 60);
            var start = new Date(date.getFullYear(), 0, 1);
            var summerOffset = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
            var winterOffset = start.getTimezoneOffset();
            var dst = (summerOffset != winterOffset && date.getTimezoneOffset() == Math.min(winterOffset, summerOffset)) | 0;
            HEAP32[tmPtr + 32 >>> 2 >>> 0] = dst;
          }
          function __mmap_js(len, prot, flags, fd, offset, allocated, addr) {
            return -52;
          }
          function __munmap_js(addr, len, prot, flags, fd, offset) {
          }
          var __timegm_js = function(tmPtr) {
            tmPtr >>>= 0;
            var ret = (() => {
              var time = Date.UTC(HEAP32[tmPtr + 20 >>> 2 >>> 0] + 1900, HEAP32[tmPtr + 16 >>> 2 >>> 0], HEAP32[tmPtr + 12 >>> 2 >>> 0], HEAP32[tmPtr + 8 >>> 2 >>> 0], HEAP32[tmPtr + 4 >>> 2 >>> 0], HEAP32[tmPtr >>> 2 >>> 0], 0);
              var date = new Date(time);
              HEAP32[tmPtr + 24 >>> 2 >>> 0] = date.getUTCDay();
              var start = Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
              var yday = (date.getTime() - start) / (1e3 * 60 * 60 * 24) | 0;
              HEAP32[tmPtr + 28 >>> 2 >>> 0] = yday;
              return date.getTime() / 1e3;
            })();
            return BigInt(ret);
          };
          var stringToUTF8Array = (str, heap, outIdx, maxBytesToWrite) => {
            outIdx >>>= 0;
            assert(typeof str === "string", `stringToUTF8Array expects a string (got ${typeof str})`);
            if (!(maxBytesToWrite > 0)) return 0;
            var startIdx = outIdx;
            var endIdx = outIdx + maxBytesToWrite - 1;
            for (var i = 0; i < str.length; ++i) {
              var u = str.charCodeAt(i);
              if (u >= 55296 && u <= 57343) {
                var u1 = str.charCodeAt(++i);
                u = 65536 + ((u & 1023) << 10) | u1 & 1023;
              }
              if (u <= 127) {
                if (outIdx >= endIdx) break;
                heap[outIdx++ >>> 0] = u;
              } else if (u <= 2047) {
                if (outIdx + 1 >= endIdx) break;
                heap[outIdx++ >>> 0] = 192 | u >> 6;
                heap[outIdx++ >>> 0] = 128 | u & 63;
              } else if (u <= 65535) {
                if (outIdx + 2 >= endIdx) break;
                heap[outIdx++ >>> 0] = 224 | u >> 12;
                heap[outIdx++ >>> 0] = 128 | u >> 6 & 63;
                heap[outIdx++ >>> 0] = 128 | u & 63;
              } else {
                if (outIdx + 3 >= endIdx) break;
                if (u > 1114111) warnOnce("Invalid Unicode code point " + ptrToString(u) + " encountered when serializing a JS string to a UTF-8 string in wasm memory! (Valid unicode code points should be in range 0-0x10FFFF).");
                heap[outIdx++ >>> 0] = 240 | u >> 18;
                heap[outIdx++ >>> 0] = 128 | u >> 12 & 63;
                heap[outIdx++ >>> 0] = 128 | u >> 6 & 63;
                heap[outIdx++ >>> 0] = 128 | u & 63;
              }
            }
            heap[outIdx >>> 0] = 0;
            return outIdx - startIdx;
          };
          var stringToUTF8 = (str, outPtr, maxBytesToWrite) => {
            assert(typeof maxBytesToWrite == "number", "stringToUTF8(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!");
            return stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite);
          };
          var lengthBytesUTF8 = (str) => {
            var len = 0;
            for (var i = 0; i < str.length; ++i) {
              var c = str.charCodeAt(i);
              if (c <= 127) {
                len++;
              } else if (c <= 2047) {
                len += 2;
              } else if (c >= 55296 && c <= 57343) {
                len += 4;
                ++i;
              } else {
                len += 3;
              }
            }
            return len;
          };
          var __tzset_js = function(timezone, daylight, std_name, dst_name) {
            timezone >>>= 0;
            daylight >>>= 0;
            std_name >>>= 0;
            dst_name >>>= 0;
            var currentYear = (/* @__PURE__ */ new Date()).getFullYear();
            var winter = new Date(currentYear, 0, 1);
            var summer = new Date(currentYear, 6, 1);
            var winterOffset = winter.getTimezoneOffset();
            var summerOffset = summer.getTimezoneOffset();
            var stdTimezoneOffset = Math.max(winterOffset, summerOffset);
            HEAPU32[timezone >>> 2 >>> 0] = stdTimezoneOffset * 60;
            HEAP32[daylight >>> 2 >>> 0] = Number(winterOffset != summerOffset);
            var extractZone = (timezoneOffset) => {
              var sign = timezoneOffset >= 0 ? "-" : "+";
              var absOffset = Math.abs(timezoneOffset);
              var hours = String(Math.floor(absOffset / 60)).padStart(2, "0");
              var minutes = String(absOffset % 60).padStart(2, "0");
              return `UTC${sign}${hours}${minutes}`;
            };
            var winterName = extractZone(winterOffset);
            var summerName = extractZone(summerOffset);
            assert(winterName);
            assert(summerName);
            assert(lengthBytesUTF8(winterName) <= 16, `timezone name truncated to fit in TZNAME_MAX (${winterName})`);
            assert(lengthBytesUTF8(summerName) <= 16, `timezone name truncated to fit in TZNAME_MAX (${summerName})`);
            if (summerOffset < winterOffset) {
              stringToUTF8(winterName, std_name, 17);
              stringToUTF8(summerName, dst_name, 17);
            } else {
              stringToUTF8(winterName, dst_name, 17);
              stringToUTF8(summerName, std_name, 17);
            }
          };
          var _emscripten_get_now = () => performance.now();
          var _emscripten_date_now = () => Date.now();
          var checkWasiClock = (clock_id) => clock_id >= 0 && clock_id <= 3;
          function _clock_time_get(clk_id, ignored_precision, ptime) {
            ptime >>>= 0;
            if (!checkWasiClock(clk_id)) {
              return 28;
            }
            var now;
            if (clk_id === 0) {
              now = _emscripten_date_now();
            } else {
              now = _emscripten_get_now();
            }
            var nsec = Math.round(now * 1e3 * 1e3);
            HEAP64[ptime >>> 3] = BigInt(nsec);
            return 0;
          }
          var readEmAsmArgsArray = [];
          var readEmAsmArgs = (sigPtr, buf) => {
            assert(Array.isArray(readEmAsmArgsArray));
            assert(buf % 16 == 0);
            readEmAsmArgsArray.length = 0;
            var ch;
            while (ch = HEAPU8[sigPtr++ >>> 0]) {
              var chr = String.fromCharCode(ch);
              var validChars = ["d", "f", "i", "p"];
              validChars.push("j");
              assert(validChars.includes(chr), `Invalid character ${ch}("${chr}") in readEmAsmArgs! Use only [${validChars}], and do not specify "v" for void return argument.`);
              var wide = ch != 105;
              wide &= ch != 112;
              buf += wide && buf % 8 ? 4 : 0;
              readEmAsmArgsArray.push(
                // Special case for pointers under wasm64 or CAN_ADDRESS_2GB mode.
                ch == 112 ? HEAPU32[buf >>> 2 >>> 0] : ch == 106 ? HEAP64[buf >>> 3] : ch == 105 ? HEAP32[buf >>> 2 >>> 0] : HEAPF64[buf >>> 3 >>> 0]
              );
              buf += wide ? 8 : 4;
            }
            return readEmAsmArgsArray;
          };
          var runEmAsmFunction = (code, sigPtr, argbuf) => {
            var args = readEmAsmArgs(sigPtr, argbuf);
            assert(ASM_CONSTS.hasOwnProperty(code), `No EM_ASM constant found at address ${code}.  The loaded WebAssembly file is likely out of sync with the generated JavaScript.`);
            return ASM_CONSTS[code](...args);
          };
          function _emscripten_asm_const_int(code, sigPtr, argbuf) {
            code >>>= 0;
            sigPtr >>>= 0;
            argbuf >>>= 0;
            return runEmAsmFunction(code, sigPtr, argbuf);
          }
          function _emscripten_err(str) {
            str >>>= 0;
            return err(UTF8ToString(str));
          }
          function _emscripten_errn(str, len) {
            str >>>= 0;
            len >>>= 0;
            return err(UTF8ToString(str, len));
          }
          var getHeapMax = () => (
            // Stay one Wasm page short of 4GB: while e.g. Chrome is able to allocate
            // full 4GB Wasm memories, the size will wrap back to 0 bytes in Wasm side
            // for any code that deals with heap sizes, which would require special
            // casing all heap size related code to treat 0 specially.
            4294901760
          );
          function _emscripten_get_heap_max() {
            return getHeapMax();
          }
          function _emscripten_pc_get_function(pc) {
            abort("Cannot use emscripten_pc_get_function without -sUSE_OFFSET_CONVERTER");
            return 0;
          }
          var alignMemory = (size, alignment) => {
            assert(alignment, "alignment argument is required");
            return Math.ceil(size / alignment) * alignment;
          };
          var growMemory = (size) => {
            var b = wasmMemory.buffer;
            var pages = (size - b.byteLength + 65535) / 65536 | 0;
            try {
              wasmMemory.grow(pages);
              updateMemoryViews();
              return 1;
            } catch (e) {
              err(`growMemory: Attempted to grow heap from ${b.byteLength} bytes to ${size} bytes, but got error: ${e}`);
            }
          };
          function _emscripten_resize_heap(requestedSize) {
            requestedSize >>>= 0;
            var oldSize = HEAPU8.length;
            assert(requestedSize > oldSize);
            var maxHeapSize = getHeapMax();
            if (requestedSize > maxHeapSize) {
              err(`Cannot enlarge memory, requested ${requestedSize} bytes, but the limit is ${maxHeapSize} bytes!`);
              return false;
            }
            for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
              var overGrownHeapSize = oldSize * (1 + 0.2 / cutDown);
              overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
              var newSize = Math.min(maxHeapSize, alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536));
              var replacement = growMemory(newSize);
              if (replacement) {
                return true;
              }
            }
            err(`Failed to grow the heap from ${oldSize} bytes to ${newSize} bytes, not enough memory!`);
            return false;
          }
          var convertFrameToPC = (frame) => {
            abort("Cannot use convertFrameToPC (needed by __builtin_return_address) without -sUSE_OFFSET_CONVERTER");
            return 0;
          };
          var UNWIND_CACHE = {};
          var saveInUnwindCache = (callstack) => {
            callstack.forEach((frame) => {
              convertFrameToPC();
            });
          };
          var jsStackTrace = () => new Error().stack.toString();
          function _emscripten_stack_snapshot() {
            var callstack = jsStackTrace().split("\n");
            if (callstack[0] == "Error") {
              callstack.shift();
            }
            saveInUnwindCache(callstack);
            UNWIND_CACHE.last_addr = convertFrameToPC(callstack[3]);
            UNWIND_CACHE.last_stack = callstack;
            return UNWIND_CACHE.last_addr;
          }
          function _emscripten_stack_unwind_buffer(addr, buffer, count) {
            addr >>>= 0;
            buffer >>>= 0;
            var stack;
            if (UNWIND_CACHE.last_addr == addr) {
              stack = UNWIND_CACHE.last_stack;
            } else {
              stack = jsStackTrace().split("\n");
              if (stack[0] == "Error") {
                stack.shift();
              }
              saveInUnwindCache(stack);
            }
            var offset = 3;
            while (stack[offset] && convertFrameToPC(stack[offset]) != addr) {
              ++offset;
            }
            for (var i = 0; i < count && stack[i + offset]; ++i) {
              HEAP32[buffer + i * 4 >>> 2 >>> 0] = convertFrameToPC(stack[i + offset]);
            }
            return i;
          }
          var ENV = {};
          var getExecutableName = () => thisProgram || "./this.program";
          var getEnvStrings = () => {
            if (!getEnvStrings.strings) {
              var lang = (typeof navigator == "object" && navigator.languages && navigator.languages[0] || "C").replace("-", "_") + ".UTF-8";
              var env = {
                "USER": "web_user",
                "LOGNAME": "web_user",
                "PATH": "/",
                "PWD": "/",
                "HOME": "/home/web_user",
                "LANG": lang,
                "_": getExecutableName()
              };
              for (var x in ENV) {
                if (ENV[x] === void 0) delete env[x];
                else env[x] = ENV[x];
              }
              var strings = [];
              for (var x in env) {
                strings.push(`${x}=${env[x]}`);
              }
              getEnvStrings.strings = strings;
            }
            return getEnvStrings.strings;
          };
          function _environ_get(__environ, environ_buf) {
            __environ >>>= 0;
            environ_buf >>>= 0;
            var bufSize = 0;
            var envp = 0;
            for (var string of getEnvStrings()) {
              var ptr = environ_buf + bufSize;
              HEAPU32[__environ + envp >>> 2 >>> 0] = ptr;
              bufSize += stringToUTF8(string, ptr, Infinity) + 1;
              envp += 4;
            }
            return 0;
          }
          function _environ_sizes_get(penviron_count, penviron_buf_size) {
            penviron_count >>>= 0;
            penviron_buf_size >>>= 0;
            var strings = getEnvStrings();
            HEAPU32[penviron_count >>> 2 >>> 0] = strings.length;
            var bufSize = 0;
            for (var string of strings) {
              bufSize += lengthBytesUTF8(string) + 1;
            }
            HEAPU32[penviron_buf_size >>> 2 >>> 0] = bufSize;
            return 0;
          }
          var runtimeKeepaliveCounter = 0;
          var keepRuntimeAlive = () => noExitRuntime || runtimeKeepaliveCounter > 0;
          var _proc_exit = (code) => {
            var _a;
            EXITSTATUS = code;
            if (!keepRuntimeAlive()) {
              (_a = Module["onExit"]) == null ? void 0 : _a.call(Module, code);
              ABORT = true;
            }
            quit_(code, new ExitStatus(code));
          };
          var exitJS = (status, implicit) => {
            EXITSTATUS = status;
            checkUnflushedContent();
            if (keepRuntimeAlive() && !implicit) {
              var msg = `program exited (with status: ${status}), but keepRuntimeAlive() is set (counter=${runtimeKeepaliveCounter}) due to an async operation, so halting execution but not exiting the runtime or preventing further async execution (you can use emscripten_force_exit, if you want to force a true shutdown)`;
              readyPromiseReject(msg);
              err(msg);
            }
            _proc_exit(status);
          };
          var _exit = exitJS;
          var _fd_close = (fd) => {
            abort("fd_close called without SYSCALLS_REQUIRE_FILESYSTEM");
          };
          function _fd_fdstat_get(fd, pbuf) {
            pbuf >>>= 0;
            var rightsBase = 0;
            var rightsInheriting = 0;
            var flags = 0;
            {
              assert(fd == 0 || fd == 1 || fd == 2);
              var type = 2;
              if (fd == 0) {
                rightsBase = 2;
              } else if (fd == 1 || fd == 2) {
                rightsBase = 64;
              }
              flags = 1;
            }
            HEAP8[pbuf >>> 0] = type;
            HEAP16[pbuf + 2 >>> 1 >>> 0] = flags;
            HEAP64[pbuf + 8 >>> 3] = BigInt(rightsBase);
            HEAP64[pbuf + 16 >>> 3] = BigInt(rightsInheriting);
            return 0;
          }
          function _fd_read(fd, iov, iovcnt, pnum) {
            abort("fd_read called without SYSCALLS_REQUIRE_FILESYSTEM");
          }
          function _fd_seek(fd, offset, whence, newOffset) {
            return 70;
          }
          var _fd_sync = (fd) => {
            abort("fd_sync called without SYSCALLS_REQUIRE_FILESYSTEM");
          };
          var printCharBuffers = [null, [], []];
          var printChar = (stream, curr) => {
            var buffer = printCharBuffers[stream];
            assert(buffer);
            if (curr === 0 || curr === 10) {
              (stream === 1 ? out : err)(UTF8ArrayToString(buffer));
              buffer.length = 0;
            } else {
              buffer.push(curr);
            }
          };
          var flush_NO_FILESYSTEM = () => {
            _fflush(0);
            if (printCharBuffers[1].length) printChar(1, 10);
            if (printCharBuffers[2].length) printChar(2, 10);
          };
          function _fd_write(fd, iov, iovcnt, pnum) {
            iov >>>= 0;
            iovcnt >>>= 0;
            pnum >>>= 0;
            var num = 0;
            for (var i = 0; i < iovcnt; i++) {
              var ptr = HEAPU32[iov >>> 2 >>> 0];
              var len = HEAPU32[iov + 4 >>> 2 >>> 0];
              iov += 8;
              for (var j = 0; j < len; j++) {
                printChar(fd, HEAPU8[ptr + j >>> 0]);
              }
              num += len;
            }
            HEAPU32[pnum >>> 2 >>> 0] = num;
            return 0;
          }
          var handleException = (e) => {
            if (e instanceof ExitStatus || e == "unwind") {
              return EXITSTATUS;
            }
            checkStackCookie();
            if (e instanceof WebAssembly.RuntimeError) {
              if (_emscripten_stack_get_current() <= 0) {
                err("Stack overflow detected.  You can try increasing -sSTACK_SIZE (currently set to 2097152)");
              }
            }
            quit_(1, e);
          };
          var stackAlloc = (sz) => __emscripten_stack_alloc(sz);
          var stringToUTF8OnStack = (str) => {
            var size = lengthBytesUTF8(str) + 1;
            var ret = stackAlloc(size);
            stringToUTF8(str, ret, size);
            return ret;
          };
          var getCFunc = (ident) => {
            var func = Module["_" + ident];
            assert(func, "Cannot call unknown function " + ident + ", make sure it is exported");
            return func;
          };
          var writeArrayToMemory = (array, buffer) => {
            assert(array.length >= 0, "writeArrayToMemory array must have a length (should be an array or typed array)");
            HEAP8.set(array, buffer >>> 0);
          };
          var ccall = (ident, returnType, argTypes, args, opts) => {
            var toC = {
              "string": (str) => {
                var ret2 = 0;
                if (str !== null && str !== void 0 && str !== 0) {
                  ret2 = stringToUTF8OnStack(str);
                }
                return ret2;
              },
              "array": (arr) => {
                var ret2 = stackAlloc(arr.length);
                writeArrayToMemory(arr, ret2);
                return ret2;
              }
            };
            function convertReturnValue(ret2) {
              if (returnType === "string") {
                return UTF8ToString(ret2);
              }
              if (returnType === "boolean") return Boolean(ret2);
              return ret2;
            }
            var func = getCFunc(ident);
            var cArgs = [];
            var stack = 0;
            assert(returnType !== "array", 'Return type should not be "array".');
            if (args) {
              for (var i = 0; i < args.length; i++) {
                var converter = toC[argTypes[i]];
                if (converter) {
                  if (stack === 0) stack = stackSave();
                  cArgs[i] = converter(args[i]);
                } else {
                  cArgs[i] = args[i];
                }
              }
            }
            var ret = func(...cArgs);
            function onDone(ret2) {
              if (stack !== 0) stackRestore(stack);
              return convertReturnValue(ret2);
            }
            ret = onDone(ret);
            return ret;
          };
          var uleb128Encode = (n, target) => {
            assert(n < 16384);
            if (n < 128) {
              target.push(n);
            } else {
              target.push(n % 128 | 128, n >> 7);
            }
          };
          var sigToWasmTypes = (sig) => {
            var typeNames = {
              "i": "i32",
              "j": "i64",
              "f": "f32",
              "d": "f64",
              "e": "externref",
              "p": "i32"
            };
            var type = {
              parameters: [],
              results: sig[0] == "v" ? [] : [typeNames[sig[0]]]
            };
            for (var i = 1; i < sig.length; ++i) {
              assert(sig[i] in typeNames, "invalid signature char: " + sig[i]);
              type.parameters.push(typeNames[sig[i]]);
            }
            return type;
          };
          var generateFuncType = (sig, target) => {
            var sigRet = sig.slice(0, 1);
            var sigParam = sig.slice(1);
            var typeCodes = {
              "i": 127,
              // i32
              "p": 127,
              // i32
              "j": 126,
              // i64
              "f": 125,
              // f32
              "d": 124,
              // f64
              "e": 111
            };
            target.push(96);
            uleb128Encode(sigParam.length, target);
            for (var paramType of sigParam) {
              assert(paramType in typeCodes, `invalid signature char: ${paramType}`);
              target.push(typeCodes[paramType]);
            }
            if (sigRet == "v") {
              target.push(0);
            } else {
              target.push(1, typeCodes[sigRet]);
            }
          };
          var convertJsFunctionToWasm = (func, sig) => {
            if (typeof WebAssembly.Function == "function") {
              return new WebAssembly.Function(sigToWasmTypes(sig), func);
            }
            var typeSectionBody = [1];
            generateFuncType(sig, typeSectionBody);
            var bytes = [
              0,
              97,
              115,
              109,
              // magic ("\0asm")
              1,
              0,
              0,
              0,
              // version: 1
              1
            ];
            uleb128Encode(typeSectionBody.length, bytes);
            bytes.push(...typeSectionBody);
            bytes.push(
              2,
              7,
              // import section
              // (import "e" "f" (func 0 (type 0)))
              1,
              1,
              101,
              1,
              102,
              0,
              0,
              7,
              5,
              // export section
              // (export "f" (func 0 (type 0)))
              1,
              1,
              102,
              0,
              0
            );
            var module2 = new WebAssembly.Module(new Uint8Array(bytes));
            var instance = new WebAssembly.Instance(module2, {
              "e": {
                "f": func
              }
            });
            var wrappedFunc = instance.exports["f"];
            return wrappedFunc;
          };
          var wasmTableMirror = [];
          var wasmTable;
          var getWasmTableEntry = (funcPtr) => {
            var func = wasmTableMirror[funcPtr];
            if (!func) {
              wasmTableMirror[funcPtr] = func = wasmTable.get(funcPtr);
            }
            assert(wasmTable.get(funcPtr) == func, "JavaScript-side Wasm function table mirror is out of date!");
            return func;
          };
          var updateTableMap = (offset, count) => {
            if (functionsInTableMap) {
              for (var i = offset; i < offset + count; i++) {
                var item = getWasmTableEntry(i);
                if (item) {
                  functionsInTableMap.set(item, i);
                }
              }
            }
          };
          var functionsInTableMap;
          var getFunctionAddress = (func) => {
            if (!functionsInTableMap) {
              functionsInTableMap = /* @__PURE__ */ new WeakMap();
              updateTableMap(0, wasmTable.length);
            }
            return functionsInTableMap.get(func) || 0;
          };
          var freeTableIndexes = [];
          var getEmptyTableSlot = () => {
            if (freeTableIndexes.length) {
              return freeTableIndexes.pop();
            }
            try {
              wasmTable.grow(1);
            } catch (err2) {
              if (!(err2 instanceof RangeError)) {
                throw err2;
              }
              throw "Unable to grow wasm table. Set ALLOW_TABLE_GROWTH.";
            }
            return wasmTable.length - 1;
          };
          var setWasmTableEntry = (idx, func) => {
            wasmTable.set(idx, func);
            wasmTableMirror[idx] = wasmTable.get(idx);
          };
          var addFunction = (func, sig) => {
            assert(typeof func != "undefined");
            var rtn = getFunctionAddress(func);
            if (rtn) {
              return rtn;
            }
            var ret = getEmptyTableSlot();
            try {
              setWasmTableEntry(ret, func);
            } catch (err2) {
              if (!(err2 instanceof TypeError)) {
                throw err2;
              }
              assert(typeof sig != "undefined", "Missing signature argument to addFunction: " + func);
              var wrapped = convertJsFunctionToWasm(func, sig);
              setWasmTableEntry(ret, wrapped);
            }
            functionsInTableMap.set(func, ret);
            return ret;
          };
          {
            if (Module["noExitRuntime"]) noExitRuntime = Module["noExitRuntime"];
            if (Module["print"]) out = Module["print"];
            if (Module["printErr"]) err = Module["printErr"];
            if (Module["wasmBinary"]) wasmBinary = Module["wasmBinary"];
            Module["FS_createDataFile"] = FS.createDataFile;
            Module["FS_createPreloadedFile"] = FS.createPreloadedFile;
            checkIncomingModuleAPI();
            if (Module["arguments"]) arguments_ = Module["arguments"];
            if (Module["thisProgram"]) thisProgram = Module["thisProgram"];
            assert(typeof Module["memoryInitializerPrefixURL"] == "undefined", "Module.memoryInitializerPrefixURL option was removed, use Module.locateFile instead");
            assert(typeof Module["pthreadMainPrefixURL"] == "undefined", "Module.pthreadMainPrefixURL option was removed, use Module.locateFile instead");
            assert(typeof Module["cdInitializerPrefixURL"] == "undefined", "Module.cdInitializerPrefixURL option was removed, use Module.locateFile instead");
            assert(typeof Module["filePackagePrefixURL"] == "undefined", "Module.filePackagePrefixURL option was removed, use Module.locateFile instead");
            assert(typeof Module["read"] == "undefined", "Module.read option was removed");
            assert(typeof Module["readAsync"] == "undefined", "Module.readAsync option was removed (modify readAsync in JS)");
            assert(typeof Module["readBinary"] == "undefined", "Module.readBinary option was removed (modify readBinary in JS)");
            assert(typeof Module["setWindowTitle"] == "undefined", "Module.setWindowTitle option was removed (modify emscripten_set_window_title in JS)");
            assert(typeof Module["TOTAL_MEMORY"] == "undefined", "Module.TOTAL_MEMORY has been renamed Module.INITIAL_MEMORY");
            assert(typeof Module["ENVIRONMENT"] == "undefined", "Module.ENVIRONMENT has been deprecated. To force the environment, use the ENVIRONMENT compile-time option (for example, -sENVIRONMENT=web or -sENVIRONMENT=node)");
            assert(typeof Module["STACK_SIZE"] == "undefined", "STACK_SIZE can no longer be set at runtime.  Use -sSTACK_SIZE at link time");
            assert(typeof Module["wasmMemory"] == "undefined", "Use of `wasmMemory` detected.  Use -sIMPORTED_MEMORY to define wasmMemory externally");
            assert(typeof Module["INITIAL_MEMORY"] == "undefined", "Detected runtime INITIAL_MEMORY setting.  Use -sIMPORTED_MEMORY to define wasmMemory dynamically");
          }
          Module["callMain"] = callMain;
          Module["ccall"] = ccall;
          Module["addFunction"] = addFunction;
          var missingLibrarySymbols = ["writeI53ToI64", "writeI53ToI64Clamped", "writeI53ToI64Signaling", "writeI53ToU64Clamped", "writeI53ToU64Signaling", "readI53FromI64", "readI53FromU64", "convertI32PairToI53", "convertI32PairToI53Checked", "convertU32PairToI53", "getTempRet0", "setTempRet0", "zeroMemory", "strError", "inetPton4", "inetNtop4", "inetPton6", "inetNtop6", "readSockaddr", "writeSockaddr", "emscriptenLog", "runMainThreadEmAsm", "jstoi_q", "listenOnce", "autoResumeAudioContext", "getDynCaller", "dynCall", "runtimeKeepalivePush", "runtimeKeepalivePop", "callUserCallback", "maybeExit", "asmjsMangle", "asyncLoad", "mmapAlloc", "HandleAllocator", "getNativeTypeSize", "addOnInit", "addOnPostCtor", "addOnPreMain", "addOnExit", "STACK_SIZE", "STACK_ALIGN", "POINTER_SIZE", "ASSERTIONS", "cwrap", "removeFunction", "reallyNegative", "unSign", "strLen", "reSign", "formatString", "intArrayFromString", "intArrayToString", "AsciiToString", "stringToAscii", "UTF16ToString", "stringToUTF16", "lengthBytesUTF16", "UTF32ToString", "stringToUTF32", "lengthBytesUTF32", "stringToNewUTF8", "registerKeyEventCallback", "maybeCStringToJsString", "findEventTarget", "getBoundingClientRect", "fillMouseEventData", "registerMouseEventCallback", "registerWheelEventCallback", "registerUiEventCallback", "registerFocusEventCallback", "fillDeviceOrientationEventData", "registerDeviceOrientationEventCallback", "fillDeviceMotionEventData", "registerDeviceMotionEventCallback", "screenOrientation", "fillOrientationChangeEventData", "registerOrientationChangeEventCallback", "fillFullscreenChangeEventData", "registerFullscreenChangeEventCallback", "JSEvents_requestFullscreen", "JSEvents_resizeCanvasForFullscreen", "registerRestoreOldStyle", "hideEverythingExceptGivenElement", "restoreHiddenElements", "setLetterbox", "softFullscreenResizeWebGLRenderTarget", "doRequestFullscreen", "fillPointerlockChangeEventData", "registerPointerlockChangeEventCallback", "registerPointerlockErrorEventCallback", "requestPointerLock", "fillVisibilityChangeEventData", "registerVisibilityChangeEventCallback", "registerTouchEventCallback", "fillGamepadEventData", "registerGamepadEventCallback", "registerBeforeUnloadEventCallback", "fillBatteryEventData", "battery", "registerBatteryEventCallback", "setCanvasElementSize", "getCanvasElementSize", "getCallstack", "convertPCtoSourceLocation", "wasiRightsToMuslOFlags", "wasiOFlagsToMuslOFlags", "initRandomFill", "randomFill", "safeSetTimeout", "setImmediateWrapped", "safeRequestAnimationFrame", "clearImmediateWrapped", "registerPostMainLoop", "registerPreMainLoop", "getPromise", "makePromise", "idsToPromises", "makePromiseCallback", "ExceptionInfo", "findMatchingCatch", "Browser_asyncPrepareDataCounter", "arraySum", "addDays", "getSocketFromFD", "getSocketAddress", "heapObjectForWebGLType", "toTypedArrayIndex", "webgl_enable_ANGLE_instanced_arrays", "webgl_enable_OES_vertex_array_object", "webgl_enable_WEBGL_draw_buffers", "webgl_enable_WEBGL_multi_draw", "webgl_enable_EXT_polygon_offset_clamp", "webgl_enable_EXT_clip_control", "webgl_enable_WEBGL_polygon_mode", "emscriptenWebGLGet", "computeUnpackAlignedImageSize", "colorChannelsInGlTextureFormat", "emscriptenWebGLGetTexPixelData", "emscriptenWebGLGetUniform", "webglGetUniformLocation", "webglPrepareUniformLocationsBeforeFirstUse", "webglGetLeftBracePos", "emscriptenWebGLGetVertexAttrib", "__glGetActiveAttribOrUniform", "writeGLArray", "registerWebGlEventCallback", "runAndAbortIfError", "ALLOC_NORMAL", "ALLOC_STACK", "allocate", "writeStringToMemory", "writeAsciiToMemory", "demangle", "stackTrace"];
          missingLibrarySymbols.forEach(missingLibrarySymbol);
          var unexportedSymbols = ["run", "addRunDependency", "removeRunDependency", "out", "err", "abort", "wasmMemory", "wasmExports", "HEAPF32", "HEAPF64", "HEAP8", "HEAP16", "HEAPU16", "HEAP32", "HEAPU32", "HEAP64", "HEAPU64", "writeStackCookie", "checkStackCookie", "INT53_MAX", "INT53_MIN", "bigintToI53Checked", "stackSave", "stackRestore", "stackAlloc", "ptrToString", "exitJS", "getHeapMax", "growMemory", "ENV", "ERRNO_CODES", "DNS", "Protocols", "Sockets", "timers", "warnOnce", "readEmAsmArgsArray", "readEmAsmArgs", "runEmAsmFunction", "getExecutableName", "handleException", "keepRuntimeAlive", "alignMemory", "wasmTable", "noExitRuntime", "addOnPreRun", "addOnPostRun", "getCFunc", "uleb128Encode", "sigToWasmTypes", "generateFuncType", "convertJsFunctionToWasm", "freeTableIndexes", "functionsInTableMap", "getEmptyTableSlot", "updateTableMap", "getFunctionAddress", "setValue", "getValue", "PATH", "PATH_FS", "UTF8Decoder", "UTF8ArrayToString", "UTF8ToString", "stringToUTF8Array", "stringToUTF8", "lengthBytesUTF8", "UTF16Decoder", "stringToUTF8OnStack", "writeArrayToMemory", "JSEvents", "specialHTMLTargets", "findCanvasEventTarget", "currentFullscreenStrategy", "restoreOldWindowedStyle", "jsStackTrace", "UNWIND_CACHE", "ExitStatus", "getEnvStrings", "checkWasiClock", "flush_NO_FILESYSTEM", "emSetImmediate", "emClearImmediate_deps", "emClearImmediate", "promiseMap", "uncaughtExceptionCount", "exceptionLast", "exceptionCaught", "Browser", "getPreloadedImageData__data", "wget", "MONTH_DAYS_REGULAR", "MONTH_DAYS_LEAP", "MONTH_DAYS_REGULAR_CUMULATIVE", "MONTH_DAYS_LEAP_CUMULATIVE", "isLeapYear", "ydayFromDate", "SYSCALLS", "tempFixedLengthArray", "miniTempWebGLFloatBuffers", "miniTempWebGLIntBuffers", "GL", "AL", "GLUT", "EGL", "GLEW", "IDBStore", "SDL", "SDL_gfx", "allocateUTF8", "allocateUTF8OnStack", "print", "printErr", "jstoi_s"];
          unexportedSymbols.forEach(unexportedRuntimeSymbol);
          function checkIncomingModuleAPI() {
            ignoredModuleProp("fetchSettings");
          }
          var ASM_CONSTS = {
            4684452: () => typeof wasmOffsetConverter !== "undefined"
          };
          function HaveOffsetConverter() {
            return typeof wasmOffsetConverter !== "undefined";
          }
          var wasmImports = {
            /** @export */
            HaveOffsetConverter,
            /** @export */
            __syscall_chmod: ___syscall_chmod,
            /** @export */
            __syscall_faccessat: ___syscall_faccessat,
            /** @export */
            __syscall_fchmod: ___syscall_fchmod,
            /** @export */
            __syscall_fchown32: ___syscall_fchown32,
            /** @export */
            __syscall_fcntl64: ___syscall_fcntl64,
            /** @export */
            __syscall_fstat64: ___syscall_fstat64,
            /** @export */
            __syscall_ftruncate64: ___syscall_ftruncate64,
            /** @export */
            __syscall_getcwd: ___syscall_getcwd,
            /** @export */
            __syscall_ioctl: ___syscall_ioctl,
            /** @export */
            __syscall_lstat64: ___syscall_lstat64,
            /** @export */
            __syscall_mkdirat: ___syscall_mkdirat,
            /** @export */
            __syscall_newfstatat: ___syscall_newfstatat,
            /** @export */
            __syscall_openat: ___syscall_openat,
            /** @export */
            __syscall_readlinkat: ___syscall_readlinkat,
            /** @export */
            __syscall_rmdir: ___syscall_rmdir,
            /** @export */
            __syscall_stat64: ___syscall_stat64,
            /** @export */
            __syscall_unlinkat: ___syscall_unlinkat,
            /** @export */
            __syscall_utimensat: ___syscall_utimensat,
            /** @export */
            _abort_js: __abort_js,
            /** @export */
            _gmtime_js: __gmtime_js,
            /** @export */
            _localtime_js: __localtime_js,
            /** @export */
            _mmap_js: __mmap_js,
            /** @export */
            _munmap_js: __munmap_js,
            /** @export */
            _timegm_js: __timegm_js,
            /** @export */
            _tzset_js: __tzset_js,
            /** @export */
            clock_time_get: _clock_time_get,
            /** @export */
            emscripten_asm_const_int: _emscripten_asm_const_int,
            /** @export */
            emscripten_date_now: _emscripten_date_now,
            /** @export */
            emscripten_err: _emscripten_err,
            /** @export */
            emscripten_errn: _emscripten_errn,
            /** @export */
            emscripten_get_heap_max: _emscripten_get_heap_max,
            /** @export */
            emscripten_get_now: _emscripten_get_now,
            /** @export */
            emscripten_pc_get_function: _emscripten_pc_get_function,
            /** @export */
            emscripten_resize_heap: _emscripten_resize_heap,
            /** @export */
            emscripten_stack_snapshot: _emscripten_stack_snapshot,
            /** @export */
            emscripten_stack_unwind_buffer: _emscripten_stack_unwind_buffer,
            /** @export */
            environ_get: _environ_get,
            /** @export */
            environ_sizes_get: _environ_sizes_get,
            /** @export */
            exit: _exit,
            /** @export */
            fd_close: _fd_close,
            /** @export */
            fd_fdstat_get: _fd_fdstat_get,
            /** @export */
            fd_read: _fd_read,
            /** @export */
            fd_seek: _fd_seek,
            /** @export */
            fd_sync: _fd_sync,
            /** @export */
            fd_write: _fd_write,
            /** @export */
            proc_exit: _proc_exit
          };
          var wasmExports = await createWasm();
          Module["_trace_processor_rpc_init"] = createExportWrapper("trace_processor_rpc_init", 2);
          Module["_trace_processor_on_rpc_request"] = createExportWrapper("trace_processor_on_rpc_request", 1);
          var _main = Module["_main"] = createExportWrapper("__main_argc_argv", 2);
          Module["_SynqPerfettoParseAlloc"] = createExportWrapper("SynqPerfettoParseAlloc", 2);
          Module["_SynqPerfettoParseFree"] = createExportWrapper("SynqPerfettoParseFree", 2);
          Module["_SynqPerfettoParse"] = createExportWrapper("SynqPerfettoParse", 3);
          Module["_synq_extent_on_shift"] = createExportWrapper("synq_extent_on_shift", 3);
          Module["_SynqPerfettoGetToken"] = createExportWrapper("SynqPerfettoGetToken", 3);
          Module["_synq_extent_on_reduce"] = createExportWrapper("synq_extent_on_reduce", 2);
          Module["_SynqPerfettoParseInit"] = createExportWrapper("SynqPerfettoParseInit", 2);
          Module["_SynqPerfettoParseFinalize"] = createExportWrapper("SynqPerfettoParseFinalize", 1);
          Module["_SynqPerfettoParseFallback"] = createExportWrapper("SynqPerfettoParseFallback", 1);
          Module["_SynqPerfettoParseExpectedTokens"] = createExportWrapper("SynqPerfettoParseExpectedTokens", 3);
          Module["_SynqPerfettoParseCompletionContext"] = createExportWrapper("SynqPerfettoParseCompletionContext", 1);
          var _fflush = createExportWrapper("fflush", 1);
          var _emscripten_stack_get_end = wasmExports["emscripten_stack_get_end"];
          wasmExports["emscripten_stack_get_base"];
          var _emscripten_stack_init = wasmExports["emscripten_stack_init"];
          wasmExports["emscripten_stack_get_free"];
          var __emscripten_stack_restore = wasmExports["_emscripten_stack_restore"];
          var __emscripten_stack_alloc = wasmExports["_emscripten_stack_alloc"];
          var _emscripten_stack_get_current = wasmExports["emscripten_stack_get_current"];
          function applySignatureConversions(wasmExports2) {
            wasmExports2 = Object.assign({}, wasmExports2);
            var makeWrapper_p = (f) => () => f() >>> 0;
            var makeWrapper_pp = (f) => (a0) => f(a0) >>> 0;
            wasmExports2["emscripten_stack_get_end"] = makeWrapper_p(wasmExports2["emscripten_stack_get_end"]);
            wasmExports2["emscripten_stack_get_base"] = makeWrapper_p(wasmExports2["emscripten_stack_get_base"]);
            wasmExports2["_emscripten_stack_alloc"] = makeWrapper_pp(wasmExports2["_emscripten_stack_alloc"]);
            wasmExports2["emscripten_stack_get_current"] = makeWrapper_p(wasmExports2["emscripten_stack_get_current"]);
            return wasmExports2;
          }
          var calledRun;
          function callMain(args = []) {
            assert(runDependencies == 0, 'cannot call main when async dependencies remain! (listen on Module["onRuntimeInitialized"])');
            assert(typeof onPreRuns === "undefined" || onPreRuns.length == 0, "cannot call main when preRun functions remain to be called");
            var entryFunction = _main;
            args.unshift(thisProgram);
            var argc = args.length;
            var argv = stackAlloc((argc + 1) * 4);
            var argv_ptr = argv;
            args.forEach((arg) => {
              HEAPU32[argv_ptr >>> 2 >>> 0] = stringToUTF8OnStack(arg);
              argv_ptr += 4;
            });
            HEAPU32[argv_ptr >>> 2 >>> 0] = 0;
            try {
              var ret = entryFunction(argc, argv);
              exitJS(
                ret,
                /* implicit = */
                true
              );
              return ret;
            } catch (e) {
              return handleException(e);
            }
          }
          function stackCheckInit() {
            _emscripten_stack_init();
            writeStackCookie();
          }
          function run(args = arguments_) {
            if (runDependencies > 0) {
              dependenciesFulfilled = run;
              return;
            }
            stackCheckInit();
            preRun();
            if (runDependencies > 0) {
              dependenciesFulfilled = run;
              return;
            }
            function doRun() {
              var _a;
              assert(!calledRun);
              calledRun = true;
              Module["calledRun"] = true;
              if (ABORT) return;
              initRuntime();
              preMain();
              readyPromiseResolve(Module);
              (_a = Module["onRuntimeInitialized"]) == null ? void 0 : _a.call(Module);
              consumedModuleProp("onRuntimeInitialized");
              var noInitialRun = Module["noInitialRun"] || false;
              if (!noInitialRun) callMain(args);
              postRun();
            }
            if (Module["setStatus"]) {
              Module["setStatus"]("Running...");
              setTimeout(() => {
                setTimeout(() => Module["setStatus"](""), 1);
                doRun();
              }, 1);
            } else {
              doRun();
            }
            checkStackCookie();
          }
          function checkUnflushedContent() {
            var oldOut = out;
            var oldErr = err;
            var has = false;
            out = err = (x) => {
              has = true;
            };
            try {
              flush_NO_FILESYSTEM();
            } catch (e) {
            }
            out = oldOut;
            err = oldErr;
            if (has) {
              warnOnce("stdio streams had content in them that was not flushed. you should set EXIT_RUNTIME to 1 (see the Emscripten FAQ), or make sure to emit a newline when you printf etc.");
              warnOnce("(this may also be due to not including full filesystem support - try building with -sFORCE_FILESYSTEM)");
            }
          }
          function preInit() {
            if (Module["preInit"]) {
              if (typeof Module["preInit"] == "function") Module["preInit"] = [Module["preInit"]];
              while (Module["preInit"].length > 0) {
                Module["preInit"].shift()();
              }
            }
            consumedModuleProp("preInit");
          }
          preInit();
          run();
          moduleRtn = readyPromise;
          for (const prop of Object.keys(Module)) {
            if (!(prop in moduleArg)) {
              Object.defineProperty(moduleArg, prop, {
                configurable: true,
                get() {
                  abort(`Access to module property ('${prop}') is no longer possible via the module constructor argument; Instead, use the result of the module constructor.`);
                }
              });
            }
          }
          return moduleRtn;
        });
      })();
      {
        module.exports = trace_processor_wasm;
        module.exports.default = trace_processor_wasm;
      }
    })(trace_processor);
    return trace_processor.exports;
  }
  var trace_processorExports = requireTrace_processor();
  const TraceProcessor32 = /* @__PURE__ */ getDefaultExportFromCjs(trace_processorExports);
  let memory64SupportCache;
  function memory64Supported() {
    if (memory64SupportCache !== void 0) return memory64SupportCache;
    const program = new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      5,
      3,
      1,
      4,
      0,
      0,
      8,
      4,
      110,
      97,
      109,
      101,
      2,
      1,
      0
    ]);
    try {
      new WebAssembly.Module(program);
      return memory64SupportCache = true;
    } catch {
      return memory64SupportCache = false;
    }
  }
  const REQ_BUF_SIZE = 32 * 1024 * 1024;
  class WasmBridge {
    constructor() {
      __publicField(this, "aborted", false);
      __publicField(this, "connection");
      __publicField(this, "reqBufferAddr", 0);
      __publicField(this, "lastStderr", []);
      __publicField(this, "messagePort");
      __publicField(this, "useMemory64", false);
    }
    // |precompiledModule| is compiled once on the main thread and shared with
    // every worker so V8 reuses the same tiered-up wasm code. The port's
    // onmessage is wired up only after init completes, so any RPC bytes that
    // arrive in the meantime stay queued on the port.
    async initialize(port, precompiledModule) {
      assertTrue(this.messagePort === void 0);
      this.messagePort = port;
      this.useMemory64 = memory64Supported();
      const initModule = this.useMemory64 ? TraceProcessor64 : TraceProcessor32;
      const connection = await initModule({
        locateFile: (s) => s,
        print: (line) => console.log(line),
        printErr: (line) => this.appendAndLogErr(line),
        onRuntimeInitialized: () => {
        },
        instantiateWasm: (imports, successCallback) => {
          const instance = new WebAssembly.Instance(precompiledModule, imports);
          successCallback(instance, precompiledModule);
          return instance.exports;
        }
      });
      const fn = connection.addFunction(this.onReply.bind(this), "vpi");
      this.reqBufferAddr = this.wasmPtrCast(
        connection.ccall(
          "trace_processor_rpc_init",
          /* return=*/
          "pointer",
          /* args=*/
          ["pointer", "number"],
          [fn, REQ_BUF_SIZE]
        )
      );
      this.connection = connection;
      port.onmessage = this.onMessage.bind(this);
    }
    onMessage(msg) {
      if (this.aborted) {
        throw new Error("Wasm module crashed");
      }
      const connection = assertExists(this.connection);
      assertTrue(msg.data instanceof Uint8Array);
      const data = msg.data;
      let wrSize = 0;
      while (wrSize < data.length) {
        const sliceLen = Math.min(data.length - wrSize, REQ_BUF_SIZE);
        const dataSlice = data.subarray(wrSize, wrSize + sliceLen);
        connection.HEAPU8.set(dataSlice, this.reqBufferAddr);
        wrSize += sliceLen;
        try {
          connection.ccall(
            "trace_processor_on_rpc_request",
            // C function name.
            "void",
            // Return type.
            ["number"],
            // Arg types.
            [sliceLen]
            // Args.
          );
        } catch (err) {
          this.aborted = true;
          let abortReason = `${err}`;
          if (err instanceof Error) {
            abortReason = `${err.name}: ${err.message}
${err.stack}`;
          }
          abortReason += "\n\nstderr: \n" + this.lastStderr.join("\n");
          throw new Error(abortReason);
        }
      }
    }
    // This function is bound and passed to Initialize and is called by the C++
    // code while in the ccall(trace_processor_on_rpc_request).
    onReply(heapPtrArg, size) {
      const heapPtr = this.wasmPtrCast(heapPtrArg);
      const data = assertExists(this.connection).HEAPU8.slice(
        heapPtr,
        heapPtr + size
      );
      assertExists(this.messagePort).postMessage(data, [data.buffer]);
    }
    appendAndLogErr(line) {
      console.warn(line);
      this.lastStderr.push(line);
      if (this.lastStderr.length > 512) {
        this.lastStderr.shift();
      }
    }
    // Takes a wasm pointer and converts it into a positive number < 2**53.
    // When using memory64 pointer args are passed as BigInt, but they are
    // guaranteed to be < 2**53 anyways.
    // When using memory32, pointer args are passed as numbers. However, because
    // they can be between 2GB and 4GB, we need to remove the negative sign.
    wasmPtrCast(val) {
      if (this.useMemory64) {
        return Number(val);
      }
      assertTrue(typeof val === "number");
      return Number(val) >>> 0;
    }
  }
  const selfWorker = self;
  const wasmBridge = new WasmBridge();
  selfWorker.onmessage = (msg) => {
    const data = msg.data;
    wasmBridge.initialize(data.port, data.wasmModule);
  };
})();
//# sourceMappingURL=engine_bundle.js.map

;(self.__SOURCEMAPS=self.__SOURCEMAPS||{})['engine_bundle.js']={"version":3,"sources":["../../src/base/assert.ts","ui/tsc/gen/trace_processor_memory64.js","ui/tsc/gen/trace_processor.js","../../src/trace_processor/wasm_modules.ts","../../src/engine/wasm_bridge.ts","../../src/engine/index.ts"],"mappings":"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AO;AAGT;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AAEA;AACA;AACA;AACA;AACA;AAAyC;AAG3C;AAKE;AAAO;AAGT;AAAyD;AAMzD;AACE;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AAAwB;AAE1B;AAAiB;AAGnB;AACE;AACA;AAGA;AACA;AACA;AAEA;AAQE;AAEA;AACE;AACA;AAAuC;AAEzC;AACE;AACA;AAAuB;AAEvB;AACA;AACA;AAAkC;AAElC;AACA;AACA;AACA;AAAkC;AAElC;AACA;AACA;AACA;AACA;AACA;AAAkC;AACxC;AAGE;AACA;AAAgB;AAGlB;AACE;AACA;AAA6D;AAG/D;AACE;AACA;AAKE;AAEA;AACE;AAAA;AAEA;AAAO;AAEP;AACA;AAAE;AAEF;AAAO;AACb;AAEE;AAAO;AAGT;AACE;AACA;AACA;AACA;AAEA;AACA;AACA;AACA;AACA;AAOA;AAMA;AACA;AACA;AAGE;AACA;AACA;AACA;AACA;AAAmC;AAErC;AACA;AACA;AACA;AACA;AACA;AACA;AAEE;AACA;AAAqC;AAErC;AACA;AAAqC;AACzC;AAGA;AAEA;AAIA;AAEA;AAEE;AACA;AACE;AAAO;AAET;AAEA;AACE;AAA0B;AAE1B;AAAyB;AAK3B;AACA;AACA;AAAO;AAGT;AAEA;AAEE;AAEA;AACA;AACA;AAGA;AACE;AACA;AAEA;AACA;AAGA;AACA;AACA;AACA;AAAmB;AAAA;AACiI;AACpJ;AAAkB;AAEpB;AAAO;AAGT;AACE;AACA;AACA;AAA+B;AAGjC;AACE;AACA;AACA;AACA;AAA4C;AAG9C;AACE;AACA;AAA4B;AAG9B;AACE;AACA;AACA;AAAiC;AAGnC;AAAiB;AAAA;AAAA;AAAA;AAAA;AAIjB;AAEA;AACE;AAAiB;AAGnB;AAEE;AACA;AAAO;AAGT;AACE;AACA;AAAqC;AAGvC;AACE;AACA;AACA;AAEE;AAEA;AACA;AAAO;AAEP;AAAyG;AAC7G;AAGA;AACE;AACA;AAGA;AAmBA;AACA;AACE;AACA;AAAO;AAKT;AAC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","file":"engine_bundle.js"};