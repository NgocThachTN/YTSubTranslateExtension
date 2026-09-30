const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

// CRC32 implementation for PNG chunks
function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    let byte = buf[i];
    for (let j = 0; j < 8; j++) {
      if ((crc ^ byte) & 1) {
        crc = (crc >>> 1) ^ 0xEDB88320;
      } else {
        crc = crc >>> 1;
      }
      byte >>>= 1;
    }
  }
  return (crc ^ -1) >>> 0;
}

function createChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function generatePng(size) {
  const width = size;
  const height = size;

  // RGBA buffer (height rows, each starting with filter byte 0)
  const rowSize = 1 + width * 4;
  const rawData = Buffer.alloc(height * rowSize);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0; // Filter: None

    for (let x = 0; x < width; x++) {
      const pixelOffset = rowOffset + 1 + x * 4;

      // Normalized coordinates
      const nx = x / (width - 1);
      const ny = y / (height - 1);

      // Rounded rectangle mask (radius ~ 22%)
      const r = 0.22;
      let inside = true;
      let alpha = 255;

      // Distance to corner centers
      const cx = nx < 0.5 ? r : 1 - r;
      const cy = ny < 0.5 ? r : 1 - r;
      if ((nx < r || nx > 1 - r) && (ny < r || ny > 1 - r)) {
        const dist = Math.sqrt((nx - cx) ** 2 + (ny - cy) ** 2);
        if (dist > r) {
          inside = false;
        } else if (dist > r - 0.05) {
          alpha = Math.round((1 - (dist - (r - 0.05)) / 0.05) * 255);
        }
      }

      if (!inside) {
        rawData[pixelOffset] = 0;
        rawData[pixelOffset + 1] = 0;
        rawData[pixelOffset + 2] = 0;
        rawData[pixelOffset + 3] = 0;
        continue;
      }

      // Default Red Gradient background (#FF0033 to #CC0000)
      let red = Math.round(255 - 40 * ny);
      let green = Math.round(15 + 10 * nx);
      let blue = Math.round(35 + 20 * nx);

      // Inner Subtitle Box: x: 15%..85%, y: 22%..78%
      const inSubBox = nx >= 0.14 && nx <= 0.86 && ny >= 0.22 && ny <= 0.78;
      const onSubBorder = (nx >= 0.12 && nx <= 0.88 && ny >= 0.20 && ny <= 0.80) && !inSubBox;

      if (onSubBorder) {
        // White border
        red = 255;
        green = 255;
        blue = 255;
      } else if (inSubBox) {
        // Dark translucent background
        red = 20;
        green = 24;
        blue = 35;

        // Draw "VI" or subtitle bars inside box
        // Subtitle horizontal line 1 (original)
        const line1 = ny >= 0.33 && ny <= 0.43 && nx >= 0.22 && nx <= 0.78;
        // Subtitle horizontal line 2 (vietnamese translation)
        const line2 = ny >= 0.53 && ny <= 0.65 && nx >= 0.22 && nx <= 0.78;

        if (line1) {
          // White sub line
          red = 240;
          green = 240;
          blue = 245;
        } else if (line2) {
          // Bright yellow/gold sub line (representing translation)
          red = 255;
          green = 225;
          blue = 50;
        }
      }

      // Green active dot badge at bottom right corner (x: 70%..92%, y: 70%..92%)
      const dotCenterX = 0.80;
      const dotCenterY = 0.80;
      const dotRadius = 0.13;
      const dotDist = Math.sqrt((nx - dotCenterX) ** 2 + (ny - dotCenterY) ** 2);
      if (dotDist <= dotRadius) {
        if (dotDist > dotRadius - 0.03) {
          // Green border / ring
          red = 255;
          green = 255;
          blue = 255;
        } else {
          // Bright green badge
          red = 0;
          green = 230;
          blue = 118;
        }
        alpha = 255;
      }

      rawData[pixelOffset] = red;
      rawData[pixelOffset + 1] = green;
      rawData[pixelOffset + 2] = blue;
      rawData[pixelOffset + 3] = alpha;
    }
  }

  // Header chunk (IHDR)
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Bit depth: 8
  ihdr[9] = 6; // Color type: 6 (RGBA)
  ihdr[10] = 0; // Compression: Deflate
  ihdr[11] = 0; // Filter: 0
  ihdr[12] = 0; // Interlace: 0

  const compressedData = zlib.deflateSync(rawData);

  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrChunk = createChunk('IHDR', ihdr);
  const idatChunk = createChunk('IDAT', compressedData);
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([pngSignature, ihdrChunk, idatChunk, iendChunk]);
}

[16, 48, 128].forEach(size => {
  const pngBuf = generatePng(size);
  const filePath = path.join(__dirname, 'icons', `icon${size}.png`);
  fs.writeFileSync(filePath, pngBuf);
  console.log(`Generated ${filePath} (${size}x${size})`);
});
