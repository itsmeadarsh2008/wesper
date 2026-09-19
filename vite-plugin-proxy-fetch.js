/**
 * Vite plugin: server-side proxy for upstream endpoints with broken TLS or CORS.
 *
 * Handles /artistgrid-api/* and /tracker-api/* routes by fetching them
 * from Node.js (bypassing browser CORS) with TLS errors suppressed.
 * Falls back to Web Archive cache when upstream is unreachable.
 */
import https from 'node:https';
import http from 'node:http';

const ROUTE_MAP = [
    {
        prefix: '/artistgrid-api/',
        upstreams: [
            'https://sheets.artistgrid.cx/',
            'https://web.archive.org/web/2026id_/https://sheets.artistgrid.cx/',
        ],
    },
    {
        prefix: '/tracker-api/',
        upstreams: ['https://tracker.israeli.ovh/'],
    },
];

const GENERIC_PROXY_PREFIX = '/cors-proxy/';

const agent = new https.Agent({ rejectUnauthorized: false });

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

const WESPER_USER_AGENT = 'Wesper/1.0 (https://github.com/itsmeadarsh2008/wesper)';

function sanitizeForwardHeaders(headers = {}) {
    const blocked = new Set(['host', 'origin', 'referer', 'connection', 'content-length', 'accept-encoding']);

    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        if (!value) continue;
        const lower = key.toLowerCase();
        if (blocked.has(lower)) continue;
        out[key] = value;
    }

    return out;
}

function ensureWesperUserAgent(headers = {}) {
    const out = { ...headers };
    const existingKey = Object.keys(out).find((key) => key.toLowerCase() === 'user-agent');
    const existing = existingKey ? out[existingKey] : null;
    if (!existing) {
        out['User-Agent'] = WESPER_USER_AGENT;
    } else if (!String(existing).includes('Wesper')) {
        out[existingKey] = `${existing} ${WESPER_USER_AGENT}`;
    }
    return out;
}

function nodeGet(url, timeoutMs = 12000, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 3) return reject(new Error('Too many redirects'));
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { agent, timeout: timeoutMs, headers: { 'User-Agent': WESPER_USER_AGENT } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(nodeGet(res.headers.location, timeoutMs, redirects + 1));
            }

            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () =>
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks),
                })
            );
            res.on('error', reject);
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('upstream timeout'));
        });
    });
}

function nodeRequest({ url, method = 'GET', headers = {}, body = null, timeoutMs = 12000, redirects = 0 }) {
    return new Promise((resolve, reject) => {
        if (redirects > 3) return reject(new Error('Too many redirects'));

        const target = new URL(url);
        const mod = target.protocol === 'https:' ? https : http;

        const req = mod.request(
            target,
            {
                method,
                headers: ensureWesperUserAgent(headers),
                agent,
                timeout: timeoutMs,
            },
            (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    const redirectUrl = new URL(res.headers.location, target).toString();
                    const preserveMethod = res.statusCode === 307 || res.statusCode === 308;
                    const nextMethod = preserveMethod ? method : 'GET';
                    const nextBody = preserveMethod ? body : null;
                    res.resume();
                    return resolve(
                        nodeRequest({
                            url: redirectUrl,
                            method: nextMethod,
                            headers,
                            body: nextBody,
                            timeoutMs,
                            redirects: redirects + 1,
                        })
                    );
                }

                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () =>
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: Buffer.concat(chunks),
                    })
                );
                res.on('error', reject);
            }
        );

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('upstream timeout'));
        });

        if (body && body.length > 0) {
            req.write(body);
        }
        req.end();
    });
}

export default function proxyFetchPlugin() {
    return {
        name: 'vite-plugin-proxy-fetch',
        configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
                if (req.url?.startsWith(GENERIC_PROXY_PREFIX)) {
                    const encodedTarget = req.url.slice(GENERIC_PROXY_PREFIX.length);
                    if (!encodedTarget) {
                        res.statusCode = 400;
                        res.setHeader('Access-Control-Allow-Origin', '*');
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify({ error: 'Missing target URL' }));
                        return;
                    }

                    let targetUrl;
                    try {
                        targetUrl = decodeURIComponent(encodedTarget);
                    } catch {
                        res.statusCode = 400;
                        res.setHeader('Access-Control-Allow-Origin', '*');
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify({ error: 'Invalid target URL encoding' }));
                        return;
                    }

                    if (!/^https?:\/\//i.test(targetUrl)) {
                        res.statusCode = 403;
                        res.setHeader('Access-Control-Allow-Origin', '*');
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify({ error: 'Target URL must be http(s)' }));
                        return;
                    }

                    if (req.method === 'OPTIONS') {
                        res.statusCode = 204;
                        res.setHeader('Access-Control-Allow-Origin', '*');
                        res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
                        res.setHeader('Access-Control-Allow-Headers', '*');
                        res.setHeader('Access-Control-Expose-Headers', '*');
                        res.end();
                        return;
                    }

                    try {
                        const requestBody = await readRequestBody(req);
                        const forwardHeaders = sanitizeForwardHeaders(req.headers);
                        if (requestBody.length > 0) {
                            forwardHeaders['content-length'] = String(requestBody.length);
                        }

                        const result = await nodeRequest({
                            url: targetUrl,
                            method: req.method || 'GET',
                            headers: forwardHeaders,
                            body: requestBody,
                        });

                        res.setHeader('Access-Control-Allow-Origin', '*');
                        res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
                        res.setHeader('Access-Control-Allow-Headers', '*');
                        res.setHeader('Access-Control-Expose-Headers', '*');
                        if (result.headers['content-type']) {
                            res.setHeader('Content-Type', result.headers['content-type']);
                        }
                        res.statusCode = result.status;
                        res.end(result.body);
                        return;
                    } catch (error) {
                        console.error('[proxy-fetch] generic cors proxy failed for', targetUrl, error?.message);
                        res.statusCode = 502;
                        res.setHeader('Access-Control-Allow-Origin', '*');
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify({ error: 'Upstream unreachable' }));
                        return;
                    }
                }

                let route = null;
                let rest = '';

                for (const r of ROUTE_MAP) {
                    if (req.url.startsWith(r.prefix)) {
                        route = r;
                        rest = req.url.slice(r.prefix.length);
                        break;
                    }
                }

                if (!route) return next();

                let lastErr = null;
                for (const upstream of route.upstreams) {
                    try {
                        const result = await nodeGet(upstream + rest);
                        if (result.status >= 200 && result.status < 400) {
                            res.setHeader('Access-Control-Allow-Origin', '*');
                            if (result.headers['content-type']) {
                                res.setHeader('Content-Type', result.headers['content-type']);
                            }
                            res.statusCode = result.status;
                            res.end(result.body);
                            return;
                        }
                        lastErr = new Error(`HTTP ${result.status}`);
                    } catch (err) {
                        lastErr = err;
                    }
                }

                console.error(`[proxy-fetch] all upstreams failed for ${req.url}:`, lastErr?.message);
                res.statusCode = 502;
                res.setHeader('Content-Type', 'text/plain');
                res.end('Bad Gateway: all upstreams unreachable');
            });
        },
    };
}
