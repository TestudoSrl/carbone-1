var image = require('../lib/image');

/**
 * Marker formatter used by template authors in image placeholders:
 *
 *   <wp:docPr descr="{d.rows[i].foo.image:generateImage()}"/>
 *
 * At preprocess time the image scanner rewrites the marker into
 * `_carboneImage(<imgId>)` and injects it as a hidden text run next to the
 * drawing. This function is therefore a pass-through identity: the real
 * substitution happens in the preprocessor + post-processor.
 *
 * Any extra arguments (`generateImage(400, 300)` etc.) are currently ignored —
 * geometry is taken from the placeholder frame in the template.
 */
function generateImage (d /*, ...*/) {
  return d;
}

/**
 * Internal formatter emitted by the preprocessor. Wraps the resolved value
 * (expected to be a `data:image/<mime>;base64,<body>` URI) inside a token
 * pair that the post-processor recognizes and translates into a real media
 * file + relationship + drawing patch.
 *
 * Template authors should not use this formatter directly — write
 * `:generateImage()` in the image descr, it gets rewritten to this at
 * preprocess time.
 */
function _carboneImage (d, imgId) {
  var value = d == null ? '' : String(d);
  return image.TOKEN_START + imgId + image.TOKEN_SEP + value + image.TOKEN_END;
}

module.exports = {
  generateImage  : generateImage,
  _carboneImage  : _carboneImage
};
