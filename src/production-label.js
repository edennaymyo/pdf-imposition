const SALES_ORDER_PATTERN = /(?:^|[^a-z0-9])s(\d{4,10})(?=$|[^0-9])/i;

const FINISH_LABELS = {
  none: 'no lamination',
  gloss: 'gloss',
  matte: 'matte',
  softTouch: 'soft touch',
};

const FINISH_FILE_TOKENS = {
  none: 'NoLam',
  gloss: 'Gloss',
  matte: 'Matte',
  softTouch: 'SoftTouch',
};

export function extractSalesOrder(fileName = '') {
  const match = String(fileName).match(SALES_ORDER_PATTERN);
  if (!match) return '';
  return `S${match[1]}`;
}

function cleanMedia(value = '') {
  return String(value).trim().replace(/\s+/g, ' ');
}

function fileToken(value = '') {
  return cleanMedia(value)
    .replace(/\bgsm\b/gi, 'g')
    .replace(/[^a-z0-9]+/gi, '')
    .slice(0, 48);
}

export function formatProductionLabel({ salesOrder = '', media = '', lamination = 'none', sheetQty = 1 } = {}) {
  const normalizedMedia = cleanMedia(media);
  const orderAndMedia = [salesOrder, normalizedMedia].filter(Boolean).join('-');
  const finish = FINISH_LABELS[lamination] || FINISH_LABELS.none;
  const quantity = Math.max(1, Math.floor(Number(sheetQty) || 1));
  return [orderAndMedia, finish, `${quantity} ${quantity === 1 ? 'sheet' : 'sheets'}`].filter(Boolean).join(', ');
}

export function productionFileName({ salesOrder = '', media = '', lamination = 'none', sheetQty = 1 } = {}) {
  const quantity = Math.max(1, Math.floor(Number(sheetQty) || 1));
  const tokens = [salesOrder, fileToken(media), FINISH_FILE_TOKENS[lamination] || FINISH_FILE_TOKENS.none, `${quantity}-sheets`]
    .filter(Boolean);
  return `${tokens.join('-') || 'imposed-output'}.pdf`;
}
