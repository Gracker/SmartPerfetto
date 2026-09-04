(function() {
	var _documentCurrentScript = typeof document !== "undefined" ? document.currentScript : null;
	typeof document === "undefined" ? location.href : _documentCurrentScript && _documentCurrentScript.tagName.toUpperCase() === "SCRIPT" && _documentCurrentScript.src || document.baseURI;
	//#region \0rolldown/runtime.js
	var __create = Object.create;
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __getProtoOf = Object.getPrototypeOf;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
			key = keys[i];
			if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: ((k) => from[k]).bind(null, key),
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
		value: mod,
		enumerable: true
	}) : target, mod));
	//#endregion
	//#region \0perfetto:version:ui/src/virtual/version
	var VERSION = "v58.2-6e665f809";
	//#endregion
	//#region ../../ui/src/base/utils.ts
	function exists(value) {
		return value !== void 0 && value !== null;
	}
	//#endregion
	//#region ../../ui/src/base/logging.ts
	var errorHandlers = [];
	function addErrorHandler(handler) {
		if (!errorHandlers.includes(handler)) errorHandlers.push(handler);
	}
	function reportError(err) {
		let errorObj = void 0;
		let errMsg = "";
		let errType;
		const stack = [];
		const baseUrl = `${location.protocol}//${location.host}`;
		if (err instanceof ErrorEvent) {
			errType = "ERROR";
			if (err.error === null || err.error === void 0) {
				const errLines = `${err.message}`.split("\n");
				errMsg = errLines[0];
				errorObj = { stack: errLines.slice(1).join("\n") };
			} else {
				errMsg = `${err.error}`;
				errorObj = err.error;
			}
		} else if (err instanceof PromiseRejectionEvent) {
			errType = "PROMISE_REJ";
			errMsg = `${err.reason}`;
			errorObj = err.reason;
		} else {
			errType = "OTHER";
			errMsg = `${err}`;
		}
		errMsg = errMsg.replace(/^Uncaught Error:/, "");
		errMsg = errMsg.replace(/^Error:/, "");
		errMsg = errMsg.trim();
		if (errorObj !== void 0 && errorObj !== null) {
			const maybeStack = errorObj.stack;
			let errStack = maybeStack !== void 0 ? `${maybeStack}` : "";
			errStack = errStack.replaceAll(/\r/g, "");
			for (let line of errStack.split("\n")) {
				if (errMsg.includes(line)) continue;
				line = line.replace(/^\s*at\s*/, "");
				line = line.replace(/\s*\(([^)]+)\)$/, "@$1");
				const lastAt = line.lastIndexOf("@");
				let entryName = "";
				let entryLocation = "";
				if (lastAt >= 0) {
					entryLocation = line.substring(lastAt + 1);
					entryName = line.substring(0, lastAt);
				} else entryLocation = line;
				if (entryLocation.includes(baseUrl)) {
					entryLocation = entryLocation.replace(baseUrl, "");
					entryLocation = entryLocation.replace(`/${VERSION}/`, "");
				}
				stack.push({
					name: entryName,
					location: entryLocation
				});
			}
			const wasmFunc = stack.find((e) => e.name.includes("perfetto::"))?.name;
			if (errMsg.includes("RuntimeError") && exists(wasmFunc)) errMsg += ` @ ${wasmFunc.trim()}`;
		}
		for (const handler of errorHandlers) handler({
			errType,
			message: errMsg,
			stack
		});
	}
	//#endregion
	//#region ../../ui/src/base/assert.ts
	function ensureExists(x, msg) {
		if (x === null || x === void 0) throw new Error(msg ?? "Value is null or undefined");
		return x;
	}
	//#endregion
	//#region ../../ui/src/traceconv/index.ts
	var import_traceconv = /* @__PURE__ */ __toESM((/* @__PURE__ */ __commonJSMin(((exports, module) => {
		var traceconv_wasm = (() => {
			var _scriptName = globalThis.document?.currentScript?.src;
			return async function(moduleArg = {}) {
				var moduleRtn;
				(function() {
					function $humanReadableVersionToPacked$$($str$jscomp$6_vers$$) {
						$str$jscomp$6_vers$$ = $str$jscomp$6_vers$$.split("-")[0];
						for ($str$jscomp$6_vers$$ = $str$jscomp$6_vers$$.split(".").slice(0, 3); 3 > $str$jscomp$6_vers$$.length;) $str$jscomp$6_vers$$.push("00");
						$str$jscomp$6_vers$$ = $str$jscomp$6_vers$$.map(($n$jscomp$2$$) => $n$jscomp$2$$.padStart(2, "0"));
						return $str$jscomp$6_vers$$.join("");
					}
					var $currentChromeVersion_currentNodeVersion_userAgent$$ = "undefined" !== typeof process && process.$versions$?.node ? $humanReadableVersionToPacked$$(process.$versions$.node) : 2147483647;
					if (2147483647 > $currentChromeVersion_currentNodeVersion_userAgent$$) throw Error("not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)");
					if (2147483647 > $currentChromeVersion_currentNodeVersion_userAgent$$) throw Error(`This emscripten-generated code requires node v214748.36.47 (detected v${[
						$currentChromeVersion_currentNodeVersion_userAgent$$ / 1e4 | 0,
						($currentChromeVersion_currentNodeVersion_userAgent$$ / 100 | 0) % 100,
						$currentChromeVersion_currentNodeVersion_userAgent$$ % 100
					].join(".")})`);
					if ($currentChromeVersion_currentNodeVersion_userAgent$$ = "undefined" !== typeof navigator && navigator.userAgent) {
						var $currentFirefoxVersion_currentSafariVersion$$ = $currentChromeVersion_currentNodeVersion_userAgent$$.includes("Safari/") && !$currentChromeVersion_currentNodeVersion_userAgent$$.includes("Chrome/") && $currentChromeVersion_currentNodeVersion_userAgent$$.match(/Version\/(\d+\.?\d*\.?\d*)/) ? $humanReadableVersionToPacked$$($currentChromeVersion_currentNodeVersion_userAgent$$.match(/Version\/(\d+\.?\d*\.?\d*)/)[1]) : 2147483647;
						if (15e4 > $currentFirefoxVersion_currentSafariVersion$$) throw Error(`This emscripten-generated code requires Safari v15.0.0 (detected v${$currentFirefoxVersion_currentSafariVersion$$})`);
						$currentFirefoxVersion_currentSafariVersion$$ = $currentChromeVersion_currentNodeVersion_userAgent$$.match(/Firefox\/(\d+(?:\.\d+)?)/) ? parseFloat($currentChromeVersion_currentNodeVersion_userAgent$$.match(/Firefox\/(\d+(?:\.\d+)?)/)[1]) : 2147483647;
						if (79 > $currentFirefoxVersion_currentSafariVersion$$) throw Error(`This emscripten-generated code requires Firefox v79 (detected v${$currentFirefoxVersion_currentSafariVersion$$})`);
						$currentChromeVersion_currentNodeVersion_userAgent$$ = $currentChromeVersion_currentNodeVersion_userAgent$$.match(/Chrome\/(\d+(?:\.\d+)?)/) ? parseFloat($currentChromeVersion_currentNodeVersion_userAgent$$.match(/Chrome\/(\d+(?:\.\d+)?)/)[1]) : 2147483647;
						if (85 > $currentChromeVersion_currentNodeVersion_userAgent$$) throw Error(`This emscripten-generated code requires Chrome v85 (detected v${$currentChromeVersion_currentNodeVersion_userAgent$$})`);
					}
				})();
				var $Module$$ = moduleArg, $ENVIRONMENT_IS_WEB$$ = !!globalThis.window, $ENVIRONMENT_IS_WORKER$$ = !!globalThis.WorkerGlobalScope, $ENVIRONMENT_IS_NODE$$ = globalThis.$g$?.$versions$?.node && "renderer" != globalThis.$g$?.type, $ENVIRONMENT_IS_SHELL$$ = !$ENVIRONMENT_IS_WEB$$ && !$ENVIRONMENT_IS_NODE$$ && !$ENVIRONMENT_IS_WORKER$$, $arguments_$$ = [], $thisProgram$$ = "./this.program";
				$ENVIRONMENT_IS_WORKER$$ && (_scriptName = self.location.href);
				var $scriptDirectory$$ = "", $readAsync$$, $readBinary$$;
				if (!$ENVIRONMENT_IS_SHELL$$) if ($ENVIRONMENT_IS_WEB$$ || $ENVIRONMENT_IS_WORKER$$) {
					try {
						$scriptDirectory$$ = new URL(".", _scriptName).href;
					} catch {}
					if (!globalThis.window && !globalThis.WorkerGlobalScope) throw Error("not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)");
					$ENVIRONMENT_IS_WORKER$$ && ($readBinary$$ = ($url$jscomp$24$$) => {
						var $xhr$$ = new XMLHttpRequest();
						$xhr$$.open("GET", $url$jscomp$24$$, !1);
						$xhr$$.responseType = "arraybuffer";
						$xhr$$.send(null);
						return new Uint8Array($xhr$$.response);
					});
					$readAsync$$ = async ($response$jscomp$2_url$jscomp$25$$) => {
						$assert$$(!$isFileURI$$($response$jscomp$2_url$jscomp$25$$), "readAsync does not work with file:// URLs");
						$response$jscomp$2_url$jscomp$25$$ = await fetch($response$jscomp$2_url$jscomp$25$$, { credentials: "same-origin" });
						if ($response$jscomp$2_url$jscomp$25$$.ok) return $response$jscomp$2_url$jscomp$25$$.arrayBuffer();
						throw Error($response$jscomp$2_url$jscomp$25$$.status + " : " + $response$jscomp$2_url$jscomp$25$$.url);
					};
				} else throw Error("environment detection error");
				var $out$$ = console.log.bind(console), $err$$ = console.error.bind(console);
				$assert$$(!$ENVIRONMENT_IS_NODE$$, "node environment detected but not enabled at build time.  Add `node` to `-sENVIRONMENT` to enable.");
				$assert$$(!$ENVIRONMENT_IS_SHELL$$, "shell environment detected but not enabled at build time.  Add `shell` to `-sENVIRONMENT` to enable.");
				var $wasmBinary$$;
				globalThis.WebAssembly || $err$$("no native wasm support detected");
				var $ABORT$$ = !1, $EXITSTATUS$$;
				function $assert$$($condition$jscomp$2$$, $text$jscomp$12$$) {
					$condition$jscomp$2$$ || $abort$$("Assertion failed" + ($text$jscomp$12$$ ? ": " + $text$jscomp$12$$ : ""));
				}
				var $isFileURI$$ = ($filename$jscomp$2$$) => $filename$jscomp$2$$.startsWith("file://");
				function $writeStackCookie$$() {
					var $max$$ = $_emscripten_stack_get_end$$();
					$assert$$(0 == ($max$$ & 3));
					0 == $max$$ && ($max$$ += 4);
					$HEAPU32$$[$max$$ >>> 2 >>> 0] = 34821223;
					$HEAPU32$$[$max$$ + 4 >>> 2 >>> 0] = 2310721022;
					$HEAPU32$$[0] = 1668509029;
				}
				function $checkStackCookie$$() {
					if (!$ABORT$$) {
						var $max$jscomp$1$$ = $_emscripten_stack_get_end$$();
						0 == $max$jscomp$1$$ && ($max$jscomp$1$$ += 4);
						var $cookie1$$ = $HEAPU32$$[$max$jscomp$1$$ >>> 2 >>> 0], $cookie2$$ = $HEAPU32$$[$max$jscomp$1$$ + 4 >>> 2 >>> 0];
						34821223 == $cookie1$$ && 2310721022 == $cookie2$$ || $abort$$(`Stack overflow! Stack cookie has been overwritten at ${$ptrToString$$($max$jscomp$1$$)}, expected hex dwords 0x89BACDFE and 0x2135467, but received ${$ptrToString$$($cookie2$$)} ${$ptrToString$$($cookie1$$)}`);
						1668509029 != $HEAPU32$$[0] && $abort$$("Runtime error: The application has corrupted its heap memory area (address zero)!");
					}
				}
				var $h16$jscomp$inline_22$$ = /* @__PURE__ */ new Int16Array(1), $h8$jscomp$inline_23$$ = new Int8Array($h16$jscomp$inline_22$$.buffer);
				$h16$jscomp$inline_22$$[0] = 25459;
				115 === $h8$jscomp$inline_23$$[0] && 99 === $h8$jscomp$inline_23$$[1] || $abort$$("Runtime error: expected the system to be little-endian! (Run with -sSUPPORT_BIG_ENDIAN to bypass)");
				function $consumedModuleProp$$($prop$jscomp$2$$) {
					Object.getOwnPropertyDescriptor($Module$$, $prop$jscomp$2$$) || Object.defineProperty($Module$$, $prop$jscomp$2$$, {
						configurable: !0,
						set() {
							$abort$$(`Attempt to set \`Module.${$prop$jscomp$2$$}\` after it has already been processed.  This can happen, for example, when code is injected via '--post-js' rather than '--pre-js'`);
						}
					});
				}
				function $makeInvalidEarlyAccess$$($name$jscomp$74$$) {
					return () => $assert$$(!1, `call to '${$name$jscomp$74$$}' via reference taken before Wasm module initialization`);
				}
				function $ignoredModuleProp$$($prop$jscomp$3$$) {
					Object.getOwnPropertyDescriptor($Module$$, $prop$jscomp$3$$) && $abort$$(`\`Module.${$prop$jscomp$3$$}\` was supplied but \`${$prop$jscomp$3$$}\` not included in INCOMING_MODULE_JS_API`);
				}
				function $unexportedRuntimeSymbol$$($sym$jscomp$3$$) {
					Object.getOwnPropertyDescriptor($Module$$, $sym$jscomp$3$$) || Object.defineProperty($Module$$, $sym$jscomp$3$$, {
						configurable: !0,
						get() {
							var $msg$$ = `'${$sym$jscomp$3$$}' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the Emscripten FAQ)`;
							"FS_createPath" !== $sym$jscomp$3$$ && "FS_createDataFile" !== $sym$jscomp$3$$ && "FS_createPreloadedFile" !== $sym$jscomp$3$$ && "FS_preloadFile" !== $sym$jscomp$3$$ && "FS_unlink" !== $sym$jscomp$3$$ && "addRunDependency" !== $sym$jscomp$3$$ && "FS_createLazyFile" !== $sym$jscomp$3$$ && "FS_createDevice" !== $sym$jscomp$3$$ && "removeRunDependency" !== $sym$jscomp$3$$ || ($msg$$ += ". Alternatively, forcing filesystem support (-sFORCE_FILESYSTEM) can export this for you");
							$abort$$($msg$$);
						}
					});
				}
				var $readyPromiseResolve$$, $readyPromiseReject$$, $HEAP8$$, $HEAPU8$$, $HEAP16$$, $HEAP32$$, $HEAPU32$$, $HEAPF64$$, $HEAP64$$, $runtimeInitialized$$ = !1;
				function $updateMemoryViews$$() {
					var $b$jscomp$1$$ = $wasmMemory$$.buffer;
					$HEAP8$$ = new Int8Array($b$jscomp$1$$);
					$HEAP16$$ = new Int16Array($b$jscomp$1$$);
					$Module$$.HEAPU8 = $HEAPU8$$ = new Uint8Array($b$jscomp$1$$);
					new Uint16Array($b$jscomp$1$$);
					$HEAP32$$ = new Int32Array($b$jscomp$1$$);
					$HEAPU32$$ = new Uint32Array($b$jscomp$1$$);
					new Float32Array($b$jscomp$1$$);
					$HEAPF64$$ = new Float64Array($b$jscomp$1$$);
					$HEAP64$$ = new BigInt64Array($b$jscomp$1$$);
					new BigUint64Array($b$jscomp$1$$);
				}
				$assert$$(globalThis.Int32Array && globalThis.Float64Array && Int32Array.prototype.subarray && Int32Array.prototype.set, "JS engine does not provide full typed array support");
				function $abort$$($e$jscomp$7_what$$) {
					$Module$$.onAbort?.($e$jscomp$7_what$$);
					$e$jscomp$7_what$$ = "Aborted(" + $e$jscomp$7_what$$ + ")";
					$err$$($e$jscomp$7_what$$);
					$ABORT$$ = !0;
					$e$jscomp$7_what$$ = new WebAssembly.RuntimeError($e$jscomp$7_what$$);
					$readyPromiseReject$$?.($e$jscomp$7_what$$);
					throw $e$jscomp$7_what$$;
				}
				function $createExportWrapper$$($name$jscomp$76$$, $nargs$$) {
					return (...$args$jscomp$3$$) => {
						$assert$$($runtimeInitialized$$, `native function \`${$name$jscomp$76$$}\` called before runtime initialization`);
						var $f$jscomp$1$$ = $wasmExports$$[$name$jscomp$76$$];
						$assert$$($f$jscomp$1$$, `exported native function \`${$name$jscomp$76$$}\` not found`);
						$assert$$($args$jscomp$3$$.length <= $nargs$$, `native function \`${$name$jscomp$76$$}\` called with ${$args$jscomp$3$$.length} args but expects ${$nargs$$}`);
						return $f$jscomp$1$$(...$args$jscomp$3$$);
					};
				}
				var $wasmBinaryFile$$;
				async function $getWasmBinary$$($JSCompiler_inline_result$jscomp$0_binaryFile$$) {
					if (!$wasmBinary$$) try {
						var $response$jscomp$3$$ = await $readAsync$$($JSCompiler_inline_result$jscomp$0_binaryFile$$);
						return new Uint8Array($response$jscomp$3$$);
					} catch {}
					if ($JSCompiler_inline_result$jscomp$0_binaryFile$$ == $wasmBinaryFile$$ && $wasmBinary$$) $JSCompiler_inline_result$jscomp$0_binaryFile$$ = new Uint8Array($wasmBinary$$);
					else if ($readBinary$$) $JSCompiler_inline_result$jscomp$0_binaryFile$$ = $readBinary$$($JSCompiler_inline_result$jscomp$0_binaryFile$$);
					else throw "both async and sync fetching of the wasm failed";
					return $JSCompiler_inline_result$jscomp$0_binaryFile$$;
				}
				async function $instantiateArrayBuffer$$($binaryFile$jscomp$1$$, $imports$$) {
					try {
						var $binary$$ = await $getWasmBinary$$($binaryFile$jscomp$1$$);
						return await WebAssembly.instantiate($binary$$, $imports$$);
					} catch ($reason$jscomp$9$$) {
						$err$$(`failed to asynchronously prepare wasm: ${$reason$jscomp$9$$}`), $isFileURI$$($binaryFile$jscomp$1$$) && $err$$(`warning: Loading from a file URI (${$binaryFile$jscomp$1$$}) is not supported in most browsers. See https://emscripten.org/docs/getting_started/FAQ.html#how-do-i-run-a-local-webserver-for-testing-why-does-my-program-stall-in-downloading-or-preparing`), $abort$$($reason$jscomp$9$$);
					}
				}
				async function $instantiateAsync$$($imports$jscomp$1$$) {
					var $binaryFile$jscomp$2$$ = $wasmBinaryFile$$;
					if (!$wasmBinary$$) try {
						var $response$jscomp$4$$ = fetch($binaryFile$jscomp$2$$, { credentials: "same-origin" });
						return await WebAssembly.instantiateStreaming($response$jscomp$4$$, $imports$jscomp$1$$);
					} catch ($reason$jscomp$10$$) {
						$err$$(`wasm streaming compile failed: ${$reason$jscomp$10$$}`), $err$$("falling back to ArrayBuffer instantiation");
					}
					return $instantiateArrayBuffer$$($binaryFile$jscomp$2$$, $imports$jscomp$1$$);
				}
				class $ExitStatus$$ {
					name = "ExitStatus";
					constructor($status$jscomp$1$$) {
						this.message = `Program terminated with exit(${$status$jscomp$1$$})`;
						this.status = $status$jscomp$1$$;
					}
				}
				var $callRuntimeCallbacks$$ = ($callbacks$$) => {
					for (; 0 < $callbacks$$.length;) $callbacks$$.shift()($Module$$);
				}, $onPostRuns$$ = [], $onPreRuns$$ = [], $addOnPreRun$$ = () => {
					var $cb$jscomp$1$$ = $Module$$.preRun.shift();
					$onPreRuns$$.push($cb$jscomp$1$$);
				}, $noExitRuntime$$ = !0, $ptrToString$$ = ($ptr$$) => {
					$assert$$("number" === typeof $ptr$$, `ptrToString expects a number, got ${typeof $ptr$$}`);
					return "0x" + ($ptr$$ >>> 0).toString(16).padStart(8, "0");
				}, $warnOnce$$ = ($text$jscomp$13$$) => {
					$warnOnce$$.$shown$ || ($warnOnce$$.$shown$ = {});
					$warnOnce$$.$shown$[$text$jscomp$13$$] || ($warnOnce$$.$shown$[$text$jscomp$13$$] = 1, $err$$($text$jscomp$13$$));
				}, $PATH$normalizeArray$$ = ($parts$$, $allowAboveRoot$$) => {
					for (var $up$$ = 0, $i$jscomp$4$$ = $parts$$.length - 1; 0 <= $i$jscomp$4$$; $i$jscomp$4$$--) {
						var $last$$ = $parts$$[$i$jscomp$4$$];
						"." === $last$$ ? $parts$$.splice($i$jscomp$4$$, 1) : ".." === $last$$ ? ($parts$$.splice($i$jscomp$4$$, 1), $up$$++) : $up$$ && ($parts$$.splice($i$jscomp$4$$, 1), $up$$--);
					}
					if ($allowAboveRoot$$) for (; $up$$; $up$$--) $parts$$.unshift("..");
					return $parts$$;
				}, $PATH$normalize$$ = ($path$jscomp$7$$) => {
					var $isAbsolute$$ = "/" === $path$jscomp$7$$.charAt(0), $trailingSlash$$ = "/" === $path$jscomp$7$$.slice(-1);
					($path$jscomp$7$$ = $PATH$normalizeArray$$($path$jscomp$7$$.split("/").filter(($p$$) => !!$p$$), !$isAbsolute$$).join("/")) || $isAbsolute$$ || ($path$jscomp$7$$ = ".");
					$path$jscomp$7$$ && $trailingSlash$$ && ($path$jscomp$7$$ += "/");
					return ($isAbsolute$$ ? "/" : "") + $path$jscomp$7$$;
				}, $PATH$dirname$$ = ($path$jscomp$8_root$jscomp$3$$) => {
					var $dir_result$jscomp$3$$ = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/.exec($path$jscomp$8_root$jscomp$3$$).slice(1);
					$path$jscomp$8_root$jscomp$3$$ = $dir_result$jscomp$3$$[0];
					$dir_result$jscomp$3$$ = $dir_result$jscomp$3$$[1];
					if (!$path$jscomp$8_root$jscomp$3$$ && !$dir_result$jscomp$3$$) return ".";
					$dir_result$jscomp$3$$ &&= $dir_result$jscomp$3$$.slice(0, -1);
					return $path$jscomp$8_root$jscomp$3$$ + $dir_result$jscomp$3$$;
				}, $PATH$basename$$ = ($path$jscomp$9$$) => $path$jscomp$9$$ && $path$jscomp$9$$.match(/([^\/]+|\/)\/*$/)[1], $PATH$join2$$ = ($l$$, $r$jscomp$1$$) => $PATH$normalize$$($l$$ + "/" + $r$jscomp$1$$), $initRandomFill$$ = () => ($view$jscomp$5$$) => crypto.getRandomValues($view$jscomp$5$$), $randomFill$$ = ($view$jscomp$6$$) => {
					($randomFill$$ = $initRandomFill$$())($view$jscomp$6$$);
				}, $PATH_FS$resolve$$ = (...$args$jscomp$4$$) => {
					for (var $resolvedPath$$ = "", $path$jscomp$10_resolvedAbsolute$$ = !1, $i$jscomp$5$$ = $args$jscomp$4$$.length - 1; -1 <= $i$jscomp$5$$ && !$path$jscomp$10_resolvedAbsolute$$; $i$jscomp$5$$--) {
						$path$jscomp$10_resolvedAbsolute$$ = 0 <= $i$jscomp$5$$ ? $args$jscomp$4$$[$i$jscomp$5$$] : $FS$$.$cwd$();
						if ("string" != typeof $path$jscomp$10_resolvedAbsolute$$) throw new TypeError("Arguments to path.resolve must be strings");
						if (!$path$jscomp$10_resolvedAbsolute$$) return "";
						$resolvedPath$$ = $path$jscomp$10_resolvedAbsolute$$ + "/" + $resolvedPath$$;
						$path$jscomp$10_resolvedAbsolute$$ = "/" === $path$jscomp$10_resolvedAbsolute$$.charAt(0);
					}
					$resolvedPath$$ = $PATH$normalizeArray$$($resolvedPath$$.split("/").filter(($p$jscomp$1$$) => !!$p$jscomp$1$$), !$path$jscomp$10_resolvedAbsolute$$).join("/");
					return ($path$jscomp$10_resolvedAbsolute$$ ? "/" : "") + $resolvedPath$$ || ".";
				}, $PATH_FS$relative$$ = ($from_fromParts$$, $to_toParts$$) => {
					function $trim$$($arr$jscomp$2$$) {
						for (var $start$jscomp$13$$ = 0; $start$jscomp$13$$ < $arr$jscomp$2$$.length && "" === $arr$jscomp$2$$[$start$jscomp$13$$]; $start$jscomp$13$$++);
						for (var $end$jscomp$11$$ = $arr$jscomp$2$$.length - 1; 0 <= $end$jscomp$11$$ && "" === $arr$jscomp$2$$[$end$jscomp$11$$]; $end$jscomp$11$$--);
						return $start$jscomp$13$$ > $end$jscomp$11$$ ? [] : $arr$jscomp$2$$.slice($start$jscomp$13$$, $end$jscomp$11$$ - $start$jscomp$13$$ + 1);
					}
					$from_fromParts$$ = $PATH_FS$resolve$$($from_fromParts$$).slice(1);
					$to_toParts$$ = $PATH_FS$resolve$$($to_toParts$$).slice(1);
					$from_fromParts$$ = $trim$$($from_fromParts$$.split("/"));
					$to_toParts$$ = $trim$$($to_toParts$$.split("/"));
					for (var $length$jscomp$16_outputParts$$ = Math.min($from_fromParts$$.length, $to_toParts$$.length), $samePartsLength$$ = $length$jscomp$16_outputParts$$, $i$jscomp$6$$ = 0; $i$jscomp$6$$ < $length$jscomp$16_outputParts$$; $i$jscomp$6$$++) if ($from_fromParts$$[$i$jscomp$6$$] !== $to_toParts$$[$i$jscomp$6$$]) {
						$samePartsLength$$ = $i$jscomp$6$$;
						break;
					}
					$length$jscomp$16_outputParts$$ = [];
					for ($i$jscomp$6$$ = $samePartsLength$$; $i$jscomp$6$$ < $from_fromParts$$.length; $i$jscomp$6$$++) $length$jscomp$16_outputParts$$.push("..");
					$length$jscomp$16_outputParts$$ = $length$jscomp$16_outputParts$$.concat($to_toParts$$.slice($samePartsLength$$));
					return $length$jscomp$16_outputParts$$.join("/");
				}, $UTF8Decoder$$ = globalThis.TextDecoder && new TextDecoder(), $UTF8ArrayToString$$ = ($heapOrArray$jscomp$1$$, $idx$jscomp$1$$ = 0, $maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_31_str$jscomp$7$$) => {
					$idx$jscomp$1$$ >>>= 0;
					var $endPtr_idx$jscomp$inline_28$$ = $idx$jscomp$1$$;
					for ($maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_31_str$jscomp$7$$ = $endPtr_idx$jscomp$inline_28$$ + $maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_31_str$jscomp$7$$; $heapOrArray$jscomp$1$$[$endPtr_idx$jscomp$inline_28$$] && !($endPtr_idx$jscomp$inline_28$$ >= $maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_31_str$jscomp$7$$);) ++$endPtr_idx$jscomp$inline_28$$;
					if (16 < $endPtr_idx$jscomp$inline_28$$ - $idx$jscomp$1$$ && $heapOrArray$jscomp$1$$.buffer && $UTF8Decoder$$) return $UTF8Decoder$$.decode($heapOrArray$jscomp$1$$.subarray($idx$jscomp$1$$, $endPtr_idx$jscomp$inline_28$$));
					for ($maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_31_str$jscomp$7$$ = ""; $idx$jscomp$1$$ < $endPtr_idx$jscomp$inline_28$$;) {
						var $ch_u0$$ = $heapOrArray$jscomp$1$$[$idx$jscomp$1$$++];
						if ($ch_u0$$ & 128) {
							var $u1$$ = $heapOrArray$jscomp$1$$[$idx$jscomp$1$$++] & 63;
							if (192 == ($ch_u0$$ & 224)) $maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_31_str$jscomp$7$$ += String.fromCharCode(($ch_u0$$ & 31) << 6 | $u1$$);
							else {
								var $u2$$ = $heapOrArray$jscomp$1$$[$idx$jscomp$1$$++] & 63;
								224 == ($ch_u0$$ & 240) ? $ch_u0$$ = ($ch_u0$$ & 15) << 12 | $u1$$ << 6 | $u2$$ : (240 != ($ch_u0$$ & 248) && $warnOnce$$("Invalid UTF-8 leading byte " + $ptrToString$$($ch_u0$$) + " encountered when deserializing a UTF-8 string in wasm memory to a JS string!"), $ch_u0$$ = ($ch_u0$$ & 7) << 18 | $u1$$ << 12 | $u2$$ << 6 | $heapOrArray$jscomp$1$$[$idx$jscomp$1$$++] & 63);
								65536 > $ch_u0$$ ? $maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_31_str$jscomp$7$$ += String.fromCharCode($ch_u0$$) : ($ch_u0$$ -= 65536, $maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_31_str$jscomp$7$$ += String.fromCharCode(55296 | $ch_u0$$ >> 10, 56320 | $ch_u0$$ & 1023));
							}
						} else $maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_31_str$jscomp$7$$ += String.fromCharCode($ch_u0$$);
					}
					return $maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_31_str$jscomp$7$$;
				}, $FS_stdin_getChar_buffer$$ = [], $lengthBytesUTF8$$ = ($str$jscomp$8$$) => {
					for (var $len$$ = 0, $i$jscomp$7$$ = 0; $i$jscomp$7$$ < $str$jscomp$8$$.length; ++$i$jscomp$7$$) {
						var $c$$ = $str$jscomp$8$$.charCodeAt($i$jscomp$7$$);
						127 >= $c$$ ? $len$$++ : 2047 >= $c$$ ? $len$$ += 2 : 55296 <= $c$$ && 57343 >= $c$$ ? ($len$$ += 4, ++$i$jscomp$7$$) : $len$$ += 3;
					}
					return $len$$;
				}, $stringToUTF8Array$$ = ($str$jscomp$9$$, $heap$$, $outIdx$$, $endIdx_maxBytesToWrite$$) => {
					$outIdx$$ >>>= 0;
					$assert$$("string" === typeof $str$jscomp$9$$, `stringToUTF8Array expects a string (got ${typeof $str$jscomp$9$$})`);
					if (!(0 < $endIdx_maxBytesToWrite$$)) return 0;
					var $startIdx$$ = $outIdx$$;
					$endIdx_maxBytesToWrite$$ = $outIdx$$ + $endIdx_maxBytesToWrite$$ - 1;
					for (var $i$jscomp$8$$ = 0; $i$jscomp$8$$ < $str$jscomp$9$$.length; ++$i$jscomp$8$$) {
						var $u$$ = $str$jscomp$9$$.codePointAt($i$jscomp$8$$);
						if (127 >= $u$$) {
							if ($outIdx$$ >= $endIdx_maxBytesToWrite$$) break;
							$heap$$[$outIdx$$++ >>> 0] = $u$$;
						} else if (2047 >= $u$$) {
							if ($outIdx$$ + 1 >= $endIdx_maxBytesToWrite$$) break;
							$heap$$[$outIdx$$++ >>> 0] = 192 | $u$$ >> 6;
							$heap$$[$outIdx$$++ >>> 0] = 128 | $u$$ & 63;
						} else if (65535 >= $u$$) {
							if ($outIdx$$ + 2 >= $endIdx_maxBytesToWrite$$) break;
							$heap$$[$outIdx$$++ >>> 0] = 224 | $u$$ >> 12;
							$heap$$[$outIdx$$++ >>> 0] = 128 | $u$$ >> 6 & 63;
							$heap$$[$outIdx$$++ >>> 0] = 128 | $u$$ & 63;
						} else {
							if ($outIdx$$ + 3 >= $endIdx_maxBytesToWrite$$) break;
							1114111 < $u$$ && $warnOnce$$("Invalid Unicode code point " + $ptrToString$$($u$$) + " encountered when serializing a JS string to a UTF-8 string in wasm memory! (Valid unicode code points should be in range 0-0x10FFFF).");
							$heap$$[$outIdx$$++ >>> 0] = 240 | $u$$ >> 18;
							$heap$$[$outIdx$$++ >>> 0] = 128 | $u$$ >> 12 & 63;
							$heap$$[$outIdx$$++ >>> 0] = 128 | $u$$ >> 6 & 63;
							$heap$$[$outIdx$$++ >>> 0] = 128 | $u$$ & 63;
							$i$jscomp$8$$++;
						}
					}
					$heap$$[$outIdx$$ >>> 0] = 0;
					return $outIdx$$ - $startIdx$$;
				}, $intArrayFromString$$ = ($numBytesWritten_stringy$$) => {
					var $u8array$$ = Array($lengthBytesUTF8$$($numBytesWritten_stringy$$) + 1);
					$numBytesWritten_stringy$$ = $stringToUTF8Array$$($numBytesWritten_stringy$$, $u8array$$, 0, $u8array$$.length);
					$u8array$$.length = $numBytesWritten_stringy$$;
					return $u8array$$;
				}, $TTY$ttys$$ = [];
				function $TTY$register$$($dev$$, $ops$$) {
					$TTY$ttys$$[$dev$$] = {
						input: [],
						output: [],
						$ops$: $ops$$
					};
					$JSCompiler_StaticMethods_registerDevice$$($dev$$, $TTY$stream_ops$$);
				}
				var $TTY$stream_ops$$ = {
					open($stream$jscomp$4$$) {
						var $tty$$ = $TTY$ttys$$[$stream$jscomp$4$$.node.$rdev$];
						if (!$tty$$) throw new $FS$$.$ErrnoError$(43);
						$stream$jscomp$4$$.$tty$ = $tty$$;
						$stream$jscomp$4$$.seekable = !1;
					},
					close($stream$jscomp$5$$) {
						$stream$jscomp$5$$.$tty$.$ops$.$fsync$($stream$jscomp$5$$.$tty$);
					},
					$fsync$($stream$jscomp$6$$) {
						$stream$jscomp$6$$.$tty$.$ops$.$fsync$($stream$jscomp$6$$.$tty$);
					},
					read($stream$jscomp$7$$, $buffer$jscomp$18$$, $offset$jscomp$26$$, $length$jscomp$18$$) {
						if (!$stream$jscomp$7$$.$tty$ || !$stream$jscomp$7$$.$tty$.$ops$.$get_char$) throw new $FS$$.$ErrnoError$(60);
						for (var $bytesRead$$ = 0, $i$jscomp$9$$ = 0; $i$jscomp$9$$ < $length$jscomp$18$$; $i$jscomp$9$$++) {
							try {
								var $result$jscomp$5$$ = $stream$jscomp$7$$.$tty$.$ops$.$get_char$($stream$jscomp$7$$.$tty$);
							} catch ($e$jscomp$9$$) {
								throw new $FS$$.$ErrnoError$(29);
							}
							if (void 0 === $result$jscomp$5$$ && 0 === $bytesRead$$) throw new $FS$$.$ErrnoError$(6);
							if (null === $result$jscomp$5$$ || void 0 === $result$jscomp$5$$) break;
							$bytesRead$$++;
							$buffer$jscomp$18$$[$offset$jscomp$26$$ + $i$jscomp$9$$] = $result$jscomp$5$$;
						}
						$bytesRead$$ && ($stream$jscomp$7$$.node.$atime$ = Date.now());
						return $bytesRead$$;
					},
					write($stream$jscomp$8$$, $buffer$jscomp$19$$, $offset$jscomp$27$$, $length$jscomp$19$$) {
						if (!$stream$jscomp$8$$.$tty$ || !$stream$jscomp$8$$.$tty$.$ops$.$put_char$) throw new $FS$$.$ErrnoError$(60);
						try {
							for (var $i$jscomp$10$$ = 0; $i$jscomp$10$$ < $length$jscomp$19$$; $i$jscomp$10$$++) $stream$jscomp$8$$.$tty$.$ops$.$put_char$($stream$jscomp$8$$.$tty$, $buffer$jscomp$19$$[$offset$jscomp$27$$ + $i$jscomp$10$$]);
						} catch ($e$jscomp$10$$) {
							throw new $FS$$.$ErrnoError$(29);
						}
						$length$jscomp$19$$ && ($stream$jscomp$8$$.node.$mtime$ = $stream$jscomp$8$$.node.$ctime$ = Date.now());
						return $i$jscomp$10$$;
					}
				}, $TTY$default_tty_ops$$ = {
					$get_char$() {
						a: {
							if (!$FS_stdin_getChar_buffer$$.length) {
								var $JSCompiler_inline_result$jscomp$2_result$jscomp$inline_33$$ = null;
								globalThis.window?.prompt && ($JSCompiler_inline_result$jscomp$2_result$jscomp$inline_33$$ = window.prompt("Input: "), null !== $JSCompiler_inline_result$jscomp$2_result$jscomp$inline_33$$ && ($JSCompiler_inline_result$jscomp$2_result$jscomp$inline_33$$ += "\n"));
								if (!$JSCompiler_inline_result$jscomp$2_result$jscomp$inline_33$$) {
									$JSCompiler_inline_result$jscomp$2_result$jscomp$inline_33$$ = null;
									break a;
								}
								$FS_stdin_getChar_buffer$$ = $intArrayFromString$$($JSCompiler_inline_result$jscomp$2_result$jscomp$inline_33$$);
							}
							$JSCompiler_inline_result$jscomp$2_result$jscomp$inline_33$$ = $FS_stdin_getChar_buffer$$.shift();
						}
						return $JSCompiler_inline_result$jscomp$2_result$jscomp$inline_33$$;
					},
					$put_char$($tty$jscomp$2$$, $val$jscomp$1$$) {
						null === $val$jscomp$1$$ || 10 === $val$jscomp$1$$ ? ($out$$($UTF8ArrayToString$$($tty$jscomp$2$$.output)), $tty$jscomp$2$$.output = []) : 0 != $val$jscomp$1$$ && $tty$jscomp$2$$.output.push($val$jscomp$1$$);
					},
					$fsync$($tty$jscomp$3$$) {
						0 < $tty$jscomp$3$$.output?.length && ($out$$($UTF8ArrayToString$$($tty$jscomp$3$$.output)), $tty$jscomp$3$$.output = []);
					},
					$ioctl_tcgets$() {
						return {
							$c_iflag$: 25856,
							$c_oflag$: 5,
							$c_cflag$: 191,
							$c_lflag$: 35387,
							$c_cc$: [
								3,
								28,
								127,
								21,
								4,
								0,
								1,
								0,
								17,
								19,
								26,
								0,
								18,
								15,
								23,
								22,
								0,
								0,
								0,
								0,
								0,
								0,
								0,
								0,
								0,
								0,
								0,
								0,
								0,
								0,
								0,
								0
							]
						};
					},
					$ioctl_tcsets$() {
						return 0;
					},
					$ioctl_tiocgwinsz$() {
						return [24, 80];
					}
				}, $TTY$default_tty1_ops$$ = {
					$put_char$($tty$jscomp$7$$, $val$jscomp$2$$) {
						null === $val$jscomp$2$$ || 10 === $val$jscomp$2$$ ? ($err$$($UTF8ArrayToString$$($tty$jscomp$7$$.output)), $tty$jscomp$7$$.output = []) : 0 != $val$jscomp$2$$ && $tty$jscomp$7$$.output.push($val$jscomp$2$$);
					},
					$fsync$($tty$jscomp$8$$) {
						0 < $tty$jscomp$8$$.output?.length && ($err$$($UTF8ArrayToString$$($tty$jscomp$8$$.output)), $tty$jscomp$8$$.output = []);
					}
				}, $alignMemory$$ = ($size$jscomp$22$$) => {
					$assert$$(65536, "alignment argument is required");
					return 65536 * Math.ceil($size$jscomp$22$$ / 65536);
				}, $mmapAlloc$$ = ($size$jscomp$23$$) => {
					$size$jscomp$23$$ = $alignMemory$$($size$jscomp$23$$);
					var $ptr$jscomp$2$$ = $_emscripten_builtin_memalign$$(65536, $size$jscomp$23$$);
					$ptr$jscomp$2$$ && $HEAPU8$$.fill(0, $ptr$jscomp$2$$, $ptr$jscomp$2$$ + $size$jscomp$23$$);
					return $ptr$jscomp$2$$;
				}, $MEMFS$$ = {
					$ops_table$: null,
					$mount$() {
						return $MEMFS$$.createNode(null, "/", 16895, 0);
					},
					createNode($parent$jscomp$4$$, $name$jscomp$77$$, $mode$jscomp$15_node$jscomp$5$$, $dev$jscomp$1$$) {
						var $JSCompiler_temp$jscomp$7$$;
						($JSCompiler_temp$jscomp$7$$ = 24576 === ($mode$jscomp$15_node$jscomp$5$$ & 61440)) || ($JSCompiler_temp$jscomp$7$$ = 4096 === ($mode$jscomp$15_node$jscomp$5$$ & 61440));
						if ($JSCompiler_temp$jscomp$7$$) throw new $FS$$.$ErrnoError$(63);
						$MEMFS$$.$ops_table$ || ($MEMFS$$.$ops_table$ = {
							dir: {
								node: {
									$getattr$: $MEMFS$$.$node_ops$.$getattr$,
									$setattr$: $MEMFS$$.$node_ops$.$setattr$,
									$lookup$: $MEMFS$$.$node_ops$.$lookup$,
									$mknod$: $MEMFS$$.$node_ops$.$mknod$,
									$rename$: $MEMFS$$.$node_ops$.$rename$,
									$unlink$: $MEMFS$$.$node_ops$.$unlink$,
									$rmdir$: $MEMFS$$.$node_ops$.$rmdir$,
									$readdir$: $MEMFS$$.$node_ops$.$readdir$,
									$symlink$: $MEMFS$$.$node_ops$.$symlink$
								},
								stream: { $llseek$: $MEMFS$$.$stream_ops$.$llseek$ }
							},
							file: {
								node: {
									$getattr$: $MEMFS$$.$node_ops$.$getattr$,
									$setattr$: $MEMFS$$.$node_ops$.$setattr$
								},
								stream: {
									$llseek$: $MEMFS$$.$stream_ops$.$llseek$,
									read: $MEMFS$$.$stream_ops$.read,
									write: $MEMFS$$.$stream_ops$.write,
									$mmap$: $MEMFS$$.$stream_ops$.$mmap$,
									$msync$: $MEMFS$$.$stream_ops$.$msync$
								}
							},
							link: {
								node: {
									$getattr$: $MEMFS$$.$node_ops$.$getattr$,
									$setattr$: $MEMFS$$.$node_ops$.$setattr$,
									$readlink$: $MEMFS$$.$node_ops$.$readlink$
								},
								stream: {}
							},
							$chrdev$: {
								node: {
									$getattr$: $MEMFS$$.$node_ops$.$getattr$,
									$setattr$: $MEMFS$$.$node_ops$.$setattr$
								},
								stream: $FS$$.$chrdev_stream_ops$
							}
						});
						$mode$jscomp$15_node$jscomp$5$$ = $FS$$.createNode($parent$jscomp$4$$, $name$jscomp$77$$, $mode$jscomp$15_node$jscomp$5$$, $dev$jscomp$1$$);
						$JSCompiler_StaticMethods_isDir$$($mode$jscomp$15_node$jscomp$5$$.mode) ? ($mode$jscomp$15_node$jscomp$5$$.$node_ops$ = $MEMFS$$.$ops_table$.dir.node, $mode$jscomp$15_node$jscomp$5$$.$stream_ops$ = $MEMFS$$.$ops_table$.dir.stream, $mode$jscomp$15_node$jscomp$5$$.$contents$ = {}) : $FS$$.isFile($mode$jscomp$15_node$jscomp$5$$.mode) ? ($mode$jscomp$15_node$jscomp$5$$.$node_ops$ = $MEMFS$$.$ops_table$.file.node, $mode$jscomp$15_node$jscomp$5$$.$stream_ops$ = $MEMFS$$.$ops_table$.file.stream, $mode$jscomp$15_node$jscomp$5$$.$usedBytes$ = 0, $mode$jscomp$15_node$jscomp$5$$.$contents$ = $MEMFS$$.$emptyFileContents$ ?? ($MEMFS$$.$emptyFileContents$ = /* @__PURE__ */ new Uint8Array(0))) : 40960 === ($mode$jscomp$15_node$jscomp$5$$.mode & 61440) ? ($mode$jscomp$15_node$jscomp$5$$.$node_ops$ = $MEMFS$$.$ops_table$.link.node, $mode$jscomp$15_node$jscomp$5$$.$stream_ops$ = $MEMFS$$.$ops_table$.link.stream) : 8192 === ($mode$jscomp$15_node$jscomp$5$$.mode & 61440) && ($mode$jscomp$15_node$jscomp$5$$.$node_ops$ = $MEMFS$$.$ops_table$.$chrdev$.node, $mode$jscomp$15_node$jscomp$5$$.$stream_ops$ = $MEMFS$$.$ops_table$.$chrdev$.stream);
						$mode$jscomp$15_node$jscomp$5$$.$atime$ = $mode$jscomp$15_node$jscomp$5$$.$mtime$ = $mode$jscomp$15_node$jscomp$5$$.$ctime$ = Date.now();
						$parent$jscomp$4$$ && ($parent$jscomp$4$$.$contents$[$name$jscomp$77$$] = $mode$jscomp$15_node$jscomp$5$$, $parent$jscomp$4$$.$atime$ = $parent$jscomp$4$$.$mtime$ = $parent$jscomp$4$$.$ctime$ = $mode$jscomp$15_node$jscomp$5$$.$atime$);
						return $mode$jscomp$15_node$jscomp$5$$;
					},
					$node_ops$: {
						$getattr$($node$jscomp$9$$) {
							var $attr$$ = {};
							$attr$$.$dev$ = 8192 === ($node$jscomp$9$$.mode & 61440) ? $node$jscomp$9$$.id : 1;
							$attr$$.$ino$ = $node$jscomp$9$$.id;
							$attr$$.mode = $node$jscomp$9$$.mode;
							$attr$$.$nlink$ = 1;
							$attr$$.uid = 0;
							$attr$$.$gid$ = 0;
							$attr$$.$rdev$ = $node$jscomp$9$$.$rdev$;
							$JSCompiler_StaticMethods_isDir$$($node$jscomp$9$$.mode) ? $attr$$.size = 4096 : $FS$$.isFile($node$jscomp$9$$.mode) ? $attr$$.size = $node$jscomp$9$$.$usedBytes$ : 40960 === ($node$jscomp$9$$.mode & 61440) ? $attr$$.size = $node$jscomp$9$$.link.length : $attr$$.size = 0;
							$attr$$.$atime$ = new Date($node$jscomp$9$$.$atime$);
							$attr$$.$mtime$ = new Date($node$jscomp$9$$.$mtime$);
							$attr$$.$ctime$ = new Date($node$jscomp$9$$.$ctime$);
							$attr$$.$blksize$ = 4096;
							$attr$$.$blocks$ = Math.ceil($attr$$.size / $attr$$.$blksize$);
							return $attr$$;
						},
						$setattr$($node$jscomp$10$$, $attr$jscomp$1_newSize$jscomp$inline_45$$) {
							for (var $key$jscomp$39_oldContents$jscomp$inline_47$$ of [
								"mode",
								"atime",
								"mtime",
								"ctime"
							]) null != $attr$jscomp$1_newSize$jscomp$inline_45$$[$key$jscomp$39_oldContents$jscomp$inline_47$$] && ($node$jscomp$10$$[$key$jscomp$39_oldContents$jscomp$inline_47$$] = $attr$jscomp$1_newSize$jscomp$inline_45$$[$key$jscomp$39_oldContents$jscomp$inline_47$$]);
							void 0 !== $attr$jscomp$1_newSize$jscomp$inline_45$$.size && ($attr$jscomp$1_newSize$jscomp$inline_45$$ = $attr$jscomp$1_newSize$jscomp$inline_45$$.size, $node$jscomp$10$$.$usedBytes$ != $attr$jscomp$1_newSize$jscomp$inline_45$$ && ($key$jscomp$39_oldContents$jscomp$inline_47$$ = $node$jscomp$10$$.$contents$, $node$jscomp$10$$.$contents$ = new Uint8Array($attr$jscomp$1_newSize$jscomp$inline_45$$), $node$jscomp$10$$.$contents$.set($key$jscomp$39_oldContents$jscomp$inline_47$$.subarray(0, Math.min($attr$jscomp$1_newSize$jscomp$inline_45$$, $node$jscomp$10$$.$usedBytes$))), $node$jscomp$10$$.$usedBytes$ = $attr$jscomp$1_newSize$jscomp$inline_45$$));
						},
						$lookup$() {
							throw new $FS$$.$ErrnoError$(44);
						},
						$mknod$($parent$jscomp$6$$, $name$jscomp$79$$, $mode$jscomp$16$$, $dev$jscomp$2$$) {
							return $MEMFS$$.createNode($parent$jscomp$6$$, $name$jscomp$79$$, $mode$jscomp$16$$, $dev$jscomp$2$$);
						},
						$rename$($old_node$$, $new_dir$$, $new_name$$) {
							try {
								var $new_node$$ = $JSCompiler_StaticMethods_lookupNode$$($new_dir$$, $new_name$$);
							} catch ($e$jscomp$11$$) {}
							if ($new_node$$) {
								if ($JSCompiler_StaticMethods_isDir$$($old_node$$.mode)) for (var $i$jscomp$11$$ in $new_node$$.$contents$) throw new $FS$$.$ErrnoError$(55);
								$JSCompiler_StaticMethods_hashRemoveNode$$($new_node$$);
							}
							delete $old_node$$.parent.$contents$[$old_node$$.name];
							$new_dir$$.$contents$[$new_name$$] = $old_node$$;
							$old_node$$.name = $new_name$$;
							$new_dir$$.$ctime$ = $new_dir$$.$mtime$ = $old_node$$.parent.$ctime$ = $old_node$$.parent.$mtime$ = Date.now();
						},
						$unlink$($parent$jscomp$7$$, $name$jscomp$80$$) {
							delete $parent$jscomp$7$$.$contents$[$name$jscomp$80$$];
							$parent$jscomp$7$$.$ctime$ = $parent$jscomp$7$$.$mtime$ = Date.now();
						},
						$rmdir$($parent$jscomp$8$$, $name$jscomp$81$$) {
							var $node$jscomp$11$$ = $JSCompiler_StaticMethods_lookupNode$$($parent$jscomp$8$$, $name$jscomp$81$$), $i$jscomp$12$$;
							for ($i$jscomp$12$$ in $node$jscomp$11$$.$contents$) throw new $FS$$.$ErrnoError$(55);
							delete $parent$jscomp$8$$.$contents$[$name$jscomp$81$$];
							$parent$jscomp$8$$.$ctime$ = $parent$jscomp$8$$.$mtime$ = Date.now();
						},
						$readdir$($node$jscomp$12$$) {
							return [
								".",
								"..",
								...Object.keys($node$jscomp$12$$.$contents$)
							];
						},
						$symlink$($node$jscomp$13_parent$jscomp$9$$, $newname$$, $oldpath$$) {
							$node$jscomp$13_parent$jscomp$9$$ = $MEMFS$$.createNode($node$jscomp$13_parent$jscomp$9$$, $newname$$, 41471, 0);
							$node$jscomp$13_parent$jscomp$9$$.link = $oldpath$$;
							return $node$jscomp$13_parent$jscomp$9$$;
						},
						$readlink$($node$jscomp$14$$) {
							if (40960 !== ($node$jscomp$14$$.mode & 61440)) throw new $FS$$.$ErrnoError$(28);
							return $node$jscomp$14$$.link;
						}
					},
					$stream_ops$: {
						read($size$jscomp$24_stream$jscomp$9$$, $buffer$jscomp$20$$, $offset$jscomp$28$$, $length$jscomp$20$$, $position$jscomp$1$$) {
							var $contents$jscomp$2$$ = $size$jscomp$24_stream$jscomp$9$$.node.$contents$;
							if ($position$jscomp$1$$ >= $size$jscomp$24_stream$jscomp$9$$.node.$usedBytes$) return 0;
							$size$jscomp$24_stream$jscomp$9$$ = Math.min($size$jscomp$24_stream$jscomp$9$$.node.$usedBytes$ - $position$jscomp$1$$, $length$jscomp$20$$);
							$assert$$(0 <= $size$jscomp$24_stream$jscomp$9$$);
							$buffer$jscomp$20$$.set($contents$jscomp$2$$.subarray($position$jscomp$1$$, $position$jscomp$1$$ + $size$jscomp$24_stream$jscomp$9$$), $offset$jscomp$28$$);
							return $size$jscomp$24_stream$jscomp$9$$;
						},
						write($node$jscomp$15_stream$jscomp$10$$, $buffer$jscomp$21$$, $offset$jscomp$29$$, $length$jscomp$21$$, $position$jscomp$2$$, $canOwn_newCapacity$jscomp$inline_50$$) {
							$assert$$($buffer$jscomp$21$$.subarray, "FS.write expects a TypedArray");
							$buffer$jscomp$21$$.buffer === $HEAP8$$.buffer && ($canOwn_newCapacity$jscomp$inline_50$$ = !1);
							if (!$length$jscomp$21$$) return 0;
							$node$jscomp$15_stream$jscomp$10$$ = $node$jscomp$15_stream$jscomp$10$$.node;
							$node$jscomp$15_stream$jscomp$10$$.$mtime$ = $node$jscomp$15_stream$jscomp$10$$.$ctime$ = Date.now();
							if ($canOwn_newCapacity$jscomp$inline_50$$) $assert$$(0 === $position$jscomp$2$$, "canOwn must imply no weird position inside the file"), $node$jscomp$15_stream$jscomp$10$$.$contents$ = $buffer$jscomp$21$$.subarray($offset$jscomp$29$$, $offset$jscomp$29$$ + $length$jscomp$21$$), $node$jscomp$15_stream$jscomp$10$$.$usedBytes$ = $length$jscomp$21$$;
							else if (0 === $node$jscomp$15_stream$jscomp$10$$.$usedBytes$ && 0 === $position$jscomp$2$$) $node$jscomp$15_stream$jscomp$10$$.$contents$ = $buffer$jscomp$21$$.slice($offset$jscomp$29$$, $offset$jscomp$29$$ + $length$jscomp$21$$), $node$jscomp$15_stream$jscomp$10$$.$usedBytes$ = $length$jscomp$21$$;
							else {
								$canOwn_newCapacity$jscomp$inline_50$$ = $position$jscomp$2$$ + $length$jscomp$21$$;
								var $oldContents$jscomp$inline_53_prevCapacity$jscomp$inline_52$$ = $node$jscomp$15_stream$jscomp$10$$.$contents$.length;
								$oldContents$jscomp$inline_53_prevCapacity$jscomp$inline_52$$ >= $canOwn_newCapacity$jscomp$inline_50$$ || ($canOwn_newCapacity$jscomp$inline_50$$ = Math.max($canOwn_newCapacity$jscomp$inline_50$$, $oldContents$jscomp$inline_53_prevCapacity$jscomp$inline_52$$ * (1048576 > $oldContents$jscomp$inline_53_prevCapacity$jscomp$inline_52$$ ? 2 : 1.125) >>> 0), $oldContents$jscomp$inline_53_prevCapacity$jscomp$inline_52$$ && ($canOwn_newCapacity$jscomp$inline_50$$ = Math.max($canOwn_newCapacity$jscomp$inline_50$$, 256)), $assert$$($FS$$.isFile($node$jscomp$15_stream$jscomp$10$$.mode), "getFileDataAsTypedArray called on non-file"), $oldContents$jscomp$inline_53_prevCapacity$jscomp$inline_52$$ = $node$jscomp$15_stream$jscomp$10$$.$contents$.subarray(0, $node$jscomp$15_stream$jscomp$10$$.$usedBytes$), $node$jscomp$15_stream$jscomp$10$$.$contents$ = new Uint8Array($canOwn_newCapacity$jscomp$inline_50$$), $node$jscomp$15_stream$jscomp$10$$.$contents$.set($oldContents$jscomp$inline_53_prevCapacity$jscomp$inline_52$$));
								$node$jscomp$15_stream$jscomp$10$$.$contents$.set($buffer$jscomp$21$$.subarray($offset$jscomp$29$$, $offset$jscomp$29$$ + $length$jscomp$21$$), $position$jscomp$2$$);
								$node$jscomp$15_stream$jscomp$10$$.$usedBytes$ = Math.max($node$jscomp$15_stream$jscomp$10$$.$usedBytes$, $position$jscomp$2$$ + $length$jscomp$21$$);
							}
							return $length$jscomp$21$$;
						},
						$llseek$($stream$jscomp$11$$, $offset$jscomp$30_position$jscomp$3$$, $whence$$) {
							1 === $whence$$ ? $offset$jscomp$30_position$jscomp$3$$ += $stream$jscomp$11$$.position : 2 === $whence$$ && $FS$$.isFile($stream$jscomp$11$$.node.mode) && ($offset$jscomp$30_position$jscomp$3$$ += $stream$jscomp$11$$.node.$usedBytes$);
							if (0 > $offset$jscomp$30_position$jscomp$3$$) throw new $FS$$.$ErrnoError$(28);
							return $offset$jscomp$30_position$jscomp$3$$;
						},
						$mmap$($contents$jscomp$3_stream$jscomp$12$$, $length$jscomp$22$$, $position$jscomp$4$$, $allocated_prot$$, $flags$jscomp$6_ptr$jscomp$3$$) {
							if (!$FS$$.isFile($contents$jscomp$3_stream$jscomp$12$$.node.mode)) throw new $FS$$.$ErrnoError$(43);
							$contents$jscomp$3_stream$jscomp$12$$ = $contents$jscomp$3_stream$jscomp$12$$.node.$contents$;
							if ($flags$jscomp$6_ptr$jscomp$3$$ & 2 || $contents$jscomp$3_stream$jscomp$12$$.buffer !== $HEAP8$$.buffer) {
								$allocated_prot$$ = !0;
								$flags$jscomp$6_ptr$jscomp$3$$ = $mmapAlloc$$($length$jscomp$22$$);
								if (!$flags$jscomp$6_ptr$jscomp$3$$) throw new $FS$$.$ErrnoError$(48);
								if ($contents$jscomp$3_stream$jscomp$12$$) {
									if (0 < $position$jscomp$4$$ || $position$jscomp$4$$ + $length$jscomp$22$$ < $contents$jscomp$3_stream$jscomp$12$$.length) $contents$jscomp$3_stream$jscomp$12$$.subarray ? $contents$jscomp$3_stream$jscomp$12$$ = $contents$jscomp$3_stream$jscomp$12$$.subarray($position$jscomp$4$$, $position$jscomp$4$$ + $length$jscomp$22$$) : $contents$jscomp$3_stream$jscomp$12$$ = Array.prototype.slice.call($contents$jscomp$3_stream$jscomp$12$$, $position$jscomp$4$$, $position$jscomp$4$$ + $length$jscomp$22$$);
									$HEAP8$$.set($contents$jscomp$3_stream$jscomp$12$$, $flags$jscomp$6_ptr$jscomp$3$$ >>> 0);
								}
							} else $allocated_prot$$ = !1, $flags$jscomp$6_ptr$jscomp$3$$ = $contents$jscomp$3_stream$jscomp$12$$.byteOffset;
							return {
								$ptr$: $flags$jscomp$6_ptr$jscomp$3$$,
								$allocated$: $allocated_prot$$
							};
						},
						$msync$($stream$jscomp$13$$, $buffer$jscomp$22$$, $offset$jscomp$31$$, $length$jscomp$23$$) {
							$MEMFS$$.$stream_ops$.write($stream$jscomp$13$$, $buffer$jscomp$22$$, 0, $length$jscomp$23$$, $offset$jscomp$31$$, !1);
							return 0;
						}
					}
				}, $FS_fileDataToTypedArray$$ = ($data$jscomp$82$$) => {
					"string" == typeof $data$jscomp$82$$ && ($data$jscomp$82$$ = $intArrayFromString$$($data$jscomp$82$$));
					$data$jscomp$82$$.subarray || ($data$jscomp$82$$ = new Uint8Array($data$jscomp$82$$));
					return $data$jscomp$82$$;
				}, $FS_getMode$$ = ($canRead$$, $canWrite$$) => {
					var $mode$jscomp$17$$ = 0;
					$canRead$$ && ($mode$jscomp$17$$ |= 365);
					$canWrite$$ && ($mode$jscomp$17$$ |= 146);
					return $mode$jscomp$17$$;
				}, $WORKERFS$$ = {
					$DIR_MODE$: 16895,
					$FILE_MODE$: 33279,
					$reader$: null,
					$mount$($mount$jscomp$1_name$jscomp$82$$) {
						function $ensureParent$$($parts$jscomp$1_path$jscomp$11$$) {
							$parts$jscomp$1_path$jscomp$11$$ = $parts$jscomp$1_path$jscomp$11$$.split("/");
							for (var $parent$jscomp$10$$ = $root$jscomp$4$$, $i$jscomp$13$$ = 0; $i$jscomp$13$$ < $parts$jscomp$1_path$jscomp$11$$.length - 1; $i$jscomp$13$$++) {
								var $curr$$ = $parts$jscomp$1_path$jscomp$11$$.slice(0, $i$jscomp$13$$ + 1).join("/");
								let $$jscomp$logical$assign$tmp301936253$3$$, $$jscomp$logical$assign$tmpindex301936253$3$$;
								($$jscomp$logical$assign$tmp301936253$3$$ = $createdParents$$)[$$jscomp$logical$assign$tmpindex301936253$3$$ = $curr$$] || ($$jscomp$logical$assign$tmp301936253$3$$[$$jscomp$logical$assign$tmpindex301936253$3$$] = $WORKERFS$$.createNode($parent$jscomp$10$$, $parts$jscomp$1_path$jscomp$11$$[$i$jscomp$13$$], $WORKERFS$$.$DIR_MODE$, 0));
								$parent$jscomp$10$$ = $createdParents$$[$curr$$];
							}
							return $parent$jscomp$10$$;
						}
						function $base$jscomp$3$$($parts$jscomp$2_path$jscomp$12$$) {
							$parts$jscomp$2_path$jscomp$12$$ = $parts$jscomp$2_path$jscomp$12$$.split("/");
							return $parts$jscomp$2_path$jscomp$12$$[$parts$jscomp$2_path$jscomp$12$$.length - 1];
						}
						$assert$$($ENVIRONMENT_IS_WORKER$$);
						$WORKERFS$$.$reader$ ?? ($WORKERFS$$.$reader$ = new FileReaderSync());
						var $root$jscomp$4$$ = $WORKERFS$$.createNode(null, "/", $WORKERFS$$.$DIR_MODE$, 0), $createdParents$$ = {}, $file$jscomp$1$$;
						for ($file$jscomp$1$$ of $mount$jscomp$1_name$jscomp$82$$.$opts$.files || []) $WORKERFS$$.createNode($ensureParent$$($file$jscomp$1$$.name), $base$jscomp$3$$($file$jscomp$1$$.name), $WORKERFS$$.$FILE_MODE$, 0, $file$jscomp$1$$, $file$jscomp$1$$.lastModifiedDate);
						for (var $obj$jscomp$29$$ of $mount$jscomp$1_name$jscomp$82$$.$opts$.blobs || []) $WORKERFS$$.createNode($ensureParent$$($obj$jscomp$29$$.name), $base$jscomp$3$$($obj$jscomp$29$$.name), $WORKERFS$$.$FILE_MODE$, 0, $obj$jscomp$29$$.data);
						for (var $pack$$ of $mount$jscomp$1_name$jscomp$82$$.$opts$.packages || []) for ($file$jscomp$1$$ of $pack$$.metadata.files) $mount$jscomp$1_name$jscomp$82$$ = $file$jscomp$1$$.filename.slice(1), $WORKERFS$$.createNode($ensureParent$$($mount$jscomp$1_name$jscomp$82$$), $base$jscomp$3$$($mount$jscomp$1_name$jscomp$82$$), $WORKERFS$$.$FILE_MODE$, 0, $pack$$.blob.slice($file$jscomp$1$$.start, $file$jscomp$1$$.end));
						return $root$jscomp$4$$;
					},
					createNode($parent$jscomp$11$$, $name$jscomp$83$$, $mode$jscomp$18$$, $dev$jscomp$3_node$jscomp$16$$, $contents$jscomp$4$$, $mtime$$) {
						$dev$jscomp$3_node$jscomp$16$$ = $FS$$.createNode($parent$jscomp$11$$, $name$jscomp$83$$, $mode$jscomp$18$$);
						$dev$jscomp$3_node$jscomp$16$$.mode = $mode$jscomp$18$$;
						$dev$jscomp$3_node$jscomp$16$$.$node_ops$ = $WORKERFS$$.$node_ops$;
						$dev$jscomp$3_node$jscomp$16$$.$stream_ops$ = $WORKERFS$$.$stream_ops$;
						$dev$jscomp$3_node$jscomp$16$$.$atime$ = $dev$jscomp$3_node$jscomp$16$$.$mtime$ = $dev$jscomp$3_node$jscomp$16$$.$ctime$ = ($mtime$$ || /* @__PURE__ */ new Date()).getTime();
						$assert$$($WORKERFS$$.$FILE_MODE$ !== $WORKERFS$$.$DIR_MODE$);
						$mode$jscomp$18$$ === $WORKERFS$$.$FILE_MODE$ ? ($dev$jscomp$3_node$jscomp$16$$.size = $contents$jscomp$4$$.size, $dev$jscomp$3_node$jscomp$16$$.$contents$ = $contents$jscomp$4$$) : ($dev$jscomp$3_node$jscomp$16$$.size = 4096, $dev$jscomp$3_node$jscomp$16$$.$contents$ = {});
						$parent$jscomp$11$$ && ($parent$jscomp$11$$.$contents$[$name$jscomp$83$$] = $dev$jscomp$3_node$jscomp$16$$);
						return $dev$jscomp$3_node$jscomp$16$$;
					},
					$node_ops$: {
						$getattr$($node$jscomp$17$$) {
							return {
								$dev$: 1,
								$ino$: $node$jscomp$17$$.id,
								mode: $node$jscomp$17$$.mode,
								$nlink$: 1,
								uid: 0,
								$gid$: 0,
								$rdev$: 0,
								size: $node$jscomp$17$$.size,
								$atime$: new Date($node$jscomp$17$$.$atime$),
								$mtime$: new Date($node$jscomp$17$$.$mtime$),
								$ctime$: new Date($node$jscomp$17$$.$ctime$),
								$blksize$: 4096,
								$blocks$: Math.ceil($node$jscomp$17$$.size / 4096)
							};
						},
						$setattr$($node$jscomp$18$$, $attr$jscomp$2$$) {
							for (const $key$jscomp$40$$ of [
								"mode",
								"atime",
								"mtime",
								"ctime"
							]) null != $attr$jscomp$2$$[$key$jscomp$40$$] && ($node$jscomp$18$$[$key$jscomp$40$$] = $attr$jscomp$2$$[$key$jscomp$40$$]);
						},
						$lookup$() {
							throw new $FS$$.$ErrnoError$(44);
						},
						$mknod$() {
							throw new $FS$$.$ErrnoError$(63);
						},
						$rename$() {
							throw new $FS$$.$ErrnoError$(63);
						},
						$unlink$() {
							throw new $FS$$.$ErrnoError$(63);
						},
						$rmdir$() {
							throw new $FS$$.$ErrnoError$(63);
						},
						$readdir$($node$jscomp$19$$) {
							var $entries$$ = [".", ".."], $key$jscomp$41$$;
							for ($key$jscomp$41$$ of Object.keys($node$jscomp$19$$.$contents$)) $entries$$.push($key$jscomp$41$$);
							return $entries$$;
						},
						$symlink$() {
							throw new $FS$$.$ErrnoError$(63);
						}
					},
					$stream_ops$: {
						read($chunk$jscomp$6_stream$jscomp$14$$, $buffer$jscomp$23$$, $offset$jscomp$32$$, $ab_length$jscomp$24$$, $position$jscomp$5$$) {
							if ($position$jscomp$5$$ >= $chunk$jscomp$6_stream$jscomp$14$$.node.size) return 0;
							$chunk$jscomp$6_stream$jscomp$14$$ = $chunk$jscomp$6_stream$jscomp$14$$.node.$contents$.slice($position$jscomp$5$$, $position$jscomp$5$$ + $ab_length$jscomp$24$$);
							$ab_length$jscomp$24$$ = $WORKERFS$$.$reader$.readAsArrayBuffer($chunk$jscomp$6_stream$jscomp$14$$);
							$buffer$jscomp$23$$.set(new Uint8Array($ab_length$jscomp$24$$), $offset$jscomp$32$$);
							return $chunk$jscomp$6_stream$jscomp$14$$.size;
						},
						write() {
							throw new $FS$$.$ErrnoError$(29);
						},
						$llseek$($stream$jscomp$16$$, $offset$jscomp$34_position$jscomp$7$$, $whence$jscomp$1$$) {
							1 === $whence$jscomp$1$$ ? $offset$jscomp$34_position$jscomp$7$$ += $stream$jscomp$16$$.position : 2 === $whence$jscomp$1$$ && $FS$$.isFile($stream$jscomp$16$$.node.mode) && ($offset$jscomp$34_position$jscomp$7$$ += $stream$jscomp$16$$.node.size);
							if (0 > $offset$jscomp$34_position$jscomp$7$$) throw new $FS$$.$ErrnoError$(28);
							return $offset$jscomp$34_position$jscomp$7$$;
						}
					}
				}, $UTF8ToString$$ = ($ptr$jscomp$4$$, $maxBytesToRead$jscomp$2$$) => {
					$assert$$("number" == typeof $ptr$jscomp$4$$, `UTF8ToString expects a number (got ${typeof $ptr$jscomp$4$$})`);
					return ($ptr$jscomp$4$$ >>>= 0) ? $UTF8ArrayToString$$($HEAPU8$$, $ptr$jscomp$4$$, $maxBytesToRead$jscomp$2$$) : "";
				}, $ERRNO_CODES$$ = {
					EPERM: 63,
					ENOENT: 44,
					ESRCH: 71,
					EINTR: 27,
					EIO: 29,
					ENXIO: 60,
					E2BIG: 1,
					ENOEXEC: 45,
					EBADF: 8,
					ECHILD: 12,
					EAGAIN: 6,
					EWOULDBLOCK: 6,
					ENOMEM: 48,
					EACCES: 2,
					EFAULT: 21,
					ENOTBLK: 105,
					EBUSY: 10,
					EEXIST: 20,
					EXDEV: 75,
					ENODEV: 43,
					ENOTDIR: 54,
					EISDIR: 31,
					EINVAL: 28,
					ENFILE: 41,
					EMFILE: 33,
					ENOTTY: 59,
					ETXTBSY: 74,
					EFBIG: 22,
					ENOSPC: 51,
					ESPIPE: 70,
					EROFS: 69,
					EMLINK: 34,
					EPIPE: 64,
					EDOM: 18,
					ERANGE: 68,
					ENOMSG: 49,
					EIDRM: 24,
					ECHRNG: 106,
					EL2NSYNC: 156,
					EL3HLT: 107,
					EL3RST: 108,
					ELNRNG: 109,
					EUNATCH: 110,
					ENOCSI: 111,
					EL2HLT: 112,
					EDEADLK: 16,
					ENOLCK: 46,
					EBADE: 113,
					EBADR: 114,
					EXFULL: 115,
					ENOANO: 104,
					EBADRQC: 103,
					EBADSLT: 102,
					EDEADLOCK: 16,
					EBFONT: 101,
					ENOSTR: 100,
					ENODATA: 116,
					ETIME: 117,
					ENOSR: 118,
					ENONET: 119,
					ENOPKG: 120,
					EREMOTE: 121,
					ENOLINK: 47,
					EADV: 122,
					ESRMNT: 123,
					ECOMM: 124,
					EPROTO: 65,
					EMULTIHOP: 36,
					EDOTDOT: 125,
					EBADMSG: 9,
					ENOTUNIQ: 126,
					EBADFD: 127,
					EREMCHG: 128,
					ELIBACC: 129,
					ELIBBAD: 130,
					ELIBSCN: 131,
					ELIBMAX: 132,
					ELIBEXEC: 133,
					ENOSYS: 52,
					ENOTEMPTY: 55,
					ENAMETOOLONG: 37,
					ELOOP: 32,
					EOPNOTSUPP: 138,
					EPFNOSUPPORT: 139,
					ECONNRESET: 15,
					ENOBUFS: 42,
					EAFNOSUPPORT: 5,
					EPROTOTYPE: 67,
					ENOTSOCK: 57,
					ENOPROTOOPT: 50,
					ESHUTDOWN: 140,
					ECONNREFUSED: 14,
					EADDRINUSE: 3,
					ECONNABORTED: 13,
					ENETUNREACH: 40,
					ENETDOWN: 38,
					ETIMEDOUT: 73,
					EHOSTDOWN: 142,
					EHOSTUNREACH: 23,
					EINPROGRESS: 26,
					EALREADY: 7,
					EDESTADDRREQ: 17,
					EMSGSIZE: 35,
					EPROTONOSUPPORT: 66,
					ESOCKTNOSUPPORT: 137,
					EADDRNOTAVAIL: 4,
					ENETRESET: 39,
					EISCONN: 30,
					ENOTCONN: 53,
					ETOOMANYREFS: 141,
					EUSERS: 136,
					EDQUOT: 19,
					ESTALE: 72,
					ENOTSUP: 138,
					ENOMEDIUM: 148,
					EILSEQ: 25,
					EOVERFLOW: 61,
					ECANCELED: 11,
					ENOTRECOVERABLE: 56,
					EOWNERDEAD: 62,
					ESTRPIPE: 135
				}, $asyncLoad$$ = async ($url$jscomp$26$$) => {
					var $arrayBuffer$$ = await $readAsync$$($url$jscomp$26$$);
					$assert$$($arrayBuffer$$, `Loading data file "${$url$jscomp$26$$}" failed (no arrayBuffer).`);
					return new Uint8Array($arrayBuffer$$);
				}, $runDependencies$$ = 0, $dependenciesFulfilled$$ = null, $runDependencyTracking$$ = {}, $runDependencyWatcher$$ = null, $addRunDependency$$ = ($id$jscomp$8$$) => {
					$runDependencies$$++;
					$Module$$.monitorRunDependencies?.($runDependencies$$);
					$assert$$($id$jscomp$8$$, "addRunDependency requires an ID");
					$assert$$(!$runDependencyTracking$$[$id$jscomp$8$$]);
					$runDependencyTracking$$[$id$jscomp$8$$] = 1;
					null === $runDependencyWatcher$$ && globalThis.setInterval && ($runDependencyWatcher$$ = setInterval(() => {
						if ($ABORT$$) clearInterval($runDependencyWatcher$$), $runDependencyWatcher$$ = null;
						else {
							var $shown$$ = !1, $dep$$;
							for ($dep$$ in $runDependencyTracking$$) $shown$$ || ($shown$$ = !0, $err$$("still waiting on run dependencies:")), $err$$(`dependency: ${$dep$$}`);
							$shown$$ && $err$$("(end of list)");
						}
					}, 1e4));
				}, $preloadPlugins$$ = [], $FS_handledByPreloadPlugin$$ = async ($byteArray$$, $fullname$$) => {
					"undefined" != typeof Browser && $JSCompiler_StaticMethods_init$$();
					for (var $plugin$$ of $preloadPlugins$$) if ($plugin$$.canHandle($fullname$$)) return $assert$$("AsyncFunction" === $plugin$$.handle.constructor.name, "Filesystem plugin handlers must be async functions (See #24914)"), $plugin$$.handle($byteArray$$, $fullname$$);
					return $byteArray$$;
				}, $FS_preloadFile$$ = async ($parent$jscomp$17_parent$jscomp$inline_229$$, $callback$jscomp$inline_61_id$jscomp$inline_60_name$jscomp$88$$, $data$jscomp$inline_231_url$jscomp$27$$, $canRead$jscomp$1$$, $canWrite$jscomp$1$$, $dontCreateFile_path$jscomp$inline_236$$, $canOwn$jscomp$1$$, $preFinish$$) => {
					var $fullname$jscomp$1$$ = $callback$jscomp$inline_61_id$jscomp$inline_60_name$jscomp$88$$ ? $PATH_FS$resolve$$($PATH$normalize$$($parent$jscomp$17_parent$jscomp$inline_229$$ + "/" + $callback$jscomp$inline_61_id$jscomp$inline_60_name$jscomp$88$$)) : $parent$jscomp$17_parent$jscomp$inline_229$$, $dep$jscomp$1_id$jscomp$inline_55$$;
					a: for (var $byteArray$jscomp$1_orig$jscomp$inline_56$$ = $dep$jscomp$1_id$jscomp$inline_55$$ = `cp ${$fullname$jscomp$1$$}`;;) {
						if (!$runDependencyTracking$$[$dep$jscomp$1_id$jscomp$inline_55$$]) break a;
						$dep$jscomp$1_id$jscomp$inline_55$$ = $byteArray$jscomp$1_orig$jscomp$inline_56$$ + Math.random();
					}
					$addRunDependency$$($dep$jscomp$1_id$jscomp$inline_55$$);
					try {
						if ($byteArray$jscomp$1_orig$jscomp$inline_56$$ = $data$jscomp$inline_231_url$jscomp$27$$, "string" == typeof $data$jscomp$inline_231_url$jscomp$27$$ && ($byteArray$jscomp$1_orig$jscomp$inline_56$$ = await $asyncLoad$$($data$jscomp$inline_231_url$jscomp$27$$)), $byteArray$jscomp$1_orig$jscomp$inline_56$$ = await $FS_handledByPreloadPlugin$$($byteArray$jscomp$1_orig$jscomp$inline_56$$, $fullname$jscomp$1$$), $preFinish$$?.(), !$dontCreateFile_path$jscomp$inline_236$$) {
							$data$jscomp$inline_231_url$jscomp$27$$ = $byteArray$jscomp$1_orig$jscomp$inline_56$$;
							$dontCreateFile_path$jscomp$inline_236$$ = $callback$jscomp$inline_61_id$jscomp$inline_60_name$jscomp$88$$;
							$parent$jscomp$17_parent$jscomp$inline_229$$ && ($parent$jscomp$17_parent$jscomp$inline_229$$ = "string" == typeof $parent$jscomp$17_parent$jscomp$inline_229$$ ? $parent$jscomp$17_parent$jscomp$inline_229$$ : $JSCompiler_StaticMethods_getPath$$($parent$jscomp$17_parent$jscomp$inline_229$$), $dontCreateFile_path$jscomp$inline_236$$ = $callback$jscomp$inline_61_id$jscomp$inline_60_name$jscomp$88$$ ? $PATH$normalize$$($parent$jscomp$17_parent$jscomp$inline_229$$ + "/" + $callback$jscomp$inline_61_id$jscomp$inline_60_name$jscomp$88$$) : $parent$jscomp$17_parent$jscomp$inline_229$$);
							var $mode$jscomp$inline_237$$ = $FS_getMode$$($canRead$jscomp$1$$, $canWrite$jscomp$1$$), $node$jscomp$inline_238$$ = $FS$$.create($dontCreateFile_path$jscomp$inline_236$$, $mode$jscomp$inline_237$$);
							if ($data$jscomp$inline_231_url$jscomp$27$$) {
								$data$jscomp$inline_231_url$jscomp$27$$ = $FS_fileDataToTypedArray$$($data$jscomp$inline_231_url$jscomp$27$$);
								$JSCompiler_StaticMethods_chmod$$($node$jscomp$inline_238$$, $mode$jscomp$inline_237$$ | 146);
								var $stream$jscomp$inline_239$$ = $FS$$.open($node$jscomp$inline_238$$, 577);
								$FS$$.write($stream$jscomp$inline_239$$, $data$jscomp$inline_231_url$jscomp$27$$, 0, $data$jscomp$inline_231_url$jscomp$27$$.length, 0, $canOwn$jscomp$1$$);
								$FS$$.close($stream$jscomp$inline_239$$);
								$JSCompiler_StaticMethods_chmod$$($node$jscomp$inline_238$$, $mode$jscomp$inline_237$$);
							}
						}
					} finally {
						$callback$jscomp$inline_61_id$jscomp$inline_60_name$jscomp$88$$ = $dep$jscomp$1_id$jscomp$inline_55$$, $runDependencies$$--, $Module$$.monitorRunDependencies?.($runDependencies$$), $assert$$($callback$jscomp$inline_61_id$jscomp$inline_60_name$jscomp$88$$, "removeRunDependency requires an ID"), $assert$$($runDependencyTracking$$[$callback$jscomp$inline_61_id$jscomp$inline_60_name$jscomp$88$$]), delete $runDependencyTracking$$[$callback$jscomp$inline_61_id$jscomp$inline_60_name$jscomp$88$$], 0 == $runDependencies$$ && (null !== $runDependencyWatcher$$ && (clearInterval($runDependencyWatcher$$), $runDependencyWatcher$$ = null), $dependenciesFulfilled$$ && ($callback$jscomp$inline_61_id$jscomp$inline_60_name$jscomp$88$$ = $dependenciesFulfilled$$, $dependenciesFulfilled$$ = null, $callback$jscomp$inline_61_id$jscomp$inline_60_name$jscomp$88$$()));
					}
				};
				function $JSCompiler_StaticMethods_init$$() {
					$assert$$(!$FS$$.$initialized$, "FS.init was previously called. If you want to initialize later with custom parameters, remove any earlier calls (note that one is automatically added to the generated code)");
					$FS$$.$initialized$ = !0;
					$input$jscomp$10_input$jscomp$inline_63_stdout$jscomp$inline_68$$ ??= $Module$$.stdin;
					$output$jscomp$3_output$jscomp$inline_64_stderr$jscomp$inline_69$$ ??= $Module$$.stdout;
					$error$jscomp$4_error$jscomp$inline_65_stdin$jscomp$inline_67$$ ??= $Module$$.stderr;
					$input$jscomp$10_input$jscomp$inline_63_stdout$jscomp$inline_68$$ ? $FS$$.$createDevice$("/dev", "stdin", $input$jscomp$10_input$jscomp$inline_63_stdout$jscomp$inline_68$$) : $FS$$.$symlink$("/dev/tty", "/dev/stdin");
					$output$jscomp$3_output$jscomp$inline_64_stderr$jscomp$inline_69$$ ? $FS$$.$createDevice$("/dev", "stdout", null, $output$jscomp$3_output$jscomp$inline_64_stderr$jscomp$inline_69$$) : $FS$$.$symlink$("/dev/tty", "/dev/stdout");
					$error$jscomp$4_error$jscomp$inline_65_stdin$jscomp$inline_67$$ ? $FS$$.$createDevice$("/dev", "stderr", null, $error$jscomp$4_error$jscomp$inline_65_stdin$jscomp$inline_67$$) : $FS$$.$symlink$("/dev/tty1", "/dev/stderr");
					var $error$jscomp$4_error$jscomp$inline_65_stdin$jscomp$inline_67$$ = $FS$$.open("/dev/stdin", 0);
					var $input$jscomp$10_input$jscomp$inline_63_stdout$jscomp$inline_68$$ = $FS$$.open("/dev/stdout", 1);
					var $output$jscomp$3_output$jscomp$inline_64_stderr$jscomp$inline_69$$ = $FS$$.open("/dev/stderr", 1);
					$assert$$(0 === $error$jscomp$4_error$jscomp$inline_65_stdin$jscomp$inline_67$$.$fd$, `invalid handle for stdin (${$error$jscomp$4_error$jscomp$inline_65_stdin$jscomp$inline_67$$.$fd$})`);
					$assert$$(1 === $input$jscomp$10_input$jscomp$inline_63_stdout$jscomp$inline_68$$.$fd$, `invalid handle for stdout (${$input$jscomp$10_input$jscomp$inline_63_stdout$jscomp$inline_68$$.$fd$})`);
					$assert$$(2 === $output$jscomp$3_output$jscomp$inline_64_stderr$jscomp$inline_69$$.$fd$, `invalid handle for stderr (${$output$jscomp$3_output$jscomp$inline_64_stderr$jscomp$inline_69$$.$fd$})`);
				}
				function $JSCompiler_StaticMethods_registerDevice$$($dev$jscomp$7$$, $ops$jscomp$1$$) {
					$FS$$.$devices$[$dev$jscomp$7$$] = { $stream_ops$: $ops$jscomp$1$$ };
				}
				function $JSCompiler_StaticMethods_isDir$$($mode$jscomp$23$$) {
					return 16384 === ($mode$jscomp$23$$ & 61440);
				}
				function $JSCompiler_StaticMethods_lookupNode$$($parent$jscomp$20$$, $name$jscomp$92$$) {
					var $errCode_errCode$jscomp$inline_73_node$jscomp$23$$ = $JSCompiler_StaticMethods_isDir$$($parent$jscomp$20$$.mode) ? ($errCode_errCode$jscomp$inline_73_node$jscomp$23$$ = $JSCompiler_StaticMethods_nodePermissions$$($parent$jscomp$20$$, "x")) ? $errCode_errCode$jscomp$inline_73_node$jscomp$23$$ : $parent$jscomp$20$$.$node_ops$.$lookup$ ? 0 : 2 : 54;
					if ($errCode_errCode$jscomp$inline_73_node$jscomp$23$$) throw new $FS$$.$ErrnoError$($errCode_errCode$jscomp$inline_73_node$jscomp$23$$);
					for ($errCode_errCode$jscomp$inline_73_node$jscomp$23$$ = $FS$$.$nameTable$[$JSCompiler_StaticMethods_hashName$$($parent$jscomp$20$$.id, $name$jscomp$92$$)]; $errCode_errCode$jscomp$inline_73_node$jscomp$23$$; $errCode_errCode$jscomp$inline_73_node$jscomp$23$$ = $errCode_errCode$jscomp$inline_73_node$jscomp$23$$.$name_next$) {
						var $nodeName$$ = $errCode_errCode$jscomp$inline_73_node$jscomp$23$$.name;
						if ($errCode_errCode$jscomp$inline_73_node$jscomp$23$$.parent.id === $parent$jscomp$20$$.id && $nodeName$$ === $name$jscomp$92$$) return $errCode_errCode$jscomp$inline_73_node$jscomp$23$$;
					}
					return $FS$$.$lookup$($parent$jscomp$20$$, $name$jscomp$92$$);
				}
				function $JSCompiler_StaticMethods_hashRemoveNode$$($node$jscomp$22$$) {
					var $current$jscomp$1_hash$jscomp$2$$ = $JSCompiler_StaticMethods_hashName$$($node$jscomp$22$$.parent.id, $node$jscomp$22$$.name);
					if ($FS$$.$nameTable$[$current$jscomp$1_hash$jscomp$2$$] === $node$jscomp$22$$) $FS$$.$nameTable$[$current$jscomp$1_hash$jscomp$2$$] = $node$jscomp$22$$.$name_next$;
					else for ($current$jscomp$1_hash$jscomp$2$$ = $FS$$.$nameTable$[$current$jscomp$1_hash$jscomp$2$$]; $current$jscomp$1_hash$jscomp$2$$;) {
						if ($current$jscomp$1_hash$jscomp$2$$.$name_next$ === $node$jscomp$22$$) {
							$current$jscomp$1_hash$jscomp$2$$.$name_next$ = $node$jscomp$22$$.$name_next$;
							break;
						}
						$current$jscomp$1_hash$jscomp$2$$ = $current$jscomp$1_hash$jscomp$2$$.$name_next$;
					}
				}
				function $JSCompiler_StaticMethods_lookupPath$$($parts$jscomp$3_path$jscomp$13$$, $opts$$ = {}) {
					if (!$parts$jscomp$3_path$jscomp$13$$) throw new $FS$$.$ErrnoError$(44);
					$opts$$.$follow_mount$ ?? ($opts$$.$follow_mount$ = !0);
					"/" === $parts$jscomp$3_path$jscomp$13$$.charAt(0) || ($parts$jscomp$3_path$jscomp$13$$ = $FS$$.$cwd$() + "/" + $parts$jscomp$3_path$jscomp$13$$);
					var $nlinks$$ = 0;
					a: for (; 40 > $nlinks$$; $nlinks$$++) {
						$parts$jscomp$3_path$jscomp$13$$ = $parts$jscomp$3_path$jscomp$13$$.split("/").filter(($p$jscomp$2$$) => !!$p$jscomp$2$$);
						for (var $current_link$$ = $FS$$.root, $current_path$$ = "/", $i$jscomp$14$$ = 0; $i$jscomp$14$$ < $parts$jscomp$3_path$jscomp$13$$.length; $i$jscomp$14$$++) {
							var $islast$$ = $i$jscomp$14$$ === $parts$jscomp$3_path$jscomp$13$$.length - 1;
							if ($islast$$ && $opts$$.parent) break;
							if ("." !== $parts$jscomp$3_path$jscomp$13$$[$i$jscomp$14$$]) if (".." === $parts$jscomp$3_path$jscomp$13$$[$i$jscomp$14$$]) if ($current_path$$ = $PATH$dirname$$($current_path$$), $FS$$.$isRoot$($current_link$$)) {
								$parts$jscomp$3_path$jscomp$13$$ = $current_path$$ + "/" + $parts$jscomp$3_path$jscomp$13$$.slice($i$jscomp$14$$ + 1).join("/");
								$nlinks$$--;
								continue a;
							} else $current_link$$ = $current_link$$.parent;
							else {
								$current_path$$ = $PATH$normalize$$($current_path$$ + "/" + $parts$jscomp$3_path$jscomp$13$$[$i$jscomp$14$$]);
								try {
									$current_link$$ = $JSCompiler_StaticMethods_lookupNode$$($current_link$$, $parts$jscomp$3_path$jscomp$13$$[$i$jscomp$14$$]);
								} catch ($e$jscomp$12$$) {
									if (44 === $e$jscomp$12$$?.$errno$ && $islast$$ && $opts$$.$noent_okay$) return { path: $current_path$$ };
									throw $e$jscomp$12$$;
								}
								!$current_link$$.$mounted$ || $islast$$ && !$opts$$.$follow_mount$ || ($current_link$$ = $current_link$$.$mounted$.root);
								if (40960 === ($current_link$$.mode & 61440) && (!$islast$$ || $opts$$.$follow$)) {
									if (!$current_link$$.$node_ops$.$readlink$) throw new $FS$$.$ErrnoError$(52);
									$current_link$$ = $current_link$$.$node_ops$.$readlink$($current_link$$);
									"/" === $current_link$$.charAt(0) || ($current_link$$ = $PATH$dirname$$($current_path$$) + "/" + $current_link$$);
									$parts$jscomp$3_path$jscomp$13$$ = $current_link$$ + "/" + $parts$jscomp$3_path$jscomp$13$$.slice($i$jscomp$14$$ + 1).join("/");
									continue a;
								}
							}
						}
						return {
							path: $current_path$$,
							node: $current_link$$
						};
					}
					throw new $FS$$.$ErrnoError$(32);
				}
				function $JSCompiler_StaticMethods_getPath$$($mount$jscomp$2_node$jscomp$20$$) {
					for (var $path$jscomp$14$$;;) {
						if ($FS$$.$isRoot$($mount$jscomp$2_node$jscomp$20$$)) return $mount$jscomp$2_node$jscomp$20$$ = $mount$jscomp$2_node$jscomp$20$$.$mount$.$mountpoint$, $path$jscomp$14$$ ? "/" !== $mount$jscomp$2_node$jscomp$20$$[$mount$jscomp$2_node$jscomp$20$$.length - 1] ? `${$mount$jscomp$2_node$jscomp$20$$}/${$path$jscomp$14$$}` : $mount$jscomp$2_node$jscomp$20$$ + $path$jscomp$14$$ : $mount$jscomp$2_node$jscomp$20$$;
						$path$jscomp$14$$ = $path$jscomp$14$$ ? `${$mount$jscomp$2_node$jscomp$20$$.name}/${$path$jscomp$14$$}` : $mount$jscomp$2_node$jscomp$20$$.name;
						$mount$jscomp$2_node$jscomp$20$$ = $mount$jscomp$2_node$jscomp$20$$.parent;
					}
				}
				function $JSCompiler_StaticMethods_hashName$$($parentid$$, $name$jscomp$91$$) {
					for (var $hash$$ = 0, $i$jscomp$15$$ = 0; $i$jscomp$15$$ < $name$jscomp$91$$.length; $i$jscomp$15$$++) $hash$$ = ($hash$$ << 5) - $hash$$ + $name$jscomp$91$$.charCodeAt($i$jscomp$15$$) | 0;
					return ($parentid$$ + $hash$$ >>> 0) % $FS$$.$nameTable$.length;
				}
				function $JSCompiler_StaticMethods_hashAddNode$$($node$jscomp$21$$) {
					var $hash$jscomp$1$$ = $JSCompiler_StaticMethods_hashName$$($node$jscomp$21$$.parent.id, $node$jscomp$21$$.name);
					$node$jscomp$21$$.$name_next$ = $FS$$.$nameTable$[$hash$jscomp$1$$];
					$FS$$.$nameTable$[$hash$jscomp$1$$] = $node$jscomp$21$$;
				}
				function $JSCompiler_StaticMethods_nodePermissions$$($node$jscomp$28$$, $perms$jscomp$1$$) {
					return $FS$$.$ignorePermissions$ ? 0 : $perms$jscomp$1$$.includes("r") && !($node$jscomp$28$$.mode & 292) || $perms$jscomp$1$$.includes("w") && !($node$jscomp$28$$.mode & 146) || $perms$jscomp$1$$.includes("x") && !($node$jscomp$28$$.mode & 73) ? 2 : 0;
				}
				function $JSCompiler_StaticMethods_mayCreate$$($dir$jscomp$2$$, $name$jscomp$94$$) {
					if (!$JSCompiler_StaticMethods_isDir$$($dir$jscomp$2$$.mode)) return 54;
					try {
						return $JSCompiler_StaticMethods_lookupNode$$($dir$jscomp$2$$, $name$jscomp$94$$), 20;
					} catch ($e$jscomp$13$$) {}
					return $JSCompiler_StaticMethods_nodePermissions$$($dir$jscomp$2$$, "wx");
				}
				function $JSCompiler_StaticMethods_mayDelete$$($dir$jscomp$3_errCode$jscomp$2$$, $name$jscomp$95$$, $isdir$$) {
					try {
						var $node$jscomp$30$$ = $JSCompiler_StaticMethods_lookupNode$$($dir$jscomp$3_errCode$jscomp$2$$, $name$jscomp$95$$);
					} catch ($e$jscomp$14$$) {
						return $e$jscomp$14$$.$errno$;
					}
					if ($dir$jscomp$3_errCode$jscomp$2$$ = $JSCompiler_StaticMethods_nodePermissions$$($dir$jscomp$3_errCode$jscomp$2$$, "wx")) return $dir$jscomp$3_errCode$jscomp$2$$;
					if ($isdir$$) {
						if (!$JSCompiler_StaticMethods_isDir$$($node$jscomp$30$$.mode)) return 54;
						if ($FS$$.$isRoot$($node$jscomp$30$$) || $JSCompiler_StaticMethods_getPath$$($node$jscomp$30$$) === $FS$$.$cwd$()) return 10;
					} else if ($JSCompiler_StaticMethods_isDir$$($node$jscomp$30$$.mode)) return 31;
					return 0;
				}
				function $JSCompiler_StaticMethods_checkOpExists$$($op$$, $err$jscomp$4$$) {
					if (!$op$$) throw new $FS$$.$ErrnoError$($err$jscomp$4$$);
					return $op$$;
				}
				function $JSCompiler_StaticMethods_getStreamChecked$$($fd$jscomp$1_stream$jscomp$17$$) {
					$fd$jscomp$1_stream$jscomp$17$$ = $FS$$.$getStream$($fd$jscomp$1_stream$jscomp$17$$);
					if (!$fd$jscomp$1_stream$jscomp$17$$) throw new $FS$$.$ErrnoError$(8);
					return $fd$jscomp$1_stream$jscomp$17$$;
				}
				function $JSCompiler_StaticMethods_createStream$$($stream$jscomp$18$$, $fd$jscomp$3_fd$jscomp$inline_76$$ = -1) {
					$assert$$(-1 <= $fd$jscomp$3_fd$jscomp$inline_76$$);
					$stream$jscomp$18$$ = Object.assign(new $FS$$.$FSStream$(), $stream$jscomp$18$$);
					if (-1 == $fd$jscomp$3_fd$jscomp$inline_76$$) a: {
						for ($fd$jscomp$3_fd$jscomp$inline_76$$ = 0; $fd$jscomp$3_fd$jscomp$inline_76$$ <= $FS$$.$MAX_OPEN_FDS$; $fd$jscomp$3_fd$jscomp$inline_76$$++) if (!$FS$$.streams[$fd$jscomp$3_fd$jscomp$inline_76$$]) break a;
						throw new $FS$$.$ErrnoError$(33);
					}
					$stream$jscomp$18$$.$fd$ = $fd$jscomp$3_fd$jscomp$inline_76$$;
					return $FS$$.streams[$fd$jscomp$3_fd$jscomp$inline_76$$] = $stream$jscomp$18$$;
				}
				function $JSCompiler_StaticMethods_dupStream$$($origStream_stream$jscomp$19$$, $fd$jscomp$5$$ = -1) {
					$origStream_stream$jscomp$19$$ = $JSCompiler_StaticMethods_createStream$$($origStream_stream$jscomp$19$$, $fd$jscomp$5$$);
					$origStream_stream$jscomp$19$$.$stream_ops$?.$dup$?.($origStream_stream$jscomp$19$$);
					return $origStream_stream$jscomp$19$$;
				}
				function $JSCompiler_StaticMethods_doSetAttr$$($arg$jscomp$8_stream$jscomp$20$$, $node$jscomp$32$$, $attr$jscomp$3$$) {
					var $setattr$$ = $arg$jscomp$8_stream$jscomp$20$$?.$stream_ops$.$setattr$;
					$arg$jscomp$8_stream$jscomp$20$$ = $setattr$$ ? $arg$jscomp$8_stream$jscomp$20$$ : $node$jscomp$32$$;
					$setattr$$ ??= $node$jscomp$32$$.$node_ops$.$setattr$;
					$JSCompiler_StaticMethods_checkOpExists$$($setattr$$, 63);
					$setattr$$($arg$jscomp$8_stream$jscomp$20$$, $attr$jscomp$3$$);
				}
				function $JSCompiler_StaticMethods_getMounts$$($check_mount$jscomp$3$$) {
					var $mounts$$ = [];
					for ($check_mount$jscomp$3$$ = [$check_mount$jscomp$3$$]; $check_mount$jscomp$3$$.length;) {
						var $m$$ = $check_mount$jscomp$3$$.pop();
						$mounts$$.push($m$$);
						$check_mount$jscomp$3$$.push(...$m$$.$mounts$);
					}
					return $mounts$$;
				}
				function $JSCompiler_StaticMethods_statfsNode$$($node$jscomp$35$$) {
					var $rtn$$ = {
						$bsize$: 4096,
						$frsize$: 4096,
						$blocks$: 1e6,
						$bfree$: 5e5,
						$bavail$: 5e5,
						files: $FS$$.$nextInode$,
						$ffree$: $FS$$.$nextInode$ - 1,
						$fsid$: 42,
						flags: 2,
						$namelen$: 255
					};
					$node$jscomp$35$$.$node_ops$.$statfs$ && Object.assign($rtn$$, $node$jscomp$35$$.$node_ops$.$statfs$($node$jscomp$35$$.$mount$.$opts$.root));
					return $rtn$$;
				}
				function $JSCompiler_StaticMethods_mkdir$$($path$jscomp$18$$, $mode$jscomp$32$$ = 511) {
					return $FS$$.$mknod$($path$jscomp$18$$, $mode$jscomp$32$$ & 1023 | 16384, 0);
				}
				function $JSCompiler_StaticMethods_mkdev$$($path$jscomp$20$$, $mode$jscomp$34$$, $dev$jscomp$10$$) {
					"undefined" == typeof $dev$jscomp$10$$ && ($dev$jscomp$10$$ = $mode$jscomp$34$$, $mode$jscomp$34$$ = 438);
					return $FS$$.$mknod$($path$jscomp$20$$, $mode$jscomp$34$$ | 8192, $dev$jscomp$10$$);
				}
				function $JSCompiler_StaticMethods_doChmod$$($stream$jscomp$24$$, $node$jscomp$41$$, $mode$jscomp$35$$, $dontFollow$jscomp$1$$) {
					$JSCompiler_StaticMethods_doSetAttr$$($stream$jscomp$24$$, $node$jscomp$41$$, {
						mode: $mode$jscomp$35$$ & 4095 | $node$jscomp$41$$.mode & -4096,
						$ctime$: Date.now(),
						$dontFollow$: $dontFollow$jscomp$1$$
					});
				}
				function $JSCompiler_StaticMethods_chmod$$($node$jscomp$42_path$jscomp$27$$, $mode$jscomp$36$$, $dontFollow$jscomp$2$$) {
					$node$jscomp$42_path$jscomp$27$$ = "string" == typeof $node$jscomp$42_path$jscomp$27$$ ? $JSCompiler_StaticMethods_lookupPath$$($node$jscomp$42_path$jscomp$27$$, { $follow$: !$dontFollow$jscomp$2$$ }).node : $node$jscomp$42_path$jscomp$27$$;
					$JSCompiler_StaticMethods_doChmod$$(null, $node$jscomp$42_path$jscomp$27$$, $mode$jscomp$36$$, $dontFollow$jscomp$2$$);
				}
				function $JSCompiler_StaticMethods_doTruncate$$($stream$jscomp$28$$, $node$jscomp$45$$, $len$jscomp$2$$) {
					if ($JSCompiler_StaticMethods_isDir$$($node$jscomp$45$$.mode)) throw new $FS$$.$ErrnoError$(31);
					if (!$FS$$.isFile($node$jscomp$45$$.mode)) throw new $FS$$.$ErrnoError$(28);
					var $errCode$jscomp$10$$ = $JSCompiler_StaticMethods_nodePermissions$$($node$jscomp$45$$, "w");
					if ($errCode$jscomp$10$$) throw new $FS$$.$ErrnoError$($errCode$jscomp$10$$);
					$JSCompiler_StaticMethods_doSetAttr$$($stream$jscomp$28$$, $node$jscomp$45$$, {
						size: $len$jscomp$2$$,
						timestamp: Date.now()
					});
				}
				function $JSCompiler_StaticMethods_analyzePath$$($path$jscomp$38$$, $dontResolveLastLink$jscomp$1$$) {
					try {
						var $lookup$jscomp$16$$ = $JSCompiler_StaticMethods_lookupPath$$($path$jscomp$38$$, { $follow$: !$dontResolveLastLink$jscomp$1$$ });
						$path$jscomp$38$$ = $lookup$jscomp$16$$.path;
					} catch ($e$jscomp$19$$) {}
					var $ret$jscomp$2$$ = {
						$isRoot$: !1,
						$exists$: !1,
						error: 0,
						name: null,
						path: null,
						object: null,
						$parentExists$: !1,
						$parentPath$: null,
						$parentObject$: null
					};
					try {
						$lookup$jscomp$16$$ = $JSCompiler_StaticMethods_lookupPath$$($path$jscomp$38$$, { parent: !0 }), $ret$jscomp$2$$.$parentExists$ = !0, $ret$jscomp$2$$.$parentPath$ = $lookup$jscomp$16$$.path, $ret$jscomp$2$$.$parentObject$ = $lookup$jscomp$16$$.node, $ret$jscomp$2$$.name = $PATH$basename$$($path$jscomp$38$$), $lookup$jscomp$16$$ = $JSCompiler_StaticMethods_lookupPath$$($path$jscomp$38$$, { $follow$: !$dontResolveLastLink$jscomp$1$$ }), $ret$jscomp$2$$.$exists$ = !0, $ret$jscomp$2$$.path = $lookup$jscomp$16$$.path, $ret$jscomp$2$$.object = $lookup$jscomp$16$$.node, $ret$jscomp$2$$.name = $lookup$jscomp$16$$.node.name, $ret$jscomp$2$$.$isRoot$ = "/" === $lookup$jscomp$16$$.path;
					} catch ($e$jscomp$20$$) {
						$ret$jscomp$2$$.error = $e$jscomp$20$$.$errno$;
					}
					return $ret$jscomp$2$$;
				}
				function $JSCompiler_StaticMethods_createFile$$($l$jscomp$inline_78_parent$jscomp$29$$, $name$jscomp$101_path$jscomp$40$$, $canRead$jscomp$4$$, $canWrite$jscomp$4$$) {
					$l$jscomp$inline_78_parent$jscomp$29$$ = "string" == typeof $l$jscomp$inline_78_parent$jscomp$29$$ ? $l$jscomp$inline_78_parent$jscomp$29$$ : $JSCompiler_StaticMethods_getPath$$($l$jscomp$inline_78_parent$jscomp$29$$);
					$name$jscomp$101_path$jscomp$40$$ = $PATH$normalize$$($l$jscomp$inline_78_parent$jscomp$29$$ + "/" + $name$jscomp$101_path$jscomp$40$$);
					return $FS$$.create($name$jscomp$101_path$jscomp$40$$, $FS_getMode$$($canRead$jscomp$4$$, $canWrite$jscomp$4$$));
				}
				function $JSCompiler_StaticMethods_forceLoadFile$$($obj$jscomp$30$$) {
					if (!($obj$jscomp$30$$.$isDevice$ || $obj$jscomp$30$$.$isFolder$ || $obj$jscomp$30$$.link || $obj$jscomp$30$$.$contents$)) if (globalThis.XMLHttpRequest) $abort$$("Lazy loading should have been performed (contents set) in createLazyFile, but it was not. Lazy loading only works in web workers. Use --embed-file or --preload-file in emcc on the main thread.");
					else try {
						$obj$jscomp$30$$.$contents$ = $readBinary$$($obj$jscomp$30$$.url);
					} catch ($e$jscomp$24$$) {
						throw new $FS$$.$ErrnoError$(29);
					}
				}
				var $FS$$ = {
					root: null,
					$mounts$: [],
					$devices$: {},
					streams: [],
					$nextInode$: 1,
					$nameTable$: null,
					$currentPath$: "/",
					$initialized$: !1,
					$ignorePermissions$: !0,
					$filesystems$: null,
					$syncFSRequests$: 0,
					$ErrnoError$: class extends Error {
						name = "ErrnoError";
						constructor($errno$jscomp$1$$) {
							super($runtimeInitialized$$ ? $UTF8ToString$$($_strerror$$($errno$jscomp$1$$)) : "");
							this.$errno$ = $errno$jscomp$1$$;
							for (var $key$jscomp$42$$ in $ERRNO_CODES$$) if ($ERRNO_CODES$$[$key$jscomp$42$$] === $errno$jscomp$1$$) {
								this.code = $key$jscomp$42$$;
								break;
							}
						}
					},
					$FSStream$: class {
						$g$ = {};
						node = null;
						get object() {
							return this.node;
						}
						set object($val$jscomp$3$$) {
							this.node = $val$jscomp$3$$;
						}
						get flags() {
							return this.$g$.flags;
						}
						set flags($val$jscomp$4$$) {
							this.$g$.flags = $val$jscomp$4$$;
						}
						get position() {
							return this.$g$.position;
						}
						set position($val$jscomp$5$$) {
							this.$g$.position = $val$jscomp$5$$;
						}
					},
					$FSNode$: class {
						$node_ops$ = {};
						$stream_ops$ = {};
						$mounted$ = null;
						constructor($parent$jscomp$19$$, $name$jscomp$90$$, $mode$jscomp$20$$, $rdev$$) {
							$parent$jscomp$19$$ ||= this;
							this.parent = $parent$jscomp$19$$;
							this.$mount$ = $parent$jscomp$19$$.$mount$;
							this.id = $FS$$.$nextInode$++;
							this.name = $name$jscomp$90$$;
							this.mode = $mode$jscomp$20$$;
							this.$rdev$ = $rdev$$;
							this.$atime$ = this.$mtime$ = this.$ctime$ = Date.now();
						}
						get read() {
							return 365 === (this.mode & 365);
						}
						set read($val$jscomp$6$$) {
							$val$jscomp$6$$ ? this.mode |= 365 : this.mode &= -366;
						}
						get write() {
							return 146 === (this.mode & 146);
						}
						set write($val$jscomp$7$$) {
							$val$jscomp$7$$ ? this.mode |= 146 : this.mode &= -147;
						}
						get $isFolder$() {
							return $JSCompiler_StaticMethods_isDir$$(this.mode);
						}
						get $isDevice$() {
							return 8192 === (this.mode & 61440);
						}
					},
					createNode($node$jscomp$24_parent$jscomp$21$$, $name$jscomp$93$$, $mode$jscomp$21$$, $rdev$jscomp$1$$) {
						$assert$$("object" == typeof $node$jscomp$24_parent$jscomp$21$$);
						$node$jscomp$24_parent$jscomp$21$$ = new $FS$$.$FSNode$($node$jscomp$24_parent$jscomp$21$$, $name$jscomp$93$$, $mode$jscomp$21$$, $rdev$jscomp$1$$);
						$JSCompiler_StaticMethods_hashAddNode$$($node$jscomp$24_parent$jscomp$21$$);
						return $node$jscomp$24_parent$jscomp$21$$;
					},
					$isRoot$($node$jscomp$26$$) {
						return $node$jscomp$26$$ === $node$jscomp$26$$.parent;
					},
					isFile($mode$jscomp$22$$) {
						return 32768 === ($mode$jscomp$22$$ & 61440);
					},
					$isSocket$($mode$jscomp$28$$) {
						return 49152 === ($mode$jscomp$28$$ & 49152);
					},
					$MAX_OPEN_FDS$: 4096,
					$getStream$: ($fd$jscomp$2$$) => $FS$$.streams[$fd$jscomp$2$$],
					$chrdev_stream_ops$: {
						open($stream$jscomp$21$$) {
							$stream$jscomp$21$$.$stream_ops$ = $FS$$.$getDevice$($stream$jscomp$21$$.node.$rdev$).$stream_ops$;
							$stream$jscomp$21$$.$stream_ops$.open?.($stream$jscomp$21$$);
						},
						$llseek$() {
							throw new $FS$$.$ErrnoError$(70);
						}
					},
					$major$: ($dev$jscomp$5$$) => $dev$jscomp$5$$ >> 8,
					$minor$: ($dev$jscomp$6$$) => $dev$jscomp$6$$ & 255,
					$makedev$: ($ma$$, $mi$$) => $ma$$ << 8 | $mi$$,
					$getDevice$: ($dev$jscomp$8$$) => $FS$$.$devices$[$dev$jscomp$8$$],
					$syncfs$($populate$$, $callback$jscomp$59$$) {
						function $doCallback$$($errCode$jscomp$3$$) {
							$assert$$(0 < $FS$$.$syncFSRequests$);
							$FS$$.$syncFSRequests$--;
							return $callback$jscomp$59$$($errCode$jscomp$3$$);
						}
						function $done$$($errCode$jscomp$4$$) {
							if ($errCode$jscomp$4$$) {
								if (!$done$$.$errored$) return $done$$.$errored$ = !0, $doCallback$$($errCode$jscomp$4$$);
							} else ++$completed$$ >= $mounts$jscomp$1$$.length && $doCallback$$(null);
						}
						"function" == typeof $populate$$ && ($callback$jscomp$59$$ = $populate$$, $populate$$ = !1);
						$FS$$.$syncFSRequests$++;
						1 < $FS$$.$syncFSRequests$ && $err$$(`warning: ${$FS$$.$syncFSRequests$} FS.syncfs operations in flight at once, probably just doing extra work`);
						var $mounts$jscomp$1$$ = $JSCompiler_StaticMethods_getMounts$$($FS$$.root.$mount$), $completed$$ = 0, $mount$jscomp$4$$;
						for ($mount$jscomp$4$$ of $mounts$jscomp$1$$) $mount$jscomp$4$$.type.$syncfs$ ? $mount$jscomp$4$$.type.$syncfs$($mount$jscomp$4$$, $populate$$, $done$$) : $done$$(null);
					},
					$mount$($mountRoot_type$jscomp$166$$, $mount$jscomp$5_opts$jscomp$1$$, $mountpoint$$) {
						if ("string" == typeof $mountRoot_type$jscomp$166$$) throw $mountRoot_type$jscomp$166$$;
						var $root$jscomp$5$$ = "/" === $mountpoint$$, $pseudo$$ = !$mountpoint$$;
						if ($root$jscomp$5$$ && $FS$$.root) throw new $FS$$.$ErrnoError$(10);
						if (!$root$jscomp$5$$ && !$pseudo$$) {
							var $lookup_node$jscomp$33$$ = $JSCompiler_StaticMethods_lookupPath$$($mountpoint$$, { $follow_mount$: !1 });
							$mountpoint$$ = $lookup_node$jscomp$33$$.path;
							$lookup_node$jscomp$33$$ = $lookup_node$jscomp$33$$.node;
							if ($lookup_node$jscomp$33$$.$mounted$) throw new $FS$$.$ErrnoError$(10);
							if (!$JSCompiler_StaticMethods_isDir$$($lookup_node$jscomp$33$$.mode)) throw new $FS$$.$ErrnoError$(54);
						}
						$mount$jscomp$5_opts$jscomp$1$$ = {
							type: $mountRoot_type$jscomp$166$$,
							$opts$: $mount$jscomp$5_opts$jscomp$1$$,
							$mountpoint$: $mountpoint$$,
							$mounts$: []
						};
						$mountRoot_type$jscomp$166$$ = $mountRoot_type$jscomp$166$$.$mount$($mount$jscomp$5_opts$jscomp$1$$);
						$mountRoot_type$jscomp$166$$.$mount$ = $mount$jscomp$5_opts$jscomp$1$$;
						$mount$jscomp$5_opts$jscomp$1$$.root = $mountRoot_type$jscomp$166$$;
						$root$jscomp$5$$ ? $FS$$.root = $mountRoot_type$jscomp$166$$ : $lookup_node$jscomp$33$$ && ($lookup_node$jscomp$33$$.$mounted$ = $mount$jscomp$5_opts$jscomp$1$$, $lookup_node$jscomp$33$$.$mount$ && $lookup_node$jscomp$33$$.$mount$.$mounts$.push($mount$jscomp$5_opts$jscomp$1$$));
						return $mountRoot_type$jscomp$166$$;
					},
					$unmount$($lookup$jscomp$1_mountpoint$jscomp$1_node$jscomp$34$$) {
						$lookup$jscomp$1_mountpoint$jscomp$1_node$jscomp$34$$ = $JSCompiler_StaticMethods_lookupPath$$($lookup$jscomp$1_mountpoint$jscomp$1_node$jscomp$34$$, { $follow_mount$: !1 });
						if (!$lookup$jscomp$1_mountpoint$jscomp$1_node$jscomp$34$$.node.$mounted$) throw new $FS$$.$ErrnoError$(28);
						$lookup$jscomp$1_mountpoint$jscomp$1_node$jscomp$34$$ = $lookup$jscomp$1_mountpoint$jscomp$1_node$jscomp$34$$.node;
						var $mount$jscomp$6$$ = $lookup$jscomp$1_mountpoint$jscomp$1_node$jscomp$34$$.$mounted$, $mounts$jscomp$2$$ = $JSCompiler_StaticMethods_getMounts$$($mount$jscomp$6$$);
						for ([, $current$jscomp$2_idx$jscomp$2$$] of Object.entries($FS$$.$nameTable$)) for (; $current$jscomp$2_idx$jscomp$2$$;) {
							var $next$$ = $current$jscomp$2_idx$jscomp$2$$.$name_next$;
							$mounts$jscomp$2$$.includes($current$jscomp$2_idx$jscomp$2$$.$mount$) && $JSCompiler_StaticMethods_hashRemoveNode$$($current$jscomp$2_idx$jscomp$2$$);
							var $current$jscomp$2_idx$jscomp$2$$ = $next$$;
						}
						$lookup$jscomp$1_mountpoint$jscomp$1_node$jscomp$34$$.$mounted$ = null;
						$current$jscomp$2_idx$jscomp$2$$ = $lookup$jscomp$1_mountpoint$jscomp$1_node$jscomp$34$$.$mount$.$mounts$.indexOf($mount$jscomp$6$$);
						$assert$$(-1 !== $current$jscomp$2_idx$jscomp$2$$);
						$lookup$jscomp$1_mountpoint$jscomp$1_node$jscomp$34$$.$mount$.$mounts$.splice($current$jscomp$2_idx$jscomp$2$$, 1);
					},
					$lookup$($parent$jscomp$22$$, $name$jscomp$96$$) {
						return $parent$jscomp$22$$.$node_ops$.$lookup$($parent$jscomp$22$$, $name$jscomp$96$$);
					},
					$mknod$($name$jscomp$97_path$jscomp$15$$, $mode$jscomp$30$$, $dev$jscomp$9$$) {
						var $parent$jscomp$23$$ = $JSCompiler_StaticMethods_lookupPath$$($name$jscomp$97_path$jscomp$15$$, { parent: !0 }).node;
						$name$jscomp$97_path$jscomp$15$$ = $PATH$basename$$($name$jscomp$97_path$jscomp$15$$);
						if (!$name$jscomp$97_path$jscomp$15$$) throw new $FS$$.$ErrnoError$(28);
						if ("." === $name$jscomp$97_path$jscomp$15$$ || ".." === $name$jscomp$97_path$jscomp$15$$) throw new $FS$$.$ErrnoError$(20);
						var $errCode$jscomp$5$$ = $JSCompiler_StaticMethods_mayCreate$$($parent$jscomp$23$$, $name$jscomp$97_path$jscomp$15$$);
						if ($errCode$jscomp$5$$) throw new $FS$$.$ErrnoError$($errCode$jscomp$5$$);
						if (!$parent$jscomp$23$$.$node_ops$.$mknod$) throw new $FS$$.$ErrnoError$(63);
						return $parent$jscomp$23$$.$node_ops$.$mknod$($parent$jscomp$23$$, $name$jscomp$97_path$jscomp$15$$, $mode$jscomp$30$$, $dev$jscomp$9$$);
					},
					$statfs$($path$jscomp$16$$) {
						return $JSCompiler_StaticMethods_statfsNode$$($JSCompiler_StaticMethods_lookupPath$$($path$jscomp$16$$, { $follow$: !0 }).node);
					},
					$statfsStream$($stream$jscomp$22$$) {
						return $JSCompiler_StaticMethods_statfsNode$$($stream$jscomp$22$$.node);
					},
					create($path$jscomp$17$$, $mode$jscomp$31$$ = 438) {
						return $FS$$.$mknod$($path$jscomp$17$$, $mode$jscomp$31$$ & 4095 | 32768, 0);
					},
					$mkdirTree$($path$jscomp$19$$, $mode$jscomp$33$$) {
						var $dirs$$ = $path$jscomp$19$$.split("/"), $d$$ = "", $dir$jscomp$4$$;
						for ($dir$jscomp$4$$ of $dirs$$) if ($dir$jscomp$4$$) {
							if ($d$$ || "/" === $path$jscomp$19$$.charAt(0)) $d$$ += "/";
							$d$$ += $dir$jscomp$4$$;
							try {
								$JSCompiler_StaticMethods_mkdir$$($d$$, $mode$jscomp$33$$);
							} catch ($e$jscomp$15$$) {
								if (20 != $e$jscomp$15$$.$errno$) throw $e$jscomp$15$$;
							}
						}
					},
					$symlink$($oldpath$jscomp$1$$, $newname$jscomp$1_newpath$$) {
						if (!$PATH_FS$resolve$$($oldpath$jscomp$1$$)) throw new $FS$$.$ErrnoError$(44);
						var $parent$jscomp$24$$ = $JSCompiler_StaticMethods_lookupPath$$($newname$jscomp$1_newpath$$, { parent: !0 }).node;
						if (!$parent$jscomp$24$$) throw new $FS$$.$ErrnoError$(44);
						$newname$jscomp$1_newpath$$ = $PATH$basename$$($newname$jscomp$1_newpath$$);
						var $errCode$jscomp$6$$ = $JSCompiler_StaticMethods_mayCreate$$($parent$jscomp$24$$, $newname$jscomp$1_newpath$$);
						if ($errCode$jscomp$6$$) throw new $FS$$.$ErrnoError$($errCode$jscomp$6$$);
						if (!$parent$jscomp$24$$.$node_ops$.$symlink$) throw new $FS$$.$ErrnoError$(63);
						return $parent$jscomp$24$$.$node_ops$.$symlink$($parent$jscomp$24$$, $newname$jscomp$1_newpath$$, $oldpath$jscomp$1$$);
					},
					$rename$($old_path_relative$$, $isdir$jscomp$1_new_path$$) {
						var $old_dirname$$ = $PATH$dirname$$($old_path_relative$$), $new_dirname$$ = $PATH$dirname$$($isdir$jscomp$1_new_path$$), $errCode$jscomp$7_old_name$$ = $PATH$basename$$($old_path_relative$$), $new_name$jscomp$1$$ = $PATH$basename$$($isdir$jscomp$1_new_path$$);
						var $lookup$jscomp$4_new_dir$jscomp$1$$ = $JSCompiler_StaticMethods_lookupPath$$($old_path_relative$$, { parent: !0 });
						var $old_dir$$ = $lookup$jscomp$4_new_dir$jscomp$1$$.node;
						$lookup$jscomp$4_new_dir$jscomp$1$$ = $JSCompiler_StaticMethods_lookupPath$$($isdir$jscomp$1_new_path$$, { parent: !0 });
						$lookup$jscomp$4_new_dir$jscomp$1$$ = $lookup$jscomp$4_new_dir$jscomp$1$$.node;
						if (!$old_dir$$ || !$lookup$jscomp$4_new_dir$jscomp$1$$) throw new $FS$$.$ErrnoError$(44);
						if ($old_dir$$.$mount$ !== $lookup$jscomp$4_new_dir$jscomp$1$$.$mount$) throw new $FS$$.$ErrnoError$(75);
						var $old_node$jscomp$1$$ = $JSCompiler_StaticMethods_lookupNode$$($old_dir$$, $errCode$jscomp$7_old_name$$);
						$old_path_relative$$ = $PATH_FS$relative$$($old_path_relative$$, $new_dirname$$);
						if ("." !== $old_path_relative$$.charAt(0)) throw new $FS$$.$ErrnoError$(28);
						$old_path_relative$$ = $PATH_FS$relative$$($isdir$jscomp$1_new_path$$, $old_dirname$$);
						if ("." !== $old_path_relative$$.charAt(0)) throw new $FS$$.$ErrnoError$(55);
						try {
							var $new_node$jscomp$1$$ = $JSCompiler_StaticMethods_lookupNode$$($lookup$jscomp$4_new_dir$jscomp$1$$, $new_name$jscomp$1$$);
						} catch ($e$jscomp$16$$) {}
						if ($old_node$jscomp$1$$ !== $new_node$jscomp$1$$) {
							$isdir$jscomp$1_new_path$$ = $JSCompiler_StaticMethods_isDir$$($old_node$jscomp$1$$.mode);
							if ($errCode$jscomp$7_old_name$$ = $JSCompiler_StaticMethods_mayDelete$$($old_dir$$, $errCode$jscomp$7_old_name$$, $isdir$jscomp$1_new_path$$)) throw new $FS$$.$ErrnoError$($errCode$jscomp$7_old_name$$);
							if ($errCode$jscomp$7_old_name$$ = $new_node$jscomp$1$$ ? $JSCompiler_StaticMethods_mayDelete$$($lookup$jscomp$4_new_dir$jscomp$1$$, $new_name$jscomp$1$$, $isdir$jscomp$1_new_path$$) : $JSCompiler_StaticMethods_mayCreate$$($lookup$jscomp$4_new_dir$jscomp$1$$, $new_name$jscomp$1$$)) throw new $FS$$.$ErrnoError$($errCode$jscomp$7_old_name$$);
							if (!$old_dir$$.$node_ops$.$rename$) throw new $FS$$.$ErrnoError$(63);
							if ($old_node$jscomp$1$$.$mounted$ || $new_node$jscomp$1$$ && $new_node$jscomp$1$$.$mounted$) throw new $FS$$.$ErrnoError$(10);
							if ($lookup$jscomp$4_new_dir$jscomp$1$$ !== $old_dir$$ && ($errCode$jscomp$7_old_name$$ = $JSCompiler_StaticMethods_nodePermissions$$($old_dir$$, "w"))) throw new $FS$$.$ErrnoError$($errCode$jscomp$7_old_name$$);
							$JSCompiler_StaticMethods_hashRemoveNode$$($old_node$jscomp$1$$);
							try {
								$old_dir$$.$node_ops$.$rename$($old_node$jscomp$1$$, $lookup$jscomp$4_new_dir$jscomp$1$$, $new_name$jscomp$1$$), $old_node$jscomp$1$$.parent = $lookup$jscomp$4_new_dir$jscomp$1$$;
							} catch ($e$jscomp$17$$) {
								throw $e$jscomp$17$$;
							} finally {
								$JSCompiler_StaticMethods_hashAddNode$$($old_node$jscomp$1$$);
							}
						}
					},
					$rmdir$($name$jscomp$98_path$jscomp$21$$) {
						var $parent$jscomp$25$$ = $JSCompiler_StaticMethods_lookupPath$$($name$jscomp$98_path$jscomp$21$$, { parent: !0 }).node;
						$name$jscomp$98_path$jscomp$21$$ = $PATH$basename$$($name$jscomp$98_path$jscomp$21$$);
						var $node$jscomp$36$$ = $JSCompiler_StaticMethods_lookupNode$$($parent$jscomp$25$$, $name$jscomp$98_path$jscomp$21$$), $errCode$jscomp$8$$ = $JSCompiler_StaticMethods_mayDelete$$($parent$jscomp$25$$, $name$jscomp$98_path$jscomp$21$$, !0);
						if ($errCode$jscomp$8$$) throw new $FS$$.$ErrnoError$($errCode$jscomp$8$$);
						if (!$parent$jscomp$25$$.$node_ops$.$rmdir$) throw new $FS$$.$ErrnoError$(63);
						if ($node$jscomp$36$$.$mounted$) throw new $FS$$.$ErrnoError$(10);
						$parent$jscomp$25$$.$node_ops$.$rmdir$($parent$jscomp$25$$, $name$jscomp$98_path$jscomp$21$$);
						$JSCompiler_StaticMethods_hashRemoveNode$$($node$jscomp$36$$);
					},
					$readdir$($node$jscomp$37_path$jscomp$22$$) {
						$node$jscomp$37_path$jscomp$22$$ = $JSCompiler_StaticMethods_lookupPath$$($node$jscomp$37_path$jscomp$22$$, { $follow$: !0 }).node;
						return $JSCompiler_StaticMethods_checkOpExists$$($node$jscomp$37_path$jscomp$22$$.$node_ops$.$readdir$, 54)($node$jscomp$37_path$jscomp$22$$);
					},
					$unlink$($name$jscomp$99_path$jscomp$23$$) {
						var $parent$jscomp$26$$ = $JSCompiler_StaticMethods_lookupPath$$($name$jscomp$99_path$jscomp$23$$, { parent: !0 }).node;
						if (!$parent$jscomp$26$$) throw new $FS$$.$ErrnoError$(44);
						$name$jscomp$99_path$jscomp$23$$ = $PATH$basename$$($name$jscomp$99_path$jscomp$23$$);
						var $node$jscomp$38$$ = $JSCompiler_StaticMethods_lookupNode$$($parent$jscomp$26$$, $name$jscomp$99_path$jscomp$23$$), $errCode$jscomp$9$$ = $JSCompiler_StaticMethods_mayDelete$$($parent$jscomp$26$$, $name$jscomp$99_path$jscomp$23$$, !1);
						if ($errCode$jscomp$9$$) throw new $FS$$.$ErrnoError$($errCode$jscomp$9$$);
						if (!$parent$jscomp$26$$.$node_ops$.$unlink$) throw new $FS$$.$ErrnoError$(63);
						if ($node$jscomp$38$$.$mounted$) throw new $FS$$.$ErrnoError$(10);
						$parent$jscomp$26$$.$node_ops$.$unlink$($parent$jscomp$26$$, $name$jscomp$99_path$jscomp$23$$);
						$JSCompiler_StaticMethods_hashRemoveNode$$($node$jscomp$38$$);
					},
					$readlink$($link$jscomp$1_path$jscomp$24$$) {
						$link$jscomp$1_path$jscomp$24$$ = $JSCompiler_StaticMethods_lookupPath$$($link$jscomp$1_path$jscomp$24$$).node;
						if (!$link$jscomp$1_path$jscomp$24$$) throw new $FS$$.$ErrnoError$(44);
						if (!$link$jscomp$1_path$jscomp$24$$.$node_ops$.$readlink$) throw new $FS$$.$ErrnoError$(28);
						return $link$jscomp$1_path$jscomp$24$$.$node_ops$.$readlink$($link$jscomp$1_path$jscomp$24$$);
					},
					stat($node$jscomp$39_path$jscomp$25$$, $dontFollow$$) {
						$node$jscomp$39_path$jscomp$25$$ = $JSCompiler_StaticMethods_lookupPath$$($node$jscomp$39_path$jscomp$25$$, { $follow$: !$dontFollow$$ }).node;
						return $JSCompiler_StaticMethods_checkOpExists$$($node$jscomp$39_path$jscomp$25$$.$node_ops$.$getattr$, 63)($node$jscomp$39_path$jscomp$25$$);
					},
					$lchmod$($path$jscomp$28$$, $mode$jscomp$37$$) {
						$JSCompiler_StaticMethods_chmod$$($path$jscomp$28$$, $mode$jscomp$37$$, !0);
					},
					$lchown$($node$jscomp$inline_93_path$jscomp$30$$) {
						$node$jscomp$inline_93_path$jscomp$30$$ = "string" == typeof $node$jscomp$inline_93_path$jscomp$30$$ ? $JSCompiler_StaticMethods_lookupPath$$($node$jscomp$inline_93_path$jscomp$30$$, { $follow$: !1 }).node : $node$jscomp$inline_93_path$jscomp$30$$;
						$JSCompiler_StaticMethods_doSetAttr$$(null, $node$jscomp$inline_93_path$jscomp$30$$, {
							timestamp: Date.now(),
							$dontFollow$: !0
						});
					},
					truncate($node$jscomp$46_path$jscomp$31$$, $len$jscomp$3$$) {
						if (0 > $len$jscomp$3$$) throw new $FS$$.$ErrnoError$(28);
						$node$jscomp$46_path$jscomp$31$$ = "string" == typeof $node$jscomp$46_path$jscomp$31$$ ? $JSCompiler_StaticMethods_lookupPath$$($node$jscomp$46_path$jscomp$31$$, { $follow$: !0 }).node : $node$jscomp$46_path$jscomp$31$$;
						$JSCompiler_StaticMethods_doTruncate$$(null, $node$jscomp$46_path$jscomp$31$$, $len$jscomp$3$$);
					},
					open($path$jscomp$33$$, $flags$jscomp$9_stream$jscomp$30$$, $mode$jscomp$39$$ = 438) {
						if ("" === $path$jscomp$33$$) throw new $FS$$.$ErrnoError$(44);
						if ("string" == typeof $flags$jscomp$9_stream$jscomp$30$$) {
							var $flags$jscomp$inline_96_node$jscomp$48$$ = {
								r: 0,
								"r+": 2,
								w: 577,
								"w+": 578,
								a: 1089,
								"a+": 1090
							}[$flags$jscomp$9_stream$jscomp$30$$];
							if ("undefined" == typeof $flags$jscomp$inline_96_node$jscomp$48$$) throw Error(`Unknown file open mode: ${$flags$jscomp$9_stream$jscomp$30$$}`);
							$flags$jscomp$9_stream$jscomp$30$$ = $flags$jscomp$inline_96_node$jscomp$48$$;
						}
						$mode$jscomp$39$$ = $flags$jscomp$9_stream$jscomp$30$$ & 64 ? $mode$jscomp$39$$ & 4095 | 32768 : 0;
						if ("object" == typeof $path$jscomp$33$$) $flags$jscomp$inline_96_node$jscomp$48$$ = $path$jscomp$33$$;
						else {
							var $errCode$jscomp$11_isDirPath_mode$jscomp$inline_101_perms$jscomp$inline_246$$ = $path$jscomp$33$$.endsWith("/");
							var $created_lookup$jscomp$14$$ = $JSCompiler_StaticMethods_lookupPath$$($path$jscomp$33$$, {
								$follow$: !($flags$jscomp$9_stream$jscomp$30$$ & 131072),
								$noent_okay$: !0
							});
							$flags$jscomp$inline_96_node$jscomp$48$$ = $created_lookup$jscomp$14$$.node;
							$path$jscomp$33$$ = $created_lookup$jscomp$14$$.path;
						}
						$created_lookup$jscomp$14$$ = !1;
						if ($flags$jscomp$9_stream$jscomp$30$$ & 64) if ($flags$jscomp$inline_96_node$jscomp$48$$) {
							if ($flags$jscomp$9_stream$jscomp$30$$ & 128) throw new $FS$$.$ErrnoError$(20);
						} else {
							if ($errCode$jscomp$11_isDirPath_mode$jscomp$inline_101_perms$jscomp$inline_246$$) throw new $FS$$.$ErrnoError$(31);
							$flags$jscomp$inline_96_node$jscomp$48$$ = $FS$$.$mknod$($path$jscomp$33$$, $mode$jscomp$39$$ | 511, 0);
							$created_lookup$jscomp$14$$ = !0;
						}
						if (!$flags$jscomp$inline_96_node$jscomp$48$$) throw new $FS$$.$ErrnoError$(44);
						8192 === ($flags$jscomp$inline_96_node$jscomp$48$$.mode & 61440) && ($flags$jscomp$9_stream$jscomp$30$$ &= -513);
						if ($flags$jscomp$9_stream$jscomp$30$$ & 65536 && !$JSCompiler_StaticMethods_isDir$$($flags$jscomp$inline_96_node$jscomp$48$$.mode)) throw new $FS$$.$ErrnoError$(54);
						if (!$created_lookup$jscomp$14$$ && ($flags$jscomp$inline_96_node$jscomp$48$$ ? 40960 === ($flags$jscomp$inline_96_node$jscomp$48$$.mode & 61440) ? $errCode$jscomp$11_isDirPath_mode$jscomp$inline_101_perms$jscomp$inline_246$$ = 32 : ($errCode$jscomp$11_isDirPath_mode$jscomp$inline_101_perms$jscomp$inline_246$$ = [
							"r",
							"w",
							"rw"
						][$flags$jscomp$9_stream$jscomp$30$$ & 3], $flags$jscomp$9_stream$jscomp$30$$ & 512 && ($errCode$jscomp$11_isDirPath_mode$jscomp$inline_101_perms$jscomp$inline_246$$ += "w"), $errCode$jscomp$11_isDirPath_mode$jscomp$inline_101_perms$jscomp$inline_246$$ = $JSCompiler_StaticMethods_isDir$$($flags$jscomp$inline_96_node$jscomp$48$$.mode) && ("r" !== $errCode$jscomp$11_isDirPath_mode$jscomp$inline_101_perms$jscomp$inline_246$$ || $flags$jscomp$9_stream$jscomp$30$$ & 576) ? 31 : $JSCompiler_StaticMethods_nodePermissions$$($flags$jscomp$inline_96_node$jscomp$48$$, $errCode$jscomp$11_isDirPath_mode$jscomp$inline_101_perms$jscomp$inline_246$$)) : $errCode$jscomp$11_isDirPath_mode$jscomp$inline_101_perms$jscomp$inline_246$$ = 44, $errCode$jscomp$11_isDirPath_mode$jscomp$inline_101_perms$jscomp$inline_246$$)) throw new $FS$$.$ErrnoError$($errCode$jscomp$11_isDirPath_mode$jscomp$inline_101_perms$jscomp$inline_246$$);
						$flags$jscomp$9_stream$jscomp$30$$ & 512 && !$created_lookup$jscomp$14$$ && $FS$$.truncate($flags$jscomp$inline_96_node$jscomp$48$$, 0);
						$flags$jscomp$9_stream$jscomp$30$$ &= -131713;
						$flags$jscomp$9_stream$jscomp$30$$ = $JSCompiler_StaticMethods_createStream$$({
							node: $flags$jscomp$inline_96_node$jscomp$48$$,
							path: $JSCompiler_StaticMethods_getPath$$($flags$jscomp$inline_96_node$jscomp$48$$),
							flags: $flags$jscomp$9_stream$jscomp$30$$,
							seekable: !0,
							position: 0,
							$stream_ops$: $flags$jscomp$inline_96_node$jscomp$48$$.$stream_ops$,
							$ungotten$: [],
							error: !1
						});
						$flags$jscomp$9_stream$jscomp$30$$.$stream_ops$.open && $flags$jscomp$9_stream$jscomp$30$$.$stream_ops$.open($flags$jscomp$9_stream$jscomp$30$$);
						$created_lookup$jscomp$14$$ && $JSCompiler_StaticMethods_chmod$$($flags$jscomp$inline_96_node$jscomp$48$$, $mode$jscomp$39$$ & 511);
						return $flags$jscomp$9_stream$jscomp$30$$;
					},
					close($stream$jscomp$31$$) {
						if (null === $stream$jscomp$31$$.$fd$) throw new $FS$$.$ErrnoError$(8);
						$stream$jscomp$31$$.$getdents$ && ($stream$jscomp$31$$.$getdents$ = null);
						try {
							$stream$jscomp$31$$.$stream_ops$.close && $stream$jscomp$31$$.$stream_ops$.close($stream$jscomp$31$$);
						} catch ($e$jscomp$18$$) {
							throw $e$jscomp$18$$;
						} finally {
							$FS$$.streams[$stream$jscomp$31$$.$fd$] = null;
						}
						$stream$jscomp$31$$.$fd$ = null;
					},
					$llseek$($stream$jscomp$33$$, $offset$jscomp$35$$, $whence$jscomp$2$$) {
						if (null === $stream$jscomp$33$$.$fd$) throw new $FS$$.$ErrnoError$(8);
						if (!$stream$jscomp$33$$.seekable || !$stream$jscomp$33$$.$stream_ops$.$llseek$) throw new $FS$$.$ErrnoError$(70);
						if (0 != $whence$jscomp$2$$ && 1 != $whence$jscomp$2$$ && 2 != $whence$jscomp$2$$) throw new $FS$$.$ErrnoError$(28);
						$stream$jscomp$33$$.position = $stream$jscomp$33$$.$stream_ops$.$llseek$($stream$jscomp$33$$, $offset$jscomp$35$$, $whence$jscomp$2$$);
						$stream$jscomp$33$$.$ungotten$ = [];
						return $stream$jscomp$33$$.position;
					},
					read($stream$jscomp$34$$, $buffer$jscomp$25_bytesRead$jscomp$1$$, $offset$jscomp$36$$, $length$jscomp$26$$, $position$jscomp$8$$) {
						$assert$$(0 <= $offset$jscomp$36$$);
						if (0 > $length$jscomp$26$$ || 0 > $position$jscomp$8$$) throw new $FS$$.$ErrnoError$(28);
						if (null === $stream$jscomp$34$$.$fd$) throw new $FS$$.$ErrnoError$(8);
						if (1 === ($stream$jscomp$34$$.flags & 2097155)) throw new $FS$$.$ErrnoError$(8);
						if ($JSCompiler_StaticMethods_isDir$$($stream$jscomp$34$$.node.mode)) throw new $FS$$.$ErrnoError$(31);
						if (!$stream$jscomp$34$$.$stream_ops$.read) throw new $FS$$.$ErrnoError$(28);
						var $seeking$$ = "undefined" != typeof $position$jscomp$8$$;
						if (!$seeking$$) $position$jscomp$8$$ = $stream$jscomp$34$$.position;
						else if (!$stream$jscomp$34$$.seekable) throw new $FS$$.$ErrnoError$(70);
						$buffer$jscomp$25_bytesRead$jscomp$1$$ = $stream$jscomp$34$$.$stream_ops$.read($stream$jscomp$34$$, $buffer$jscomp$25_bytesRead$jscomp$1$$, $offset$jscomp$36$$, $length$jscomp$26$$, $position$jscomp$8$$);
						$seeking$$ || ($stream$jscomp$34$$.position += $buffer$jscomp$25_bytesRead$jscomp$1$$);
						return $buffer$jscomp$25_bytesRead$jscomp$1$$;
					},
					write($stream$jscomp$35$$, $buffer$jscomp$26_bytesWritten$jscomp$1$$, $offset$jscomp$37$$, $length$jscomp$27$$, $position$jscomp$9$$, $canOwn$jscomp$3$$) {
						$assert$$(0 <= $offset$jscomp$37$$);
						$assert$$($buffer$jscomp$26_bytesWritten$jscomp$1$$.subarray, "FS.write expects a TypedArray");
						if (0 > $length$jscomp$27$$ || 0 > $position$jscomp$9$$) throw new $FS$$.$ErrnoError$(28);
						if (null === $stream$jscomp$35$$.$fd$) throw new $FS$$.$ErrnoError$(8);
						if (0 === ($stream$jscomp$35$$.flags & 2097155)) throw new $FS$$.$ErrnoError$(8);
						if ($JSCompiler_StaticMethods_isDir$$($stream$jscomp$35$$.node.mode)) throw new $FS$$.$ErrnoError$(31);
						if (!$stream$jscomp$35$$.$stream_ops$.write) throw new $FS$$.$ErrnoError$(28);
						$stream$jscomp$35$$.seekable && $stream$jscomp$35$$.flags & 1024 && $FS$$.$llseek$($stream$jscomp$35$$, 0, 2);
						var $seeking$jscomp$1$$ = "undefined" != typeof $position$jscomp$9$$;
						if (!$seeking$jscomp$1$$) $position$jscomp$9$$ = $stream$jscomp$35$$.position;
						else if (!$stream$jscomp$35$$.seekable) throw new $FS$$.$ErrnoError$(70);
						$buffer$jscomp$26_bytesWritten$jscomp$1$$ = $stream$jscomp$35$$.$stream_ops$.write($stream$jscomp$35$$, $buffer$jscomp$26_bytesWritten$jscomp$1$$, $offset$jscomp$37$$, $length$jscomp$27$$, $position$jscomp$9$$, $canOwn$jscomp$3$$);
						$seeking$jscomp$1$$ || ($stream$jscomp$35$$.position += $buffer$jscomp$26_bytesWritten$jscomp$1$$);
						return $buffer$jscomp$26_bytesWritten$jscomp$1$$;
					},
					$mmap$($stream$jscomp$36$$, $length$jscomp$28$$, $position$jscomp$10$$, $prot$jscomp$1$$, $flags$jscomp$10$$) {
						if (0 !== ($prot$jscomp$1$$ & 2) && 0 === ($flags$jscomp$10$$ & 2) && 2 !== ($stream$jscomp$36$$.flags & 2097155)) throw new $FS$$.$ErrnoError$(2);
						if (1 === ($stream$jscomp$36$$.flags & 2097155)) throw new $FS$$.$ErrnoError$(2);
						if (!$stream$jscomp$36$$.$stream_ops$.$mmap$) throw new $FS$$.$ErrnoError$(43);
						if (!$length$jscomp$28$$) throw new $FS$$.$ErrnoError$(28);
						return $stream$jscomp$36$$.$stream_ops$.$mmap$($stream$jscomp$36$$, $length$jscomp$28$$, $position$jscomp$10$$, $prot$jscomp$1$$, $flags$jscomp$10$$);
					},
					$msync$($stream$jscomp$37$$, $buffer$jscomp$27$$, $offset$jscomp$38$$, $length$jscomp$29$$, $mmapFlags$jscomp$1$$) {
						$assert$$(0 <= $offset$jscomp$38$$);
						return $stream$jscomp$37$$.$stream_ops$.$msync$ ? $stream$jscomp$37$$.$stream_ops$.$msync$($stream$jscomp$37$$, $buffer$jscomp$27$$, $offset$jscomp$38$$, $length$jscomp$29$$, $mmapFlags$jscomp$1$$) : 0;
					},
					$ioctl$($stream$jscomp$38$$, $cmd$$, $arg$jscomp$10$$) {
						if (!$stream$jscomp$38$$.$stream_ops$.$ioctl$) throw new $FS$$.$ErrnoError$(59);
						return $stream$jscomp$38$$.$stream_ops$.$ioctl$($stream$jscomp$38$$, $cmd$$, $arg$jscomp$10$$);
					},
					$readFile$($length$jscomp$30_path$jscomp$34$$, $opts$jscomp$2$$ = {}) {
						$opts$jscomp$2$$.flags = $opts$jscomp$2$$.flags || 0;
						$opts$jscomp$2$$.encoding = $opts$jscomp$2$$.encoding || "binary";
						"utf8" !== $opts$jscomp$2$$.encoding && "binary" !== $opts$jscomp$2$$.encoding && $abort$$(`Invalid encoding type "${$opts$jscomp$2$$.encoding}"`);
						var $stream$jscomp$39$$ = $FS$$.open($length$jscomp$30_path$jscomp$34$$, $opts$jscomp$2$$.flags);
						$length$jscomp$30_path$jscomp$34$$ = $FS$$.stat($length$jscomp$30_path$jscomp$34$$).size;
						var $buf$$ = new Uint8Array($length$jscomp$30_path$jscomp$34$$);
						$FS$$.read($stream$jscomp$39$$, $buf$$, 0, $length$jscomp$30_path$jscomp$34$$, 0);
						"utf8" === $opts$jscomp$2$$.encoding && ($buf$$ = $UTF8ArrayToString$$($buf$$));
						$FS$$.close($stream$jscomp$39$$);
						return $buf$$;
					},
					$writeFile$($path$jscomp$35_stream$jscomp$40$$, $data$jscomp$83$$, $opts$jscomp$3$$ = {}) {
						$opts$jscomp$3$$.flags = $opts$jscomp$3$$.flags || 577;
						$path$jscomp$35_stream$jscomp$40$$ = $FS$$.open($path$jscomp$35_stream$jscomp$40$$, $opts$jscomp$3$$.flags, $opts$jscomp$3$$.mode);
						$data$jscomp$83$$ = $FS_fileDataToTypedArray$$($data$jscomp$83$$);
						$FS$$.write($path$jscomp$35_stream$jscomp$40$$, $data$jscomp$83$$, 0, $data$jscomp$83$$.byteLength, void 0, $opts$jscomp$3$$.$canOwn$);
						$FS$$.close($path$jscomp$35_stream$jscomp$40$$);
					},
					$cwd$: () => $FS$$.$currentPath$,
					$chdir$($lookup$jscomp$15_path$jscomp$36$$) {
						$lookup$jscomp$15_path$jscomp$36$$ = $JSCompiler_StaticMethods_lookupPath$$($lookup$jscomp$15_path$jscomp$36$$, { $follow$: !0 });
						if (null === $lookup$jscomp$15_path$jscomp$36$$.node) throw new $FS$$.$ErrnoError$(44);
						if (!$JSCompiler_StaticMethods_isDir$$($lookup$jscomp$15_path$jscomp$36$$.node.mode)) throw new $FS$$.$ErrnoError$(54);
						var $errCode$jscomp$12$$ = $JSCompiler_StaticMethods_nodePermissions$$($lookup$jscomp$15_path$jscomp$36$$.node, "x");
						if ($errCode$jscomp$12$$) throw new $FS$$.$ErrnoError$($errCode$jscomp$12$$);
						$FS$$.$currentPath$ = $lookup$jscomp$15_path$jscomp$36$$.path;
					},
					$quit$() {
						$FS$$.$initialized$ = !1;
						$_fflush$$(0);
						for (var $stream$jscomp$43$$ of $FS$$.streams) $stream$jscomp$43$$ && $FS$$.close($stream$jscomp$43$$);
					},
					$findObject$($path$jscomp$37_ret$jscomp$1$$, $dontResolveLastLink$$) {
						$path$jscomp$37_ret$jscomp$1$$ = $JSCompiler_StaticMethods_analyzePath$$($path$jscomp$37_ret$jscomp$1$$, $dontResolveLastLink$$);
						return $path$jscomp$37_ret$jscomp$1$$.$exists$ ? $path$jscomp$37_ret$jscomp$1$$.object : null;
					},
					$createPath$($parent$jscomp$28$$, $parts$jscomp$4_path$jscomp$39$$) {
						$parent$jscomp$28$$ = "string" == typeof $parent$jscomp$28$$ ? $parent$jscomp$28$$ : $JSCompiler_StaticMethods_getPath$$($parent$jscomp$28$$);
						for ($parts$jscomp$4_path$jscomp$39$$ = $parts$jscomp$4_path$jscomp$39$$.split("/").reverse(); $parts$jscomp$4_path$jscomp$39$$.length;) {
							var $part$$ = $parts$jscomp$4_path$jscomp$39$$.pop();
							if ($part$$) {
								var $current$jscomp$3$$ = $PATH$normalize$$($parent$jscomp$28$$ + "/" + $part$$);
								try {
									$JSCompiler_StaticMethods_mkdir$$($current$jscomp$3$$);
								} catch ($e$jscomp$21$$) {
									if (20 != $e$jscomp$21$$.$errno$) throw $e$jscomp$21$$;
								}
								$parent$jscomp$28$$ = $current$jscomp$3$$;
							}
						}
						return $current$jscomp$3$$;
					},
					$createDevice$($parent$jscomp$31_path$jscomp$42$$, $mode$jscomp$42_name$jscomp$103$$, $input$jscomp$11$$, $output$jscomp$4$$) {
						$parent$jscomp$31_path$jscomp$42$$ = $PATH$join2$$("string" == typeof $parent$jscomp$31_path$jscomp$42$$ ? $parent$jscomp$31_path$jscomp$42$$ : $JSCompiler_StaticMethods_getPath$$($parent$jscomp$31_path$jscomp$42$$), $mode$jscomp$42_name$jscomp$103$$);
						$mode$jscomp$42_name$jscomp$103$$ = $FS_getMode$$(!!$input$jscomp$11$$, !!$output$jscomp$4$$);
						var $$jscomp$logical$assign$tmp301936253$6_dev$jscomp$11$$;
						($$jscomp$logical$assign$tmp301936253$6_dev$jscomp$11$$ = $FS$$.$createDevice$).$major$ ?? ($$jscomp$logical$assign$tmp301936253$6_dev$jscomp$11$$.$major$ = 64);
						$$jscomp$logical$assign$tmp301936253$6_dev$jscomp$11$$ = $FS$$.$makedev$($FS$$.$createDevice$.$major$++, 0);
						$JSCompiler_StaticMethods_registerDevice$$($$jscomp$logical$assign$tmp301936253$6_dev$jscomp$11$$, {
							open($stream$jscomp$45$$) {
								$stream$jscomp$45$$.seekable = !1;
							},
							close() {
								$output$jscomp$4$$?.buffer?.length && $output$jscomp$4$$(10);
							},
							read($stream$jscomp$47$$, $buffer$jscomp$29$$, $offset$jscomp$40$$, $length$jscomp$32$$) {
								for (var $bytesRead$jscomp$2$$ = 0, $i$jscomp$16$$ = 0; $i$jscomp$16$$ < $length$jscomp$32$$; $i$jscomp$16$$++) {
									try {
										var $result$jscomp$6$$ = $input$jscomp$11$$();
									} catch ($e$jscomp$22$$) {
										throw new $FS$$.$ErrnoError$(29);
									}
									if (void 0 === $result$jscomp$6$$ && 0 === $bytesRead$jscomp$2$$) throw new $FS$$.$ErrnoError$(6);
									if (null === $result$jscomp$6$$ || void 0 === $result$jscomp$6$$) break;
									$bytesRead$jscomp$2$$++;
									$buffer$jscomp$29$$[$offset$jscomp$40$$ + $i$jscomp$16$$] = $result$jscomp$6$$;
								}
								$bytesRead$jscomp$2$$ && ($stream$jscomp$47$$.node.$atime$ = Date.now());
								return $bytesRead$jscomp$2$$;
							},
							write($stream$jscomp$48$$, $buffer$jscomp$30$$, $offset$jscomp$41$$, $length$jscomp$33$$) {
								for (var $i$jscomp$17$$ = 0; $i$jscomp$17$$ < $length$jscomp$33$$; $i$jscomp$17$$++) try {
									$output$jscomp$4$$($buffer$jscomp$30$$[$offset$jscomp$41$$ + $i$jscomp$17$$]);
								} catch ($e$jscomp$23$$) {
									throw new $FS$$.$ErrnoError$(29);
								}
								$length$jscomp$33$$ && ($stream$jscomp$48$$.node.$mtime$ = $stream$jscomp$48$$.node.$ctime$ = Date.now());
								return $i$jscomp$17$$;
							}
						});
						return $JSCompiler_StaticMethods_mkdev$$($parent$jscomp$31_path$jscomp$42$$, $mode$jscomp$42_name$jscomp$103$$, $$jscomp$logical$assign$tmp301936253$6_dev$jscomp$11$$);
					},
					$createLazyFile$($parent$jscomp$32_stream_ops$$, $name$jscomp$104$$, $url$jscomp$29$$, $canRead$jscomp$6$$, $canWrite$jscomp$6$$) {
						function $writeChunks$$($contents$jscomp$5_stream$jscomp$49$$, $buffer$jscomp$31$$, $offset$jscomp$42$$, $length$jscomp$34_size$jscomp$25$$, $position$jscomp$11$$) {
							$contents$jscomp$5_stream$jscomp$49$$ = $contents$jscomp$5_stream$jscomp$49$$.node.$contents$;
							if ($position$jscomp$11$$ >= $contents$jscomp$5_stream$jscomp$49$$.length) return 0;
							$length$jscomp$34_size$jscomp$25$$ = Math.min($contents$jscomp$5_stream$jscomp$49$$.length - $position$jscomp$11$$, $length$jscomp$34_size$jscomp$25$$);
							$assert$$(0 <= $length$jscomp$34_size$jscomp$25$$);
							if ($contents$jscomp$5_stream$jscomp$49$$.slice) for (var $i$jscomp$18$$ = 0; $i$jscomp$18$$ < $length$jscomp$34_size$jscomp$25$$; $i$jscomp$18$$++) $buffer$jscomp$31$$[$offset$jscomp$42$$ + $i$jscomp$18$$] = $contents$jscomp$5_stream$jscomp$49$$[$position$jscomp$11$$ + $i$jscomp$18$$];
							else for ($i$jscomp$18$$ = 0; $i$jscomp$18$$ < $length$jscomp$34_size$jscomp$25$$; $i$jscomp$18$$++) $buffer$jscomp$31$$[$offset$jscomp$42$$ + $i$jscomp$18$$] = $contents$jscomp$5_stream$jscomp$49$$.get($position$jscomp$11$$ + $i$jscomp$18$$);
							return $length$jscomp$34_size$jscomp$25$$;
						}
						class $LazyUint8Array$$ {
							$l$ = !1;
							$g$ = [];
							$h$ = void 0;
							$o$ = 0;
							$m$ = 0;
							get($idx$jscomp$3$$) {
								if (!($idx$jscomp$3$$ > this.length - 1 || 0 > $idx$jscomp$3$$)) {
									var $chunkOffset$$ = $idx$jscomp$3$$ % this.$u$;
									return this.$h$($idx$jscomp$3$$ / this.$u$ | 0)[$chunkOffset$$];
								}
							}
							$v$($getter$$) {
								this.$h$ = $getter$$;
							}
							$s$() {
								var $usesGzip_xhr$jscomp$1$$ = new XMLHttpRequest();
								$usesGzip_xhr$jscomp$1$$.open("HEAD", $url$jscomp$29$$, !1);
								$usesGzip_xhr$jscomp$1$$.send(null);
								200 <= $usesGzip_xhr$jscomp$1$$.status && 300 > $usesGzip_xhr$jscomp$1$$.status || 304 === $usesGzip_xhr$jscomp$1$$.status || $abort$$("Couldn't load " + $url$jscomp$29$$ + ". Status: " + $usesGzip_xhr$jscomp$1$$.status);
								var $datalength$$ = Number($usesGzip_xhr$jscomp$1$$.getResponseHeader("Content-length")), $header$jscomp$2$$, $hasByteServing$$ = ($header$jscomp$2$$ = $usesGzip_xhr$jscomp$1$$.getResponseHeader("Accept-Ranges")) && "bytes" === $header$jscomp$2$$;
								$usesGzip_xhr$jscomp$1$$ = ($header$jscomp$2$$ = $usesGzip_xhr$jscomp$1$$.getResponseHeader("Content-Encoding")) && "gzip" === $header$jscomp$2$$;
								var $chunkSize$$ = 1048576;
								$hasByteServing$$ || ($chunkSize$$ = $datalength$$);
								var $lazyArray$jscomp$1$$ = this;
								$lazyArray$jscomp$1$$.$v$(($chunkNum$jscomp$1$$) => {
									var $JSCompiler_inline_result$jscomp$15_start$jscomp$14$$ = $chunkNum$jscomp$1$$ * $chunkSize$$, $end$jscomp$12_to$jscomp$inline_107$$ = ($chunkNum$jscomp$1$$ + 1) * $chunkSize$$ - 1;
									$end$jscomp$12_to$jscomp$inline_107$$ = Math.min($end$jscomp$12_to$jscomp$inline_107$$, $datalength$$ - 1);
									if ("undefined" == typeof $lazyArray$jscomp$1$$.$g$[$chunkNum$jscomp$1$$]) {
										var $JSCompiler_temp_const$jscomp$14$$ = $lazyArray$jscomp$1$$.$g$;
										$JSCompiler_inline_result$jscomp$15_start$jscomp$14$$ > $end$jscomp$12_to$jscomp$inline_107$$ && $abort$$("invalid range (" + $JSCompiler_inline_result$jscomp$15_start$jscomp$14$$ + ", " + $end$jscomp$12_to$jscomp$inline_107$$ + ") or no bytes requested!");
										$end$jscomp$12_to$jscomp$inline_107$$ > $datalength$$ - 1 && $abort$$("only " + $datalength$$ + " bytes available! programmer error!");
										var $xhr$jscomp$inline_108$$ = new XMLHttpRequest();
										$xhr$jscomp$inline_108$$.open("GET", $url$jscomp$29$$, !1);
										$datalength$$ !== $chunkSize$$ && $xhr$jscomp$inline_108$$.setRequestHeader("Range", "bytes=" + $JSCompiler_inline_result$jscomp$15_start$jscomp$14$$ + "-" + $end$jscomp$12_to$jscomp$inline_107$$);
										$xhr$jscomp$inline_108$$.responseType = "arraybuffer";
										$xhr$jscomp$inline_108$$.overrideMimeType && $xhr$jscomp$inline_108$$.overrideMimeType("text/plain; charset=x-user-defined");
										$xhr$jscomp$inline_108$$.send(null);
										200 <= $xhr$jscomp$inline_108$$.status && 300 > $xhr$jscomp$inline_108$$.status || 304 === $xhr$jscomp$inline_108$$.status || $abort$$("Couldn't load " + $url$jscomp$29$$ + ". Status: " + $xhr$jscomp$inline_108$$.status);
										$JSCompiler_inline_result$jscomp$15_start$jscomp$14$$ = void 0 !== $xhr$jscomp$inline_108$$.response ? new Uint8Array($xhr$jscomp$inline_108$$.response || []) : $intArrayFromString$$($xhr$jscomp$inline_108$$.responseText || "");
										$JSCompiler_temp_const$jscomp$14$$[$chunkNum$jscomp$1$$] = $JSCompiler_inline_result$jscomp$15_start$jscomp$14$$;
									}
									"undefined" == typeof $lazyArray$jscomp$1$$.$g$[$chunkNum$jscomp$1$$] && $abort$$("doXHR failed!");
									return $lazyArray$jscomp$1$$.$g$[$chunkNum$jscomp$1$$];
								});
								if ($usesGzip_xhr$jscomp$1$$ || !$datalength$$) $chunkSize$$ = $datalength$$ = 1, $chunkSize$$ = $datalength$$ = this.$h$(0).length, $out$$("LazyFiles on gzip forces download of the whole file when length is accessed");
								this.$o$ = $datalength$$;
								this.$m$ = $chunkSize$$;
								this.$l$ = !0;
							}
							get length() {
								this.$l$ || this.$s$();
								return this.$o$;
							}
							get $u$() {
								this.$l$ || this.$s$();
								return this.$m$;
							}
						}
						if (globalThis.XMLHttpRequest) {
							$ENVIRONMENT_IS_WORKER$$ || $abort$$("Cannot do synchronous binary XHRs outside webworkers in modern browsers. Use --embed-file or --preload-file in emcc");
							var $JSCompiler_object_inline_contents_218$$ = new $LazyUint8Array$$();
							var $JSCompiler_object_inline_url_219$$ = void 0;
						} else $JSCompiler_object_inline_url_219$$ = $url$jscomp$29$$, $JSCompiler_object_inline_contents_218$$ = void 0;
						var $node$jscomp$51$$ = $JSCompiler_StaticMethods_createFile$$($parent$jscomp$32_stream_ops$$, $name$jscomp$104$$, $canRead$jscomp$6$$, $canWrite$jscomp$6$$);
						$JSCompiler_object_inline_contents_218$$ ? $node$jscomp$51$$.$contents$ = $JSCompiler_object_inline_contents_218$$ : $JSCompiler_object_inline_url_219$$ && ($node$jscomp$51$$.$contents$ = null, $node$jscomp$51$$.url = $JSCompiler_object_inline_url_219$$);
						Object.defineProperties($node$jscomp$51$$, { $usedBytes$: { get: function() {
							return this.$contents$.length;
						} } });
						$parent$jscomp$32_stream_ops$$ = {};
						for (const [$key$jscomp$43$$, $fn$$] of Object.entries($node$jscomp$51$$.$stream_ops$)) $parent$jscomp$32_stream_ops$$[$key$jscomp$43$$] = (...$args$jscomp$6$$) => {
							$JSCompiler_StaticMethods_forceLoadFile$$($node$jscomp$51$$);
							return $fn$$(...$args$jscomp$6$$);
						};
						$parent$jscomp$32_stream_ops$$.read = ($stream$jscomp$50$$, $buffer$jscomp$32$$, $offset$jscomp$43$$, $length$jscomp$35$$, $position$jscomp$12$$) => {
							$JSCompiler_StaticMethods_forceLoadFile$$($node$jscomp$51$$);
							return $writeChunks$$($stream$jscomp$50$$, $buffer$jscomp$32$$, $offset$jscomp$43$$, $length$jscomp$35$$, $position$jscomp$12$$);
						};
						$parent$jscomp$32_stream_ops$$.$mmap$ = ($stream$jscomp$51$$, $length$jscomp$36$$, $position$jscomp$13$$) => {
							$JSCompiler_StaticMethods_forceLoadFile$$($node$jscomp$51$$);
							var $ptr$jscomp$5$$ = $mmapAlloc$$($length$jscomp$36$$);
							if (!$ptr$jscomp$5$$) throw new $FS$$.$ErrnoError$(48);
							$writeChunks$$($stream$jscomp$51$$, $HEAP8$$, $ptr$jscomp$5$$, $length$jscomp$36$$, $position$jscomp$13$$);
							return {
								$ptr$: $ptr$jscomp$5$$,
								$allocated$: !0
							};
						};
						$node$jscomp$51$$.$stream_ops$ = $parent$jscomp$32_stream_ops$$;
						return $node$jscomp$51$$;
					}
				};
				function $SYSCALLS$calculateAt$$($dir$jscomp$5_dirfd$$, $path$jscomp$43$$, $allowEmpty$$) {
					if ("/" === $path$jscomp$43$$.charAt(0)) return $path$jscomp$43$$;
					$dir$jscomp$5_dirfd$$ = -100 === $dir$jscomp$5_dirfd$$ ? $FS$$.$cwd$() : $JSCompiler_StaticMethods_getStreamChecked$$($dir$jscomp$5_dirfd$$).path;
					if (0 == $path$jscomp$43$$.length) {
						if (!$allowEmpty$$) throw new $FS$$.$ErrnoError$(44);
						return $dir$jscomp$5_dirfd$$;
					}
					return $dir$jscomp$5_dirfd$$ + "/" + $path$jscomp$43$$;
				}
				function $SYSCALLS$writeStat$$($buf$jscomp$1$$, $stat$jscomp$1$$) {
					$HEAPU32$$[$buf$jscomp$1$$ >>> 2 >>> 0] = $stat$jscomp$1$$.$dev$;
					$HEAPU32$$[$buf$jscomp$1$$ + 4 >>> 2 >>> 0] = $stat$jscomp$1$$.mode;
					$HEAPU32$$[$buf$jscomp$1$$ + 8 >>> 2 >>> 0] = $stat$jscomp$1$$.$nlink$;
					$HEAPU32$$[$buf$jscomp$1$$ + 12 >>> 2 >>> 0] = $stat$jscomp$1$$.uid;
					$HEAPU32$$[$buf$jscomp$1$$ + 16 >>> 2 >>> 0] = $stat$jscomp$1$$.$gid$;
					$HEAPU32$$[$buf$jscomp$1$$ + 20 >>> 2 >>> 0] = $stat$jscomp$1$$.$rdev$;
					$HEAP64$$[$buf$jscomp$1$$ + 24 >>> 3 >>> 0] = BigInt($stat$jscomp$1$$.size);
					$HEAP32$$[$buf$jscomp$1$$ + 32 >>> 2 >>> 0] = 4096;
					$HEAP32$$[$buf$jscomp$1$$ + 36 >>> 2 >>> 0] = $stat$jscomp$1$$.$blocks$;
					var $atime$jscomp$1$$ = $stat$jscomp$1$$.$atime$.getTime(), $mtime$jscomp$2$$ = $stat$jscomp$1$$.$mtime$.getTime(), $ctime$$ = $stat$jscomp$1$$.$ctime$.getTime();
					$HEAP64$$[$buf$jscomp$1$$ + 40 >>> 3 >>> 0] = BigInt(Math.floor($atime$jscomp$1$$ / 1e3));
					$HEAPU32$$[$buf$jscomp$1$$ + 48 >>> 2 >>> 0] = $atime$jscomp$1$$ % 1e3 * 1e6;
					$HEAP64$$[$buf$jscomp$1$$ + 56 >>> 3 >>> 0] = BigInt(Math.floor($mtime$jscomp$2$$ / 1e3));
					$HEAPU32$$[$buf$jscomp$1$$ + 64 >>> 2 >>> 0] = $mtime$jscomp$2$$ % 1e3 * 1e6;
					$HEAP64$$[$buf$jscomp$1$$ + 72 >>> 3 >>> 0] = BigInt(Math.floor($ctime$$ / 1e3));
					$HEAPU32$$[$buf$jscomp$1$$ + 80 >>> 2 >>> 0] = $ctime$$ % 1e3 * 1e6;
					$HEAP64$$[$buf$jscomp$1$$ + 88 >>> 3 >>> 0] = BigInt($stat$jscomp$1$$.$ino$);
					return 0;
				}
				var $SYSCALLS$varargs$$ = void 0, $syscallGetVarargI$$ = () => {
					$assert$$(void 0 != $SYSCALLS$varargs$$);
					var $ret$jscomp$4$$ = $HEAP32$$[+$SYSCALLS$varargs$$ >>> 2 >>> 0];
					$SYSCALLS$varargs$$ += 4;
					return $ret$jscomp$4$$;
				}, $stringToUTF8$$ = ($str$jscomp$11$$, $outPtr$$, $maxBytesToWrite$jscomp$1$$) => {
					$assert$$("number" == typeof $maxBytesToWrite$jscomp$1$$, "stringToUTF8(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!");
					return $stringToUTF8Array$$($str$jscomp$11$$, $HEAPU8$$, $outPtr$$, $maxBytesToWrite$jscomp$1$$);
				}, $MONTH_DAYS_LEAP_CUMULATIVE$$ = [
					0,
					31,
					60,
					91,
					121,
					152,
					182,
					213,
					244,
					274,
					305,
					335
				], $MONTH_DAYS_REGULAR_CUMULATIVE$$ = [
					0,
					31,
					59,
					90,
					120,
					151,
					181,
					212,
					243,
					273,
					304,
					334
				], $readEmAsmArgsArray$$ = [], $UNWIND_CACHE$$ = {}, $convertFrameToPC$$ = ($frame$jscomp$1$$) => {
					var $match$$;
					if ($match$$ = /\bwasm-function\[\d+\]:(0x[0-9a-f]+)/.exec($frame$jscomp$1$$)) return +$match$$[1];
					if (/\bwasm-function\[(\d+)\]:(\d+)/.exec($frame$jscomp$1$$)) $warnOnce$$("legacy backtrace format detected, this version of v8 is no longer supported by the emscripten backtrace mechanism");
					else if ($match$$ = /:(\d+):\d+(?:\)|$)/.exec($frame$jscomp$1$$)) return 2147483648 | +$match$$[1];
					return 0;
				}, $saveInUnwindCache$$ = ($callstack_pc$$) => {
					for (var $line$jscomp$7$$ of $callstack_pc$$) ($callstack_pc$$ = $convertFrameToPC$$($line$jscomp$7$$)) && ($UNWIND_CACHE$$[$callstack_pc$$] = $line$jscomp$7$$);
				};
				function $_emscripten_pc_get_function$$($frame$jscomp$2_name$jscomp$106_pc$jscomp$1_str$jscomp$inline_110$$) {
					$frame$jscomp$2_name$jscomp$106_pc$jscomp$1_str$jscomp$inline_110$$ = $UNWIND_CACHE$$[$frame$jscomp$2_name$jscomp$106_pc$jscomp$1_str$jscomp$inline_110$$ >>> 0];
					if (!$frame$jscomp$2_name$jscomp$106_pc$jscomp$1_str$jscomp$inline_110$$) return 0;
					var $match$jscomp$1_size$jscomp$inline_111$$;
					if ($match$jscomp$1_size$jscomp$inline_111$$ = /^\s+at .*\.wasm\.(.*) \(.*\)$/.exec($frame$jscomp$2_name$jscomp$106_pc$jscomp$1_str$jscomp$inline_110$$)) $frame$jscomp$2_name$jscomp$106_pc$jscomp$1_str$jscomp$inline_110$$ = $match$jscomp$1_size$jscomp$inline_111$$[1];
					else if ($match$jscomp$1_size$jscomp$inline_111$$ = /^\s+at (.*) \(.*\)$/.exec($frame$jscomp$2_name$jscomp$106_pc$jscomp$1_str$jscomp$inline_110$$)) $frame$jscomp$2_name$jscomp$106_pc$jscomp$1_str$jscomp$inline_110$$ = $match$jscomp$1_size$jscomp$inline_111$$[1];
					else if ($match$jscomp$1_size$jscomp$inline_111$$ = /^(.+?)@/.exec($frame$jscomp$2_name$jscomp$106_pc$jscomp$1_str$jscomp$inline_110$$)) $frame$jscomp$2_name$jscomp$106_pc$jscomp$1_str$jscomp$inline_110$$ = $match$jscomp$1_size$jscomp$inline_111$$[1];
					else return 0;
					$_free$$($_emscripten_pc_get_function$$.$ret$ ?? 0);
					$match$jscomp$1_size$jscomp$inline_111$$ = $lengthBytesUTF8$$($frame$jscomp$2_name$jscomp$106_pc$jscomp$1_str$jscomp$inline_110$$) + 1;
					var $ret$jscomp$inline_112$$ = $_malloc$$($match$jscomp$1_size$jscomp$inline_111$$);
					$ret$jscomp$inline_112$$ && $stringToUTF8$$($frame$jscomp$2_name$jscomp$106_pc$jscomp$1_str$jscomp$inline_110$$, $ret$jscomp$inline_112$$, $match$jscomp$1_size$jscomp$inline_111$$);
					$_emscripten_pc_get_function$$.$ret$ = $ret$jscomp$inline_112$$;
					return $_emscripten_pc_get_function$$.$ret$;
				}
				var $ENV$$ = {}, $getEnvStrings$$ = () => {
					if (!$getEnvStrings$strings$$) {
						var $env$$ = {
							USER: "web_user",
							LOGNAME: "web_user",
							PATH: "/",
							PWD: "/",
							HOME: "/home/web_user",
							LANG: (globalThis.navigator?.language ?? "C").replace("-", "_") + ".UTF-8",
							_: $thisProgram$$ || "./this.program"
						}, $x$jscomp$92$$;
						for ($x$jscomp$92$$ in $ENV$$) void 0 === $ENV$$[$x$jscomp$92$$] ? delete $env$$[$x$jscomp$92$$] : $env$$[$x$jscomp$92$$] = $ENV$$[$x$jscomp$92$$];
						var $strings$$ = [];
						for ($x$jscomp$92$$ in $env$$) $strings$$.push(`${$x$jscomp$92$$}=${$env$$[$x$jscomp$92$$]}`);
						$getEnvStrings$strings$$ = $strings$$;
					}
					return $getEnvStrings$strings$$;
				}, $getEnvStrings$strings$$, $_proc_exit$$ = ($code$jscomp$4$$) => {
					$EXITSTATUS$$ = $code$jscomp$4$$;
					$noExitRuntime$$ || ($Module$$.onExit?.($code$jscomp$4$$), $ABORT$$ = !0);
					throw new $ExitStatus$$($code$jscomp$4$$);
				}, $exitJS$$ = ($status$jscomp$2$$, $implicit_msg$jscomp$1$$) => {
					$EXITSTATUS$$ = $status$jscomp$2$$;
					$checkUnflushedContent$$();
					$noExitRuntime$$ && !$implicit_msg$jscomp$1$$ && ($implicit_msg$jscomp$1$$ = `program exited (with status: ${$status$jscomp$2$$}), but keepRuntimeAlive() is set (counter=0) due to an async operation, so halting execution but not exiting the runtime or preventing further async execution (you can use emscripten_force_exit, if you want to force a true shutdown)`, $readyPromiseReject$$?.($implicit_msg$jscomp$1$$), $err$$($implicit_msg$jscomp$1$$));
					$_proc_exit$$($status$jscomp$2$$);
				}, $stringToUTF8OnStack$$ = ($str$jscomp$15$$) => {
					var $size$jscomp$30$$ = $lengthBytesUTF8$$($str$jscomp$15$$) + 1, $ret$jscomp$10$$ = $__emscripten_stack_alloc$$($size$jscomp$30$$);
					$stringToUTF8$$($str$jscomp$15$$, $ret$jscomp$10$$, $size$jscomp$30$$);
					return $ret$jscomp$10$$;
				}, $getCFunc$$ = ($ident$jscomp$1$$) => {
					var $func$jscomp$7$$ = $Module$$["_" + $ident$jscomp$1$$];
					$assert$$($func$jscomp$7$$, "Cannot call unknown function " + $ident$jscomp$1$$ + ", make sure it is exported");
					return $func$jscomp$7$$;
				}, $wasmTableMirror$$ = [], $functionsInTableMap$$, $freeTableIndexes$$ = [], $uleb128EncodeWithLen$$ = ($arr$jscomp$4$$) => {
					const $n$jscomp$4$$ = $arr$jscomp$4$$.length;
					$assert$$(16384 > $n$jscomp$4$$);
					return [
						$n$jscomp$4$$ % 128 | 128,
						$n$jscomp$4$$ >> 7,
						...$arr$jscomp$4$$
					];
				}, $wasmTypeCodes$$ = {
					i: 127,
					p: 127,
					j: 126,
					f: 125,
					d: 124,
					e: 111
				}, $generateTypePack$$ = ($types$$) => $uleb128EncodeWithLen$$(Array.from($types$$, ($type$jscomp$169$$) => {
					var $code$jscomp$5$$ = $wasmTypeCodes$$[$type$jscomp$169$$];
					$assert$$($code$jscomp$5$$, `invalid signature char: ${$type$jscomp$169$$}`);
					return $code$jscomp$5$$;
				}));
				$FS$$.$createPreloadedFile$ = ($parent$jscomp$18$$, $name$jscomp$89$$, $url$jscomp$28$$, $canRead$jscomp$2$$, $canWrite$jscomp$2$$, $onload$$, $onerror$$, $dontCreateFile$jscomp$1$$, $canOwn$jscomp$2$$, $preFinish$jscomp$1$$) => {
					$FS_preloadFile$$($parent$jscomp$18$$, $name$jscomp$89$$, $url$jscomp$28$$, $canRead$jscomp$2$$, $canWrite$jscomp$2$$, $dontCreateFile$jscomp$1$$, $canOwn$jscomp$2$$, $preFinish$jscomp$1$$).then($onload$$).catch($onerror$$);
				};
				$FS$$.$preloadFile$ = $FS_preloadFile$$;
				$FS$$.$nameTable$ = Array(4096);
				$FS$$.$mount$($MEMFS$$, {}, "/");
				$JSCompiler_StaticMethods_mkdir$$("/tmp");
				$JSCompiler_StaticMethods_mkdir$$("/home");
				$JSCompiler_StaticMethods_mkdir$$("/home/web_user");
				(function() {
					$JSCompiler_StaticMethods_mkdir$$("/dev");
					$JSCompiler_StaticMethods_registerDevice$$($FS$$.$makedev$(1, 3), {
						read: () => 0,
						write: ($stream$jscomp$41$$, $buffer$jscomp$28$$, $offset$jscomp$39$$, $length$jscomp$31$$) => $length$jscomp$31$$,
						$llseek$: () => 0
					});
					$JSCompiler_StaticMethods_mkdev$$("/dev/null", $FS$$.$makedev$(1, 3));
					$TTY$register$$($FS$$.$makedev$(5, 0), $TTY$default_tty_ops$$);
					$TTY$register$$($FS$$.$makedev$(6, 0), $TTY$default_tty1_ops$$);
					$JSCompiler_StaticMethods_mkdev$$("/dev/tty", $FS$$.$makedev$(5, 0));
					$JSCompiler_StaticMethods_mkdev$$("/dev/tty1", $FS$$.$makedev$(6, 0));
					var $randomBuffer$$ = /* @__PURE__ */ new Uint8Array(1024), $randomLeft$$ = 0, $randomByte$$ = () => {
						0 === $randomLeft$$ && ($randomFill$$($randomBuffer$$), $randomLeft$$ = $randomBuffer$$.byteLength);
						return $randomBuffer$$[--$randomLeft$$];
					};
					$FS$$.$createDevice$("/dev", "random", $randomByte$$);
					$FS$$.$createDevice$("/dev", "urandom", $randomByte$$);
					$JSCompiler_StaticMethods_mkdir$$("/dev/shm");
					$JSCompiler_StaticMethods_mkdir$$("/dev/shm/tmp");
				})();
				(function() {
					$JSCompiler_StaticMethods_mkdir$$("/proc");
					var $proc_self$$ = $JSCompiler_StaticMethods_mkdir$$("/proc/self");
					$JSCompiler_StaticMethods_mkdir$$("/proc/self/fd");
					$FS$$.$mount$({ $mount$() {
						var $node$jscomp$49$$ = $FS$$.createNode($proc_self$$, "fd", 16895, 73);
						$node$jscomp$49$$.$stream_ops$ = { $llseek$: $MEMFS$$.$stream_ops$.$llseek$ };
						$node$jscomp$49$$.$node_ops$ = {
							$lookup$($fd$jscomp$10_parent$jscomp$27_ret$$, $name$jscomp$100$$) {
								$fd$jscomp$10_parent$jscomp$27_ret$$ = +$name$jscomp$100$$;
								var $stream$jscomp$42$$ = $JSCompiler_StaticMethods_getStreamChecked$$($fd$jscomp$10_parent$jscomp$27_ret$$);
								$fd$jscomp$10_parent$jscomp$27_ret$$ = {
									parent: null,
									$mount$: { $mountpoint$: "fake" },
									$node_ops$: { $readlink$: () => $stream$jscomp$42$$.path },
									id: $fd$jscomp$10_parent$jscomp$27_ret$$ + 1
								};
								return $fd$jscomp$10_parent$jscomp$27_ret$$.parent = $fd$jscomp$10_parent$jscomp$27_ret$$;
							},
							$readdir$() {
								return Array.from($FS$$.streams.entries()).filter(([, $v$$]) => $v$$).map(([$k$jscomp$1$$]) => $k$jscomp$1$$.toString());
							}
						};
						return $node$jscomp$49$$;
					} }, {}, "/proc/self/fd");
				})();
				$FS$$.$filesystems$ = {
					MEMFS: $MEMFS$$,
					WORKERFS: $WORKERFS$$
				};
				$Module$$.noExitRuntime && ($noExitRuntime$$ = $Module$$.noExitRuntime);
				$Module$$.preloadPlugins && ($preloadPlugins$$ = $Module$$.preloadPlugins);
				$Module$$.print && ($out$$ = $Module$$.print);
				$Module$$.printErr && ($err$$ = $Module$$.printErr);
				$Module$$.wasmBinary && ($wasmBinary$$ = $Module$$.wasmBinary);
				$ignoredModuleProp$$("fetchSettings");
				$ignoredModuleProp$$("logReadFiles");
				$ignoredModuleProp$$("loadSplitModule");
				$ignoredModuleProp$$("onMalloc");
				$ignoredModuleProp$$("onRealloc");
				$ignoredModuleProp$$("onFree");
				$ignoredModuleProp$$("onSbrkGrow");
				$Module$$.arguments && ($arguments_$$ = $Module$$.arguments);
				$Module$$.thisProgram && ($thisProgram$$ = $Module$$.thisProgram);
				$assert$$("undefined" == typeof $Module$$.memoryInitializerPrefixURL, "Module.memoryInitializerPrefixURL option was removed, use Module.locateFile instead");
				$assert$$("undefined" == typeof $Module$$.pthreadMainPrefixURL, "Module.pthreadMainPrefixURL option was removed, use Module.locateFile instead");
				$assert$$("undefined" == typeof $Module$$.cdInitializerPrefixURL, "Module.cdInitializerPrefixURL option was removed, use Module.locateFile instead");
				$assert$$("undefined" == typeof $Module$$.filePackagePrefixURL, "Module.filePackagePrefixURL option was removed, use Module.locateFile instead");
				$assert$$("undefined" == typeof $Module$$.read, "Module.read option was removed");
				$assert$$("undefined" == typeof $Module$$.readAsync, "Module.readAsync option was removed (modify readAsync in JS)");
				$assert$$("undefined" == typeof $Module$$.readBinary, "Module.readBinary option was removed (modify readBinary in JS)");
				$assert$$("undefined" == typeof $Module$$.setWindowTitle, "Module.setWindowTitle option was removed (modify emscripten_set_window_title in JS)");
				$assert$$("undefined" == typeof $Module$$.TOTAL_MEMORY, "Module.TOTAL_MEMORY has been renamed Module.INITIAL_MEMORY");
				$assert$$("undefined" == typeof $Module$$.ENVIRONMENT, "Module.ENVIRONMENT has been deprecated. To force the environment, use the ENVIRONMENT compile-time option (for example, -sENVIRONMENT=web or -sENVIRONMENT=node)");
				$assert$$("undefined" == typeof $Module$$.STACK_SIZE, "STACK_SIZE can no longer be set at runtime.  Use -sSTACK_SIZE at link time");
				$assert$$("undefined" == typeof $Module$$.wasmMemory, "Use of `wasmMemory` detected.  Use -sIMPORTED_MEMORY to define wasmMemory externally");
				$assert$$("undefined" == typeof $Module$$.INITIAL_MEMORY, "Detected runtime INITIAL_MEMORY setting.  Use -sIMPORTED_MEMORY to define wasmMemory dynamically");
				if ($Module$$.preInit) for ("function" == typeof $Module$$.preInit && ($Module$$.preInit = [$Module$$.preInit]); 0 < $Module$$.preInit.length;) $Module$$.preInit.shift()();
				$consumedModuleProp$$("preInit");
				$Module$$.callMain = $callMain$$;
				$Module$$.ccall = ($func$jscomp$8_ident$jscomp$2$$, $returnType$$, $argTypes_ret$jscomp$11$$, $args$jscomp$8$$) => {
					var $toC$$ = {
						string: ($str$jscomp$16$$) => {
							var $ret$jscomp$12$$ = 0;
							null !== $str$jscomp$16$$ && void 0 !== $str$jscomp$16$$ && 0 !== $str$jscomp$16$$ && ($ret$jscomp$12$$ = $stringToUTF8OnStack$$($str$jscomp$16$$));
							return $ret$jscomp$12$$;
						},
						array: ($arr$jscomp$3$$) => {
							var $ret$jscomp$13$$ = $__emscripten_stack_alloc$$($arr$jscomp$3$$.length);
							$assert$$(0 <= $arr$jscomp$3$$.length, "writeArrayToMemory array must have a length (should be an array or typed array)");
							$HEAP8$$.set($arr$jscomp$3$$, $ret$jscomp$13$$ >>> 0);
							return $ret$jscomp$13$$;
						}
					};
					$func$jscomp$8_ident$jscomp$2$$ = $getCFunc$$($func$jscomp$8_ident$jscomp$2$$);
					var $cArgs$$ = [], $stack$jscomp$1$$ = 0;
					$assert$$("array" !== $returnType$$, "Return type should not be \"array\".");
					if ($args$jscomp$8$$) for (var $i$jscomp$23$$ = 0; $i$jscomp$23$$ < $args$jscomp$8$$.length; $i$jscomp$23$$++) {
						var $converter$$ = $toC$$[$argTypes_ret$jscomp$11$$[$i$jscomp$23$$]];
						$converter$$ ? (0 === $stack$jscomp$1$$ && ($stack$jscomp$1$$ = $_emscripten_stack_get_current$$()), $cArgs$$[$i$jscomp$23$$] = $converter$$($args$jscomp$8$$[$i$jscomp$23$$])) : $cArgs$$[$i$jscomp$23$$] = $args$jscomp$8$$[$i$jscomp$23$$];
					}
					$argTypes_ret$jscomp$11$$ = $func$jscomp$8_ident$jscomp$2$$(...$cArgs$$);
					return $argTypes_ret$jscomp$11$$ = function($ret$jscomp$15$$) {
						0 !== $stack$jscomp$1$$ && $__emscripten_stack_restore$$($stack$jscomp$1$$);
						return "string" === $returnType$$ ? $UTF8ToString$$($ret$jscomp$15$$) : "pointer" === $returnType$$ ? $ret$jscomp$15$$ >>> 0 : "boolean" === $returnType$$ ? !!$ret$jscomp$15$$ : $ret$jscomp$15$$;
					}($argTypes_ret$jscomp$11$$);
				};
				$Module$$.addFunction = ($func$jscomp$13$$, $bytes$jscomp$inline_137_module$jscomp$inline_138_sig$jscomp$1_wrapped$$) => {
					$assert$$("undefined" != typeof $func$jscomp$13$$);
					if (!$functionsInTableMap$$) {
						$functionsInTableMap$$ = /* @__PURE__ */ new WeakMap();
						var $count$jscomp$inline_249_idx$jscomp$inline_132_idx$jscomp$inline_140_rtn$jscomp$2$$ = $wasmTable$$.length;
						if ($functionsInTableMap$$) for (var $i$jscomp$inline_250$$ = 0; $i$jscomp$inline_250$$ < 0 + $count$jscomp$inline_249_idx$jscomp$inline_132_idx$jscomp$inline_140_rtn$jscomp$2$$; $i$jscomp$inline_250$$++) {
							var $funcPtr$jscomp$inline_270_item$jscomp$inline_251$$ = $i$jscomp$inline_250$$;
							var $func$jscomp$inline_271$$ = $wasmTableMirror$$[$funcPtr$jscomp$inline_270_item$jscomp$inline_251$$];
							$func$jscomp$inline_271$$ || ($wasmTableMirror$$[$funcPtr$jscomp$inline_270_item$jscomp$inline_251$$] = $func$jscomp$inline_271$$ = $wasmTable$$.get($funcPtr$jscomp$inline_270_item$jscomp$inline_251$$));
							$assert$$($wasmTable$$.get($funcPtr$jscomp$inline_270_item$jscomp$inline_251$$) == $func$jscomp$inline_271$$, "JavaScript-side Wasm function table mirror is out of date!");
							($funcPtr$jscomp$inline_270_item$jscomp$inline_251$$ = $func$jscomp$inline_271$$) && $functionsInTableMap$$.set($funcPtr$jscomp$inline_270_item$jscomp$inline_251$$, $i$jscomp$inline_250$$);
						}
					}
					if ($count$jscomp$inline_249_idx$jscomp$inline_132_idx$jscomp$inline_140_rtn$jscomp$2$$ = $functionsInTableMap$$.get($func$jscomp$13$$) || 0) return $count$jscomp$inline_249_idx$jscomp$inline_132_idx$jscomp$inline_140_rtn$jscomp$2$$;
					a: if ($freeTableIndexes$$.length) var $ret$jscomp$16$$ = $freeTableIndexes$$.pop();
					else {
						try {
							$ret$jscomp$16$$ = $wasmTable$$.grow(1);
							break a;
						} catch ($err$jscomp$inline_130$$) {
							if (!($err$jscomp$inline_130$$ instanceof RangeError)) throw $err$jscomp$inline_130$$;
							$abort$$("Unable to grow wasm table. Set ALLOW_TABLE_GROWTH.");
						}
						$ret$jscomp$16$$ = void 0;
					}
					try {
						$count$jscomp$inline_249_idx$jscomp$inline_132_idx$jscomp$inline_140_rtn$jscomp$2$$ = $ret$jscomp$16$$, $wasmTable$$.set($count$jscomp$inline_249_idx$jscomp$inline_132_idx$jscomp$inline_140_rtn$jscomp$2$$, $func$jscomp$13$$), $wasmTableMirror$$[$count$jscomp$inline_249_idx$jscomp$inline_132_idx$jscomp$inline_140_rtn$jscomp$2$$] = $wasmTable$$.get($count$jscomp$inline_249_idx$jscomp$inline_132_idx$jscomp$inline_140_rtn$jscomp$2$$);
					} catch ($err$jscomp$6$$) {
						if (!($err$jscomp$6$$ instanceof TypeError)) throw $err$jscomp$6$$;
						$assert$$("undefined" != typeof $bytes$jscomp$inline_137_module$jscomp$inline_138_sig$jscomp$1_wrapped$$, "Missing signature argument to addFunction: " + $func$jscomp$13$$);
						$bytes$jscomp$inline_137_module$jscomp$inline_138_sig$jscomp$1_wrapped$$ = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1, ...$uleb128EncodeWithLen$$([
							1,
							96,
							...$generateTypePack$$($bytes$jscomp$inline_137_module$jscomp$inline_138_sig$jscomp$1_wrapped$$.slice(1)),
							...$generateTypePack$$("v" === $bytes$jscomp$inline_137_module$jscomp$inline_138_sig$jscomp$1_wrapped$$[0] ? "" : $bytes$jscomp$inline_137_module$jscomp$inline_138_sig$jscomp$1_wrapped$$[0])
						]), 2, 7, 1, 1, 101, 1, 102, 0, 0, 7, 5, 1, 1, 102, 0, 0);
						$bytes$jscomp$inline_137_module$jscomp$inline_138_sig$jscomp$1_wrapped$$ = new WebAssembly.Module($bytes$jscomp$inline_137_module$jscomp$inline_138_sig$jscomp$1_wrapped$$);
						$bytes$jscomp$inline_137_module$jscomp$inline_138_sig$jscomp$1_wrapped$$ = new WebAssembly.Instance($bytes$jscomp$inline_137_module$jscomp$inline_138_sig$jscomp$1_wrapped$$, { e: { f: $func$jscomp$13$$ } }).exports.f;
						$count$jscomp$inline_249_idx$jscomp$inline_132_idx$jscomp$inline_140_rtn$jscomp$2$$ = $ret$jscomp$16$$;
						$wasmTable$$.set($count$jscomp$inline_249_idx$jscomp$inline_132_idx$jscomp$inline_140_rtn$jscomp$2$$, $bytes$jscomp$inline_137_module$jscomp$inline_138_sig$jscomp$1_wrapped$$);
						$wasmTableMirror$$[$count$jscomp$inline_249_idx$jscomp$inline_132_idx$jscomp$inline_140_rtn$jscomp$2$$] = $wasmTable$$.get($count$jscomp$inline_249_idx$jscomp$inline_132_idx$jscomp$inline_140_rtn$jscomp$2$$);
					}
					$functionsInTableMap$$.set($func$jscomp$13$$, $ret$jscomp$16$$);
					return $ret$jscomp$16$$;
				};
				$Module$$.FS_unlink = (...$args$jscomp$12$$) => $FS$$.$unlink$(...$args$jscomp$12$$);
				$Module$$.FS = $FS$$;
				$Module$$.FS_lookupPath = (...$args$jscomp$11$$) => $JSCompiler_StaticMethods_lookupPath$$(...$args$jscomp$11$$);
				$Module$$.FS_mount = (...$args$jscomp$10$$) => $FS$$.$mount$(...$args$jscomp$10$$);
				$Module$$.FS_mkdir = (...$args$jscomp$9$$) => $JSCompiler_StaticMethods_mkdir$$(...$args$jscomp$9$$);
				$Module$$.WORKERFS = $WORKERFS$$;
				"writeI53ToI64 writeI53ToI64Clamped writeI53ToI64Signaling writeI53ToU64Clamped writeI53ToU64Signaling readI53FromU64 convertI32PairToI53 convertI32PairToI53Checked convertU32PairToI53 getTempRet0 setTempRet0 createNamedFunction withStackSave inetPton4 inetNtop4 inetPton6 inetNtop6 readSockaddr writeSockaddr runMainThreadEmAsm jstoi_q autoResumeAudioContext getDynCaller dynCall runtimeKeepalivePush runtimeKeepalivePop callUserCallback maybeExit asmjsMangle HandleAllocator addOnInit addOnPostCtor addOnPreMain addOnExit STACK_SIZE STACK_ALIGN POINTER_SIZE ASSERTIONS cwrap removeFunction intArrayToString AsciiToString stringToAscii UTF16ToString stringToUTF16 lengthBytesUTF16 UTF32ToString stringToUTF32 lengthBytesUTF32 registerKeyEventCallback maybeCStringToJsString findEventTarget getBoundingClientRect fillMouseEventData registerMouseEventCallback registerWheelEventCallback registerUiEventCallback registerFocusEventCallback fillDeviceOrientationEventData registerDeviceOrientationEventCallback fillDeviceMotionEventData registerDeviceMotionEventCallback screenOrientation fillOrientationChangeEventData registerOrientationChangeEventCallback fillFullscreenChangeEventData registerFullscreenChangeEventCallback JSEvents_requestFullscreen JSEvents_resizeCanvasForFullscreen registerRestoreOldStyle hideEverythingExceptGivenElement restoreHiddenElements setLetterbox softFullscreenResizeWebGLRenderTarget doRequestFullscreen fillPointerlockChangeEventData registerPointerlockChangeEventCallback registerPointerlockErrorEventCallback requestPointerLock fillVisibilityChangeEventData registerVisibilityChangeEventCallback registerTouchEventCallback fillGamepadEventData registerGamepadEventCallback registerBeforeUnloadEventCallback fillBatteryEventData registerBatteryEventCallback setCanvasElementSize getCanvasElementSize getCallstack convertPCtoSourceLocation wasiRightsToMuslOFlags wasiOFlagsToMuslOFlags safeSetTimeout setImmediateWrapped safeRequestAnimationFrame clearImmediateWrapped registerPostMainLoop registerPreMainLoop getPromise makePromise idsToPromises makePromiseCallback ExceptionInfo findMatchingCatch Browser_asyncPrepareDataCounter arraySum addDays getSocketFromFD getSocketAddress FS_mkdirTree _setNetworkCallback heapObjectForWebGLType toTypedArrayIndex webgl_enable_ANGLE_instanced_arrays webgl_enable_OES_vertex_array_object webgl_enable_WEBGL_draw_buffers webgl_enable_WEBGL_multi_draw webgl_enable_EXT_polygon_offset_clamp webgl_enable_EXT_clip_control webgl_enable_WEBGL_polygon_mode emscriptenWebGLGet computeUnpackAlignedImageSize colorChannelsInGlTextureFormat emscriptenWebGLGetTexPixelData emscriptenWebGLGetUniform webglGetUniformLocation webglPrepareUniformLocationsBeforeFirstUse webglGetLeftBracePos emscriptenWebGLGetVertexAttrib __glGetActiveAttribOrUniform writeGLArray registerWebGlEventCallback runAndAbortIfError ALLOC_NORMAL ALLOC_STACK allocate writeStringToMemory writeAsciiToMemory allocateUTF8 allocateUTF8OnStack demangle stackTrace getNativeTypeSize".split(" ").forEach(function($sym$jscomp$2$$) {
					$unexportedRuntimeSymbol$$($sym$jscomp$2$$);
				});
				"run out err abort wasmExports HEAPF32 HEAPF64 HEAP8 HEAP16 HEAPU16 HEAP32 HEAPU32 HEAP64 HEAPU64 writeStackCookie checkStackCookie readI53FromI64 INT53_MAX INT53_MIN bigintToI53Checked stackSave stackRestore stackAlloc ptrToString zeroMemory exitJS getHeapMax growMemory ENV ERRNO_CODES strError DNS Protocols Sockets timers warnOnce readEmAsmArgsArray readEmAsmArgs runEmAsmFunction getExecutableName handleException keepRuntimeAlive asyncLoad alignMemory mmapAlloc wasmTable wasmMemory getUniqueRunDependency noExitRuntime addRunDependency removeRunDependency addOnPreRun addOnPostRun convertJsFunctionToWasm freeTableIndexes functionsInTableMap getEmptyTableSlot updateTableMap getFunctionAddress setValue getValue PATH PATH_FS UTF8Decoder UTF8ArrayToString UTF8ToString stringToUTF8Array stringToUTF8 lengthBytesUTF8 intArrayFromString UTF16Decoder stringToNewUTF8 stringToUTF8OnStack writeArrayToMemory JSEvents specialHTMLTargets findCanvasEventTarget currentFullscreenStrategy restoreOldWindowedStyle jsStackTrace UNWIND_CACHE ExitStatus getEnvStrings checkWasiClock doReadv doWritev initRandomFill randomFill emSetImmediate emClearImmediate_deps emClearImmediate promiseMap uncaughtExceptionCount exceptionLast exceptionCaught Browser requestFullscreen requestFullScreen setCanvasSize getUserMedia createContext getPreloadedImageData__data wget MONTH_DAYS_REGULAR MONTH_DAYS_LEAP MONTH_DAYS_REGULAR_CUMULATIVE MONTH_DAYS_LEAP_CUMULATIVE isLeapYear ydayFromDate SYSCALLS preloadPlugins FS_createPreloadedFile FS_preloadFile FS_modeStringToFlags FS_getMode FS_fileDataToTypedArray FS_stdin_getChar_buffer FS_stdin_getChar FS_createPath FS_createDevice FS_readFile FS_root FS_mounts FS_devices FS_streams FS_nextInode FS_nameTable FS_currentPath FS_initialized FS_ignorePermissions FS_filesystems FS_syncFSRequests FS_getPath FS_hashName FS_hashAddNode FS_hashRemoveNode FS_lookupNode FS_createNode FS_destroyNode FS_isRoot FS_isMountpoint FS_isFile FS_isDir FS_isLink FS_isChrdev FS_isBlkdev FS_isFIFO FS_isSocket FS_flagsToPermissionString FS_nodePermissions FS_mayLookup FS_mayCreate FS_mayDelete FS_mayOpen FS_checkOpExists FS_nextfd FS_getStreamChecked FS_getStream FS_createStream FS_closeStream FS_dupStream FS_doSetAttr FS_chrdev_stream_ops FS_major FS_minor FS_makedev FS_registerDevice FS_getDevice FS_getMounts FS_syncfs FS_unmount FS_lookup FS_mknod FS_statfs FS_statfsStream FS_statfsNode FS_create FS_mkdev FS_symlink FS_rename FS_rmdir FS_readdir FS_readlink FS_stat FS_fstat FS_lstat FS_doChmod FS_chmod FS_lchmod FS_fchmod FS_doChown FS_chown FS_lchown FS_fchown FS_doTruncate FS_truncate FS_ftruncate FS_utime FS_open FS_close FS_isClosed FS_llseek FS_read FS_write FS_mmap FS_msync FS_ioctl FS_writeFile FS_cwd FS_chdir FS_createDefaultDirectories FS_createDefaultDevices FS_createSpecialDirectories FS_createStandardStreams FS_staticInit FS_init FS_quit FS_findObject FS_analyzePath FS_createFile FS_createDataFile FS_forceLoadFile FS_createLazyFile MEMFS TTY PIPEFS SOCKFS tempFixedLengthArray miniTempWebGLFloatBuffers miniTempWebGLIntBuffers GL AL GLUT EGL GLEW IDBStore SDL SDL_gfx print printErr jstoi_s".split(" ").forEach($unexportedRuntimeSymbol$$);
				var $ASM_CONSTS$$ = { 4887036: () => "undefined" !== typeof wasmOffsetConverter }, $_main$$ = $Module$$._main = $makeInvalidEarlyAccess$$("_main"), $_strerror$$ = $makeInvalidEarlyAccess$$("_strerror"), $_malloc$$ = $makeInvalidEarlyAccess$$("_malloc"), $_free$$ = $makeInvalidEarlyAccess$$("_free"), $_fflush$$ = $makeInvalidEarlyAccess$$("_fflush");
				$Module$$._SynqPerfettoParseAlloc = $makeInvalidEarlyAccess$$("_SynqPerfettoParseAlloc");
				$Module$$._SynqPerfettoParseFree = $makeInvalidEarlyAccess$$("_SynqPerfettoParseFree");
				$Module$$._SynqPerfettoParse = $makeInvalidEarlyAccess$$("_SynqPerfettoParse");
				$Module$$._synq_extent_on_shift = $makeInvalidEarlyAccess$$("_synq_extent_on_shift");
				$Module$$._SynqPerfettoGetToken = $makeInvalidEarlyAccess$$("_SynqPerfettoGetToken");
				$Module$$._synq_extent_on_reduce = $makeInvalidEarlyAccess$$("_synq_extent_on_reduce");
				$Module$$._synq_extent_fold_below_into_top = $makeInvalidEarlyAccess$$("_synq_extent_fold_below_into_top");
				$Module$$._SynqPerfettoParseInit = $makeInvalidEarlyAccess$$("_SynqPerfettoParseInit");
				$Module$$._SynqPerfettoParseFinalize = $makeInvalidEarlyAccess$$("_SynqPerfettoParseFinalize");
				$Module$$._SynqPerfettoParseFallback = $makeInvalidEarlyAccess$$("_SynqPerfettoParseFallback");
				$Module$$._SynqPerfettoParseExpectedTokens = $makeInvalidEarlyAccess$$("_SynqPerfettoParseExpectedTokens");
				$Module$$._SynqPerfettoParseCompletionContext = $makeInvalidEarlyAccess$$("_SynqPerfettoParseCompletionContext");
				var $_emscripten_stack_get_end$$ = $makeInvalidEarlyAccess$$("_emscripten_stack_get_end"), $_emscripten_builtin_memalign$$ = $makeInvalidEarlyAccess$$("_emscripten_builtin_memalign"), $_emscripten_stack_init$$ = $makeInvalidEarlyAccess$$("_emscripten_stack_init"), $__emscripten_stack_restore$$ = $makeInvalidEarlyAccess$$("__emscripten_stack_restore"), $__emscripten_stack_alloc$$ = $makeInvalidEarlyAccess$$("__emscripten_stack_alloc"), $_emscripten_stack_get_current$$ = $makeInvalidEarlyAccess$$("_emscripten_stack_get_current"), $wasmMemory$$ = $makeInvalidEarlyAccess$$("wasmMemory"), $wasmTable$$ = $makeInvalidEarlyAccess$$("wasmTable"), $wasmImports$$ = {
					HaveOffsetConverter: function() {
						return "undefined" !== typeof wasmOffsetConverter;
					},
					__syscall_chmod: function($path$jscomp$44$$, $mode$jscomp$43$$) {
						$path$jscomp$44$$ >>>= 0;
						try {
							return $path$jscomp$44$$ = $UTF8ToString$$($path$jscomp$44$$), $JSCompiler_StaticMethods_chmod$$($path$jscomp$44$$, $mode$jscomp$43$$), 0;
						} catch ($e$jscomp$25$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$25$$.name) throw $e$jscomp$25$$;
							return -$e$jscomp$25$$.$errno$;
						}
					},
					__syscall_faccessat: function($dirfd$jscomp$1_perms$jscomp$2$$, $path$jscomp$45$$, $amode$$, $flags$jscomp$13$$) {
						$path$jscomp$45$$ >>>= 0;
						try {
							$path$jscomp$45$$ = $UTF8ToString$$($path$jscomp$45$$);
							$assert$$(!$flags$jscomp$13$$ || 512 == $flags$jscomp$13$$);
							$path$jscomp$45$$ = $SYSCALLS$calculateAt$$($dirfd$jscomp$1_perms$jscomp$2$$, $path$jscomp$45$$);
							if ($amode$$ & -8) return -28;
							var $node$jscomp$52$$ = $JSCompiler_StaticMethods_lookupPath$$($path$jscomp$45$$, { $follow$: !0 }).node;
							if (!$node$jscomp$52$$) return -44;
							$dirfd$jscomp$1_perms$jscomp$2$$ = "";
							$amode$$ & 4 && ($dirfd$jscomp$1_perms$jscomp$2$$ += "r");
							$amode$$ & 2 && ($dirfd$jscomp$1_perms$jscomp$2$$ += "w");
							$amode$$ & 1 && ($dirfd$jscomp$1_perms$jscomp$2$$ += "x");
							return $dirfd$jscomp$1_perms$jscomp$2$$ && $JSCompiler_StaticMethods_nodePermissions$$($node$jscomp$52$$, $dirfd$jscomp$1_perms$jscomp$2$$) ? -2 : 0;
						} catch ($e$jscomp$26$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$26$$.name) throw $e$jscomp$26$$;
							return -$e$jscomp$26$$.$errno$;
						}
					},
					__syscall_fchmod: function($fd$jscomp$12$$, $mode$jscomp$44$$) {
						try {
							var $stream$jscomp$inline_146$$ = $JSCompiler_StaticMethods_getStreamChecked$$($fd$jscomp$12$$);
							$JSCompiler_StaticMethods_doChmod$$($stream$jscomp$inline_146$$, $stream$jscomp$inline_146$$.node, $mode$jscomp$44$$, !1);
							return 0;
						} catch ($e$jscomp$27$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$27$$.name) throw $e$jscomp$27$$;
							return -$e$jscomp$27$$.$errno$;
						}
					},
					__syscall_fchown32: function($fd$jscomp$13$$) {
						try {
							var $stream$jscomp$inline_150$$ = $JSCompiler_StaticMethods_getStreamChecked$$($fd$jscomp$13$$);
							$JSCompiler_StaticMethods_doSetAttr$$($stream$jscomp$inline_150$$, $stream$jscomp$inline_150$$.node, {
								timestamp: Date.now(),
								$dontFollow$: !1
							});
							return 0;
						} catch ($e$jscomp$28$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$28$$.name) throw $e$jscomp$28$$;
							return -$e$jscomp$28$$.$errno$;
						}
					},
					__syscall_fcntl64: function($fd$jscomp$14$$, $cmd$jscomp$1$$, $varargs$$) {
						$SYSCALLS$varargs$$ = $varargs$$ >>> 0;
						try {
							var $stream$jscomp$54$$ = $JSCompiler_StaticMethods_getStreamChecked$$($fd$jscomp$14$$);
							switch ($cmd$jscomp$1$$) {
								case 0:
									var $arg$jscomp$11$$ = $syscallGetVarargI$$();
									if (0 > $arg$jscomp$11$$) break;
									for (; $FS$$.streams[$arg$jscomp$11$$];) $arg$jscomp$11$$++;
									return $JSCompiler_StaticMethods_dupStream$$($stream$jscomp$54$$, $arg$jscomp$11$$).$fd$;
								case 1:
								case 2: return 0;
								case 3: return $stream$jscomp$54$$.flags;
								case 4: return $arg$jscomp$11$$ = $syscallGetVarargI$$(), $stream$jscomp$54$$.flags |= $arg$jscomp$11$$, 0;
								case 12: return $arg$jscomp$11$$ = $syscallGetVarargI$$(), $HEAP16$$[$arg$jscomp$11$$ + 0 >>> 1 >>> 0] = 2, 0;
								case 13:
								case 14: return 0;
							}
							return -28;
						} catch ($e$jscomp$29$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$29$$.name) throw $e$jscomp$29$$;
							return -$e$jscomp$29$$.$errno$;
						}
					},
					__syscall_fstat64: function($arg$jscomp$inline_157_fd$jscomp$15$$, $JSCompiler_temp_const$jscomp$10_buf$jscomp$3$$) {
						try {
							$JSCompiler_temp_const$jscomp$10_buf$jscomp$3$$ >>>= 0;
							var $stream$jscomp$inline_154$$ = $JSCompiler_StaticMethods_getStreamChecked$$($arg$jscomp$inline_157_fd$jscomp$15$$), $node$jscomp$inline_155$$ = $stream$jscomp$inline_154$$.node, $getattr$jscomp$inline_156$$ = $stream$jscomp$inline_154$$.$stream_ops$.$getattr$;
							$arg$jscomp$inline_157_fd$jscomp$15$$ = $getattr$jscomp$inline_156$$ ? $stream$jscomp$inline_154$$ : $node$jscomp$inline_155$$;
							$getattr$jscomp$inline_156$$ ??= $node$jscomp$inline_155$$.$node_ops$.$getattr$;
							$JSCompiler_StaticMethods_checkOpExists$$($getattr$jscomp$inline_156$$, 63);
							var $JSCompiler_inline_result$jscomp$11$$ = $getattr$jscomp$inline_156$$($arg$jscomp$inline_157_fd$jscomp$15$$);
							return $SYSCALLS$writeStat$$($JSCompiler_temp_const$jscomp$10_buf$jscomp$3$$, $JSCompiler_inline_result$jscomp$11$$);
						} catch ($e$jscomp$30$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$30$$.name) throw $e$jscomp$30$$;
							return -$e$jscomp$30$$.$errno$;
						}
					},
					__syscall_ftruncate64: function($fd$jscomp$16$$, $len$jscomp$inline_160_length$jscomp$37$$) {
						$len$jscomp$inline_160_length$jscomp$37$$ = -9007199254740992 > $len$jscomp$inline_160_length$jscomp$37$$ || 9007199254740992 < $len$jscomp$inline_160_length$jscomp$37$$ ? NaN : Number($len$jscomp$inline_160_length$jscomp$37$$);
						try {
							if (isNaN($len$jscomp$inline_160_length$jscomp$37$$)) return -61;
							var $stream$jscomp$inline_162$$ = $JSCompiler_StaticMethods_getStreamChecked$$($fd$jscomp$16$$);
							if (0 > $len$jscomp$inline_160_length$jscomp$37$$ || 0 === ($stream$jscomp$inline_162$$.flags & 2097155)) throw new $FS$$.$ErrnoError$(28);
							$JSCompiler_StaticMethods_doTruncate$$($stream$jscomp$inline_162$$, $stream$jscomp$inline_162$$.node, $len$jscomp$inline_160_length$jscomp$37$$);
							return 0;
						} catch ($e$jscomp$31$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$31$$.name) throw $e$jscomp$31$$;
							return -$e$jscomp$31$$.$errno$;
						}
					},
					__syscall_getcwd: function($buf$jscomp$4$$, $size$jscomp$26$$) {
						$size$jscomp$26$$ >>>= 0;
						try {
							if (0 === $size$jscomp$26$$) return -28;
							var $cwd$$ = $FS$$.$cwd$(), $cwdLengthInBytes$$ = $lengthBytesUTF8$$($cwd$$) + 1;
							if ($size$jscomp$26$$ < $cwdLengthInBytes$$) return -68;
							$stringToUTF8$$($cwd$$, $buf$jscomp$4$$ >>> 0, $size$jscomp$26$$);
							return $cwdLengthInBytes$$;
						} catch ($e$jscomp$32$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$32$$.name) throw $e$jscomp$32$$;
							return -$e$jscomp$32$$.$errno$;
						}
					},
					__syscall_getdents64: function($fd$jscomp$17_pos$jscomp$5$$, $dirp$$, $count$jscomp$39_idx$jscomp$4$$) {
						$dirp$$ >>>= 0;
						$count$jscomp$39_idx$jscomp$4$$ >>>= 0;
						try {
							var $stream$jscomp$55$$ = $JSCompiler_StaticMethods_getStreamChecked$$($fd$jscomp$17_pos$jscomp$5$$);
							$stream$jscomp$55$$.$getdents$ || ($stream$jscomp$55$$.$getdents$ = $FS$$.$readdir$($stream$jscomp$55$$.path));
							$fd$jscomp$17_pos$jscomp$5$$ = 0;
							var $off$$ = $FS$$.$llseek$($stream$jscomp$55$$, 0, 1), $startIdx$jscomp$1$$ = Math.floor($off$$ / 280), $endIdx$jscomp$1$$ = Math.min($stream$jscomp$55$$.$getdents$.length, $startIdx$jscomp$1$$ + Math.floor($count$jscomp$39_idx$jscomp$4$$ / 280));
							for ($count$jscomp$39_idx$jscomp$4$$ = $startIdx$jscomp$1$$; $count$jscomp$39_idx$jscomp$4$$ < $endIdx$jscomp$1$$; $count$jscomp$39_idx$jscomp$4$$++) {
								var $name$jscomp$105$$ = $stream$jscomp$55$$.$getdents$[$count$jscomp$39_idx$jscomp$4$$];
								if ("." === $name$jscomp$105$$) {
									var $id$jscomp$9$$ = $stream$jscomp$55$$.node.id;
									var $type$jscomp$167$$ = 4;
								} else if (".." === $name$jscomp$105$$) $id$jscomp$9$$ = $JSCompiler_StaticMethods_lookupPath$$($stream$jscomp$55$$.path, { parent: !0 }).node.id, $type$jscomp$167$$ = 4;
								else {
									try {
										var $child$$ = $JSCompiler_StaticMethods_lookupNode$$($stream$jscomp$55$$.node, $name$jscomp$105$$);
									} catch ($e$jscomp$33$$) {
										if (28 === $e$jscomp$33$$?.$errno$) continue;
										throw $e$jscomp$33$$;
									}
									$id$jscomp$9$$ = $child$$.id;
									$type$jscomp$167$$ = 8192 === ($child$$.mode & 61440) ? 2 : $JSCompiler_StaticMethods_isDir$$($child$$.mode) ? 4 : 40960 === ($child$$.mode & 61440) ? 10 : 8;
								}
								$assert$$($id$jscomp$9$$);
								$HEAP64$$[$dirp$$ + $fd$jscomp$17_pos$jscomp$5$$ >>> 3 >>> 0] = BigInt($id$jscomp$9$$);
								$HEAP64$$[$dirp$$ + $fd$jscomp$17_pos$jscomp$5$$ + 8 >>> 3 >>> 0] = BigInt(280 * ($count$jscomp$39_idx$jscomp$4$$ + 1));
								$HEAP16$$[$dirp$$ + $fd$jscomp$17_pos$jscomp$5$$ + 16 >>> 1 >>> 0] = 280;
								$HEAP8$$[$dirp$$ + $fd$jscomp$17_pos$jscomp$5$$ + 18 >>> 0] = $type$jscomp$167$$;
								$stringToUTF8$$($name$jscomp$105$$, $dirp$$ + $fd$jscomp$17_pos$jscomp$5$$ + 19, 256);
								$fd$jscomp$17_pos$jscomp$5$$ += 280;
							}
							$FS$$.$llseek$($stream$jscomp$55$$, 280 * $count$jscomp$39_idx$jscomp$4$$, 0);
							return $fd$jscomp$17_pos$jscomp$5$$;
						} catch ($e$jscomp$34$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$34$$.name) throw $e$jscomp$34$$;
							return -$e$jscomp$34$$.$errno$;
						}
					},
					__syscall_ioctl: function($JSCompiler_object_inline_c_cc_224_c_cc_fd$jscomp$18$$, $op$jscomp$1$$, $varargs$jscomp$1$$) {
						$SYSCALLS$varargs$$ = $varargs$jscomp$1$$ >>> 0;
						try {
							var $stream$jscomp$56$$ = $JSCompiler_StaticMethods_getStreamChecked$$($JSCompiler_object_inline_c_cc_224_c_cc_fd$jscomp$18$$);
							switch ($op$jscomp$1$$) {
								case 21509: return $stream$jscomp$56$$.$tty$ ? 0 : -59;
								case 21505:
									if (!$stream$jscomp$56$$.$tty$) return -59;
									if ($stream$jscomp$56$$.$tty$.$ops$.$ioctl_tcgets$) {
										$JSCompiler_object_inline_c_cc_224_c_cc_fd$jscomp$18$$ = [
											3,
											28,
											127,
											21,
											4,
											0,
											1,
											0,
											17,
											19,
											26,
											0,
											18,
											15,
											23,
											22,
											0,
											0,
											0,
											0,
											0,
											0,
											0,
											0,
											0,
											0,
											0,
											0,
											0,
											0,
											0,
											0
										];
										var $argp$$ = $syscallGetVarargI$$();
										$HEAP32$$[$argp$$ >>> 2 >>> 0] = 25856;
										$HEAP32$$[$argp$$ + 4 >>> 2 >>> 0] = 5;
										$HEAP32$$[$argp$$ + 8 >>> 2 >>> 0] = 191;
										$HEAP32$$[$argp$$ + 12 >>> 2 >>> 0] = 35387;
										for (var $i$jscomp$19_winsize$$ = 0; 32 > $i$jscomp$19_winsize$$; $i$jscomp$19_winsize$$++) $HEAP8$$[$argp$$ + $i$jscomp$19_winsize$$ + 17 >>> 0] = $JSCompiler_object_inline_c_cc_224_c_cc_fd$jscomp$18$$[$i$jscomp$19_winsize$$] || 0;
									}
									return 0;
								case 21510:
								case 21511:
								case 21512: return $stream$jscomp$56$$.$tty$ ? 0 : -59;
								case 21506:
								case 21507:
								case 21508:
									if (!$stream$jscomp$56$$.$tty$) return -59;
									if ($stream$jscomp$56$$.$tty$.$ops$.$ioctl_tcsets$) for ($argp$$ = $syscallGetVarargI$$(), $JSCompiler_object_inline_c_cc_224_c_cc_fd$jscomp$18$$ = [], $i$jscomp$19_winsize$$ = 0; 32 > $i$jscomp$19_winsize$$; $i$jscomp$19_winsize$$++) $JSCompiler_object_inline_c_cc_224_c_cc_fd$jscomp$18$$.push($HEAP8$$[$argp$$ + $i$jscomp$19_winsize$$ + 17 >>> 0]);
									return 0;
								case 21519:
									if (!$stream$jscomp$56$$.$tty$) return -59;
									$argp$$ = $syscallGetVarargI$$();
									return $HEAP32$$[$argp$$ >>> 2 >>> 0] = 0;
								case 21520: return $stream$jscomp$56$$.$tty$ ? -28 : -59;
								case 21537:
								case 21531: return $argp$$ = $syscallGetVarargI$$(), $FS$$.$ioctl$($stream$jscomp$56$$, $op$jscomp$1$$, $argp$$);
								case 21523:
									if (!$stream$jscomp$56$$.$tty$) return -59;
									$stream$jscomp$56$$.$tty$.$ops$.$ioctl_tiocgwinsz$ && ($i$jscomp$19_winsize$$ = [24, 80], $argp$$ = $syscallGetVarargI$$(), $HEAP16$$[$argp$$ >>> 1 >>> 0] = $i$jscomp$19_winsize$$[0], $HEAP16$$[$argp$$ + 2 >>> 1 >>> 0] = $i$jscomp$19_winsize$$[1]);
									return 0;
								case 21524: return $stream$jscomp$56$$.$tty$ ? 0 : -59;
								case 21515: return $stream$jscomp$56$$.$tty$ ? 0 : -59;
								default: return -28;
							}
						} catch ($e$jscomp$35$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$35$$.name) throw $e$jscomp$35$$;
							return -$e$jscomp$35$$.$errno$;
						}
					},
					__syscall_lstat64: function($path$jscomp$46$$, $buf$jscomp$5$$) {
						$path$jscomp$46$$ >>>= 0;
						$buf$jscomp$5$$ >>>= 0;
						try {
							return $path$jscomp$46$$ = $UTF8ToString$$($path$jscomp$46$$), $SYSCALLS$writeStat$$($buf$jscomp$5$$, $FS$$.stat($path$jscomp$46$$, !0));
						} catch ($e$jscomp$36$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$36$$.name) throw $e$jscomp$36$$;
							return -$e$jscomp$36$$.$errno$;
						}
					},
					__syscall_mkdirat: function($dirfd$jscomp$2$$, $path$jscomp$47$$, $mode$jscomp$45$$) {
						$path$jscomp$47$$ >>>= 0;
						try {
							return $path$jscomp$47$$ = $UTF8ToString$$($path$jscomp$47$$), $path$jscomp$47$$ = $SYSCALLS$calculateAt$$($dirfd$jscomp$2$$, $path$jscomp$47$$), $JSCompiler_StaticMethods_mkdir$$($path$jscomp$47$$, $mode$jscomp$45$$), 0;
						} catch ($e$jscomp$37$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$37$$.name) throw $e$jscomp$37$$;
							return -$e$jscomp$37$$.$errno$;
						}
					},
					__syscall_newfstatat: function($dirfd$jscomp$3$$, $path$jscomp$48$$, $buf$jscomp$6$$, $flags$jscomp$14$$) {
						$path$jscomp$48$$ >>>= 0;
						$buf$jscomp$6$$ >>>= 0;
						try {
							$path$jscomp$48$$ = $UTF8ToString$$($path$jscomp$48$$);
							var $nofollow$$ = $flags$jscomp$14$$ & 256, $allowEmpty$jscomp$1$$ = $flags$jscomp$14$$ & 4096;
							$flags$jscomp$14$$ &= -6401;
							$assert$$(!$flags$jscomp$14$$, `unknown flags in __syscall_newfstatat: ${$flags$jscomp$14$$}`);
							$path$jscomp$48$$ = $SYSCALLS$calculateAt$$($dirfd$jscomp$3$$, $path$jscomp$48$$, $allowEmpty$jscomp$1$$);
							return $SYSCALLS$writeStat$$($buf$jscomp$6$$, $nofollow$$ ? $FS$$.stat($path$jscomp$48$$, !0) : $FS$$.stat($path$jscomp$48$$));
						} catch ($e$jscomp$38$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$38$$.name) throw $e$jscomp$38$$;
							return -$e$jscomp$38$$.$errno$;
						}
					},
					__syscall_openat: function($dirfd$jscomp$4$$, $path$jscomp$49$$, $flags$jscomp$15$$, $varargs$jscomp$2$$) {
						$path$jscomp$49$$ >>>= 0;
						$SYSCALLS$varargs$$ = $varargs$jscomp$2$$ >>>= 0;
						try {
							$path$jscomp$49$$ = $UTF8ToString$$($path$jscomp$49$$);
							$path$jscomp$49$$ = $SYSCALLS$calculateAt$$($dirfd$jscomp$4$$, $path$jscomp$49$$);
							var $mode$jscomp$46$$ = $varargs$jscomp$2$$ ? $syscallGetVarargI$$() : 0;
							return $FS$$.open($path$jscomp$49$$, $flags$jscomp$15$$, $mode$jscomp$46$$).$fd$;
						} catch ($e$jscomp$39$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$39$$.name) throw $e$jscomp$39$$;
							return -$e$jscomp$39$$.$errno$;
						}
					},
					__syscall_readlinkat: function($dirfd$jscomp$5$$, $path$jscomp$50$$, $buf$jscomp$7$$, $bufsize$$) {
						$path$jscomp$50$$ >>>= 0;
						$buf$jscomp$7$$ >>>= 0;
						$bufsize$$ >>>= 0;
						try {
							$path$jscomp$50$$ = $UTF8ToString$$($path$jscomp$50$$);
							$path$jscomp$50$$ = $SYSCALLS$calculateAt$$($dirfd$jscomp$5$$, $path$jscomp$50$$);
							if (0 >= $bufsize$$) return -28;
							var $ret$jscomp$5$$ = $FS$$.$readlink$($path$jscomp$50$$), $len$jscomp$6$$ = Math.min($bufsize$$, $lengthBytesUTF8$$($ret$jscomp$5$$)), $endChar$$ = $HEAP8$$[$buf$jscomp$7$$ + $len$jscomp$6$$ >>> 0];
							$stringToUTF8$$($ret$jscomp$5$$, $buf$jscomp$7$$, $bufsize$$ + 1);
							$HEAP8$$[$buf$jscomp$7$$ + $len$jscomp$6$$ >>> 0] = $endChar$$;
							return $len$jscomp$6$$;
						} catch ($e$jscomp$40$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$40$$.name) throw $e$jscomp$40$$;
							return -$e$jscomp$40$$.$errno$;
						}
					},
					__syscall_rmdir: function($path$jscomp$51$$) {
						$path$jscomp$51$$ >>>= 0;
						try {
							return $path$jscomp$51$$ = $UTF8ToString$$($path$jscomp$51$$), $FS$$.$rmdir$($path$jscomp$51$$), 0;
						} catch ($e$jscomp$41$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$41$$.name) throw $e$jscomp$41$$;
							return -$e$jscomp$41$$.$errno$;
						}
					},
					__syscall_stat64: function($path$jscomp$52$$, $buf$jscomp$8$$) {
						$path$jscomp$52$$ >>>= 0;
						$buf$jscomp$8$$ >>>= 0;
						try {
							return $path$jscomp$52$$ = $UTF8ToString$$($path$jscomp$52$$), $SYSCALLS$writeStat$$($buf$jscomp$8$$, $FS$$.stat($path$jscomp$52$$));
						} catch ($e$jscomp$42$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$42$$.name) throw $e$jscomp$42$$;
							return -$e$jscomp$42$$.$errno$;
						}
					},
					__syscall_unlinkat: function($dirfd$jscomp$6$$, $path$jscomp$53$$, $flags$jscomp$16$$) {
						$path$jscomp$53$$ >>>= 0;
						try {
							$path$jscomp$53$$ = $UTF8ToString$$($path$jscomp$53$$);
							$path$jscomp$53$$ = $SYSCALLS$calculateAt$$($dirfd$jscomp$6$$, $path$jscomp$53$$);
							if ($flags$jscomp$16$$) if (512 === $flags$jscomp$16$$) $FS$$.$rmdir$($path$jscomp$53$$);
							else return -28;
							else $FS$$.$unlink$($path$jscomp$53$$);
							return 0;
						} catch ($e$jscomp$43$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$43$$.name) throw $e$jscomp$43$$;
							return -$e$jscomp$43$$.$errno$;
						}
					},
					__syscall_utimensat: function($atime$jscomp$inline_165_dirfd$jscomp$7$$, $path$jscomp$54$$, $times$$, $flags$jscomp$17$$) {
						$path$jscomp$54$$ >>>= 0;
						$times$$ >>>= 0;
						try {
							$path$jscomp$54$$ = $UTF8ToString$$($path$jscomp$54$$);
							$assert$$(!$flags$jscomp$17$$);
							$path$jscomp$54$$ = $SYSCALLS$calculateAt$$($atime$jscomp$inline_165_dirfd$jscomp$7$$, $path$jscomp$54$$, !0);
							var $now$$ = Date.now(), $atime$jscomp$2$$, $mtime$jscomp$3_mtime$jscomp$inline_166$$;
							if ($times$$) {
								var $seconds$$ = $HEAPU32$$[$times$$ >>> 2 >>> 0] + 4294967296 * $HEAP32$$[$times$$ + 4 >>> 2 >>> 0], $nanoseconds$$ = $HEAP32$$[$times$$ + 8 >>> 2 >>> 0];
								1073741823 == $nanoseconds$$ ? $atime$jscomp$2$$ = $now$$ : 1073741822 == $nanoseconds$$ ? $atime$jscomp$2$$ = null : $atime$jscomp$2$$ = 1e3 * $seconds$$ + $nanoseconds$$ / 1e6;
								$times$$ += 16;
								$seconds$$ = $HEAPU32$$[$times$$ >>> 2 >>> 0] + 4294967296 * $HEAP32$$[$times$$ + 4 >>> 2 >>> 0];
								$nanoseconds$$ = $HEAP32$$[$times$$ + 8 >>> 2 >>> 0];
								1073741823 == $nanoseconds$$ ? $mtime$jscomp$3_mtime$jscomp$inline_166$$ = $now$$ : 1073741822 == $nanoseconds$$ ? $mtime$jscomp$3_mtime$jscomp$inline_166$$ = null : $mtime$jscomp$3_mtime$jscomp$inline_166$$ = 1e3 * $seconds$$ + $nanoseconds$$ / 1e6;
							} else $mtime$jscomp$3_mtime$jscomp$inline_166$$ = $atime$jscomp$2$$ = $now$$;
							if (null !== ($mtime$jscomp$3_mtime$jscomp$inline_166$$ ?? $atime$jscomp$2$$)) {
								$atime$jscomp$inline_165_dirfd$jscomp$7$$ = $atime$jscomp$2$$;
								var $node$jscomp$inline_168$$ = $JSCompiler_StaticMethods_lookupPath$$($path$jscomp$54$$, { $follow$: !0 }).node;
								$JSCompiler_StaticMethods_checkOpExists$$($node$jscomp$inline_168$$.$node_ops$.$setattr$, 63)($node$jscomp$inline_168$$, {
									$atime$: $atime$jscomp$inline_165_dirfd$jscomp$7$$,
									$mtime$: $mtime$jscomp$3_mtime$jscomp$inline_166$$
								});
							}
							return 0;
						} catch ($e$jscomp$44$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$44$$.name) throw $e$jscomp$44$$;
							return -$e$jscomp$44$$.$errno$;
						}
					},
					_abort_js: () => $abort$$("native code called abort()"),
					_gmtime_js: function($date$jscomp$3_time$$, $tmPtr$$) {
						$date$jscomp$3_time$$ = -9007199254740992 > $date$jscomp$3_time$$ || 9007199254740992 < $date$jscomp$3_time$$ ? NaN : Number($date$jscomp$3_time$$);
						$tmPtr$$ >>>= 0;
						$date$jscomp$3_time$$ = /* @__PURE__ */ new Date(1e3 * $date$jscomp$3_time$$);
						$HEAP32$$[$tmPtr$$ >>> 2 >>> 0] = $date$jscomp$3_time$$.getUTCSeconds();
						$HEAP32$$[$tmPtr$$ + 4 >>> 2 >>> 0] = $date$jscomp$3_time$$.getUTCMinutes();
						$HEAP32$$[$tmPtr$$ + 8 >>> 2 >>> 0] = $date$jscomp$3_time$$.getUTCHours();
						$HEAP32$$[$tmPtr$$ + 12 >>> 2 >>> 0] = $date$jscomp$3_time$$.getUTCDate();
						$HEAP32$$[$tmPtr$$ + 16 >>> 2 >>> 0] = $date$jscomp$3_time$$.getUTCMonth();
						$HEAP32$$[$tmPtr$$ + 20 >>> 2 >>> 0] = $date$jscomp$3_time$$.getUTCFullYear() - 1900;
						$HEAP32$$[$tmPtr$$ + 24 >>> 2 >>> 0] = $date$jscomp$3_time$$.getUTCDay();
						$HEAP32$$[$tmPtr$$ + 28 >>> 2 >>> 0] = ($date$jscomp$3_time$$.getTime() - Date.UTC($date$jscomp$3_time$$.getUTCFullYear(), 0, 1, 0, 0, 0, 0)) / 864e5 | 0;
					},
					_localtime_js: function($date$jscomp$5_time$jscomp$1$$, $tmPtr$jscomp$1$$) {
						$date$jscomp$5_time$jscomp$1$$ = -9007199254740992 > $date$jscomp$5_time$jscomp$1$$ || 9007199254740992 < $date$jscomp$5_time$jscomp$1$$ ? NaN : Number($date$jscomp$5_time$jscomp$1$$);
						$tmPtr$jscomp$1$$ >>>= 0;
						$date$jscomp$5_time$jscomp$1$$ = /* @__PURE__ */ new Date(1e3 * $date$jscomp$5_time$jscomp$1$$);
						$HEAP32$$[$tmPtr$jscomp$1$$ >>> 2 >>> 0] = $date$jscomp$5_time$jscomp$1$$.getSeconds();
						$HEAP32$$[$tmPtr$jscomp$1$$ + 4 >>> 2 >>> 0] = $date$jscomp$5_time$jscomp$1$$.getMinutes();
						$HEAP32$$[$tmPtr$jscomp$1$$ + 8 >>> 2 >>> 0] = $date$jscomp$5_time$jscomp$1$$.getHours();
						$HEAP32$$[$tmPtr$jscomp$1$$ + 12 >>> 2 >>> 0] = $date$jscomp$5_time$jscomp$1$$.getDate();
						$HEAP32$$[$tmPtr$jscomp$1$$ + 16 >>> 2 >>> 0] = $date$jscomp$5_time$jscomp$1$$.getMonth();
						$HEAP32$$[$tmPtr$jscomp$1$$ + 20 >>> 2 >>> 0] = $date$jscomp$5_time$jscomp$1$$.getFullYear() - 1900;
						$HEAP32$$[$tmPtr$jscomp$1$$ + 24 >>> 2 >>> 0] = $date$jscomp$5_time$jscomp$1$$.getDay();
						var $summerOffset_year$jscomp$inline_257$$ = $date$jscomp$5_time$jscomp$1$$.getFullYear();
						$HEAP32$$[$tmPtr$jscomp$1$$ + 28 >>> 2 >>> 0] = (0 !== $summerOffset_year$jscomp$inline_257$$ % 4 || 0 === $summerOffset_year$jscomp$inline_257$$ % 100 && 0 !== $summerOffset_year$jscomp$inline_257$$ % 400 ? $MONTH_DAYS_REGULAR_CUMULATIVE$$ : $MONTH_DAYS_LEAP_CUMULATIVE$$)[$date$jscomp$5_time$jscomp$1$$.getMonth()] + $date$jscomp$5_time$jscomp$1$$.getDate() - 1 | 0;
						$HEAP32$$[$tmPtr$jscomp$1$$ + 36 >>> 2 >>> 0] = -(60 * $date$jscomp$5_time$jscomp$1$$.getTimezoneOffset());
						$summerOffset_year$jscomp$inline_257$$ = new Date($date$jscomp$5_time$jscomp$1$$.getFullYear(), 6, 1).getTimezoneOffset();
						var $winterOffset$$ = new Date($date$jscomp$5_time$jscomp$1$$.getFullYear(), 0, 1).getTimezoneOffset();
						$HEAP32$$[$tmPtr$jscomp$1$$ + 32 >>> 2 >>> 0] = ($summerOffset_year$jscomp$inline_257$$ != $winterOffset$$ && $date$jscomp$5_time$jscomp$1$$.getTimezoneOffset() == Math.min($winterOffset$$, $summerOffset_year$jscomp$inline_257$$)) | 0;
					},
					_mmap_js: function($len$jscomp$7$$, $prot$jscomp$3$$, $flags$jscomp$18$$, $fd$jscomp$19$$, $offset$jscomp$46$$, $allocated$jscomp$1$$, $addr$jscomp$1$$) {
						$len$jscomp$7$$ >>>= 0;
						$offset$jscomp$46$$ = -9007199254740992 > $offset$jscomp$46$$ || 9007199254740992 < $offset$jscomp$46$$ ? NaN : Number($offset$jscomp$46$$);
						$allocated$jscomp$1$$ >>>= 0;
						$addr$jscomp$1$$ >>>= 0;
						try {
							$assert$$(!isNaN($offset$jscomp$46$$));
							var $stream$jscomp$57$$ = $JSCompiler_StaticMethods_getStreamChecked$$($fd$jscomp$19$$), $res$$ = $FS$$.$mmap$($stream$jscomp$57$$, $len$jscomp$7$$, $offset$jscomp$46$$, $prot$jscomp$3$$, $flags$jscomp$18$$), $ptr$jscomp$8$$ = $res$$.$ptr$;
							$HEAP32$$[$allocated$jscomp$1$$ >>> 2 >>> 0] = $res$$.$allocated$;
							$HEAPU32$$[$addr$jscomp$1$$ >>> 2 >>> 0] = $ptr$jscomp$8$$;
							return 0;
						} catch ($e$jscomp$45$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$45$$.name) throw $e$jscomp$45$$;
							return -$e$jscomp$45$$.$errno$;
						}
					},
					_munmap_js: function($addr$jscomp$2_addr$jscomp$inline_170$$, $len$jscomp$8_len$jscomp$inline_172$$, $prot$jscomp$4$$, $flags$jscomp$19$$, $fd$jscomp$20$$, $offset$jscomp$47_offset$jscomp$inline_174$$) {
						$addr$jscomp$2_addr$jscomp$inline_170$$ >>>= 0;
						$len$jscomp$8_len$jscomp$inline_172$$ >>>= 0;
						$offset$jscomp$47_offset$jscomp$inline_174$$ = -9007199254740992 > $offset$jscomp$47_offset$jscomp$inline_174$$ || 9007199254740992 < $offset$jscomp$47_offset$jscomp$inline_174$$ ? NaN : Number($offset$jscomp$47_offset$jscomp$inline_174$$);
						try {
							var $stream$jscomp$58$$ = $JSCompiler_StaticMethods_getStreamChecked$$($fd$jscomp$20$$);
							if ($prot$jscomp$4$$ & 2) {
								if (!$FS$$.isFile($stream$jscomp$58$$.node.mode)) throw new $FS$$.$ErrnoError$(43);
								$flags$jscomp$19$$ & 2 || $FS$$.$msync$($stream$jscomp$58$$, $HEAPU8$$.slice($addr$jscomp$2_addr$jscomp$inline_170$$, $addr$jscomp$2_addr$jscomp$inline_170$$ + $len$jscomp$8_len$jscomp$inline_172$$), $offset$jscomp$47_offset$jscomp$inline_174$$, $len$jscomp$8_len$jscomp$inline_172$$, $flags$jscomp$19$$);
							}
						} catch ($e$jscomp$46$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$46$$.name) throw $e$jscomp$46$$;
							return -$e$jscomp$46$$.$errno$;
						}
					},
					_timegm_js: function($tmPtr$jscomp$2$$) {
						$tmPtr$jscomp$2$$ >>>= 0;
						var $date$jscomp$inline_176$$ = new Date(Date.UTC($HEAP32$$[$tmPtr$jscomp$2$$ + 20 >>> 2 >>> 0] + 1900, $HEAP32$$[$tmPtr$jscomp$2$$ + 16 >>> 2 >>> 0], $HEAP32$$[$tmPtr$jscomp$2$$ + 12 >>> 2 >>> 0], $HEAP32$$[$tmPtr$jscomp$2$$ + 8 >>> 2 >>> 0], $HEAP32$$[$tmPtr$jscomp$2$$ + 4 >>> 2 >>> 0], $HEAP32$$[$tmPtr$jscomp$2$$ >>> 2 >>> 0], 0));
						$HEAP32$$[$tmPtr$jscomp$2$$ + 24 >>> 2 >>> 0] = $date$jscomp$inline_176$$.getUTCDay();
						$HEAP32$$[$tmPtr$jscomp$2$$ + 28 >>> 2 >>> 0] = ($date$jscomp$inline_176$$.getTime() - Date.UTC($date$jscomp$inline_176$$.getUTCFullYear(), 0, 1, 0, 0, 0, 0)) / 864e5 | 0;
						return BigInt($date$jscomp$inline_176$$.getTime() / 1e3);
					},
					_tzset_js: function($timezone_winterName$$, $daylight_extractZone_summerName$$, $std_name$$, $dst_name$$) {
						$std_name$$ >>>= 0;
						$dst_name$$ >>>= 0;
						var $currentYear_summerOffset$jscomp$1$$ = (/* @__PURE__ */ new Date()).getFullYear(), $winterOffset$jscomp$1$$ = new Date($currentYear_summerOffset$jscomp$1$$, 0, 1).getTimezoneOffset();
						$currentYear_summerOffset$jscomp$1$$ = new Date($currentYear_summerOffset$jscomp$1$$, 6, 1).getTimezoneOffset();
						$HEAPU32$$[$timezone_winterName$$ >>> 0 >>> 2 >>> 0] = 60 * Math.max($winterOffset$jscomp$1$$, $currentYear_summerOffset$jscomp$1$$);
						$HEAP32$$[$daylight_extractZone_summerName$$ >>> 0 >>> 2 >>> 0] = Number($winterOffset$jscomp$1$$ != $currentYear_summerOffset$jscomp$1$$);
						$daylight_extractZone_summerName$$ = ($timezoneOffset$$) => {
							var $absOffset$$ = Math.abs($timezoneOffset$$);
							return `UTC${0 <= $timezoneOffset$$ ? "-" : "+"}${String(Math.floor($absOffset$$ / 60)).padStart(2, "0")}${String($absOffset$$ % 60).padStart(2, "0")}`;
						};
						$timezone_winterName$$ = $daylight_extractZone_summerName$$($winterOffset$jscomp$1$$);
						$daylight_extractZone_summerName$$ = $daylight_extractZone_summerName$$($currentYear_summerOffset$jscomp$1$$);
						$assert$$($timezone_winterName$$);
						$assert$$($daylight_extractZone_summerName$$);
						$assert$$(16 >= $lengthBytesUTF8$$($timezone_winterName$$), `timezone name truncated to fit in TZNAME_MAX (${$timezone_winterName$$})`);
						$assert$$(16 >= $lengthBytesUTF8$$($daylight_extractZone_summerName$$), `timezone name truncated to fit in TZNAME_MAX (${$daylight_extractZone_summerName$$})`);
						$currentYear_summerOffset$jscomp$1$$ < $winterOffset$jscomp$1$$ ? ($stringToUTF8$$($timezone_winterName$$, $std_name$$, 17), $stringToUTF8$$($daylight_extractZone_summerName$$, $dst_name$$, 17)) : ($stringToUTF8$$($timezone_winterName$$, $dst_name$$, 17), $stringToUTF8$$($daylight_extractZone_summerName$$, $std_name$$, 17));
					},
					clock_time_get: function($clk_id$$, $ignored_precision$$, $ptime$$) {
						if (!(0 <= $clk_id$$ && 3 >= $clk_id$$)) return 28;
						$HEAP64$$[$ptime$$ >>> 0 >>> 3 >>> 0] = BigInt(Math.round(1e6 * (0 === $clk_id$$ ? Date.now() : performance.now())));
						return 0;
					},
					emscripten_asm_const_int: function($code$jscomp$3_code$jscomp$inline_178$$, $sigPtr$jscomp$2_sigPtr$jscomp$inline_259$$, $argbuf$jscomp$1_buf$jscomp$inline_260$$) {
						$code$jscomp$3_code$jscomp$inline_178$$ >>>= 0;
						$sigPtr$jscomp$2_sigPtr$jscomp$inline_259$$ >>>= 0;
						$argbuf$jscomp$1_buf$jscomp$inline_260$$ >>>= 0;
						$assert$$(Array.isArray($readEmAsmArgsArray$$));
						$assert$$(0 == $argbuf$jscomp$1_buf$jscomp$inline_260$$ % 16);
						$readEmAsmArgsArray$$.length = 0;
						for (var $ch$jscomp$inline_261$$; $ch$jscomp$inline_261$$ = $HEAPU8$$[$sigPtr$jscomp$2_sigPtr$jscomp$inline_259$$++ >>> 0];) {
							var $chr$jscomp$inline_262_wide$jscomp$inline_264$$ = String.fromCharCode($ch$jscomp$inline_261$$), $validChars$jscomp$inline_263$$ = [
								"d",
								"f",
								"i",
								"p"
							];
							$validChars$jscomp$inline_263$$.push("j");
							$assert$$($validChars$jscomp$inline_263$$.includes($chr$jscomp$inline_262_wide$jscomp$inline_264$$), `Invalid character ${$ch$jscomp$inline_261$$}("${$chr$jscomp$inline_262_wide$jscomp$inline_264$$}") in readEmAsmArgs! Use only [${$validChars$jscomp$inline_263$$}], and do not specify "v" for void return argument.`);
							$chr$jscomp$inline_262_wide$jscomp$inline_264$$ = 105 != $ch$jscomp$inline_261$$;
							$chr$jscomp$inline_262_wide$jscomp$inline_264$$ &= 112 != $ch$jscomp$inline_261$$;
							$argbuf$jscomp$1_buf$jscomp$inline_260$$ += $chr$jscomp$inline_262_wide$jscomp$inline_264$$ && $argbuf$jscomp$1_buf$jscomp$inline_260$$ % 8 ? 4 : 0;
							$readEmAsmArgsArray$$.push(112 == $ch$jscomp$inline_261$$ ? $HEAPU32$$[$argbuf$jscomp$1_buf$jscomp$inline_260$$ >>> 2 >>> 0] : 106 == $ch$jscomp$inline_261$$ ? $HEAP64$$[$argbuf$jscomp$1_buf$jscomp$inline_260$$ >>> 3 >>> 0] : 105 == $ch$jscomp$inline_261$$ ? $HEAP32$$[$argbuf$jscomp$1_buf$jscomp$inline_260$$ >>> 2 >>> 0] : $HEAPF64$$[$argbuf$jscomp$1_buf$jscomp$inline_260$$ >>> 3 >>> 0]);
							$argbuf$jscomp$1_buf$jscomp$inline_260$$ += $chr$jscomp$inline_262_wide$jscomp$inline_264$$ ? 8 : 4;
						}
						$assert$$($ASM_CONSTS$$.hasOwnProperty($code$jscomp$3_code$jscomp$inline_178$$), `No EM_ASM constant found at address ${$code$jscomp$3_code$jscomp$inline_178$$}.  The loaded WebAssembly file is likely out of sync with the generated JavaScript.`);
						return $ASM_CONSTS$$[$code$jscomp$3_code$jscomp$inline_178$$](...$readEmAsmArgsArray$$);
					},
					emscripten_date_now: () => Date.now(),
					emscripten_err: function($str$jscomp$12$$) {
						return $err$$($UTF8ToString$$($str$jscomp$12$$ >>> 0));
					},
					emscripten_errn: function($str$jscomp$13$$, $len$jscomp$9$$) {
						return $err$$($UTF8ToString$$($str$jscomp$13$$ >>> 0, $len$jscomp$9$$ >>> 0));
					},
					emscripten_get_heap_max: function() {
						return 4294901760;
					},
					emscripten_get_now: () => performance.now(),
					emscripten_pc_get_function: $_emscripten_pc_get_function$$,
					emscripten_resize_heap: function($requestedSize$$) {
						$requestedSize$$ >>>= 0;
						var $oldSize$$ = $HEAPU8$$.length;
						$assert$$($requestedSize$$ > $oldSize$$);
						if (4294901760 < $requestedSize$$) return $err$$(`Cannot enlarge memory, requested ${$requestedSize$$} bytes, but the limit is 4294901760 bytes!`), !1;
						for (var $cutDown$$ = 1; 4 >= $cutDown$$; $cutDown$$ *= 2) {
							var $newSize$jscomp$2_overGrownHeapSize$$ = $oldSize$$ * (1 + .2 / $cutDown$$);
							$newSize$jscomp$2_overGrownHeapSize$$ = Math.min($newSize$jscomp$2_overGrownHeapSize$$, $requestedSize$$ + 100663296);
							$newSize$jscomp$2_overGrownHeapSize$$ = Math.min(4294901760, $alignMemory$$(Math.max($requestedSize$$, $newSize$jscomp$2_overGrownHeapSize$$)));
							a: {
								var $size$jscomp$inline_183$$ = $newSize$jscomp$2_overGrownHeapSize$$, $oldHeapSize$jscomp$inline_184$$ = $wasmMemory$$.buffer.byteLength;
								try {
									$wasmMemory$$.grow(($size$jscomp$inline_183$$ - $oldHeapSize$jscomp$inline_184$$ + 65535) / 65536 | 0);
									$updateMemoryViews$$();
									var $JSCompiler_inline_result$jscomp$19$$ = 1;
									break a;
								} catch ($e$jscomp$inline_186$$) {
									$err$$(`growMemory: Attempted to grow heap from ${$oldHeapSize$jscomp$inline_184$$} bytes to ${$size$jscomp$inline_183$$} bytes, but got error: ${$e$jscomp$inline_186$$}`);
								}
								$JSCompiler_inline_result$jscomp$19$$ = void 0;
							}
							if ($JSCompiler_inline_result$jscomp$19$$) return !0;
						}
						$err$$(`Failed to grow the heap from ${$oldSize$$} bytes to ${$newSize$jscomp$2_overGrownHeapSize$$} bytes, not enough memory!`);
						return !1;
					},
					emscripten_stack_snapshot: function() {
						var $callstack$jscomp$1$$ = Error().stack.toString().split("\n");
						"Error" == $callstack$jscomp$1$$[0] && $callstack$jscomp$1$$.shift();
						$saveInUnwindCache$$($callstack$jscomp$1$$);
						$UNWIND_CACHE$$.$last_addr$ = $convertFrameToPC$$($callstack$jscomp$1$$[3]);
						$UNWIND_CACHE$$.$last_stack$ = $callstack$jscomp$1$$;
						return $UNWIND_CACHE$$.$last_addr$;
					},
					emscripten_stack_unwind_buffer: function($addr$jscomp$3_i$jscomp$20$$, $buffer$jscomp$34$$, $count$jscomp$40$$) {
						$addr$jscomp$3_i$jscomp$20$$ >>>= 0;
						$buffer$jscomp$34$$ >>>= 0;
						if ($UNWIND_CACHE$$.$last_addr$ == $addr$jscomp$3_i$jscomp$20$$) var $stack$$ = $UNWIND_CACHE$$.$last_stack$;
						else $stack$$ = Error().stack.toString().split("\n"), "Error" == $stack$$[0] && $stack$$.shift(), $saveInUnwindCache$$($stack$$);
						for (var $offset$jscomp$48$$ = 3; $stack$$[$offset$jscomp$48$$] && $convertFrameToPC$$($stack$$[$offset$jscomp$48$$]) != $addr$jscomp$3_i$jscomp$20$$;) ++$offset$jscomp$48$$;
						for ($addr$jscomp$3_i$jscomp$20$$ = 0; $addr$jscomp$3_i$jscomp$20$$ < $count$jscomp$40$$ && $stack$$[$addr$jscomp$3_i$jscomp$20$$ + $offset$jscomp$48$$]; ++$addr$jscomp$3_i$jscomp$20$$) $HEAP32$$[$buffer$jscomp$34$$ + 4 * $addr$jscomp$3_i$jscomp$20$$ >>> 2 >>> 0] = $convertFrameToPC$$($stack$$[$addr$jscomp$3_i$jscomp$20$$ + $offset$jscomp$48$$]);
						return $addr$jscomp$3_i$jscomp$20$$;
					},
					environ_get: function($__environ$$, $environ_buf$$) {
						$__environ$$ >>>= 0;
						$environ_buf$$ >>>= 0;
						var $bufSize$$ = 0, $envp$$ = 0, $string$jscomp$3$$;
						for ($string$jscomp$3$$ of $getEnvStrings$$()) {
							var $ptr$jscomp$9$$ = $environ_buf$$ + $bufSize$$;
							$HEAPU32$$[$__environ$$ + $envp$$ >>> 2 >>> 0] = $ptr$jscomp$9$$;
							$bufSize$$ += $stringToUTF8$$($string$jscomp$3$$, $ptr$jscomp$9$$, Infinity) + 1;
							$envp$$ += 4;
						}
						return 0;
					},
					environ_sizes_get: function($bufSize$jscomp$1_penviron_count$$, $penviron_buf_size$$) {
						$bufSize$jscomp$1_penviron_count$$ >>>= 0;
						$penviron_buf_size$$ >>>= 0;
						var $strings$jscomp$1$$ = $getEnvStrings$$();
						$HEAPU32$$[$bufSize$jscomp$1_penviron_count$$ >>> 2 >>> 0] = $strings$jscomp$1$$.length;
						$bufSize$jscomp$1_penviron_count$$ = 0;
						for (var $string$jscomp$4$$ of $strings$jscomp$1$$) $bufSize$jscomp$1_penviron_count$$ += $lengthBytesUTF8$$($string$jscomp$4$$) + 1;
						$HEAPU32$$[$penviron_buf_size$$ >>> 2 >>> 0] = $bufSize$jscomp$1_penviron_count$$;
						return 0;
					},
					exit: $exitJS$$,
					fd_close: function($fd$jscomp$21$$) {
						try {
							var $stream$jscomp$59$$ = $JSCompiler_StaticMethods_getStreamChecked$$($fd$jscomp$21$$);
							$FS$$.close($stream$jscomp$59$$);
							return 0;
						} catch ($e$jscomp$48$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$48$$.name) throw $e$jscomp$48$$;
							return $e$jscomp$48$$.$errno$;
						}
					},
					fd_fdstat_get: function($fd$jscomp$22$$, $pbuf$$) {
						$pbuf$$ >>>= 0;
						try {
							var $stream$jscomp$60$$ = $JSCompiler_StaticMethods_getStreamChecked$$($fd$jscomp$22$$);
							$HEAP8$$[$pbuf$$ >>> 0] = $stream$jscomp$60$$.$tty$ ? 2 : $JSCompiler_StaticMethods_isDir$$($stream$jscomp$60$$.mode) ? 3 : 40960 === ($stream$jscomp$60$$.mode & 61440) ? 7 : 4;
							$HEAP16$$[$pbuf$$ + 2 >>> 1 >>> 0] = 0;
							$HEAP64$$[$pbuf$$ + 8 >>> 3 >>> 0] = BigInt(0);
							$HEAP64$$[$pbuf$$ + 16 >>> 3 >>> 0] = BigInt(0);
							return 0;
						} catch ($e$jscomp$49$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$49$$.name) throw $e$jscomp$49$$;
							return $e$jscomp$49$$.$errno$;
						}
					},
					fd_read: function($fd$jscomp$23_iov$jscomp$inline_189$$, $iov$jscomp$1_ret$jscomp$inline_192$$, $iovcnt$jscomp$1_iovcnt$jscomp$inline_190$$, $pnum$$) {
						$iov$jscomp$1_ret$jscomp$inline_192$$ >>>= 0;
						$iovcnt$jscomp$1_iovcnt$jscomp$inline_190$$ >>>= 0;
						$pnum$$ >>>= 0;
						try {
							a: {
								var $stream$jscomp$inline_188$$ = $JSCompiler_StaticMethods_getStreamChecked$$($fd$jscomp$23_iov$jscomp$inline_189$$);
								$fd$jscomp$23_iov$jscomp$inline_189$$ = $iov$jscomp$1_ret$jscomp$inline_192$$;
								for (var $offset$jscomp$inline_191$$, $i$jscomp$inline_193$$ = $iov$jscomp$1_ret$jscomp$inline_192$$ = 0; $i$jscomp$inline_193$$ < $iovcnt$jscomp$1_iovcnt$jscomp$inline_190$$; $i$jscomp$inline_193$$++) {
									var $ptr$jscomp$inline_194$$ = $HEAPU32$$[$fd$jscomp$23_iov$jscomp$inline_189$$ >>> 2 >>> 0], $len$jscomp$inline_195$$ = $HEAPU32$$[$fd$jscomp$23_iov$jscomp$inline_189$$ + 4 >>> 2 >>> 0];
									$fd$jscomp$23_iov$jscomp$inline_189$$ += 8;
									var $curr$jscomp$inline_196$$ = $FS$$.read($stream$jscomp$inline_188$$, $HEAP8$$, $ptr$jscomp$inline_194$$, $len$jscomp$inline_195$$, $offset$jscomp$inline_191$$);
									if (0 > $curr$jscomp$inline_196$$) {
										var $num$jscomp$7$$ = -1;
										break a;
									}
									$iov$jscomp$1_ret$jscomp$inline_192$$ += $curr$jscomp$inline_196$$;
									if ($curr$jscomp$inline_196$$ < $len$jscomp$inline_195$$) break;
									"undefined" != typeof $offset$jscomp$inline_191$$ && ($offset$jscomp$inline_191$$ += $curr$jscomp$inline_196$$);
								}
								$num$jscomp$7$$ = $iov$jscomp$1_ret$jscomp$inline_192$$;
							}
							$HEAPU32$$[$pnum$$ >>> 2 >>> 0] = $num$jscomp$7$$;
							return 0;
						} catch ($e$jscomp$50$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$50$$.name) throw $e$jscomp$50$$;
							return $e$jscomp$50$$.$errno$;
						}
					},
					fd_seek: function($fd$jscomp$24$$, $offset$jscomp$50$$, $whence$jscomp$3$$, $newOffset$$) {
						$offset$jscomp$50$$ = -9007199254740992 > $offset$jscomp$50$$ || 9007199254740992 < $offset$jscomp$50$$ ? NaN : Number($offset$jscomp$50$$);
						$newOffset$$ >>>= 0;
						try {
							if (isNaN($offset$jscomp$50$$)) return 61;
							var $stream$jscomp$63$$ = $JSCompiler_StaticMethods_getStreamChecked$$($fd$jscomp$24$$);
							$FS$$.$llseek$($stream$jscomp$63$$, $offset$jscomp$50$$, $whence$jscomp$3$$);
							$HEAP64$$[$newOffset$$ >>> 3 >>> 0] = BigInt($stream$jscomp$63$$.position);
							$stream$jscomp$63$$.$getdents$ && 0 === $offset$jscomp$50$$ && 0 === $whence$jscomp$3$$ && ($stream$jscomp$63$$.$getdents$ = null);
							return 0;
						} catch ($e$jscomp$51$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$51$$.name) throw $e$jscomp$51$$;
							return $e$jscomp$51$$.$errno$;
						}
					},
					fd_sync: function($fd$jscomp$25$$) {
						try {
							var $stream$jscomp$64$$ = $JSCompiler_StaticMethods_getStreamChecked$$($fd$jscomp$25$$);
							return $stream$jscomp$64$$.$stream_ops$?.$fsync$?.($stream$jscomp$64$$);
						} catch ($e$jscomp$52$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$52$$.name) throw $e$jscomp$52$$;
							return $e$jscomp$52$$.$errno$;
						}
					},
					fd_write: function($fd$jscomp$26_iov$jscomp$inline_199$$, $iov$jscomp$3_ret$jscomp$inline_202$$, $iovcnt$jscomp$3_iovcnt$jscomp$inline_200$$, $pnum$jscomp$1$$) {
						$iov$jscomp$3_ret$jscomp$inline_202$$ >>>= 0;
						$iovcnt$jscomp$3_iovcnt$jscomp$inline_200$$ >>>= 0;
						$pnum$jscomp$1$$ >>>= 0;
						try {
							a: {
								var $stream$jscomp$inline_198$$ = $JSCompiler_StaticMethods_getStreamChecked$$($fd$jscomp$26_iov$jscomp$inline_199$$);
								$fd$jscomp$26_iov$jscomp$inline_199$$ = $iov$jscomp$3_ret$jscomp$inline_202$$;
								for (var $offset$jscomp$inline_201$$, $i$jscomp$inline_203$$ = $iov$jscomp$3_ret$jscomp$inline_202$$ = 0; $i$jscomp$inline_203$$ < $iovcnt$jscomp$3_iovcnt$jscomp$inline_200$$; $i$jscomp$inline_203$$++) {
									var $ptr$jscomp$inline_204$$ = $HEAPU32$$[$fd$jscomp$26_iov$jscomp$inline_199$$ >>> 2 >>> 0], $len$jscomp$inline_205$$ = $HEAPU32$$[$fd$jscomp$26_iov$jscomp$inline_199$$ + 4 >>> 2 >>> 0];
									$fd$jscomp$26_iov$jscomp$inline_199$$ += 8;
									var $curr$jscomp$inline_206$$ = $FS$$.write($stream$jscomp$inline_198$$, $HEAP8$$, $ptr$jscomp$inline_204$$, $len$jscomp$inline_205$$, $offset$jscomp$inline_201$$);
									if (0 > $curr$jscomp$inline_206$$) {
										var $num$jscomp$8$$ = -1;
										break a;
									}
									$iov$jscomp$3_ret$jscomp$inline_202$$ += $curr$jscomp$inline_206$$;
									if ($curr$jscomp$inline_206$$ < $len$jscomp$inline_205$$) break;
									"undefined" != typeof $offset$jscomp$inline_201$$ && ($offset$jscomp$inline_201$$ += $curr$jscomp$inline_206$$);
								}
								$num$jscomp$8$$ = $iov$jscomp$3_ret$jscomp$inline_202$$;
							}
							$HEAPU32$$[$pnum$jscomp$1$$ >>> 2 >>> 0] = $num$jscomp$8$$;
							return 0;
						} catch ($e$jscomp$53$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$53$$.name) throw $e$jscomp$53$$;
							return $e$jscomp$53$$.$errno$;
						}
					},
					proc_exit: $_proc_exit$$,
					random_get: function($buffer$jscomp$35$$, $size$jscomp$29$$) {
						$buffer$jscomp$35$$ >>>= 0;
						try {
							return $randomFill$$($HEAPU8$$.subarray($buffer$jscomp$35$$ >>> 0, $buffer$jscomp$35$$ + ($size$jscomp$29$$ >>> 0) >>> 0)), 0;
						} catch ($e$jscomp$54$$) {
							if ("undefined" == typeof $FS$$ || "ErrnoError" !== $e$jscomp$54$$.name) throw $e$jscomp$54$$;
							return $e$jscomp$54$$.$errno$;
						}
					}
				};
				function $applySignatureConversions$$() {
					var $wasmExports$jscomp$2$$ = $wasmExports$$;
					$wasmExports$jscomp$2$$ = Object.assign({}, $wasmExports$jscomp$2$$);
					var $makeWrapper_pp$$ = ($f$jscomp$3$$) => ($a0$jscomp$1$$) => $f$jscomp$3$$($a0$jscomp$1$$) >>> 0, $makeWrapper_p$$ = ($f$jscomp$4$$) => () => $f$jscomp$4$$() >>> 0;
					$wasmExports$jscomp$2$$.strerror = (($f$jscomp$2$$) => ($a0$$) => $f$jscomp$2$$($a0$$) >>> 0)($wasmExports$jscomp$2$$.strerror);
					$wasmExports$jscomp$2$$.malloc = $makeWrapper_pp$$($wasmExports$jscomp$2$$.malloc);
					$wasmExports$jscomp$2$$.emscripten_stack_get_end = $makeWrapper_p$$($wasmExports$jscomp$2$$.emscripten_stack_get_end);
					$wasmExports$jscomp$2$$.emscripten_stack_get_base = $makeWrapper_p$$($wasmExports$jscomp$2$$.emscripten_stack_get_base);
					$wasmExports$jscomp$2$$.emscripten_builtin_memalign = (($f$jscomp$5$$) => ($a0$jscomp$2$$, $a1$$) => $f$jscomp$5$$($a0$jscomp$2$$, $a1$$) >>> 0)($wasmExports$jscomp$2$$.emscripten_builtin_memalign);
					$wasmExports$jscomp$2$$._emscripten_stack_alloc = $makeWrapper_pp$$($wasmExports$jscomp$2$$._emscripten_stack_alloc);
					$wasmExports$jscomp$2$$.emscripten_stack_get_current = $makeWrapper_p$$($wasmExports$jscomp$2$$.emscripten_stack_get_current);
					return $wasmExports$jscomp$2$$;
				}
				var $calledRun$$;
				function $callMain$$($JSCompiler_inline_result$jscomp$20_args$jscomp$13_e$jscomp$inline_208$$ = []) {
					$assert$$(0 == $runDependencies$$, "cannot call main when async dependencies remain! (listen on Module[\"onRuntimeInitialized\"])");
					$assert$$("undefined" === typeof $onPreRuns$$ || 0 == $onPreRuns$$.length, "cannot call main when preRun functions remain to be called");
					var $entryFunction$$ = $_main$$;
					$JSCompiler_inline_result$jscomp$20_args$jscomp$13_e$jscomp$inline_208$$.unshift($thisProgram$$);
					var $argc$$ = $JSCompiler_inline_result$jscomp$20_args$jscomp$13_e$jscomp$inline_208$$.length, $argv$$ = $__emscripten_stack_alloc$$(4 * ($argc$$ + 1)), $argv_ptr$$ = $argv$$, $arg$jscomp$12$$;
					for ($arg$jscomp$12$$ of $JSCompiler_inline_result$jscomp$20_args$jscomp$13_e$jscomp$inline_208$$) $HEAPU32$$[$argv_ptr$$ >>> 2 >>> 0] = $stringToUTF8OnStack$$($arg$jscomp$12$$), $argv_ptr$$ += 4;
					$HEAPU32$$[$argv_ptr$$ >>> 2 >>> 0] = 0;
					try {
						var $ret$jscomp$17$$ = $entryFunction$$($argc$$, $argv$$);
						$exitJS$$($ret$jscomp$17$$, !0);
						return $ret$jscomp$17$$;
					} catch ($e$jscomp$56$$) {
						$JSCompiler_inline_result$jscomp$20_args$jscomp$13_e$jscomp$inline_208$$ = $e$jscomp$56$$;
						if ($JSCompiler_inline_result$jscomp$20_args$jscomp$13_e$jscomp$inline_208$$ instanceof $ExitStatus$$ || "unwind" == $JSCompiler_inline_result$jscomp$20_args$jscomp$13_e$jscomp$inline_208$$) $JSCompiler_inline_result$jscomp$20_args$jscomp$13_e$jscomp$inline_208$$ = $EXITSTATUS$$;
						else throw $checkStackCookie$$(), $JSCompiler_inline_result$jscomp$20_args$jscomp$13_e$jscomp$inline_208$$ instanceof WebAssembly.RuntimeError && 0 >= $_emscripten_stack_get_current$$() && $err$$("Stack overflow detected.  You can try increasing -sSTACK_SIZE (currently set to 2097152)"), $JSCompiler_inline_result$jscomp$20_args$jscomp$13_e$jscomp$inline_208$$;
						return $JSCompiler_inline_result$jscomp$20_args$jscomp$13_e$jscomp$inline_208$$;
					}
				}
				function $run$$($args$jscomp$14$$ = $arguments_$$) {
					function $doRun$$() {
						$assert$$(!$calledRun$$);
						$calledRun$$ = !0;
						$Module$$.calledRun = !0;
						if (!$ABORT$$) {
							$assert$$(!$runtimeInitialized$$);
							$runtimeInitialized$$ = !0;
							$checkStackCookie$$();
							$Module$$.noFSInit || $FS$$.$initialized$ || $JSCompiler_StaticMethods_init$$();
							$wasmExports$$.__wasm_call_ctors();
							$FS$$.$ignorePermissions$ = !1;
							$checkStackCookie$$();
							$readyPromiseResolve$$?.($Module$$);
							$Module$$.onRuntimeInitialized?.();
							$consumedModuleProp$$("onRuntimeInitialized");
							$Module$$.noInitialRun || $callMain$$($args$jscomp$14$$);
							$checkStackCookie$$();
							if ($Module$$.postRun) for ("function" == typeof $Module$$.postRun && ($Module$$.postRun = [$Module$$.postRun]); $Module$$.postRun.length;) {
								var $cb$jscomp$inline_268$$ = $Module$$.postRun.shift();
								$onPostRuns$$.push($cb$jscomp$inline_268$$);
							}
							$consumedModuleProp$$("postRun");
							$callRuntimeCallbacks$$($onPostRuns$$);
						}
					}
					if (0 < $runDependencies$$) $dependenciesFulfilled$$ = $run$$;
					else {
						$_emscripten_stack_init$$();
						$writeStackCookie$$();
						if ($Module$$.preRun) for ("function" == typeof $Module$$.preRun && ($Module$$.preRun = [$Module$$.preRun]); $Module$$.preRun.length;) $addOnPreRun$$();
						$consumedModuleProp$$("preRun");
						$callRuntimeCallbacks$$($onPreRuns$$);
						0 < $runDependencies$$ ? $dependenciesFulfilled$$ = $run$$ : ($Module$$.setStatus ? ($Module$$.setStatus("Running..."), setTimeout(() => {
							setTimeout(() => $Module$$.setStatus(""), 1);
							$doRun$$();
						}, 1)) : $doRun$$(), $checkStackCookie$$());
					}
				}
				function $checkUnflushedContent$$() {
					var $oldOut$$ = $out$$, $oldErr$$ = $err$$, $has$$ = !1;
					$out$$ = $err$$ = () => {
						$has$$ = !0;
					};
					try {
						$_fflush$$(0);
						for (var $name$jscomp$107$$ of ["stdout", "stderr"]) {
							var $info$jscomp$1$$ = $JSCompiler_StaticMethods_analyzePath$$("/dev/" + $name$jscomp$107$$);
							if (!$info$jscomp$1$$) return;
							$TTY$ttys$$[$info$jscomp$1$$.object.$rdev$]?.output?.length && ($has$$ = !0);
						}
					} catch ($e$jscomp$57$$) {}
					$out$$ = $oldOut$$;
					$err$$ = $oldErr$$;
					$has$$ && $warnOnce$$("stdio streams had content in them that was not flushed. you should set EXIT_RUNTIME to 1 (see the Emscripten FAQ), or make sure to emit a newline when you printf etc.");
				}
				var $wasmExports$$ = await async function() {
					function $receiveInstance$$($instance$jscomp$1_wasmExports$jscomp$inline_215$$) {
						$wasmExports$$ = $instance$jscomp$1_wasmExports$jscomp$inline_215$$.exports;
						$instance$jscomp$1_wasmExports$jscomp$inline_215$$ = $wasmExports$$ = $applySignatureConversions$$();
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.__main_argc_argv, "missing Wasm export: __main_argc_argv");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.strerror, "missing Wasm export: strerror");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.malloc, "missing Wasm export: malloc");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.free, "missing Wasm export: free");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.fflush, "missing Wasm export: fflush");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.SynqPerfettoParseAlloc, "missing Wasm export: SynqPerfettoParseAlloc");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.SynqPerfettoParseFree, "missing Wasm export: SynqPerfettoParseFree");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.SynqPerfettoParse, "missing Wasm export: SynqPerfettoParse");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.synq_extent_on_shift, "missing Wasm export: synq_extent_on_shift");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.SynqPerfettoGetToken, "missing Wasm export: SynqPerfettoGetToken");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.synq_extent_on_reduce, "missing Wasm export: synq_extent_on_reduce");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.synq_extent_fold_below_into_top, "missing Wasm export: synq_extent_fold_below_into_top");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.SynqPerfettoParseInit, "missing Wasm export: SynqPerfettoParseInit");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.SynqPerfettoParseFinalize, "missing Wasm export: SynqPerfettoParseFinalize");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.SynqPerfettoParseFallback, "missing Wasm export: SynqPerfettoParseFallback");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.SynqPerfettoParseExpectedTokens, "missing Wasm export: SynqPerfettoParseExpectedTokens");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.SynqPerfettoParseCompletionContext, "missing Wasm export: SynqPerfettoParseCompletionContext");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.emscripten_stack_get_end, "missing Wasm export: emscripten_stack_get_end");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.emscripten_stack_get_base, "missing Wasm export: emscripten_stack_get_base");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.emscripten_builtin_memalign, "missing Wasm export: emscripten_builtin_memalign");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.emscripten_stack_init, "missing Wasm export: emscripten_stack_init");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.emscripten_stack_get_free, "missing Wasm export: emscripten_stack_get_free");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$._emscripten_stack_restore, "missing Wasm export: _emscripten_stack_restore");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$._emscripten_stack_alloc, "missing Wasm export: _emscripten_stack_alloc");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.emscripten_stack_get_current, "missing Wasm export: emscripten_stack_get_current");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.memory, "missing Wasm export: memory");
						$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_215$$.__indirect_function_table, "missing Wasm export: __indirect_function_table");
						$_main$$ = $Module$$._main = $createExportWrapper$$("__main_argc_argv", 2);
						$_strerror$$ = $createExportWrapper$$("strerror", 1);
						$_malloc$$ = $createExportWrapper$$("malloc", 1);
						$_free$$ = $createExportWrapper$$("free", 1);
						$_fflush$$ = $createExportWrapper$$("fflush", 1);
						$Module$$._SynqPerfettoParseAlloc = $createExportWrapper$$("SynqPerfettoParseAlloc", 2);
						$Module$$._SynqPerfettoParseFree = $createExportWrapper$$("SynqPerfettoParseFree", 2);
						$Module$$._SynqPerfettoParse = $createExportWrapper$$("SynqPerfettoParse", 3);
						$Module$$._synq_extent_on_shift = $createExportWrapper$$("synq_extent_on_shift", 3);
						$Module$$._SynqPerfettoGetToken = $createExportWrapper$$("SynqPerfettoGetToken", 3);
						$Module$$._synq_extent_on_reduce = $createExportWrapper$$("synq_extent_on_reduce", 2);
						$Module$$._synq_extent_fold_below_into_top = $createExportWrapper$$("synq_extent_fold_below_into_top", 1);
						$Module$$._SynqPerfettoParseInit = $createExportWrapper$$("SynqPerfettoParseInit", 2);
						$Module$$._SynqPerfettoParseFinalize = $createExportWrapper$$("SynqPerfettoParseFinalize", 1);
						$Module$$._SynqPerfettoParseFallback = $createExportWrapper$$("SynqPerfettoParseFallback", 1);
						$Module$$._SynqPerfettoParseExpectedTokens = $createExportWrapper$$("SynqPerfettoParseExpectedTokens", 3);
						$Module$$._SynqPerfettoParseCompletionContext = $createExportWrapper$$("SynqPerfettoParseCompletionContext", 1);
						$_emscripten_stack_get_end$$ = $instance$jscomp$1_wasmExports$jscomp$inline_215$$.emscripten_stack_get_end;
						$_emscripten_builtin_memalign$$ = $createExportWrapper$$("emscripten_builtin_memalign", 2);
						$_emscripten_stack_init$$ = $instance$jscomp$1_wasmExports$jscomp$inline_215$$.emscripten_stack_init;
						$__emscripten_stack_restore$$ = $instance$jscomp$1_wasmExports$jscomp$inline_215$$._emscripten_stack_restore;
						$__emscripten_stack_alloc$$ = $instance$jscomp$1_wasmExports$jscomp$inline_215$$._emscripten_stack_alloc;
						$_emscripten_stack_get_current$$ = $instance$jscomp$1_wasmExports$jscomp$inline_215$$.emscripten_stack_get_current;
						$wasmMemory$$ = $instance$jscomp$1_wasmExports$jscomp$inline_215$$.memory;
						$wasmTable$$ = $instance$jscomp$1_wasmExports$jscomp$inline_215$$.__indirect_function_table;
						$updateMemoryViews$$();
						return $wasmExports$$;
					}
					var $trueModule$$ = $Module$$, $info$$ = {
						env: $wasmImports$$,
						wasi_snapshot_preview1: $wasmImports$$
					};
					if ($Module$$.instantiateWasm) return new Promise(($resolve$$, $reject$$) => {
						try {
							$Module$$.instantiateWasm($info$$, ($inst$$, $mod$$) => {
								$resolve$$($receiveInstance$$($inst$$, $mod$$));
							});
						} catch ($e$jscomp$8$$) {
							$err$$(`Module.instantiateWasm callback failed with error: ${$e$jscomp$8$$}`), $reject$$($e$jscomp$8$$);
						}
					});
					$wasmBinaryFile$$ ??= $Module$$.locateFile ? $Module$$.locateFile("traceconv.wasm", $scriptDirectory$$) : $scriptDirectory$$ + "traceconv.wasm";
					return function($result$jscomp$2$$) {
						$assert$$($Module$$ === $trueModule$$, "the Module object should not be replaced during async compilation - perhaps the order of HTML elements is wrong?");
						$trueModule$$ = null;
						return $receiveInstance$$($result$jscomp$2$$.instance);
					}(await $instantiateAsync$$($info$$));
				}();
				$run$$();
				$runtimeInitialized$$ ? moduleRtn = $Module$$ : moduleRtn = new Promise(($resolve$jscomp$1$$, $reject$jscomp$1$$) => {
					$readyPromiseResolve$$ = $resolve$jscomp$1$$;
					$readyPromiseReject$$ = $reject$jscomp$1$$;
				});
				for (const $prop$jscomp$4$$ of Object.keys($Module$$)) $prop$jscomp$4$$ in moduleArg || Object.defineProperty(moduleArg, $prop$jscomp$4$$, {
					configurable: !0,
					get() {
						$abort$$(`Access to module property ('${$prop$jscomp$4$$}') is no longer possible via the module constructor argument; Instead, use the result of the module constructor.`);
					}
				});
				return moduleRtn;
			};
		})();
		if (typeof exports === "object" && typeof module === "object") {
			module.exports = traceconv_wasm;
			module.exports.default = traceconv_wasm;
		} else if (typeof define === "function" && define["amd"]) define([], () => traceconv_wasm);
	})))());
	var selfWorker = self;
	function updateStatus(status) {
		selfWorker.postMessage({
			kind: "updateStatus",
			status
		});
	}
	function notifyJobCompleted() {
		selfWorker.postMessage({ kind: "jobCompleted" });
	}
	function downloadFile(buffer, name) {
		selfWorker.postMessage({
			kind: "downloadFile",
			buffer,
			name
		}, [buffer.buffer]);
	}
	function openTraceInLegacy(buffer) {
		selfWorker.postMessage({
			kind: "openTraceInLegacy",
			buffer
		});
	}
	function forwardError(error) {
		selfWorker.postMessage({
			kind: "error",
			error
		});
	}
	function fsNodeToBuffer(fsNode) {
		const fileSize = ensureExists(fsNode.usedBytes);
		return new Uint8Array(fsNode.contents.buffer, 0, fileSize);
	}
	async function runTraceconv(trace, args) {
		const module = await (0, import_traceconv.default)({
			noInitialRun: true,
			locateFile: (s) => s,
			print: updateStatus,
			printErr: updateStatus,
			onRuntimeInitialized: () => {}
		});
		module.FS_mkdir("/fs");
		module.FS_mount(module.WORKERFS, { blobs: [{
			name: "trace.proto",
			data: trace
		}] }, "/fs");
		updateStatus("Converting trace");
		module.callMain(args);
		updateStatus("Trace conversion completed");
		return module;
	}
	function isConvertTraceAndDownload(msg) {
		if (msg.kind !== "ConvertTraceAndDownload") return false;
		if (msg.trace === void 0) throw new Error("ConvertTraceAndDownloadArgs missing trace");
		if (msg.format !== "json" && msg.format !== "systrace") throw new Error("ConvertTraceAndDownloadArgs has bad format");
		return true;
	}
	async function ConvertTraceAndDownload(trace, format, truncate) {
		const outPath = "/trace.json";
		const args = [format];
		if (truncate !== void 0) args.push("--truncate", truncate);
		args.push("/fs/trace.proto", outPath);
		try {
			const module = await runTraceconv(trace, args);
			const fsNode = module.FS_lookupPath(outPath).node;
			downloadFile(fsNodeToBuffer(fsNode), `trace.${format}`);
			module.FS_unlink(outPath);
		} finally {
			notifyJobCompleted();
		}
	}
	function isConvertTraceAndOpenInLegacy(msg) {
		if (msg.kind !== "ConvertTraceAndOpenInLegacy") return false;
		return true;
	}
	async function ConvertTraceAndOpenInLegacy(trace, truncate) {
		const outPath = "/trace.json";
		const args = ["json"];
		if (truncate !== void 0) args.push("--truncate", truncate);
		args.push("/fs/trace.proto", outPath);
		try {
			const module = await runTraceconv(trace, args);
			const fsNode = module.FS_lookupPath(outPath).node;
			const data = fsNode.contents.buffer;
			const size = fsNode.usedBytes;
			openTraceInLegacy(new Uint8Array(data, 0, size));
			module.FS_unlink(outPath);
		} finally {
			notifyJobCompleted();
		}
	}
	function isConvertTraceToPprof(msg) {
		if (msg.kind !== "ConvertTraceToPprof") return false;
		return true;
	}
	async function ConvertTraceToPprof(trace, profileType, pid, ts) {
		const args = [
			"profile",
			`--${profileType}`,
			`--pid`,
			`${pid}`,
			`--timestamps`,
			`${ts}`,
			"/fs/trace.proto"
		];
		try {
			const module = await runTraceconv(trace, args);
			const heapDirName = Object.keys(module.FS_lookupPath("/tmp/").node.contents)[0];
			if (heapDirName === void 0) throw new Error(`No profiles generated; the trace has no profile matching type=${profileType} pid=${pid} ts=${ts}`);
			const heapDirContents = module.FS_lookupPath(`/tmp/${heapDirName}`).node.contents;
			const heapDumpFiles = Object.keys(heapDirContents);
			for (let i = 0; i < heapDumpFiles.length; ++i) {
				const heapDump = heapDumpFiles[i];
				const fileNode = module.FS_lookupPath(`/tmp/${heapDirName}/${heapDump}`).node;
				const fileName = `/heap_dump.${i}.${pid}.pb`;
				downloadFile(fsNodeToBuffer(fileNode), fileName);
			}
		} finally {
			notifyJobCompleted();
		}
	}
	selfWorker.onmessage = (msg) => {
		self.addEventListener("error", (e) => reportError(e));
		self.addEventListener("unhandledrejection", (e) => reportError(e));
		addErrorHandler((error) => forwardError(error));
		const args = msg.data;
		if (isConvertTraceAndDownload(args)) ConvertTraceAndDownload(args.trace, args.format, args.truncate);
		else if (isConvertTraceAndOpenInLegacy(args)) ConvertTraceAndOpenInLegacy(args.trace, args.truncate);
		else if (isConvertTraceToPprof(args)) ConvertTraceToPprof(args.trace, args.profileType, args.pid, args.ts);
		else throw new Error(`Unknown method call ${JSON.stringify(args)}`);
	};
	//#endregion
})();

//# sourceMappingURL=traceconv_bundle.js.map
;(self.__SOURCEMAPS=self.__SOURCEMAPS||{})['traceconv_bundle.js']={"version":3,"sources":["../../src/base/utils.ts","../../src/base/logging.ts","../../src/base/assert.ts","ui/tsc/gen/traceconv.js","../../src/traceconv/index.ts"],"mappings":";;;;;;;;;;;;;;;;;;;;;;;;;;;;;;AAkBA;AACE;AACF;;;ACSA;AAEA;AACE;AAGF;AAEA;AACE;AACA;AACA;AACA;AACA;AAEA;AACE;AAMA;AAEE;AACA;AACA;AACF;AAEE;AACA;AACF;AACF;AACE;AACA;AACA;AACF;AACE;AACA;AACF;AAIA;AACA;AACA;AAEA;AACE;AACA;AACA;AACA;AACE;AAeA;AACA;AAKA;AACA;AACA;AACA;AACE;AACA;AACF;AAMA;AACE;AACA;AACF;AACA;AAAY;AAAiB;AAAuB;AACtD;AAMA;AACA;AAGF;AAIA;AAEI;AACA;AACA;AACF;AAEJ;;;ACxFA;AACE;AAGA;AACF;;;;ACpDA;AAIE;AACA;AACE;AAEJ;AACE;AACE;AACA;AAGA;AACA;AACF;AACA;AACA;AAGA;AAC6F;AAAiE;AAAuE;AAA0D;AAE/R;AACE;AACA;AAGA;AACA;AAGA;AACA;AAGF;AACF;AACA;AACA;AACA;AACA;AAEI;AACE;AACF;AAEA;AAGA;AACE;AACA;AACA;AACA;AACA;AACF;AACA;AACE;AACA;AACA;AAGA;AACF;AACF;AAIF;AACA;AACA;AACA;AACA;AACA;AACA;AACE;AACF;AACA;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACF;AACA;AACE;AACE;AACA;AACA;AACA;AACA;AACF;AACF;AACA;AACA;AACA;AACA;AACE;AAAoH;AAAiB;AACnI;AACF;AAAC;AACH;AACA;AACE;AACF;AACA;AACE;AACF;AACA;AACE;AAAkH;AAAiB;AACjI;AACA;AACA;AACF;AAAC;AACH;AACA;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACF;AACA;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACF;AACA;AACE;AACE;AACA;AACA;AACA;AACA;AACF;AACF;AACA;AACA;AACE;AAEI;AACA;AACF;AAGF;AAGE;AAGE;AAGJ;AACF;AACA;AACE;AACE;AACA;AACF;AACE;AACF;AACF;AACA;AACE;AACA;AAEI;AACA;AACF;AACE;AACF;AAEF;AACF;AACA;AACE;AACA;AACE;AACA;AACF;AACF;AACA;AACE;AAGF;AACE;AACA;AACF;AACE;AACA;AACF;AACE;AACA;AACF;AACE;AACE;AACA;AACF;AACA;AAKA;AACF;AACE;AACA;AACA;AACA;AACF;AACE;AACA;AACA;AACA;AAGA;AACA;AACF;AACE;AACF;AACE;AACE;AACA;AAGA;AAGA;AACA;AACF;AACA;AACA;AACF;AACE;AACE;AAEA;AAEA;AACF;AACA;AACA;AACA;AACA;AACA;AAEI;AACA;AACF;AAEF;AACA;AAGA;AACA;AACF;AACE;AACA;AACA;AAGA;AAGA;AACE;AACA;AACE;AACA;AAEO;AACL;AACA;AACA;AACF;AACF;AAGF;AACA;AACF;AACE;AACE;AACA;AACF;AACA;AACF;AACE;AACA;AACA;AAGA;AACA;AACA;AACE;AACA;AACE;AAGA;AACF;AACE;AAGA;AACA;AACF;AACE;AAGA;AACA;AACA;AACF;AACE;AAGA;AACA;AACA;AACA;AACA;AACA;AACF;AACF;AACA;AACA;AACF;AACE;AACA;AACA;AACA;AACF;AACA;AACE;AAAuB;AAAU;AAAW;AAAY;AACxD;AACF;AACA;AAAyB;AACvB;AACA;AAGA;AACA;AACF;AAAG;AACD;AACF;AAAG;AACD;AACF;AAAG;AACD;AAGA;AACE;AACE;AACF;AACE;AACF;AACA;AAGA;AAGA;AACA;AACF;AACA;AACA;AACF;AAAG;AACD;AAGA;AACE;AAGF;AACE;AACF;AACA;AACA;AACF;AAAC;AAA6B;AAC5B;AACE;AACE;AACA;AACA;AACE;AACA;AACF;AACA;AACF;AACA;AACF;AACA;AACF;AAAG;AACD;AACF;AAAG;AACD;AACF;AAAG;AACD;AAAQ;AAAiB;AAAa;AAAe;AAAiB;AAAQ;AAAG;AAAI;AAAK;AAAI;AAAG;AAAG;AAAG;AAAG;AAAI;AAAI;AAAI;AAAG;AAAI;AAAI;AAAI;AAAI;AAAG;AAAG;AAAG;AAAG;AAAG;AAAG;AAAG;AAAG;AAAG;AAAG;AAAG;AAAG;AAAG;AAAG;AAAG;AAAC;AAAC;AAC1L;AAAG;AACD;AACF;AAAG;AACD;AACF;AAAC;AAA8B;AAC7B;AACF;AAAG;AACD;AACF;AAAC;AACC;AACA;AACF;AACE;AACA;AACA;AACA;AACF;AAAe;AAAkB;AAC/B;AACF;AAAG;AACD;AACA;AACA;AAGA;AAAiD;AAAK;AAAM;AAAyC;AAAyC;AAAuC;AAAqC;AAAuC;AAAuC;AAAqC;AAAyC;AAAuC;AAAG;AAAgD;AAAG;AAAM;AAAM;AAC/d;AAAuC;AAAG;AAAQ;AAAyC;AAAiC;AAAmC;AAAqC;AAAqC;AAAC;AAAG;AAAM;AAAM;AAAyC;AAAyC;AAAyC;AAAG;AAAS;AAAG;AAAU;AAAM;AAAyC;AAAuC;AAAG;AAAgC;AAAC;AACvgB;AACA;AAGA;AACA;AACA;AACF;AAAG;AAAY;AACb;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACF;AAAG;AACD;AAA2D;AAAQ;AAAS;AAAS;AAAO;AAG5F;AAEF;AAAG;AACD;AACF;AAAG;AACD;AACF;AAAG;AACD;AACE;AACF;AAEA;AACE;AAKA;AACF;AACA;AACA;AACA;AACA;AACF;AAAG;AACD;AACA;AACF;AAAG;AACD;AACA;AAGA;AACA;AACF;AAAG;AACD;AAAQ;AAAK;AAAM;AAA4C;AACjE;AAAG;AACD;AACA;AACA;AACF;AAAG;AACD;AAGA;AACF;AAAC;AAAG;AAAc;AAChB;AACA;AAGA;AACA;AACA;AACA;AACF;AAAG;AACD;AACA;AACA;AAGA;AACA;AACA;AAEO;AAEA;AACL;AACA;AACA;AAEA;AACA;AACF;AACA;AACF;AAAG;AACD;AACA;AAGA;AACF;AAAG;AACD;AAGA;AACA;AACE;AACA;AACA;AAGA;AACE;AAGA;AACF;AACF;AAGA;AAAQ;AAAsC;AAA6B;AAC7E;AAAG;AACD;AACA;AACF;AAAC;AAAC;AACA;AACA;AACA;AACF;AACE;AACA;AACA;AACA;AACF;AAAkB;AAAkB;AAAmB;AAAe;AACpE;AACE;AACA;AACE;AACA;AACA;AACA;AACF;AACA;AACF;AACA;AACE;AACA;AACF;AACA;AACA;AACA;AACA;AAGA;AAGA;AAKA;AACF;AAAG;AACD;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACF;AAAG;AAAY;AACb;AAAQ;AAAS;AAA4B;AAA6B;AAAW;AAAO;AAAS;AAAU;AAA6B;AAA6C;AAA6C;AAA6C;AAAgB;AAAiD;AACtV;AAAG;AACD;AAAgC;AAAQ;AAAS;AAAS;AAAO;AAGnE;AAAG;AACD;AACF;AAAG;AACD;AACF;AAAG;AACD;AACF;AAAG;AACD;AACF;AAAG;AACD;AACF;AAAG;AACD;AACA;AAGA;AACF;AAAG;AACD;AACF;AAAC;AAAG;AAAc;AAChB;AAGA;AACA;AACA;AACA;AACF;AAAG;AACD;AACF;AAAG;AACD;AACA;AAGA;AACF;AAAC;AAAC;AACA;AACA;AACF;AAAqB;AAAU;AAAW;AAAU;AAAU;AAAQ;AAAU;AAAS;AAAY;AAAS;AAAW;AAAU;AAAe;AAAW;AAAU;AAAW;AAAa;AAAU;AAAW;AAAU;AAAW;AAAY;AAAW;AAAW;AAAW;AAAW;AAAW;AAAY;AAAU;AAAW;AAAW;AAAU;AAAW;AAAU;AAAS;AAAW;AAAW;AAAU;AAAY;AAAc;AAAY;AAAY;AAAY;AAAa;AAC3e;AAAY;AAAY;AAAW;AAAW;AAAW;AAAY;AAAY;AAAa;AAAa;AAAc;AAAY;AAAY;AAAa;AAAW;AAAW;AAAY;AAAY;AAAa;AAAY;AAAU;AAAY;AAAW;AAAW;AAAc;AAAa;AAAW;AAAc;AAAY;AAAa;AAAa;AAAa;AAAa;AAAa;AAAc;AAAW;AAAc;AAAiB;AAAU;AAAgB;AACpe;AAAe;AAAY;AAAgB;AAAe;AAAa;AAAgB;AAAe;AAAiB;AAAc;AAAiB;AAAgB;AAAa;AAAc;AAAe;AAAiB;AAAgB;AAAY;AAAiB;AAAa;AAAoB;AAAqB;AAAiB;AAAc;AAAY;AAAa;AAAkB;AAAY;AAAW;AAAW;AAAa;AAAe;AAAW;AAAc;AAAc;AACnf;AAAe;AAAY;AACzB;AACA;AACA;AACF;AACE;AACA;AACA;AACA;AACA;AACA;AACE;AAEO;AACL;AACA;AAGA;AACF;AACF;AACF;AACE;AACA;AAKA;AACF;AACE;AACA;AAEI;AAGA;AACF;AAEF;AACA;AACE;AACE;AACA;AACA;AAEA;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACF;AACF;AACF;AACE;AAEF;AACF;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACF;AACA;AACE;AACF;AACA;AACE;AACF;AACA;AACE;AACA;AAGA;AACE;AACA;AAGF;AACA;AACF;AACA;AACE;AACA;AAGE;AACE;AACE;AACA;AACF;AACA;AACF;AAEJ;AACA;AACE;AAGA;AACA;AACA;AACA;AACE;AACA;AACE;AACA;AAGA;AAGM;AACA;AACA;AACF;AAGK;AACL;AACA;AACE;AACF;AACE;AAGA;AACF;AACA;AACA;AACE;AAGA;AACA;AACA;AACA;AACF;AACF;AAEJ;AACA;AAAQ;AAAsB;AAAoB;AACpD;AACA;AACF;AACA;AACE;AACE;AAGA;AACA;AACF;AACF;AACA;AACE;AAGA;AACF;AACA;AACE;AACA;AACA;AACF;AACA;AACE;AACF;AACA;AACE;AAGA;AACE;AACF;AAEA;AACF;AACA;AACE;AACE;AACF;AACE;AACF;AACA;AAGA;AACE;AAGA;AAGF;AAGA;AACF;AACA;AACE;AAGA;AACF;AACA;AACE;AACA;AAGA;AACF;AACA;AACE;AACA;AACA;AAEI;AAKA;AACF;AAEF;AACA;AACF;AACA;AACE;AACA;AACA;AACF;AACA;AACE;AACA;AACA;AACA;AACA;AACF;AACA;AACE;AACA;AACE;AACA;AACA;AACF;AACA;AACF;AACA;AACE;AAAc;AAAc;AAAe;AAAc;AAAa;AAAc;AAAyB;AAA+B;AAAW;AAAS;AAAa;AAC7K;AACA;AACF;AACA;AACE;AACF;AACA;AACE;AACA;AACF;AACA;AACE;AAA+E;AAAgE;AAAoB;AAAmC;AACxM;AACA;AACE;AACA;AACF;AACA;AACE;AAGA;AAGA;AACA;AAGA;AAA+E;AAAsB;AAAoB;AAC3H;AACA;AACE;AACE;AACA;AACF;AAEA;AAAuB;AAAa;AAAa;AAAS;AAAW;AAAW;AAAa;AAAmB;AAAmB;AAAmB;AACtJ;AACE;AAEF;AACE;AACF;AACA;AACF;AACA;AACE;AACA;AACA;AACF;AACA;AACE;AAII;AACE;AACF;AACE;AACF;AAGN;AACA;AAAa;AAAW;AAAa;AAAc;AAAY;AAAe;AAAkB;AAAmB;AAAkB;AAAwB;AAAoB;AAAoB;AACnM;AACA;AACE;AACA;AACA;AAEI;AACA;AACF;AAEJ;AACF;AAAG;AACD;AACA;AACA;AACE;AACF;AACA;AACE;AACF;AACA;AACE;AACF;AACA;AACE;AACF;AACA;AACE;AACF;AACA;AACE;AACF;AACF;AAAG;AACD;AACA;AACA;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACF;AACA;AACE;AACF;AACA;AACE;AACF;AACA;AACE;AACF;AACA;AACE;AACF;AACA;AACE;AACF;AACA;AACE;AACF;AACF;AAAG;AACD;AACA;AACA;AACA;AACF;AAAG;AACD;AACF;AAAG;AACD;AACF;AAAG;AACD;AACF;AAAG;AAAqB;AAA6D;AAAqB;AACxG;AACA;AACF;AAAG;AACD;AACF;AAAC;AAAG;AAAiD;AAAkD;AAAgD;AAAiE;AACtN;AACE;AACA;AACA;AACF;AACA;AACE;AACM;AAC8D;AAKtE;AACA;AACA;AACA;AACA;AACA;AAGF;AAAG;AACD;AAGA;AACA;AAGA;AACE;AACA;AACA;AACA;AAGA;AAGF;AACA;AAAmC;AAAmC;AAAwC;AAA4B;AAAW;AACrJ;AACA;AACA;AACA;AACA;AACF;AAAG;AACD;AACA;AAGA;AACA;AACA;AAEI;AACA;AACA;AACF;AAEF;AACA;AACA;AACA;AACF;AAAG;AACD;AACF;AAAG;AACD;AACA;AACA;AAGA;AAGA;AACA;AAGA;AAGA;AACF;AAAG;AACD;AACF;AAAG;AACD;AACF;AAAG;AACD;AACF;AAAG;AACD;AACA;AAEI;AAGA;AACA;AACE;AACF;AACE;AAGF;AACF;AAEJ;AAAG;AACD;AAGA;AACA;AAGA;AACA;AACA;AAGA;AAGA;AACF;AAAG;AACD;AACA;AACA;AACA;AACA;AACA;AAGA;AAGA;AACA;AACA;AAGA;AACA;AAGA;AACE;AACF;AAEA;AACE;AACA;AAGA;AAGA;AAGA;AAGA;AAGA;AACA;AACE;AACF;AACE;AACF;AACE;AACF;AACF;AACF;AAAG;AACD;AACA;AACA;AACA;AAGA;AAGA;AAGA;AACA;AACF;AAAG;AACD;AACA;AACF;AAAG;AACD;AACA;AAGA;AACA;AACA;AAGA;AAGA;AAGA;AACA;AACF;AAAG;AACD;AACA;AAGA;AAGA;AACF;AAAG;AACD;AACA;AACF;AAAG;AACD;AACF;AAAG;AACD;AACA;AAAsF;AAAsB;AAAe;AAC7H;AAAG;AACD;AAGA;AACA;AACF;AAAG;AACD;AAGA;AACE;AAAgD;AAAK;AAAQ;AAAO;AAAU;AAAQ;AAAS;AAC/F;AAGA;AACF;AACA;AACA;AAEO;AACL;AACA;AAA6F;AAAyD;AAAe;AACrK;AACA;AACF;AACA;AACA;AAEQ;AAC6B;AAGjC;AAGA;AACA;AACF;AAEF;AAGA;AACA;AAGA;AAA2T;AAAK;AAAK;AAAI;AAKzU;AACA;AACA;AAA+E;AAA+C;AAAoF;AAA0C;AAAa;AAAY;AAAoE;AAAe;AAAQ;AAChX;AACA;AACA;AACF;AAAG;AACD;AAGA;AACA;AACE;AACF;AACE;AACF;AACE;AACF;AACA;AACF;AAAG;AACD;AAGA;AAGA;AAGA;AACA;AACA;AACF;AAAG;AACD;AACA;AAGA;AAGA;AAGA;AAGA;AAGA;AACA;AAEO;AAGP;AACA;AACA;AACF;AAAG;AACD;AACA;AACA;AAGA;AAGA;AAGA;AAGA;AAGA;AACA;AACA;AAEO;AAGP;AACA;AACA;AACF;AAAG;AACD;AAGA;AAGA;AAGA;AAGA;AACF;AAAG;AACD;AACA;AACF;AAAG;AACD;AAGA;AACF;AAAG;AACD;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACF;AAAG;AACD;AACA;AACA;AACA;AACA;AACF;AAAG;AAAiC;AAClC;AACA;AAGA;AAGA;AACA;AAGA;AACF;AAAG;AACD;AACA;AACA;AAGF;AAAG;AACD;AACA;AACF;AAAG;AACD;AACA;AACE;AACA;AACE;AACA;AACE;AACF;AACE;AAGF;AACA;AACF;AACF;AACA;AACF;AAAG;AACD;AACA;AACA;AACA;AACA;AACA;AAAoG;AAClG;AACF;AAAG;AACD;AACF;AAAG;AACD;AACE;AACE;AACF;AACE;AACF;AACA;AAGA;AAGA;AACA;AACF;AACA;AACA;AACF;AAAG;AACD;AAEI;AACF;AACE;AACF;AAEF;AACA;AACF;AAAC;AACD;AACF;AAAG;AACD;AACE;AACA;AAGA;AACA;AACA;AAKE;AAIF;AACF;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACE;AACE;AACA;AACF;AACF;AACA;AACE;AACF;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACE;AACA;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACF;AACA;AACA;AACF;AACA;AAGA;AACA;AACA;AACF;AACA;AACE;AACA;AACF;AACA;AACE;AACA;AACF;AACF;AACA;AACE;AACA;AACA;AACF;AAGA;AACA;AACA;AACE;AACF;AACA;AACA;AAEI;AACA;AACF;AAEF;AACE;AACA;AACF;AACA;AACE;AACA;AACA;AAGA;AACA;AAAQ;AAAuB;AAAc;AAC/C;AACA;AACA;AACF;AAAC;AACD;AACE;AAGA;AACA;AACE;AAGA;AACF;AACA;AACF;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACF;AACA;AACE;AACA;AACA;AACA;AACF;AACE;AACA;AACF;AAAoC;AAAG;AAAI;AAAI;AAAI;AAAK;AAAK;AAAK;AAAK;AAAK;AAAK;AAAK;AAAG;AAAuC;AAAG;AAAI;AAAI;AAAI;AAAK;AAAK;AAAK;AAAK;AAAK;AAAK;AAAK;AAAG;AACnL;AACA;AAGA;AAEO;AAGP;AACF;AACE;AAGF;AACA;AACE;AACA;AAGA;AACA;AAEO;AAEA;AAGL;AAEF;AACA;AACA;AACA;AACA;AACA;AACF;AACA;AACE;AACE;AAAc;AAAiB;AAAoB;AAAU;AAAS;AAAuB;AAA2E;AAAoC;AAC5M;AAGA;AACA;AAGA;AACF;AACA;AACF;AACE;AACA;AACA;AACF;AACE;AACA;AACA;AACA;AACF;AACE;AACA;AACA;AACF;AACE;AACA;AACA;AACF;AACE;AACA;AACA;AAAQ;AAA2B;AAAoB;AAAkB;AAC3E;AAAuB;AAAO;AAAO;AAAO;AAAO;AAAO;AAAK;AAC7D;AACA;AACA;AACF;AACA;AACE;AACF;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACE;AACA;AAAmE;AAAc;AAAmH;AAAgB;AACpN;AACA;AACA;AACA;AACA;AACA;AACE;AACA;AACF;AACA;AACA;AACA;AACA;AACF;AACA;AACE;AACA;AACA;AACA;AACE;AACA;AACA;AAAgC;AAC9B;AACA;AACA;AAAwC;AAAa;AAA+B;AAAwD;AAA2C;AACvL;AACF;AAAG;AACD;AACF;AAAC;AACD;AACF;AACF;AACA;AAAuB;AAAgB;AAAoB;AAC3D;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AAKA;AACA;AACA;AACE;AAAc;AACZ;AACA;AACA;AACF;AAAG;AACD;AACA;AACA;AACA;AACF;AAAC;AACD;AACA;AACA;AACA;AAEI;AACA;AACF;AAEF;AACA;AACE;AACA;AACF;AACF;AACA;AACE;AACA;AACE;AACA;AACA;AAEI;AACA;AACA;AACA;AACA;AACF;AAEJ;AACA;AAGA;AAGS;AACL;AACE;AACA;AACF;AACE;AAGA;AACF;AACA;AACF;AAEF;AACE;AACF;AACE;AAGA;AACA;AAAqJ;AAAG;AAAI;AAA2G;AAA8L;AAErc;AACA;AACA;AACA;AACA;AACF;AACA;AACA;AACF;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACE;AACF;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACkI;AAChI;AACF;AAAG;AACD;AACA;AACE;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACA;AACE;AACA;AACA;AACA;AAGA;AACA;AAGA;AACA;AACA;AACA;AACA;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACE;AACA;AACA;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACE;AACA;AAAsG;AAAsB;AAAe;AAC3I;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACA;AACE;AACA;AACE;AACE;AACA;AAGA;AAGA;AACF;AACA;AAEA;AAEA;AAEA;AAEA;AACA;AAEF;AACA;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACA;AACE;AAGA;AACA;AAGA;AACA;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACA;AACE;AAGA;AACA;AAGA;AACA;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACA;AACA;AACE;AACA;AACA;AACA;AACA;AACE;AACA;AACE;AACA;AACF;AAEO;AACL;AACE;AACF;AACE;AAGA;AACF;AACA;AACA;AACF;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACF;AACA;AACA;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACA;AACE;AACA;AACE;AAEA;AACE;AAGA;AACE;AAA0D;AAAG;AAAI;AAAK;AAAI;AAAG;AAAG;AAAG;AAAG;AAAI;AAAI;AAAI;AAAG;AAAI;AAAI;AAAI;AAAI;AAAG;AAAG;AAAG;AAAG;AAAG;AAAG;AAAG;AAAG;AAAG;AAAG;AAAG;AAAG;AAAG;AAAG;AAAG;AAAC;AACnK;AACA;AACA;AACA;AACA;AACA;AAGF;AACA;AACF;AACA;AACA;AAEA;AACA;AACA;AACE;AAGA;AAKA;AACF;AACE;AAGA;AACA;AACF;AAEA;AACA;AAEA;AACE;AAGA;AACA;AACF;AAEA;AAEA;AAEF;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACA;AACA;AACE;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACA;AACE;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACA;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACA;AACA;AACE;AACA;AACA;AACA;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACA;AACA;AACA;AACE;AACA;AACA;AAGA;AACA;AACA;AACA;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACA;AACE;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACA;AACA;AACE;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACA;AACE;AACA;AACA;AAII;AAGF;AAEF;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACA;AACA;AACE;AACA;AACA;AACA;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACF;AAGA;AACE;AACA;AACA;AAA0H;AAAmD;AAAiD;AAChO;AACA;AACF;AACE;AAGA;AACF;AACF;AAAG;AAAwD;AACzD;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACF;AAAG;AACD;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACF;AAAG;AACD;AACA;AACA;AACA;AACA;AACE;AACA;AACA;AACA;AACA;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACA;AACA;AACA;AACE;AACA;AACE;AAGA;AACF;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACA;AACA;AACA;AACA;AACF;AAAG;AACD;AACA;AACA;AACA;AACA;AACA;AACA;AACE;AACA;AACF;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACF;AAAG;AACD;AAGA;AACA;AACF;AAAG;AACD;AACA;AACA;AACA;AACA;AACA;AACA;AACE;AAAuI;AAAK;AAAK;AAAK;AAAG;AACzJ;AACA;AACA;AACA;AACA;AACA;AACA;AACF;AACA;AACA;AACF;AAAG;AAAsC;AACvC;AACF;AAAG;AACD;AACF;AAAG;AACD;AACF;AAAG;AAA4C;AAA2D;AACxG;AACA;AACA;AACA;AAGA;AACE;AACA;AACA;AACA;AACE;AACA;AACE;AACA;AACA;AACA;AACF;AACE;AACF;AACA;AACF;AACA;AAGF;AACA;AACA;AACF;AAAG;AACD;AACA;AACA;AACA;AACA;AACA;AACF;AAAG;AACD;AACA;AACA;AAGE;AAEF;AAGA;AAGA;AACF;AAAG;AACD;AACA;AACA;AACA;AACE;AACA;AACA;AACA;AACF;AACA;AACF;AAAG;AACD;AACA;AACA;AACA;AACA;AACA;AAGA;AACA;AACF;AAAG;AAAgB;AACjB;AACE;AACA;AACA;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACA;AACA;AACA;AACE;AACE;AACA;AACA;AACE;AACA;AACA;AACA;AACE;AACA;AACF;AACA;AACA;AAGA;AACF;AACA;AACF;AACA;AACA;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACA;AACA;AACE;AAGA;AACA;AACA;AACA;AACA;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACE;AACA;AACF;AACE;AAGA;AACF;AACF;AAAG;AACD;AACA;AACA;AACA;AACE;AACE;AACA;AACA;AACE;AACA;AACA;AACA;AACE;AACA;AACF;AACA;AACA;AAGA;AACF;AACA;AACF;AACA;AACA;AACF;AACE;AAGA;AACF;AACF;AAAG;AAAyB;AAC1B;AACA;AACE;AACF;AACE;AAGA;AACF;AACF;AAAC;AACD;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACF;AACA;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AAGA;AACA;AACE;AACA;AACA;AACF;AACE;AACA;AAGE;AAEF;AACF;AACF;AACA;AACE;AACE;AACA;AACA;AACA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AAEI;AACA;AACF;AAEF;AACA;AACF;AACF;AACA;AAEO;AACL;AACA;AACA;AAKA;AACA;AACA;AACE;AACA;AACF;AACF;AACF;AACA;AACE;AACA;AACE;AACF;AACA;AACE;AACA;AACE;AACA;AAGA;AACF;AACF;AAEA;AACA;AACA;AACF;AACA;AAEE;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACF;AACA;AAA0C;AAAoB;AAAqC;AACnG;AAEI;AACE;AACE;AACF;AACF;AACE;AACF;AACF;AAEF;AACA;AACE;AACA;AACA;AACF;AACF;AACA;AACA;AACE;AACA;AACF;AACA;AACuF;AAAiB;AACpG;AACF;AAAC;AAKC;AACF;AACF;AAGA;AACE;AAGA;AACF;;AC/0FA;AAWA;AACE;AACE;AACA;AACF;AACF;AAEA;AACE;AACF;AAEA;AACE;AAEI;AACA;AACA;AACF;AAGJ;AAEA;AACE;AACE;AACA;AACF;AACF;AAEA;AACE;AACE;AACA;AACF;AACF;AAEA;AACE;AACA;AACF;AAEA;AACE;AACE;AACA;AACA;AACA;AACA;AACF;AAGA;AACA;AAEY;AAAqB;AAAW;AAG5C;AACA;AACA;AACA;AACF;AASA;AAGE;AAGA;AAGA;AAGA;AACF;AAEA;AAKE;AACA;AACA;AAGA;AACA;AACE;AACA;AACA;AACA;AACF;AACE;AACF;AACF;AAQA;AAGE;AAGA;AACF;AAEA;AAIE;AACA;AACA;AAGA;AACA;AACE;AACA;AACA;AACA;AAEA;AACA;AACF;AACE;AACF;AACF;AAYA;AACE;AAGA;AACF;AAEA;AAME;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACF;AAEA;AACE;AACA;AAGA;AAMA;AAEA;AACA;AACE;AACA;AAGA;AACA;AACF;AACF;AACE;AACF;AACF;AAEA;AACE;AACA;AACA;AACA;AACA;AAEO;AAEA;AAGL;AAEJ","file":"traceconv_bundle.js"};