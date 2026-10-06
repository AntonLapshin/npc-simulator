// core/dom.js — tiny DOM helpers shared by the UI modules.

/** document.getElementById shorthand. */
export const $ = (id) => document.getElementById(id);

/** Create an element with attributes/props and children. */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const ch of [].concat(children)) {
    if (ch == null) continue;
    node.appendChild(typeof ch === "string" ? document.createTextNode(ch) : ch);
  }
  return node;
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Syntax-highlighted JSON (same regex approach as the prototype). */
export function highlightJSON(o) {
  const s = JSON.stringify(o, null, 2)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return s.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?)/g,
    (m) => {
      let cls = "j-num";
      if (/^"/.test(m)) cls = /:$/.test(m) ? "j-key" : "j-str";
      else if (/true|false/.test(m)) cls = "j-bool";
      else if (/null/.test(m)) cls = "j-null";
      return '<span class="' + cls + '">' + m + "</span>";
    },
  );
}

/** Auto-grow a textarea up to maxH px. */
export function autogrow(textarea, maxH = 140) {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(maxH, Math.max(52, textarea.scrollHeight)) + "px";
}
