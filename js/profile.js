import { syncManager } from './accounts/appwrite-sync.js';
import { authManager } from './accounts/auth.js';
import { navigate } from './router.js';
import { MusicAPI } from './music-api.js';
import { debounce, escapeHtml, getShareUrl, copyTextToClipboard } from './utils.js';
import { storage, client, APPWRITE_PROJECT_ID, APPWRITE_ENDPOINT, APPWRITE_DATABASE_ID } from './lib/appwrite.js';
import { ID } from 'appwrite';

// objects execution february 29th 2027

const profilePage = document.getElementById('page-profile');
const editProfileModal = document.getElementById('edit-profile-modal');
const editProfileBtn = document.getElementById('profile-edit-btn');
const viewMyProfileBtn = document.getElementById('view-my-profile-btn');

const editUsername = document.getElementById('edit-profile-username');
const editDisplayName = document.getElementById('edit-profile-display-name');
const editAvatar = document.getElementById('edit-profile-avatar');
const editBanner = document.getElementById('edit-profile-banner');
const editStatusSearch = document.getElementById('edit-profile-status-search');
const editStatusJson = document.getElementById('edit-profile-status-json');
const statusSearchResults = document.getElementById('status-search-results');
const statusPreview = document.getElementById('status-preview');
const clearStatusBtn = document.getElementById('clear-status-btn');
const editFavoriteAlbumsList = document.getElementById('edit-favorite-albums-list');
const editFavoriteAlbumsSearch = document.getElementById('edit-favorite-albums-search');
const editFavoriteAlbumsResults = document.getElementById('edit-favorite-albums-results');
const editAbout = document.getElementById('edit-profile-about');
const editWebsite = document.getElementById('edit-profile-website');
const editLastfm = document.getElementById('edit-profile-lastfm');
const privacyPlaylists = document.getElementById('privacy-playlists-toggle');
const privacyLastfm = document.getElementById('privacy-lastfm-toggle');
const privacyListening = document.getElementById('privacy-listening-toggle');
const saveProfileBtn = document.getElementById('edit-profile-save');
const cancelProfileBtn = document.getElementById('edit-profile-cancel');
const shareProfileBtn = document.getElementById('profile-share-btn');
const usernameError = document.getElementById('username-error');

let currentProfileUsername = null;
let currentFavoriteAlbums = [];
const api = new MusicAPI();

function normalizeFavoriteAlbums(value) {
    let parsed = value;
    if (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed);
        } catch {
            parsed = [];
        }
    }

    const albums = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? Object.values(parsed) : [];
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
}

async function uploadImage(file) {
    try {
        const BUCKET_ID = 'profile-images';
        const fileId = ID.unique();

        console.log('[Profile] Uploading image to Appwrite Storage...');
        const result = await storage.createFile(BUCKET_ID, fileId, file);

        // Construct the preview URL (using the project endpoint)
        // Format: [endpoint]/storage/buckets/[bucketId]/files/[fileId]/preview?project=[projectId]
        const endpoint = APPWRITE_ENDPOINT;
        const projectId = APPWRITE_PROJECT_ID;
        const url = `${endpoint}/storage/buckets/${BUCKET_ID}/files/${result.$id}/view?project=${projectId}`;

        console.log('[Profile] Upload successful! URL:', url);
        return url;
    } catch (error) {
        console.error('[Profile] Upload error:', error);
        throw error;
    }
}

function setupImageUploadControl(idPrefix) {
    const urlInput = document.getElementById(idPrefix);
    const fileInput = document.getElementById(idPrefix + '-file');
    const uploadBtn = document.getElementById(idPrefix + '-upload-btn');
    const toggleBtn = document.getElementById(idPrefix + '-toggle-btn');
    const statusEl = document.getElementById(idPrefix + '-upload-status');

    if (!urlInput || !fileInput || !uploadBtn || !toggleBtn || !statusEl) return () => {};

    let useUrl = false;

    function updateUI() {
        if (useUrl) {
            uploadBtn.style.display = 'none';
            urlInput.style.display = 'block';
            toggleBtn.textContent = 'Upload';
        } else {
            uploadBtn.style.display = 'flex';
            urlInput.style.display = 'none';
            toggleBtn.textContent = 'or URL';
        }
    }

    toggleBtn.addEventListener('click', () => {
        useUrl = !useUrl;
        updateUI();
    });

    uploadBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            alert('Please select an image file');
            return;
        }

        statusEl.style.display = 'block';
        statusEl.textContent = 'Uploading...';
        statusEl.style.color = 'var(--muted-foreground)';
        uploadBtn.disabled = true;

        try {
            const url = await uploadImage(file);
            urlInput.value = url;
            statusEl.textContent = 'Done!';
            statusEl.style.color = '#10b981';
            setTimeout(() => {
                statusEl.style.display = 'none';
            }, 2000);
        } catch (error) {
            statusEl.textContent = 'Failed - try URL';
            statusEl.style.color = '#ef4444';
        } finally {
            uploadBtn.disabled = false;
            fileInput.value = '';
        }
    });

    return (currentUrl) => {
        urlInput.value = currentUrl || '';
        useUrl = !!currentUrl;
        updateUI();
        statusEl.style.display = 'none';
    };
}

let profileSubscription = null;

function renderProfileStatus(profile) {
    const presenceIndicator = document.getElementById('profile-presence-indicator');
    const avatarRing = document.querySelector('#page-profile .profile-avatar-ring');
    const statusEl = document.getElementById('profile-status');
    if (!statusEl) return;

    const toTimestamp = (value) => {
        if (value === null || value === undefined || value === '') return 0;
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        const parsed = Date.parse(String(value));
        return Number.isFinite(parsed) ? parsed : 0;
    };

    const parseStatusPayload = (status) => {
        if (!status || typeof status !== 'string') return null;
        try {
            const parsed = JSON.parse(status);
            if (!parsed || typeof parsed !== 'object') return null;

            const asNumber = (value) => {
                const n = Number(value);
                return Number.isFinite(n) ? n : 0;
            };

            return {
                text: parsed.text ? String(parsed.text) : '',
                image: parsed.image ? String(parsed.image) : '',
                link: parsed.link ? String(parsed.link) : '',
                updatedAt: asNumber(parsed.updatedAt),
                startedAt: asNumber(parsed.startedAt),
                expiresAt: asNumber(parsed.expiresAt),
                durationSec: asNumber(parsed.durationSec),
            };
        } catch {
            return null;
        }
    };

    const isFreshNowPlaying = (statusPayload, profileUpdatedAtMs) => {
        if (!statusPayload?.text) return false;

        const now = Date.now();
        const updatedAt = statusPayload.updatedAt || 0;
        const startedAt = statusPayload.startedAt || 0;
        const expiresAt = statusPayload.expiresAt || 0;
        const durationSec = statusPayload.durationSec || 0;

        if (expiresAt > 0 && now > expiresAt) return false;
        if (updatedAt > 0 && now - updatedAt > 12 * 60 * 1000) return false;

        if (startedAt > 0 && durationSec > 0) {
            const maxSongSpanMs = Math.max(3 * 60 * 1000, Math.min(durationSec * 1000 * 1.8, 20 * 60 * 1000));
            if (now - startedAt > maxSongSpanMs) return false;
        }

        if (profileUpdatedAtMs > 0 && now - profileUpdatedAtMs > 15 * 60 * 1000) return false;
        return true;
    };

    const resolveStatusImage = (value) => {
        if (!value) return '/assets/appicon.png';
        if (
            value.startsWith('http://') ||
            value.startsWith('https://') ||
            value.startsWith('/') ||
            value.startsWith('assets/')
        ) {
            return value;
        }
        return api.getCoverUrl(value, '80');
    };

    if (profile.status) {
        try {
            const profileUpdatedAtMs = toTimestamp(profile?.$updatedAt || profile?.updated_at || 0);
            const statusObj = parseStatusPayload(profile.status);

            if (!isFreshNowPlaying(statusObj, profileUpdatedAtMs)) {
                statusEl.style.display = 'none';
                if (presenceIndicator) presenceIndicator.style.display = 'none';
                if (avatarRing) avatarRing.classList.remove('is-live');
                return;
            }

            const coverUrl = resolveStatusImage(statusObj.image || '');
            const statusLabel = escapeHtml(statusObj.text || 'Unknown Track');
            statusEl.innerHTML = `
                <span style="opacity: 0.6; margin-right: 0.5rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em;">Listening to</span>
                <img src="${coverUrl}" onerror="this.src='/assets/appicon.png'" style="width: 18px; height: 18px; border-radius: 4px; object-fit: cover; margin-right: 0.5rem;">
                <a href="#" class="status-link" style="color: inherit; text-decoration: none; font-weight: 600;">${statusLabel}</a>
            `;
            statusEl.querySelector('.status-link').onclick = (e) => {
                e.preventDefault();
                if (statusObj.link) {
                    navigate(statusObj.link);
                }
            };

            // Presence indicator is now represented by a green avatar ring.
            if (presenceIndicator) presenceIndicator.style.display = 'none';
            if (avatarRing) avatarRing.classList.add('is-live');
        } catch {
            statusEl.textContent = profile.status;
            if (presenceIndicator) presenceIndicator.style.display = 'none';
            if (avatarRing) avatarRing.classList.remove('is-live');
        }
        statusEl.style.display = 'inline-flex';
    } else {
        statusEl.style.display = 'none';
        if (presenceIndicator) presenceIndicator.style.display = 'none';
        if (avatarRing) avatarRing.classList.remove('is-live');
    }
}

const resetAvatarControl = setupImageUploadControl('edit-profile-avatar');
const resetBannerControl = setupImageUploadControl('edit-profile-banner');

export async function loadProfile(username) {
    const profilePage = document.getElementById('page-profile');
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));

    if (profilePage) {
        profilePage.classList.add('active');
        // Ensure header is shown for real profiles
        const headerContainer = profilePage.querySelector('.profile-header-container');
        if (headerContainer) headerContainer.style.display = 'block';
    }

    const displayNameEl = document.getElementById('profile-display-name');
    const usernameEl = document.getElementById('profile-username');

    if (document.getElementById('profile-banner')) document.getElementById('profile-banner').style.backgroundImage = '';
    if (document.getElementById('profile-avatar'))
        document.getElementById('profile-avatar').src = '/assets/appicon.png';
    if (displayNameEl) displayNameEl.textContent = 'Loading...';
    if (usernameEl) usernameEl.textContent = '@' + username;

    const statusEl = document.getElementById('profile-status');
    const avatarRing = document.querySelector('#page-profile .profile-avatar-ring');
    const aboutEl = document.getElementById('profile-about');
    const websiteEl = document.getElementById('profile-website');
    const lastfmEl = document.getElementById('profile-lastfm');
    const playlistsContainer = document.getElementById('profile-playlists-container');

    if (statusEl) statusEl.style.display = 'none';
    if (avatarRing) avatarRing.classList.remove('is-live');
    if (aboutEl) aboutEl.textContent = '';
    if (websiteEl) websiteEl.style.display = 'none';
    if (lastfmEl) lastfmEl.style.display = 'none';
    if (playlistsContainer) playlistsContainer.innerHTML = '';

    const favAlbumsSection = document.getElementById('profile-favorite-albums-section');
    const favAlbumsContainer = document.getElementById('profile-favorite-albums-container');
    if (favAlbumsSection) favAlbumsSection.style.display = 'none';
    if (favAlbumsContainer) favAlbumsContainer.innerHTML = '';

    const recentSection = document.getElementById('profile-recent-scrobbles-section');
    const recentContainer = document.getElementById('profile-recent-scrobbles-container');
    if (recentSection) recentSection.style.display = 'none';
    if (recentContainer) recentContainer.innerHTML = '';

    const topArtistsSection = document.getElementById('profile-top-artists-section');
    const topArtistsContainer = document.getElementById('profile-top-artists-container');
    const topAlbumsSection = document.getElementById('profile-top-albums-section');
    const topAlbumsContainer = document.getElementById('profile-top-albums-container');
    const topTracksSection = document.getElementById('profile-top-tracks-section');
    const topTracksContainer = document.getElementById('profile-top-tracks-container');

    if (topArtistsSection) topArtistsSection.style.display = 'none';
    if (topArtistsContainer) topArtistsContainer.innerHTML = '';
    if (topAlbumsSection) topAlbumsSection.style.display = 'none';
    if (topAlbumsContainer) topAlbumsContainer.innerHTML = '';
    if (topTracksSection) topTracksSection.style.display = 'none';
    if (topTracksContainer) topTracksContainer.innerHTML = '';

    editProfileBtn.style.display = 'none';

    const profile = await syncManager.getProfile(username);

    if (!profile) {
        console.warn('[Profile] Profile record NOT FOUND for username:', username);
        if (displayNameEl) displayNameEl.textContent = 'User not found';
        return;
    }

    console.log('[Profile] Initializing profile UI with data:', profile.display_name || username);
    currentProfileUsername = username;

    // Real-time status updates
    if (profileSubscription) profileSubscription();

    const DATABASE_ID = APPWRITE_DATABASE_ID;
    const USERS_COLLECTION = 'DB_users';

    profileSubscription = client.subscribe(
        `databases.${DATABASE_ID}.collections.${USERS_COLLECTION}.documents.${profile.$id}`,
        (response) => {
            if (response.events.some((e) => e.includes('.update'))) {
                renderProfileStatus(response.payload);
            }
        }
    );

    if (displayNameEl) displayNameEl.textContent = profile.display_name || username;
    if (profile.banner) {
        document.getElementById('profile-banner').style.backgroundImage = `url('${profile.banner}')`;
    } else {
        document.getElementById('profile-banner').style.backgroundImage = 'none';
    }

    if (profile.avatar_url) {
        document.getElementById('profile-avatar').src = profile.avatar_url;
    } else {
        document.getElementById('profile-avatar').src = '/assets/appicon.png';
    }

    renderProfileStatus(profile);

    if (profile.about) {
        document.getElementById('profile-about').textContent = profile.about;
        document.getElementById('profile-about').style.display = 'block';
    } else {
        document.getElementById('profile-about').style.display = 'none';
    }

    const hasWebsite = !!profile.website;
    const hasLastfm = profile.lastfm_username && profile.privacy?.lastfm !== 'private';
    const linksContainer = document.querySelector('.profile-links');

    if (hasWebsite || hasLastfm) {
        if (linksContainer) linksContainer.style.display = 'flex';

        if (hasWebsite) {
            const webEl = document.getElementById('profile-website');
            webEl.href = profile.website;
            webEl.style.display = 'inline-flex';
        } else {
            document.getElementById('profile-website').style.display = 'none';
        }

        if (hasLastfm) {
            const lfmEl = document.getElementById('profile-lastfm');
            lfmEl.href = `https://last.fm/user/${profile.lastfm_username}`;
            lfmEl.style.display = 'inline-flex';
        } else {
            document.getElementById('profile-lastfm').style.display = 'none';
        }
    } else {
        if (linksContainer) linksContainer.style.display = 'none';
    }

    const favoriteAlbums = normalizeFavoriteAlbums(profile.favorite_albums);

    if (favoriteAlbums.length > 0) {
        if (favAlbumsSection && favAlbumsContainer) {
            favAlbumsSection.style.display = 'block';
            favAlbumsContainer.innerHTML = `
                <div class="profile-favorite-albums-collage">
                    ${favoriteAlbums
                        .map((album, index) => {
                            const image = api.getCoverUrl(album.cover);
                            const description = album.description || 'A timeless favorite from my library.';
                            const featuredClass = index % 7 === 0 ? 'is-featured' : '';
                            return `
                            <article
                                class="favorite-album-collage-item ${featuredClass}"
                                role="button"
                                tabindex="0"
                                aria-label="Open album ${escapeHtml(album.title)}"
                                onclick="window.navigate('/album/${album.id}')"
                                onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.navigate('/album/${album.id}');}"
                            >
                                <img src="${image}" alt="${escapeHtml(album.title)}" class="favorite-album-collage-image" loading="lazy" onerror="window.handleCoverImageFallback(this)">
                                <div class="favorite-album-collage-overlay">
                                    <div class="favorite-album-collage-meta">${escapeHtml(album.artist)}</div>
                                    <h3 class="favorite-album-collage-title">${escapeHtml(album.title)}</h3>
                                    <p class="favorite-album-collage-description">${escapeHtml(description)}</p>
                                </div>
                            </article>
                        `;
                        })
                        .join('')}
                </div>
            `;
        }
    }

    const dataSource = profile.profile_data_source || (profile.lastfm_username ? 'lastfm' : null);

    if (profile.lastfm_username && profile.privacy?.lastfm !== 'private') {
        fetchLastFmRecentTracks(profile.lastfm_username).then(async (tracks) => {
            if (tracks.length > 0) {
                recentSection.style.display = 'block';
                recentContainer.innerHTML = tracks
                    .map((track, index) => {
                        const isNowPlaying = track['@attr']?.nowplaying === 'true';
                        let image = getLastFmImage(track.image);
                        const hasImage = !!image;
                        if (!image) image = '/assets/appicon.png';

                        track._imgId = `scrobble-img-${index}`;
                        track._needsCover = !hasImage;

                        let dateDisplay = '';
                        if (isNowPlaying) dateDisplay = 'Scrobbling now';
                        else if (track.date) {
                            const date = new Date(track.date.uts * 1000);
                            dateDisplay =
                                date.toLocaleDateString() +
                                ' ' +
                                date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                        }

                        return `
                        <div class="track-item lastfm-track" data-title="${escapeHtml(track.name)}" data-artist="${escapeHtml(track.artist?.['#text'] || track.artist?.name || '')}" style="grid-template-columns: 48px 1fr auto; cursor: pointer; padding: 0.75rem; border-radius: var(--radius-lg); background: color-mix(in srgb, var(--card) 20%, transparent); transition: all 0.2s ease;">
                            <div style="position: relative; width: 48px; height: 48px;">
                                <img id="${track._imgId}" src="${image}" class="track-item-cover" style="width: 48px; height: 48px; border-radius: var(--radius-md); box-shadow: var(--shadow-sm);" loading="lazy" onerror="this.src='/assets/appicon.png'">
                                ${isNowPlaying ? '<div class="now-playing-waves" style="position: absolute; inset:0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; border-radius: var(--radius-md);"><div class="wave"></div><div class="wave"></div><div class="wave"></div></div>' : ''}
                            </div>
                            <div class="track-item-info" style="margin-left: 1rem;">
                                <div class="track-item-details">
                                    <div class="title" style="font-weight: 600; font-size: 0.95rem;">${track.name}</div>
                                    <div class="artist" style="opacity: 0.6; font-size: 0.85rem;">${track.artist?.['#text'] || track.artist?.name || track.artist || 'Unknown Artist'}</div>
                                </div>
                            </div>
                            <div class="track-item-duration" style="font-size: 0.75rem; opacity: 0.5; font-weight: 500;">${dateDisplay}</div>
                        </div>
                    `;
                    })
                    .join('');

                recentContainer.querySelectorAll('.track-item').forEach((item) => {
                    item.addEventListener('click', () => handleTrackClick(item.dataset.title, item.dataset.artist));
                    item.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        return false;
                    });
                });

                for (const track of tracks) {
                    if (track._needsCover) {
                        fetchFallbackCover(track.name, track.artist?.['#text'] || track.artist?.name, track._imgId);
                    }
                }
            }
        });

        fetchLastFmTopArtists(profile.lastfm_username).then(async (artists) => {
            if (artists.length > 0 && topArtistsSection && topArtistsContainer) {
                topArtistsSection.style.display = 'block';
                topArtistsContainer.innerHTML = artists
                    .map((artist, index) => {
                        let image = getLastFmImage(artist.image);
                        const hasImage = !!image;
                        if (!image) image = '/assets/appicon.png';

                        const imgId = `top-artist-img-${index}`;
                        artist._imgId = imgId;
                        artist._needsCover = !hasImage;

                        return `
                        <div class="card artist lastfm-card" data-name="${escapeHtml(artist.name)}" style="cursor: pointer;">
                            <div class="card-image-wrapper">
                                <img id="${imgId}" src="${image}" class="card-image" loading="lazy" onerror="this.src='/assets/appicon.png'">
                            </div>
                            <div class="card-info">
                                <div class="card-title">${artist.name}</div>
                                <div class="card-subtitle">${parseInt(artist.playcount).toLocaleString()} plays</div>
                            </div>
                        </div>
                    `;
                    })
                    .join('');

                topArtistsContainer.querySelectorAll('.card').forEach((card) => {
                    card.addEventListener('click', () => handleArtistClick(card.dataset.name));
                    card.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        return false;
                    });
                });

                for (const artist of artists) {
                    if (artist._needsCover) {
                        fetchFallbackArtistImage(artist.name, artist._imgId);
                    }
                }
            }
        });

        fetchLastFmTopAlbums(profile.lastfm_username).then(async (albums) => {
            if (albums.length > 0 && topAlbumsSection && topAlbumsContainer) {
                topAlbumsSection.style.display = 'block';
                topAlbumsContainer.innerHTML = albums
                    .map((album, index) => {
                        let image = getLastFmImage(album.image);
                        const hasImage = !!image;
                        if (!image) image = '/assets/appicon.png';

                        const imgId = `top-album-img-${index}`;
                        album._imgId = imgId;
                        album._needsCover = !hasImage;

                        const artistName =
                            album.artist?.name ||
                            album.artist?.['#text'] ||
                            (typeof album.artist === 'string' ? album.artist : 'Unknown Artist');
                        album._artistName = artistName;

                        return `
                        <div class="card lastfm-card" data-name="${escapeHtml(album.name)}" data-artist="${escapeHtml(artistName)}" style="cursor: pointer;">
                            <div class="card-image-wrapper">
                                <img id="${imgId}" src="${image}" class="card-image" loading="lazy" onerror="this.src='/assets/appicon.png'">
                            </div>
                            <div class="card-info">
                                <div class="card-title">${album.name}</div>
                                <div class="card-subtitle">${artistName}</div>
                            </div>
                        </div>
                    `;
                    })
                    .join('');

                topAlbumsContainer.querySelectorAll('.card').forEach((card) => {
                    card.addEventListener('click', () => handleAlbumClick(card.dataset.name, card.dataset.artist));
                    card.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        return false;
                    });
                });

                for (const album of albums) {
                    if (album._needsCover) {
                        fetchFallbackAlbumCover(album.name, album._artistName, album._imgId);
                    }
                }
            }
        });

        fetchLastFmTopTracks(profile.lastfm_username).then(async (tracks) => {
            if (tracks.length > 0 && topTracksSection && topTracksContainer) {
                topTracksSection.style.display = 'block';
                topTracksContainer.innerHTML = tracks
                    .map((track, index) => {
                        let image = getLastFmImage(track.image);
                        const hasImage = !!image;
                        if (!image) image = '/assets/appicon.png';

                        const imgId = `top-track-img-${index}`;
                        track._imgId = imgId;
                        track._needsCover = !hasImage;

                        const artistName =
                            track.artist?.name ||
                            track.artist?.['#text'] ||
                            (typeof track.artist === 'string' ? track.artist : 'Unknown Artist');
                        track._artistName = artistName;

                        return `
                        <div class="track-item lastfm-track" data-title="${escapeHtml(track.name)}" data-artist="${escapeHtml(artistName)}" style="grid-template-columns: 40px 1fr auto; cursor: pointer;">
                            <img id="${imgId}" src="${image}" class="track-item-cover" style="width: 40px; height: 40px; border-radius: 4px;" loading="lazy" onerror="this.src='/assets/appicon.png'">
                            <div class="track-item-info">
                                <div class="track-item-details">
                                    <div class="title">${track.name}</div>
                                    <div class="artist">${artistName}</div>
                                </div>
                            </div>
                            <div class="track-item-duration" style="font-size: 0.8rem; min-width: auto;">${parseInt(track.playcount).toLocaleString()} plays</div>
                        </div>
                    `;
                    })
                    .join('');

                topTracksContainer.querySelectorAll('.track-item').forEach((item) => {
                    item.addEventListener('click', () => handleTrackClick(item.dataset.title, item.dataset.artist));
                    item.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        return false;
                    });
                });

                for (const track of tracks) {
                    if (track._needsCover) {
                        fetchFallbackCover(track.name, track._artistName, track._imgId);
                    }
                }
            }
        });
    }

    const currentUser = await syncManager.getUserData();
    const isOwner = currentUser && currentUser.profile && currentUser.profile.username === username;

    if (isOwner) {
        editProfileBtn.style.display = 'inline-flex';
    }

    if (profile.privacy?.playlists !== 'private' || isOwner) {
        const container = document.getElementById('profile-playlists-container');
        const playlists = profile.user_playlists || {};

        Object.values(playlists).forEach((playlist) => {
            if (!playlist.isPublic && !isOwner) return;

            const card = document.createElement('div');
            card.className = 'card';
            card.innerHTML = `
                <div class="card-image-wrapper">
                    <img src="${playlist.cover || '/assets/appicon.png'}" class="card-image" loading="lazy" alt="${playlist.name}">
                </div>
                <div class="card-info">
                    <div class="card-title">${playlist.name}</div>
                    <div class="card-subtitle">${playlist.numberOfTracks || 0} tracks</div>
                </div>
            `;
            card.onclick = () => {
                navigate(`/userplaylist/${playlist.id}`);
            };
            container.appendChild(card);
        });

        if (container.children.length === 0) {
            container.innerHTML = '<div class="placeholder-msg">No public playlists yet.</div>';
        }
    }
}

export function openEditProfile() {
    syncManager.getUserData().then((data) => {
        if (!data || !data.profile) return;
        const p = data.profile;

        editUsername.value = p.username || '';
        editDisplayName.value = p.display_name || '';
        resetAvatarControl(p.avatar_url);
        resetBannerControl(p.banner);

        editStatusJson.value = p.status || '';
        editStatusSearch.value = '';
        if (p.status) {
            try {
                const statusObj = JSON.parse(p.status);
                showStatusPreview(statusObj);
            } catch {
                if (p.status.trim()) {
                    editStatusSearch.value = p.status;
                    hideStatusPreview();
                }
            }
        } else {
            hideStatusPreview();
        }

        currentFavoriteAlbums = normalizeFavoriteAlbums(p.favorite_albums);
        renderEditFavoriteAlbums();
        editFavoriteAlbumsSearch.value = '';
        editFavoriteAlbumsResults.style.display = 'none';

        editAbout.value = p.about || '';
        editWebsite.value = p.website || '';
        editLastfm.value = p.lastfm_username || '';

        privacyPlaylists.checked = p.privacy?.playlists !== 'private';
        privacyLastfm.checked = p.privacy?.lastfm !== 'private';
        if (privacyListening) privacyListening.checked = p.privacy?.listening === 'private';

        editProfileModal.classList.add('active');
    });
}

async function saveProfile() {
    const newUsername = editUsername.value.trim();
    if (!newUsername) {
        usernameError.textContent = 'Username cannot be empty';
        usernameError.style.display = 'block';
        return;
    }

    const currentUserData = await syncManager.getUserData();
    if (!currentUserData) {
        alert('You must be logged in to save your profile.');
        return;
    }

    if (currentUserData.profile.username !== newUsername) {
        const taken = await syncManager.isUsernameTaken(newUsername);
        if (taken) {
            usernameError.textContent = 'Username is already taken';
            usernameError.style.display = 'block';
            return;
        }
    }

    usernameError.style.display = 'none';
    saveProfileBtn.disabled = true;
    saveProfileBtn.textContent = 'Saving...';

    const data = {
        username: newUsername,
        display_name: editDisplayName.value.trim(),
        avatar_url: editAvatar.value.trim(),
        banner: editBanner.value.trim(),
        status: editStatusJson.value.trim() || (editStatusSearch.value.trim() ? editStatusSearch.value.trim() : ''),
        about: editAbout.value.trim(),
        website: editWebsite.value.trim(),
        favorite_albums: normalizeFavoriteAlbums(currentFavoriteAlbums),
        lastfm_username: editLastfm.value.trim(),
        privacy: {
            playlists: privacyPlaylists.checked ? 'public' : 'private',
            lastfm: privacyLastfm.checked ? 'public' : 'private',
            listening: privacyListening?.checked ? 'private' : 'public',
        },
    };

    try {
        await syncManager.updateProfile(data);
        editProfileModal.classList.remove('active');
        loadProfile(newUsername);

        if (window.location.pathname.includes('/user/@')) {
            window.history.replaceState(null, '', `/user/@${newUsername}`);
        }
    } catch (e) {
        alert('Failed to save profile. See console.');
        console.error(e);
    } finally {
        saveProfileBtn.disabled = false;
        saveProfileBtn.textContent = 'Save Profile';
    }
}

editProfileBtn.addEventListener('click', openEditProfile);
cancelProfileBtn.addEventListener('click', () => editProfileModal.classList.remove('active'));
saveProfileBtn.addEventListener('click', saveProfile);

shareProfileBtn?.addEventListener('click', () => {
    if (!currentProfileUsername) return;
    const url = getShareUrl(`/user/@${currentProfileUsername}`);
    copyTextToClipboard(url).then((copied) => {
        if (!copied) {
            alert('Could not copy link on this browser.');
            return;
        }
        const originalContent = shareProfileBtn.innerHTML;
        shareProfileBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 8px;">
                <polyline points="20 6 9 17 4 12"/>
            </svg>
            Copied!
        `;
        setTimeout(() => {
            shareProfileBtn.innerHTML = originalContent;
        }, 2000);
    });
});

viewMyProfileBtn.addEventListener('click', async () => {
    const data = await syncManager.getUserData();
    if (data && data.profile && data.profile.username) {
        navigate(`/user/@${data.profile.username}`);
    } else {
        openEditProfile();
    }
});

authManager.onAuthStateChanged((user) => {
    viewMyProfileBtn.style.display = user ? 'inline-block' : 'none';
});

function showStatusPreview(data) {
    document.getElementById('status-preview-img').src = data.image;
    document.getElementById('status-preview-title').textContent = data.title;
    document.getElementById('status-preview-subtitle').textContent = data.subtitle;
    statusPreview.style.display = 'flex';
    editStatusSearch.style.display = 'none';
}

function hideStatusPreview() {
    statusPreview.style.display = 'none';
    editStatusSearch.style.display = 'block';
    editStatusJson.value = '';
}

clearStatusBtn.addEventListener('click', () => {
    hideStatusPreview();
    editStatusSearch.value = '';
    editStatusSearch.focus();
});

const performStatusSearch = debounce(async (query) => {
    if (!query) {
        statusSearchResults.style.display = 'none';
        return;
    }

    try {
        const [tracks, albums] = await Promise.all([
            api.searchTracks(query, { limit: 3 }),
            api.searchAlbums(query, { limit: 3 }),
        ]);

        statusSearchResults.innerHTML = '';

        const createItem = (item, type) => {
            const div = document.createElement('div');
            div.className = 'search-result-item';
            const title = item.title;
            const subtitle =
                type === 'track' ? item.artist?.name || 'Unknown Artist' : item.artist?.name || 'Unknown Artist';
            const image = api.getCoverUrl(item.album?.cover || item.cover);

            div.innerHTML = `
                <img src="${image}">
                <div class="search-result-info">
                    <div class="search-result-title">${title}</div>
                    <div class="search-result-subtitle">${type === 'track' ? 'Song' : 'Album'} • ${subtitle}</div>
                </div>
            `;

            div.onclick = () => {
                const data = {
                    type: type,
                    id: item.id,
                    text: `${title} - ${subtitle}`,
                    title: title,
                    subtitle: subtitle,
                    image: image,
                    cover: item.album?.cover || item.cover || null,
                    link: `/${type}/${item.id}`,
                };
                editStatusJson.value = JSON.stringify(data);
                showStatusPreview(data);
                statusSearchResults.style.display = 'none';
            };
            return div;
        };

        tracks.items.forEach((t) => statusSearchResults.appendChild(createItem(t, 'track')));
        albums.items.forEach((a) => statusSearchResults.appendChild(createItem(a, 'album')));

        statusSearchResults.style.display = tracks.items.length || albums.items.length ? 'block' : 'none';
    } catch (e) {
        console.error('Status search failed', e);
    }
}, 300);

editStatusSearch.addEventListener('input', (e) => performStatusSearch(e.target.value.trim()));
document.addEventListener('click', (e) => {
    if (!e.target.closest('.status-picker-container')) {
        statusSearchResults.style.display = 'none';
    }
});

function renderEditFavoriteAlbums() {
    currentFavoriteAlbums = normalizeFavoriteAlbums(currentFavoriteAlbums);
    editFavoriteAlbumsList.innerHTML = currentFavoriteAlbums
        .map(
            (album, index) => `
        <div class="edit-favorite-album-item" style="background: var(--secondary); padding: 0.5rem; border-radius: var(--radius); border: 1px solid var(--border);">
            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;">
                <img src="${api.getCoverUrl(album.cover)}" style="width: 40px; height: 40px; border-radius: 4px; object-fit: cover;">
                <div style="flex: 1; min-width: 0;">
                    <div style="font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(album.title)}</div>
                    <div style="font-size: 0.8rem; color: var(--muted-foreground);">${escapeHtml(album.artist)}</div>
                </div>
                <button class="btn-icon remove-album-btn" data-index="${index}" style="color: var(--danger);">&times;</button>
            </div>
            <textarea class="template-input album-description-input" data-index="${index}" placeholder="Why is this a favorite?" style="min-height: 60px; font-size: 0.85rem; resize: vertical;">${escapeHtml(album.description || '')}</textarea>
        </div>
    `
        )
        .join('');

    editFavoriteAlbumsList.querySelectorAll('.remove-album-btn').forEach((btn) => {
        btn.onclick = () => {
            const idx = parseInt(btn.dataset.index);
            currentFavoriteAlbums.splice(idx, 1);
            renderEditFavoriteAlbums();
        };
    });

    editFavoriteAlbumsList.querySelectorAll('.album-description-input').forEach((input) => {
        input.oninput = () => {
            const idx = parseInt(input.dataset.index);
            currentFavoriteAlbums[idx].description = input.value;
        };
    });

    if (currentFavoriteAlbums.length >= 5) {
        editFavoriteAlbumsSearch.disabled = true;
        editFavoriteAlbumsSearch.placeholder = 'Max 5 albums reached';
    } else {
        editFavoriteAlbumsSearch.disabled = false;
        editFavoriteAlbumsSearch.placeholder = 'Search for an album...';
    }
}

const performFavoriteAlbumSearch = debounce(async (query) => {
    if (!query || currentFavoriteAlbums.length >= 5) {
        editFavoriteAlbumsResults.style.display = 'none';
        return;
    }

    try {
        const results = await api.searchAlbums(query, { limit: 5 });
        editFavoriteAlbumsResults.innerHTML = '';

        if (results.items.length === 0) {
            editFavoriteAlbumsResults.style.display = 'none';
            return;
        }

        results.items.forEach((album) => {
            const div = document.createElement('div');
            div.className = 'search-result-item';
            const image = api.getCoverUrl(album.cover);

            div.innerHTML = `
                <img src="${image}">
                <div class="search-result-info">
                    <div class="search-result-title">${album.title}</div>
                    <div class="search-result-subtitle">${album.artist?.name || 'Unknown Artist'}</div>
                </div>
            `;

            div.onclick = () => {
                currentFavoriteAlbums.push({
                    id: album.id,
                    title: album.title,
                    artist: album.artist?.name || 'Unknown Artist',
                    cover: album.cover,
                    description: '',
                });
                renderEditFavoriteAlbums();
                editFavoriteAlbumsSearch.value = '';
                editFavoriteAlbumsResults.style.display = 'none';
            };
            editFavoriteAlbumsResults.appendChild(div);
        });

        editFavoriteAlbumsResults.style.display = 'block';
    } catch (e) {
        console.error('Album search failed', e);
    }
}, 300);

editFavoriteAlbumsSearch.addEventListener('input', (e) => performFavoriteAlbumSearch(e.target.value.trim()));

function getLastFmImage(images) {
    if (!images) return null;
    const imgArray = Array.isArray(images) ? images : [images];
    const sizes = ['extralarge', 'large', 'medium', 'small'];

    const placeholders = ['2a96cbd8b46e442fc41c2b86b821562f', 'c6f59c1e5e7240a4c0d427abd71f3dbb'];

    const isValidUrl = (url) => {
        if (!url) return false;
        return !placeholders.some((ph) => url.includes(ph));
    };

    for (const size of sizes) {
        const img = imgArray.find((i) => i.size === size);
        if (img && img['#text'] && isValidUrl(img['#text'])) return img['#text'];
    }
    const anyImg = imgArray.find((i) => i['#text'] && isValidUrl(i['#text']));
    if (anyImg) return anyImg['#text'];
    return null;
}

async function handleArtistClick(name) {
    try {
        const results = await api.searchArtists(name, { limit: 1 });
        if (results.items.length > 0) {
            navigate(`/artist/${results.items[0].id}`);
        } else {
            alert('Artist not found in library');
        }
    } catch (e) {
        console.error(e);
    }
}

async function handleAlbumClick(name, artist) {
    try {
        const query = `${name} ${artist}`;
        const results = await api.searchAlbums(query, { limit: 1 });
        if (results.items.length > 0) {
            navigate(`/album/${results.items[0].id}`);
        } else {
            alert('Album not found in library');
        }
    } catch (e) {
        console.error(e);
    }
}

async function handleTrackClick(title, artist) {
    try {
        const query = `${title} ${artist}`;
        const results = await api.searchTracks(query, { limit: 1 });
        if (results.items.length > 0) {
            const track = results.items[0];
            if (window.wesperPlayer) {
                window.wesperPlayer.setQueue([track], 0);
                window.wesperPlayer.playTrackFromQueue();
            }
        } else {
            alert('Track not found');
        }
    } catch (e) {
        console.error(e);
    }
}

async function fetchFallbackCover(title, artist, imgId) {
    try {
        const query = `${title} ${artist}`;
        await new Promise((r) => setTimeout(r, 100));
        const results = await api.searchTracks(query, { limit: 5 });
        let foundCover = false;

        if (results.items && results.items.length > 0) {
            const found = results.items.find((item) => item.album?.cover);
            if (found) {
                const newUrl = api.getCoverUrl(found.album.cover);
                const imgEl = document.getElementById(imgId);
                if (imgEl) {
                    imgEl.src = newUrl;
                    foundCover = true;
                }
            }
        }

        if (!foundCover) {
            await fetchFallbackArtistImage(artist, imgId);
        }
    } catch (e) {
        await fetchFallbackArtistImage(artist, imgId);
    }
}

async function fetchFallbackAlbumCover(title, artist, imgId) {
    try {
        const query = `${title} ${artist}`;
        await new Promise((r) => setTimeout(r, 100));
        const results = await api.searchAlbums(query, { limit: 5 });
        let foundCover = false;

        if (results.items && results.items.length > 0) {
            const found = results.items.find((item) => item.cover);
            if (found) {
                const newUrl = api.getCoverUrl(found.cover);
                const imgEl = document.getElementById(imgId);
                if (imgEl) {
                    imgEl.src = newUrl;
                    foundCover = true;
                }
            }
        }

        if (!foundCover) {
            await fetchFallbackArtistImage(artist, imgId);
        }
    } catch (e) {
        await fetchFallbackArtistImage(artist, imgId);
    }
}

async function fetchFallbackArtistImage(artistName, imgId) {
    try {
        await new Promise((r) => setTimeout(r, 100));
        const results = await api.searchArtists(artistName, { limit: 3 });
        if (results.items && results.items.length > 0) {
            const found = results.items.find((item) => item.picture);
            if (found) {
                const newUrl = api.getArtistPictureUrl(found.picture);
                const imgEl = document.getElementById(imgId);
                if (imgEl) imgEl.src = newUrl;
            }
        }
    } catch {
        // Ignore fallback image lookup failures.
    }
}

async function fetchLastFmRecentTracks(username) {
    const apiKey = '85214f5abbc730e78770f27784b9bdf7';
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${encodeURIComponent(username)}&api_key=${apiKey}&format=json&limit=5`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        const tracks = data.recenttracks?.track;
        if (!tracks) return [];
        return Array.isArray(tracks) ? tracks : [tracks];
    } catch (e) {
        console.error('Failed to fetch Last.fm recent tracks', e);
        return [];
    }
}

async function fetchLastFmTopArtists(username) {
    const apiKey = '85214f5abbc730e78770f27784b9bdf7';
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.gettopartists&user=${encodeURIComponent(username)}&api_key=${apiKey}&format=json&limit=6`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        return data.topartists?.artist || [];
    } catch (e) {
        console.error('Failed to fetch Last.fm top artists', e);
        return [];
    }
}

async function fetchLastFmTopAlbums(username) {
    const apiKey = '85214f5abbc730e78770f27784b9bdf7';
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.gettopalbums&user=${encodeURIComponent(username)}&api_key=${apiKey}&format=json&limit=6`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        return data.topalbums?.album || [];
    } catch (e) {
        console.error('Failed to fetch Last.fm top albums', e);
        return [];
    }
}

async function fetchLastFmTopTracks(username) {
    const apiKey = '85214f5abbc730e78770f27784b9bdf7';
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.gettoptracks&user=${encodeURIComponent(username)}&api_key=${apiKey}&format=json&limit=5`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        return data.toptracks?.track || [];
    } catch (e) {
        console.error('Failed to fetch Last.fm top tracks', e);
        return [];
    }
}
