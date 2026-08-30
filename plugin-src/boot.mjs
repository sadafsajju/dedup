// The one script injected into the top of every canvas page's <head>.
//
// Its own module because two servers inject it: the Vite plugin (tagger.mjs)
// serves it per request, and the static server (serve.mjs) inlines it into
// plain HTML pages. It carries the things that must run *before the app boots*
// — the mock-session seed, the offline cut and the hold — and all of them are
// gated on being framed here, in the script itself, so none can ever run when
// the user opens their own dev server in a browser.
//
// Order matters: the offline cut has to be in place before any app code can
// make its first request, and it comes before the hold because the hold ends
// this script with an early return.

/** Query flag on a frame's URL asking it to freeze on its first screen. */
export const HOLD_FLAG = "__dedup_hold";

/** Query flag on a frame's URL asking it to render with no network. */
export const OFFLINE_FLAG = "__dedup_offline";

/**
 * The script served into the top of every canvas page's <head>, carrying the
 * three things that must run *before the app boots*: the mock-session seed
 * (zero-login editing), the offline cut (rendering the app's no-network
 * state), and the hold (freezing a transient screen).
 *
 * Each is gated on being framed, so the user's own browsing of their dev
 * server is never affected, and each is wrapped so a failure warns instead of
 * killing the page in <head>. `seed` is the persisted `session.json`
 * (`{enabled, script}`) or null; with no seed and no flags this is still a
 * valid, inert script.
 */
export function buildBootScript(seed) {
  const body = seed && seed.enabled && seed.script && seed.script.trim()
    ? `  try {
${seed.script}
  } catch (e) {
    console.warn("dedup: mock-session seed failed", e);
  }`
    : "  /* no active mock session */";
  return `// dedup boot script — injected only into the editor canvas.
(function () {
  "use strict";
  // Framed gate: never touch the app when it's opened directly in a browser.
  if (window.top === window.self) return;
${body}

  // --- offline --------------------------------------------------------------
  // "No internet" is a state most apps have a screen for and almost nobody
  // gets to look at: you cannot style an error state you cannot reach. This
  // cuts the *app's* network at the source — the request APIs it calls —
  // while leaving the dev server's own traffic alone, so the page still hot
  // reloads and the canvas keeps working while the app inside it believes it
  // is offline.
  //
  // Nothing here mocks a response, and that is the whole distinction: every
  // request the app makes fails the way one fails with no network, so what
  // renders is the app's real offline behaviour rather than a fiction about
  // it. The seed rule applies just as much here (see session.rs) — dedup
  // changes the conditions, never the answers.
  if (location.search.indexOf("${OFFLINE_FLAG}=1") !== -1) {
    try {
      goOffline();
    } catch (e) {
      console.warn("dedup: offline failed to install", e);
    }
  }

  function goOffline() {
    // Same-origin paths that belong to the dev server and to dedup rather
    // than to the app: HMR, the module graph, dedup's own endpoints. Cutting
    // these would take hot reload and the canvas down along with the app's
    // API calls, which is not what "the app is offline" means. Everything
    // else — every cross-origin request, and every same-origin route the app
    // itself defines — fails.
    var TOOLING = [
      "/__dedup/",
      "/@vite/",
      "/@id/",
      "/@fs/",
      "/@react-refresh",
      "/__vite_ping",
      "/node_modules/",
      "/_next/static/",
      "/_next/webpack-hmr",
      "/__nextjs",
    ];
    var toApp = function (input) {
      var url;
      try {
        var raw =
          typeof input === "string"
            ? input
            : input && input.url
              ? input.url
              : String(input);
        url = new URL(raw, location.href);
      } catch (e) {
        return true; // unreadable: it is the app's, and it fails
      }
      if (url.origin !== location.origin) return true;
      for (var i = 0; i < TOOLING.length; i++) {
        if (url.pathname.indexOf(TOOLING[i]) === 0) return false;
      }
      return true;
    };
    var later = function (fn) {
      // Short timer on purpose: the hold below queues anything >= 400ms, and
      // a failure the app never hears about is not a failure it can render.
      (window.setTimeout || setTimeout)(fn, 0);
    };
    var event = function (type, progress) {
      try {
        return progress && typeof ProgressEvent === "function"
          ? new ProgressEvent(type)
          : new Event(type);
      } catch (e) {
        return new Event(type);
      }
    };

    if (typeof window.fetch === "function") {
      var realFetch = window.fetch;
      window.fetch = function (input) {
        if (!toApp(input)) return realFetch.apply(this, arguments);
        // WebKit's own words for a request that never reached the network —
        // the canvas is a WKWebView, so this is what the app would really be
        // handed, down to the message anyone logs.
        return Promise.reject(new TypeError("Load failed"));
      };
    }

    if (typeof window.XMLHttpRequest === "function") {
      var RealXHR = window.XMLHttpRequest;
      var OfflineXHR = function () {
        var xhr = new RealXHR();
        var open = xhr.open;
        var send = xhr.send;
        var blocked = false;
        xhr.open = function (method, url) {
          blocked = toApp(url);
          return open.apply(xhr, arguments);
        };
        xhr.send = function () {
          if (!blocked) return send.apply(xhr, arguments);
          later(function () {
            // A real network failure is readyState 4 with status 0, then
            // error and loadend. status is already 0; readyState is shadowed
            // with an own property so a library that waits for 4 sees 4.
            try {
              Object.defineProperty(xhr, "readyState", {
                value: 4,
                configurable: true,
              });
            } catch (e) {}
            xhr.dispatchEvent(event("readystatechange", false));
            xhr.dispatchEvent(event("error", true));
            xhr.dispatchEvent(event("loadend", true));
          });
        };
        return xhr;
      };
      OfflineXHR.prototype = RealXHR.prototype;
      var STATES = ["UNSENT", "OPENED", "HEADERS_RECEIVED", "LOADING", "DONE"];
      for (var si = 0; si < STATES.length; si++) OfflineXHR[STATES[si]] = si;
      window.XMLHttpRequest = OfflineXHR;
    }

    // A socket that cannot connect: constructs, then fails asynchronously the
    // way a real one does — error, then close with 1006 (abnormal).
    var deadSocket = function (url, extra) {
      var sock = new EventTarget();
      sock.url = String(url);
      sock.readyState = 0;
      sock.bufferedAmount = 0;
      sock.extensions = "";
      sock.protocol = "";
      sock.binaryType = "blob";
      sock.onopen = null;
      sock.onerror = null;
      sock.onclose = null;
      sock.onmessage = null;
      sock.send = function () {
        var err = new Error("WebSocket is already in CLOSING or CLOSED state.");
        err.name = "InvalidStateError";
        throw err;
      };
      sock.close = function () {
        sock.readyState = 3;
      };
      // The on-handlers here are plain properties — EventTarget knows nothing
      // about them — so each is called once by hand and once by dispatch.
      var fire = function (type, ev) {
        if (typeof sock["on" + type] === "function") sock["on" + type].call(sock, ev);
        try {
          sock.dispatchEvent(ev);
        } catch (e) {}
      };
      later(function () {
        sock.readyState = 3;
        fire("error", event("error", false));
        var closed = event("close", false);
        closed.code = 1006;
        closed.reason = "";
        closed.wasClean = false;
        fire("close", closed);
      });
      if (extra) extra(sock);
      return sock;
    };

    if (typeof window.WebSocket === "function" && typeof EventTarget === "function") {
      var RealWS = window.WebSocket;
      var OfflineWS = function (url, protocols) {
        // Vite's HMR socket is the dev server talking to itself, not the app
        // reaching the network — it announces itself by protocol.
        var hmr =
          protocols === "vite-hmr" ||
          (protocols && protocols.length && protocols[0] === "vite-hmr");
        if (hmr || !toApp(url)) return new RealWS(url, protocols);
        return deadSocket(url, null);
      };
      var WS_STATES = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
      for (var wi = 0; wi < WS_STATES.length; wi++) OfflineWS[WS_STATES[wi]] = wi;
      window.WebSocket = OfflineWS;
    }

    if (typeof window.EventSource === "function" && typeof EventTarget === "function") {
      var RealES = window.EventSource;
      var OfflineES = function (url, config) {
        if (!toApp(url)) return new RealES(url, config);
        return deadSocket(url, function (es) {
          es.withCredentials = false;
          es.close = function () {
            es.readyState = 2;
          };
        });
      };
      OfflineES.CONNECTING = 0;
      OfflineES.OPEN = 1;
      OfflineES.CLOSED = 2;
      window.EventSource = OfflineES;
    }

    if (window.navigator) {
      if (typeof window.navigator.sendBeacon === "function") {
        window.navigator.sendBeacon = function () {
          return false;
        };
      }
      // Own property, shadowing the prototype getter — the first thing an app
      // that cares about connectivity reads.
      try {
        Object.defineProperty(window.navigator, "onLine", {
          configurable: true,
          get: function () {
            return false;
          },
        });
      } catch (e) {}
    }

    // Apps that listen rather than poll are told once, after the page has had
    // its chance to attach a listener. The onLine getter above already covers
    // the ones that check on mount.
    if (typeof window.addEventListener === "function") {
      window.addEventListener("load", function () {
        try {
          window.dispatchEvent(new Event("offline"));
        } catch (e) {}
      });
    }

    window.__dedupOffline = true;
  }

  // --- hold ---------------------------------------------------------------
  // Splash screens, interstitials and "redirecting…" states are gone before
  // anyone can look at them, so they can never be inspected or edited. When
  // this frame is flagged, freeze it on its first screen.
  //
  // Long timers are how those screens advance, so queue them. Short ones must
  // still run: React's scheduler falls back to setTimeout, and stalling that
  // hangs the page instead of pausing it. 400ms cleanly separates the two —
  // no framework schedules rendering that far out, and no splash is that
  // brief. Timer-driven navigation is covered twice over, since history is
  // frozen as well. Releasing restores everything and flushes what was held,
  // so the app continues rather than having lost the work.
  if (location.search.indexOf("${HOLD_FLAG}=1") === -1) return;
  try {
    var MIN_HELD_DELAY = 400;
    var queued = [];
    var seq = 0;
    var nSetTimeout = window.setTimeout.bind(window);
    var nSetInterval = window.setInterval.bind(window);
    var nClearTimeout = window.clearTimeout.bind(window);
    var nClearInterval = window.clearInterval.bind(window);

    var hold = function (fn, args, resume) {
      var id = "dedup-held-" + ++seq;
      queued.push({
        id: id,
        run: function () {
          if (resume) resume();
          fn.apply(null, args);
        },
      });
      return id;
    };
    window.setTimeout = function (fn, delay) {
      if (typeof fn === "function" && (+delay || 0) >= MIN_HELD_DELAY) {
        return hold(fn, [].slice.call(arguments, 2), null);
      }
      return nSetTimeout.apply(null, arguments);
    };
    window.setInterval = function (fn, delay) {
      var d = +delay || 0;
      if (typeof fn === "function" && d >= MIN_HELD_DELAY) {
        // On release the interval resumes ticking, not just fires once.
        return hold(fn, [].slice.call(arguments, 2), function () {
          nSetInterval(fn, d);
        });
      }
      return nSetInterval.apply(null, arguments);
    };
    var drop = function (id) {
      for (var i = 0; i < queued.length; i++) {
        if (queued[i].id === id) {
          queued.splice(i, 1);
          return true;
        }
      }
      return false;
    };
    // The app may cancel a held timer before it ever runs — honour that.
    window.clearTimeout = function (id) {
      if (!drop(id)) nClearTimeout(id);
    };
    window.clearInterval = function (id) {
      if (!drop(id)) nClearInterval(id);
    };

    var pushState = history.pushState;
    var replaceState = history.replaceState;
    history.pushState = function () {};
    history.replaceState = function () {};

    window.__dedupHeld = true;
    window.__dedupRelease = function () {
      if (!window.__dedupHeld) return;
      window.__dedupHeld = false;
      window.setTimeout = nSetTimeout;
      window.setInterval = nSetInterval;
      window.clearTimeout = nClearTimeout;
      window.clearInterval = nClearInterval;
      history.pushState = pushState;
      history.replaceState = replaceState;
      var pending = queued.slice();
      queued.length = 0;
      for (var i = 0; i < pending.length; i++) {
        try {
          pending[i].run();
        } catch (e) {
          console.warn("dedup: a held timer failed on release", e);
        }
      }
    };
  } catch (e) {
    console.warn("dedup: hold failed to install", e);
  }
})();
`;
}
