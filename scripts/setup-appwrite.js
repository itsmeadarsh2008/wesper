import { Client, Databases, Storage, Permission, Query, Role } from 'node-appwrite';
import dotenv from 'dotenv';

dotenv.config();

const client = new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT || 'https://sgp.cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_PROJECT_ID || 'monochrome-plus')
    .setKey(process.env.APPWRITE_API_KEY); // Requires an API key with database permissions

const databases = new Databases(client);
const storage = new Storage(client);

const SYNC_COLLECTION_METADATA =
    process.argv.includes('--sync-collection-metadata') ||
    process.env.APPWRITE_SETUP_SYNC_COLLECTION_METADATA === 'true';

const DATABASE_ID = process.env.APPWRITE_DATABASE_ID || 'monochrome-plus';
const DATABASE_NAME = process.env.APPWRITE_DATABASE_NAME || 'Wesper';
const USERS_COLLECTION_ID = 'DB_users';

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNotFoundError(error) {
    return error?.code === 404 || /not.?found/i.test(String(error?.type || ''));
}

function hasLegacyMetadataFlag() {
    return (
        process.argv.includes('--apply-collection-updates') ||
        process.env.APPWRITE_SETUP_APPLY_COLLECTION_UPDATES === 'true'
    );
}

const collections = [
    {
        id: USERS_COLLECTION_ID,
        name: 'Users',
        permissions: [
            Permission.read(Role.any()),
            Permission.create(Role.users()),
            Permission.update(Role.users()),
            Permission.delete(Role.users()),
        ],
        documentSecurity: true,
        attributes: [
            { key: 'firebase_id', type: 'string', size: 255, required: true },
            { key: 'username', type: 'string', size: 255, required: true },
            { key: 'display_name', type: 'string', size: 255, required: false },
            { key: 'avatar_url', type: 'string', size: 1000, required: false },
            { key: 'banner', type: 'string', size: 1000, required: false },
            { key: 'status', type: 'string', size: 5000, required: false }, // Store JSON as string
            { key: 'about', type: 'string', size: 5000, required: false },
            { key: 'website', type: 'string', size: 500, required: false },
            { key: 'lastfm_username', type: 'string', size: 255, required: false },
            { key: 'profile_data_source', type: 'string', size: 64, required: false },
            { key: 'library', type: 'string', size: 65535, required: false, x_large: true }, // Big JSON
            { key: 'history', type: 'string', size: 65535, required: false, x_large: true },
            { key: 'user_playlists', type: 'string', size: 65535, required: false, x_large: true },
            { key: 'user_folders', type: 'string', size: 65535, required: false, x_large: true },
            { key: 'favorite_albums', type: 'string', size: 65535, required: false, x_large: true },
            { key: 'statistics_summary', type: 'string', size: 65535, required: false, x_large: true },
            { key: 'privacy', type: 'string', size: 2000, required: false },
        ],
        indexes: [
            { key: 'idx_firebase_id', attributes: ['firebase_id'], type: 'key' },
            { key: 'idx_username', attributes: ['username'], type: 'unique' },
        ],
    },
    {
        id: 'DB_public_playlists',
        name: 'Public Playlists',
        permissions: [
            Permission.read(Role.any()),
            Permission.create(Role.users()),
            Permission.update(Role.users()),
            Permission.delete(Role.users()),
        ],
        documentSecurity: true,
        attributes: [
            { key: 'id', type: 'string', size: 255, required: true },
            { key: 'owner_id', type: 'string', size: 255, required: true },
            { key: 'name', type: 'string', size: 255, required: true },
            { key: 'description', type: 'string', size: 2000, required: false },
            { key: 'cover', type: 'string', size: 1000, required: false },
            { key: 'tracks', type: 'string', size: 65535, required: false, x_large: true },
            { key: 'is_public', type: 'boolean', required: false, default: true },
        ],
        indexes: [
            { key: 'idx_playlist_id', attributes: ['id'], type: 'key' },
            { key: 'idx_owner', attributes: ['owner_id'], type: 'key' },
        ],
    },
    {
        id: 'DB_collaborative_playlists',
        name: 'Collaborative Playlists',
        permissions: [
            Permission.read(Role.users()),
            Permission.create(Role.users()),
            Permission.update(Role.users()),
            Permission.delete(Role.users()),
        ],
        documentSecurity: true,
        attributes: [
            { key: 'id', type: 'string', size: 255, required: true },
            { key: 'owner_id', type: 'string', size: 255, required: true },
            { key: 'name', type: 'string', size: 255, required: true },
            { key: 'description', type: 'string', size: 2000, required: false },
            { key: 'cover', type: 'string', size: 1000, required: false },
            { key: 'tracks', type: 'string', size: 65535, required: false, x_large: true },
            { key: 'members', type: 'string', size: 65535, required: false, x_large: true },
            { key: 'created_at', type: 'integer', required: true },
            { key: 'updated_at', type: 'integer', required: true },
            { key: 'is_collaborative', type: 'boolean', required: false, default: true },
        ],
        indexes: [
            { key: 'idx_collab_playlist_id', attributes: ['id'], type: 'key' },
            { key: 'idx_collab_owner', attributes: ['owner_id'], type: 'key' },
            { key: 'idx_collab_updated', attributes: ['updated_at'], type: 'key' },
            { key: 'idx_collab_type', attributes: ['is_collaborative'], type: 'key' },
        ],
    },
    {
        id: 'DB_friend_requests',
        name: 'Friend Requests',
        permissions: [
            Permission.read(Role.users()),
            Permission.create(Role.users()),
            Permission.update(Role.users()),
            Permission.delete(Role.users()),
        ],
        documentSecurity: true,
        attributes: [
            { key: 'sender_id', type: 'string', size: 255, required: true },
            { key: 'sender_username', type: 'string', size: 255, required: true },
            { key: 'sender_display_name', type: 'string', size: 255, required: false },
            { key: 'sender_avatar', type: 'string', size: 1000, required: false },
            { key: 'receiver_id', type: 'string', size: 255, required: true },
            { key: 'receiver_username', type: 'string', size: 255, required: true },
            { key: 'receiver_display_name', type: 'string', size: 255, required: false },
            { key: 'receiver_avatar', type: 'string', size: 1000, required: false },
            { key: 'status', type: 'string', size: 32, required: true },
            { key: 'created_at', type: 'integer', required: true },
            { key: 'updated_at', type: 'integer', required: true },
        ],
        indexes: [
            { key: 'idx_friend_sender', attributes: ['sender_id'], type: 'key' },
            { key: 'idx_friend_receiver', attributes: ['receiver_id'], type: 'key' },
            { key: 'idx_friend_status', attributes: ['status'], type: 'key' },
            { key: 'idx_friend_created', attributes: ['created_at'], type: 'key' },
        ],
    },
    {
        id: 'DB_chat_messages',
        name: 'Chat Messages',
        permissions: [
            Permission.read(Role.users()),
            Permission.create(Role.users()),
            Permission.update(Role.users()),
            Permission.delete(Role.users()),
        ],
        documentSecurity: true,
        attributes: [
            { key: 'conversation_id', type: 'string', size: 512, required: true },
            { key: 'sender_id', type: 'string', size: 255, required: true },
            { key: 'sender_username', type: 'string', size: 255, required: true },
            { key: 'sender_display_name', type: 'string', size: 255, required: false },
            { key: 'sender_avatar', type: 'string', size: 1000, required: false },
            { key: 'receiver_id', type: 'string', size: 255, required: true },
            { key: 'receiver_username', type: 'string', size: 255, required: true },
            { key: 'receiver_display_name', type: 'string', size: 255, required: false },
            { key: 'receiver_avatar', type: 'string', size: 1000, required: false },
            { key: 'message', type: 'string', size: 5000, required: false },
            { key: 'track_payload', type: 'string', size: 65535, required: false, x_large: true },
            { key: 'created_at', type: 'integer', required: true },
            { key: 'read', type: 'boolean', required: false, default: false },
        ],
        indexes: [
            { key: 'idx_chat_conversation', attributes: ['conversation_id'], type: 'key' },
            { key: 'idx_chat_sender', attributes: ['sender_id'], type: 'key' },
            { key: 'idx_chat_receiver', attributes: ['receiver_id'], type: 'key' },
            { key: 'idx_chat_created', attributes: ['created_at'], type: 'key' },
            { key: 'idx_chat_read', attributes: ['read'], type: 'key' },
        ],
    },
];

async function backfillUserStatisticsSummary() {
    console.log('📊 Ensuring existing user documents have "statistics_summary"...');

    let cursor = null;
    let scanned = 0;
    let patched = 0;

    while (true) {
        const queries = [Query.limit(100)];
        if (cursor) {
            queries.push(Query.cursorAfter(cursor));
        }

        const response = await databases.listDocuments(DATABASE_ID, USERS_COLLECTION_ID, queries);
        const documents = response.documents || [];
        if (documents.length === 0) {
            break;
        }

        for (const doc of documents) {
            scanned += 1;

            const raw = doc.statistics_summary;
            const hasSummary =
                (typeof raw === 'string' && raw.trim().length > 0) ||
                (raw && typeof raw === 'object' && Object.keys(raw).length > 0);

            if (hasSummary) {
                continue;
            }

            await databases.updateDocument(DATABASE_ID, USERS_COLLECTION_ID, doc.$id, {
                statistics_summary: '{}',
            });
            patched += 1;
            await wait(120);
        }

        cursor = documents[documents.length - 1].$id;
        if (documents.length < 100) {
            break;
        }
    }

    console.log(`✅ Stats backfill complete. Scanned: ${scanned}, Patched: ${patched}`);
}

async function setup() {
    try {
        console.log('🚀 Starting Appwrite Setup...');
        console.log('🛡️ Non-destructive mode enabled (existing data is never deleted).');
        if (hasLegacyMetadataFlag()) {
            console.log(
                '⚠️ Ignoring deprecated metadata update flag (--apply-collection-updates). Use --sync-collection-metadata to explicitly update existing collection metadata.'
            );
        }
        if (SYNC_COLLECTION_METADATA) {
            console.log('⚠️ Collection metadata sync is enabled (--sync-collection-metadata).');
        }

        // 1. Create Database if not exists (ID is immutable, name is display-only)
        try {
            const existing = await databases.get(DATABASE_ID);
            console.log(`✅ Database "${DATABASE_ID}" already exists.`);
            if (existing?.name !== DATABASE_NAME) {
                console.log(`   Renaming database display name "${existing?.name}" → "${DATABASE_NAME}"...`);
                await databases.update(DATABASE_ID, DATABASE_NAME);
            }
        } catch (e) {
            if (!isNotFoundError(e)) {
                throw e;
            }
            console.log(`Creating database "${DATABASE_ID}"...`);
            await databases.create(DATABASE_ID, DATABASE_NAME);
        }

        // 2. Create Collections
        for (const col of collections) {
            let collectionExists = false;
            try {
                await databases.getCollection(DATABASE_ID, col.id);
                collectionExists = true;
                console.log(`✅ Collection "${col.id}" already exists.`);

                if (SYNC_COLLECTION_METADATA) {
                    console.log(`   Updating collection metadata for "${col.id}"...`);
                    await databases.updateCollection(
                        DATABASE_ID,
                        col.id,
                        col.name,
                        col.permissions,
                        col.documentSecurity
                    );
                } else {
                    console.log(
                        `   Skipping collection metadata update for "${col.id}" (safe mode). Use --sync-collection-metadata to enable.`
                    );
                }
            } catch (e) {
                if (!isNotFoundError(e)) {
                    throw e;
                }
                console.log(`Creating collection "${col.id}"...`);
                await databases.createCollection(DATABASE_ID, col.id, col.name, col.permissions, col.documentSecurity);
            }

            // 3. Create Attributes
            const existingAttrRes = await databases.listAttributes(DATABASE_ID, col.id);
            const existingKeys = existingAttrRes.attributes.map((a) => a.key);

            for (const attr of col.attributes) {
                if (existingKeys.includes(attr.key)) continue;

                const requiredForCreation = collectionExists ? false : attr.required;
                if (collectionExists && attr.required) {
                    console.log(
                        `   ⚠️ Attribute "${attr.key}" is required in schema but will be created as optional to avoid impacting existing documents.`
                    );
                }

                console.log(`   Adding attribute "${attr.key}" to "${col.id}"...`);
                const canUseDefault = Object.hasOwn(attr, 'default') && !requiredForCreation;
                if (attr.type === 'string') {
                    if (canUseDefault) {
                        await databases.createStringAttribute(
                            DATABASE_ID,
                            col.id,
                            attr.key,
                            attr.size,
                            requiredForCreation,
                            attr.default
                        );
                    } else {
                        await databases.createStringAttribute(
                            DATABASE_ID,
                            col.id,
                            attr.key,
                            attr.size,
                            requiredForCreation
                        );
                    }
                } else if (attr.type === 'boolean') {
                    if (canUseDefault) {
                        await databases.createBooleanAttribute(
                            DATABASE_ID,
                            col.id,
                            attr.key,
                            requiredForCreation,
                            attr.default
                        );
                    } else {
                        await databases.createBooleanAttribute(DATABASE_ID, col.id, attr.key, requiredForCreation);
                    }
                } else if (attr.type === 'integer') {
                    if (canUseDefault) {
                        await databases.createIntegerAttribute(
                            DATABASE_ID,
                            col.id,
                            attr.key,
                            requiredForCreation,
                            null,
                            null,
                            attr.default
                        );
                    } else {
                        await databases.createIntegerAttribute(
                            DATABASE_ID,
                            col.id,
                            attr.key,
                            requiredForCreation,
                            null,
                            null
                        );
                    }
                }
                // Add sleep to avoid rate limits on cloud
                await new Promise((r) => setTimeout(r, 1000));
            }

            // 4. Create Indexes
            const existingIdxRes = await databases.listIndexes(DATABASE_ID, col.id);
            const existingIdxKeys = existingIdxRes.indexes.map((i) => i.key);

            for (const idx of col.indexes) {
                if (existingIdxKeys.includes(idx.key)) continue;
                console.log(`   Adding index "${idx.key}" to "${col.id}"...`);
                try {
                    await databases.createIndex(DATABASE_ID, col.id, idx.key, idx.type, idx.attributes);
                } catch (indexError) {
                    console.warn(
                        `   ⚠️ Skipped index "${idx.key}" on "${col.id}". This can happen with existing data constraints:`,
                        indexError?.message || indexError
                    );
                }
            }
        }

        try {
            await backfillUserStatisticsSummary();
        } catch (migrationError) {
            console.warn(
                '⚠️ Could not complete statistics_summary backfill. Setup is still usable; rerun to retry migration.',
                migrationError?.message || migrationError
            );
        }

        // 5. Create Storage Bucket
        const BUCKET_ID = 'profile-images';
        try {
            await storage.getBucket(BUCKET_ID);
            console.log(`✅ Bucket "${BUCKET_ID}" already exists.`);
        } catch (error) {
            if (!isNotFoundError(error)) {
                throw error;
            }
            console.log(`Creating bucket "${BUCKET_ID}"...`);
            await storage.createBucket(
                BUCKET_ID,
                'Profile Images',
                [
                    Permission.read(Role.any()),
                    Permission.create(Role.users()),
                    Permission.update(Role.users()),
                    Permission.delete(Role.users()),
                ],
                false, // fileSecurity
                true, // enabled
                50000000, // maximumFileSize (50MB)
                ['jpg', 'png', 'jpeg', 'webp', 'gif'], // allowedExtensions
                'none', // compression
                true, // encryption
                true // antivirus
            );
        }

        console.log('✨ Appwrite Infrastructure Setup Complete!');
    } catch (error) {
        console.error('❌ Setup failed:', error);
        if (error.code === 401) {
            console.error('   Hint: Make sure your APPWRITE_API_KEY is correct and has "databases.write" permissions.');
        }
    }
}

setup();
