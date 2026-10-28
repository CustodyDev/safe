'use strict';
const crypto = require('crypto');
const fs = require('fs');

/** SHA-256 (hex) de un archivo, leído en streaming. */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

module.exports = { sha256File, sha256Buffer };
