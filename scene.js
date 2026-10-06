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

/**
 * Everything the viewer needs for a scene. Missing settings fall back to the viewer's
 * defaults; missing limits mean no limits; collision is used when the folder has it.
 */
export const loadScene = async (folder, defaultSettings) => {
    const [settings, limits, sog, collision] = await Promise.all([
        fetchJson(`${folder.url}settings.json`),
        fetchJson(`${folder.url}limits.json`),
        exists(`${folder.url}scene.sog`),
        exists(`${folder.url}collision.voxel.json`)
    ]);
    const contentUrl = `${folder.url}${sog ? 'scene.sog' : 'scene.ply'}`;
    if (!sog && !(await exists(contentUrl))) {
        throw new Error(`No scene.sog or scene.ply in ${folder.url}`);
    }
    return {
        contentUrl,
        settings: settings ?? defaultSettings(),
        hasSettings: settings !== null,
        limits: limits ?? undefined,
        collisionUrl: collision ? `${folder.url}collision.voxel.json` : undefined
    };
};
