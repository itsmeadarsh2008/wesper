import { Client, Account, Databases, Storage, Query, ID } from 'appwrite';

const DEFAULT_APPWRITE_ENDPOINT = 'https://sgp.cloud.appwrite.io/v1';
// Verified live project on sgp.cloud.appwrite.io. Commit de9a289 renamed the
// IDs to 'wesper', which does not exist there (API returns 404 project_not_found),
// so auth/database/storage all fail with the X-Appwrite-Project error.
// IDs must stay 'monochrome-plus' (immutable in Appwrite); the display
// name is 'Wesper'. Override IDs via env only after creating them in console.
const DEFAULT_APPWRITE_PROJECT_ID = 'monochrome-plus';
const DEFAULT_APPWRITE_DATABASE_ID = 'monochrome-plus';
const windowEndpoint = typeof window !== 'undefined' ? window.__APPWRITE_ENDPOINT__ : undefined;
const windowProjectId = typeof window !== 'undefined' ? window.__APPWRITE_PROJECT_ID__ : undefined;
const windowDatabaseId = typeof window !== 'undefined' ? window.__APPWRITE_DATABASE_ID__ : undefined;
const envEndpoint = import.meta.env.VITE_APPWRITE_ENDPOINT;
const envProjectId = import.meta.env.VITE_APPWRITE_PROJECT_ID;
const envDatabaseId = import.meta.env.VITE_APPWRITE_DATABASE_ID;
const configuredEndpoint = windowEndpoint || envEndpoint;

export const APPWRITE_PROJECT_ID = windowProjectId || envProjectId || DEFAULT_APPWRITE_PROJECT_ID;
export const APPWRITE_DATABASE_ID = windowDatabaseId || envDatabaseId || DEFAULT_APPWRITE_DATABASE_ID;

const isBrowser = typeof window !== 'undefined';
const isHttpsContext = !isBrowser || window.location.protocol === 'https:';
const isProxyEndpoint = typeof configuredEndpoint === 'string' && configuredEndpoint.startsWith('/appwrite/');

const appwriteEndpoint =
    !isHttpsContext && isProxyEndpoint ? DEFAULT_APPWRITE_ENDPOINT : configuredEndpoint || DEFAULT_APPWRITE_ENDPOINT;

export const APPWRITE_ENDPOINT = appwriteEndpoint;

const client = new Client().setEndpoint(appwriteEndpoint).setProject(APPWRITE_PROJECT_ID);

const account = new Account(client);
const databases = new Databases(client);
const storage = new Storage(client);

export { client, account, databases, storage, Query, ID };
