import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { VitePWA } from 'vite-plugin-pwa';
import authGatePlugin from './vite-plugin-auth-gate.js';
import nodeFetch from './vite-plugin-proxy-fetch.js';
import discordBridgePlugin from './vite-plugin-discord-bridge.js';

const APP_REPO_URL = 'https://github.com/itsmeadarsh2008/wesper';
const APP_REPO_API = 'https://api.github.com/repos/itsmeadarsh2008/wesper';

// Prefer the local git HEAD. When building from a GitHub ZIP (no .git folder)
// fall back to the branch tip reported by the GitHub API, so the About section
// still shows the exact commit the bundle was built from.
function getLocalGitCommit() {
    try {
        return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    } catch {
        return null;
    }
}

async function getGitHubCommit() {
    try {
        const res = await fetch(`${APP_REPO_API}/commits/master`, {
            headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'Wesper/1.0 (https://github.com/itsmeadarsh2008/wesper)',
            },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return typeof data?.sha === 'string' && /^[0-9a-f]{40}$/i.test(data.sha) ? data.sha : null;
    } catch {
        return null;
    }
}

export default defineConfig(async () => {
    let appCommit = getLocalGitCommit();
    let appCommitSource = 'git';
    if (!appCommit) {
        appCommit = await getGitHubCommit();
        appCommitSource = appCommit ? 'github' : 'unknown';
        appCommit = appCommit || 'unknown';
    }
    const appCommitShort = appCommit === 'unknown' ? 'unknown' : appCommit.slice(0, 7);

    return {
        base: '/',
        define: {
            __APP_COMMIT__: JSON.stringify(appCommit),
            __APP_COMMIT_SHORT__: JSON.stringify(appCommitShort),
            __APP_REPO_URL__: JSON.stringify(APP_REPO_URL),
            __APP_COMMIT_SOURCE__: JSON.stringify(appCommitSource),
        },
        resolve: {
            alias: {
                pocketbase: '/node_modules/pocketbase/dist/pocketbase.es.js',
            },
        },
        optimizeDeps: {
            exclude: ['pocketbase'],
        },
        server: {
            host: true,
            port: 5173,
            strictPort: true,
            hmr: {
                host: 'localhost',
                protocol: 'ws',
                port: 5173,
            },
            allowedHosts: true,
            historyApiFallback: true,
            fs: {
                allow: ['.', 'node_modules'],
            },
            proxy: {
                '/appwrite/v1': {
                    target: 'https://sgp.cloud.appwrite.io',
                    changeOrigin: true,
                    secure: true,
                },
                '/artistgrid-trends': {
                    target: 'https://trends.artistgrid.cx',
                    changeOrigin: true,
                    secure: false,
                    rewrite: (path) => path.replace(/^\/artistgrid-trends/, ''),
                },
                '/artistgrid-assets': {
                    target: 'https://assets.artistgrid.cx',
                    changeOrigin: true,
                    secure: false,
                    rewrite: (path) => path.replace(/^\/artistgrid-assets/, ''),
                },
                '/cors-proxy': {
                    target: 'https://corsproxy.io',
                    changeOrigin: true,
                    secure: true,
                    rewrite: (path) => {
                        const encodedUrl = path.replace(/^\/cors-proxy\//, '');
                        return `/proxy?url=${encodedUrl}`;
                    },
                },
            },
        },
        preview: {
            proxy: {
                '/appwrite/v1': {
                    target: 'https://sgp.cloud.appwrite.io',
                    changeOrigin: true,
                    secure: true,
                },
                '/cors-proxy': {
                    target: 'https://corsproxy.io',
                    changeOrigin: true,
                    secure: true,
                    rewrite: (path) => {
                        const encodedUrl = path.replace(/^\/cors-proxy\//, '');
                        return `/proxy?url=${encodedUrl}`;
                    },
                },
            },
        },
        build: {
            outDir: 'dist',
            emptyOutDir: true,
        },
        plugins: [
            nodeFetch(),
            authGatePlugin(),
            discordBridgePlugin(),
            VitePWA({
                registerType: 'prompt',
                workbox: {
                    globPatterns: ['**/*.{js,css,html,ico,png,svg,json}'],
                    cleanupOutdatedCaches: true,
                    maximumFileSizeToCacheInBytes: 3 * 1024 * 1024, // 3 MiB limit
                    // Define runtime caching strategies
                    runtimeCaching: [
                        {
                            // Proxied third-party traffic (covers via public CORS
                            // proxies, or the same-origin /cors-proxy route) must
                            // never be intercepted: the SW network path rejects
                            // with "no-response" when a proxy dies, and the page's
                            // own fallback chain can't advance past a failed
                            // respondWith(). Let those reach the network directly.
                            urlPattern: ({ request }) => {
                                try {
                                    const url = request.url;
                                    if (url.includes('/cors-proxy/')) return false;
                                    const host = new URL(url).hostname;
                                    if (
                                        host === 'corsproxy.io' ||
                                        host.endsWith('.allorigins.win') ||
                                        host === 'cors-proxy.htmldriven.com'
                                    ) {
                                        return false;
                                    }
                                } catch {
                                    /* fall through to default handling */
                                }
                                return request.destination === 'image';
                            },
                            handler: 'CacheFirst',
                            options: {
                                cacheName: 'images',
                                expiration: {
                                    maxEntries: 100,
                                    maxAgeSeconds: 60 * 24 * 60 * 60, // 60 Days
                                },
                            },
                        },
                        {
                            urlPattern: ({ request }) => {
                                try {
                                    const url = request.url;
                                    if (url.includes('/cors-proxy/')) return false;
                                    const host = new URL(url).hostname;
                                    if (
                                        host === 'corsproxy.io' ||
                                        host.endsWith('.allorigins.win') ||
                                        host === 'cors-proxy.htmldriven.com'
                                    ) {
                                        return false;
                                    }
                                } catch {
                                    /* fall through to default handling */
                                }
                                return request.destination === 'audio' || request.destination === 'video';
                            },
                            handler: 'CacheFirst',
                            options: {
                                cacheName: 'media',
                                expiration: {
                                    maxEntries: 50,
                                    maxAgeSeconds: 60 * 24 * 60 * 60, // 60 Days
                                },
                                rangeRequests: true, // Support scrubbing
                            },
                        },
                    ],
                },
                includeAssets: ['discord.html'],
                manifest: false, // Use existing public/manifest.json
            }),
        ],
    };
});
