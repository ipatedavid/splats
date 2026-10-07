// Finding and loading one scene folder. Shared by the player and the editor.

const SCENE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * The scene folder named in the address (?scene=name). `?base=` overrides the configured
 * hosting, for trying a scene from somewhere else. Null when the name is missing or unsafe.
 */
export const sceneFolder = (params) => {
    const name = params.get('scene');
    if (!name || !SCENE_NAME.test(name)) {
        return null;
    }
    const base = (params.get('base') || window.SPLATS_CONFIG.sceneBase).replace(/\/?$/, '/');
    return { name, url: new URL(`${name}/`, new URL(base, location.href)).href };
};

// Public buckets answer 403 rather than 404 for a file that is not there.
const missing = (status) => status === 404 || status === 403;

const fetchJson = async (url) => {
    const response = await fetch(url, { cache: 'no-cache' });
    if (missing(response.status)) {
        return null;
    }
    if (!response.ok) {
        throw new Error(`${url} answered ${response.status}.`);
    }
    return response.json();
};

const exists = async (url) => {
    try {
        const response = await fetch(url, { method: 'HEAD', cache: 'no-cache' });
        return response.ok;
    } catch {
        return false;
    }
};

// A pointer in scene.json may name files hosted elsewhere (a scene published on superspl.at,
// say). Only https addresses, or paths inside the folder, are used.
const pointer = (value, folderUrl) => {
    if (typeof value !== 'string' || !value) {
        return undefined;
    }
    const url = new URL(value, folderUrl);
    return url.protocol === 'https:' || url.href.startsWith(folderUrl) ? url.href : undefined;
};

/**
 * Everything the viewer needs for a scene. The splat is the folder's scene.sog / scene.ply,
 * or whatever scene.json points to. Missing settings fall back to the viewer's defaults;
 * missing limits mean no limits; collision, skybox and poster are used when present.
 */
export const loadScene = async (folder, defaultSettings) => {
    const [manifest, settings, limits] = await Promise.all([
        fetchJson(`${folder.url}scene.json`),
        fetchJson(`${folder.url}settings.json`),
        fetchJson(`${folder.url}limits.json`)
    ]);
    const pointed = (key) => pointer(manifest?.[key], folder.url);
    const local = async (name) => ((await exists(`${folder.url}${name}`)) ? `${folder.url}${name}` : undefined);

    let contentUrl = pointed('content');
    if (!contentUrl) {
        contentUrl = (await local('scene.sog')) ?? (await local('scene.ply'));
    }
    if (!contentUrl) {
        throw new Error(`No scene.sog, scene.ply or scene.json pointer in ${folder.url}`);
    }
    const [collisionUrl, skyboxUrl, posterUrl] = await Promise.all([
        pointed('collision') ?? local('collision.voxel.json'),
        pointed('skybox') ?? local('skybox.webp'),
        pointed('poster') ?? local('poster.webp')
    ]);
    return {
        contentUrl,
        settings: settings ?? defaultSettings(),
        hasSettings: settings !== null,
        limits: limits ?? undefined,
        collisionUrl,
        skyboxUrl,
        posterUrl
    };
};
