import { buildJobPdf, buildPlacementPreviewPdf } from './pdf-engine.js';

let queue = Promise.resolve();

async function runTask({ id, type, payload }) {
  try {
    const bytes = type === 'placement-preview'
      ? await buildPlacementPreviewPdf(payload.input, payload.itemWidth, payload.itemHeight, payload.rotation)
      : await buildJobPdf(payload.front, payload.back, payload.settings);
    self.postMessage({ id, bytes }, [bytes.buffer]);
  } catch (failure) {
    self.postMessage({ id, error: failure instanceof Error ? failure.message : String(failure) });
  }
}

self.onmessage = event => {
  queue = queue.then(() => runTask(event.data), () => runTask(event.data));
};
