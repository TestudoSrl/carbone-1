var assert = require('assert');
var path   = require('path');
var fs     = require('fs');
var helper = require('../lib/helper');
var image  = require('../lib/image');
var imageFormatters = require('../formatters/image');

describe('image (generateImage) — row-level dynamic images', function () {

  describe('parseDataUri', function () {
    var parseDataUri = image._internal.parseDataUri;

    it('should decode a valid PNG data URI', function () {
      var dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
      var parsed = parseDataUri(dataUri, 1);
      assert.strictEqual(parsed.mime, 'image/png');
      assert.strictEqual(parsed.ext, 'png');
      assert.ok(Buffer.isBuffer(parsed.buffer));
      assert.ok(parsed.buffer.length > 0);
    });

    it('should accept jpeg and normalize ext to jpeg', function () {
      var parsed = parseDataUri('data:image/jpeg;base64,/9j/4AAQ', 1);
      assert.strictEqual(parsed.ext, 'jpeg');
    });

    it('should accept jpg alias and normalize to jpeg', function () {
      var parsed = parseDataUri('data:image/jpg;base64,/9j/4AAQ', 1);
      assert.strictEqual(parsed.ext, 'jpeg');
    });

    it('should accept svg+xml and map ext to svg', function () {
      var parsed = parseDataUri('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 1);
      assert.strictEqual(parsed.ext, 'svg');
      assert.strictEqual(parsed.mime, 'image/svg+xml');
    });

    it('should throw on empty input', function () {
      assert.throws(function () { parseDataUri('', 7); }, /invalid image data.*imgId=7/);
    });

    it('should throw on non-data-URI input', function () {
      assert.throws(function () { parseDataUri('https://example.com/foo.png', 3); },
        /invalid image data.*imgId=3.*https:\/\/example/);
    });

    it('should throw on data URI with unsupported mime', function () {
      assert.throws(function () { parseDataUri('data:application/pdf;base64,AAAA', 2); },
        /invalid image data/);
    });

    it('should throw when decoded body is zero bytes', function () {
      // Empty base64 body after strip — regex allows zero-or-more whitespace but body is captured non-empty.
      // Using a single space as body (regex requires [A-Za-z0-9+/=\s]+).
      assert.throws(function () { parseDataUri('data:image/png;base64, ', 4); },
        /invalid image data|0 bytes/);
    });
  });

  describe('_carboneImage formatter', function () {
    it('should wrap a value in a token pair', function () {
      var out = imageFormatters._carboneImage('data:image/png;base64,AAA=', 5);
      assert.strictEqual(out,
        image.TOKEN_START + '5' + image.TOKEN_SEP + 'data:image/png;base64,AAA=' + image.TOKEN_END);
    });

    it('should coerce null/undefined to empty string', function () {
      var out = imageFormatters._carboneImage(null, 1);
      assert.strictEqual(out,
        image.TOKEN_START + '1' + image.TOKEN_SEP + '' + image.TOKEN_END);
    });
  });

  describe('generateImage formatter', function () {
    it('should pass the value through unchanged (real substitution happens in pre/post-processor)', function () {
      assert.strictEqual(imageFormatters.generateImage('data:image/png;base64,AAA='),
        'data:image/png;base64,AAA=');
    });
  });

  describe('scanImageMarkers (docx)', function () {

    function buildDocxTemplate (documentXml, documentRelsXml) {
      return {
        files : [
          { name : 'word/document.xml', data : documentXml, parent : '' },
          { name : 'word/_rels/document.xml.rels', data : documentRelsXml, parent : '' }
        ],
        embeddings : [],
        filename   : 'x.docx',
        extension  : 'docx'
      };
    }

    var drawingWithMarker =
      '<w:p>' +
        '<w:r>' +
          '<w:drawing>' +
            '<wp:inline>' +
              '<wp:extent cx="1000" cy="1000"/>' +
              '<wp:docPr id="4" name="Signature" descr="{d.rows[i].order.signatureImage:generateImage()}"/>' +
              '<a:graphic><a:graphicData>' +
                '<pic:pic>' +
                  '<pic:blipFill><a:blip r:embed="rId9"/></pic:blipFill>' +
                '</pic:pic>' +
              '</a:graphicData></a:graphic>' +
            '</wp:inline>' +
          '</w:drawing>' +
        '</w:r>' +
      '</w:p>';

    var simpleRels =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>' +
      '</Relationships>';

    it('should register the marker, rename docPr, blank descr, and inject a hidden run', function () {
      var template = buildDocxTemplate(drawingWithMarker, simpleRels);
      image.scanImageMarkers(template, 'docx');

      var registry = template._carboneImageRegistry;
      assert.deepStrictEqual(Object.keys(registry.entries), ['1']);
      assert.strictEqual(registry.entries[1].origRelId, 'rId9');
      assert.strictEqual(registry.entries[1].origMedia, 'media/image1.png');
      assert.strictEqual(registry.entries[1].markerPath, 'd.rows[i].order.signatureImage');

      var rewritten = template.files[0].data;
      assert.ok(/name="_carbone_img_1"/.test(rewritten), 'docPr name rewritten: ' + rewritten);
      assert.ok(/descr=""/.test(rewritten), 'descr blanked: ' + rewritten);
      // Hidden run with Carbone marker injected after the drawing's <w:r>
      assert.ok(/<w:vanish\/>.*_carboneImage\(1\)/.test(rewritten),
        'hidden run with _carboneImage(1) marker missing: ' + rewritten);
    });

    it('should allocate sequential imgIds for multiple image placeholders', function () {
      var docxXml = drawingWithMarker.replace(/rId9/g, 'rId9') +
                    drawingWithMarker.replace(/rId9/g, 'rId10')
                                     .replace(/signatureImage/g, 'avatarImage');
      var rels = simpleRels.replace('</Relationships>',
        '<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.png"/></Relationships>');
      var template = buildDocxTemplate(docxXml, rels);
      image.scanImageMarkers(template, 'docx');

      var keys = Object.keys(template._carboneImageRegistry.entries);
      assert.deepStrictEqual(keys, ['1', '2']);
      assert.strictEqual(template._carboneImageRegistry.entries[2].origRelId, 'rId10');
      assert.ok(/_carboneImage\(1\)/.test(template.files[0].data));
      assert.ok(/_carboneImage\(2\)/.test(template.files[0].data));
    });

    it('should ignore drawings whose descr has no generateImage marker', function () {
      var xml = drawingWithMarker.replace(':generateImage()', '');
      var template = buildDocxTemplate(xml, simpleRels);
      image.scanImageMarkers(template, 'docx');
      assert.deepStrictEqual(Object.keys(template._carboneImageRegistry.entries), []);
      assert.ok(!/_carboneImage/.test(template.files[0].data), 'no hidden run should be injected');
    });

    it('should be a no-op for unsupported formats', function () {
      var template = buildDocxTemplate(drawingWithMarker, simpleRels);
      image.scanImageMarkers(template, 'pptx');
      assert.deepStrictEqual(Object.keys(template._carboneImageRegistry.entries), []);
    });
  });

  describe('applyImagePatches (docx)', function () {

    var PNG_1x1_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    var DATA_URI_A = 'data:image/png;base64,' + PNG_1x1_BASE64;
    var DATA_URI_B = 'data:image/png;base64,' + PNG_1x1_BASE64.replace('iV', 'Iv'); // different string (still decodable base64)

    function buildDocxReportWithTwoRows (payloadA, payloadB) {
      // Two duplicated rows, each with its own drawing (same name="_carbone_img_1"
      // because the scan runs before loop expansion — the builder duplicates it)
      // and its own hidden token.
      function row (payload) {
        return '<w:tr><w:tc><w:p>' +
          '<w:r><w:drawing>' +
            '<wp:inline>' +
              '<wp:docPr id="4" name="_carbone_img_1" descr=""/>' +
              '<a:blip r:embed="rId9"/>' +
            '</wp:inline>' +
          '</w:drawing></w:r>' +
          '<w:r><w:rPr><w:vanish/></w:rPr><w:t xml:space="preserve">' +
            image.TOKEN_START + '1' + image.TOKEN_SEP + payload + image.TOKEN_END +
          '</w:t></w:r>' +
        '</w:p></w:tc></w:tr>';
      }
      var documentXml = '<w:document><w:body><w:tbl>' +
        row(payloadA) + row(payloadB) +
      '</w:tbl></w:body></w:document>';

      var relsXml =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>' +
        '</Relationships>';

      var contentTypesXml =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '</Types>';

      return {
        files : [
          { name : 'word/document.xml', data : documentXml, parent : '' },
          { name : 'word/_rels/document.xml.rels', data : relsXml, parent : '' },
          { name : '[Content_Types].xml', data : contentTypesXml, parent : '' }
        ]
      };
    }

    it('should emit one media file + rel + blip patch per row', function () {
      var report = buildDocxReportWithTwoRows(DATA_URI_A, DATA_URI_B);
      image.applyImagePatches(report, 'docx');

      var mediaFiles = report.files.filter(function (f) { return /^word\/media\/carbone_img_/.test(f.name); });
      assert.strictEqual(mediaFiles.length, 2, 'expected 2 new media files, got ' + mediaFiles.length);
      mediaFiles.forEach(function (f) {
        assert.ok(Buffer.isBuffer(f.data), 'media file data must be a Buffer');
        assert.ok(f.data.length > 0, 'decoded buffer must be non-empty');
      });

      var rels = report.files.filter(function (f) { return f.name === 'word/_rels/document.xml.rels'; })[0];
      var newRelIds = [];
      var re = /<Relationship\b[^>]*?\bId="(rId\d+)"[^>]*?\bTarget="media\/carbone_img_(\d+)\.png"/g;
      var m;
      while ((m = re.exec(rels.data)) !== null) { newRelIds.push(m[1]); }
      assert.strictEqual(newRelIds.length, 2, 'expected 2 new <Relationship> entries');
      assert.notStrictEqual(newRelIds[0], newRelIds[1], 'relIds must be distinct');
      assert.notStrictEqual(newRelIds[0], 'rId9');
      assert.notStrictEqual(newRelIds[1], 'rId9');

      var doc = report.files.filter(function (f) { return f.name === 'word/document.xml'; })[0];
      // Both original blip r:embed="rId9" must have been replaced by the new ids.
      assert.ok(!/r:embed="rId9"/.test(doc.data), 'original relId should no longer appear: ' + doc.data);
      assert.ok(doc.data.indexOf('r:embed="' + newRelIds[0] + '"') !== -1);
      assert.ok(doc.data.indexOf('r:embed="' + newRelIds[1] + '"') !== -1);

      // Hidden run + token must be stripped.
      assert.ok(!/__CBIMG__/.test(doc.data), 'CBIMG tokens must be removed');
      assert.ok(!/_carboneImage/.test(doc.data), 'formatter traces must be removed');
      assert.ok(!/<w:vanish\/>/.test(doc.data), 'hidden run must be stripped');

      // Content_Types must declare .png once (was not declared before).
      var ct = report.files.filter(function (f) { return f.name === '[Content_Types].xml'; })[0];
      assert.ok(/Extension="png"\s+ContentType="image\/png"/.test(ct.data),
        'png extension must be registered: ' + ct.data);
    });

    it('should throw a descriptive error on a non-data-URI payload', function () {
      var report = buildDocxReportWithTwoRows('https://example.com/foo.png', DATA_URI_B);
      assert.throws(function () { image.applyImagePatches(report, 'docx'); },
        /\[carbone:generateImage\] invalid image data.*imgId=1.*https:\/\/example/);
    });

    it('should be a no-op when no tokens are present', function () {
      var report = {
        files : [
          { name : 'word/document.xml', data : '<w:document><w:body/></w:document>', parent : '' },
          { name : 'word/_rels/document.xml.rels', data : '<Relationships/>', parent : '' }
        ]
      };
      var before = report.files.length;
      image.applyImagePatches(report, 'docx');
      assert.strictEqual(report.files.length, before, 'no files should be added');
    });
  });

});
