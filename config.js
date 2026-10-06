// Where the scene folders live. Each scene is a folder named after the scene, holding
// scene.sog (or scene.ply), and optionally settings.json, limits.json and
// collision.voxel.json + collision.voxel.bin.
// Fill in the Scaleway bucket address once it exists, ending in a slash.
window.SPLATS_CONFIG = {
    sceneBase: 'https://YOUR-BUCKET.s3.fr-par.scw.cloud/scenes/'
};
