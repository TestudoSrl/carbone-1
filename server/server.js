/**
 * Minimal HTTP server wrapping Carbone CE — drop-in replacement for the
 * /render/template endpoint used by omnia-next. It intentionally does NOT
 * implement the full Carbone Cloud/EE API (templates-by-id, studio, S3
 * plugin, auth, etc.). It speaks exactly what pdf-carbone.ts / xlsx-carbone.ts
 * send today:
 *
 *   POST /render/template?download=true
 *   Body: { data, template: <base64>, convertTo, reportName, lang, timezone }
 *   Response: 200 with the rendered file (Content-Type per target format,
 *             Content-Disposition: attachment; filename="…")
 *
 *   GET /health → 200 { ok: true }
 *
 * Any Authorization header is ignored (the ugrade path still sends it for
 * backward compatibility). No per-request auth.
 */

var http  = require('http');
var fs    = require('fs');
var os    = require('os');
var path  = require('path');
var crypto = require('crypto');

var carbone = require('../lib/index');

var PORT = parseInt(process.env.CARBONE_PORT || process.env.PORT || '4000', 10);
var MAX_BODY = parseInt(process.env.CARBONE_MAX_BODY_BYTES || String(100 * 1024 * 1024), 10);

// Carbone writes temp artifacts under params.renderPath; point it at a
// dedicated dir we own. params.templatePath is used only when the caller
// passes a template *id* (we always pass a full path instead).
var TEMP_ROOT = process.env.CARBONE_TEMP_DIR || path.join(os.tmpdir(), 'carbone-testudo');
try { fs.mkdirSync(TEMP_ROOT, { recursive : true }); } catch (e) { /* ignore */ }
carbone.set({
  templatePath : TEMP_ROOT,
  renderPath   : path.join(TEMP_ROOT, 'render'),
  tempPath     : TEMP_ROOT
});

var MIME_BY_EXT = {
  pdf  : 'application/pdf',
  docx : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  odt  : 'application/vnd.oasis.opendocument.text',
  ods  : 'application/vnd.oasis.opendocument.spreadsheet',
  pptx : 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  html : 'text/html',
  txt  : 'text/plain'
};

function readBody (req, max, cb) {
  var chunks = [];
  var total = 0;
  var aborted = false;
  req.on('data', function (chunk) {
    if (aborted) { return; }
    total += chunk.length;
    if (total > max) {
      aborted = true;
      cb(new Error('Request body exceeds ' + max + ' bytes'));
      try { req.socket.destroy(); } catch (e) { /* ignore */ }
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', function () {
    if (aborted) { return; }
    cb(null, Buffer.concat(chunks));
  });
  req.on('error', function (err) { if (!aborted) { cb(err); } });
}

function sendJson (res, status, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type'   : 'application/json; charset=utf-8',
    'Content-Length' : Buffer.byteLength(body)
  });
  res.end(body);
}

function inferSourceExt (templateBuffer) {
  // Quick heuristic: all the OOXML / ODF formats we care about start with PK
  // (zip). Without scanning the zip content, we let Carbone's file.detectType
  // figure it out once we hand it the file — we only need the extension for
  // the temp filename, so default to .docx unless the caller gives us a hint
  // via an optional 'extension' field in the body.
  return 'docx';
}

function handleRender (req, res) {
  readBody(req, MAX_BODY, function (err, buf) {
    if (err) { return sendJson(res, 413, { error : err.message }); }
    var payload;
    try { payload = JSON.parse(buf.toString('utf8')); }
    catch (e) { return sendJson(res, 400, { error : 'Invalid JSON body' }); }

    if (!payload || typeof payload.template !== 'string') {
      return sendJson(res, 400, { error : 'Missing "template" (base64-encoded template)' });
    }

    var templateBuffer;
    try { templateBuffer = Buffer.from(payload.template, 'base64'); }
    catch (e) { return sendJson(res, 400, { error : 'Invalid base64 template' }); }
    if (templateBuffer.length === 0) {
      return sendJson(res, 400, { error : 'Empty template buffer' });
    }

    var sourceExt = typeof payload.extension === 'string'
      ? payload.extension.toLowerCase()
      : inferSourceExt(templateBuffer);
    var convertTo = typeof payload.convertTo === 'string' ? payload.convertTo.toLowerCase() : null;
    var reportName = typeof payload.reportName === 'string' && payload.reportName.length > 0
      ? payload.reportName
      : 'report';

    // Write to a per-request temp file so concurrent renders don't clash.
    var uid = crypto.randomBytes(8).toString('hex');
    var tmpFile = path.join(TEMP_ROOT, 'in_' + uid + '.' + sourceExt);
    try { fs.writeFileSync(tmpFile, templateBuffer); }
    catch (e) { return sendJson(res, 500, { error : 'Cannot write temp template: ' + e.message }); }

    var renderOpts = {
      extension  : sourceExt,
      convertTo  : convertTo || undefined,
      reportName : reportName,
      lang       : payload.lang || undefined,
      timezone   : payload.timezone || undefined
    };

    carbone.render(tmpFile, payload.data || {}, renderOpts, function (err, result, renderedName) {
      // Clean the input file regardless.
      fs.unlink(tmpFile, function () { /* ignore */ });
      if (err) {
        var msg = err && err.message ? err.message : String(err);
        return sendJson(res, 500, { error : msg });
      }
      var outExt = (convertTo || sourceExt).replace(/^\./, '').toLowerCase();
      var mime = MIME_BY_EXT[outExt] || 'application/octet-stream';
      var fileName = (reportName + '.' + outExt).replace(/"/g, '');
      res.writeHead(200, {
        'Content-Type'        : mime,
        'Content-Disposition' : 'attachment; filename="' + fileName + '"',
        'Content-Length'      : result.length
      });
      res.end(result);
    });
  });
}

var server = http.createServer(function (req, res) {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/status')) {
    return sendJson(res, 200, { ok : true, name : 'carbone-testudo', version : require('../package.json').version });
  }
  if (req.method === 'POST' && req.url && req.url.indexOf('/render/template') === 0) {
    return handleRender(req, res);
  }
  sendJson(res, 404, { error : 'Not Found' });
});

server.listen(PORT, function () {
  process.stdout.write('[carbone-testudo] listening on ' + PORT + '\n');
});

// Graceful shutdown so k8s rollouts don't drop in-flight renders.
['SIGTERM', 'SIGINT'].forEach(function (sig) {
  process.on(sig, function () {
    process.stdout.write('[carbone-testudo] ' + sig + ' received, closing\n');
    server.close(function () { process.exit(0); });
    setTimeout(function () { process.exit(0); }, 15000).unref();
  });
});
