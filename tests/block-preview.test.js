import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFArray, PDFDict, PDFDocument, PDFName, decodePDFRawStream, rgb } from 'pdf-lib';
import { buildPlacementPreviewPdf } from '../src/pdf-engine.js';

function decoded(stream) {
  return Buffer.from(decodePDFRawStream(stream).decode()).toString();
}

function pageContent(page) {
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray
    ? Array.from({ length: contents.size() }, (_, index) => contents.lookup(index)) : [contents];
  return streams.map(decoded).join('\n');
}

test('block preview renders only the selected source page into one isolated slot', async () => {
  const mm = 72 / 25.4;
  const source = await PDFDocument.create();
  const first = source.addPage([106 * mm, 158 * mm]);
  first.setTrimBox(3 * mm, 3 * mm, 100 * mm, 152 * mm);
  first.drawRectangle({ x: 3 * mm, y: 3 * mm, width: 100 * mm, height: 152 * mm, color: rgb(1, 0, 0) });
  const second = source.addPage([106 * mm, 158 * mm]);
  second.setTrimBox(3 * mm, 3 * mm, 100 * mm, 152 * mm);
  second.drawRectangle({ x: 3 * mm, y: 3 * mm, width: 100 * mm, height: 152 * mm, color: rgb(0, 0, 1) });

  const file = new Blob([await source.save()]);
  const meta = { width: 100, height: 152, top: 3, bottom: 3, left: 3, right: 3 };
  const bytes = await buildPlacementPreviewPdf({ file, meta, pageIndex: 1 }, 100, 152, 0);
  const preview = await PDFDocument.load(bytes);

  assert.equal(preview.getPageCount(), 1);
  const [page] = preview.getPages();
  assert.ok(Math.abs(page.getWidth() - 100 * mm) < 0.001);
  assert.ok(Math.abs(page.getHeight() - 152 * mm) < 0.001);
  assert.equal((pageContent(page).match(/\bDo\b/g) || []).length, 1);

  const xObjects = page.node.Resources().lookup(PDFName.of('XObject'), PDFDict);
  const embeddedContent = [...xObjects.entries()].map(([, value]) => decoded(preview.context.lookup(value))).join('\n');
  assert.match(embeddedContent, /0 0 1 rg/);
  assert.doesNotMatch(embeddedContent, /1 0 0 rg/);
});
