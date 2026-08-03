(function() {
	var _documentCurrentScript = typeof document !== "undefined" ? document.currentScript : null;
	typeof document === "undefined" ? location.href : _documentCurrentScript && _documentCurrentScript.tagName.toUpperCase() === "SCRIPT" && _documentCurrentScript.src || document.baseURI;
	//#region ../../ui/src/service_worker/service_worker.ts
	var LOG_TAG = `ServiceWorker: `;
	var CACHE_NAME = "ui-perfetto-dev";
	var OPEN_TRACE_PREFIX = "/_open_trace";
	var INDEX_TIMEOUT_MS = 3e3;
	var INSTALL_TIMEOUT_MS = 3e4;
	var postedFiles = /* @__PURE__ */ new Map();
	var ALLOWLISTED_DOMAINS = [
		/\.googleapis\.com$/,
		/\.google-analytics\.com$/,
		/\.googletagmanager\.com$/
	];
	function isAllowlistedDomain(hostname) {
		return ALLOWLISTED_DOMAINS.some((pattern) => pattern.test(hostname));
	}
	function isLocalhost(hostname) {
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
	}
	function checkFirewall(req) {
		const url = new URL(req.url);
		if (isLocalhost(url.hostname)) return { allowed: true };
		if (url.origin === self.location.origin) return { allowed: true };
		if (isAllowlistedDomain(url.hostname)) return { allowed: true };
		if (req.method !== "GET") return {
			allowed: false,
			reason: `Method ${req.method} not allowed`
		};
		if (url.hostname === "api.github.com" && url.pathname.includes("/contents/") && url.searchParams.has("ref") && url.search.indexOf("&") === -1) return { allowed: true };
		if (url.search !== "") return {
			allowed: false,
			reason: "Query strings not allowed"
		};
		return { allowed: true };
	}
	self.addEventListener("install", (event) => {
		const doInstall = async () => {
			let bypass = true;
			try {
				bypass = await caches.has("BYPASS_SERVICE_WORKER");
			} catch (_) {}
			if (bypass) throw new Error(LOG_TAG + "skipping installation, bypass enabled");
			try {
				for (const key of await caches.keys()) if (key.startsWith("dist-")) await caches.delete(key);
			} catch (_) {}
			const match = /\bv=([\w.-]*)/.exec(location.search);
			if (!match) throw new Error(`Failed to install. Was epecting a query string like ?v=v1.2-sha query string, got "${location.search}" instead`);
			await installAppVersionIntoCache(match[1]);
			self.skipWaiting();
		};
		event.waitUntil(doInstall());
	});
	self.addEventListener("activate", (event) => {
		console.info(LOG_TAG + "activated");
		const doActivate = async () => {
			await self.clients.claim();
		};
		event.waitUntil(doActivate());
	});
	self.addEventListener("fetch", (event) => {
		const firewall = checkFirewall(event.request);
		if (!firewall.allowed) {
			console.warn(LOG_TAG + `Blocked: ${event.request.url} - ${firewall.reason}`);
			event.respondWith(new Response(`Blocked by firewall: ${firewall.reason}`, {
				status: 403,
				statusText: "Forbidden"
			}));
			return;
		}
		if (!shouldHandleHttpRequest(event.request)) {
			console.debug(LOG_TAG + `serving ${event.request.url} from network`);
			return;
		}
		event.respondWith(handleHttpRequest(event.request));
	});
	function shouldHandleHttpRequest(req) {
		if (req.cache === "only-if-cached" && req.mode !== "same-origin") return false;
		const url = new URL(req.url);
		if (url.pathname === "/live_reload") return false;
		if (url.pathname.startsWith(OPEN_TRACE_PREFIX)) return true;
		return req.method === "GET" && url.origin === self.location.origin;
	}
	async function handleHttpRequest(req) {
		if (!shouldHandleHttpRequest(req)) throw new Error(LOG_TAG + `${req.url} shouldn't have been handled`);
		const cacheOps = { cacheName: CACHE_NAME };
		const url = new URL(req.url);
		if (url.pathname === "/") try {
			console.debug(LOG_TAG + `Fetching live ${req.url}`);
			return await fetchWithTimeout(req, INDEX_TIMEOUT_MS);
		} catch (err) {
			console.warn(LOG_TAG + `Failed to fetch ${req.url}, using cache.`, err);
		}
		else if (url.pathname === "/offline") {
			const cachedRes = await caches.match(new Request("/"), cacheOps);
			if (cachedRes) return cachedRes;
		} else if (url.pathname.startsWith(OPEN_TRACE_PREFIX)) return await handleOpenTraceRequest(req);
		const cachedRes = await caches.match(req, cacheOps);
		if (cachedRes) {
			console.debug(LOG_TAG + `serving ${req.url} from cache`);
			return cachedRes;
		}
		console.warn(LOG_TAG + `cache miss on ${req.url}, using live network`);
		return fetch(req);
	}
	async function handleOpenTraceRequest(req) {
		const url = new URL(req.url);
		console.assert(url.pathname.startsWith(OPEN_TRACE_PREFIX));
		const fileKey = url.pathname.substring(12);
		if (req.method === "POST") {
			const formData = await req.formData();
			const qsParams = new URLSearchParams();
			formData.forEach((value, key) => {
				if (key === "trace") {
					if (value instanceof File) {
						postedFiles.set(fileKey, value);
						qsParams.set("url", req.url);
					}
					return;
				}
				qsParams.set(key, `${value}`);
			});
			return Response.redirect(`${url.protocol}//${url.host}/#!/?${qsParams}`);
		}
		const file = postedFiles.get(fileKey);
		if (file !== void 0) {
			postedFiles.delete(fileKey);
			return new Response(file);
		}
		return Response.error();
	}
	async function installAppVersionIntoCache(version) {
		const manifestUrl = `${version}/manifest.json`;
		try {
			console.log(LOG_TAG + `Starting installation of ${manifestUrl}`);
			await caches.delete(CACHE_NAME);
			const manifest = await (await fetchWithTimeout(manifestUrl, INSTALL_TIMEOUT_MS)).json();
			const manifestResources = manifest["resources"];
			if (!manifestResources || !(manifestResources instanceof Object)) throw new Error(`Invalid manifest ${manifestUrl} : ${manifest}`);
			const cache = await caches.open(CACHE_NAME);
			const urlsToCache = [];
			urlsToCache.push(new Request("/", {
				cache: "reload",
				mode: "same-origin"
			}));
			for (const [resource, integrity] of Object.entries(manifestResources)) {
				const reqOpts = {
					cache: "no-cache",
					mode: "same-origin",
					integrity: `${integrity}`
				};
				urlsToCache.push(new Request(`${version}/${resource}`, reqOpts));
			}
			await cache.addAll(urlsToCache);
			console.log(LOG_TAG + "installation completed for " + version);
		} catch (err) {
			console.error(LOG_TAG + `Installation failed for ${manifestUrl}`, err);
			await caches.delete(CACHE_NAME);
			throw err;
		}
	}
	var TimeoutError = class extends Error {
		constructor(url) {
			super(`Timed out while fetching ${url}`);
		}
	};
	var NetworkError = class extends Error {
		constructor(url, cause) {
			super(`Network error while fetching ${url}: ${cause}`);
		}
	};
	function fetchWithTimeout(req, timeoutMs) {
		const url = req.url || `${req}`;
		return new Promise((resolve, reject) => {
			const timerId = setTimeout(() => {
				reject(new TimeoutError(url));
			}, timeoutMs);
			fetch(req).then((resp) => {
				clearTimeout(timerId);
				if (resp.ok) resolve(resp);
				else reject(/* @__PURE__ */ new Error(`Fetch failed for ${url}: ${resp.status} ${resp.statusText}`));
			}, (e) => {
				clearTimeout(timerId);
				reject(new NetworkError(url, e));
			});
		});
	}
	//#endregion
})();
