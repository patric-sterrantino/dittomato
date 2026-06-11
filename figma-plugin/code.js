figma.showUI(__html__, { width: 480, height: 620, title: 'Dittomato' });

function isInfoComponent(node) {
  if (node.name && node.name.trim().toLowerCase() === 'info') return true;
  if (node.type === 'INSTANCE' && node.mainComponent &&
      node.mainComponent.name.trim().toLowerCase() === 'info') return true;
  return false;
}

let scanOptions = { ignoreHidden: false, autoScan: true };

function collectTextNodes(node, results) {
  if (!results) results = [];
  // Skip "Info" components and their entire subtree
  if (isInfoComponent(node)) return results;
  // Skip hidden layers (and their subtree) if the option is on
  if (scanOptions.ignoreHidden && node.visible === false) return results;
  if (node.type === 'TEXT') {
    const text = node.characters.trim();
    if (text.length >= 2) {
      results.push({ nodeId: node.id, layerName: node.name, text });
    }
  }
  if ('children' in node) {
    for (const child of node.children) {
      collectTextNodes(child, results);
    }
  }
  return results;
}

function suggestPrefix(sel) {
  if (!sel.length) return '';
  var start = sel[0];
  // Walk up from the selected node (or its parent if it's a text node)
  var current = (start.type === 'TEXT') ? start.parent : start;
  var parts = [];
  while (current && current.type !== 'PAGE' && parts.length < 2) {
    if (['FRAME', 'SECTION', 'COMPONENT_SET'].indexOf(current.type) !== -1) {
      parts.unshift(current.name);
    }
    current = current.parent;
  }
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

function scan() {
  const sel = figma.currentPage.selection;
  if (!sel.length) {
    figma.ui.postMessage({ type: 'no-selection' });
    return;
  }
  var nodes = [];
  for (var si = 0; si < sel.length; si++) collectTextNodes(sel[si], nodes);
  figma.ui.postMessage({ type: 'scan-result', nodes, suggestedPrefix: suggestPrefix(sel) });
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
