var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
(function() {
  "use strict";
  function defer() {
    let resolve = null;
    let reject = null;
    const p = new Promise((res, rej) => [resolve, reject] = [res, rej]);
    return Object.assign(p, { resolve, reject });
  }
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
    (function(module, exports$1) {
      var trace_processor_memory64_wasm = (() => {
        var _a;
        var _scriptName = typeof document != "undefined" ? (_a = document.currentScript) == null ? void 0 : _a.src : void 0;
        return (function(moduleArg = {}) {
          var moduleRtn;
          var Module = moduleArg;
          var readyPromiseResolve, readyPromiseReject;
          new Promise((resolve, reject) => {
            readyPromiseResolve = resolve;
            readyPromiseReject = reject;
          });
          var ENVIRONMENT_IS_WEB = typeof window == "object";
          var ENVIRONMENT_IS_WORKER = typeof WorkerGlobalScope != "undefined";
          var ENVIRONMENT_IS_NODE = typeof process == "object" && typeof process.versions == "object" && typeof process.versions.node == "string" && process.type != "renderer";
          var ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER;
          var arguments_ = [];
          var thisProgram = "./this.program";
          var quit_ = (status, toThrow) => {
            throw toThrow;
          };
          if (ENVIRONMENT_IS_WORKER) {
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
          if (ENVIRONMENT_IS_SHELL) {
            if (typeof process == "object" && typeof require === "function" || typeof window == "object" || typeof WorkerGlobalScope != "undefined") throw new Error("not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)");
          } else if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
            try {
              scriptDirectory = new URL(".", _scriptName).href;
            } catch {
            }
            if (!(typeof window == "object" || typeof WorkerGlobalScope != "undefined")) throw new Error("not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)");
            {
              if (ENVIRONMENT_IS_WORKER) {
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
          } else {
            throw new Error("environment detection error");
          }
          var out = console.log.bind(console);
          var err = console.error.bind(console);
          var WORKERFS = "WORKERFS is no longer included by default; build with -lworkerfs.js";
          assert(!ENVIRONMENT_IS_NODE, "node environment detected but not enabled at build time.  Add `node` to `-sENVIRONMENT` to enable.");
          assert(!ENVIRONMENT_IS_SHELL, "shell environment detected but not enabled at build time.  Add `shell` to `-sENVIRONMENT` to enable.");
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
            if (!Module["noFSInit"] && !FS.initialized) FS.init();
            wasmExports["__wasm_call_ctors"]();
            FS.ignorePermissions = false;
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
          function getUniqueRunDependency(id) {
            var orig = id;
            while (1) {
              if (!runDependencyTracking[id]) return id;
              id = orig + Math.random();
            }
          }
          function addRunDependency(id) {
            var _a2;
            runDependencies++;
            (_a2 = Module["monitorRunDependencies"]) == null ? void 0 : _a2.call(Module, runDependencies);
            if (id) {
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
            } else {
              err("warning: run dependency added without ID");
            }
          }
          function removeRunDependency(id) {
            var _a2;
            runDependencies--;
            (_a2 = Module["monitorRunDependencies"]) == null ? void 0 : _a2.call(Module, runDependencies);
            if (id) {
              assert(runDependencyTracking[id]);
              delete runDependencyTracking[id];
            } else {
              err("warning: run dependency removed without ID");
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
            var _a2;
            (_a2 = Module["onAbort"]) == null ? void 0 : _a2.call(Module, what);
            what = "Aborted(" + what + ")";
            err(what);
            ABORT = true;
            var e = new WebAssembly.RuntimeError(what);
            readyPromiseReject(e);
            throw e;
          }
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
            throw 'sync fetching of the wasm failed: you can preload it to Module["wasmBinary"] manually, or emcc.py will do that for you when generating HTML (but not JS)';
          }
          function instantiateSync(file, info) {
            var module2;
            var binary = getBinarySync(file);
            module2 = new WebAssembly.Module(binary);
            var instance = new WebAssembly.Instance(module2, info);
            return [instance, module2];
          }
          function getWasmImports() {
            return {
              "env": wasmImports,
              "wasi_snapshot_preview1": wasmImports
            };
          }
          function createWasm() {
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
            var result = instantiateSync(wasmBinaryFile, info);
            return receiveInstance(result[0]);
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
          var PATH = {
            isAbs: (path) => path.charAt(0) === "/",
            splitPath: (filename) => {
              var splitPathRe = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
              return splitPathRe.exec(filename).slice(1);
            },
            normalizeArray: (parts, allowAboveRoot) => {
              var up = 0;
              for (var i = parts.length - 1; i >= 0; i--) {
                var last = parts[i];
                if (last === ".") {
                  parts.splice(i, 1);
                } else if (last === "..") {
                  parts.splice(i, 1);
                  up++;
                } else if (up) {
                  parts.splice(i, 1);
                  up--;
                }
              }
              if (allowAboveRoot) {
                for (; up; up--) {
                  parts.unshift("..");
                }
              }
              return parts;
            },
            normalize: (path) => {
              var isAbsolute = PATH.isAbs(path), trailingSlash = path.slice(-1) === "/";
              path = PATH.normalizeArray(path.split("/").filter((p) => !!p), !isAbsolute).join("/");
              if (!path && !isAbsolute) {
                path = ".";
              }
              if (path && trailingSlash) {
                path += "/";
              }
              return (isAbsolute ? "/" : "") + path;
            },
            dirname: (path) => {
              var result = PATH.splitPath(path), root = result[0], dir = result[1];
              if (!root && !dir) {
                return ".";
              }
              if (dir) {
                dir = dir.slice(0, -1);
              }
              return root + dir;
            },
            basename: (path) => path && path.match(/([^\/]+|\/)\/*$/)[1],
            join: (...paths) => PATH.normalize(paths.join("/")),
            join2: (l, r) => PATH.normalize(l + "/" + r)
          };
          var initRandomFill = () => (view) => crypto.getRandomValues(view);
          var randomFill = (view) => {
            (randomFill = initRandomFill())(view);
          };
          var PATH_FS = {
            resolve: (...args) => {
              var resolvedPath = "", resolvedAbsolute = false;
              for (var i = args.length - 1; i >= -1 && !resolvedAbsolute; i--) {
                var path = i >= 0 ? args[i] : FS.cwd();
                if (typeof path != "string") {
                  throw new TypeError("Arguments to path.resolve must be strings");
                } else if (!path) {
                  return "";
                }
                resolvedPath = path + "/" + resolvedPath;
                resolvedAbsolute = PATH.isAbs(path);
              }
              resolvedPath = PATH.normalizeArray(resolvedPath.split("/").filter((p) => !!p), !resolvedAbsolute).join("/");
              return (resolvedAbsolute ? "/" : "") + resolvedPath || ".";
            },
            relative: (from, to) => {
              from = PATH_FS.resolve(from).slice(1);
              to = PATH_FS.resolve(to).slice(1);
              function trim(arr) {
                var start = 0;
                for (; start < arr.length; start++) {
                  if (arr[start] !== "") break;
                }
                var end = arr.length - 1;
                for (; end >= 0; end--) {
                  if (arr[end] !== "") break;
                }
                if (start > end) return [];
                return arr.slice(start, end - start + 1);
              }
              var fromParts = trim(from.split("/"));
              var toParts = trim(to.split("/"));
              var length = Math.min(fromParts.length, toParts.length);
              var samePartsLength = length;
              for (var i = 0; i < length; i++) {
                if (fromParts[i] !== toParts[i]) {
                  samePartsLength = i;
                  break;
                }
              }
              var outputParts = [];
              for (var i = samePartsLength; i < fromParts.length; i++) {
                outputParts.push("..");
              }
              outputParts = outputParts.concat(toParts.slice(samePartsLength));
              return outputParts.join("/");
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
          var FS_stdin_getChar_buffer = [];
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
          var intArrayFromString = (stringy, dontAddNull, length) => {
            var len = lengthBytesUTF8(stringy) + 1;
            var u8array = new Array(len);
            var numBytesWritten = stringToUTF8Array(stringy, u8array, 0, u8array.length);
            u8array.length = numBytesWritten;
            return u8array;
          };
          var FS_stdin_getChar = () => {
            if (!FS_stdin_getChar_buffer.length) {
              var result = null;
              if (typeof window != "undefined" && typeof window.prompt == "function") {
                result = window.prompt("Input: ");
                if (result !== null) {
                  result += "\n";
                }
              }
              if (!result) {
                return null;
              }
              FS_stdin_getChar_buffer = intArrayFromString(result);
            }
            return FS_stdin_getChar_buffer.shift();
          };
          var TTY = {
            ttys: [],
            init() {
            },
            shutdown() {
            },
            register(dev, ops) {
              TTY.ttys[dev] = {
                input: [],
                output: [],
                ops
              };
              FS.registerDevice(dev, TTY.stream_ops);
            },
            stream_ops: {
              open(stream) {
                var tty = TTY.ttys[stream.node.rdev];
                if (!tty) {
                  throw new FS.ErrnoError(43);
                }
                stream.tty = tty;
                stream.seekable = false;
              },
              close(stream) {
                stream.tty.ops.fsync(stream.tty);
              },
              fsync(stream) {
                stream.tty.ops.fsync(stream.tty);
              },
              read(stream, buffer, offset, length, pos) {
                if (!stream.tty || !stream.tty.ops.get_char) {
                  throw new FS.ErrnoError(60);
                }
                var bytesRead = 0;
                for (var i = 0; i < length; i++) {
                  var result;
                  try {
                    result = stream.tty.ops.get_char(stream.tty);
                  } catch (e) {
                    throw new FS.ErrnoError(29);
                  }
                  if (result === void 0 && bytesRead === 0) {
                    throw new FS.ErrnoError(6);
                  }
                  if (result === null || result === void 0) break;
                  bytesRead++;
                  buffer[offset + i] = result;
                }
                if (bytesRead) {
                  stream.node.atime = Date.now();
                }
                return bytesRead;
              },
              write(stream, buffer, offset, length, pos) {
                if (!stream.tty || !stream.tty.ops.put_char) {
                  throw new FS.ErrnoError(60);
                }
                try {
                  for (var i = 0; i < length; i++) {
                    stream.tty.ops.put_char(stream.tty, buffer[offset + i]);
                  }
                } catch (e) {
                  throw new FS.ErrnoError(29);
                }
                if (length) {
                  stream.node.mtime = stream.node.ctime = Date.now();
                }
                return i;
              }
            },
            default_tty_ops: {
              get_char(tty) {
                return FS_stdin_getChar();
              },
              put_char(tty, val) {
                if (val === null || val === 10) {
                  out(UTF8ArrayToString(tty.output));
                  tty.output = [];
                } else {
                  if (val != 0) tty.output.push(val);
                }
              },
              fsync(tty) {
                var _a2;
                if (((_a2 = tty.output) == null ? void 0 : _a2.length) > 0) {
                  out(UTF8ArrayToString(tty.output));
                  tty.output = [];
                }
              },
              ioctl_tcgets(tty) {
                return {
                  c_iflag: 25856,
                  c_oflag: 5,
                  c_cflag: 191,
                  c_lflag: 35387,
                  c_cc: [3, 28, 127, 21, 4, 0, 1, 0, 17, 19, 26, 0, 18, 15, 23, 22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
                };
              },
              ioctl_tcsets(tty, optional_actions, data) {
                return 0;
              },
              ioctl_tiocgwinsz(tty) {
                return [24, 80];
              }
            },
            default_tty1_ops: {
              put_char(tty, val) {
                if (val === null || val === 10) {
                  err(UTF8ArrayToString(tty.output));
                  tty.output = [];
                } else {
                  if (val != 0) tty.output.push(val);
                }
              },
              fsync(tty) {
                var _a2;
                if (((_a2 = tty.output) == null ? void 0 : _a2.length) > 0) {
                  err(UTF8ArrayToString(tty.output));
                  tty.output = [];
                }
              }
            }
          };
          var zeroMemory = (ptr, size) => HEAPU8.fill(0, ptr, ptr + size);
          var alignMemory = (size, alignment) => {
            assert(alignment, "alignment argument is required");
            return Math.ceil(size / alignment) * alignment;
          };
          var mmapAlloc = (size) => {
            size = alignMemory(size, 65536);
            var ptr = _emscripten_builtin_memalign(65536, size);
            if (ptr) zeroMemory(ptr, size);
            return ptr;
          };
          var MEMFS = {
            ops_table: null,
            mount(mount) {
              return MEMFS.createNode(null, "/", 16895, 0);
            },
            createNode(parent, name, mode, dev) {
              if (FS.isBlkdev(mode) || FS.isFIFO(mode)) {
                throw new FS.ErrnoError(63);
              }
              MEMFS.ops_table || (MEMFS.ops_table = {
                dir: {
                  node: {
                    getattr: MEMFS.node_ops.getattr,
                    setattr: MEMFS.node_ops.setattr,
                    lookup: MEMFS.node_ops.lookup,
                    mknod: MEMFS.node_ops.mknod,
                    rename: MEMFS.node_ops.rename,
                    unlink: MEMFS.node_ops.unlink,
                    rmdir: MEMFS.node_ops.rmdir,
                    readdir: MEMFS.node_ops.readdir,
                    symlink: MEMFS.node_ops.symlink
                  },
                  stream: {
                    llseek: MEMFS.stream_ops.llseek
                  }
                },
                file: {
                  node: {
                    getattr: MEMFS.node_ops.getattr,
                    setattr: MEMFS.node_ops.setattr
                  },
                  stream: {
                    llseek: MEMFS.stream_ops.llseek,
                    read: MEMFS.stream_ops.read,
                    write: MEMFS.stream_ops.write,
                    mmap: MEMFS.stream_ops.mmap,
                    msync: MEMFS.stream_ops.msync
                  }
                },
                link: {
                  node: {
                    getattr: MEMFS.node_ops.getattr,
                    setattr: MEMFS.node_ops.setattr,
                    readlink: MEMFS.node_ops.readlink
                  },
                  stream: {}
                },
                chrdev: {
                  node: {
                    getattr: MEMFS.node_ops.getattr,
                    setattr: MEMFS.node_ops.setattr
                  },
                  stream: FS.chrdev_stream_ops
                }
              });
              var node = FS.createNode(parent, name, mode, dev);
              if (FS.isDir(node.mode)) {
                node.node_ops = MEMFS.ops_table.dir.node;
                node.stream_ops = MEMFS.ops_table.dir.stream;
                node.contents = {};
              } else if (FS.isFile(node.mode)) {
                node.node_ops = MEMFS.ops_table.file.node;
                node.stream_ops = MEMFS.ops_table.file.stream;
                node.usedBytes = 0;
                node.contents = null;
              } else if (FS.isLink(node.mode)) {
                node.node_ops = MEMFS.ops_table.link.node;
                node.stream_ops = MEMFS.ops_table.link.stream;
              } else if (FS.isChrdev(node.mode)) {
                node.node_ops = MEMFS.ops_table.chrdev.node;
                node.stream_ops = MEMFS.ops_table.chrdev.stream;
              }
              node.atime = node.mtime = node.ctime = Date.now();
              if (parent) {
                parent.contents[name] = node;
                parent.atime = parent.mtime = parent.ctime = node.atime;
              }
              return node;
            },
            getFileDataAsTypedArray(node) {
              if (!node.contents) return new Uint8Array(0);
              if (node.contents.subarray) return node.contents.subarray(0, node.usedBytes);
              return new Uint8Array(node.contents);
            },
            expandFileStorage(node, newCapacity) {
              var prevCapacity = node.contents ? node.contents.length : 0;
              if (prevCapacity >= newCapacity) return;
              var CAPACITY_DOUBLING_MAX = 1024 * 1024;
              newCapacity = Math.max(newCapacity, prevCapacity * (prevCapacity < CAPACITY_DOUBLING_MAX ? 2 : 1.125) >>> 0);
              if (prevCapacity != 0) newCapacity = Math.max(newCapacity, 256);
              var oldContents = node.contents;
              node.contents = new Uint8Array(newCapacity);
              if (node.usedBytes > 0) node.contents.set(oldContents.subarray(0, node.usedBytes), 0);
            },
            resizeFileStorage(node, newSize) {
              if (node.usedBytes == newSize) return;
              if (newSize == 0) {
                node.contents = null;
                node.usedBytes = 0;
              } else {
                var oldContents = node.contents;
                node.contents = new Uint8Array(newSize);
                if (oldContents) {
                  node.contents.set(oldContents.subarray(0, Math.min(newSize, node.usedBytes)));
                }
                node.usedBytes = newSize;
              }
            },
            node_ops: {
              getattr(node) {
                var attr = {};
                attr.dev = FS.isChrdev(node.mode) ? node.id : 1;
                attr.ino = node.id;
                attr.mode = node.mode;
                attr.nlink = 1;
                attr.uid = 0;
                attr.gid = 0;
                attr.rdev = node.rdev;
                if (FS.isDir(node.mode)) {
                  attr.size = 4096;
                } else if (FS.isFile(node.mode)) {
                  attr.size = node.usedBytes;
                } else if (FS.isLink(node.mode)) {
                  attr.size = node.link.length;
                } else {
                  attr.size = 0;
                }
                attr.atime = new Date(node.atime);
                attr.mtime = new Date(node.mtime);
                attr.ctime = new Date(node.ctime);
                attr.blksize = 4096;
                attr.blocks = Math.ceil(attr.size / attr.blksize);
                return attr;
              },
              setattr(node, attr) {
                for (const key of ["mode", "atime", "mtime", "ctime"]) {
                  if (attr[key] != null) {
                    node[key] = attr[key];
                  }
                }
                if (attr.size !== void 0) {
                  MEMFS.resizeFileStorage(node, attr.size);
                }
              },
              lookup(parent, name) {
                throw new FS.ErrnoError(44);
              },
              mknod(parent, name, mode, dev) {
                return MEMFS.createNode(parent, name, mode, dev);
              },
              rename(old_node, new_dir, new_name) {
                var new_node;
                try {
                  new_node = FS.lookupNode(new_dir, new_name);
                } catch (e) {
                }
                if (new_node) {
                  if (FS.isDir(old_node.mode)) {
                    for (var i in new_node.contents) {
                      throw new FS.ErrnoError(55);
                    }
                  }
                  FS.hashRemoveNode(new_node);
                }
                delete old_node.parent.contents[old_node.name];
                new_dir.contents[new_name] = old_node;
                old_node.name = new_name;
                new_dir.ctime = new_dir.mtime = old_node.parent.ctime = old_node.parent.mtime = Date.now();
              },
              unlink(parent, name) {
                delete parent.contents[name];
                parent.ctime = parent.mtime = Date.now();
              },
              rmdir(parent, name) {
                var node = FS.lookupNode(parent, name);
                for (var i in node.contents) {
                  throw new FS.ErrnoError(55);
                }
                delete parent.contents[name];
                parent.ctime = parent.mtime = Date.now();
              },
              readdir(node) {
                return [".", "..", ...Object.keys(node.contents)];
              },
              symlink(parent, newname, oldpath) {
                var node = MEMFS.createNode(parent, newname, 511 | 40960, 0);
                node.link = oldpath;
                return node;
              },
              readlink(node) {
                if (!FS.isLink(node.mode)) {
                  throw new FS.ErrnoError(28);
                }
                return node.link;
              }
            },
            stream_ops: {
              read(stream, buffer, offset, length, position) {
                var contents = stream.node.contents;
                if (position >= stream.node.usedBytes) return 0;
                var size = Math.min(stream.node.usedBytes - position, length);
                assert(size >= 0);
                if (size > 8 && contents.subarray) {
                  buffer.set(contents.subarray(position, position + size), offset);
                } else {
                  for (var i = 0; i < size; i++) buffer[offset + i] = contents[position + i];
                }
                return size;
              },
              write(stream, buffer, offset, length, position, canOwn) {
                assert(!(buffer instanceof ArrayBuffer));
                if (buffer.buffer === HEAP8.buffer) {
                  canOwn = false;
                }
                if (!length) return 0;
                var node = stream.node;
                node.mtime = node.ctime = Date.now();
                if (buffer.subarray && (!node.contents || node.contents.subarray)) {
                  if (canOwn) {
                    assert(position === 0, "canOwn must imply no weird position inside the file");
                    node.contents = buffer.subarray(offset, offset + length);
                    node.usedBytes = length;
                    return length;
                  } else if (node.usedBytes === 0 && position === 0) {
                    node.contents = buffer.slice(offset, offset + length);
                    node.usedBytes = length;
                    return length;
                  } else if (position + length <= node.usedBytes) {
                    node.contents.set(buffer.subarray(offset, offset + length), position);
                    return length;
                  }
                }
                MEMFS.expandFileStorage(node, position + length);
                if (node.contents.subarray && buffer.subarray) {
                  node.contents.set(buffer.subarray(offset, offset + length), position);
                } else {
                  for (var i = 0; i < length; i++) {
                    node.contents[position + i] = buffer[offset + i];
                  }
                }
                node.usedBytes = Math.max(node.usedBytes, position + length);
                return length;
              },
              llseek(stream, offset, whence) {
                var position = offset;
                if (whence === 1) {
                  position += stream.position;
                } else if (whence === 2) {
                  if (FS.isFile(stream.node.mode)) {
                    position += stream.node.usedBytes;
                  }
                }
                if (position < 0) {
                  throw new FS.ErrnoError(28);
                }
                return position;
              },
              mmap(stream, length, position, prot, flags) {
                if (!FS.isFile(stream.node.mode)) {
                  throw new FS.ErrnoError(43);
                }
                var ptr;
                var allocated;
                var contents = stream.node.contents;
                if (!(flags & 2) && contents && contents.buffer === HEAP8.buffer) {
                  allocated = false;
                  ptr = contents.byteOffset;
                } else {
                  allocated = true;
                  ptr = mmapAlloc(length);
                  if (!ptr) {
                    throw new FS.ErrnoError(48);
                  }
                  if (contents) {
                    if (position > 0 || position + length < contents.length) {
                      if (contents.subarray) {
                        contents = contents.subarray(position, position + length);
                      } else {
                        contents = Array.prototype.slice.call(contents, position, position + length);
                      }
                    }
                    HEAP8.set(contents, ptr);
                  }
                }
                return {
                  ptr,
                  allocated
                };
              },
              msync(stream, buffer, offset, length, mmapFlags) {
                MEMFS.stream_ops.write(stream, buffer, 0, length, offset, false);
                return 0;
              }
            }
          };
          var asyncLoad = async (url) => {
            var arrayBuffer = await readAsync(url);
            assert(arrayBuffer, `Loading data file "${url}" failed (no arrayBuffer).`);
            return new Uint8Array(arrayBuffer);
          };
          var FS_createDataFile = (...args) => FS.createDataFile(...args);
          var preloadPlugins = [];
          var FS_handledByPreloadPlugin = (byteArray, fullname, finish, onerror) => {
            if (typeof Browser != "undefined") Browser.init();
            var handled = false;
            preloadPlugins.forEach((plugin) => {
              if (handled) return;
              if (plugin["canHandle"](fullname)) {
                plugin["handle"](byteArray, fullname, finish, onerror);
                handled = true;
              }
            });
            return handled;
          };
          var FS_createPreloadedFile = (parent, name, url, canRead, canWrite, onload, onerror, dontCreateFile, canOwn, preFinish) => {
            var fullname = name ? PATH_FS.resolve(PATH.join2(parent, name)) : parent;
            var dep = getUniqueRunDependency(`cp ${fullname}`);
            function processData(byteArray) {
              function finish(byteArray2) {
                preFinish == null ? void 0 : preFinish();
                if (!dontCreateFile) {
                  FS_createDataFile(parent, name, byteArray2, canRead, canWrite, canOwn);
                }
                onload == null ? void 0 : onload();
                removeRunDependency(dep);
              }
              if (FS_handledByPreloadPlugin(byteArray, fullname, finish, () => {
                onerror == null ? void 0 : onerror();
                removeRunDependency(dep);
              })) {
                return;
              }
              finish(byteArray);
            }
            addRunDependency(dep);
            if (typeof url == "string") {
              asyncLoad(url).then(processData, onerror);
            } else {
              processData(url);
            }
          };
          var FS_modeStringToFlags = (str) => {
            var flagModes = {
              "r": 0,
              "r+": 2,
              "w": 512 | 64 | 1,
              "w+": 512 | 64 | 2,
              "a": 1024 | 64 | 1,
              "a+": 1024 | 64 | 2
            };
            var flags = flagModes[str];
            if (typeof flags == "undefined") {
              throw new Error(`Unknown file open mode: ${str}`);
            }
            return flags;
          };
          var FS_getMode = (canRead, canWrite) => {
            var mode = 0;
            if (canRead) mode |= 292 | 73;
            if (canWrite) mode |= 146;
            return mode;
          };
          var WORKERFS = {
            DIR_MODE: 16895,
            FILE_MODE: 33279,
            reader: null,
            mount(mount) {
              assert(ENVIRONMENT_IS_WORKER);
              WORKERFS.reader ?? (WORKERFS.reader = new FileReaderSync());
              var root = WORKERFS.createNode(null, "/", WORKERFS.DIR_MODE, 0);
              var createdParents = {};
              function ensureParent(path) {
                var parts = path.split("/");
                var parent = root;
                for (var i = 0; i < parts.length - 1; i++) {
                  var curr = parts.slice(0, i + 1).join("/");
                  createdParents[curr] || (createdParents[curr] = WORKERFS.createNode(parent, parts[i], WORKERFS.DIR_MODE, 0));
                  parent = createdParents[curr];
                }
                return parent;
              }
              function base(path) {
                var parts = path.split("/");
                return parts[parts.length - 1];
              }
              Array.prototype.forEach.call(mount.opts["files"] || [], function(file) {
                WORKERFS.createNode(ensureParent(file.name), base(file.name), WORKERFS.FILE_MODE, 0, file, file.lastModifiedDate);
              });
              (mount.opts["blobs"] || []).forEach((obj) => {
                WORKERFS.createNode(ensureParent(obj["name"]), base(obj["name"]), WORKERFS.FILE_MODE, 0, obj["data"]);
              });
              (mount.opts["packages"] || []).forEach((pack) => {
                pack["metadata"].files.forEach((file) => {
                  var name = file.filename.slice(1);
                  WORKERFS.createNode(ensureParent(name), base(name), WORKERFS.FILE_MODE, 0, pack["blob"].slice(file.start, file.end));
                });
              });
              return root;
            },
            createNode(parent, name, mode, dev, contents, mtime) {
              var node = FS.createNode(parent, name, mode);
              node.mode = mode;
              node.node_ops = WORKERFS.node_ops;
              node.stream_ops = WORKERFS.stream_ops;
              node.atime = node.mtime = node.ctime = (mtime || /* @__PURE__ */ new Date()).getTime();
              assert(WORKERFS.FILE_MODE !== WORKERFS.DIR_MODE);
              if (mode === WORKERFS.FILE_MODE) {
                node.size = contents.size;
                node.contents = contents;
              } else {
                node.size = 4096;
                node.contents = {};
              }
              if (parent) {
                parent.contents[name] = node;
              }
              return node;
            },
            node_ops: {
              getattr(node) {
                return {
                  dev: 1,
                  ino: node.id,
                  mode: node.mode,
                  nlink: 1,
                  uid: 0,
                  gid: 0,
                  rdev: 0,
                  size: node.size,
                  atime: new Date(node.atime),
                  mtime: new Date(node.mtime),
                  ctime: new Date(node.ctime),
                  blksize: 4096,
                  blocks: Math.ceil(node.size / 4096)
                };
              },
              setattr(node, attr) {
                for (const key of ["mode", "atime", "mtime", "ctime"]) {
                  if (attr[key] != null) {
                    node[key] = attr[key];
                  }
                }
              },
              lookup(parent, name) {
                throw new FS.ErrnoError(44);
              },
              mknod(parent, name, mode, dev) {
                throw new FS.ErrnoError(63);
              },
              rename(oldNode, newDir, newName) {
                throw new FS.ErrnoError(63);
              },
              unlink(parent, name) {
                throw new FS.ErrnoError(63);
              },
              rmdir(parent, name) {
                throw new FS.ErrnoError(63);
              },
              readdir(node) {
                var entries = [".", ".."];
                for (var key of Object.keys(node.contents)) {
                  entries.push(key);
                }
                return entries;
              },
              symlink(parent, newName, oldPath) {
                throw new FS.ErrnoError(63);
              }
            },
            stream_ops: {
              read(stream, buffer, offset, length, position) {
                if (position >= stream.node.size) return 0;
                var chunk = stream.node.contents.slice(position, position + length);
                var ab = WORKERFS.reader.readAsArrayBuffer(chunk);
                buffer.set(new Uint8Array(ab), offset);
                return chunk.size;
              },
              write(stream, buffer, offset, length, position) {
                throw new FS.ErrnoError(29);
              },
              llseek(stream, offset, whence) {
                var position = offset;
                if (whence === 1) {
                  position += stream.position;
                } else if (whence === 2) {
                  if (FS.isFile(stream.node.mode)) {
                    position += stream.node.size;
                  }
                }
                if (position < 0) {
                  throw new FS.ErrnoError(28);
                }
                return position;
              }
            }
          };
          var UTF8ToString = (ptr, maxBytesToRead) => {
            assert(typeof ptr == "number", `UTF8ToString expects a number (got ${typeof ptr})`);
            return ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead) : "";
          };
          var strError = (errno) => UTF8ToString(_strerror(errno));
          var ERRNO_CODES = {
            "EPERM": 63,
            "ENOENT": 44,
            "ESRCH": 71,
            "EINTR": 27,
            "EIO": 29,
            "ENXIO": 60,
            "E2BIG": 1,
            "ENOEXEC": 45,
            "EBADF": 8,
            "ECHILD": 12,
            "EAGAIN": 6,
            "EWOULDBLOCK": 6,
            "ENOMEM": 48,
            "EACCES": 2,
            "EFAULT": 21,
            "ENOTBLK": 105,
            "EBUSY": 10,
            "EEXIST": 20,
            "EXDEV": 75,
            "ENODEV": 43,
            "ENOTDIR": 54,
            "EISDIR": 31,
            "EINVAL": 28,
            "ENFILE": 41,
            "EMFILE": 33,
            "ENOTTY": 59,
            "ETXTBSY": 74,
            "EFBIG": 22,
            "ENOSPC": 51,
            "ESPIPE": 70,
            "EROFS": 69,
            "EMLINK": 34,
            "EPIPE": 64,
            "EDOM": 18,
            "ERANGE": 68,
            "ENOMSG": 49,
            "EIDRM": 24,
            "ECHRNG": 106,
            "EL2NSYNC": 156,
            "EL3HLT": 107,
            "EL3RST": 108,
            "ELNRNG": 109,
            "EUNATCH": 110,
            "ENOCSI": 111,
            "EL2HLT": 112,
            "EDEADLK": 16,
            "ENOLCK": 46,
            "EBADE": 113,
            "EBADR": 114,
            "EXFULL": 115,
            "ENOANO": 104,
            "EBADRQC": 103,
            "EBADSLT": 102,
            "EDEADLOCK": 16,
            "EBFONT": 101,
            "ENOSTR": 100,
            "ENODATA": 116,
            "ETIME": 117,
            "ENOSR": 118,
            "ENONET": 119,
            "ENOPKG": 120,
            "EREMOTE": 121,
            "ENOLINK": 47,
            "EADV": 122,
            "ESRMNT": 123,
            "ECOMM": 124,
            "EPROTO": 65,
            "EMULTIHOP": 36,
            "EDOTDOT": 125,
            "EBADMSG": 9,
            "ENOTUNIQ": 126,
            "EBADFD": 127,
            "EREMCHG": 128,
            "ELIBACC": 129,
            "ELIBBAD": 130,
            "ELIBSCN": 131,
            "ELIBMAX": 132,
            "ELIBEXEC": 133,
            "ENOSYS": 52,
            "ENOTEMPTY": 55,
            "ENAMETOOLONG": 37,
            "ELOOP": 32,
            "EOPNOTSUPP": 138,
            "EPFNOSUPPORT": 139,
            "ECONNRESET": 15,
            "ENOBUFS": 42,
            "EAFNOSUPPORT": 5,
            "EPROTOTYPE": 67,
            "ENOTSOCK": 57,
            "ENOPROTOOPT": 50,
            "ESHUTDOWN": 140,
            "ECONNREFUSED": 14,
            "EADDRINUSE": 3,
            "ECONNABORTED": 13,
            "ENETUNREACH": 40,
            "ENETDOWN": 38,
            "ETIMEDOUT": 73,
            "EHOSTDOWN": 142,
            "EHOSTUNREACH": 23,
            "EINPROGRESS": 26,
            "EALREADY": 7,
            "EDESTADDRREQ": 17,
            "EMSGSIZE": 35,
            "EPROTONOSUPPORT": 66,
            "ESOCKTNOSUPPORT": 137,
            "EADDRNOTAVAIL": 4,
            "ENETRESET": 39,
            "EISCONN": 30,
            "ENOTCONN": 53,
            "ETOOMANYREFS": 141,
            "EUSERS": 136,
            "EDQUOT": 19,
            "ESTALE": 72,
            "ENOTSUP": 138,
            "ENOMEDIUM": 148,
            "EILSEQ": 25,
            "EOVERFLOW": 61,
            "ECANCELED": 11,
            "ENOTRECOVERABLE": 56,
            "EOWNERDEAD": 62,
            "ESTRPIPE": 135
          };
          var FS = {
            root: null,
            mounts: [],
            devices: {},
            streams: [],
            nextInode: 1,
            nameTable: null,
            currentPath: "/",
            initialized: false,
            ignorePermissions: true,
            filesystems: null,
            syncFSRequests: 0,
            readFiles: {},
            ErrnoError: class extends Error {
              // We set the `name` property to be able to identify `FS.ErrnoError`
              // - the `name` is a standard ECMA-262 property of error objects. Kind of good to have it anyway.
              // - when using PROXYFS, an error can come from an underlying FS
              // as different FS objects have their own FS.ErrnoError each,
              // the test `err instanceof FS.ErrnoError` won't detect an error coming from another filesystem, causing bugs.
              // we'll use the reliable test `err.name == "ErrnoError"` instead
              constructor(errno) {
                super(runtimeInitialized ? strError(errno) : "");
                __publicField(this, "name", "ErrnoError");
                this.errno = errno;
                for (var key in ERRNO_CODES) {
                  if (ERRNO_CODES[key] === errno) {
                    this.code = key;
                    break;
                  }
                }
              }
            },
            FSStream: class {
              constructor() {
                __publicField(this, "shared", {});
              }
              get object() {
                return this.node;
              }
              set object(val) {
                this.node = val;
              }
              get isRead() {
                return (this.flags & 2097155) !== 1;
              }
              get isWrite() {
                return (this.flags & 2097155) !== 0;
              }
              get isAppend() {
                return this.flags & 1024;
              }
              get flags() {
                return this.shared.flags;
              }
              set flags(val) {
                this.shared.flags = val;
              }
              get position() {
                return this.shared.position;
              }
              set position(val) {
                this.shared.position = val;
              }
            },
            FSNode: class {
              constructor(parent, name, mode, rdev) {
                __publicField(this, "node_ops", {});
                __publicField(this, "stream_ops", {});
                __publicField(this, "readMode", 292 | 73);
                __publicField(this, "writeMode", 146);
                __publicField(this, "mounted", null);
                if (!parent) {
                  parent = this;
                }
                this.parent = parent;
                this.mount = parent.mount;
                this.id = FS.nextInode++;
                this.name = name;
                this.mode = mode;
                this.rdev = rdev;
                this.atime = this.mtime = this.ctime = Date.now();
              }
              get read() {
                return (this.mode & this.readMode) === this.readMode;
              }
              set read(val) {
                val ? this.mode |= this.readMode : this.mode &= ~this.readMode;
              }
              get write() {
                return (this.mode & this.writeMode) === this.writeMode;
              }
              set write(val) {
                val ? this.mode |= this.writeMode : this.mode &= ~this.writeMode;
              }
              get isFolder() {
                return FS.isDir(this.mode);
              }
              get isDevice() {
                return FS.isChrdev(this.mode);
              }
            },
            lookupPath(path, opts = {}) {
              if (!path) {
                throw new FS.ErrnoError(44);
              }
              opts.follow_mount ?? (opts.follow_mount = true);
              if (!PATH.isAbs(path)) {
                path = FS.cwd() + "/" + path;
              }
              linkloop: for (var nlinks = 0; nlinks < 40; nlinks++) {
                var parts = path.split("/").filter((p) => !!p);
                var current = FS.root;
                var current_path = "/";
                for (var i = 0; i < parts.length; i++) {
                  var islast = i === parts.length - 1;
                  if (islast && opts.parent) {
                    break;
                  }
                  if (parts[i] === ".") {
                    continue;
                  }
                  if (parts[i] === "..") {
                    current_path = PATH.dirname(current_path);
                    if (FS.isRoot(current)) {
                      path = current_path + "/" + parts.slice(i + 1).join("/");
                      continue linkloop;
                    } else {
                      current = current.parent;
                    }
                    continue;
                  }
                  current_path = PATH.join2(current_path, parts[i]);
                  try {
                    current = FS.lookupNode(current, parts[i]);
                  } catch (e) {
                    if ((e == null ? void 0 : e.errno) === 44 && islast && opts.noent_okay) {
                      return {
                        path: current_path
                      };
                    }
                    throw e;
                  }
                  if (FS.isMountpoint(current) && (!islast || opts.follow_mount)) {
                    current = current.mounted.root;
                  }
                  if (FS.isLink(current.mode) && (!islast || opts.follow)) {
                    if (!current.node_ops.readlink) {
                      throw new FS.ErrnoError(52);
                    }
                    var link = current.node_ops.readlink(current);
                    if (!PATH.isAbs(link)) {
                      link = PATH.dirname(current_path) + "/" + link;
                    }
                    path = link + "/" + parts.slice(i + 1).join("/");
                    continue linkloop;
                  }
                }
                return {
                  path: current_path,
                  node: current
                };
              }
              throw new FS.ErrnoError(32);
            },
            getPath(node) {
              var path;
              while (true) {
                if (FS.isRoot(node)) {
                  var mount = node.mount.mountpoint;
                  if (!path) return mount;
                  return mount[mount.length - 1] !== "/" ? `${mount}/${path}` : mount + path;
                }
                path = path ? `${node.name}/${path}` : node.name;
                node = node.parent;
              }
            },
            hashName(parentid, name) {
              var hash = 0;
              for (var i = 0; i < name.length; i++) {
                hash = (hash << 5) - hash + name.charCodeAt(i) | 0;
              }
              return (parentid + hash >>> 0) % FS.nameTable.length;
            },
            hashAddNode(node) {
              var hash = FS.hashName(node.parent.id, node.name);
              node.name_next = FS.nameTable[hash];
              FS.nameTable[hash] = node;
            },
            hashRemoveNode(node) {
              var hash = FS.hashName(node.parent.id, node.name);
              if (FS.nameTable[hash] === node) {
                FS.nameTable[hash] = node.name_next;
              } else {
                var current = FS.nameTable[hash];
                while (current) {
                  if (current.name_next === node) {
                    current.name_next = node.name_next;
                    break;
                  }
                  current = current.name_next;
                }
              }
            },
            lookupNode(parent, name) {
              var errCode = FS.mayLookup(parent);
              if (errCode) {
                throw new FS.ErrnoError(errCode);
              }
              var hash = FS.hashName(parent.id, name);
              for (var node = FS.nameTable[hash]; node; node = node.name_next) {
                var nodeName = node.name;
                if (node.parent.id === parent.id && nodeName === name) {
                  return node;
                }
              }
              return FS.lookup(parent, name);
            },
            createNode(parent, name, mode, rdev) {
              assert(typeof parent == "object");
              var node = new FS.FSNode(parent, name, mode, rdev);
              FS.hashAddNode(node);
              return node;
            },
            destroyNode(node) {
              FS.hashRemoveNode(node);
            },
            isRoot(node) {
              return node === node.parent;
            },
            isMountpoint(node) {
              return !!node.mounted;
            },
            isFile(mode) {
              return (mode & 61440) === 32768;
            },
            isDir(mode) {
              return (mode & 61440) === 16384;
            },
            isLink(mode) {
              return (mode & 61440) === 40960;
            },
            isChrdev(mode) {
              return (mode & 61440) === 8192;
            },
            isBlkdev(mode) {
              return (mode & 61440) === 24576;
            },
            isFIFO(mode) {
              return (mode & 61440) === 4096;
            },
            isSocket(mode) {
              return (mode & 49152) === 49152;
            },
            flagsToPermissionString(flag) {
              var perms = ["r", "w", "rw"][flag & 3];
              if (flag & 512) {
                perms += "w";
              }
              return perms;
            },
            nodePermissions(node, perms) {
              if (FS.ignorePermissions) {
                return 0;
              }
              if (perms.includes("r") && !(node.mode & 292)) {
                return 2;
              } else if (perms.includes("w") && !(node.mode & 146)) {
                return 2;
              } else if (perms.includes("x") && !(node.mode & 73)) {
                return 2;
              }
              return 0;
            },
            mayLookup(dir) {
              if (!FS.isDir(dir.mode)) return 54;
              var errCode = FS.nodePermissions(dir, "x");
              if (errCode) return errCode;
              if (!dir.node_ops.lookup) return 2;
              return 0;
            },
            mayCreate(dir, name) {
              if (!FS.isDir(dir.mode)) {
                return 54;
              }
              try {
                var node = FS.lookupNode(dir, name);
                return 20;
              } catch (e) {
              }
              return FS.nodePermissions(dir, "wx");
            },
            mayDelete(dir, name, isdir) {
              var node;
              try {
                node = FS.lookupNode(dir, name);
              } catch (e) {
                return e.errno;
              }
              var errCode = FS.nodePermissions(dir, "wx");
              if (errCode) {
                return errCode;
              }
              if (isdir) {
                if (!FS.isDir(node.mode)) {
                  return 54;
                }
                if (FS.isRoot(node) || FS.getPath(node) === FS.cwd()) {
                  return 10;
                }
              } else {
                if (FS.isDir(node.mode)) {
                  return 31;
                }
              }
              return 0;
            },
            mayOpen(node, flags) {
              if (!node) {
                return 44;
              }
              if (FS.isLink(node.mode)) {
                return 32;
              } else if (FS.isDir(node.mode)) {
                if (FS.flagsToPermissionString(flags) !== "r" || flags & (512 | 64)) {
                  return 31;
                }
              }
              return FS.nodePermissions(node, FS.flagsToPermissionString(flags));
            },
            checkOpExists(op, err2) {
              if (!op) {
                throw new FS.ErrnoError(err2);
              }
              return op;
            },
            MAX_OPEN_FDS: 4096,
            nextfd() {
              for (var fd = 0; fd <= FS.MAX_OPEN_FDS; fd++) {
                if (!FS.streams[fd]) {
                  return fd;
                }
              }
              throw new FS.ErrnoError(33);
            },
            getStreamChecked(fd) {
              var stream = FS.getStream(fd);
              if (!stream) {
                throw new FS.ErrnoError(8);
              }
              return stream;
            },
            getStream: (fd) => FS.streams[fd],
            createStream(stream, fd = -1) {
              assert(fd >= -1);
              stream = Object.assign(new FS.FSStream(), stream);
              if (fd == -1) {
                fd = FS.nextfd();
              }
              stream.fd = fd;
              FS.streams[fd] = stream;
              return stream;
            },
            closeStream(fd) {
              FS.streams[fd] = null;
            },
            dupStream(origStream, fd = -1) {
              var _a2, _b;
              var stream = FS.createStream(origStream, fd);
              (_b = (_a2 = stream.stream_ops) == null ? void 0 : _a2.dup) == null ? void 0 : _b.call(_a2, stream);
              return stream;
            },
            doSetAttr(stream, node, attr) {
              var setattr = stream == null ? void 0 : stream.stream_ops.setattr;
              var arg = setattr ? stream : node;
              setattr ?? (setattr = node.node_ops.setattr);
              FS.checkOpExists(setattr, 63);
              setattr(arg, attr);
            },
            chrdev_stream_ops: {
              open(stream) {
                var _a2, _b;
                var device = FS.getDevice(stream.node.rdev);
                stream.stream_ops = device.stream_ops;
                (_b = (_a2 = stream.stream_ops).open) == null ? void 0 : _b.call(_a2, stream);
              },
              llseek() {
                throw new FS.ErrnoError(70);
              }
            },
            major: (dev) => dev >> 8,
            minor: (dev) => dev & 255,
            makedev: (ma, mi) => ma << 8 | mi,
            registerDevice(dev, ops) {
              FS.devices[dev] = {
                stream_ops: ops
              };
            },
            getDevice: (dev) => FS.devices[dev],
            getMounts(mount) {
              var mounts = [];
              var check = [mount];
              while (check.length) {
                var m = check.pop();
                mounts.push(m);
                check.push(...m.mounts);
              }
              return mounts;
            },
            syncfs(populate, callback) {
              if (typeof populate == "function") {
                callback = populate;
                populate = false;
              }
              FS.syncFSRequests++;
              if (FS.syncFSRequests > 1) {
                err(`warning: ${FS.syncFSRequests} FS.syncfs operations in flight at once, probably just doing extra work`);
              }
              var mounts = FS.getMounts(FS.root.mount);
              var completed = 0;
              function doCallback(errCode) {
                assert(FS.syncFSRequests > 0);
                FS.syncFSRequests--;
                return callback(errCode);
              }
              function done(errCode) {
                if (errCode) {
                  if (!done.errored) {
                    done.errored = true;
                    return doCallback(errCode);
                  }
                  return;
                }
                if (++completed >= mounts.length) {
                  doCallback(null);
                }
              }
              mounts.forEach((mount) => {
                if (!mount.type.syncfs) {
                  return done(null);
                }
                mount.type.syncfs(mount, populate, done);
              });
            },
            mount(type, opts, mountpoint) {
              if (typeof type == "string") {
                throw type;
              }
              var root = mountpoint === "/";
              var pseudo = !mountpoint;
              var node;
              if (root && FS.root) {
                throw new FS.ErrnoError(10);
              } else if (!root && !pseudo) {
                var lookup = FS.lookupPath(mountpoint, {
                  follow_mount: false
                });
                mountpoint = lookup.path;
                node = lookup.node;
                if (FS.isMountpoint(node)) {
                  throw new FS.ErrnoError(10);
                }
                if (!FS.isDir(node.mode)) {
                  throw new FS.ErrnoError(54);
                }
              }
              var mount = {
                type,
                opts,
                mountpoint,
                mounts: []
              };
              var mountRoot = type.mount(mount);
              mountRoot.mount = mount;
              mount.root = mountRoot;
              if (root) {
                FS.root = mountRoot;
              } else if (node) {
                node.mounted = mount;
                if (node.mount) {
                  node.mount.mounts.push(mount);
                }
              }
              return mountRoot;
            },
            unmount(mountpoint) {
              var lookup = FS.lookupPath(mountpoint, {
                follow_mount: false
              });
              if (!FS.isMountpoint(lookup.node)) {
                throw new FS.ErrnoError(28);
              }
              var node = lookup.node;
              var mount = node.mounted;
              var mounts = FS.getMounts(mount);
              Object.keys(FS.nameTable).forEach((hash) => {
                var current = FS.nameTable[hash];
                while (current) {
                  var next = current.name_next;
                  if (mounts.includes(current.mount)) {
                    FS.destroyNode(current);
                  }
                  current = next;
                }
              });
              node.mounted = null;
              var idx = node.mount.mounts.indexOf(mount);
              assert(idx !== -1);
              node.mount.mounts.splice(idx, 1);
            },
            lookup(parent, name) {
              return parent.node_ops.lookup(parent, name);
            },
            mknod(path, mode, dev) {
              var lookup = FS.lookupPath(path, {
                parent: true
              });
              var parent = lookup.node;
              var name = PATH.basename(path);
              if (!name) {
                throw new FS.ErrnoError(28);
              }
              if (name === "." || name === "..") {
                throw new FS.ErrnoError(20);
              }
              var errCode = FS.mayCreate(parent, name);
              if (errCode) {
                throw new FS.ErrnoError(errCode);
              }
              if (!parent.node_ops.mknod) {
                throw new FS.ErrnoError(63);
              }
              return parent.node_ops.mknod(parent, name, mode, dev);
            },
            statfs(path) {
              return FS.statfsNode(FS.lookupPath(path, {
                follow: true
              }).node);
            },
            statfsStream(stream) {
              return FS.statfsNode(stream.node);
            },
            statfsNode(node) {
              var rtn = {
                bsize: 4096,
                frsize: 4096,
                blocks: 1e6,
                bfree: 5e5,
                bavail: 5e5,
                files: FS.nextInode,
                ffree: FS.nextInode - 1,
                fsid: 42,
                flags: 2,
                namelen: 255
              };
              if (node.node_ops.statfs) {
                Object.assign(rtn, node.node_ops.statfs(node.mount.opts.root));
              }
              return rtn;
            },
            create(path, mode = 438) {
              mode &= 4095;
              mode |= 32768;
              return FS.mknod(path, mode, 0);
            },
            mkdir(path, mode = 511) {
              mode &= 511 | 512;
              mode |= 16384;
              return FS.mknod(path, mode, 0);
            },
            mkdirTree(path, mode) {
              var dirs = path.split("/");
              var d = "";
              for (var dir of dirs) {
                if (!dir) continue;
                if (d || PATH.isAbs(path)) d += "/";
                d += dir;
                try {
                  FS.mkdir(d, mode);
                } catch (e) {
                  if (e.errno != 20) throw e;
                }
              }
            },
            mkdev(path, mode, dev) {
              if (typeof dev == "undefined") {
                dev = mode;
                mode = 438;
              }
              mode |= 8192;
              return FS.mknod(path, mode, dev);
            },
            symlink(oldpath, newpath) {
              if (!PATH_FS.resolve(oldpath)) {
                throw new FS.ErrnoError(44);
              }
              var lookup = FS.lookupPath(newpath, {
                parent: true
              });
              var parent = lookup.node;
              if (!parent) {
                throw new FS.ErrnoError(44);
              }
              var newname = PATH.basename(newpath);
              var errCode = FS.mayCreate(parent, newname);
              if (errCode) {
                throw new FS.ErrnoError(errCode);
              }
              if (!parent.node_ops.symlink) {
                throw new FS.ErrnoError(63);
              }
              return parent.node_ops.symlink(parent, newname, oldpath);
            },
            rename(old_path, new_path) {
              var old_dirname = PATH.dirname(old_path);
              var new_dirname = PATH.dirname(new_path);
              var old_name = PATH.basename(old_path);
              var new_name = PATH.basename(new_path);
              var lookup, old_dir, new_dir;
              lookup = FS.lookupPath(old_path, {
                parent: true
              });
              old_dir = lookup.node;
              lookup = FS.lookupPath(new_path, {
                parent: true
              });
              new_dir = lookup.node;
              if (!old_dir || !new_dir) throw new FS.ErrnoError(44);
              if (old_dir.mount !== new_dir.mount) {
                throw new FS.ErrnoError(75);
              }
              var old_node = FS.lookupNode(old_dir, old_name);
              var relative = PATH_FS.relative(old_path, new_dirname);
              if (relative.charAt(0) !== ".") {
                throw new FS.ErrnoError(28);
              }
              relative = PATH_FS.relative(new_path, old_dirname);
              if (relative.charAt(0) !== ".") {
                throw new FS.ErrnoError(55);
              }
              var new_node;
              try {
                new_node = FS.lookupNode(new_dir, new_name);
              } catch (e) {
              }
              if (old_node === new_node) {
                return;
              }
              var isdir = FS.isDir(old_node.mode);
              var errCode = FS.mayDelete(old_dir, old_name, isdir);
              if (errCode) {
                throw new FS.ErrnoError(errCode);
              }
              errCode = new_node ? FS.mayDelete(new_dir, new_name, isdir) : FS.mayCreate(new_dir, new_name);
              if (errCode) {
                throw new FS.ErrnoError(errCode);
              }
              if (!old_dir.node_ops.rename) {
                throw new FS.ErrnoError(63);
              }
              if (FS.isMountpoint(old_node) || new_node && FS.isMountpoint(new_node)) {
                throw new FS.ErrnoError(10);
              }
              if (new_dir !== old_dir) {
                errCode = FS.nodePermissions(old_dir, "w");
                if (errCode) {
                  throw new FS.ErrnoError(errCode);
                }
              }
              FS.hashRemoveNode(old_node);
              try {
                old_dir.node_ops.rename(old_node, new_dir, new_name);
                old_node.parent = new_dir;
              } catch (e) {
                throw e;
              } finally {
                FS.hashAddNode(old_node);
              }
            },
            rmdir(path) {
              var lookup = FS.lookupPath(path, {
                parent: true
              });
              var parent = lookup.node;
              var name = PATH.basename(path);
              var node = FS.lookupNode(parent, name);
              var errCode = FS.mayDelete(parent, name, true);
              if (errCode) {
                throw new FS.ErrnoError(errCode);
              }
              if (!parent.node_ops.rmdir) {
                throw new FS.ErrnoError(63);
              }
              if (FS.isMountpoint(node)) {
                throw new FS.ErrnoError(10);
              }
              parent.node_ops.rmdir(parent, name);
              FS.destroyNode(node);
            },
            readdir(path) {
              var lookup = FS.lookupPath(path, {
                follow: true
              });
              var node = lookup.node;
              var readdir = FS.checkOpExists(node.node_ops.readdir, 54);
              return readdir(node);
            },
            unlink(path) {
              var lookup = FS.lookupPath(path, {
                parent: true
              });
              var parent = lookup.node;
              if (!parent) {
                throw new FS.ErrnoError(44);
              }
              var name = PATH.basename(path);
              var node = FS.lookupNode(parent, name);
              var errCode = FS.mayDelete(parent, name, false);
              if (errCode) {
                throw new FS.ErrnoError(errCode);
              }
              if (!parent.node_ops.unlink) {
                throw new FS.ErrnoError(63);
              }
              if (FS.isMountpoint(node)) {
                throw new FS.ErrnoError(10);
              }
              parent.node_ops.unlink(parent, name);
              FS.destroyNode(node);
            },
            readlink(path) {
              var lookup = FS.lookupPath(path);
              var link = lookup.node;
              if (!link) {
                throw new FS.ErrnoError(44);
              }
              if (!link.node_ops.readlink) {
                throw new FS.ErrnoError(28);
              }
              return link.node_ops.readlink(link);
            },
            stat(path, dontFollow) {
              var lookup = FS.lookupPath(path, {
                follow: !dontFollow
              });
              var node = lookup.node;
              var getattr = FS.checkOpExists(node.node_ops.getattr, 63);
              return getattr(node);
            },
            fstat(fd) {
              var stream = FS.getStreamChecked(fd);
              var node = stream.node;
              var getattr = stream.stream_ops.getattr;
              var arg = getattr ? stream : node;
              getattr ?? (getattr = node.node_ops.getattr);
              FS.checkOpExists(getattr, 63);
              return getattr(arg);
            },
            lstat(path) {
              return FS.stat(path, true);
            },
            doChmod(stream, node, mode, dontFollow) {
              FS.doSetAttr(stream, node, {
                mode: mode & 4095 | node.mode & -4096,
                ctime: Date.now(),
                dontFollow
              });
            },
            chmod(path, mode, dontFollow) {
              var node;
              if (typeof path == "string") {
                var lookup = FS.lookupPath(path, {
                  follow: !dontFollow
                });
                node = lookup.node;
              } else {
                node = path;
              }
              FS.doChmod(null, node, mode, dontFollow);
            },
            lchmod(path, mode) {
              FS.chmod(path, mode, true);
            },
            fchmod(fd, mode) {
              var stream = FS.getStreamChecked(fd);
              FS.doChmod(stream, stream.node, mode, false);
            },
            doChown(stream, node, dontFollow) {
              FS.doSetAttr(stream, node, {
                timestamp: Date.now(),
                dontFollow
              });
            },
            chown(path, uid, gid, dontFollow) {
              var node;
              if (typeof path == "string") {
                var lookup = FS.lookupPath(path, {
                  follow: !dontFollow
                });
                node = lookup.node;
              } else {
                node = path;
              }
              FS.doChown(null, node, dontFollow);
            },
            lchown(path, uid, gid) {
              FS.chown(path, uid, gid, true);
            },
            fchown(fd, uid, gid) {
              var stream = FS.getStreamChecked(fd);
              FS.doChown(stream, stream.node, false);
            },
            doTruncate(stream, node, len) {
              if (FS.isDir(node.mode)) {
                throw new FS.ErrnoError(31);
              }
              if (!FS.isFile(node.mode)) {
                throw new FS.ErrnoError(28);
              }
              var errCode = FS.nodePermissions(node, "w");
              if (errCode) {
                throw new FS.ErrnoError(errCode);
              }
              FS.doSetAttr(stream, node, {
                size: len,
                timestamp: Date.now()
              });
            },
            truncate(path, len) {
              if (len < 0) {
                throw new FS.ErrnoError(28);
              }
              var node;
              if (typeof path == "string") {
                var lookup = FS.lookupPath(path, {
                  follow: true
                });
                node = lookup.node;
              } else {
                node = path;
              }
              FS.doTruncate(null, node, len);
            },
            ftruncate(fd, len) {
              var stream = FS.getStreamChecked(fd);
              if (len < 0 || (stream.flags & 2097155) === 0) {
                throw new FS.ErrnoError(28);
              }
              FS.doTruncate(stream, stream.node, len);
            },
            utime(path, atime, mtime) {
              var lookup = FS.lookupPath(path, {
                follow: true
              });
              var node = lookup.node;
              var setattr = FS.checkOpExists(node.node_ops.setattr, 63);
              setattr(node, {
                atime,
                mtime
              });
            },
            open(path, flags, mode = 438) {
              if (path === "") {
                throw new FS.ErrnoError(44);
              }
              flags = typeof flags == "string" ? FS_modeStringToFlags(flags) : flags;
              if (flags & 64) {
                mode = mode & 4095 | 32768;
              } else {
                mode = 0;
              }
              var node;
              var isDirPath;
              if (typeof path == "object") {
                node = path;
              } else {
                isDirPath = path.endsWith("/");
                var lookup = FS.lookupPath(path, {
                  follow: !(flags & 131072),
                  noent_okay: true
                });
                node = lookup.node;
                path = lookup.path;
              }
              var created = false;
              if (flags & 64) {
                if (node) {
                  if (flags & 128) {
                    throw new FS.ErrnoError(20);
                  }
                } else if (isDirPath) {
                  throw new FS.ErrnoError(31);
                } else {
                  node = FS.mknod(path, mode | 511, 0);
                  created = true;
                }
              }
              if (!node) {
                throw new FS.ErrnoError(44);
              }
              if (FS.isChrdev(node.mode)) {
                flags &= -513;
              }
              if (flags & 65536 && !FS.isDir(node.mode)) {
                throw new FS.ErrnoError(54);
              }
              if (!created) {
                var errCode = FS.mayOpen(node, flags);
                if (errCode) {
                  throw new FS.ErrnoError(errCode);
                }
              }
              if (flags & 512 && !created) {
                FS.truncate(node, 0);
              }
              flags &= -131713;
              var stream = FS.createStream({
                node,
                path: FS.getPath(node),
                // we want the absolute path to the node
                flags,
                seekable: true,
                position: 0,
                stream_ops: node.stream_ops,
                // used by the file family libc calls (fopen, fwrite, ferror, etc.)
                ungotten: [],
                error: false
              });
              if (stream.stream_ops.open) {
                stream.stream_ops.open(stream);
              }
              if (created) {
                FS.chmod(node, mode & 511);
              }
              if (Module["logReadFiles"] && !(flags & 1)) {
                if (!(path in FS.readFiles)) {
                  FS.readFiles[path] = 1;
                }
              }
              return stream;
            },
            close(stream) {
              if (FS.isClosed(stream)) {
                throw new FS.ErrnoError(8);
              }
              if (stream.getdents) stream.getdents = null;
              try {
                if (stream.stream_ops.close) {
                  stream.stream_ops.close(stream);
                }
              } catch (e) {
                throw e;
              } finally {
                FS.closeStream(stream.fd);
              }
              stream.fd = null;
            },
            isClosed(stream) {
              return stream.fd === null;
            },
            llseek(stream, offset, whence) {
              if (FS.isClosed(stream)) {
                throw new FS.ErrnoError(8);
              }
              if (!stream.seekable || !stream.stream_ops.llseek) {
                throw new FS.ErrnoError(70);
              }
              if (whence != 0 && whence != 1 && whence != 2) {
                throw new FS.ErrnoError(28);
              }
              stream.position = stream.stream_ops.llseek(stream, offset, whence);
              stream.ungotten = [];
              return stream.position;
            },
            read(stream, buffer, offset, length, position) {
              assert(offset >= 0);
              if (length < 0 || position < 0) {
                throw new FS.ErrnoError(28);
              }
              if (FS.isClosed(stream)) {
                throw new FS.ErrnoError(8);
              }
              if ((stream.flags & 2097155) === 1) {
                throw new FS.ErrnoError(8);
              }
              if (FS.isDir(stream.node.mode)) {
                throw new FS.ErrnoError(31);
              }
              if (!stream.stream_ops.read) {
                throw new FS.ErrnoError(28);
              }
              var seeking = typeof position != "undefined";
              if (!seeking) {
                position = stream.position;
              } else if (!stream.seekable) {
                throw new FS.ErrnoError(70);
              }
              var bytesRead = stream.stream_ops.read(stream, buffer, offset, length, position);
              if (!seeking) stream.position += bytesRead;
              return bytesRead;
            },
            write(stream, buffer, offset, length, position, canOwn) {
              assert(offset >= 0);
              if (length < 0 || position < 0) {
                throw new FS.ErrnoError(28);
              }
              if (FS.isClosed(stream)) {
                throw new FS.ErrnoError(8);
              }
              if ((stream.flags & 2097155) === 0) {
                throw new FS.ErrnoError(8);
              }
              if (FS.isDir(stream.node.mode)) {
                throw new FS.ErrnoError(31);
              }
              if (!stream.stream_ops.write) {
                throw new FS.ErrnoError(28);
              }
              if (stream.seekable && stream.flags & 1024) {
                FS.llseek(stream, 0, 2);
              }
              var seeking = typeof position != "undefined";
              if (!seeking) {
                position = stream.position;
              } else if (!stream.seekable) {
                throw new FS.ErrnoError(70);
              }
              var bytesWritten = stream.stream_ops.write(stream, buffer, offset, length, position, canOwn);
              if (!seeking) stream.position += bytesWritten;
              return bytesWritten;
            },
            mmap(stream, length, position, prot, flags) {
              if ((prot & 2) !== 0 && (flags & 2) === 0 && (stream.flags & 2097155) !== 2) {
                throw new FS.ErrnoError(2);
              }
              if ((stream.flags & 2097155) === 1) {
                throw new FS.ErrnoError(2);
              }
              if (!stream.stream_ops.mmap) {
                throw new FS.ErrnoError(43);
              }
              if (!length) {
                throw new FS.ErrnoError(28);
              }
              return stream.stream_ops.mmap(stream, length, position, prot, flags);
            },
            msync(stream, buffer, offset, length, mmapFlags) {
              assert(offset >= 0);
              if (!stream.stream_ops.msync) {
                return 0;
              }
              return stream.stream_ops.msync(stream, buffer, offset, length, mmapFlags);
            },
            ioctl(stream, cmd, arg) {
              if (!stream.stream_ops.ioctl) {
                throw new FS.ErrnoError(59);
              }
              return stream.stream_ops.ioctl(stream, cmd, arg);
            },
            readFile(path, opts = {}) {
              opts.flags = opts.flags || 0;
              opts.encoding = opts.encoding || "binary";
              if (opts.encoding !== "utf8" && opts.encoding !== "binary") {
                throw new Error(`Invalid encoding type "${opts.encoding}"`);
              }
              var ret;
              var stream = FS.open(path, opts.flags);
              var stat = FS.stat(path);
              var length = stat.size;
              var buf = new Uint8Array(length);
              FS.read(stream, buf, 0, length, 0);
              if (opts.encoding === "utf8") {
                ret = UTF8ArrayToString(buf);
              } else if (opts.encoding === "binary") {
                ret = buf;
              }
              FS.close(stream);
              return ret;
            },
            writeFile(path, data, opts = {}) {
              opts.flags = opts.flags || 577;
              var stream = FS.open(path, opts.flags, opts.mode);
              if (typeof data == "string") {
                var buf = new Uint8Array(lengthBytesUTF8(data) + 1);
                var actualNumBytes = stringToUTF8Array(data, buf, 0, buf.length);
                FS.write(stream, buf, 0, actualNumBytes, void 0, opts.canOwn);
              } else if (ArrayBuffer.isView(data)) {
                FS.write(stream, data, 0, data.byteLength, void 0, opts.canOwn);
              } else {
                throw new Error("Unsupported data type");
              }
              FS.close(stream);
            },
            cwd: () => FS.currentPath,
            chdir(path) {
              var lookup = FS.lookupPath(path, {
                follow: true
              });
              if (lookup.node === null) {
                throw new FS.ErrnoError(44);
              }
              if (!FS.isDir(lookup.node.mode)) {
                throw new FS.ErrnoError(54);
              }
              var errCode = FS.nodePermissions(lookup.node, "x");
              if (errCode) {
                throw new FS.ErrnoError(errCode);
              }
              FS.currentPath = lookup.path;
            },
            createDefaultDirectories() {
              FS.mkdir("/tmp");
              FS.mkdir("/home");
              FS.mkdir("/home/web_user");
            },
            createDefaultDevices() {
              FS.mkdir("/dev");
              FS.registerDevice(FS.makedev(1, 3), {
                read: () => 0,
                write: (stream, buffer, offset, length, pos) => length,
                llseek: () => 0
              });
              FS.mkdev("/dev/null", FS.makedev(1, 3));
              TTY.register(FS.makedev(5, 0), TTY.default_tty_ops);
              TTY.register(FS.makedev(6, 0), TTY.default_tty1_ops);
              FS.mkdev("/dev/tty", FS.makedev(5, 0));
              FS.mkdev("/dev/tty1", FS.makedev(6, 0));
              var randomBuffer = new Uint8Array(1024), randomLeft = 0;
              var randomByte = () => {
                if (randomLeft === 0) {
                  randomFill(randomBuffer);
                  randomLeft = randomBuffer.byteLength;
                }
                return randomBuffer[--randomLeft];
              };
              FS.createDevice("/dev", "random", randomByte);
              FS.createDevice("/dev", "urandom", randomByte);
              FS.mkdir("/dev/shm");
              FS.mkdir("/dev/shm/tmp");
            },
            createSpecialDirectories() {
              FS.mkdir("/proc");
              var proc_self = FS.mkdir("/proc/self");
              FS.mkdir("/proc/self/fd");
              FS.mount({
                mount() {
                  var node = FS.createNode(proc_self, "fd", 16895, 73);
                  node.stream_ops = {
                    llseek: MEMFS.stream_ops.llseek
                  };
                  node.node_ops = {
                    lookup(parent, name) {
                      var fd = +name;
                      var stream = FS.getStreamChecked(fd);
                      var ret = {
                        parent: null,
                        mount: {
                          mountpoint: "fake"
                        },
                        node_ops: {
                          readlink: () => stream.path
                        },
                        id: fd + 1
                      };
                      ret.parent = ret;
                      return ret;
                    },
                    readdir() {
                      return Array.from(FS.streams.entries()).filter(([k, v]) => v).map(([k, v]) => k.toString());
                    }
                  };
                  return node;
                }
              }, {}, "/proc/self/fd");
            },
            createStandardStreams(input, output, error) {
              if (input) {
                FS.createDevice("/dev", "stdin", input);
              } else {
                FS.symlink("/dev/tty", "/dev/stdin");
              }
              if (output) {
                FS.createDevice("/dev", "stdout", null, output);
              } else {
                FS.symlink("/dev/tty", "/dev/stdout");
              }
              if (error) {
                FS.createDevice("/dev", "stderr", null, error);
              } else {
                FS.symlink("/dev/tty1", "/dev/stderr");
              }
              var stdin = FS.open("/dev/stdin", 0);
              var stdout = FS.open("/dev/stdout", 1);
              var stderr = FS.open("/dev/stderr", 1);
              assert(stdin.fd === 0, `invalid handle for stdin (${stdin.fd})`);
              assert(stdout.fd === 1, `invalid handle for stdout (${stdout.fd})`);
              assert(stderr.fd === 2, `invalid handle for stderr (${stderr.fd})`);
            },
            staticInit() {
              FS.nameTable = new Array(4096);
              FS.mount(MEMFS, {}, "/");
              FS.createDefaultDirectories();
              FS.createDefaultDevices();
              FS.createSpecialDirectories();
              FS.filesystems = {
                "MEMFS": MEMFS,
                "WORKERFS": WORKERFS
              };
            },
            init(input, output, error) {
              assert(!FS.initialized, "FS.init was previously called. If you want to initialize later with custom parameters, remove any earlier calls (note that one is automatically added to the generated code)");
              FS.initialized = true;
              input ?? (input = Module["stdin"]);
              output ?? (output = Module["stdout"]);
              error ?? (error = Module["stderr"]);
              FS.createStandardStreams(input, output, error);
            },
            quit() {
              FS.initialized = false;
              _fflush(0);
              for (var stream of FS.streams) {
                if (stream) {
                  FS.close(stream);
                }
              }
            },
            findObject(path, dontResolveLastLink) {
              var ret = FS.analyzePath(path, dontResolveLastLink);
              if (!ret.exists) {
                return null;
              }
              return ret.object;
            },
            analyzePath(path, dontResolveLastLink) {
              try {
                var lookup = FS.lookupPath(path, {
                  follow: !dontResolveLastLink
                });
                path = lookup.path;
              } catch (e) {
              }
              var ret = {
                isRoot: false,
                exists: false,
                error: 0,
                name: null,
                path: null,
                object: null,
                parentExists: false,
                parentPath: null,
                parentObject: null
              };
              try {
                var lookup = FS.lookupPath(path, {
                  parent: true
                });
                ret.parentExists = true;
                ret.parentPath = lookup.path;
                ret.parentObject = lookup.node;
                ret.name = PATH.basename(path);
                lookup = FS.lookupPath(path, {
                  follow: !dontResolveLastLink
                });
                ret.exists = true;
                ret.path = lookup.path;
                ret.object = lookup.node;
                ret.name = lookup.node.name;
                ret.isRoot = lookup.path === "/";
              } catch (e) {
                ret.error = e.errno;
              }
              return ret;
            },
            createPath(parent, path, canRead, canWrite) {
              parent = typeof parent == "string" ? parent : FS.getPath(parent);
              var parts = path.split("/").reverse();
              while (parts.length) {
                var part = parts.pop();
                if (!part) continue;
                var current = PATH.join2(parent, part);
                try {
                  FS.mkdir(current);
                } catch (e) {
                  if (e.errno != 20) throw e;
                }
                parent = current;
              }
              return current;
            },
            createFile(parent, name, properties, canRead, canWrite) {
              var path = PATH.join2(typeof parent == "string" ? parent : FS.getPath(parent), name);
              var mode = FS_getMode(canRead, canWrite);
              return FS.create(path, mode);
            },
            createDataFile(parent, name, data, canRead, canWrite, canOwn) {
              var path = name;
              if (parent) {
                parent = typeof parent == "string" ? parent : FS.getPath(parent);
                path = name ? PATH.join2(parent, name) : parent;
              }
              var mode = FS_getMode(canRead, canWrite);
              var node = FS.create(path, mode);
              if (data) {
                if (typeof data == "string") {
                  var arr = new Array(data.length);
                  for (var i = 0, len = data.length; i < len; ++i) arr[i] = data.charCodeAt(i);
                  data = arr;
                }
                FS.chmod(node, mode | 146);
                var stream = FS.open(node, 577);
                FS.write(stream, data, 0, data.length, 0, canOwn);
                FS.close(stream);
                FS.chmod(node, mode);
              }
            },
            createDevice(parent, name, input, output) {
              var _a2;
              var path = PATH.join2(typeof parent == "string" ? parent : FS.getPath(parent), name);
              var mode = FS_getMode(!!input, !!output);
              (_a2 = FS.createDevice).major ?? (_a2.major = 64);
              var dev = FS.makedev(FS.createDevice.major++, 0);
              FS.registerDevice(dev, {
                open(stream) {
                  stream.seekable = false;
                },
                close(stream) {
                  var _a3;
                  if ((_a3 = output == null ? void 0 : output.buffer) == null ? void 0 : _a3.length) {
                    output(10);
                  }
                },
                read(stream, buffer, offset, length, pos) {
                  var bytesRead = 0;
                  for (var i = 0; i < length; i++) {
                    var result;
                    try {
                      result = input();
                    } catch (e) {
                      throw new FS.ErrnoError(29);
                    }
                    if (result === void 0 && bytesRead === 0) {
                      throw new FS.ErrnoError(6);
                    }
                    if (result === null || result === void 0) break;
                    bytesRead++;
                    buffer[offset + i] = result;
                  }
                  if (bytesRead) {
                    stream.node.atime = Date.now();
                  }
                  return bytesRead;
                },
                write(stream, buffer, offset, length, pos) {
                  for (var i = 0; i < length; i++) {
                    try {
                      output(buffer[offset + i]);
                    } catch (e) {
                      throw new FS.ErrnoError(29);
                    }
                  }
                  if (length) {
                    stream.node.mtime = stream.node.ctime = Date.now();
                  }
                  return i;
                }
              });
              return FS.mkdev(path, mode, dev);
            },
            forceLoadFile(obj) {
              if (obj.isDevice || obj.isFolder || obj.link || obj.contents) return true;
              if (typeof XMLHttpRequest != "undefined") {
                throw new Error("Lazy loading should have been performed (contents set) in createLazyFile, but it was not. Lazy loading only works in web workers. Use --embed-file or --preload-file in emcc on the main thread.");
              } else {
                try {
                  obj.contents = readBinary(obj.url);
                  obj.usedBytes = obj.contents.length;
                } catch (e) {
                  throw new FS.ErrnoError(29);
                }
              }
            },
            createLazyFile(parent, name, url, canRead, canWrite) {
              class LazyUint8Array {
                constructor() {
                  __publicField(this, "lengthKnown", false);
                  __publicField(this, "chunks", []);
                }
                // Loaded chunks. Index is the chunk number
                get(idx) {
                  if (idx > this.length - 1 || idx < 0) {
                    return void 0;
                  }
                  var chunkOffset = idx % this.chunkSize;
                  var chunkNum = idx / this.chunkSize | 0;
                  return this.getter(chunkNum)[chunkOffset];
                }
                setDataGetter(getter) {
                  this.getter = getter;
                }
                cacheLength() {
                  var xhr = new XMLHttpRequest();
                  xhr.open("HEAD", url, false);
                  xhr.send(null);
                  if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
                  var datalength = Number(xhr.getResponseHeader("Content-length"));
                  var header;
                  var hasByteServing = (header = xhr.getResponseHeader("Accept-Ranges")) && header === "bytes";
                  var usesGzip = (header = xhr.getResponseHeader("Content-Encoding")) && header === "gzip";
                  var chunkSize = 1024 * 1024;
                  if (!hasByteServing) chunkSize = datalength;
                  var doXHR = (from, to) => {
                    if (from > to) throw new Error("invalid range (" + from + ", " + to + ") or no bytes requested!");
                    if (to > datalength - 1) throw new Error("only " + datalength + " bytes available! programmer error!");
                    var xhr2 = new XMLHttpRequest();
                    xhr2.open("GET", url, false);
                    if (datalength !== chunkSize) xhr2.setRequestHeader("Range", "bytes=" + from + "-" + to);
                    xhr2.responseType = "arraybuffer";
                    if (xhr2.overrideMimeType) {
                      xhr2.overrideMimeType("text/plain; charset=x-user-defined");
                    }
                    xhr2.send(null);
                    if (!(xhr2.status >= 200 && xhr2.status < 300 || xhr2.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr2.status);
                    if (xhr2.response !== void 0) {
                      return new Uint8Array(
                        /** @type{Array<number>} */
                        xhr2.response || []
                      );
                    }
                    return intArrayFromString(xhr2.responseText || "");
                  };
                  var lazyArray2 = this;
                  lazyArray2.setDataGetter((chunkNum) => {
                    var start = chunkNum * chunkSize;
                    var end = (chunkNum + 1) * chunkSize - 1;
                    end = Math.min(end, datalength - 1);
                    if (typeof lazyArray2.chunks[chunkNum] == "undefined") {
                      lazyArray2.chunks[chunkNum] = doXHR(start, end);
                    }
                    if (typeof lazyArray2.chunks[chunkNum] == "undefined") throw new Error("doXHR failed!");
                    return lazyArray2.chunks[chunkNum];
                  });
                  if (usesGzip || !datalength) {
                    chunkSize = datalength = 1;
                    datalength = this.getter(0).length;
                    chunkSize = datalength;
                    out("LazyFiles on gzip forces download of the whole file when length is accessed");
                  }
                  this._length = datalength;
                  this._chunkSize = chunkSize;
                  this.lengthKnown = true;
                }
                get length() {
                  if (!this.lengthKnown) {
                    this.cacheLength();
                  }
                  return this._length;
                }
                get chunkSize() {
                  if (!this.lengthKnown) {
                    this.cacheLength();
                  }
                  return this._chunkSize;
                }
              }
              if (typeof XMLHttpRequest != "undefined") {
                if (!ENVIRONMENT_IS_WORKER) throw "Cannot do synchronous binary XHRs outside webworkers in modern browsers. Use --embed-file or --preload-file in emcc";
                var lazyArray = new LazyUint8Array();
                var properties = {
                  isDevice: false,
                  contents: lazyArray
                };
              } else {
                var properties = {
                  isDevice: false,
                  url
                };
              }
              var node = FS.createFile(parent, name, properties, canRead, canWrite);
              if (properties.contents) {
                node.contents = properties.contents;
              } else if (properties.url) {
                node.contents = null;
                node.url = properties.url;
              }
              Object.defineProperties(node, {
                usedBytes: {
                  get: function() {
                    return this.contents.length;
                  }
                }
              });
              var stream_ops = {};
              var keys = Object.keys(node.stream_ops);
              keys.forEach((key) => {
                var fn = node.stream_ops[key];
                stream_ops[key] = (...args) => {
                  FS.forceLoadFile(node);
                  return fn(...args);
                };
              });
              function writeChunks(stream, buffer, offset, length, position) {
                var contents = stream.node.contents;
                if (position >= contents.length) return 0;
                var size = Math.min(contents.length - position, length);
                assert(size >= 0);
                if (contents.slice) {
                  for (var i = 0; i < size; i++) {
                    buffer[offset + i] = contents[position + i];
                  }
                } else {
                  for (var i = 0; i < size; i++) {
                    buffer[offset + i] = contents.get(position + i);
                  }
                }
                return size;
              }
              stream_ops.read = (stream, buffer, offset, length, position) => {
                FS.forceLoadFile(node);
                return writeChunks(stream, buffer, offset, length, position);
              };
              stream_ops.mmap = (stream, length, position, prot, flags) => {
                FS.forceLoadFile(node);
                var ptr = mmapAlloc(length);
                if (!ptr) {
                  throw new FS.ErrnoError(48);
                }
                writeChunks(stream, HEAP8, ptr, length, position);
                return {
                  ptr,
                  allocated: true
                };
              };
              node.stream_ops = stream_ops;
              return node;
            },
            absolutePath() {
              abort("FS.absolutePath has been removed; use PATH_FS.resolve instead");
            },
            createFolder() {
              abort("FS.createFolder has been removed; use FS.mkdir instead");
            },
            createLink() {
              abort("FS.createLink has been removed; use FS.symlink instead");
            },
            joinPath() {
              abort("FS.joinPath has been removed; use PATH.join instead");
            },
            mmapAlloc() {
              abort("FS.mmapAlloc has been replaced by the top level function mmapAlloc");
            },
            standardizePath() {
              abort("FS.standardizePath has been removed; use PATH.normalize instead");
            }
          };
          var SYSCALLS = {
            DEFAULT_POLLMASK: 5,
            calculateAt(dirfd, path, allowEmpty) {
              if (PATH.isAbs(path)) {
                return path;
              }
              var dir;
              if (dirfd === -100) {
                dir = FS.cwd();
              } else {
                var dirstream = SYSCALLS.getStreamFromFD(dirfd);
                dir = dirstream.path;
              }
              if (path.length == 0) {
                if (!allowEmpty) {
                  throw new FS.ErrnoError(44);
                }
                return dir;
              }
              return dir + "/" + path;
            },
            writeStat(buf, stat) {
              HEAP32[buf / 4] = stat.dev;
              HEAP32[(buf + 4) / 4] = stat.mode;
              HEAPU64[(buf + 8) / 8] = BigInt(stat.nlink);
              HEAP32[(buf + 16) / 4] = stat.uid;
              HEAP32[(buf + 20) / 4] = stat.gid;
              HEAP32[(buf + 24) / 4] = stat.rdev;
              HEAP64[(buf + 32) / 8] = BigInt(stat.size);
              HEAP32[(buf + 40) / 4] = 4096;
              HEAP32[(buf + 44) / 4] = stat.blocks;
              var atime = stat.atime.getTime();
              var mtime = stat.mtime.getTime();
              var ctime = stat.ctime.getTime();
              HEAP64[(buf + 48) / 8] = BigInt(Math.floor(atime / 1e3));
              HEAPU64[(buf + 56) / 8] = BigInt(atime % 1e3 * 1e3 * 1e3);
              HEAP64[(buf + 64) / 8] = BigInt(Math.floor(mtime / 1e3));
              HEAPU64[(buf + 72) / 8] = BigInt(mtime % 1e3 * 1e3 * 1e3);
              HEAP64[(buf + 80) / 8] = BigInt(Math.floor(ctime / 1e3));
              HEAPU64[(buf + 88) / 8] = BigInt(ctime % 1e3 * 1e3 * 1e3);
              HEAP64[(buf + 96) / 8] = BigInt(stat.ino);
              return 0;
            },
            writeStatFs(buf, stats) {
              HEAP32[(buf + 8) / 4] = stats.bsize;
              HEAP32[(buf + 56) / 4] = stats.bsize;
              HEAP32[(buf + 16) / 4] = stats.blocks;
              HEAP32[(buf + 20) / 4] = stats.bfree;
              HEAP32[(buf + 24) / 4] = stats.bavail;
              HEAP32[(buf + 28) / 4] = stats.files;
              HEAP32[(buf + 32) / 4] = stats.ffree;
              HEAP32[(buf + 36) / 4] = stats.fsid;
              HEAP32[(buf + 64) / 4] = stats.flags;
              HEAP32[(buf + 48) / 4] = stats.namelen;
            },
            doMsync(addr, stream, len, flags, offset) {
              if (!FS.isFile(stream.node.mode)) {
                throw new FS.ErrnoError(43);
              }
              if (flags & 2) {
                return 0;
              }
              var buffer = HEAPU8.slice(addr, addr + len);
              FS.msync(stream, buffer, offset, len, flags);
            },
            getStreamFromFD(fd) {
              var stream = FS.getStreamChecked(fd);
              return stream;
            },
            varargs: void 0,
            getStr(ptr) {
              var ret = UTF8ToString(ptr);
              return ret;
            }
          };
          var INT53_MAX = 9007199254740992;
          var INT53_MIN = -9007199254740992;
          var bigintToI53Checked = (num) => num < INT53_MIN || num > INT53_MAX ? NaN : Number(num);
          function ___syscall_chmod(path, mode) {
            path = bigintToI53Checked(path);
            try {
              path = SYSCALLS.getStr(path);
              FS.chmod(path, mode);
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_faccessat(dirfd, path, amode, flags) {
            path = bigintToI53Checked(path);
            try {
              path = SYSCALLS.getStr(path);
              assert(flags === 0 || flags == 512);
              path = SYSCALLS.calculateAt(dirfd, path);
              if (amode & ~7) {
                return -28;
              }
              var lookup = FS.lookupPath(path, {
                follow: true
              });
              var node = lookup.node;
              if (!node) {
                return -44;
              }
              var perms = "";
              if (amode & 4) perms += "r";
              if (amode & 2) perms += "w";
              if (amode & 1) perms += "x";
              if (perms && FS.nodePermissions(node, perms)) {
                return -2;
              }
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_fchmod(fd, mode) {
            try {
              FS.fchmod(fd, mode);
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_fchown32(fd, owner, group) {
            try {
              FS.fchown(fd, owner, group);
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          var syscallGetVarargP = () => {
            assert(SYSCALLS.varargs != void 0);
            var ret = Number(HEAPU64[SYSCALLS.varargs / 8]);
            SYSCALLS.varargs += 8;
            return ret;
          };
          var syscallGetVarargI = () => {
            assert(SYSCALLS.varargs != void 0);
            var ret = HEAP32[+SYSCALLS.varargs / 4];
            SYSCALLS.varargs += 4;
            return ret;
          };
          function ___syscall_fcntl64(fd, cmd, varargs) {
            varargs = bigintToI53Checked(varargs);
            SYSCALLS.varargs = varargs;
            try {
              var stream = SYSCALLS.getStreamFromFD(fd);
              switch (cmd) {
                case 0: {
                  var arg = syscallGetVarargI();
                  if (arg < 0) {
                    return -28;
                  }
                  while (FS.streams[arg]) {
                    arg++;
                  }
                  var newStream;
                  newStream = FS.dupStream(stream, arg);
                  return newStream.fd;
                }
                case 1:
                case 2:
                  return 0;
                // FD_CLOEXEC makes no sense for a single process.
                case 3:
                  return stream.flags;
                case 4: {
                  var arg = syscallGetVarargI();
                  stream.flags |= arg;
                  return 0;
                }
                case 5: {
                  var arg = syscallGetVarargP();
                  var offset = 0;
                  HEAP16[(arg + offset) / 2] = 2;
                  return 0;
                }
                case 6:
                case 7:
                  return 0;
              }
              return -28;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_fstat64(fd, buf) {
            buf = bigintToI53Checked(buf);
            try {
              return SYSCALLS.writeStat(buf, FS.fstat(fd));
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_ftruncate64(fd, length) {
            length = bigintToI53Checked(length);
            try {
              if (isNaN(length)) return 61;
              FS.ftruncate(fd, length);
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          var stringToUTF8 = (str, outPtr, maxBytesToWrite) => {
            assert(typeof maxBytesToWrite == "number", "stringToUTF8(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!");
            return stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite);
          };
          function ___syscall_getcwd(buf, size) {
            buf = bigintToI53Checked(buf);
            size = bigintToI53Checked(size);
            try {
              if (size === 0) return -28;
              var cwd = FS.cwd();
              var cwdLengthInBytes = lengthBytesUTF8(cwd) + 1;
              if (size < cwdLengthInBytes) return -68;
              stringToUTF8(cwd, buf, size);
              return cwdLengthInBytes;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_ioctl(fd, op, varargs) {
            varargs = bigintToI53Checked(varargs);
            SYSCALLS.varargs = varargs;
            try {
              var stream = SYSCALLS.getStreamFromFD(fd);
              switch (op) {
                case 21509: {
                  if (!stream.tty) return -59;
                  return 0;
                }
                case 21505: {
                  if (!stream.tty) return -59;
                  if (stream.tty.ops.ioctl_tcgets) {
                    var termios = stream.tty.ops.ioctl_tcgets(stream);
                    var argp = syscallGetVarargP();
                    HEAP32[argp / 4] = termios.c_iflag || 0;
                    HEAP32[(argp + 4) / 4] = termios.c_oflag || 0;
                    HEAP32[(argp + 8) / 4] = termios.c_cflag || 0;
                    HEAP32[(argp + 12) / 4] = termios.c_lflag || 0;
                    for (var i = 0; i < 32; i++) {
                      HEAP8[argp + i + 17] = termios.c_cc[i] || 0;
                    }
                    return 0;
                  }
                  return 0;
                }
                case 21510:
                case 21511:
                case 21512: {
                  if (!stream.tty) return -59;
                  return 0;
                }
                case 21506:
                case 21507:
                case 21508: {
                  if (!stream.tty) return -59;
                  if (stream.tty.ops.ioctl_tcsets) {
                    var argp = syscallGetVarargP();
                    var c_iflag = HEAP32[argp / 4];
                    var c_oflag = HEAP32[(argp + 4) / 4];
                    var c_cflag = HEAP32[(argp + 8) / 4];
                    var c_lflag = HEAP32[(argp + 12) / 4];
                    var c_cc = [];
                    for (var i = 0; i < 32; i++) {
                      c_cc.push(HEAP8[argp + i + 17]);
                    }
                    return stream.tty.ops.ioctl_tcsets(stream.tty, op, {
                      c_iflag,
                      c_oflag,
                      c_cflag,
                      c_lflag,
                      c_cc
                    });
                  }
                  return 0;
                }
                case 21519: {
                  if (!stream.tty) return -59;
                  var argp = syscallGetVarargP();
                  HEAP32[argp / 4] = 0;
                  return 0;
                }
                case 21520: {
                  if (!stream.tty) return -59;
                  return -28;
                }
                case 21531: {
                  var argp = syscallGetVarargP();
                  return FS.ioctl(stream, op, argp);
                }
                case 21523: {
                  if (!stream.tty) return -59;
                  if (stream.tty.ops.ioctl_tiocgwinsz) {
                    var winsize = stream.tty.ops.ioctl_tiocgwinsz(stream.tty);
                    var argp = syscallGetVarargP();
                    HEAP16[argp / 2] = winsize[0];
                    HEAP16[(argp + 2) / 2] = winsize[1];
                  }
                  return 0;
                }
                case 21524: {
                  if (!stream.tty) return -59;
                  return 0;
                }
                case 21515: {
                  if (!stream.tty) return -59;
                  return 0;
                }
                default:
                  return -28;
              }
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_lstat64(path, buf) {
            path = bigintToI53Checked(path);
            buf = bigintToI53Checked(buf);
            try {
              path = SYSCALLS.getStr(path);
              return SYSCALLS.writeStat(buf, FS.lstat(path));
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_mkdirat(dirfd, path, mode) {
            path = bigintToI53Checked(path);
            try {
              path = SYSCALLS.getStr(path);
              path = SYSCALLS.calculateAt(dirfd, path);
              FS.mkdir(path, mode, 0);
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_newfstatat(dirfd, path, buf, flags) {
            path = bigintToI53Checked(path);
            buf = bigintToI53Checked(buf);
            try {
              path = SYSCALLS.getStr(path);
              var nofollow = flags & 256;
              var allowEmpty = flags & 4096;
              flags = flags & ~6400;
              assert(!flags, `unknown flags in __syscall_newfstatat: ${flags}`);
              path = SYSCALLS.calculateAt(dirfd, path, allowEmpty);
              return SYSCALLS.writeStat(buf, nofollow ? FS.lstat(path) : FS.stat(path));
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_openat(dirfd, path, flags, varargs) {
            path = bigintToI53Checked(path);
            varargs = bigintToI53Checked(varargs);
            SYSCALLS.varargs = varargs;
            try {
              path = SYSCALLS.getStr(path);
              path = SYSCALLS.calculateAt(dirfd, path);
              var mode = varargs ? syscallGetVarargI() : 0;
              return FS.open(path, flags, mode).fd;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_readlinkat(dirfd, path, buf, bufsize) {
            path = bigintToI53Checked(path);
            buf = bigintToI53Checked(buf);
            bufsize = bigintToI53Checked(bufsize);
            try {
              path = SYSCALLS.getStr(path);
              path = SYSCALLS.calculateAt(dirfd, path);
              if (bufsize <= 0) return -28;
              var ret = FS.readlink(path);
              var len = Math.min(bufsize, lengthBytesUTF8(ret));
              var endChar = HEAP8[buf + len];
              stringToUTF8(ret, buf, bufsize + 1);
              HEAP8[buf + len] = endChar;
              return len;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_rmdir(path) {
            path = bigintToI53Checked(path);
            try {
              path = SYSCALLS.getStr(path);
              FS.rmdir(path);
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_stat64(path, buf) {
            path = bigintToI53Checked(path);
            buf = bigintToI53Checked(buf);
            try {
              path = SYSCALLS.getStr(path);
              return SYSCALLS.writeStat(buf, FS.stat(path));
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_unlinkat(dirfd, path, flags) {
            path = bigintToI53Checked(path);
            try {
              path = SYSCALLS.getStr(path);
              path = SYSCALLS.calculateAt(dirfd, path);
              if (flags === 0) {
                FS.unlink(path);
              } else if (flags === 512) {
                FS.rmdir(path);
              } else {
                abort("Invalid flags passed to unlinkat");
              }
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          var readI53FromI64 = (ptr) => HEAPU32[ptr / 4] + HEAP32[(ptr + 4) / 4] * 4294967296;
          function ___syscall_utimensat(dirfd, path, times, flags) {
            path = bigintToI53Checked(path);
            times = bigintToI53Checked(times);
            try {
              path = SYSCALLS.getStr(path);
              assert(flags === 0);
              path = SYSCALLS.calculateAt(dirfd, path, true);
              var now = Date.now(), atime, mtime;
              if (!times) {
                atime = now;
                mtime = now;
              } else {
                var seconds = readI53FromI64(times);
                var nanoseconds = HEAP32[(times + 8) / 4];
                if (nanoseconds == 1073741823) {
                  atime = now;
                } else if (nanoseconds == 1073741822) {
                  atime = null;
                } else {
                  atime = seconds * 1e3 + nanoseconds / (1e3 * 1e3);
                }
                times += 16;
                seconds = readI53FromI64(times);
                nanoseconds = HEAP32[(times + 8) / 4];
                if (nanoseconds == 1073741823) {
                  mtime = now;
                } else if (nanoseconds == 1073741822) {
                  mtime = null;
                } else {
                  mtime = seconds * 1e3 + nanoseconds / (1e3 * 1e3);
                }
              }
              if ((mtime ?? atime) !== null) {
                FS.utime(path, atime, mtime);
              }
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
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
            len = bigintToI53Checked(len);
            offset = bigintToI53Checked(offset);
            allocated = bigintToI53Checked(allocated);
            addr = bigintToI53Checked(addr);
            try {
              if (isNaN(offset)) return 61;
              var stream = SYSCALLS.getStreamFromFD(fd);
              var res = FS.mmap(stream, len, offset, prot, flags);
              var ptr = res.ptr;
              HEAP32[allocated / 4] = res.allocated;
              HEAPU64[addr / 8] = BigInt(ptr);
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function __munmap_js(addr, len, prot, flags, fd, offset) {
            addr = bigintToI53Checked(addr);
            len = bigintToI53Checked(len);
            offset = bigintToI53Checked(offset);
            try {
              var stream = SYSCALLS.getStreamFromFD(fd);
              if (prot & 2) {
                SYSCALLS.doMsync(addr, stream, len, flags, offset);
              }
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
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
            var _a2;
            EXITSTATUS = code;
            if (!keepRuntimeAlive()) {
              (_a2 = Module["onExit"]) == null ? void 0 : _a2.call(Module, code);
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
          function _fd_close(fd) {
            try {
              var stream = SYSCALLS.getStreamFromFD(fd);
              FS.close(stream);
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return e.errno;
            }
          }
          function _fd_fdstat_get(fd, pbuf) {
            pbuf = bigintToI53Checked(pbuf);
            try {
              var rightsBase = 0;
              var rightsInheriting = 0;
              var flags = 0;
              {
                var stream = SYSCALLS.getStreamFromFD(fd);
                var type = stream.tty ? 2 : FS.isDir(stream.mode) ? 3 : FS.isLink(stream.mode) ? 7 : 4;
              }
              HEAP8[pbuf] = type;
              HEAP16[(pbuf + 2) / 2] = flags;
              HEAP64[(pbuf + 8) / 8] = BigInt(rightsBase);
              HEAP64[(pbuf + 16) / 8] = BigInt(rightsInheriting);
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return e.errno;
            }
          }
          var doReadv = (stream, iov, iovcnt, offset) => {
            var ret = 0;
            for (var i = 0; i < iovcnt; i++) {
              var ptr = Number(HEAPU64[iov / 8]);
              var len = Number(HEAPU64[(iov + 8) / 8]);
              iov += 16;
              var curr = FS.read(stream, HEAP8, ptr, len, offset);
              if (curr < 0) return -1;
              ret += curr;
              if (curr < len) break;
            }
            return ret;
          };
          function _fd_read(fd, iov, iovcnt, pnum) {
            iov = bigintToI53Checked(iov);
            iovcnt = bigintToI53Checked(iovcnt);
            pnum = bigintToI53Checked(pnum);
            try {
              var stream = SYSCALLS.getStreamFromFD(fd);
              var num = doReadv(stream, iov, iovcnt);
              HEAPU64[pnum / 8] = BigInt(num);
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return e.errno;
            }
          }
          function _fd_seek(fd, offset, whence, newOffset) {
            offset = bigintToI53Checked(offset);
            newOffset = bigintToI53Checked(newOffset);
            try {
              if (isNaN(offset)) return 61;
              var stream = SYSCALLS.getStreamFromFD(fd);
              FS.llseek(stream, offset, whence);
              HEAP64[newOffset / 8] = BigInt(stream.position);
              if (stream.getdents && offset === 0 && whence === 0) stream.getdents = null;
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return e.errno;
            }
          }
          function _fd_sync(fd) {
            var _a2;
            try {
              var stream = SYSCALLS.getStreamFromFD(fd);
              if ((_a2 = stream.stream_ops) == null ? void 0 : _a2.fsync) {
                return stream.stream_ops.fsync(stream);
              }
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return e.errno;
            }
          }
          var doWritev = (stream, iov, iovcnt, offset) => {
            var ret = 0;
            for (var i = 0; i < iovcnt; i++) {
              var ptr = Number(HEAPU64[iov / 8]);
              var len = Number(HEAPU64[(iov + 8) / 8]);
              iov += 16;
              var curr = FS.write(stream, HEAP8, ptr, len, offset);
              if (curr < 0) return -1;
              ret += curr;
              if (curr < len) {
                break;
              }
            }
            return ret;
          };
          function _fd_write(fd, iov, iovcnt, pnum) {
            iov = bigintToI53Checked(iov);
            iovcnt = bigintToI53Checked(iovcnt);
            pnum = bigintToI53Checked(pnum);
            try {
              var stream = SYSCALLS.getStreamFromFD(fd);
              var num = doWritev(stream, iov, iovcnt);
              HEAPU64[pnum / 8] = BigInt(num);
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return e.errno;
            }
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
          FS.createPreloadedFile = FS_createPreloadedFile;
          FS.staticInit();
          {
            if (Module["noExitRuntime"]) noExitRuntime = Module["noExitRuntime"];
            if (Module["preloadPlugins"]) preloadPlugins = Module["preloadPlugins"];
            if (Module["print"]) out = Module["print"];
            if (Module["printErr"]) err = Module["printErr"];
            if (Module["wasmBinary"]) wasmBinary = Module["wasmBinary"];
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
          Module["FS"] = FS;
          var missingLibrarySymbols = ["writeI53ToI64", "writeI53ToI64Clamped", "writeI53ToI64Signaling", "writeI53ToU64Clamped", "writeI53ToU64Signaling", "readI53FromU64", "convertI32PairToI53", "convertI32PairToI53Checked", "convertU32PairToI53", "getTempRet0", "setTempRet0", "inetPton4", "inetNtop4", "inetPton6", "inetNtop6", "readSockaddr", "writeSockaddr", "emscriptenLog", "runMainThreadEmAsm", "jstoi_q", "listenOnce", "autoResumeAudioContext", "getDynCaller", "dynCall", "runtimeKeepalivePush", "runtimeKeepalivePop", "callUserCallback", "maybeExit", "asmjsMangle", "HandleAllocator", "getNativeTypeSize", "addOnInit", "addOnPostCtor", "addOnPreMain", "addOnExit", "STACK_SIZE", "STACK_ALIGN", "POINTER_SIZE", "ASSERTIONS", "cwrap", "removeFunction", "reallyNegative", "unSign", "strLen", "reSign", "formatString", "intArrayToString", "AsciiToString", "stringToAscii", "UTF16ToString", "stringToUTF16", "lengthBytesUTF16", "UTF32ToString", "stringToUTF32", "lengthBytesUTF32", "stringToNewUTF8", "registerKeyEventCallback", "maybeCStringToJsString", "findEventTarget", "getBoundingClientRect", "fillMouseEventData", "registerMouseEventCallback", "registerWheelEventCallback", "registerUiEventCallback", "registerFocusEventCallback", "fillDeviceOrientationEventData", "registerDeviceOrientationEventCallback", "fillDeviceMotionEventData", "registerDeviceMotionEventCallback", "screenOrientation", "fillOrientationChangeEventData", "registerOrientationChangeEventCallback", "fillFullscreenChangeEventData", "registerFullscreenChangeEventCallback", "JSEvents_requestFullscreen", "JSEvents_resizeCanvasForFullscreen", "registerRestoreOldStyle", "hideEverythingExceptGivenElement", "restoreHiddenElements", "setLetterbox", "softFullscreenResizeWebGLRenderTarget", "doRequestFullscreen", "fillPointerlockChangeEventData", "registerPointerlockChangeEventCallback", "registerPointerlockErrorEventCallback", "requestPointerLock", "fillVisibilityChangeEventData", "registerVisibilityChangeEventCallback", "registerTouchEventCallback", "fillGamepadEventData", "registerGamepadEventCallback", "registerBeforeUnloadEventCallback", "fillBatteryEventData", "battery", "registerBatteryEventCallback", "setCanvasElementSize", "getCanvasElementSize", "getCallstack", "convertPCtoSourceLocation", "wasiRightsToMuslOFlags", "wasiOFlagsToMuslOFlags", "safeSetTimeout", "setImmediateWrapped", "safeRequestAnimationFrame", "clearImmediateWrapped", "registerPostMainLoop", "registerPreMainLoop", "getPromise", "makePromise", "idsToPromises", "makePromiseCallback", "ExceptionInfo", "findMatchingCatch", "Browser_asyncPrepareDataCounter", "arraySum", "addDays", "getSocketFromFD", "getSocketAddress", "FS_mkdirTree", "_setNetworkCallback", "heapObjectForWebGLType", "toTypedArrayIndex", "webgl_enable_ANGLE_instanced_arrays", "webgl_enable_OES_vertex_array_object", "webgl_enable_WEBGL_draw_buffers", "webgl_enable_WEBGL_multi_draw", "webgl_enable_EXT_polygon_offset_clamp", "webgl_enable_EXT_clip_control", "webgl_enable_WEBGL_polygon_mode", "emscriptenWebGLGet", "computeUnpackAlignedImageSize", "colorChannelsInGlTextureFormat", "emscriptenWebGLGetTexPixelData", "emscriptenWebGLGetUniform", "webglGetUniformLocation", "webglPrepareUniformLocationsBeforeFirstUse", "webglGetLeftBracePos", "emscriptenWebGLGetVertexAttrib", "__glGetActiveAttribOrUniform", "writeGLArray", "registerWebGlEventCallback", "runAndAbortIfError", "ALLOC_NORMAL", "ALLOC_STACK", "allocate", "writeStringToMemory", "writeAsciiToMemory", "demangle", "stackTrace"];
          missingLibrarySymbols.forEach(missingLibrarySymbol);
          var unexportedSymbols = ["run", "addRunDependency", "removeRunDependency", "out", "err", "abort", "wasmMemory", "wasmExports", "HEAPF32", "HEAPF64", "HEAP8", "HEAP16", "HEAPU16", "HEAP32", "HEAPU32", "HEAP64", "HEAPU64", "writeStackCookie", "checkStackCookie", "readI53FromI64", "INT53_MAX", "INT53_MIN", "bigintToI53Checked", "stackSave", "stackRestore", "stackAlloc", "ptrToString", "zeroMemory", "exitJS", "getHeapMax", "growMemory", "ENV", "ERRNO_CODES", "strError", "DNS", "Protocols", "Sockets", "timers", "warnOnce", "readEmAsmArgsArray", "readEmAsmArgs", "runEmAsmFunction", "getExecutableName", "handleException", "keepRuntimeAlive", "asyncLoad", "alignMemory", "mmapAlloc", "wasmTable", "noExitRuntime", "addOnPreRun", "addOnPostRun", "getCFunc", "uleb128Encode", "sigToWasmTypes", "generateFuncType", "convertJsFunctionToWasm", "freeTableIndexes", "functionsInTableMap", "getEmptyTableSlot", "updateTableMap", "getFunctionAddress", "setValue", "getValue", "PATH", "PATH_FS", "UTF8Decoder", "UTF8ArrayToString", "UTF8ToString", "stringToUTF8Array", "stringToUTF8", "lengthBytesUTF8", "intArrayFromString", "UTF16Decoder", "stringToUTF8OnStack", "writeArrayToMemory", "JSEvents", "specialHTMLTargets", "findCanvasEventTarget", "currentFullscreenStrategy", "restoreOldWindowedStyle", "jsStackTrace", "UNWIND_CACHE", "ExitStatus", "getEnvStrings", "checkWasiClock", "doReadv", "doWritev", "initRandomFill", "randomFill", "emSetImmediate", "emClearImmediate_deps", "emClearImmediate", "promiseMap", "uncaughtExceptionCount", "exceptionLast", "exceptionCaught", "Browser", "getPreloadedImageData__data", "wget", "MONTH_DAYS_REGULAR", "MONTH_DAYS_LEAP", "MONTH_DAYS_REGULAR_CUMULATIVE", "MONTH_DAYS_LEAP_CUMULATIVE", "isLeapYear", "ydayFromDate", "SYSCALLS", "preloadPlugins", "FS_createPreloadedFile", "FS_modeStringToFlags", "FS_getMode", "FS_stdin_getChar_buffer", "FS_stdin_getChar", "FS_unlink", "FS_createPath", "FS_createDevice", "FS_readFile", "FS_root", "FS_mounts", "FS_devices", "FS_streams", "FS_nextInode", "FS_nameTable", "FS_currentPath", "FS_initialized", "FS_ignorePermissions", "FS_filesystems", "FS_syncFSRequests", "FS_readFiles", "FS_lookupPath", "FS_getPath", "FS_hashName", "FS_hashAddNode", "FS_hashRemoveNode", "FS_lookupNode", "FS_createNode", "FS_destroyNode", "FS_isRoot", "FS_isMountpoint", "FS_isFile", "FS_isDir", "FS_isLink", "FS_isChrdev", "FS_isBlkdev", "FS_isFIFO", "FS_isSocket", "FS_flagsToPermissionString", "FS_nodePermissions", "FS_mayLookup", "FS_mayCreate", "FS_mayDelete", "FS_mayOpen", "FS_checkOpExists", "FS_nextfd", "FS_getStreamChecked", "FS_getStream", "FS_createStream", "FS_closeStream", "FS_dupStream", "FS_doSetAttr", "FS_chrdev_stream_ops", "FS_major", "FS_minor", "FS_makedev", "FS_registerDevice", "FS_getDevice", "FS_getMounts", "FS_syncfs", "FS_mount", "FS_unmount", "FS_lookup", "FS_mknod", "FS_statfs", "FS_statfsStream", "FS_statfsNode", "FS_create", "FS_mkdir", "FS_mkdev", "FS_symlink", "FS_rename", "FS_rmdir", "FS_readdir", "FS_readlink", "FS_stat", "FS_fstat", "FS_lstat", "FS_doChmod", "FS_chmod", "FS_lchmod", "FS_fchmod", "FS_doChown", "FS_chown", "FS_lchown", "FS_fchown", "FS_doTruncate", "FS_truncate", "FS_ftruncate", "FS_utime", "FS_open", "FS_close", "FS_isClosed", "FS_llseek", "FS_read", "FS_write", "FS_mmap", "FS_msync", "FS_ioctl", "FS_writeFile", "FS_cwd", "FS_chdir", "FS_createDefaultDirectories", "FS_createDefaultDevices", "FS_createSpecialDirectories", "FS_createStandardStreams", "FS_staticInit", "FS_init", "FS_quit", "FS_findObject", "FS_analyzePath", "FS_createFile", "FS_createDataFile", "FS_forceLoadFile", "FS_createLazyFile", "FS_absolutePath", "FS_createFolder", "FS_createLink", "FS_joinPath", "FS_mmapAlloc", "FS_standardizePath", "MEMFS", "TTY", "PIPEFS", "SOCKFS", "tempFixedLengthArray", "miniTempWebGLFloatBuffers", "miniTempWebGLIntBuffers", "GL", "AL", "GLUT", "EGL", "GLEW", "IDBStore", "SDL", "SDL_gfx", "allocateUTF8", "allocateUTF8OnStack", "print", "printErr", "jstoi_s", "WORKERFS"];
          unexportedSymbols.forEach(unexportedRuntimeSymbol);
          function checkIncomingModuleAPI() {
            ignoredModuleProp("fetchSettings");
          }
          var ASM_CONSTS = {
            4893648: () => typeof wasmOffsetConverter !== "undefined"
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
          var wasmExports = createWasm();
          var _strerror = createExportWrapper("strerror", 1);
          Module["_trace_processor_rpc_init"] = createExportWrapper("trace_processor_rpc_init", 2);
          Module["_trace_processor_on_rpc_request"] = createExportWrapper("trace_processor_on_rpc_request", 1);
          var _main = Module["_main"] = createExportWrapper("__main_argc_argv", 2);
          Module["_synq_extent_on_shift"] = createExportWrapper("synq_extent_on_shift", 3);
          Module["_synq_extent_on_reduce"] = createExportWrapper("synq_extent_on_reduce", 2);
          Module["_SynqPerfettoParseInit"] = createExportWrapper("SynqPerfettoParseInit", 2);
          Module["_SynqPerfettoParseAlloc"] = createExportWrapper("SynqPerfettoParseAlloc", 2);
          Module["_SynqPerfettoParseFinalize"] = createExportWrapper("SynqPerfettoParseFinalize", 1);
          Module["_SynqPerfettoParseFree"] = createExportWrapper("SynqPerfettoParseFree", 2);
          Module["_SynqPerfettoParse"] = createExportWrapper("SynqPerfettoParse", 3);
          Module["_SynqPerfettoParseFallback"] = createExportWrapper("SynqPerfettoParseFallback", 1);
          Module["_SynqPerfettoParseExpectedTokens"] = createExportWrapper("SynqPerfettoParseExpectedTokens", 3);
          Module["_SynqPerfettoParseCompletionContext"] = createExportWrapper("SynqPerfettoParseCompletionContext", 1);
          Module["_SynqPerfettoGetToken"] = createExportWrapper("SynqPerfettoGetToken", 3);
          var _fflush = createExportWrapper("fflush", 1);
          var _emscripten_stack_get_end = wasmExports["emscripten_stack_get_end"];
          wasmExports["emscripten_stack_get_base"];
          var _emscripten_builtin_memalign = createExportWrapper("emscripten_builtin_memalign", 2);
          var _emscripten_stack_init = wasmExports["emscripten_stack_init"];
          wasmExports["emscripten_stack_get_free"];
          var __emscripten_stack_restore = wasmExports["_emscripten_stack_restore"];
          var __emscripten_stack_alloc = wasmExports["_emscripten_stack_alloc"];
          var _emscripten_stack_get_current = wasmExports["emscripten_stack_get_current"];
          function applySignatureConversions(wasmExports2) {
            wasmExports2 = Object.assign({}, wasmExports2);
            var makeWrapper_p_ = (f) => (a0) => Number(f(a0));
            var makeWrapper___PP = (f) => (a0, a1, a2) => f(a0, BigInt(a1 ? a1 : 0), BigInt(a2 ? a2 : 0));
            var makeWrapper__p = (f) => (a0) => f(BigInt(a0));
            var makeWrapper_p = (f) => () => Number(f());
            var makeWrapper_ppp = (f) => (a0, a1) => Number(f(BigInt(a0), BigInt(a1)));
            var makeWrapper_pp = (f) => (a0) => Number(f(BigInt(a0)));
            wasmExports2["strerror"] = makeWrapper_p_(wasmExports2["strerror"]);
            wasmExports2["__main_argc_argv"] = makeWrapper___PP(wasmExports2["__main_argc_argv"]);
            wasmExports2["fflush"] = makeWrapper__p(wasmExports2["fflush"]);
            wasmExports2["emscripten_stack_get_end"] = makeWrapper_p(wasmExports2["emscripten_stack_get_end"]);
            wasmExports2["emscripten_stack_get_base"] = makeWrapper_p(wasmExports2["emscripten_stack_get_base"]);
            wasmExports2["emscripten_builtin_memalign"] = makeWrapper_ppp(wasmExports2["emscripten_builtin_memalign"]);
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
              var _a2;
              assert(!calledRun);
              calledRun = true;
              Module["calledRun"] = true;
              if (ABORT) return;
              initRuntime();
              preMain();
              readyPromiseResolve(Module);
              (_a2 = Module["onRuntimeInitialized"]) == null ? void 0 : _a2.call(Module);
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
              _fflush(0);
              ["stdout", "stderr"].forEach((name) => {
                var _a2;
                var info = FS.analyzePath("/dev/" + name);
                if (!info) return;
                var stream = info.object;
                var rdev = stream.rdev;
                var tty = TTY.ttys[rdev];
                if ((_a2 = tty == null ? void 0 : tty.output) == null ? void 0 : _a2.length) {
                  has = true;
                }
              });
            } catch (e) {
            }
            out = oldOut;
            err = oldErr;
            if (has) {
              warnOnce("stdio streams had content in them that was not flushed. you should set EXIT_RUNTIME to 1 (see the Emscripten FAQ), or make sure to emit a newline when you printf etc.");
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
          moduleRtn = Module;
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
    (function(module, exports$1) {
      var trace_processor_wasm = (() => {
        var _a;
        var _scriptName = typeof document != "undefined" ? (_a = document.currentScript) == null ? void 0 : _a.src : void 0;
        return (function(moduleArg = {}) {
          var moduleRtn;
          var Module = moduleArg;
          var readyPromiseResolve, readyPromiseReject;
          new Promise((resolve, reject) => {
            readyPromiseResolve = resolve;
            readyPromiseReject = reject;
          });
          var ENVIRONMENT_IS_WEB = typeof window == "object";
          var ENVIRONMENT_IS_WORKER = typeof WorkerGlobalScope != "undefined";
          var ENVIRONMENT_IS_NODE = typeof process == "object" && typeof process.versions == "object" && typeof process.versions.node == "string" && process.type != "renderer";
          var ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER;
          var arguments_ = [];
          var thisProgram = "./this.program";
          var quit_ = (status, toThrow) => {
            throw toThrow;
          };
          if (ENVIRONMENT_IS_WORKER) {
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
          if (ENVIRONMENT_IS_SHELL) {
            if (typeof process == "object" && typeof require === "function" || typeof window == "object" || typeof WorkerGlobalScope != "undefined") throw new Error("not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)");
          } else if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
            try {
              scriptDirectory = new URL(".", _scriptName).href;
            } catch {
            }
            if (!(typeof window == "object" || typeof WorkerGlobalScope != "undefined")) throw new Error("not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)");
            {
              if (ENVIRONMENT_IS_WORKER) {
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
          } else {
            throw new Error("environment detection error");
          }
          var out = console.log.bind(console);
          var err = console.error.bind(console);
          var WORKERFS = "WORKERFS is no longer included by default; build with -lworkerfs.js";
          assert(!ENVIRONMENT_IS_NODE, "node environment detected but not enabled at build time.  Add `node` to `-sENVIRONMENT` to enable.");
          assert(!ENVIRONMENT_IS_SHELL, "shell environment detected but not enabled at build time.  Add `shell` to `-sENVIRONMENT` to enable.");
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
            if (!Module["noFSInit"] && !FS.initialized) FS.init();
            wasmExports["__wasm_call_ctors"]();
            FS.ignorePermissions = false;
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
          function getUniqueRunDependency(id) {
            var orig = id;
            while (1) {
              if (!runDependencyTracking[id]) return id;
              id = orig + Math.random();
            }
          }
          function addRunDependency(id) {
            var _a2;
            runDependencies++;
            (_a2 = Module["monitorRunDependencies"]) == null ? void 0 : _a2.call(Module, runDependencies);
            if (id) {
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
            } else {
              err("warning: run dependency added without ID");
            }
          }
          function removeRunDependency(id) {
            var _a2;
            runDependencies--;
            (_a2 = Module["monitorRunDependencies"]) == null ? void 0 : _a2.call(Module, runDependencies);
            if (id) {
              assert(runDependencyTracking[id]);
              delete runDependencyTracking[id];
            } else {
              err("warning: run dependency removed without ID");
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
            var _a2;
            (_a2 = Module["onAbort"]) == null ? void 0 : _a2.call(Module, what);
            what = "Aborted(" + what + ")";
            err(what);
            ABORT = true;
            var e = new WebAssembly.RuntimeError(what);
            readyPromiseReject(e);
            throw e;
          }
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
            throw 'sync fetching of the wasm failed: you can preload it to Module["wasmBinary"] manually, or emcc.py will do that for you when generating HTML (but not JS)';
          }
          function instantiateSync(file, info) {
            var module2;
            var binary = getBinarySync(file);
            module2 = new WebAssembly.Module(binary);
            var instance = new WebAssembly.Instance(module2, info);
            return [instance, module2];
          }
          function getWasmImports() {
            return {
              "env": wasmImports,
              "wasi_snapshot_preview1": wasmImports
            };
          }
          function createWasm() {
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
            var result = instantiateSync(wasmBinaryFile, info);
            return receiveInstance(result[0]);
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
          var PATH = {
            isAbs: (path) => path.charAt(0) === "/",
            splitPath: (filename) => {
              var splitPathRe = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
              return splitPathRe.exec(filename).slice(1);
            },
            normalizeArray: (parts, allowAboveRoot) => {
              var up = 0;
              for (var i = parts.length - 1; i >= 0; i--) {
                var last = parts[i];
                if (last === ".") {
                  parts.splice(i, 1);
                } else if (last === "..") {
                  parts.splice(i, 1);
                  up++;
                } else if (up) {
                  parts.splice(i, 1);
                  up--;
                }
              }
              if (allowAboveRoot) {
                for (; up; up--) {
                  parts.unshift("..");
                }
              }
              return parts;
            },
            normalize: (path) => {
              var isAbsolute = PATH.isAbs(path), trailingSlash = path.slice(-1) === "/";
              path = PATH.normalizeArray(path.split("/").filter((p) => !!p), !isAbsolute).join("/");
              if (!path && !isAbsolute) {
                path = ".";
              }
              if (path && trailingSlash) {
                path += "/";
              }
              return (isAbsolute ? "/" : "") + path;
            },
            dirname: (path) => {
              var result = PATH.splitPath(path), root = result[0], dir = result[1];
              if (!root && !dir) {
                return ".";
              }
              if (dir) {
                dir = dir.slice(0, -1);
              }
              return root + dir;
            },
            basename: (path) => path && path.match(/([^\/]+|\/)\/*$/)[1],
            join: (...paths) => PATH.normalize(paths.join("/")),
            join2: (l, r) => PATH.normalize(l + "/" + r)
          };
          var initRandomFill = () => (view) => crypto.getRandomValues(view);
          var randomFill = (view) => {
            (randomFill = initRandomFill())(view);
          };
          var PATH_FS = {
            resolve: (...args) => {
              var resolvedPath = "", resolvedAbsolute = false;
              for (var i = args.length - 1; i >= -1 && !resolvedAbsolute; i--) {
                var path = i >= 0 ? args[i] : FS.cwd();
                if (typeof path != "string") {
                  throw new TypeError("Arguments to path.resolve must be strings");
                } else if (!path) {
                  return "";
                }
                resolvedPath = path + "/" + resolvedPath;
                resolvedAbsolute = PATH.isAbs(path);
              }
              resolvedPath = PATH.normalizeArray(resolvedPath.split("/").filter((p) => !!p), !resolvedAbsolute).join("/");
              return (resolvedAbsolute ? "/" : "") + resolvedPath || ".";
            },
            relative: (from, to) => {
              from = PATH_FS.resolve(from).slice(1);
              to = PATH_FS.resolve(to).slice(1);
              function trim(arr) {
                var start = 0;
                for (; start < arr.length; start++) {
                  if (arr[start] !== "") break;
                }
                var end = arr.length - 1;
                for (; end >= 0; end--) {
                  if (arr[end] !== "") break;
                }
                if (start > end) return [];
                return arr.slice(start, end - start + 1);
              }
              var fromParts = trim(from.split("/"));
              var toParts = trim(to.split("/"));
              var length = Math.min(fromParts.length, toParts.length);
              var samePartsLength = length;
              for (var i = 0; i < length; i++) {
                if (fromParts[i] !== toParts[i]) {
                  samePartsLength = i;
                  break;
                }
              }
              var outputParts = [];
              for (var i = samePartsLength; i < fromParts.length; i++) {
                outputParts.push("..");
              }
              outputParts = outputParts.concat(toParts.slice(samePartsLength));
              return outputParts.join("/");
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
          var FS_stdin_getChar_buffer = [];
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
          var intArrayFromString = (stringy, dontAddNull, length) => {
            var len = lengthBytesUTF8(stringy) + 1;
            var u8array = new Array(len);
            var numBytesWritten = stringToUTF8Array(stringy, u8array, 0, u8array.length);
            u8array.length = numBytesWritten;
            return u8array;
          };
          var FS_stdin_getChar = () => {
            if (!FS_stdin_getChar_buffer.length) {
              var result = null;
              if (typeof window != "undefined" && typeof window.prompt == "function") {
                result = window.prompt("Input: ");
                if (result !== null) {
                  result += "\n";
                }
              }
              if (!result) {
                return null;
              }
              FS_stdin_getChar_buffer = intArrayFromString(result);
            }
            return FS_stdin_getChar_buffer.shift();
          };
          var TTY = {
            ttys: [],
            init() {
            },
            shutdown() {
            },
            register(dev, ops) {
              TTY.ttys[dev] = {
                input: [],
                output: [],
                ops
              };
              FS.registerDevice(dev, TTY.stream_ops);
            },
            stream_ops: {
              open(stream) {
                var tty = TTY.ttys[stream.node.rdev];
                if (!tty) {
                  throw new FS.ErrnoError(43);
                }
                stream.tty = tty;
                stream.seekable = false;
              },
              close(stream) {
                stream.tty.ops.fsync(stream.tty);
              },
              fsync(stream) {
                stream.tty.ops.fsync(stream.tty);
              },
              read(stream, buffer, offset, length, pos) {
                if (!stream.tty || !stream.tty.ops.get_char) {
                  throw new FS.ErrnoError(60);
                }
                var bytesRead = 0;
                for (var i = 0; i < length; i++) {
                  var result;
                  try {
                    result = stream.tty.ops.get_char(stream.tty);
                  } catch (e) {
                    throw new FS.ErrnoError(29);
                  }
                  if (result === void 0 && bytesRead === 0) {
                    throw new FS.ErrnoError(6);
                  }
                  if (result === null || result === void 0) break;
                  bytesRead++;
                  buffer[offset + i] = result;
                }
                if (bytesRead) {
                  stream.node.atime = Date.now();
                }
                return bytesRead;
              },
              write(stream, buffer, offset, length, pos) {
                if (!stream.tty || !stream.tty.ops.put_char) {
                  throw new FS.ErrnoError(60);
                }
                try {
                  for (var i = 0; i < length; i++) {
                    stream.tty.ops.put_char(stream.tty, buffer[offset + i]);
                  }
                } catch (e) {
                  throw new FS.ErrnoError(29);
                }
                if (length) {
                  stream.node.mtime = stream.node.ctime = Date.now();
                }
                return i;
              }
            },
            default_tty_ops: {
              get_char(tty) {
                return FS_stdin_getChar();
              },
              put_char(tty, val) {
                if (val === null || val === 10) {
                  out(UTF8ArrayToString(tty.output));
                  tty.output = [];
                } else {
                  if (val != 0) tty.output.push(val);
                }
              },
              fsync(tty) {
                var _a2;
                if (((_a2 = tty.output) == null ? void 0 : _a2.length) > 0) {
                  out(UTF8ArrayToString(tty.output));
                  tty.output = [];
                }
              },
              ioctl_tcgets(tty) {
                return {
                  c_iflag: 25856,
                  c_oflag: 5,
                  c_cflag: 191,
                  c_lflag: 35387,
                  c_cc: [3, 28, 127, 21, 4, 0, 1, 0, 17, 19, 26, 0, 18, 15, 23, 22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
                };
              },
              ioctl_tcsets(tty, optional_actions, data) {
                return 0;
              },
              ioctl_tiocgwinsz(tty) {
                return [24, 80];
              }
            },
            default_tty1_ops: {
              put_char(tty, val) {
                if (val === null || val === 10) {
                  err(UTF8ArrayToString(tty.output));
                  tty.output = [];
                } else {
                  if (val != 0) tty.output.push(val);
                }
              },
              fsync(tty) {
                var _a2;
                if (((_a2 = tty.output) == null ? void 0 : _a2.length) > 0) {
                  err(UTF8ArrayToString(tty.output));
                  tty.output = [];
                }
              }
            }
          };
          var zeroMemory = (ptr, size) => HEAPU8.fill(0, ptr, ptr + size);
          var alignMemory = (size, alignment) => {
            assert(alignment, "alignment argument is required");
            return Math.ceil(size / alignment) * alignment;
          };
          var mmapAlloc = (size) => {
            size = alignMemory(size, 65536);
            var ptr = _emscripten_builtin_memalign(65536, size);
            if (ptr) zeroMemory(ptr, size);
            return ptr;
          };
          var MEMFS = {
            ops_table: null,
            mount(mount) {
              return MEMFS.createNode(null, "/", 16895, 0);
            },
            createNode(parent, name, mode, dev) {
              if (FS.isBlkdev(mode) || FS.isFIFO(mode)) {
                throw new FS.ErrnoError(63);
              }
              MEMFS.ops_table || (MEMFS.ops_table = {
                dir: {
                  node: {
                    getattr: MEMFS.node_ops.getattr,
                    setattr: MEMFS.node_ops.setattr,
                    lookup: MEMFS.node_ops.lookup,
                    mknod: MEMFS.node_ops.mknod,
                    rename: MEMFS.node_ops.rename,
                    unlink: MEMFS.node_ops.unlink,
                    rmdir: MEMFS.node_ops.rmdir,
                    readdir: MEMFS.node_ops.readdir,
                    symlink: MEMFS.node_ops.symlink
                  },
                  stream: {
                    llseek: MEMFS.stream_ops.llseek
                  }
                },
                file: {
                  node: {
                    getattr: MEMFS.node_ops.getattr,
                    setattr: MEMFS.node_ops.setattr
                  },
                  stream: {
                    llseek: MEMFS.stream_ops.llseek,
                    read: MEMFS.stream_ops.read,
                    write: MEMFS.stream_ops.write,
                    mmap: MEMFS.stream_ops.mmap,
                    msync: MEMFS.stream_ops.msync
                  }
                },
                link: {
                  node: {
                    getattr: MEMFS.node_ops.getattr,
                    setattr: MEMFS.node_ops.setattr,
                    readlink: MEMFS.node_ops.readlink
                  },
                  stream: {}
                },
                chrdev: {
                  node: {
                    getattr: MEMFS.node_ops.getattr,
                    setattr: MEMFS.node_ops.setattr
                  },
                  stream: FS.chrdev_stream_ops
                }
              });
              var node = FS.createNode(parent, name, mode, dev);
              if (FS.isDir(node.mode)) {
                node.node_ops = MEMFS.ops_table.dir.node;
                node.stream_ops = MEMFS.ops_table.dir.stream;
                node.contents = {};
              } else if (FS.isFile(node.mode)) {
                node.node_ops = MEMFS.ops_table.file.node;
                node.stream_ops = MEMFS.ops_table.file.stream;
                node.usedBytes = 0;
                node.contents = null;
              } else if (FS.isLink(node.mode)) {
                node.node_ops = MEMFS.ops_table.link.node;
                node.stream_ops = MEMFS.ops_table.link.stream;
              } else if (FS.isChrdev(node.mode)) {
                node.node_ops = MEMFS.ops_table.chrdev.node;
                node.stream_ops = MEMFS.ops_table.chrdev.stream;
              }
              node.atime = node.mtime = node.ctime = Date.now();
              if (parent) {
                parent.contents[name] = node;
                parent.atime = parent.mtime = parent.ctime = node.atime;
              }
              return node;
            },
            getFileDataAsTypedArray(node) {
              if (!node.contents) return new Uint8Array(0);
              if (node.contents.subarray) return node.contents.subarray(0, node.usedBytes);
              return new Uint8Array(node.contents);
            },
            expandFileStorage(node, newCapacity) {
              var prevCapacity = node.contents ? node.contents.length : 0;
              if (prevCapacity >= newCapacity) return;
              var CAPACITY_DOUBLING_MAX = 1024 * 1024;
              newCapacity = Math.max(newCapacity, prevCapacity * (prevCapacity < CAPACITY_DOUBLING_MAX ? 2 : 1.125) >>> 0);
              if (prevCapacity != 0) newCapacity = Math.max(newCapacity, 256);
              var oldContents = node.contents;
              node.contents = new Uint8Array(newCapacity);
              if (node.usedBytes > 0) node.contents.set(oldContents.subarray(0, node.usedBytes), 0);
            },
            resizeFileStorage(node, newSize) {
              if (node.usedBytes == newSize) return;
              if (newSize == 0) {
                node.contents = null;
                node.usedBytes = 0;
              } else {
                var oldContents = node.contents;
                node.contents = new Uint8Array(newSize);
                if (oldContents) {
                  node.contents.set(oldContents.subarray(0, Math.min(newSize, node.usedBytes)));
                }
                node.usedBytes = newSize;
              }
            },
            node_ops: {
              getattr(node) {
                var attr = {};
                attr.dev = FS.isChrdev(node.mode) ? node.id : 1;
                attr.ino = node.id;
                attr.mode = node.mode;
                attr.nlink = 1;
                attr.uid = 0;
                attr.gid = 0;
                attr.rdev = node.rdev;
                if (FS.isDir(node.mode)) {
                  attr.size = 4096;
                } else if (FS.isFile(node.mode)) {
                  attr.size = node.usedBytes;
                } else if (FS.isLink(node.mode)) {
                  attr.size = node.link.length;
                } else {
                  attr.size = 0;
                }
                attr.atime = new Date(node.atime);
                attr.mtime = new Date(node.mtime);
                attr.ctime = new Date(node.ctime);
                attr.blksize = 4096;
                attr.blocks = Math.ceil(attr.size / attr.blksize);
                return attr;
              },
              setattr(node, attr) {
                for (const key of ["mode", "atime", "mtime", "ctime"]) {
                  if (attr[key] != null) {
                    node[key] = attr[key];
                  }
                }
                if (attr.size !== void 0) {
                  MEMFS.resizeFileStorage(node, attr.size);
                }
              },
              lookup(parent, name) {
                throw new FS.ErrnoError(44);
              },
              mknod(parent, name, mode, dev) {
                return MEMFS.createNode(parent, name, mode, dev);
              },
              rename(old_node, new_dir, new_name) {
                var new_node;
                try {
                  new_node = FS.lookupNode(new_dir, new_name);
                } catch (e) {
                }
                if (new_node) {
                  if (FS.isDir(old_node.mode)) {
                    for (var i in new_node.contents) {
                      throw new FS.ErrnoError(55);
                    }
                  }
                  FS.hashRemoveNode(new_node);
                }
                delete old_node.parent.contents[old_node.name];
                new_dir.contents[new_name] = old_node;
                old_node.name = new_name;
                new_dir.ctime = new_dir.mtime = old_node.parent.ctime = old_node.parent.mtime = Date.now();
              },
              unlink(parent, name) {
                delete parent.contents[name];
                parent.ctime = parent.mtime = Date.now();
              },
              rmdir(parent, name) {
                var node = FS.lookupNode(parent, name);
                for (var i in node.contents) {
                  throw new FS.ErrnoError(55);
                }
                delete parent.contents[name];
                parent.ctime = parent.mtime = Date.now();
              },
              readdir(node) {
                return [".", "..", ...Object.keys(node.contents)];
              },
              symlink(parent, newname, oldpath) {
                var node = MEMFS.createNode(parent, newname, 511 | 40960, 0);
                node.link = oldpath;
                return node;
              },
              readlink(node) {
                if (!FS.isLink(node.mode)) {
                  throw new FS.ErrnoError(28);
                }
                return node.link;
              }
            },
            stream_ops: {
              read(stream, buffer, offset, length, position) {
                var contents = stream.node.contents;
                if (position >= stream.node.usedBytes) return 0;
                var size = Math.min(stream.node.usedBytes - position, length);
                assert(size >= 0);
                if (size > 8 && contents.subarray) {
                  buffer.set(contents.subarray(position, position + size), offset);
                } else {
                  for (var i = 0; i < size; i++) buffer[offset + i] = contents[position + i];
                }
                return size;
              },
              write(stream, buffer, offset, length, position, canOwn) {
                assert(!(buffer instanceof ArrayBuffer));
                if (buffer.buffer === HEAP8.buffer) {
                  canOwn = false;
                }
                if (!length) return 0;
                var node = stream.node;
                node.mtime = node.ctime = Date.now();
                if (buffer.subarray && (!node.contents || node.contents.subarray)) {
                  if (canOwn) {
                    assert(position === 0, "canOwn must imply no weird position inside the file");
                    node.contents = buffer.subarray(offset, offset + length);
                    node.usedBytes = length;
                    return length;
                  } else if (node.usedBytes === 0 && position === 0) {
                    node.contents = buffer.slice(offset, offset + length);
                    node.usedBytes = length;
                    return length;
                  } else if (position + length <= node.usedBytes) {
                    node.contents.set(buffer.subarray(offset, offset + length), position);
                    return length;
                  }
                }
                MEMFS.expandFileStorage(node, position + length);
                if (node.contents.subarray && buffer.subarray) {
                  node.contents.set(buffer.subarray(offset, offset + length), position);
                } else {
                  for (var i = 0; i < length; i++) {
                    node.contents[position + i] = buffer[offset + i];
                  }
                }
                node.usedBytes = Math.max(node.usedBytes, position + length);
                return length;
              },
              llseek(stream, offset, whence) {
                var position = offset;
                if (whence === 1) {
                  position += stream.position;
                } else if (whence === 2) {
                  if (FS.isFile(stream.node.mode)) {
                    position += stream.node.usedBytes;
                  }
                }
                if (position < 0) {
                  throw new FS.ErrnoError(28);
                }
                return position;
              },
              mmap(stream, length, position, prot, flags) {
                if (!FS.isFile(stream.node.mode)) {
                  throw new FS.ErrnoError(43);
                }
                var ptr;
                var allocated;
                var contents = stream.node.contents;
                if (!(flags & 2) && contents && contents.buffer === HEAP8.buffer) {
                  allocated = false;
                  ptr = contents.byteOffset;
                } else {
                  allocated = true;
                  ptr = mmapAlloc(length);
                  if (!ptr) {
                    throw new FS.ErrnoError(48);
                  }
                  if (contents) {
                    if (position > 0 || position + length < contents.length) {
                      if (contents.subarray) {
                        contents = contents.subarray(position, position + length);
                      } else {
                        contents = Array.prototype.slice.call(contents, position, position + length);
                      }
                    }
                    HEAP8.set(contents, ptr >>> 0);
                  }
                }
                return {
                  ptr,
                  allocated
                };
              },
              msync(stream, buffer, offset, length, mmapFlags) {
                MEMFS.stream_ops.write(stream, buffer, 0, length, offset, false);
                return 0;
              }
            }
          };
          var asyncLoad = async (url) => {
            var arrayBuffer = await readAsync(url);
            assert(arrayBuffer, `Loading data file "${url}" failed (no arrayBuffer).`);
            return new Uint8Array(arrayBuffer);
          };
          var FS_createDataFile = (...args) => FS.createDataFile(...args);
          var preloadPlugins = [];
          var FS_handledByPreloadPlugin = (byteArray, fullname, finish, onerror) => {
            if (typeof Browser != "undefined") Browser.init();
            var handled = false;
            preloadPlugins.forEach((plugin) => {
              if (handled) return;
              if (plugin["canHandle"](fullname)) {
                plugin["handle"](byteArray, fullname, finish, onerror);
                handled = true;
              }
            });
            return handled;
          };
          var FS_createPreloadedFile = (parent, name, url, canRead, canWrite, onload, onerror, dontCreateFile, canOwn, preFinish) => {
            var fullname = name ? PATH_FS.resolve(PATH.join2(parent, name)) : parent;
            var dep = getUniqueRunDependency(`cp ${fullname}`);
            function processData(byteArray) {
              function finish(byteArray2) {
                preFinish == null ? void 0 : preFinish();
                if (!dontCreateFile) {
                  FS_createDataFile(parent, name, byteArray2, canRead, canWrite, canOwn);
                }
                onload == null ? void 0 : onload();
                removeRunDependency(dep);
              }
              if (FS_handledByPreloadPlugin(byteArray, fullname, finish, () => {
                onerror == null ? void 0 : onerror();
                removeRunDependency(dep);
              })) {
                return;
              }
              finish(byteArray);
            }
            addRunDependency(dep);
            if (typeof url == "string") {
              asyncLoad(url).then(processData, onerror);
            } else {
              processData(url);
            }
          };
          var FS_modeStringToFlags = (str) => {
            var flagModes = {
              "r": 0,
              "r+": 2,
              "w": 512 | 64 | 1,
              "w+": 512 | 64 | 2,
              "a": 1024 | 64 | 1,
              "a+": 1024 | 64 | 2
            };
            var flags = flagModes[str];
            if (typeof flags == "undefined") {
              throw new Error(`Unknown file open mode: ${str}`);
            }
            return flags;
          };
          var FS_getMode = (canRead, canWrite) => {
            var mode = 0;
            if (canRead) mode |= 292 | 73;
            if (canWrite) mode |= 146;
            return mode;
          };
          var WORKERFS = {
            DIR_MODE: 16895,
            FILE_MODE: 33279,
            reader: null,
            mount(mount) {
              assert(ENVIRONMENT_IS_WORKER);
              WORKERFS.reader ?? (WORKERFS.reader = new FileReaderSync());
              var root = WORKERFS.createNode(null, "/", WORKERFS.DIR_MODE, 0);
              var createdParents = {};
              function ensureParent(path) {
                var parts = path.split("/");
                var parent = root;
                for (var i = 0; i < parts.length - 1; i++) {
                  var curr = parts.slice(0, i + 1).join("/");
                  createdParents[curr] || (createdParents[curr] = WORKERFS.createNode(parent, parts[i], WORKERFS.DIR_MODE, 0));
                  parent = createdParents[curr];
                }
                return parent;
              }
              function base(path) {
                var parts = path.split("/");
                return parts[parts.length - 1];
              }
              Array.prototype.forEach.call(mount.opts["files"] || [], function(file) {
                WORKERFS.createNode(ensureParent(file.name), base(file.name), WORKERFS.FILE_MODE, 0, file, file.lastModifiedDate);
              });
              (mount.opts["blobs"] || []).forEach((obj) => {
                WORKERFS.createNode(ensureParent(obj["name"]), base(obj["name"]), WORKERFS.FILE_MODE, 0, obj["data"]);
              });
              (mount.opts["packages"] || []).forEach((pack) => {
                pack["metadata"].files.forEach((file) => {
                  var name = file.filename.slice(1);
                  WORKERFS.createNode(ensureParent(name), base(name), WORKERFS.FILE_MODE, 0, pack["blob"].slice(file.start, file.end));
                });
              });
              return root;
            },
            createNode(parent, name, mode, dev, contents, mtime) {
              var node = FS.createNode(parent, name, mode);
              node.mode = mode;
              node.node_ops = WORKERFS.node_ops;
              node.stream_ops = WORKERFS.stream_ops;
              node.atime = node.mtime = node.ctime = (mtime || /* @__PURE__ */ new Date()).getTime();
              assert(WORKERFS.FILE_MODE !== WORKERFS.DIR_MODE);
              if (mode === WORKERFS.FILE_MODE) {
                node.size = contents.size;
                node.contents = contents;
              } else {
                node.size = 4096;
                node.contents = {};
              }
              if (parent) {
                parent.contents[name] = node;
              }
              return node;
            },
            node_ops: {
              getattr(node) {
                return {
                  dev: 1,
                  ino: node.id,
                  mode: node.mode,
                  nlink: 1,
                  uid: 0,
                  gid: 0,
                  rdev: 0,
                  size: node.size,
                  atime: new Date(node.atime),
                  mtime: new Date(node.mtime),
                  ctime: new Date(node.ctime),
                  blksize: 4096,
                  blocks: Math.ceil(node.size / 4096)
                };
              },
              setattr(node, attr) {
                for (const key of ["mode", "atime", "mtime", "ctime"]) {
                  if (attr[key] != null) {
                    node[key] = attr[key];
                  }
                }
              },
              lookup(parent, name) {
                throw new FS.ErrnoError(44);
              },
              mknod(parent, name, mode, dev) {
                throw new FS.ErrnoError(63);
              },
              rename(oldNode, newDir, newName) {
                throw new FS.ErrnoError(63);
              },
              unlink(parent, name) {
                throw new FS.ErrnoError(63);
              },
              rmdir(parent, name) {
                throw new FS.ErrnoError(63);
              },
              readdir(node) {
                var entries = [".", ".."];
                for (var key of Object.keys(node.contents)) {
                  entries.push(key);
                }
                return entries;
              },
              symlink(parent, newName, oldPath) {
                throw new FS.ErrnoError(63);
              }
            },
            stream_ops: {
              read(stream, buffer, offset, length, position) {
                if (position >= stream.node.size) return 0;
                var chunk = stream.node.contents.slice(position, position + length);
                var ab = WORKERFS.reader.readAsArrayBuffer(chunk);
                buffer.set(new Uint8Array(ab), offset);
                return chunk.size;
              },
              write(stream, buffer, offset, length, position) {
                throw new FS.ErrnoError(29);
              },
              llseek(stream, offset, whence) {
                var position = offset;
                if (whence === 1) {
                  position += stream.position;
                } else if (whence === 2) {
                  if (FS.isFile(stream.node.mode)) {
                    position += stream.node.size;
                  }
                }
                if (position < 0) {
                  throw new FS.ErrnoError(28);
                }
                return position;
              }
            }
          };
          var UTF8ToString = (ptr, maxBytesToRead) => {
            assert(typeof ptr == "number", `UTF8ToString expects a number (got ${typeof ptr})`);
            ptr >>>= 0;
            return ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead) : "";
          };
          var strError = (errno) => UTF8ToString(_strerror(errno));
          var ERRNO_CODES = {
            "EPERM": 63,
            "ENOENT": 44,
            "ESRCH": 71,
            "EINTR": 27,
            "EIO": 29,
            "ENXIO": 60,
            "E2BIG": 1,
            "ENOEXEC": 45,
            "EBADF": 8,
            "ECHILD": 12,
            "EAGAIN": 6,
            "EWOULDBLOCK": 6,
            "ENOMEM": 48,
            "EACCES": 2,
            "EFAULT": 21,
            "ENOTBLK": 105,
            "EBUSY": 10,
            "EEXIST": 20,
            "EXDEV": 75,
            "ENODEV": 43,
            "ENOTDIR": 54,
            "EISDIR": 31,
            "EINVAL": 28,
            "ENFILE": 41,
            "EMFILE": 33,
            "ENOTTY": 59,
            "ETXTBSY": 74,
            "EFBIG": 22,
            "ENOSPC": 51,
            "ESPIPE": 70,
            "EROFS": 69,
            "EMLINK": 34,
            "EPIPE": 64,
            "EDOM": 18,
            "ERANGE": 68,
            "ENOMSG": 49,
            "EIDRM": 24,
            "ECHRNG": 106,
            "EL2NSYNC": 156,
            "EL3HLT": 107,
            "EL3RST": 108,
            "ELNRNG": 109,
            "EUNATCH": 110,
            "ENOCSI": 111,
            "EL2HLT": 112,
            "EDEADLK": 16,
            "ENOLCK": 46,
            "EBADE": 113,
            "EBADR": 114,
            "EXFULL": 115,
            "ENOANO": 104,
            "EBADRQC": 103,
            "EBADSLT": 102,
            "EDEADLOCK": 16,
            "EBFONT": 101,
            "ENOSTR": 100,
            "ENODATA": 116,
            "ETIME": 117,
            "ENOSR": 118,
            "ENONET": 119,
            "ENOPKG": 120,
            "EREMOTE": 121,
            "ENOLINK": 47,
            "EADV": 122,
            "ESRMNT": 123,
            "ECOMM": 124,
            "EPROTO": 65,
            "EMULTIHOP": 36,
            "EDOTDOT": 125,
            "EBADMSG": 9,
            "ENOTUNIQ": 126,
            "EBADFD": 127,
            "EREMCHG": 128,
            "ELIBACC": 129,
            "ELIBBAD": 130,
            "ELIBSCN": 131,
            "ELIBMAX": 132,
            "ELIBEXEC": 133,
            "ENOSYS": 52,
            "ENOTEMPTY": 55,
            "ENAMETOOLONG": 37,
            "ELOOP": 32,
            "EOPNOTSUPP": 138,
            "EPFNOSUPPORT": 139,
            "ECONNRESET": 15,
            "ENOBUFS": 42,
            "EAFNOSUPPORT": 5,
            "EPROTOTYPE": 67,
            "ENOTSOCK": 57,
            "ENOPROTOOPT": 50,
            "ESHUTDOWN": 140,
            "ECONNREFUSED": 14,
            "EADDRINUSE": 3,
            "ECONNABORTED": 13,
            "ENETUNREACH": 40,
            "ENETDOWN": 38,
            "ETIMEDOUT": 73,
            "EHOSTDOWN": 142,
            "EHOSTUNREACH": 23,
            "EINPROGRESS": 26,
            "EALREADY": 7,
            "EDESTADDRREQ": 17,
            "EMSGSIZE": 35,
            "EPROTONOSUPPORT": 66,
            "ESOCKTNOSUPPORT": 137,
            "EADDRNOTAVAIL": 4,
            "ENETRESET": 39,
            "EISCONN": 30,
            "ENOTCONN": 53,
            "ETOOMANYREFS": 141,
            "EUSERS": 136,
            "EDQUOT": 19,
            "ESTALE": 72,
            "ENOTSUP": 138,
            "ENOMEDIUM": 148,
            "EILSEQ": 25,
            "EOVERFLOW": 61,
            "ECANCELED": 11,
            "ENOTRECOVERABLE": 56,
            "EOWNERDEAD": 62,
            "ESTRPIPE": 135
          };
          var FS = {
            root: null,
            mounts: [],
            devices: {},
            streams: [],
            nextInode: 1,
            nameTable: null,
            currentPath: "/",
            initialized: false,
            ignorePermissions: true,
            filesystems: null,
            syncFSRequests: 0,
            readFiles: {},
            ErrnoError: class extends Error {
              // We set the `name` property to be able to identify `FS.ErrnoError`
              // - the `name` is a standard ECMA-262 property of error objects. Kind of good to have it anyway.
              // - when using PROXYFS, an error can come from an underlying FS
              // as different FS objects have their own FS.ErrnoError each,
              // the test `err instanceof FS.ErrnoError` won't detect an error coming from another filesystem, causing bugs.
              // we'll use the reliable test `err.name == "ErrnoError"` instead
              constructor(errno) {
                super(runtimeInitialized ? strError(errno) : "");
                __publicField(this, "name", "ErrnoError");
                this.errno = errno;
                for (var key in ERRNO_CODES) {
                  if (ERRNO_CODES[key] === errno) {
                    this.code = key;
                    break;
                  }
                }
              }
            },
            FSStream: class {
              constructor() {
                __publicField(this, "shared", {});
              }
              get object() {
                return this.node;
              }
              set object(val) {
                this.node = val;
              }
              get isRead() {
                return (this.flags & 2097155) !== 1;
              }
              get isWrite() {
                return (this.flags & 2097155) !== 0;
              }
              get isAppend() {
                return this.flags & 1024;
              }
              get flags() {
                return this.shared.flags;
              }
              set flags(val) {
                this.shared.flags = val;
              }
              get position() {
                return this.shared.position;
              }
              set position(val) {
                this.shared.position = val;
              }
            },
            FSNode: class {
              constructor(parent, name, mode, rdev) {
                __publicField(this, "node_ops", {});
                __publicField(this, "stream_ops", {});
                __publicField(this, "readMode", 292 | 73);
                __publicField(this, "writeMode", 146);
                __publicField(this, "mounted", null);
                if (!parent) {
                  parent = this;
                }
                this.parent = parent;
                this.mount = parent.mount;
                this.id = FS.nextInode++;
                this.name = name;
                this.mode = mode;
                this.rdev = rdev;
                this.atime = this.mtime = this.ctime = Date.now();
              }
              get read() {
                return (this.mode & this.readMode) === this.readMode;
              }
              set read(val) {
                val ? this.mode |= this.readMode : this.mode &= ~this.readMode;
              }
              get write() {
                return (this.mode & this.writeMode) === this.writeMode;
              }
              set write(val) {
                val ? this.mode |= this.writeMode : this.mode &= ~this.writeMode;
              }
              get isFolder() {
                return FS.isDir(this.mode);
              }
              get isDevice() {
                return FS.isChrdev(this.mode);
              }
            },
            lookupPath(path, opts = {}) {
              if (!path) {
                throw new FS.ErrnoError(44);
              }
              opts.follow_mount ?? (opts.follow_mount = true);
              if (!PATH.isAbs(path)) {
                path = FS.cwd() + "/" + path;
              }
              linkloop: for (var nlinks = 0; nlinks < 40; nlinks++) {
                var parts = path.split("/").filter((p) => !!p);
                var current = FS.root;
                var current_path = "/";
                for (var i = 0; i < parts.length; i++) {
                  var islast = i === parts.length - 1;
                  if (islast && opts.parent) {
                    break;
                  }
                  if (parts[i] === ".") {
                    continue;
                  }
                  if (parts[i] === "..") {
                    current_path = PATH.dirname(current_path);
                    if (FS.isRoot(current)) {
                      path = current_path + "/" + parts.slice(i + 1).join("/");
                      continue linkloop;
                    } else {
                      current = current.parent;
                    }
                    continue;
                  }
                  current_path = PATH.join2(current_path, parts[i]);
                  try {
                    current = FS.lookupNode(current, parts[i]);
                  } catch (e) {
                    if ((e == null ? void 0 : e.errno) === 44 && islast && opts.noent_okay) {
                      return {
                        path: current_path
                      };
                    }
                    throw e;
                  }
                  if (FS.isMountpoint(current) && (!islast || opts.follow_mount)) {
                    current = current.mounted.root;
                  }
                  if (FS.isLink(current.mode) && (!islast || opts.follow)) {
                    if (!current.node_ops.readlink) {
                      throw new FS.ErrnoError(52);
                    }
                    var link = current.node_ops.readlink(current);
                    if (!PATH.isAbs(link)) {
                      link = PATH.dirname(current_path) + "/" + link;
                    }
                    path = link + "/" + parts.slice(i + 1).join("/");
                    continue linkloop;
                  }
                }
                return {
                  path: current_path,
                  node: current
                };
              }
              throw new FS.ErrnoError(32);
            },
            getPath(node) {
              var path;
              while (true) {
                if (FS.isRoot(node)) {
                  var mount = node.mount.mountpoint;
                  if (!path) return mount;
                  return mount[mount.length - 1] !== "/" ? `${mount}/${path}` : mount + path;
                }
                path = path ? `${node.name}/${path}` : node.name;
                node = node.parent;
              }
            },
            hashName(parentid, name) {
              var hash = 0;
              for (var i = 0; i < name.length; i++) {
                hash = (hash << 5) - hash + name.charCodeAt(i) | 0;
              }
              return (parentid + hash >>> 0) % FS.nameTable.length;
            },
            hashAddNode(node) {
              var hash = FS.hashName(node.parent.id, node.name);
              node.name_next = FS.nameTable[hash];
              FS.nameTable[hash] = node;
            },
            hashRemoveNode(node) {
              var hash = FS.hashName(node.parent.id, node.name);
              if (FS.nameTable[hash] === node) {
                FS.nameTable[hash] = node.name_next;
              } else {
                var current = FS.nameTable[hash];
                while (current) {
                  if (current.name_next === node) {
                    current.name_next = node.name_next;
                    break;
                  }
                  current = current.name_next;
                }
              }
            },
            lookupNode(parent, name) {
              var errCode = FS.mayLookup(parent);
              if (errCode) {
                throw new FS.ErrnoError(errCode);
              }
              var hash = FS.hashName(parent.id, name);
              for (var node = FS.nameTable[hash]; node; node = node.name_next) {
                var nodeName = node.name;
                if (node.parent.id === parent.id && nodeName === name) {
                  return node;
                }
              }
              return FS.lookup(parent, name);
            },
            createNode(parent, name, mode, rdev) {
              assert(typeof parent == "object");
              var node = new FS.FSNode(parent, name, mode, rdev);
              FS.hashAddNode(node);
              return node;
            },
            destroyNode(node) {
              FS.hashRemoveNode(node);
            },
            isRoot(node) {
              return node === node.parent;
            },
            isMountpoint(node) {
              return !!node.mounted;
            },
            isFile(mode) {
              return (mode & 61440) === 32768;
            },
            isDir(mode) {
              return (mode & 61440) === 16384;
            },
            isLink(mode) {
              return (mode & 61440) === 40960;
            },
            isChrdev(mode) {
              return (mode & 61440) === 8192;
            },
            isBlkdev(mode) {
              return (mode & 61440) === 24576;
            },
            isFIFO(mode) {
              return (mode & 61440) === 4096;
            },
            isSocket(mode) {
              return (mode & 49152) === 49152;
            },
            flagsToPermissionString(flag) {
              var perms = ["r", "w", "rw"][flag & 3];
              if (flag & 512) {
                perms += "w";
              }
              return perms;
            },
            nodePermissions(node, perms) {
              if (FS.ignorePermissions) {
                return 0;
              }
              if (perms.includes("r") && !(node.mode & 292)) {
                return 2;
              } else if (perms.includes("w") && !(node.mode & 146)) {
                return 2;
              } else if (perms.includes("x") && !(node.mode & 73)) {
                return 2;
              }
              return 0;
            },
            mayLookup(dir) {
              if (!FS.isDir(dir.mode)) return 54;
              var errCode = FS.nodePermissions(dir, "x");
              if (errCode) return errCode;
              if (!dir.node_ops.lookup) return 2;
              return 0;
            },
            mayCreate(dir, name) {
              if (!FS.isDir(dir.mode)) {
                return 54;
              }
              try {
                var node = FS.lookupNode(dir, name);
                return 20;
              } catch (e) {
              }
              return FS.nodePermissions(dir, "wx");
            },
            mayDelete(dir, name, isdir) {
              var node;
              try {
                node = FS.lookupNode(dir, name);
              } catch (e) {
                return e.errno;
              }
              var errCode = FS.nodePermissions(dir, "wx");
              if (errCode) {
                return errCode;
              }
              if (isdir) {
                if (!FS.isDir(node.mode)) {
                  return 54;
                }
                if (FS.isRoot(node) || FS.getPath(node) === FS.cwd()) {
                  return 10;
                }
              } else {
                if (FS.isDir(node.mode)) {
                  return 31;
                }
              }
              return 0;
            },
            mayOpen(node, flags) {
              if (!node) {
                return 44;
              }
              if (FS.isLink(node.mode)) {
                return 32;
              } else if (FS.isDir(node.mode)) {
                if (FS.flagsToPermissionString(flags) !== "r" || flags & (512 | 64)) {
                  return 31;
                }
              }
              return FS.nodePermissions(node, FS.flagsToPermissionString(flags));
            },
            checkOpExists(op, err2) {
              if (!op) {
                throw new FS.ErrnoError(err2);
              }
              return op;
            },
            MAX_OPEN_FDS: 4096,
            nextfd() {
              for (var fd = 0; fd <= FS.MAX_OPEN_FDS; fd++) {
                if (!FS.streams[fd]) {
                  return fd;
                }
              }
              throw new FS.ErrnoError(33);
            },
            getStreamChecked(fd) {
              var stream = FS.getStream(fd);
              if (!stream) {
                throw new FS.ErrnoError(8);
              }
              return stream;
            },
            getStream: (fd) => FS.streams[fd],
            createStream(stream, fd = -1) {
              assert(fd >= -1);
              stream = Object.assign(new FS.FSStream(), stream);
              if (fd == -1) {
                fd = FS.nextfd();
              }
              stream.fd = fd;
              FS.streams[fd] = stream;
              return stream;
            },
            closeStream(fd) {
              FS.streams[fd] = null;
            },
            dupStream(origStream, fd = -1) {
              var _a2, _b;
              var stream = FS.createStream(origStream, fd);
              (_b = (_a2 = stream.stream_ops) == null ? void 0 : _a2.dup) == null ? void 0 : _b.call(_a2, stream);
              return stream;
            },
            doSetAttr(stream, node, attr) {
              var setattr = stream == null ? void 0 : stream.stream_ops.setattr;
              var arg = setattr ? stream : node;
              setattr ?? (setattr = node.node_ops.setattr);
              FS.checkOpExists(setattr, 63);
              setattr(arg, attr);
            },
            chrdev_stream_ops: {
              open(stream) {
                var _a2, _b;
                var device = FS.getDevice(stream.node.rdev);
                stream.stream_ops = device.stream_ops;
                (_b = (_a2 = stream.stream_ops).open) == null ? void 0 : _b.call(_a2, stream);
              },
              llseek() {
                throw new FS.ErrnoError(70);
              }
            },
            major: (dev) => dev >> 8,
            minor: (dev) => dev & 255,
            makedev: (ma, mi) => ma << 8 | mi,
            registerDevice(dev, ops) {
              FS.devices[dev] = {
                stream_ops: ops
              };
            },
            getDevice: (dev) => FS.devices[dev],
            getMounts(mount) {
              var mounts = [];
              var check = [mount];
              while (check.length) {
                var m = check.pop();
                mounts.push(m);
                check.push(...m.mounts);
              }
              return mounts;
            },
            syncfs(populate, callback) {
              if (typeof populate == "function") {
                callback = populate;
                populate = false;
              }
              FS.syncFSRequests++;
              if (FS.syncFSRequests > 1) {
                err(`warning: ${FS.syncFSRequests} FS.syncfs operations in flight at once, probably just doing extra work`);
              }
              var mounts = FS.getMounts(FS.root.mount);
              var completed = 0;
              function doCallback(errCode) {
                assert(FS.syncFSRequests > 0);
                FS.syncFSRequests--;
                return callback(errCode);
              }
              function done(errCode) {
                if (errCode) {
                  if (!done.errored) {
                    done.errored = true;
                    return doCallback(errCode);
                  }
                  return;
                }
                if (++completed >= mounts.length) {
                  doCallback(null);
                }
              }
              mounts.forEach((mount) => {
                if (!mount.type.syncfs) {
                  return done(null);
                }
                mount.type.syncfs(mount, populate, done);
              });
            },
            mount(type, opts, mountpoint) {
              if (typeof type == "string") {
                throw type;
              }
              var root = mountpoint === "/";
              var pseudo = !mountpoint;
              var node;
              if (root && FS.root) {
                throw new FS.ErrnoError(10);
              } else if (!root && !pseudo) {
                var lookup = FS.lookupPath(mountpoint, {
                  follow_mount: false
                });
                mountpoint = lookup.path;
                node = lookup.node;
                if (FS.isMountpoint(node)) {
                  throw new FS.ErrnoError(10);
                }
                if (!FS.isDir(node.mode)) {
                  throw new FS.ErrnoError(54);
                }
              }
              var mount = {
                type,
                opts,
                mountpoint,
                mounts: []
              };
              var mountRoot = type.mount(mount);
              mountRoot.mount = mount;
              mount.root = mountRoot;
              if (root) {
                FS.root = mountRoot;
              } else if (node) {
                node.mounted = mount;
                if (node.mount) {
                  node.mount.mounts.push(mount);
                }
              }
              return mountRoot;
            },
            unmount(mountpoint) {
              var lookup = FS.lookupPath(mountpoint, {
                follow_mount: false
              });
              if (!FS.isMountpoint(lookup.node)) {
                throw new FS.ErrnoError(28);
              }
              var node = lookup.node;
              var mount = node.mounted;
              var mounts = FS.getMounts(mount);
              Object.keys(FS.nameTable).forEach((hash) => {
                var current = FS.nameTable[hash];
                while (current) {
                  var next = current.name_next;
                  if (mounts.includes(current.mount)) {
                    FS.destroyNode(current);
                  }
                  current = next;
                }
              });
              node.mounted = null;
              var idx = node.mount.mounts.indexOf(mount);
              assert(idx !== -1);
              node.mount.mounts.splice(idx, 1);
            },
            lookup(parent, name) {
              return parent.node_ops.lookup(parent, name);
            },
            mknod(path, mode, dev) {
              var lookup = FS.lookupPath(path, {
                parent: true
              });
              var parent = lookup.node;
              var name = PATH.basename(path);
              if (!name) {
                throw new FS.ErrnoError(28);
              }
              if (name === "." || name === "..") {
                throw new FS.ErrnoError(20);
              }
              var errCode = FS.mayCreate(parent, name);
              if (errCode) {
                throw new FS.ErrnoError(errCode);
              }
              if (!parent.node_ops.mknod) {
                throw new FS.ErrnoError(63);
              }
              return parent.node_ops.mknod(parent, name, mode, dev);
            },
            statfs(path) {
              return FS.statfsNode(FS.lookupPath(path, {
                follow: true
              }).node);
            },
            statfsStream(stream) {
              return FS.statfsNode(stream.node);
            },
            statfsNode(node) {
              var rtn = {
                bsize: 4096,
                frsize: 4096,
                blocks: 1e6,
                bfree: 5e5,
                bavail: 5e5,
                files: FS.nextInode,
                ffree: FS.nextInode - 1,
                fsid: 42,
                flags: 2,
                namelen: 255
              };
              if (node.node_ops.statfs) {
                Object.assign(rtn, node.node_ops.statfs(node.mount.opts.root));
              }
              return rtn;
            },
            create(path, mode = 438) {
              mode &= 4095;
              mode |= 32768;
              return FS.mknod(path, mode, 0);
            },
            mkdir(path, mode = 511) {
              mode &= 511 | 512;
              mode |= 16384;
              return FS.mknod(path, mode, 0);
            },
            mkdirTree(path, mode) {
              var dirs = path.split("/");
              var d = "";
              for (var dir of dirs) {
                if (!dir) continue;
                if (d || PATH.isAbs(path)) d += "/";
                d += dir;
                try {
                  FS.mkdir(d, mode);
                } catch (e) {
                  if (e.errno != 20) throw e;
                }
              }
            },
            mkdev(path, mode, dev) {
              if (typeof dev == "undefined") {
                dev = mode;
                mode = 438;
              }
              mode |= 8192;
              return FS.mknod(path, mode, dev);
            },
            symlink(oldpath, newpath) {
              if (!PATH_FS.resolve(oldpath)) {
                throw new FS.ErrnoError(44);
              }
              var lookup = FS.lookupPath(newpath, {
                parent: true
              });
              var parent = lookup.node;
              if (!parent) {
                throw new FS.ErrnoError(44);
              }
              var newname = PATH.basename(newpath);
              var errCode = FS.mayCreate(parent, newname);
              if (errCode) {
                throw new FS.ErrnoError(errCode);
              }
              if (!parent.node_ops.symlink) {
                throw new FS.ErrnoError(63);
              }
              return parent.node_ops.symlink(parent, newname, oldpath);
            },
            rename(old_path, new_path) {
              var old_dirname = PATH.dirname(old_path);
              var new_dirname = PATH.dirname(new_path);
              var old_name = PATH.basename(old_path);
              var new_name = PATH.basename(new_path);
              var lookup, old_dir, new_dir;
              lookup = FS.lookupPath(old_path, {
                parent: true
              });
              old_dir = lookup.node;
              lookup = FS.lookupPath(new_path, {
                parent: true
              });
              new_dir = lookup.node;
              if (!old_dir || !new_dir) throw new FS.ErrnoError(44);
              if (old_dir.mount !== new_dir.mount) {
                throw new FS.ErrnoError(75);
              }
              var old_node = FS.lookupNode(old_dir, old_name);
              var relative = PATH_FS.relative(old_path, new_dirname);
              if (relative.charAt(0) !== ".") {
                throw new FS.ErrnoError(28);
              }
              relative = PATH_FS.relative(new_path, old_dirname);
              if (relative.charAt(0) !== ".") {
                throw new FS.ErrnoError(55);
              }
              var new_node;
              try {
                new_node = FS.lookupNode(new_dir, new_name);
              } catch (e) {
              }
              if (old_node === new_node) {
                return;
              }
              var isdir = FS.isDir(old_node.mode);
              var errCode = FS.mayDelete(old_dir, old_name, isdir);
              if (errCode) {
                throw new FS.ErrnoError(errCode);
              }
              errCode = new_node ? FS.mayDelete(new_dir, new_name, isdir) : FS.mayCreate(new_dir, new_name);
              if (errCode) {
                throw new FS.ErrnoError(errCode);
              }
              if (!old_dir.node_ops.rename) {
                throw new FS.ErrnoError(63);
              }
              if (FS.isMountpoint(old_node) || new_node && FS.isMountpoint(new_node)) {
                throw new FS.ErrnoError(10);
              }
              if (new_dir !== old_dir) {
                errCode = FS.nodePermissions(old_dir, "w");
                if (errCode) {
                  throw new FS.ErrnoError(errCode);
                }
              }
              FS.hashRemoveNode(old_node);
              try {
                old_dir.node_ops.rename(old_node, new_dir, new_name);
                old_node.parent = new_dir;
              } catch (e) {
                throw e;
              } finally {
                FS.hashAddNode(old_node);
              }
            },
            rmdir(path) {
              var lookup = FS.lookupPath(path, {
                parent: true
              });
              var parent = lookup.node;
              var name = PATH.basename(path);
              var node = FS.lookupNode(parent, name);
              var errCode = FS.mayDelete(parent, name, true);
              if (errCode) {
                throw new FS.ErrnoError(errCode);
              }
              if (!parent.node_ops.rmdir) {
                throw new FS.ErrnoError(63);
              }
              if (FS.isMountpoint(node)) {
                throw new FS.ErrnoError(10);
              }
              parent.node_ops.rmdir(parent, name);
              FS.destroyNode(node);
            },
            readdir(path) {
              var lookup = FS.lookupPath(path, {
                follow: true
              });
              var node = lookup.node;
              var readdir = FS.checkOpExists(node.node_ops.readdir, 54);
              return readdir(node);
            },
            unlink(path) {
              var lookup = FS.lookupPath(path, {
                parent: true
              });
              var parent = lookup.node;
              if (!parent) {
                throw new FS.ErrnoError(44);
              }
              var name = PATH.basename(path);
              var node = FS.lookupNode(parent, name);
              var errCode = FS.mayDelete(parent, name, false);
              if (errCode) {
                throw new FS.ErrnoError(errCode);
              }
              if (!parent.node_ops.unlink) {
                throw new FS.ErrnoError(63);
              }
              if (FS.isMountpoint(node)) {
                throw new FS.ErrnoError(10);
              }
              parent.node_ops.unlink(parent, name);
              FS.destroyNode(node);
            },
            readlink(path) {
              var lookup = FS.lookupPath(path);
              var link = lookup.node;
              if (!link) {
                throw new FS.ErrnoError(44);
              }
              if (!link.node_ops.readlink) {
                throw new FS.ErrnoError(28);
              }
              return link.node_ops.readlink(link);
            },
            stat(path, dontFollow) {
              var lookup = FS.lookupPath(path, {
                follow: !dontFollow
              });
              var node = lookup.node;
              var getattr = FS.checkOpExists(node.node_ops.getattr, 63);
              return getattr(node);
            },
            fstat(fd) {
              var stream = FS.getStreamChecked(fd);
              var node = stream.node;
              var getattr = stream.stream_ops.getattr;
              var arg = getattr ? stream : node;
              getattr ?? (getattr = node.node_ops.getattr);
              FS.checkOpExists(getattr, 63);
              return getattr(arg);
            },
            lstat(path) {
              return FS.stat(path, true);
            },
            doChmod(stream, node, mode, dontFollow) {
              FS.doSetAttr(stream, node, {
                mode: mode & 4095 | node.mode & -4096,
                ctime: Date.now(),
                dontFollow
              });
            },
            chmod(path, mode, dontFollow) {
              var node;
              if (typeof path == "string") {
                var lookup = FS.lookupPath(path, {
                  follow: !dontFollow
                });
                node = lookup.node;
              } else {
                node = path;
              }
              FS.doChmod(null, node, mode, dontFollow);
            },
            lchmod(path, mode) {
              FS.chmod(path, mode, true);
            },
            fchmod(fd, mode) {
              var stream = FS.getStreamChecked(fd);
              FS.doChmod(stream, stream.node, mode, false);
            },
            doChown(stream, node, dontFollow) {
              FS.doSetAttr(stream, node, {
                timestamp: Date.now(),
                dontFollow
              });
            },
            chown(path, uid, gid, dontFollow) {
              var node;
              if (typeof path == "string") {
                var lookup = FS.lookupPath(path, {
                  follow: !dontFollow
                });
                node = lookup.node;
              } else {
                node = path;
              }
              FS.doChown(null, node, dontFollow);
            },
            lchown(path, uid, gid) {
              FS.chown(path, uid, gid, true);
            },
            fchown(fd, uid, gid) {
              var stream = FS.getStreamChecked(fd);
              FS.doChown(stream, stream.node, false);
            },
            doTruncate(stream, node, len) {
              if (FS.isDir(node.mode)) {
                throw new FS.ErrnoError(31);
              }
              if (!FS.isFile(node.mode)) {
                throw new FS.ErrnoError(28);
              }
              var errCode = FS.nodePermissions(node, "w");
              if (errCode) {
                throw new FS.ErrnoError(errCode);
              }
              FS.doSetAttr(stream, node, {
                size: len,
                timestamp: Date.now()
              });
            },
            truncate(path, len) {
              if (len < 0) {
                throw new FS.ErrnoError(28);
              }
              var node;
              if (typeof path == "string") {
                var lookup = FS.lookupPath(path, {
                  follow: true
                });
                node = lookup.node;
              } else {
                node = path;
              }
              FS.doTruncate(null, node, len);
            },
            ftruncate(fd, len) {
              var stream = FS.getStreamChecked(fd);
              if (len < 0 || (stream.flags & 2097155) === 0) {
                throw new FS.ErrnoError(28);
              }
              FS.doTruncate(stream, stream.node, len);
            },
            utime(path, atime, mtime) {
              var lookup = FS.lookupPath(path, {
                follow: true
              });
              var node = lookup.node;
              var setattr = FS.checkOpExists(node.node_ops.setattr, 63);
              setattr(node, {
                atime,
                mtime
              });
            },
            open(path, flags, mode = 438) {
              if (path === "") {
                throw new FS.ErrnoError(44);
              }
              flags = typeof flags == "string" ? FS_modeStringToFlags(flags) : flags;
              if (flags & 64) {
                mode = mode & 4095 | 32768;
              } else {
                mode = 0;
              }
              var node;
              var isDirPath;
              if (typeof path == "object") {
                node = path;
              } else {
                isDirPath = path.endsWith("/");
                var lookup = FS.lookupPath(path, {
                  follow: !(flags & 131072),
                  noent_okay: true
                });
                node = lookup.node;
                path = lookup.path;
              }
              var created = false;
              if (flags & 64) {
                if (node) {
                  if (flags & 128) {
                    throw new FS.ErrnoError(20);
                  }
                } else if (isDirPath) {
                  throw new FS.ErrnoError(31);
                } else {
                  node = FS.mknod(path, mode | 511, 0);
                  created = true;
                }
              }
              if (!node) {
                throw new FS.ErrnoError(44);
              }
              if (FS.isChrdev(node.mode)) {
                flags &= -513;
              }
              if (flags & 65536 && !FS.isDir(node.mode)) {
                throw new FS.ErrnoError(54);
              }
              if (!created) {
                var errCode = FS.mayOpen(node, flags);
                if (errCode) {
                  throw new FS.ErrnoError(errCode);
                }
              }
              if (flags & 512 && !created) {
                FS.truncate(node, 0);
              }
              flags &= -131713;
              var stream = FS.createStream({
                node,
                path: FS.getPath(node),
                // we want the absolute path to the node
                flags,
                seekable: true,
                position: 0,
                stream_ops: node.stream_ops,
                // used by the file family libc calls (fopen, fwrite, ferror, etc.)
                ungotten: [],
                error: false
              });
              if (stream.stream_ops.open) {
                stream.stream_ops.open(stream);
              }
              if (created) {
                FS.chmod(node, mode & 511);
              }
              if (Module["logReadFiles"] && !(flags & 1)) {
                if (!(path in FS.readFiles)) {
                  FS.readFiles[path] = 1;
                }
              }
              return stream;
            },
            close(stream) {
              if (FS.isClosed(stream)) {
                throw new FS.ErrnoError(8);
              }
              if (stream.getdents) stream.getdents = null;
              try {
                if (stream.stream_ops.close) {
                  stream.stream_ops.close(stream);
                }
              } catch (e) {
                throw e;
              } finally {
                FS.closeStream(stream.fd);
              }
              stream.fd = null;
            },
            isClosed(stream) {
              return stream.fd === null;
            },
            llseek(stream, offset, whence) {
              if (FS.isClosed(stream)) {
                throw new FS.ErrnoError(8);
              }
              if (!stream.seekable || !stream.stream_ops.llseek) {
                throw new FS.ErrnoError(70);
              }
              if (whence != 0 && whence != 1 && whence != 2) {
                throw new FS.ErrnoError(28);
              }
              stream.position = stream.stream_ops.llseek(stream, offset, whence);
              stream.ungotten = [];
              return stream.position;
            },
            read(stream, buffer, offset, length, position) {
              assert(offset >= 0);
              if (length < 0 || position < 0) {
                throw new FS.ErrnoError(28);
              }
              if (FS.isClosed(stream)) {
                throw new FS.ErrnoError(8);
              }
              if ((stream.flags & 2097155) === 1) {
                throw new FS.ErrnoError(8);
              }
              if (FS.isDir(stream.node.mode)) {
                throw new FS.ErrnoError(31);
              }
              if (!stream.stream_ops.read) {
                throw new FS.ErrnoError(28);
              }
              var seeking = typeof position != "undefined";
              if (!seeking) {
                position = stream.position;
              } else if (!stream.seekable) {
                throw new FS.ErrnoError(70);
              }
              var bytesRead = stream.stream_ops.read(stream, buffer, offset, length, position);
              if (!seeking) stream.position += bytesRead;
              return bytesRead;
            },
            write(stream, buffer, offset, length, position, canOwn) {
              assert(offset >= 0);
              if (length < 0 || position < 0) {
                throw new FS.ErrnoError(28);
              }
              if (FS.isClosed(stream)) {
                throw new FS.ErrnoError(8);
              }
              if ((stream.flags & 2097155) === 0) {
                throw new FS.ErrnoError(8);
              }
              if (FS.isDir(stream.node.mode)) {
                throw new FS.ErrnoError(31);
              }
              if (!stream.stream_ops.write) {
                throw new FS.ErrnoError(28);
              }
              if (stream.seekable && stream.flags & 1024) {
                FS.llseek(stream, 0, 2);
              }
              var seeking = typeof position != "undefined";
              if (!seeking) {
                position = stream.position;
              } else if (!stream.seekable) {
                throw new FS.ErrnoError(70);
              }
              var bytesWritten = stream.stream_ops.write(stream, buffer, offset, length, position, canOwn);
              if (!seeking) stream.position += bytesWritten;
              return bytesWritten;
            },
            mmap(stream, length, position, prot, flags) {
              if ((prot & 2) !== 0 && (flags & 2) === 0 && (stream.flags & 2097155) !== 2) {
                throw new FS.ErrnoError(2);
              }
              if ((stream.flags & 2097155) === 1) {
                throw new FS.ErrnoError(2);
              }
              if (!stream.stream_ops.mmap) {
                throw new FS.ErrnoError(43);
              }
              if (!length) {
                throw new FS.ErrnoError(28);
              }
              return stream.stream_ops.mmap(stream, length, position, prot, flags);
            },
            msync(stream, buffer, offset, length, mmapFlags) {
              assert(offset >= 0);
              if (!stream.stream_ops.msync) {
                return 0;
              }
              return stream.stream_ops.msync(stream, buffer, offset, length, mmapFlags);
            },
            ioctl(stream, cmd, arg) {
              if (!stream.stream_ops.ioctl) {
                throw new FS.ErrnoError(59);
              }
              return stream.stream_ops.ioctl(stream, cmd, arg);
            },
            readFile(path, opts = {}) {
              opts.flags = opts.flags || 0;
              opts.encoding = opts.encoding || "binary";
              if (opts.encoding !== "utf8" && opts.encoding !== "binary") {
                throw new Error(`Invalid encoding type "${opts.encoding}"`);
              }
              var ret;
              var stream = FS.open(path, opts.flags);
              var stat = FS.stat(path);
              var length = stat.size;
              var buf = new Uint8Array(length);
              FS.read(stream, buf, 0, length, 0);
              if (opts.encoding === "utf8") {
                ret = UTF8ArrayToString(buf);
              } else if (opts.encoding === "binary") {
                ret = buf;
              }
              FS.close(stream);
              return ret;
            },
            writeFile(path, data, opts = {}) {
              opts.flags = opts.flags || 577;
              var stream = FS.open(path, opts.flags, opts.mode);
              if (typeof data == "string") {
                var buf = new Uint8Array(lengthBytesUTF8(data) + 1);
                var actualNumBytes = stringToUTF8Array(data, buf, 0, buf.length);
                FS.write(stream, buf, 0, actualNumBytes, void 0, opts.canOwn);
              } else if (ArrayBuffer.isView(data)) {
                FS.write(stream, data, 0, data.byteLength, void 0, opts.canOwn);
              } else {
                throw new Error("Unsupported data type");
              }
              FS.close(stream);
            },
            cwd: () => FS.currentPath,
            chdir(path) {
              var lookup = FS.lookupPath(path, {
                follow: true
              });
              if (lookup.node === null) {
                throw new FS.ErrnoError(44);
              }
              if (!FS.isDir(lookup.node.mode)) {
                throw new FS.ErrnoError(54);
              }
              var errCode = FS.nodePermissions(lookup.node, "x");
              if (errCode) {
                throw new FS.ErrnoError(errCode);
              }
              FS.currentPath = lookup.path;
            },
            createDefaultDirectories() {
              FS.mkdir("/tmp");
              FS.mkdir("/home");
              FS.mkdir("/home/web_user");
            },
            createDefaultDevices() {
              FS.mkdir("/dev");
              FS.registerDevice(FS.makedev(1, 3), {
                read: () => 0,
                write: (stream, buffer, offset, length, pos) => length,
                llseek: () => 0
              });
              FS.mkdev("/dev/null", FS.makedev(1, 3));
              TTY.register(FS.makedev(5, 0), TTY.default_tty_ops);
              TTY.register(FS.makedev(6, 0), TTY.default_tty1_ops);
              FS.mkdev("/dev/tty", FS.makedev(5, 0));
              FS.mkdev("/dev/tty1", FS.makedev(6, 0));
              var randomBuffer = new Uint8Array(1024), randomLeft = 0;
              var randomByte = () => {
                if (randomLeft === 0) {
                  randomFill(randomBuffer);
                  randomLeft = randomBuffer.byteLength;
                }
                return randomBuffer[--randomLeft];
              };
              FS.createDevice("/dev", "random", randomByte);
              FS.createDevice("/dev", "urandom", randomByte);
              FS.mkdir("/dev/shm");
              FS.mkdir("/dev/shm/tmp");
            },
            createSpecialDirectories() {
              FS.mkdir("/proc");
              var proc_self = FS.mkdir("/proc/self");
              FS.mkdir("/proc/self/fd");
              FS.mount({
                mount() {
                  var node = FS.createNode(proc_self, "fd", 16895, 73);
                  node.stream_ops = {
                    llseek: MEMFS.stream_ops.llseek
                  };
                  node.node_ops = {
                    lookup(parent, name) {
                      var fd = +name;
                      var stream = FS.getStreamChecked(fd);
                      var ret = {
                        parent: null,
                        mount: {
                          mountpoint: "fake"
                        },
                        node_ops: {
                          readlink: () => stream.path
                        },
                        id: fd + 1
                      };
                      ret.parent = ret;
                      return ret;
                    },
                    readdir() {
                      return Array.from(FS.streams.entries()).filter(([k, v]) => v).map(([k, v]) => k.toString());
                    }
                  };
                  return node;
                }
              }, {}, "/proc/self/fd");
            },
            createStandardStreams(input, output, error) {
              if (input) {
                FS.createDevice("/dev", "stdin", input);
              } else {
                FS.symlink("/dev/tty", "/dev/stdin");
              }
              if (output) {
                FS.createDevice("/dev", "stdout", null, output);
              } else {
                FS.symlink("/dev/tty", "/dev/stdout");
              }
              if (error) {
                FS.createDevice("/dev", "stderr", null, error);
              } else {
                FS.symlink("/dev/tty1", "/dev/stderr");
              }
              var stdin = FS.open("/dev/stdin", 0);
              var stdout = FS.open("/dev/stdout", 1);
              var stderr = FS.open("/dev/stderr", 1);
              assert(stdin.fd === 0, `invalid handle for stdin (${stdin.fd})`);
              assert(stdout.fd === 1, `invalid handle for stdout (${stdout.fd})`);
              assert(stderr.fd === 2, `invalid handle for stderr (${stderr.fd})`);
            },
            staticInit() {
              FS.nameTable = new Array(4096);
              FS.mount(MEMFS, {}, "/");
              FS.createDefaultDirectories();
              FS.createDefaultDevices();
              FS.createSpecialDirectories();
              FS.filesystems = {
                "MEMFS": MEMFS,
                "WORKERFS": WORKERFS
              };
            },
            init(input, output, error) {
              assert(!FS.initialized, "FS.init was previously called. If you want to initialize later with custom parameters, remove any earlier calls (note that one is automatically added to the generated code)");
              FS.initialized = true;
              input ?? (input = Module["stdin"]);
              output ?? (output = Module["stdout"]);
              error ?? (error = Module["stderr"]);
              FS.createStandardStreams(input, output, error);
            },
            quit() {
              FS.initialized = false;
              _fflush(0);
              for (var stream of FS.streams) {
                if (stream) {
                  FS.close(stream);
                }
              }
            },
            findObject(path, dontResolveLastLink) {
              var ret = FS.analyzePath(path, dontResolveLastLink);
              if (!ret.exists) {
                return null;
              }
              return ret.object;
            },
            analyzePath(path, dontResolveLastLink) {
              try {
                var lookup = FS.lookupPath(path, {
                  follow: !dontResolveLastLink
                });
                path = lookup.path;
              } catch (e) {
              }
              var ret = {
                isRoot: false,
                exists: false,
                error: 0,
                name: null,
                path: null,
                object: null,
                parentExists: false,
                parentPath: null,
                parentObject: null
              };
              try {
                var lookup = FS.lookupPath(path, {
                  parent: true
                });
                ret.parentExists = true;
                ret.parentPath = lookup.path;
                ret.parentObject = lookup.node;
                ret.name = PATH.basename(path);
                lookup = FS.lookupPath(path, {
                  follow: !dontResolveLastLink
                });
                ret.exists = true;
                ret.path = lookup.path;
                ret.object = lookup.node;
                ret.name = lookup.node.name;
                ret.isRoot = lookup.path === "/";
              } catch (e) {
                ret.error = e.errno;
              }
              return ret;
            },
            createPath(parent, path, canRead, canWrite) {
              parent = typeof parent == "string" ? parent : FS.getPath(parent);
              var parts = path.split("/").reverse();
              while (parts.length) {
                var part = parts.pop();
                if (!part) continue;
                var current = PATH.join2(parent, part);
                try {
                  FS.mkdir(current);
                } catch (e) {
                  if (e.errno != 20) throw e;
                }
                parent = current;
              }
              return current;
            },
            createFile(parent, name, properties, canRead, canWrite) {
              var path = PATH.join2(typeof parent == "string" ? parent : FS.getPath(parent), name);
              var mode = FS_getMode(canRead, canWrite);
              return FS.create(path, mode);
            },
            createDataFile(parent, name, data, canRead, canWrite, canOwn) {
              var path = name;
              if (parent) {
                parent = typeof parent == "string" ? parent : FS.getPath(parent);
                path = name ? PATH.join2(parent, name) : parent;
              }
              var mode = FS_getMode(canRead, canWrite);
              var node = FS.create(path, mode);
              if (data) {
                if (typeof data == "string") {
                  var arr = new Array(data.length);
                  for (var i = 0, len = data.length; i < len; ++i) arr[i] = data.charCodeAt(i);
                  data = arr;
                }
                FS.chmod(node, mode | 146);
                var stream = FS.open(node, 577);
                FS.write(stream, data, 0, data.length, 0, canOwn);
                FS.close(stream);
                FS.chmod(node, mode);
              }
            },
            createDevice(parent, name, input, output) {
              var _a2;
              var path = PATH.join2(typeof parent == "string" ? parent : FS.getPath(parent), name);
              var mode = FS_getMode(!!input, !!output);
              (_a2 = FS.createDevice).major ?? (_a2.major = 64);
              var dev = FS.makedev(FS.createDevice.major++, 0);
              FS.registerDevice(dev, {
                open(stream) {
                  stream.seekable = false;
                },
                close(stream) {
                  var _a3;
                  if ((_a3 = output == null ? void 0 : output.buffer) == null ? void 0 : _a3.length) {
                    output(10);
                  }
                },
                read(stream, buffer, offset, length, pos) {
                  var bytesRead = 0;
                  for (var i = 0; i < length; i++) {
                    var result;
                    try {
                      result = input();
                    } catch (e) {
                      throw new FS.ErrnoError(29);
                    }
                    if (result === void 0 && bytesRead === 0) {
                      throw new FS.ErrnoError(6);
                    }
                    if (result === null || result === void 0) break;
                    bytesRead++;
                    buffer[offset + i] = result;
                  }
                  if (bytesRead) {
                    stream.node.atime = Date.now();
                  }
                  return bytesRead;
                },
                write(stream, buffer, offset, length, pos) {
                  for (var i = 0; i < length; i++) {
                    try {
                      output(buffer[offset + i]);
                    } catch (e) {
                      throw new FS.ErrnoError(29);
                    }
                  }
                  if (length) {
                    stream.node.mtime = stream.node.ctime = Date.now();
                  }
                  return i;
                }
              });
              return FS.mkdev(path, mode, dev);
            },
            forceLoadFile(obj) {
              if (obj.isDevice || obj.isFolder || obj.link || obj.contents) return true;
              if (typeof XMLHttpRequest != "undefined") {
                throw new Error("Lazy loading should have been performed (contents set) in createLazyFile, but it was not. Lazy loading only works in web workers. Use --embed-file or --preload-file in emcc on the main thread.");
              } else {
                try {
                  obj.contents = readBinary(obj.url);
                  obj.usedBytes = obj.contents.length;
                } catch (e) {
                  throw new FS.ErrnoError(29);
                }
              }
            },
            createLazyFile(parent, name, url, canRead, canWrite) {
              class LazyUint8Array {
                constructor() {
                  __publicField(this, "lengthKnown", false);
                  __publicField(this, "chunks", []);
                }
                // Loaded chunks. Index is the chunk number
                get(idx) {
                  if (idx > this.length - 1 || idx < 0) {
                    return void 0;
                  }
                  var chunkOffset = idx % this.chunkSize;
                  var chunkNum = idx / this.chunkSize | 0;
                  return this.getter(chunkNum)[chunkOffset];
                }
                setDataGetter(getter) {
                  this.getter = getter;
                }
                cacheLength() {
                  var xhr = new XMLHttpRequest();
                  xhr.open("HEAD", url, false);
                  xhr.send(null);
                  if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
                  var datalength = Number(xhr.getResponseHeader("Content-length"));
                  var header;
                  var hasByteServing = (header = xhr.getResponseHeader("Accept-Ranges")) && header === "bytes";
                  var usesGzip = (header = xhr.getResponseHeader("Content-Encoding")) && header === "gzip";
                  var chunkSize = 1024 * 1024;
                  if (!hasByteServing) chunkSize = datalength;
                  var doXHR = (from, to) => {
                    if (from > to) throw new Error("invalid range (" + from + ", " + to + ") or no bytes requested!");
                    if (to > datalength - 1) throw new Error("only " + datalength + " bytes available! programmer error!");
                    var xhr2 = new XMLHttpRequest();
                    xhr2.open("GET", url, false);
                    if (datalength !== chunkSize) xhr2.setRequestHeader("Range", "bytes=" + from + "-" + to);
                    xhr2.responseType = "arraybuffer";
                    if (xhr2.overrideMimeType) {
                      xhr2.overrideMimeType("text/plain; charset=x-user-defined");
                    }
                    xhr2.send(null);
                    if (!(xhr2.status >= 200 && xhr2.status < 300 || xhr2.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr2.status);
                    if (xhr2.response !== void 0) {
                      return new Uint8Array(
                        /** @type{Array<number>} */
                        xhr2.response || []
                      );
                    }
                    return intArrayFromString(xhr2.responseText || "");
                  };
                  var lazyArray2 = this;
                  lazyArray2.setDataGetter((chunkNum) => {
                    var start = chunkNum * chunkSize;
                    var end = (chunkNum + 1) * chunkSize - 1;
                    end = Math.min(end, datalength - 1);
                    if (typeof lazyArray2.chunks[chunkNum] == "undefined") {
                      lazyArray2.chunks[chunkNum] = doXHR(start, end);
                    }
                    if (typeof lazyArray2.chunks[chunkNum] == "undefined") throw new Error("doXHR failed!");
                    return lazyArray2.chunks[chunkNum];
                  });
                  if (usesGzip || !datalength) {
                    chunkSize = datalength = 1;
                    datalength = this.getter(0).length;
                    chunkSize = datalength;
                    out("LazyFiles on gzip forces download of the whole file when length is accessed");
                  }
                  this._length = datalength;
                  this._chunkSize = chunkSize;
                  this.lengthKnown = true;
                }
                get length() {
                  if (!this.lengthKnown) {
                    this.cacheLength();
                  }
                  return this._length;
                }
                get chunkSize() {
                  if (!this.lengthKnown) {
                    this.cacheLength();
                  }
                  return this._chunkSize;
                }
              }
              if (typeof XMLHttpRequest != "undefined") {
                if (!ENVIRONMENT_IS_WORKER) throw "Cannot do synchronous binary XHRs outside webworkers in modern browsers. Use --embed-file or --preload-file in emcc";
                var lazyArray = new LazyUint8Array();
                var properties = {
                  isDevice: false,
                  contents: lazyArray
                };
              } else {
                var properties = {
                  isDevice: false,
                  url
                };
              }
              var node = FS.createFile(parent, name, properties, canRead, canWrite);
              if (properties.contents) {
                node.contents = properties.contents;
              } else if (properties.url) {
                node.contents = null;
                node.url = properties.url;
              }
              Object.defineProperties(node, {
                usedBytes: {
                  get: function() {
                    return this.contents.length;
                  }
                }
              });
              var stream_ops = {};
              var keys = Object.keys(node.stream_ops);
              keys.forEach((key) => {
                var fn = node.stream_ops[key];
                stream_ops[key] = (...args) => {
                  FS.forceLoadFile(node);
                  return fn(...args);
                };
              });
              function writeChunks(stream, buffer, offset, length, position) {
                var contents = stream.node.contents;
                if (position >= contents.length) return 0;
                var size = Math.min(contents.length - position, length);
                assert(size >= 0);
                if (contents.slice) {
                  for (var i = 0; i < size; i++) {
                    buffer[offset + i] = contents[position + i];
                  }
                } else {
                  for (var i = 0; i < size; i++) {
                    buffer[offset + i] = contents.get(position + i);
                  }
                }
                return size;
              }
              stream_ops.read = (stream, buffer, offset, length, position) => {
                FS.forceLoadFile(node);
                return writeChunks(stream, buffer, offset, length, position);
              };
              stream_ops.mmap = (stream, length, position, prot, flags) => {
                FS.forceLoadFile(node);
                var ptr = mmapAlloc(length);
                if (!ptr) {
                  throw new FS.ErrnoError(48);
                }
                writeChunks(stream, HEAP8, ptr, length, position);
                return {
                  ptr,
                  allocated: true
                };
              };
              node.stream_ops = stream_ops;
              return node;
            },
            absolutePath() {
              abort("FS.absolutePath has been removed; use PATH_FS.resolve instead");
            },
            createFolder() {
              abort("FS.createFolder has been removed; use FS.mkdir instead");
            },
            createLink() {
              abort("FS.createLink has been removed; use FS.symlink instead");
            },
            joinPath() {
              abort("FS.joinPath has been removed; use PATH.join instead");
            },
            mmapAlloc() {
              abort("FS.mmapAlloc has been replaced by the top level function mmapAlloc");
            },
            standardizePath() {
              abort("FS.standardizePath has been removed; use PATH.normalize instead");
            }
          };
          var SYSCALLS = {
            DEFAULT_POLLMASK: 5,
            calculateAt(dirfd, path, allowEmpty) {
              if (PATH.isAbs(path)) {
                return path;
              }
              var dir;
              if (dirfd === -100) {
                dir = FS.cwd();
              } else {
                var dirstream = SYSCALLS.getStreamFromFD(dirfd);
                dir = dirstream.path;
              }
              if (path.length == 0) {
                if (!allowEmpty) {
                  throw new FS.ErrnoError(44);
                }
                return dir;
              }
              return dir + "/" + path;
            },
            writeStat(buf, stat) {
              HEAP32[buf >>> 2 >>> 0] = stat.dev;
              HEAP32[buf + 4 >>> 2 >>> 0] = stat.mode;
              HEAPU32[buf + 8 >>> 2 >>> 0] = stat.nlink;
              HEAP32[buf + 12 >>> 2 >>> 0] = stat.uid;
              HEAP32[buf + 16 >>> 2 >>> 0] = stat.gid;
              HEAP32[buf + 20 >>> 2 >>> 0] = stat.rdev;
              HEAP64[buf + 24 >>> 3] = BigInt(stat.size);
              HEAP32[buf + 32 >>> 2 >>> 0] = 4096;
              HEAP32[buf + 36 >>> 2 >>> 0] = stat.blocks;
              var atime = stat.atime.getTime();
              var mtime = stat.mtime.getTime();
              var ctime = stat.ctime.getTime();
              HEAP64[buf + 40 >>> 3] = BigInt(Math.floor(atime / 1e3));
              HEAPU32[buf + 48 >>> 2 >>> 0] = atime % 1e3 * 1e3 * 1e3;
              HEAP64[buf + 56 >>> 3] = BigInt(Math.floor(mtime / 1e3));
              HEAPU32[buf + 64 >>> 2 >>> 0] = mtime % 1e3 * 1e3 * 1e3;
              HEAP64[buf + 72 >>> 3] = BigInt(Math.floor(ctime / 1e3));
              HEAPU32[buf + 80 >>> 2 >>> 0] = ctime % 1e3 * 1e3 * 1e3;
              HEAP64[buf + 88 >>> 3] = BigInt(stat.ino);
              return 0;
            },
            writeStatFs(buf, stats) {
              HEAP32[buf + 4 >>> 2 >>> 0] = stats.bsize;
              HEAP32[buf + 40 >>> 2 >>> 0] = stats.bsize;
              HEAP32[buf + 8 >>> 2 >>> 0] = stats.blocks;
              HEAP32[buf + 12 >>> 2 >>> 0] = stats.bfree;
              HEAP32[buf + 16 >>> 2 >>> 0] = stats.bavail;
              HEAP32[buf + 20 >>> 2 >>> 0] = stats.files;
              HEAP32[buf + 24 >>> 2 >>> 0] = stats.ffree;
              HEAP32[buf + 28 >>> 2 >>> 0] = stats.fsid;
              HEAP32[buf + 44 >>> 2 >>> 0] = stats.flags;
              HEAP32[buf + 36 >>> 2 >>> 0] = stats.namelen;
            },
            doMsync(addr, stream, len, flags, offset) {
              if (!FS.isFile(stream.node.mode)) {
                throw new FS.ErrnoError(43);
              }
              if (flags & 2) {
                return 0;
              }
              var buffer = HEAPU8.slice(addr, addr + len);
              FS.msync(stream, buffer, offset, len, flags);
            },
            getStreamFromFD(fd) {
              var stream = FS.getStreamChecked(fd);
              return stream;
            },
            varargs: void 0,
            getStr(ptr) {
              var ret = UTF8ToString(ptr);
              return ret;
            }
          };
          var INT53_MAX = 9007199254740992;
          var INT53_MIN = -9007199254740992;
          var bigintToI53Checked = (num) => num < INT53_MIN || num > INT53_MAX ? NaN : Number(num);
          function ___syscall_chmod(path, mode) {
            path >>>= 0;
            try {
              path = SYSCALLS.getStr(path);
              FS.chmod(path, mode);
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_faccessat(dirfd, path, amode, flags) {
            path >>>= 0;
            try {
              path = SYSCALLS.getStr(path);
              assert(flags === 0 || flags == 512);
              path = SYSCALLS.calculateAt(dirfd, path);
              if (amode & ~7) {
                return -28;
              }
              var lookup = FS.lookupPath(path, {
                follow: true
              });
              var node = lookup.node;
              if (!node) {
                return -44;
              }
              var perms = "";
              if (amode & 4) perms += "r";
              if (amode & 2) perms += "w";
              if (amode & 1) perms += "x";
              if (perms && FS.nodePermissions(node, perms)) {
                return -2;
              }
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_fchmod(fd, mode) {
            try {
              FS.fchmod(fd, mode);
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_fchown32(fd, owner, group) {
            try {
              FS.fchown(fd, owner, group);
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          var syscallGetVarargI = () => {
            assert(SYSCALLS.varargs != void 0);
            var ret = HEAP32[+SYSCALLS.varargs >>> 2 >>> 0];
            SYSCALLS.varargs += 4;
            return ret;
          };
          var syscallGetVarargP = syscallGetVarargI;
          function ___syscall_fcntl64(fd, cmd, varargs) {
            varargs >>>= 0;
            SYSCALLS.varargs = varargs;
            try {
              var stream = SYSCALLS.getStreamFromFD(fd);
              switch (cmd) {
                case 0: {
                  var arg = syscallGetVarargI();
                  if (arg < 0) {
                    return -28;
                  }
                  while (FS.streams[arg]) {
                    arg++;
                  }
                  var newStream;
                  newStream = FS.dupStream(stream, arg);
                  return newStream.fd;
                }
                case 1:
                case 2:
                  return 0;
                // FD_CLOEXEC makes no sense for a single process.
                case 3:
                  return stream.flags;
                case 4: {
                  var arg = syscallGetVarargI();
                  stream.flags |= arg;
                  return 0;
                }
                case 12: {
                  var arg = syscallGetVarargP();
                  var offset = 0;
                  HEAP16[arg + offset >>> 1 >>> 0] = 2;
                  return 0;
                }
                case 13:
                case 14:
                  return 0;
              }
              return -28;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_fstat64(fd, buf) {
            buf >>>= 0;
            try {
              return SYSCALLS.writeStat(buf, FS.fstat(fd));
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_ftruncate64(fd, length) {
            length = bigintToI53Checked(length);
            try {
              if (isNaN(length)) return 61;
              FS.ftruncate(fd, length);
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          var stringToUTF8 = (str, outPtr, maxBytesToWrite) => {
            assert(typeof maxBytesToWrite == "number", "stringToUTF8(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!");
            return stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite);
          };
          function ___syscall_getcwd(buf, size) {
            buf >>>= 0;
            size >>>= 0;
            try {
              if (size === 0) return -28;
              var cwd = FS.cwd();
              var cwdLengthInBytes = lengthBytesUTF8(cwd) + 1;
              if (size < cwdLengthInBytes) return -68;
              stringToUTF8(cwd, buf, size);
              return cwdLengthInBytes;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_ioctl(fd, op, varargs) {
            varargs >>>= 0;
            SYSCALLS.varargs = varargs;
            try {
              var stream = SYSCALLS.getStreamFromFD(fd);
              switch (op) {
                case 21509: {
                  if (!stream.tty) return -59;
                  return 0;
                }
                case 21505: {
                  if (!stream.tty) return -59;
                  if (stream.tty.ops.ioctl_tcgets) {
                    var termios = stream.tty.ops.ioctl_tcgets(stream);
                    var argp = syscallGetVarargP();
                    HEAP32[argp >>> 2 >>> 0] = termios.c_iflag || 0;
                    HEAP32[argp + 4 >>> 2 >>> 0] = termios.c_oflag || 0;
                    HEAP32[argp + 8 >>> 2 >>> 0] = termios.c_cflag || 0;
                    HEAP32[argp + 12 >>> 2 >>> 0] = termios.c_lflag || 0;
                    for (var i = 0; i < 32; i++) {
                      HEAP8[argp + i + 17 >>> 0] = termios.c_cc[i] || 0;
                    }
                    return 0;
                  }
                  return 0;
                }
                case 21510:
                case 21511:
                case 21512: {
                  if (!stream.tty) return -59;
                  return 0;
                }
                case 21506:
                case 21507:
                case 21508: {
                  if (!stream.tty) return -59;
                  if (stream.tty.ops.ioctl_tcsets) {
                    var argp = syscallGetVarargP();
                    var c_iflag = HEAP32[argp >>> 2 >>> 0];
                    var c_oflag = HEAP32[argp + 4 >>> 2 >>> 0];
                    var c_cflag = HEAP32[argp + 8 >>> 2 >>> 0];
                    var c_lflag = HEAP32[argp + 12 >>> 2 >>> 0];
                    var c_cc = [];
                    for (var i = 0; i < 32; i++) {
                      c_cc.push(HEAP8[argp + i + 17 >>> 0]);
                    }
                    return stream.tty.ops.ioctl_tcsets(stream.tty, op, {
                      c_iflag,
                      c_oflag,
                      c_cflag,
                      c_lflag,
                      c_cc
                    });
                  }
                  return 0;
                }
                case 21519: {
                  if (!stream.tty) return -59;
                  var argp = syscallGetVarargP();
                  HEAP32[argp >>> 2 >>> 0] = 0;
                  return 0;
                }
                case 21520: {
                  if (!stream.tty) return -59;
                  return -28;
                }
                case 21531: {
                  var argp = syscallGetVarargP();
                  return FS.ioctl(stream, op, argp);
                }
                case 21523: {
                  if (!stream.tty) return -59;
                  if (stream.tty.ops.ioctl_tiocgwinsz) {
                    var winsize = stream.tty.ops.ioctl_tiocgwinsz(stream.tty);
                    var argp = syscallGetVarargP();
                    HEAP16[argp >>> 1 >>> 0] = winsize[0];
                    HEAP16[argp + 2 >>> 1 >>> 0] = winsize[1];
                  }
                  return 0;
                }
                case 21524: {
                  if (!stream.tty) return -59;
                  return 0;
                }
                case 21515: {
                  if (!stream.tty) return -59;
                  return 0;
                }
                default:
                  return -28;
              }
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_lstat64(path, buf) {
            path >>>= 0;
            buf >>>= 0;
            try {
              path = SYSCALLS.getStr(path);
              return SYSCALLS.writeStat(buf, FS.lstat(path));
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_mkdirat(dirfd, path, mode) {
            path >>>= 0;
            try {
              path = SYSCALLS.getStr(path);
              path = SYSCALLS.calculateAt(dirfd, path);
              FS.mkdir(path, mode, 0);
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_newfstatat(dirfd, path, buf, flags) {
            path >>>= 0;
            buf >>>= 0;
            try {
              path = SYSCALLS.getStr(path);
              var nofollow = flags & 256;
              var allowEmpty = flags & 4096;
              flags = flags & ~6400;
              assert(!flags, `unknown flags in __syscall_newfstatat: ${flags}`);
              path = SYSCALLS.calculateAt(dirfd, path, allowEmpty);
              return SYSCALLS.writeStat(buf, nofollow ? FS.lstat(path) : FS.stat(path));
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_openat(dirfd, path, flags, varargs) {
            path >>>= 0;
            varargs >>>= 0;
            SYSCALLS.varargs = varargs;
            try {
              path = SYSCALLS.getStr(path);
              path = SYSCALLS.calculateAt(dirfd, path);
              var mode = varargs ? syscallGetVarargI() : 0;
              return FS.open(path, flags, mode).fd;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_readlinkat(dirfd, path, buf, bufsize) {
            path >>>= 0;
            buf >>>= 0;
            bufsize >>>= 0;
            try {
              path = SYSCALLS.getStr(path);
              path = SYSCALLS.calculateAt(dirfd, path);
              if (bufsize <= 0) return -28;
              var ret = FS.readlink(path);
              var len = Math.min(bufsize, lengthBytesUTF8(ret));
              var endChar = HEAP8[buf + len >>> 0];
              stringToUTF8(ret, buf, bufsize + 1);
              HEAP8[buf + len >>> 0] = endChar;
              return len;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_rmdir(path) {
            path >>>= 0;
            try {
              path = SYSCALLS.getStr(path);
              FS.rmdir(path);
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_stat64(path, buf) {
            path >>>= 0;
            buf >>>= 0;
            try {
              path = SYSCALLS.getStr(path);
              return SYSCALLS.writeStat(buf, FS.stat(path));
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function ___syscall_unlinkat(dirfd, path, flags) {
            path >>>= 0;
            try {
              path = SYSCALLS.getStr(path);
              path = SYSCALLS.calculateAt(dirfd, path);
              if (flags === 0) {
                FS.unlink(path);
              } else if (flags === 512) {
                FS.rmdir(path);
              } else {
                abort("Invalid flags passed to unlinkat");
              }
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          var readI53FromI64 = (ptr) => HEAPU32[ptr >>> 2 >>> 0] + HEAP32[ptr + 4 >>> 2 >>> 0] * 4294967296;
          function ___syscall_utimensat(dirfd, path, times, flags) {
            path >>>= 0;
            times >>>= 0;
            try {
              path = SYSCALLS.getStr(path);
              assert(flags === 0);
              path = SYSCALLS.calculateAt(dirfd, path, true);
              var now = Date.now(), atime, mtime;
              if (!times) {
                atime = now;
                mtime = now;
              } else {
                var seconds = readI53FromI64(times);
                var nanoseconds = HEAP32[times + 8 >>> 2 >>> 0];
                if (nanoseconds == 1073741823) {
                  atime = now;
                } else if (nanoseconds == 1073741822) {
                  atime = null;
                } else {
                  atime = seconds * 1e3 + nanoseconds / (1e3 * 1e3);
                }
                times += 16;
                seconds = readI53FromI64(times);
                nanoseconds = HEAP32[times + 8 >>> 2 >>> 0];
                if (nanoseconds == 1073741823) {
                  mtime = now;
                } else if (nanoseconds == 1073741822) {
                  mtime = null;
                } else {
                  mtime = seconds * 1e3 + nanoseconds / (1e3 * 1e3);
                }
              }
              if ((mtime ?? atime) !== null) {
                FS.utime(path, atime, mtime);
              }
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
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
            len >>>= 0;
            offset = bigintToI53Checked(offset);
            allocated >>>= 0;
            addr >>>= 0;
            try {
              if (isNaN(offset)) return 61;
              var stream = SYSCALLS.getStreamFromFD(fd);
              var res = FS.mmap(stream, len, offset, prot, flags);
              var ptr = res.ptr;
              HEAP32[allocated >>> 2 >>> 0] = res.allocated;
              HEAPU32[addr >>> 2 >>> 0] = ptr;
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
          }
          function __munmap_js(addr, len, prot, flags, fd, offset) {
            addr >>>= 0;
            len >>>= 0;
            offset = bigintToI53Checked(offset);
            try {
              var stream = SYSCALLS.getStreamFromFD(fd);
              if (prot & 2) {
                SYSCALLS.doMsync(addr, stream, len, flags, offset);
              }
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return -e.errno;
            }
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
            var _a2;
            EXITSTATUS = code;
            if (!keepRuntimeAlive()) {
              (_a2 = Module["onExit"]) == null ? void 0 : _a2.call(Module, code);
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
          function _fd_close(fd) {
            try {
              var stream = SYSCALLS.getStreamFromFD(fd);
              FS.close(stream);
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return e.errno;
            }
          }
          function _fd_fdstat_get(fd, pbuf) {
            pbuf >>>= 0;
            try {
              var rightsBase = 0;
              var rightsInheriting = 0;
              var flags = 0;
              {
                var stream = SYSCALLS.getStreamFromFD(fd);
                var type = stream.tty ? 2 : FS.isDir(stream.mode) ? 3 : FS.isLink(stream.mode) ? 7 : 4;
              }
              HEAP8[pbuf >>> 0] = type;
              HEAP16[pbuf + 2 >>> 1 >>> 0] = flags;
              HEAP64[pbuf + 8 >>> 3] = BigInt(rightsBase);
              HEAP64[pbuf + 16 >>> 3] = BigInt(rightsInheriting);
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return e.errno;
            }
          }
          var doReadv = (stream, iov, iovcnt, offset) => {
            var ret = 0;
            for (var i = 0; i < iovcnt; i++) {
              var ptr = HEAPU32[iov >>> 2 >>> 0];
              var len = HEAPU32[iov + 4 >>> 2 >>> 0];
              iov += 8;
              var curr = FS.read(stream, HEAP8, ptr, len, offset);
              if (curr < 0) return -1;
              ret += curr;
              if (curr < len) break;
            }
            return ret;
          };
          function _fd_read(fd, iov, iovcnt, pnum) {
            iov >>>= 0;
            iovcnt >>>= 0;
            pnum >>>= 0;
            try {
              var stream = SYSCALLS.getStreamFromFD(fd);
              var num = doReadv(stream, iov, iovcnt);
              HEAPU32[pnum >>> 2 >>> 0] = num;
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return e.errno;
            }
          }
          function _fd_seek(fd, offset, whence, newOffset) {
            offset = bigintToI53Checked(offset);
            newOffset >>>= 0;
            try {
              if (isNaN(offset)) return 61;
              var stream = SYSCALLS.getStreamFromFD(fd);
              FS.llseek(stream, offset, whence);
              HEAP64[newOffset >>> 3] = BigInt(stream.position);
              if (stream.getdents && offset === 0 && whence === 0) stream.getdents = null;
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return e.errno;
            }
          }
          function _fd_sync(fd) {
            var _a2;
            try {
              var stream = SYSCALLS.getStreamFromFD(fd);
              if ((_a2 = stream.stream_ops) == null ? void 0 : _a2.fsync) {
                return stream.stream_ops.fsync(stream);
              }
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return e.errno;
            }
          }
          var doWritev = (stream, iov, iovcnt, offset) => {
            var ret = 0;
            for (var i = 0; i < iovcnt; i++) {
              var ptr = HEAPU32[iov >>> 2 >>> 0];
              var len = HEAPU32[iov + 4 >>> 2 >>> 0];
              iov += 8;
              var curr = FS.write(stream, HEAP8, ptr, len, offset);
              if (curr < 0) return -1;
              ret += curr;
              if (curr < len) {
                break;
              }
            }
            return ret;
          };
          function _fd_write(fd, iov, iovcnt, pnum) {
            iov >>>= 0;
            iovcnt >>>= 0;
            pnum >>>= 0;
            try {
              var stream = SYSCALLS.getStreamFromFD(fd);
              var num = doWritev(stream, iov, iovcnt);
              HEAPU32[pnum >>> 2 >>> 0] = num;
              return 0;
            } catch (e) {
              if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
              return e.errno;
            }
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
          FS.createPreloadedFile = FS_createPreloadedFile;
          FS.staticInit();
          {
            if (Module["noExitRuntime"]) noExitRuntime = Module["noExitRuntime"];
            if (Module["preloadPlugins"]) preloadPlugins = Module["preloadPlugins"];
            if (Module["print"]) out = Module["print"];
            if (Module["printErr"]) err = Module["printErr"];
            if (Module["wasmBinary"]) wasmBinary = Module["wasmBinary"];
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
          Module["FS"] = FS;
          var missingLibrarySymbols = ["writeI53ToI64", "writeI53ToI64Clamped", "writeI53ToI64Signaling", "writeI53ToU64Clamped", "writeI53ToU64Signaling", "readI53FromU64", "convertI32PairToI53", "convertI32PairToI53Checked", "convertU32PairToI53", "getTempRet0", "setTempRet0", "inetPton4", "inetNtop4", "inetPton6", "inetNtop6", "readSockaddr", "writeSockaddr", "emscriptenLog", "runMainThreadEmAsm", "jstoi_q", "listenOnce", "autoResumeAudioContext", "getDynCaller", "dynCall", "runtimeKeepalivePush", "runtimeKeepalivePop", "callUserCallback", "maybeExit", "asmjsMangle", "HandleAllocator", "getNativeTypeSize", "addOnInit", "addOnPostCtor", "addOnPreMain", "addOnExit", "STACK_SIZE", "STACK_ALIGN", "POINTER_SIZE", "ASSERTIONS", "cwrap", "removeFunction", "reallyNegative", "unSign", "strLen", "reSign", "formatString", "intArrayToString", "AsciiToString", "stringToAscii", "UTF16ToString", "stringToUTF16", "lengthBytesUTF16", "UTF32ToString", "stringToUTF32", "lengthBytesUTF32", "stringToNewUTF8", "registerKeyEventCallback", "maybeCStringToJsString", "findEventTarget", "getBoundingClientRect", "fillMouseEventData", "registerMouseEventCallback", "registerWheelEventCallback", "registerUiEventCallback", "registerFocusEventCallback", "fillDeviceOrientationEventData", "registerDeviceOrientationEventCallback", "fillDeviceMotionEventData", "registerDeviceMotionEventCallback", "screenOrientation", "fillOrientationChangeEventData", "registerOrientationChangeEventCallback", "fillFullscreenChangeEventData", "registerFullscreenChangeEventCallback", "JSEvents_requestFullscreen", "JSEvents_resizeCanvasForFullscreen", "registerRestoreOldStyle", "hideEverythingExceptGivenElement", "restoreHiddenElements", "setLetterbox", "softFullscreenResizeWebGLRenderTarget", "doRequestFullscreen", "fillPointerlockChangeEventData", "registerPointerlockChangeEventCallback", "registerPointerlockErrorEventCallback", "requestPointerLock", "fillVisibilityChangeEventData", "registerVisibilityChangeEventCallback", "registerTouchEventCallback", "fillGamepadEventData", "registerGamepadEventCallback", "registerBeforeUnloadEventCallback", "fillBatteryEventData", "battery", "registerBatteryEventCallback", "setCanvasElementSize", "getCanvasElementSize", "getCallstack", "convertPCtoSourceLocation", "wasiRightsToMuslOFlags", "wasiOFlagsToMuslOFlags", "safeSetTimeout", "setImmediateWrapped", "safeRequestAnimationFrame", "clearImmediateWrapped", "registerPostMainLoop", "registerPreMainLoop", "getPromise", "makePromise", "idsToPromises", "makePromiseCallback", "ExceptionInfo", "findMatchingCatch", "Browser_asyncPrepareDataCounter", "arraySum", "addDays", "getSocketFromFD", "getSocketAddress", "FS_mkdirTree", "_setNetworkCallback", "heapObjectForWebGLType", "toTypedArrayIndex", "webgl_enable_ANGLE_instanced_arrays", "webgl_enable_OES_vertex_array_object", "webgl_enable_WEBGL_draw_buffers", "webgl_enable_WEBGL_multi_draw", "webgl_enable_EXT_polygon_offset_clamp", "webgl_enable_EXT_clip_control", "webgl_enable_WEBGL_polygon_mode", "emscriptenWebGLGet", "computeUnpackAlignedImageSize", "colorChannelsInGlTextureFormat", "emscriptenWebGLGetTexPixelData", "emscriptenWebGLGetUniform", "webglGetUniformLocation", "webglPrepareUniformLocationsBeforeFirstUse", "webglGetLeftBracePos", "emscriptenWebGLGetVertexAttrib", "__glGetActiveAttribOrUniform", "writeGLArray", "registerWebGlEventCallback", "runAndAbortIfError", "ALLOC_NORMAL", "ALLOC_STACK", "allocate", "writeStringToMemory", "writeAsciiToMemory", "demangle", "stackTrace"];
          missingLibrarySymbols.forEach(missingLibrarySymbol);
          var unexportedSymbols = ["run", "addRunDependency", "removeRunDependency", "out", "err", "abort", "wasmMemory", "wasmExports", "HEAPF32", "HEAPF64", "HEAP8", "HEAP16", "HEAPU16", "HEAP32", "HEAPU32", "HEAP64", "HEAPU64", "writeStackCookie", "checkStackCookie", "readI53FromI64", "INT53_MAX", "INT53_MIN", "bigintToI53Checked", "stackSave", "stackRestore", "stackAlloc", "ptrToString", "zeroMemory", "exitJS", "getHeapMax", "growMemory", "ENV", "ERRNO_CODES", "strError", "DNS", "Protocols", "Sockets", "timers", "warnOnce", "readEmAsmArgsArray", "readEmAsmArgs", "runEmAsmFunction", "getExecutableName", "handleException", "keepRuntimeAlive", "asyncLoad", "alignMemory", "mmapAlloc", "wasmTable", "noExitRuntime", "addOnPreRun", "addOnPostRun", "getCFunc", "uleb128Encode", "sigToWasmTypes", "generateFuncType", "convertJsFunctionToWasm", "freeTableIndexes", "functionsInTableMap", "getEmptyTableSlot", "updateTableMap", "getFunctionAddress", "setValue", "getValue", "PATH", "PATH_FS", "UTF8Decoder", "UTF8ArrayToString", "UTF8ToString", "stringToUTF8Array", "stringToUTF8", "lengthBytesUTF8", "intArrayFromString", "UTF16Decoder", "stringToUTF8OnStack", "writeArrayToMemory", "JSEvents", "specialHTMLTargets", "findCanvasEventTarget", "currentFullscreenStrategy", "restoreOldWindowedStyle", "jsStackTrace", "UNWIND_CACHE", "ExitStatus", "getEnvStrings", "checkWasiClock", "doReadv", "doWritev", "initRandomFill", "randomFill", "emSetImmediate", "emClearImmediate_deps", "emClearImmediate", "promiseMap", "uncaughtExceptionCount", "exceptionLast", "exceptionCaught", "Browser", "getPreloadedImageData__data", "wget", "MONTH_DAYS_REGULAR", "MONTH_DAYS_LEAP", "MONTH_DAYS_REGULAR_CUMULATIVE", "MONTH_DAYS_LEAP_CUMULATIVE", "isLeapYear", "ydayFromDate", "SYSCALLS", "preloadPlugins", "FS_createPreloadedFile", "FS_modeStringToFlags", "FS_getMode", "FS_stdin_getChar_buffer", "FS_stdin_getChar", "FS_unlink", "FS_createPath", "FS_createDevice", "FS_readFile", "FS_root", "FS_mounts", "FS_devices", "FS_streams", "FS_nextInode", "FS_nameTable", "FS_currentPath", "FS_initialized", "FS_ignorePermissions", "FS_filesystems", "FS_syncFSRequests", "FS_readFiles", "FS_lookupPath", "FS_getPath", "FS_hashName", "FS_hashAddNode", "FS_hashRemoveNode", "FS_lookupNode", "FS_createNode", "FS_destroyNode", "FS_isRoot", "FS_isMountpoint", "FS_isFile", "FS_isDir", "FS_isLink", "FS_isChrdev", "FS_isBlkdev", "FS_isFIFO", "FS_isSocket", "FS_flagsToPermissionString", "FS_nodePermissions", "FS_mayLookup", "FS_mayCreate", "FS_mayDelete", "FS_mayOpen", "FS_checkOpExists", "FS_nextfd", "FS_getStreamChecked", "FS_getStream", "FS_createStream", "FS_closeStream", "FS_dupStream", "FS_doSetAttr", "FS_chrdev_stream_ops", "FS_major", "FS_minor", "FS_makedev", "FS_registerDevice", "FS_getDevice", "FS_getMounts", "FS_syncfs", "FS_mount", "FS_unmount", "FS_lookup", "FS_mknod", "FS_statfs", "FS_statfsStream", "FS_statfsNode", "FS_create", "FS_mkdir", "FS_mkdev", "FS_symlink", "FS_rename", "FS_rmdir", "FS_readdir", "FS_readlink", "FS_stat", "FS_fstat", "FS_lstat", "FS_doChmod", "FS_chmod", "FS_lchmod", "FS_fchmod", "FS_doChown", "FS_chown", "FS_lchown", "FS_fchown", "FS_doTruncate", "FS_truncate", "FS_ftruncate", "FS_utime", "FS_open", "FS_close", "FS_isClosed", "FS_llseek", "FS_read", "FS_write", "FS_mmap", "FS_msync", "FS_ioctl", "FS_writeFile", "FS_cwd", "FS_chdir", "FS_createDefaultDirectories", "FS_createDefaultDevices", "FS_createSpecialDirectories", "FS_createStandardStreams", "FS_staticInit", "FS_init", "FS_quit", "FS_findObject", "FS_analyzePath", "FS_createFile", "FS_createDataFile", "FS_forceLoadFile", "FS_createLazyFile", "FS_absolutePath", "FS_createFolder", "FS_createLink", "FS_joinPath", "FS_mmapAlloc", "FS_standardizePath", "MEMFS", "TTY", "PIPEFS", "SOCKFS", "tempFixedLengthArray", "miniTempWebGLFloatBuffers", "miniTempWebGLIntBuffers", "GL", "AL", "GLUT", "EGL", "GLEW", "IDBStore", "SDL", "SDL_gfx", "allocateUTF8", "allocateUTF8OnStack", "print", "printErr", "jstoi_s", "WORKERFS"];
          unexportedSymbols.forEach(unexportedRuntimeSymbol);
          function checkIncomingModuleAPI() {
            ignoredModuleProp("fetchSettings");
          }
          var ASM_CONSTS = {
            4643772: () => typeof wasmOffsetConverter !== "undefined"
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
          var wasmExports = createWasm();
          var _strerror = createExportWrapper("strerror", 1);
          Module["_trace_processor_rpc_init"] = createExportWrapper("trace_processor_rpc_init", 2);
          Module["_trace_processor_on_rpc_request"] = createExportWrapper("trace_processor_on_rpc_request", 1);
          var _main = Module["_main"] = createExportWrapper("__main_argc_argv", 2);
          Module["_synq_extent_on_shift"] = createExportWrapper("synq_extent_on_shift", 3);
          Module["_synq_extent_on_reduce"] = createExportWrapper("synq_extent_on_reduce", 2);
          Module["_SynqPerfettoParseInit"] = createExportWrapper("SynqPerfettoParseInit", 2);
          Module["_SynqPerfettoParseAlloc"] = createExportWrapper("SynqPerfettoParseAlloc", 2);
          Module["_SynqPerfettoParseFinalize"] = createExportWrapper("SynqPerfettoParseFinalize", 1);
          Module["_SynqPerfettoParseFree"] = createExportWrapper("SynqPerfettoParseFree", 2);
          Module["_SynqPerfettoParse"] = createExportWrapper("SynqPerfettoParse", 3);
          Module["_SynqPerfettoParseFallback"] = createExportWrapper("SynqPerfettoParseFallback", 1);
          Module["_SynqPerfettoParseExpectedTokens"] = createExportWrapper("SynqPerfettoParseExpectedTokens", 3);
          Module["_SynqPerfettoParseCompletionContext"] = createExportWrapper("SynqPerfettoParseCompletionContext", 1);
          Module["_SynqPerfettoGetToken"] = createExportWrapper("SynqPerfettoGetToken", 3);
          var _fflush = createExportWrapper("fflush", 1);
          var _emscripten_stack_get_end = wasmExports["emscripten_stack_get_end"];
          wasmExports["emscripten_stack_get_base"];
          var _emscripten_builtin_memalign = createExportWrapper("emscripten_builtin_memalign", 2);
          var _emscripten_stack_init = wasmExports["emscripten_stack_init"];
          wasmExports["emscripten_stack_get_free"];
          var __emscripten_stack_restore = wasmExports["_emscripten_stack_restore"];
          var __emscripten_stack_alloc = wasmExports["_emscripten_stack_alloc"];
          var _emscripten_stack_get_current = wasmExports["emscripten_stack_get_current"];
          function applySignatureConversions(wasmExports2) {
            wasmExports2 = Object.assign({}, wasmExports2);
            var makeWrapper_p_ = (f) => (a0) => f(a0) >>> 0;
            var makeWrapper_p = (f) => () => f() >>> 0;
            var makeWrapper_ppp = (f) => (a0, a1) => f(a0, a1) >>> 0;
            var makeWrapper_pp = (f) => (a0) => f(a0) >>> 0;
            wasmExports2["strerror"] = makeWrapper_p_(wasmExports2["strerror"]);
            wasmExports2["emscripten_stack_get_end"] = makeWrapper_p(wasmExports2["emscripten_stack_get_end"]);
            wasmExports2["emscripten_stack_get_base"] = makeWrapper_p(wasmExports2["emscripten_stack_get_base"]);
            wasmExports2["emscripten_builtin_memalign"] = makeWrapper_ppp(wasmExports2["emscripten_builtin_memalign"]);
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
              var _a2;
              assert(!calledRun);
              calledRun = true;
              Module["calledRun"] = true;
              if (ABORT) return;
              initRuntime();
              preMain();
              readyPromiseResolve(Module);
              (_a2 = Module["onRuntimeInitialized"]) == null ? void 0 : _a2.call(Module);
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
              _fflush(0);
              ["stdout", "stderr"].forEach((name) => {
                var _a2;
                var info = FS.analyzePath("/dev/" + name);
                if (!info) return;
                var stream = info.object;
                var rdev = stream.rdev;
                var tty = TTY.ttys[rdev];
                if ((_a2 = tty == null ? void 0 : tty.output) == null ? void 0 : _a2.length) {
                  has = true;
                }
              });
            } catch (e) {
            }
            out = oldOut;
            err = oldErr;
            if (has) {
              warnOnce("stdio streams had content in them that was not flushed. you should set EXIT_RUNTIME to 1 (see the Emscripten FAQ), or make sure to emit a newline when you printf etc.");
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
          moduleRtn = Module;
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
  const REQ_BUF_SIZE = 32 * 1024 * 1024;
  class WasmBridge {
    constructor() {
      __publicField(this, "aborted");
      __publicField(this, "connection");
      __publicField(this, "reqBufferAddr", 0);
      __publicField(this, "lastStderr", []);
      __publicField(this, "messagePort");
      __publicField(this, "useMemory64");
      this.aborted = false;
      const deferredRuntimeInitialized = defer();
      this.useMemory64 = hasMemory64Support();
      const initModule = this.useMemory64 ? TraceProcessor64 : TraceProcessor32;
      this.connection = initModule({
        locateFile: (s) => s,
        print: (line) => console.log(line),
        printErr: (line) => this.appendAndLogErr(line),
        onRuntimeInitialized: () => deferredRuntimeInitialized.resolve()
      });
      deferredRuntimeInitialized.then(() => {
        const fn = this.connection.addFunction(this.onReply.bind(this), "vpi");
        this.reqBufferAddr = this.wasmPtrCast(
          this.connection.ccall(
            "trace_processor_rpc_init",
            /* return=*/
            "pointer",
            /* args=*/
            ["pointer", "number"],
            [fn, REQ_BUF_SIZE]
          )
        );
      });
    }
    initialize(port) {
      assertTrue(this.messagePort === void 0);
      this.messagePort = port;
      this.messagePort.onmessage = this.onMessage.bind(this);
    }
    onMessage(msg) {
      if (this.aborted) {
        throw new Error("Wasm module crashed");
      }
      assertTrue(msg.data instanceof Uint8Array);
      const data = msg.data;
      let wrSize = 0;
      while (wrSize < data.length) {
        const sliceLen = Math.min(data.length - wrSize, REQ_BUF_SIZE);
        const dataSlice = data.subarray(wrSize, wrSize + sliceLen);
        this.connection.HEAPU8.set(dataSlice, this.reqBufferAddr);
        wrSize += sliceLen;
        try {
          this.connection.ccall(
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
      const data = this.connection.HEAPU8.slice(heapPtr, heapPtr + size);
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
  function hasMemory64Support() {
    const memory64DetectProgram = new Uint8Array([
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
      new WebAssembly.Module(memory64DetectProgram);
      return true;
    } catch (e) {
      return false;
    }
  }
  const selfWorker = self;
  const wasmBridge = new WasmBridge();
  selfWorker.onmessage = (msg) => {
    const port = msg.data;
    wasmBridge.initialize(port);
  };
})();
//# sourceMappingURL=engine_bundle.js.map

;(self.__SOURCEMAPS=self.__SOURCEMAPS||{})['engine_bundle.js']={"version":3,"sources":["../../src/base/deferred.ts","../../src/base/assert.ts","ui/tsc/gen/trace_processor_memory64.js","ui/tsc/gen/trace_processor.js","../../src/engine/wasm_bridge.ts","../../src/engine/index.ts"],"mappings":"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AAEM;AACA;AAAsC;AAC5C;AAEM;AACA;AACE;AAA0B;AAE5B;AACA;AAAsC;AAC5C;AAEM;AAAiD;AACvD;AAEM;AACA;AACA;AAAO;AACb;AAEM;AACE;AAA0B;AAE5B;AAAY;AAClB;AAEE;AAAY;AAER;AACA;AACA;AACA;AACA;AAEE;AAA+D;AAE/D;AAAyE;AAE3E;AAAO;AACb;AAGM;AAKA;AACE;AAAS;AAEX;AACA;AACA;AACA;AAEE;AACE;AACA;AACA;AACA;AAAO;AAGP;AACA;AACA;AAAO;AAGP;AACA;AAAO;AACjB;AAGM;AACA;AAEE;AAAoE;AAEpE;AACE;AAA+C;AACzD;AAEM;AACA;AAAO;AACb;AAEM;AACA;AACE;AAAmB;AAEnB;AACE;AAAwB;AAClC;AAEM;AACE;AAA0B;AAE5B;AAAO;AACb;AAEM;AACE;AAA0B;AAE5B;AACA;AACA;AAEA;AAGE;AACA;AAAe;AAEf;AACA;AACA;AACE;AAA0B;AAE5B;AAEE;AACE;AACE;AAAwD;AAExD;AAA2E;AACzF;AAEU;AAAuB;AACjC;AAEM;AAAO;AACL;AACA;AAER;AAAA;AAEM;AAEA;AAAO;AACb;AACA;AAGA;AACE;AACA;AACA;AAAiC;AAGnC;AAEA;AAEA;AAEE;AACA;AACA;AACE;AACA;AACE;AACA;AAAU;AAChB;AAEE;AAAO;AAGT;AAGE;AACA;AAEA;AACE;AACE;AACA;AACE;AAAoE;AAEtE;AACA;AAAuB;AAEzB;AACE;AACA;AAAuB;AAEvB;AAAA;AAEF;AAAgB;AAElB;AACA;AACE;AAAwC;AAExC;AAAe;AACnB;AAGA;AACE;AAAgB;AACT;AACC;AACU;AACC;AACA;AACC;AAEpB;AACA;AACE;AAAgD;AAElD;AAAO;AAGT;AACE;AACA;AACA;AACA;AAAO;AAGT;AAAe;AACH;AACC;AACH;AAEN;AACA;AACA;AACA;AACA;AAEE;AACA;AACA;AACE;AAQA;AACA;AAA4B;AAE9B;AAAO;AAET;AACE;AACA;AAA6B;AAG/B;AACE;AAAgH;AAElH;AACE;AAAoG;AAEtG;AACE;AACE;AAEA;AAAmH;AACpH;AAEH;AAAO;AACX;AAEI;AACA;AACA;AACA;AACA;AACA;AACA;AACE;AACA;AAAgB;AAEhB;AACA;AAAgB;AAElB;AACE;AAAwB;AAE1B;AAAO;AACX;AACY;AAEN;AAAO;AACA;AACK;AACC;AACJ;AACF;AACA;AACC;AACK;AACe;AACA;AACA;AACjB;AACyB;AAE1C;AAAA;AAEM;AACE;AACE;AAAoB;AAC9B;AACA;AACA;AAEM;AAA0B;AAChC;AAEM;AAA0B;AAChC;AAEM;AAA0B;AAChC;AAEM;AAA0B;AAChC;AAEM;AAA0B;AAChC;AAEM;AACA;AACE;AAAgB;AAElB;AAAO;AACb;AAEM;AAA0B;AAChC;AAEE;AAAY;AAER;AACA;AACA;AACA;AACA;AAAa;AACnB;AAEM;AAA0B;AAChC;AAEM;AACA;AACE;AAAmB;AAEnB;AACE;AAAwB;AAClC;AAEM;AACE;AAA0B;AAE5B;AAAO;AACb;AACA;AAiBQ;AACN;AACA;AAA8D;AAGhE;AAEA;AAAkB;AACP;AACC;AACD;AACA;AACF;AACE;AACA;AACE;AACF;AACC;AACA;AACK;AACL;AACA;AACA;AACC;AACF;AACC;AACD;AACC;AACC;AACD;AACA;AACA;AACA;AACA;AACC;AACF;AACC;AACA;AACD;AACC;AACD;AACD;AACE;AACA;AACD;AACC;AACE;AACF;AACA;AACA;AACC;AACD;AACA;AACC;AACD;AACD;AACA;AACC;AACA;AACC;AACA;AACE;AACH;AACA;AACC;AACF;AACA;AACC;AACA;AACC;AACA;AACH;AACE;AACD;AACC;AACG;AACF;AACA;AACC;AACF;AACC;AACA;AACA;AACA;AACA;AACC;AACF;AACG;AACG;AACP;AACK;AACE;AACF;AACH;AACK;AACF;AACF;AACG;AACF;AACG;AACF;AACE;AACD;AACH;AACC;AACA;AACG;AACD;AACH;AACI;AACJ;AACO;AACA;AACF;AACJ;AACF;AACC;AACI;AACN;AACA;AACA;AACC;AACE;AACH;AACG;AACA;AACM;AACL;AACF;AAGd;AAAS;AACD;AACE;AACC;AAC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;AACA;AACA;AACA;AAGA;AACA;AACE;AACE;AACA;AAA0B;AAE5B;AAAgC;AAElC;AACA;AAGA;AACA;AAAuB;AAC3B;AAII;AACA;AACA;AACA;AAAS;AAEL;AACA;AAAkB;AACS;AAE3B;AAAgB;AAEZ;AACA;AACA;AAAU;AACA;AACD;AACO;AAEd;AAAU;AACe;AAEzB;AAAS;AAEX;AAEA;AAAO;AACnB;AAEY;AAA0F;AACtG;AAEQ;AAAO;AACf;AAC0B;AAC1B;AASI;AACE;AAAsC;AAEtC;AAAmC;AAErC;AACE;AAA8C;AAE9C;AAAoC;AAEtC;AACE;AAA6C;AAE7C;AAAqC;AAGvC;AACA;AACA;AACA;AACA;AACA;AAAkE;AACtE;AAEI;AACA;AACA;AACA;AACA;AACA;AAAiB;AACN;AACG;AAElB;AAAA;AAEI;AACA;AAEA;AACA;AACA;AACA;AAA6C;AACjD;AAEI;AAEA;AAEA;AACE;AACE;AAAe;AACvB;AACA;AACA;AAEI;AACA;AACE;AAAO;AAET;AAAW;AACf;AAGI;AACE;AAAiC;AACtB;AAEX;AAAc;AACJ;AACZ;AAAU;AACA;AACA;AACD;AACD;AACA;AACE;AACM;AACF;AACE;AAEhB;AACE;AAAiC;AACvB;AAEV;AACA;AACA;AACA;AACA;AAA6B;AAClB;AAEX;AACA;AACA;AACA;AACA;AAA6B;AAE7B;AAAc;AAEhB;AAAO;AACX;AAEI;AACA;AACA;AACE;AACA;AACA;AACA;AACE;AAAgB;AAEhB;AAAyB;AAE3B;AAAS;AAEX;AAAO;AACX;AAEI;AACA;AACA;AAA2B;AAC/B;AAEI;AACA;AACE;AACA;AAAyC;AAE3C;AACA;AACA;AACE;AACE;AACA;AACA;AAAO;AAGT;AACA;AACA;AACA;AACA;AAAmB;AACzB;AACA;;AAEI;AACA;AACA;AACA;AAGA;AAAuB;AAEnB;AAAkB;AAC1B;;AAGQ;AACE;AAAS;AACnB;AACA;AAEQ;AACA;AACE;AACA;AACE;AAAc;AAEd;AAA0B;AAE5B;AACE;AAAyB;AAE3B;AACA;AACA;AAAqB;AAEvB;AACE;AAA4B;AAE9B;AAAO;AACf;AAEQ;AACE;AACE;AAAyB;AAEzB;AAA0B;AACtC;AAEQ;AACE;AAAgD;AAElD;AAAO;AACf;AAEI;AAA+B;AACnC;AAEI;AACA;AACE;AAAkN;AAGlN;AACE;AACA;AAA6B;AAE7B;AAA0B;AAClC;AACA;AACA;AACuD;AAG9B;AACnB;AACA;AAAO;AAAA;AAAA;AAGL;AACE;AAAO;AAET;AACA;AACA;AAAwC;AAChD;AAEQ;AAAc;AACtB;AAGQ;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AAEA;AAEA;AACE;AACA;AAEA;AACA;AACA;AAEA;AACA;AACE;AAAyD;AAE3D;AACA;AACA;AACE;AAAW;AAAA;AAAwD;AAAE;AAEvE;AAAsD;AAExD;AACA;AACE;AACA;AAEA;AAEA;AACE;AAA6C;AAE/C;AACA;AAAgC;AAElC;AAEE;AAEA;AACA;AACA;AAAiF;AAEnF;AACA;AACA;AAAmB;AAC3B;AAEQ;AACE;AAAgB;AAElB;AAAY;AACpB;AAEQ;AACE;AAAgB;AAElB;AAAY;AACpB;AAEI;AACE;AACA;AACA;AAAiB;AACL;AACA;AAElB;AACM;AAAiB;AACL;AACV;AAER;AACI;AAIA;AACE;AAA2B;AAE3B;AACA;AAAsB;AAGxB;AAA8B;AACjB;AAEP;AAAqB;AAC/B;AACA;AAGI;AACA;AACA;AACE;AACA;AACE;AACA;AAAiB;AACzB;AAEI;AACE;AACA;AACA;AACA;AACA;AAEE;AACE;AAA0C;AACpD;AAEQ;AAEE;AAA8C;AACxD;AAEM;AAAO;AAGT;AACE;AACA;AAA2D;AAG7D;AACE;AACA;AACA;AACE;AAA0B;AAE5B;AACA;AAAO;AACL;AACW;AAEnB;AACI;AACA;AAAO;AACX;AAEI;AAAqE;AACzE;AAEI;AAA8D;AAClE;AAEI;AAA8D;AAClE;AAEI;AAA2D;AAC/D;AAEI;AAA0E;AAC9E;AAEI;AAAuE;AAC3E;AAGA;AAAe;AACK;AAEhB;AACE;AAAO;AAGT;AACA;AACE;AAAY;AAEZ;AACA;AAAgB;AAElB;AACE;AACE;AAA0B;AAE5B;AAAO;AAET;AAAmB;AACvB;AAEI;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AAAO;AACX;AAEI;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AAEA;AAAqC;AACzC;AAEI;AACE;AAA0B;AAE5B;AAEE;AAAO;AAET;AACA;AAA2C;AAC/C;AAEI;AACA;AAAO;AACX;AACW;AAEP;AACA;AAAO;AACX;AAGA;AAEA;AAEA;AAEA;AACE;AACA;AACE;AACA;AACA;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AACE;AACA;AACE;AACA;AACA;AACA;AAEE;AAAO;AAET;AAAiC;AACvB;AAEV;AACA;AACE;AAAO;AAET;AACA;AACA;AACA;AACA;AACE;AAAO;AAET;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AACE;AACE;AACA;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AACE;AACE;AACA;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AACE;AACA;AACA;AACA;AAAO;AAGT;AACE;AAEA;AACA;AACA;AAAO;AAGT;AACE;AACA;AACA;AACE;AACA;AAAW;AAGP;AACA;AACE;AAAO;AAET;AACE;AAAA;AAEF;AACA;AACA;AAAiB;AACzB;AAEU;AAEJ;AAAO;AAAA;AAIP;AAAc;AAIZ;AACA;AACA;AAAO;AACf;AAIQ;AACA;AAEA;AACA;AAAO;AACf;AAEU;AAMJ;AAAO;AAET;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AACE;AACA;AACE;AAA2C;AAE3C;AACA;AAAU;AACd;AAGA;AACE;AACA;AACE;AACA;AACA;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AACE;AACA;AAA6D;AAG/D;AACE;AACA;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AACE;AACA;AACA;AACE;AACA;AAAU;AAGN;AACA;AAAO;AACf;AAIQ;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACE;AAA8C;AAEhD;AAAO;AAET;AAAO;AACf;AAEU;AACA;AAGF;AACA;AAAO;AACf;AAEU;AACA;AAGF;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACE;AAAkC;AAEpC;AAAmD;AACjD;AACA;AACA;AACA;AACA;AACD;AAEH;AAAO;AACf;AAIQ;AACA;AACA;AACA;AAAO;AACf;AAIQ;AACA;AAAO;AACf;AAIQ;AACA;AAAgC;AACxC;AAMQ;AACA;AACE;AACA;AACA;AACA;AAAwC;AAE1C;AAAO;AACf;AAOQ;AACA;AAAO;AACf;AAIQ;AACA;AAAO;AACf;AAGM;AAAO;AACb;AAEI;AACA;AAAU;AACd;AAGA;AACE;AACA;AACA;AACE;AACA;AAA6C;AAE7C;AACA;AAAU;AACd;AAGA;AACE;AACA;AACE;AACA;AACA;AACA;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AACE;AACA;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AAAwE;AAExE;AACA;AAAU;AACd;AAGA;AACE;AACA;AACA;AACA;AACE;AACA;AACA;AACA;AAAkC;AAElC;AACA;AAAU;AACd;AAGA;AACE;AACA;AACA;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AAGA;AACA;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AACE;AACA;AACE;AACA;AACA;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AACE;AACA;AACA;AACE;AACA;AAA4C;AAE5C;AACA;AAAU;AACd;AAGA;AACE;AACA;AACE;AACA;AACA;AACE;AAAc;AAEd;AAAa;AAEb;AAAwC;AAE1C;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AAEA;AACE;AACA;AACA;AACE;AACA;AACA;AACA;AACA;AACE;AACA;AAAQ;AAER;AACA;AACA;AACE;AAAQ;AAER;AAAQ;AAER;AAAgD;AAElD;AACA;AACA;AACA;AACE;AAAQ;AAER;AAAQ;AAER;AAAgD;AACxD;AAII;AACE;AAA2B;AAE7B;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AAEA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AAAiC;AAGnC;AAEA;AAEA;AAEA;AACE;AACA;AACA;AAEA;AAAO;AAGT;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AAEA;AACA;AACA;AACA;AACA;AAAiC;AAGnC;AACE;AACA;AACA;AACA;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AACE;AACA;AACA;AACA;AACE;AACA;AACE;AAAiD;AACvD;AAEI;AACA;AAAU;AACd;AAGA;AACE;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AAAwB;AAE1B;AAAiB;AAGnB;AACE;AACA;AACA;AACA;AAEA;AACA;AACA;AACA;AACA;AAOA;AAMA;AACA;AACA;AAGE;AACA;AACA;AACA;AACA;AAAmC;AAErC;AACA;AACA;AACA;AACA;AACA;AACA;AAEE;AACA;AAAqC;AAErC;AACA;AAAqC;AACzC;AAGA;AAEA;AAIA;AAEA;AAEE;AACA;AACE;AAAO;AAET;AAEA;AACE;AAA0B;AAE1B;AAAyB;AAK3B;AACA;AACA;AAAO;AAGT;AAEA;AAEE;AAEA;AACA;AACA;AAGA;AACE;AACA;AAEA;AACA;AAGA;AACA;AACA;AAAmB;AAAA;AAC8G;AACjI;AAAkB;AAEpB;AAAO;AAGT;AACE;AACA;AACA;AAA+B;AAGjC;AACE;AACA;AACA;AACA;AAA4C;AAG9C;AACE;AACA;AAA4B;AAG9B;AACE;AACA;AACA;AAAiC;AAGnC;AAEA;AAEA;AAEE;AACE;AACA;AAAO;AAET;AAAiB;AAGnB;AACE;AACA;AACA;AAEE;AAEA;AACA;AAAO;AAEP;AAAyG;AAC7G;AAGA;AACE;AACA;AAGA;AAmBA;AACA;AACE;AACA;AAAO;AAKT;AACE;AAGA;AACA;AACA;AACA;AACE;AAAO;AACb;AAEE;AACA;AAAO;AAGgB;AACvB;AAEA;AAAO;AAGT;AAEA;AACE;AACW;AAAsB;AAIhC;AAGH;AAEA;AACE;AACE;AACA;AACE;AAAe;AAEjB;AAGA;AACA;AACA;AAAoB;AAEtB;AAAiB;AAGnB;AACE;AACA;AACA;AACA;AACE;AAAqB;AAErB;AACA;AACE;AAAW;AAEb;AAAuB;AAEzB;AACA;AACE;AAAE;AAEJ;AACE;AAAuE;AAEzE;AAAO;AAGT;AAEA;AAEA;AACE;AAGE;AACA;AAAU;AACA;AACG;AACH;AACD;AACC;AACA;AACc;AAGxB;AAIE;AAAsC;AAAsB;AAE9D;AACA;AACE;AAA6B;AAE/B;AAAwB;AAE1B;AAAqB;AAGvB;AACE;AACA;AACA;AACA;AACA;AACE;AACA;AACA;AACA;AAAQ;AAEV;AAAO;AAGT;AACE;AACA;AACA;AACA;AACA;AACA;AACE;AAAqC;AAEvC;AACA;AAAO;AAGT;AAEA;AAEA;;AACE;AACA;AACE;AACA;AAAQ;AAEV;AAAgC;AAGqC;AACrE;AACA;AAEA;AACE;AACA;AACA;AAAO;AAET;AAAiB;AAGnB;AAEA;AACE;AACE;AACA;AACA;AAAO;AAEP;AACA;AAAS;AACb;AAGA;AACE;AACA;AACE;AACA;AACA;AACA;AACE;AAGA;AAAqF;AAEvF;AACA;AACA;AACA;AACA;AAAO;AAEP;AACA;AAAS;AACb;AAG+B;AAC7B;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AAAgB;AAMlB;AAAO;AAGT;AACE;AACA;AACA;AACA;AACE;AACA;AACA;AACA;AAAO;AAEP;AACA;AAAS;AACb;AAGA;AACE;AACA;AACA;AACE;AACA;AACA;AACA;AACA;AAEA;AAAO;AAEP;AACA;AAAS;AACb;AAGA;;AACE;AACE;AACA;AACE;AAAqC;AAEvC;AAAO;AAEP;AACA;AAAS;AACb;AAG+B;AAC7B;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AAEE;AAAA;AACN;AAKE;AAAO;AAGT;AACE;AACA;AACA;AACA;AACE;AACA;AACA;AACA;AAAO;AAEP;AACA;AAAS;AACb;AAGA;AAME;AACE;AAAO;AAET;AACA;AACE;AACE;AAA8F;AACpG;AAEE;AAAU;AAGZ;AAEA;AACE;AACA;AACA;AACA;AAAO;AAGT;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;AACK;AACL;AAMA;AACE;AACA;AACA;AACA;AAEA;AACA;AAEA;AACA;AACU;AAAoB;AAIhC;AAEA;AACE;AACE;AACA;AACE;AAAoC;AAC1C;AAEE;AAEA;AAA8B;AAGhC;AACE;AACA;AACA;AAEA;AAGA;AAEA;AAAuB;AAGzB;AACE;AAAgB;AAGlB;AACE;AAEA;AACE;AACA;AACE;AAAsC;AAC5C;AAEE;AAEA;AAA+B;AAUjC;AAEA;AAGA;AAEA;AAEA;AACE;AACA;AACE;AACA;AAAuB;AAC3B;AAGA;;AACE;AACA;AACA;AACE;AACA;AACA;AAEE;AACE;AACE;AACA;AACA;AAAA;AAEF;AACA;AACE;AACE;AACA;AAAwC;AAE1C;AAAwB;AAE1B;AACE;AAAmB;AAC7B;AACY;AACZ;AAEI;AAA8C;AAClD;AAGA;;AACE;AACA;AACA;AACE;AACA;AAA+B;AAE/B;AAAgD;AAElD;AACE;AACE;AACA;AAAuB;AAEzB;AACE;AACA;AACA;AAAQ;AACd;AACA;AAGoC;;AAClC;AACA;AAGA;AACA;AAa8B;AAC9B;AAIA;AAAM;AAGR;AACE;AACE;AACA;AACA;AAEA;AACA;AAAgB;AACpB;AAGA;AAEA;AACE;AAAwC;AAG1C;AACE;AACE;AAAgC;AAElC;AACE;AAAsB;AAExB;AAAM;AAGR;AACE;AACA;AACA;AACA;AACA;AAAyB;AAG3B;AAEE;AAAO;AACE;AACmB;AAE9B;AAIA;AAI4C;AACxC;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AAAO;AAGT;AAEA;AAOA;AACE;AACE;AACE;AACE;AAAkC;AACnC;AAED;AACA;AAAQ;AAChB;AACK;AAEH;AACA;AAIA;AAAgC;AAClC;AAIiB;AACf;AAEE;AACA;AAAc;AAClB;AAGA;AACE;AAEE;AAAwB;AAC5B;AAGA;AAEA;AAEA;AAEA;AAEA;AAEA;AACE;AACA;AAA8C;AAGhD;AAEA;AAEA;AACE;AACA;AACE;AACA;AAAQ;AACZ;AAGA;AAAW;AACyB;AAEhC;AACA;AAAyC;AAC7C;AAGI;AACA;AACE;AACA;AACE;AAAiB;AAEjB;A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B;AAGA;AACE;AAAgB;AACT;AACC;AACU;AACC;AACA;AACC;AAEpB;AACA;AACE;AAAgD;AAElD;AAAO;AAGT;AACE;AACA;AACA;AACA;AAAO;AAGT;AAAe;AACH;AACC;AACH;AAEN;AACA;AACA;AACA;AACA;AAEE;AACA;AACA;AACE;AAQA;AACA;AAA4B;AAE9B;AAAO;AAET;AACE;AACA;AAA6B;AAG/B;AACE;AAAgH;AAElH;AACE;AAAoG;AAEtG;AACE;AACE;AAEA;AAAmH;AACpH;AAEH;AAAO;AACX;AAEI;AACA;AACA;AACA;AACA;AACA;AACA;AACE;AACA;AAAgB;AAEhB;AACA;AAAgB;AAElB;AACE;AAAwB;AAE1B;AAAO;AACX;AACY;AAEN;AAAO;AACA;AACK;AACC;AACJ;AACF;AACA;AACC;AACK;AACe;AACA;AACA;AACjB;AACyB;AAE1C;AAAA;AAEM;AACE;AACE;AAAoB;AAC9B;AACA;AACA;AAEM;AAA0B;AAChC;AAEM;AAA0B;AAChC;AAEM;AAA0B;AAChC;AAEM;AAA0B;AAChC;AAEM;AAA0B;AAChC;AAEM;AACA;AACE;AAAgB;AAElB;AAAO;AACb;AAEM;AAA0B;AAChC;AAEE;AAAY;AAER;AACA;AACA;AACA;AACA;AAAa;AACnB;AAEM;AAA0B;AAChC;AAEM;AACA;AACE;AAAmB;AAEnB;AACE;AAAwB;AAClC;AAEM;AACE;AAA0B;AAE5B;AAAO;AACb;AACA;AAiBQ;AACN;AACA;AACA;AAA8D;AAGhE;AAEA;AAAkB;AACP;AACC;AACD;AACA;AACF;AACE;AACA;AACE;AACF;AACC;AACA;AACK;AACL;AACA;AACA;AACC;AACF;AACC;AACD;AACC;AACC;AACD;AACA;AACA;AACA;AACA;AACC;AACF;AACC;AACA;AACD;AACC;AACD;AACD;AACE;AACA;AACD;AACC;AACE;AACF;AACA;AACA;AACC;AACD;AACA;AACC;AACD;AACD;AACA;AACC;AACA;AACC;AACA;AACE;AACH;AACA;AACC;AACF;AACA;AACC;AACA;AACC;AACA;AACH;AACE;AACD;AACC;AACG;AACF;AACA;AACC;AACF;AACC;AACA;AACA;AACA;AACA;AACC;AACF;AACG;AACG;AACP;AACK;AACE;AACF;AACH;AACK;AACF;AACF;AACG;AACF;AACG;AACF;AACE;AACD;AACH;AACC;AACA;AACG;AACD;AACH;AACI;AACJ;AACO;AACA;AACF;AACJ;AACF;AACC;AACI;AACN;AACA;AACA;AACC;AACE;AACH;AACG;AACA;AACM;AACL;AACF;AAGd;AAAS;AACD;AACE;AACC;AACA;AACE;AACA;AACE;AACA;AACM;AACN;AACG;AACL;AACqB;AAAA;AAAA;AAAA;AAAA;AAAA;AAAA;AAS5B;AARF;AASE;AACA;AACE;AACE;AACA;AAAA;AACV;AACA;AACA;AAEE;AAAgB;AACd;AAAO;AAAA;AAEL;AAAY;AAClB;AAEM;AAAY;AAClB;AAEM;AAAkC;AACxC;AAEM;AAAkC;AACxC;AAEM;AAAqB;AAC3B;AAEM;AAAmB;AACzB;AAEM;AAAoB;AAC1B;AAEM;AAAmB;AACzB;AAEM;AAAuB;AAC7B;AAEE;AAAc;AACZ;AACA;AACA;AACA;AACA;AAEE;AACE;AAAS;AAEX;AACA;AACA;AACA;AACA;AACA;AACA;AAA+C;AACrD;AAEM;AAA4C;AAClD;AAEM;AAAsD;AAC5D;AAEM;AAA6C;AACnD;AAEM;AAAuD;AAC7D;AAEM;AAAyB;AAC/B;AAEM;AAA4B;AAClC;AAEE;AACE;AACE;AAA0B;AAE5B;AACA;AACE;AAAwB;AAG1B;AAEE;AAEA;AACA;AACA;AACE;AACA;AAEE;AAAA;AAEF;AACE;AAAA;AAEF;AACE;AACA;AACE;AACA;AAAS;AAET;AAAkB;AAEpB;AAAA;AAEF;AACA;AACE;AAAyC;AAKzC;AACE;AAAO;AACC;AAEpB;AACU;AAAM;AAGR;AACE;AAA0B;AAI5B;AACE;AACE;AAA0B;AAE5B;AACA;AACE;AAA0C;AAE5C;AACA;AAAS;AACnB;AAEM;AAAO;AACC;AACA;AAEd;AACI;AAA0B;AAC9B;AAEI;AACA;AACE;AACE;AACA;AACA;AAAsE;AAExE;AACA;AAAY;AAClB;AACA;AAEI;AACA;AACE;AAAmD;AAErD;AAAgD;AACpD;AAEI;AACA;AACA;AAAqB;AACzB;AAEI;AACA;AACE;AAA0B;AAE1B;AACA;AACE;AACE;AACA;AAAA;AAEF;AAAkB;AAC1B;AACA;AACA;AAEI;AACA;AACE;AAA+B;AAEjC;AACA;AACE;AACA;AACE;AAAO;AACf;AAGI;AAA6B;AACjC;AAEI;AACA;AACA;AACA;AAAO;AACX;AAEI;AAAsB;AAC1B;AAEI;AAAqB;AACzB;AAEI;AAAc;AAClB;AAEI;AAA0B;AAC9B;AAEI;AAA0B;AAC9B;AAEI;AAA0B;AAC9B;AAEI;AAA0B;AAC9B;AAEI;AAA0B;AAC9B;AAEI;AAA0B;AAC9B;AAEI;AAA0B;AAC9B;AAEI;AACA;AACE;AAAS;AAEX;AAAO;AACX;AAEI;AACE;AAAO;AAGT;AACE;AAAO;AAEP;AAAO;AAEP;AAAO;AAET;AAAO;AACX;AAEI;AACA;AACA;AACA;AACA;AAAO;AACX;AAEI;AACE;AAAO;AAET;AACE;AACA;AAAO;AACG;AACZ;AAAmC;AACvC;AAEI;AACA;AACE;AAA8B;AAE9B;AAAS;AAEX;AACA;AACE;AAAO;AAET;AACE;AACE;AAAO;AAET;AACE;AAAO;AACf;AAEM;AACE;AAAO;AACf;AAEI;AAAO;AACX;AAEI;AACE;AAAO;AAET;AACE;AAAO;AAEP;AAEE;AAAO;AACf;AAEI;AAAiE;AACrE;AAEI;AACE;AAA2B;AAE7B;AAAO;AACX;AACgB;AAEZ;AACE;AACE;AAAO;AACf;AAEI;AAA0B;AAC9B;AAEI;AACA;AACE;AAAyB;AAE3B;AAAO;AACX;AACgC;AAE5B;AAEA;AACA;AACE;AAAc;AAEhB;AACA;AACA;AAAO;AACX;AAEI;AAAiB;AACrB;;AAEI;AACA;AACA;AAAO;AACX;AAEI;AACA;AACA;AACA;AACA;AAAiB;AACrB;AACqB;;AAEf;AAEA;AAEA;AAAyB;AAC/B;AAEM;AAA0B;AAChC;AAEE;AAAwB;AACD;AACY;AAEjC;AAAkB;AACJ;AAElB;AAAA;AACkC;AAE9B;AACA;AACA;AACE;AACA;AACA;AAAsB;AAExB;AAAO;AACX;AAEI;AACE;AACA;AAAW;AAEb;AACA;AACE;AAA0G;AAE5G;AACA;AACA;AACE;AACA;AACA;AAAuB;AAEzB;AACE;AACE;AACE;AACA;AAAyB;AAE3B;AAAA;AAEF;AACE;AAAe;AACvB;AAGI;AACE;AACE;AAAgB;AAElB;AAAuC;AACxC;AACL;AAEI;AAGE;AAAM;AAER;AACA;AACA;AACA;AACE;AAA0B;AAE1B;AAAuC;AACvB;AAEhB;AAEA;AACA;AACE;AAA0B;AAE5B;AACE;AAA0B;AAClC;AAEI;AAAY;AACV;AACA;AACA;AACQ;AAGV;AACA;AACA;AACA;AACE;AAAU;AAGV;AAEA;AACE;AAA4B;AACpC;AAEI;AAAO;AACX;AAEI;AAAuC;AACvB;AAEhB;AACE;AAA0B;AAG5B;AACA;AACA;AACA;AACE;AACA;AACE;AACA;AACE;AAAsB;AAExB;AAAU;AAClB;AAGI;AAEA;AACA;AACA;AAA+B;AACnC;AAEI;AAA0C;AAC9C;AAEI;AAAiC;AACvB;AAEV;AACA;AACA;AACE;AAA0B;AAE5B;AACE;AAA0B;AAE5B;AACA;AACE;AAA+B;AAEjC;AACE;AAA0B;AAE5B;AAAoD;AACxD;AAEI;AAAyC;AAC/B;AACH;AACX;AAKI;AAAgC;AACpC;AAKI;AAAU;AACD;AACC;AACA;AACD;AACC;AACE;AACY;AAChB;AACC;AACE;AAEX;AACE;AAA6D;AAE/D;AAAO;AACX;AAEI;AACA;AACA;AAA6B;AACjC;AAEI;AACA;AACA;AAA6B;AACjC;AAEI;AACA;AACA;AACE;AACA;AACA;AACA;AACE;AAAgB;AAEhB;AAAyB;AACjC;AACA;AACA;AAEI;AACE;AACA;AAAO;AAET;AACA;AAA+B;AACnC;AAEI;AACE;AAA0B;AAE5B;AAAoC;AAC1B;AAEV;AACA;AACE;AAA0B;AAE5B;AACA;AACA;AACE;AAA+B;AAEjC;AACE;AAA0B;AAE5B;AAAuD;AAC3D;AAEI;AACA;AACA;AACA;AAEA;AAEA;AAAiC;AACvB;AAEV;AACA;AAAiC;AACvB;AAEV;AACA;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;AACA;AACA;AACA;AACE;AAA2B;AAE3B;AAAM;AAER;AACA;AAAO;AACX;AAEI;AACA;AACA;AACE;AACA;AACA;AAA+D;AAE/D;AAAiE;AAEjE;AAAuC;AAEzC;AAAe;AACnB;AACgB;AAEZ;AAAiC;AACvB;AAEV;AACE;AAA0B;AAE5B;AACE;AAA0B;AAE5B;AACA;AACE;AAA+B;AAEjC;AAAwB;AAC5B;AAEI;AACA;AACA;AAAyB;AAC7B;AAGI;AAEA;AAAoC;AACtB;AACoC;AAClC;AAEhB;AAIA;AACA;AACA;AACA;AAGA;AACA;AACE;AACE;AACA;AAA0B;AAE5B;AAAgC;AAElC;AACA;AAGA;AACA;AAAuB;AAC3B;AAII;AACA;AACA;AACA;AAAS;AAEL;AACA;AAAkB;AACS;AAE3B;AAAgB;AAEZ;AACA;AACA;AAAU;AACA;AACD;AACO;AAEd;AAAU;AACe;AAEzB;AAAS;AAEX;AAEA;AAAO;AACnB;AAEY;AAA0F;AACtG;AAEQ;AAAO;AACf;AAC0B;AAC1B;AASI;AACE;AAAsC;AAEtC;AAAmC;AAErC;AACE;AAA8C;AAE9C;AAAoC;AAEtC;AACE;AAA6C;AAE7C;AAAqC;AAGvC;AACA;AACA;AACA;AACA;AACA;AAAkE;AACtE;AAEI;AACA;AACA;AACA;AACA;AACA;AAAiB;AACN;AACG;AAElB;AAAA;AAEI;AACA;AAEA;AACA;AACA;AACA;AAA6C;AACjD;AAEI;AAEA;AAEA;AACE;AACE;AAAe;AACvB;AACA;AACA;AAEI;AACA;AACE;AAAO;AAET;AAAW;AACf;AAGI;AACE;AAAiC;AACtB;AAEX;AAAc;AACJ;AACZ;AAAU;AACA;AACA;AACD;AACD;AACA;AACE;AACM;AACF;AACE;AAEhB;AACE;AAAiC;AACvB;AAEV;AACA;AACA;AACA;AACA;AAA6B;AAClB;AAEX;AACA;AACA;AACA;AACA;AAA6B;AAE7B;AAAc;AAEhB;AAAO;AACX;AAEI;AACA;AACA;AACE;AACA;AACA;AACA;AACE;AAAgB;AAEhB;AAAyB;AAE3B;AAAS;AAEX;AAAO;AACX;AAEI;AACA;AACA;AAA2B;AAC/B;AAEI;AACA;AACE;AACA;AAAyC;AAE3C;AACA;AACA;AACE;AACE;AACA;AACA;AAAO;AAGT;AACA;AACA;AACA;AACA;AAAmB;AACzB;AACA;;AAEI;AACA;AACA;AACA;AAGA;AAAuB;AAEnB;AAAkB;AAC1B;;AAGQ;AACE;AAAS;AACnB;AACA;AAEQ;AACA;AACE;AACA;AACE;AAAc;AAEd;AAA0B;AAE5B;AACE;AAAyB;AAE3B;AACA;AACA;AAAqB;AAEvB;AACE;AAA4B;AAE9B;AAAO;AACf;AAEQ;AACE;AACE;AAAyB;AAEzB;AAA0B;AACtC;AAEQ;AACE;AAAgD;AAElD;AAAO;AACf;AAEI;AAA+B;AACnC;AAEI;AACA;AACE;AAAkN;AAGlN;AACE;AACA;AAA6B;AAE7B;AAA0B;AAClC;AACA;AACA;AACuD;AAG9B;AACnB;AACA;AAAO;AAAA;AAAA;AAGL;AACE;AAAO;AAET;AACA;AACA;AAAwC;AAChD;AAEQ;AAAc;AACtB;AAGQ;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AAEA;AAEA;AACE;AACA;AAEA;AACA;AACA;AAEA;AACA;AACE;AAAyD;AAE3D;AACA;AACA;AACE;AAAW;AAAA;AAAwD;AAAE;AAEvE;AAAsD;AAExD;AACA;AACE;AACA;AAEA;AAEA;AACE;AAA6C;AAE/C;AACA;AAAgC;AAElC;AAEE;AAEA;AACA;AACA;AAAiF;AAEnF;AACA;AACA;AAAmB;AAC3B;AAEQ;AACE;AAAgB;AAElB;AAAY;AACpB;AAEQ;AACE;AAAgB;AAElB;AAAY;AACpB;AAEI;AACE;AACA;AACA;AAAiB;AACL;AACA;AAElB;AACM;AAAiB;AACL;AACV;AAER;AACI;AAIA;AACE;AAA2B;AAE3B;AACA;AAAsB;AAGxB;AAA8B;AACjB;AAEP;AAAqB;AAC/B;AACA;AAGI;AACA;AACA;AACE;AACA;AACE;AACA;AAAiB;AACzB;AAEI;AACE;AACA;AACA;AACA;AACA;AAEE;AACE;AAA0C;AACpD;AAEQ;AAEE;AAA8C;AACxD;AAEM;AAAO;AAGT;AACE;AACA;AAA2D;AAG7D;AACE;AACA;AACA;AACE;AAA0B;AAE5B;AACA;AAAO;AACL;AACW;AAEnB;AACI;AACA;AAAO;AACX;AAEI;AAAqE;AACzE;AAEI;AAA8D;AAClE;AAEI;AAA8D;AAClE;AAEI;AAA2D;AAC/D;AAEI;AAA0E;AAC9E;AAEI;AAAuE;AAC3E;AAGA;AAAe;AACK;AAEhB;AACE;AAAO;AAGT;AACA;AACE;AAAY;AAEZ;AACA;AAAgB;AAElB;AACE;AACE;AAA0B;AAE5B;AAAO;AAET;AAAmB;AACvB;AAEI;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AAAO;AACX;AAEI;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AAEA;AAA6C;AACjD;AAEI;AACE;AAA0B;AAE5B;AAEE;AAAO;AAET;AACA;AAA2C;AAC/C;AAEI;AACA;AAAO;AACX;AACW;AAEP;AACA;AAAO;AACX;AAGA;AAEA;AAEA;AAEA;AACE;AACA;AACE;AACA;AACA;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AACE;AACA;AACE;AACA;AACA;AACA;AAEE;AAAO;AAET;AAAiC;AACvB;AAEV;AACA;AACE;AAAO;AAET;AACA;AACA;AACA;AACA;AACE;AAAO;AAET;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AACE;AACE;AACA;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AACE;AACE;AACA;AAAO;AAEP;AACA;AAAU;AACd;AAG8B;AAC5B;AAEA;AACA;AACA;AAAO;AAGT;AAEA;AACE;AACA;AACA;AACE;AACA;AAAW;AAGP;AACA;AACE;AAAO;AAET;AACE;AAAA;AAEF;AACA;AACA;AAAiB;AACzB;AAEU;AAEJ;AAAO;AAAA;AAIP;AAAc;AAIZ;AACA;AACA;AAAO;AACf;AAIQ;AACA;AAEA;AACA;AAAO;AACf;AAEU;AAMJ;AAAO;AAET;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AACE;AACA;AACE;AAA2C;AAE3C;AACA;AAAU;AACd;AAGA;AACE;AACA;AACE;AACA;AACA;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AACE;AACA;AAA6D;AAG/D;AACE;AACA;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AACE;AACA;AACA;AACE;AACA;AAAU;AAGN;AACA;AAAO;AACf;AAIQ;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACE;AAAoD;AAEtD;AAAO;AAET;AAAO;AACf;AAEU;AACA;AAGF;AACA;AAAO;AACf;AAEU;AACA;AAGF;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACE;AAAwC;AAE1C;AAAmD;AACjD;AACA;AACA;AACA;AACA;AACD;AAEH;AAAO;AACf;AAIQ;AACA;AACA;AACA;AAAO;AACf;AAIQ;AACA;AAAO;AACf;AAIQ;AACA;AAAgC;AACxC;AAMQ;AACA;AACE;AACA;AACA;AACA;AAAgD;AAElD;AAAO;AACf;AAOQ;AACA;AAAO;AACf;AAIQ;AACA;AAAO;AACf;AAGM;AAAO;AACb;AAEI;AACA;AAAU;AACd;AAGA;AACE;AACA;AACA;AACE;AACA;AAA6C;AAE7C;AACA;AAAU;AACd;AAGA;AACE;AACA;AACE;AACA;AACA;AACA;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AACE;AACA;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AAAwE;AAExE;AACA;AAAU;AACd;AAGA;AACE;AACA;AACA;AACA;AACE;AACA;AACA;AACA;AAAkC;AAElC;AACA;AAAU;AACd;AAGA;AACE;AACA;AACA;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AAGA;AACA;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AACE;AACA;AACE;AACA;AACA;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AACE;AACA;AACA;AACE;AACA;AAA4C;AAE5C;AACA;AAAU;AACd;AAGA;AACE;AACA;AACE;AACA;AACA;AACE;AAAc;AAEd;AAAa;AAEb;AAAwC;AAE1C;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AAEA;AACE;AACA;AACA;AACE;AACA;AACA;AACA;AACA;AACE;AACA;AAAQ;AAER;AACA;AACA;AACE;AAAQ;AAER;AAAQ;AAER;AAAgD;AAElD;AACA;AACA;AACA;AACE;AAAQ;AAER;AAAQ;AAER;AAAgD;AACxD;AAII;AACE;AAA2B;AAE7B;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AAEA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AAAyC;AAG3C;AAEA;AAEA;AAEA;AACE;AACA;AACA;AAEA;AAAO;AAGT;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AAEA;AACA;AACA;AACA;AACA;AAAyC;AAG3C;AACE;AACA;AACA;AACA;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AAAO;AAEP;AACA;AAAU;AACd;AAGA;AACE;AACA;AACA;AACA;AACE;AACA;AACE;AAAiD;AACvD;AAEI;AACA;AAAU;AACd;AAGA;AACE;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AAAwB;AAE1B;AAAiB;AAGnB;AACE;AACA;AACA;AACA;AAEA;AACA;AACA;AACA;AACA;AAOA;AAMA;AACA;AACA;AAGE;AACA;AACA;AACA;AACA;AAAmC;AAErC;AACA;AACA;AACA;AACA;AACA;AACA;AAEE;AACA;AAAqC;AAErC;AACA;AAAqC;AACzC;AAGA;AAEA;AAIA;AAEA;AAEE;AACA;AACE;AAAO;AAET;AAEA;AACE;AAA0B;AAE1B;AAAyB;AAK3B;AACA;AACA;AAAO;AAGT;AAEA;AAEE;AAEA;AACA;AACA;AAGA;AACE;AACA;AAEA;AACA;AAGA;AACA;AACA;AACA;AAAmB;AAAA;AACiI;AACpJ;AAAkB;AAEpB;AAAO;AAGT;AACE;AACA;AACA;AAA+B;AAGjC;AACE;AACA;AACA;AACA;AAA4C;AAG9C;AACE;AACA;AAA4B;AAG9B;AACE;AACA;AACA;AAAiC;AAGnC;AAAiB;AAAA;AAAA;AAAA;AAAA;AAIjB;AAEA;AACE;AAAiB;AAGnB;AAEE;AACA;AAAO;AAGT;AACE;AACA;AACA;AAEE;AAEA;AACA;AAAO;AAEP;AAAyG;AAC7G;AAGA;AACE;AACA;AAGA;AAmBA;AACA;AACE;AACA;AAAO;AAKT;AACE;AAGA;AACA;AACA;AACA;AACE;AAAO;AACb;AAEE;AACA;AAAO;AAGgB;AACvB;AAEA;AAAO;AAGT;AAEA;AACE;AACW;AAAsB;AAIhC;AAGH;AAEA;AACE;AACA;AACE;AAAe;AAEjB;AAGA;AACA;AACA;AAAoB;AAGtB;AACE;AACA;AACA;AACA;AACE;AAAqB;AAErB;AACA;AACE;AAAW;AAEb;AAAuB;AAEzB;AACA;AACE;AAAE;AAEJ;AACE;AAA+E;AAEjF;AAAO;AAGT;AAEA;AAEA;AACE;AAGE;AACA;AAAU;AACA;AACG;AACH;AACD;AACC;AACA;AACc;AAGxB;AAIE;AAAsC;AAAsB;AAE9D;AACA;AACE;AAA6B;AAE/B;AAAwB;AAE1B;AAAqB;AAGvB;AACE;AACA;AACA;AACA;AACA;AACE;AACA;AACA;AACA;AAAQ;AAEV;AAAO;AAGT;AACE;AACA;AACA;AACA;AACA;AACA;AACE;AAAqC;AAEvC;AACA;AAAO;AAGT;AAEA;AAEA;;AACE;AACA;AACE;AACA;AAAQ;AAEV;AAAgC;AAGqC;AACrE;AACA;AAEA;AACE;AACA;AACA;AAAO;AAET;AAAiB;AAGnB;AAEA;AACE;AACE;AACA;AACA;AAAO;AAEP;AACA;AAAS;AACb;AAGA;AACE;AACA;AACE;AACA;AACA;AACA;AACE;AAGA;AAAqF;AAEvF;AACA;AACA;AACA;AACA;AAAO;AAEP;AACA;AAAS;AACb;AAG+B;AAC7B;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AAAgB;AAMlB;AAAO;AAGT;AACE;AACA;AACA;AACA;AACE;AACA;AACA;AACA;AAAO;AAEP;AACA;AAAS;AACb;AAGA;AACE;AACA;AACA;AACE;AACA;AACA;AACA;AACA;AAEA;AAAO;AAEP;AACA;AAAS;AACb;AAGA;;AACE;AACE;AA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A;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACE;AACA;AAAY;AAEd;AACA;AACE;AAEA;AAAA;AAAO;AAAA;AAAsB;AAC7B;AAAO;AAEP;AAAwB;AAC5B;AAGA;AAIE;AAEA;AAAgB;AAGlB;AACE;AACE;AACA;AAAA;AAEF;AACA;AAEA;AACE;AACA;AAAA;AAEF;;AAGE;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AAAO;AAET;AACE;AACA;AACE;AACA;AAAK;AACH;AAEJ;AAAK;AAEP;AAAgB;AAGlB;AAYE;AACA;AACA;AACA;AACE;AAAM;AAER;AAEE;AAEA;;AACE;AACA;AACA;AACA;AACA;AACA;AACE;AAAM;AACd;AACK;AACS;AACZ;AACA;AACA;AACE;AAAiL;AACrL;AAGA;AACE;AACE;AACA;AACE;AAAyB;AAC/B;AAEE;AAA4B;AAG9B;AAEA;AAQA;AAOA;AACE;AACE;AAAuC;AACvB;AAEZ;AAA2J;AACnK;AACK;AACL;AAIE;AAAO;AACT;AAG+D;AAC7D;AAGA;AAAyB;AAC3B;;;;;AC//JA;AAAiC;AAWT;AACd;AACA;AACA;AACA;AACA;AACA;AAGN;AACA;AACA;AACA;AACA;AAA6B;AACA;AACc;AACY;AACE;AAGzD;AACE;AACA;AAA0B;AACR;AACd;AAAA;AACa;AAAA;AACkB;AACd;AAAA;AACnB;AAEH;AACH;AAIE;AACA;AAGA;AAAqD;AACvD;AAGE;AACE;AAAqC;AAEvC;AACA;AACA;AAIA;AACE;AACA;AACA;AACA;AACA;AACE;AAAgB;AACd;AAAA;AACA;AAAA;AACS;AAAA;AACA;AAAA;AAAA;AAGX;AACA;AACA;AACE;AAAyC;AAAc;AAEzD;AACA;AAA2B;AAC7B;AACF;AACF;AAAA;AAAA;AAKE;AACA;AACA;AAA8D;AAChE;AAGE;AAEA;AACA;AACE;AAAgB;AAClB;AACF;AAAA;AAAA;AAAA;AAAA;AAAA;AAQE;AACE;AAAiB;AAQnB;AACA;AAAuB;AACzB;AAIF;AAKE;AAA6C;AAC3C;AAAM;AAAM;AAAM;AAAM;AAAM;AAAM;AAAM;AAAM;AAAM;AAAM;AAAM;AAClE;AAAM;AAAM;AAAM;AAAM;AAAM;AAAM;AAAM;AAAM;AAAM;AAAM;AAE9D;AACE;AACA;AAAO;AAEP;AAAO;AACT;AC9JF;AACA;AAaA;AACE;AACA;AAA0B","file":"engine_bundle.js"};