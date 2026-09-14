// js/accounts/appwrite-sync.js
import { client, databases, APPWRITE_DATABASE_ID as DATABASE_ID } from '../lib/appwrite.js';
import { db as database } from '../db.js';
import { authManager } from './auth.js';
import { ID, Permission, Query, Role } from 'appwrite';
import { getShareUrl, getTrackArtists } from '../utils.js';

const USERS_COLLECTION = 'DB_users';
const PUBLIC_PLAYLISTS_COLLECTION = 'DB_public_playlists';
const COLLABORATIVE_PLAYLISTS_COLLECTION = 'DB_collaborative_playlists';
const FRIEND_REQUESTS_COLLECTION = 'DB_friend_requests';
const CHAT_MESSAGES_COLLECTION = 'DB_chat_messages';

const DEFAULT_PRIVACY = { playlists: 'public', lastfm: 'public' };
const MAX_HISTORY_STRING_LENGTH = 65000; // Appwrite limit is 65535 chars
const MAX_HISTORY_CHUNK_SIZE = 60000; // safe per-chunk payload for history chunks
const MAX_TRACK_SYNC = 1500;
const MAX_ALBUM_SYNC = 1000;
const MAX_ARTIST_SYNC = 1000;
const MAX_PLAYLIST_SYNC = 600;
const MAX_MIX_SYNC = 400;
const MAX_PUBLIC_PLAYLIST_TRACKS = 500;
const MAX_PUBLIC_PLAYLIST_TRACKS_PAYLOAD_CHARS = 62000;
const PLAYLIST_TRACK_CHUNK_ESTIMATE_TOTAL = 999999;
const PLAYLIST_SYNC_BATCH_SIZE = 6;
const MAX_COLLAB_PLAYLIST_TRACKS = 700;
const MAX_COLLAB_PLAYLIST_TRACKS_PAYLOAD_CHARS = 62000;
const PENDING_LIBRARY_OPS_STORAGE_KEY = 'monochrome.sync.pendingLibraryOps.v1';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isNetworkError(error) {
    const message = String(error?.message || '').toLowerCase();
    return (
        error?.name === 'TypeError' ||
        message.includes('networkerror') ||
        message.includes('failed to fetch') ||
        message.includes('network request')
    );
}

const syncManager = {
    _userRecordCache: null,
    _isSyncing: false,
    _realtimeUnsubscribe: null,
    _syncIntervalId: null,
    _statusBackoffUntil: 0,
    _lastPlaybackStatusFingerprint: '',
    _lastPlaybackStatusSentAt: 0,
    _cloudPullPromise: null,
    _publicPlaylistSyncPromise: null,
    _publicPlaylistSyncTimeoutId: null,
    _privatePlaylistSyncPromise: null,
    _privatePlaylistSyncTimeoutId: null,
    _collaborativePlaylistSyncPromise: null,
    _collaborativePlaylistSyncTimeoutId: null,
    _chunkedHistorySupported: true,

    _loadPendingLibraryOps() {
        if (typeof localStorage === 'undefined') return [];
        try {
            const raw = localStorage.getItem(PENDING_LIBRARY_OPS_STORAGE_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    },

    _savePendingLibraryOps(ops) {
        if (typeof localStorage === 'undefined') return;
        try {
            if (!Array.isArray(ops) || ops.length === 0) {
                localStorage.removeItem(PENDING_LIBRARY_OPS_STORAGE_KEY);
                return;
            }
            localStorage.setItem(PENDING_LIBRARY_OPS_STORAGE_KEY, JSON.stringify(ops.slice(-200)));
        } catch {
            // Ignore localStorage write failures.
        }
    },

    _enqueuePendingLibraryOp(type, item, added) {
        const keyCandidate = type === 'playlist' ? item?.uuid || item?.id : item?.id || item?.trackId;
        if (!keyCandidate) return;

        const key = String(keyCandidate);
        const normalizedItem =
            type === 'playlist'
                ? { ...item, uuid: item?.uuid || key, id: item?.id || key }
                : { ...item, id: item?.id || key };

        const op = {
            type,
            key,
            added: !!added,
            item: this._minifyItem(type, normalizedItem),
            ts: Date.now(),
        };

        const existing = this._loadPendingLibraryOps();
        const filtered = existing.filter((entry) => !(entry?.type === type && String(entry?.key || '') === key));
        filtered.push(op);
        this._savePendingLibraryOps(filtered);
    },

    async _flushPendingLibraryOps() {
        if (!authManager.user) return 0;

        const pending = this._loadPendingLibraryOps();
        if (!pending.length) return 0;

        let applied = 0;
        let failedIndex = -1;

        for (let index = 0; index < pending.length; index++) {
            const entry = pending[index];
            if (!entry?.type || !entry?.item) continue;
            try {
                const ok = await this.syncLibraryItem(entry.type, entry.item, !!entry.added, {
                    skipQueueOnError: true,
                });
                if (ok) {
                    applied++;
                } else {
                    failedIndex = index;
                    break;
                }
            } catch {
                failedIndex = index;
                break;
            }
        }

        const remaining = failedIndex === -1 ? [] : pending.slice(failedIndex);
        this._savePendingLibraryOps(remaining);

        if (applied > 0) {
            console.log(`[Appwrite Sync] Flushed ${applied} pending library sync operation(s)`);
        }

        return applied;
    },

    _safeParseJSON(value, fallback) {
        if (value === null || value === undefined || value === '') return fallback;
        if (typeof value !== 'string') return value;
        try {
            return JSON.parse(value);
        } catch {
            return fallback;
        }
    },

    _safeObject(value, fallback = {}) {
        const parsed = this._safeParseJSON(value, fallback);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
        return parsed;
    },

    _safeArray(value, fallback = []) {
        const parsed = this._safeParseJSON(value, fallback);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === 'object') return Object.values(parsed);
        return fallback;
    },

    _truncateHistoryToFit(historyArray) {
        const normalizedHistory = Array.isArray(historyArray) ? historyArray : [];
        const serializedFull = JSON.stringify(normalizedHistory);

        if (serializedFull.length <= MAX_HISTORY_STRING_LENGTH) {
            return serializedFull;
        }

        // Keep the most recent entries when we hit limit.
        const reversed = [...normalizedHistory].reverse();
        const selected = [];
        let currentLength = 2; // []

        for (const item of reversed) {
            const itemSerialized = JSON.stringify(item);
            const itemTokenLength = itemSerialized.length + (selected.length > 0 ? 1 : 0);

            if (currentLength + itemTokenLength > MAX_HISTORY_STRING_LENGTH) {
                break;
            }

            selected.unshift(item);
            currentLength += itemTokenLength;
        }

        return JSON.stringify(selected);
    },

    _buildHistorySyncPayload(history) {
        const normalizedHistory = Array.isArray(history) ? history : [];
        const { direct, chunks } = this._splitHistoryChunks(normalizedHistory);

        if (!this._chunkedHistorySupported || chunks.length === 0) {
            return {
                history: this._chunkedHistorySupported
                    ? JSON.stringify(direct)
                    : this._truncateHistoryToFit(normalizedHistory),
            };
        }

        const firstChunk = chunks[0] || [];
        const overflowChunks = chunks.slice(1);

        const payload = {
            history: JSON.stringify(firstChunk),
            history_chunk_count: overflowChunks.length,
        };

        overflowChunks.forEach((chunk, index) => {
            payload[`history_chunk_${index}`] = JSON.stringify(chunk);
        });

        return payload;
    },

    _collectHistoryFromRecord(record) {
        if (!record || typeof record !== 'object') return [];

        let history = this._safeArray(record.history, []);
        const rawChunkCount = record.history_chunk_count;
        const chunkCount = Number.isFinite(Number(rawChunkCount)) ? Number(rawChunkCount) : 0;

        if (chunkCount > 0) {
            for (let i = 0; i < chunkCount; i++) {
                history = history.concat(this._safeArray(record[`history_chunk_${i}`], []));
            }
            return history;
        }

        // Backward compatibility: if no explicit chunk count was present,
        // pick legacy chunk fields (e.g. from older versions that used history_chunk_<n> only).
        if (rawChunkCount === undefined || rawChunkCount === null) {
            const backwardChunks = Object.keys(record)
                .filter((key) => /^history_chunk_\d+$/.test(key))
                .sort((a, b) => Number(a.replace('history_chunk_', '')) - Number(b.replace('history_chunk_', '')));

            for (const key of backwardChunks) {
                history = history.concat(this._safeArray(record[key], []));
            }
        }

        return history;
    },

    _splitHistoryChunks(entries) {
        if (!Array.isArray(entries)) return { direct: [], chunks: [] };

        const serialized = JSON.stringify(entries);
        if (serialized.length <= MAX_HISTORY_STRING_LENGTH) {
            return { direct: entries, chunks: [] };
        }

        const chunks = [];
        let chunk = [];
        let chunkSize = 0;

        for (const item of entries) {
            const itemStr = JSON.stringify(item);
            const itemSize = itemStr.length;
            if (chunkSize + itemSize > MAX_HISTORY_CHUNK_SIZE && chunk.length > 0) {
                chunks.push(chunk);
                chunk = [];
                chunkSize = 0;
            }

            chunk.push(item);
            chunkSize += itemSize;
        }

        if (chunk.length > 0) {
            chunks.push(chunk);
        }

        return { direct: [], chunks };
    },

    _normalizeFavoriteAlbums(value) {
        const albums = this._safeArray(value, []);
        return albums
            .filter((album) => album && typeof album === 'object')
            .map((album) => ({
                id: album.id,
                title: album.title || '',
                artist: album.artist?.name || album.artist || 'Unknown Artist',
                cover: album.cover || album.album?.cover || null,
                description: album.description || '',
            }))
            .filter((album) => album.id);
    },

    _mapProfileRecord(record) {
        if (!record) return null;
        return {
            ...record,
            privacy: this._safeObject(record.privacy, DEFAULT_PRIVACY),
            user_playlists: this._safeObject(record.user_playlists, {}),
            statistics_summary: this._safeObject(record.statistics_summary, {}),
            favorite_albums: this._normalizeFavoriteAlbums(record.favorite_albums),
        };
    },

    _getConversationId(userA, userB) {
        return [String(userA), String(userB)].sort().join('__');
    },

    _mapChatMessage(doc) {
        return {
            id: doc.$id,
            conversationId: doc.conversation_id,
            senderId: doc.sender_id,
            senderUsername: doc.sender_username,
            senderDisplayName: doc.sender_display_name || doc.sender_username || 'User',
            senderAvatar: doc.sender_avatar || '',
            receiverId: doc.receiver_id,
            receiverUsername: doc.receiver_username,
            message: doc.message || '',
            trackPayload: this._safeParseJSON(doc.track_payload, null),
            read: !!doc.read,
            createdAt: doc.created_at || Date.now(),
        };
    },

    _didCloudSyncPayloadChange(previousRecord, nextRecord) {
        if (!nextRecord) return false;
        if (!previousRecord) return true;

        const keys = ['library', 'history', 'user_playlists', 'user_folders', 'favorite_albums', 'statistics_summary'];
        if (this._chunkedHistorySupported) {
            keys.push('history_chunk_count');
        }

        return keys.some((key) => String(previousRecord[key] ?? '') !== String(nextRecord[key] ?? ''));
    },

    _getCurrentMonthKey() {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    },

    _historyDurationSeconds(track) {
        if (!track || typeof track !== 'object') return 0;
        const raw = Number(track.duration ?? track.durationSec ?? track.length ?? 0);
        if (!Number.isFinite(raw) || raw <= 0) return 0;
        return raw > 10000 ? raw / 1000 : raw;
    },

    _historyArtists(track) {
        if (!track || typeof track !== 'object') return [];

        if (Array.isArray(track.artists)) {
            return track.artists
                .map((artist) => ({
                    id: artist?.id ?? null,
                    name: String(artist?.name || artist || '').trim(),
                }))
                .filter((artist) => artist.name);
        }

        const single = String(track.artist?.name || track.artist || '').trim();
        return single ? [{ id: track.artist?.id ?? null, name: single }] : [];
    },

    _historyTrackKey(track, artists = []) {
        if (!track || typeof track !== 'object') return null;
        if (track.id != null) return `id:${track.id}`;
        if (track.trackId != null) return `trackId:${track.trackId}`;
        if (track.isrc) return `isrc:${String(track.isrc).toLowerCase()}`;

        const title = String(track.title || '')
            .trim()
            .toLowerCase();
        const artistKey = artists.map((artist) => artist.name.toLowerCase()).join(',');
        if (!title && !artistKey) return null;
        return `meta:${title}::${artistKey}`;
    },

    _buildStatisticsSummary(history = []) {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();

        const monthTracks = (Array.isArray(history) ? history : []).filter((entry) => {
            const timestamp = Number(entry?.timestamp || 0);
            return Number.isFinite(timestamp) && timestamp >= monthStart && timestamp < monthEnd;
        });

        const topArtists = new Map();
        const topTracks = new Map();
        let totalSeconds = 0;

        monthTracks.forEach((track) => {
            const seconds = this._historyDurationSeconds(track);
            totalSeconds += seconds;

            const artists = this._historyArtists(track);
            artists.forEach((artist) => {
                const key = artist.id ? `id:${artist.id}` : `name:${artist.name.toLowerCase()}`;
                const existing = topArtists.get(key) || { name: artist.name, plays: 0, seconds: 0 };
                existing.plays += 1;
                existing.seconds += seconds;
                topArtists.set(key, existing);
            });

            const trackKey = this._historyTrackKey(track, artists);
            if (!trackKey) return;

            const existingTrack = topTracks.get(trackKey) || {
                title: track.title || 'Unknown Track',
                artistText:
                    artists.map((artist) => artist.name).join(', ') ||
                    String(track.artist?.name || track.artist || '').trim() ||
                    'Unknown Artist',
                plays: 0,
                seconds: 0,
            };
            existingTrack.plays += 1;
            existingTrack.seconds += seconds;
            topTracks.set(trackKey, existingTrack);
        });

        const toSorted = (items) =>
            Array.from(items.values())
                .sort((a, b) => {
                    if (b.plays !== a.plays) return b.plays - a.plays;
                    return b.seconds - a.seconds;
                })
                .slice(0, 5);

        return {
            monthKey: this._getCurrentMonthKey(),
            totalSeconds: Math.max(0, Math.round(totalSeconds)),
            totalPlays: monthTracks.length,
            uniqueArtists: topArtists.size,
            topArtists: toSorted(topArtists),
            topTracks: toSorted(topTracks),
            updatedAt: Date.now(),
        };
    },

    async syncListeningStats(historyOverride = null) {
        if (!authManager.user) return null;

        try {
            const record = await this._getUserRecord();
            if (!record) return null;

            const history = Array.isArray(historyOverride) ? historyOverride : this._safeArray(record.history, []);
            const summary = this._buildStatisticsSummary(history);
            const existing = this._safeObject(record.statistics_summary, {});

            const currentSignature = JSON.stringify({
                monthKey: summary.monthKey,
                totalSeconds: summary.totalSeconds,
                totalPlays: summary.totalPlays,
                uniqueArtists: summary.uniqueArtists,
                topArtists: summary.topArtists,
                topTracks: summary.topTracks,
            });
            const existingSignature = JSON.stringify({
                monthKey: existing.monthKey,
                totalSeconds: Number(existing.totalSeconds || 0),
                totalPlays: Number(existing.totalPlays || 0),
                uniqueArtists: Number(existing.uniqueArtists || 0),
                topArtists: Array.isArray(existing.topArtists) ? existing.topArtists : [],
                topTracks: Array.isArray(existing.topTracks) ? existing.topTracks : [],
            });

            if (currentSignature === existingSignature) {
                return summary;
            }

            await this._updateUserJSON(null, 'statistics_summary', summary);
            return summary;
        } catch (error) {
            console.warn('[Appwrite Sync] Failed to sync listening statistics:', error);
            return null;
        }
    },

    _getPlaylistCoverCollage(tracks = []) {
        const uniqueCovers = [];
        const seen = new Set();
        for (const track of tracks) {
            const cover = track?.album?.cover;
            if (!cover || seen.has(cover)) continue;
            seen.add(cover);
            uniqueCovers.push(cover);
            if (uniqueCovers.length >= 4) break;
        }
        return uniqueCovers;
    },

    _serializePlaylistTrackChunk(items = [], chunkIndex = 0, chunkTotal = 1, totalTracks = 0) {
        return JSON.stringify({
            chunkVersion: 1,
            chunkIndex,
            chunkTotal,
            totalTracks,
            items,
        });
    },

    _parsePlaylistTrackChunk(rawValue) {
        const parsed = this._safeParseJSON(rawValue, []);
        if (Array.isArray(parsed)) {
            const tracks = parsed.filter((track) => track && typeof track === 'object');
            return {
                tracks,
                chunkIndex: 0,
                chunkTotal: 1,
                totalTracks: tracks.length,
            };
        }

        if (!parsed || typeof parsed !== 'object') {
            return {
                tracks: [],
                chunkIndex: 0,
                chunkTotal: 1,
                totalTracks: 0,
            };
        }

        const chunkTracks = (
            Array.isArray(parsed.items) ? parsed.items : Array.isArray(parsed.tracks) ? parsed.tracks : []
        ).filter((track) => track && typeof track === 'object');
        const chunkIndex = Number(parsed.chunkIndex);
        const chunkTotal = Number(parsed.chunkTotal);
        const totalTracks = Number(parsed.totalTracks);

        return {
            tracks: chunkTracks,
            chunkIndex: Number.isFinite(chunkIndex) && chunkIndex >= 0 ? Math.floor(chunkIndex) : 0,
            chunkTotal: Number.isFinite(chunkTotal) && chunkTotal > 0 ? Math.floor(chunkTotal) : 1,
            totalTracks:
                Number.isFinite(totalTracks) && totalTracks >= 0 ? Math.floor(totalTracks) : chunkTracks.length,
        };
    },

    _mapPublicPlaylistDoc(doc) {
        const parsedChunk = this._parsePlaylistTrackChunk(doc?.tracks);
        const tracks = parsedChunk.tracks;
        const rawTrackCount = Number(doc?.numberOfTracks ?? doc?.number_of_tracks);
        const numberOfTracksBase =
            Number.isFinite(rawTrackCount) && rawTrackCount > 0
                ? Math.max(rawTrackCount, parsedChunk.totalTracks, tracks.length)
                : Math.max(parsedChunk.totalTracks, tracks.length);
        const createdAt = doc?.$createdAt ? Date.parse(doc.$createdAt) : Date.now();
        const updatedAt = doc?.$updatedAt ? Date.parse(doc.$updatedAt) : Date.now();
        return {
            id: doc?.id,
            owner_id: doc?.owner_id || '',
            name: doc?.name || 'Untitled Playlist',
            title: doc?.name || 'Untitled Playlist',
            description: doc?.description || '',
            cover: doc?.cover || '',
            tracks,
            numberOfTracks: numberOfTracksBase,
            totalTracks: numberOfTracksBase,
            chunkIndex: parsedChunk.chunkIndex,
            chunkTotal: parsedChunk.chunkTotal,
            images: this._getPlaylistCoverCollage(tracks),
            createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
            updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
            isPublic: doc?.is_public !== false,
        };
    },

    _mergePublicPlaylistDocs(documents = [], { isPublicFallback = true } = {}) {
        const mappedDocs = (Array.isArray(documents) ? documents : [])
            .map((doc) => this._mapPublicPlaylistDoc(doc))
            .filter((doc) => doc?.id);
        if (!mappedDocs.length) return null;

        const byChunkIndex = new Map();
        mappedDocs.forEach((doc) => {
            const index = Number.isFinite(doc.chunkIndex) && doc.chunkIndex >= 0 ? doc.chunkIndex : byChunkIndex.size;
            const existing = byChunkIndex.get(index);
            if (!existing || (doc.updatedAt || 0) >= (existing.updatedAt || 0)) {
                byChunkIndex.set(index, doc);
            }
        });

        const orderedChunks = Array.from(byChunkIndex.values()).sort((a, b) => {
            if (a.chunkIndex !== b.chunkIndex) {
                return a.chunkIndex - b.chunkIndex;
            }
            return (a.updatedAt || 0) - (b.updatedAt || 0);
        });

        const base = orderedChunks.find((chunk) => chunk.chunkIndex === 0) || orderedChunks[orderedChunks.length - 1];
        const tracks = orderedChunks.flatMap((chunk) =>
            this._safeArray(chunk.tracks, []).filter((track) => track && typeof track === 'object')
        );
        const numberOfTracks = Math.max(
            Number(base?.numberOfTracks) || 0,
            ...orderedChunks.map((chunk) => Number(chunk.totalTracks) || 0),
            tracks.length
        );

        return {
            ...base,
            tracks,
            numberOfTracks,
            totalTracks: numberOfTracks,
            chunkIndex: 0,
            chunkTotal: orderedChunks.length,
            images: this._getPlaylistCoverCollage(tracks),
            isPublic: typeof base?.isPublic === 'boolean' ? base.isPublic : !!isPublicFallback,
        };
    },

    _mergePublicPlaylistDocuments(documents = [], { isPublicFallback = true } = {}) {
        const grouped = new Map();
        (Array.isArray(documents) ? documents : []).forEach((doc) => {
            const playlistId = String(doc?.id || '').trim();
            if (!playlistId) return;
            if (!grouped.has(playlistId)) {
                grouped.set(playlistId, []);
            }
            grouped.get(playlistId).push(doc);
        });

        return Array.from(grouped.values())
            .map((group) => this._mergePublicPlaylistDocs(group, { isPublicFallback }))
            .filter((playlist) => playlist?.id);
    },

    _mapCollaborativePlaylistDoc(doc) {
        const tracks = this._safeArray(doc?.tracks, []).filter((track) => track && typeof track === 'object');
        const parsedMembers = this._safeArray(doc?.members, [])
            .map((memberId) => String(memberId || '').trim())
            .filter(Boolean);
        const ownerId = String(doc?.owner_id || parsedMembers[0] || '').trim();
        const members = Array.from(new Set([ownerId, ...parsedMembers].filter(Boolean)));
        const createdAtRaw = Number(doc?.created_at);
        const updatedAtRaw = Number(doc?.updated_at);
        const fallbackCreatedAt = doc?.$createdAt ? Date.parse(doc.$createdAt) : Date.now();
        const fallbackUpdatedAt = doc?.$updatedAt ? Date.parse(doc.$updatedAt) : Date.now();

        return {
            id: doc?.id || doc?.$id,
            name: doc?.name || 'Untitled Collaborative Playlist',
            description: doc?.description || '',
            cover: doc?.cover || '',
            tracks,
            members,
            owner: ownerId,
            createdAt: Number.isFinite(createdAtRaw) ? createdAtRaw : fallbackCreatedAt,
            updatedAt: Number.isFinite(updatedAtRaw) ? updatedAtRaw : fallbackUpdatedAt,
            isCollaborative: true,
        };
    },

    _playlistSyncSignature(playlist) {
        if (!playlist) return '';
        return JSON.stringify({
            id: playlist.id,
            name: playlist.name || '',
            description: playlist.description || '',
            cover: playlist.cover || '',
            numberOfTracks: playlist.numberOfTracks || 0,
            tracks: playlist.tracks || [],
            isPublic: !!playlist.isPublic,
        });
    },

    _collaborativePlaylistSyncSignature(playlist) {
        if (!playlist) return '';
        return JSON.stringify({
            id: playlist.id,
            name: playlist.name || '',
            description: playlist.description || '',
            cover: playlist.cover || '',
            tracks: playlist.tracks || [],
            members: playlist.members || [],
            owner: playlist.owner || '',
            updatedAt: playlist.updatedAt || 0,
            isCollaborative: !!playlist.isCollaborative,
        });
    },

    _minifyPublicPlaylistTrack(track) {
        if (!track || typeof track !== 'object') return null;

        const toArtistRef = (artist) => {
            if (!artist || typeof artist !== 'object') return null;
            const id = artist.id ?? null;
            const name = artist.name || null;
            if (!id && !name) return null;
            return { id, name };
        };

        const primaryArtist = toArtistRef(track.artist) || toArtistRef(track.artists?.[0]);
        const artists = Array.isArray(track.artists)
            ? track.artists.map((artist) => toArtistRef(artist)).filter(Boolean)
            : primaryArtist
              ? [primaryArtist]
              : [];

        return {
            id: track.id ?? null,
            title: track.title || null,
            duration: Number.isFinite(track.duration) ? track.duration : null,
            explicit: !!track.explicit,
            addedAt: Number.isFinite(Number(track.addedAt)) ? Number(track.addedAt) : null,
            addedById: track.addedById ? String(track.addedById) : null,
            addedByName: track.addedByName ? String(track.addedByName) : null,
            artist: primaryArtist,
            artists,
            album: track.album
                ? {
                      id: track.album.id ?? null,
                      title: track.album.title || null,
                      cover: track.album.cover || null,
                      artist: toArtistRef(track.album.artist),
                  }
                : null,
            trackNumber: track.trackNumber || null,
        };
    },

    _serializePublicPlaylistTracks(tracks = []) {
        const normalized = (Array.isArray(tracks) ? tracks : [])
            .map((track) => this._minifyPublicPlaylistTrack(track))
            .filter((track) => track?.id);

        const chunks = this._chunkPlaylistTracksForCloud(normalized, {
            maxTracksPerChunk: MAX_PUBLIC_PLAYLIST_TRACKS,
            maxPayloadChars: MAX_PUBLIC_PLAYLIST_TRACKS_PAYLOAD_CHARS,
        });
        const kept = chunks.reduce((total, chunk) => total + (chunk.tracksCount || 0), 0);
        return { chunks, kept, total: normalized.length };
    },

    _chunkPlaylistTracksForCloud(tracks = [], { maxTracksPerChunk = 500, maxPayloadChars = 62000 } = {}) {
        if (!Array.isArray(tracks) || !tracks.length) {
            return [];
        }

        const chunks = [];
        let cursor = 0;

        while (cursor < tracks.length) {
            let lower = cursor + 1;
            let upper = Math.min(tracks.length, cursor + maxTracksPerChunk);
            let bestEnd = -1;

            while (lower <= upper) {
                const midpoint = Math.floor((lower + upper) / 2);
                const candidateItems = tracks.slice(cursor, midpoint);
                const candidateSerialized = this._serializePlaylistTrackChunk(
                    candidateItems,
                    0,
                    PLAYLIST_TRACK_CHUNK_ESTIMATE_TOTAL,
                    tracks.length
                );

                if (candidateSerialized.length <= maxPayloadChars) {
                    bestEnd = midpoint;
                    lower = midpoint + 1;
                } else {
                    upper = midpoint - 1;
                }
            }

            if (bestEnd === -1) {
                const problematicTrack = tracks[cursor];
                console.warn(
                    `[Appwrite Sync] Skipping oversized playlist track payload for track "${problematicTrack?.id || 'unknown'}".`
                );
                cursor += 1;
                continue;
            }

            chunks.push(tracks.slice(cursor, bestEnd));
            cursor = bestEnd;
        }

        const chunkTotal = chunks.length || 1;
        return chunks.map((items, index) => ({
            chunkIndex: index,
            chunkTotal,
            tracksCount: items.length,
            serialized: this._serializePlaylistTrackChunk(items, index, chunkTotal, tracks.length),
        }));
    },

    _serializeCollaborativePlaylistTracks(tracks = []) {
        const normalized = (Array.isArray(tracks) ? tracks : [])
            .map((track) => this._minifyPublicPlaylistTrack(track))
            .filter((track) => track?.id);

        if (!normalized.length) {
            return { serialized: '[]', kept: 0, total: 0 };
        }

        let keepCount = Math.min(normalized.length, MAX_COLLAB_PLAYLIST_TRACKS);
        while (keepCount > 0) {
            const serialized = JSON.stringify(normalized.slice(0, keepCount));
            if (serialized.length <= MAX_COLLAB_PLAYLIST_TRACKS_PAYLOAD_CHARS) {
                return { serialized, kept: keepCount, total: normalized.length };
            }

            keepCount = keepCount > 300 ? keepCount - 50 : keepCount > 120 ? keepCount - 25 : keepCount - 10;
        }

        return { serialized: '[]', kept: 0, total: normalized.length };
    },

    async _runBatchedTasks(taskFactories = [], { batchSize = PLAYLIST_SYNC_BATCH_SIZE } = {}) {
        const completed = [];
        for (let start = 0; start < taskFactories.length; start += batchSize) {
            const batch = taskFactories.slice(start, start + batchSize);
            const settled = await Promise.allSettled(batch.map((taskFactory) => taskFactory()));
            const rejected = settled.find((result) => result.status === 'rejected');
            if (rejected) {
                throw rejected.reason;
            }
            settled.forEach((result) => {
                if (result.status === 'fulfilled') {
                    completed.push(result.value);
                }
            });
        }
        return completed;
    },

    _normalizeCollaborativeMembers(members, ownerId = '') {
        const normalizedOwnerId = String(ownerId || '').trim();
        const memberList = (Array.isArray(members) ? members : [])
            .map((memberId) => String(memberId || '').trim())
            .filter(Boolean);
        const uniqueMembers = Array.from(new Set([normalizedOwnerId, ...memberList].filter(Boolean)));
        return {
            ownerId: normalizedOwnerId || uniqueMembers[0] || '',
            members: uniqueMembers,
            serialized: JSON.stringify(uniqueMembers),
        };
    },

    _buildCollaborativePlaylistPermissions(ownerId, _members = []) {
        const permissions = [
            // Client SDK cannot grant per-user permissions for other user IDs.
            Permission.read(Role.users()),
            Permission.update(Role.users()),
        ];

        if (ownerId) {
            permissions.push(Permission.delete(Role.user(ownerId)));
        }

        return Array.from(new Set(permissions));
    },

    async _withRetry(operation, { retries = 2, baseDelay = 450, label = 'Appwrite request' } = {}) {
        let lastError = null;
        for (let attempt = 0; attempt <= retries; attempt += 1) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;
                if (attempt >= retries || !isNetworkError(error)) {
                    throw error;
                }
                const delayMs = baseDelay * Math.pow(2, attempt);
                console.warn(`[Appwrite Sync] ${label} failed, retrying in ${delayMs}ms...`, error);
                await wait(delayMs);
            }
        }
        throw lastError;
    },

    async _getUserRecord(forceRefresh = false) {
        const user = authManager.user;
        if (!user) return null;

        if (!forceRefresh && this._userRecordCache && this._userRecordCache.firebase_id === user.$id) {
            return this._userRecordCache;
        }

        try {
            const response = await this._withRetry(
                () =>
                    databases.listDocuments(DATABASE_ID, USERS_COLLECTION, [
                        Query.equal('firebase_id', user.$id),
                        Query.limit(1),
                    ]),
                { label: 'get user record' }
            );

            if (response.documents.length > 0) {
                this._userRecordCache = response.documents[0];
                return this._userRecordCache;
            }

            const usernameSeed = user.name || user.email?.split('@')[0] || 'user';
            const username =
                usernameSeed
                    .toLowerCase()
                    .replace(/[^a-z0-9_.-]/g, '.')
                    .replace(/\.+/g, '.')
                    .replace(/^\./, '')
                    .replace(/\.$/, '')
                    .slice(0, 40) || 'user';

            const displayName = user.name || user.email?.split('@')[0] || 'User';

            const newRecord = await this._withRetry(
                () =>
                    databases.createDocument(DATABASE_ID, USERS_COLLECTION, ID.unique(), {
                        firebase_id: user.$id,
                        library: '{}',
                        history: '[]',
                        user_playlists: '{}',
                        user_folders: '{}',
                        username,
                        display_name: displayName,
                        avatar_url: user.prefs?.avatar || '',
                        privacy: JSON.stringify(DEFAULT_PRIVACY),
                        favorite_albums: '[]',
                        statistics_summary: '{}',
                    }),
                { label: 'create user record' }
            );

            this._userRecordCache = newRecord;
            return newRecord;
        } catch (error) {
            if (error?.code === 404) {
                console.error(
                    '[Appwrite Sync] Database or collection missing. Run "node scripts/setup-appwrite.js" with APPWRITE_API_KEY.'
                );
            } else {
                console.error('[Appwrite Sync] Failed to get/create user record:', error);
            }
            return null;
        }
    },

    async _updateUserHistory(history) {
        const record = await this._getUserRecord();
        if (!record) return null;

        let payload = this._buildHistorySyncPayload(history);

        try {
            const updated = await this._withRetry(
                () => databases.updateDocument(DATABASE_ID, USERS_COLLECTION, record.$id, payload),
                { label: 'update history' }
            );
            this._userRecordCache = updated;
            return updated;
        } catch (error) {
            const errorMessage = String(error?.message || '').toLowerCase();
            if (
                this._chunkedHistorySupported &&
                (errorMessage.includes('unknown attribute') || errorMessage.includes('unauthorized attribute')) &&
                errorMessage.includes('history_chunk_count')
            ) {
                console.warn(
                    '[Appwrite Sync] Chunked history fields unsupported by this Appwrite schema, falling back to safe history payload.'
                );
                this._chunkedHistorySupported = false;
                payload = this._buildHistorySyncPayload(history);

                try {
                    const fallbackUpdated = await this._withRetry(
                        () => databases.updateDocument(DATABASE_ID, USERS_COLLECTION, record.$id, payload),
                        { label: 'update history (fallback)' }
                    );
                    this._userRecordCache = fallbackUpdated;
                    return fallbackUpdated;
                } catch (fallbackError) {
                    console.error('[Appwrite Sync] Fallback history update failed:', fallbackError);
                    throw fallbackError;
                }
            }

            console.error('[Appwrite Sync] Failed to update chunked history:', error);
            throw error;
        }
    },

    async _updateUserJSON(_uidIgnored, field, data) {
        const record = await this._getUserRecord();
        if (!record) return null;

        if (field === 'history') {
            return this._updateUserHistory(data);
        }

        try {
            const serializedData = typeof data === 'string' ? data : JSON.stringify(data);
            const payload = { [field]: serializedData };
            const updated = await this._withRetry(
                () => databases.updateDocument(DATABASE_ID, USERS_COLLECTION, record.$id, payload),
                { label: `update ${field}` }
            );
            this._userRecordCache = updated;
            return updated;
        } catch (error) {
            console.error(`[Appwrite Sync] Failed to update ${field}:`, error);
            throw error;
        }
    },

    safeParseInternal(str, _fieldName, fallback) {
        return this._safeParseJSON(str, fallback);
    },

    async getUserData() {
        console.log('[Appwrite Sync] Getting user data...');
        const record = await this._getUserRecord();
        if (!record) {
            console.warn('[Appwrite Sync] No user record found in getUserData');
            return null;
        }

        console.log('[Appwrite Sync] User record found:', record.$id, { username: record.username });

        const library = this._safeObject(record.library, {});
        const history = this._collectHistoryFromRecord(record);
        const userPlaylists = this._safeObject(record.user_playlists, {});
        const userFolders = this._safeObject(record.user_folders, {});

        const profile = {
            username: record.username,
            display_name: record.display_name,
            avatar_url: record.avatar_url,
            banner: record.banner,
            status: record.status,
            about: record.about,
            website: record.website,
            privacy: this._safeObject(record.privacy, DEFAULT_PRIVACY),
            lastfm_username: record.lastfm_username,
            favorite_albums: this._normalizeFavoriteAlbums(record.favorite_albums),
            statistics_summary: this._safeObject(record.statistics_summary, {}),
        };

        return { library, history, userPlaylists, userFolders, profile };
    },

    async getProfile(username) {
        if (!username) return null;

        if (this._userRecordCache && this._userRecordCache.username === username) {
            console.log('[Appwrite Sync] Returning cached profile for:', username);
            const profile = this._mapProfileRecord(this._userRecordCache);
            console.log('[Appwrite Sync] Cached profile has', profile.favorite_albums?.length || 0, 'favorite albums');
            return profile;
        }

        console.log('[Appwrite Sync] Fetching profile for:', username);
        try {
            const res = await this._withRetry(
                () =>
                    databases.listDocuments(DATABASE_ID, USERS_COLLECTION, [
                        Query.equal('username', username),
                        Query.limit(1),
                    ]),
                { label: 'fetch profile' }
            );

            if (res.documents.length === 0) {
                console.warn('[Appwrite Sync] No profile found for username:', username);
                return null;
            }

            const record = res.documents[0];
            console.log('[Appwrite Sync] Profile found:', record.$id);
            const profile = this._mapProfileRecord(record);
            console.log('[Appwrite Sync] Fetched profile has', profile.favorite_albums?.length || 0, 'favorite albums');
            return profile;
        } catch (error) {
            console.error('[Appwrite Sync] Failed to fetch profile:', error);
            return null;
        }
    },

    async updateProfile(data) {
        const record = await this._getUserRecord();
        if (!record) return null;

        const updateData = { ...data };
        if (Object.prototype.hasOwnProperty.call(updateData, 'favorite_albums')) {
            const normalizedAlbums = this._normalizeFavoriteAlbums(updateData.favorite_albums);
            console.log('[Appwrite Sync] Normalized favorite albums:', normalizedAlbums.length, 'albums');
            updateData.favorite_albums = JSON.stringify(normalizedAlbums);
        }

        for (const key of Object.keys(updateData)) {
            const value = updateData[key];
            if (value && typeof value === 'object' && key !== 'favorite_albums') {
                updateData[key] = JSON.stringify(value);
            }
        }

        console.log('[Appwrite Sync] Updating profile with data:', Object.keys(updateData));
        try {
            const updated = await this._withRetry(
                () => databases.updateDocument(DATABASE_ID, USERS_COLLECTION, record.$id, updateData),
                { label: 'update profile' }
            );
            this._userRecordCache = updated;
            // Also update _profileCache if it exists to ensure consistency
            if (this._profileCache) {
                this._profileCache = this._mapProfileRecord(updated);
            }
            console.log('[Appwrite Sync] Profile updated successfully');
            return updated;
        } catch (error) {
            console.error('[Appwrite Sync] Failed to update profile:', error);
            throw error;
        }
    },

    async clearCloudData() {
        const record = await this._getUserRecord();
        if (!record) return false;

        try {
            const updated = await databases.updateDocument(DATABASE_ID, USERS_COLLECTION, record.$id, {
                library: '{}',
                history: '[]',
                user_playlists: '{}',
                user_folders: '{}',
                favorite_albums: '[]',
                statistics_summary: '{}',
                status: '',
            });
            this._userRecordCache = updated;

            const user = authManager.user;
            if (user) {
                const published = await databases.listDocuments(DATABASE_ID, PUBLIC_PLAYLISTS_COLLECTION, [
                    Query.equal('owner_id', user.$id),
                    Query.limit(500),
                ]);
                await Promise.allSettled(
                    published.documents.map((doc) =>
                        databases.deleteDocument(DATABASE_ID, PUBLIC_PLAYLISTS_COLLECTION, doc.$id)
                    )
                );

                const collaborative = await databases.listDocuments(DATABASE_ID, COLLABORATIVE_PLAYLISTS_COLLECTION, [
                    Query.equal('owner_id', user.$id),
                    Query.limit(300),
                ]);
                await Promise.allSettled(
                    collaborative.documents.map((doc) =>
                        databases.deleteDocument(DATABASE_ID, COLLABORATIVE_PLAYLISTS_COLLECTION, doc.$id)
                    )
                );
            }

            return true;
        } catch (error) {
            console.error('[Appwrite Sync] Failed to clear cloud data:', error);
            throw error;
        }
    },

    async isUsernameTaken(username) {
        if (!username) return false;
        try {
            const res = await databases.listDocuments(DATABASE_ID, USERS_COLLECTION, [
                Query.equal('username', username.toLowerCase()),
                Query.limit(1),
            ]);
            return res.total > 0;
        } catch {
            return false;
        }
    },

    async searchUsers(query) {
        if (!query) return [];
        console.log('[Appwrite Sync] Searching users for:', query);
        try {
            const res = await databases.listDocuments(DATABASE_ID, USERS_COLLECTION, [
                Query.or([Query.contains('username', query), Query.contains('display_name', query)]),
                Query.limit(15),
            ]);
            return res.documents;
        } catch (error) {
            console.error('[Appwrite Sync] User search failed:', error);
            return [];
        }
    },

    async getCommunityStats() {
        try {
            const [userCount, activeUsers] = await Promise.all([
                databases.listDocuments(DATABASE_ID, USERS_COLLECTION, [Query.limit(1)]),
                databases.listDocuments(DATABASE_ID, USERS_COLLECTION, [
                    Query.notEqual('status', ''),
                    Query.limit(500),
                ]),
            ]);

            const now = Date.now();
            const onlineUsers = (activeUsers.documents || []).filter((record) => {
                try {
                    const status = JSON.parse(record.status || '{}');
                    return Number(status.expiresAt) > now && status.state !== 'stopped';
                } catch {
                    return false;
                }
            }).length;

            return {
                totalUsers: Number(userCount.total) || 0,
                onlineUsers,
            };
        } catch (error) {
            console.warn('[Appwrite Sync] Failed to load community stats:', error?.message || error);
            return null;
        }
    },

    _minifyItem(type, item) {
        if (!item) return item;
        const base = {
            id: item.id,
            addedAt: item.addedAt || Date.now(),
        };

        if (type === 'track') {
            const artists =
                item.artists?.map((artist) => ({
                    id: artist?.id,
                    name: artist?.name || null,
                })) || (item.artist ? [{ id: item.artist.id, name: item.artist.name || null }] : []);

            return {
                ...base,
                title: item.title || null,
                duration: item.duration || null,
                explicit: !!item.explicit,
                artist: item.artist || artists[0] || null,
                artists,
                album: item.album
                    ? {
                          id: item.album.id,
                          title: item.album.title || null,
                          cover: item.album.cover || null,
                          releaseDate: item.album.releaseDate || null,
                          artist: item.album.artist || null,
                      }
                    : null,
                trackNumber: item.trackNumber || null,
                streamStartDate: item.streamStartDate || null,
                version: item.version || null,
                mixes: item.mixes || null,
                isTracker: !!item.isTracker || String(item.id || '').startsWith('tracker-'),
                trackerInfo: item.trackerInfo || null,
            };
        }

        if (type === 'album') {
            return {
                ...base,
                title: item.title || null,
                cover: item.cover || null,
                releaseDate: item.releaseDate || null,
                explicit: !!item.explicit,
                artist: item.artist || item.artists?.[0] || null,
                numberOfTracks: item.numberOfTracks || null,
                type: item.type || null,
            };
        }

        if (type === 'artist') {
            return {
                ...base,
                name: item.name || null,
                picture: item.picture || item.image || null,
            };
        }

        if (type === 'playlist') {
            const resolvedImage =
                item.image ||
                item.squareImage ||
                item.cover ||
                item.picture ||
                item.imageUrl ||
                item.images?.LARGE?.url ||
                item.images?.MEDIUM?.url ||
                item.images?.SMALL?.url ||
                null;

            return {
                uuid: item.uuid || item.id,
                addedAt: item.addedAt || item.createdAt || Date.now(),
                title: item.title || item.name || null,
                image: resolvedImage,
                squareImage: item.squareImage || resolvedImage,
                cover: item.cover || resolvedImage,
                numberOfTracks: item.numberOfTracks || item.tracks?.length || 0,
            };
        }

        if (type === 'mix') {
            return {
                ...base,
                title: item.title || null,
                subTitle: item.subTitle || null,
                cover: item.cover || null,
                mixType: item.mixType || null,
            };
        }

        return base;
    },

    async syncLibraryItem(type, item, added, options = {}) {
        const record = await this._getUserRecord();
        if (!record || !item) return false;

        const library = this._safeObject(record.library, {});
        const pluralType = type === 'mix' ? 'mixes' : `${type}s`;
        const key =
            type === 'playlist'
                ? item.uuid || item.id
                : type === 'track'
                  ? item.id || item.trackId || item.uuid || item.isrc
                  : type === 'album'
                    ? item.id || item.albumId || item.uuid
                    : type === 'artist'
                      ? item.id || item.artistId || item.uuid
                      : type === 'mix'
                        ? item.id || item.mixId || item.uuid
                        : item.id || item.uuid;
        if (!key) return false;

        if (!library[pluralType] || typeof library[pluralType] !== 'object') {
            library[pluralType] = {};
        }

        if (added) {
            library[pluralType][key] = this._minifyItem(type, item);
        } else {
            delete library[pluralType][key];
        }

        try {
            await this._updateUserJSON(null, 'library', library);
            return true;
        } catch {
            if (!options.skipQueueOnError) {
                this._enqueuePendingLibraryOp(type, item, added);
            }
            return false;
        }
    },

    async syncHistoryItem(historyEntry) {
        if (!authManager.user || !historyEntry) return;

        try {
            const record = await this._getUserRecord();
            if (!record) return;

            const history = this._safeArray(record.history, []);
            const minified = this._minifyItem('track', historyEntry);
            minified.timestamp = historyEntry.timestamp || Date.now();

            // Allow repeated plays of the same track by preserving entries with different timestamps.
            // Only deduplicate exactly same timestamp entries to prevent accidental duplicates from retry loops.
            const nextHistory = history.filter((entry) => entry.timestamp !== minified.timestamp);
            nextHistory.unshift(minified);
            nextHistory.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

            await this._updateUserHistory(nextHistory);
            await this.syncListeningStats(nextHistory);
            window.dispatchEvent(new CustomEvent('history-changed'));
        } catch (error) {
            console.warn('[Appwrite Sync] Failed to sync history item:', error);
        }
    },

    async syncUserPlaylist(playlist, action = 'update') {
        const record = await this._getUserRecord();
        if (!record) return;

        const playlists = this._safeObject(record.user_playlists, {});
        const playlistId = playlist?.id || playlist?.uuid;
        if (!playlistId) return;

        const expectedTrackCount = Array.isArray(playlist?.tracks)
            ? playlist.tracks.length
            : Number(playlist?.numberOfTracks || 0);
        let trackSync = {
            cloudSynced: action === 'delete',
            syncedTrackCount: action === 'delete' ? 0 : expectedTrackCount,
            expectedTrackCount: action === 'delete' ? 0 : expectedTrackCount,
            chunks: action === 'delete' ? 0 : 1,
            isPublic: !!playlist?.isPublic,
            error: null,
        };

        if (action === 'delete') {
            delete playlists[playlistId];
            try {
                await this.unpublishPlaylist(playlistId);
            } catch (error) {
                trackSync = {
                    ...trackSync,
                    cloudSynced: false,
                    error: String(error?.message || 'Failed to delete playlist from cloud'),
                };
            }
        } else if (playlist.isPublic) {
            playlists[playlistId] = {
                id: playlistId,
                name: playlist.name || playlist.title || 'Untitled Playlist',
                description: playlist.description || '',
                cover: playlist.cover || null,
                numberOfTracks: playlist.tracks?.length || playlist.numberOfTracks || 0,
                isPublic: true,
            };
            try {
                trackSync = await this.publishPlaylist(playlist);
            } catch (error) {
                trackSync = {
                    ...trackSync,
                    cloudSynced: false,
                    syncedTrackCount: 0,
                    error: String(error?.message || 'Failed to publish playlist to cloud'),
                };
            }
        } else {
            playlists[playlistId] = {
                id: playlistId,
                name: playlist.name || playlist.title || 'Untitled Playlist',
                description: playlist.description || '',
                cover: playlist.cover || null,
                numberOfTracks: playlist.tracks?.length || playlist.numberOfTracks || 0,
                isPublic: false,
            };
            try {
                trackSync = await this.syncPrivatePlaylist(playlist);
            } catch (error) {
                trackSync = {
                    ...trackSync,
                    cloudSynced: false,
                    syncedTrackCount: 0,
                    error: String(error?.message || 'Failed to sync private playlist to cloud'),
                };
            }
        }

        let metadataSynced = false;
        try {
            await this._updateUserJSON(null, 'user_playlists', playlists);
            window.dispatchEvent(new CustomEvent('library-changed'));
            metadataSynced = true;
        } catch (error) {
            console.warn('[Appwrite Sync] Failed syncing user playlist metadata:', error);
        }

        return {
            playlistId,
            metadataSynced,
            trackSync,
        };
    },

    async syncUserFolder(folder, action = 'update') {
        const record = await this._getUserRecord();
        if (!record) return;

        const folders = this._safeObject(record.user_folders, {});
        const folderId = folder?.id;
        if (!folderId) return;

        if (action === 'delete') {
            delete folders[folderId];
        } else {
            folders[folderId] = {
                id: folderId,
                name: folder.name || 'Folder',
                cover: folder.cover || '',
                playlists: Array.isArray(folder.playlists) ? folder.playlists : [],
                updatedAt: folder.updatedAt || Date.now(),
            };
        }

        try {
            await this._updateUserJSON(null, 'user_folders', folders);
            window.dispatchEvent(new CustomEvent('library-changed'));
        } catch (error) {
            console.warn('[Appwrite Sync] Failed syncing user folder metadata:', error);
        }
    },

    async _listOwnedPlaylistCloudDocs(playlistId) {
        const user = authManager.user;
        if (!user || !playlistId) return [];

        const res = await databases.listDocuments(DATABASE_ID, PUBLIC_PLAYLISTS_COLLECTION, [
            Query.equal('id', playlistId),
            Query.equal('owner_id', user.$id),
            Query.limit(500),
        ]);
        return res.documents || [];
    },

    async _syncPlaylistTrackDocuments(playlist, { isPublic = true } = {}) {
        await authManager.initialized.catch(() => {});
        const user = authManager.user;
        const playlistId = playlist?.id || playlist?.uuid;
        if (!user) {
            throw new Error('You must be signed in to sync playlists.');
        }
        if (!playlistId) {
            throw new Error('Playlist id is missing.');
        }

        const tracksPayload = this._serializePublicPlaylistTracks(playlist.tracks || []);
        if (tracksPayload.kept < tracksPayload.total) {
            console.warn(
                `[Appwrite Sync] Playlist "${playlistId}" cloud payload skipped ${tracksPayload.total - tracksPayload.kept} oversized tracks.`
            );
        }

        const chunks =
            tracksPayload.chunks.length > 0
                ? tracksPayload.chunks
                : [
                      {
                          chunkIndex: 0,
                          chunkTotal: 1,
                          tracksCount: 0,
                          serialized: this._serializePlaylistTrackChunk([], 0, 1, 0),
                      },
                  ];

        const desiredName = playlist.name || playlist.title || 'Untitled Playlist';
        const desiredDescription = playlist.description || '';
        const desiredCover = playlist.cover || '';
        const existingDocs = await this._listOwnedPlaylistCloudDocs(playlistId);
        const matchingVisibilityDocs = existingDocs.filter((doc) => doc?.is_public === isPublic);
        const existingByChunk = new Map();
        matchingVisibilityDocs.forEach((doc) => {
            const parsedChunk = this._parsePlaylistTrackChunk(doc?.tracks);
            const updatedAt = doc?.$updatedAt ? Date.parse(doc.$updatedAt) : 0;
            const existing = existingByChunk.get(parsedChunk.chunkIndex);
            if (!existing || updatedAt >= existing.updatedAt) {
                existingByChunk.set(parsedChunk.chunkIndex, {
                    doc,
                    updatedAt,
                    serialized: this._serializePlaylistTrackChunk(
                        parsedChunk.tracks,
                        parsedChunk.chunkIndex,
                        parsedChunk.chunkTotal,
                        parsedChunk.totalTracks
                    ),
                });
            }
        });

        const isAlreadySynced =
            existingDocs.length === chunks.length &&
            matchingVisibilityDocs.length === chunks.length &&
            existingByChunk.size === chunks.length &&
            chunks.every((chunk) => {
                const existing = existingByChunk.get(chunk.chunkIndex);
                if (!existing) return false;

                return (
                    existing.serialized === chunk.serialized &&
                    String(existing.doc?.id || '') === String(playlistId) &&
                    String(existing.doc?.owner_id || '') === String(user.$id) &&
                    String(existing.doc?.name || '') === String(desiredName) &&
                    String(existing.doc?.description || '') === String(desiredDescription) &&
                    String(existing.doc?.cover || '') === String(desiredCover) &&
                    existing.doc?.is_public === isPublic
                );
            });

        if (isAlreadySynced) {
            return {
                cloudSynced: tracksPayload.kept >= tracksPayload.total,
                syncedTrackCount: tracksPayload.kept,
                expectedTrackCount: tracksPayload.total,
                chunks: chunks.length,
                isPublic,
                error: null,
            };
        }

        if (existingDocs.length) {
            await Promise.allSettled(
                existingDocs.map((doc) => databases.deleteDocument(DATABASE_ID, PUBLIC_PLAYLISTS_COLLECTION, doc.$id))
            );
        }

        const permissions = isPublic
            ? [
                  Permission.read(Role.any()),
                  Permission.update(Role.user(user.$id)),
                  Permission.delete(Role.user(user.$id)),
              ]
            : [
                  Permission.read(Role.user(user.$id)),
                  Permission.update(Role.user(user.$id)),
                  Permission.delete(Role.user(user.$id)),
              ];

        const taskFactories = chunks.map(
            (chunk) => () =>
                this._withRetry(
                    () =>
                        databases.createDocument(
                            DATABASE_ID,
                            PUBLIC_PLAYLISTS_COLLECTION,
                            ID.unique(),
                            {
                                id: playlistId,
                                owner_id: user.$id,
                                name: desiredName,
                                description: desiredDescription,
                                cover: desiredCover,
                                tracks: chunk.serialized,
                                is_public: isPublic,
                            },
                            permissions
                        ),
                    { label: `sync playlist chunk ${chunk.chunkIndex + 1}/${chunks.length}` }
                )
        );

        await this._runBatchedTasks(taskFactories, { batchSize: PLAYLIST_SYNC_BATCH_SIZE });

        return {
            cloudSynced: tracksPayload.kept >= tracksPayload.total,
            syncedTrackCount: tracksPayload.kept,
            expectedTrackCount: tracksPayload.total,
            chunks: chunks.length,
            isPublic,
            error: null,
        };
    },

    async syncPrivatePlaylist(playlist) {
        return this._syncPlaylistTrackDocuments(playlist, { isPublic: false });
    },

    async _findCollaborativePlaylistDoc(playlistId) {
        if (!playlistId) return null;
        const res = await databases.listDocuments(DATABASE_ID, COLLABORATIVE_PLAYLISTS_COLLECTION, [
            Query.equal('id', playlistId),
            Query.limit(1),
        ]);
        return res.documents[0] || null;
    },

    async syncCollaborativePlaylist(playlist, action = 'update') {
        await authManager.initialized.catch(() => {});
        const user = authManager.user;
        const playlistId = playlist?.id;
        if (!user || !playlistId) return null;

        try {
            if (action === 'delete') {
                const existing = await this._findCollaborativePlaylistDoc(playlistId);
                if (!existing) return null;
                return await databases.deleteDocument(DATABASE_ID, COLLABORATIVE_PLAYLISTS_COLLECTION, existing.$id);
            }

            const ownerId = String(playlist?.owner || user.$id || '').trim() || user.$id;
            const memberPayload = this._normalizeCollaborativeMembers(playlist?.members || [], ownerId);
            const tracksPayload = this._serializeCollaborativePlaylistTracks(playlist?.tracks || []);

            if (tracksPayload.kept < tracksPayload.total) {
                console.warn(
                    `[Appwrite Sync] Collaborative playlist "${playlistId}" track list truncated for cloud payload (${tracksPayload.kept}/${tracksPayload.total}).`
                );
            }

            const createdAt = Number(playlist?.createdAt) || Date.now();
            const updatedAt = Number(playlist?.updatedAt) || Date.now();

            const payload = {
                id: playlistId,
                owner_id: ownerId,
                name: playlist?.name || 'Untitled Collaborative Playlist',
                description: playlist?.description || '',
                cover: playlist?.cover || '',
                tracks: tracksPayload.serialized,
                members: memberPayload.serialized,
                created_at: createdAt,
                updated_at: updatedAt,
                is_collaborative: true,
            };

            const permissions = this._buildCollaborativePlaylistPermissions(ownerId, memberPayload.members);
            const existing = await this._findCollaborativePlaylistDoc(playlistId);
            if (existing) {
                return await databases.updateDocument(
                    DATABASE_ID,
                    COLLABORATIVE_PLAYLISTS_COLLECTION,
                    existing.$id,
                    payload,
                    permissions
                );
            }

            return await databases.createDocument(
                DATABASE_ID,
                COLLABORATIVE_PLAYLISTS_COLLECTION,
                ID.unique(),
                payload,
                permissions
            );
        } catch (error) {
            console.warn('[Appwrite Sync] Failed to sync collaborative playlist:', error);
            throw error;
        }
    },

    async publishPlaylist(playlist) {
        await authManager.initialized.catch(() => {});
        const user = authManager.user;
        const playlistId = playlist?.id || playlist?.uuid;
        if (!user) {
            throw new Error('You must be signed in to publish playlists.');
        }
        if (!playlistId) {
            throw new Error('Playlist id is missing.');
        }

        try {
            return await this._syncPlaylistTrackDocuments(playlist, { isPublic: true });
        } catch (error) {
            console.error('[Appwrite Sync] Failed to publish playlist:', error);
            throw error;
        }
    },

    async unpublishPlaylist(playlistId) {
        const user = authManager.user;
        if (!user || !playlistId) return;

        try {
            const res = await databases.listDocuments(DATABASE_ID, PUBLIC_PLAYLISTS_COLLECTION, [
                Query.equal('id', playlistId),
                Query.equal('owner_id', user.$id),
                Query.limit(500),
            ]);

            await Promise.allSettled(
                res.documents.map((doc) => databases.deleteDocument(DATABASE_ID, PUBLIC_PLAYLISTS_COLLECTION, doc.$id))
            );
        } catch (error) {
            if (error?.code !== 404) {
                console.warn('[Appwrite Sync] Failed to unpublish playlist:', error);
            }
        }
    },

    async getPublicPlaylist(playlistId) {
        if (!playlistId) return null;
        try {
            const res = await databases.listDocuments(DATABASE_ID, PUBLIC_PLAYLISTS_COLLECTION, [
                Query.equal('id', playlistId),
                Query.equal('is_public', true),
                Query.limit(500),
            ]);

            if (!res.documents.length) return null;
            const merged = this._mergePublicPlaylistDocs(res.documents, { isPublicFallback: true });
            if (!merged) return null;

            return {
                id: merged.id,
                name: merged.name,
                title: merged.name,
                description: merged.description || '',
                cover: merged.cover || '',
                tracks: merged.tracks || [],
                numberOfTracks: merged.numberOfTracks || 0,
                owner_id: merged.owner_id,
                isPublic: true,
            };
        } catch (error) {
            console.warn('[Appwrite Sync] Failed to fetch public playlist:', error);
            return null;
        }
    },

    async sendFriendRequestToUser(username) {
        const user = authManager.user;
        if (!user) throw new Error('You must be signed in.');

        const cleanUsername = String(username || '')
            .trim()
            .replace(/^@/, '')
            .toLowerCase();

        if (!cleanUsername) throw new Error('Please provide a username.');

        const [currentData, targetProfile] = await Promise.all([this.getUserData(), this.getProfile(cleanUsername)]);
        if (!targetProfile) throw new Error('User not found.');
        if (targetProfile.firebase_id === user.$id) throw new Error('You cannot add yourself.');

        const [aToB, bToA] = await Promise.all([
            databases.listDocuments(DATABASE_ID, FRIEND_REQUESTS_COLLECTION, [
                Query.equal('sender_id', user.$id),
                Query.equal('receiver_id', targetProfile.firebase_id),
                Query.limit(5),
            ]),
            databases.listDocuments(DATABASE_ID, FRIEND_REQUESTS_COLLECTION, [
                Query.equal('sender_id', targetProfile.firebase_id),
                Query.equal('receiver_id', user.$id),
                Query.limit(5),
            ]),
        ]);

        const existing = [...aToB.documents, ...bToA.documents];
        if (existing.some((doc) => doc.status === 'pending')) {
            throw new Error('A pending friend request already exists.');
        }
        if (existing.some((doc) => doc.status === 'accepted')) {
            throw new Error('You are already friends.');
        }

        const myProfile = currentData?.profile || {};
        const now = Date.now();

        await databases.createDocument(
            DATABASE_ID,
            FRIEND_REQUESTS_COLLECTION,
            ID.unique(),
            {
                sender_id: user.$id,
                sender_username: myProfile.username || user.name || user.email || 'user',
                sender_display_name: myProfile.display_name || user.name || myProfile.username || 'User',
                sender_avatar: myProfile.avatar_url || user.prefs?.avatar || '',
                receiver_id: targetProfile.firebase_id,
                receiver_username: targetProfile.username,
                receiver_display_name: targetProfile.display_name || targetProfile.username,
                receiver_avatar: targetProfile.avatar_url || '',
                status: 'pending',
                created_at: now,
                updated_at: now,
            },
            [
                // Client SDK cannot grant per-user document access for another user id.
                Permission.read(Role.users()),
                Permission.update(Role.users()),
                Permission.delete(Role.user(user.$id)),
            ]
        );
    },

    async listIncomingFriendRequests() {
        const user = authManager.user;
        if (!user) return [];

        try {
            const res = await databases.listDocuments(DATABASE_ID, FRIEND_REQUESTS_COLLECTION, [
                Query.equal('receiver_id', user.$id),
                Query.equal('status', 'pending'),
                Query.orderDesc('created_at'),
                Query.limit(100),
            ]);

            return res.documents.map((doc) => ({
                requestId: doc.$id,
                uid: doc.sender_id,
                username: doc.sender_username,
                displayName: doc.sender_display_name || doc.sender_username,
                avatarUrl: doc.sender_avatar || '',
                requestedAt: doc.created_at || Date.now(),
                outgoing: false,
                status: doc.status,
            }));
        } catch (error) {
            console.warn('[Appwrite Sync] Failed to list incoming requests:', error);
            return [];
        }
    },

    async listOutgoingFriendRequests() {
        const user = authManager.user;
        if (!user) return [];

        try {
            const res = await databases.listDocuments(DATABASE_ID, FRIEND_REQUESTS_COLLECTION, [
                Query.equal('sender_id', user.$id),
                Query.equal('status', 'pending'),
                Query.orderDesc('created_at'),
                Query.limit(100),
            ]);

            return res.documents.map((doc) => ({
                requestId: doc.$id,
                uid: doc.receiver_id,
                username: doc.receiver_username,
                displayName: doc.receiver_display_name || doc.receiver_username,
                avatarUrl: doc.receiver_avatar || '',
                requestedAt: doc.created_at || Date.now(),
                outgoing: true,
                status: doc.status,
            }));
        } catch (error) {
            console.warn('[Appwrite Sync] Failed to list outgoing requests:', error);
            return [];
        }
    },

    async listFriends() {
        const user = authManager.user;
        if (!user) return [];

        try {
            const [sent, received] = await Promise.all([
                databases.listDocuments(DATABASE_ID, FRIEND_REQUESTS_COLLECTION, [
                    Query.equal('sender_id', user.$id),
                    Query.equal('status', 'accepted'),
                    Query.limit(500),
                ]),
                databases.listDocuments(DATABASE_ID, FRIEND_REQUESTS_COLLECTION, [
                    Query.equal('receiver_id', user.$id),
                    Query.equal('status', 'accepted'),
                    Query.limit(500),
                ]),
            ]);

            const byUid = new Map();
            sent.documents.forEach((doc) => {
                byUid.set(doc.receiver_id, {
                    uid: doc.receiver_id,
                    username: doc.receiver_username,
                    displayName: doc.receiver_display_name || doc.receiver_username || 'User',
                    avatarUrl: doc.receiver_avatar || '',
                    addedAt: doc.updated_at || doc.created_at || Date.now(),
                });
            });
            received.documents.forEach((doc) => {
                byUid.set(doc.sender_id, {
                    uid: doc.sender_id,
                    username: doc.sender_username,
                    displayName: doc.sender_display_name || doc.sender_username || 'User',
                    avatarUrl: doc.sender_avatar || '',
                    addedAt: doc.updated_at || doc.created_at || Date.now(),
                });
            });

            return Array.from(byUid.values()).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
        } catch (error) {
            console.warn('[Appwrite Sync] Failed to list friends:', error);
            return [];
        }
    },

    async acceptFriendRequest(requestId) {
        const user = authManager.user;
        if (!user || !requestId) return;

        await databases.updateDocument(DATABASE_ID, FRIEND_REQUESTS_COLLECTION, requestId, {
            status: 'accepted',
            updated_at: Date.now(),
        });
    },

    async rejectFriendRequest(requestId) {
        const user = authManager.user;
        if (!user || !requestId) return;

        await databases.updateDocument(DATABASE_ID, FRIEND_REQUESTS_COLLECTION, requestId, {
            status: 'rejected',
            updated_at: Date.now(),
        });
    },

    async cancelFriendRequest(requestId) {
        const user = authManager.user;
        if (!user || !requestId) return;
        await databases.deleteDocument(DATABASE_ID, FRIEND_REQUESTS_COLLECTION, requestId);
    },

    async _getUserByFirebaseId(firebaseId) {
        if (!firebaseId) return null;
        const res = await databases.listDocuments(DATABASE_ID, USERS_COLLECTION, [
            Query.equal('firebase_id', firebaseId),
            Query.limit(1),
        ]);
        return res.documents[0] || null;
    },

    async sendChatMessage({
        toUserId,
        toUsername = '',
        toDisplayName = '',
        toAvatarUrl = '',
        message = '',
        trackPayload = null,
    } = {}) {
        const user = authManager.user;
        if (!user) throw new Error('You must be signed in.');
        if (!toUserId) throw new Error('Recipient is required.');

        const text = String(message || '').trim();
        if (!text && !trackPayload) {
            throw new Error('Cannot send an empty message.');
        }

        const currentData = await this.getUserData();
        const senderProfile = currentData?.profile || {};

        let receiverInfo = {
            username: toUsername,
            display_name: toDisplayName,
            avatar_url: toAvatarUrl,
        };
        if (!receiverInfo.username) {
            const receiverDoc = await this._getUserByFirebaseId(toUserId);
            receiverInfo = receiverDoc || receiverInfo;
        }

        const payload = {
            conversation_id: this._getConversationId(user.$id, toUserId),
            sender_id: user.$id,
            sender_username: senderProfile.username || user.name || user.email || 'user',
            sender_display_name: senderProfile.display_name || user.name || senderProfile.username || 'User',
            sender_avatar: senderProfile.avatar_url || user.prefs?.avatar || '',
            receiver_id: toUserId,
            receiver_username: receiverInfo.username || 'user',
            receiver_display_name: receiverInfo.display_name || receiverInfo.username || 'User',
            receiver_avatar: receiverInfo.avatar_url || '',
            message: text.slice(0, 3000),
            track_payload: trackPayload ? JSON.stringify(trackPayload) : '',
            read: false,
            created_at: Date.now(),
        };

        const created = await databases.createDocument(DATABASE_ID, CHAT_MESSAGES_COLLECTION, ID.unique(), payload, [
            // Client SDK cannot grant per-user document access for another user id.
            Permission.read(Role.users()),
            Permission.update(Role.users()),
            Permission.delete(Role.user(user.$id)),
        ]);
        return this._mapChatMessage(created);
    },

    async listChatMessages(withUserId, { limit = 200, markRead = true } = {}) {
        const user = authManager.user;
        if (!user || !withUserId) return [];

        const cappedLimit = Math.max(1, Math.min(limit, 500));
        const conversationId = this._getConversationId(user.$id, withUserId);
        try {
            const res = await databases.listDocuments(DATABASE_ID, CHAT_MESSAGES_COLLECTION, [
                Query.equal('conversation_id', conversationId),
                Query.orderAsc('created_at'),
                Query.limit(cappedLimit),
            ]);

            const messages = res.documents.map((doc) => this._mapChatMessage(doc));
            if (markRead) {
                await this.markConversationRead(withUserId, messages);
            }
            return messages;
        } catch (error) {
            console.warn('[Appwrite Sync] Failed to list chat messages:', error);
            return [];
        }
    },

    async listChatSummaries() {
        const user = authManager.user;
        if (!user) return [];

        try {
            const [sent, received] = await Promise.all([
                databases.listDocuments(DATABASE_ID, CHAT_MESSAGES_COLLECTION, [
                    Query.equal('sender_id', user.$id),
                    Query.orderDesc('created_at'),
                    Query.limit(300),
                ]),
                databases.listDocuments(DATABASE_ID, CHAT_MESSAGES_COLLECTION, [
                    Query.equal('receiver_id', user.$id),
                    Query.orderDesc('created_at'),
                    Query.limit(300),
                ]),
            ]);

            const byPeer = new Map();
            [...sent.documents, ...received.documents]
                .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
                .forEach((doc) => {
                    const senderIsMe = doc.sender_id === user.$id;
                    const peerId = senderIsMe ? doc.receiver_id : doc.sender_id;
                    const peerUsername = senderIsMe ? doc.receiver_username : doc.sender_username;
                    const peerDisplayName = senderIsMe
                        ? doc.receiver_display_name || doc.receiver_username
                        : doc.sender_display_name || doc.sender_username;
                    const peerAvatar = senderIsMe ? doc.receiver_avatar : doc.sender_avatar;

                    if (!byPeer.has(peerId)) {
                        byPeer.set(peerId, {
                            peerId,
                            username: peerUsername,
                            displayName: peerDisplayName || peerUsername || 'User',
                            avatarUrl: peerAvatar || '',
                            lastMessage: doc.message || (doc.track_payload ? 'Shared a track' : ''),
                            lastMessageAt: doc.created_at || 0,
                            unreadCount: 0,
                        });
                    }

                    const summary = byPeer.get(peerId);
                    if (!senderIsMe && !doc.read) {
                        summary.unreadCount += 1;
                    }
                });

            return Array.from(byPeer.values()).sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
        } catch (error) {
            console.warn('[Appwrite Sync] Failed to list chat summaries:', error);
            return [];
        }
    },

    async markConversationRead(withUserId, existingMessages = null) {
        const user = authManager.user;
        if (!user || !withUserId) return;

        const messages =
            existingMessages && Array.isArray(existingMessages)
                ? existingMessages
                : await this.listChatMessages(withUserId, { markRead: false });

        const unread = messages.filter((msg) => msg.receiverId === user.$id && !msg.read);
        if (!unread.length) return;

        await Promise.allSettled(
            unread.map((msg) => databases.updateDocument(DATABASE_ID, CHAT_MESSAGES_COLLECTION, msg.id, { read: true }))
        );
    },

    async syncCloudPublicPlaylistsToLocal() {
        const user = authManager.user;
        if (!user) return false;

        if (this._publicPlaylistSyncPromise) {
            return this._publicPlaylistSyncPromise;
        }

        this._publicPlaylistSyncPromise = (async () => {
            try {
                const response = await this._withRetry(
                    () =>
                        databases.listDocuments(DATABASE_ID, PUBLIC_PLAYLISTS_COLLECTION, [
                            Query.equal('owner_id', user.$id),
                            Query.equal('is_public', true),
                            Query.limit(500),
                        ]),
                    { label: 'sync cloud public playlists' }
                );

                const cloudPlaylists = this._mergePublicPlaylistDocuments(response.documents, {
                    isPublicFallback: true,
                });

                const dbHandle = await database.open();
                const didChange = await new Promise((resolve, reject) => {
                    const tx = dbHandle.transaction('user_playlists', 'readwrite');
                    const store = tx.objectStore('user_playlists');
                    let changed = false;

                    const allReq = store.getAll();
                    allReq.onsuccess = () => {
                        const existing = allReq.result || [];
                        const existingById = new Map(
                            existing
                                .filter((playlist) => playlist?.id)
                                .map((playlist) => [String(playlist.id), playlist])
                        );
                        const existingPublicById = new Map(
                            existing
                                .filter((playlist) => playlist?.isPublic && playlist?.id)
                                .map((playlist) => [String(playlist.id), playlist])
                        );
                        const incomingById = new Map(cloudPlaylists.map((playlist) => [String(playlist.id), playlist]));

                        existingPublicById.forEach((_playlist, playlistId) => {
                            if (!incomingById.has(playlistId)) {
                                store.delete(playlistId);
                                changed = true;
                            }
                        });

                        cloudPlaylists.forEach((playlist) => {
                            const playlistId = String(playlist.id);
                            const existingPlaylist = existingById.get(playlistId);
                            const existingTracks = this._safeArray(existingPlaylist?.tracks, []);
                            const incomingTracks = this._safeArray(playlist?.tracks, []);

                            const incomingExpectedCount = Number(playlist?.numberOfTracks) || incomingTracks.length;
                            const incomingLikelyTruncated =
                                incomingTracks.length > 0 && incomingExpectedCount > incomingTracks.length;

                            const mergedTracks =
                                incomingLikelyTruncated && existingTracks.length > incomingTracks.length
                                    ? existingTracks
                                    : incomingTracks;
                            const mergedTrackCount = Math.max(
                                Number(existingPlaylist?.numberOfTracks) || 0,
                                incomingExpectedCount,
                                mergedTracks.length
                            );
                            const mergedPlaylist = {
                                ...(existingPlaylist || {}),
                                ...playlist,
                                tracks: mergedTracks,
                                numberOfTracks: mergedTrackCount,
                                isPublic: true,
                            };

                            if (
                                !existingPlaylist ||
                                this._playlistSyncSignature(existingPlaylist) !==
                                    this._playlistSyncSignature(mergedPlaylist)
                            ) {
                                store.put(mergedPlaylist);
                                changed = true;
                            }
                        });
                    };
                    allReq.onerror = () => reject(allReq.error || tx.error);

                    tx.oncomplete = () => resolve(changed);
                    tx.onerror = (event) => reject(event.target.error || tx.error);
                    tx.onabort = (event) => reject(event.target.error || tx.error);
                });

                if (didChange) {
                    window.dispatchEvent(new CustomEvent('library-changed'));
                }

                return didChange;
            } catch (error) {
                console.warn('[Appwrite Sync] Failed to sync cloud public playlists:', error);
                return false;
            } finally {
                this._publicPlaylistSyncPromise = null;
            }
        })();

        return this._publicPlaylistSyncPromise;
    },

    async syncCloudPrivatePlaylistsToLocal() {
        const user = authManager.user;
        if (!user) return false;

        if (this._privatePlaylistSyncPromise) {
            return this._privatePlaylistSyncPromise;
        }

        this._privatePlaylistSyncPromise = (async () => {
            try {
                const response = await this._withRetry(
                    () =>
                        databases.listDocuments(DATABASE_ID, PUBLIC_PLAYLISTS_COLLECTION, [
                            Query.equal('owner_id', user.$id),
                            Query.equal('is_public', false),
                            Query.limit(500),
                        ]),
                    { label: 'sync cloud private playlists' }
                );

                const cloudPlaylists = this._mergePublicPlaylistDocuments(response.documents, {
                    isPublicFallback: false,
                });

                const dbHandle = await database.open();
                const didChange = await new Promise((resolve, reject) => {
                    const tx = dbHandle.transaction('user_playlists', 'readwrite');
                    const store = tx.objectStore('user_playlists');
                    let changed = false;

                    const allReq = store.getAll();
                    allReq.onsuccess = () => {
                        const existing = allReq.result || [];
                        const existingById = new Map(
                            existing
                                .filter((playlist) => playlist?.id)
                                .map((playlist) => [String(playlist.id), playlist])
                        );

                        cloudPlaylists.forEach((playlist) => {
                            const playlistId = String(playlist.id);
                            const existingPlaylist = existingById.get(playlistId);
                            const existingTracks = this._safeArray(existingPlaylist?.tracks, []);
                            const incomingTracks = this._safeArray(playlist?.tracks, []);
                            const incomingExpectedCount = Number(playlist?.numberOfTracks) || incomingTracks.length;
                            const incomingLikelyTruncated =
                                incomingTracks.length > 0 && incomingExpectedCount > incomingTracks.length;

                            const mergedTracks =
                                incomingLikelyTruncated && existingTracks.length > incomingTracks.length
                                    ? existingTracks
                                    : incomingTracks;
                            const mergedTrackCount = Math.max(
                                Number(existingPlaylist?.numberOfTracks) || 0,
                                incomingExpectedCount,
                                mergedTracks.length
                            );
                            const mergedPlaylist = {
                                ...(existingPlaylist || {}),
                                ...playlist,
                                tracks: mergedTracks,
                                numberOfTracks: mergedTrackCount,
                                isPublic: false,
                            };

                            if (
                                !existingPlaylist ||
                                this._playlistSyncSignature(existingPlaylist) !==
                                    this._playlistSyncSignature(mergedPlaylist)
                            ) {
                                store.put(mergedPlaylist);
                                changed = true;
                            }
                        });
                    };
                    allReq.onerror = () => reject(allReq.error || tx.error);

                    tx.oncomplete = () => resolve(changed);
                    tx.onerror = (event) => reject(event.target.error || tx.error);
                    tx.onabort = (event) => reject(event.target.error || tx.error);
                });

                if (didChange) {
                    window.dispatchEvent(new CustomEvent('library-changed'));
                }

                return didChange;
            } catch (error) {
                console.warn('[Appwrite Sync] Failed to sync cloud private playlists:', error);
                return false;
            } finally {
                this._privatePlaylistSyncPromise = null;
            }
        })();

        return this._privatePlaylistSyncPromise;
    },

    async syncCloudCollaborativePlaylistsToLocal() {
        const user = authManager.user;
        if (!user) return false;

        if (this._collaborativePlaylistSyncPromise) {
            return this._collaborativePlaylistSyncPromise;
        }

        this._collaborativePlaylistSyncPromise = (async () => {
            try {
                const response = await this._withRetry(
                    () =>
                        databases.listDocuments(DATABASE_ID, COLLABORATIVE_PLAYLISTS_COLLECTION, [
                            Query.equal('is_collaborative', true),
                            Query.or([
                                Query.equal('owner_id', user.$id),
                                Query.contains('members', user.$id),
                                Query.contains('members', `"${user.$id}"`),
                            ]),
                            Query.limit(500),
                        ]),
                    { label: 'sync cloud collaborative playlists' }
                );

                const cloudPlaylists = response.documents
                    .map((doc) => this._mapCollaborativePlaylistDoc(doc))
                    .filter((playlist) => playlist.id);

                const dbHandle = await database.open();
                const didChange = await new Promise((resolve, reject) => {
                    const tx = dbHandle.transaction('collaborative_playlists', 'readwrite');
                    const store = tx.objectStore('collaborative_playlists');
                    let changed = false;

                    const allReq = store.getAll();
                    allReq.onsuccess = () => {
                        const existing = allReq.result || [];
                        const existingById = new Map(
                            existing
                                .filter((playlist) => playlist?.id)
                                .map((playlist) => [String(playlist.id), playlist])
                        );

                        cloudPlaylists.forEach((playlist) => {
                            const existingPlaylist = existingById.get(String(playlist.id));
                            const mergedPlaylist = {
                                ...(existingPlaylist || {}),
                                ...playlist,
                                isCollaborative: true,
                            };

                            if (
                                !existingPlaylist ||
                                this._collaborativePlaylistSyncSignature(existingPlaylist) !==
                                    this._collaborativePlaylistSyncSignature(mergedPlaylist)
                            ) {
                                store.put(mergedPlaylist);
                                changed = true;
                            }
                        });
                    };
                    allReq.onerror = () => reject(allReq.error || tx.error);

                    tx.oncomplete = () => resolve(changed);
                    tx.onerror = (event) => reject(event.target.error || tx.error);
                    tx.onabort = (event) => reject(event.target.error || tx.error);
                });

                if (didChange) {
                    window.dispatchEvent(new CustomEvent('library-changed'));
                }

                return didChange;
            } catch (error) {
                console.warn('[Appwrite Sync] Failed to sync cloud collaborative playlists:', error);
                return false;
            } finally {
                this._collaborativePlaylistSyncPromise = null;
            }
        })();

        return this._collaborativePlaylistSyncPromise;
    },

    _scheduleCloudPublicPlaylistSync(delayMs = 700) {
        if (this._publicPlaylistSyncTimeoutId) {
            clearTimeout(this._publicPlaylistSyncTimeoutId);
        }

        this._publicPlaylistSyncTimeoutId = setTimeout(() => {
            this._publicPlaylistSyncTimeoutId = null;
            this.syncCloudPublicPlaylistsToLocal().catch((error) => {
                console.warn('[Appwrite Sync] Delayed public playlist sync failed:', error);
            });
        }, delayMs);
    },

    _scheduleCloudPrivatePlaylistSync(delayMs = 700) {
        if (this._privatePlaylistSyncTimeoutId) {
            clearTimeout(this._privatePlaylistSyncTimeoutId);
        }

        this._privatePlaylistSyncTimeoutId = setTimeout(() => {
            this._privatePlaylistSyncTimeoutId = null;
            this.syncCloudPrivatePlaylistsToLocal().catch((error) => {
                console.warn('[Appwrite Sync] Delayed private playlist sync failed:', error);
            });
        }, delayMs);
    },

    _scheduleCloudCollaborativePlaylistSync(delayMs = 700) {
        if (this._collaborativePlaylistSyncTimeoutId) {
            clearTimeout(this._collaborativePlaylistSyncTimeoutId);
        }

        this._collaborativePlaylistSyncTimeoutId = setTimeout(() => {
            this._collaborativePlaylistSyncTimeoutId = null;
            this.syncCloudCollaborativePlaylistsToLocal().catch((error) => {
                console.warn('[Appwrite Sync] Delayed collaborative playlist sync failed:', error);
            });
        }, delayMs);
    },

    async pullCloudData({ syncPublicPlaylists = true, syncPrivatePlaylists = true } = {}) {
        if (!authManager.user) return false;

        if (this._cloudPullPromise) {
            return this._cloudPullPromise;
        }

        this._cloudPullPromise = (async () => {
            try {
                const cloudData = await this.getUserData();
                if (!cloudData) return false;

                const cloudLibrary = cloudData.library || {};
                const cloudUserFolders = Object.values(cloudData.userFolders || {});
                const didImport = await database.importData(
                    {
                        favorites_tracks: Object.values(cloudLibrary.tracks || {}),
                        favorites_albums: Object.values(cloudLibrary.albums || {}),
                        favorites_artists: Object.values(cloudLibrary.artists || {}),
                        favorites_playlists: Object.values(cloudLibrary.playlists || {}),
                        favorites_mixes: Object.values(cloudLibrary.mixes || {}),
                        history_tracks: cloudData.history || [],
                        user_playlists: undefined,
                        user_folders: cloudUserFolders,
                    },
                    false
                );

                let playlistChanged = false;
                if (syncPublicPlaylists) {
                    const [publicChanged, privateChanged] = await Promise.all([
                        this.syncCloudPublicPlaylistsToLocal(),
                        syncPrivatePlaylists ? this.syncCloudPrivatePlaylistsToLocal() : Promise.resolve(false),
                    ]);
                    playlistChanged = publicChanged || privateChanged;
                } else if (syncPrivatePlaylists) {
                    playlistChanged = await this.syncCloudPrivatePlaylistsToLocal();
                }
                const collaborativeChanged = await this.syncCloudCollaborativePlaylistsToLocal();

                if (didImport) {
                    window.dispatchEvent(new CustomEvent('library-changed'));
                    window.dispatchEvent(new CustomEvent('history-changed'));
                } else if (playlistChanged || collaborativeChanged) {
                    window.dispatchEvent(new CustomEvent('library-changed'));
                }

                return didImport || playlistChanged || collaborativeChanged;
            } catch (error) {
                console.warn('[Appwrite Sync] Failed to pull cloud data:', error);
                return false;
            } finally {
                this._cloudPullPromise = null;
            }
        })();

        return this._cloudPullPromise;
    },

    setupRealtimeSubscriptions() {
        const user = authManager.user;
        if (!user || this._realtimeUnsubscribe) return;

        try {
            this._realtimeUnsubscribe = client.subscribe(
                [
                    `databases.${DATABASE_ID}.collections.${USERS_COLLECTION}.documents`,
                    `databases.${DATABASE_ID}.collections.${PUBLIC_PLAYLISTS_COLLECTION}.documents`,
                    `databases.${DATABASE_ID}.collections.${COLLABORATIVE_PLAYLISTS_COLLECTION}.documents`,
                    `databases.${DATABASE_ID}.collections.${FRIEND_REQUESTS_COLLECTION}.documents`,
                    `databases.${DATABASE_ID}.collections.${CHAT_MESSAGES_COLLECTION}.documents`,
                ],
                (response) => {
                    const doc = response.payload;
                    if (!doc || typeof doc !== 'object') return;

                    if (Object.prototype.hasOwnProperty.call(doc, 'firebase_id')) {
                        const previousRecord = this._userRecordCache;
                        if (doc.firebase_id === user.$id) {
                            this._userRecordCache = doc;
                            const cloudPayloadChanged = this._didCloudSyncPayloadChange(previousRecord, doc);
                            window.dispatchEvent(
                                new CustomEvent('pb-user-updated', {
                                    detail: {
                                        ...doc,
                                        _cloudPayloadChanged: cloudPayloadChanged,
                                    },
                                })
                            );
                            if (cloudPayloadChanged) {
                                this.pullCloudData({ syncPublicPlaylists: true }).catch((error) => {
                                    console.warn('[Appwrite Sync] Realtime cloud pull failed:', error);
                                });
                            }
                        } else {
                            window.dispatchEvent(new CustomEvent('pb-friend-updated', { detail: doc }));
                        }
                        return;
                    }

                    if (
                        Object.prototype.hasOwnProperty.call(doc, 'owner_id') &&
                        Object.prototype.hasOwnProperty.call(doc, 'id') &&
                        Object.prototype.hasOwnProperty.call(doc, 'is_public')
                    ) {
                        const playlist = this._mapPublicPlaylistDoc(doc);
                        window.dispatchEvent(
                            new CustomEvent('pb-public-playlist-updated', {
                                detail: {
                                    playlistId: playlist.id,
                                    ownerId: doc.owner_id,
                                    playlist,
                                    events: response.events || [],
                                },
                            })
                        );

                        if (doc.owner_id === user.$id) {
                            if (doc.is_public === false) {
                                this._scheduleCloudPrivatePlaylistSync();
                            } else {
                                this._scheduleCloudPublicPlaylistSync();
                            }
                        }
                        return;
                    }

                    if (
                        Object.prototype.hasOwnProperty.call(doc, 'owner_id') &&
                        Object.prototype.hasOwnProperty.call(doc, 'id') &&
                        Object.prototype.hasOwnProperty.call(doc, 'is_collaborative')
                    ) {
                        const collaborativePlaylist = this._mapCollaborativePlaylistDoc(doc);
                        window.dispatchEvent(
                            new CustomEvent('pb-collab-playlist-updated', {
                                detail: {
                                    playlistId: collaborativePlaylist.id,
                                    ownerId: doc.owner_id,
                                    playlist: collaborativePlaylist,
                                    events: response.events || [],
                                },
                            })
                        );

                        this._scheduleCloudCollaborativePlaylistSync();
                        return;
                    }

                    if (
                        Object.prototype.hasOwnProperty.call(doc, 'sender_id') &&
                        Object.prototype.hasOwnProperty.call(doc, 'receiver_id') &&
                        Object.prototype.hasOwnProperty.call(doc, 'status')
                    ) {
                        if (doc.sender_id === user.$id || doc.receiver_id === user.$id) {
                            window.dispatchEvent(new CustomEvent('pb-friend-request-updated', { detail: doc }));
                        }
                        return;
                    }

                    if (
                        Object.prototype.hasOwnProperty.call(doc, 'conversation_id') &&
                        Object.prototype.hasOwnProperty.call(doc, 'message')
                    ) {
                        if (doc.sender_id === user.$id || doc.receiver_id === user.$id) {
                            window.dispatchEvent(
                                new CustomEvent('pb-chat-message', {
                                    detail: this._mapChatMessage(doc),
                                })
                            );
                        }
                    }
                }
            );
            console.log('[Appwrite Sync] Real-time subscriptions active');
        } catch (error) {
            console.error('[Appwrite Sync] Failed to initialize real-time subscriptions:', error);
        }
    },

    async updatePlaybackStatus(track, options = {}) {
        if (!authManager.user || !track) return;
        if (Date.now() < this._statusBackoffUntil) return;

        // Check private listening mode
        try {
            const userData = await this.getUserData();
            if (userData?.profile?.privacy?.listening === 'private') return;
        } catch {
            // Ignore transient profile lookup failures and proceed with best effort status sync.
        }

        const now = Date.now();
        const durationRaw = Number(options.durationSec ?? track.duration ?? track.length ?? 0);
        const durationSec = Number.isFinite(durationRaw) && durationRaw > 0 ? Math.max(0, durationRaw) : 0;
        const positionRaw = Number(options.positionSec ?? options.currentTimeSec ?? 0);
        const positionSec = Number.isFinite(positionRaw)
            ? Math.max(0, Math.min(positionRaw, durationSec || positionRaw))
            : 0;

        // The status auto-expires if no heartbeat arrives, preventing stale "Now Playing" cards.
        const baseTtlMs = durationSec > 0 ? Math.round(durationSec * 1000 * 1.2) : 4 * 60 * 1000;
        const ttlMs = Math.max(90 * 1000, Math.min(baseTtlMs, 8 * 60 * 1000));
        const startedAt = Math.max(0, Math.round(now - positionSec * 1000));

        const statusData = {
            v: 2,
            trackId: String(track.id || ''),
            text: `${track.title} - ${getTrackArtists(track)}`,
            image: track.album?.cover || 'assets/appicon.png',
            link: getShareUrl(`/track/${track.id}`),
            durationSec,
            positionSec: Math.round(positionSec),
            startedAt,
            updatedAt: now,
            expiresAt: now + ttlMs,
        };

        this._lastPlaybackStatusPayload = statusData;

        const force = options.force === true;
        const fingerprint = JSON.stringify({
            trackId: statusData.trackId,
            text: statusData.text,
            positionBucket: Math.floor(statusData.positionSec / 15),
        });

        if (
            !force &&
            fingerprint === this._lastPlaybackStatusFingerprint &&
            now - this._lastPlaybackStatusSentAt < 20_000
        ) {
            return;
        }

        try {
            await this.updateProfile({ status: JSON.stringify(statusData) });
            this._lastPlaybackStatusFingerprint = fingerprint;
            this._lastPlaybackStatusSentAt = now;
        } catch (error) {
            if (isNetworkError(error)) {
                this._statusBackoffUntil = Date.now() + 10_000;
            }
            console.error('[Appwrite Sync] Failed to update playback status:', error);
        }
    },

    async clearPlaybackStatus() {
        if (!authManager.user) return;
        if (Date.now() < this._statusBackoffUntil) return;

        try {
            const now = Date.now();
            const previous = this._lastPlaybackStatusPayload;
            const idlePayload = previous
                ? {
                      ...previous,
                      updatedAt: now,
                      expiresAt: now,
                      positionSec: 0,
                      state: 'stopped',
                  }
                : '';

            await this.updateProfile({ status: idlePayload ? JSON.stringify(idlePayload) : '' });
            this._lastPlaybackStatusFingerprint = '';
            this._lastPlaybackStatusSentAt = 0;
        } catch (error) {
            if (isNetworkError(error)) {
                this._statusBackoffUntil = Date.now() + 10_000;
            }
            console.error('[Appwrite Sync] Failed to clear playback status:', error);
        }
    },

    async onAuthStateChanged(user) {
        if (!user) {
            this._userRecordCache = null;
            this._isSyncing = false;
            this._cloudPullPromise = null;
            this._publicPlaylistSyncPromise = null;
            this._privatePlaylistSyncPromise = null;
            this._collaborativePlaylistSyncPromise = null;
            if (this._publicPlaylistSyncTimeoutId) {
                clearTimeout(this._publicPlaylistSyncTimeoutId);
                this._publicPlaylistSyncTimeoutId = null;
            }
            if (this._privatePlaylistSyncTimeoutId) {
                clearTimeout(this._privatePlaylistSyncTimeoutId);
                this._privatePlaylistSyncTimeoutId = null;
            }
            if (this._collaborativePlaylistSyncTimeoutId) {
                clearTimeout(this._collaborativePlaylistSyncTimeoutId);
                this._collaborativePlaylistSyncTimeoutId = null;
            }
            if (this._realtimeUnsubscribe) {
                this._realtimeUnsubscribe();
                this._realtimeUnsubscribe = null;
            }
            this.stopPeriodicSync();
            return;
        }

        if (this._isSyncing) return;
        this._isSyncing = true;

        try {
            await this._getUserRecord();
            await this._flushPendingLibraryOps();
            this.setupRealtimeSubscriptions();

            const cloudData = await this.getUserData();
            if (!cloudData) return;

            const cloudLibrary = cloudData.library || {};
            const hasCloudData =
                Object.values(cloudLibrary).some((value) => value && Object.keys(value).length > 0) ||
                (cloudData.history?.length || 0) > 0 ||
                Object.keys(cloudData.userPlaylists || {}).length > 0 ||
                Object.keys(cloudData.userFolders || {}).length > 0;

            if (hasCloudData) {
                await this.pullCloudData({ syncPublicPlaylists: true, syncPrivatePlaylists: true });
            } else {
                await this.syncCloudPublicPlaylistsToLocal();
                await this.syncCloudPrivatePlaylistsToLocal();
                await this.syncCloudCollaborativePlaylistsToLocal();
            }

            this.startPeriodicSync();
        } catch (error) {
            console.error('[Appwrite Sync] Sync error:', error);
        } finally {
            this._isSyncing = false;
        }
    },

    startPeriodicSync() {
        if (this._syncIntervalId) return;

        const doSync = async () => {
            if (!authManager.user) return;
            try {
                const localData = await database.exportData();
                if (!localData) return;

                const record = await this._getUserRecord();
                if (!record) return;

                const asMap = (arr, key = 'id') => {
                    const map = {};
                    arr.forEach((item) => {
                        const itemKey = item?.[key] ?? item?.uuid;
                        if (!itemKey) return;
                        map[itemKey] = item;
                    });
                    return map;
                };

                const library = {
                    tracks: asMap((localData.favorites_tracks || []).slice(0, MAX_TRACK_SYNC)),
                    albums: asMap((localData.favorites_albums || []).slice(0, MAX_ALBUM_SYNC)),
                    artists: asMap((localData.favorites_artists || []).slice(0, MAX_ARTIST_SYNC)),
                    playlists: asMap((localData.favorites_playlists || []).slice(0, MAX_PLAYLIST_SYNC), 'uuid'),
                    mixes: asMap((localData.favorites_mixes || []).slice(0, MAX_MIX_SYNC)),
                };

                const history = (localData.history_tracks || []).map((entry) => {
                    const minified = this._minifyItem('track', entry);
                    minified.timestamp = entry.timestamp || Date.now();
                    return minified;
                });
                const statisticsSummary = this._buildStatisticsSummary(history);
                const playlists = localData.user_playlists || [];
                const folders = localData.user_folders || [];
                const existingCloudPlaylistMetadata = this._safeObject(record.user_playlists, {});
                const existingCloudFolderMetadata = this._safeObject(record.user_folders, {});
                const hasLocalPlaylistMetadata = playlists.length > 0;
                const hasCloudPlaylistMetadata = Object.keys(existingCloudPlaylistMetadata).length > 0;
                const shouldProtectCloudPlaylists = !hasLocalPlaylistMetadata && hasCloudPlaylistMetadata;

                const publicPlaylistIds = new Set();
                const cloudPlaylistMetadata = shouldProtectCloudPlaylists ? { ...existingCloudPlaylistMetadata } : {};
                for (const playlist of playlists) {
                    if (!playlist?.id) continue;

                    cloudPlaylistMetadata[playlist.id] = {
                        id: playlist.id,
                        name: playlist.name || 'Untitled Playlist',
                        cover: playlist.cover || null,
                        description: playlist.description || '',
                        numberOfTracks: Array.isArray(playlist.tracks)
                            ? playlist.tracks.length
                            : playlist.numberOfTracks || 0,
                        isPublic: !!playlist.isPublic,
                        updatedAt: playlist.updatedAt || Date.now(),
                    };

                    if (!playlist?.isPublic) continue;
                    publicPlaylistIds.add(playlist.id);
                }

                const hasLocalFolderMetadata = folders.length > 0;
                const hasCloudFolderMetadata = Object.keys(existingCloudFolderMetadata).length > 0;
                const shouldProtectCloudFolders = !hasLocalFolderMetadata && hasCloudFolderMetadata;
                const cloudFolderMetadata = shouldProtectCloudFolders ? { ...existingCloudFolderMetadata } : {};
                for (const folder of folders) {
                    if (!folder?.id) continue;
                    cloudFolderMetadata[folder.id] = {
                        id: folder.id,
                        name: folder.name || 'Folder',
                        cover: folder.cover || '',
                        playlists: Array.isArray(folder.playlists) ? folder.playlists : [],
                        updatedAt: folder.updatedAt || Date.now(),
                    };
                }

                const historyPayload = this._buildHistorySyncPayload(history);
                let updated;
                try {
                    updated = await this._withRetry(
                        () =>
                            databases.updateDocument(DATABASE_ID, USERS_COLLECTION, record.$id, {
                                library: JSON.stringify(library),
                                user_playlists: JSON.stringify(cloudPlaylistMetadata),
                                user_folders: JSON.stringify(cloudFolderMetadata),
                                statistics_summary: JSON.stringify(statisticsSummary),
                                ...historyPayload,
                            }),
                        { label: 'periodic sync' }
                    );
                } catch (periodicSyncError) {
                    const errorMessage = String(periodicSyncError?.message || '').toLowerCase();
                    const chunkFieldRejected =
                        this._chunkedHistorySupported &&
                        (errorMessage.includes('unknown attribute') ||
                            errorMessage.includes('unauthorized attribute')) &&
                        errorMessage.includes('history_chunk_count');

                    if (!chunkFieldRejected) {
                        throw periodicSyncError;
                    }

                    console.warn(
                        '[Appwrite Sync] Chunked history fields unsupported by this Appwrite schema, falling back to safe history payload.'
                    );
                    this._chunkedHistorySupported = false;

                    const fallbackHistoryPayload = this._buildHistorySyncPayload(history);
                    updated = await this._withRetry(
                        () =>
                            databases.updateDocument(DATABASE_ID, USERS_COLLECTION, record.$id, {
                                library: JSON.stringify(library),
                                user_playlists: JSON.stringify(cloudPlaylistMetadata),
                                user_folders: JSON.stringify(cloudFolderMetadata),
                                statistics_summary: JSON.stringify(statisticsSummary),
                                ...fallbackHistoryPayload,
                            }),
                        { label: 'periodic sync (fallback)' }
                    );
                }

                try {
                    if (hasLocalPlaylistMetadata) {
                        const existingCloudPlaylists = await databases.listDocuments(
                            DATABASE_ID,
                            PUBLIC_PLAYLISTS_COLLECTION,
                            [
                                Query.equal('owner_id', authManager.user.$id),
                                Query.equal('is_public', true),
                                Query.limit(500),
                            ]
                        );

                        await Promise.allSettled(
                            existingCloudPlaylists.documents
                                .filter((doc) => !publicPlaylistIds.has(doc.id))
                                .map((doc) =>
                                    databases.deleteDocument(DATABASE_ID, PUBLIC_PLAYLISTS_COLLECTION, doc.$id)
                                )
                        );

                        const playlistSyncTasks = playlists
                            .filter((playlist) => playlist?.id)
                            .map((playlist) =>
                                playlist.isPublic ? this.publishPlaylist(playlist) : this.syncPrivatePlaylist(playlist)
                            );
                        await Promise.allSettled(playlistSyncTasks);
                    } else if (hasCloudPlaylistMetadata) {
                        console.log(
                            '[Appwrite Sync] Skipping destructive public playlist sync because local metadata is empty.'
                        );
                    }
                } catch (playlistError) {
                    console.warn('[Appwrite Sync] Periodic public playlist sync failed:', playlistError);
                }

                try {
                    const collaborativePlaylists = await database.getCollaborativePlaylists();
                    if (Array.isArray(collaborativePlaylists) && collaborativePlaylists.length > 0) {
                        await Promise.allSettled(
                            collaborativePlaylists.map((playlist) => this.syncCollaborativePlaylist(playlist, 'update'))
                        );
                    }
                } catch (collabError) {
                    console.warn('[Appwrite Sync] Periodic collaborative playlist sync failed:', collabError);
                }

                this._userRecordCache = updated;
                window.dispatchEvent(new CustomEvent('library-changed'));
                console.log('[Appwrite Sync] Periodic sync complete');
            } catch (error) {
                console.warn('[Appwrite Sync] Periodic sync failed:', error);
            }
        };

        setTimeout(doSync, 5000);
        this._syncIntervalId = setInterval(doSync, 2 * 60 * 1000);
    },

    stopPeriodicSync() {
        if (this._syncIntervalId) {
            clearInterval(this._syncIntervalId);
            this._syncIntervalId = null;
        }
    },
};

authManager.onAuthStateChanged(syncManager.onAuthStateChanged.bind(syncManager));
window.syncManager = syncManager;

export { syncManager };
