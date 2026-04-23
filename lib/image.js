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
    if (format === 'odt') {
      return scanOdt(template);
    }
    // phase 1c adds xlsx here
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
    if (format === 'odt') {
      return applyOdt(report);
    }
    // phase 1c adds xlsx here
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
// ODT
// ─────────────────────────────────────────────────────────────────────────────

function scanOdt (template) {
  for (var i = 0; i < template.files.length; i++) {
    var f = template.files[i];
    if (!f || typeof f.data !== 'string') { continue; }
    if (f.name !== 'content.xml' && f.name !== 'styles.xml') { continue; }
    f.data = scanOdtContent(f.data, template._carboneImageRegistry);
  }
}

function scanOdtContent (xml, registry) {
  // Pass 1 — mutate each <draw:frame> whose <svg:desc> or <svg:title>
  // contains a generateImage marker. Rename draw:name, blank the desc/title,
  // capture origHref.
  xml = xml.replace(/<draw:frame\b[\s\S]*?<\/draw:frame>/g, function (frameXml) {
    var marker = extractOdtGenerateImageMarker(frameXml);
    if (!marker) { return frameXml; }

    var imageMatch = /<draw:image\b[^>]*\bxlink:href="([^"]+)"/.exec(frameXml);
    var origHref = imageMatch ? imageMatch[1] : null;
    var hrefMime = /\bloext:mime-type="([^"]+)"/.exec(frameXml);

    var imgId = ++registry.nextId;
    registry.entries[imgId] = {
      format     : 'odt',
      origHref   : origHref,
      origMime   : hrefMime ? hrefMime[1] : null,
      markerPath : marker.path
    };

    // Rename draw:name (add if missing); blank svg:desc / svg:title content.
    var result = frameXml;
    if (/<draw:frame\b[^>]*\bdraw:name="/.test(result)) {
      result = result.replace(/(<draw:frame\b[^>]*\bdraw:name=")[^"]*(")/,
        '$1' + DOCPR_NAME_PREFIX + imgId + '$2');
    }
    else {
      result = result.replace(/<draw:frame\b/,
        '<draw:frame draw:name="' + DOCPR_NAME_PREFIX + imgId + '"');
    }
    result = result.replace(/<svg:desc\b[^>]*>[\s\S]*?<\/svg:desc>/g, '<svg:desc></svg:desc>');
    result = result.replace(/<svg:title\b[^>]*>[\s\S]*?<\/svg:title>/g, '<svg:title></svg:title>');
    return result;
  });

  // Pass 2 — inject a hidden <text:p> sibling after each registered frame's
  // enclosing <text:p>. The builder duplicates the whole <table:table-row>
  // (or surrounding container), so one sibling paragraph per iteration is
  // exactly what's needed. The text:p is completely stripped by the
  // post-processor so visibility doesn't matter.
  for (var imgIdStr in registry.entries) {
    if (!registry.entries.hasOwnProperty(imgIdStr)) { continue; }
    var entry = registry.entries[imgIdStr];
    if (entry.format !== 'odt') { continue; }
    var imgId = parseInt(imgIdStr, 10);
    var nameAttr = DOCPR_NAME_PREFIX + imgId;
    var re = new RegExp(
      '(<text:p\\b[^>]*>[\\s\\S]*?<draw:frame\\b[^>]*\\bdraw:name="' +
      helper.regexEscape(nameAttr) +
      '"[^>]*>[\\s\\S]*?<\\/draw:frame>[\\s\\S]*?<\\/text:p>)',
      'g'
    );
    xml = xml.replace(re, function (paraXml) {
      var token = '{' + entry.markerPath + ':_carboneImage(' + imgId + ')}';
      return paraXml + '<text:p>' + token + '</text:p>';
    });
  }

  return xml;
}

function extractOdtGenerateImageMarker (frameXml) {
  var candidates = [
    /<svg:desc\b[^>]*>([\s\S]*?)<\/svg:desc>/,
    /<svg:title\b[^>]*>([\s\S]*?)<\/svg:title>/
  ];
  for (var i = 0; i < candidates.length; i++) {
    var m = candidates[i].exec(frameXml);
    if (!m) { continue; }
    var text = decodeXmlText(m[1]);
    var markerMatch = GENERATE_IMAGE_MARKER_RE.exec(text);
    if (markerMatch) {
      return { path : markerMatch[1] };
    }
  }
  return null;
}

function applyOdt (report) {
  var filesByName = {};
  for (var i = 0; i < report.files.length; i++) {
    filesByName[report.files[i].name] = report.files[i];
  }

  var manifest = filesByName['META-INF/manifest.xml'];
  var newMediaFiles = [];
  var newManifestEntries = [];
  var nextMediaUid = 1;

  for (var i = 0; i < report.files.length; i++) {
    var f = report.files[i];
    if (!f || typeof f.data !== 'string') { continue; }
    if (f.name !== 'content.xml' && f.name !== 'styles.xml') { continue; }

    var state = {
      newMedia       : newMediaFiles,
      manifestEntries: newManifestEntries,
      nextMediaUid   : nextMediaUid
    };
    f.data = rewriteOdtDocument(f.data, state);
    nextMediaUid = state.nextMediaUid;
  }

  for (var j = 0; j < newMediaFiles.length; j++) {
    report.files.push(newMediaFiles[j]);
    filesByName[newMediaFiles[j].name] = newMediaFiles[j];
  }

  if (manifest && newManifestEntries.length > 0) {
    manifest.data = appendOdtManifestEntries(manifest.data, newManifestEntries);
  }
}

function rewriteOdtDocument (xml, state) {
  var imgIdsInDoc = collectTokenImgIds(xml);
  if (imgIdsInDoc.length === 0) { return xml; }

  for (var i = 0; i < imgIdsInDoc.length; i++) {
    var imgId = imgIdsInDoc[i];
    var nameAttr = DOCPR_NAME_PREFIX + imgId;
    // Match: frame-paragraph carrying _carbone_img_<id> + optional intermediate
    // XML + token-paragraph carrying __CBIMG__<id>__. The frame's enclosing
    // <text:p> stays put; we patch xlink:href inside it and strip the token
    // paragraph entirely.
    var pairRe = new RegExp(
      '(<text:p\\b[^>]*>[\\s\\S]*?<draw:frame\\b[^>]*\\bdraw:name="' +
      helper.regexEscape(nameAttr) +
      '"[^>]*>[\\s\\S]*?<draw:image\\b[^>]*\\bxlink:href=")([^"]+)(' +
      '"[^>]*\\/?>[\\s\\S]*?<\\/draw:frame>[\\s\\S]*?<\\/text:p>)' +
      '([\\s\\S]*?)' +
      '<text:p\\b[^>]*>' + helper.regexEscape(TOKEN_START) +
      imgId + helper.regexEscape(TOKEN_SEP) +
      '([\\s\\S]*?)' + helper.regexEscape(TOKEN_END) +
      '<\\/text:p>',
      'g'
    );
    xml = xml.replace(pairRe, function (_m, frameHead, _origHref, frameTail, between, payload) {
      var parsed = parseDataUri(payload, imgId);
      var uid = 'carbone_img_' + (state.nextMediaUid++);
      var mediaFileName = 'Pictures/' + uid + '.' + parsed.ext;
      state.newMedia.push({
        name   : mediaFileName,
        data   : parsed.buffer,
        parent : ''
      });
      state.manifestEntries.push(
        '<manifest:file-entry manifest:full-path="' + mediaFileName +
        '" manifest:media-type="' + parsed.mime + '"/>'
      );
      return frameHead + mediaFileName + frameTail + between;
    });
  }

  return xml;
}

function appendOdtManifestEntries (xml, entries) {
  var joined = entries.join('');
  if (/<\/manifest:manifest>\s*$/.test(xml)) {
    return xml.replace(/<\/manifest:manifest>\s*$/, joined + '</manifest:manifest>');
  }
  return xml + joined;
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

// Same entity set; kept as a separate name to keep call sites readable.
var decodeXmlText = decodeXmlAttrValue;

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
