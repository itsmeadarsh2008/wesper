// cors-proxy-worker.js
//
// Self-hosted CORS proxy for Wesper. Deploy it on your own
// workers.dev domain (or a custom domain) and point the app at it:
//
//   1. Deploy this file as a Cloudflare Worker:
//      npx wrangler deploy cors-proxy-worker.js
//      (or paste it into the Cloudflare dashboard → Workers & Pages)
//
//   2. Tell Wesper to use it (run this once in the browser console
//      on the deployed site):
//      localStorage.setItem(
//          'mono-cors-proxy-custom',
//          'https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/cors/'
//      );
//      location.reload();
//
//   The app then routes all proxied traffic (e.g. TIDAL DASH segments)
//   through this proxy first, only falling back to the public proxies.
//
// See js/cors-bypass.js (CUSTOM_PROXY_KEY / getCustomProxyTemplate).

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // OPTIONS preflight — the browser always sends one for cross-origin
        // range requests; answer it fully so dash.js segments work.
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
                    'Access-Control-Allow-Headers': '*',
                    'Access-Control-Max-Age': '86400',
                },
            });
        }

        if (url.pathname === '/') {
            return new Response('Wesper CORS proxy is running.', {
                headers: { 'Access-Control-Allow-Origin': '*' },
            });
        }

        if (url.pathname !== '/cors/' || (request.method !== 'GET' && request.method !== 'HEAD')) {
            return new Response('Not found — use /cors/?url=<encoded>', { status: 404 });
        }

        const target = url.searchParams.get('url');
        if (!target || !/^https?:\/\//i.test(target)) {
            return new Response('Missing or invalid url parameter', { status: 400 });
        }

        const upstreamHeaders = new Headers();
        const range = request.headers.get('range');
        if (range) upstreamHeaders.set('range', range);
        upstreamHeaders.set(
            'user-agent',
            'Wesper/1.0 (https://github.com/itsmeadarsh2008/wesper) Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        );
        upstreamHeaders.set('accept', '*/*');

        let upstream;
        try {
            upstream = await fetch(target, {
                method: request.method,
                headers: upstreamHeaders,
                redirect: 'follow',
                signal: AbortSignal.timeout(30000),
            });
        } catch (err) {
            return new Response(`Upstream fetch failed: ${err.message}`, { status: 502 });
        }

        const responseHeaders = new Headers(upstream.headers);
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set(
            'Access-Control-Expose-Headers',
            'Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag, Cache-Control'
        );
        responseHeaders.set('Cache-Control', 'no-store');

        return new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: responseHeaders,
        });
    },
};
