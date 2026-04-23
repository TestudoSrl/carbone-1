#!/usr/bin/env node
/**
 * Local end-to-end render for the generateImage feature.
 *
 * Usage:
 *   node scripts/render-test.js <template.docx|odt|xlsx> <data.json> [out-path]
 *
 * data.json can reference image files relative to its own location via an
 * `_imageFiles` key:
 *   {
 *     "_imageFiles": { "sigA": "./sig-a.png", "sigB": "./sig-b.png" },
 *     "rows": [
 *       { "img": "@sigA" },
 *       { "img": "@sigB" }
 *     ]
 *   }
 * Any `@<key>` string anywhere in the data tree is replaced by the data URI
 * of the referenced file. Useful when the JSON payload is authored by hand.
 *
 * Exits non-zero on render errors.
 */

var fs   = require('fs');
var path = require('path');
var carbone = require('../lib/index');

function die (msg) { process.stderr.write('[render-test] ' + msg + '\n'); process.exit(2); }

var argv = process.argv.slice(2);
if (argv.length < 2) { die('usage: render-test.js <template> <data.json> [out-path]'); }
var templatePath = path.resolve(argv[0]);
var dataPath     = path.resolve(argv[1]);
var outPath      = argv[2] ? path.resolve(argv[2]) : null;

if (!fs.existsSync(templatePath)) { die('template not found: ' + templatePath); }
if (!fs.existsSync(dataPath))     { die('data file not found: ' + dataPath); }

var data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
var imageFiles = data._imageFiles || {};
delete data._imageFiles;

// Pre-resolve @<key> references into data URIs.
var mimeByExt = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
                  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
var resolved = {};
Object.keys(imageFiles).forEach(function (key) {
  var rel = imageFiles[key];
  var abs = path.resolve(path.dirname(dataPath), rel);
  if (!fs.existsSync(abs)) { die('image file missing for "' + key + '": ' + abs); }
  var ext = path.extname(abs).replace(/^\./, '').toLowerCase();
  var mime = mimeByExt[ext] || 'application/octet-stream';
  resolved[key] = 'data:' + mime + ';base64,' + fs.readFileSync(abs).toString('base64');
});

(function walk (node) {
  if (Array.isArray(node)) { node.forEach(walk); return; }
  if (node && typeof node === 'object') {
    for (var k in node) {
      if (!node.hasOwnProperty(k)) { continue; }
      var v = node[k];
      if (typeof v === 'string' && v.charAt(0) === '@' && resolved.hasOwnProperty(v.slice(1))) {
        node[k] = resolved[v.slice(1)];
      }
      else if (v && typeof v === 'object') { walk(v); }
    }
  }
})(data);

var ext = path.extname(templatePath).replace(/^\./, '').toLowerCase();
var defaultOut = path.join(process.cwd(), 'render-' + path.basename(templatePath, '.' + ext) + '.' + ext);
var finalOut = outPath || defaultOut;

var opts = { extension: ext };
carbone.render(templatePath, data, opts, function (err, result) {
  if (err) {
    process.stderr.write('[render-test] render failed: ' + (err.message || err) + '\n');
    process.exit(1);
  }
  fs.writeFileSync(finalOut, result);
  process.stdout.write(finalOut + '\n');
});
