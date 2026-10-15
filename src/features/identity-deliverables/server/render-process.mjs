// Dedicated bounded process. Only validated passive geometry/bytes are passed over IPC.
// No credentials, file paths, source URLs or provider clients enter this process.
import { createHash } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';
const MAX_BYTES = 52_428_800, MAX_PIXELS = 16_777_216;
function bounded(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_BYTES) throw new Error('File byte limit exceeded.');
  return bytes;
}
function dimensions(input) {
  if (![input.width, input.height].every(n => Number.isInteger(n) && n >= 1 && n <= 4096) || input.width * input.height > MAX_PIXELS) throw new Error('Invalid pixel bounds.');
}
function renderPng(input) {
  dimensions(input);
  const svg = bounded(input.svg);
  const result = new Resvg(svg, { font: { loadSystemFonts: false, fontFiles: [], fontDirs: [] }, fitTo: { mode: input.width >= input.height ? 'width' : 'height', value: Math.max(input.width, input.height) } }).render();
  if (result.width !== input.width || result.height !== input.height) throw new Error('PNG dimensions differ from the frozen selection.');
  return bounded(new Uint8Array(result.asPng()));
}
async function renderPdf(input) {
  const { default: PDFDocument } = await import('pdfkit');
  const [x, y, width, height] = input.viewBox, scale = 600 / Math.max(width, height);
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ autoFirstPage: true, size: [width * scale, height * scale], margin: 0, compress: true, pdfVersion: '1.7',
      info: { Title: 'Reviewed logo', Subject: `Variant SHA-256 ${input.variantHash}`, Producer: 'Embel logo export v1 / PDFKit 0.20.2', Creator: 'Embel', CreationDate: new Date('2000-01-01T00:00:00Z'), ModDate: new Date('2000-01-01T00:00:00Z') } });
    const chunks = []; let total = 0;
    document.on('data', chunk => { total += chunk.length; if (total > MAX_BYTES) { document.destroy(); reject(new Error('PDF byte limit exceeded.')); } else chunks.push(chunk); });
    document.once('error', reject); document.once('end', () => resolve(bounded(new Uint8Array(Buffer.concat(chunks)))));
    document.scale(scale).translate(-x, -y);
    for (const path of input.paths) {
      document.save().path(path.d);
      if (path.fill) document.fillColor(path.fill.color).fillOpacity(path.fill.opacity);
      if (path.stroke) document.strokeColor(path.stroke.color).strokeOpacity(path.stroke.opacity).lineWidth(path.stroke.width).lineCap(path.stroke.linecap).lineJoin(path.stroke.linejoin).miterLimit(path.stroke.miterLimit);
      if (path.fill && path.stroke) document.fillAndStroke(path.fill.color, path.stroke.color, path.fillRule === 'evenodd' ? 'even-odd' : 'non-zero');
      else if (path.fill) document.fill(path.fill.color, path.fillRule === 'evenodd' ? 'even-odd' : 'non-zero');
      else if (path.stroke) document.stroke();
      document.restore();
    }
    document.end();
  });
}
function pixelEvidence(data, width, height) {
  let transparent = false, visible = false;
  const bounds = [width, height, -1, -1];
  for (let p = 0; p < width * height; p++) {
    const alpha = data[p * 4 + 3];
    if (alpha < 255) transparent = true;
    if (alpha > 0) { visible = true; const x = p % width, y = Math.floor(p / width); bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y); bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y); }
  }
  return { transparent, visible, bounds };
}
function pixelDifference(a, b) {
  if (a.length !== b.length) throw new Error('Raster dimensions differ.');
  let error = 0;
  for (let p = 0; p < a.length; p += 4) {
    const aa = a[p + 3] / 255, ba = b[p + 3] / 255;
    for (let channel = 0; channel < 3; channel++) error += Math.abs(a[p + channel] * aa - b[p + channel] * ba) / 255;
    error += Math.abs(aa - ba);
  }
  return error / a.length;
}
async function verify(input) {
  dimensions(input);
  for (const key of ['svg', 'pdf', 'png']) bounded(input[key]);
  if (Buffer.from(input.pdf.subarray(0, 5)).toString() !== '%PDF-') throw new Error('Not a PDF.');
  if (Buffer.compare(Buffer.from(input.png.subarray(0, 8)), Buffer.from([137,80,78,71,13,10,26,10])) !== 0) throw new Error('Not a PNG.');
  const [{ default: sharp }, { getDocument, OPS, version }] = await Promise.all([import('sharp'), import('pdfjs-dist/legacy/build/pdf.mjs')]);
  if (version !== '6.2.108' || sharp.versions.sharp !== '0.35.5') throw new Error('Unqualified verifier version.');
  const pngReader = sharp(input.png, { failOn: 'error', limitInputPixels: MAX_PIXELS });
  const metadata = await pngReader.metadata();
  if (metadata.format !== 'png' || !metadata.hasAlpha || metadata.width !== input.width || metadata.height !== input.height || (metadata.pages ?? 1) !== 1) throw new Error('PNG metadata differs from the selected format.');
  const png = await pngReader.ensureAlpha().raw().toBuffer();
  const pngEvidence = pixelEvidence(png, input.width, input.height);
  if (!pngEvidence.transparent || !pngEvidence.visible) throw new Error('PNG must contain visible artwork and actual alpha.');
  const expectedPng = await sharp(renderPng(input), { failOn: 'error', limitInputPixels: MAX_PIXELS }).ensureAlpha().raw().toBuffer();
  if (pixelDifference(png, expectedPng) !== 0) throw new Error('PNG differs from approved geometry.');
  const task = getDocument({ data: new Uint8Array(input.pdf), useSystemFonts: false, disableFontFace: true, stopAtErrors: true, disableAutoFetch: true, disableStream: true, disableRange: true, maxImageSize: MAX_PIXELS, verbosity: 0 });
  try {
    const pdf = await task.promise;
    if (pdf.numPages !== 1 || pdf.isPureXfa) throw new Error('Logo PDF must contain exactly one ordinary vector page.');
    const [scripts, attachments, action, fields, outline, metadata] = await Promise.all([pdf.getJSActions(), pdf.getAttachments(), pdf.getOpenAction(), pdf.getFieldObjects(), pdf.getOutline(), pdf.getMetadata()]);
    if (scripts || attachments || action || fields || outline || metadata.info.Subject !== `Variant SHA-256 ${input.variantHash}`) throw new Error('PDF contains active content or wrong source binding.');
    const page = await pdf.getPage(1);
    if ((await page.getAnnotations()).length || await page.getJSActions()) throw new Error('PDF actions/annotations are forbidden.');
    const operations = await page.getOperatorList();
    const names = new Map(Object.entries(OPS).map(([key, value]) => [value, key]));
    const paints = new Set([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
    let pathPaintCount = 0;
    for (let i = 0; i < operations.fnArray.length; i++) {
      const operator = operations.fnArray[i], name = names.get(operator) ?? 'unknown';
      if (/paint.*Image|paintInline|paintSolidColorImage|show.*Text|showText|shadingFill/.test(name) || operator === OPS.paintXObject) throw new Error('PDF contains raster or unsupported drawing operations.');
      if (paints.has(operator) || (operator === OPS.constructPath && paints.has(operations.argsArray[i]?.[0]))) pathPaintCount++;
    }
    if (!pathPaintCount) throw new Error('PDF contains no actual path paint.');
    const [, , sourceWidth, sourceHeight] = input.expectedViewBox;
    const baseViewport = page.getViewport({ scale: 1 });
    if (Math.abs(baseViewport.width - 600 * sourceWidth / Math.max(sourceWidth, sourceHeight)) > 0.001 || Math.abs(baseViewport.height - 600 * sourceHeight / Math.max(sourceWidth, sourceHeight)) > 0.001) throw new Error('PDF page geometry differs from approved canvas.');
    const viewport = page.getViewport({ scale: Math.max(input.width, input.height) / Math.max(baseViewport.width, baseViewport.height) });
    const canvas = pdf.canvasFactory.create(input.width, input.height);
    try {
      await page.render({ canvas: null, canvasContext: canvas.context, viewport, background: 'rgba(0,0,0,0)' }).promise;
      const pdfPixels = canvas.context.getImageData(0, 0, input.width, input.height).data;
      const pdfEvidence = pixelEvidence(pdfPixels, input.width, input.height);
      const alphaBoundsDelta = Math.max(...pdfEvidence.bounds.map((value, index) => Math.abs(value - pngEvidence.bounds[index])));
      const meanAbsoluteNormalizedError = pixelDifference(pdfPixels, png);
      if (!pdfEvidence.visible || alphaBoundsDelta > 1 || meanAbsoluteNormalizedError > 0.01) throw new Error('Independent PDF rasterization differs from approved geometry.');
      return { pathPaintCount, meanAbsoluteNormalizedError, alphaBoundsDelta, pngPixelHash: createHash('sha256').update(png).digest('hex') };
    } finally { pdf.canvasFactory.destroy(canvas); }
  } finally { await task.destroy(); }
}
async function inspectPdf(input) {
  const bytes = bounded(input.pdf);
  if (Buffer.from(bytes.subarray(0, 5)).toString() !== '%PDF-') throw new Error('Not a PDF.');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, stopAtErrors: true, disableAutoFetch: true, verbosity: 0 });
  try {
    const pdf = await task.promise;
    if (pdf.numPages < 1 || pdf.numPages > 100 || pdf.isPureXfa || await pdf.getJSActions() || await pdf.getAttachments() || await pdf.getOpenAction() || await pdf.getFieldObjects()) throw new Error('PDF contains unsupported active content.');
    for (let n = 1; n <= pdf.numPages; n++) { const page = await pdf.getPage(n); if ((await page.getAnnotations()).length || await page.getJSActions()) throw new Error('PDF actions are not allowed.'); await page.getOperatorList(); }
    return { pages: pdf.numPages };
  } finally { await task.destroy(); }
}
async function renderGuidelines(input) {
  const { default: PDFDocument } = await import('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 48, autoFirstPage: true, info: { Title: `${input.brandName} — Brand guidelines`, Creator: 'Embel', Producer: 'Embel guidelines v1', CreationDate: new Date('2000-01-01T00:00:00Z'), ModDate: new Date('2000-01-01T00:00:00Z') } });
  const chunks = [], complete = new Promise((resolve, reject) => { let total = 0; doc.on('data', chunk => { total += chunk.length; if (total > MAX_BYTES) { doc.destroy(); reject(new Error('Guidelines exceed byte limit.')); } else chunks.push(chunk); }); doc.once('error', reject); doc.once('end', () => resolve(bounded(new Uint8Array(Buffer.concat(chunks))))); });
  doc.registerFont('neutral', Buffer.from(input.bodyFont));
  const body = (text, size = 10) => { doc.font('neutral').fontSize(size).fillColor('#18202C').text(text, { width: 499, lineGap: 3 }); doc.moveDown(0.5); };
  const space = height => { if (doc.y + height > 785) doc.addPage(); };
  const section = title => { space(65); body(title, 18); };
  body(input.brandName, 26); body('Brand guidelines', 20);
  body(`Approved logo: ${input.logoApprovalId}\nApproved identity direction: ${input.directionApprovalId}`, 9);
  section('Logo use'); body('Use only these reviewed arrangements and color versions. Preserve the complete artwork, approved spelling and proportions. Do not stretch, rotate, redraw or crop the logo. White artwork is shown on a dark background for visibility.');
  for (const variant of input.variants) {
    space(180); body(`${variant.role} / ${variant.colorway}\nVariant ${variant.id}`, 9);
    const y = doc.y, x = 48, boxWidth = 499, boxHeight = 108;
    doc.save().rect(x, y, boxWidth, boxHeight).fill(variant.colorway === 'white' ? '#18202C' : '#F2F3F6').restore();
    const [vx, vy, vw, vh] = variant.viewBox, scale = Math.min((boxWidth - 24) / vw, (boxHeight - 16) / vh);
    doc.save().translate(x + (boxWidth - vw * scale) / 2, y + (boxHeight - vh * scale) / 2).scale(scale).translate(-vx, -vy);
    for (const path of variant.paths) {
      doc.save().path(path.d);
      if (path.fill) doc.fillColor(path.fill.color).fillOpacity(path.fill.opacity);
      if (path.stroke) doc.strokeColor(path.stroke.color).strokeOpacity(path.stroke.opacity).lineWidth(path.stroke.width).lineCap(path.stroke.linecap).lineJoin(path.stroke.linejoin).miterLimit(path.stroke.miterLimit);
      if (path.fill && path.stroke) doc.fillAndStroke(path.fill.color, path.stroke.color, path.fillRule === 'evenodd' ? 'even-odd' : 'non-zero');
      else if (path.fill) doc.fill(path.fill.color, path.fillRule === 'evenodd' ? 'even-odd' : 'non-zero');
      else if (path.stroke) doc.stroke();
      doc.restore();
    }
    doc.restore(); doc.y = y + boxHeight + 14;
  }
  section('Color specifications');
  for (const color of input.colors) { space(100); const y = doc.y; doc.save().rect(48, y, 24, 24).fill(color.hex).restore(); doc.y += 30; body(color.description); }
  section('Typography');
  for (let i = 0; i < input.typography.length; i++) {
    const row = input.typography[i]; space(110); body(row.family, 14); body(row.description);
    if (row.bytes && row.sample) { doc.registerFont(`brand-${i}`, Buffer.from(row.bytes)); doc.font(`brand-${i}`).fontSize(20).fillColor('#18202C').text(row.sample, { width: 499, lineGap: 3 }); doc.moveDown(); }
    else body(row.unavailable, 9);
  }
  section('Spacing rules');
  for (const variant of input.variants) body(`${variant.role} / ${variant.colorway}: clear space ${variant.clearSpace} artwork units. ${variant.minimumDigitalSize === null ? 'Minimum digital size is not yet established by preview review.' : `Reviewed minimum digital size: ${variant.minimumDigitalSize} px.`}`, 9);
  body('Keep the clear-space area free of text and graphics. Export canvases include the reviewed clear space; do not trim it away.');
  section('Rights and technical notes'); body(input.notice, 9);
  body('Explanatory body text uses Geist under the SIL Open Font License 1.1. This does not replace any unavailable brand type specimen. No font binary is included in the logo package.', 9);
  doc.addPage(); body('Explanatory font license', 16); body(input.bodyFontLicense, 7);
  doc.end(); const bytes = await complete;
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, verbosity: 0 });
  try {
    const pdf = await task.promise; let text = '';
    if (await pdf.getJSActions() || await pdf.getAttachments() || await pdf.getOpenAction()) throw new Error('Unexpected active guidelines content.');
    for (let n = 1; n <= pdf.numPages; n++) text += (await (await pdf.getPage(n)).getTextContent()).items.map(item => item.str ?? '').join(' ') + '\n';
    for (const heading of ['Logo use', 'Color specifications', 'Typography', 'Spacing rules', input.logoApprovalId]) if (!text.includes(heading)) throw new Error('Guidelines failed independent text verification.');
  } finally { await task.destroy(); }
  return bytes;
}
process.once('message', async input => {
  try {
    let value;
    if (input.operation === 'png') value = renderPng(input);
    else if (input.operation === 'logo') value = { png: renderPng(input), pdf: await renderPdf(input) };
    else if (input.operation === 'verify') value = await verify(input);
    else if (input.operation === 'guidelines') value = await renderGuidelines(input);
    else if (input.operation === 'inspect_pdf') value = await inspectPdf(input);
    else throw new Error('Unsupported renderer operation.');
    process.send({ ok: true, value }, () => process.disconnect());
  } catch (error) {
    // Only controlled error text crosses the process boundary. No document content is logged.
    process.send({ ok: false, error: error instanceof Error ? error.message : 'Renderer failed.' }, () => process.disconnect());
  }
});
