// Scene editor: records camera limits, a walking fence, the start view and annotations from
// the live view, and hands them over as limits.json and settings.json to upload.
import { createViewer, defaultSettings } from './index.js';
import { sceneFolder, loadScene } from './scene.js';

const $ = (selector) => document.querySelector(selector);
const stage = $('#stage');
const params = new URL(location.href).searchParams;
const folder = sceneFolder(params);

const mod = (value, n) => ((value % n) + n) % n;
const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const setStatus = (text) => {
    $('#status').textContent = text;
};

let scene = null;
let viewer = null;
let previewing = false;
let pendingSpot = null; // annotation position waiting for its title

// The draft: limits being built, the marks they are built from, and the settings.
let draft = null;

const storageKey = folder ? `splat-editor:${folder.url}` : '';
const saveDraft = () => {
    try {
        localStorage.setItem(storageKey, JSON.stringify(draft));
    } catch {
        // private window or storage off: the draft just lives until the tab closes
    }
};
const storedDraft = () => {
    try {
        return JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    } catch {
        return null;
    }
};

// ---- turning marks into limits ------------------------------------------------------------

// The allowed turn runs from one edge to the other; of the two ways round, take the one that
// contains the start view, or else the shorter one.
const yawRange = (a, b, inside) => {
    const one = [a, a + mod(b - a, 360)];
    const other = [b, b + mod(a - b, 360)];
    const contains = (arc, yaw) => mod(yaw - arc[0], 360) <= arc[1] - arc[0];
    if (inside !== undefined) {
        if (contains(one, inside) && !contains(other, inside)) return one;
        if (contains(other, inside) && !contains(one, inside)) return other;
    }
    return one[1] - one[0] <= other[1] - other[0] ? one : other;
};

const sorted = (a, b) => (a <= b ? [a, b] : [b, a]);

const buildLimits = () => {
    const m = draft.marks;
    const limits = {};
    if (draft.mode) {
        limits.mode = draft.mode;
    }
    if (draft.mode === 'orbit') {
        const orbit = {};
        if (m.left !== undefined && m.right !== undefined) {
            orbit.yaw = yawRange(m.left, m.right, draft.startYaw).map((v) => round(v, 1));
        }
        if (m.low !== undefined && m.high !== undefined) {
            orbit.pitch = sorted(m.low, m.high).map((v) => round(v, 1));
        }
        if (m.near !== undefined && m.far !== undefined) {
            orbit.distance = sorted(m.near, m.far).map((v) => round(v, 3));
        }
        if (draft.pan === 'locked') {
            orbit.pan = false;
        } else if (draft.pan === 'box' && draft.panBox) {
            orbit.pan = draft.panBox.map((v) => round(v, 3));
        }
        limits.orbit = orbit;
    }
    if (draft.mode === 'walk' && draft.fence.length >= 3) {
        limits.walk = { fence: draft.fence.map(([x, z]) => [round(x, 3), round(z, 3)]) };
    }
    return limits;
};

// ---- the viewer ---------------------------------------------------------------------------

const startViewer = async () => {
    viewer?.destroy();
    stage.replaceChildren();
    const limits = previewing ? buildLimits() : undefined;
    document.body.classList.toggle('gs-locked', Boolean(previewing && limits?.mode));
    viewer = await createViewer({
        container: stage,
        settings: structuredClone(draft.settings),
        contentUrl: scene.contentUrl,
        collisionUrl: scene.collisionUrl,
        skyboxUrl: scene.skyboxUrl,
        limits,
        renderer: params.has('webgl') ? 'webgl' : 'webgpu'
    });
    window.viewer = viewer;
    // Skip the intro animation: it would swallow the first button press, and dragging during it
    // drops into fly mode with the mouse captured. The camera is set up once the scene has
    // loaded, so switch then.
    if (!limits?.mode) {
        const current = viewer;
        const leaveAnimation = () => {
            if (current === viewer && viewer.state.cameraMode === 'anim') {
                viewer.state.cameraMode = draft.mode === 'walk' ? (viewer.state.walkAllowed ? 'walk' : 'fly') : 'orbit';
            }
        };
        viewer.events.on('cameraMode:changed', (mode) => mode === 'anim' && setTimeout(leaveAnimation, 0));
        viewer.events.on('loaded:changed', (loaded) => loaded && setTimeout(leaveAnimation, 0));
        leaveAnimation();
    }
};

const pose = () => viewer?.cameraPose();

// Orbit marks only mean something in orbit mode.
const ensureOrbit = () => {
    if (viewer && viewer.state.cameraMode !== 'orbit') {
        viewer.state.cameraMode = 'orbit';
        setStatus('Switched to orbit. Set the view again, then press the button.');
        return false;
    }
    return true;
};

// ---- rendering the panel ------------------------------------------------------------------

const describe = (pair, unit) => (pair ? `${pair[0]}${unit} to ${pair[1]}${unit}` : 'not limited');

const render = () => {
    const limits = buildLimits();
    for (const input of document.querySelectorAll('input[name="mode"]')) {
        input.checked = input.value === (draft.mode ?? '');
    }
    $('#orbit-tools').hidden = draft.mode !== 'orbit';
    $('#walk-tools').hidden = draft.mode !== 'walk';
    $('#mode-hint').textContent = {
        orbit: 'Visitors circle a focus point, within the limits below. No walking or flying.',
        walk: 'Visitors walk at eye height and cannot leave the fence. No orbit or flying.',
        '': 'Visitors can switch freely between orbit, fly and walk. No limits.'
    }[draft.mode ?? ''];

    const m = draft.marks;
    const partial = (a, b) => (a !== undefined && b === undefined) || (a === undefined && b !== undefined);
    $('#out-yaw').textContent = partial(m.left, m.right)
        ? 'one edge set; set the other'
        : describe(limits.orbit?.yaw, '°');
    $('#out-pitch').textContent = partial(m.low, m.high)
        ? 'one edge set; set the other'
        : describe(limits.orbit?.pitch, '°');
    $('#out-distance').textContent = partial(m.near, m.far)
        ? 'one end set; set the other'
        : describe(limits.orbit?.distance, ' m');
    for (const button of document.querySelectorAll('[data-mark]')) {
        button.classList.toggle('active', m[button.dataset.mark] !== undefined);
    }
    $('#pan').value = draft.pan;
    $('#pan-margin').hidden = draft.pan !== 'box';
    $('#pan-margin').nextElementSibling.hidden = draft.pan !== 'box';

    $('#out-fence').textContent =
        draft.fence.length === 0
            ? 'No fence yet.'
            : `${draft.fence.length} corner${draft.fence.length === 1 ? '' : 's'}` +
              (draft.fence.length < 3 ? ' — needs at least 3.' : '.');

    const [r, g, b] = draft.settings.background.color;
    const hex = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
    $('#background').value = `#${hex(r)}${hex(g)}${hex(b)}`;

    const list = $('#annotations');
    list.replaceChildren();
    draft.settings.annotations.forEach((annotation, index) => {
        const item = document.createElement('li');
        const row = document.createElement('div');
        row.className = 'row';
        const title = document.createElement('span');
        title.textContent = annotation.title;
        const go = document.createElement('button');
        go.className = 'quiet';
        go.textContent = 'Show';
        go.addEventListener('click', () => viewer?.selectAnnotation(index));
        const remove = document.createElement('button');
        remove.className = 'quiet';
        remove.textContent = 'Delete';
        remove.addEventListener('click', async () => {
            draft.settings.annotations.splice(index, 1);
            saveDraft();
            render();
            await startViewer();
        });
        row.append(title, go, remove);
        item.append(row);
        const warning = annotationWarning(annotation, limits);
        if (warning) {
            const note = document.createElement('p');
            note.className = 'warn';
            note.textContent = warning;
            item.append(note);
        }
        list.append(item);
    });
    // A start view that circles a point outside the zoom limits gets pushed to the limit at
    // load, and the orbit then turns around that point instead of the subject.
    const start = draft.settings.cameras?.[0]?.initial;
    const zoom = limits.orbit?.distance;
    const startDistance = start ? Math.hypot(...start.position.map((v, i) => v - start.target[i])) : 0;
    const startOff = Boolean(limits.mode === 'orbit' && zoom && start &&
        (startDistance < zoom[0] * 0.98 || startDistance > zoom[1] * 1.02));
    $('#start-warning').hidden = !startOff;
    $('#start-warning').textContent = startOff
        ? `The start view circles a point ${round(startDistance, 1)} m away, outside the zoom limits, ` +
          'so visitors would orbit around the wrong spot. Click the subject, then press Use this view.'
        : '';
    $('#preview').setAttribute('aria-pressed', String(previewing));
    $('#preview').textContent = previewing ? 'Back to editing' : 'Try as a visitor';
};

// An annotation whose view sits outside the orbit limits snaps back when visitors open it.
const annotationWarning = (annotation, limits) => {
    const view = annotation.extras?.view;
    const orbit = limits.orbit;
    if (!view || limits.mode !== 'orbit' || !orbit) {
        return '';
    }
    const outside = [];
    if (orbit.yaw) {
        const yaw = orbit.yaw[0] + mod(view.yaw - orbit.yaw[0], 360);
        if (yaw > orbit.yaw[1] + 0.5) outside.push('turn');
    }
    if (orbit.pitch && (view.pitch < orbit.pitch[0] - 0.5 || view.pitch > orbit.pitch[1] + 0.5)) {
        outside.push('tilt');
    }
    if (orbit.distance && (view.distance < orbit.distance[0] * 0.98 || view.distance > orbit.distance[1] * 1.02)) {
        outside.push('zoom');
    }
    return outside.length ? `Its view is outside the ${outside.join(' and ')} limits; re-save it from inside them.` : '';
};

// ---- controls -----------------------------------------------------------------------------

const wire = () => {
    // The viewer listens for keys on the whole page (W A S D Q E fly the camera). Typing in the
    // panel must stay in the panel.
    for (const type of ['keydown', 'keyup', 'keypress']) {
        $('#panel').addEventListener(type, (event) => event.stopPropagation());
    }

    for (const input of document.querySelectorAll('input[name="mode"]')) {
        input.addEventListener('change', () => {
            draft.mode = input.value || null;
            saveDraft();
            render();
            if (viewer && draft.mode === 'orbit') {
                viewer.state.cameraMode = 'orbit';
            } else if (viewer && draft.mode === 'walk' && viewer.state.walkAllowed) {
                viewer.state.cameraMode = 'walk';
            }
        });
    }

    for (const button of document.querySelectorAll('[data-mark]')) {
        button.addEventListener('click', () => {
            if (!ensureOrbit()) return;
            const p = pose();
            const value = { left: p.angles[1], right: p.angles[1], low: p.angles[0], high: p.angles[0], near: p.distance, far: p.distance }[
                button.dataset.mark
            ];
            draft.marks[button.dataset.mark] = value;
            saveDraft();
            render();
            setStatus(`${button.textContent.replace(' here', '')}: saved.`);
        });
    }

    $('#pan').addEventListener('change', () => {
        draft.pan = $('#pan').value;
        if (draft.pan === 'box') {
            if (!ensureOrbit()) {
                draft.pan = 'free';
            } else {
                const [x, y, z] = pose().focus;
                const r = Math.max(0.1, Number($('#pan-margin').value) || 1);
                draft.panBox = [x - r, y - r, z - r, x + r, y + r, z + r];
                setStatus(`Panning kept within ${r} m of the current focus point.`);
            }
        }
        saveDraft();
        render();
    });
    $('#pan-margin').addEventListener('change', () => {
        if (draft.pan === 'box' && draft.panBox) {
            const centre = [0, 1, 2].map((i) => (draft.panBox[i] + draft.panBox[i + 3]) / 2);
            const r = Math.max(0.1, Number($('#pan-margin').value) || 1);
            draft.panBox = [...centre.map((c) => c - r), ...centre.map((c) => c + r)];
            saveDraft();
        }
    });
    $('#clear-orbit').addEventListener('click', () => {
        draft.marks = {};
        draft.pan = 'free';
        draft.panBox = null;
        saveDraft();
        render();
    });

    $('#add-corner').addEventListener('click', () => {
        const [x, , z] = pose().position;
        draft.fence.push([x, z]);
        saveDraft();
        render();
    });
    $('#undo-corner').addEventListener('click', () => {
        draft.fence.pop();
        saveDraft();
        render();
    });
    $('#clear-fence').addEventListener('click', () => {
        draft.fence = [];
        saveDraft();
        render();
    });

    $('#start-view').addEventListener('click', () => {
        // in an orbit scene the start view must circle the subject: take it from orbit mode
        if (draft.mode === 'orbit' && !ensureOrbit()) return;
        const p = pose();
        draft.settings.cameras = [{ initial: { position: p.position, target: p.focus, fov: p.fov } }];
        draft.startYaw = p.angles[1];
        saveDraft();
        render();
        setStatus('Start view saved.');
    });
    $('#background').addEventListener('change', async () => {
        const hex = $('#background').value;
        draft.settings.background.color = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
        saveDraft();
        await startViewer();
    });

    // Placing: the next click on the splat picks the spot, instead of moving the camera.
    $('#place').addEventListener('click', () => {
        document.body.classList.add('placing');
        setStatus('Click the spot on the splat for the annotation.');
    });
    // While placing, the whole click belongs to the editor: none of it may reach the viewer.
    let swallowUntilUp = false;
    for (const type of ['pointerup', 'mouseup', 'click', 'mousedown']) {
        stage.addEventListener(
            type,
            (event) => {
                if (document.body.classList.contains('placing') || swallowUntilUp) {
                    event.stopPropagation();
                    event.preventDefault();
                    if (type === 'click') swallowUntilUp = false;
                }
            },
            true
        );
    }
    stage.addEventListener(
        'pointerdown',
        async (event) => {
            if (!document.body.classList.contains('placing')) return;
            event.stopPropagation();
            event.preventDefault();
            swallowUntilUp = true;
            document.body.classList.remove('placing');
            const rect = stage.getBoundingClientRect();
            const spot = await viewer.pick((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
            if (!spot) {
                setStatus('Nothing there to attach it to. Press the button and try again on the splat.');
                return;
            }
            pendingSpot = spot;
            $('#annotation-form').hidden = false;
            $('#ann-title').focus();
            setStatus('Spot chosen.');
        },
        true
    );
    $('#annotation-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        // The viewer flies to look at the marker itself, so the view aims at it from here.
        const p = pose();
        const distance = Math.hypot(...p.position.map((v, i) => v - pendingSpot[i]));
        draft.settings.annotations.push({
            position: pendingSpot,
            title: $('#ann-title').value.trim(),
            text: $('#ann-text').value.trim(),
            camera: { initial: { position: p.position, target: pendingSpot, fov: p.fov } },
            extras: { view: { yaw: p.angles[1], pitch: p.angles[0], distance } }
        });
        pendingSpot = null;
        $('#annotation-form').reset();
        $('#annotation-form').hidden = true;
        saveDraft();
        render();
        setStatus('Annotation saved.');
        await startViewer();
    });
    $('#ann-cancel').addEventListener('click', () => {
        pendingSpot = null;
        $('#annotation-form').reset();
        $('#annotation-form').hidden = true;
    });

    $('#preview').addEventListener('click', async () => {
        previewing = !previewing;
        render();
        setStatus(previewing ? 'Showing the scene as visitors get it.' : 'Editing: limits are off.');
        await startViewer();
    });

    const download = (name, data) => {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' }));
        link.download = name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    };
    // Named after the scene, so Publish Scene can match them to it (and never to another one).
    $('#download-limits').addEventListener('click', () => download(`${folder.name}.limits.json`, buildLimits()));
    // the current view as the portfolio picture: a supersampled 1600 x 1000 render, as WebP
    $('#download-poster').addEventListener('click', async () => {
        setStatus('Rendering the poster…');
        const shot = await viewer.captureFrame({ width: 1600, height: 1000, supersample: 2 });
        const bytes = Uint8ClampedArray.from(atob(shot.data), (c) => c.charCodeAt(0));
        const canvas = document.createElement('canvas');
        canvas.width = shot.width;
        canvas.height = shot.height;
        canvas.getContext('2d').putImageData(new ImageData(bytes, shot.width, shot.height), 0, 0);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.85));
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${folder.name}.poster.webp`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        setStatus(`Poster saved as ${folder.name}.poster.webp.`);
    });
    $('#download-settings').addEventListener('click', () => download(`${folder.name}.settings.json`, draft.settings));
    $('#reset-draft').addEventListener('click', async () => {
        draft = draftFrom(scene.limits, structuredClone(scene.settings));
        saveDraft();
        render();
        setStatus('Back to the files on the hosting.');
        await startViewer();
    });

    // a live readout, so the numbers behind the buttons are visible
    setInterval(() => {
        const p = pose();
        if (p) {
            $('#pose').textContent = `${p.mode} · turn ${round(p.angles[1], 1)}° · tilt ${round(p.angles[0], 1)}° · ${round(p.distance, 2)} m`;
        }
    }, 250);
};

// for checking the editor from the browser console (and tests): read-only views of the draft
window.editor = { draft: () => structuredClone(draft), limits: () => buildLimits() };

// ---- start --------------------------------------------------------------------------------

const draftFrom = (limits, settings) => {
    const marks = {};
    const orbit = limits?.orbit;
    if (orbit?.yaw) [marks.left, marks.right] = orbit.yaw;
    if (orbit?.pitch) [marks.low, marks.high] = orbit.pitch;
    if (orbit?.distance) [marks.near, marks.far] = orbit.distance;
    return {
        mode: limits?.mode ?? null,
        marks,
        pan: orbit?.pan === false ? 'locked' : Array.isArray(orbit?.pan) ? 'box' : 'free',
        panBox: Array.isArray(orbit?.pan) ? orbit.pan : null,
        fence: limits?.walk?.fence ?? [],
        startYaw: undefined,
        settings
    };
};

if (!folder) {
    $('#title').textContent = 'No scene chosen';
    setStatus('Add ?scene=name to the address.');
} else {
    $('#title').textContent = `Scene: ${folder.name}`;
    try {
        scene = await loadScene(folder, defaultSettings);
        const saved = storedDraft();
        draft = saved ?? draftFrom(scene.limits, scene.settings);
        if (saved) {
            setStatus('Continuing your unsaved draft from last time.');
        }
        wire();
        render();
        await startViewer();
    } catch (error) {
        setStatus(`This scene could not be loaded. ${error.message}`);
    }
}
