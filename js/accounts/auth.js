// js/accounts/auth.js
import { account, client, APPWRITE_PROJECT_ID } from '../lib/appwrite.js';
import { ID } from 'appwrite';
import MailChecker from 'mailchecker';

const OAUTH_ATTEMPT_KEY = 'mono-oauth-attempt';
const OAUTH_ATTEMPT_MAX_AGE_MS = 2 * 60 * 1000;
const APPWRITE_OAUTH_FALLBACK_ENDPOINTS = ['https://cloud.appwrite.io/v1', 'https://sgp.cloud.appwrite.io/v1'];
const DEFAULT_OAUTH_REDIRECT_URL = 'https://monochrome-plus.appwrite.network';
const EMAIL_BASIC_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isHttpUrl(value) {
    return /^https?:\/\//i.test(value || '');
}

function appendUniqueUrl(target, value) {
    if (!isHttpUrl(value)) return;
    if (!target.includes(value)) {
        target.push(value);
    }
}

function getOAuthRedirectUrls() {
    const origin = typeof window !== 'undefined' ? window.location?.origin || '' : '';
    const redirects = [];

    appendUniqueUrl(redirects, origin);

    return redirects.length ? redirects : [DEFAULT_OAUTH_REDIRECT_URL];
}

/**
 * Start the OAuth2 token flow.
 *
 * Uses createOAuth2Token semantics instead of createOAuth2Session:
 * the session is created client-side after the redirect (via
 * createSession(userId, secret)) instead of relying on a cross-site
 * Appwrite cookie. Browsers with strict tracking protection / adblockers
 * (Firefox Total Cookie Protection, uBlock Origin) block that third-party
 * cookie, which previously left the user signed out after a "successful"
 * Discord/Google login. The Appwrite server returns the session in the
 * X-Fallback-Cookies header on the createSession response, and the SDK
 * persists it in localStorage, so the session survives without cookies.
 */
async function createOAuthSessionWithFallback(provider, redirectUrls) {
    const endpointCandidates = [null, ...APPWRITE_OAUTH_FALLBACK_ENDPOINTS];
    const redirectCandidates = Array.isArray(redirectUrls) ? redirectUrls : [redirectUrls];

    for (const redirectUrl of redirectCandidates) {
        for (const endpoint of endpointCandidates) {
            try {
                const baseEndpoint = String(endpoint || client.config.endpoint || '')
                    .trim()
                    .replace(/\/+$/, '');
                if (!baseEndpoint) throw new Error('No Appwrite endpoint available');

                const url = new URL(`${baseEndpoint}/account/tokens/oauth2/${provider}`);
                url.searchParams.set('project', APPWRITE_PROJECT_ID);
                url.searchParams.set('success', redirectUrl);
                url.searchParams.set('failure', redirectUrl);

                console.log(`[Appwrite] ${provider} login initiated (token flow, endpoint: ${baseEndpoint})...`);
                window.location.href = url.toString();
                return;
            } catch (error) {
                console.warn(
                    `[Appwrite] ${provider} OAuth endpoint failed${endpoint ? ` (${endpoint})` : ''} with redirect ${redirectUrl}:`,
                    error?.message || error
                );
            }
        }
    }

    throw new Error(`${provider} OAuth is temporarily unavailable. Please retry in a moment or use Email sign-in.`);
}

export class AuthManager {
    constructor() {
        this.user = null;
        this.authListeners = [];
        this.initialized = this.init();
    }

    async _refreshUser() {
        const user = await account.get();
        this.user = user;
        this.updateUI(user);
        this.authListeners.forEach((listener) => listener(user));
        return user;
    }

    async init() {
        await this._handleOAuthCallback();

        try {
            // Check for existing session (persistent auth)
            const user = await account.get();
            this.user = user;
            console.log(
                '[Appwrite] ✓ Authentication successful. Session restored:',
                user.email || user.name || user.$id
            );
            this.updateUI(user);
            this.authListeners.forEach((listener) => listener(user));

            localStorage.removeItem(OAUTH_ATTEMPT_KEY);
        } catch {
            console.log('[Appwrite] Info: No active session found on initialization');
            this.user = null; // Explicitly null
            this.updateUI(null);
            this.authListeners.forEach((listener) => listener(null));

            this._reportBlockedOAuth();
        }
    }

    /**
     * Complete the OAuth2 token flow after the provider redirect lands back
     * on the app with `?userId=...&secret=...` (success) or `?error=...`
     * (failure). Creating the session here keeps auth working even when the
     * Appwrite session cookie is blocked by tracking protection/adblockers.
     */
    async _handleOAuthCallback() {
        if (typeof window === 'undefined' || !window.location?.search) return false;

        const params = new URLSearchParams(window.location.search);
        const userId = params.get('userId');
        const secret = params.get('secret');
        const oauthError = params.get('error');

        if (!userId && !secret && !oauthError) return false;

        const cleanupUrl = () => {
            const cleanPath = window.location.pathname + window.location.hash;
            window.history.replaceState(null, '', cleanPath);
        };

        try {
            if (userId && secret) {
                await account.createSession(userId, secret);
                console.log('[Appwrite] ✓ OAuth session created via token flow');
            } else {
                console.warn('[Appwrite] OAuth callback reported an error:', oauthError || 'unknown');
                this._reportBlockedOAuth();
            }
        } catch (error) {
            console.error('[Appwrite] OAuth session creation failed:', error);
            this._reportBlockedOAuth();
        } finally {
            localStorage.removeItem(OAUTH_ATTEMPT_KEY);
            cleanupUrl();
        }

        return true;
    }

    _consumeOAuthAttempt() {
        try {
            const rawAttempt = localStorage.getItem(OAUTH_ATTEMPT_KEY);
            if (!rawAttempt) return null;

            const attempt = JSON.parse(rawAttempt);
            const age = Date.now() - Number(attempt?.ts || 0);
            if (age <= OAUTH_ATTEMPT_MAX_AGE_MS && attempt?.provider) {
                return attempt.provider;
            }
            return null;
        } catch {
            // Ignore malformed localStorage payloads
            return null;
        } finally {
            localStorage.removeItem(OAUTH_ATTEMPT_KEY);
        }
    }

    _reportBlockedOAuth() {
        const provider = this._consumeOAuthAttempt();
        if (!provider) return;

        window.dispatchEvent(
            new CustomEvent('auth-oauth-blocked', {
                detail: {
                    provider,
                },
            })
        );
    }

    onAuthStateChanged(callback) {
        this.authListeners.push(callback);
        // Trigger immediately so caller knows current state (even if Guest)
        callback(this.user);
    }

    async signInWithGoogle() {
        try {
            const redirectUrls = getOAuthRedirectUrls();
            localStorage.setItem(OAUTH_ATTEMPT_KEY, JSON.stringify({ provider: 'google', ts: Date.now() }));
            await createOAuthSessionWithFallback('google', redirectUrls);
        } catch (error) {
            console.error('[Appwrite] ✗ Google login failed:', error);
            localStorage.removeItem(OAUTH_ATTEMPT_KEY);
            throw error;
        }
    }

    async signInWithDiscord() {
        try {
            const redirectUrls = getOAuthRedirectUrls();
            localStorage.setItem(OAUTH_ATTEMPT_KEY, JSON.stringify({ provider: 'discord', ts: Date.now() }));
            await createOAuthSessionWithFallback('discord', redirectUrls);
        } catch (error) {
            console.error('[Appwrite] ✗ Discord login failed after fallback attempts:', error);
            localStorage.removeItem(OAUTH_ATTEMPT_KEY);
            throw error;
        }
    }

    async signInWithEmail(email, password) {
        try {
            await account.createEmailPasswordSession(email, password);
            const user = await this._refreshUser();
            console.log('[Appwrite] ✓ Email login successful:', user.email);
            return user;
        } catch (error) {
            console.error('Email Login failed:', error);
            throw error;
        }
    }

    evaluateSignupEmail(email) {
        const normalizedEmail = String(email || '')
            .trim()
            .toLowerCase();

        if (!EMAIL_BASIC_PATTERN.test(normalizedEmail)) {
            return {
                ok: false,
                code: 'auth/invalid-email',
                message: 'Please enter a valid email address.',
                normalizedEmail,
            };
        }

        if (!MailChecker.isValid(normalizedEmail)) {
            return {
                ok: false,
                code: 'auth/disposable-email',
                message: 'Temporary or disposable email addresses are not allowed. Use a permanent email.',
                normalizedEmail,
            };
        }

        return {
            ok: true,
            code: 'auth/email-ok',
            message: 'Email looks good.',
            normalizedEmail,
        };
    }

    async signUpWithEmail(email, password) {
        const result = this.evaluateSignupEmail(email);
        if (!result.ok) {
            const error = new Error(result.message);
            error.code = result.code;
            throw error;
        }

        try {
            await account.create(ID.unique(), result.normalizedEmail, password);
            // Sign in automatically after sign up
            return await this.signInWithEmail(result.normalizedEmail, password);
        } catch (error) {
            console.error('Sign Up failed:', error);
            throw error;
        }
    }

    async sendPasswordReset(email) {
        try {
            const redirectUrl = window.location.origin + '/reset-password';
            await account.createRecovery(email, redirectUrl);
            return true;
        } catch (error) {
            console.error('Password reset failed:', error);
            throw error;
        }
    }

    async signOut() {
        try {
            await account.deleteSession('current');
            this.user = null;
            console.log('[Appwrite] ✓ Signed out successfully');
            this.updateUI(null);
            this.authListeners.forEach((listener) => listener(null));

            if (window.__AUTH_GATE__) {
                window.location.href = '/login';
            }
        } catch (error) {
            console.error('Logout failed:', error);
            throw error;
        }
    }

    updateUI(user) {
        const connectBtn = document.getElementById('auth-signout-btn');
        const clearDataBtn = document.getElementById('firebase-clear-cloud-btn');
        const statusText = document.getElementById('auth-status');
        const authMethodsContainer = document.getElementById('auth-buttons-container');
        const authPanel = document.getElementById('auth-panel');
        const userBadge = document.getElementById('auth-user-pill');
        const viewProfileBtn = document.getElementById('view-my-profile-btn');

        if (!statusText) return; // UI might not be rendered yet

        if (!user) {
            if (connectBtn) {
                connectBtn.style.display = 'none';
                connectBtn.classList.remove('danger');
                connectBtn.onclick = null;
            }
            if (clearDataBtn) clearDataBtn.style.display = 'none';
            if (statusText) statusText.textContent = 'Authentication required to sync and personalize your experience.';
            if (authMethodsContainer) authMethodsContainer.style.display = '';
            if (authPanel) authPanel.classList.remove('signed-in');
            if (userBadge) userBadge.style.display = 'none';
            if (viewProfileBtn) viewProfileBtn.style.display = 'none';
        } else {
            if (connectBtn) {
                connectBtn.textContent = 'Sign Out';
                connectBtn.style.display = 'inline-flex';
                connectBtn.classList.add('danger');
                connectBtn.onclick = () => this.signOut();
            }

            if (clearDataBtn) clearDataBtn.style.display = 'block';
            if (authMethodsContainer) authMethodsContainer.style.display = 'none';
            if (authPanel) authPanel.classList.add('signed-in');
            if (userBadge) {
                userBadge.style.display = 'inline-flex';
                userBadge.textContent = user.email || user.phone || user.name || user.$id;
            }
            if (viewProfileBtn) viewProfileBtn.style.display = 'inline-flex';
            if (statusText)
                statusText.textContent = `Signed in as ${user.email || user.phone || user.name || user.$id}`;
        }

        // Auth gate active: strip down to status + sign out only
        if (window.__AUTH_GATE__) {
            if (connectBtn) {
                connectBtn.textContent = 'Sign Out';
                connectBtn.classList.add('danger');
                connectBtn.style.display = user ? 'inline-flex' : 'none';
                connectBtn.onclick = () => this.signOut();
            }
            if (clearDataBtn) clearDataBtn.style.display = 'none';
            if (authMethodsContainer) authMethodsContainer.style.display = user ? 'none' : '';
            if (statusText)
                statusText.textContent = user
                    ? `Signed in as ${user.email || user.phone || user.name || user.$id}`
                    : 'Authentication required to sync and personalize your experience.';
            return;
        }
    }
}

export const authManager = new AuthManager();
window.authManager = authManager;
