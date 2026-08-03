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
	//#region ../../ui/src/base/assert.ts
	function assertTrue(x, msg) {
		if (!Boolean(x)) throw new Error(msg ?? "Failed assertion");
	}
	function ensureExists(x, msg) {
		if (x === null || x === void 0) throw new Error(msg ?? "Value is null or undefined");
		return x;
	}
	//#endregion
	//#region ui/tsc/gen/trace_processor_memory64.js
	var require_trace_processor_memory64 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
		async function trace_processor_memory64_wasm(moduleArg = {}) {
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
					if (2147483647 > $currentFirefoxVersion_currentSafariVersion$$) throw Error(`This page was compiled without support for Safari browser. Pass -sMIN_SAFARI_VERSION=${$currentFirefoxVersion_currentSafariVersion$$} or lower to enable support for this browser.`);
					if (2147483647 > $currentFirefoxVersion_currentSafariVersion$$) throw Error(`This emscripten-generated code requires Safari v214748.36.47 (detected v${$currentFirefoxVersion_currentSafariVersion$$})`);
					$currentFirefoxVersion_currentSafariVersion$$ = $currentChromeVersion_currentNodeVersion_userAgent$$.match(/Firefox\/(\d+(?:\.\d+)?)/) ? parseFloat($currentChromeVersion_currentNodeVersion_userAgent$$.match(/Firefox\/(\d+(?:\.\d+)?)/)[1]) : 2147483647;
					if (129 > $currentFirefoxVersion_currentSafariVersion$$) throw Error(`This emscripten-generated code requires Firefox v129 (detected v${$currentFirefoxVersion_currentSafariVersion$$})`);
					$currentChromeVersion_currentNodeVersion_userAgent$$ = $currentChromeVersion_currentNodeVersion_userAgent$$.match(/Chrome\/(\d+(?:\.\d+)?)/) ? parseFloat($currentChromeVersion_currentNodeVersion_userAgent$$.match(/Chrome\/(\d+(?:\.\d+)?)/)[1]) : 2147483647;
					if (128 > $currentChromeVersion_currentNodeVersion_userAgent$$) throw Error(`This emscripten-generated code requires Chrome v128 (detected v${$currentChromeVersion_currentNodeVersion_userAgent$$})`);
				}
			})();
			var $Module$$ = moduleArg, $ENVIRONMENT_IS_WEB$$ = !!globalThis.window, $ENVIRONMENT_IS_WORKER$$ = !!globalThis.WorkerGlobalScope, $ENVIRONMENT_IS_NODE$$ = globalThis.$g$?.$versions$?.node && "renderer" != globalThis.$g$?.type, $ENVIRONMENT_IS_SHELL$$ = !$ENVIRONMENT_IS_WEB$$ && !$ENVIRONMENT_IS_NODE$$ && !$ENVIRONMENT_IS_WORKER$$, $arguments_$$ = [], $thisProgram$$ = "./this.program", $_scriptName$$;
			$ENVIRONMENT_IS_WORKER$$ && ($_scriptName$$ = self.location.href);
			var $scriptDirectory$$ = "", $readAsync$$, $readBinary$$;
			if (!$ENVIRONMENT_IS_SHELL$$) if ($ENVIRONMENT_IS_WEB$$ || $ENVIRONMENT_IS_WORKER$$) {
				try {
					$scriptDirectory$$ = new URL(".", $_scriptName$$).href;
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
			$assert$$(!$ENVIRONMENT_IS_WEB$$, "web environment detected but not enabled at build time.  Add `web` to `-sENVIRONMENT` to enable.");
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
				$HEAPU32$$[$max$$ / 4] = 34821223;
				$HEAPU32$$[($max$$ + 4) / 4] = 2310721022;
				$HEAPU32$$[0] = 1668509029;
			}
			function $checkStackCookie$$() {
				if (!$ABORT$$) {
					var $max$jscomp$1$$ = $_emscripten_stack_get_end$$();
					0 == $max$jscomp$1$$ && ($max$jscomp$1$$ += 4);
					var $cookie1$$ = $HEAPU32$$[$max$jscomp$1$$ / 4], $cookie2$$ = $HEAPU32$$[($max$jscomp$1$$ + 4) / 4];
					34821223 == $cookie1$$ && 2310721022 == $cookie2$$ || $abort$$(`Stack overflow! Stack cookie has been overwritten at ${$ptrToString$$($max$jscomp$1$$)}, expected hex dwords 0x89BACDFE and 0x2135467, but received ${$ptrToString$$($cookie2$$)} ${$ptrToString$$($cookie1$$)}`);
					1668509029 != $HEAPU32$$[0] && $abort$$("Runtime error: The application has corrupted its heap memory area (address zero)!");
				}
			}
			var $h16$jscomp$inline_12$$ = /* @__PURE__ */ new Int16Array(1), $h8$jscomp$inline_13$$ = new Int8Array($h16$jscomp$inline_12$$.buffer);
			$h16$jscomp$inline_12$$[0] = 25459;
			115 === $h8$jscomp$inline_13$$[0] && 99 === $h8$jscomp$inline_13$$[1] || $abort$$("Runtime error: expected the system to be little-endian! (Run with -sSUPPORT_BIG_ENDIAN to bypass)");
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
			var $readyPromiseResolve$$, $readyPromiseReject$$, $HEAP8$$, $HEAPU8$$, $HEAP16$$, $HEAP32$$, $HEAPU32$$, $HEAPF64$$, $HEAP64$$, $HEAPU64$$, $runtimeInitialized$$ = !1;
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
				$HEAPU64$$ = new BigUint64Array($b$jscomp$1$$);
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
			function $FS$error$$() {
				$abort$$("Filesystem support (FS) was not included. The problem is that you are using files from JS, but files were not used from C/C++, so filesystem support was not auto-included. You can force-include filesystem support with -sFORCE_FILESYSTEM");
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
				0 > $ptr$$ && ($ptr$$ = 18446744073709551616n + BigInt($ptr$$));
				return "0x" + $ptr$$.toString(16).padStart(16, "0");
			}, $warnOnce$$ = ($text$jscomp$13$$) => {
				$warnOnce$$.$shown$ || ($warnOnce$$.$shown$ = {});
				$warnOnce$$.$shown$[$text$jscomp$13$$] || ($warnOnce$$.$shown$[$text$jscomp$13$$] = 1, $err$$($text$jscomp$13$$));
			}, $UTF8Decoder$$ = globalThis.TextDecoder && new TextDecoder(), $UTF8ArrayToString$$ = ($heapOrArray$jscomp$1$$, $idx$jscomp$1$$ = 0, $maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_21_str$jscomp$7$$) => {
				var $endPtr_idx$jscomp$inline_18$$ = $idx$jscomp$1$$;
				for ($maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_21_str$jscomp$7$$ = $endPtr_idx$jscomp$inline_18$$ + $maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_21_str$jscomp$7$$; $heapOrArray$jscomp$1$$[$endPtr_idx$jscomp$inline_18$$] && !($endPtr_idx$jscomp$inline_18$$ >= $maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_21_str$jscomp$7$$);) ++$endPtr_idx$jscomp$inline_18$$;
				if (16 < $endPtr_idx$jscomp$inline_18$$ - $idx$jscomp$1$$ && $heapOrArray$jscomp$1$$.buffer && $UTF8Decoder$$) return $UTF8Decoder$$.decode($heapOrArray$jscomp$1$$.subarray($idx$jscomp$1$$, $endPtr_idx$jscomp$inline_18$$));
				for ($maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_21_str$jscomp$7$$ = ""; $idx$jscomp$1$$ < $endPtr_idx$jscomp$inline_18$$;) {
					var $ch_u0$$ = $heapOrArray$jscomp$1$$[$idx$jscomp$1$$++];
					if ($ch_u0$$ & 128) {
						var $u1$$ = $heapOrArray$jscomp$1$$[$idx$jscomp$1$$++] & 63;
						if (192 == ($ch_u0$$ & 224)) $maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_21_str$jscomp$7$$ += String.fromCharCode(($ch_u0$$ & 31) << 6 | $u1$$);
						else {
							var $u2$$ = $heapOrArray$jscomp$1$$[$idx$jscomp$1$$++] & 63;
							224 == ($ch_u0$$ & 240) ? $ch_u0$$ = ($ch_u0$$ & 15) << 12 | $u1$$ << 6 | $u2$$ : (240 != ($ch_u0$$ & 248) && $warnOnce$$("Invalid UTF-8 leading byte " + $ptrToString$$($ch_u0$$) + " encountered when deserializing a UTF-8 string in wasm memory to a JS string!"), $ch_u0$$ = ($ch_u0$$ & 7) << 18 | $u1$$ << 12 | $u2$$ << 6 | $heapOrArray$jscomp$1$$[$idx$jscomp$1$$++] & 63);
							65536 > $ch_u0$$ ? $maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_21_str$jscomp$7$$ += String.fromCharCode($ch_u0$$) : ($ch_u0$$ -= 65536, $maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_21_str$jscomp$7$$ += String.fromCharCode(55296 | $ch_u0$$ >> 10, 56320 | $ch_u0$$ & 1023));
						}
					} else $maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_21_str$jscomp$7$$ += String.fromCharCode($ch_u0$$);
				}
				return $maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_21_str$jscomp$7$$;
			}, $UTF8ToString$$ = ($ptr$jscomp$1$$, $maxBytesToRead$jscomp$2$$) => {
				$assert$$("number" == typeof $ptr$jscomp$1$$, `UTF8ToString expects a number (got ${typeof $ptr$jscomp$1$$})`);
				return $ptr$jscomp$1$$ ? $UTF8ArrayToString$$($HEAPU8$$, $ptr$jscomp$1$$, $maxBytesToRead$jscomp$2$$) : "";
			}, $bigintToI53Checked$$ = ($num$jscomp$6$$) => -9007199254740992 > $num$jscomp$6$$ || 9007199254740992 < $num$jscomp$6$$ ? NaN : Number($num$jscomp$6$$), $MONTH_DAYS_LEAP_CUMULATIVE$$ = [
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
			], $stringToUTF8$$ = ($JSCompiler_inline_result$jscomp$2_str$jscomp$9$$, $outIdx$jscomp$inline_24_outPtr$$, $endIdx$jscomp$inline_28_maxBytesToWrite$jscomp$1$$) => {
				$assert$$("number" == typeof $endIdx$jscomp$inline_28_maxBytesToWrite$jscomp$1$$, "stringToUTF8(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!");
				var $heap$jscomp$inline_26$$ = $HEAPU8$$;
				$assert$$("string" === typeof $JSCompiler_inline_result$jscomp$2_str$jscomp$9$$, `stringToUTF8Array expects a string (got ${typeof $JSCompiler_inline_result$jscomp$2_str$jscomp$9$$})`);
				if (0 < $endIdx$jscomp$inline_28_maxBytesToWrite$jscomp$1$$) {
					var $startIdx$jscomp$inline_27$$ = $outIdx$jscomp$inline_24_outPtr$$;
					$endIdx$jscomp$inline_28_maxBytesToWrite$jscomp$1$$ = $outIdx$jscomp$inline_24_outPtr$$ + $endIdx$jscomp$inline_28_maxBytesToWrite$jscomp$1$$ - 1;
					for (var $i$jscomp$inline_29$$ = 0; $i$jscomp$inline_29$$ < $JSCompiler_inline_result$jscomp$2_str$jscomp$9$$.length; ++$i$jscomp$inline_29$$) {
						var $u$jscomp$inline_30$$ = $JSCompiler_inline_result$jscomp$2_str$jscomp$9$$.codePointAt($i$jscomp$inline_29$$);
						if (127 >= $u$jscomp$inline_30$$) {
							if ($outIdx$jscomp$inline_24_outPtr$$ >= $endIdx$jscomp$inline_28_maxBytesToWrite$jscomp$1$$) break;
							$heap$jscomp$inline_26$$[$outIdx$jscomp$inline_24_outPtr$$++] = $u$jscomp$inline_30$$;
						} else if (2047 >= $u$jscomp$inline_30$$) {
							if ($outIdx$jscomp$inline_24_outPtr$$ + 1 >= $endIdx$jscomp$inline_28_maxBytesToWrite$jscomp$1$$) break;
							$heap$jscomp$inline_26$$[$outIdx$jscomp$inline_24_outPtr$$++] = 192 | $u$jscomp$inline_30$$ >> 6;
							$heap$jscomp$inline_26$$[$outIdx$jscomp$inline_24_outPtr$$++] = 128 | $u$jscomp$inline_30$$ & 63;
						} else if (65535 >= $u$jscomp$inline_30$$) {
							if ($outIdx$jscomp$inline_24_outPtr$$ + 2 >= $endIdx$jscomp$inline_28_maxBytesToWrite$jscomp$1$$) break;
							$heap$jscomp$inline_26$$[$outIdx$jscomp$inline_24_outPtr$$++] = 224 | $u$jscomp$inline_30$$ >> 12;
							$heap$jscomp$inline_26$$[$outIdx$jscomp$inline_24_outPtr$$++] = 128 | $u$jscomp$inline_30$$ >> 6 & 63;
							$heap$jscomp$inline_26$$[$outIdx$jscomp$inline_24_outPtr$$++] = 128 | $u$jscomp$inline_30$$ & 63;
						} else {
							if ($outIdx$jscomp$inline_24_outPtr$$ + 3 >= $endIdx$jscomp$inline_28_maxBytesToWrite$jscomp$1$$) break;
							1114111 < $u$jscomp$inline_30$$ && $warnOnce$$("Invalid Unicode code point " + $ptrToString$$($u$jscomp$inline_30$$) + " encountered when serializing a JS string to a UTF-8 string in wasm memory! (Valid unicode code points should be in range 0-0x10FFFF).");
							$heap$jscomp$inline_26$$[$outIdx$jscomp$inline_24_outPtr$$++] = 240 | $u$jscomp$inline_30$$ >> 18;
							$heap$jscomp$inline_26$$[$outIdx$jscomp$inline_24_outPtr$$++] = 128 | $u$jscomp$inline_30$$ >> 12 & 63;
							$heap$jscomp$inline_26$$[$outIdx$jscomp$inline_24_outPtr$$++] = 128 | $u$jscomp$inline_30$$ >> 6 & 63;
							$heap$jscomp$inline_26$$[$outIdx$jscomp$inline_24_outPtr$$++] = 128 | $u$jscomp$inline_30$$ & 63;
							$i$jscomp$inline_29$$++;
						}
					}
					$heap$jscomp$inline_26$$[$outIdx$jscomp$inline_24_outPtr$$] = 0;
					$JSCompiler_inline_result$jscomp$2_str$jscomp$9$$ = $outIdx$jscomp$inline_24_outPtr$$ - $startIdx$jscomp$inline_27$$;
				} else $JSCompiler_inline_result$jscomp$2_str$jscomp$9$$ = 0;
				return $JSCompiler_inline_result$jscomp$2_str$jscomp$9$$;
			}, $lengthBytesUTF8$$ = ($str$jscomp$10$$) => {
				for (var $len$jscomp$2$$ = 0, $i$jscomp$5$$ = 0; $i$jscomp$5$$ < $str$jscomp$10$$.length; ++$i$jscomp$5$$) {
					var $c$$ = $str$jscomp$10$$.charCodeAt($i$jscomp$5$$);
					127 >= $c$$ ? $len$jscomp$2$$++ : 2047 >= $c$$ ? $len$jscomp$2$$ += 2 : 55296 <= $c$$ && 57343 >= $c$$ ? ($len$jscomp$2$$ += 4, ++$i$jscomp$5$$) : $len$jscomp$2$$ += 3;
				}
				return $len$jscomp$2$$;
			}, $readEmAsmArgsArray$$ = [], $UNWIND_CACHE$$ = {}, $convertFrameToPC$$ = ($frame$jscomp$1$$) => {
				var $match$$;
				if ($match$$ = /\bwasm-function\[\d+\]:(0x[0-9a-f]+)/.exec($frame$jscomp$1$$)) return +$match$$[1];
				if (/\bwasm-function\[(\d+)\]:(\d+)/.exec($frame$jscomp$1$$)) $warnOnce$$("legacy backtrace format detected, this version of v8 is no longer supported by the emscripten backtrace mechanism");
				else if ($match$$ = /:(\d+):\d+(?:\)|$)/.exec($frame$jscomp$1$$)) return 2147483648 | +$match$$[1];
				return 0;
			}, $saveInUnwindCache$$ = ($callstack_pc$$) => {
				for (var $line$jscomp$7$$ of $callstack_pc$$) ($callstack_pc$$ = $convertFrameToPC$$($line$jscomp$7$$)) && ($UNWIND_CACHE$$[$callstack_pc$$] = $line$jscomp$7$$);
			};
			function $_emscripten_pc_get_function$$($pc$jscomp$1$$) {
				$pc$jscomp$1$$ = $bigintToI53Checked$$($pc$jscomp$1$$);
				var $ret$jscomp$4$$ = (() => {
					var $JSCompiler_temp_const$jscomp$4_frame$jscomp$2$$ = $UNWIND_CACHE$$[$pc$jscomp$1$$];
					if (!$JSCompiler_temp_const$jscomp$4_frame$jscomp$2$$) return 0;
					var $match$jscomp$1_name$jscomp$77_str$jscomp$inline_32$$;
					if ($match$jscomp$1_name$jscomp$77_str$jscomp$inline_32$$ = /^\s+at .*\.wasm\.(.*) \(.*\)$/.exec($JSCompiler_temp_const$jscomp$4_frame$jscomp$2$$)) $match$jscomp$1_name$jscomp$77_str$jscomp$inline_32$$ = $match$jscomp$1_name$jscomp$77_str$jscomp$inline_32$$[1];
					else if ($match$jscomp$1_name$jscomp$77_str$jscomp$inline_32$$ = /^\s+at (.*) \(.*\)$/.exec($JSCompiler_temp_const$jscomp$4_frame$jscomp$2$$)) $match$jscomp$1_name$jscomp$77_str$jscomp$inline_32$$ = $match$jscomp$1_name$jscomp$77_str$jscomp$inline_32$$[1];
					else if ($match$jscomp$1_name$jscomp$77_str$jscomp$inline_32$$ = /^(.+?)@/.exec($JSCompiler_temp_const$jscomp$4_frame$jscomp$2$$)) $match$jscomp$1_name$jscomp$77_str$jscomp$inline_32$$ = $match$jscomp$1_name$jscomp$77_str$jscomp$inline_32$$[1];
					else return 0;
					$_free$$($_emscripten_pc_get_function$$.$ret$ ?? 0);
					$JSCompiler_temp_const$jscomp$4_frame$jscomp$2$$ = $_emscripten_pc_get_function$$;
					var $size$jscomp$inline_33$$ = $lengthBytesUTF8$$($match$jscomp$1_name$jscomp$77_str$jscomp$inline_32$$) + 1, $ret$jscomp$inline_34$$ = $_malloc$$($size$jscomp$inline_33$$);
					$ret$jscomp$inline_34$$ && $stringToUTF8$$($match$jscomp$1_name$jscomp$77_str$jscomp$inline_32$$, $ret$jscomp$inline_34$$, $size$jscomp$inline_33$$);
					$JSCompiler_temp_const$jscomp$4_frame$jscomp$2$$.$ret$ = $ret$jscomp$inline_34$$;
					return $_emscripten_pc_get_function$$.$ret$;
				})();
				return BigInt($ret$jscomp$4$$);
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
			}, $printCharBuffers$$ = [
				null,
				[],
				[]
			], $printChar$$ = ($stream$jscomp$4$$, $curr$$) => {
				var $buffer$jscomp$19$$ = $printCharBuffers$$[$stream$jscomp$4$$];
				$assert$$($buffer$jscomp$19$$);
				0 === $curr$$ || 10 === $curr$$ ? ((1 === $stream$jscomp$4$$ ? $out$$ : $err$$)($UTF8ArrayToString$$($buffer$jscomp$19$$)), $buffer$jscomp$19$$.length = 0) : $buffer$jscomp$19$$.push($curr$$);
			}, $stringToUTF8OnStack$$ = ($str$jscomp$14$$) => {
				var $size$jscomp$25$$ = $lengthBytesUTF8$$($str$jscomp$14$$) + 1, $ret$jscomp$5$$ = $__emscripten_stack_alloc$$($size$jscomp$25$$);
				$stringToUTF8$$($str$jscomp$14$$, $ret$jscomp$5$$, $size$jscomp$25$$);
				return $ret$jscomp$5$$;
			}, $getCFunc$$ = ($ident$jscomp$1$$) => {
				var $func$jscomp$7$$ = $Module$$["_" + $ident$jscomp$1$$];
				$assert$$($func$jscomp$7$$, "Cannot call unknown function " + $ident$jscomp$1$$ + ", make sure it is exported");
				return $func$jscomp$7$$;
			}, $wasmTableMirror$$ = [], $functionsInTableMap$$, $freeTableIndexes$$ = [], $uleb128EncodeWithLen$$ = ($arr$jscomp$3$$) => {
				const $n$jscomp$4$$ = $arr$jscomp$3$$.length;
				$assert$$(16384 > $n$jscomp$4$$);
				return [
					$n$jscomp$4$$ % 128 | 128,
					$n$jscomp$4$$ >> 7,
					...$arr$jscomp$3$$
				];
			}, $wasmTypeCodes$$ = {
				i: 127,
				p: 126,
				j: 126,
				f: 125,
				d: 124,
				e: 111
			}, $generateTypePack$$ = ($types$$) => $uleb128EncodeWithLen$$(Array.from($types$$, ($type$jscomp$167$$) => {
				var $code$jscomp$5$$ = $wasmTypeCodes$$[$type$jscomp$167$$];
				$assert$$($code$jscomp$5$$, `invalid signature char: ${$type$jscomp$167$$}`);
				return $code$jscomp$5$$;
			}));
			$Module$$.noExitRuntime && ($noExitRuntime$$ = $Module$$.noExitRuntime);
			$Module$$.print && ($out$$ = $Module$$.print);
			$Module$$.printErr && ($err$$ = $Module$$.printErr);
			$Module$$.wasmBinary && ($wasmBinary$$ = $Module$$.wasmBinary);
			$Module$$.FS_createDataFile = function() {
				$FS$error$$();
			};
			$Module$$.FS_createPreloadedFile = function() {
				$FS$error$$();
			};
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
			$Module$$.ccall = ($func$jscomp$8_ident$jscomp$2$$, $returnType$$, $argTypes_ret$jscomp$6$$, $args$jscomp$5$$) => {
				var $toC$$ = {
					pointer: ($p$$) => BigInt($p$$),
					string: ($str$jscomp$15$$) => {
						var $ret$jscomp$7$$ = 0;
						null !== $str$jscomp$15$$ && void 0 !== $str$jscomp$15$$ && 0 !== $str$jscomp$15$$ && ($ret$jscomp$7$$ = $stringToUTF8OnStack$$($str$jscomp$15$$));
						return BigInt($ret$jscomp$7$$);
					},
					array: ($arr$jscomp$2$$) => {
						var $ret$jscomp$8$$ = $__emscripten_stack_alloc$$($arr$jscomp$2$$.length);
						$assert$$(0 <= $arr$jscomp$2$$.length, "writeArrayToMemory array must have a length (should be an array or typed array)");
						$HEAP8$$.set($arr$jscomp$2$$, $ret$jscomp$8$$);
						return BigInt($ret$jscomp$8$$);
					}
				};
				$func$jscomp$8_ident$jscomp$2$$ = $getCFunc$$($func$jscomp$8_ident$jscomp$2$$);
				var $cArgs$$ = [], $stack$jscomp$1$$ = 0;
				$assert$$("array" !== $returnType$$, "Return type should not be \"array\".");
				if ($args$jscomp$5$$) for (var $i$jscomp$8$$ = 0; $i$jscomp$8$$ < $args$jscomp$5$$.length; $i$jscomp$8$$++) {
					var $converter$$ = $toC$$[$argTypes_ret$jscomp$6$$[$i$jscomp$8$$]];
					$converter$$ ? (0 === $stack$jscomp$1$$ && ($stack$jscomp$1$$ = $_emscripten_stack_get_current$$()), $cArgs$$[$i$jscomp$8$$] = $converter$$($args$jscomp$5$$[$i$jscomp$8$$])) : $cArgs$$[$i$jscomp$8$$] = $args$jscomp$5$$[$i$jscomp$8$$];
				}
				$argTypes_ret$jscomp$6$$ = $func$jscomp$8_ident$jscomp$2$$(...$cArgs$$);
				return $argTypes_ret$jscomp$6$$ = function($ret$jscomp$10$$) {
					0 !== $stack$jscomp$1$$ && $__emscripten_stack_restore$$($stack$jscomp$1$$);
					return "string" === $returnType$$ ? $UTF8ToString$$(Number($ret$jscomp$10$$)) : "pointer" === $returnType$$ ? Number($ret$jscomp$10$$) : "boolean" === $returnType$$ ? !!$ret$jscomp$10$$ : $ret$jscomp$10$$;
				}($argTypes_ret$jscomp$6$$);
			};
			$Module$$.addFunction = ($func$jscomp$13$$, $bytes$jscomp$inline_57_module$jscomp$inline_58_sig$jscomp$1_wrapped$$) => {
				$assert$$("undefined" != typeof $func$jscomp$13$$);
				if (!$functionsInTableMap$$) {
					$functionsInTableMap$$ = /* @__PURE__ */ new WeakMap();
					var $count$jscomp$inline_91_idx$jscomp$inline_52_idx$jscomp$inline_60_rtn$$ = Number($wasmTable$$.length);
					if ($functionsInTableMap$$) for (var $i$jscomp$inline_92$$ = 0; $i$jscomp$inline_92$$ < 0 + $count$jscomp$inline_91_idx$jscomp$inline_52_idx$jscomp$inline_60_rtn$$; $i$jscomp$inline_92$$++) {
						var $funcPtr$jscomp$inline_108_item$jscomp$inline_93$$ = $i$jscomp$inline_92$$;
						$funcPtr$jscomp$inline_108_item$jscomp$inline_93$$ = Number($funcPtr$jscomp$inline_108_item$jscomp$inline_93$$);
						var $func$jscomp$inline_109$$ = $wasmTableMirror$$[$funcPtr$jscomp$inline_108_item$jscomp$inline_93$$];
						$func$jscomp$inline_109$$ || ($wasmTableMirror$$[$funcPtr$jscomp$inline_108_item$jscomp$inline_93$$] = $func$jscomp$inline_109$$ = $wasmTable$$.get(BigInt($funcPtr$jscomp$inline_108_item$jscomp$inline_93$$)));
						$assert$$($wasmTable$$.get(BigInt($funcPtr$jscomp$inline_108_item$jscomp$inline_93$$)) == $func$jscomp$inline_109$$, "JavaScript-side Wasm function table mirror is out of date!");
						($funcPtr$jscomp$inline_108_item$jscomp$inline_93$$ = $func$jscomp$inline_109$$) && $functionsInTableMap$$.set($funcPtr$jscomp$inline_108_item$jscomp$inline_93$$, $i$jscomp$inline_92$$);
					}
				}
				if ($count$jscomp$inline_91_idx$jscomp$inline_52_idx$jscomp$inline_60_rtn$$ = $functionsInTableMap$$.get($func$jscomp$13$$) || 0) return $count$jscomp$inline_91_idx$jscomp$inline_52_idx$jscomp$inline_60_rtn$$;
				a: if ($freeTableIndexes$$.length) var $ret$jscomp$11$$ = $freeTableIndexes$$.pop();
				else {
					try {
						$ret$jscomp$11$$ = $wasmTable$$.grow(1n);
						break a;
					} catch ($err$jscomp$inline_50$$) {
						if (!($err$jscomp$inline_50$$ instanceof RangeError)) throw $err$jscomp$inline_50$$;
						$abort$$("Unable to grow wasm table. Set ALLOW_TABLE_GROWTH.");
					}
					$ret$jscomp$11$$ = void 0;
				}
				try {
					$count$jscomp$inline_91_idx$jscomp$inline_52_idx$jscomp$inline_60_rtn$$ = $ret$jscomp$11$$, $wasmTable$$.set(BigInt($count$jscomp$inline_91_idx$jscomp$inline_52_idx$jscomp$inline_60_rtn$$), $func$jscomp$13$$), $wasmTableMirror$$[$count$jscomp$inline_91_idx$jscomp$inline_52_idx$jscomp$inline_60_rtn$$] = $wasmTable$$.get(BigInt($count$jscomp$inline_91_idx$jscomp$inline_52_idx$jscomp$inline_60_rtn$$));
				} catch ($err$jscomp$5$$) {
					if (!($err$jscomp$5$$ instanceof TypeError)) throw $err$jscomp$5$$;
					$assert$$("undefined" != typeof $bytes$jscomp$inline_57_module$jscomp$inline_58_sig$jscomp$1_wrapped$$, "Missing signature argument to addFunction: " + $func$jscomp$13$$);
					$bytes$jscomp$inline_57_module$jscomp$inline_58_sig$jscomp$1_wrapped$$ = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1, ...$uleb128EncodeWithLen$$([
						1,
						96,
						...$generateTypePack$$($bytes$jscomp$inline_57_module$jscomp$inline_58_sig$jscomp$1_wrapped$$.slice(1)),
						...$generateTypePack$$("v" === $bytes$jscomp$inline_57_module$jscomp$inline_58_sig$jscomp$1_wrapped$$[0] ? "" : $bytes$jscomp$inline_57_module$jscomp$inline_58_sig$jscomp$1_wrapped$$[0])
					]), 2, 7, 1, 1, 101, 1, 102, 0, 0, 7, 5, 1, 1, 102, 0, 0);
					$bytes$jscomp$inline_57_module$jscomp$inline_58_sig$jscomp$1_wrapped$$ = new WebAssembly.Module($bytes$jscomp$inline_57_module$jscomp$inline_58_sig$jscomp$1_wrapped$$);
					$bytes$jscomp$inline_57_module$jscomp$inline_58_sig$jscomp$1_wrapped$$ = new WebAssembly.Instance($bytes$jscomp$inline_57_module$jscomp$inline_58_sig$jscomp$1_wrapped$$, { e: { f: $func$jscomp$13$$ } }).exports.f;
					$count$jscomp$inline_91_idx$jscomp$inline_52_idx$jscomp$inline_60_rtn$$ = $ret$jscomp$11$$;
					$wasmTable$$.set(BigInt($count$jscomp$inline_91_idx$jscomp$inline_52_idx$jscomp$inline_60_rtn$$), $bytes$jscomp$inline_57_module$jscomp$inline_58_sig$jscomp$1_wrapped$$);
					$wasmTableMirror$$[$count$jscomp$inline_91_idx$jscomp$inline_52_idx$jscomp$inline_60_rtn$$] = $wasmTable$$.get(BigInt($count$jscomp$inline_91_idx$jscomp$inline_52_idx$jscomp$inline_60_rtn$$));
				}
				$functionsInTableMap$$.set($func$jscomp$13$$, $ret$jscomp$11$$);
				return $ret$jscomp$11$$;
			};
			"writeI53ToI64 writeI53ToI64Clamped writeI53ToI64Signaling writeI53ToU64Clamped writeI53ToU64Signaling readI53FromI64 readI53FromU64 convertI32PairToI53 convertI32PairToI53Checked convertU32PairToI53 getTempRet0 setTempRet0 createNamedFunction zeroMemory withStackSave strError inetPton4 inetNtop4 inetPton6 inetNtop6 readSockaddr writeSockaddr runMainThreadEmAsm jstoi_q autoResumeAudioContext getDynCaller dynCall runtimeKeepalivePush runtimeKeepalivePop callUserCallback maybeExit asyncLoad asmjsMangle mmapAlloc HandleAllocator getUniqueRunDependency addRunDependency removeRunDependency addOnInit addOnPostCtor addOnPreMain addOnExit STACK_SIZE STACK_ALIGN POINTER_SIZE ASSERTIONS cwrap removeFunction intArrayFromString intArrayToString AsciiToString stringToAscii UTF16ToString stringToUTF16 lengthBytesUTF16 UTF32ToString stringToUTF32 lengthBytesUTF32 registerKeyEventCallback maybeCStringToJsString findEventTarget getBoundingClientRect fillMouseEventData registerMouseEventCallback registerWheelEventCallback registerUiEventCallback registerFocusEventCallback fillDeviceOrientationEventData registerDeviceOrientationEventCallback fillDeviceMotionEventData registerDeviceMotionEventCallback screenOrientation fillOrientationChangeEventData registerOrientationChangeEventCallback fillFullscreenChangeEventData registerFullscreenChangeEventCallback JSEvents_requestFullscreen JSEvents_resizeCanvasForFullscreen registerRestoreOldStyle hideEverythingExceptGivenElement restoreHiddenElements setLetterbox softFullscreenResizeWebGLRenderTarget doRequestFullscreen fillPointerlockChangeEventData registerPointerlockChangeEventCallback registerPointerlockErrorEventCallback requestPointerLock fillVisibilityChangeEventData registerVisibilityChangeEventCallback registerTouchEventCallback fillGamepadEventData registerGamepadEventCallback registerBeforeUnloadEventCallback fillBatteryEventData registerBatteryEventCallback setCanvasElementSize getCanvasElementSize getCallstack convertPCtoSourceLocation wasiRightsToMuslOFlags wasiOFlagsToMuslOFlags initRandomFill randomFill safeSetTimeout setImmediateWrapped safeRequestAnimationFrame clearImmediateWrapped registerPostMainLoop registerPreMainLoop getPromise makePromise idsToPromises makePromiseCallback ExceptionInfo findMatchingCatch Browser_asyncPrepareDataCounter arraySum addDays getSocketFromFD getSocketAddress heapObjectForWebGLType toTypedArrayIndex webgl_enable_ANGLE_instanced_arrays webgl_enable_OES_vertex_array_object webgl_enable_WEBGL_draw_buffers webgl_enable_WEBGL_multi_draw webgl_enable_EXT_polygon_offset_clamp webgl_enable_EXT_clip_control webgl_enable_WEBGL_polygon_mode emscriptenWebGLGet computeUnpackAlignedImageSize colorChannelsInGlTextureFormat emscriptenWebGLGetTexPixelData emscriptenWebGLGetUniform webglGetUniformLocation webglPrepareUniformLocationsBeforeFirstUse webglGetLeftBracePos emscriptenWebGLGetVertexAttrib __glGetActiveAttribOrUniform writeGLArray registerWebGlEventCallback runAndAbortIfError ALLOC_NORMAL ALLOC_STACK allocate writeStringToMemory writeAsciiToMemory allocateUTF8 allocateUTF8OnStack demangle stackTrace getNativeTypeSize".split(" ").forEach(function($sym$jscomp$2$$) {
				$unexportedRuntimeSymbol$$($sym$jscomp$2$$);
			});
			"run out err abort wasmExports HEAPF32 HEAPF64 HEAP8 HEAP16 HEAPU16 HEAP32 HEAPU32 HEAP64 HEAPU64 writeStackCookie checkStackCookie INT53_MAX INT53_MIN bigintToI53Checked stackSave stackRestore stackAlloc ptrToString exitJS getHeapMax growMemory ENV ERRNO_CODES DNS Protocols Sockets timers warnOnce readEmAsmArgsArray readEmAsmArgs runEmAsmFunction getExecutableName handleException keepRuntimeAlive alignMemory wasmTable wasmMemory noExitRuntime addOnPreRun addOnPostRun convertJsFunctionToWasm freeTableIndexes functionsInTableMap getEmptyTableSlot updateTableMap getFunctionAddress setValue getValue PATH PATH_FS UTF8Decoder UTF8ArrayToString UTF8ToString stringToUTF8Array stringToUTF8 lengthBytesUTF8 UTF16Decoder stringToNewUTF8 stringToUTF8OnStack writeArrayToMemory JSEvents specialHTMLTargets findCanvasEventTarget currentFullscreenStrategy restoreOldWindowedStyle jsStackTrace UNWIND_CACHE ExitStatus getEnvStrings checkWasiClock flush_NO_FILESYSTEM emSetImmediate emClearImmediate_deps emClearImmediate promiseMap uncaughtExceptionCount exceptionLast exceptionCaught Browser requestFullscreen requestFullScreen setCanvasSize getUserMedia createContext getPreloadedImageData__data wget MONTH_DAYS_REGULAR MONTH_DAYS_LEAP MONTH_DAYS_REGULAR_CUMULATIVE MONTH_DAYS_LEAP_CUMULATIVE isLeapYear ydayFromDate SYSCALLS tempFixedLengthArray miniTempWebGLFloatBuffers miniTempWebGLIntBuffers GL AL GLUT EGL GLEW IDBStore SDL SDL_gfx print printErr jstoi_s".split(" ").forEach($unexportedRuntimeSymbol$$);
			var $ASM_CONSTS$$ = { 5119344: () => "undefined" !== typeof wasmOffsetConverter }, $_free$$ = $makeInvalidEarlyAccess$$("_free");
			$Module$$._trace_processor_rpc_init = $makeInvalidEarlyAccess$$("_trace_processor_rpc_init");
			$Module$$._trace_processor_on_rpc_request = $makeInvalidEarlyAccess$$("_trace_processor_on_rpc_request");
			var $_main$$ = $Module$$._main = $makeInvalidEarlyAccess$$("_main"), $_malloc$$ = $makeInvalidEarlyAccess$$("_malloc"), $_fflush$$ = $makeInvalidEarlyAccess$$("_fflush");
			$Module$$._SynqPerfettoParseAlloc = $makeInvalidEarlyAccess$$("_SynqPerfettoParseAlloc");
			$Module$$._SynqPerfettoParseFree = $makeInvalidEarlyAccess$$("_SynqPerfettoParseFree");
			$Module$$._SynqPerfettoParse = $makeInvalidEarlyAccess$$("_SynqPerfettoParse");
			$Module$$._SynqPerfettoGetToken = $makeInvalidEarlyAccess$$("_SynqPerfettoGetToken");
			$Module$$._synq_extent_on_shift = $makeInvalidEarlyAccess$$("_synq_extent_on_shift");
			$Module$$._synq_extent_on_reduce = $makeInvalidEarlyAccess$$("_synq_extent_on_reduce");
			$Module$$._synq_extent_fold_below_into_top = $makeInvalidEarlyAccess$$("_synq_extent_fold_below_into_top");
			$Module$$._SynqPerfettoParseInit = $makeInvalidEarlyAccess$$("_SynqPerfettoParseInit");
			$Module$$._SynqPerfettoParseFinalize = $makeInvalidEarlyAccess$$("_SynqPerfettoParseFinalize");
			$Module$$._SynqPerfettoParseFallback = $makeInvalidEarlyAccess$$("_SynqPerfettoParseFallback");
			$Module$$._SynqPerfettoParseExpectedTokens = $makeInvalidEarlyAccess$$("_SynqPerfettoParseExpectedTokens");
			$Module$$._SynqPerfettoParseCompletionContext = $makeInvalidEarlyAccess$$("_SynqPerfettoParseCompletionContext");
			var $_emscripten_stack_get_end$$ = $makeInvalidEarlyAccess$$("_emscripten_stack_get_end"), $_emscripten_stack_init$$ = $makeInvalidEarlyAccess$$("_emscripten_stack_init"), $__emscripten_stack_restore$$ = $makeInvalidEarlyAccess$$("__emscripten_stack_restore"), $__emscripten_stack_alloc$$ = $makeInvalidEarlyAccess$$("__emscripten_stack_alloc"), $_emscripten_stack_get_current$$ = $makeInvalidEarlyAccess$$("_emscripten_stack_get_current"), $wasmMemory$$ = $makeInvalidEarlyAccess$$("wasmMemory"), $wasmTable$$ = $makeInvalidEarlyAccess$$("wasmTable"), $wasmImports$$ = {
				HaveOffsetConverter: function() {
					return "undefined" !== typeof wasmOffsetConverter;
				},
				__syscall_chmod: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_faccessat: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_fchmod: () => {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_fchown32: () => {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_fcntl64: function() {
					return 0;
				},
				__syscall_fstat64: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_ftruncate64: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_getcwd: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_ioctl: function() {
					return 0;
				},
				__syscall_lstat64: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_mkdirat: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_newfstatat: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_openat: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_readlinkat: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_rmdir: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_stat64: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_unlinkat: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_utimensat: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				_abort_js: () => $abort$$("native code called abort()"),
				_gmtime_js: function($date$jscomp$3_time$$, $tmPtr$$) {
					$date$jscomp$3_time$$ = $bigintToI53Checked$$($date$jscomp$3_time$$);
					$tmPtr$$ = $bigintToI53Checked$$($tmPtr$$);
					$date$jscomp$3_time$$ = /* @__PURE__ */ new Date(1e3 * $date$jscomp$3_time$$);
					$HEAP32$$[$tmPtr$$ / 4] = $date$jscomp$3_time$$.getUTCSeconds();
					$HEAP32$$[($tmPtr$$ + 4) / 4] = $date$jscomp$3_time$$.getUTCMinutes();
					$HEAP32$$[($tmPtr$$ + 8) / 4] = $date$jscomp$3_time$$.getUTCHours();
					$HEAP32$$[($tmPtr$$ + 12) / 4] = $date$jscomp$3_time$$.getUTCDate();
					$HEAP32$$[($tmPtr$$ + 16) / 4] = $date$jscomp$3_time$$.getUTCMonth();
					$HEAP32$$[($tmPtr$$ + 20) / 4] = $date$jscomp$3_time$$.getUTCFullYear() - 1900;
					$HEAP32$$[($tmPtr$$ + 24) / 4] = $date$jscomp$3_time$$.getUTCDay();
					$HEAP32$$[($tmPtr$$ + 28) / 4] = ($date$jscomp$3_time$$.getTime() - Date.UTC($date$jscomp$3_time$$.getUTCFullYear(), 0, 1, 0, 0, 0, 0)) / 864e5 | 0;
				},
				_localtime_js: function($date$jscomp$5_time$jscomp$1$$, $tmPtr$jscomp$1$$) {
					$date$jscomp$5_time$jscomp$1$$ = $bigintToI53Checked$$($date$jscomp$5_time$jscomp$1$$);
					$tmPtr$jscomp$1$$ = $bigintToI53Checked$$($tmPtr$jscomp$1$$);
					$date$jscomp$5_time$jscomp$1$$ = /* @__PURE__ */ new Date(1e3 * $date$jscomp$5_time$jscomp$1$$);
					$HEAP32$$[$tmPtr$jscomp$1$$ / 4] = $date$jscomp$5_time$jscomp$1$$.getSeconds();
					$HEAP32$$[($tmPtr$jscomp$1$$ + 4) / 4] = $date$jscomp$5_time$jscomp$1$$.getMinutes();
					$HEAP32$$[($tmPtr$jscomp$1$$ + 8) / 4] = $date$jscomp$5_time$jscomp$1$$.getHours();
					$HEAP32$$[($tmPtr$jscomp$1$$ + 12) / 4] = $date$jscomp$5_time$jscomp$1$$.getDate();
					$HEAP32$$[($tmPtr$jscomp$1$$ + 16) / 4] = $date$jscomp$5_time$jscomp$1$$.getMonth();
					$HEAP32$$[($tmPtr$jscomp$1$$ + 20) / 4] = $date$jscomp$5_time$jscomp$1$$.getFullYear() - 1900;
					$HEAP32$$[($tmPtr$jscomp$1$$ + 24) / 4] = $date$jscomp$5_time$jscomp$1$$.getDay();
					var $summerOffset_year$jscomp$inline_95$$ = $date$jscomp$5_time$jscomp$1$$.getFullYear();
					$HEAP32$$[($tmPtr$jscomp$1$$ + 28) / 4] = (0 !== $summerOffset_year$jscomp$inline_95$$ % 4 || 0 === $summerOffset_year$jscomp$inline_95$$ % 100 && 0 !== $summerOffset_year$jscomp$inline_95$$ % 400 ? $MONTH_DAYS_REGULAR_CUMULATIVE$$ : $MONTH_DAYS_LEAP_CUMULATIVE$$)[$date$jscomp$5_time$jscomp$1$$.getMonth()] + $date$jscomp$5_time$jscomp$1$$.getDate() - 1 | 0;
					$HEAP64$$[($tmPtr$jscomp$1$$ + 40) / 8] = BigInt(-(60 * $date$jscomp$5_time$jscomp$1$$.getTimezoneOffset()));
					$summerOffset_year$jscomp$inline_95$$ = new Date($date$jscomp$5_time$jscomp$1$$.getFullYear(), 6, 1).getTimezoneOffset();
					var $winterOffset$$ = new Date($date$jscomp$5_time$jscomp$1$$.getFullYear(), 0, 1).getTimezoneOffset();
					$HEAP32$$[($tmPtr$jscomp$1$$ + 32) / 4] = ($summerOffset_year$jscomp$inline_95$$ != $winterOffset$$ && $date$jscomp$5_time$jscomp$1$$.getTimezoneOffset() == Math.min($winterOffset$$, $summerOffset_year$jscomp$inline_95$$)) | 0;
				},
				_mmap_js: function() {
					return -52;
				},
				_munmap_js: function() {},
				_timegm_js: function($tmPtr$jscomp$2$$) {
					$tmPtr$jscomp$2$$ = $bigintToI53Checked$$($tmPtr$jscomp$2$$);
					var $date$jscomp$inline_63$$ = new Date(Date.UTC($HEAP32$$[($tmPtr$jscomp$2$$ + 20) / 4] + 1900, $HEAP32$$[($tmPtr$jscomp$2$$ + 16) / 4], $HEAP32$$[($tmPtr$jscomp$2$$ + 12) / 4], $HEAP32$$[($tmPtr$jscomp$2$$ + 8) / 4], $HEAP32$$[($tmPtr$jscomp$2$$ + 4) / 4], $HEAP32$$[$tmPtr$jscomp$2$$ / 4], 0));
					$HEAP32$$[($tmPtr$jscomp$2$$ + 24) / 4] = $date$jscomp$inline_63$$.getUTCDay();
					$HEAP32$$[($tmPtr$jscomp$2$$ + 28) / 4] = ($date$jscomp$inline_63$$.getTime() - Date.UTC($date$jscomp$inline_63$$.getUTCFullYear(), 0, 1, 0, 0, 0, 0)) / 864e5 | 0;
					return BigInt($date$jscomp$inline_63$$.getTime() / 1e3);
				},
				_tzset_js: function($timezone_winterName$$, $daylight_extractZone_summerName$$, $std_name$$, $dst_name$$) {
					$timezone_winterName$$ = $bigintToI53Checked$$($timezone_winterName$$);
					$daylight_extractZone_summerName$$ = $bigintToI53Checked$$($daylight_extractZone_summerName$$);
					$std_name$$ = $bigintToI53Checked$$($std_name$$);
					$dst_name$$ = $bigintToI53Checked$$($dst_name$$);
					var $currentYear_summerOffset$jscomp$1$$ = (/* @__PURE__ */ new Date()).getFullYear(), $winterOffset$jscomp$1$$ = new Date($currentYear_summerOffset$jscomp$1$$, 0, 1).getTimezoneOffset();
					$currentYear_summerOffset$jscomp$1$$ = new Date($currentYear_summerOffset$jscomp$1$$, 6, 1).getTimezoneOffset();
					$HEAPU64$$[$timezone_winterName$$ / 8] = BigInt(60 * Math.max($winterOffset$jscomp$1$$, $currentYear_summerOffset$jscomp$1$$));
					$HEAP32$$[$daylight_extractZone_summerName$$ / 4] = Number($winterOffset$jscomp$1$$ != $currentYear_summerOffset$jscomp$1$$);
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
					$ptime$$ = $bigintToI53Checked$$($ptime$$);
					if (!(0 <= $clk_id$$ && 3 >= $clk_id$$)) return 28;
					$HEAP64$$[$ptime$$ / 8] = BigInt(Math.round(1e6 * (0 === $clk_id$$ ? Date.now() : performance.now())));
					return 0;
				},
				emscripten_asm_const_int: function($code$jscomp$3_code$jscomp$inline_65$$, $sigPtr$jscomp$2_sigPtr$jscomp$inline_97$$, $argbuf$jscomp$1_buf$jscomp$inline_98$$) {
					$code$jscomp$3_code$jscomp$inline_65$$ = $bigintToI53Checked$$($code$jscomp$3_code$jscomp$inline_65$$);
					$sigPtr$jscomp$2_sigPtr$jscomp$inline_97$$ = $bigintToI53Checked$$($sigPtr$jscomp$2_sigPtr$jscomp$inline_97$$);
					$argbuf$jscomp$1_buf$jscomp$inline_98$$ = $bigintToI53Checked$$($argbuf$jscomp$1_buf$jscomp$inline_98$$);
					$assert$$(Array.isArray($readEmAsmArgsArray$$));
					$assert$$(0 == $argbuf$jscomp$1_buf$jscomp$inline_98$$ % 16);
					$readEmAsmArgsArray$$.length = 0;
					for (var $ch$jscomp$inline_99$$; $ch$jscomp$inline_99$$ = $HEAPU8$$[$sigPtr$jscomp$2_sigPtr$jscomp$inline_97$$++];) {
						var $chr$jscomp$inline_100_wide$jscomp$inline_102$$ = String.fromCharCode($ch$jscomp$inline_99$$), $validChars$jscomp$inline_101$$ = [
							"d",
							"f",
							"i",
							"p"
						];
						$validChars$jscomp$inline_101$$.push("j");
						$assert$$($validChars$jscomp$inline_101$$.includes($chr$jscomp$inline_100_wide$jscomp$inline_102$$), `Invalid character ${$ch$jscomp$inline_99$$}("${$chr$jscomp$inline_100_wide$jscomp$inline_102$$}") in readEmAsmArgs! Use only [${$validChars$jscomp$inline_101$$}], and do not specify "v" for void return argument.`);
						$chr$jscomp$inline_100_wide$jscomp$inline_102$$ = 105 != $ch$jscomp$inline_99$$;
						$argbuf$jscomp$1_buf$jscomp$inline_98$$ += $chr$jscomp$inline_100_wide$jscomp$inline_102$$ && $argbuf$jscomp$1_buf$jscomp$inline_98$$ % 8 ? 4 : 0;
						$readEmAsmArgsArray$$.push(112 == $ch$jscomp$inline_99$$ ? Number($HEAPU64$$[$argbuf$jscomp$1_buf$jscomp$inline_98$$ / 8]) : 106 == $ch$jscomp$inline_99$$ ? $HEAP64$$[$argbuf$jscomp$1_buf$jscomp$inline_98$$ / 8] : 105 == $ch$jscomp$inline_99$$ ? $HEAP32$$[$argbuf$jscomp$1_buf$jscomp$inline_98$$ / 4] : $HEAPF64$$[$argbuf$jscomp$1_buf$jscomp$inline_98$$ / 8]);
						$argbuf$jscomp$1_buf$jscomp$inline_98$$ += $chr$jscomp$inline_100_wide$jscomp$inline_102$$ ? 8 : 4;
					}
					$assert$$($ASM_CONSTS$$.hasOwnProperty($code$jscomp$3_code$jscomp$inline_65$$), `No EM_ASM constant found at address ${$code$jscomp$3_code$jscomp$inline_65$$}.  The loaded WebAssembly file is likely out of sync with the generated JavaScript.`);
					return $ASM_CONSTS$$[$code$jscomp$3_code$jscomp$inline_65$$](...$readEmAsmArgsArray$$);
				},
				emscripten_date_now: () => Date.now(),
				emscripten_err: function($str$jscomp$11$$) {
					$str$jscomp$11$$ = $bigintToI53Checked$$($str$jscomp$11$$);
					return $err$$($UTF8ToString$$($str$jscomp$11$$));
				},
				emscripten_errn: function($str$jscomp$12$$, $len$jscomp$3$$) {
					$str$jscomp$12$$ = $bigintToI53Checked$$($str$jscomp$12$$);
					$len$jscomp$3$$ = $bigintToI53Checked$$($len$jscomp$3$$);
					return $err$$($UTF8ToString$$($str$jscomp$12$$, $len$jscomp$3$$));
				},
				emscripten_get_heap_max: () => BigInt(17179869184),
				emscripten_get_now: () => performance.now(),
				emscripten_pc_get_function: $_emscripten_pc_get_function$$,
				emscripten_resize_heap: function($requestedSize$$) {
					$requestedSize$$ = $bigintToI53Checked$$($requestedSize$$);
					var $oldSize$$ = $HEAPU8$$.length;
					$assert$$($requestedSize$$ > $oldSize$$);
					if (17179869184 < $requestedSize$$) return $err$$(`Cannot enlarge memory, requested ${$requestedSize$$} bytes, but the limit is 17179869184 bytes!`), !1;
					for (var $cutDown$$ = 1; 4 >= $cutDown$$; $cutDown$$ *= 2) {
						var $oldHeapSize$jscomp$inline_74_overGrownHeapSize_size$jscomp$inline_70$$ = $oldSize$$ * (1 + .2 / $cutDown$$);
						$oldHeapSize$jscomp$inline_74_overGrownHeapSize_size$jscomp$inline_70$$ = Math.min($oldHeapSize$jscomp$inline_74_overGrownHeapSize_size$jscomp$inline_70$$, $requestedSize$$ + 100663296);
						var $JSCompiler_temp_const$jscomp$7_newSize$jscomp$1$$ = Math, $JSCompiler_temp_const$jscomp$6_size$jscomp$inline_73$$ = $JSCompiler_temp_const$jscomp$7_newSize$jscomp$1$$.min;
						$oldHeapSize$jscomp$inline_74_overGrownHeapSize_size$jscomp$inline_70$$ = Math.max($requestedSize$$, $oldHeapSize$jscomp$inline_74_overGrownHeapSize_size$jscomp$inline_70$$);
						$assert$$(65536, "alignment argument is required");
						$JSCompiler_temp_const$jscomp$7_newSize$jscomp$1$$ = $JSCompiler_temp_const$jscomp$6_size$jscomp$inline_73$$.call($JSCompiler_temp_const$jscomp$7_newSize$jscomp$1$$, 17179869184, 65536 * Math.ceil($oldHeapSize$jscomp$inline_74_overGrownHeapSize_size$jscomp$inline_70$$ / 65536));
						a: {
							$JSCompiler_temp_const$jscomp$6_size$jscomp$inline_73$$ = $JSCompiler_temp_const$jscomp$7_newSize$jscomp$1$$;
							$oldHeapSize$jscomp$inline_74_overGrownHeapSize_size$jscomp$inline_70$$ = $wasmMemory$$.buffer.byteLength;
							try {
								$wasmMemory$$.grow(BigInt(($JSCompiler_temp_const$jscomp$6_size$jscomp$inline_73$$ - $oldHeapSize$jscomp$inline_74_overGrownHeapSize_size$jscomp$inline_70$$ + 65535) / 65536 | 0));
								$updateMemoryViews$$();
								var $JSCompiler_inline_result$jscomp$9$$ = 1;
								break a;
							} catch ($e$jscomp$inline_76$$) {
								$err$$(`growMemory: Attempted to grow heap from ${$oldHeapSize$jscomp$inline_74_overGrownHeapSize_size$jscomp$inline_70$$} bytes to ${$JSCompiler_temp_const$jscomp$6_size$jscomp$inline_73$$} bytes, but got error: ${$e$jscomp$inline_76$$}`);
							}
							$JSCompiler_inline_result$jscomp$9$$ = void 0;
						}
						if ($JSCompiler_inline_result$jscomp$9$$) return !0;
					}
					$err$$(`Failed to grow the heap from ${$oldSize$$} bytes to ${$JSCompiler_temp_const$jscomp$7_newSize$jscomp$1$$} bytes, not enough memory!`);
					return !1;
				},
				emscripten_stack_snapshot: function() {
					var $callstack$jscomp$inline_78$$ = Error().stack.toString().split("\n");
					"Error" == $callstack$jscomp$inline_78$$[0] && $callstack$jscomp$inline_78$$.shift();
					$saveInUnwindCache$$($callstack$jscomp$inline_78$$);
					$UNWIND_CACHE$$.$last_addr$ = $convertFrameToPC$$($callstack$jscomp$inline_78$$[3]);
					$UNWIND_CACHE$$.$last_stack$ = $callstack$jscomp$inline_78$$;
					return BigInt($UNWIND_CACHE$$.$last_addr$);
				},
				emscripten_stack_unwind_buffer: function($addr$jscomp$2_i$jscomp$6$$, $buffer$jscomp$18$$, $count$jscomp$39$$) {
					$addr$jscomp$2_i$jscomp$6$$ = $bigintToI53Checked$$($addr$jscomp$2_i$jscomp$6$$);
					$buffer$jscomp$18$$ = $bigintToI53Checked$$($buffer$jscomp$18$$);
					if ($UNWIND_CACHE$$.$last_addr$ == $addr$jscomp$2_i$jscomp$6$$) var $stack$$ = $UNWIND_CACHE$$.$last_stack$;
					else $stack$$ = Error().stack.toString().split("\n"), "Error" == $stack$$[0] && $stack$$.shift(), $saveInUnwindCache$$($stack$$);
					for (var $offset$jscomp$28$$ = 3; $stack$$[$offset$jscomp$28$$] && $convertFrameToPC$$($stack$$[$offset$jscomp$28$$]) != $addr$jscomp$2_i$jscomp$6$$;) ++$offset$jscomp$28$$;
					for ($addr$jscomp$2_i$jscomp$6$$ = 0; $addr$jscomp$2_i$jscomp$6$$ < $count$jscomp$39$$ && $stack$$[$addr$jscomp$2_i$jscomp$6$$ + $offset$jscomp$28$$]; ++$addr$jscomp$2_i$jscomp$6$$) $HEAP32$$[($buffer$jscomp$18$$ + 4 * $addr$jscomp$2_i$jscomp$6$$) / 4] = $convertFrameToPC$$($stack$$[$addr$jscomp$2_i$jscomp$6$$ + $offset$jscomp$28$$]);
					return $addr$jscomp$2_i$jscomp$6$$;
				},
				environ_get: function($__environ$$, $environ_buf$$) {
					$__environ$$ = $bigintToI53Checked$$($__environ$$);
					$environ_buf$$ = $bigintToI53Checked$$($environ_buf$$);
					var $bufSize$$ = 0, $envp$$ = 0, $string$jscomp$3$$;
					for ($string$jscomp$3$$ of $getEnvStrings$$()) {
						var $ptr$jscomp$3$$ = $environ_buf$$ + $bufSize$$;
						$HEAPU64$$[($__environ$$ + $envp$$) / 8] = BigInt($ptr$jscomp$3$$);
						$bufSize$$ += $stringToUTF8$$($string$jscomp$3$$, $ptr$jscomp$3$$, Infinity) + 1;
						$envp$$ += 8;
					}
					return 0;
				},
				environ_sizes_get: function($bufSize$jscomp$1_penviron_count$$, $penviron_buf_size$$) {
					$bufSize$jscomp$1_penviron_count$$ = $bigintToI53Checked$$($bufSize$jscomp$1_penviron_count$$);
					$penviron_buf_size$$ = $bigintToI53Checked$$($penviron_buf_size$$);
					var $strings$jscomp$1$$ = $getEnvStrings$$();
					$HEAPU64$$[$bufSize$jscomp$1_penviron_count$$ / 8] = BigInt($strings$jscomp$1$$.length);
					$bufSize$jscomp$1_penviron_count$$ = 0;
					for (var $string$jscomp$4$$ of $strings$jscomp$1$$) $bufSize$jscomp$1_penviron_count$$ += $lengthBytesUTF8$$($string$jscomp$4$$) + 1;
					$HEAPU64$$[$penviron_buf_size$$ / 8] = BigInt($bufSize$jscomp$1_penviron_count$$);
					return 0;
				},
				exit: $exitJS$$,
				fd_close: () => {
					$abort$$("fd_close called without SYSCALLS_REQUIRE_FILESYSTEM");
				},
				fd_fdstat_get: function($fd$jscomp$9$$, $pbuf$$) {
					$pbuf$$ = $bigintToI53Checked$$($pbuf$$);
					var $rightsBase$$ = 0;
					$assert$$(0 == $fd$jscomp$9$$ || 1 == $fd$jscomp$9$$ || 2 == $fd$jscomp$9$$);
					if (0 == $fd$jscomp$9$$) $rightsBase$$ = 2;
					else if (1 == $fd$jscomp$9$$ || 2 == $fd$jscomp$9$$) $rightsBase$$ = 64;
					$HEAP8$$[$pbuf$$] = 2;
					$HEAP16$$[($pbuf$$ + 2) / 2] = 1;
					$HEAP64$$[($pbuf$$ + 8) / 8] = BigInt($rightsBase$$);
					$HEAP64$$[($pbuf$$ + 16) / 8] = BigInt(0);
					return 0;
				},
				fd_read: function() {
					$abort$$("fd_read called without SYSCALLS_REQUIRE_FILESYSTEM");
				},
				fd_seek: function() {
					return 70;
				},
				fd_sync: () => {
					$abort$$("fd_sync called without SYSCALLS_REQUIRE_FILESYSTEM");
					return 52;
				},
				fd_write: function($fd$jscomp$13$$, $iov$jscomp$1$$, $iovcnt$jscomp$1$$, $pnum$jscomp$1$$) {
					$iov$jscomp$1$$ = $bigintToI53Checked$$($iov$jscomp$1$$);
					$iovcnt$jscomp$1$$ = $bigintToI53Checked$$($iovcnt$jscomp$1$$);
					$pnum$jscomp$1$$ = $bigintToI53Checked$$($pnum$jscomp$1$$);
					for (var $num$jscomp$7$$ = 0, $i$jscomp$7$$ = 0; $i$jscomp$7$$ < $iovcnt$jscomp$1$$; $i$jscomp$7$$++) {
						var $ptr$jscomp$4$$ = Number($HEAPU64$$[$iov$jscomp$1$$ / 8]), $len$jscomp$4$$ = Number($HEAPU64$$[($iov$jscomp$1$$ + 8) / 8]);
						$iov$jscomp$1$$ += 16;
						for (var $j$$ = 0; $j$$ < $len$jscomp$4$$; $j$$++) $printChar$$($fd$jscomp$13$$, $HEAPU8$$[$ptr$jscomp$4$$ + $j$$]);
						$num$jscomp$7$$ += $len$jscomp$4$$;
					}
					$HEAPU64$$[$pnum$jscomp$1$$ / 8] = BigInt($num$jscomp$7$$);
					return 0;
				},
				proc_exit: $_proc_exit$$
			};
			function $applySignatureConversions$$() {
				var $wasmExports$jscomp$2$$ = $wasmExports$$;
				$wasmExports$jscomp$2$$ = Object.assign({}, $wasmExports$jscomp$2$$);
				var $makeWrapper__p$$ = ($f$jscomp$2$$) => ($a0$$) => $f$jscomp$2$$(BigInt($a0$$)), $makeWrapper_pp$$ = ($f$jscomp$4$$) => ($a0$jscomp$2$$) => Number($f$jscomp$4$$(BigInt($a0$jscomp$2$$))), $makeWrapper_p$$ = ($f$jscomp$5$$) => () => Number($f$jscomp$5$$());
				$wasmExports$jscomp$2$$.free = $makeWrapper__p$$($wasmExports$jscomp$2$$.free);
				$wasmExports$jscomp$2$$.__main_argc_argv = (($f$jscomp$3$$) => ($a0$jscomp$1$$, $a1$$, $a2$$) => $f$jscomp$3$$($a0$jscomp$1$$, BigInt($a1$$ ? $a1$$ : 0), BigInt($a2$$ ? $a2$$ : 0)))($wasmExports$jscomp$2$$.__main_argc_argv);
				$wasmExports$jscomp$2$$.malloc = $makeWrapper_pp$$($wasmExports$jscomp$2$$.malloc);
				$wasmExports$jscomp$2$$.fflush = $makeWrapper__p$$($wasmExports$jscomp$2$$.fflush);
				$wasmExports$jscomp$2$$.emscripten_stack_get_end = $makeWrapper_p$$($wasmExports$jscomp$2$$.emscripten_stack_get_end);
				$wasmExports$jscomp$2$$.emscripten_stack_get_base = $makeWrapper_p$$($wasmExports$jscomp$2$$.emscripten_stack_get_base);
				$wasmExports$jscomp$2$$._emscripten_stack_restore = $makeWrapper__p$$($wasmExports$jscomp$2$$._emscripten_stack_restore);
				$wasmExports$jscomp$2$$._emscripten_stack_alloc = $makeWrapper_pp$$($wasmExports$jscomp$2$$._emscripten_stack_alloc);
				$wasmExports$jscomp$2$$.emscripten_stack_get_current = $makeWrapper_p$$($wasmExports$jscomp$2$$.emscripten_stack_get_current);
				return $wasmExports$jscomp$2$$;
			}
			var $calledRun$$;
			function $callMain$$($JSCompiler_inline_result$jscomp$10_args$jscomp$6_e$jscomp$inline_80$$ = []) {
				$assert$$("undefined" === typeof $onPreRuns$$ || 0 == $onPreRuns$$.length, "cannot call main when preRun functions remain to be called");
				var $entryFunction$$ = $_main$$;
				$JSCompiler_inline_result$jscomp$10_args$jscomp$6_e$jscomp$inline_80$$.unshift($thisProgram$$);
				var $argc$$ = $JSCompiler_inline_result$jscomp$10_args$jscomp$6_e$jscomp$inline_80$$.length, $argv$$ = $__emscripten_stack_alloc$$(8 * ($argc$$ + 1)), $argv_ptr$$ = $argv$$, $arg$jscomp$8$$;
				for ($arg$jscomp$8$$ of $JSCompiler_inline_result$jscomp$10_args$jscomp$6_e$jscomp$inline_80$$) $HEAPU64$$[$argv_ptr$$ / 8] = BigInt($stringToUTF8OnStack$$($arg$jscomp$8$$)), $argv_ptr$$ += 8;
				$HEAPU64$$[$argv_ptr$$ / 8] = 0n;
				try {
					var $ret$jscomp$12$$ = $entryFunction$$($argc$$, BigInt($argv$$));
					$exitJS$$($ret$jscomp$12$$, !0);
					return $ret$jscomp$12$$;
				} catch ($e$jscomp$11$$) {
					$JSCompiler_inline_result$jscomp$10_args$jscomp$6_e$jscomp$inline_80$$ = $e$jscomp$11$$;
					if ($JSCompiler_inline_result$jscomp$10_args$jscomp$6_e$jscomp$inline_80$$ instanceof $ExitStatus$$ || "unwind" == $JSCompiler_inline_result$jscomp$10_args$jscomp$6_e$jscomp$inline_80$$) $JSCompiler_inline_result$jscomp$10_args$jscomp$6_e$jscomp$inline_80$$ = $EXITSTATUS$$;
					else throw $checkStackCookie$$(), $JSCompiler_inline_result$jscomp$10_args$jscomp$6_e$jscomp$inline_80$$ instanceof WebAssembly.RuntimeError && 0 >= $_emscripten_stack_get_current$$() && $err$$("Stack overflow detected.  You can try increasing -sSTACK_SIZE (currently set to 2097152)"), $JSCompiler_inline_result$jscomp$10_args$jscomp$6_e$jscomp$inline_80$$;
					return $JSCompiler_inline_result$jscomp$10_args$jscomp$6_e$jscomp$inline_80$$;
				}
			}
			function $checkUnflushedContent$$() {
				var $oldOut$$ = $out$$, $oldErr$$ = $err$$, $has$$ = !1;
				$out$$ = $err$$ = () => {
					$has$$ = !0;
				};
				try {
					$_fflush$$(0), $printCharBuffers$$[1].length && $printChar$$(1, 10), $printCharBuffers$$[2].length && $printChar$$(2, 10);
				} catch ($e$jscomp$12$$) {}
				$out$$ = $oldOut$$;
				$err$$ = $oldErr$$;
				$has$$ && ($warnOnce$$("stdio streams had content in them that was not flushed. you should set EXIT_RUNTIME to 1 (see the Emscripten FAQ), or make sure to emit a newline when you printf etc."), $warnOnce$$("(this may also be due to not including full filesystem support - try building with -sFORCE_FILESYSTEM)"));
			}
			var $wasmExports$$ = await async function() {
				function $receiveInstance$$($instance$jscomp$1_wasmExports$jscomp$inline_83$$) {
					$wasmExports$$ = $instance$jscomp$1_wasmExports$jscomp$inline_83$$.exports;
					$instance$jscomp$1_wasmExports$jscomp$inline_83$$ = $wasmExports$$ = $applySignatureConversions$$();
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.free, "missing Wasm export: free");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.trace_processor_rpc_init, "missing Wasm export: trace_processor_rpc_init");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.trace_processor_on_rpc_request, "missing Wasm export: trace_processor_on_rpc_request");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.__main_argc_argv, "missing Wasm export: __main_argc_argv");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.malloc, "missing Wasm export: malloc");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.fflush, "missing Wasm export: fflush");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.SynqPerfettoParseAlloc, "missing Wasm export: SynqPerfettoParseAlloc");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.SynqPerfettoParseFree, "missing Wasm export: SynqPerfettoParseFree");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.SynqPerfettoParse, "missing Wasm export: SynqPerfettoParse");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.SynqPerfettoGetToken, "missing Wasm export: SynqPerfettoGetToken");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.synq_extent_on_shift, "missing Wasm export: synq_extent_on_shift");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.synq_extent_on_reduce, "missing Wasm export: synq_extent_on_reduce");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.synq_extent_fold_below_into_top, "missing Wasm export: synq_extent_fold_below_into_top");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.SynqPerfettoParseInit, "missing Wasm export: SynqPerfettoParseInit");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.SynqPerfettoParseFinalize, "missing Wasm export: SynqPerfettoParseFinalize");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.SynqPerfettoParseFallback, "missing Wasm export: SynqPerfettoParseFallback");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.SynqPerfettoParseExpectedTokens, "missing Wasm export: SynqPerfettoParseExpectedTokens");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.SynqPerfettoParseCompletionContext, "missing Wasm export: SynqPerfettoParseCompletionContext");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.emscripten_stack_get_end, "missing Wasm export: emscripten_stack_get_end");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.emscripten_stack_get_base, "missing Wasm export: emscripten_stack_get_base");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.emscripten_stack_init, "missing Wasm export: emscripten_stack_init");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.emscripten_stack_get_free, "missing Wasm export: emscripten_stack_get_free");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$._emscripten_stack_restore, "missing Wasm export: _emscripten_stack_restore");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$._emscripten_stack_alloc, "missing Wasm export: _emscripten_stack_alloc");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.emscripten_stack_get_current, "missing Wasm export: emscripten_stack_get_current");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.memory, "missing Wasm export: memory");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_83$$.__indirect_function_table, "missing Wasm export: __indirect_function_table");
					$_free$$ = $createExportWrapper$$("free", 1);
					$Module$$._trace_processor_rpc_init = $createExportWrapper$$("trace_processor_rpc_init", 2);
					$Module$$._trace_processor_on_rpc_request = $createExportWrapper$$("trace_processor_on_rpc_request", 1);
					$_main$$ = $Module$$._main = $createExportWrapper$$("__main_argc_argv", 2);
					$_malloc$$ = $createExportWrapper$$("malloc", 1);
					$_fflush$$ = $createExportWrapper$$("fflush", 1);
					$Module$$._SynqPerfettoParseAlloc = $createExportWrapper$$("SynqPerfettoParseAlloc", 2);
					$Module$$._SynqPerfettoParseFree = $createExportWrapper$$("SynqPerfettoParseFree", 2);
					$Module$$._SynqPerfettoParse = $createExportWrapper$$("SynqPerfettoParse", 3);
					$Module$$._SynqPerfettoGetToken = $createExportWrapper$$("SynqPerfettoGetToken", 3);
					$Module$$._synq_extent_on_shift = $createExportWrapper$$("synq_extent_on_shift", 3);
					$Module$$._synq_extent_on_reduce = $createExportWrapper$$("synq_extent_on_reduce", 2);
					$Module$$._synq_extent_fold_below_into_top = $createExportWrapper$$("synq_extent_fold_below_into_top", 1);
					$Module$$._SynqPerfettoParseInit = $createExportWrapper$$("SynqPerfettoParseInit", 2);
					$Module$$._SynqPerfettoParseFinalize = $createExportWrapper$$("SynqPerfettoParseFinalize", 1);
					$Module$$._SynqPerfettoParseFallback = $createExportWrapper$$("SynqPerfettoParseFallback", 1);
					$Module$$._SynqPerfettoParseExpectedTokens = $createExportWrapper$$("SynqPerfettoParseExpectedTokens", 3);
					$Module$$._SynqPerfettoParseCompletionContext = $createExportWrapper$$("SynqPerfettoParseCompletionContext", 1);
					$_emscripten_stack_get_end$$ = $instance$jscomp$1_wasmExports$jscomp$inline_83$$.emscripten_stack_get_end;
					$_emscripten_stack_init$$ = $instance$jscomp$1_wasmExports$jscomp$inline_83$$.emscripten_stack_init;
					$__emscripten_stack_restore$$ = $instance$jscomp$1_wasmExports$jscomp$inline_83$$._emscripten_stack_restore;
					$__emscripten_stack_alloc$$ = $instance$jscomp$1_wasmExports$jscomp$inline_83$$._emscripten_stack_alloc;
					$_emscripten_stack_get_current$$ = $instance$jscomp$1_wasmExports$jscomp$inline_83$$.emscripten_stack_get_current;
					$wasmMemory$$ = $instance$jscomp$1_wasmExports$jscomp$inline_83$$.memory;
					$wasmTable$$ = $instance$jscomp$1_wasmExports$jscomp$inline_83$$.__indirect_function_table;
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
				$wasmBinaryFile$$ ??= $Module$$.locateFile ? $Module$$.locateFile("trace_processor_memory64.wasm", $scriptDirectory$$) : $scriptDirectory$$ + "trace_processor_memory64.wasm";
				return function($result$jscomp$2$$) {
					$assert$$($Module$$ === $trueModule$$, "the Module object should not be replaced during async compilation - perhaps the order of HTML elements is wrong?");
					$trueModule$$ = null;
					return $receiveInstance$$($result$jscomp$2$$.instance);
				}(await $instantiateAsync$$($info$$));
			}();
			(function($args$jscomp$7$$ = $arguments_$$) {
				function $doRun$$() {
					$assert$$(!$calledRun$$);
					$calledRun$$ = !0;
					$Module$$.calledRun = !0;
					if (!$ABORT$$) {
						$assert$$(!$runtimeInitialized$$);
						$runtimeInitialized$$ = !0;
						$checkStackCookie$$();
						$wasmExports$$.__wasm_call_ctors();
						$checkStackCookie$$();
						$readyPromiseResolve$$?.($Module$$);
						$Module$$.onRuntimeInitialized?.();
						$consumedModuleProp$$("onRuntimeInitialized");
						$Module$$.noInitialRun || $callMain$$($args$jscomp$7$$);
						$checkStackCookie$$();
						if ($Module$$.postRun) for ("function" == typeof $Module$$.postRun && ($Module$$.postRun = [$Module$$.postRun]); $Module$$.postRun.length;) {
							var $cb$jscomp$inline_106$$ = $Module$$.postRun.shift();
							$onPostRuns$$.push($cb$jscomp$inline_106$$);
						}
						$consumedModuleProp$$("postRun");
						$callRuntimeCallbacks$$($onPostRuns$$);
					}
				}
				$_emscripten_stack_init$$();
				$writeStackCookie$$();
				if ($Module$$.preRun) for ("function" == typeof $Module$$.preRun && ($Module$$.preRun = [$Module$$.preRun]); $Module$$.preRun.length;) $addOnPreRun$$();
				$consumedModuleProp$$("preRun");
				$callRuntimeCallbacks$$($onPreRuns$$);
				$Module$$.setStatus ? ($Module$$.setStatus("Running..."), setTimeout(() => {
					setTimeout(() => $Module$$.setStatus(""), 1);
					$doRun$$();
				}, 1)) : $doRun$$();
				$checkStackCookie$$();
			})();
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
		}
		if (typeof exports === "object" && typeof module === "object") {
			module.exports = trace_processor_memory64_wasm;
			module.exports.default = trace_processor_memory64_wasm;
		} else if (typeof define === "function" && define["amd"]) define([], () => trace_processor_memory64_wasm);
	}));
	//#endregion
	//#region ui/tsc/gen/trace_processor.js
	var require_trace_processor = /* @__PURE__ */ __commonJSMin(((exports, module) => {
		async function trace_processor_wasm(moduleArg = {}) {
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
			var $Module$$ = moduleArg, $ENVIRONMENT_IS_WEB$$ = !!globalThis.window, $ENVIRONMENT_IS_WORKER$$ = !!globalThis.WorkerGlobalScope, $ENVIRONMENT_IS_NODE$$ = globalThis.$g$?.$versions$?.node && "renderer" != globalThis.$g$?.type, $ENVIRONMENT_IS_SHELL$$ = !$ENVIRONMENT_IS_WEB$$ && !$ENVIRONMENT_IS_NODE$$ && !$ENVIRONMENT_IS_WORKER$$, $arguments_$$ = [], $thisProgram$$ = "./this.program", $_scriptName$$;
			$ENVIRONMENT_IS_WORKER$$ && ($_scriptName$$ = self.location.href);
			var $scriptDirectory$$ = "", $readAsync$$, $readBinary$$;
			if (!$ENVIRONMENT_IS_SHELL$$) if ($ENVIRONMENT_IS_WEB$$ || $ENVIRONMENT_IS_WORKER$$) {
				try {
					$scriptDirectory$$ = new URL(".", $_scriptName$$).href;
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
			$assert$$(!$ENVIRONMENT_IS_WEB$$, "web environment detected but not enabled at build time.  Add `web` to `-sENVIRONMENT` to enable.");
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
			var $h16$jscomp$inline_11$$ = /* @__PURE__ */ new Int16Array(1), $h8$jscomp$inline_12$$ = new Int8Array($h16$jscomp$inline_11$$.buffer);
			$h16$jscomp$inline_11$$[0] = 25459;
			115 === $h8$jscomp$inline_12$$[0] && 99 === $h8$jscomp$inline_12$$[1] || $abort$$("Runtime error: expected the system to be little-endian! (Run with -sSUPPORT_BIG_ENDIAN to bypass)");
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
			function $FS$error$$() {
				$abort$$("Filesystem support (FS) was not included. The problem is that you are using files from JS, but files were not used from C/C++, so filesystem support was not auto-included. You can force-include filesystem support with -sFORCE_FILESYSTEM");
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
			}, $UTF8Decoder$$ = globalThis.TextDecoder && new TextDecoder(), $UTF8ArrayToString$$ = ($heapOrArray$jscomp$1$$, $idx$jscomp$1$$ = 0, $maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_20_str$jscomp$7$$) => {
				$idx$jscomp$1$$ >>>= 0;
				var $endPtr_idx$jscomp$inline_17$$ = $idx$jscomp$1$$;
				for ($maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_20_str$jscomp$7$$ = $endPtr_idx$jscomp$inline_17$$ + $maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_20_str$jscomp$7$$; $heapOrArray$jscomp$1$$[$endPtr_idx$jscomp$inline_17$$] && !($endPtr_idx$jscomp$inline_17$$ >= $maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_20_str$jscomp$7$$);) ++$endPtr_idx$jscomp$inline_17$$;
				if (16 < $endPtr_idx$jscomp$inline_17$$ - $idx$jscomp$1$$ && $heapOrArray$jscomp$1$$.buffer && $UTF8Decoder$$) return $UTF8Decoder$$.decode($heapOrArray$jscomp$1$$.subarray($idx$jscomp$1$$, $endPtr_idx$jscomp$inline_17$$));
				for ($maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_20_str$jscomp$7$$ = ""; $idx$jscomp$1$$ < $endPtr_idx$jscomp$inline_17$$;) {
					var $ch_u0$$ = $heapOrArray$jscomp$1$$[$idx$jscomp$1$$++];
					if ($ch_u0$$ & 128) {
						var $u1$$ = $heapOrArray$jscomp$1$$[$idx$jscomp$1$$++] & 63;
						if (192 == ($ch_u0$$ & 224)) $maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_20_str$jscomp$7$$ += String.fromCharCode(($ch_u0$$ & 31) << 6 | $u1$$);
						else {
							var $u2$$ = $heapOrArray$jscomp$1$$[$idx$jscomp$1$$++] & 63;
							224 == ($ch_u0$$ & 240) ? $ch_u0$$ = ($ch_u0$$ & 15) << 12 | $u1$$ << 6 | $u2$$ : (240 != ($ch_u0$$ & 248) && $warnOnce$$("Invalid UTF-8 leading byte " + $ptrToString$$($ch_u0$$) + " encountered when deserializing a UTF-8 string in wasm memory to a JS string!"), $ch_u0$$ = ($ch_u0$$ & 7) << 18 | $u1$$ << 12 | $u2$$ << 6 | $heapOrArray$jscomp$1$$[$idx$jscomp$1$$++] & 63);
							65536 > $ch_u0$$ ? $maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_20_str$jscomp$7$$ += String.fromCharCode($ch_u0$$) : ($ch_u0$$ -= 65536, $maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_20_str$jscomp$7$$ += String.fromCharCode(55296 | $ch_u0$$ >> 10, 56320 | $ch_u0$$ & 1023));
						}
					} else $maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_20_str$jscomp$7$$ += String.fromCharCode($ch_u0$$);
				}
				return $maxBytesToRead$jscomp$1_maxIdx$jscomp$inline_20_str$jscomp$7$$;
			}, $UTF8ToString$$ = ($ptr$jscomp$1$$, $maxBytesToRead$jscomp$2$$) => {
				$assert$$("number" == typeof $ptr$jscomp$1$$, `UTF8ToString expects a number (got ${typeof $ptr$jscomp$1$$})`);
				return ($ptr$jscomp$1$$ >>>= 0) ? $UTF8ArrayToString$$($HEAPU8$$, $ptr$jscomp$1$$, $maxBytesToRead$jscomp$2$$) : "";
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
			], $stringToUTF8$$ = ($JSCompiler_inline_result$jscomp$2_str$jscomp$9$$, $outIdx$jscomp$inline_23_outPtr$$, $endIdx$jscomp$inline_27_maxBytesToWrite$jscomp$1$$) => {
				$assert$$("number" == typeof $endIdx$jscomp$inline_27_maxBytesToWrite$jscomp$1$$, "stringToUTF8(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!");
				var $heap$jscomp$inline_25$$ = $HEAPU8$$;
				$outIdx$jscomp$inline_23_outPtr$$ >>>= 0;
				$assert$$("string" === typeof $JSCompiler_inline_result$jscomp$2_str$jscomp$9$$, `stringToUTF8Array expects a string (got ${typeof $JSCompiler_inline_result$jscomp$2_str$jscomp$9$$})`);
				if (0 < $endIdx$jscomp$inline_27_maxBytesToWrite$jscomp$1$$) {
					var $startIdx$jscomp$inline_26$$ = $outIdx$jscomp$inline_23_outPtr$$;
					$endIdx$jscomp$inline_27_maxBytesToWrite$jscomp$1$$ = $outIdx$jscomp$inline_23_outPtr$$ + $endIdx$jscomp$inline_27_maxBytesToWrite$jscomp$1$$ - 1;
					for (var $i$jscomp$inline_28$$ = 0; $i$jscomp$inline_28$$ < $JSCompiler_inline_result$jscomp$2_str$jscomp$9$$.length; ++$i$jscomp$inline_28$$) {
						var $u$jscomp$inline_29$$ = $JSCompiler_inline_result$jscomp$2_str$jscomp$9$$.codePointAt($i$jscomp$inline_28$$);
						if (127 >= $u$jscomp$inline_29$$) {
							if ($outIdx$jscomp$inline_23_outPtr$$ >= $endIdx$jscomp$inline_27_maxBytesToWrite$jscomp$1$$) break;
							$heap$jscomp$inline_25$$[$outIdx$jscomp$inline_23_outPtr$$++ >>> 0] = $u$jscomp$inline_29$$;
						} else if (2047 >= $u$jscomp$inline_29$$) {
							if ($outIdx$jscomp$inline_23_outPtr$$ + 1 >= $endIdx$jscomp$inline_27_maxBytesToWrite$jscomp$1$$) break;
							$heap$jscomp$inline_25$$[$outIdx$jscomp$inline_23_outPtr$$++ >>> 0] = 192 | $u$jscomp$inline_29$$ >> 6;
							$heap$jscomp$inline_25$$[$outIdx$jscomp$inline_23_outPtr$$++ >>> 0] = 128 | $u$jscomp$inline_29$$ & 63;
						} else if (65535 >= $u$jscomp$inline_29$$) {
							if ($outIdx$jscomp$inline_23_outPtr$$ + 2 >= $endIdx$jscomp$inline_27_maxBytesToWrite$jscomp$1$$) break;
							$heap$jscomp$inline_25$$[$outIdx$jscomp$inline_23_outPtr$$++ >>> 0] = 224 | $u$jscomp$inline_29$$ >> 12;
							$heap$jscomp$inline_25$$[$outIdx$jscomp$inline_23_outPtr$$++ >>> 0] = 128 | $u$jscomp$inline_29$$ >> 6 & 63;
							$heap$jscomp$inline_25$$[$outIdx$jscomp$inline_23_outPtr$$++ >>> 0] = 128 | $u$jscomp$inline_29$$ & 63;
						} else {
							if ($outIdx$jscomp$inline_23_outPtr$$ + 3 >= $endIdx$jscomp$inline_27_maxBytesToWrite$jscomp$1$$) break;
							1114111 < $u$jscomp$inline_29$$ && $warnOnce$$("Invalid Unicode code point " + $ptrToString$$($u$jscomp$inline_29$$) + " encountered when serializing a JS string to a UTF-8 string in wasm memory! (Valid unicode code points should be in range 0-0x10FFFF).");
							$heap$jscomp$inline_25$$[$outIdx$jscomp$inline_23_outPtr$$++ >>> 0] = 240 | $u$jscomp$inline_29$$ >> 18;
							$heap$jscomp$inline_25$$[$outIdx$jscomp$inline_23_outPtr$$++ >>> 0] = 128 | $u$jscomp$inline_29$$ >> 12 & 63;
							$heap$jscomp$inline_25$$[$outIdx$jscomp$inline_23_outPtr$$++ >>> 0] = 128 | $u$jscomp$inline_29$$ >> 6 & 63;
							$heap$jscomp$inline_25$$[$outIdx$jscomp$inline_23_outPtr$$++ >>> 0] = 128 | $u$jscomp$inline_29$$ & 63;
							$i$jscomp$inline_28$$++;
						}
					}
					$heap$jscomp$inline_25$$[$outIdx$jscomp$inline_23_outPtr$$ >>> 0] = 0;
					$JSCompiler_inline_result$jscomp$2_str$jscomp$9$$ = $outIdx$jscomp$inline_23_outPtr$$ - $startIdx$jscomp$inline_26$$;
				} else $JSCompiler_inline_result$jscomp$2_str$jscomp$9$$ = 0;
				return $JSCompiler_inline_result$jscomp$2_str$jscomp$9$$;
			}, $lengthBytesUTF8$$ = ($str$jscomp$10$$) => {
				for (var $len$jscomp$2$$ = 0, $i$jscomp$5$$ = 0; $i$jscomp$5$$ < $str$jscomp$10$$.length; ++$i$jscomp$5$$) {
					var $c$$ = $str$jscomp$10$$.charCodeAt($i$jscomp$5$$);
					127 >= $c$$ ? $len$jscomp$2$$++ : 2047 >= $c$$ ? $len$jscomp$2$$ += 2 : 55296 <= $c$$ && 57343 >= $c$$ ? ($len$jscomp$2$$ += 4, ++$i$jscomp$5$$) : $len$jscomp$2$$ += 3;
				}
				return $len$jscomp$2$$;
			}, $readEmAsmArgsArray$$ = [], $UNWIND_CACHE$$ = {}, $convertFrameToPC$$ = ($frame$jscomp$1$$) => {
				var $match$$;
				if ($match$$ = /\bwasm-function\[\d+\]:(0x[0-9a-f]+)/.exec($frame$jscomp$1$$)) return +$match$$[1];
				if (/\bwasm-function\[(\d+)\]:(\d+)/.exec($frame$jscomp$1$$)) $warnOnce$$("legacy backtrace format detected, this version of v8 is no longer supported by the emscripten backtrace mechanism");
				else if ($match$$ = /:(\d+):\d+(?:\)|$)/.exec($frame$jscomp$1$$)) return 2147483648 | +$match$$[1];
				return 0;
			}, $saveInUnwindCache$$ = ($callstack_pc$$) => {
				for (var $line$jscomp$7$$ of $callstack_pc$$) ($callstack_pc$$ = $convertFrameToPC$$($line$jscomp$7$$)) && ($UNWIND_CACHE$$[$callstack_pc$$] = $line$jscomp$7$$);
			};
			function $_emscripten_pc_get_function$$($frame$jscomp$2_name$jscomp$77_pc$jscomp$1_str$jscomp$inline_31$$) {
				$frame$jscomp$2_name$jscomp$77_pc$jscomp$1_str$jscomp$inline_31$$ = $UNWIND_CACHE$$[$frame$jscomp$2_name$jscomp$77_pc$jscomp$1_str$jscomp$inline_31$$ >>> 0];
				if (!$frame$jscomp$2_name$jscomp$77_pc$jscomp$1_str$jscomp$inline_31$$) return 0;
				var $match$jscomp$1_size$jscomp$inline_32$$;
				if ($match$jscomp$1_size$jscomp$inline_32$$ = /^\s+at .*\.wasm\.(.*) \(.*\)$/.exec($frame$jscomp$2_name$jscomp$77_pc$jscomp$1_str$jscomp$inline_31$$)) $frame$jscomp$2_name$jscomp$77_pc$jscomp$1_str$jscomp$inline_31$$ = $match$jscomp$1_size$jscomp$inline_32$$[1];
				else if ($match$jscomp$1_size$jscomp$inline_32$$ = /^\s+at (.*) \(.*\)$/.exec($frame$jscomp$2_name$jscomp$77_pc$jscomp$1_str$jscomp$inline_31$$)) $frame$jscomp$2_name$jscomp$77_pc$jscomp$1_str$jscomp$inline_31$$ = $match$jscomp$1_size$jscomp$inline_32$$[1];
				else if ($match$jscomp$1_size$jscomp$inline_32$$ = /^(.+?)@/.exec($frame$jscomp$2_name$jscomp$77_pc$jscomp$1_str$jscomp$inline_31$$)) $frame$jscomp$2_name$jscomp$77_pc$jscomp$1_str$jscomp$inline_31$$ = $match$jscomp$1_size$jscomp$inline_32$$[1];
				else return 0;
				$_free$$($_emscripten_pc_get_function$$.$ret$ ?? 0);
				$match$jscomp$1_size$jscomp$inline_32$$ = $lengthBytesUTF8$$($frame$jscomp$2_name$jscomp$77_pc$jscomp$1_str$jscomp$inline_31$$) + 1;
				var $ret$jscomp$inline_33$$ = $_malloc$$($match$jscomp$1_size$jscomp$inline_32$$);
				$ret$jscomp$inline_33$$ && $stringToUTF8$$($frame$jscomp$2_name$jscomp$77_pc$jscomp$1_str$jscomp$inline_31$$, $ret$jscomp$inline_33$$, $match$jscomp$1_size$jscomp$inline_32$$);
				$_emscripten_pc_get_function$$.$ret$ = $ret$jscomp$inline_33$$;
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
			}, $printCharBuffers$$ = [
				null,
				[],
				[]
			], $printChar$$ = ($stream$jscomp$4$$, $curr$$) => {
				var $buffer$jscomp$19$$ = $printCharBuffers$$[$stream$jscomp$4$$];
				$assert$$($buffer$jscomp$19$$);
				0 === $curr$$ || 10 === $curr$$ ? ((1 === $stream$jscomp$4$$ ? $out$$ : $err$$)($UTF8ArrayToString$$($buffer$jscomp$19$$)), $buffer$jscomp$19$$.length = 0) : $buffer$jscomp$19$$.push($curr$$);
			}, $stringToUTF8OnStack$$ = ($str$jscomp$14$$) => {
				var $size$jscomp$25$$ = $lengthBytesUTF8$$($str$jscomp$14$$) + 1, $ret$jscomp$3$$ = $__emscripten_stack_alloc$$($size$jscomp$25$$);
				$stringToUTF8$$($str$jscomp$14$$, $ret$jscomp$3$$, $size$jscomp$25$$);
				return $ret$jscomp$3$$;
			}, $getCFunc$$ = ($ident$jscomp$1$$) => {
				var $func$jscomp$7$$ = $Module$$["_" + $ident$jscomp$1$$];
				$assert$$($func$jscomp$7$$, "Cannot call unknown function " + $ident$jscomp$1$$ + ", make sure it is exported");
				return $func$jscomp$7$$;
			}, $wasmTableMirror$$ = [], $functionsInTableMap$$, $freeTableIndexes$$ = [], $uleb128EncodeWithLen$$ = ($arr$jscomp$3$$) => {
				const $n$jscomp$4$$ = $arr$jscomp$3$$.length;
				$assert$$(16384 > $n$jscomp$4$$);
				return [
					$n$jscomp$4$$ % 128 | 128,
					$n$jscomp$4$$ >> 7,
					...$arr$jscomp$3$$
				];
			}, $wasmTypeCodes$$ = {
				i: 127,
				p: 127,
				j: 126,
				f: 125,
				d: 124,
				e: 111
			}, $generateTypePack$$ = ($types$$) => $uleb128EncodeWithLen$$(Array.from($types$$, ($type$jscomp$167$$) => {
				var $code$jscomp$5$$ = $wasmTypeCodes$$[$type$jscomp$167$$];
				$assert$$($code$jscomp$5$$, `invalid signature char: ${$type$jscomp$167$$}`);
				return $code$jscomp$5$$;
			}));
			$Module$$.noExitRuntime && ($noExitRuntime$$ = $Module$$.noExitRuntime);
			$Module$$.print && ($out$$ = $Module$$.print);
			$Module$$.printErr && ($err$$ = $Module$$.printErr);
			$Module$$.wasmBinary && ($wasmBinary$$ = $Module$$.wasmBinary);
			$Module$$.FS_createDataFile = function() {
				$FS$error$$();
			};
			$Module$$.FS_createPreloadedFile = function() {
				$FS$error$$();
			};
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
			$Module$$.ccall = ($func$jscomp$8_ident$jscomp$2$$, $returnType$$, $argTypes_ret$jscomp$4$$, $args$jscomp$5$$) => {
				var $toC$$ = {
					string: ($str$jscomp$15$$) => {
						var $ret$jscomp$5$$ = 0;
						null !== $str$jscomp$15$$ && void 0 !== $str$jscomp$15$$ && 0 !== $str$jscomp$15$$ && ($ret$jscomp$5$$ = $stringToUTF8OnStack$$($str$jscomp$15$$));
						return $ret$jscomp$5$$;
					},
					array: ($arr$jscomp$2$$) => {
						var $ret$jscomp$6$$ = $__emscripten_stack_alloc$$($arr$jscomp$2$$.length);
						$assert$$(0 <= $arr$jscomp$2$$.length, "writeArrayToMemory array must have a length (should be an array or typed array)");
						$HEAP8$$.set($arr$jscomp$2$$, $ret$jscomp$6$$ >>> 0);
						return $ret$jscomp$6$$;
					}
				};
				$func$jscomp$8_ident$jscomp$2$$ = $getCFunc$$($func$jscomp$8_ident$jscomp$2$$);
				var $cArgs$$ = [], $stack$jscomp$1$$ = 0;
				$assert$$("array" !== $returnType$$, "Return type should not be \"array\".");
				if ($args$jscomp$5$$) for (var $i$jscomp$8$$ = 0; $i$jscomp$8$$ < $args$jscomp$5$$.length; $i$jscomp$8$$++) {
					var $converter$$ = $toC$$[$argTypes_ret$jscomp$4$$[$i$jscomp$8$$]];
					$converter$$ ? (0 === $stack$jscomp$1$$ && ($stack$jscomp$1$$ = $_emscripten_stack_get_current$$()), $cArgs$$[$i$jscomp$8$$] = $converter$$($args$jscomp$5$$[$i$jscomp$8$$])) : $cArgs$$[$i$jscomp$8$$] = $args$jscomp$5$$[$i$jscomp$8$$];
				}
				$argTypes_ret$jscomp$4$$ = $func$jscomp$8_ident$jscomp$2$$(...$cArgs$$);
				return $argTypes_ret$jscomp$4$$ = function($ret$jscomp$8$$) {
					0 !== $stack$jscomp$1$$ && $__emscripten_stack_restore$$($stack$jscomp$1$$);
					return "string" === $returnType$$ ? $UTF8ToString$$($ret$jscomp$8$$) : "pointer" === $returnType$$ ? $ret$jscomp$8$$ >>> 0 : "boolean" === $returnType$$ ? !!$ret$jscomp$8$$ : $ret$jscomp$8$$;
				}($argTypes_ret$jscomp$4$$);
			};
			$Module$$.addFunction = ($func$jscomp$13$$, $bytes$jscomp$inline_56_module$jscomp$inline_57_sig$jscomp$1_wrapped$$) => {
				$assert$$("undefined" != typeof $func$jscomp$13$$);
				if (!$functionsInTableMap$$) {
					$functionsInTableMap$$ = /* @__PURE__ */ new WeakMap();
					var $count$jscomp$inline_88_idx$jscomp$inline_51_idx$jscomp$inline_59_rtn$$ = $wasmTable$$.length;
					if ($functionsInTableMap$$) for (var $i$jscomp$inline_89$$ = 0; $i$jscomp$inline_89$$ < 0 + $count$jscomp$inline_88_idx$jscomp$inline_51_idx$jscomp$inline_59_rtn$$; $i$jscomp$inline_89$$++) {
						var $funcPtr$jscomp$inline_105_item$jscomp$inline_90$$ = $i$jscomp$inline_89$$;
						var $func$jscomp$inline_106$$ = $wasmTableMirror$$[$funcPtr$jscomp$inline_105_item$jscomp$inline_90$$];
						$func$jscomp$inline_106$$ || ($wasmTableMirror$$[$funcPtr$jscomp$inline_105_item$jscomp$inline_90$$] = $func$jscomp$inline_106$$ = $wasmTable$$.get($funcPtr$jscomp$inline_105_item$jscomp$inline_90$$));
						$assert$$($wasmTable$$.get($funcPtr$jscomp$inline_105_item$jscomp$inline_90$$) == $func$jscomp$inline_106$$, "JavaScript-side Wasm function table mirror is out of date!");
						($funcPtr$jscomp$inline_105_item$jscomp$inline_90$$ = $func$jscomp$inline_106$$) && $functionsInTableMap$$.set($funcPtr$jscomp$inline_105_item$jscomp$inline_90$$, $i$jscomp$inline_89$$);
					}
				}
				if ($count$jscomp$inline_88_idx$jscomp$inline_51_idx$jscomp$inline_59_rtn$$ = $functionsInTableMap$$.get($func$jscomp$13$$) || 0) return $count$jscomp$inline_88_idx$jscomp$inline_51_idx$jscomp$inline_59_rtn$$;
				a: if ($freeTableIndexes$$.length) var $ret$jscomp$9$$ = $freeTableIndexes$$.pop();
				else {
					try {
						$ret$jscomp$9$$ = $wasmTable$$.grow(1);
						break a;
					} catch ($err$jscomp$inline_49$$) {
						if (!($err$jscomp$inline_49$$ instanceof RangeError)) throw $err$jscomp$inline_49$$;
						$abort$$("Unable to grow wasm table. Set ALLOW_TABLE_GROWTH.");
					}
					$ret$jscomp$9$$ = void 0;
				}
				try {
					$count$jscomp$inline_88_idx$jscomp$inline_51_idx$jscomp$inline_59_rtn$$ = $ret$jscomp$9$$, $wasmTable$$.set($count$jscomp$inline_88_idx$jscomp$inline_51_idx$jscomp$inline_59_rtn$$, $func$jscomp$13$$), $wasmTableMirror$$[$count$jscomp$inline_88_idx$jscomp$inline_51_idx$jscomp$inline_59_rtn$$] = $wasmTable$$.get($count$jscomp$inline_88_idx$jscomp$inline_51_idx$jscomp$inline_59_rtn$$);
				} catch ($err$jscomp$5$$) {
					if (!($err$jscomp$5$$ instanceof TypeError)) throw $err$jscomp$5$$;
					$assert$$("undefined" != typeof $bytes$jscomp$inline_56_module$jscomp$inline_57_sig$jscomp$1_wrapped$$, "Missing signature argument to addFunction: " + $func$jscomp$13$$);
					$bytes$jscomp$inline_56_module$jscomp$inline_57_sig$jscomp$1_wrapped$$ = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1, ...$uleb128EncodeWithLen$$([
						1,
						96,
						...$generateTypePack$$($bytes$jscomp$inline_56_module$jscomp$inline_57_sig$jscomp$1_wrapped$$.slice(1)),
						...$generateTypePack$$("v" === $bytes$jscomp$inline_56_module$jscomp$inline_57_sig$jscomp$1_wrapped$$[0] ? "" : $bytes$jscomp$inline_56_module$jscomp$inline_57_sig$jscomp$1_wrapped$$[0])
					]), 2, 7, 1, 1, 101, 1, 102, 0, 0, 7, 5, 1, 1, 102, 0, 0);
					$bytes$jscomp$inline_56_module$jscomp$inline_57_sig$jscomp$1_wrapped$$ = new WebAssembly.Module($bytes$jscomp$inline_56_module$jscomp$inline_57_sig$jscomp$1_wrapped$$);
					$bytes$jscomp$inline_56_module$jscomp$inline_57_sig$jscomp$1_wrapped$$ = new WebAssembly.Instance($bytes$jscomp$inline_56_module$jscomp$inline_57_sig$jscomp$1_wrapped$$, { e: { f: $func$jscomp$13$$ } }).exports.f;
					$count$jscomp$inline_88_idx$jscomp$inline_51_idx$jscomp$inline_59_rtn$$ = $ret$jscomp$9$$;
					$wasmTable$$.set($count$jscomp$inline_88_idx$jscomp$inline_51_idx$jscomp$inline_59_rtn$$, $bytes$jscomp$inline_56_module$jscomp$inline_57_sig$jscomp$1_wrapped$$);
					$wasmTableMirror$$[$count$jscomp$inline_88_idx$jscomp$inline_51_idx$jscomp$inline_59_rtn$$] = $wasmTable$$.get($count$jscomp$inline_88_idx$jscomp$inline_51_idx$jscomp$inline_59_rtn$$);
				}
				$functionsInTableMap$$.set($func$jscomp$13$$, $ret$jscomp$9$$);
				return $ret$jscomp$9$$;
			};
			"writeI53ToI64 writeI53ToI64Clamped writeI53ToI64Signaling writeI53ToU64Clamped writeI53ToU64Signaling readI53FromI64 readI53FromU64 convertI32PairToI53 convertI32PairToI53Checked convertU32PairToI53 getTempRet0 setTempRet0 createNamedFunction zeroMemory withStackSave strError inetPton4 inetNtop4 inetPton6 inetNtop6 readSockaddr writeSockaddr runMainThreadEmAsm jstoi_q autoResumeAudioContext getDynCaller dynCall runtimeKeepalivePush runtimeKeepalivePop callUserCallback maybeExit asyncLoad asmjsMangle mmapAlloc HandleAllocator getUniqueRunDependency addRunDependency removeRunDependency addOnInit addOnPostCtor addOnPreMain addOnExit STACK_SIZE STACK_ALIGN POINTER_SIZE ASSERTIONS cwrap removeFunction intArrayFromString intArrayToString AsciiToString stringToAscii UTF16ToString stringToUTF16 lengthBytesUTF16 UTF32ToString stringToUTF32 lengthBytesUTF32 registerKeyEventCallback maybeCStringToJsString findEventTarget getBoundingClientRect fillMouseEventData registerMouseEventCallback registerWheelEventCallback registerUiEventCallback registerFocusEventCallback fillDeviceOrientationEventData registerDeviceOrientationEventCallback fillDeviceMotionEventData registerDeviceMotionEventCallback screenOrientation fillOrientationChangeEventData registerOrientationChangeEventCallback fillFullscreenChangeEventData registerFullscreenChangeEventCallback JSEvents_requestFullscreen JSEvents_resizeCanvasForFullscreen registerRestoreOldStyle hideEverythingExceptGivenElement restoreHiddenElements setLetterbox softFullscreenResizeWebGLRenderTarget doRequestFullscreen fillPointerlockChangeEventData registerPointerlockChangeEventCallback registerPointerlockErrorEventCallback requestPointerLock fillVisibilityChangeEventData registerVisibilityChangeEventCallback registerTouchEventCallback fillGamepadEventData registerGamepadEventCallback registerBeforeUnloadEventCallback fillBatteryEventData registerBatteryEventCallback setCanvasElementSize getCanvasElementSize getCallstack convertPCtoSourceLocation wasiRightsToMuslOFlags wasiOFlagsToMuslOFlags initRandomFill randomFill safeSetTimeout setImmediateWrapped safeRequestAnimationFrame clearImmediateWrapped registerPostMainLoop registerPreMainLoop getPromise makePromise idsToPromises makePromiseCallback ExceptionInfo findMatchingCatch Browser_asyncPrepareDataCounter arraySum addDays getSocketFromFD getSocketAddress heapObjectForWebGLType toTypedArrayIndex webgl_enable_ANGLE_instanced_arrays webgl_enable_OES_vertex_array_object webgl_enable_WEBGL_draw_buffers webgl_enable_WEBGL_multi_draw webgl_enable_EXT_polygon_offset_clamp webgl_enable_EXT_clip_control webgl_enable_WEBGL_polygon_mode emscriptenWebGLGet computeUnpackAlignedImageSize colorChannelsInGlTextureFormat emscriptenWebGLGetTexPixelData emscriptenWebGLGetUniform webglGetUniformLocation webglPrepareUniformLocationsBeforeFirstUse webglGetLeftBracePos emscriptenWebGLGetVertexAttrib __glGetActiveAttribOrUniform writeGLArray registerWebGlEventCallback runAndAbortIfError ALLOC_NORMAL ALLOC_STACK allocate writeStringToMemory writeAsciiToMemory allocateUTF8 allocateUTF8OnStack demangle stackTrace getNativeTypeSize".split(" ").forEach(function($sym$jscomp$2$$) {
				$unexportedRuntimeSymbol$$($sym$jscomp$2$$);
			});
			"run out err abort wasmExports HEAPF32 HEAPF64 HEAP8 HEAP16 HEAPU16 HEAP32 HEAPU32 HEAP64 HEAPU64 writeStackCookie checkStackCookie INT53_MAX INT53_MIN bigintToI53Checked stackSave stackRestore stackAlloc ptrToString exitJS getHeapMax growMemory ENV ERRNO_CODES DNS Protocols Sockets timers warnOnce readEmAsmArgsArray readEmAsmArgs runEmAsmFunction getExecutableName handleException keepRuntimeAlive alignMemory wasmTable wasmMemory noExitRuntime addOnPreRun addOnPostRun convertJsFunctionToWasm freeTableIndexes functionsInTableMap getEmptyTableSlot updateTableMap getFunctionAddress setValue getValue PATH PATH_FS UTF8Decoder UTF8ArrayToString UTF8ToString stringToUTF8Array stringToUTF8 lengthBytesUTF8 UTF16Decoder stringToNewUTF8 stringToUTF8OnStack writeArrayToMemory JSEvents specialHTMLTargets findCanvasEventTarget currentFullscreenStrategy restoreOldWindowedStyle jsStackTrace UNWIND_CACHE ExitStatus getEnvStrings checkWasiClock flush_NO_FILESYSTEM emSetImmediate emClearImmediate_deps emClearImmediate promiseMap uncaughtExceptionCount exceptionLast exceptionCaught Browser requestFullscreen requestFullScreen setCanvasSize getUserMedia createContext getPreloadedImageData__data wget MONTH_DAYS_REGULAR MONTH_DAYS_LEAP MONTH_DAYS_REGULAR_CUMULATIVE MONTH_DAYS_LEAP_CUMULATIVE isLeapYear ydayFromDate SYSCALLS tempFixedLengthArray miniTempWebGLFloatBuffers miniTempWebGLIntBuffers GL AL GLUT EGL GLEW IDBStore SDL SDL_gfx print printErr jstoi_s".split(" ").forEach($unexportedRuntimeSymbol$$);
			var $ASM_CONSTS$$ = { 4864548: () => "undefined" !== typeof wasmOffsetConverter }, $_free$$ = $makeInvalidEarlyAccess$$("_free");
			$Module$$._trace_processor_rpc_init = $makeInvalidEarlyAccess$$("_trace_processor_rpc_init");
			$Module$$._trace_processor_on_rpc_request = $makeInvalidEarlyAccess$$("_trace_processor_on_rpc_request");
			var $_main$$ = $Module$$._main = $makeInvalidEarlyAccess$$("_main"), $_malloc$$ = $makeInvalidEarlyAccess$$("_malloc"), $_fflush$$ = $makeInvalidEarlyAccess$$("_fflush");
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
			var $_emscripten_stack_get_end$$ = $makeInvalidEarlyAccess$$("_emscripten_stack_get_end"), $_emscripten_stack_init$$ = $makeInvalidEarlyAccess$$("_emscripten_stack_init"), $__emscripten_stack_restore$$ = $makeInvalidEarlyAccess$$("__emscripten_stack_restore"), $__emscripten_stack_alloc$$ = $makeInvalidEarlyAccess$$("__emscripten_stack_alloc"), $_emscripten_stack_get_current$$ = $makeInvalidEarlyAccess$$("_emscripten_stack_get_current"), $wasmMemory$$ = $makeInvalidEarlyAccess$$("wasmMemory"), $wasmTable$$ = $makeInvalidEarlyAccess$$("wasmTable"), $wasmImports$$ = {
				HaveOffsetConverter: function() {
					return "undefined" !== typeof wasmOffsetConverter;
				},
				__syscall_chmod: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_faccessat: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_fchmod: () => {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_fchown32: () => {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_fcntl64: function() {
					return 0;
				},
				__syscall_fstat64: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_ftruncate64: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_getcwd: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_ioctl: function() {
					return 0;
				},
				__syscall_lstat64: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_mkdirat: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_newfstatat: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_openat: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_readlinkat: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_rmdir: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_stat64: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_unlinkat: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
				},
				__syscall_utimensat: function() {
					$abort$$("it should not be possible to operate on streams when !SYSCALLS_REQUIRE_FILESYSTEM");
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
					var $summerOffset_year$jscomp$inline_92$$ = $date$jscomp$5_time$jscomp$1$$.getFullYear();
					$HEAP32$$[$tmPtr$jscomp$1$$ + 28 >>> 2 >>> 0] = (0 !== $summerOffset_year$jscomp$inline_92$$ % 4 || 0 === $summerOffset_year$jscomp$inline_92$$ % 100 && 0 !== $summerOffset_year$jscomp$inline_92$$ % 400 ? $MONTH_DAYS_REGULAR_CUMULATIVE$$ : $MONTH_DAYS_LEAP_CUMULATIVE$$)[$date$jscomp$5_time$jscomp$1$$.getMonth()] + $date$jscomp$5_time$jscomp$1$$.getDate() - 1 | 0;
					$HEAP32$$[$tmPtr$jscomp$1$$ + 36 >>> 2 >>> 0] = -(60 * $date$jscomp$5_time$jscomp$1$$.getTimezoneOffset());
					$summerOffset_year$jscomp$inline_92$$ = new Date($date$jscomp$5_time$jscomp$1$$.getFullYear(), 6, 1).getTimezoneOffset();
					var $winterOffset$$ = new Date($date$jscomp$5_time$jscomp$1$$.getFullYear(), 0, 1).getTimezoneOffset();
					$HEAP32$$[$tmPtr$jscomp$1$$ + 32 >>> 2 >>> 0] = ($summerOffset_year$jscomp$inline_92$$ != $winterOffset$$ && $date$jscomp$5_time$jscomp$1$$.getTimezoneOffset() == Math.min($winterOffset$$, $summerOffset_year$jscomp$inline_92$$)) | 0;
				},
				_mmap_js: function() {
					return -52;
				},
				_munmap_js: function() {},
				_timegm_js: function($tmPtr$jscomp$2$$) {
					$tmPtr$jscomp$2$$ >>>= 0;
					var $date$jscomp$inline_62$$ = new Date(Date.UTC($HEAP32$$[$tmPtr$jscomp$2$$ + 20 >>> 2 >>> 0] + 1900, $HEAP32$$[$tmPtr$jscomp$2$$ + 16 >>> 2 >>> 0], $HEAP32$$[$tmPtr$jscomp$2$$ + 12 >>> 2 >>> 0], $HEAP32$$[$tmPtr$jscomp$2$$ + 8 >>> 2 >>> 0], $HEAP32$$[$tmPtr$jscomp$2$$ + 4 >>> 2 >>> 0], $HEAP32$$[$tmPtr$jscomp$2$$ >>> 2 >>> 0], 0));
					$HEAP32$$[$tmPtr$jscomp$2$$ + 24 >>> 2 >>> 0] = $date$jscomp$inline_62$$.getUTCDay();
					$HEAP32$$[$tmPtr$jscomp$2$$ + 28 >>> 2 >>> 0] = ($date$jscomp$inline_62$$.getTime() - Date.UTC($date$jscomp$inline_62$$.getUTCFullYear(), 0, 1, 0, 0, 0, 0)) / 864e5 | 0;
					return BigInt($date$jscomp$inline_62$$.getTime() / 1e3);
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
				emscripten_asm_const_int: function($code$jscomp$3_code$jscomp$inline_64$$, $sigPtr$jscomp$2_sigPtr$jscomp$inline_94$$, $argbuf$jscomp$1_buf$jscomp$inline_95$$) {
					$code$jscomp$3_code$jscomp$inline_64$$ >>>= 0;
					$sigPtr$jscomp$2_sigPtr$jscomp$inline_94$$ >>>= 0;
					$argbuf$jscomp$1_buf$jscomp$inline_95$$ >>>= 0;
					$assert$$(Array.isArray($readEmAsmArgsArray$$));
					$assert$$(0 == $argbuf$jscomp$1_buf$jscomp$inline_95$$ % 16);
					$readEmAsmArgsArray$$.length = 0;
					for (var $ch$jscomp$inline_96$$; $ch$jscomp$inline_96$$ = $HEAPU8$$[$sigPtr$jscomp$2_sigPtr$jscomp$inline_94$$++ >>> 0];) {
						var $chr$jscomp$inline_97_wide$jscomp$inline_99$$ = String.fromCharCode($ch$jscomp$inline_96$$), $validChars$jscomp$inline_98$$ = [
							"d",
							"f",
							"i",
							"p"
						];
						$validChars$jscomp$inline_98$$.push("j");
						$assert$$($validChars$jscomp$inline_98$$.includes($chr$jscomp$inline_97_wide$jscomp$inline_99$$), `Invalid character ${$ch$jscomp$inline_96$$}("${$chr$jscomp$inline_97_wide$jscomp$inline_99$$}") in readEmAsmArgs! Use only [${$validChars$jscomp$inline_98$$}], and do not specify "v" for void return argument.`);
						$chr$jscomp$inline_97_wide$jscomp$inline_99$$ = 105 != $ch$jscomp$inline_96$$;
						$chr$jscomp$inline_97_wide$jscomp$inline_99$$ &= 112 != $ch$jscomp$inline_96$$;
						$argbuf$jscomp$1_buf$jscomp$inline_95$$ += $chr$jscomp$inline_97_wide$jscomp$inline_99$$ && $argbuf$jscomp$1_buf$jscomp$inline_95$$ % 8 ? 4 : 0;
						$readEmAsmArgsArray$$.push(112 == $ch$jscomp$inline_96$$ ? $HEAPU32$$[$argbuf$jscomp$1_buf$jscomp$inline_95$$ >>> 2 >>> 0] : 106 == $ch$jscomp$inline_96$$ ? $HEAP64$$[$argbuf$jscomp$1_buf$jscomp$inline_95$$ >>> 3 >>> 0] : 105 == $ch$jscomp$inline_96$$ ? $HEAP32$$[$argbuf$jscomp$1_buf$jscomp$inline_95$$ >>> 2 >>> 0] : $HEAPF64$$[$argbuf$jscomp$1_buf$jscomp$inline_95$$ >>> 3 >>> 0]);
						$argbuf$jscomp$1_buf$jscomp$inline_95$$ += $chr$jscomp$inline_97_wide$jscomp$inline_99$$ ? 8 : 4;
					}
					$assert$$($ASM_CONSTS$$.hasOwnProperty($code$jscomp$3_code$jscomp$inline_64$$), `No EM_ASM constant found at address ${$code$jscomp$3_code$jscomp$inline_64$$}.  The loaded WebAssembly file is likely out of sync with the generated JavaScript.`);
					return $ASM_CONSTS$$[$code$jscomp$3_code$jscomp$inline_64$$](...$readEmAsmArgsArray$$);
				},
				emscripten_date_now: () => Date.now(),
				emscripten_err: function($str$jscomp$11$$) {
					return $err$$($UTF8ToString$$($str$jscomp$11$$ >>> 0));
				},
				emscripten_errn: function($str$jscomp$12$$, $len$jscomp$3$$) {
					return $err$$($UTF8ToString$$($str$jscomp$12$$ >>> 0, $len$jscomp$3$$ >>> 0));
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
						var $oldHeapSize$jscomp$inline_73_overGrownHeapSize_size$jscomp$inline_69$$ = $oldSize$$ * (1 + .2 / $cutDown$$);
						$oldHeapSize$jscomp$inline_73_overGrownHeapSize_size$jscomp$inline_69$$ = Math.min($oldHeapSize$jscomp$inline_73_overGrownHeapSize_size$jscomp$inline_69$$, $requestedSize$$ + 100663296);
						var $JSCompiler_temp_const$jscomp$6_newSize$jscomp$1$$ = Math, $JSCompiler_temp_const$jscomp$5_size$jscomp$inline_72$$ = $JSCompiler_temp_const$jscomp$6_newSize$jscomp$1$$.min;
						$oldHeapSize$jscomp$inline_73_overGrownHeapSize_size$jscomp$inline_69$$ = Math.max($requestedSize$$, $oldHeapSize$jscomp$inline_73_overGrownHeapSize_size$jscomp$inline_69$$);
						$assert$$(65536, "alignment argument is required");
						$JSCompiler_temp_const$jscomp$6_newSize$jscomp$1$$ = $JSCompiler_temp_const$jscomp$5_size$jscomp$inline_72$$.call($JSCompiler_temp_const$jscomp$6_newSize$jscomp$1$$, 4294901760, 65536 * Math.ceil($oldHeapSize$jscomp$inline_73_overGrownHeapSize_size$jscomp$inline_69$$ / 65536));
						a: {
							$JSCompiler_temp_const$jscomp$5_size$jscomp$inline_72$$ = $JSCompiler_temp_const$jscomp$6_newSize$jscomp$1$$;
							$oldHeapSize$jscomp$inline_73_overGrownHeapSize_size$jscomp$inline_69$$ = $wasmMemory$$.buffer.byteLength;
							try {
								$wasmMemory$$.grow(($JSCompiler_temp_const$jscomp$5_size$jscomp$inline_72$$ - $oldHeapSize$jscomp$inline_73_overGrownHeapSize_size$jscomp$inline_69$$ + 65535) / 65536 | 0);
								$updateMemoryViews$$();
								var $JSCompiler_inline_result$jscomp$8$$ = 1;
								break a;
							} catch ($e$jscomp$inline_75$$) {
								$err$$(`growMemory: Attempted to grow heap from ${$oldHeapSize$jscomp$inline_73_overGrownHeapSize_size$jscomp$inline_69$$} bytes to ${$JSCompiler_temp_const$jscomp$5_size$jscomp$inline_72$$} bytes, but got error: ${$e$jscomp$inline_75$$}`);
							}
							$JSCompiler_inline_result$jscomp$8$$ = void 0;
						}
						if ($JSCompiler_inline_result$jscomp$8$$) return !0;
					}
					$err$$(`Failed to grow the heap from ${$oldSize$$} bytes to ${$JSCompiler_temp_const$jscomp$6_newSize$jscomp$1$$} bytes, not enough memory!`);
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
				emscripten_stack_unwind_buffer: function($addr$jscomp$2_i$jscomp$6$$, $buffer$jscomp$18$$, $count$jscomp$39$$) {
					$addr$jscomp$2_i$jscomp$6$$ >>>= 0;
					$buffer$jscomp$18$$ >>>= 0;
					if ($UNWIND_CACHE$$.$last_addr$ == $addr$jscomp$2_i$jscomp$6$$) var $stack$$ = $UNWIND_CACHE$$.$last_stack$;
					else $stack$$ = Error().stack.toString().split("\n"), "Error" == $stack$$[0] && $stack$$.shift(), $saveInUnwindCache$$($stack$$);
					for (var $offset$jscomp$28$$ = 3; $stack$$[$offset$jscomp$28$$] && $convertFrameToPC$$($stack$$[$offset$jscomp$28$$]) != $addr$jscomp$2_i$jscomp$6$$;) ++$offset$jscomp$28$$;
					for ($addr$jscomp$2_i$jscomp$6$$ = 0; $addr$jscomp$2_i$jscomp$6$$ < $count$jscomp$39$$ && $stack$$[$addr$jscomp$2_i$jscomp$6$$ + $offset$jscomp$28$$]; ++$addr$jscomp$2_i$jscomp$6$$) $HEAP32$$[$buffer$jscomp$18$$ + 4 * $addr$jscomp$2_i$jscomp$6$$ >>> 2 >>> 0] = $convertFrameToPC$$($stack$$[$addr$jscomp$2_i$jscomp$6$$ + $offset$jscomp$28$$]);
					return $addr$jscomp$2_i$jscomp$6$$;
				},
				environ_get: function($__environ$$, $environ_buf$$) {
					$__environ$$ >>>= 0;
					$environ_buf$$ >>>= 0;
					var $bufSize$$ = 0, $envp$$ = 0, $string$jscomp$3$$;
					for ($string$jscomp$3$$ of $getEnvStrings$$()) {
						var $ptr$jscomp$3$$ = $environ_buf$$ + $bufSize$$;
						$HEAPU32$$[$__environ$$ + $envp$$ >>> 2 >>> 0] = $ptr$jscomp$3$$;
						$bufSize$$ += $stringToUTF8$$($string$jscomp$3$$, $ptr$jscomp$3$$, Infinity) + 1;
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
				fd_close: () => {
					$abort$$("fd_close called without SYSCALLS_REQUIRE_FILESYSTEM");
				},
				fd_fdstat_get: function($fd$jscomp$9$$, $pbuf$$) {
					$pbuf$$ >>>= 0;
					var $rightsBase$$ = 0;
					$assert$$(0 == $fd$jscomp$9$$ || 1 == $fd$jscomp$9$$ || 2 == $fd$jscomp$9$$);
					if (0 == $fd$jscomp$9$$) $rightsBase$$ = 2;
					else if (1 == $fd$jscomp$9$$ || 2 == $fd$jscomp$9$$) $rightsBase$$ = 64;
					$HEAP8$$[$pbuf$$ >>> 0] = 2;
					$HEAP16$$[$pbuf$$ + 2 >>> 1 >>> 0] = 1;
					$HEAP64$$[$pbuf$$ + 8 >>> 3 >>> 0] = BigInt($rightsBase$$);
					$HEAP64$$[$pbuf$$ + 16 >>> 3 >>> 0] = BigInt(0);
					return 0;
				},
				fd_read: function() {
					$abort$$("fd_read called without SYSCALLS_REQUIRE_FILESYSTEM");
				},
				fd_seek: function() {
					return 70;
				},
				fd_sync: () => {
					$abort$$("fd_sync called without SYSCALLS_REQUIRE_FILESYSTEM");
					return 52;
				},
				fd_write: function($fd$jscomp$13$$, $iov$jscomp$1$$, $iovcnt$jscomp$1$$, $pnum$jscomp$1$$) {
					$iov$jscomp$1$$ >>>= 0;
					$iovcnt$jscomp$1$$ >>>= 0;
					$pnum$jscomp$1$$ >>>= 0;
					for (var $num$jscomp$7$$ = 0, $i$jscomp$7$$ = 0; $i$jscomp$7$$ < $iovcnt$jscomp$1$$; $i$jscomp$7$$++) {
						var $ptr$jscomp$4$$ = $HEAPU32$$[$iov$jscomp$1$$ >>> 2 >>> 0], $len$jscomp$4$$ = $HEAPU32$$[$iov$jscomp$1$$ + 4 >>> 2 >>> 0];
						$iov$jscomp$1$$ += 8;
						for (var $j$$ = 0; $j$$ < $len$jscomp$4$$; $j$$++) $printChar$$($fd$jscomp$13$$, $HEAPU8$$[$ptr$jscomp$4$$ + $j$$ >>> 0]);
						$num$jscomp$7$$ += $len$jscomp$4$$;
					}
					$HEAPU32$$[$pnum$jscomp$1$$ >>> 2 >>> 0] = $num$jscomp$7$$;
					return 0;
				},
				proc_exit: $_proc_exit$$
			};
			function $applySignatureConversions$$() {
				var $wasmExports$jscomp$2$$ = $wasmExports$$;
				$wasmExports$jscomp$2$$ = Object.assign({}, $wasmExports$jscomp$2$$);
				var $makeWrapper_pp$$ = ($f$jscomp$2$$) => ($a0$$) => $f$jscomp$2$$($a0$$) >>> 0, $makeWrapper_p$$ = ($f$jscomp$3$$) => () => $f$jscomp$3$$() >>> 0;
				$wasmExports$jscomp$2$$.malloc = $makeWrapper_pp$$($wasmExports$jscomp$2$$.malloc);
				$wasmExports$jscomp$2$$.emscripten_stack_get_end = $makeWrapper_p$$($wasmExports$jscomp$2$$.emscripten_stack_get_end);
				$wasmExports$jscomp$2$$.emscripten_stack_get_base = $makeWrapper_p$$($wasmExports$jscomp$2$$.emscripten_stack_get_base);
				$wasmExports$jscomp$2$$._emscripten_stack_alloc = $makeWrapper_pp$$($wasmExports$jscomp$2$$._emscripten_stack_alloc);
				$wasmExports$jscomp$2$$.emscripten_stack_get_current = $makeWrapper_p$$($wasmExports$jscomp$2$$.emscripten_stack_get_current);
				return $wasmExports$jscomp$2$$;
			}
			var $calledRun$$;
			function $callMain$$($JSCompiler_inline_result$jscomp$9_args$jscomp$6_e$jscomp$inline_77$$ = []) {
				$assert$$("undefined" === typeof $onPreRuns$$ || 0 == $onPreRuns$$.length, "cannot call main when preRun functions remain to be called");
				var $entryFunction$$ = $_main$$;
				$JSCompiler_inline_result$jscomp$9_args$jscomp$6_e$jscomp$inline_77$$.unshift($thisProgram$$);
				var $argc$$ = $JSCompiler_inline_result$jscomp$9_args$jscomp$6_e$jscomp$inline_77$$.length, $argv$$ = $__emscripten_stack_alloc$$(4 * ($argc$$ + 1)), $argv_ptr$$ = $argv$$, $arg$jscomp$8$$;
				for ($arg$jscomp$8$$ of $JSCompiler_inline_result$jscomp$9_args$jscomp$6_e$jscomp$inline_77$$) $HEAPU32$$[$argv_ptr$$ >>> 2 >>> 0] = $stringToUTF8OnStack$$($arg$jscomp$8$$), $argv_ptr$$ += 4;
				$HEAPU32$$[$argv_ptr$$ >>> 2 >>> 0] = 0;
				try {
					var $ret$jscomp$10$$ = $entryFunction$$($argc$$, $argv$$);
					$exitJS$$($ret$jscomp$10$$, !0);
					return $ret$jscomp$10$$;
				} catch ($e$jscomp$11$$) {
					$JSCompiler_inline_result$jscomp$9_args$jscomp$6_e$jscomp$inline_77$$ = $e$jscomp$11$$;
					if ($JSCompiler_inline_result$jscomp$9_args$jscomp$6_e$jscomp$inline_77$$ instanceof $ExitStatus$$ || "unwind" == $JSCompiler_inline_result$jscomp$9_args$jscomp$6_e$jscomp$inline_77$$) $JSCompiler_inline_result$jscomp$9_args$jscomp$6_e$jscomp$inline_77$$ = $EXITSTATUS$$;
					else throw $checkStackCookie$$(), $JSCompiler_inline_result$jscomp$9_args$jscomp$6_e$jscomp$inline_77$$ instanceof WebAssembly.RuntimeError && 0 >= $_emscripten_stack_get_current$$() && $err$$("Stack overflow detected.  You can try increasing -sSTACK_SIZE (currently set to 2097152)"), $JSCompiler_inline_result$jscomp$9_args$jscomp$6_e$jscomp$inline_77$$;
					return $JSCompiler_inline_result$jscomp$9_args$jscomp$6_e$jscomp$inline_77$$;
				}
			}
			function $checkUnflushedContent$$() {
				var $oldOut$$ = $out$$, $oldErr$$ = $err$$, $has$$ = !1;
				$out$$ = $err$$ = () => {
					$has$$ = !0;
				};
				try {
					$_fflush$$(0), $printCharBuffers$$[1].length && $printChar$$(1, 10), $printCharBuffers$$[2].length && $printChar$$(2, 10);
				} catch ($e$jscomp$12$$) {}
				$out$$ = $oldOut$$;
				$err$$ = $oldErr$$;
				$has$$ && ($warnOnce$$("stdio streams had content in them that was not flushed. you should set EXIT_RUNTIME to 1 (see the Emscripten FAQ), or make sure to emit a newline when you printf etc."), $warnOnce$$("(this may also be due to not including full filesystem support - try building with -sFORCE_FILESYSTEM)"));
			}
			var $wasmExports$$ = await async function() {
				function $receiveInstance$$($instance$jscomp$1_wasmExports$jscomp$inline_80$$) {
					$wasmExports$$ = $instance$jscomp$1_wasmExports$jscomp$inline_80$$.exports;
					$instance$jscomp$1_wasmExports$jscomp$inline_80$$ = $wasmExports$$ = $applySignatureConversions$$();
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.free, "missing Wasm export: free");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.trace_processor_rpc_init, "missing Wasm export: trace_processor_rpc_init");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.trace_processor_on_rpc_request, "missing Wasm export: trace_processor_on_rpc_request");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.__main_argc_argv, "missing Wasm export: __main_argc_argv");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.malloc, "missing Wasm export: malloc");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.fflush, "missing Wasm export: fflush");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.SynqPerfettoParseAlloc, "missing Wasm export: SynqPerfettoParseAlloc");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.SynqPerfettoParseFree, "missing Wasm export: SynqPerfettoParseFree");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.SynqPerfettoParse, "missing Wasm export: SynqPerfettoParse");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.synq_extent_on_shift, "missing Wasm export: synq_extent_on_shift");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.SynqPerfettoGetToken, "missing Wasm export: SynqPerfettoGetToken");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.synq_extent_on_reduce, "missing Wasm export: synq_extent_on_reduce");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.synq_extent_fold_below_into_top, "missing Wasm export: synq_extent_fold_below_into_top");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.SynqPerfettoParseInit, "missing Wasm export: SynqPerfettoParseInit");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.SynqPerfettoParseFinalize, "missing Wasm export: SynqPerfettoParseFinalize");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.SynqPerfettoParseFallback, "missing Wasm export: SynqPerfettoParseFallback");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.SynqPerfettoParseExpectedTokens, "missing Wasm export: SynqPerfettoParseExpectedTokens");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.SynqPerfettoParseCompletionContext, "missing Wasm export: SynqPerfettoParseCompletionContext");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.emscripten_stack_get_end, "missing Wasm export: emscripten_stack_get_end");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.emscripten_stack_get_base, "missing Wasm export: emscripten_stack_get_base");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.emscripten_stack_init, "missing Wasm export: emscripten_stack_init");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.emscripten_stack_get_free, "missing Wasm export: emscripten_stack_get_free");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$._emscripten_stack_restore, "missing Wasm export: _emscripten_stack_restore");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$._emscripten_stack_alloc, "missing Wasm export: _emscripten_stack_alloc");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.emscripten_stack_get_current, "missing Wasm export: emscripten_stack_get_current");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.memory, "missing Wasm export: memory");
					$assert$$("undefined" != typeof $instance$jscomp$1_wasmExports$jscomp$inline_80$$.__indirect_function_table, "missing Wasm export: __indirect_function_table");
					$_free$$ = $createExportWrapper$$("free", 1);
					$Module$$._trace_processor_rpc_init = $createExportWrapper$$("trace_processor_rpc_init", 2);
					$Module$$._trace_processor_on_rpc_request = $createExportWrapper$$("trace_processor_on_rpc_request", 1);
					$_main$$ = $Module$$._main = $createExportWrapper$$("__main_argc_argv", 2);
					$_malloc$$ = $createExportWrapper$$("malloc", 1);
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
					$_emscripten_stack_get_end$$ = $instance$jscomp$1_wasmExports$jscomp$inline_80$$.emscripten_stack_get_end;
					$_emscripten_stack_init$$ = $instance$jscomp$1_wasmExports$jscomp$inline_80$$.emscripten_stack_init;
					$__emscripten_stack_restore$$ = $instance$jscomp$1_wasmExports$jscomp$inline_80$$._emscripten_stack_restore;
					$__emscripten_stack_alloc$$ = $instance$jscomp$1_wasmExports$jscomp$inline_80$$._emscripten_stack_alloc;
					$_emscripten_stack_get_current$$ = $instance$jscomp$1_wasmExports$jscomp$inline_80$$.emscripten_stack_get_current;
					$wasmMemory$$ = $instance$jscomp$1_wasmExports$jscomp$inline_80$$.memory;
					$wasmTable$$ = $instance$jscomp$1_wasmExports$jscomp$inline_80$$.__indirect_function_table;
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
				$wasmBinaryFile$$ ??= $Module$$.locateFile ? $Module$$.locateFile("trace_processor.wasm", $scriptDirectory$$) : $scriptDirectory$$ + "trace_processor.wasm";
				return function($result$jscomp$2$$) {
					$assert$$($Module$$ === $trueModule$$, "the Module object should not be replaced during async compilation - perhaps the order of HTML elements is wrong?");
					$trueModule$$ = null;
					return $receiveInstance$$($result$jscomp$2$$.instance);
				}(await $instantiateAsync$$($info$$));
			}();
			(function($args$jscomp$7$$ = $arguments_$$) {
				function $doRun$$() {
					$assert$$(!$calledRun$$);
					$calledRun$$ = !0;
					$Module$$.calledRun = !0;
					if (!$ABORT$$) {
						$assert$$(!$runtimeInitialized$$);
						$runtimeInitialized$$ = !0;
						$checkStackCookie$$();
						$wasmExports$$.__wasm_call_ctors();
						$checkStackCookie$$();
						$readyPromiseResolve$$?.($Module$$);
						$Module$$.onRuntimeInitialized?.();
						$consumedModuleProp$$("onRuntimeInitialized");
						$Module$$.noInitialRun || $callMain$$($args$jscomp$7$$);
						$checkStackCookie$$();
						if ($Module$$.postRun) for ("function" == typeof $Module$$.postRun && ($Module$$.postRun = [$Module$$.postRun]); $Module$$.postRun.length;) {
							var $cb$jscomp$inline_103$$ = $Module$$.postRun.shift();
							$onPostRuns$$.push($cb$jscomp$inline_103$$);
						}
						$consumedModuleProp$$("postRun");
						$callRuntimeCallbacks$$($onPostRuns$$);
					}
				}
				$_emscripten_stack_init$$();
				$writeStackCookie$$();
				if ($Module$$.preRun) for ("function" == typeof $Module$$.preRun && ($Module$$.preRun = [$Module$$.preRun]); $Module$$.preRun.length;) $addOnPreRun$$();
				$consumedModuleProp$$("preRun");
				$callRuntimeCallbacks$$($onPreRuns$$);
				$Module$$.setStatus ? ($Module$$.setStatus("Running..."), setTimeout(() => {
					setTimeout(() => $Module$$.setStatus(""), 1);
					$doRun$$();
				}, 1)) : $doRun$$();
				$checkStackCookie$$();
			})();
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
		}
		if (typeof exports === "object" && typeof module === "object") {
			module.exports = trace_processor_wasm;
			module.exports.default = trace_processor_wasm;
		} else if (typeof define === "function" && define["amd"]) define([], () => trace_processor_wasm);
	}));
	//#endregion
	//#region ../../ui/src/trace_processor/wasm_modules.ts
	var import_trace_processor_memory64 = /* @__PURE__ */ __toESM(require_trace_processor_memory64());
	var import_trace_processor = /* @__PURE__ */ __toESM(require_trace_processor());
	var memory64SupportCache;
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
	//#endregion
	//#region ../../ui/src/engine/wasm_bridge.ts
	var REQ_BUF_SIZE = 32 * 1024 * 1024;
	var WasmBridge = class {
		aborted = false;
		connection;
		reqBufferAddr = 0;
		lastStderr = [];
		messagePort;
		useMemory64 = false;
		async initialize(port, precompiledModule) {
			assertTrue(this.messagePort === void 0);
			this.messagePort = port;
			this.useMemory64 = memory64Supported();
			const connection = await (this.useMemory64 ? import_trace_processor_memory64.default : import_trace_processor.default)({
				locateFile: (s) => s,
				print: (line) => console.log(line),
				printErr: (line) => this.appendAndLogErr(line),
				onRuntimeInitialized: () => {},
				instantiateWasm: (imports, successCallback) => {
					const instance = new WebAssembly.Instance(precompiledModule, imports);
					successCallback(instance, precompiledModule);
					return instance.exports;
				}
			});
			const fn = connection.addFunction(this.onReply.bind(this), "vpi");
			this.reqBufferAddr = this.wasmPtrCast(connection.ccall("trace_processor_rpc_init", "pointer", ["pointer", "number"], [fn, REQ_BUF_SIZE]));
			this.connection = connection;
			port.onmessage = this.onMessage.bind(this);
		}
		onMessage(msg) {
			if (this.aborted) throw new Error("Wasm module crashed");
			const connection = ensureExists(this.connection);
			assertTrue(msg.data instanceof Uint8Array);
			const data = msg.data;
			let wrSize = 0;
			while (wrSize < data.length) {
				const sliceLen = Math.min(data.length - wrSize, REQ_BUF_SIZE);
				const dataSlice = data.subarray(wrSize, wrSize + sliceLen);
				connection.HEAPU8.set(dataSlice, this.reqBufferAddr);
				wrSize += sliceLen;
				try {
					connection.ccall("trace_processor_on_rpc_request", "void", ["number"], [sliceLen]);
				} catch (err) {
					this.aborted = true;
					let abortReason = `${err}`;
					if (err instanceof Error) abortReason = `${err.name}: ${err.message}\n${err.stack}`;
					abortReason += "\n\nstderr: \n" + this.lastStderr.join("\n");
					throw new Error(abortReason);
				}
			}
		}
		onReply(heapPtrArg, size) {
			const heapPtr = this.wasmPtrCast(heapPtrArg);
			const data = ensureExists(this.connection).HEAPU8.slice(heapPtr, heapPtr + size);
			ensureExists(this.messagePort).postMessage(data, [data.buffer]);
		}
		appendAndLogErr(line) {
			console.warn(line);
			this.lastStderr.push(line);
			if (this.lastStderr.length > 512) this.lastStderr.shift();
		}
		wasmPtrCast(val) {
			if (this.useMemory64) return Number(val);
			assertTrue(typeof val === "number");
			return Number(val) >>> 0;
		}
	};
	//#endregion
	//#region ../../ui/src/engine/index.ts
	var selfWorker = self;
	var wasmBridge = new WasmBridge();
	selfWorker.onmessage = (msg) => {
		const data = msg.data;
		wasmBridge.initialize(data.port, data.wasmModule);
	};
	//#endregion
})();
