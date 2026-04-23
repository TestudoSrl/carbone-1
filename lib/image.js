/**
 * Row-level dynamic images for Carbone (Testudo fork).
 *
 * Adds support equivalent to Carbone Cloud's `:generateImage()` formatter.
 * A template author writes an image placeholder with a Carbone marker in the
 * alt-text / description. At render time the image is cloned per loop
 * iteration and each copy gets a distinct payload (data URI).
 *
 * DOCX:
 *   <w:r><w:drawing>…
 *     <wp:docPr id="3" name="sig"
 *       descr="{d.rows[i].order.signatureImage:generateImage()}"/>
 *     …<a:blip r:embed="rId5"/>…
 *   </w:drawing></w:r>
 *
 * Data passed to carbone.render():
 *   { rows: [
 *     { order: { signatureImage: "data:image/png;base64,AAA…" } },
 *     { order: { signatureImage: "data:image/png;base64,BBB…" } }
 *   ]}
 *
 * Pipeline (invoked from lib/preprocessor.js and lib/index.js):
 *
 *   [1] scanImageMarkers(template, format) — called from preprocessor.execute()
 *       For each image placeholder whose descr contains a Carbone marker ending
 *       in `:generateImage()`, allocate a sequential imgId, rename the docPr
 *       `name` attribute to `_carbone_img_<imgId>` (a stable tag for later
 *       retrieval), clear the descr, and inject a hidden text run next to the
 *       drawing containing `{…:_carboneImage(imgId)}`. Carbone's normal
 *       loop-expansion duplicates both the drawing and the hidden run together.
 *
 *   [2] applyImagePatches(report, format) — called after walkFiles, before
 *       file.buildFile(). Scans each document for token pairs emitted by the
 *       `_carboneImage` formatter, decodes the data URI, emits a new media
 *       file, allocates a new relationship id, rewrites the adjacent drawing's
 *       <a:blip r:embed="…"/> to point at it, strips the hidden run, and
 *       registers the media extension in [Content_Types].xml / manifest.xml.
 *
 * Only data URIs (`data:image/<mime>;base64,<body>`) are accepted as payloads
 * on purpose — HTTP fetching is deliberately out of scope for this iteration.
 */

var path   = require('path');
var helper = require('./helper');

// Tokens emitted by the `_carboneImage` formatter. Chosen so that each side
// contains only characters safe inside <w:t> / <text:p> without XML escaping.
var TOKEN_START = '__CBIMG__';
var TOKEN_SEP   = '__#__';
var TOKEN_END   = '__GMICBC__';

// Attribute prefix used to tag image placeholders in the template so the
// post-processor can locate them deterministically after loop expansion.
var DOCPR_NAME_PREFIX = '_carbone_img_';

// Regex fragment matching a Carbone marker whose last formatter is
// `:generateImage(...)`. Captures the path up to (but not including) the
// `:generateImage` call.
var GENERATE_IMAGE_MARKER_RE = /\{\s*([cdt][.\[][^}]*?)\s*:\s*generateImage\s*\([^}]*\)\s*\}/;

var IMAGE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

var image = {

  TOKEN_START       : TOKEN_START,
  TOKEN_SEP         : TOKEN_SEP,
  TOKEN_END         : TOKEN_END,
  DOCPR_NAME_PREFIX : DOCPR_NAME_PREFIX,

  /**
   * Pre-process a template's XML files, registering image markers and
   * injecting the hidden text markers that the builder will expand per row.
   *
   * @param {Object} template — as produced by file.openTemplate / file.unzip
   * @param {String} format   — 'docx' | 'odt' | 'xlsx' (others: no-op)
   */
  scanImageMarkers : function (template, format) {
    if (!template || !Array.isArray(template.files)) {
      return;
    }
    template._carboneImageRegistry = { nextId : 0, entries : {} };
    if (format === 'docx') {
      return scanDocx(template);
    }
    // phase 1b/1c adds odt and xlsx here
  },

  /**
   * Post-process the rendered report, turning the `_carboneImage` tokens into
   * real media files + relationships and patching the adjacent drawings.
   *
   * @param {Object} report — as passed to file.buildFile
   * @param {String} format — 'docx' | 'odt' | 'xlsx' (others: no-op)
   */
  applyImagePatches : function (report, format) {
    if (!report || !Array.isArray(report.files)) {
      return;
    }
    if (format === 'docx') {
      return applyDocx(report);
    }
    // phase 1b/1c adds odt and xlsx here
  },

  // Exposed for unit tests only. Not part of the public API.
  _internal : {
    parseDataUri        : parseDataUri,
    decodeXmlAttrValue  : decodeXmlAttrValue,
    GENERATE_IMAGE_MARKER_RE : GENERATE_IMAGE_MARKER_RE
  }

};

module.exports = image;

// ─────────────────────────────────────────────────────────────────────────────
// DOCX
// ─────────────────────────────────────────────────────────────────────────────

function scanDocx (template) {
  var relsByDoc = indexRelsByDoc(template, /^word\//);
  for (var i = 0; i < template.files.length; i++) {
    var f = template.files[i];
    if (!f || typeof f.data !== 'string') { continue; }
    if (!/^word\/(document|header\d*|footer\d*)\.xml$/.test(f.name)) { continue; }
    var relsKey = f.name.replace(/\.xml$/, '');
    f.data = scanDocxContent(f.data, relsByDoc[relsKey] || null, template._carboneImageRegistry);
  }
}

function scanDocxContent (xml, relsFile, registry) {
  // Pass 1 — find each <w:drawing>…</w:drawing> block whose docPr carries a
  // generateImage marker. Mutate docPr in place: give the drawing a stable
  // `name="_carbone_img_<imgId>"` and blank the descr (so the raw marker
  // doesn't leak into the rendered alt-text).
  xml = xml.replace(/<w:drawing\b[\s\S]*?<\/w:drawing>/g, function (drawingXml) {
    var docPrMatch = /<wp:docPr\b([^/>]*?)\s*\/>/.exec(drawingXml);
    if (!docPrMatch) { return drawingXml; }
    var attrs = docPrMatch[1];
    var descrMatch = /\bdescr="([^"]*)"/.exec(attrs);
    if (!descrMatch) { return drawingXml; }
    var descr = decodeXmlAttrValue(descrMatch[1]);
    var markerMatch = GENERATE_IMAGE_MARKER_RE.exec(descr);
    if (!markerMatch) { return drawingXml; }
    var markerPath = markerMatch[1];

    var blipMatch = /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(drawingXml);
    if (!blipMatch) { return drawingXml; }
    var origRelId = blipMatch[1];

    var origMedia = null;
    if (relsFile && typeof relsFile.data === 'string') {
      var relRe = new RegExp(
        '<Relationship\\b[^>]*\\bId="' + helper.regexEscape(origRelId) +
        '"[^>]*\\bTarget="([^"]+)"'
      );
      var relMatch = relRe.exec(relsFile.data);
      if (relMatch) { origMedia = relMatch[1]; }
    }

    var imgId = ++registry.nextId;
    registry.entries[imgId] = {
      format     : 'docx',
      relsFile   : relsFile ? relsFile.name : null,
      origRelId  : origRelId,
      origMedia  : origMedia,
      markerPath : markerPath
    };

    // Rewrite docPr: stable name + empty descr.
    var newAttrs = attrs.replace(/\bdescr="[^"]*"/, 'descr=""');
    if (/\bname="/.test(newAttrs)) {
      newAttrs = newAttrs.replace(/\bname="[^"]*"/,
        'name="' + DOCPR_NAME_PREFIX + imgId + '"');
    }
    else {
      newAttrs = ' name="' + DOCPR_NAME_PREFIX + imgId + '"' + newAttrs;
    }
    return drawingXml.replace(docPrMatch[0], '<wp:docPr' + newAttrs + '/>');
  });

  // Pass 2 — for each registered imgId, locate the <w:drawing>'s enclosing
  // <w:r>…</w:r> and append a sibling hidden run carrying the Carbone marker
  // that will be expanded by the builder once per loop iteration.
  for (var imgIdStr in registry.entries) {
    if (!registry.entries.hasOwnProperty(imgIdStr)) { continue; }
    var entry = registry.entries[imgIdStr];
    if (entry.format !== 'docx') { continue; }
    var imgId = parseInt(imgIdStr, 10);
    var nameAttr = DOCPR_NAME_PREFIX + imgId;
    var re = new RegExp(
      '(<w:r\\b[^>]*>[\\s\\S]*?<w:drawing\\b[\\s\\S]*?<wp:docPr\\b[^/>]*\\bname="' +
      helper.regexEscape(nameAttr) +
      '"[^/>]*?/>[\\s\\S]*?<\\/w:drawing>[\\s\\S]*?<\\/w:r>)',
      'g'
    );
    xml = xml.replace(re, function (runXml) {
      var token = '{' + entry.markerPath + ':_carboneImage(' + imgId + ')}';
      var hidden = '<w:r><w:rPr><w:vanish/></w:rPr>' +
                   '<w:t xml:space="preserve">' + token + '</w:t></w:r>';
      return runXml + hidden;
    });
  }

  return xml;
}

function applyDocx (report) {
  var filesByName = {};
  for (var i = 0; i < report.files.length; i++) {
    filesByName[report.files[i].name] = report.files[i];
  }

  var contentTypesFile = filesByName['[Content_Types].xml'];
  var extSeen = {};
  var nextMediaUid = 1;
  var nextRelId = computeNextFreeRelId(report);

  for (var i = 0; i < report.files.length; i++) {
    var f = report.files[i];
    if (!f || typeof f.data !== 'string') { continue; }
    if (!/^word\/(document|header\d*|footer\d*)\.xml$/.test(f.name)) { continue; }
    var relsKey = f.name.replace(/\.xml$/, '.xml.rels')
                         .replace(/^(.*\/)?([^/]+)$/, '$1_rels/$2');
    // word/document.xml → word/_rels/document.xml.rels
    var relsFile = filesByName[computeRelsPath(f.name)];
    if (!relsFile) { continue; }

    var state = {
      extSeen      : extSeen,
      newMedia     : [],
      newRelXml    : [],
      nextRelId    : nextRelId,
      nextMediaUid : nextMediaUid,
      docPath      : f.name
    };
    f.data = rewriteDocxDocument(f.data, state);
    nextRelId = state.nextRelId;
    nextMediaUid = state.nextMediaUid;

    if (state.newRelXml.length > 0) {
      relsFile.data = appendRelationships(relsFile.data, state.newRelXml);
    }
    for (var j = 0; j < state.newMedia.length; j++) {
      report.files.push(state.newMedia[j]);
      filesByName[state.newMedia[j].name] = state.newMedia[j];
    }
  }

  if (contentTypesFile && Object.keys(extSeen).length > 0) {
    contentTypesFile.data = mergeContentTypes(contentTypesFile.data, extSeen);
  }
}

function rewriteDocxDocument (xml, state) {
  // Collect all tokens first so we know which imgIds appear in this document.
  var imgIdsInDoc = collectTokenImgIds(xml);
  if (imgIdsInDoc.length === 0) { return xml; }

  for (var i = 0; i < imgIdsInDoc.length; i++) {
    var imgId = imgIdsInDoc[i];
    var nameAttr = DOCPR_NAME_PREFIX + imgId;
    // Match: drawing-run for this imgId, interstitial XML, token-run carrying
    // the payload. (?: (?!<w:r\b)[\s\S])*? in the hidden-run segments keeps
    // the match inside a single run so it can't swallow unrelated runs.
    var pairRe = new RegExp(
      '(<w:r\\b[^>]*>[\\s\\S]*?<w:drawing\\b[\\s\\S]*?<wp:docPr\\b[^/>]*\\bname="' +
      helper.regexEscape(nameAttr) +
      '"[^/>]*?/>[\\s\\S]*?<a:blip\\b[^>]*\\br:embed=")([^"]+)(' +
      '"[^/>]*\\/?>[\\s\\S]*?<\\/w:drawing>[\\s\\S]*?<\\/w:r>)' +
      '([\\s\\S]*?)' +
      '<w:r\\b[^>]*>(?:(?!<w:r\\b)[\\s\\S])*?<w:t\\b[^>]*>' + helper.regexEscape(TOKEN_START) +
      imgId + helper.regexEscape(TOKEN_SEP) +
      '([\\s\\S]*?)' + helper.regexEscape(TOKEN_END) +
      '<\\/w:t>(?:(?!<w:r\\b)[\\s\\S])*?<\\/w:r>',
      'g'
    );
    xml = xml.replace(pairRe, function (_m, drawingHead, _origRelId, drawingTail, between, payload) {
      var parsed = parseDataUri(payload, imgId);
      var uid = 'carbone_img_' + (state.nextMediaUid++);
      var mediaFileName = 'word/media/' + uid + '.' + parsed.ext;
      state.newMedia.push({
        name   : mediaFileName,
        data   : parsed.buffer,
        parent : ''
      });
      var newRelId = 'rId' + (state.nextRelId++);
      state.newRelXml.push(
        '<Relationship Id="' + newRelId + '" Type="' + IMAGE_REL_TYPE +
        '" Target="media/' + uid + '.' + parsed.ext + '"/>'
      );
      state.extSeen[parsed.ext] = parsed.mime;
      return drawingHead + newRelId + drawingTail + between;
    });
  }

  return xml;
}

function collectTokenImgIds (xml) {
  var seen = {};
  var out = [];
  var re = new RegExp(helper.regexEscape(TOKEN_START) + '(\\d+)' + helper.regexEscape(TOKEN_SEP), 'g');
  var m;
  while ((m = re.exec(xml)) !== null) {
    var id = parseInt(m[1], 10);
    if (!seen[id]) {
      seen[id] = true;
      out.push(id);
    }
  }
  return out;
}

function computeRelsPath (xmlPath) {
  // word/document.xml → word/_rels/document.xml.rels
  var idx = xmlPath.lastIndexOf('/');
  var dir = idx >= 0 ? xmlPath.slice(0, idx) : '';
  var base = idx >= 0 ? xmlPath.slice(idx + 1) : xmlPath;
  return (dir ? dir + '/' : '') + '_rels/' + base + '.rels';
}

function indexRelsByDoc (template, filter) {
  var byDoc = {};
  for (var i = 0; i < template.files.length; i++) {
    var f = template.files[i];
    if (!f || !filter.test(f.name)) { continue; }
    var m = /^(.*?)\/?_rels\/(.+)\.rels$/.exec(f.name);
    if (!m) { continue; }
    var dir = m[1];
    var base = m[2];
    byDoc[(dir ? dir + '/' : '') + base.replace(/\.xml$/, '')] = f;
  }
  return byDoc;
}

function computeNextFreeRelId (report) {
  var maxN = 0;
  for (var i = 0; i < report.files.length; i++) {
    var f = report.files[i];
    if (!f || typeof f.data !== 'string') { continue; }
    if (!/\.rels$/.test(f.name)) { continue; }
    var re = /\bId="rId(\d+)"/g;
    var m;
    while ((m = re.exec(f.data)) !== null) {
      var n = parseInt(m[1], 10);
      if (n > maxN) { maxN = n; }
    }
  }
  return maxN + 1;
}

function appendRelationships (relsXml, newRelEntries) {
  var joined = newRelEntries.join('');
  if (/<\/Relationships>\s*$/.test(relsXml)) {
    return relsXml.replace(/<\/Relationships>\s*$/, joined + '</Relationships>');
  }
  return relsXml + joined;
}

function mergeContentTypes (xml, extSeen) {
  for (var ext in extSeen) {
    if (!extSeen.hasOwnProperty(ext)) { continue; }
    var contentType = extSeen[ext];
    var defRe = new RegExp('<Default\\b[^/>]*\\bExtension="' + helper.regexEscape(ext) + '"');
    if (defRe.test(xml)) { continue; }
    xml = xml.replace(/<\/Types>\s*$/,
      '<Default Extension="' + ext + '" ContentType="' + contentType + '"/></Types>');
  }
  return xml;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

function decodeXmlAttrValue (s) {
  if (typeof s !== 'string') { return s; }
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

var DATA_URI_RE = /^data:(image\/(png|jpeg|jpg|gif|bmp|webp|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/i;

/**
 * Validate a `data:image/<mime>;base64,<body>` string and decode it. Throws
 * with an explicit, actionable message on any other input (no silent fallback:
 * the datasource is the one responsible for substituting blank placeholders).
 */
function parseDataUri (s, imgIdForError) {
  if (typeof s !== 'string' || s.length === 0) {
    throw new Error(buildInvalidImageError(imgIdForError, '<empty>'));
  }
  var m = DATA_URI_RE.exec(s.trim());
  if (!m) {
    throw new Error(buildInvalidImageError(imgIdForError, s));
  }
  var mime = m[1].toLowerCase();
  var rawExt = m[2].toLowerCase();
  var ext = rawExt === 'jpg' ? 'jpeg' : rawExt === 'svg+xml' ? 'svg' : rawExt;
  var body = m[3].replace(/\s+/g, '');
  var buffer;
  try {
    buffer = Buffer.from(body, 'base64');
  }
  catch (e) {
    throw new Error(buildInvalidImageError(imgIdForError, s) + ' (base64 decode failed)');
  }
  if (buffer.length === 0) {
    throw new Error(buildInvalidImageError(imgIdForError, s) + ' (decoded to 0 bytes)');
  }
  return { mime : mime, ext : ext, buffer : buffer };
}

function buildInvalidImageError (imgId, payload) {
  var preview = String(payload || '').slice(0, 40).replace(/[\n\r\t]/g, ' ');
  return '[carbone:generateImage] invalid image data' +
         (imgId != null ? ' for imgId=' + imgId : '') +
         ': expected "data:image/<mime>;base64,<body>" (got: ' + preview + ')';
}
