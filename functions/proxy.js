// functions/proxy.js
// Generic same-origin proxy for browser CORS-bypassed requests.

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Expose-Headers': '*',
    };
}

function sanitizeForwardHeaders(headers) {
    const WESPER_USER_AGENT = 'Wesper/1.0 (https://github.com/itsmeadarsh2008/wesper)';
    const blocked = new Set([
        'host',
        'origin',
        'referer',
        'connection',
        'content-length',
        'accept-encoding',
        'cf-connecting-ip',
        'x-forwarded-for',
        'x-real-ip',
    ]);

    const out = new Headers();
    headers.forEach((value, key) => {
        if (!value) return;
        if (blocked.has(key.toLowerCase())) return;
        out.set(key, value);
    });

    const existing = out.get('user-agent');
    if (!existing) {
        out.set('user-agent', WESPER_USER_AGENT);
    } else if (!existing.includes('Wesper')) {
        out.set('user-agent', `${existing} ${WESPER_USER_AGENT}`);
    }

    return out;
}

export async function onRequest(context) {
    const { request } = context;

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get('url');

    if (!target) {
        return new Response(JSON.stringify({ error: 'Missing url query parameter' }), {
            status: 400,
            headers: {
                ...corsHeaders(),
                'Content-Type': 'application/json',
            },
        });
    }

    let parsedTarget;
    try {
        parsedTarget = new URL(target);
    } catch {
        return new Response(JSON.stringify({ error: 'Invalid target URL' }), {
            status: 400,
            headers: {
                ...corsHeaders(),
                'Content-Type': 'application/json',
            },
        });
    }

    if (!/^https?:$/i.test(parsedTarget.protocol)) {
        return new Response(JSON.stringify({ error: 'Only http(s) targets are allowed' }), {
            status: 403,
            headers: {
                ...corsHeaders(),
                'Content-Type': 'application/json',
            },
        });
    }

    try {
        const method = request.method || 'GET';
        const forwardHeaders = sanitizeForwardHeaders(request.headers);

        const init = {
            method,
            headers: forwardHeaders,
            redirect: 'follow',
        };

        if (!['GET', 'HEAD'].includes(method.toUpperCase())) {
            init.body = await request.arrayBuffer();
        }

        const upstream = await fetch(parsedTarget.toString(), init);
        const responseHeaders = new Headers(corsHeaders());

        const contentType = upstream.headers.get('content-type');
        if (contentType) {
            responseHeaders.set('Content-Type', contentType);
        }

        return new Response(upstream.body, {
            status: upstream.status,
            headers: responseHeaders,
        });
    } catch (error) {
        return new Response(
            JSON.stringify({ error: 'Upstream request failed', message: error?.message || 'unknown' }),
            {
                status: 502,
                headers: {
                    ...corsHeaders(),
                    'Content-Type': 'application/json',
                },
            }
        );
    }
}
