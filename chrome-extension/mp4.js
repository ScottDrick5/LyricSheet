// Reading the audio out of MP4 / M4A files, including the "fragmented" kind
// that streaming players (like Suno's) use, which Chrome's ordinary audio
// decoding can't open. The audio frames are pulled out of the file and decoded
// with WebCodecs at the file's own sample rate; the file's edit list is applied
// so encoder priming/padding is removed the same way a music app would.

const MP4 = (() => {
  const type4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

  function boxes(b, dv, start, end) {
    const out = [];
    let o = start;
    while (o + 8 <= end) {
      let size = dv.getUint32(o);
      let hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; } else if (size === 0) size = end - o;
      if (size < hdr) break;
      out.push({ type: type4(b, o + 4), start: o, body: o + hdr, end: Math.min(o + size, end) });
      o += size;
    }
    return out;
  }

  // Length-prefixed MPEG-4 descriptor (inside esds).
  function descriptor(b, o) {
    const tag = b[o++];
    let len = 0;
    for (let i = 0; i < 4; i++) {
      const v = b[o++];
      len = (len << 7) | (v & 0x7f);
      if (!(v & 0x80)) break;
    }
    return { tag, body: o, end: o + len };
  }

  function aacConfig(b, esds) {
    let d = descriptor(b, esds.body + 4);                 // ES_Descriptor
    if (d.tag !== 3) return null;
    let o = d.body + 2;
    const flags = b[o++];
    if (flags & 0x80) o += 2;
    if (flags & 0x40) o += 1 + b[o];
    if (flags & 0x20) o += 2;
    d = descriptor(b, o);                                 // DecoderConfigDescriptor
    if (d.tag !== 4) return null;
    d = descriptor(b, d.body + 13);                       // DecoderSpecificInfo = AudioSpecificConfig
    if (d.tag !== 5) return null;
    const asc = b.slice(d.body, d.end);
    let aot = asc[0] >> 3;
    if (aot === 31) aot = 32 + (((asc[0] & 7) << 3) | (asc[1] >> 5));
    return { codec: `mp4a.40.${aot}`, description: asc };
  }

  function opusConfig(b, dv, dops) {
    // dOps (big-endian) -> OpusHead (little-endian), which WebCodecs expects.
    const o = dops.body;
    const channels = b[o + 1];
    const family = b[o + 10];
    const table = family ? b.slice(o + 11, dops.end) : new Uint8Array(0);
    const head = new Uint8Array(19 + table.length);
    head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, channels]);
    const hv = new DataView(head.buffer);
    hv.setUint16(10, dv.getUint16(o + 2), true);         // pre-skip
    hv.setUint32(12, dv.getUint32(o + 4), true);         // input sample rate
    hv.setInt16(16, dv.getInt16(o + 8), true);           // output gain
    head[18] = family;
    head.set(table, 19);
    return { codec: 'opus', description: head };
  }

  function parse(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const top = boxes(b, dv, 0, b.length);
    const moov = top.find((x) => x.type === 'moov');
    if (!moov) return null;
    const kids = (box) => boxes(b, dv, box.body, box.end);
    const full = (box) => kids({ ...box, body: box.body + 4 }); // skip version/flags
    const find = (list, t) => list.find((x) => x.type === t);
    const moovKids = kids(moov);
    const mvhd = find(moovKids, 'mvhd');
    const movieScale = mvhd ? dv.getUint32(mvhd.body + (b[mvhd.body] === 1 ? 20 : 12)) : 0;

    for (const trak of moovKids.filter((x) => x.type === 'trak')) {
      const tk = kids(trak);
      const tkhd = find(tk, 'tkhd');
      const trackId = dv.getUint32(tkhd.body + (b[tkhd.body] === 1 ? 20 : 12));
      const mdia = find(tk, 'mdia');
      const md = kids(mdia);
      const hdlr = find(md, 'hdlr');
      if (!hdlr || type4(b, hdlr.body + 8) !== 'soun') continue;
      const mdhd = find(md, 'mdhd');
      const timescale = dv.getUint32(mdhd.body + (b[mdhd.body] === 1 ? 20 : 12));
      const stbl = find(kids(find(md, 'minf')), 'stbl');
      const st = kids(stbl);
      const stsd = find(st, 'stsd');
      const entry = boxes(b, dv, stsd.body + 8, stsd.end)[0];
      const ver = dv.getUint16(entry.body + 8);
      const channels = dv.getUint16(entry.body + 16);
      const rate = dv.getUint32(entry.body + 24) >>> 16;
      const inner = boxes(b, dv, entry.body + 28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0), entry.end);
      let cfg = null;
      if (entry.type === 'mp4a' && find(inner, 'esds')) cfg = aacConfig(b, find(inner, 'esds'));
      if (entry.type === 'Opus' && find(inner, 'dOps')) cfg = opusConfig(b, dv, find(inner, 'dOps'));
      if (!cfg) throw new Error(`unsupported audio format "${entry.type}"`);

      // Edit list: skip encoder priming at the start, trim padding at the end.
      let skip = 0;
      let keep = 0;
      const edts = find(tk, 'edts');
      const elst = edts && find(kids(edts), 'elst');
      if (elst) {
        const v1 = b[elst.body] === 1;
        const n = dv.getUint32(elst.body + 4);
        for (let i = 0, o = elst.body + 8; i < n; i++, o += v1 ? 20 : 12) {
          const dur = v1 ? Number(dv.getBigUint64(o)) : dv.getUint32(o);
          const mt = v1 ? Number(dv.getBigInt64(o + 8)) : dv.getInt32(o + 4);
          if (mt < 0) continue; // empty edit
          skip = mt;
          keep = dur && movieScale ? Math.round((dur * timescale) / movieScale) : 0;
          break;
        }
      }

      const samples = [];
      // Ordinary MP4: sample tables.
      const stsz = find(st, 'stsz');
      const count = stsz ? dv.getUint32(stsz.body + 8) : 0;
      if (count) {
        const fixed = dv.getUint32(stsz.body + 4);
        const sizes = Array.from({ length: count }, (_, i) => fixed || dv.getUint32(stsz.body + 12 + i * 4));
        const stco = find(st, 'stco') || find(st, 'co64');
        const wide = stco.type === 'co64';
        const chunks = Array.from({ length: dv.getUint32(stco.body + 4) }, (_, i) =>
          wide ? Number(dv.getBigUint64(stco.body + 8 + i * 8)) : dv.getUint32(stco.body + 8 + i * 4));
        const stsc = find(st, 'stsc');
        const runs = Array.from({ length: dv.getUint32(stsc.body + 4) }, (_, i) => ({
          first: dv.getUint32(stsc.body + 8 + i * 12) - 1,
          per: dv.getUint32(stsc.body + 12 + i * 12)
        }));
        const stts = find(st, 'stts');
        const durs = [];
        for (let i = 0, n = dv.getUint32(stts.body + 4); i < n; i++) {
          const c = dv.getUint32(stts.body + 8 + i * 8);
          const d = dv.getUint32(stts.body + 12 + i * 8);
          for (let k = 0; k < c; k++) durs.push(d);
        }
        let s = 0;
        for (let c = 0; c < chunks.length && s < count; c++) {
          const run = [...runs].reverse().find((r) => r.first <= c);
          let off = chunks[c];
          for (let k = 0; k < run.per && s < count; k++, s++) {
            samples.push({ offset: off, size: sizes[s], duration: durs[s] || 1024 });
            off += sizes[s];
          }
        }
      }

      // Fragmented MP4: moof/traf/trun boxes after the moov.
      const mvex = find(moovKids, 'mvex');
      const trex = mvex && kids(mvex).find((x) => x.type === 'trex' && dv.getUint32(x.body + 4) === trackId);
      const defDur = trex ? dv.getUint32(trex.body + 12) : 0;
      const defSize = trex ? dv.getUint32(trex.body + 16) : 0;
      for (const moof of top.filter((x) => x.type === 'moof')) {
        for (const traf of kids(moof).filter((x) => x.type === 'traf')) {
          const tf = kids(traf);
          const tfhd = find(tf, 'tfhd');
          if (dv.getUint32(tfhd.body + 4) !== trackId) continue;
          const tflags = dv.getUint32(tfhd.body) & 0xffffff;
          let o = tfhd.body + 8;
          let base = moof.start;
          if (tflags & 0x1) { base = Number(dv.getBigUint64(o)); o += 8; }
          if (tflags & 0x2) o += 4;
          const tDur = tflags & 0x8 ? dv.getUint32((o += 4) - 4) : defDur;
          const tSize = tflags & 0x10 ? dv.getUint32((o += 4) - 4) : defSize;
          let next = base;
          for (const trun of tf.filter((x) => x.type === 'trun')) {
            const f = dv.getUint32(trun.body) & 0xffffff;
            const n = dv.getUint32(trun.body + 4);
            let p = trun.body + 8;
            let off = next;
            if (f & 0x1) { off = base + dv.getInt32(p); p += 4; }
            if (f & 0x4) p += 4;
            for (let i = 0; i < n; i++) {
              const duration = f & 0x100 ? dv.getUint32((p += 4) - 4) : tDur;
              const size = f & 0x200 ? dv.getUint32((p += 4) - 4) : tSize;
              if (f & 0x400) p += 4;
              if (f & 0x800) p += 4;
              samples.push({ offset: off, size, duration: duration || 1024 });
              off += size;
            }
            next = off;
          }
        }
      }
      if (!samples.length) throw new Error('no audio frames found in the file');
      return { ...cfg, sampleRate: rate, channels, timescale, skip, keep, samples };
    }
    throw new Error('no audio track in the file');
  }

  async function decode(bytes) {
    const t = parse(bytes);
    if (!t) throw new Error('not an MP4 file');
    const config = { codec: t.codec, sampleRate: t.sampleRate, numberOfChannels: t.channels, description: t.description };
    if (typeof AudioDecoder === 'undefined' || !(await AudioDecoder.isConfigSupported(config)).supported) {
      throw new Error(`Chrome can't decode ${t.codec}`);
    }
    const parts = [];
    let rate = t.sampleRate;
    let chs = t.channels;
    let failure = null;
    const dec = new AudioDecoder({
      output: (ad) => {
        rate = ad.sampleRate;
        chs = ad.numberOfChannels;
        const planes = [];
        for (let c = 0; c < chs; c++) {
          const p = new Float32Array(ad.numberOfFrames);
          ad.copyTo(p, { planeIndex: c, format: 'f32-planar' });
          planes.push(p);
        }
        parts.push(planes);
        ad.close();
      },
      error: (e) => { failure = e; }
    });
    dec.configure(config);
    let ts = 0;
    for (const s of t.samples) {
      dec.decode(new EncodedAudioChunk({
        type: 'key',
        timestamp: Math.round((ts * 1e6) / t.timescale),
        duration: Math.round((s.duration * 1e6) / t.timescale),
        data: bytes.subarray(s.offset, s.offset + s.size)
      }));
      ts += s.duration;
    }
    await dec.flush();
    dec.close();
    if (failure) throw failure;
    const total = parts.reduce((n, p) => n + p[0].length, 0);
    const chans = Array.from({ length: chs }, () => new Float32Array(total));
    let o = 0;
    for (const p of parts) {
      for (let c = 0; c < chs; c++) chans[c].set(p[c], o);
      o += p[0].length;
    }
    const scale = rate / t.timescale;
    const start = Math.min(total, Math.round(t.skip * scale));
    const length = Math.round((t.keep || ts - t.skip) * scale);
    const end = Math.min(total, start + length);
    const data = chans.map((ch) => ch.subarray(start, end));
    return { sampleRate: rate, numberOfChannels: chs, length: end - start, getChannelData: (c) => data[c] };
  }

  return { parse, decode };
})();

if (typeof module !== 'undefined') module.exports = MP4;
