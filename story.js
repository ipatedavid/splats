// Scroll stories: a splat that moves as the page scrolls. A scene's story is a list of
// keyframes (a camera pose each, with an optional caption) kept in its settings.json as
// `story`; the editor records them. The camera passes keyframe i exactly when section i's
// middle crosses the middle of the window, and glides along a smooth path in between.

const FRAME_RATE = 30;

/** The keyframes of a story that can be played: at least one, each with a whole pose. */
export const storyKeyframes = (story) =>
    (Array.isArray(story?.keyframes) ? story.keyframes : []).filter(
        (k) => [k?.position, k?.target].every((v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)) &&
            Number.isFinite(k.fov)
    );

/**
 * The story as a viewer animation track: keyframe i at time i seconds. A single keyframe is
 * held, so there is still a path to stand on.
 */
export const storyTrack = (keyframes, smoothness = 1) => {
    const keys = keyframes.length === 1 ? [keyframes[0], keyframes[0]] : keyframes;
    return {
        name: 'story',
        duration: keys.length - 1,
        frameRate: FRAME_RATE,
        loopMode: 'none',
        interpolation: 'spline',
        smoothness,
        keyframes: {
            times: keys.map((_, i) => i * FRAME_RATE),
            values: {
                position: keys.flatMap((k) => k.position),
                target: keys.flatMap((k) => k.target),
                fov: keys.map((k) => k.fov)
            }
        }
    };
};

/**
 * The pose `time` keyframes along the path (1.5 = halfway from the second to the third), the
 * same cubic curve the viewer plays (its CubicSpline.fromPoints), for scrubbing in the editor.
 */
export const storyPoseAt = (keyframes, time, smoothness = 1) => {
    const n = keyframes.length;
    const point = (k) => [...k.position, ...k.target, k.fov];
    if (n === 1 || time <= 0) return poseOf(point(keyframes[0]));
    if (time >= n - 1) return poseOf(point(keyframes[n - 1]));
    const points = keyframes.map(point);
    // tangents as the viewer makes them, for keys one time unit apart
    const tangent = (i, j) =>
        i === 0 ? points[1][j] - points[0][j]
            : i === n - 1 ? points[i][j] - points[i - 1][j]
                : (points[i + 1][j] - points[i - 1][j]) / 2;
    const seg = Math.floor(time);
    const t = time - seg;
    const t2 = t * t;
    const omt = 1 - t;
    const omt2 = omt * omt;
    return poseOf(points[seg].map((p0, j) => {
        const m0 = tangent(seg, j) * smoothness;
        const m1 = tangent(seg + 1, j) * smoothness;
        const p1 = points[seg + 1][j];
        return p0 * ((1 + 2 * t) * omt2) + m0 * (t * omt2) + p1 * (t2 * (3 - 2 * t)) + m1 * (t2 * (t - 1));
    }));
};
const poseOf = (v) => ({ position: v.slice(0, 3), target: v.slice(3, 6), fov: v[6] });

/** Settings for a viewer that only plays the story: no tour, no annotations, starts at keyframe 1. */
export const storySettings = (settings, keyframes, smoothness) => ({
    ...structuredClone(settings),
    animTracks: [storyTrack(keyframes, smoothness)],
    startMode: 'animTrack',
    cameras: [{ initial: { position: keyframes[0].position, target: keyframes[0].target, fov: keyframes[0].fov } }],
    annotations: []
});

// The story time a section stands for: its data-time, else its place in the list. Two sections
// with the same time hold the camera still while the page scrolls between them.
const sectionTimes = (sections) => sections.map((s, i) => (s.dataset.time !== undefined ? Number(s.dataset.time) : i));

/**
 * Where the story is for the page's scroll position: each section's time at its middle, eased
 * in between, held at both ends.
 */
const storyTime = (sections, times) => {
    const middle = window.scrollY + window.innerHeight / 2;
    const centres = sections.map((s) => {
        const box = s.getBoundingClientRect();
        return box.top + window.scrollY + box.height / 2;
    });
    if (middle <= centres[0]) return times[0];
    for (let i = 0; i < centres.length - 1; i++) {
        if (middle < centres[i + 1]) {
            return times[i] + ((times[i + 1] - times[i]) * (middle - centres[i])) / (centres[i + 1] - centres[i]);
        }
    }
    return times[times.length - 1];
};

/**
 * Ties a viewer playing a story track to the scroll position of `sections` (one per keyframe,
 * or as their data-time says). The camera eases after the scroll, so a flick of the wheel
 * becomes a glide. Returns a stop function.
 */
export const bindScroll = (viewer, sections, { ease = 5 } = {}) => {
    const times = sectionTimes(sections);
    const last = Math.max(1, ...times);
    let shown = storyTime(sections, times);
    let ready = false;
    let frame = 0;
    let before = performance.now();
    const tick = (now) => {
        const dt = Math.min(0.1, (now - before) / 1000);
        before = now;
        const wanted = Math.min(storyTime(sections, times), last);
        shown += (wanted - shown) * (1 - Math.exp(-dt * ease));
        if (Math.abs(wanted - shown) < 1e-4) shown = wanted;
        if (ready) {
            try {
                viewer.seek(shown);
            } catch {
                ready = false; // not loaded after all; wait for it
            }
        }
        frame = requestAnimationFrame(tick);
    };
    const onLoaded = (loaded) => {
        ready = Boolean(loaded);
    };
    viewer.events.on('loaded:changed', onLoaded);
    ready = Boolean(viewer.state.loaded);
    frame = requestAnimationFrame(tick);
    return () => {
        cancelAnimationFrame(frame);
        viewer.events.off?.('loaded:changed', onLoaded);
    };
};
