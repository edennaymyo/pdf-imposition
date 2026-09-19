import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePDFRawStream, PDFArray, PDFDocument } from 'pdf-lib';
import { addProductionLabel } from '../src/pdf-engine.js';
import { extractSalesOrder, formatProductionLabel, productionFileName } from '../src/production-label.js';

test('sales order is normalized from common master filename forms', () => {
  assert.equal(extractSalesOrder('S07649-1G1 Motel.pdf'), 'S07649');
  assert.equal(extractSalesOrder('job_S07580_front.pdf'), 'S07580');
  assert.equal(extractSalesOrder('SO007649-legacy.pdf'), '');
  assert.equal(extractSalesOrder('customer artwork.pdf'), '');
});

test('production label and filesystem-safe download name are generated consistently', () => {
  const details = { salesOrder: 'S07649', media: 'AC 300 gsm', lamination: 'matte', sheetQty: 5 };
  assert.equal(formatProductionLabel(details), 'S07649-AC 300 gsm, matte, 5 sheets');
  assert.equal(productionFileName(details), 'S07649-AC300g-Matte-5-sheets.pdf');
});

test('production label is added to every exported page', async () => {
  const source = await PDFDocument.create();
  source.addPage([300, 400]);
  source.addPage([300, 400]);
  const labeled = await PDFDocument.load(await addProductionLabel(await source.save(), 'S07649-AC300g, matte, 5 sheets'));
  assert.equal(labeled.getPageCount(), 2);
  for (const page of labeled.getPages()) {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
    const decoded = streams.map(stream => new TextDecoder().decode(decodePDFRawStream(labeled.context.lookup(stream)).decode())).join('\n');
    assert.match(decoded, /533037363439/);
  }
});
