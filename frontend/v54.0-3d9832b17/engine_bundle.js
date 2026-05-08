var engine = (function () {
'use strict';

function getDefaultExportFromCjs (x) {
	return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, 'default') ? x['default'] : x;
}

function getAugmentedNamespace(n) {
  if (n.__esModule) return n;
  var f = n.default;
	if (typeof f == "function") {
		var a = function a () {
			if (this instanceof a) {
        return Reflect.construct(f, arguments, this.constructor);
			}
			return f.apply(this, arguments);
		};
		a.prototype = f.prototype;
  } else a = {};
  Object.defineProperty(a, '__esModule', {value: true});
	Object.keys(n).forEach(function (k) {
		var d = Object.getOwnPropertyDescriptor(n, k);
		Object.defineProperty(a, k, d.get ? d : {
			enumerable: true,
			get: function () {
				return n[k];
			}
		});
	});
	return a;
}

var engine = {};

var wasm_bridge = {};

/******************************************************************************
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
***************************************************************************** */
/* global Reflect, Promise, SuppressedError, Symbol */

var extendStatics = function(d, b) {
  extendStatics = Object.setPrototypeOf ||
      ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
      function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
  return extendStatics(d, b);
};

function __extends(d, b) {
  if (typeof b !== "function" && b !== null)
      throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
  extendStatics(d, b);
  function __() { this.constructor = d; }
  d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
}

var __assign = function() {
  __assign = Object.assign || function __assign(t) {
      for (var s, i = 1, n = arguments.length; i < n; i++) {
          s = arguments[i];
          for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p)) t[p] = s[p];
      }
      return t;
  };
  return __assign.apply(this, arguments);
};

function __rest(s, e) {
  var t = {};
  for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
      t[p] = s[p];
  if (s != null && typeof Object.getOwnPropertySymbols === "function")
      for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
          if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
              t[p[i]] = s[p[i]];
      }
  return t;
}

function __decorate(decorators, target, key, desc) {
  var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
  if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
  else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
  return c > 3 && r && Object.defineProperty(target, key, r), r;
}

function __param(paramIndex, decorator) {
  return function (target, key) { decorator(target, key, paramIndex); }
}

function __esDecorate(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
  function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
  var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
  var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
  var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
  var _, done = false;
  for (var i = decorators.length - 1; i >= 0; i--) {
      var context = {};
      for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
      for (var p in contextIn.access) context.access[p] = contextIn.access[p];
      context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
      var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
      if (kind === "accessor") {
          if (result === void 0) continue;
          if (result === null || typeof result !== "object") throw new TypeError("Object expected");
          if (_ = accept(result.get)) descriptor.get = _;
          if (_ = accept(result.set)) descriptor.set = _;
          if (_ = accept(result.init)) initializers.unshift(_);
      }
      else if (_ = accept(result)) {
          if (kind === "field") initializers.unshift(_);
          else descriptor[key] = _;
      }
  }
  if (target) Object.defineProperty(target, contextIn.name, descriptor);
  done = true;
}
function __runInitializers(thisArg, initializers, value) {
  var useValue = arguments.length > 2;
  for (var i = 0; i < initializers.length; i++) {
      value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
  }
  return useValue ? value : void 0;
}
function __propKey(x) {
  return typeof x === "symbol" ? x : "".concat(x);
}
function __setFunctionName(f, name, prefix) {
  if (typeof name === "symbol") name = name.description ? "[".concat(name.description, "]") : "";
  return Object.defineProperty(f, "name", { configurable: true, value: prefix ? "".concat(prefix, " ", name) : name });
}
function __metadata(metadataKey, metadataValue) {
  if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(metadataKey, metadataValue);
}

function __awaiter(thisArg, _arguments, P, generator) {
  function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
  return new (P || (P = Promise))(function (resolve, reject) {
      function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
      function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
      function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
      step((generator = generator.apply(thisArg, _arguments || [])).next());
  });
}

function __generator(thisArg, body) {
  var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
  return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
  function verb(n) { return function (v) { return step([n, v]); }; }
  function step(op) {
      if (f) throw new TypeError("Generator is already executing.");
      while (g && (g = 0, op[0] && (_ = 0)), _) try {
          if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
          if (y = 0, t) op = [op[0] & 2, t.value];
          switch (op[0]) {
              case 0: case 1: t = op; break;
              case 4: _.label++; return { value: op[1], done: false };
              case 5: _.label++; y = op[1]; op = [0]; continue;
              case 7: op = _.ops.pop(); _.trys.pop(); continue;
              default:
                  if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                  if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                  if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                  if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                  if (t[2]) _.ops.pop();
                  _.trys.pop(); continue;
          }
          op = body.call(thisArg, _);
      } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
      if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
  }
}

var __createBinding = Object.create ? (function(o, m, k, k2) {
  if (k2 === undefined) k2 = k;
  var desc = Object.getOwnPropertyDescriptor(m, k);
  if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
  }
  Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
  if (k2 === undefined) k2 = k;
  o[k2] = m[k];
});

function __exportStar(m, o) {
  for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(o, p)) __createBinding(o, m, p);
}

function __values(o) {
  var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
  if (m) return m.call(o);
  if (o && typeof o.length === "number") return {
      next: function () {
          if (o && i >= o.length) o = void 0;
          return { value: o && o[i++], done: !o };
      }
  };
  throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
}

function __read(o, n) {
  var m = typeof Symbol === "function" && o[Symbol.iterator];
  if (!m) return o;
  var i = m.call(o), r, ar = [], e;
  try {
      while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
  }
  catch (error) { e = { error: error }; }
  finally {
      try {
          if (r && !r.done && (m = i["return"])) m.call(i);
      }
      finally { if (e) throw e.error; }
  }
  return ar;
}

/** @deprecated */
function __spread() {
  for (var ar = [], i = 0; i < arguments.length; i++)
      ar = ar.concat(__read(arguments[i]));
  return ar;
}

/** @deprecated */
function __spreadArrays() {
  for (var s = 0, i = 0, il = arguments.length; i < il; i++) s += arguments[i].length;
  for (var r = Array(s), k = 0, i = 0; i < il; i++)
      for (var a = arguments[i], j = 0, jl = a.length; j < jl; j++, k++)
          r[k] = a[j];
  return r;
}

function __spreadArray(to, from, pack) {
  if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
      if (ar || !(i in from)) {
          if (!ar) ar = Array.prototype.slice.call(from, 0, i);
          ar[i] = from[i];
      }
  }
  return to.concat(ar || Array.prototype.slice.call(from));
}

function __await(v) {
  return this instanceof __await ? (this.v = v, this) : new __await(v);
}

function __asyncGenerator(thisArg, _arguments, generator) {
  if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
  var g = generator.apply(thisArg, _arguments || []), i, q = [];
  return i = {}, verb("next"), verb("throw"), verb("return", awaitReturn), i[Symbol.asyncIterator] = function () { return this; }, i;
  function awaitReturn(f) { return function (v) { return Promise.resolve(v).then(f, reject); }; }
  function verb(n, f) { if (g[n]) { i[n] = function (v) { return new Promise(function (a, b) { q.push([n, v, a, b]) > 1 || resume(n, v); }); }; if (f) i[n] = f(i[n]); } }
  function resume(n, v) { try { step(g[n](v)); } catch (e) { settle(q[0][3], e); } }
  function step(r) { r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r); }
  function fulfill(value) { resume("next", value); }
  function reject(value) { resume("throw", value); }
  function settle(f, v) { if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]); }
}

function __asyncDelegator(o) {
  var i, p;
  return i = {}, verb("next"), verb("throw", function (e) { throw e; }), verb("return"), i[Symbol.iterator] = function () { return this; }, i;
  function verb(n, f) { i[n] = o[n] ? function (v) { return (p = !p) ? { value: __await(o[n](v)), done: false } : f ? f(v) : v; } : f; }
}

function __asyncValues(o) {
  if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
  var m = o[Symbol.asyncIterator], i;
  return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
  function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
  function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
}

function __makeTemplateObject(cooked, raw) {
  if (Object.defineProperty) { Object.defineProperty(cooked, "raw", { value: raw }); } else { cooked.raw = raw; }
  return cooked;
}
var __setModuleDefault = Object.create ? (function(o, v) {
  Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
  o["default"] = v;
};

function __importStar(mod) {
  if (mod && mod.__esModule) return mod;
  var result = {};
  if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
  __setModuleDefault(result, mod);
  return result;
}

function __importDefault(mod) {
  return (mod && mod.__esModule) ? mod : { default: mod };
}

function __classPrivateFieldGet(receiver, state, kind, f) {
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
}

function __classPrivateFieldSet(receiver, state, value, kind, f) {
  if (kind === "m") throw new TypeError("Private method is not writable");
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return (kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value)), value;
}

function __classPrivateFieldIn(state, receiver) {
  if (receiver === null || (typeof receiver !== "object" && typeof receiver !== "function")) throw new TypeError("Cannot use 'in' operator on non-object");
  return typeof state === "function" ? receiver === state : state.has(receiver);
}

function __addDisposableResource(env, value, async) {
  if (value !== null && value !== void 0) {
    if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
    var dispose, inner;
    if (async) {
      if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
      dispose = value[Symbol.asyncDispose];
    }
    if (dispose === void 0) {
      if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
      dispose = value[Symbol.dispose];
      if (async) inner = dispose;
    }
    if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
    if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
    env.stack.push({ value: value, dispose: dispose, async: async });
  }
  else if (async) {
    env.stack.push({ async: true });
  }
  return value;
}

var _SuppressedError = typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
  var e = new Error(message);
  return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
};

function __disposeResources(env) {
  function fail(e) {
    env.error = env.hasError ? new _SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
    env.hasError = true;
  }
  function next() {
    while (env.stack.length) {
      var rec = env.stack.pop();
      try {
        var result = rec.dispose && rec.dispose.call(rec.value);
        if (rec.async) return Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
      }
      catch (e) {
          fail(e);
      }
    }
    if (env.hasError) throw env.error;
  }
  return next();
}

var tslib_es6 = {
  __extends,
  __assign,
  __rest,
  __decorate,
  __param,
  __metadata,
  __awaiter,
  __generator,
  __createBinding,
  __exportStar,
  __values,
  __read,
  __spread,
  __spreadArrays,
  __spreadArray,
  __await,
  __asyncGenerator,
  __asyncDelegator,
  __asyncValues,
  __makeTemplateObject,
  __importStar,
  __importDefault,
  __classPrivateFieldGet,
  __classPrivateFieldSet,
  __classPrivateFieldIn,
  __addDisposableResource,
  __disposeResources,
};

var tslib_es6$1 = /*#__PURE__*/Object.freeze({
__proto__: null,
__addDisposableResource: __addDisposableResource,
get __assign () { return __assign; },
__asyncDelegator: __asyncDelegator,
__asyncGenerator: __asyncGenerator,
__asyncValues: __asyncValues,
__await: __await,
__awaiter: __awaiter,
__classPrivateFieldGet: __classPrivateFieldGet,
__classPrivateFieldIn: __classPrivateFieldIn,
__classPrivateFieldSet: __classPrivateFieldSet,
__createBinding: __createBinding,
__decorate: __decorate,
__disposeResources: __disposeResources,
__esDecorate: __esDecorate,
__exportStar: __exportStar,
__extends: __extends,
__generator: __generator,
__importDefault: __importDefault,
__importStar: __importStar,
__makeTemplateObject: __makeTemplateObject,
__metadata: __metadata,
__param: __param,
__propKey: __propKey,
__read: __read,
__rest: __rest,
__runInitializers: __runInitializers,
__setFunctionName: __setFunctionName,
__spread: __spread,
__spreadArray: __spreadArray,
__spreadArrays: __spreadArrays,
__values: __values,
default: tslib_es6
});

var require$$0 = /*@__PURE__*/getAugmentedNamespace(tslib_es6$1);

var deferred = {};

var hasRequiredDeferred;

function requireDeferred () {
	if (hasRequiredDeferred) return deferred;
	hasRequiredDeferred = 1;
	// Copyright (C) 2018 The Android Open Source Project
	//
	// Licensed under the Apache License, Version 2.0 (the "License");
	// you may not use this file except in compliance with the License.
	// You may obtain a copy of the License at
	//
	//      http://www.apache.org/licenses/LICENSE-2.0
	//
	// Unless required by applicable law or agreed to in writing, software
	// distributed under the License is distributed on an "AS IS" BASIS,
	// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	// See the License for the specific language governing permissions and
	// limitations under the License.
	Object.defineProperty(deferred, "__esModule", { value: true });
	deferred.defer = defer;
	// Create a promise with exposed resolve and reject callbacks.
	function defer() {
	    // eslint-disable-next-line @typescript-eslint/no-explicit-any
	    let resolve = null;
	    // eslint-disable-next-line @typescript-eslint/no-explicit-any
	    let reject = null;
	    const p = new Promise((res, rej) => ([resolve, reject] = [res, rej]));
	    // eslint-disable-next-line @typescript-eslint/no-explicit-any
	    return Object.assign(p, { resolve, reject });
	}
	
	return deferred;
}

var assert = {};

var hasRequiredAssert;

function requireAssert () {
	if (hasRequiredAssert) return assert;
	hasRequiredAssert = 1;
	// Copyright (C) 2026 The Android Open Source Project
	//
	// Licensed under the Apache License, Version 2.0 (the "License");
	// you may not use this file except in compliance with the License.
	// You may obtain a copy of the License at
	//
	//      http://www.apache.org/licenses/LICENSE-2.0
	//
	// Unless required by applicable law or agreed to in writing, software
	// distributed under the License is distributed on an "AS IS" BASIS,
	// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	// See the License for the specific language governing permissions and
	// limitations under the License.
	Object.defineProperty(assert, "__esModule", { value: true });
	assert.assertExists = assertExists;
	assert.assertDefined = assertDefined;
	assert.assertIsInstance = assertIsInstance;
	assert.assertTrue = assertTrue;
	assert.assertFalse = assertFalse;
	assert.assertUnreachable = assertUnreachable;
	// Assertion utilities for runtime validation and TypeScript type narrowing.
	//
	// These functions provide fail-fast semantics: if an assertion fails, an
	// exception is thrown immediately. This makes bugs easier to catch and debug
	// by surfacing issues at the point of failure rather than propagating invalid
	// state.
	//
	// In addition to runtime checks, these assertions help TypeScript narrow types.
	// For example, after calling assertExists(x), TypeScript knows x is non-null.
	function assertExists(value, optMsg) {
	    if (value === null || value === undefined) {
	        throw new Error(optMsg ?? 'Value is null or undefined');
	    }
	    return value;
	}
	// assertExists trips over NULLs, but in many contexts NULL is a valid SQL value
	// we have to work with.
	function assertDefined(value, optMsg) {
	    if (value === undefined) {
	        throw new Error(optMsg ?? 'Value is undefined');
	    }
	    return value;
	}
	// Asserts that the value is an instance of the given class. Returns the value
	// with a narrowed type if the assertion passes, otherwise throws an error.
	function assertIsInstance(value, clazz, optMsg) {
	    assertTrue(value instanceof clazz, optMsg ?? `Value is not an instance of ${clazz.name}`);
	    return value;
	}
	function assertTrue(value, optMsg) {
	    if (!value) {
	        throw new Error(optMsg ?? 'Failed assertion');
	    }
	}
	function assertFalse(value, optMsg) {
	    assertTrue(!value, optMsg);
	}
	// This function serves two purposes.
	// 1) A runtime check - if we are ever called, we throw an exception.
	// This is useful for checking that code we suspect should never be reached is
	// actually never reached.
	// 2) A compile time check where typescript asserts that the value passed can be
	// cast to the "never" type.
	// This is useful for ensuring we exhaustively check union types.
	function assertUnreachable(value, optMsg) {
	    throw new Error(optMsg ?? `This code should not be reachable ${value}`);
	}
	
	return assert;
}

function commonjsRequire(path) {
	throw new Error('Could not dynamically require "' + path + '". Please configure the dynamicRequireTargets or/and ignoreDynamicRequires option of @rollup/plugin-commonjs appropriately for this require call to work.');
}

var trace_processor_memory64 = {exports: {}};

var hasRequiredTrace_processor_memory64;

function requireTrace_processor_memory64 () {
	if (hasRequiredTrace_processor_memory64) return trace_processor_memory64.exports;
	hasRequiredTrace_processor_memory64 = 1;
	(function (module, exports$1) {
		var trace_processor_memory64_wasm = (() => {
		  var _scriptName = typeof document != 'undefined' ? document.currentScript?.src : undefined;
		  return (
		function(moduleArg = {}) {
		  var moduleRtn;

		// include: shell.js
		// The Module object: Our interface to the outside world. We import
		// and export values on it. There are various ways Module can be used:
		// 1. Not defined. We create it here
		// 2. A function parameter, function(moduleArg) => Promise<Module>
		// 3. pre-run appended it, var Module = {}; ..generated code..
		// 4. External script tag defines var Module.
		// We need to check if Module already exists (e.g. case 3 above).
		// Substitution will be replaced with actual code on later stage of the build,
		// this way Closure Compiler will not mangle it (e.g. case 4. above).
		// Note that if you want to run closure, and also to use Module
		// after the generated code, you will need to define   var Module = {};
		// before the code. Then that object will be used in the code, and you
		// can continue to use Module afterwards as well.
		var Module = moduleArg;

		// Set up the promise that indicates the Module is initialized
		var readyPromiseResolve, readyPromiseReject;

		new Promise((resolve, reject) => {
		  readyPromiseResolve = resolve;
		  readyPromiseReject = reject;
		});

		// Determine the runtime environment we are in. You can customize this by
		// setting the ENVIRONMENT setting at compile time (see settings.js).
		// Attempt to auto-detect the environment
		var ENVIRONMENT_IS_WEB = typeof window == "object";

		var ENVIRONMENT_IS_WORKER = typeof WorkerGlobalScope != "undefined";

		// N.b. Electron.js environment is simultaneously a NODE-environment, but
		// also a web environment.
		var ENVIRONMENT_IS_NODE = typeof process == "object" && typeof process.versions == "object" && typeof process.versions.node == "string" && process.type != "renderer";

		var ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER;

		// --pre-jses are emitted after the Module integration code, so that they can
		// refer to Module (if they choose; they can also define Module)
		var arguments_ = [];

		var thisProgram = "./this.program";

		var quit_ = (status, toThrow) => {
		  throw toThrow;
		};

		if (ENVIRONMENT_IS_WORKER) {
		  _scriptName = self.location.href;
		}

		// `/` should be present at the end if `scriptDirectory` is not empty
		var scriptDirectory = "";

		function locateFile(path) {
		  if (Module["locateFile"]) {
		    return Module["locateFile"](path, scriptDirectory);
		  }
		  return scriptDirectory + path;
		}

		// Hooks that are implemented differently in different runtime environments.
		var readAsync, readBinary;

		if (ENVIRONMENT_IS_SHELL) {
		  if ((typeof process == "object" && typeof commonjsRequire === "function") || typeof window == "object" || typeof WorkerGlobalScope != "undefined") throw new Error("not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)");
		} else // Note that this includes Node.js workers when relevant (pthreads is enabled).
		// Node.js workers are detected as a combination of ENVIRONMENT_IS_WORKER and
		// ENVIRONMENT_IS_NODE.
		if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
		  try {
		    scriptDirectory = new URL(".", _scriptName).href;
		  } catch {}
		  if (!(typeof window == "object" || typeof WorkerGlobalScope != "undefined")) throw new Error("not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)");
		  {
		    // include: web_or_worker_shell_read.js
		    if (ENVIRONMENT_IS_WORKER) {
		      readBinary = url => {
		        var xhr = new XMLHttpRequest;
		        xhr.open("GET", url, false);
		        xhr.responseType = "arraybuffer";
		        xhr.send(null);
		        return new Uint8Array(/** @type{!ArrayBuffer} */ (xhr.response));
		      };
		    }
		    readAsync = async url => {
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

		// perform assertions in shell.js after we set up out() and err(), as otherwise
		// if an assertion fails it cannot print the message
		assert(!ENVIRONMENT_IS_NODE, "node environment detected but not enabled at build time.  Add `node` to `-sENVIRONMENT` to enable.");

		assert(!ENVIRONMENT_IS_SHELL, "shell environment detected but not enabled at build time.  Add `shell` to `-sENVIRONMENT` to enable.");

		// end include: shell.js
		// include: preamble.js
		// === Preamble library stuff ===
		// Documentation for the public APIs defined in this file must be updated in:
		//    site/source/docs/api_reference/preamble.js.rst
		// A prebuilt local version of the documentation is available at:
		//    site/build/text/docs/api_reference/preamble.js.txt
		// You can also build docs locally as HTML or other formats in site/
		// An online HTML version (which may be of a different version of Emscripten)
		//    is up at http://kripken.github.io/emscripten-site/docs/api_reference/preamble.js.html
		var wasmBinary;

		if (typeof WebAssembly != "object") {
		  err("no native wasm support detected");
		}

		// Wasm globals
		var wasmMemory;

		//========================================
		// Runtime essentials
		//========================================
		// whether we are quitting the application. no code should run after this.
		// set in exit() and abort()
		var ABORT = false;

		// set by exit() and abort().  Passed to 'onExit' handler.
		// NOTE: This is also used as the process return code code in shell environments
		// but only when noExitRuntime is false.
		var EXITSTATUS;

		// In STRICT mode, we only define assert() when ASSERTIONS is set.  i.e. we
		// don't define it at all in release modes.  This matches the behaviour of
		// MINIMAL_RUNTIME.
		// TODO(sbc): Make this the default even without STRICT enabled.
		/** @type {function(*, string=)} */ function assert(condition, text) {
		  if (!condition) {
		    abort("Assertion failed" + (text ? ": " + text : ""));
		  }
		}

		// Memory management
		var /** @type {!Int8Array} */ HEAP8, /** @type {!Uint8Array} */ HEAPU8, /** @type {!Int16Array} */ HEAP16, /** @type {!Int32Array} */ HEAP32, /** @type {!Uint32Array} */ HEAPU32, /* BigInt64Array type is not correctly defined in closure
		/** not-@type {!BigInt64Array} */ HEAP64, /* BigUint64Array type is not correctly defined in closure
		/** not-t@type {!BigUint64Array} */ HEAPU64, /** @type {!Float64Array} */ HEAPF64;

		var runtimeInitialized = false;

		/**
		 * Indicates whether filename is delivered via file protocol (as opposed to http/https)
		 * @noinline
		 */ var isFileURI = filename => filename.startsWith("file://");

		// include: runtime_shared.js
		// include: runtime_stack_check.js
		// Initializes the stack cookie. Called at the startup of main and at the startup of each thread in pthreads mode.
		function writeStackCookie() {
		  var max = _emscripten_stack_get_end();
		  assert((max & 3) == 0);
		  // If the stack ends at address zero we write our cookies 4 bytes into the
		  // stack.  This prevents interference with SAFE_HEAP and ASAN which also
		  // monitor writes to address zero.
		  if (max == 0) {
		    max += 4;
		  }
		  // The stack grow downwards towards _emscripten_stack_get_end.
		  // We write cookies to the final two words in the stack and detect if they are
		  // ever overwritten.
		  HEAPU32[((max) / 4)] = 34821223;
		  HEAPU32[(((max) + (4)) / 4)] = 2310721022;
		  // Also test the global address 0 for integrity.
		  HEAPU32[((0) / 4)] = 1668509029;
		}

		function checkStackCookie() {
		  if (ABORT) return;
		  var max = _emscripten_stack_get_end();
		  // See writeStackCookie().
		  if (max == 0) {
		    max += 4;
		  }
		  var cookie1 = HEAPU32[((max) / 4)];
		  var cookie2 = HEAPU32[(((max) + (4)) / 4)];
		  if (cookie1 != 34821223 || cookie2 != 2310721022) {
		    abort(`Stack overflow! Stack cookie has been overwritten at ${ptrToString(max)}, expected hex dwords 0x89BACDFE and 0x2135467, but received ${ptrToString(cookie2)} ${ptrToString(cookie1)}`);
		  }
		  // Also test the global address 0 for integrity.
		  if (HEAPU32[((0) / 4)] != 1668509029) {
		    abort("Runtime error: The application has corrupted its heap memory area (address zero)!");
		  }
		}

		// Endianness check
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

		// forcing the filesystem exports a few things by default
		function isExportedByForceFilesystem(name) {
		  return name === "FS_createPath" || name === "FS_createDataFile" || name === "FS_createPreloadedFile" || name === "FS_unlink" || name === "addRunDependency" || // The old FS has some functionality that WasmFS lacks.
		  name === "FS_createLazyFile" || name === "FS_createDevice" || name === "removeRunDependency";
		}

		function missingLibrarySymbol(sym) {
		  // Any symbol that is not included from the JS library is also (by definition)
		  // not exported on the Module object.
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

		// end include: runtime_debug.js
		// include: memoryprofiler.js
		// end include: memoryprofiler.js
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

		// end include: runtime_shared.js
		assert(typeof Int32Array != "undefined" && typeof Float64Array !== "undefined" && Int32Array.prototype.subarray != undefined && Int32Array.prototype.set != undefined, "JS engine does not provide full typed array support");

		function preRun() {
		  if (Module["preRun"]) {
		    if (typeof Module["preRun"] == "function") Module["preRun"] = [ Module["preRun"] ];
		    while (Module["preRun"].length) {
		      addOnPreRun(Module["preRun"].shift());
		    }
		  }
		  consumedModuleProp("preRun");
		  // Begin ATPRERUNS hooks
		  callRuntimeCallbacks(onPreRuns);
		}

		function initRuntime() {
		  assert(!runtimeInitialized);
		  runtimeInitialized = true;
		  checkStackCookie();
		  // Begin ATINITS hooks
		  if (!Module["noFSInit"] && !FS.initialized) FS.init();
		  // End ATINITS hooks
		  wasmExports["__wasm_call_ctors"]();
		  // Begin ATPOSTCTORS hooks
		  FS.ignorePermissions = false;
		}

		function preMain() {
		  checkStackCookie();
		}

		function postRun() {
		  checkStackCookie();
		  // PThreads reuse the runtime from the main thread.
		  if (Module["postRun"]) {
		    if (typeof Module["postRun"] == "function") Module["postRun"] = [ Module["postRun"] ];
		    while (Module["postRun"].length) {
		      addOnPostRun(Module["postRun"].shift());
		    }
		  }
		  consumedModuleProp("postRun");
		  // Begin ATPOSTRUNS hooks
		  callRuntimeCallbacks(onPostRuns);
		}

		// A counter of dependencies for calling run(). If we need to
		// do asynchronous work before running, increment this and
		// decrement it. Incrementing must happen in a place like
		// Module.preRun (used by emcc to add file preloading).
		// Note that you can add dependencies in preRun, even though
		// it happens right before run - run will be postponed until
		// the dependencies are met.
		var runDependencies = 0;

		var dependenciesFulfilled = null;

		// overridden to take different actions when all run dependencies are fulfilled
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
		  runDependencies++;
		  Module["monitorRunDependencies"]?.(runDependencies);
		  if (id) {
		    assert(!runDependencyTracking[id]);
		    runDependencyTracking[id] = 1;
		    if (runDependencyWatcher === null && typeof setInterval != "undefined") {
		      // Check for missing dependencies every few seconds
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
		  runDependencies--;
		  Module["monitorRunDependencies"]?.(runDependencies);
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

		/** @param {string|number=} what */ function abort(what) {
		  Module["onAbort"]?.(what);
		  what = "Aborted(" + what + ")";
		  // TODO(sbc): Should we remove printing and leave it up to whoever
		  // catches the exception?
		  err(what);
		  ABORT = true;
		  // Use a wasm runtime error, because a JS error might be seen as a foreign
		  // exception, which means we'd run destructors on it. We need the error to
		  // simply make the program stop.
		  // FIXME This approach does not work in Wasm EH because it currently does not assume
		  // all RuntimeErrors are from traps; it decides whether a RuntimeError is from
		  // a trap or not based on a hidden field within the object. So at the moment
		  // we don't have a way of throwing a wasm trap from JS. TODO Make a JS API that
		  // allows this in the wasm spec.
		  // Suppress closure compiler warning here. Closure compiler's builtin extern
		  // definition for WebAssembly.RuntimeError claims it takes no arguments even
		  // though it can.
		  // TODO(https://github.com/google/closure-compiler/pull/3913): Remove if/when upstream closure gets fixed.
		  /** @suppress {checkTypes} */ var e = new WebAssembly.RuntimeError(what);
		  readyPromiseReject(e);
		  // Throw the error whether or not MODULARIZE is set because abort is used
		  // in code paths apart from instantiation where an exception is expected
		  // to be thrown when abort is called.
		  throw e;
		}

		function createExportWrapper(name, nargs) {
		  return (...args) => {
		    assert(runtimeInitialized, `native function \`${name}\` called before runtime initialization`);
		    var f = wasmExports[name];
		    assert(f, `exported native function \`${name}\` not found`);
		    // Only assert for too many arguments. Too few can be valid since the missing arguments will be zero filled.
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
		  var module;
		  var binary = getBinarySync(file);
		  module = new WebAssembly.Module(binary);
		  var instance = new WebAssembly.Instance(module, info);
		  return [ instance, module ];
		}

		function getWasmImports() {
		  // prepare imports
		  return {
		    "env": wasmImports,
		    "wasi_snapshot_preview1": wasmImports
		  };
		}

		// Create the wasm instance.
		// Receives the wasm imports, returns the exports.
		function createWasm() {
		  // Load the wasm module and create an instance of using native support in the JS engine.
		  // handle a generated wasm instance, receiving its exports and
		  // performing other necessary setup
		  /** @param {WebAssembly.Module=} module*/ function receiveInstance(instance, module) {
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
		  // wait for the pthread pool (if any)
		  addRunDependency("wasm-instantiate");
		  // Prefer streaming instantiation if available.
		  var info = getWasmImports();
		  // User shell pages can write their own Module.instantiateWasm = function(imports, successCallback) callback
		  // to manually instantiate the Wasm module themselves. This allows pages to
		  // run the instantiation parallel to any other async startup actions they are
		  // performing.
		  // Also pthreads and wasm workers initialize the wasm instance through this
		  // path.
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
		  wasmBinaryFile ??= findWasmBinary();
		  var result = instantiateSync(wasmBinaryFile, info);
		  // TODO: Due to Closure regression https://github.com/google/closure-compiler/issues/3193,
		  // the above line no longer optimizes out down to the following line.
		  // When the regression is fixed, we can remove this if/else.
		  return receiveInstance(result[0]);
		}

		// end include: preamble.js
		// Begin JS library code
		class ExitStatus {
		  name="ExitStatus";
		  constructor(status) {
		    this.message = `Program terminated with exit(${status})`;
		    this.status = status;
		  }
		}

		var callRuntimeCallbacks = callbacks => {
		  while (callbacks.length > 0) {
		    // Pass the module as the first argument.
		    callbacks.shift()(Module);
		  }
		};

		var onPostRuns = [];

		var addOnPostRun = cb => onPostRuns.push(cb);

		var onPreRuns = [];

		var addOnPreRun = cb => onPreRuns.push(cb);

		var noExitRuntime = true;

		var ptrToString = ptr => {
		  assert(typeof ptr === "number");
		  return "0x" + ptr.toString(16).padStart(8, "0");
		};

		var stackRestore = val => __emscripten_stack_restore(val);

		var stackSave = () => _emscripten_stack_get_current();

		var warnOnce = text => {
		  warnOnce.shown ||= {};
		  if (!warnOnce.shown[text]) {
		    warnOnce.shown[text] = 1;
		    err(text);
		  }
		};

		var INT53_MAX = 9007199254740992;

		var INT53_MIN = -9007199254740992;

		var bigintToI53Checked = num => (num < INT53_MIN || num > INT53_MAX) ? NaN : Number(num);

		var UTF8Decoder = typeof TextDecoder != "undefined" ? new TextDecoder : undefined;

		/**
		     * Given a pointer 'idx' to a null-terminated UTF8-encoded string in the given
		     * array that contains uint8 values, returns a copy of that string as a
		     * Javascript String object.
		     * heapOrArray is either a regular array, or a JavaScript typed array view.
		     * @param {number=} idx
		     * @param {number=} maxBytesToRead
		     * @return {string}
		     */ var UTF8ArrayToString = (heapOrArray, idx = 0, maxBytesToRead = NaN) => {
		  var endIdx = idx + maxBytesToRead;
		  var endPtr = idx;
		  // TextDecoder needs to know the byte length in advance, it doesn't stop on
		  // null terminator by itself.  Also, use the length info to avoid running tiny
		  // strings through TextDecoder, since .subarray() allocates garbage.
		  // (As a tiny code save trick, compare endPtr against endIdx using a negation,
		  // so that undefined/NaN means Infinity)
		  while (heapOrArray[endPtr] && !(endPtr >= endIdx)) ++endPtr;
		  if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) {
		    return UTF8Decoder.decode(heapOrArray.subarray(idx, endPtr));
		  }
		  var str = "";
		  // If building with TextDecoder, we have already computed the string length
		  // above, so test loop end condition against that
		  while (idx < endPtr) {
		    // For UTF8 byte structure, see:
		    // http://en.wikipedia.org/wiki/UTF-8#Description
		    // https://www.ietf.org/rfc/rfc2279.txt
		    // https://tools.ietf.org/html/rfc3629
		    var u0 = heapOrArray[idx++];
		    if (!(u0 & 128)) {
		      str += String.fromCharCode(u0);
		      continue;
		    }
		    var u1 = heapOrArray[idx++] & 63;
		    if ((u0 & 224) == 192) {
		      str += String.fromCharCode(((u0 & 31) << 6) | u1);
		      continue;
		    }
		    var u2 = heapOrArray[idx++] & 63;
		    if ((u0 & 240) == 224) {
		      u0 = ((u0 & 15) << 12) | (u1 << 6) | u2;
		    } else {
		      if ((u0 & 248) != 240) warnOnce("Invalid UTF-8 leading byte " + ptrToString(u0) + " encountered when deserializing a UTF-8 string in wasm memory to a JS string!");
		      u0 = ((u0 & 7) << 18) | (u1 << 12) | (u2 << 6) | (heapOrArray[idx++] & 63);
		    }
		    if (u0 < 65536) {
		      str += String.fromCharCode(u0);
		    } else {
		      var ch = u0 - 65536;
		      str += String.fromCharCode(55296 | (ch >> 10), 56320 | (ch & 1023));
		    }
		  }
		  return str;
		};

		/**
		     * Given a pointer 'ptr' to a null-terminated UTF8-encoded string in the
		     * emscripten HEAP, returns a copy of that string as a Javascript String object.
		     *
		     * @param {number} ptr
		     * @param {number=} maxBytesToRead - An optional length that specifies the
		     *   maximum number of bytes to read. You can omit this parameter to scan the
		     *   string until the first 0 byte. If maxBytesToRead is passed, and the string
		     *   at [ptr, ptr+maxBytesToReadr[ contains a null byte in the middle, then the
		     *   string will cut short at that byte index (i.e. maxBytesToRead will not
		     *   produce a string of exact length [ptr, ptr+maxBytesToRead[) N.B. mixing
		     *   frequent uses of UTF8ToString() with and without maxBytesToRead may throw
		     *   JS JIT optimizations off, so it is worth to consider consistently using one
		     * @return {string}
		     */ var UTF8ToString = (ptr, maxBytesToRead) => {
		  assert(typeof ptr == "number", `UTF8ToString expects a number (got ${typeof ptr})`);
		  return ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead) : "";
		};

		function ___assert_fail(condition, filename, line, func) {
		  condition = bigintToI53Checked(condition);
		  filename = bigintToI53Checked(filename);
		  func = bigintToI53Checked(func);
		  return abort(`Assertion failed: ${UTF8ToString(condition)}, at: ` + [ filename ? UTF8ToString(filename) : "unknown filename", line, func ? UTF8ToString(func) : "unknown function" ]);
		}

		var PATH = {
		  isAbs: path => path.charAt(0) === "/",
		  splitPath: filename => {
		    var splitPathRe = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
		    return splitPathRe.exec(filename).slice(1);
		  },
		  normalizeArray: (parts, allowAboveRoot) => {
		    // if the path tries to go above the root, `up` ends up > 0
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
		    // if the path is allowed to go above the root, restore leading ..s
		    if (allowAboveRoot) {
		      for (;up; up--) {
		        parts.unshift("..");
		      }
		    }
		    return parts;
		  },
		  normalize: path => {
		    var isAbsolute = PATH.isAbs(path), trailingSlash = path.slice(-1) === "/";
		    // Normalize the path
		    path = PATH.normalizeArray(path.split("/").filter(p => !!p), !isAbsolute).join("/");
		    if (!path && !isAbsolute) {
		      path = ".";
		    }
		    if (path && trailingSlash) {
		      path += "/";
		    }
		    return (isAbsolute ? "/" : "") + path;
		  },
		  dirname: path => {
		    var result = PATH.splitPath(path), root = result[0], dir = result[1];
		    if (!root && !dir) {
		      // No dirname whatsoever
		      return ".";
		    }
		    if (dir) {
		      // It has a dirname, strip trailing slash
		      dir = dir.slice(0, -1);
		    }
		    return root + dir;
		  },
		  basename: path => path && path.match(/([^\/]+|\/)\/*$/)[1],
		  join: (...paths) => PATH.normalize(paths.join("/")),
		  join2: (l, r) => PATH.normalize(l + "/" + r)
		};

		var initRandomFill = () => view => crypto.getRandomValues(view);

		var randomFill = view => {
		  // Lazily init on the first invocation.
		  (randomFill = initRandomFill())(view);
		};

		var PATH_FS = {
		  resolve: (...args) => {
		    var resolvedPath = "", resolvedAbsolute = false;
		    for (var i = args.length - 1; i >= -1 && !resolvedAbsolute; i--) {
		      var path = (i >= 0) ? args[i] : FS.cwd();
		      // Skip empty and invalid entries
		      if (typeof path != "string") {
		        throw new TypeError("Arguments to path.resolve must be strings");
		      } else if (!path) {
		        return "";
		      }
		      resolvedPath = path + "/" + resolvedPath;
		      resolvedAbsolute = PATH.isAbs(path);
		    }
		    // At this point the path should be resolved to a full absolute path, but
		    // handle relative paths to be safe (might happen when process.cwd() fails)
		    resolvedPath = PATH.normalizeArray(resolvedPath.split("/").filter(p => !!p), !resolvedAbsolute).join("/");
		    return ((resolvedAbsolute ? "/" : "") + resolvedPath) || ".";
		  },
		  relative: (from, to) => {
		    from = PATH_FS.resolve(from).slice(1);
		    to = PATH_FS.resolve(to).slice(1);
		    function trim(arr) {
		      var start = 0;
		      for (;start < arr.length; start++) {
		        if (arr[start] !== "") break;
		      }
		      var end = arr.length - 1;
		      for (;end >= 0; end--) {
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

		var FS_stdin_getChar_buffer = [];

		var lengthBytesUTF8 = str => {
		  var len = 0;
		  for (var i = 0; i < str.length; ++i) {
		    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code
		    // unit, not a Unicode code point of the character! So decode
		    // UTF16->UTF32->UTF8.
		    // See http://unicode.org/faq/utf_bom.html#utf16-3
		    var c = str.charCodeAt(i);
		    // possibly a lead surrogate
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
		  // Parameter maxBytesToWrite is not optional. Negative values, 0, null,
		  // undefined and false each don't write out any bytes.
		  if (!(maxBytesToWrite > 0)) return 0;
		  var startIdx = outIdx;
		  var endIdx = outIdx + maxBytesToWrite - 1;
		  // -1 for string null terminator.
		  for (var i = 0; i < str.length; ++i) {
		    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code
		    // unit, not a Unicode code point of the character! So decode
		    // UTF16->UTF32->UTF8.
		    // See http://unicode.org/faq/utf_bom.html#utf16-3
		    // For UTF8 byte structure, see http://en.wikipedia.org/wiki/UTF-8#Description
		    // and https://www.ietf.org/rfc/rfc2279.txt
		    // and https://tools.ietf.org/html/rfc3629
		    var u = str.charCodeAt(i);
		    // possibly a lead surrogate
		    if (u >= 55296 && u <= 57343) {
		      var u1 = str.charCodeAt(++i);
		      u = 65536 + ((u & 1023) << 10) | (u1 & 1023);
		    }
		    if (u <= 127) {
		      if (outIdx >= endIdx) break;
		      heap[outIdx++] = u;
		    } else if (u <= 2047) {
		      if (outIdx + 1 >= endIdx) break;
		      heap[outIdx++] = 192 | (u >> 6);
		      heap[outIdx++] = 128 | (u & 63);
		    } else if (u <= 65535) {
		      if (outIdx + 2 >= endIdx) break;
		      heap[outIdx++] = 224 | (u >> 12);
		      heap[outIdx++] = 128 | ((u >> 6) & 63);
		      heap[outIdx++] = 128 | (u & 63);
		    } else {
		      if (outIdx + 3 >= endIdx) break;
		      if (u > 1114111) warnOnce("Invalid Unicode code point " + ptrToString(u) + " encountered when serializing a JS string to a UTF-8 string in wasm memory! (Valid unicode code points should be in range 0-0x10FFFF).");
		      heap[outIdx++] = 240 | (u >> 18);
		      heap[outIdx++] = 128 | ((u >> 12) & 63);
		      heap[outIdx++] = 128 | ((u >> 6) & 63);
		      heap[outIdx++] = 128 | (u & 63);
		    }
		  }
		  // Null-terminate the pointer to the buffer.
		  heap[outIdx] = 0;
		  return outIdx - startIdx;
		};

		/** @type {function(string, boolean=, number=)} */ var intArrayFromString = (stringy, dontAddNull, length) => {
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
		      // Browser.
		      result = window.prompt("Input: ");
		      // returns null on cancel
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
		  init() {},
		  shutdown() {},
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
		      // flush any pending line data
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
		        if (result === undefined && bytesRead === 0) {
		          throw new FS.ErrnoError(6);
		        }
		        if (result === null || result === undefined) break;
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
		      if (tty.output?.length > 0) {
		        out(UTF8ArrayToString(tty.output));
		        tty.output = [];
		      }
		    },
		    ioctl_tcgets(tty) {
		      // typical setting
		      return {
		        c_iflag: 25856,
		        c_oflag: 5,
		        c_cflag: 191,
		        c_lflag: 35387,
		        c_cc: [ 3, 28, 127, 21, 4, 0, 1, 0, 17, 19, 26, 0, 18, 15, 23, 22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ]
		      };
		    },
		    ioctl_tcsets(tty, optional_actions, data) {
		      // currently just ignore
		      return 0;
		    },
		    ioctl_tiocgwinsz(tty) {
		      return [ 24, 80 ];
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
		      if (tty.output?.length > 0) {
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

		var mmapAlloc = size => {
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
		      // no supported
		      throw new FS.ErrnoError(63);
		    }
		    MEMFS.ops_table ||= {
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
		    };
		    var node = FS.createNode(parent, name, mode, dev);
		    if (FS.isDir(node.mode)) {
		      node.node_ops = MEMFS.ops_table.dir.node;
		      node.stream_ops = MEMFS.ops_table.dir.stream;
		      node.contents = {};
		    } else if (FS.isFile(node.mode)) {
		      node.node_ops = MEMFS.ops_table.file.node;
		      node.stream_ops = MEMFS.ops_table.file.stream;
		      node.usedBytes = 0;
		      // The actual number of bytes used in the typed array, as opposed to contents.length which gives the whole capacity.
		      // When the byte data of the file is populated, this will point to either a typed array, or a normal JS array. Typed arrays are preferred
		      // for performance, and used by default. However, typed arrays are not resizable like normal JS arrays are, so there is a small disk size
		      // penalty involved for appending file writes that continuously grow a file similar to std::vector capacity vs used -scheme.
		      node.contents = null;
		    } else if (FS.isLink(node.mode)) {
		      node.node_ops = MEMFS.ops_table.link.node;
		      node.stream_ops = MEMFS.ops_table.link.stream;
		    } else if (FS.isChrdev(node.mode)) {
		      node.node_ops = MEMFS.ops_table.chrdev.node;
		      node.stream_ops = MEMFS.ops_table.chrdev.stream;
		    }
		    node.atime = node.mtime = node.ctime = Date.now();
		    // add the new node to the parent
		    if (parent) {
		      parent.contents[name] = node;
		      parent.atime = parent.mtime = parent.ctime = node.atime;
		    }
		    return node;
		  },
		  getFileDataAsTypedArray(node) {
		    if (!node.contents) return new Uint8Array(0);
		    if (node.contents.subarray) return node.contents.subarray(0, node.usedBytes);
		    // Make sure to not return excess unused bytes.
		    return new Uint8Array(node.contents);
		  },
		  expandFileStorage(node, newCapacity) {
		    var prevCapacity = node.contents ? node.contents.length : 0;
		    if (prevCapacity >= newCapacity) return;
		    // No need to expand, the storage was already large enough.
		    // Don't expand strictly to the given requested limit if it's only a very small increase, but instead geometrically grow capacity.
		    // For small filesizes (<1MB), perform size*2 geometric increase, but for large sizes, do a much more conservative size*1.125 increase to
		    // avoid overshooting the allocation cap by a very large margin.
		    var CAPACITY_DOUBLING_MAX = 1024 * 1024;
		    newCapacity = Math.max(newCapacity, (prevCapacity * (prevCapacity < CAPACITY_DOUBLING_MAX ? 2 : 1.125)) >>> 0);
		    if (prevCapacity != 0) newCapacity = Math.max(newCapacity, 256);
		    // At minimum allocate 256b for each file when expanding.
		    var oldContents = node.contents;
		    node.contents = new Uint8Array(newCapacity);
		    // Allocate new storage.
		    if (node.usedBytes > 0) node.contents.set(oldContents.subarray(0, node.usedBytes), 0);
		  },
		  resizeFileStorage(node, newSize) {
		    if (node.usedBytes == newSize) return;
		    if (newSize == 0) {
		      node.contents = null;
		      // Fully decommit when requesting a resize to zero.
		      node.usedBytes = 0;
		    } else {
		      var oldContents = node.contents;
		      node.contents = new Uint8Array(newSize);
		      // Allocate new storage.
		      if (oldContents) {
		        node.contents.set(oldContents.subarray(0, Math.min(newSize, node.usedBytes)));
		      }
		      node.usedBytes = newSize;
		    }
		  },
		  node_ops: {
		    getattr(node) {
		      var attr = {};
		      // device numbers reuse inode numbers.
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
		      // NOTE: In our implementation, st_blocks = Math.ceil(st_size/st_blksize),
		      //       but this is not required by the standard.
		      attr.blksize = 4096;
		      attr.blocks = Math.ceil(attr.size / attr.blksize);
		      return attr;
		    },
		    setattr(node, attr) {
		      for (const key of [ "mode", "atime", "mtime", "ctime" ]) {
		        if (attr[key] != null) {
		          node[key] = attr[key];
		        }
		      }
		      if (attr.size !== undefined) {
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
		      } catch (e) {}
		      if (new_node) {
		        if (FS.isDir(old_node.mode)) {
		          // if we're overwriting a directory at new_name, make sure it's empty.
		          for (var i in new_node.contents) {
		            throw new FS.ErrnoError(55);
		          }
		        }
		        FS.hashRemoveNode(new_node);
		      }
		      // do the internal rewiring
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
		      return [ ".", "..", ...Object.keys(node.contents) ];
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
		        // non-trivial, and typed array
		        buffer.set(contents.subarray(position, position + size), offset);
		      } else {
		        for (var i = 0; i < size; i++) buffer[offset + i] = contents[position + i];
		      }
		      return size;
		    },
		    write(stream, buffer, offset, length, position, canOwn) {
		      // The data buffer should be a typed array view
		      assert(!(buffer instanceof ArrayBuffer));
		      // If the buffer is located in main memory (HEAP), and if
		      // memory can grow, we can't hold on to references of the
		      // memory buffer, as they may get invalidated. That means we
		      // need to do copy its contents.
		      if (buffer.buffer === HEAP8.buffer) {
		        canOwn = false;
		      }
		      if (!length) return 0;
		      var node = stream.node;
		      node.mtime = node.ctime = Date.now();
		      if (buffer.subarray && (!node.contents || node.contents.subarray)) {
		        // This write is from a typed array to a typed array?
		        if (canOwn) {
		          assert(position === 0, "canOwn must imply no weird position inside the file");
		          node.contents = buffer.subarray(offset, offset + length);
		          node.usedBytes = length;
		          return length;
		        } else if (node.usedBytes === 0 && position === 0) {
		          // If this is a simple first write to an empty file, do a fast set since we don't need to care about old data.
		          node.contents = buffer.slice(offset, offset + length);
		          node.usedBytes = length;
		          return length;
		        } else if (position + length <= node.usedBytes) {
		          // Writing to an already allocated and used subrange of the file?
		          node.contents.set(buffer.subarray(offset, offset + length), position);
		          return length;
		        }
		      }
		      // Appending to an existing file and we need to reallocate, or source data did not come as a typed array.
		      MEMFS.expandFileStorage(node, position + length);
		      if (node.contents.subarray && buffer.subarray) {
		        // Use typed array write which is available.
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
		      // Only make a new copy when MAP_PRIVATE is specified.
		      if (!(flags & 2) && contents && contents.buffer === HEAP8.buffer) {
		        // We can't emulate MAP_SHARED when the file is not backed by the
		        // buffer we're mapping to (e.g. the HEAP buffer).
		        allocated = false;
		        ptr = contents.byteOffset;
		      } else {
		        allocated = true;
		        ptr = mmapAlloc(length);
		        if (!ptr) {
		          throw new FS.ErrnoError(48);
		        }
		        if (contents) {
		          // Try to avoid unnecessary slices.
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
		      // should we check if bytesWritten and length are the same?
		      return 0;
		    }
		  }
		};

		var asyncLoad = async url => {
		  var arrayBuffer = await readAsync(url);
		  assert(arrayBuffer, `Loading data file "${url}" failed (no arrayBuffer).`);
		  return new Uint8Array(arrayBuffer);
		};

		var FS_createDataFile = (...args) => FS.createDataFile(...args);

		var preloadPlugins = [];

		var FS_handledByPreloadPlugin = (byteArray, fullname, finish, onerror) => {
		  // Ensure plugins are ready.
		  if (typeof Browser != "undefined") Browser.init();
		  var handled = false;
		  preloadPlugins.forEach(plugin => {
		    if (handled) return;
		    if (plugin["canHandle"](fullname)) {
		      plugin["handle"](byteArray, fullname, finish, onerror);
		      handled = true;
		    }
		  });
		  return handled;
		};

		var FS_createPreloadedFile = (parent, name, url, canRead, canWrite, onload, onerror, dontCreateFile, canOwn, preFinish) => {
		  // TODO we should allow people to just pass in a complete filename instead
		  // of parent and name being that we just join them anyways
		  var fullname = name ? PATH_FS.resolve(PATH.join2(parent, name)) : parent;
		  var dep = getUniqueRunDependency(`cp ${fullname}`);
		  // might have several active requests for the same fullname
		  function processData(byteArray) {
		    function finish(byteArray) {
		      preFinish?.();
		      if (!dontCreateFile) {
		        FS_createDataFile(parent, name, byteArray, canRead, canWrite, canOwn);
		      }
		      onload?.();
		      removeRunDependency(dep);
		    }
		    if (FS_handledByPreloadPlugin(byteArray, fullname, finish, () => {
		      onerror?.();
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

		var FS_modeStringToFlags = str => {
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
		    WORKERFS.reader ??= new FileReaderSync;
		    var root = WORKERFS.createNode(null, "/", WORKERFS.DIR_MODE, 0);
		    var createdParents = {};
		    function ensureParent(path) {
		      // return the parent node, creating subdirs as necessary
		      var parts = path.split("/");
		      var parent = root;
		      for (var i = 0; i < parts.length - 1; i++) {
		        var curr = parts.slice(0, i + 1).join("/");
		        // Issue 4254: Using curr as a node name will prevent the node
		        // from being found in FS.nameTable when FS.open is called on
		        // a path which holds a child of this node,
		        // given that all FS functions assume node names
		        // are just their corresponding parts within their given path,
		        // rather than incremental aggregates which include their parent's
		        // directories.
		        createdParents[curr] ||= WORKERFS.createNode(parent, parts[i], WORKERFS.DIR_MODE, 0);
		        parent = createdParents[curr];
		      }
		      return parent;
		    }
		    function base(path) {
		      var parts = path.split("/");
		      return parts[parts.length - 1];
		    }
		    // We also accept FileList here, by using Array.prototype
		    Array.prototype.forEach.call(mount.opts["files"] || [], function(file) {
		      WORKERFS.createNode(ensureParent(file.name), base(file.name), WORKERFS.FILE_MODE, 0, file, file.lastModifiedDate);
		    });
		    (mount.opts["blobs"] || []).forEach(obj => {
		      WORKERFS.createNode(ensureParent(obj["name"]), base(obj["name"]), WORKERFS.FILE_MODE, 0, obj["data"]);
		    });
		    (mount.opts["packages"] || []).forEach(pack => {
		      pack["metadata"].files.forEach(file => {
		        var name = file.filename.slice(1);
		        // remove initial slash
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
		    node.atime = node.mtime = node.ctime = (mtime || new Date).getTime();
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
		      for (const key of [ "mode", "atime", "mtime", "ctime" ]) {
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
		      var entries = [ ".", ".." ];
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

		var strError = errno => UTF8ToString(_strerror(errno));

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
		    name="ErrnoError";
		    // We set the `name` property to be able to identify `FS.ErrnoError`
		    // - the `name` is a standard ECMA-262 property of error objects. Kind of good to have it anyway.
		    // - when using PROXYFS, an error can come from an underlying FS
		    // as different FS objects have their own FS.ErrnoError each,
		    // the test `err instanceof FS.ErrnoError` won't detect an error coming from another filesystem, causing bugs.
		    // we'll use the reliable test `err.name == "ErrnoError"` instead
		    constructor(errno) {
		      super(runtimeInitialized ? strError(errno) : "");
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
		    shared={};
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
		      return (this.flags & 1024);
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
		    node_ops={};
		    stream_ops={};
		    readMode=292 | 73;
		    writeMode=146;
		    mounted=null;
		    constructor(parent, name, mode, rdev) {
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
		    opts.follow_mount ??= true;
		    if (!PATH.isAbs(path)) {
		      path = FS.cwd() + "/" + path;
		    }
		    // limit max consecutive symlinks to 40 (SYMLOOP_MAX).
		    linkloop: for (var nlinks = 0; nlinks < 40; nlinks++) {
		      // split the absolute path
		      var parts = path.split("/").filter(p => !!p);
		      // start at the root
		      var current = FS.root;
		      var current_path = "/";
		      for (var i = 0; i < parts.length; i++) {
		        var islast = (i === parts.length - 1);
		        if (islast && opts.parent) {
		          // stop resolving
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
		          // if noent_okay is true, suppress a ENOENT in the last component
		          // and return an object with an undefined node. This is needed for
		          // resolving symlinks in the path when creating a file.
		          if ((e?.errno === 44) && islast && opts.noent_okay) {
		            return {
		              path: current_path
		            };
		          }
		          throw e;
		        }
		        // jump to the mount's root node if this is a mountpoint
		        if (FS.isMountpoint(current) && (!islast || opts.follow_mount)) {
		          current = current.mounted.root;
		        }
		        // by default, lookupPath will not follow a symlink if it is the final path component.
		        // setting opts.follow = true will override this behavior.
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
		      hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
		    }
		    return ((parentid + hash) >>> 0) % FS.nameTable.length;
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
		    // if we failed to find it in the cache, call into the VFS
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
		    var perms = [ "r", "w", "rw" ][flag & 3];
		    if ((flag & 512)) {
		      perms += "w";
		    }
		    return perms;
		  },
		  nodePermissions(node, perms) {
		    if (FS.ignorePermissions) {
		      return 0;
		    }
		    // return 0 if any user, group or owner bits are set.
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
		    } catch (e) {}
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
		      if (FS.flagsToPermissionString(flags) !== "r" || (flags & (512 | 64))) {
		        // TODO: check for O_SEARCH? (== search for dir only)
		        return 31;
		      }
		    }
		    return FS.nodePermissions(node, FS.flagsToPermissionString(flags));
		  },
		  checkOpExists(op, err) {
		    if (!op) {
		      throw new FS.ErrnoError(err);
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
		  getStream: fd => FS.streams[fd],
		  createStream(stream, fd = -1) {
		    assert(fd >= -1);
		    // clone it, so we can return an instance of FSStream
		    stream = Object.assign(new FS.FSStream, stream);
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
		    var stream = FS.createStream(origStream, fd);
		    stream.stream_ops?.dup?.(stream);
		    return stream;
		  },
		  doSetAttr(stream, node, attr) {
		    var setattr = stream?.stream_ops.setattr;
		    var arg = setattr ? stream : node;
		    setattr ??= node.node_ops.setattr;
		    FS.checkOpExists(setattr, 63);
		    setattr(arg, attr);
		  },
		  chrdev_stream_ops: {
		    open(stream) {
		      var device = FS.getDevice(stream.node.rdev);
		      // override node's stream ops with the device's
		      stream.stream_ops = device.stream_ops;
		      // forward the open call
		      stream.stream_ops.open?.(stream);
		    },
		    llseek() {
		      throw new FS.ErrnoError(70);
		    }
		  },
		  major: dev => ((dev) >> 8),
		  minor: dev => ((dev) & 255),
		  makedev: (ma, mi) => ((ma) << 8 | (mi)),
		  registerDevice(dev, ops) {
		    FS.devices[dev] = {
		      stream_ops: ops
		    };
		  },
		  getDevice: dev => FS.devices[dev],
		  getMounts(mount) {
		    var mounts = [];
		    var check = [ mount ];
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
		    // sync all mounts
		    mounts.forEach(mount => {
		      if (!mount.type.syncfs) {
		        return done(null);
		      }
		      mount.type.syncfs(mount, populate, done);
		    });
		  },
		  mount(type, opts, mountpoint) {
		    if (typeof type == "string") {
		      // The filesystem was not included, and instead we have an error
		      // message stored in the variable.
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
		      // use the absolute path
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
		    // create a root node for the fs
		    var mountRoot = type.mount(mount);
		    mountRoot.mount = mount;
		    mount.root = mountRoot;
		    if (root) {
		      FS.root = mountRoot;
		    } else if (node) {
		      // set as a mountpoint
		      node.mounted = mount;
		      // add the new mount to the current mount's children
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
		    // destroy the nodes for this mount, and all its child mounts
		    var node = lookup.node;
		    var mount = node.mounted;
		    var mounts = FS.getMounts(mount);
		    Object.keys(FS.nameTable).forEach(hash => {
		      var current = FS.nameTable[hash];
		      while (current) {
		        var next = current.name_next;
		        if (mounts.includes(current.mount)) {
		          FS.destroyNode(current);
		        }
		        current = next;
		      }
		    });
		    // no longer a mountpoint
		    node.mounted = null;
		    // remove this mount from the child mounts
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
		    // We keep a separate statfsStream function because noderawfs overrides
		    // it. In noderawfs, stream.node is sometimes null. Instead, we need to
		    // look at stream.path.
		    return FS.statfsNode(stream.node);
		  },
		  statfsNode(node) {
		    // NOTE: None of the defaults here are true. We're just returning safe and
		    //       sane values. Currently nodefs and rawfs replace these defaults,
		    //       other file systems leave them alone.
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
		    // parents must exist
		    var lookup, old_dir, new_dir;
		    // let the errors from non existent directories percolate up
		    lookup = FS.lookupPath(old_path, {
		      parent: true
		    });
		    old_dir = lookup.node;
		    lookup = FS.lookupPath(new_path, {
		      parent: true
		    });
		    new_dir = lookup.node;
		    if (!old_dir || !new_dir) throw new FS.ErrnoError(44);
		    // need to be part of the same mount
		    if (old_dir.mount !== new_dir.mount) {
		      throw new FS.ErrnoError(75);
		    }
		    // source must exist
		    var old_node = FS.lookupNode(old_dir, old_name);
		    // old path should not be an ancestor of the new path
		    var relative = PATH_FS.relative(old_path, new_dirname);
		    if (relative.charAt(0) !== ".") {
		      throw new FS.ErrnoError(28);
		    }
		    // new path should not be an ancestor of the old path
		    relative = PATH_FS.relative(new_path, old_dirname);
		    if (relative.charAt(0) !== ".") {
		      throw new FS.ErrnoError(55);
		    }
		    // see if the new path already exists
		    var new_node;
		    try {
		      new_node = FS.lookupNode(new_dir, new_name);
		    } catch (e) {}
		    // early out if nothing needs to change
		    if (old_node === new_node) {
		      return;
		    }
		    // we'll need to delete the old entry
		    var isdir = FS.isDir(old_node.mode);
		    var errCode = FS.mayDelete(old_dir, old_name, isdir);
		    if (errCode) {
		      throw new FS.ErrnoError(errCode);
		    }
		    // need delete permissions if we'll be overwriting.
		    // need create permissions if new doesn't already exist.
		    errCode = new_node ? FS.mayDelete(new_dir, new_name, isdir) : FS.mayCreate(new_dir, new_name);
		    if (errCode) {
		      throw new FS.ErrnoError(errCode);
		    }
		    if (!old_dir.node_ops.rename) {
		      throw new FS.ErrnoError(63);
		    }
		    if (FS.isMountpoint(old_node) || (new_node && FS.isMountpoint(new_node))) {
		      throw new FS.ErrnoError(10);
		    }
		    // if we are going to change the parent, check write permissions
		    if (new_dir !== old_dir) {
		      errCode = FS.nodePermissions(old_dir, "w");
		      if (errCode) {
		        throw new FS.ErrnoError(errCode);
		      }
		    }
		    // remove the node from the lookup hash
		    FS.hashRemoveNode(old_node);
		    // do the underlying fs rename
		    try {
		      old_dir.node_ops.rename(old_node, new_dir, new_name);
		      // update old node (we do this here to avoid each backend
		      // needing to)
		      old_node.parent = new_dir;
		    } catch (e) {
		      throw e;
		    } finally {
		      // add the node back to the hash (in case node_ops.rename
		      // changed its name)
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
		      // According to POSIX, we should map EISDIR to EPERM, but
		      // we instead do what Linux does (and we must, as we use
		      // the musl linux libc).
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
		    getattr ??= node.node_ops.getattr;
		    FS.checkOpExists(getattr, 63);
		    return getattr(arg);
		  },
		  lstat(path) {
		    return FS.stat(path, true);
		  },
		  doChmod(stream, node, mode, dontFollow) {
		    FS.doSetAttr(stream, node, {
		      mode: (mode & 4095) | (node.mode & -4096),
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
		    if ((flags & 64)) {
		      mode = (mode & 4095) | 32768;
		    } else {
		      mode = 0;
		    }
		    var node;
		    var isDirPath;
		    if (typeof path == "object") {
		      node = path;
		    } else {
		      isDirPath = path.endsWith("/");
		      // noent_okay makes it so that if the final component of the path
		      // doesn't exist, lookupPath returns `node: undefined`. `path` will be
		      // updated to point to the target of all symlinks.
		      var lookup = FS.lookupPath(path, {
		        follow: !(flags & 131072),
		        noent_okay: true
		      });
		      node = lookup.node;
		      path = lookup.path;
		    }
		    // perhaps we need to create the node
		    var created = false;
		    if ((flags & 64)) {
		      if (node) {
		        // if O_CREAT and O_EXCL are set, error out if the node already exists
		        if ((flags & 128)) {
		          throw new FS.ErrnoError(20);
		        }
		      } else if (isDirPath) {
		        throw new FS.ErrnoError(31);
		      } else {
		        // node doesn't exist, try to create it
		        // Ignore the permission bits here to ensure we can `open` this new
		        // file below. We use chmod below the apply the permissions once the
		        // file is open.
		        node = FS.mknod(path, mode | 511, 0);
		        created = true;
		      }
		    }
		    if (!node) {
		      throw new FS.ErrnoError(44);
		    }
		    // can't truncate a device
		    if (FS.isChrdev(node.mode)) {
		      flags &= -513;
		    }
		    // if asked only for a directory, then this must be one
		    if ((flags & 65536) && !FS.isDir(node.mode)) {
		      throw new FS.ErrnoError(54);
		    }
		    // check permissions, if this is not a file we just created now (it is ok to
		    // create and write to a file with read-only permissions; it is read-only
		    // for later use)
		    if (!created) {
		      var errCode = FS.mayOpen(node, flags);
		      if (errCode) {
		        throw new FS.ErrnoError(errCode);
		      }
		    }
		    // do truncation if necessary
		    if ((flags & 512) && !created) {
		      FS.truncate(node, 0);
		    }
		    // we've already handled these, don't pass down to the underlying vfs
		    flags &= -131713;
		    // register the stream with the filesystem
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
		    // call the new stream's open function
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
		    // free readdir state
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
		      // seek to the end before writing in append mode
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
		    // User requests writing to file (prot & PROT_WRITE != 0).
		    // Checking if we have permissions to write to the file unless
		    // MAP_PRIVATE flag is set. According to POSIX spec it is possible
		    // to write to file opened in read-only mode with MAP_PRIVATE flag,
		    // as all modifications will be visible only in the memory of
		    // the current process.
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
		      FS.write(stream, buf, 0, actualNumBytes, undefined, opts.canOwn);
		    } else if (ArrayBuffer.isView(data)) {
		      FS.write(stream, data, 0, data.byteLength, undefined, opts.canOwn);
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
		    // create /dev
		    FS.mkdir("/dev");
		    // setup /dev/null
		    FS.registerDevice(FS.makedev(1, 3), {
		      read: () => 0,
		      write: (stream, buffer, offset, length, pos) => length,
		      llseek: () => 0
		    });
		    FS.mkdev("/dev/null", FS.makedev(1, 3));
		    // setup /dev/tty and /dev/tty1
		    // stderr needs to print output using err() rather than out()
		    // so we register a second tty just for it.
		    TTY.register(FS.makedev(5, 0), TTY.default_tty_ops);
		    TTY.register(FS.makedev(6, 0), TTY.default_tty1_ops);
		    FS.mkdev("/dev/tty", FS.makedev(5, 0));
		    FS.mkdev("/dev/tty1", FS.makedev(6, 0));
		    // setup /dev/[u]random
		    // use a buffer to avoid overhead of individual crypto calls per byte
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
		    // we're not going to emulate the actual shm device,
		    // just create the tmp dirs that reside in it commonly
		    FS.mkdir("/dev/shm");
		    FS.mkdir("/dev/shm/tmp");
		  },
		  createSpecialDirectories() {
		    // create /proc/self/fd which allows /proc/self/fd/6 => readlink gives the
		    // name of the stream for fd 6 (see test_unistd_ttyname)
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
		            // make it look like a simple root node
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
		    // TODO deprecate the old functionality of a single
		    // input / output callback and that utilizes FS.createDevice
		    // and instead require a unique set of stream ops
		    // by default, we symlink the standard streams to the
		    // default tty devices. however, if the standard streams
		    // have been overwritten we create a unique device for
		    // them instead.
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
		    // open default streams for the stdin, stdout and stderr devices
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
		    // Allow Module.stdin etc. to provide defaults, if none explicitly passed to us here
		    input ??= Module["stdin"];
		    output ??= Module["stdout"];
		    error ??= Module["stderr"];
		    FS.createStandardStreams(input, output, error);
		  },
		  quit() {
		    FS.initialized = false;
		    // force-flush all streams, so we get musl std streams printed out
		    _fflush(0);
		    // close all of our streams
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
		    // operate from within the context of the symlink's target
		    try {
		      var lookup = FS.lookupPath(path, {
		        follow: !dontResolveLastLink
		      });
		      path = lookup.path;
		    } catch (e) {}
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
		      // make sure we can write to the file
		      FS.chmod(node, mode | 146);
		      var stream = FS.open(node, 577);
		      FS.write(stream, data, 0, data.length, 0, canOwn);
		      FS.close(stream);
		      FS.chmod(node, mode);
		    }
		  },
		  createDevice(parent, name, input, output) {
		    var path = PATH.join2(typeof parent == "string" ? parent : FS.getPath(parent), name);
		    var mode = FS_getMode(!!input, !!output);
		    FS.createDevice.major ??= 64;
		    var dev = FS.makedev(FS.createDevice.major++, 0);
		    // Create a fake device that a set of stream ops to emulate
		    // the old behavior.
		    FS.registerDevice(dev, {
		      open(stream) {
		        stream.seekable = false;
		      },
		      close(stream) {
		        // flush any pending line data
		        if (output?.buffer?.length) {
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
		          if (result === undefined && bytesRead === 0) {
		            throw new FS.ErrnoError(6);
		          }
		          if (result === null || result === undefined) break;
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
		      // Command-line.
		      try {
		        obj.contents = readBinary(obj.url);
		        obj.usedBytes = obj.contents.length;
		      } catch (e) {
		        throw new FS.ErrnoError(29);
		      }
		    }
		  },
		  createLazyFile(parent, name, url, canRead, canWrite) {
		    // Lazy chunked Uint8Array (implements get and length from Uint8Array).
		    // Actual getting is abstracted away for eventual reuse.
		    class LazyUint8Array {
		      lengthKnown=false;
		      chunks=[];
		      // Loaded chunks. Index is the chunk number
		      get(idx) {
		        if (idx > this.length - 1 || idx < 0) {
		          return undefined;
		        }
		        var chunkOffset = idx % this.chunkSize;
		        var chunkNum = (idx / this.chunkSize) | 0;
		        return this.getter(chunkNum)[chunkOffset];
		      }
		      setDataGetter(getter) {
		        this.getter = getter;
		      }
		      cacheLength() {
		        // Find length
		        var xhr = new XMLHttpRequest;
		        xhr.open("HEAD", url, false);
		        xhr.send(null);
		        if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
		        var datalength = Number(xhr.getResponseHeader("Content-length"));
		        var header;
		        var hasByteServing = (header = xhr.getResponseHeader("Accept-Ranges")) && header === "bytes";
		        var usesGzip = (header = xhr.getResponseHeader("Content-Encoding")) && header === "gzip";
		        var chunkSize = 1024 * 1024;
		        // Chunk size in bytes
		        if (!hasByteServing) chunkSize = datalength;
		        // Function to get a range from the remote URL.
		        var doXHR = (from, to) => {
		          if (from > to) throw new Error("invalid range (" + from + ", " + to + ") or no bytes requested!");
		          if (to > datalength - 1) throw new Error("only " + datalength + " bytes available! programmer error!");
		          // TODO: Use mozResponseArrayBuffer, responseStream, etc. if available.
		          var xhr = new XMLHttpRequest;
		          xhr.open("GET", url, false);
		          if (datalength !== chunkSize) xhr.setRequestHeader("Range", "bytes=" + from + "-" + to);
		          // Some hints to the browser that we want binary data.
		          xhr.responseType = "arraybuffer";
		          if (xhr.overrideMimeType) {
		            xhr.overrideMimeType("text/plain; charset=x-user-defined");
		          }
		          xhr.send(null);
		          if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
		          if (xhr.response !== undefined) {
		            return new Uint8Array(/** @type{Array<number>} */ (xhr.response || []));
		          }
		          return intArrayFromString(xhr.responseText || "");
		        };
		        var lazyArray = this;
		        lazyArray.setDataGetter(chunkNum => {
		          var start = chunkNum * chunkSize;
		          var end = (chunkNum + 1) * chunkSize - 1;
		          // including this byte
		          end = Math.min(end, datalength - 1);
		          // if datalength-1 is selected, this is the last block
		          if (typeof lazyArray.chunks[chunkNum] == "undefined") {
		            lazyArray.chunks[chunkNum] = doXHR(start, end);
		          }
		          if (typeof lazyArray.chunks[chunkNum] == "undefined") throw new Error("doXHR failed!");
		          return lazyArray.chunks[chunkNum];
		        });
		        if (usesGzip || !datalength) {
		          // if the server uses gzip or doesn't supply the length, we have to download the whole file to get the (uncompressed) length
		          chunkSize = datalength = 1;
		          // this will force getter(0)/doXHR do download the whole file
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
		      var lazyArray = new LazyUint8Array;
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
		    // This is a total hack, but I want to get this lazy file code out of the
		    // core of MEMFS. If we want to keep this lazy file concept I feel it should
		    // be its own thin LAZYFS proxying calls to MEMFS.
		    if (properties.contents) {
		      node.contents = properties.contents;
		    } else if (properties.url) {
		      node.contents = null;
		      node.url = properties.url;
		    }
		    // Add a function that defers querying the file size until it is asked the first time.
		    Object.defineProperties(node, {
		      usedBytes: {
		        get: function() {
		          return this.contents.length;
		        }
		      }
		    });
		    // override each stream op with one that tries to force load the lazy file first
		    var stream_ops = {};
		    var keys = Object.keys(node.stream_ops);
		    keys.forEach(key => {
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
		        // normal array
		        for (var i = 0; i < size; i++) {
		          buffer[offset + i] = contents[position + i];
		        }
		      } else {
		        for (var i = 0; i < size; i++) {
		          // LazyUint8Array from sync binary XHR
		          buffer[offset + i] = contents.get(position + i);
		        }
		      }
		      return size;
		    }
		    // use a custom read function
		    stream_ops.read = (stream, buffer, offset, length, position) => {
		      FS.forceLoadFile(node);
		      return writeChunks(stream, buffer, offset, length, position);
		    };
		    // use a custom mmap function
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
		    // relative path
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
		    HEAP32[((buf) / 4)] = stat.dev;
		    HEAP32[(((buf) + (4)) / 4)] = stat.mode;
		    HEAPU64[(((buf) + (8)) / 8)] = BigInt(stat.nlink);
		    HEAP32[(((buf) + (16)) / 4)] = stat.uid;
		    HEAP32[(((buf) + (20)) / 4)] = stat.gid;
		    HEAP32[(((buf) + (24)) / 4)] = stat.rdev;
		    HEAP64[(((buf) + (32)) / 8)] = BigInt(stat.size);
		    HEAP32[(((buf) + (40)) / 4)] = 4096;
		    HEAP32[(((buf) + (44)) / 4)] = stat.blocks;
		    var atime = stat.atime.getTime();
		    var mtime = stat.mtime.getTime();
		    var ctime = stat.ctime.getTime();
		    HEAP64[(((buf) + (48)) / 8)] = BigInt(Math.floor(atime / 1e3));
		    HEAPU64[(((buf) + (56)) / 8)] = BigInt((atime % 1e3) * 1e3 * 1e3);
		    HEAP64[(((buf) + (64)) / 8)] = BigInt(Math.floor(mtime / 1e3));
		    HEAPU64[(((buf) + (72)) / 8)] = BigInt((mtime % 1e3) * 1e3 * 1e3);
		    HEAP64[(((buf) + (80)) / 8)] = BigInt(Math.floor(ctime / 1e3));
		    HEAPU64[(((buf) + (88)) / 8)] = BigInt((ctime % 1e3) * 1e3 * 1e3);
		    HEAP64[(((buf) + (96)) / 8)] = BigInt(stat.ino);
		    return 0;
		  },
		  writeStatFs(buf, stats) {
		    HEAP32[(((buf) + (8)) / 4)] = stats.bsize;
		    HEAP32[(((buf) + (56)) / 4)] = stats.bsize;
		    HEAP32[(((buf) + (16)) / 4)] = stats.blocks;
		    HEAP32[(((buf) + (20)) / 4)] = stats.bfree;
		    HEAP32[(((buf) + (24)) / 4)] = stats.bavail;
		    HEAP32[(((buf) + (28)) / 4)] = stats.files;
		    HEAP32[(((buf) + (32)) / 4)] = stats.ffree;
		    HEAP32[(((buf) + (36)) / 4)] = stats.fsid;
		    HEAP32[(((buf) + (64)) / 4)] = stats.flags;
		    // ST_NOSUID
		    HEAP32[(((buf) + (48)) / 4)] = stats.namelen;
		  },
		  doMsync(addr, stream, len, flags, offset) {
		    if (!FS.isFile(stream.node.mode)) {
		      throw new FS.ErrnoError(43);
		    }
		    if (flags & 2) {
		      // MAP_PRIVATE calls need not to be synced back to underlying fs
		      return 0;
		    }
		    var buffer = HEAPU8.slice(addr, addr + len);
		    FS.msync(stream, buffer, offset, len, flags);
		  },
		  getStreamFromFD(fd) {
		    var stream = FS.getStreamChecked(fd);
		    return stream;
		  },
		  varargs: undefined,
		  getStr(ptr) {
		    var ret = UTF8ToString(ptr);
		    return ret;
		  }
		};

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
		      // need a valid mode
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
		  assert(SYSCALLS.varargs != undefined);
		  var ret = Number(HEAPU64[((SYSCALLS.varargs) / 8)]);
		  SYSCALLS.varargs += 8;
		  return ret;
		};

		var syscallGetVarargI = () => {
		  assert(SYSCALLS.varargs != undefined);
		  // the `+` prepended here is necessary to convince the JSCompiler that varargs is indeed a number.
		  var ret = HEAP32[((+SYSCALLS.varargs) / 4)];
		  SYSCALLS.varargs += 4;
		  return ret;
		};

		function ___syscall_fcntl64(fd, cmd, varargs) {
		  varargs = bigintToI53Checked(varargs);
		  SYSCALLS.varargs = varargs;
		  try {
		    var stream = SYSCALLS.getStreamFromFD(fd);
		    switch (cmd) {
		     case 0:
		      {
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

		     case 4:
		      {
		        var arg = syscallGetVarargI();
		        stream.flags |= arg;
		        return 0;
		      }

		     case 5:
		      {
		        var arg = syscallGetVarargP();
		        var offset = 0;
		        // We're always unlocked.
		        HEAP16[(((arg) + (offset)) / 2)] = 2;
		        return 0;
		      }

		     case 6:
		     case 7:
		      // Pretend that the locking is successful. These are process-level locks,
		      // and Emscripten programs are a single process. If we supported linking a
		      // filesystem between programs, we'd need to do more here.
		      // See https://github.com/emscripten-core/emscripten/issues/23697
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
		     case 21509:
		      {
		        if (!stream.tty) return -59;
		        return 0;
		      }

		     case 21505:
		      {
		        if (!stream.tty) return -59;
		        if (stream.tty.ops.ioctl_tcgets) {
		          var termios = stream.tty.ops.ioctl_tcgets(stream);
		          var argp = syscallGetVarargP();
		          HEAP32[((argp) / 4)] = termios.c_iflag || 0;
		          HEAP32[(((argp) + (4)) / 4)] = termios.c_oflag || 0;
		          HEAP32[(((argp) + (8)) / 4)] = termios.c_cflag || 0;
		          HEAP32[(((argp) + (12)) / 4)] = termios.c_lflag || 0;
		          for (var i = 0; i < 32; i++) {
		            HEAP8[(argp + i) + (17)] = termios.c_cc[i] || 0;
		          }
		          return 0;
		        }
		        return 0;
		      }

		     case 21510:
		     case 21511:
		     case 21512:
		      {
		        if (!stream.tty) return -59;
		        return 0;
		      }

		     case 21506:
		     case 21507:
		     case 21508:
		      {
		        if (!stream.tty) return -59;
		        if (stream.tty.ops.ioctl_tcsets) {
		          var argp = syscallGetVarargP();
		          var c_iflag = HEAP32[((argp) / 4)];
		          var c_oflag = HEAP32[(((argp) + (4)) / 4)];
		          var c_cflag = HEAP32[(((argp) + (8)) / 4)];
		          var c_lflag = HEAP32[(((argp) + (12)) / 4)];
		          var c_cc = [];
		          for (var i = 0; i < 32; i++) {
		            c_cc.push(HEAP8[(argp + i) + (17)]);
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

		     case 21519:
		      {
		        if (!stream.tty) return -59;
		        var argp = syscallGetVarargP();
		        HEAP32[((argp) / 4)] = 0;
		        return 0;
		      }

		     case 21520:
		      {
		        if (!stream.tty) return -59;
		        return -28;
		      }

		     case 21531:
		      {
		        var argp = syscallGetVarargP();
		        return FS.ioctl(stream, op, argp);
		      }

		     case 21523:
		      {
		        // TODO: in theory we should write to the winsize struct that gets
		        // passed in, but for now musl doesn't read anything on it
		        if (!stream.tty) return -59;
		        if (stream.tty.ops.ioctl_tiocgwinsz) {
		          var winsize = stream.tty.ops.ioctl_tiocgwinsz(stream.tty);
		          var argp = syscallGetVarargP();
		          HEAP16[((argp) / 2)] = winsize[0];
		          HEAP16[(((argp) + (2)) / 2)] = winsize[1];
		        }
		        return 0;
		      }

		     case 21524:
		      {
		        // TODO: technically, this ioctl call should change the window size.
		        // but, since emscripten doesn't have any concept of a terminal window
		        // yet, we'll just silently throw it away as we do TIOCGWINSZ
		        if (!stream.tty) return -59;
		        return 0;
		      }

		     case 21515:
		      {
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
		    flags = flags & (~6400);
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
		    // readlink is one of the rare functions that write out a C string, but does never append a null to the output buffer(!)
		    // stringToUTF8() always appends a null byte, so restore the character under the null byte after the write.
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

		var readI53FromI64 = ptr => HEAPU32[((ptr) / 4)] + HEAP32[(((ptr) + (4)) / 4)] * 4294967296;

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
		      var nanoseconds = HEAP32[(((times) + (8)) / 4)];
		      if (nanoseconds == 1073741823) {
		        atime = now;
		      } else if (nanoseconds == 1073741822) {
		        atime = null;
		      } else {
		        atime = (seconds * 1e3) + (nanoseconds / (1e3 * 1e3));
		      }
		      times += 16;
		      seconds = readI53FromI64(times);
		      nanoseconds = HEAP32[(((times) + (8)) / 4)];
		      if (nanoseconds == 1073741823) {
		        mtime = now;
		      } else if (nanoseconds == 1073741822) {
		        mtime = null;
		      } else {
		        mtime = (seconds * 1e3) + (nanoseconds / (1e3 * 1e3));
		      }
		    }
		    // null here means UTIME_OMIT was passed. If both were set to UTIME_OMIT then
		    // we can skip the call completely.
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
		  HEAP32[((tmPtr) / 4)] = date.getUTCSeconds();
		  HEAP32[(((tmPtr) + (4)) / 4)] = date.getUTCMinutes();
		  HEAP32[(((tmPtr) + (8)) / 4)] = date.getUTCHours();
		  HEAP32[(((tmPtr) + (12)) / 4)] = date.getUTCDate();
		  HEAP32[(((tmPtr) + (16)) / 4)] = date.getUTCMonth();
		  HEAP32[(((tmPtr) + (20)) / 4)] = date.getUTCFullYear() - 1900;
		  HEAP32[(((tmPtr) + (24)) / 4)] = date.getUTCDay();
		  var start = Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
		  var yday = ((date.getTime() - start) / (1e3 * 60 * 60 * 24)) | 0;
		  HEAP32[(((tmPtr) + (28)) / 4)] = yday;
		}

		var isLeapYear = year => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

		var MONTH_DAYS_LEAP_CUMULATIVE = [ 0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335 ];

		var MONTH_DAYS_REGULAR_CUMULATIVE = [ 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334 ];

		var ydayFromDate = date => {
		  var leap = isLeapYear(date.getFullYear());
		  var monthDaysCumulative = (leap ? MONTH_DAYS_LEAP_CUMULATIVE : MONTH_DAYS_REGULAR_CUMULATIVE);
		  var yday = monthDaysCumulative[date.getMonth()] + date.getDate() - 1;
		  // -1 since it's days since Jan 1
		  return yday;
		};

		function __localtime_js(time, tmPtr) {
		  time = bigintToI53Checked(time);
		  tmPtr = bigintToI53Checked(tmPtr);
		  var date = new Date(time * 1e3);
		  HEAP32[((tmPtr) / 4)] = date.getSeconds();
		  HEAP32[(((tmPtr) + (4)) / 4)] = date.getMinutes();
		  HEAP32[(((tmPtr) + (8)) / 4)] = date.getHours();
		  HEAP32[(((tmPtr) + (12)) / 4)] = date.getDate();
		  HEAP32[(((tmPtr) + (16)) / 4)] = date.getMonth();
		  HEAP32[(((tmPtr) + (20)) / 4)] = date.getFullYear() - 1900;
		  HEAP32[(((tmPtr) + (24)) / 4)] = date.getDay();
		  var yday = ydayFromDate(date) | 0;
		  HEAP32[(((tmPtr) + (28)) / 4)] = yday;
		  HEAP64[(((tmPtr) + (40)) / 8)] = BigInt(-(date.getTimezoneOffset() * 60));
		  // Attention: DST is in December in South, and some regions don't have DST at all.
		  var start = new Date(date.getFullYear(), 0, 1);
		  var summerOffset = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
		  var winterOffset = start.getTimezoneOffset();
		  var dst = (summerOffset != winterOffset && date.getTimezoneOffset() == Math.min(winterOffset, summerOffset)) | 0;
		  HEAP32[(((tmPtr) + (32)) / 4)] = dst;
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
		    HEAP32[((allocated) / 4)] = res.allocated;
		    HEAPU64[((addr) / 8)] = BigInt(ptr);
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
		    var time = Date.UTC(HEAP32[(((tmPtr) + (20)) / 4)] + 1900, HEAP32[(((tmPtr) + (16)) / 4)], HEAP32[(((tmPtr) + (12)) / 4)], HEAP32[(((tmPtr) + (8)) / 4)], HEAP32[(((tmPtr) + (4)) / 4)], HEAP32[((tmPtr) / 4)], 0);
		    var date = new Date(time);
		    HEAP32[(((tmPtr) + (24)) / 4)] = date.getUTCDay();
		    var start = Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
		    var yday = ((date.getTime() - start) / (1e3 * 60 * 60 * 24)) | 0;
		    HEAP32[(((tmPtr) + (28)) / 4)] = yday;
		    return date.getTime() / 1e3;
		  })();
		  return BigInt(ret);
		};

		var __tzset_js = function(timezone, daylight, std_name, dst_name) {
		  timezone = bigintToI53Checked(timezone);
		  daylight = bigintToI53Checked(daylight);
		  std_name = bigintToI53Checked(std_name);
		  dst_name = bigintToI53Checked(dst_name);
		  // TODO: Use (malleable) environment variables instead of system settings.
		  var currentYear = (new Date).getFullYear();
		  var winter = new Date(currentYear, 0, 1);
		  var summer = new Date(currentYear, 6, 1);
		  var winterOffset = winter.getTimezoneOffset();
		  var summerOffset = summer.getTimezoneOffset();
		  // Local standard timezone offset. Local standard time is not adjusted for
		  // daylight savings.  This code uses the fact that getTimezoneOffset returns
		  // a greater value during Standard Time versus Daylight Saving Time (DST).
		  // Thus it determines the expected output during Standard Time, and it
		  // compares whether the output of the given date the same (Standard) or less
		  // (DST).
		  var stdTimezoneOffset = Math.max(winterOffset, summerOffset);
		  // timezone is specified as seconds west of UTC ("The external variable
		  // `timezone` shall be set to the difference, in seconds, between
		  // Coordinated Universal Time (UTC) and local standard time."), the same
		  // as returned by stdTimezoneOffset.
		  // See http://pubs.opengroup.org/onlinepubs/009695399/functions/tzset.html
		  HEAPU64[((timezone) / 8)] = BigInt(stdTimezoneOffset * 60);
		  HEAP32[((daylight) / 4)] = Number(winterOffset != summerOffset);
		  var extractZone = timezoneOffset => {
		    // Why inverse sign?
		    // Read here https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/getTimezoneOffset
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
		    // Northern hemisphere
		    stringToUTF8(winterName, std_name, 17);
		    stringToUTF8(summerName, dst_name, 17);
		  } else {
		    stringToUTF8(winterName, dst_name, 17);
		    stringToUTF8(summerName, std_name, 17);
		  }
		};

		var _emscripten_get_now = () => performance.now();

		var _emscripten_date_now = () => Date.now();

		var checkWasiClock = clock_id => clock_id >= 0 && clock_id <= 3;

		function _clock_time_get(clk_id, ignored_precision, ptime) {
		  ptime = bigintToI53Checked(ptime);
		  if (!checkWasiClock(clk_id)) {
		    return 28;
		  }
		  var now;
		  // all wasi clocks but realtime are monotonic
		  if (clk_id === 0) {
		    now = _emscripten_date_now();
		  } else {
		    now = _emscripten_get_now();
		  }
		  // "now" is in ms, and wasi times are in ns.
		  var nsec = Math.round(now * 1e3 * 1e3);
		  HEAP64[((ptime) / 8)] = BigInt(nsec);
		  return 0;
		}

		var readEmAsmArgsArray = [];

		var readEmAsmArgs = (sigPtr, buf) => {
		  // Nobody should have mutated _readEmAsmArgsArray underneath us to be something else than an array.
		  assert(Array.isArray(readEmAsmArgsArray));
		  // The input buffer is allocated on the stack, so it must be stack-aligned.
		  assert(buf % 16 == 0);
		  readEmAsmArgsArray.length = 0;
		  var ch;
		  // Most arguments are i32s, so shift the buffer pointer so it is a plain
		  // index into HEAP32.
		  while (ch = HEAPU8[sigPtr++]) {
		    var chr = String.fromCharCode(ch);
		    var validChars = [ "d", "f", "i", "p" ];
		    // In WASM_BIGINT mode we support passing i64 values as bigint.
		    validChars.push("j");
		    assert(validChars.includes(chr), `Invalid character ${ch}("${chr}") in readEmAsmArgs! Use only [${validChars}], and do not specify "v" for void return argument.`);
		    // Floats are always passed as doubles, so all types except for 'i'
		    // are 8 bytes and require alignment.
		    var wide = (ch != 105);
		    buf += wide && (buf % 8) ? 4 : 0;
		    readEmAsmArgsArray.push(// Special case for pointers under wasm64 or CAN_ADDRESS_2GB mode.
		    ch == 112 ? Number(HEAPU64[((buf) / 8)]) : ch == 106 ? HEAP64[((buf) / 8)] : ch == 105 ? HEAP32[((buf) / 4)] : HEAPF64[((buf) / 8)]);
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

		var growMemory = size => {
		  var b = wasmMemory.buffer;
		  var pages = ((size - b.byteLength + 65535) / 65536) | 0;
		  try {
		    // round size grow request up to wasm page size (fixed 64KB per spec)
		    wasmMemory.grow(BigInt(pages));
		    // .grow() takes a delta compared to the previous size
		    updateMemoryViews();
		    return 1;
		  } catch (e) {
		    err(`growMemory: Attempted to grow heap from ${b.byteLength} bytes to ${size} bytes, but got error: ${e}`);
		  }
		};

		function _emscripten_resize_heap(requestedSize) {
		  requestedSize = bigintToI53Checked(requestedSize);
		  var oldSize = HEAPU8.length;
		  // With multithreaded builds, races can happen (another thread might increase the size
		  // in between), so return a failure, and let the caller retry.
		  assert(requestedSize > oldSize);
		  // Memory resize rules:
		  // 1.  Always increase heap size to at least the requested size, rounded up
		  //     to next page multiple.
		  // 2a. If MEMORY_GROWTH_LINEAR_STEP == -1, excessively resize the heap
		  //     geometrically: increase the heap size according to
		  //     MEMORY_GROWTH_GEOMETRIC_STEP factor (default +20%), At most
		  //     overreserve by MEMORY_GROWTH_GEOMETRIC_CAP bytes (default 96MB).
		  // 2b. If MEMORY_GROWTH_LINEAR_STEP != -1, excessively resize the heap
		  //     linearly: increase the heap size by at least
		  //     MEMORY_GROWTH_LINEAR_STEP bytes.
		  // 3.  Max size for the heap is capped at 2048MB-WASM_PAGE_SIZE, or by
		  //     MAXIMUM_MEMORY, or by ASAN limit, depending on which is smallest
		  // 4.  If we were unable to allocate as much memory, it may be due to
		  //     over-eager decision to excessively reserve due to (3) above.
		  //     Hence if an allocation fails, cut down on the amount of excess
		  //     growth, in an attempt to succeed to perform a smaller allocation.
		  // A limit is set for how much we can grow. We should not exceed that
		  // (the wasm binary specifies it, so if we tried, we'd fail anyhow).
		  var maxHeapSize = getHeapMax();
		  if (requestedSize > maxHeapSize) {
		    err(`Cannot enlarge memory, requested ${requestedSize} bytes, but the limit is ${maxHeapSize} bytes!`);
		    return false;
		  }
		  // Loop through potential heap size increases. If we attempt a too eager
		  // reservation that fails, cut down on the attempted size and reserve a
		  // smaller bump instead. (max 3 times, chosen somewhat arbitrarily)
		  for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
		    var overGrownHeapSize = oldSize * (1 + .2 / cutDown);
		    // ensure geometric growth
		    // but limit overreserving (default to capping at +96MB overgrowth at most)
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

		/** @returns {number} */ var convertFrameToPC = frame => {
		  abort("Cannot use convertFrameToPC (needed by __builtin_return_address) without -sUSE_OFFSET_CONVERTER");
		  // return 0 if we can't find any
		  return 0;
		};

		var UNWIND_CACHE = {};

		var saveInUnwindCache = callstack => {
		  callstack.forEach(frame => {
		    convertFrameToPC();
		  });
		};

		var jsStackTrace = () => (new Error).stack.toString();

		var _emscripten_stack_snapshot = function() {
		  var ret = (() => {
		    var callstack = jsStackTrace().split("\n");
		    if (callstack[0] == "Error") {
		      callstack.shift();
		    }
		    saveInUnwindCache(callstack);
		    // Caches the stack snapshot so that emscripten_stack_unwind_buffer() can
		    // unwind from this spot.
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
		    HEAP32[(((buffer) + (i * 4)) / 4)] = convertFrameToPC(stack[i + offset]);
		  }
		  return i;
		}

		var ENV = {};

		var getExecutableName = () => thisProgram || "./this.program";

		var getEnvStrings = () => {
		  if (!getEnvStrings.strings) {
		    // Default values.
		    // Browser language detection #8751
		    var lang = ((typeof navigator == "object" && navigator.languages && navigator.languages[0]) || "C").replace("-", "_") + ".UTF-8";
		    var env = {
		      "USER": "web_user",
		      "LOGNAME": "web_user",
		      "PATH": "/",
		      "PWD": "/",
		      "HOME": "/home/web_user",
		      "LANG": lang,
		      "_": getExecutableName()
		    };
		    // Apply the user-provided values, if any.
		    for (var x in ENV) {
		      // x is a key in ENV; if ENV[x] is undefined, that means it was
		      // explicitly set to be so. We allow user code to do that to
		      // force variables with default values to remain unset.
		      if (ENV[x] === undefined) delete env[x]; else env[x] = ENV[x];
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
		    HEAPU64[(((__environ) + (envp)) / 8)] = BigInt(ptr);
		    bufSize += stringToUTF8(string, ptr, Infinity) + 1;
		    envp += 8;
		  }
		  return 0;
		}

		function _environ_sizes_get(penviron_count, penviron_buf_size) {
		  penviron_count = bigintToI53Checked(penviron_count);
		  penviron_buf_size = bigintToI53Checked(penviron_buf_size);
		  var strings = getEnvStrings();
		  HEAPU64[((penviron_count) / 8)] = BigInt(strings.length);
		  var bufSize = 0;
		  for (var string of strings) {
		    bufSize += lengthBytesUTF8(string) + 1;
		  }
		  HEAPU64[((penviron_buf_size) / 8)] = BigInt(bufSize);
		  return 0;
		}

		var runtimeKeepaliveCounter = 0;

		var keepRuntimeAlive = () => noExitRuntime || runtimeKeepaliveCounter > 0;

		var _proc_exit = code => {
		  EXITSTATUS = code;
		  if (!keepRuntimeAlive()) {
		    Module["onExit"]?.(code);
		    ABORT = true;
		  }
		  quit_(code, new ExitStatus(code));
		};

		/** @suppress {duplicate } */ /** @param {boolean|number=} implicit */ var exitJS = (status, implicit) => {
		  EXITSTATUS = status;
		  checkUnflushedContent();
		  // if exit() was called explicitly, warn the user if the runtime isn't actually being shut down
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
		      // All character devices are terminals (other things a Linux system would
		      // assume is a character device, like the mouse, we have special APIs for).
		      var type = stream.tty ? 2 : FS.isDir(stream.mode) ? 3 : FS.isLink(stream.mode) ? 7 : 4;
		    }
		    HEAP8[pbuf] = type;
		    HEAP16[(((pbuf) + (2)) / 2)] = flags;
		    HEAP64[(((pbuf) + (8)) / 8)] = BigInt(rightsBase);
		    HEAP64[(((pbuf) + (16)) / 8)] = BigInt(rightsInheriting);
		    return 0;
		  } catch (e) {
		    if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
		    return e.errno;
		  }
		}

		/** @param {number=} offset */ var doReadv = (stream, iov, iovcnt, offset) => {
		  var ret = 0;
		  for (var i = 0; i < iovcnt; i++) {
		    var ptr = Number(HEAPU64[((iov) / 8)]);
		    var len = Number(HEAPU64[(((iov) + (8)) / 8)]);
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
		    HEAPU64[((pnum) / 8)] = BigInt(num);
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
		    HEAP64[((newOffset) / 8)] = BigInt(stream.position);
		    if (stream.getdents && offset === 0 && whence === 0) stream.getdents = null;
		    // reset readdir state
		    return 0;
		  } catch (e) {
		    if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
		    return e.errno;
		  }
		}

		function _fd_sync(fd) {
		  try {
		    var stream = SYSCALLS.getStreamFromFD(fd);
		    if (stream.stream_ops?.fsync) {
		      return stream.stream_ops.fsync(stream);
		    }
		    return 0;
		  } catch (e) {
		    if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
		    return e.errno;
		  }
		}

		/** @param {number=} offset */ var doWritev = (stream, iov, iovcnt, offset) => {
		  var ret = 0;
		  for (var i = 0; i < iovcnt; i++) {
		    var ptr = Number(HEAPU64[((iov) / 8)]);
		    var len = Number(HEAPU64[(((iov) + (8)) / 8)]);
		    iov += 16;
		    var curr = FS.write(stream, HEAP8, ptr, len, offset);
		    if (curr < 0) return -1;
		    ret += curr;
		    if (curr < len) {
		      // No more space to write.
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
		    HEAPU64[((pnum) / 8)] = BigInt(num);
		    return 0;
		  } catch (e) {
		    if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
		    return e.errno;
		  }
		}

		var handleException = e => {
		  // Certain exception types we do not treat as errors since they are used for
		  // internal control flow.
		  // 1. ExitStatus, which is thrown by exit()
		  // 2. "unwind", which is thrown by emscripten_unwind_to_js_event_loop() and others
		  //    that wish to return to JS event loop.
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

		var stackAlloc = sz => __emscripten_stack_alloc(sz);

		var stringToUTF8OnStack = str => {
		  var size = lengthBytesUTF8(str) + 1;
		  var ret = stackAlloc(size);
		  stringToUTF8(str, ret, size);
		  return ret;
		};

		var getCFunc = ident => {
		  var func = Module["_" + ident];
		  // closure exported function
		  assert(func, "Cannot call unknown function " + ident + ", make sure it is exported");
		  return func;
		};

		var writeArrayToMemory = (array, buffer) => {
		  assert(array.length >= 0, "writeArrayToMemory array must have a length (should be an array or typed array)");
		  HEAP8.set(array, buffer);
		};

		/**
		     * @param {string|null=} returnType
		     * @param {Array=} argTypes
		     * @param {Arguments|Array=} args
		     * @param {Object=} opts
		     */ var ccall = (ident, returnType, argTypes, args, opts) => {
		  // For fast lookup of conversion functions
		  var toC = {
		    "pointer": p => BigInt(p),
		    "string": str => {
		      var ret = 0;
		      if (str !== null && str !== undefined && str !== 0) {
		        // null string
		        ret = stringToUTF8OnStack(str);
		      }
		      return BigInt(ret);
		    },
		    "array": arr => {
		      var ret = stackAlloc(arr.length);
		      writeArrayToMemory(arr, ret);
		      return BigInt(ret);
		    }
		  };
		  function convertReturnValue(ret) {
		    if (returnType === "string") {
		      return UTF8ToString(Number(ret));
		    }
		    if (returnType === "pointer") return Number(ret);
		    if (returnType === "boolean") return Boolean(ret);
		    return ret;
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
		  function onDone(ret) {
		    if (stack !== 0) stackRestore(stack);
		    return convertReturnValue(ret);
		  }
		  ret = onDone(ret);
		  return ret;
		};

		var uleb128Encode = (n, target) => {
		  assert(n < 16384);
		  if (n < 128) {
		    target.push(n);
		  } else {
		    target.push((n % 128) | 128, n >> 7);
		  }
		};

		var sigToWasmTypes = sig => {
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
		    results: sig[0] == "v" ? [] : [ typeNames[sig[0]] ]
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
		  // Parameters, length + signatures
		  target.push(96);
		  uleb128Encode(sigParam.length, target);
		  for (var paramType of sigParam) {
		    assert(paramType in typeCodes, `invalid signature char: ${paramType}`);
		    target.push(typeCodes[paramType]);
		  }
		  // Return values, length + signatures
		  // With no multi-return in MVP, either 0 (void) or 1 (anything else)
		  if (sigRet == "v") {
		    target.push(0);
		  } else {
		    target.push(1, typeCodes[sigRet]);
		  }
		};

		var convertJsFunctionToWasm = (func, sig) => {
		  // If the type reflection proposal is available, use the new
		  // "WebAssembly.Function" constructor.
		  // Otherwise, construct a minimal wasm module importing the JS function and
		  // re-exporting it.
		  if (typeof WebAssembly.Function == "function") {
		    return new WebAssembly.Function(sigToWasmTypes(sig), func);
		  }
		  // The module is static, with the exception of the type section, which is
		  // generated based on the signature passed in.
		  var typeSectionBody = [ 1 ];
		  generateFuncType(sig, typeSectionBody);
		  // Rest of the module is static
		  var bytes = [ 0, 97, 115, 109, // magic ("\0asm")
		  1, 0, 0, 0, // version: 1
		  1 ];
		  // Write the overall length of the type section followed by the body
		  uleb128Encode(typeSectionBody.length, bytes);
		  bytes.push(...typeSectionBody);
		  // The rest of the module is static
		  bytes.push(2, 7, // import section
		  // (import "e" "f" (func 0 (type 0)))
		  1, 1, 101, 1, 102, 0, 0, 7, 5, // export section
		  // (export "f" (func 0 (type 0)))
		  1, 1, 102, 0, 0);
		  // We can compile this wasm module synchronously because it is very small.
		  // This accepts an import (at "e.f"), that it reroutes to an export (at "f")
		  var module = new WebAssembly.Module(new Uint8Array(bytes));
		  var instance = new WebAssembly.Instance(module, {
		    "e": {
		      "f": func
		    }
		  });
		  var wrappedFunc = instance.exports["f"];
		  return wrappedFunc;
		};

		var wasmTableMirror = [];

		/** @type {WebAssembly.Table} */ var wasmTable;

		var getWasmTableEntry = funcPtr => {
		  // Function pointers should show up as numbers, even under wasm64, but
		  // we still have some places where bigint values can flow here.
		  // https://github.com/emscripten-core/emscripten/issues/18200
		  funcPtr = Number(funcPtr);
		  var func = wasmTableMirror[funcPtr];
		  if (!func) {
		    /** @suppress {checkTypes} */ wasmTableMirror[funcPtr] = func = wasmTable.get(BigInt(funcPtr));
		  }
		  /** @suppress {checkTypes} */ assert(wasmTable.get(BigInt(funcPtr)) == func, "JavaScript-side Wasm function table mirror is out of date!");
		  return func;
		};

		var updateTableMap = (offset, count) => {
		  if (functionsInTableMap) {
		    for (var i = offset; i < offset + count; i++) {
		      var item = getWasmTableEntry(i);
		      // Ignore null values.
		      if (item) {
		        functionsInTableMap.set(item, i);
		      }
		    }
		  }
		};

		var functionsInTableMap;

		var getFunctionAddress = func => {
		  // First, create the map if this is the first use.
		  if (!functionsInTableMap) {
		    functionsInTableMap = new WeakMap;
		    updateTableMap(0, Number(wasmTable.length));
		  }
		  return functionsInTableMap.get(func) || 0;
		};

		var freeTableIndexes = [];

		var getEmptyTableSlot = () => {
		  // Reuse a free index if there is one, otherwise grow.
		  if (freeTableIndexes.length) {
		    return freeTableIndexes.pop();
		  }
		  // Grow the table
		  try {
		    /** @suppress {checkTypes} */ wasmTable.grow(BigInt(1));
		  } catch (err) {
		    if (!(err instanceof RangeError)) {
		      throw err;
		    }
		    throw "Unable to grow wasm table. Set ALLOW_TABLE_GROWTH.";
		  }
		  return Number(wasmTable.length) - 1;
		};

		var setWasmTableEntry = (idx, func) => {
		  /** @suppress {checkTypes} */ wasmTable.set(BigInt(idx), func);
		  // With ABORT_ON_WASM_EXCEPTIONS wasmTable.get is overridden to return wrapped
		  // functions so we need to call it here to retrieve the potential wrapper correctly
		  // instead of just storing 'func' directly into wasmTableMirror
		  /** @suppress {checkTypes} */ wasmTableMirror[idx] = wasmTable.get(BigInt(idx));
		};

		/** @param {string=} sig */ var addFunction = (func, sig) => {
		  assert(typeof func != "undefined");
		  // Check if the function is already in the table, to ensure each function
		  // gets a unique index.
		  var rtn = getFunctionAddress(func);
		  if (rtn) {
		    return rtn;
		  }
		  // It's not in the table, add it now.
		  var ret = getEmptyTableSlot();
		  // Set the new value.
		  try {
		    // Attempting to call this with JS function will cause of table.set() to fail
		    setWasmTableEntry(ret, func);
		  } catch (err) {
		    if (!(err instanceof TypeError)) {
		      throw err;
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

		// End JS library code
		// include: postlibrary.js
		// This file is included after the automatically-generated JS library code
		// but before the wasm module is created.
		{
		  // Begin ATMODULES hooks
		  if (Module["noExitRuntime"]) noExitRuntime = Module["noExitRuntime"];
		  if (Module["preloadPlugins"]) preloadPlugins = Module["preloadPlugins"];
		  if (Module["print"]) out = Module["print"];
		  if (Module["printErr"]) err = Module["printErr"];
		  if (Module["wasmBinary"]) wasmBinary = Module["wasmBinary"];
		  // End ATMODULES hooks
		  checkIncomingModuleAPI();
		  if (Module["arguments"]) arguments_ = Module["arguments"];
		  if (Module["thisProgram"]) thisProgram = Module["thisProgram"];
		  // Assertions on removed incoming Module JS APIs.
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
		  // If memory is defined in wasm, the user can't provide it, or set INITIAL_MEMORY
		  assert(typeof Module["wasmMemory"] == "undefined", "Use of `wasmMemory` detected.  Use -sIMPORTED_MEMORY to define wasmMemory externally");
		  assert(typeof Module["INITIAL_MEMORY"] == "undefined", "Detected runtime INITIAL_MEMORY setting.  Use -sIMPORTED_MEMORY to define wasmMemory dynamically");
		}

		// Begin runtime exports
		Module["callMain"] = callMain;

		Module["ccall"] = ccall;

		Module["addFunction"] = addFunction;

		Module["FS"] = FS;

		var missingLibrarySymbols = [ "writeI53ToI64", "writeI53ToI64Clamped", "writeI53ToI64Signaling", "writeI53ToU64Clamped", "writeI53ToU64Signaling", "readI53FromU64", "convertI32PairToI53", "convertI32PairToI53Checked", "convertU32PairToI53", "getTempRet0", "setTempRet0", "inetPton4", "inetNtop4", "inetPton6", "inetNtop6", "readSockaddr", "writeSockaddr", "emscriptenLog", "runMainThreadEmAsm", "jstoi_q", "listenOnce", "autoResumeAudioContext", "getDynCaller", "dynCall", "runtimeKeepalivePush", "runtimeKeepalivePop", "callUserCallback", "maybeExit", "asmjsMangle", "HandleAllocator", "getNativeTypeSize", "addOnInit", "addOnPostCtor", "addOnPreMain", "addOnExit", "STACK_SIZE", "STACK_ALIGN", "POINTER_SIZE", "ASSERTIONS", "cwrap", "removeFunction", "reallyNegative", "unSign", "strLen", "reSign", "formatString", "intArrayToString", "AsciiToString", "stringToAscii", "UTF16ToString", "stringToUTF16", "lengthBytesUTF16", "UTF32ToString", "stringToUTF32", "lengthBytesUTF32", "stringToNewUTF8", "registerKeyEventCallback", "maybeCStringToJsString", "findEventTarget", "getBoundingClientRect", "fillMouseEventData", "registerMouseEventCallback", "registerWheelEventCallback", "registerUiEventCallback", "registerFocusEventCallback", "fillDeviceOrientationEventData", "registerDeviceOrientationEventCallback", "fillDeviceMotionEventData", "registerDeviceMotionEventCallback", "screenOrientation", "fillOrientationChangeEventData", "registerOrientationChangeEventCallback", "fillFullscreenChangeEventData", "registerFullscreenChangeEventCallback", "JSEvents_requestFullscreen", "JSEvents_resizeCanvasForFullscreen", "registerRestoreOldStyle", "hideEverythingExceptGivenElement", "restoreHiddenElements", "setLetterbox", "softFullscreenResizeWebGLRenderTarget", "doRequestFullscreen", "fillPointerlockChangeEventData", "registerPointerlockChangeEventCallback", "registerPointerlockErrorEventCallback", "requestPointerLock", "fillVisibilityChangeEventData", "registerVisibilityChangeEventCallback", "registerTouchEventCallback", "fillGamepadEventData", "registerGamepadEventCallback", "registerBeforeUnloadEventCallback", "fillBatteryEventData", "battery", "registerBatteryEventCallback", "setCanvasElementSize", "getCanvasElementSize", "getCallstack", "convertPCtoSourceLocation", "wasiRightsToMuslOFlags", "wasiOFlagsToMuslOFlags", "safeSetTimeout", "setImmediateWrapped", "safeRequestAnimationFrame", "clearImmediateWrapped", "registerPostMainLoop", "registerPreMainLoop", "getPromise", "makePromise", "idsToPromises", "makePromiseCallback", "ExceptionInfo", "findMatchingCatch", "Browser_asyncPrepareDataCounter", "arraySum", "addDays", "getSocketFromFD", "getSocketAddress", "FS_mkdirTree", "_setNetworkCallback", "heapObjectForWebGLType", "toTypedArrayIndex", "webgl_enable_ANGLE_instanced_arrays", "webgl_enable_OES_vertex_array_object", "webgl_enable_WEBGL_draw_buffers", "webgl_enable_WEBGL_multi_draw", "webgl_enable_EXT_polygon_offset_clamp", "webgl_enable_EXT_clip_control", "webgl_enable_WEBGL_polygon_mode", "emscriptenWebGLGet", "computeUnpackAlignedImageSize", "colorChannelsInGlTextureFormat", "emscriptenWebGLGetTexPixelData", "emscriptenWebGLGetUniform", "webglGetUniformLocation", "webglPrepareUniformLocationsBeforeFirstUse", "webglGetLeftBracePos", "emscriptenWebGLGetVertexAttrib", "__glGetActiveAttribOrUniform", "writeGLArray", "registerWebGlEventCallback", "runAndAbortIfError", "ALLOC_NORMAL", "ALLOC_STACK", "allocate", "writeStringToMemory", "writeAsciiToMemory", "demangle", "stackTrace" ];

		missingLibrarySymbols.forEach(missingLibrarySymbol);

		var unexportedSymbols = [ "run", "addRunDependency", "removeRunDependency", "out", "err", "abort", "wasmMemory", "wasmExports", "HEAPF32", "HEAPF64", "HEAP8", "HEAP16", "HEAPU16", "HEAP32", "HEAPU32", "HEAP64", "HEAPU64", "writeStackCookie", "checkStackCookie", "readI53FromI64", "INT53_MAX", "INT53_MIN", "bigintToI53Checked", "stackSave", "stackRestore", "stackAlloc", "ptrToString", "zeroMemory", "exitJS", "getHeapMax", "growMemory", "ENV", "ERRNO_CODES", "strError", "DNS", "Protocols", "Sockets", "timers", "warnOnce", "readEmAsmArgsArray", "readEmAsmArgs", "runEmAsmFunction", "getExecutableName", "handleException", "keepRuntimeAlive", "asyncLoad", "alignMemory", "mmapAlloc", "wasmTable", "noExitRuntime", "addOnPreRun", "addOnPostRun", "getCFunc", "uleb128Encode", "sigToWasmTypes", "generateFuncType", "convertJsFunctionToWasm", "freeTableIndexes", "functionsInTableMap", "getEmptyTableSlot", "updateTableMap", "getFunctionAddress", "setValue", "getValue", "PATH", "PATH_FS", "UTF8Decoder", "UTF8ArrayToString", "UTF8ToString", "stringToUTF8Array", "stringToUTF8", "lengthBytesUTF8", "intArrayFromString", "UTF16Decoder", "stringToUTF8OnStack", "writeArrayToMemory", "JSEvents", "specialHTMLTargets", "findCanvasEventTarget", "currentFullscreenStrategy", "restoreOldWindowedStyle", "jsStackTrace", "UNWIND_CACHE", "ExitStatus", "getEnvStrings", "checkWasiClock", "doReadv", "doWritev", "initRandomFill", "randomFill", "emSetImmediate", "emClearImmediate_deps", "emClearImmediate", "promiseMap", "uncaughtExceptionCount", "exceptionLast", "exceptionCaught", "Browser", "getPreloadedImageData__data", "wget", "MONTH_DAYS_REGULAR", "MONTH_DAYS_LEAP", "MONTH_DAYS_REGULAR_CUMULATIVE", "MONTH_DAYS_LEAP_CUMULATIVE", "isLeapYear", "ydayFromDate", "SYSCALLS", "preloadPlugins", "FS_createPreloadedFile", "FS_modeStringToFlags", "FS_getMode", "FS_stdin_getChar_buffer", "FS_stdin_getChar", "FS_unlink", "FS_createPath", "FS_createDevice", "FS_readFile", "FS_root", "FS_mounts", "FS_devices", "FS_streams", "FS_nextInode", "FS_nameTable", "FS_currentPath", "FS_initialized", "FS_ignorePermissions", "FS_filesystems", "FS_syncFSRequests", "FS_readFiles", "FS_lookupPath", "FS_getPath", "FS_hashName", "FS_hashAddNode", "FS_hashRemoveNode", "FS_lookupNode", "FS_createNode", "FS_destroyNode", "FS_isRoot", "FS_isMountpoint", "FS_isFile", "FS_isDir", "FS_isLink", "FS_isChrdev", "FS_isBlkdev", "FS_isFIFO", "FS_isSocket", "FS_flagsToPermissionString", "FS_nodePermissions", "FS_mayLookup", "FS_mayCreate", "FS_mayDelete", "FS_mayOpen", "FS_checkOpExists", "FS_nextfd", "FS_getStreamChecked", "FS_getStream", "FS_createStream", "FS_closeStream", "FS_dupStream", "FS_doSetAttr", "FS_chrdev_stream_ops", "FS_major", "FS_minor", "FS_makedev", "FS_registerDevice", "FS_getDevice", "FS_getMounts", "FS_syncfs", "FS_mount", "FS_unmount", "FS_lookup", "FS_mknod", "FS_statfs", "FS_statfsStream", "FS_statfsNode", "FS_create", "FS_mkdir", "FS_mkdev", "FS_symlink", "FS_rename", "FS_rmdir", "FS_readdir", "FS_readlink", "FS_stat", "FS_fstat", "FS_lstat", "FS_doChmod", "FS_chmod", "FS_lchmod", "FS_fchmod", "FS_doChown", "FS_chown", "FS_lchown", "FS_fchown", "FS_doTruncate", "FS_truncate", "FS_ftruncate", "FS_utime", "FS_open", "FS_close", "FS_isClosed", "FS_llseek", "FS_read", "FS_write", "FS_mmap", "FS_msync", "FS_ioctl", "FS_writeFile", "FS_cwd", "FS_chdir", "FS_createDefaultDirectories", "FS_createDefaultDevices", "FS_createSpecialDirectories", "FS_createStandardStreams", "FS_staticInit", "FS_init", "FS_quit", "FS_findObject", "FS_analyzePath", "FS_createFile", "FS_createDataFile", "FS_forceLoadFile", "FS_createLazyFile", "FS_absolutePath", "FS_createFolder", "FS_createLink", "FS_joinPath", "FS_mmapAlloc", "FS_standardizePath", "MEMFS", "TTY", "PIPEFS", "SOCKFS", "tempFixedLengthArray", "miniTempWebGLFloatBuffers", "miniTempWebGLIntBuffers", "GL", "AL", "GLUT", "EGL", "GLEW", "IDBStore", "SDL", "SDL_gfx", "allocateUTF8", "allocateUTF8OnStack", "print", "printErr", "jstoi_s", "WORKERFS" ];

		unexportedSymbols.forEach(unexportedRuntimeSymbol);

		// End runtime exports
		// Begin JS library exports
		// End JS library exports
		// end include: postlibrary.js
		function checkIncomingModuleAPI() {
		  ignoredModuleProp("fetchSettings");
		}

		var ASM_CONSTS = {
		  5114368: () => (typeof wasmOffsetConverter !== "undefined")
		};

		function HaveOffsetConverter() {
		  return typeof wasmOffsetConverter !== "undefined";
		}

		var wasmImports = {
		  /** @export */ HaveOffsetConverter,
		  /** @export */ __assert_fail: ___assert_fail,
		  /** @export */ __syscall_chmod: ___syscall_chmod,
		  /** @export */ __syscall_faccessat: ___syscall_faccessat,
		  /** @export */ __syscall_fchmod: ___syscall_fchmod,
		  /** @export */ __syscall_fchown32: ___syscall_fchown32,
		  /** @export */ __syscall_fcntl64: ___syscall_fcntl64,
		  /** @export */ __syscall_fstat64: ___syscall_fstat64,
		  /** @export */ __syscall_ftruncate64: ___syscall_ftruncate64,
		  /** @export */ __syscall_getcwd: ___syscall_getcwd,
		  /** @export */ __syscall_ioctl: ___syscall_ioctl,
		  /** @export */ __syscall_lstat64: ___syscall_lstat64,
		  /** @export */ __syscall_mkdirat: ___syscall_mkdirat,
		  /** @export */ __syscall_newfstatat: ___syscall_newfstatat,
		  /** @export */ __syscall_openat: ___syscall_openat,
		  /** @export */ __syscall_readlinkat: ___syscall_readlinkat,
		  /** @export */ __syscall_rmdir: ___syscall_rmdir,
		  /** @export */ __syscall_stat64: ___syscall_stat64,
		  /** @export */ __syscall_unlinkat: ___syscall_unlinkat,
		  /** @export */ __syscall_utimensat: ___syscall_utimensat,
		  /** @export */ _abort_js: __abort_js,
		  /** @export */ _gmtime_js: __gmtime_js,
		  /** @export */ _localtime_js: __localtime_js,
		  /** @export */ _mmap_js: __mmap_js,
		  /** @export */ _munmap_js: __munmap_js,
		  /** @export */ _timegm_js: __timegm_js,
		  /** @export */ _tzset_js: __tzset_js,
		  /** @export */ clock_time_get: _clock_time_get,
		  /** @export */ emscripten_asm_const_int: _emscripten_asm_const_int,
		  /** @export */ emscripten_date_now: _emscripten_date_now,
		  /** @export */ emscripten_err: _emscripten_err,
		  /** @export */ emscripten_errn: _emscripten_errn,
		  /** @export */ emscripten_get_heap_max: _emscripten_get_heap_max,
		  /** @export */ emscripten_get_now: _emscripten_get_now,
		  /** @export */ emscripten_pc_get_function: _emscripten_pc_get_function,
		  /** @export */ emscripten_resize_heap: _emscripten_resize_heap,
		  /** @export */ emscripten_stack_snapshot: _emscripten_stack_snapshot,
		  /** @export */ emscripten_stack_unwind_buffer: _emscripten_stack_unwind_buffer,
		  /** @export */ environ_get: _environ_get,
		  /** @export */ environ_sizes_get: _environ_sizes_get,
		  /** @export */ exit: _exit,
		  /** @export */ fd_close: _fd_close,
		  /** @export */ fd_fdstat_get: _fd_fdstat_get,
		  /** @export */ fd_read: _fd_read,
		  /** @export */ fd_seek: _fd_seek,
		  /** @export */ fd_sync: _fd_sync,
		  /** @export */ fd_write: _fd_write,
		  /** @export */ proc_exit: _proc_exit
		};

		var wasmExports = createWasm();

		var _strerror = createExportWrapper("strerror", 1);

		var _fflush = createExportWrapper("fflush", 1);

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

		var _emscripten_stack_get_end = wasmExports["emscripten_stack_get_end"];

		wasmExports["emscripten_stack_get_base"];

		var _emscripten_builtin_memalign = createExportWrapper("emscripten_builtin_memalign", 2);

		var _emscripten_stack_init = wasmExports["emscripten_stack_init"];

		wasmExports["emscripten_stack_get_free"];

		var __emscripten_stack_restore = wasmExports["_emscripten_stack_restore"];

		var __emscripten_stack_alloc = wasmExports["_emscripten_stack_alloc"];

		var _emscripten_stack_get_current = wasmExports["emscripten_stack_get_current"];

		// Argument name here must shadow the `wasmExports` global so
		// that it is recognised by metadce and minify-import-export-names
		// passes.
		function applySignatureConversions(wasmExports) {
		  // First, make a copy of the incoming exports object
		  wasmExports = Object.assign({}, wasmExports);
		  var makeWrapper_p_ = f => a0 => Number(f(a0));
		  var makeWrapper__p = f => a0 => f(BigInt(a0));
		  var makeWrapper___PP = f => (a0, a1, a2) => f(a0, BigInt(a1 ? a1 : 0), BigInt(a2 ? a2 : 0));
		  var makeWrapper_p = f => () => Number(f());
		  var makeWrapper_ppp = f => (a0, a1) => Number(f(BigInt(a0), BigInt(a1)));
		  var makeWrapper_pp = f => a0 => Number(f(BigInt(a0)));
		  wasmExports["strerror"] = makeWrapper_p_(wasmExports["strerror"]);
		  wasmExports["fflush"] = makeWrapper__p(wasmExports["fflush"]);
		  wasmExports["__main_argc_argv"] = makeWrapper___PP(wasmExports["__main_argc_argv"]);
		  wasmExports["emscripten_stack_get_end"] = makeWrapper_p(wasmExports["emscripten_stack_get_end"]);
		  wasmExports["emscripten_stack_get_base"] = makeWrapper_p(wasmExports["emscripten_stack_get_base"]);
		  wasmExports["emscripten_builtin_memalign"] = makeWrapper_ppp(wasmExports["emscripten_builtin_memalign"]);
		  wasmExports["_emscripten_stack_restore"] = makeWrapper__p(wasmExports["_emscripten_stack_restore"]);
		  wasmExports["_emscripten_stack_alloc"] = makeWrapper_pp(wasmExports["_emscripten_stack_alloc"]);
		  wasmExports["emscripten_stack_get_current"] = makeWrapper_p(wasmExports["emscripten_stack_get_current"]);
		  return wasmExports;
		}

		// include: postamble.js
		// === Auto-generated postamble setup entry stuff ===
		var calledRun;

		function callMain(args = []) {
		  assert(runDependencies == 0, 'cannot call main when async dependencies remain! (listen on Module["onRuntimeInitialized"])');
		  assert(typeof onPreRuns === "undefined" || onPreRuns.length == 0, "cannot call main when preRun functions remain to be called");
		  var entryFunction = _main;
		  args.unshift(thisProgram);
		  var argc = args.length;
		  var argv = stackAlloc((argc + 1) * 8);
		  var argv_ptr = argv;
		  args.forEach(arg => {
		    HEAPU64[((argv_ptr) / 8)] = BigInt(stringToUTF8OnStack(arg));
		    argv_ptr += 8;
		  });
		  HEAPU64[((argv_ptr) / 8)] = BigInt(0);
		  try {
		    var ret = entryFunction(argc, BigInt(argv));
		    // if we're not running an evented main loop, it's time to exit
		    exitJS(ret, /* implicit = */ true);
		    return ret;
		  } catch (e) {
		    return handleException(e);
		  }
		}

		function stackCheckInit() {
		  // This is normally called automatically during __wasm_call_ctors but need to
		  // get these values before even running any of the ctors so we call it redundantly
		  // here.
		  _emscripten_stack_init();
		  // TODO(sbc): Move writeStackCookie to native to to avoid this.
		  writeStackCookie();
		}

		function run(args = arguments_) {
		  if (runDependencies > 0) {
		    dependenciesFulfilled = run;
		    return;
		  }
		  stackCheckInit();
		  preRun();
		  // a preRun added a dependency, run will be called later
		  if (runDependencies > 0) {
		    dependenciesFulfilled = run;
		    return;
		  }
		  function doRun() {
		    // run may have just been called through dependencies being fulfilled just in this very frame,
		    // or while the async setStatus time below was happening
		    assert(!calledRun);
		    calledRun = true;
		    Module["calledRun"] = true;
		    if (ABORT) return;
		    initRuntime();
		    preMain();
		    readyPromiseResolve(Module);
		    Module["onRuntimeInitialized"]?.();
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
		  // Compiler settings do not allow exiting the runtime, so flushing
		  // the streams is not possible. but in ASSERTIONS mode we check
		  // if there was something to flush, and if so tell the user they
		  // should request that the runtime be exitable.
		  // Normally we would not even include flush() at all, but in ASSERTIONS
		  // builds we do so just for this check, and here we see if there is any
		  // content to flush, that is, we check if there would have been
		  // something a non-ASSERTIONS build would have not seen.
		  // How we flush the streams depends on whether we are in SYSCALLS_REQUIRE_FILESYSTEM=0
		  // mode (which has its own special function for this; otherwise, all
		  // the code is inside libc)
		  var oldOut = out;
		  var oldErr = err;
		  var has = false;
		  out = err = x => {
		    has = true;
		  };
		  try {
		    // it doesn't matter if it fails
		    _fflush(0);
		    // also flush in the JS FS layer
		    [ "stdout", "stderr" ].forEach(name => {
		      var info = FS.analyzePath("/dev/" + name);
		      if (!info) return;
		      var stream = info.object;
		      var rdev = stream.rdev;
		      var tty = TTY.ttys[rdev];
		      if (tty?.output?.length) {
		        has = true;
		      }
		    });
		  } catch (e) {}
		  out = oldOut;
		  err = oldErr;
		  if (has) {
		    warnOnce("stdio streams had content in them that was not flushed. you should set EXIT_RUNTIME to 1 (see the Emscripten FAQ), or make sure to emit a newline when you printf etc.");
		  }
		}

		function preInit() {
		  if (Module["preInit"]) {
		    if (typeof Module["preInit"] == "function") Module["preInit"] = [ Module["preInit"] ];
		    while (Module["preInit"].length > 0) {
		      Module["preInit"].shift()();
		    }
		  }
		  consumedModuleProp("preInit");
		}

		preInit();

		run();

		// end include: postamble.js
		// include: postamble_modularize.js
		// In MODULARIZE mode we wrap the generated code in a factory function
		// and return either the Module itself, or a promise of the module.
		// We assign to the `moduleRtn` global here and configure closure to see
		// this as and extern so it won't get minified.
		moduleRtn = Module;

		// Assertion for attempting to access module properties on the incoming
		// moduleArg.  In the past we used this object as the prototype of the module
		// and assigned properties to it, but now we return a distinct object.  This
		// keeps the instance private until it is ready (i.e the promise has been
		// resolved).
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
		}
		);
		})();
		{
		  module.exports = trace_processor_memory64_wasm;
		  // This default export looks redundant, but it allows TS to import this
		  // commonjs style module.
		  module.exports.default = trace_processor_memory64_wasm;
		} 
	} (trace_processor_memory64));
	return trace_processor_memory64.exports;
}

var trace_processor_32_stub = {};

var hasRequiredTrace_processor_32_stub;

function requireTrace_processor_32_stub () {
	if (hasRequiredTrace_processor_32_stub) return trace_processor_32_stub;
	hasRequiredTrace_processor_32_stub = 1;
	// Copyright (C) 2018 The Android Open Source Project
	//
	// Licensed under the Apache License, Version 2.0 (the "License");
	// you may not use this file except in compliance with the License.
	// You may obtain a copy of the License at
	//
	//      http://www.apache.org/licenses/LICENSE-2.0
	//
	// Unless required by applicable law or agreed to in writing, software
	// distributed under the License is distributed on an "AS IS" BASIS,
	// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	// See the License for the specific language governing permissions and
	// limitations under the License.
	Object.defineProperty(trace_processor_32_stub, "__esModule", { value: true });
	trace_processor_32_stub.default = (() => {
	    throw new Error('Unable to load the 32-bit trace_processor.wasm. ' +
	        'This is because you are running in a browser that does NOT support ' +
	        'Memory64 but passed --only-wasm-memory64 to ui/build ' +
	        '(run-dev-server does that)');
	});
	
	return trace_processor_32_stub;
}

var hasRequiredWasm_bridge;

function requireWasm_bridge () {
	if (hasRequiredWasm_bridge) return wasm_bridge;
	hasRequiredWasm_bridge = 1;
	// Copyright (C) 2018 The Android Open Source Project
	//
	// Licensed under the Apache License, Version 2.0 (the "License");
	// you may not use this file except in compliance with the License.
	// You may obtain a copy of the License at
	//
	//      http://www.apache.org/licenses/LICENSE-2.0
	//
	// Unless required by applicable law or agreed to in writing, software
	// distributed under the License is distributed on an "AS IS" BASIS,
	// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	// See the License for the specific language governing permissions and
	// limitations under the License.
	Object.defineProperty(wasm_bridge, "__esModule", { value: true });
	wasm_bridge.WasmBridge = void 0;
	const tslib_1 = require$$0;
	const deferred_1 = requireDeferred();
	const assert_1 = requireAssert();
	// The 64-bit variant of TraceProcessor wasm is always built in all build
	// configurations and we can depend on it from typescript.
	const trace_processor_memory64_1 = tslib_1.__importDefault(requireTrace_processor_memory64());
	// The 32-bit variant may or may not be part of the build, depending on whether
	// the user passes --only-wasm-memory64 to ui/build.js. When we are building
	// also the 32-bit (e.g., in production builds) the import below will be
	// redirected by rollup to '../gen/trace_processor' (The 32-bit module).
	const trace_processor_32_stub_1 = tslib_1.__importDefault(requireTrace_processor_32_stub());
	// The Initialize() call will allocate a buffer of REQ_BUF_SIZE bytes which
	// will be used to copy the input request data. This is to avoid passing the
	// input data on the stack, which has a limited (~1MB) size.
	// The buffer will be allocated by the C++ side and reachable at
	// HEAPU8[reqBufferAddr, +REQ_BUFFER_SIZE].
	const REQ_BUF_SIZE = 32 * 1024 * 1024;
	// The end-to-end interaction between JS and Wasm is as follows:
	// - [JS] Inbound data received by the worker (onmessage() in engine/index.ts).
	//   - [JS] onRpcDataReceived() (this file)
	//     - [C++] trace_processor_on_rpc_request (wasm_bridge.cc)
	//       - [C++] some TraceProcessor::method()
	//         for (batch in result_rows)
	//           - [C++] RpcResponseFunction(bytes) (wasm_bridge.cc)
	//             - [JS] onReply() (this file)
	//               - [JS] postMessage() (this file)
	class WasmBridge {
	    aborted;
	    connection;
	    reqBufferAddr = 0;
	    lastStderr = [];
	    messagePort;
	    useMemory64;
	    constructor() {
	        this.aborted = false;
	        const deferredRuntimeInitialized = (0, deferred_1.defer)();
	        this.useMemory64 = hasMemory64Support();
	        const initModule = this.useMemory64 ? trace_processor_memory64_1.default : trace_processor_32_stub_1.default;
	        this.connection = initModule({
	            locateFile: (s) => s,
	            print: (line) => console.log(line),
	            printErr: (line) => this.appendAndLogErr(line),
	            onRuntimeInitialized: () => deferredRuntimeInitialized.resolve(),
	        });
	        deferredRuntimeInitialized.then(() => {
	            const fn = this.connection.addFunction(this.onReply.bind(this), 'vpi');
	            this.reqBufferAddr = this.wasmPtrCast(this.connection.ccall('trace_processor_rpc_init', 
	            /* return=*/ 'pointer', 
	            /* args=*/ ['pointer', 'number'], [fn, REQ_BUF_SIZE]));
	        });
	    }
	    initialize(port) {
	        // Ensure that initialize() is called only once.
	        (0, assert_1.assertTrue)(this.messagePort === undefined);
	        this.messagePort = port;
	        // Note: setting .onmessage implicitly calls port.start() and dispatches the
	        // queued messages. addEventListener('message') doesn't.
	        this.messagePort.onmessage = this.onMessage.bind(this);
	    }
	    onMessage(msg) {
	        if (this.aborted) {
	            throw new Error('Wasm module crashed');
	        }
	        (0, assert_1.assertTrue)(msg.data instanceof Uint8Array);
	        const data = msg.data;
	        let wrSize = 0;
	        // If the request data is larger than our JS<>Wasm interop buffer, split it
	        // into multiple writes. The RPC channel is byte-oriented and is designed to
	        // deal with arbitrary fragmentations.
	        while (wrSize < data.length) {
	            const sliceLen = Math.min(data.length - wrSize, REQ_BUF_SIZE);
	            const dataSlice = data.subarray(wrSize, wrSize + sliceLen);
	            this.connection.HEAPU8.set(dataSlice, this.reqBufferAddr);
	            wrSize += sliceLen;
	            try {
	                this.connection.ccall('trace_processor_on_rpc_request', // C function name.
	                'void', // Return type.
	                ['number'], // Arg types.
	                [sliceLen]);
	            }
	            catch (err) {
	                this.aborted = true;
	                let abortReason = `${err}`;
	                if (err instanceof Error) {
	                    abortReason = `${err.name}: ${err.message}\n${err.stack}`;
	                }
	                abortReason += '\n\nstderr: \n' + this.lastStderr.join('\n');
	                throw new Error(abortReason);
	            }
	        } // while(wrSize < data.length)
	    }
	    // This function is bound and passed to Initialize and is called by the C++
	    // code while in the ccall(trace_processor_on_rpc_request).
	    onReply(heapPtrArg, size) {
	        const heapPtr = this.wasmPtrCast(heapPtrArg);
	        const data = this.connection.HEAPU8.slice(heapPtr, heapPtr + size);
	        (0, assert_1.assertExists)(this.messagePort).postMessage(data, [data.buffer]);
	    }
	    appendAndLogErr(line) {
	        console.warn(line);
	        // Keep the last N lines in the |lastStderr| buffer.
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
	        // Force heapPtr to be a positive using an unsigned right shift.
	        // The issue here is the following: the matching code in wasm_bridge.cc
	        // invokes this function passing  arguments as uint32_t. However, in the
	        // wasm<>JS interop bindings, the uint32 args become Js numbers. If the
	        // pointer is > 2GB, this number will be negative, which causes the wrong
	        // behaviour when used as an offset on HEAP8U.
	        (0, assert_1.assertTrue)(typeof val === 'number');
	        return Number(val) >>> 0; // static_cast<uint32_t>
	    }
	}
	wasm_bridge.WasmBridge = WasmBridge;
	// Checks if the current environment supports Memory64.
	function hasMemory64Support() {
	    // Compiled version of WAT program `(module (memory i64 0))` to WASM.
	    const memory64DetectProgram = new Uint8Array([
	        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x04,
	        0x00, 0x00, 0x08, 0x04, 0x6e, 0x61, 0x6d, 0x65, 0x02, 0x01, 0x00,
	    ]);
	    try {
	        new WebAssembly.Module(memory64DetectProgram);
	        return true;
	    }
	    catch (e) {
	        return false;
	    }
	}
	
	return wasm_bridge;
}

var hasRequiredEngine;

function requireEngine () {
	if (hasRequiredEngine) return engine;
	hasRequiredEngine = 1;
	// Copyright (C) 2018 The Android Open Source Project
	//
	// Licensed under the Apache License, Version 2.0 (the "License");
	// you may not use this file except in compliance with the License.
	// You may obtain a copy of the License at
	//
	//      http://www.apache.org/licenses/LICENSE-2.0
	//
	// Unless required by applicable law or agreed to in writing, software
	// distributed under the License is distributed on an "AS IS" BASIS,
	// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	// See the License for the specific language governing permissions and
	// limitations under the License.
	Object.defineProperty(engine, "__esModule", { value: true });
	const wasm_bridge_1 = requireWasm_bridge();
	const selfWorker = self;
	const wasmBridge = new wasm_bridge_1.WasmBridge();
	// There are two message handlers here:
	// 1. The Worker (self.onmessage) handler.
	// 2. The MessagePort handler.
	// The sequence of actions is the following:
	// 1. The frontend does one postMessage({port: MessagePort}) on the Worker
	//    scope. This message transfers the MessagePort.
	//    This is the only postMessage we'll ever receive here.
	// 2. All the other messages (i.e. the TraceProcessor RPC binary pipe) will be
	//    received on the MessagePort.
	// Receives the boostrap message from the frontend with the MessagePort.
	selfWorker.onmessage = (msg) => {
	    const port = msg.data;
	    wasmBridge.initialize(port);
	};
	
	return engine;
}

var engineExports = requireEngine();
var index = /*@__PURE__*/getDefaultExportFromCjs(engineExports);

return index;

})();
//# sourceMappingURL=engine_bundle.js.map

;(self.__SOURCEMAPS=self.__SOURCEMAPS||{})['engine_bundle.js']={"version":3,"sources":["node_modules/.pnpm/tslib@2.6.3/node_modules/tslib/tslib.es6.mjs","src/base/deferred.ts","src/base/assert.ts","ui/tsc/gen/trace_processor_memory64.js","src/engine/trace_processor_32_stub.ts","src/engine/wasm_bridge.ts","src/engine/index.ts","ui/tsc/engine/index.js?commonjs-entry"],"mappings":";;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;AAAA;AACA;;AAEA;AACA;;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACA;AACA;;AAEO;AACP;AACA;AACA;AACA;AACA;AACA;;AAEO;AACP;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEO;AACP;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEO;AACP;AACA;AACA;AACA;AACA;;AAEO;AACP;AACA;;AAEO;AACP;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AAEO;AACP;AACA;AACA;AACA;AACA;AACA;AAEO;AACP;AACA;AAEO;AACP;AACA;AACA;AAEO;AACP;AACA;;AAEO;AACP;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEO;AACP;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEO;AACP;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEO;AACP;AACA;;AAEO;AACP;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEO;AACP;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEA;AACO;AACP;AACA;AACA;AACA;;AAEA;AACO;AACP;AACA;AACA;AACA;AACA;AACA;;AAEO;AACP;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEO;AACP;AACA;;AAEO;AACP;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEO;AACP;AACA;AACA;AACA;;AAEO;AACP;AACA;AACA;AACA;AACA;AACA;;AAEO;AACP;AACA;AACA;AAEA;AACA;AACA;AACA;AACA;;AAEO;AACP;AACA;AACA;AACA;AACA;AACA;;AAEO;AACP;AACA;;AAEO;AACP;AACA;AACA;AACA;;AAEO;AACP;AACA;AACA;AACA;AACA;;AAEO;AACP;AACA;AACA;;AAEO;AACP;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;;AAEO;AACP;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;ACpXA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAUA;AADA;AACA;;AAEE;;AAEA;AACA;;AAEA;AACF;;;;;;;;;;;;AC9BA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAYA;AAYA;AASA;AAYA;AAMA;AAWA;AA5DA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AAEA;AAIE;AACE;;AAEF;AACF;AAEA;AACA;AACA;AACE;AACE;;AAEF;AACF;AAEA;AACA;AACA;AAKE;AAIA;AACF;AAEA;AACE;AACE;;AAEJ;AAEA;AACE;AACF;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACE;AAGF;;;;;;;;;;;;;;;;;AC9EA;AACA;AACE;AACF;AACE;;AAEF;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEA;AACA;;AAEmB;AACjB;AACA;AACF;;AAEA;AACA;AACA;AACA;;AAEA;;AAEA;AACA;AACA;;AAEA;;AAEA;AACA;AACA;;AAEA;;AAEA;AACE;AACF;;AAEA;AACA;AACA;;AAEA;AACA;;AAEA;AACA;AACI;AACJ;AACA;AACA;;AAEA;AACA;;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACE;AACF;AACI;AACE;AACN;AACQ;AACR;AACA;AACQ;AACR;AACA;AACA;AACM;AACN;AACQ;AACR;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEA;;AAEA;;AAEA;;AAEA;AACA;AACA;;AAEA;;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;;AAEA;AACA;;AAEA;AACA;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACA;AACE;AACF;AACA;AACA;;AAEA;AACA;AACA;AACoC;;AAEpC;;AAEA;AACA;AACA;AACI;;AAEJ;AACA;AACA;AACA;AACA;AACE;AACF;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACE;AACF;AACA;AACE;AACF;;AAEA;AACE;AACF;AACA;AACA;AACI;AACJ;AACE;AACF;AACE;AACE;AACJ;AACA;AACE;AACF;AACA;AACA;;AAQA;AACA;AACE;AACA;AACF;AACA;AACA;;AAEA;AACE;AACF;AACM;AACN;AACQ;AACR;AACA;AACA;AACA;;AAEA;AACE;AACF;AACA;AACA;;AAEA;AACA;AACA;AACE;AACF;;AAkBA;AAkBA;AACA;AACA;AACA;;AAEA;AACE;AACF;AACM;AACN;AACQ;AACR;AACU;AACV;AACA;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AAEA;AACA;AAEA;AACA;AACA;AACA;;AAEA;AACA;;AAEA;AACA;AACI;AACJ;AACM;AACN;AACA;AACA;AACA;AACA;AACA;;AAEA;AACA;AACE;AACA;AACF;AACA;AAEA;AACA;AACA;AACA;AACA;;AAEA;AACE;AACF;;AAEA;AACE;AACF;AACA;AACI;AACJ;AACM;AACN;AACA;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEA;;AAEA;AACA;;AAEA;;AAEA;AACA;AACE;AACE;AACA;AACJ;AACA;;AAEA;AACE;AACF;AACE;AACE;AACJ;AACI;AACJ;AACA;AACQ;AACR;AACU;AACV;AACA;AACA;AACA;AACU;AACE;AACZ;AACA;AACU;AACV;AACQ;AACR;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEA;AACE;AACF;AACE;AACF;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACM;AACN;AACI;AACJ;AACM;AACA;AACN;AACA;AACA;;AAEA;AACA;AACA;AACA;AACA;AACA;AACE;AACF;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACgC;AAChC;AACA;AACA;AACA;AACE;AACF;;AAEA;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;;AAEA;;AAEA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACE;AACF;AACA;AACE;AACF;;AAEA;AACE;AACF;AACE;AACF;AACA;AACA;;AAEA;AACA;AACA;AACI;AACA;AACJ;AACA;;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACQ;AACE;AACV;AACA;AACQ;AACR;AACA;AACA;AACA;AACA;AACE;AACF;AACA;AACA;AACE;AACF;;AAEA;AACA;AACA;AACE;AACA;AACE;AACJ;AACA;;;AAGA;AACA;AACA;AACA;AACA;AACA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;AACA;AACA;AACA;;AAEA;;AAEA;;AAEA;AACA;AACE;AACE;AACJ;AACA;AACA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACM;AACN;AACA;AACI;AACJ;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACA;AACA;AACM;AACN;AACA;AACM;AACN;AACA;AACE;AACF;;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACA;AACA;;AAEA;AACE;AACA;AACF;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACQ;AACR;AACQ;AACA;AACR;AACQ;AACA;AACR;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACI;AACJ;AACE;AACE;AACJ;AACA;AACA;AACM;AACN;AACA;AACM;AACN;AACI;AACJ;AACE;AACE;AACJ;AACA;AACM;AACN;AACI;AACJ;AACM;AACN;AACA;AACA;AACA;AACA;AACA;AACA;;AAEA;;AAEA;AACA;AACE;AACF;;AAEA;AACA;AACI;AACA;AACJ;AACA;AACA;AACA;AACA;AACQ;AACR;AACA;AACM;AACN;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACM;AACE;AACR;AACM;AACN;AACQ;AACR;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACM;AACE;AACR;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEA;;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACM;AACN;AACM;AACN;AACM;AACA;AACN;AACM;AACN;AACA;AACE;AACF;;AAEA;AACA;AACA;AACA;AACE;AACF;AACE;AACF;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACI;AACE;AACN;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEmD;AACnD;AACE;AACF;AACmB;AACjB;AACF;;AAEA;AACA;AACA;AACA;AACA;AACM;AACN;AACA;AACQ;AACR;AACA;AACI;AACE;AACN;AACI;AACJ;AACA;AACA;;AAEA;AACE;AACA;AACA;AACF;AACA;AACM;AACA;AACN;AACA;AACI;AACJ;AACA;AACI;AACJ;AACM;AACE;AACR;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACI;AACJ;AACA;AACI;AACJ;AACQ;AACR;AACA;AACA;AACQ;AACR;AACA;AACA;AACU;AACV;AACQ;AACE;AACV;AACQ;AACA;AACA;AACR;AACM;AACE;AACR;AACM;AACN;AACI;AACJ;AACQ;AACR;AACA;AACA;AACA;AACA;AACA;AACQ;AACR;AACM;AACN;AACA;AACM;AACN;AACG;AACH;AACI;AACE;AACN;AACA;AACM;AACE;AACR;AACA;AACA;AACA;AACA;AACI;AACE;AACE;AACR;AACA;AACA;AACI;AACJ;AACA;AACQ;AACA;AACA;AACA;AACR;AACA;AACA;AACA;AACA;AACM;AACN;AACI;AACJ;AACA;AACG;AACH;AACA;AACM;AACE;AACR;AACA;AACA;AACA;AACA;AACI;AACE;AACE;AACR;AACA;AACA;;AAEA;;AAEA;;AAEA;AACA;AACE;AACF;;AAEA;AACE;AACA;AACA;AACA;AACF;;AAEA;AACE;AACA;AACF;AACA;AACE;AACF;AACA;AACM;AACN;AACI;AACJ;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACS;AACT;AACA;;AAEO;AACP;AACA;AACA;AACA;AACS;AACT;AACA;AACA;AACA;AACA;AACA;;AAEO;AACP;AACA;AACA;AACA;AACA;AACS;AACD;AACD;AACP;AACA;AACA;AACA;AACS;AACT;;AAEA;AACA;AACI;AACE;AACA;AACN;AACA;AACM;AACA;AACN;AACA;AACA;AACA;AACA;AACA;AACA;AACM;AACA;AACN;AACM;AACA;AACN;AACA;AACA;AACI;AACE;AACN;AACA;AACI;AACJ;AACE;AACF;AACI;AACJ;AACI;AACJ;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACI;AACJ;AACI;AACJ;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACM;AACN;AACM;AACE;AACR;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACM;AACN;AACA;AACA;AACA;AACQ;AACR;AACA;AACA;AACM;AACA;AACA;AACN;AACA;AACA;AACA;AACM;AACN;AACA;AACA;AACA;AACU;AACV;AACA;AACA;AACQ;AACR;AACA;AACA;AACM;AACN;AACI;AACJ;AACA;AACA;AACM;AACN;AACQ;AACR;AACM;AACE;AACR;AACA;AACY;AACZ;AACA;AACA;AACA;AACA;AACM;AACA;AACN;AACM;AACN;AACA;AACA;AACA;AACA;AACA;AACM;AACN;AACQ;AACR;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACM;AACN;AACI;AACE;AACE;AACR;AACA;AACA;AACG;AACH;AACI;AACE;AACA;AACN;AACA;AACM;AACN;AACA;AACA;AACQ;AACR;AACM;AACN;AACA;AACA;AACM;AACN;AACA;AACA;AACA;AACM;AACE;AACR;AACA;AACA;AACA;AACA;AACA;AACQ;AACE;AACV;AACA;AACU;AACV;AACA;AACA;AACA;AACU;AACV;AACA;AACA;AACU;AACV;AACA;AACA;AACM;AACA;AACN;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACM;AACN;AACA;AACA;AACA;AACA;AACA;AACQ;AACR;AACA;AACA;AACA;AACQ;AACR;AACM;AACN;AACI;AACJ;AACQ;AACR;AACM;AACA;AACA;AACN;AACA;AACA;AACA;AACQ;AACR;AACA;AACQ;AACR;AACQ;AACE;AACV;AACQ;AACR;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACU;AACV;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACM;AACN;;AAEA;;AAEA;AACE;AACF;AACA;AACA;;AAEA;;AAEA;;AAEA;AACA;AACE;AACF;AACA;AACI;AACA;AACJ;AACM;AACN;AACA;AACE;AACF;;AAEA;AACA;AACA;AACE;AACF;AACA;AACA;AACA;AACM;AACA;AACN;AACA;AACM;AACN;AACA;AACI;AACE;AACN;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;;AAEA;AACE;AACE;AACA;AACJ;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACE;AACF;;AAEA;AACA;AACE;AACF;AACE;AACF;;AAEA;AACE;AACA;AACA;AACA;AACF;AACA;AACA;AACA;AACA;AACA;AACM;AACN;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACQ;AACR;AACA;AACM;AACN;AACA;AACM;AACA;AACN;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACM;AACE;AACR;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACA;AACI;AACA;AACJ;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACE;AACN;AACI;AACJ;AACA;AACI;AACJ;AACQ;AACR;AACA;AACQ;AACA;AACA;AACA;AACR;AACQ;AACA;AACA;AACA;AACA;AACR;AACA;AACA;AACA;AACA;AACU;AACV;AACA;AACA;AACA;AACM;AACN;AACI;AACE;AACN;AACA;AACM;AACN;AACA;AACM;AACN;AACA;AACM;AACN;AACI;AACE;AACN;AACA;AACA;AACM;AACN;AACA;AACM;AACN;AACG;AACH;AACI;AACE;AACN;AACM;AACN;AACA;AACA;AACI;AACE;AACN;AACA;AACA;AACA;AACA;AACA;AACQ;AACR;AACA;AACA;AACA;AACQ;AACR;AACM;AACN;;AAEA;;AAEA;;AAEA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACF;;AAEA;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACF;AACI;AACJ;AACA;AACA;AACA;AACA;AACA;AACI;AACE;AACN;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACG;AACD;AACE;AACA;AACJ;AACA;AACA;AACA;AACA;AACI;AACE;AACN;AACI;AACE;AACN;AACI;AACJ;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACG;AACD;AACE;AACA;AACJ;AACI;AACA;AACA;AACE;AACE;AACR;AACA;AACA;AACM;AACN;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACI;AACE;AACN;AACI;AACE;AACN;AACG;AACH;AACI;AACE;AACN;AACA;AACI;AACE;AACN;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACQ;AACR;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACU;AACV;AACA;AACY;AACZ;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACc;AACd;AACA;AACU;AACV;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACY;AACZ;AACU;AACA;AACV;AACA;AACA;AACU;AACV;AACA;AACA;AACQ;AACA;AACR;AACA;AACI;AACJ;AACE;AACE;AACA;AACJ;AACQ;AACR;AACQ;AACR;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACE;AACF;AACI;AACA;AACJ;AACE;AACF;AACI;AACE;AACN;AACM;AACA;AACN;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACA;AACE;AACN;AACA;AACA;AACA;AACA;AACQ;AACR;AACA;AACA;AACI;AACJ;AACE;AACF;AACA;AACA;AACI;AACJ;AACE;AACF;AACA;AACE;AACF;AACA;AACE;AACF;AACA;AACE;AACF;AACA;AACE;AACF;AACA;AACE;AACF;AACA;AACE;AACF;AACA;AACE;AACF;AACA;AACE;AACF;AACA;AACE;AACF;AACA;AACE;AACF;AACA;AACM;AACN;AACI;AACJ;AACA;AACA;AACM;AACN;AACA;AACA;AACM;AACN;AACM;AACN;AACM;AACN;AACI;AACJ;AACE;AACF;AACI;AACJ;AACI;AACA;AACJ;AACA;AACI;AACE;AACN;AACA;AACM;AACA;AACN;AACI;AACJ;AACA;AACI;AACJ;AACM;AACN;AACA;AACA;AACI;AACA;AACE;AACN;AACI;AACE;AACE;AACR;AACA;AACQ;AACR;AACA;AACM;AACE;AACR;AACA;AACI;AACJ;AACA;AACI;AACE;AACN;AACI;AACE;AACN;AACA;AACA;AACQ;AACR;AACA;AACA;AACA;AACA;AACI;AACE;AACN;AACI;AACJ;AACE;AACF;AACA;AACM;AACE;AACR;AACA;AACI;AACJ;AACE;AACE;AACA;AACE;AACN;AACI;AACJ;AACE;AACA;AACF;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACA;AACJ;AACE;AACE;AACJ;AACE;AACE;AACA;AACA;AACJ;AACA;AACI;AACA;AACJ;AACI;AACJ;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACM;AACN;AACA;AACM;AACN;AACG;AACD;AACA;AACF;AACA;AACA;AACM;AACN;AACA;AACE;AACA;AACF;AACA;AACA;AACA;AACA;AACM;AACN;AACI;AACJ;AACA;AACA;AACM;AACA;AACN;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACM;AACN;AACA;AACA;AACA;AACM;AACN;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACM;AACN;AACA;AACA;AACI;AACJ;AACM;AACN;AACM;AACE;AACR;AACA;AACA;AACA;AACA;AACQ;AACR;AACM;AACE;AACR;AACA;AACI;AACJ;AACA;AACA;AACM;AACN;AACA;AACI;AACJ;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACA;AACQ;AACR;AACA;AACI;AACJ;AACE;AACE;AACE;AACN;AACI;AACE;AACN;AACA;AACA;AACA;AACI;AACJ;AACM;AACA;AACN;AACQ;AACR;AACA;AACQ;AACR;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACI;AACE;AACN;AACA;AACI;AACA;AACE;AACN;AACI;AACE;AACN;AACI;AACA;AACE;AACN;AACA;AACM;AACN;AACA;AACA;AACE;AACE;AACE;AACN;AACA;AACE;AACF;AACA;AACA;AACI;AACJ;AACE;AACF;AACA;AACA;AACI;AACE;AACA;AACA;AACA;AACA;AACN;AACA;AACM;AACA;AACA;AACN;AACA;AACM;AACN;AACI;AACJ;AACA;AACI;AACA;AACA;AACJ;AACA;AACA;AACI;AACA;AACJ;AACA;AACI;AACJ;AACA;AACA;AACA;AACM;AACN;AACQ;AACR;AACQ;AACR;AACA;AACA;AACA;AACA;AACM;AACA;AACN;AACI;AACA;AACJ;AACA;AACI;AACE;AACN;AACI;AACE;AACN;AACA;AACI;AACE;AACN;AACI;AACA;AACA;AACE;AACN;AACA;AACM;AACN;AACA;AACA;AACA;AACI;AACA;AACA;AACA;AACJ;AACA;AACA;AACA;AACM;AACN;AACA;AACA;AACM;AACN;AACA;AACA;AACA;AACI;AACE;AACN;AACA;AACI;AACJ;AACI;AACA;AACE;AACN;AACA;AACI;AACA;AACE;AACN;AACA;AACI;AACJ;AACM;AACN;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACI;AACE;AACN;AACA;AACA;AACI;AACA;AACE;AACN;AACA;AACM;AACN;AACA;AACM;AACN;AACA;AACA;AACM;AACA;AACE;AACR;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACM;AACN;AACA;AACA;AACA;AACA;AACA;AACE;AACE;AACE;AACN;AACA;AACI;AACA;AACJ;AACI;AACE;AACN;AACA;AACM;AACN;AACA;AACM;AACN;AACI;AACJ;AACA;AACE;AACE;AACE;AACN;AACA;AACA;AACA;AACA;AACE;AACE;AACE;AACN;AACA;AACI;AACE;AACN;AACI;AACA;AACJ;AACI;AACJ;AACA;AACA;AACM;AACN;AACA;AACM;AACN;AACA;AACM;AACN;AACI;AACJ;AACA;AACE;AACE;AACJ;AACI;AACE;AACN;AACA;AACM;AACN;AACI;AACJ;AACA;AACI;AACE;AACN;AACA;AACA;AACA;AACA;AACE;AACE;AACJ;AACI;AACA;AACJ;AACI;AACJ;AACA;AACE;AACE;AACJ;AACE;AACF;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACM;AACE;AACR;AACA;AACA;AACM;AACN;AACA;AACA;AACA;AACI;AACJ;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACE;AACE;AACJ;AACM;AACE;AACR;AACA;AACA;AACM;AACN;AACI;AACJ;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACI;AACE;AACN;AACI;AACE;AACN;AACI;AACA;AACE;AACN;AACA;AACM;AACN;AACA;AACA;AACA;AACA;AACM;AACN;AACI;AACJ;AACM;AACE;AACR;AACA;AACA;AACM;AACN;AACI;AACJ;AACA;AACI;AACJ;AACM;AACN;AACA;AACA;AACA;AACI;AACE;AACN;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACE;AACF;AACM;AACN;AACA;AACA;AACM;AACN;AACM;AACN;AACI;AACA;AACJ;AACM;AACN;AACM;AACN;AACA;AACA;AACM;AACN;AACQ;AACR;AACA;AACA;AACA;AACA;AACA;AACA;AACM;AACN;AACA;AACU;AACV;AACA;AACQ;AACR;AACA;AACA;AACA;AACA;AACA;AACQ;AACR;AACA;AACI;AACE;AACN;AACA;AACI;AACJ;AACA;AACA;AACA;AACM;AACN;AACA;AACA;AACA;AACI;AACE;AACA;AACE;AACR;AACA;AACA;AACI;AACE;AACN;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACA;AACM;AACA;AACN;AACA;AACM;AACA;AACN;AACA;AACA;AACM;AACN;AACI;AACE;AACN;AACI;AACE;AACE;AACR;AACA;AACI;AACJ;AACE;AACF;AACM;AACN;AACI;AACJ;AACA;AACA;AACQ;AACR;AACA;AACM;AACN;AACM;AACN;AACA;AACA;AACE;AACF;AACA;AACA;AACA;AACM;AACN;AACA;AACM;AACN;AACA;AACM;AACN;AACA;AACA;AACA;AACA;AACE;AACF;AACI;AACE;AACN;AACA;AACM;AACN;AACI;AACE;AACN;AACI;AACE;AACN;AACA;AACM;AACN;AACA;AACI;AACJ;AACA;AACM;AACN;AACA;AACI;AACA;AACJ;AACA;AACA;AACI;AACE;AACN;AACA;AACM;AACN;AACI;AACE;AACN;AACI;AACE;AACN;AACA;AACM;AACN;AACI;AACJ;AACM;AACN;AACA;AACI;AACJ;AACA;AACM;AACN;AACI;AACA;AACA;AACJ;AACE;AACF;AACA;AACA;AACA;AACA;AACA;AACI;AACE;AACN;AACI;AACE;AACN;AACA;AACM;AACN;AACI;AACE;AACN;AACA;AACA;AACE;AACF;AACA;AACM;AACN;AACA;AACA;AACA;AACA;AACM;AACN;AACA;AACA;AACA;AACI;AACA;AACJ;AACA;AACA;AACI;AACJ;AACI;AACJ;AACI;AACJ;AACA;AACA;AACA;AACM;AACN;AACA;AACI;AACJ;AACE;AACE;AACJ;AACA;AACA;AACA;AACA;AACA;AACM;AACN;AACA;AACA;AACA;AACA;AACA;AACE;AACE;AACE;AACN;AACA;AACM;AACN;AACA;AACM;AACN;AACA;AACI;AACE;AACN;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACM;AACN;AACM;AACN;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACA;AACI;AACA;AACJ;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACI;AACJ;AACA;AACQ;AACR;AACA;AACQ;AACR;AACA;AACY;AACA;AACE;AACd;AACgB;AACD;AACf;AACA;AACe;AACf;AACA;AACA;AACA;AACY;AACZ;AACA;AACA;AACA;AACA;AACQ;AACR;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACE;AACN;AACM;AACN;AACI;AACJ;AACA;AACM;AACN;AACI;AACJ;AACA;AACM;AACN;AACA;AACI;AACA;AACA;AACJ;AACA;AACA;AACA;AACA;AACI;AACA;AACJ;AACA;AACA;AACI;AACE;AACA;AACN;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACA;AACA;AACM;AACN;AACA;AACA;AACA;AACA;AACI;AACJ;AACM;AACN;AACA;AACA;AACA;AACA;AACA;AACM;AACE;AACR;AACA;AACA;AACI;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACN;AACA;AACM;AACE;AACR;AACA;AACA;AACA;AACM;AACN;AACQ;AACR;AACA;AACA;AACA;AACM;AACA;AACN;AACA;AACA;AACI;AACJ;AACE;AACF;AACA;AACA;AACA;AACA;AACM;AACN;AACA;AACA;AACQ;AACR;AACM;AACN;AACI;AACJ;AACE;AACE;AACA;AACA;AACJ;AACA;AACA;AACI;AACJ;AACA;AACA;AACI;AACA;AACA;AACJ;AACQ;AACR;AACQ;AACR;AACA;AACM;AACA;AACN;AACA;AACM;AACN;AACA;AACE;AACE;AACJ;AACA;AACA;AACA;AACA;AACA;AACM;AACN;AACA;AACM;AACN;AACA;AACA;AACA;AACA;AACM;AACN;AACA;AACU;AACV;AACA;AACA;AACY;AACZ;AACU;AACE;AACZ;AACU;AACA;AACA;AACV;AACQ;AACE;AACV;AACQ;AACR;AACM;AACN;AACA;AACY;AACZ;AACY;AACZ;AACA;AACQ;AACR;AACA;AACQ;AACR;AACA;AACI;AACJ;AACE;AACF;AACA;AACA;AACA;AACA;AACA;AACQ;AACA;AACR;AACQ;AACR;AACA;AACA;AACE;AACF;AACA;AACI;AACE;AACA;AACN;AACM;AACN;AACU;AACV;AACQ;AACA;AACA;AACR;AACM;AACN;AACA;AACA;AACA;AACA;AACQ;AACR;AACA;AACA;AACQ;AACR;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACU;AACV;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACY;AACZ;AACU;AACV;AACA;AACA;AACA;AACU;AACV;AACA;AACA;AACU;AACV;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACU;AACA;AACV;AACA;AACA;AACA;AACA;AACA;AACM;AACN;AACA;AACA;AACA;AACA;AACM;AACN;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACM;AACE;AACA;AACR;AACA;AACM;AACE;AACR;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACQ;AACR;AACA;;AAEA;AACA;AACA;AACI;AACJ;AACM;AACA;AACN;AACA;AACA;AACA;AACA;AACM;AACA;AACN;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACM;AACN;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACM;AACE;AACR;AACA;AACA;AACA;AACQ;AACR;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEA;AACE;AACF;AACA;AACM;AACN;AACA;AACI;AACJ;AACA;AACA;AACM;AACN;AACA;AACA;AACM;AACE;AACR;AACM;AACN;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACJ;AACI;AACJ;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACE;AACF;AACM;AACN;AACA;AACA;AACM;AACN;AACA;AACA;AACA;AACE;AACE;AACA;AACJ;AACE;AACA;AACF;AACI;AACJ;AACA;;AAEA;AACA;AACA;AACI;AACA;AACA;AACJ;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACI;AACA;AACA;AACJ;AACA;AACM;AACN;AACI;AACE;AACN;AACA;AACI;AACE;AACN;AACA;AACI;AACA;AACA;AACA;AACE;AACN;AACI;AACJ;AACA;AACA;AACA;AACA;;AAEA;AACA;AACI;AACA;AACJ;AACA;AACA;AACA;AACA;;AAEA;AACA;AACI;AACA;AACJ;AACA;AACA;AACA;AACA;;AAEA;AACE;AACF;AACA;AACE;AACF;;AAEA;AACE;AACF;AACA;AACA;AACE;AACF;;AAEA;AACA;AACA;AACA;AACI;AACJ;AACA;AACM;AACN;AACA;AACU;AACV;AACA;AACU;AACV;AACQ;AACA;AACR;AACA;;AAEK;AACL;AACM;;AAEN;AACA;AACA;;AAEA;AACM;AACN;AACA;AACQ;AACR;;AAEA;AACM;AACN;AACA;AACA;AACA;AACQ;AACR;;AAEK;AACL;AACA;AACA;AACA;AACA;AACM;;AAEF;AACJ;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACI;AACA;AACA;AACJ;AACA;AACA;AACA;AACA;;AAEA;AACE;AACA;AACF;;AAEA;AACA;AACA;AACA;AACI;AACJ;AACI;AACA;AACA;AACA;AACJ;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACI;AACJ;AACA;AACM;AACE;AACA;AACR;;AAEA;AACM;AACE;AACA;AACR;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACU;AACV;AACQ;AACR;;AAEK;AACA;AACL;AACM;AACE;AACA;AACR;;AAEK;AACA;AACL;AACM;AACE;AACA;AACR;AACU;AACV;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACQ;AACR;;AAEA;AACM;AACE;AACR;AACQ;AACA;AACR;;AAEA;AACM;AACE;AACA;AACR;;AAEA;AACM;AACN;AACQ;AACR;;AAEA;AACM;AACN;AACA;AACQ;AACA;AACR;AACA;AACA;AACA;AACA;AACQ;AACR;;AAEA;AACM;AACN;AACA;AACA;AACQ;AACA;AACR;;AAEA;AACM;AACE;AACA;AACR;;AAEK;AACC;;AAEN;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACI;AACA;AACA;AACA;AACJ;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACA;AACI;AACA;AACA;AACJ;AACA;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACA;AACI;AACA;AACA;AACA;AACJ;AACI;AACA;AACJ;AACA;AACI;AACA;AACJ;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACI;AACJ;AACI;AACJ;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACI;AACA;AACJ;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;;AAEA;;AAEA;AACA;AACA;AACA;AACI;AACJ;AACA;AACI;AACA;AACE;AACA;AACN;AACA;AACA;AACA;AACQ;AACR;AACQ;AACR;AACA;AACA;AACM;AACN;AACA;AACA;AACQ;AACR;AACQ;AACR;AACA;AACA;AACA;AACA;AACA;AACA;AACM;AACN;AACI;AACJ;AACA;AACA;AACA;AACA;;AAEA;;AAEA;AACA;AACA;AACE;AACF;AACA;AACA;AACA;AACA;AACA;AACA;AACE;AACA;AACF;AACA;;AAEA;;AAEA;;AAEA;;AAEA;AACE;AACA;AACF;AACA;AACE;AACF;;AAEA;AACA;AACA;AACE;AACF;AACA;AACA;AACA;AACA;AACA;AACA;AACE;AACF;AACE;AACF;AACA;AACA;AACA;AACE;AACF;AACA;;AAEA;AACA;AACA;AACA;AACA;AACA;AACI;AACA;AACJ;AACA;AACI;AACJ;AACI;AACJ;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACI;AACJ;AACI;AACA;AACJ;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACA;AACA;AACE;AACF;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACE;AACF;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACA;AACA;AACJ;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACA;AACJ;AACI;AACA;AACJ;AACA;;AAEA;;AAEA;;AAIA;;AAEA;AAEA;AACA;AACI;AACJ;AACE;AACF;AACA;AACA;AACA;AACA;AACA;AAGA;AACA;AACA;AACE;AACF;;AAEA;;AAEA;AACA;AACE;AACF;AACE;AACF;AACE;AACF;AACA;AACE;AACE;AACJ;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACI;AACA;AACJ;AACA;AACE;AACF;;AAEA;AACE;AACF;AACE;AACF;;AAEA;AACA;AACA;AACA;AACE;AACF;;AAEA;AACA;AACE;AACF;;AAEA;AACA;AACA;AACE;AACF;;AAEA;;AAEA;;AAEA;AAEA;AACA;AACI;AACJ;AACA;AACA;;AAEA;AACA;AACA;AACA;AACA;AACI;AACJ;AACI;AACA;AACJ;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACI;AACJ;AACI;AACE;AACN;AACA;AACA;AACE;AACF;;AAEA;AACA;AACA;AACE;AACF;;AAEA;;AAEA;AACA;AACA;AAIA;AACA;;AAEA;;AAEA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACE;AACF;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACI;AACJ;AACE;AACF;;AAEA;;AAEA;;AAEA;AACA;AACA;AACA;AACA;AACI;AACE;AACA;AACA;AACA;AACA;AACA;AACA;AACN;AACA;AACA;AACA;AACA;AACA;AACM;AACN;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACE;AACF;;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACE;AACF;;AAEA;;AAEA;;AAEA;AACE;AACF;AACA;AACI;AACJ;AACE;AACF;;AAEA;AACE;AACA;AACF;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEA;;AAEA;AACA;AACI;AACJ;AACI;AACJ;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACA;AACA;AACI;AACE;AACN;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;;AAE+B;AAC/B;AACA;AACA;AACA;AACI;AACJ;AACI;AACA;AACJ;AAKA;AACE;AACF;;AAEA;AACA;AACA;AACA;AACA;AACI;AACA;AACJ;AACI;AACJ;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACI;AACA;AACA;AACJ;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;;AAEA;AACA;AACI;AACJ;AACM;AACN;AACI;AACJ;AACA;AACA;AACA;AACA;;AAE+B;AAC/B;AACA;AACA;AACA;AACI;AACJ;AACI;AACA;AACJ;AACA;AACA;AACA;AAIA;AACE;AACF;;AAEA;AACA;AACA;AACA;AACA;AACI;AACA;AACJ;AACI;AACJ;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACA;AACA;AACE;AACE;AACJ;AACE;AACF;AACA;AACA;AACA;AACA;AACA;AACA;;AAEA;;AAEA;AACE;AACF;AACE;AACA;AACF;;AAEA;AACE;AACF;AACE;AACA;AACF;;AAEA;AACE;AACA;AACF;;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;AACE;AACF;AACI;AACJ;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACE;AACN;AACA;AACA;AACA;AACA;AACA;AACM;AACN;AACI;AACA;AACA;AACJ;AACA;AACA;AACA;AACE;AACA;AACF;AACM;AACA;AACE;AACR;AACA;AACQ;AACR;AACA;AACA;AACE;AACF;AACI;AACJ;AACA;AACA;AACE;AACF;;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEA;AACE;AACE;AACA;AACA;AACA;AACA;AACA;AACJ;AACE;AACE;AACJ;AACA;AACA;AACA;AACA;AACA;AACE;AACF;;AAEA;AACE;AACA;AACA;AACE;AACJ;AACI;AACJ;AACI;AACJ;AACI;AACJ;AACI;AACJ;AACI;AACJ;AACA;AACA;AACE;AACF;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACE;AACF;AACE;AACF;AACE;AACF;AACA;AACA;AACA;AACA;AACA;AACE;AACF;AACA;AACA;AACE;AACF;AACM;;AAEN;AACE;AACA;AACF;;AAEA;;AAEiC;;AAEjC;AACA;AACA;AACA;AACA;AACA;AACE;AACF;AACA;AACA;AACE;AACF;;AAEA;AACE;AACF;AACA;AACA;AACM;AACE;AACR;AACA;AACA;AACA;;AAEA;;AAEA;AACA;AACE;AACF;AACI;AACJ;AACE;AACF;;AAEA;;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;AACkC;AAClC;AACA;AACM;AACN;AACI;AACJ;AACE;AACF;;AAEA;AACgC;AAChC;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACA;AACE;AACE;AACJ;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACM;AACN;AACI;AACA;AACJ;AACA;AACE;AACA;AACF;;AAEA;;AAEA;;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACE;AACF;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEA;AACA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;;AAEA;AACA;AACA;;AAEA;AACA;AACiB;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACjB;;AAEA;;AAIA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;;AAEA;AACA;AACA;AACA;AACA;AACE;AACF;AACA;AACA;AACE;AACA;AACF;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACE;AACF;;AAEA;AACA;AACA;;AAEA;AACE;AACF;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACE;AACF;AACE;AACF;;AAEA;AACA;AACI;AACJ;AACA;AACE;AACA;AACF;AACA;AACI;AACJ;AACA;AACE;AACF;AACA;AACA;AACI;AACJ;AACI;AACA;AACA;AACJ;AACA;AACA;AACI;AACA;AACA;AACJ;AACA;AACA;AACI;AACJ;AACM;AACN;AACA;AACI;AACJ;AACE;AACF;;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACI;AACJ;AACA;AACA;AACA;AACA;AACI;AACE;AACN;AACA;AACA;AACM;AACN;AACQ;AACR;AACA;AACA;AACE;AACA;AACA;AACF;AACA;AACA;;AAEA;AACA;AACI;AACA;AACE;AACN;AACA;AACA;AACA;;AAEA;;AAEA;;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACM;AACN;AACQ;AACR;AACA;AACA;AACA;;;AAGE;AACF;;AAEA;AACA;AACE;AACF;AACA;AACE;AACF;;;;;;;;;;;;ACtjKA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEA;AACE;AAEI;AACA;AACA;AAEN;;;;;;;;;;ACrBA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;;;AAEA;AACA;AAEA;AACA;AACA;AAEA;AACA;AACA;AACA;AACA;AAKA;AACA;AACA;AACA;AACA;AACA;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACU;AACA;AACA;AACA;AACA;AACA;AAER;AACE;AACA;AACA;AACA;AACA;AACE;AACA;AACA;AACA;AACD;AAED;AACE;AACA;AAGI;AACA;AAIN;;AAGF;;AAEE;AACA;;;AAGA;;AAGF;AACE;AACE;;AAEF;AACA;AACA;;;;AAIA;AACE;AACA;AACA;AACA;AACA;AACE;AAEE;AACA;AACA;;AAEF;AACA;AACA;AACA;AACE;;AAEF;AACA;;AAEJ;;;;AAKM;AACN;AACA;AACA;;AAGM;AACN;;AAEA;AACA;AACE;;;;;;;;AASI;AACN;AACE;;;;;;;;AAQF;AACA;;;AA7GJ;AAiHA;AACA;;AAKE;AACE;AACA;AACD;AACD;AACE;AACA;;AACA;AACA;;AAEJ;;;;;;;;;;AC/KA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;;AAEA;AAEA;AACA;AAEA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AAEA;AACA;AACE;AACA;AACF;;;;;AC/BA;AAEA","file":"engine_bundle.js"};