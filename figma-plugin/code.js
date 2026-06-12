figma.showUI(__html__, { width: 480, height: 620, title: 'Dittomato' });

function isInfoComponent(node) {
  if (node.name && node.name.trim().toLowerCase() === 'info') return true;
  if (node.type === 'INSTANCE' && node.mainComponent &&
      node.mainComponent.name.trim().toLowerCase() === 'info') return true;
  return false;
}

let scanOptions = { ignoreHidden: true, autoScan: true };

function collectTextNodes(node, results, parentHidden, ignored) {
  if (!results) results = [];
  if (!ignored) ignored = [];
  if (isInfoComponent(node)) return results;
  // A node is effectively hidden if it or any ancestor has visible=false.
  // parentHidden propagates that state down so visible children of a hidden
  // parent are still excluded when "Skip hidden" is on.
  var hidden = parentHidden || node.visible === false;
  if (scanOptions.ignoreHidden && hidden) return results;
  if (node.type === 'TEXT') {
    if (node.name.startsWith('//')) {
      // Collect separately so the UI can show an Ignored section
      ignored.push({ nodeId: node.id, layerName: node.name, text: node.characters.trim() });
    } else {
      const text = node.characters.trim();
      if (text.length >= 2) {
        var annId = nodeAnnotationId(node);
        var entry = { nodeId: node.id, layerName: node.name, text };
        if (annId) entry.annotationId = annId;
        results.push(entry);
      }
    }
  }
  if ('children' in node) {
    for (const child of node.children) {
      collectTextNodes(child, results, hidden, ignored);
    }
  }
  return results;
}

function suggestPrefix(sel) {
  if (!sel.length) return '';
  var start = sel[0];

  // Collect all ancestors from the selection up to (but not including) PAGE.
  // ancestors[0] = direct child of PAGE (top-most), last = nearest parent.
  var ancestors = [];
  var cur = (start.type === 'TEXT') ? start.parent : start;
  while (cur && cur.type !== 'PAGE') {
    ancestors.unshift(cur);
    cur = cur.parent;
  }

  // Find the section ancestor (if any) — scan all ancestors, not just the top one
  var sectionIdx = -1;
  for (var i = 0; i < ancestors.length; i++) {
    if (ancestors[i].type === 'SECTION') { sectionIdx = i; break; }
  }
  // Find the top-level frame: first FRAME/COMPONENT_SET starting after the section
  // (or from the top of the ancestry when there is no section)
  var frameIdx = -1;
  for (var i = sectionIdx + 1; i < ancestors.length; i++) {
    if (ancestors[i].type === 'FRAME' || ancestors[i].type === 'COMPONENT_SET') {
      frameIdx = i;
      break;
    }
  }

  var parts = [];
  if (sectionIdx >= 0) parts.push(ancestors[sectionIdx].name);
  if (frameIdx >= 0)   parts.push(ancestors[frameIdx].name);

  var fileName = figma.root ? figma.root.name : '';
  if (fileName) parts.unshift(fileName);
  var sanitized = parts
    .map(function(p) {
      var words = p.trim().split(/\s+/).slice(0, 3).join(' ');
      return words.toLowerCase()
        .replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-').replace(/^-|-$/g, '');
    })
    .filter(Boolean);
  return sanitized.length ? sanitized.join('.') + '.' : '';
}

// Extract the first Ditto developer-ID-like token from a string.
// Matches e.g. "marketing.hero.title" or "nav-menu.item" but not plain words.
function extractDittoId(str) {
  var m = String(str || '').match(/\b([a-z][a-z0-9]*(?:[.\-][a-z0-9]+)+)\b/);
  return m ? m[1] : null;
}

// Return a Ditto ID from a node's Dev Mode annotations, or null.
function nodeAnnotationId(node) {
  try {
    if (node.annotations && node.annotations.length) {
      for (var i = 0; i < node.annotations.length; i++) {
        var id = extractDittoId(String(node.annotations[i].label || ''));
        if (id) return id;
      }
    }
  } catch(e) {}
  return null;
}

function scan() {
  const sel = figma.currentPage.selection;
  if (!sel.length) {
    figma.ui.postMessage({ type: 'no-selection' });
    return;
  }
  var nodes = [];
  var ignoredNodes = [];
  for (var si = 0; si < sel.length; si++) {
    // Seed parentHidden so that a directly-selected node whose parent is
    // hidden is still excluded when "Skip hidden" is on.
    var ancestorHidden = false;
    if (scanOptions.ignoreHidden) {
      var anc = sel[si].parent;
      while (anc && anc.type !== 'PAGE') {
        if (anc.visible === false) { ancestorHidden = true; break; }
        anc = anc.parent;
      }
    }
    collectTextNodes(sel[si], nodes, ancestorHidden, ignoredNodes);
  }
  figma.ui.postMessage({ type: 'scan-result', nodes, ignored: ignoredNodes, suggestedPrefix: suggestPrefix(sel) });
}

// Load stored key and send to UI, then trigger first scan
figma.clientStorage.getAsync('dittoKey').then(val => {
  figma.ui.postMessage({ type: 'key-loaded', value: val || '' });
  scan();
});

figma.on('selectionchange', () => { if (scanOptions.autoScan) scan(); });

// Load all fonts used by a text node then swap its characters.
async function applyText(tnode, newText) {
  if (tnode.fontName && typeof tnode.fontName === 'object' && 'family' in tnode.fontName) {
    await figma.loadFontAsync(tnode.fontName);
  } else {
    var seen = {};
    var len  = tnode.characters.length;
    for (var fc = 0; fc < len; fc++) {
      var fn = tnode.getRangeFontName(fc, fc + 1);
      if (fn && typeof fn === 'object' && 'family' in fn) {
        var fk = fn.family + '/' + fn.style;
        if (!seen[fk]) { seen[fk] = 1; await figma.loadFontAsync(fn); }
      }
    }
  }
  tnode.characters = String(newText);
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'save-key') {
    await figma.clientStorage.setAsync('dittoKey', msg.value);
    return;
  }

  if (msg.type === 'set-options') {
    scanOptions = Object.assign({}, scanOptions, msg.options);
    scan(); // re-apply immediately so results reflect the new filter
    return;
  }

  if (msg.type === 'rescan') {
    scan();
    return;
  }

  if (msg.type === 'rename-layers') {
    let count = 0;
    for (var ri = 0; ri < msg.renames.length; ri++) {
      var nodeId = msg.renames[ri].nodeId;
      var newName = msg.renames[ri].newName;
      try {
        var node = await figma.getNodeByIdAsync(nodeId);
        if (node && 'name' in node) { node.name = newName; count++; }
      } catch (e) { /* node may have been deleted */ }
    }
    figma.notify(count
      ? `🍅 Renamed ${count} layer${count !== 1 ? 's' : ''}`
      : 'No layers renamed');
    figma.ui.postMessage({ type: 'rename-done', count });
    return;
  }

  if (msg.type === 'rename-and-rescan') {
    for (var ri = 0; ri < msg.renames.length; ri++) {
      try {
        var rnode = await figma.getNodeByIdAsync(msg.renames[ri].nodeId);
        if (rnode && 'name' in rnode) rnode.name = msg.renames[ri].newName;
      } catch(e) {}
    }
    scan();
    return;
  }

  if (msg.type === 'text-rename-rescan') {
    // Apply Ditto text to Figma nodes, then rename layers, then rescan
    var textIds = Object.keys(msg.textMap || {});
    for (var ti = 0; ti < textIds.length; ti++) {
      try {
        var tnode = await figma.getNodeByIdAsync(textIds[ti]);
        if (tnode && tnode.type === 'TEXT') await applyText(tnode, msg.textMap[textIds[ti]]);
      } catch(e) {}
    }
    for (var ri = 0; ri < (msg.renames || []).length; ri++) {
      try {
        var rnode = await figma.getNodeByIdAsync(msg.renames[ri].nodeId);
        if (rnode && 'name' in rnode) rnode.name = msg.renames[ri].newName;
      } catch(e) {}
    }
    scan();
    return;
  }

  if (msg.type === 'apply-variant') {
    var updCount = 0;
    var updNodes = [];
    var errors   = [];

    if (msg.nodeMap) {
      // Real translation: resolve nodes directly by ID (no selection walk needed).
      var nodeIds = Object.keys(msg.nodeMap);
      for (var ni = 0; ni < nodeIds.length; ni++) {
        var nodeId  = nodeIds[ni];
        var newText = msg.nodeMap[nodeId];
        try {
          var tnode = await figma.getNodeByIdAsync(nodeId);
          if (!tnode || tnode.type !== 'TEXT') continue;
          await applyText(tnode, newText);
          updCount++;
          updNodes.push(tnode);
        } catch(e) {
          errors.push(nodeId + ': ' + (e && e.message ? e.message : e));
        }
      }
    } else if (msg.transMap) {
      // Debug test: walk selection and match by layer name.
      var sel   = figma.currentPage.selection;
      var stack = [];
      for (var si = 0; si < sel.length; si++) stack.push(sel[si]);
      while (stack.length) {
        var curr = stack.pop();
        if (curr.type === 'TEXT') {
          var newText = msg.transMap[curr.name];
          if (newText !== undefined && newText !== null) {
            try {
              await applyText(curr, newText);
              updCount++;
              updNodes.push(curr);
            } catch(e) {
              errors.push(curr.name + ': ' + (e && e.message ? e.message : e));
            }
          }
        } else if ('children' in curr) {
          for (var ci = 0; ci < curr.children.length; ci++) stack.push(curr.children[ci]);
        }
      }
    }

    if (updNodes.length) figma.viewport.scrollAndZoomIntoView(updNodes);

    figma.notify(updCount
      ? '🍅 Translated ' + updCount + ' layer' + (updCount !== 1 ? 's' : '')
      : 'No layers updated');
    figma.ui.postMessage({ type: 'translate-done', count: updCount, errors: errors });
    return;
  }

  if (msg.type === 'close') {
    figma.closePlugin();
  }
};
