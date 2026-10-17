// GitHub setup / settings dialog (github mode). The token is saved in this
// browser's localStorage for the page's own site (sources.js
// saveGitHubSettings), where any page served from that site can read it.

import { h } from "./dom.js";
import { icon, spinner } from "./icons.js";
import { openDialog, field } from "./dialog.js";
import {
  DEFAULT_API,
  DEFAULT_BRANCH,
  DEFAULT_PATH,
  DEFAULT_REPO,
  customApiAllowed,
  githubSettingsError,
  normalizeGitHubSettings,
  pagesCodeRepo,
  testGitHubSettings,
} from "../sources.js";

const TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

/**
 * The trust model, said once. In the default one-repo setup (code on `main`,
 * board on `data`) a token that can write the board can also push code,
 * which the Pi installs and Pages publishes.
 */
export const TRUST_NOTE = "Anyone with a token can also change the dashboard's code on GitHub — only give tokens to people you trust.";

function pageLocation(loc) {
  if (loc !== undefined) return loc;
  return typeof location !== "undefined" ? location : null;
}

/**
 * Where the token is kept, in words: localStorage belongs to the page's site
 * (on GitHub Pages "<owner>.github.io", shared by every Pages site of that
 * account), not to this one page.
 */
export function tokenStorageNote(loc, { customApi = false } = {}) {
  const l = pageLocation(loc);
  const site = (l && typeof l.host === "string" && l.host) || (l && typeof l.hostname === "string" && l.hostname) || "this site";
  const to = customApi ? "the API base under Advanced" : "api.github.com";
  return `The token is kept in this browser's storage for ${site} (readable by any page served from that site) and is sent only to ${to}.`;
}

/**
 * Is `repo` the repo the dashboard's code comes from (the one-repo setup)?
 * On GitHub Pages that is the repo the page is published from; elsewhere the
 * default repo. Case-insensitive, like GitHub.
 */
export function boardIsCodeRepo(repo, loc) {
  const code = pagesCodeRepo(pageLocation(loc)) || DEFAULT_REPO;
  return typeof repo === "string" && repo !== "" && repo.toLowerCase() === code.toLowerCase();
}

/**
 * Which field githubSettingsError() is about: "repo" | "branch" | "path" |
 * "token" | null. Each field is checked on its own next to known-good values.
 */
export function invalidField(settings) {
  const s = settings && typeof settings === "object" ? settings : {};
  const good = { repo: DEFAULT_REPO, branch: DEFAULT_BRANCH, path: DEFAULT_PATH, token: "" };
  for (const k of ["repo", "branch", "path", "token"]) {
    if (githubSettingsError(Object.assign({}, good, { [k]: s[k] }))) return k;
  }
  return null;
}

/**
 * What Connect does with a testGitHubSettings() result
 * ({ok, error, canWrite: true|false|null, private, warnings}):
 *   {action: "error", message}             stay open and show why
 *   {action: "confirm", message, warnings} the token can read but not write:
 *                                          ask for a second click
 *   {action: "connect", note, warnings}    connect now; `note` (write access
 *                                          couldn't be confirmed) and
 *                                          `warnings` (two-repo setup) are
 *                                          shown afterwards and never block
 */
export function connectDecision(res) {
  const r = res && typeof res === "object" ? res : {};
  const warnings = Array.isArray(r.warnings) ? r.warnings.filter((w) => typeof w === "string" && w) : [];
  if (!r.ok) return { action: "error", message: r.error || "Couldn't reach that repo", warnings: [] };
  if (r.canWrite === true) return { action: "connect", note: null, warnings };
  if (r.canWrite === null) return { action: "connect", note: r.error || "Couldn't confirm that this token can write to the repo.", warnings };
  return { action: "confirm", message: r.error || "This token can read the repo but not write it.", warnings };
}

/** End a message with a full stop unless it already has one. */
export function sentence(text) {
  const t = String(text || "").trim();
  return !t || /[.!?…]$/.test(t) ? t : `${t}.`;
}

/**
 * What "View read-only" says once armed. Switching an existing, tokened
 * setup to read-only deletes the saved token (GitHub never shows a
 * fine-grained token again), so it takes a second click, like Forget token.
 * Unsynced edits are kept and push once a token is added again.
 */
export function readOnlyConfirm(pending = 0) {
  const n = Number.isFinite(pending) && pending > 0 ? pending : 0;
  return {
    label: "Remove token?",
    warn: n
      ? `${n} unsynced change${n === 1 ? "" : "s"} from this browser will wait here until a token is added again.`
      : "The saved token will be removed from this browser. To edit again you'll need to paste a token (GitHub shows a token only once).",
  };
}

/**
 * openSetup({initial, existing, hasToken, pending, onConnect(settings, {note, warnings}),
 *            onReadOnly(settings), onForget, loc, fetchImpl})
 *   initial   : settings to prefill (defaults or saved)
 *   existing  : true when opened from the header (Settings) rather than first run
 *   onConnect : the second argument carries what to tell the user after
 *               connecting: `note` (write access couldn't be confirmed) or
 *               null, and `warnings` (two-repo setup only), both non-blocking
 *   loc       : the page location (default: the global `location`)
 *   fetchImpl : passed to testGitHubSettings (tests)
 */
export function openSetup({ initial, existing = false, hasToken = false, pending = 0, onConnect, onReadOnly, onForget, loc, fetchImpl }) {
  const where = pageLocation(loc);
  const showApi = customApiAllowed(where);
  const s = normalizeGitHubSettings(initial, where);
  const name = h("input", { type: "text", value: s.clientName, maxlength: 60, placeholder: "e.g. Richard", autocomplete: "name" });
  const repo = h("input", { type: "text", value: s.repo, placeholder: "owner/name", autocomplete: "off", spellcheck: "false", autocapitalize: "off" });
  const branch = h("input", { type: "text", value: s.branch, autocomplete: "off", spellcheck: "false", autocapitalize: "off" });
  const path = h("input", { type: "text", value: s.path, autocomplete: "off", spellcheck: "false", autocapitalize: "off" });
  const token = h("input", {
    type: "password",
    value: "",
    autocomplete: "off",
    spellcheck: "false",
    autocapitalize: "off",
    placeholder: hasToken ? "Saved — paste a new token to replace it" : "github_pat_…",
  });
  const fields = { repo, branch, path, token };
  // A custom API base (a mock server) is a local-development option only;
  // anywhere else the token only ever goes to api.github.com.
  const api = h("input", { type: "url", value: s.apiBase, autocomplete: "off", spellcheck: "false" });
  const customApi = showApi && s.apiBase !== DEFAULT_API;
  const advanced = showApi
    ? h(
        "details",
        { class: `advanced${customApi ? " custom" : ""}`, open: customApi },
        h("summary", {}, icon("chevron"), "Advanced"),
        field("API base", api, { hint: customApi ? "Not the public GitHub API — only for testing with a mock server." : "Leave as https://api.github.com" }),
      )
    : null;

  const status = h("div", { class: "setup-status", role: "status", "aria-live": "polite", hidden: true });
  const show = (kind, text) => {
    status.hidden = !text;
    status.className = `setup-status ${kind}`;
    status.replaceChildren(icon(kind === "ok" ? "check" : "alert"), h("span", { text }));
  };
  // Two-repo setup only: the token can also change the code repo. Amber, never blocks.
  const warnBox = h("div", { class: "setup-status warn setup-warnings", hidden: true });
  const showWarnings = (list) => {
    warnBox.hidden = !list.length;
    warnBox.replaceChildren(...(list.length ? [icon("alert"), h("div", {}, list.map((w) => h("div", { text: w })))] : []));
  };

  const connectLabel = existing ? "Save" : "Connect";
  const connect = h("button", { type: "button", class: "btn btn-primary", "data-default": "true", "data-act": "connect" }, icon("github"), connectLabel);
  const readOnly = h("button", { type: "button", class: "btn btn-ghost", "data-act": "readonly" }, icon("eye"), h("span", { text: "View read-only" }));
  const cancel = existing ? h("button", { type: "button", class: "btn btn-ghost", "data-act": "cancel", text: "Cancel" }) : null;
  let forget = null;
  if (existing && hasToken) {
    forget = h("button", { type: "button", class: "btn btn-danger-ghost", "data-act": "forget" }, icon("key"), "Forget token");
  }

  const intro = h(
    "div",
    { class: "setup-intro" },
    h("div", { class: "setup-badge" }, h("img", { src: "favicon.svg", alt: "", width: 40, height: 40 })),
    h(
      "p",
      {},
      "The board lives in a JSON file in the lab's GitHub repo. This page reads and writes it directly — the Raspberry Pi display picks up your changes within seconds, and theirs show up here. Paste a GitHub token once to edit; without one you can still view.",
    ),
  );

  // The repo the token must be limited to follows the Repository field.
  const repoName = h("strong", { class: "token-repo" });
  const trust = h("div", { class: "fld-hint trust-note" }, icon("users", "small"), h("span", { text: TRUST_NOTE }));
  const syncRepoHints = () => {
    const r = normalizeGitHubSettings({ repo: repo.value }, where).repo;
    repoName.textContent = r || "the board's repo";
    trust.hidden = !boardIsCodeRepo(r, where);
  };
  syncRepoHints();
  repo.addEventListener("input", syncRepoHints);

  const tokenHelp = h(
    "div",
    { class: "token-help" },
    h(
      "a",
      { href: TOKEN_URL, target: "_blank", rel: "noopener noreferrer", class: "token-link" },
      icon("key"),
      "Create a fine-grained token",
      icon("external", "small"),
    ),
    h(
      "ul",
      {},
      h("li", {}, "Repository access: ", h("strong", { text: "Only select repositories" }), " → ", repoName),
      h("li", {}, "Repository permissions → ", h("strong", { text: "Contents: Read and write" })),
    ),
    h("div", { class: "fld-hint storage-note" }, icon("eye", "small"), h("span", { text: tokenStorageNote(where, { customApi: showApi }) })),
    trust,
  );

  const dlg = openDialog({
    title: existing ? "GitHub settings" : "Connect to the lab board",
    subtitle: existing ? "Where this browser reads and writes the board" : "One-time setup for this browser",
    className: "setup",
    initialFocus: existing ? null : s.clientName ? token : name,
    body: [
      existing ? null : intro,
      field("Your name", name, { hint: "Shown on tasks you create and in commit messages." }),
      h("div", { class: "ed-grid three" }, field("Repository", repo, { cls: "span-2" }), field("Branch", branch), field("File", path)),
      field("Token", token),
      tokenHelp,
      advanced,
      status,
      warnBox,
      existing && pending > 0 ? h("div", { class: "setup-status warn" }, icon("alert"), h("span", { text: `${pending} change${pending === 1 ? " is" : "s are"} still waiting to sync from this browser.` })) : null,
    ],
    footer: [forget, h("span", { class: "spacer" }), cancel, readOnly, connect],
  });

  function collect() {
    return normalizeGitHubSettings(
      {
        clientName: name.value,
        repo: repo.value,
        branch: branch.value,
        path: path.value,
        apiBase: showApi ? api.value : DEFAULT_API,
        token: token.value.replace(/\s+/g, "") || (hasToken ? initial.token : ""),
      },
      where,
    );
  }

  /** Check the fields without asking GitHub; show the first problem next to its field. */
  function invalid(next) {
    for (const el of Object.values(fields)) el.removeAttribute("aria-invalid");
    const msg = githubSettingsError(next);
    if (!msg) return false;
    const el = fields[invalidField(next)] || repo;
    el.setAttribute("aria-invalid", "true");
    show("error", msg);
    showWarnings([]);
    el.focus();
    return true;
  }

  // "Connect anyway": armed for exactly the settings that were checked.
  let armed = null;
  const setLabel = (text) => {
    connect.lastChild.textContent = text;
  };
  const disarm = () => {
    if (armed === null) return;
    armed = null;
    setLabel(connectLabel);
  };
  for (const el of [repo, branch, path, token, api]) {
    el.addEventListener("input", () => {
      el.removeAttribute("aria-invalid");
      disarm();
    });
  }

  const finish = (next, info) => {
    dlg.close();
    onConnect(next, info);
  };

  connect.addEventListener("click", async () => {
    const next = collect();
    if (!next.token) {
      show("error", "Paste a token to edit — or choose “View read-only”.");
      token.focus();
      return;
    }
    if (invalid(next)) return;
    const key = JSON.stringify(next);
    if (armed && armed.key === key) {
      finish(next, { note: null, warnings: armed.warnings });
      return;
    }
    disarm();
    connect.disabled = true;
    readOnly.disabled = true;
    const label = Array.from(connect.childNodes);
    connect.replaceChildren(spinner(), "Checking…");
    let res;
    try {
      res = await testGitHubSettings(next, fetchImpl, where);
    } catch (e) {
      res = { ok: false, error: (e && e.message) || "Check failed" };
    }
    connect.disabled = false;
    readOnly.disabled = false;
    connect.replaceChildren(...label);
    // Closed meanwhile (Esc / ×), or the fields changed: this answer is stale.
    if (!dlg.dialog.isConnected || JSON.stringify(collect()) !== key) return;
    const d = connectDecision(res);
    if (d.action === "error") {
      show("error", d.message);
      showWarnings([]);
      return;
    }
    if (d.action === "confirm") {
      armed = { key, warnings: d.warnings };
      setLabel("Connect anyway");
      show("warn", `${sentence(d.message)} Click “Connect anyway” to use it as it is — edits made with it won't reach GitHub.`);
      showWarnings(d.warnings);
      return;
    }
    finish(next, { note: d.note, warnings: d.warnings });
  });

  if (cancel) cancel.addEventListener("click", () => dlg.close());

  let readOnlyArmed = false;
  readOnly.addEventListener("click", () => {
    const next = collect();
    next.token = "";
    if (invalid(next)) return;
    if (existing && hasToken && !readOnlyArmed) {
      readOnlyArmed = true;
      const c = readOnlyConfirm(pending);
      readOnly.lastChild.textContent = c.label;
      readOnly.classList.add("armed");
      show("warn", c.warn);
      if (status.scrollIntoView) status.scrollIntoView({ block: "nearest" });
      return;
    }
    dlg.close();
    onReadOnly(next);
  });

  if (forget) {
    let armedForget = false;
    forget.addEventListener("click", () => {
      if (!armedForget) {
        armedForget = true;
        forget.lastChild.textContent = pending > 0 ? `Forget & drop ${pending} unsynced?` : "Click again to forget";
        forget.classList.add("armed");
        return;
      }
      dlg.close();
      onForget();
    });
  }
  return dlg;
}
