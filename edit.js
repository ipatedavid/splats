// Scene editor: records camera limits, a walking fence, the start view and annotations from
// the live view, and hands them over as limits.json and settings.json to upload.
import { createViewer, defaultSettings } from './index.js';
import { sceneFolder, loadScene } from './scene.js';
import { storyPoseAt } from './story.js';

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

const MODES = ['orbit', 'walk', 'fly'];

// Scene types: sensible defaults for the modes and what the camera bumps into. Anything changed
// in the mode tabs that doesn't match one makes the scene Custom.
const PRESETS = {
    object: { modes: ['orbit'], mode: 'orbit', collision: { orbit: true, fly: true }, holdOrbit: false },
    room: { modes: ['orbit', 'walk'], mode: 'walk', collision: { orbit: true, fly: true }, holdOrbit: false },
    place: { modes: ['orbit', 'walk', 'fly'], mode: 'orbit', collision: { orbit: true, fly: true }, holdOrbit: false }
};
const PRESET_HINTS = {
    object: 'Visitors circle one subject, orbit only. Fix the point they circle under Orbit.',
    room: 'Visitors walk through the space and can switch to orbit. Close openings under Walk.',
    place: 'Visitors orbit, walk and fly, within the captured space.',
    custom: 'Your own mix: set in the Orbit, Walk and Fly tabs.'
};
const presetOf = () => {
    const modes = MODES.filter((m) => draft.modes.includes(m));
    return Object.keys(PRESETS).find((name) => {
        const p = PRESETS[name];
        return p.modes.join() === modes.join() && p.mode === startMode() &&
            p.collision.orbit === draft.collision.orbit && p.collision.fly === draft.collision.fly &&
            p.holdOrbit === draft.holdOrbit;
    }) ?? 'custom';
};
const MODE_LABELS = { orbit: 'Orbit', walk: 'Walk', fly: 'Fly' };

// The modes visitors get, in a fixed order, and the one they start in. All three with no
// start chosen is the stock viewer: every mode and its intro animation.
const allowed = () => MODES.filter((mode) => draft.modes.includes(mode));
const startMode = () => {
    const modes = allowed();
    if (modes.length === MODES.length && !draft.mode) return null;
    return modes.includes(draft.mode) ? draft.mode : modes[0];
};

const buildLimits = () => {
    const m = draft.marks;
    const limits = {};
    const modes = allowed();
    const start = startMode();
    if (start) {
        limits.mode = start;
        if (modes.length > 1) {
            limits.modes = modes;
        }
    }
    if (modes.includes('orbit')) {
        const orbit = {};
        if (draft.orbitTarget) {
            orbit.target = draft.orbitTarget.map((v) => round(v, 3));
            if (draft.orbitNudge > 0) {
                orbit.targetPan = draft.orbitNudge;
            }
        }
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
        if (Object.keys(orbit).length || start === 'orbit') {
            limits.orbit = orbit;
        }
    }
    limits.preset = presetOf();
    limits.collision = { ...draft.collision };
    limits.edge = draft.edge;
    // walls and the fence hold walking and the orbit camera
    if (modes.includes('walk') || modes.includes('orbit')) {
        const walk = {};
        if (draft.fence.length >= 3) {
            walk.fence = draft.fence.map(([x, z]) => [round(x, 3), round(z, 3)]);
        }
        if (draft.walls?.length) {
            // [x1, z1, x2, z2, ground height]; the height is only for drawing them here
            walk.walls = draft.walls.map(({ a, b, y }) => [...a, ...b, y ?? 0].map((v) => round(v, 3)));
        }
        if (draft.holdOrbit && (walk.walls || walk.fence)) {
            walk.holdOrbit = true;
        }
        if (draft.floor !== null && modes.includes('walk')) {
            walk.floor = round(draft.floor, 3);
        }
        if (Object.keys(walk).length) {
            limits.walk = walk;
        }
    }
    return limits;
};

// What the saved files would hold; the draft remembers it as `saved` when they were last
// saved (or loaded from the site), so the header can say when there is something unsaved.
const filesKey = () => JSON.stringify({ limits: buildLimits(), settings: draft.settings });

// ---- the viewer ---------------------------------------------------------------------------

// Restarts happen one at a time, and only the last one asked for survives: quick clicks on
// Try as a visitor, the background colour or annotations never leave two viewers stacked.
let restarting = Promise.resolve();
let restartWanted = 0;
const startViewer = () => {
    const ticket = ++restartWanted;
    restarting = restarting.then(() => (ticket === restartWanted ? restartViewer() : undefined)).catch((error) => {
        setStatus(`The viewer could not start. ${error.message}`);
    });
    return restarting;
};

const restartViewer = async () => {
    viewer?.destroy();
    viewer = null;
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
    drawWalls();
    viewer.setFloor?.(draft.modes.includes('walk') ? draft.floor : null);
    // the collision view: the viewer offers it once the collision data is in (and on WebGPU)
    const showCollision = () => {
        const available = Boolean(viewer?.state.hasCollisionOverlay);
        $('#show-collision').disabled = !available;
        $('#show-collision').checked = available && Boolean(draft.showCollision);
        if (available) viewer.state.collisionOverlayEnabled = Boolean(draft.showCollision);
        $('#collision-note').textContent = available
            ? ''
            : scene.collisionUrl
              ? 'The collision view appears once the collision data has loaded. It needs a browser running WebGPU (recent Chrome or Edge).'
              : 'This scene has no collision yet: make it in SuperSplat Studio and publish it with the scene.';
        $('#collision-note').hidden = available;
    };
    viewer.events.on('hasCollisionOverlay:changed', showCollision);
    viewer.events.on('collisionOverlayEnabled:changed', (on) => {
        $('#show-collision').checked = on;
    });
    showCollision();
    // the edge is found from the splat, so its size shows once that has loaded
    viewer.events.on('loaded:changed', (loaded) => loaded && setTimeout(() => ($('#out-edge').textContent = describeEdge()), 1500));
    // Skip the intro animation: it would swallow the first button press, and dragging during it
    // drops into fly mode with the mouse captured. The camera is set up once the scene has
    // loaded, so switch then.
    if (!limits?.mode) {
        const current = viewer;
        const leaveAnimation = () => {
            if (current === viewer && viewer.state.cameraMode === 'anim') {
                // the open mode tab's mode, so its settings can be recorded straight away
                const tab = document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.tab;
                const wanted = allowed().includes(tab) ? tab : startMode();
                viewer.state.cameraMode = wanted === 'walk'
                    ? (viewer.state.walkAllowed ? 'walk' : 'fly')
                    : wanted === 'fly' ? 'fly' : 'orbit';
            }
        };
        viewer.events.on('cameraMode:changed', (mode) => mode === 'anim' && setTimeout(leaveAnimation, 0));
        viewer.events.on('loaded:changed', (loaded) => loaded && setTimeout(leaveAnimation, 0));
        leaveAnimation();
    }
};

const pose = () => viewer?.cameraPose();

// The scene edge, computed by the viewer from the splat; shown for a moment when it changes.
const currentEdge = () => (draft.edge === 'off' ? null : (viewer?.sceneEdge?.(draft.edge) ?? null));
const describeEdge = () => {
    if (draft.edge === 'off') return 'Off: nothing holds visitors at the edge of the splat.';
    const edge = currentEdge();
    if (!edge) return 'Found once the splat has loaded.';
    const xs = edge.segments.flatMap(([x1, , x2]) => [x1, x2]);
    const zs = edge.segments.flatMap(([, z1, , z2]) => [z1, z2]);
    const span = (v) => round(Math.max(...v) - Math.min(...v), 1);
    return `Follows the captured space: about ${span(xs)} × ${span(zs)} m across, ${round(edge.top - edge.bottom, 1)} m high`;
};
let edgeTimer = 0;
const previewEdge = () => {
    clearTimeout(edgeTimer);
    viewer?.showEdge?.(currentEdge());
    edgeTimer = setTimeout(() => viewer?.showEdge?.(null), 4000);
};

// The walls as orange panels, while editing only (visitors never see them).
const drawWalls = () => {
    if (!viewer?.showWalls) return;
    if (previewing) {
        viewer.showWalls([]);
        return;
    }
    const fallbackY = (pose()?.position[1] ?? 1.5) - 1.5;
    viewer.showWalls((draft.walls ?? []).map(({ a, b, y }) => ({ a, b, y: y ?? fallbackY })));
};

const MAX_WALL_REACH = 15;

// A wall across the opening in front of the camera, reaching sideways until it meets the
// collision on each side (looked for at knee, waist and chest height, so low planters count).
const blockThisWay = async () => {
    if (viewer.state.cameraMode !== 'walk' && viewer.state.cameraMode !== 'fly') {
        if (viewer.state.walkAllowed) viewer.state.cameraMode = 'walk';
        setStatus('Switched to walking. Walk into the opening, face out of the area, and press again.');
        return;
    }
    const p = pose();
    const fx = p.focus[0] - p.position[0];
    const fz = p.focus[2] - p.position[2];
    const flat = Math.hypot(fx, fz);
    if (flat < 1e-6) {
        setStatus('Face along the ground, not straight up or down, then press again.');
        return;
    }
    const [dirX, dirZ] = [fx / flat, fz / flat];
    const down = await viewer.collisionDistance(p.position, [0, -1, 0], 10);
    const ground = down === null ? p.position[1] - 1.5 : p.position[1] - down;
    const cx = p.position[0] + dirX * 0.6;
    const cz = p.position[2] + dirZ * 0.6;
    const reach = async (side) => {
        let nearest = null;
        for (const h of [0.3, 0.8, 1.4]) {
            const d = await viewer.collisionDistance([cx, ground + h, cz], [-dirZ * side, 0, dirX * side], MAX_WALL_REACH);
            if (d !== null && (nearest === null || d < nearest)) nearest = d;
        }
        return nearest;
    };
    const [left, right] = [await reach(1), await reach(-1)];
    if ((left ?? 1) < 0.05 && (right ?? 1) < 0.05) {
        setStatus('That spot is inside something solid. Step back into the open and press again.');
        return;
    }
    const l = (left ?? MAX_WALL_REACH) + 0.15;
    const r = (right ?? MAX_WALL_REACH) + 0.15;
    const a = [cx - dirZ * l, cz + dirX * l];
    const b = [cx + dirZ * r, cz - dirX * r];
    draft.walls = [...(draft.walls ?? []), { a, b, y: ground, open: [left === null, right === null] }];
    saveDraft();
    render();
    const open = left === null || right === null;
    setStatus(`Wall added, ${round(l + r, 1)} m wide.` + (open
        ? ` One end found nothing within ${MAX_WALL_REACH} m, so it stops there; check it with Try as a visitor.`
        : ''));
};

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
    const modes = allowed();
    const startIn = startMode();
    for (const input of document.querySelectorAll('input[name="modes"]')) {
        input.checked = modes.includes(input.value);
        // at least one mode: the last ticked one cannot be unticked
        input.disabled = modes.length === 1 && input.checked;
    }
    const select = $('#start-mode');
    select.replaceChildren(
        ...(modes.length === MODES.length ? [new Option('Automatic (with the intro animation)', '')] : []),
        ...modes.map((mode) => new Option(MODE_LABELS[mode], mode))
    );
    select.value = startIn ?? '';
    $('#start-row').hidden = modes.length < 2;
    // each mode's tab: its settings, or a note and a button when visitors don't get it
    for (const mode of MODES) {
        const on = modes.includes(mode);
        $(`[data-off="${mode}"]`).hidden = on;
        $(`[data-on="${mode}"]`).hidden = !on;
        $(`#tab-${mode}`).classList.toggle('off', !on);
    }
    // the orbit camera can be held by the walls drawn while walking
    $('#walls-orbit').closest('label').hidden = !(draft.walls?.length || draft.fence.length);
    const names = modes.map((mode) => MODE_LABELS[mode].toLowerCase());
    $('#mode-hint').textContent = !startIn
        ? 'Visitors switch freely between orbit, walk and fly and get the intro animation. Limits still apply.'
        : modes.length === 1
          ? `Visitors only ${names[0]}. The animation is a Tour button.`
          : `Visitors start in ${MODE_LABELS[startIn].toLowerCase()} and can switch to ${names.filter((n) => n !== MODE_LABELS[startIn].toLowerCase()).join(' and ')}. The animation is a Tour button.`;
    $('#out-orbit-point').textContent = draft.orbitTarget
        ? `fixed at ${draft.orbitTarget.map((v) => round(v, 2)).join(', ')}`
        : 'not fixed: visitors can pan and click a new point';
    $('#pan-row').hidden = Boolean(draft.orbitTarget);
    $('#nudge-row').hidden = !draft.orbitTarget;
    $('#nudge-hint').hidden = !draft.orbitTarget || !(draft.orbitNudge > 0);
    $('#orbit-nudge').value = String(draft.orbitNudge ?? 0);
    $('#stop-walls').checked = draft.collision.orbit;
    $('#flat-floor').checked = draft.floor !== null;
    $('#floor-height-tools').hidden = draft.floor === null;
    if (document.activeElement !== $('#floor-height')) $('#floor-height').value = String(draft.floor ?? draft.floorHeight ?? 0);
    viewer?.setFloor?.(modes.includes('walk') ? draft.floor : null);
    $('#stay-in').checked = draft.edge !== 'off';
    $('#edge-row').hidden = draft.edge === 'off';
    for (const input of document.querySelectorAll('input[name="edge"]')) {
        input.checked = input.value === (draft.edge === 'off' ? draft.edgeTightness : draft.edge);
    }
    $('#out-edge').textContent = describeEdge();

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
    const hasLimits = Object.keys(m).length > 0 || draft.pan !== 'free' || Boolean(draft.orbitTarget);
    $('#clear-orbit').disabled = !hasLimits;

    const wallList = $('#walls');
    wallList.replaceChildren();
    (draft.walls ?? []).forEach((wall, index) => {
        const item = document.createElement('li');
        const row = document.createElement('div');
        row.className = 'row';
        const label = document.createElement('span');
        const width = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
        label.textContent = `${round(width, 1)} m wide` + (wall.open?.some(Boolean) ? ' · one end open' : '');
        const remove = document.createElement('button');
        remove.className = 'quiet';
        remove.textContent = 'Remove';
        remove.addEventListener('click', () => {
            draft.walls.splice(index, 1);
            saveDraft();
            render();
        });
        row.append(label, remove);
        item.append(row);
        wallList.append(item);
    });
    drawWalls();

    $('#clear-walls').disabled = !draft.walls?.length;
    $('#old-fence').hidden = draft.fence.length === 0;
    $('#out-fence').textContent = `This scene has a fence from before (${draft.fence.length} corners); the box does its job now.`;
    const preset = presetOf();
    for (const input of document.querySelectorAll('input[name="preset"]')) {
        input.checked = input.value === preset;
    }
    $('#preset-hint').textContent = PRESET_HINTS[preset];
    $('#collide-fly').checked = draft.collision.fly;
    $('#walls-orbit').checked = draft.holdOrbit;

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
        item.append(row, annotationLimitsControls(annotation, index));
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
    $('#out-start').textContent = start
        ? `Saved: ${round(startDistance, 1)} m from what it looks at.`
        : "Not set: the scene opens on the viewer's own view.";
    $('#start-warning').hidden = !startOff;
    $('#start-warning').textContent = startOff
        ? `The start view circles a point ${round(startDistance, 1)} m away, outside the zoom limits, ` +
          'so visitors would orbit around the wrong spot. Click the subject, then press Use this view.'
        : '';
    $('#preview').setAttribute('aria-pressed', String(previewing));
    $('#preview').textContent = previewing ? 'Back to editing' : 'Try as a visitor';
    renderStory();
    showDirty();
};

const showDirty = () => {
    $('#dirty').hidden = filesKey() === draft.saved;
};

// ---- the scroll story ---------------------------------------------------------------------

const keyframes = () => draft.settings.story?.keyframes ?? [];
const smoothness = () => draft.settings.story?.smoothness ?? 1;
const roundAll = (v) => v.map((x) => round(x, 4));

// the keyframe the camera was last sent to, outlined in the list
let currentKey = null;

const setKeyframes = (list) => {
    if (list.length) {
        draft.settings.story = { ...(draft.settings.story ?? {}), keyframes: list };
    } else {
        delete draft.settings.story;
    }
    saveDraft();
    render();
};

const goToKey = (index) => {
    const k = keyframes()[index];
    if (!k || !viewer) return;
    viewer.setCameraPose(k.position, k.target, k.fov);
    currentKey = index;
    $('#story-scrub').value = String(index);
    renderStory();
};

const renderStory = () => {
    const list = keyframes();
    $('#story-empty').hidden = list.length > 0;
    $('#story-tools').hidden = list.length < 2;
    $('#story-scrub').max = String(Math.max(1, list.length - 1));
    $('#story-smooth').value = String(smoothness());
    const items = list.map((k, index) => {
        const item = document.createElement('li');
        item.classList.toggle('current', index === currentKey);
        const head = document.createElement('div');
        head.className = 'key-head';
        const title = document.createElement('input');
        title.value = k.title ?? '';
        title.placeholder = 'Title (optional)';
        title.maxLength = 80;
        title.setAttribute('aria-label', `Keyframe ${index + 1} title`);
        title.addEventListener('input', () => {
            k.title = title.value;
            saveDraft();
            showDirty();
        });
        head.append(title);
        const text = document.createElement('textarea');
        text.rows = 2;
        text.maxLength = 400;
        text.value = k.text ?? '';
        text.placeholder = 'Caption (optional)';
        text.setAttribute('aria-label', `Keyframe ${index + 1} caption`);
        text.addEventListener('input', () => {
            k.text = text.value;
            saveDraft();
            showDirty();
        });
        const actions = document.createElement('div');
        actions.className = 'key-actions';
        const action = (label, run, disabled = false, quiet = false) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            b.disabled = disabled;
            if (quiet) b.className = 'quiet';
            b.addEventListener('click', run);
            actions.append(b);
        };
        action('Go to', () => goToKey(index));
        action('Use this view', () => {
            const p = pose();
            Object.assign(k, { position: roundAll(p.position), target: roundAll(p.focus), fov: round(p.fov, 2) });
            currentKey = index;
            setKeyframes(list);
            setStatus(`Keyframe ${index + 1} now uses this view.`);
        });
        action('↑', () => {
            [list[index - 1], list[index]] = [list[index], list[index - 1]];
            currentKey = index - 1;
            setKeyframes(list);
        }, index === 0, true);
        action('↓', () => {
            [list[index + 1], list[index]] = [list[index], list[index + 1]];
            currentKey = index + 1;
            setKeyframes(list);
        }, index === list.length - 1, true);
        action('Delete', () => {
            list.splice(index, 1);
            currentKey = null;
            setKeyframes(list);
        }, false, true);
        actions.lastChild.setAttribute('aria-label', `Delete keyframe ${index + 1}`);
        item.append(head, text, actions);
        return item;
    });
    // typing changes the draft without a render, so a rebuild here never steals the focus;
    // rebuild only when something did change
    const shape = JSON.stringify([list, currentKey]);
    if ($('#keyframes').dataset.shape !== shape) {
        $('#keyframes').replaceChildren(...items);
        $('#keyframes').dataset.shape = shape;
    }
};

// ---- an annotation's own limits -----------------------------------------------------------

// How close and how far visitors may zoom while orbiting an annotation. Kept in the
// annotation's extras.limits and recorded from the view, like the orbit limits. (Panning needs
// no limit: visitors' cameras stop at the collision, walls and fence, and stay in the splat.)
const setAnnotationLimits = (index, change) => {
    const annotation = draft.settings.annotations[index];
    const own = { ...(annotation.extras?.limits ?? {}), ...change };
    for (const key of Object.keys(own)) {
        if (own[key] === undefined) delete own[key];
    }
    if (own.closest !== undefined && own.furthest !== undefined && own.closest > own.furthest) {
        [own.closest, own.furthest] = [own.furthest, own.closest];
    }
    annotation.extras = { ...(annotation.extras ?? {}) };
    if (Object.keys(own).length) {
        annotation.extras.limits = own;
    } else {
        delete annotation.extras.limits;
    }
    saveDraft();
    render();
};

const recordAnnotationZoom = (index, end) => {
    if (viewer?.state.selectedAnnotation !== index || viewer.state.cameraMode !== 'orbit') {
        setStatus('Press Show on this annotation first, zoom to the edge, then press the button again.');
        return;
    }
    const distance = round(pose().distance, 3);
    setAnnotationLimits(index, { [end]: distance });
    setStatus(`${end === 'closest' ? 'Closest' : 'Furthest'} zoom for this annotation: ${round(distance, 2)} m.`);
};

const describeZoom = (own) => {
    if (own.closest !== undefined && own.furthest !== undefined) return `zoom ${round(own.closest, 2)} m to ${round(own.furthest, 2)} m`;
    if (own.furthest !== undefined) return `zoom out to ${round(own.furthest, 2)} m`;
    if (own.closest !== undefined) return `zoom in to ${round(own.closest, 2)} m`;
    return 'zoom not limited';
};

const annotationLimitsControls = (annotation, index) => {
    const own = annotation.extras?.limits ?? {};
    const box = document.createElement('div');
    box.className = 'ann-limits';

    const zoom = document.createElement('div');
    zoom.className = 'row';
    for (const [end, text] of [['closest', 'Closest here'], ['furthest', 'Furthest here']]) {
        const button = document.createElement('button');
        button.textContent = text;
        button.classList.toggle('active', own[end] !== undefined);
        button.addEventListener('click', () => recordAnnotationZoom(index, end));
        zoom.append(button);
    }

    const summary = document.createElement('div');
    summary.className = 'row';
    const out = document.createElement('output');
    out.textContent = describeZoom(own);
    summary.append(out);
    if (Object.keys(own).length) {
        const clear = document.createElement('button');
        clear.className = 'quiet';
        clear.textContent = 'Clear';
        clear.addEventListener('click', () =>
            setAnnotationLimits(index, { closest: undefined, furthest: undefined }));
        summary.append(clear);
    }
    box.append(zoom, summary);
    return box;
};

// An annotation whose view sits outside the orbit limits (its own, or the scene's) snaps back
// when visitors open it.
const annotationWarning = (annotation, limits) => {
    const view = annotation.extras?.view;
    const own = annotation.extras?.limits ?? {};
    // the flight to an annotation's view is not held by the edge: keep the view inside it
    const from = annotation.camera?.initial?.position;
    const edge = currentEdge();
    if (from && edge && edge.outside(from) > 0.01) {
        return 'Its view is outside the scene edge; re-save it from inside, or loosen the edge.';
    }
    if (view && (view.distance < (own.closest ?? 0) * 0.98 || view.distance > (own.furthest ?? Infinity) * 1.02)) {
        return 'Its view is outside its own zoom limits; re-save it, or record the limits again.';
    }
    const orbit = limits.orbit;
    if (!view || !orbit) {
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
    const ownZoom = own.closest !== undefined || own.furthest !== undefined;
    if (!ownZoom && orbit.distance && (view.distance < orbit.distance[0] * 0.98 || view.distance > orbit.distance[1] * 1.02)) {
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

    // Tabs. Opening a camera mode's tab also switches the view to that mode, since its settings
    // are recorded from it.
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const openTab = (name) => {
        for (const tab of tabs) {
            const selected = tab.dataset.tab === name;
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
            $(`#pane-${tab.dataset.tab}`).hidden = !selected;
        }
        try {
            localStorage.setItem('splat-editor:tab', name);
        } catch {
            // storage off: the tab is just not remembered
        }
        if (viewer && !previewing && allowed().includes(name) && viewer.state.cameraMode !== name) {
            if (name !== 'walk' || viewer.state.walkAllowed) {
                viewer.state.cameraMode = name;
            } else {
                setStatus('Walking needs the collision data; it starts once that has loaded.');
            }
        }
    };
    for (const tab of tabs) {
        tab.addEventListener('click', () => openTab(tab.dataset.tab));
        tab.addEventListener('keydown', (event) => {
            const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
            if (!step) return;
            const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length];
            next.focus();
            openTab(next.dataset.tab);
        });
    }
    let remembered = 'scene';
    try {
        remembered = localStorage.getItem('splat-editor:tab') ?? 'scene';
    } catch {
        // storage off
    }
    openTab(tabs.some((t) => t.dataset.tab === remembered) ? remembered : 'scene');
    for (const button of document.querySelectorAll('[data-enable]')) {
        button.addEventListener('click', () => {
            if (!draft.modes.includes(button.dataset.enable)) draft.modes = [...draft.modes, button.dataset.enable];
            saveDraft();
            render();
            openTab(button.dataset.enable);
        });
    }

    for (const input of document.querySelectorAll('input[name="modes"]')) {
        input.addEventListener('change', () => {
            draft.modes = input.checked ? [...draft.modes, input.value] : draft.modes.filter((m) => m !== input.value);
            if (input.checked && allowed().length === 1) {
                draft.mode = input.value;
            }
            saveDraft();
            render();
        });
    }
    $('#start-mode').addEventListener('change', () => {
        draft.mode = $('#start-mode').value || null;
        saveDraft();
        render();
        const start = startMode();
        if (viewer && start === 'orbit') {
            viewer.state.cameraMode = 'orbit';
        } else if (viewer && start === 'walk' && viewer.state.walkAllowed) {
            viewer.state.cameraMode = 'walk';
        }
    });
    for (const input of document.querySelectorAll('input[name="edge"]')) {
        input.addEventListener('change', () => {
            draft.edge = draft.edgeTightness = input.value;
            saveDraft();
            render();
            previewEdge();
        });
    }
    $('#stay-in').addEventListener('change', () => {
        draft.edge = $('#stay-in').checked ? (draft.edgeTightness ?? 'normal') : 'off';
        saveDraft();
        render();
        previewEdge();
    });
    $('#show-collision').addEventListener('change', () => {
        draft.showCollision = $('#show-collision').checked;
        saveDraft();
        if (viewer?.state.hasCollisionOverlay) viewer.state.collisionOverlayEnabled = draft.showCollision;
    });
    $('#stop-walls').addEventListener('change', () => {
        draft.collision = { ...draft.collision, orbit: $('#stop-walls').checked };
        saveDraft();
        render();
    });
    $('#orbit-nudge').addEventListener('change', () => {
        draft.orbitNudge = Number($('#orbit-nudge').value);
        saveDraft();
        render();
    });
    $('#orbit-point').addEventListener('click', () => {
        if (!ensureOrbit()) return;
        // a first orbit point lets visitors nudge the view a little
        if (!draft.orbitTarget) draft.orbitNudge = 0.3;
        draft.orbitTarget = pose().focus;
        saveDraft();
        render();
        setStatus('Orbit point fixed at the current focus. Set the start view from here too.');
    });
    $('#clear-orbit-point').addEventListener('click', () => {
        draft.orbitTarget = null;
        saveDraft();
        render();
    });

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
        draft.orbitTarget = null;
        saveDraft();
        render();
    });

    $('#add-keyframe').addEventListener('click', () => {
        const p = pose();
        if (!p) return;
        const list = [...keyframes(), { position: roundAll(p.position), target: roundAll(p.focus), fov: round(p.fov, 2), title: '', text: '' }];
        currentKey = list.length - 1;
        setKeyframes(list);
        setStatus(`Keyframe ${list.length} added.` + (list.length === 1 ? ' Move to the next view and add another.' : ''));
    });
    $('#story-scrub').addEventListener('input', () => {
        const list = keyframes();
        if (!viewer || list.length < 2) return;
        const at = storyPoseAt(list, Number($('#story-scrub').value), smoothness());
        viewer.setCameraPose(at.position, at.target, at.fov, 0.08);
        currentKey = null;
    });
    $('#story-smooth').addEventListener('change', () => {
        draft.settings.story = { ...draft.settings.story, smoothness: Number($('#story-smooth').value) };
        saveDraft();
        render();
    });
    $('#preview-story').addEventListener('click', () => {
        saveDraft();
        const query = new URLSearchParams({ scene: folder.name, draft: '1' });
        for (const key of ['base', 'webgl']) {
            if (params.has(key)) query.set(key, params.get(key));
        }
        window.open(`story.html?${query}`, '_blank', 'noopener');
    });

    $('#block-way').addEventListener('click', () => blockThisWay());
    $('#clear-walls').addEventListener('click', () => {
        draft.walls = [];
        saveDraft();
        render();
    });

    for (const input of document.querySelectorAll('input[name="preset"]')) {
        input.addEventListener('change', () => {
            const p = PRESETS[input.value];
            draft.modes = [...p.modes];
            draft.mode = p.mode;
            draft.collision = { ...p.collision };
            draft.holdOrbit = p.holdOrbit;
            saveDraft();
            render();
            if (viewer && p.mode === 'orbit') viewer.state.cameraMode = 'orbit';
            else if (viewer && p.mode === 'walk' && viewer.state.walkAllowed) viewer.state.cameraMode = 'walk';
            setStatus(input.value === 'object' && !draft.orbitTarget
                ? 'Object: click the subject, then press Fix at the current focus under Orbit.'
                : `${input.value[0].toUpperCase()}${input.value.slice(1)} settings applied.`);
        });
    }
    for (const [id, key] of [['#collide-fly', 'fly']]) {
        $(id).addEventListener('change', () => {
            draft.collision = { ...draft.collision, [key]: $(id).checked };
            saveDraft();
            render();
        });
    }
    $('#walls-orbit').addEventListener('change', () => {
        draft.holdOrbit = $('#walls-orbit').checked;
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
        if (startMode() === 'orbit' && !ensureOrbit()) return;
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
    $('#flat-floor').addEventListener('change', () => {
        draft.floor = $('#flat-floor').checked ? (draft.floorHeight ?? 0) : null;
        saveDraft();
        render();
    });
    $('#floor-height').addEventListener('change', () => {
        const value = Number($('#floor-height').value);
        draft.floorHeight = Number.isFinite(value) ? round(value, 3) : 0;
        if (draft.floor !== null) draft.floor = draft.floorHeight;
        saveDraft();
        render();
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
    $('#save-files').addEventListener('click', () => {
        download(`${folder.name}.limits.json`, buildLimits());
        // a second download right away can be blocked as "multiple downloads"; a beat apart is fine
        setTimeout(() => download(`${folder.name}.settings.json`, draft.settings), 400);
        draft.saved = filesKey();
        saveDraft();
        render();
        setStatus(`Saved ${folder.name}.limits.json and ${folder.name}.settings.json to Downloads.`);
    });
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
    $('#reset-draft').addEventListener('click', async () => {
        scene = await loadScene(folder, defaultSettings);  // the site as it is now
        draft = draftFrom(scene.limits, structuredClone(scene.settings));
        draft.saved = filesKey();
        saveDraft();
        render();
        setStatus('Back to the files on the site.');
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
        modes: limits?.modes?.length ? [...limits.modes] : limits?.mode ? [limits.mode] : [...MODES],
        orbitTarget: orbit?.target ?? null,
        collision: { orbit: limits?.collision?.orbit ?? true, fly: limits?.collision?.fly ?? true },
        orbitNudge: orbit?.targetPan ?? 0,
        floor: limits?.walk?.floor ?? null,
        floorHeight: limits?.walk?.floor ?? 0,
        holdOrbit: Boolean(limits?.walk?.holdOrbit),
        edge: limits?.edge ?? 'normal',
        edgeTightness: !limits?.edge || limits.edge === 'off' ? 'normal' : limits.edge,
        marks,
        pan: orbit?.pan === false ? 'locked' : Array.isArray(orbit?.pan) ? 'box' : 'free',
        panBox: Array.isArray(orbit?.pan) ? orbit.pan : null,
        fence: limits?.walk?.fence ?? [],
        walls: (limits?.walk?.walls ?? []).map((w) => ({ a: [w[0], w[1]], b: [w[2], w[3]], y: w[4] ?? null, open: [false, false] })),
        startYaw: undefined,
        settings,
        base: siteVersion()
    };
};

// What the site's files were when a draft started; a draft from different files is stale.
const siteVersion = () => JSON.stringify({ settings: scene.hasSettings ? scene.settings : null, limits: scene.limits ?? null });

if (!folder) {
    $('#title').textContent = 'No scene chosen';
    setStatus('Add ?scene=name to the address.');
} else {
    $('#title').textContent = `Scene: ${folder.name}`;
    try {
        scene = await loadScene(folder, defaultSettings);
        const saved = storedDraft();
        if (saved && saved.base === siteVersion()) {
            draft = saved;
            draft.modes ??= draft.mode ? [draft.mode] : [...MODES];
            draft.orbitTarget ??= null;
            draft.edge ??= 'normal';
            draft.edgeTightness ??= draft.edge === 'off' ? 'normal' : draft.edge;
            draft.orbitNudge ??= 0;
            draft.floor ??= null;
            draft.floorHeight ??= draft.floor ?? 0;
            draft.collision ??= { orbit: true, fly: true };
            draft.holdOrbit ??= false;
            draft.saved ??= null;
            draft.modes = MODES.filter((m) => draft.modes.includes(m));
            if (filesKey() !== draft.saved) setStatus('Continuing your unsaved changes from last time.');
        } else {
            draft = draftFrom(scene.limits, structuredClone(scene.settings));
            draft.saved = filesKey();
            if (saved) {
                saveDraft();
                setStatus("The scene changed on the site since your last draft, so this starts from the site's version.");
            }
        }
        wire();
        render();
        await startViewer();
    } catch (error) {
        setStatus(`This scene could not be loaded. ${error.message}`);
    }
}
