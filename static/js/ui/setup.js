// GitHub setup / settings dialog (github mode). The token is kept only in this
// browser's localStorage (via sources.js saveGitHubSettings).

import { h } from "./dom.js";
import { icon, spinner } from "./icons.js";
import { openDialog, field } from "./dialog.js";
import { DEFAULT_API, normalizeGitHubSettings, testGitHubSettings } from "../sources.js";

const TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

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
 * openSetup({initial, existing, onConnect(settings), onReadOnly(settings), onForget})
 *   initial  : settings to prefill (defaults or saved)
 *   existing : true when opened from the header (Settings) rather than first run
 */
export function openSetup({ initial, existing = false, hasToken = false, pending = 0, onConnect, onReadOnly, onForget }) {
  const s = normalizeGitHubSettings(initial);
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
  const api = h("input", { type: "url", value: s.apiBase, autocomplete: "off", spellcheck: "false" });
  const customApi = s.apiBase !== DEFAULT_API;
  const advanced = h(
    "details",
    { class: `advanced${customApi ? " custom" : ""}`, open: customApi },
    h("summary", {}, icon("chevron"), "Advanced"),
    field("API base", api, { hint: customApi ? "Not the public GitHub API — only for testing with a mock server." : "Leave as https://api.github.com" }),
  );

  const status = h("div", { class: "setup-status", role: "status", "aria-live": "polite", hidden: true });
  const show = (kind, text) => {
    status.hidden = !text;
    status.className = `setup-status ${kind}`;
    status.replaceChildren(icon(kind === "ok" ? "check" : "alert"), h("span", { text }));
  };

  const connect = h("button", { type: "button", class: "btn btn-primary", "data-default": "true" }, icon("github"), existing ? "Save" : "Connect");
  const readOnly = h("button", { type: "button", class: "btn btn-ghost", "data-act": "readonly" }, icon("eye"), h("span", { text: "View read-only" }));
  const cancel = existing ? h("button", { type: "button", class: "btn btn-ghost", "data-act": "cancel", text: "Cancel" }) : null;
  let forget = null;
  if (existing && hasToken) {
    forget = h("button", { type: "button", class: "btn btn-danger-ghost" }, icon("key"), "Forget token");
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
      h("li", {}, "Repository access: ", h("strong", { text: "Only select repositories" }), " → ", h("strong", { text: (s.repo.split("/")[1] || "lab-hub") })),
      h("li", {}, "Repository permissions → ", h("strong", { text: "Contents: Read and write" })),
    ),
    h("div", { class: "fld-hint" }, icon("eye", "small"), "The token is stored only in this browser. It is never sent anywhere except api.github.com."),
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
      existing && pending > 0 ? h("div", { class: "setup-status warn" }, icon("alert"), h("span", { text: `${pending} change${pending === 1 ? " is" : "s are"} still waiting to sync from this browser.` })) : null,
    ],
    footer: [forget, h("span", { class: "spacer" }), cancel, readOnly, connect],
  });

  function collect() {
    return normalizeGitHubSettings({
      clientName: name.value,
      repo: repo.value,
      branch: branch.value,
      path: path.value,
      apiBase: api.value,
      token: token.value.replace(/\s+/g, "") || (hasToken ? initial.token : ""),
    });
  }

  let warned = false;
  connect.addEventListener("click", async () => {
    const next = collect();
    if (!next.token) {
      show("error", "Paste a token to edit — or choose “View read-only”.");
      token.focus();
      return;
    }
    connect.disabled = true;
    readOnly.disabled = true;
    const label = Array.from(connect.childNodes);
    connect.replaceChildren(spinner(), "Checking…");
    let res;
    try {
      res = await testGitHubSettings(next);
    } catch (e) {
      res = { ok: false, error: (e && e.message) || "Check failed" };
    }
    connect.disabled = false;
    readOnly.disabled = false;
    connect.replaceChildren(...label);
    if (!res.ok) {
      show("error", res.error || "Couldn't reach that repo");
      warned = false;
      return;
    }
    if (!res.canWrite && !warned) {
      warned = true;
      show("warn", `${res.error || "This token can read but not write."} Click again to connect anyway (read-only edits will fail).`);
      connect.lastChild.textContent = "Connect anyway";
      return;
    }
    dlg.close();
    onConnect(next);
  });

  if (cancel) cancel.addEventListener("click", () => dlg.close());

  let readOnlyArmed = false;
  readOnly.addEventListener("click", () => {
    if (existing && hasToken && !readOnlyArmed) {
      readOnlyArmed = true;
      const c = readOnlyConfirm(pending);
      readOnly.lastChild.textContent = c.label;
      readOnly.classList.add("armed");
      show("warn", c.warn);
      if (status.scrollIntoView) status.scrollIntoView({ block: "nearest" });
      return;
    }
    const next = collect();
    next.token = "";
    dlg.close();
    onReadOnly(next);
  });

  if (forget) {
    let armed = false;
    forget.addEventListener("click", () => {
      if (!armed) {
        armed = true;
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
