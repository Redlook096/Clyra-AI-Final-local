/**
 * Clyra Visual Edit / Inspect Mode — injected into preview pages.
 *
 * Runs inside the preview iframe (same origin as the parent thanks to the
 * preview proxy). Draws the hover outline + floating label, serializes real
 * DOM elements on click, and applies live style patches. Every message goes
 * over window.postMessage; the parent maps changes back to real source.
 */
(function () {
  if (window.__clyraInspect) return;

  var mode = false;
  var selected = null;
  var selectedId = 0;
  var elements = new WeakMap();
  var elementIds = [];
  var elementById = {};
  var overlay = null;
  var label = null;
  var handles = [];
  var measure = null;
  var dragState = null;
  var guideX = null;
  var guideY = null;

  function el(tag, cls, parent) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (parent) parent.appendChild(node);
    return node;
  }

  function css(node, styles) {
    for (var key in styles) node.style[key] = styles[key];
  }

  function buildOverlay() {
    if (overlay) return;
    overlay = el("div", "", document.body);
    css(overlay, {
      position: "fixed",
      border: "2px solid #3977F6",
      borderRadius: "2px",
      pointerEvents: "none",
      zIndex: "2147483000",
      display: "none",
      boxSizing: "border-box",
      transition: "left 60ms linear, top 60ms linear, width 60ms linear, height 60ms linear",
    });
    label = el("div", "", overlay);
    css(label, {
      position: "absolute",
      top: "-22px",
      left: "-2px",
      background: "#3977F6",
      color: "#fff",
      font: "500 10px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      padding: "2px 6px",
      borderRadius: "4px",
      whiteSpace: "nowrap",
      maxWidth: "260px",
      overflow: "hidden",
      textOverflow: "ellipsis",
      pointerEvents: "auto",
      cursor: "move",
    });
    label.addEventListener("pointerdown", function (event) { startDrag(event, "move"); });
    measure = el("div", "", overlay);
    css(measure, {
      position: "absolute",
      bottom: "-20px",
      right: "-2px",
      background: "rgba(23,24,26,0.92)",
      color: "#fff",
      font: "500 9px/1.3 -apple-system, sans-serif",
      padding: "1px 5px",
      borderRadius: "3px",
      display: "none",
      pointerEvents: "none",
      fontVariantNumeric: "tabular-nums",
    });
    for (var i = 0; i < 8; i++) {
      var handle = el("div", "", overlay);
      var size = 7;
      var pos = ["nw", "n", "ne", "e", "se", "s", "sw", "w"][i];
      css(handle, {
        position: "absolute",
        width: size + "px",
        height: size + "px",
        background: "#fff",
        border: "1.5px solid #3977F6",
        borderRadius: "2px",
        pointerEvents: "auto",
        cursor: pos.indexOf("w") >= 0 && pos.indexOf("n") >= 0 ? "nwse-resize" : "ns-resize",
      });
      handle.dataset.pos = pos;
      handle.style.display = "none";
      (function (handlePosition) {
        handle.addEventListener("pointerdown", function (event) {
          startDrag(event, handlePosition);
        });
      })(pos);
      handles.push(handle);
    }
    guideX = el("div", "", document.body);
    guideY = el("div", "", document.body);
    css(guideX, { position: "fixed", top: "0", bottom: "0", width: "1px", background: "rgba(57,119,246,0.46)", pointerEvents: "none", zIndex: "2147482999", display: "none" });
    css(guideY, { position: "fixed", left: "0", right: "0", height: "1px", background: "rgba(57,119,246,0.46)", pointerEvents: "none", zIndex: "2147482999", display: "none" });
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && selected) {
        clearSelection(true);
      }
    }, true);
  }

  function rectOf(target) {
    var rect = target.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
  }

  function positionOverlay(rect) {
    if (!overlay) return;
    css(overlay, { display: "block", left: rect.left + "px", top: rect.top + "px", width: rect.width + "px", height: rect.height + "px" });
    for (var i = 0; i < handles.length; i++) {
      var pos = handles[i].dataset.pos;
      var left = pos.indexOf("w") >= 0 ? -4 : pos.indexOf("e") >= 0 ? rect.width - 3 : rect.width / 2 - 3.5;
      var top = pos.indexOf("n") >= 0 ? -4 : pos.indexOf("s") >= 0 ? rect.height - 3 : rect.height / 2 - 3.5;
      css(handles[i], { left: left + "px", top: top + "px" });
      handles[i].style.display = selected ? "block" : "none";
    }
  }

  function describe(target) {
    if (!target || target === document.body || target === document.documentElement) return null;
    var tag = String(target.tagName || "").toLowerCase();
    var text = (target.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
    var cls = typeof target.className === "string" ? target.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
    var id = target.id ? "#" + target.id : "";
    var kind = "element";
    if (/^(button|a|input|select|textarea)$/.test(tag)) kind = "button";
    else if (/^(h1|h2|h3|h4|p|span|label)$/.test(tag) && text && text.length < 40) kind = "Text";
    else if (/^(img|svg|canvas|video)$/.test(tag)) kind = "Image";
    else if (/^(section|nav|header|footer|main|aside|div)$/.test(tag) && cls) kind = "section";
    var name = cls || id || tag;
    var display = tag + (cls ? " · " + (cls.split(".")[0] || name) : "") + (text ? " · " + text : "");
    return { tag: tag, kind: kind, name: name.slice(0, 48), label: display.slice(0, 48), text: text };
  }

  function matchedRules(target) {
    var rules = [];
    try {
      for (var s = 0; s < document.styleSheets.length; s++) {
        var sheet = document.styleSheets[s];
        var file = null;
        try {
          if (sheet.ownerNode && sheet.ownerNode.dataset && sheet.ownerNode.dataset.viteDevId) file = sheet.ownerNode.dataset.viteDevId;
          else if (sheet.href && /^\/(src|styles?|css|assets)\//.test(new URL(sheet.href, location.href).pathname)) {
            file = new URL(sheet.href, location.href).pathname.replace(/^\/+/, "");
          }
        } catch (e) { file = null; }
        var cssRules = sheet.cssRules || sheet.rules || [];
        for (var r = 0; r < cssRules.length; r++) {
          var rule = cssRules[r];
          if (!rule.selectorText) continue;
          var matched = false;
          try { matched = target.matches(rule.selectorText); } catch (e) { matched = false; }
          if (!matched) continue;
          var declarations = {};
          var style = rule.style;
          for (var p = 0; p < style.length; p++) {
            var prop = style[p];
            if (prop.indexOf("--") === 0) continue;
            declarations[prop] = style.getPropertyValue(prop);
          }
          rules.push({ file: file, selector: rule.selectorText, declarations: declarations });
          if (rules.length >= 10) break;
        }
        if (rules.length >= 10) break;
      }
    } catch (e) { /* cross-origin sheets are skipped */ }
    return rules;
  }

  function serialize(target) {
    var info = describe(target);
    if (!info) return null;
    var rect = rectOf(target);
    var computed = getComputedStyle(target);
    var styles = {};
    ["display", "position", "width", "height", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
      "marginTop", "marginRight", "marginBottom", "marginLeft", "gap", "flexDirection", "alignItems",
      "justifyContent", "fontFamily", "fontSize", "fontWeight", "color", "backgroundColor", "borderColor",
      "borderWidth", "borderStyle", "borderRadius", "opacity", "boxShadow", "objectFit", "zIndex", "flexGrow",
      "flexShrink", "gridTemplateColumns", "gridColumn", "gridRow"].forEach(function (prop) {
      styles[prop] = computed.getPropertyValue(prop);
    });
    var path = [];
    var cursor = target;
    while (cursor && cursor !== document.body && path.length < 8) {
      var nodeInfo = describe(cursor);
      if (nodeInfo) path.unshift(nodeInfo.label);
      cursor = cursor.parentElement;
    }
    if (!elements.has(target)) {
      selectedId += 1;
      elements.set(target, selectedId);
      elementIds.push(selectedId);
      elementById[selectedId] = target;
    }
    return {
      elId: elements.get(target),
      tag: info.tag,
      kind: info.kind,
      name: info.name,
      label: info.label,
      text: info.text,
      bounds: rect,
      styles: styles,
      rules: matchedRules(target),
      domPath: path.join(" > "),
      url: location.href,
      sourceHint: (matchedRules(target).find(function (rule) { return rule.file; }) || {}).file || null,
    };
  }

  function onMove(event) {
    if (!mode) return;
    var target = event.target;
    if (!target || target.nodeType !== 1) return;
    if (dragState) return;
    var info = describe(target);
    var rect = rectOf(target);
    positionOverlay(rect);
    if (label && info) label.textContent = info.kind + " · " + info.label;
  }

  function onClick(event) {
    if (!mode) return;
    event.preventDefault();
    event.stopPropagation();
    var target = event.target;
    if (target === overlay || overlay.contains(target)) return;
    var payload = serialize(target);
    if (!payload) return;
    selected = payload.elId;
    positionOverlay(payload.bounds);
    if (label) label.textContent = payload.kind + " · " + payload.label;
    window.parent.postMessage({ type: "clyra:element", payload: payload }, "*");
  }

  function startDrag(event, pos) {
    if (!selected) return;
    var target = elementById[selected];
    if (!target) return;
    var startX = event.clientX;
    var startY = event.clientY;
    var startRect = rectOf(target);
    var computed = getComputedStyle(target);
    var absolute = computed.position === "absolute" || computed.position === "fixed";
    var startLeft = parseFloat(computed.left);
    var startTop = parseFloat(computed.top);
    if (!isFinite(startLeft)) startLeft = target.offsetLeft || 0;
    if (!isFinite(startTop)) startTop = target.offsetTop || 0;
    dragState = { target: target, startX: startX, startY: startY, startRect: startRect, pos: pos, absolute: absolute, startLeft: startLeft, startTop: startTop, styles: {} };
    event.preventDefault();
    event.stopPropagation();
    var move = function (moveEvent) {
      if (!dragState) return;
      var dx = moveEvent.clientX - dragState.startX;
      var dy = moveEvent.clientY - dragState.startY;
      var pos = dragState.pos;
      var rect = { left: dragState.startRect.left, top: dragState.startRect.top, width: dragState.startRect.width, height: dragState.startRect.height };
      var styles = {};
      if (pos === "move") {
        if (!dragState.absolute) return;
        rect.left += dx;
        rect.top += dy;
        styles.left = Math.round(dragState.startLeft + dx) + "px";
        styles.top = Math.round(dragState.startTop + dy) + "px";
      } else if (dragState.absolute) {
        if (pos.indexOf("w") >= 0) { rect.left += dx; rect.width -= dx; styles.left = Math.round(dragState.startLeft + dx) + "px"; }
        if (pos.indexOf("e") >= 0) { rect.width += dx; }
        if (pos.indexOf("n") >= 0) { rect.top += dy; rect.height -= dy; styles.top = Math.round(dragState.startTop + dy) + "px"; }
        if (pos.indexOf("s") >= 0) { rect.height += dy; }
      } else {
        if (pos.indexOf("w") >= 0) { rect.width -= dx; }
        if (pos.indexOf("e") >= 0) { rect.width += dx; }
        if (pos.indexOf("n") >= 0) { rect.height -= dy; }
        if (pos.indexOf("s") >= 0) { rect.height += dy; }
      }
      rect.width = Math.max(8, rect.width);
      rect.height = Math.max(8, rect.height);
      if (pos !== "move") {
        styles.width = Math.round(rect.width) + "px";
        styles.height = Math.round(rect.height) + "px";
      }
      dragState.styles = styles;
      for (var key in styles) dragState.target.style[key] = styles[key];
      if (measure) {
        measure.style.display = "block";
        measure.textContent = Math.round(rect.width) + " × " + Math.round(rect.height);
      }
      positionOverlay(rect);
      if (guideX && guideY) {
        guideX.style.display = "block";
        guideY.style.display = "block";
        guideX.style.left = Math.round(rect.left + rect.width / 2) + "px";
        guideY.style.top = Math.round(rect.top + rect.height / 2) + "px";
      }
      window.parent.postMessage({ type: "clyra:measure", rect: rect }, "*");
    };
    var up = function () {
      if (!dragState) return;
      var rect = rectOf(dragState.target);
      window.parent.postMessage({
        type: "clyra:drag",
        elId: selected,
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        startRect: dragState.startRect,
        absolute: dragState.absolute,
        styles: dragState.styles,
      }, "*");
      dragState = null;
      if (measure) measure.style.display = "none";
      if (guideX && guideY) { guideX.style.display = "none"; guideY.style.display = "none"; }
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function clearSelection(notify) {
    selected = null;
    dragState = null;
    if (overlay) {
      css(overlay, { display: "none" });
      for (var i = 0; i < handles.length; i++) handles[i].style.display = "none";
    }
    if (guideX && guideY) { guideX.style.display = "none"; guideY.style.display = "none"; }
    if (notify) window.parent.postMessage({ type: "clyra:clear" }, "*");
  }

  window.addEventListener("message", function (event) {
    var message = event.data || {};
    if (!message || typeof message !== "object") return;
    if (message.type === "clyra:mode") {
      mode = Boolean(message.mode);
      buildOverlay();
      if (!mode) clearSelection(false);
      return;
    }
    if (message.type === "clyra:clear") {
      clearSelection(false);
      return;
    }
    if (message.type === "clyra:style") {
      var target = elementById[message.elId];
      if (target && message.styles) {
        for (var key in message.styles) target.style[key] = message.styles[key];
      }
      return;
    }
  });

  window.__clyraInspect = {
    setMode: function (next) {
      mode = Boolean(next);
      buildOverlay();
      if (!mode) clearSelection(false);
    },
    select: function (elId) {
      var target = elementById[elId];
      if (!target) return;
      selected = elId;
      var payload = serialize(target);
      positionOverlay(payload.bounds);
    },
  };
})();
