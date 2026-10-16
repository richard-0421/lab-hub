// Inline SVG icon set (24x24, stroke 1.75, currentColor). Static strings only:
// user data never goes anywhere near innerHTML.

const P = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  trash: '<path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l.8 11.2A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.8L17.5 7M9.5 7V4.8a.8.8 0 0 1 .8-.8h3.4a.8.8 0 0 1 .8.8V7"/>',
  pin: '<path d="M12 16.5V21M8.5 3.5h7l-1 5.5 3.5 3.5v1.5h-12V12.5L9.5 9z"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  user: '<circle cx="12" cy="8" r="3.75"/><path d="M4.5 20c1.3-3.4 4.2-5.2 7.5-5.2s6.2 1.8 7.5 5.2"/>',
  users: '<circle cx="9" cy="8.5" r="3.25"/><path d="M3 19.5c.9-3.1 3.2-4.7 6-4.7s5.1 1.6 6 4.7M15.5 5.6a3.2 3.2 0 0 1 0 6M17.6 14.9c1.6.6 2.8 2.1 3.4 4.6"/>',
  flag: '<path d="M5.5 21V4.5M5.5 4.5h11.5l-2.2 4.2 2.2 4.3H5.5"/>',
  tag: '<path d="M3.5 12.3V4.8a1.3 1.3 0 0 1 1.3-1.3h7.5l8.2 8.2a1.3 1.3 0 0 1 0 1.8l-7 7a1.3 1.3 0 0 1-1.8 0z"/><circle cx="8.2" cy="8.2" r="1.4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3"/>',
  refresh: '<path d="M19.5 11A7.5 7.5 0 0 0 6.2 6.3L4.5 8M4.5 4v4h4M4.5 13a7.5 7.5 0 0 0 13.3 4.7l1.7-1.7M19.5 20v-4h-4"/>',
  "cloud-off": '<path d="M3 3l18 18M9 5.6A6 6 0 0 1 17.6 10h.4a4 4 0 0 1 2.6 7M17 19H7a4.5 4.5 0 0 1-1.7-8.7"/>',
  cloud: '<path d="M7 19a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 10a4.5 4.5 0 0 1 0 9z"/>',
  alert: '<path d="M10.3 4.3L2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  chevron: '<path d="M7 10l5 5 5-5"/>',
  grip: '<circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6L6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.3 6.3 0 0 0 10.5 10.5z"/>',
  settings: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
  github: '<circle cx="6.5" cy="5.5" r="2.2"/><circle cx="6.5" cy="18.5" r="2.2"/><circle cx="17.5" cy="7.5" r="2.2"/><path d="M6.5 7.7v8.6M17.5 9.7c0 4.3-5 3.3-9.6 7.1"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3.2-3.2a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3.2 3.2a4 4 0 0 0 5.7 5.7l1-1"/>',
  note: '<path d="M5.5 3.5h13a1 1 0 0 1 1 1v10l-5 5h-9a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1z"/><path d="M14.5 19.5v-4a1 1 0 0 1 1-1h4M8.5 8.5h7M8.5 12h4"/>',
  box: '<path d="M3.5 7.5L12 3.2l8.5 4.3v9L12 20.8l-8.5-4.3z"/><path d="M3.5 7.5L12 12l8.5-4.5M12 12v8.8M7.8 5.3l8.5 4.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  text: '<path d="M5 7h14M5 12h14M5 17h9"/>',
  sort: '<path d="M7.5 4.5v15M4 16l3.5 3.5L11 16M16.5 19.5v-15M13 8l3.5-3.5L20 8"/>',
  sparkle: '<path d="M12 3.5l1.7 5.1a1.5 1.5 0 0 0 .9.9l5.1 1.7-5.1 1.7a1.5 1.5 0 0 0-.9.9L12 18.9l-1.7-5.1a1.5 1.5 0 0 0-.9-.9L4.3 11.2l5.1-1.7a1.5 1.5 0 0 0 .9-.9z"/>',
  location: '<path d="M12 21s6.5-5.8 6.5-11a6.5 6.5 0 0 0-13 0c0 5.2 6.5 11 6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  undo: '<path d="M9 14.5L4.5 10 9 5.5M4.5 10H15a5 5 0 0 1 0 10h-3"/>',
  key: '<circle cx="8" cy="15" r="3.5"/><path d="M10.5 12.5L19 4M16 7l2.5 2.5M14 9l2 2"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  inbox: '<path d="M3.5 13.5l2.6-7.7A1.5 1.5 0 0 1 7.5 4.8h9a1.5 1.5 0 0 1 1.4 1l2.6 7.7v5a1.5 1.5 0 0 1-1.5 1.5h-14a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M3.5 13.5h4.8l1.2 2.5h5l1.2-2.5h4.8"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  external: '<path d="M14 4.5h5.5V10M19.5 4.5L11 13M18 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H10"/>',
};

const NS = "http://www.w3.org/2000/svg";

/** An <svg class="icon ..."> element for `name`. */
export function icon(name, cls) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", cls ? `icon ${cls}` : "icon");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = P[name] || ""; // constant markup from the table above
  return svg;
}

/** A spinner (only animates while it is in the DOM). */
export function spinner(cls) {
  const s = document.createElement("span");
  s.className = cls ? `spinner ${cls}` : "spinner";
  s.setAttribute("aria-hidden", "true");
  return s;
}

/** Replace every `<span data-icon="name">` placeholder under `root` with its SVG. */
export function hydrateIcons(root) {
  for (const el of Array.from(root.querySelectorAll("[data-icon]"))) {
    const svg = icon(el.getAttribute("data-icon"), el.getAttribute("class") || "");
    el.replaceWith(svg);
  }
}
