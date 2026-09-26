// Builds an ID3v2.3 tag holding just the cover art. It goes at the front of
// MP3 files, and inside WAV files as an "id3 " chunk.

function coverArtTag(art) {
  const mime = new TextEncoder().encode(art.mime);
  const body = new Uint8Array(1 + mime.length + 1 + 1 + 1 + art.bytes.length);
  let o = 0;
  body[o++] = 0;           // text encoding: Latin-1
  body.set(mime, o); o += mime.length;
  body[o++] = 0;
  body[o++] = 3;           // picture type: front cover
  body[o++] = 0;           // empty description
  body.set(art.bytes, o);

  const head = new Uint8Array(10);
  head.set([0x41, 0x50, 0x49, 0x43]); // "APIC"
  new DataView(head.buffer).setUint32(4, body.length);
  const frames = [head, body];

  const size = frames.reduce((n, f) => n + f.length, 0);
  const header = new Uint8Array(10);
  header.set([0x49, 0x44, 0x33, 3, 0, 0]); // "ID3" v2.3, no flags
  // Tag size is "syncsafe": 7 bits per byte.
  header[6] = (size >> 21) & 0x7f;
  header[7] = (size >> 14) & 0x7f;
  header[8] = (size >> 7) & 0x7f;
  header[9] = size & 0x7f;
  return new Blob([header, ...frames]);
}

// Download the cover image (first candidate that works) as JPEG or PNG bytes.
async function fetchArt(urls) {
  for (const url of urls || []) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      let blob = await res.blob();
      if (!blob.type.startsWith('image/')) continue;
      // Players only reliably show JPEG/PNG, and huge images bloat every file.
      if (!/^image\/(jpeg|png)$/.test(blob.type) || blob.size > 1500000) {
        const bmp = await createImageBitmap(blob);
        const scale = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
        const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
        canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
        blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      }
      return { mime: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()) };
    } catch (err) {
      // try the next one
    }
  }
  return null;
}
