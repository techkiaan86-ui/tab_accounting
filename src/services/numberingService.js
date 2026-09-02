const prisma = require('../config/prisma');

const TRANSACTION_TYPES = {
  invoice: { model: 'invoice', field: 'invoiceNumber', defaultPrefix: 'INV-' },
  receipt: { model: 'receipt', field: 'receiptNumber', defaultPrefix: 'RCV-' },
  payment: { model: 'payment', field: 'paymentNumber', defaultPrefix: 'PAY-' },
  purchaseorder: { model: 'purchaseorder', field: 'orderNumber', defaultPrefix: 'PO-' },
  purchasebill: { model: 'purchasebill', field: 'billNumber', defaultPrefix: 'PB-' },
  purchasequotation: { model: 'purchasequotation', field: 'quotationNumber', defaultPrefix: 'PQ-' },
  salesorder: { model: 'salesorder', field: 'orderNumber', defaultPrefix: 'SO-' },
  salesquotation: { model: 'salesquotation', field: 'quotationNumber', defaultPrefix: 'SQ-' },
  salesreturn: { model: 'salesreturn', field: 'returnNumber', defaultPrefix: 'CN-' },
  purchasereturn: { model: 'purchasereturn', field: 'returnNumber', defaultPrefix: 'DN-' },
  deliverychallan: { model: 'deliverychallan', field: 'challanNumber', defaultPrefix: 'DC-' },
  goodsreceiptnote: { model: 'goodsreceiptnote', field: 'grnNumber', defaultPrefix: 'GRN-' },
  voucher: { model: 'voucher', field: 'voucherNumber', defaultPrefix: 'VCH-' },
  posinvoice: { model: 'posinvoice', field: 'invoiceNumber', defaultPrefix: 'POS-' },
  stocktransfer: { model: 'stocktransfer', field: 'voucherNo', defaultPrefix: 'ST-' },
  adjustment: { model: 'inventoryadjustment', field: 'voucherNo', defaultPrefix: 'ADJ-' }
};

// ─── Ensure Table Exists ───────────────────────────────────────────────────────
// Creates transaction_numbering if it doesn't exist yet (safe to call multiple times)
let _tableEnsured = false;
async function ensureTable() {
  if (_tableEnsured) return;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS \`transaction_numbering\` (
        \`id\`              INT            NOT NULL AUTO_INCREMENT,
        \`companyId\`       INT            NOT NULL,
        \`transactionType\` VARCHAR(100)   NOT NULL,
        \`prefix\`          VARCHAR(50)    NULL     DEFAULT '',
        \`currentNumber\`   INT            NOT NULL DEFAULT 0,
        \`paddingLength\`   INT            NOT NULL DEFAULT 4,
        \`pattern\`         VARCHAR(50)    NOT NULL DEFAULT 'numeric',
        \`createdAt\`       DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        \`updatedAt\`       DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`TransactionNumbering_companyId_transactionType_key\` (\`companyId\`, \`transactionType\`),
        INDEX \`TransactionNumbering_companyId_fkey\` (\`companyId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    _tableEnsured = true;
  } catch (err) {
    // Table might already exist — ignore
    _tableEnsured = true;
    console.warn('[numberingService] ensureTable warning:', err.message);
  }
}

// ─── Raw SQL helpers ───────────────────────────────────────────────────────────
async function findConfig(companyId, transactionType) {
  await ensureTable();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM \`transaction_numbering\` WHERE companyId = ? AND transactionType = ? LIMIT 1`,
    companyId, transactionType
  );
  return rows.length ? rows[0] : null;
}

async function createConfig(companyId, transactionType, prefix, currentNumber = 1, paddingLength = 4, pattern = 'numeric') {
  await ensureTable();
  await prisma.$executeRawUnsafe(
    `INSERT INTO \`transaction_numbering\` (companyId, transactionType, prefix, currentNumber, paddingLength, pattern)
     VALUES (?, ?, ?, ?, ?, ?)`,
    companyId, transactionType, prefix, currentNumber, paddingLength, pattern
  );
  return findConfig(companyId, transactionType);
}

async function updateConfig(id, data) {
  await ensureTable();
  await prisma.$executeRawUnsafe(
    `UPDATE \`transaction_numbering\`
     SET prefix = ?, currentNumber = ?, paddingLength = ?, pattern = ?, updatedAt = NOW()
     WHERE id = ?`,
    data.prefix, data.currentNumber, data.paddingLength, data.pattern, id
  );
}

async function upsertConfig(companyId, transactionType, data) {
  await ensureTable();
  const { prefix = '', currentNumber = 1, paddingLength = 4, pattern = 'numeric' } = data;
  await prisma.$executeRawUnsafe(
    `INSERT INTO \`transaction_numbering\` (companyId, transactionType, prefix, currentNumber, paddingLength, pattern)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       prefix        = VALUES(prefix),
       currentNumber = VALUES(currentNumber),
       paddingLength = VALUES(paddingLength),
       pattern       = VALUES(pattern),
       updatedAt     = NOW()`,
    companyId, transactionType, prefix, currentNumber, paddingLength, pattern
  );
  return findConfig(companyId, transactionType);
}

async function findAllConfigs(companyId) {
  await ensureTable();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM \`transaction_numbering\` WHERE companyId = ?`,
    companyId
  );
  return rows;
}

// ─── Formatting helpers ────────────────────────────────────────────────────────
function formatPlaceholders(pattern, date = new Date()) {
  if (!pattern) return '';
  const yyyy = date.getFullYear().toString();
  const yy = yyyy.slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return pattern
    .replace(/{YYYY}/g, yyyy)
    .replace(/{YY}/g, yy)
    .replace(/{MM}/g, mm)
    .replace(/{DD}/g, dd);
}

function formatSequenceNumber(num, paddingLength, pattern) {
  if (pattern === 'alphanumeric') {
    return num.toString(36).toUpperCase().padStart(paddingLength, '0');
  }
  return String(num).padStart(paddingLength, '0');
}

function generateFormattedNumber(prefix = '', currentNumber = 1, paddingLength = 4, pattern = 'numeric') {
  let finalPrefix = prefix || '';
  if (pattern === 'custom') finalPrefix = formatPlaceholders(finalPrefix);
  const sequenceStr = formatSequenceNumber(currentNumber, paddingLength, pattern);
  return `${finalPrefix}${sequenceStr}`;
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Gets the next available formatted number without advancing it in the DB.
 * Also checks for uniqueness against the actual model table.
 */
async function getNextNumber(companyId, transactionType) {
  const configInfo = TRANSACTION_TYPES[transactionType];
  if (!configInfo) throw new Error(`Invalid transaction type: ${transactionType}`);

  const cid = parseInt(companyId);
  const modelName = configInfo.model;
  const fieldName = configInfo.field;

  // 1. Smart last-document pattern detection
  let nextManualReference = '';
  try {
    const lastRecord = await prisma[modelName].findFirst({
      where: { companyId: cid },
      orderBy: { id: 'desc' }
    });

    const modelsWithManualRef = [
      'invoice',
      'salesquotation',
      'salesorder',
      'deliverychallan',
      'purchasequotation',
      'purchaseorder',
      'purchasebill',
      'posinvoice'
    ];

    let lastManualRecord = null;

    if (modelsWithManualRef.includes(modelName.toLowerCase())) {
      try {
        lastManualRecord = await prisma[modelName].findFirst({
          where: {
            companyId: cid,
            AND: [
              { manualReference: { not: null } },
              { manualReference: { not: '' } }
            ]
          },
          orderBy: { id: 'desc' }
        });
      } catch (e) {
        // Ignore error
      }
    } else {
      try {
        lastManualRecord = await prisma[modelName].findFirst({
          where: {
            companyId: cid,
            notes: { contains: 'Manual Ref:' }
          },
          orderBy: { id: 'desc' }
        });
      } catch (err) {
        // Ignore error
      }
    }

    const manualSourceRecord = lastManualRecord || lastRecord;

    if (manualSourceRecord) {
      let lastManual = manualSourceRecord.manualReference || manualSourceRecord.manualVoucherNo || manualSourceRecord.manualBillNo || manualSourceRecord.manualReceiptNo || '';
      
      if (!lastManual && manualSourceRecord.notes) {
        const match = String(manualSourceRecord.notes).match(/Manual Ref:\s*([^\n\r]+)/i);
        if (match && match[1]) {
          lastManual = match[1].trim();
        }
      }

      if (lastManual) {
        const manualMatch = String(lastManual).trim().match(/^(.*?)(0*(\d+))$/);
        if (manualMatch) {
          const mPrefix = manualMatch[1];
          const mRawDigits = manualMatch[2];
          const mNumVal = parseInt(manualMatch[3], 10) + 1;
          if (mRawDigits.startsWith('0') && mRawDigits.length > 1) {
            nextManualReference = `${mPrefix}${String(mNumVal).padStart(mRawDigits.length, '0')}`;
          } else {
            nextManualReference = `${mPrefix}${mNumVal}`;
          }
        } else {
          nextManualReference = `${lastManual}-1`;
        }
      }
    }

    if (!nextManualReference) {
      const defaultPfx = configInfo.defaultPrefix || 'REF-';
      nextManualReference = `${defaultPfx}001`;
    }

    if (lastRecord && lastRecord[fieldName]) {
      const lastNumStr = String(lastRecord[fieldName]).trim();
      const match = lastNumStr.match(/^(.*?)(0*(\d+))$/);
      if (match) {
        const textPrefix = match[1]; // e.g. "M" or "ABC" or "INV-"
        const rawDigits = match[2];  // e.g. "009" or "1"
        const numVal = parseInt(match[3], 10);
        const nextNumVal = numVal + 1;

        let nextFormatted;
        if (rawDigits.startsWith('0') && rawDigits.length > 1) {
          const padded = String(nextNumVal).padStart(rawDigits.length, '0');
          nextFormatted = `${textPrefix}${padded}`;
        } else {
          nextFormatted = `${textPrefix}${nextNumVal}`;
        }

        const existing = await prisma[modelName].findFirst({
          where: { companyId: cid, [fieldName]: nextFormatted }
        });
        if (!existing) {
          return {
            formattedNumber: nextFormatted,
            currentNumber: nextNumVal,
            prefix: textPrefix,
            paddingLength: rawDigits.length,
            pattern: 'numeric',
            nextManualReference
          };
        }
      }
    }
  } catch (err) {
    console.warn('[numberingService] Error parsing lastRecord number:', err.message);
  }

  // 2. Fallback to configured numbering engine logic
  let config = await findConfig(cid, transactionType);
  if (!config) {
    config = await createConfig(cid, transactionType, configInfo.defaultPrefix, 1, 4, 'numeric');
  }

  let nextNum = config.currentNumber || 1;
  let formattedNumber = generateFormattedNumber(config.prefix, nextNum, config.paddingLength, config.pattern);

  let isUnique = false;
  let attempts = 0;
  while (!isUnique && attempts < 1000) {
    const existing = await prisma[modelName].findFirst({
      where: { companyId: cid, [fieldName]: formattedNumber }
    });
    if (!existing) {
      isUnique = true;
    } else {
      nextNum++;
      formattedNumber = generateFormattedNumber(config.prefix, nextNum, config.paddingLength, config.pattern);
    }
    attempts++;
  }

  return {
    formattedNumber,
    currentNumber: nextNum,
    prefix: config.prefix,
    paddingLength: Number(config.paddingLength),
    pattern: config.pattern,
    nextManualReference
  };
}

/**
 * Advances the sequence counter after a document is saved.
 */
async function incrementNumber(companyId, transactionType, usedNumber) {
  const configInfo = TRANSACTION_TYPES[transactionType];
  if (!configInfo) return;

  const cid = parseInt(companyId);
  let config = await findConfig(cid, transactionType);
  if (!config) {
    config = await createConfig(cid, transactionType, configInfo.defaultPrefix, 1, 4, 'numeric');
  }

  let parsedNumber = Number(config.currentNumber) || 1;

  if (usedNumber) {
    let stripped = usedNumber;
    if (config.pattern === 'custom') {
      const prefixPattern = formatPlaceholders(config.prefix || '');
      if (usedNumber.startsWith(prefixPattern)) stripped = usedNumber.substring(prefixPattern.length);
    } else if (config.prefix && usedNumber.startsWith(config.prefix)) {
      stripped = usedNumber.substring(config.prefix.length);
    }

    let parsedSuffix = NaN;
    if (config.pattern === 'alphanumeric') {
      const m = stripped.match(/[0-9A-Z]+$/i);
      if (m) parsedSuffix = parseInt(m[0], 36);
    } else {
      const m = stripped.match(/\d+$/);
      if (m) parsedSuffix = parseInt(m[0], 10);
    }

    parsedNumber = (!isNaN(parsedSuffix) && parsedSuffix >= parsedNumber)
      ? parsedSuffix + 1
      : parsedNumber + 1;

    // Safeguard against INT overflow in MySQL (INT maximum value is 2147483647)
    if (parsedNumber > 2147483640) {
      parsedNumber = (Number(config.currentNumber) || 1) + 1;
    }
  } else {
    parsedNumber += 1;
  }

  await updateConfig(config.id, {
    prefix: config.prefix,
    currentNumber: parsedNumber,
    paddingLength: Number(config.paddingLength),
    pattern: config.pattern
  });
}

module.exports = {
  TRANSACTION_TYPES,
  getNextNumber,
  incrementNumber,
  generateFormattedNumber,
  // expose raw helpers for companyController
  ensureTable,
  findAllConfigs,
  findConfig,
  upsertConfig
};
