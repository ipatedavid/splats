// The portfolio page: everything comes from portfolio.json, which you edit. The hero plays a
// scene's scroll story: portfolio.json's "hero" scene, else the first listed scene that has
// one. Each card opens a scene's story when it has one, else the 3D player.

import { sceneFolder } from './scene.js';
import { storyKeyframes } from './story.js';

const $ = (selector) => document.querySelector(selector);
const SCENE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const folderOf = (name) => sceneFolder(new URLSearchParams({ scene: name }));

const safeLink = (url) => {
    try {
        const parsed = new URL(url, location.href);
        return ['https:', 'mailto:'].includes(parsed.protocol) ? parsed.href : null;
    } catch {
        return null;
    }
};

const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

const fetchJson = async (url) => {
    try {
        const response = await fetch(url, { cache: 'no-cache' });
        return response.ok ? await response.json() : null;
    } catch {
        return null;
    }
};

// A scene's settings (for its story) and its pointer file (for a poster hosted elsewhere).
const sceneInfo = async (entry) => {
    const folder = folderOf(entry.scene);
    const [settings, manifest] = await Promise.all([
        fetchJson(`${folder.url}settings.json`),
        fetchJson(`${folder.url}scene.json`)
    ]);
    return { entry, folder, settings, keyframes: storyKeyframes(settings?.story), manifest };
};

// The card picture: the entry's own poster, else the folder's poster.webp, else the poster
// scene.json points to (a scene published on superspl.at has one).
const posterCandidates = ({ entry, folder, manifest }) => {
    const list = [];
    if (entry.poster) list.push(new URL(entry.poster, location.href).href);
    list.push(`${folder.url}poster.webp`);
    const pointed = safeLink(manifest?.poster ?? '');
    if (pointed?.startsWith('https:')) list.push(pointed);
    return list;
};

const card = (info, index) => {
    const { entry, keyframes } = info;
    const item = el('li', 'rise');
    const link = el('a', 'card');
    const story = keyframes.length > 0;
    link.href = `${story ? 'story' : 'view'}.html?scene=${encodeURIComponent(entry.scene)}`;

    const frame = el('div', 'frame');
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    if (index > 0) img.loading = 'lazy';
    const candidates = posterCandidates(info);
    img.addEventListener('error', () => {
        const next = candidates.shift();
        if (next) img.src = next;
        else img.remove();
    });
    img.src = candidates.shift();
    frame.append(img, el('span', 'badge', story ? 'Scroll story' : '3D scene'));

    const meta = el('div', 'card-meta');
    const words = el('div');
    words.append(el('h3', '', entry.title));
    const where = [entry.place, entry.date].filter(Boolean).join(' · ');
    if (where) words.append(el('p', 'where', where));
    const go = el('span', 'go', story ? 'View the story →' : 'Open in 3D →');
    meta.append(words, go);
    link.append(frame, meta);
    item.append(link);
    return item;
};

// ---- the hero -----------------------------------------------------------------------------

// One section per keyframe: the scene's name and the count, the caption, and on the last one
// a button into the free 3D player.
const heroSteps = (keyframes, entry) =>
    keyframes.map((k, i) => {
        const step = el('section', 'step');
        step.dataset.time = String(i);
        const inner = el('div', 'step-inner');
        const count = `${String(i + 1).padStart(2, '0')} / ${String(keyframes.length).padStart(2, '0')}`;
        inner.append(el('p', 'count', `${entry.title} · ${count}`));
        if (k.title) inner.append(el('h2', '', k.title));
        if (k.text) inner.append(el('p', 'caption', k.text));
        if (i === keyframes.length - 1) {
            const go = el('a', 'hero-pill', 'Explore it yourself');
            go.href = `view.html?scene=${encodeURIComponent(entry.scene)}`;
            go.append(el('span', '', ' →'));
            go.lastChild.setAttribute('aria-hidden', 'true');
            inner.append(go);
        }
        step.append(inner);
        return step;
    });

// Visitors who turned on their browser's data saver get the story over the scene's picture
// instead of a live splat of tens of MB.
const lite = Boolean(navigator.connection?.saveData);

// The hero's splat renders at one pixel per CSS pixel on high-density screens: on a soft splat
// the difference doesn't show, and it is a quarter of the work on a 2x screen. The viewer sizes
// its canvas from its container, so the container is made smaller and scaled back up.
// Desktops and laptops only: on phones the viewer already renders at reduced resolution.
const renderAtOneX = (box) => {
    const k = Math.min(window.devicePixelRatio || 1, 2);
    if (k < 1.25 || !matchMedia('(pointer: fine)').matches) return;
    Object.assign(box.style, {
        inset: 'auto',
        left: '0',
        top: '0',
        width: `${100 / k}%`,
        height: `${100 / k}%`,
        transform: `scale(${k})`,
        transformOrigin: '0 0'
    });
};

// Resolves on the visitor's first sign of moving on: a scroll, wheel, touch or key.
const firstMove = () =>
    new Promise((resolve) => {
        const kinds = ['scroll', 'wheel', 'touchstart', 'keydown'];
        const done = () => {
            kinds.forEach((k) => removeEventListener(k, done));
            resolve();
        };
        kinds.forEach((k) => addEventListener(k, done, { passive: true }));
    });

// ---- the interlude ------------------------------------------------------------------------

const smooth01 = (x) => {
    const t = Math.min(1, Math.max(0, x));
    return t * t * (3 - 2 * t);
};

// Between the opening screen and the story: a statement on dark, and the scene's size counting
// up as its splat downloads. The scroll it takes is the splat's loading time. The statement is
// portfolio.json's "interlude"; its second sentence goes on its own line, in the accent colour.
const interludeSection = (statement) => {
    const step = el('section', 'step interlude');
    step.dataset.time = '0';
    const inner = el('div', 'step-inner');
    const h = el('h2', 'statement');
    const cut = statement.indexOf('. ');
    if (cut > 0) {
        h.append(statement.slice(0, cut + 1), ' ', el('em', '', statement.slice(cut + 2)));
    } else {
        h.textContent = statement;
    }
    const tally = el('div', 'tally');
    tally.append(el('span', 'tally-number', ''), el('span', 'tally-label', 'Loading the scene'));
    const line = el('div', 'load-line');
    line.append(el('span'));
    tally.append(line);
    inner.append(h, tally);
    step.append(inner);
    return step;
};

// The splat count of a scene published as SOG (its meta.json says), else null.
const splatCount = async (info) => {
    const content = safeLink(info.manifest?.content ?? '');
    if (!content || !/\/meta\.json(\?|$)/.test(content)) return null;
    const meta = await fetchJson(content);
    return Number.isFinite(meta?.count) ? meta.count : null;
};

// Drives the counter and the line: call with the share loaded, 0 to 1.
const tallyUpdater = (section, count) => {
    const number = section.querySelector('.tally-number');
    const label = section.querySelector('.tally-label');
    const line = section.querySelector('.load-line span');
    if (count) label.textContent = 'points of light in this scene';
    number.hidden = !count;
    number.textContent = '0';
    let share = 0;
    let shown = 0;
    let frame = 0;
    const draw = () => {
        const goal = (count ?? 0) * share;
        shown += (goal - shown) * 0.08;
        if (Math.abs(goal - shown) < 1) shown = goal;
        number.textContent = Math.round(shown).toLocaleString('en-US');
        frame = shown === goal ? 0 : requestAnimationFrame(draw);
    };
    return (value) => {
        share = Math.max(share, Math.min(1, value));
        line.style.transform = `scaleX(${share})`;
        if (count && !frame) frame = requestAnimationFrame(draw);
        if (share === 1 && !count) label.textContent = 'Ready';
    };
};

const startHero = async (info, statement) => {
    const { entry, folder, settings, keyframes } = info;
    const steps = heroSteps(keyframes, entry);
    const interlude = interludeSection(statement);
    $('#hero-steps').append(interlude, ...steps);
    const loaded = tallyUpdater(interlude, await splatCount(info));

    // The veil: dark under the video (or coming in as the opening lines leave, without one),
    // held through the interlude, lifting to show the splat for the first caption.
    const veil = $('#hero-veil');
    veil.hidden = false;
    const withVideo = !$('#hero-video').hidden;
    const intro = $('#hero-steps .intro');
    const fadeVeil = () => {
        const top = intro.getBoundingClientRect();
        const comeIn = withVideo ? 1 : smooth01((-top.top / top.height - 0.2) / 0.6);
        const box = interlude.getBoundingClientRect();
        const passed = (innerHeight - box.top) / (box.height + innerHeight); // 0 entering, 1 gone
        veil.style.opacity = String(comeIn * (1 - smooth01((passed - 0.62) / 0.28)));
    };
    addEventListener('scroll', fadeVeil, { passive: true });
    fadeVeil();
    const sections = [...document.querySelectorAll('#hero-steps .step')];
    const shown = new IntersectionObserver(
        (entries) => entries.forEach((e) => e.target.classList.toggle('shown', e.isIntersecting)),
        { rootMargin: '-15% 0px -15% 0px' }
    );
    sections.forEach((s) => shown.observe(s));

    const poster = posterCandidates(info)[0];
    if (poster) $('#hero-poster').style.backgroundImage = `url("${poster}")`;
    if (lite) {
        $('#hero-poster').classList.add('drift');
        loaded(1);
        return;
    }

    // Only one of the video and the splat works at a time: the video plays alone on the first
    // screen, and the splat starts loading once the visitor starts to move on (the story is a
    // screen's scroll away; the scene's picture stands in until it is ready). With a video
    // the visitor's first move is waited for; without one the splat loads straight away.
    if (!$('#hero-video').hidden) await firstMove();
    renderAtOneX($('#hero-canvas'));
    const [{ createViewer, defaultSettings }, { loadScene }, { storySettings, bindScroll }] = await Promise.all([
        import('./index.js'),
        import('./scene.js'),
        import('./story.js')
    ]);
    const scene = await loadScene(folder, defaultSettings);
    if (scene.posterUrl) $('#hero-poster').style.backgroundImage = `url("${scene.posterUrl}")`;
    const viewer = await createViewer({
        container: $('#hero-canvas'),
        settings: storySettings(settings, keyframes, settings.story?.smoothness ?? 1),
        contentUrl: scene.contentUrl,
        skyboxUrl: scene.skyboxUrl,
        ui: false,
        noanim: true,
        renderer: new URL(location.href).searchParams.has('webgl') ? 'webgl' : 'webgpu'
    });
    window.viewer = viewer;
    viewer.events.on('loaded:changed', (ready) => {
        if (!ready) return;
        $('#hero-poster').classList.add('gone');
        loaded(1);
    });
    viewer.events.on('progress:changed', (progress) => loaded(progress / 100));
    loaded(viewer.state.loaded ? 1 : viewer.state.progress / 100);
    // with smooth scrolling the page already glides, so the camera follows it closely
    bindScroll(viewer, sections, { ease: smooth ? 14 : 6 });
};

// ---- the hero video ------------------------------------------------------------------------

// A showreel over the hero's first screen, dissolving into the scroll story as the opening
// lines scroll away. portfolio.json's "heroVideo" names the files' common start, e.g.
// "media/hero" for media/hero-1440-av1.mp4 (AV1, for browsers that play it),
// media/hero-1080.mp4 (H.264, for the rest), media/hero-portrait.mp4 (a 9:16 crop for
// phones; hero-720.mp4 before that) and media/hero-poster.webp (shown until the video plays).
const startVideo = (base) => {
    const video = $('#hero-video');
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const phone = matchMedia('(max-width: 760px)').matches;
    const av1 = video.canPlayType('video/mp4; codecs="av01.0.08M.08"') === 'probably';
    video.poster = `${base}-poster.webp`;
    // best first; a file that's missing or won't play falls through to the next
    const files = phone ? ['portrait', '720', '1080'] : av1 ? ['1440-av1', '1080'] : ['1080'];
    video.addEventListener('error', () => {
        files.shift();
        if (files.length) {
            video.src = `${base}-${files[0]}.mp4`;
            if (!still) video.play().catch(() => {});
        }
    });
    video.src = `${base}-${files[0]}.mp4`;
    video.hidden = false;
    if (!still) video.play().catch(() => {});

    const intro = $('#hero-steps .intro');
    const fade = () => {
        const box = intro.getBoundingClientRect();
        const gone = Math.min(1, Math.max(0, -box.top / box.height)); // 0 at the top, 1 once scrolled past
        const t = Math.min(1, Math.max(0, (gone - 0.2) / 0.6));
        const opacity = 1 - t * t * (3 - 2 * t);
        video.style.opacity = String(opacity);
        // Only one of the two at work: the video freezes on its frame as soon as it starts to
        // dissolve into the splat, and plays again once it fills the screen.
        if (opacity < 1 && !video.paused) video.pause();
        else if (opacity === 1 && video.paused && !still) video.play().catch(() => {});
    };
    addEventListener('scroll', fade, { passive: true });
    fade();
};

// ---- the page -----------------------------------------------------------------------------

const reveal = () => {
    const seen = new IntersectionObserver(
        (entries) =>
            entries.forEach((e) => {
                if (e.isIntersecting) {
                    e.target.classList.add('in');
                    seen.unobserve(e.target);
                }
            }),
        // start a little before they come into view, so nothing is still blank on arrival
        { rootMargin: '0px 0px 12% 0px' }
    );
    document.querySelectorAll('.rise').forEach((node) => seen.observe(node));
};

// Smooth scrolling on desktop (wheel and trackpad); touch keeps the phone's own scrolling.
// Off for visitors who ask for less motion, or if the library didn't load.
const smooth = window.Lenis && !matchMedia('(prefers-reduced-motion: reduce)').matches
    ? new window.Lenis({ lerp: 0.1 })
    : null;
if (smooth) {
    const raf = (time) => {
        smooth.raf(time);
        requestAnimationFrame(raf);
    };
    requestAnimationFrame(raf);
}
// the menu's links glide too, and land below the menu bar
document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href^="#"]');
    const target = link && (link.getAttribute('href') === '#top' ? 0 : document.querySelector(link.getAttribute('href')));
    if (target === null || target === undefined) return;
    event.preventDefault();
    const offset = target === 0 ? 0 : -$('.nav').offsetHeight + 1;
    if (smooth) {
        smooth.scrollTo(target, { offset, duration: 1.4 });
    } else {
        const top = target === 0 ? 0 : target.getBoundingClientRect().top + scrollY + offset;
        scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
});

const intro = $('#hero-steps .intro');
new IntersectionObserver((entries) => entries.forEach((e) => intro.classList.toggle('shown', e.isIntersecting)), {
    rootMargin: '-20% 0px -20% 0px'
}).observe(intro);
// the menu turns into a paper bar once the page has scrolled up under it
const onScroll = () => {
    $('#scroll-cue').classList.toggle('gone', scrollY > 40);
    $('.nav').classList.toggle('on-paper', $('.page').getBoundingClientRect().top <= $('.nav').offsetHeight);
};
addEventListener('scroll', onScroll, { passive: true });
onScroll();
for (const node of document.querySelectorAll('.section-head, .about > *, .contact > *')) node.classList.add('rise');

try {
    const response = await fetch('portfolio.json', { cache: 'no-cache' });
    if (!response.ok) {
        throw new Error(`portfolio.json answered ${response.status}`);
    }
    const data = await response.json();
    const name = data.name || 'Portfolio';
    document.title = data.tagline ? `${name} · ${data.tagline}` : name;
    $('#brand').textContent = name;
    $('#foot-name').textContent = `© ${new Date().getFullYear()} ${name}`;
    if (data.tagline) $('#tagline').textContent = data.tagline;
    $('#name-line').textContent = data.lede ?? `${name} captures real places and objects in 3D.`;
    $('#intro').textContent = data.intro ?? '';
    $('#intro').hidden = !data.intro;

    const links = $('#links');
    (data.links ?? []).forEach(({ label, url }, i) => {
        const href = safeLink(url);
        if (!label || !href) return;
        const a = el('a', i === 0 ? 'pill main' : 'pill', label);
        a.href = href;
        if (href.startsWith('mailto:')) {
            a.textContent = `${label} · ${href.slice(7)}`;
        } else {
            a.rel = 'noopener';
        }
        links.append(a);
    });

    if (typeof data.heroVideo === 'string' && /^[\w./-]+$/.test(data.heroVideo)) {
        startVideo(data.heroVideo);
    }
    const entries = (data.scenes ?? []).filter((s) => s && SCENE_NAME.test(s.scene ?? '') && s.title);
    const infos = await Promise.all(entries.map(sceneInfo));
    $('#scenes').append(...infos.map(card));
    if (!infos.length) {
        $('#empty').hidden = false;
        $('#empty').textContent = 'No scenes listed yet.';
    }
    reveal();

    const hero = infos.find((i) => i.entry.scene === data.hero && i.keyframes.length) ?? infos.find((i) => i.keyframes.length);
    if (hero) {
        await startHero(hero, data.interlude || 'Hundreds of photographs. Millions of points of light.');
    }
} catch (error) {
    reveal();
    $('#empty').hidden = false;
    $('#empty').textContent = `The scene list could not be loaded (${error.message}).`;
}
