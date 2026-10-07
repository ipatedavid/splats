// The portfolio page: everything comes from portfolio.json, which you edit.

const $ = (selector) => document.querySelector(selector);
const SCENE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const text = (selector, value) => {
    const el = $(selector);
    el.textContent = value ?? '';
    el.hidden = !value;
};

const safeLink = (url) => {
    try {
        const parsed = new URL(url, location.href);
        return ['https:', 'mailto:'].includes(parsed.protocol) ? parsed.href : null;
    } catch {
        return null;
    }
};

const card = (entry) => {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'card';
    link.href = `view.html?scene=${encodeURIComponent(entry.scene)}`;

    const poster = document.createElement('div');
    poster.className = 'poster';
    // until (or unless) the poster loads: a soft tile, with "Open in 3D" always showing
    const placeholder = document.createElement('span');
    placeholder.className = 'placeholder';
    poster.classList.add('no-poster');
    poster.append(placeholder);
    const img = new Image();
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    // The card picture: the entry's own poster, else the folder's poster.webp, else the
    // poster scene.json points to (a scene published on superspl.at has one).
    const candidates = entry.poster ? [new URL(entry.poster, location.href).href] : [`scenes/${entry.scene}/poster.webp`];
    let pointerTried = Boolean(entry.poster);
    img.addEventListener('load', () => {
        placeholder.remove();
        poster.classList.remove('no-poster');
    });
    img.addEventListener('error', async () => {
        const next = candidates.shift();
        if (next) {
            img.src = next;
            return;
        }
        if (!pointerTried) {
            pointerTried = true;
            try {
                const manifest = await (await fetch(`scenes/${entry.scene}/scene.json`, { cache: 'no-cache' })).json();
                const url = new URL(manifest.poster, location.href);
                if (url.protocol === 'https:') {
                    img.src = url.href;
                    return;
                }
            } catch {
                // no pointer, or no poster in it
            }
        }
        img.remove();
    });
    img.src = candidates.shift();
    poster.append(img);
    const open = document.createElement('span');
    open.className = 'open';
    open.textContent = 'Open in 3D';
    poster.append(open);

    const title = document.createElement('h2');
    title.textContent = entry.title;
    link.append(poster, title);
    const meta = [entry.place, entry.date].filter(Boolean).join(' · ');
    if (meta) {
        const p = document.createElement('p');
        p.className = 'meta';
        p.textContent = meta;
        link.append(p);
    }
    if (entry.text) {
        const p = document.createElement('p');
        p.textContent = entry.text;
        link.append(p);
    }
    item.append(link);
    return item;
};

// `html` is only ever one of the fixed messages below; anything else goes in as text.
const showEmpty = (html, plain = '') => {
    const empty = $('#empty');
    empty.hidden = false;
    if (html) {
        empty.innerHTML = html;
    } else {
        empty.textContent = plain;
    }
};

try {
    const response = await fetch('portfolio.json', { cache: 'no-cache' });
    if (!response.ok) {
        throw new Error(`portfolio.json answered ${response.status}`);
    }
    const data = await response.json();
    if (data.name) {
        document.title = data.name;
    }
    text('#name', data.name || 'Splats');
    text('#tagline', data.tagline);
    text('#intro', data.intro);
    const links = $('#links');
    for (const { label, url } of data.links ?? []) {
        const href = safeLink(url);
        if (label && href) {
            const a = document.createElement('a');
            a.href = href;
            a.textContent = label;
            if (href.startsWith('https:')) {
                a.rel = 'noopener';
            }
            links.append(a);
        }
    }
    links.hidden = !links.children.length;
    const scenes = (data.scenes ?? []).filter((s) => s && SCENE_NAME.test(s.scene ?? '') && s.title);
    $('#scenes').append(...scenes.map(card));
    if (!scenes.length) {
        showEmpty(
            'No scenes listed yet. Add one to <code>portfolio.json</code> with its folder name and a ' +
                'title, and put its files in <code>scenes/&lt;name&gt;/</code>.'
        );
    }
} catch (error) {
    showEmpty('', `The scene list could not be loaded (${error.message}).`);
}
