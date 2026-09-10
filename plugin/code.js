/**
 * Main thread: Plugin API only (no fetch / WebSocket).
 * Jobs are allowlisted structured commands — no free-form eval.
 */
figma.showUI(__html__, { width: 320, height: 300, themeColors: true });

function snapshot() {
  return {
    fileName: figma.root.name,
    fileKey: typeof figma.fileKey === "string" ? figma.fileKey : undefined,
    editorType: figma.editorType,
    pageName: figma.currentPage.name,
    currentUser: figma.currentUser ? figma.currentUser.name : undefined,
  };
}

function idsFrom(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const ids = value.filter((item) => typeof item === "string");
  return ids.length > 0 ? ids : undefined;
}

function sanitize(value, depth) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (depth > 5) {
    return "[Truncated]";
  }
  if (typeof value.id === "string" && typeof value.type === "string") {
    return { id: value.id, name: value.name, type: value.type };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitize(item, depth + 1));
  }
  const out = {};
  const entries = Object.entries(value).slice(0, 50);
  for (const [key, nested] of entries) {
    try {
      out[key] = sanitize(nested, depth + 1);
    } catch {
      out[key] = "[Unserializable]";
    }
  }
  return out;
}

async function executeCommand(command) {
  if (!command || typeof command !== "object") {
    throw new Error("Missing command.");
  }
  const op = command.op;
  if (op === "create_frame") {
    const frame = figma.createFrame();
    frame.name = typeof command.name === "string" && command.name ? command.name : "Frame";
    const width = typeof command.width === "number" && command.width > 0 ? command.width : 400;
    const height = typeof command.height === "number" && command.height > 0 ? command.height : 300;
    frame.resize(width, height);
    if (typeof command.x === "number") {
      frame.x = command.x;
    }
    if (typeof command.y === "number") {
      frame.y = command.y;
    }
    figma.currentPage.selection = [frame];
    figma.viewport.scrollAndZoomIntoView([frame]);
    return { createdNodeIds: [frame.id], name: frame.name, type: frame.type };
  }
  if (op === "set_text") {
    if (typeof command.id !== "string" || !command.id) {
      throw new Error("set_text requires id.");
    }
    const node = await figma.getNodeByIdAsync(command.id);
    if (!node || node.type !== "TEXT") {
      throw new Error("Node " + command.id + " is not a TEXT node.");
    }
    const font = node.fontName;
    if (font === figma.mixed) {
      await figma.loadFontAsync({ family: "Inter", style: "Regular" });
      node.fontName = { family: "Inter", style: "Regular" };
    } else {
      await figma.loadFontAsync(font);
    }
    node.characters = typeof command.characters === "string" ? command.characters : "";
    return { mutatedNodeIds: [node.id] };
  }
  throw new Error(
    "Unknown command. Allowlisted ops: create_frame, set_text. Free-form Plugin API JavaScript is not enabled.",
  );
}

figma.ui.onmessage = async (msg) => {
  if (!msg || typeof msg !== "object") {
    return;
  }

  if (msg.type === "snapshot") {
    figma.ui.postMessage({ type: "snapshot", payload: snapshot() });
    return;
  }

  if (msg.type === "run") {
    figma.ui.postMessage({
      type: "result",
      id: typeof msg.id === "string" ? msg.id : "",
      ok: false,
      error: "Free-form JS eval is disabled. Use allowlisted commands (create_frame, set_text).",
    });
    return;
  }

  if (msg.type !== "command" || typeof msg.id !== "string") {
    return;
  }

  try {
    if (figma.editorType !== "figma") {
      throw new Error(
        "This bridge supports Figma Design files. FigJam/Slides/Buzz are not supported in this pass.",
      );
    }
    const raw = await executeCommand(msg.command);
    const cleaned = sanitize(raw, 0);
    const createdNodeIds = idsFrom(cleaned && cleaned.createdNodeIds);
    const mutatedNodeIds = idsFrom(cleaned && cleaned.mutatedNodeIds);
    figma.ui.postMessage({
      type: "result",
      id: msg.id,
      ok: true,
      result: cleaned,
      createdNodeIds,
      mutatedNodeIds,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    figma.ui.postMessage({
      type: "result",
      id: msg.id,
      ok: false,
      error,
    });
  }
};

figma.on("currentpagechange", () => {
  figma.ui.postMessage({ type: "snapshot", payload: snapshot() });
});

figma.ui.postMessage({ type: "snapshot", payload: snapshot() });
