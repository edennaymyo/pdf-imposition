import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFArray, PDFDocument, decodePDFRawStream, rgb } from 'pdf-lib';
import { buildJobPdf } from '../src/pdf-engine.js';

function content(page) {
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray
    ? Array.from({ length: contents.size() }, (_, index) => contents.lookup(index)) : [contents];
  return streams.map(stream => Buffer.from(decodePDFRawStream(stream).decode()).toString()).join('\n');
}

test('TrimBox outlines are exact export-only rectangles on every front and back slot', async () => {
  const mm = 72 / 25.4;
  const source = await PDFDocument.create();
  const frontPage = source.addPage([96 * mm, 58 * mm]);
  frontPage.setTrimBox(3 * mm, 3 * mm, 90 * mm, 52 * mm);
  frontPage.drawRectangle({ x: 0, y: 0, width: 96 * mm, height: 58 * mm, color: rgb(1, 0.5, 0) });
  const backPage = source.addPage([96 * mm, 58 * mm]);
  backPage.setTrimBox(3 * mm, 3 * mm, 90 * mm, 52 * mm);
  backPage.drawRectangle({ x: 0, y: 0, width: 96 * mm, height: 58 * mm, color: rgb(0, 0.7, 0.4) });
  const file = new Blob([await source.save()]);
  const meta = { width: 90, height: 52, top: 3, bottom: 3, left: 3, right: 3 };
  const front = { file, meta, pageIndex: 0 };
  const back = { file, meta, pageIndex: 1 };
  const settings = {
    sheetW: 330.2, sheetH: 482.6, rows: 2, cols: 2, gutterCut: 5, gutterSlit: 5,
    topOffset: 20, sideTrim: 18, horizontalPlacement: 'center', rotation: 0, backRotation: 0,
    rotationPattern: 'same', duplex: true, flipEdge: 'long', marks: false,
    duploRegMark: false, finishingSide: 'front', trimBoxOutline: true, trimBoxColor: '#ff00ff',
  };

  const previewOnly = await PDFDocument.load(await buildJobPdf(front, back, { ...settings, trimBoxOutput: 'preview' }));
  for (const page of previewOnly.getPages()) assert.equal((content(page).match(/\nh\s+S\b/g) || []).length, 0);

  const exported = await PDFDocument.load(await buildJobPdf(front, back, { ...settings, trimBoxOutput: 'export' }));
  for (const page of exported.getPages()) {
    const operators = content(page);
    assert.equal((operators.match(/\nh\s+S\b/g) || []).length, 4);
    assert.match(operators, /0 1 0 0 K/); // Pure CMYK magenta stroke.
    assert.match(operators, /0\.25 w/);
  }
});
