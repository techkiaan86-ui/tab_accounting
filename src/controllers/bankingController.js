const prisma = require('../config/prisma');

/**
 * Ensures required database tables and columns exist for Banking & Reconciliation
 */
let tablesInitialized = false;
const ensureBankingTables = async () => {
    if (tablesInitialized) return;
    try {
        // 1. Ensure bankaccount table exists
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS bankaccount (
                id INT AUTO_INCREMENT PRIMARY KEY,
                accountName VARCHAR(255) NOT NULL,
                accountNumber VARCHAR(100) NOT NULL,
                bankName VARCHAR(255) NOT NULL,
                branchName VARCHAR(255) NULL,
                ifscCode VARCHAR(100) NULL,
                iban VARCHAR(100) NULL,
                swiftBic VARCHAR(50) NULL,
                currency VARCHAR(10) DEFAULT 'USD',
                openingBalance DOUBLE DEFAULT 0,
                currentBalance DOUBLE DEFAULT 0,
                ledgerId INT NULL,
                companyId INT NOT NULL,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_ba_company (companyId)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        // Helper to get existing column names for a table
        const getExistingColumns = async (table) => {
            try {
                const cols = await prisma.$queryRawUnsafe(`
                    SELECT COLUMN_NAME 
                    FROM information_schema.COLUMNS 
                    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?;
                `, table);
                return new Set(cols.map(c => (c.COLUMN_NAME || c.column_name || '').toLowerCase()));
            } catch (e) {
                return new Set();
            }
        };

        const bankAccountCols = await getExistingColumns('bankaccount');
        const safeAddColToBankAccount = async (colName, colDef) => {
            if (!bankAccountCols.has(colName.toLowerCase())) {
                try {
                    await prisma.$executeRawUnsafe(`ALTER TABLE bankaccount ADD COLUMN ${colDef};`);
                } catch (e) {}
            }
        };

        await safeAddColToBankAccount('iban', 'iban VARCHAR(100) NULL');
        await safeAddColToBankAccount('swiftBic', 'swiftBic VARCHAR(50) NULL');
        await safeAddColToBankAccount('currency', 'currency VARCHAR(10) DEFAULT "USD"');
        await safeAddColToBankAccount('ledgerId', 'ledgerId INT NULL');

        // 2. Ensure banktransaction table exists
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS banktransaction (
                id INT AUTO_INCREMENT PRIMARY KEY,
                date DATETIME NOT NULL,
                bankAccountId INT NOT NULL,
                transactionType VARCHAR(50) NOT NULL DEFAULT 'DEPOSIT',
                amount DOUBLE NOT NULL,
                description TEXT NULL,
                referenceNumber VARCHAR(100) NULL,
                status VARCHAR(50) DEFAULT 'UNMATCHED',
                matchedEntityType VARCHAR(50) NULL,
                matchedEntityId INT NULL,
                isCleared BOOLEAN DEFAULT FALSE,
                isReconciled BOOLEAN DEFAULT FALSE,
                reconciliationId INT NULL,
                companyId INT NOT NULL,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_bt_account (bankAccountId),
                INDEX idx_bt_company (companyId),
                INDEX idx_bt_status (status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        // Safely add missing columns to banktransaction only if they don't exist
        const bankTxCols = await getExistingColumns('banktransaction');
        const safeAddColToBankTx = async (colName, colDef) => {
            if (!bankTxCols.has(colName.toLowerCase())) {
                try {
                    await prisma.$executeRawUnsafe(`ALTER TABLE banktransaction ADD COLUMN ${colDef};`);
                } catch (e) {}
            }
        };

        await safeAddColToBankTx('status', "status VARCHAR(50) DEFAULT 'UNMATCHED'");
        await safeAddColToBankTx('matchedEntityType', 'matchedEntityType VARCHAR(50) NULL');
        await safeAddColToBankTx('matchedEntityId', 'matchedEntityId INT NULL');
        await safeAddColToBankTx('isCleared', 'isCleared BOOLEAN DEFAULT FALSE');
        await safeAddColToBankTx('isReconciled', 'isReconciled BOOLEAN DEFAULT FALSE');
        await safeAddColToBankTx('reconciliationId', 'reconciliationId INT NULL');

        // 3. Ensure bank_reconciliation table exists
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS bank_reconciliation (
                id INT AUTO_INCREMENT PRIMARY KEY,
                bankAccountId INT NOT NULL,
                statementDate DATETIME NOT NULL,
                statementEndingBalance DOUBLE NOT NULL,
                beginningBalance DOUBLE DEFAULT 0,
                clearedBalance DOUBLE NOT NULL,
                difference DOUBLE NOT NULL,
                clearedDepositsCount INT DEFAULT 0,
                clearedDepositsAmount DOUBLE DEFAULT 0,
                clearedWithdrawalsCount INT DEFAULT 0,
                clearedWithdrawalsAmount DOUBLE DEFAULT 0,
                status VARCHAR(50) DEFAULT 'COMPLETED',
                notes TEXT NULL,
                companyId INT NOT NULL,
                reconciledByUserId INT NULL,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_br_account (bankAccountId),
                INDEX idx_br_company (companyId)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        tablesInitialized = true;
    } catch (err) {
        console.error('Error ensuring banking tables exist:', err.message);
    }
};

ensureBankingTables();

// Helper to ensure an Asset account exists in Chart of Accounts for a bank account
const ensureBankLedger = async (companyId, accountName, bankName, initialBalance = 0) => {
    let assetsGroup = await prisma.accountgroup.findFirst({
        where: { companyId, type: 'ASSETS' }
    });

    if (!assetsGroup) {
        assetsGroup = await prisma.accountgroup.create({
            data: {
                name: 'Current Assets',
                type: 'ASSETS',
                companyId
            }
        });
    }

    const ledgerName = `${accountName} (${bankName})`;
    let ledger = await prisma.ledger.findFirst({
        where: { companyId, name: ledgerName }
    });

    if (!ledger) {
        ledger = await prisma.ledger.create({
            data: {
                name: ledgerName,
                groupId: assetsGroup.id,
                openingBalance: parseFloat(initialBalance) || 0,
                currentBalance: parseFloat(initialBalance) || 0,
                isEnabled: true,
                companyId
            }
        });
    }

    return ledger;
};

// ===================================================
// 1. BANK ACCOUNTS CRUD
// ===================================================

const getBankAccounts = async (req, res) => {
    try {
        await ensureBankingTables();
        const companyId = parseInt(req.user?.companyId || req.query.companyId);
        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID required' });

        let accounts = await prisma.$queryRawUnsafe(`
            SELECT ba.*, 
                   COALESCE(l.name, '') AS ledgerName,
                   COALESCE(l.currentBalance, ba.currentBalance) AS bookBalance
            FROM bankaccount ba
            LEFT JOIN ledger l ON ba.ledgerId = l.id
            WHERE ba.companyId = ?
            ORDER BY ba.id DESC
        `, companyId);

        // Auto-provision initial bank account if none exists yet
        if (!accounts || accounts.length === 0) {
            const bankLedger = await prisma.ledger.findFirst({
                where: {
                    companyId,
                    name: { contains: 'Bank' },
                    accountgroup: { type: 'ASSETS' }
                }
            });

            const company = await prisma.company.findUnique({
                where: { id: companyId }
            });

            if (bankLedger || company?.bankName || company?.accountNumber) {
                const accName = company?.accountName || bankLedger?.name || 'Main Bank Account';
                const bName = company?.bankName || 'Bank of Ireland';
                const accNum = company?.accountNumber || '123456789076';
                const cur = company?.currency || 'EUR';
                const bal = bankLedger ? Number(bankLedger.currentBalance || 0) : 0;
                const ledId = bankLedger ? bankLedger.id : null;

                await prisma.$executeRawUnsafe(`
                    INSERT INTO bankaccount (accountName, accountNumber, bankName, iban, swiftBic, currency, openingBalance, currentBalance, ledgerId, companyId)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, accName, accNum, bName, company?.iban || null, company?.bic || company?.swiftBic || null, cur, bal, bal, ledId, companyId);

                accounts = await prisma.$queryRawUnsafe(`
                    SELECT ba.*, 
                           COALESCE(l.name, '') AS ledgerName,
                           COALESCE(l.currentBalance, ba.currentBalance) AS bookBalance
                    FROM bankaccount ba
                    LEFT JOIN ledger l ON ba.ledgerId = l.id
                    WHERE ba.companyId = ?
                    ORDER BY ba.id DESC
                `, companyId);
            }
        }

        // Fetch counts of unmatched/pending transactions and last reconciled date per account
        const enriched = await Promise.all(accounts.map(async (acc) => {
            const [unmatchedCount] = await prisma.$queryRawUnsafe(`
                SELECT COUNT(*) as cnt FROM banktransaction 
                WHERE bankAccountId = ? AND (status = 'UNMATCHED' OR status = 'PENDING')
            `, acc.id);

            const [lastRec] = await prisma.$queryRawUnsafe(`
                SELECT statementDate, statementEndingBalance 
                FROM bank_reconciliation 
                WHERE bankAccountId = ? 
                ORDER BY statementDate DESC LIMIT 1
            `, acc.id);

            return {
                ...acc,
                unmatchedCount: Number(unmatchedCount?.cnt || 0),
                lastReconciledDate: lastRec?.statementDate || null,
                lastReconciledBalance: lastRec?.statementEndingBalance !== undefined ? Number(lastRec.statementEndingBalance) : null
            };
        }));

        return res.status(200).json({ success: true, data: enriched });
    } catch (error) {
        console.error('getBankAccounts error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const createBankAccount = async (req, res) => {
    try {
        await ensureBankingTables();
        const companyId = parseInt(req.user?.companyId || req.body.companyId);
        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID required' });

        const {
            accountName,
            accountNumber,
            bankName,
            branchName = '',
            ifscCode = '',
            iban = '',
            swiftBic = '',
            currency = 'USD',
            openingBalance = 0,
            linkToLedger = true
        } = req.body;

        if (!accountName || !accountNumber || !bankName) {
            return res.status(400).json({ success: false, message: 'Account Name, Account Number, and Bank Name are required' });
        }

        const bal = parseFloat(openingBalance) || 0;
        let ledgerId = null;

        if (linkToLedger) {
            const ledger = await ensureBankLedger(companyId, accountName, bankName, bal);
            ledgerId = ledger.id;
        }

        await prisma.$executeRawUnsafe(`
            INSERT INTO bankaccount (accountName, accountNumber, bankName, branchName, ifscCode, iban, swiftBic, currency, openingBalance, currentBalance, ledgerId, companyId)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, accountName, accountNumber, bankName, branchName, ifscCode, iban, swiftBic, currency, bal, bal, ledgerId, companyId);

        const [created] = await prisma.$queryRawUnsafe(`
            SELECT * FROM bankaccount WHERE companyId = ? ORDER BY id DESC LIMIT 1
        `, companyId);

        return res.status(201).json({ success: true, message: 'Bank Account created successfully', data: created });
    } catch (error) {
        console.error('createBankAccount error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const updateBankAccount = async (req, res) => {
    try {
        await ensureBankingTables();
        const companyId = parseInt(req.user?.companyId || req.body.companyId);
        const id = parseInt(req.params.id);

        const {
            accountName,
            accountNumber,
            bankName,
            branchName = '',
            ifscCode = '',
            iban = '',
            swiftBic = '',
            currency = 'USD',
            openingBalance = 0
        } = req.body;

        await prisma.$executeRawUnsafe(`
            UPDATE bankaccount 
            SET accountName = ?, accountNumber = ?, bankName = ?, branchName = ?, 
                ifscCode = ?, iban = ?, swiftBic = ?, currency = ?, openingBalance = ?
            WHERE id = ? AND companyId = ?
        `, accountName, accountNumber, bankName, branchName, ifscCode, iban, swiftBic, currency, parseFloat(openingBalance) || 0, id, companyId);

        return res.status(200).json({ success: true, message: 'Bank Account updated successfully' });
    } catch (error) {
        console.error('updateBankAccount error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const deleteBankAccount = async (req, res) => {
    try {
        await ensureBankingTables();
        const companyId = parseInt(req.user?.companyId || req.body.companyId);
        const id = parseInt(req.params.id);

        // Delete associated bank transactions and reconciliations
        await prisma.$executeRawUnsafe(`DELETE FROM banktransaction WHERE bankAccountId = ? AND companyId = ?`, id, companyId);
        await prisma.$executeRawUnsafe(`DELETE FROM bank_reconciliation WHERE bankAccountId = ? AND companyId = ?`, id, companyId);
        await prisma.$executeRawUnsafe(`DELETE FROM bankaccount WHERE id = ? AND companyId = ?`, id, companyId);

        return res.status(200).json({ success: true, message: 'Bank Account deleted successfully' });
    } catch (error) {
        console.error('deleteBankAccount error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// ===================================================
// 2. STATEMENT IMPORT (CSV / EXCEL PARSER)
// ===================================================

const importBankStatement = async (req, res) => {
    try {
        await ensureBankingTables();
        const companyId = parseInt(req.user?.companyId || req.body.companyId);
        const { bankAccountId, rows = [] } = req.body;

        if (!companyId || !bankAccountId) {
            return res.status(400).json({ success: false, message: 'Company ID and Bank Account are required' });
        }

        if (!Array.isArray(rows) || rows.length === 0) {
            return res.status(400).json({ success: false, message: 'No statement rows provided for import' });
        }

        let importedCount = 0;
        let skippedCount = 0;
        let netBalanceChange = 0;

        for (const row of rows) {
            // Flexible field extraction
            const txDate = row.date || row.Date || row['Transaction Date'] || row['Value Date'] || new Date();
            const description = (row.description || row.Description || row.Narration || row.Details || row.Payee || '').toString().trim();
            const reference = (row.reference || row.Ref || row['Reference Number'] || row['Cheque No'] || row['Chq / Ref No.'] || '').toString().trim();

            let amount = 0;
            let type = 'DEPOSIT'; // Inflow

            // Handle debit/credit columns vs single amount column
            const debit = parseFloat(row.debit || row.Debit || row.Withdrawal || row.Paid || 0) || 0;
            const credit = parseFloat(row.credit || row.Credit || row.Deposit || row.Received || 0) || 0;

            if (debit > 0) {
                amount = debit;
                type = 'WITHDRAWAL';
            } else if (credit > 0) {
                amount = credit;
                type = 'DEPOSIT';
            } else {
                const rawAmt = parseFloat(row.amount || row.Amount || 0) || 0;
                amount = Math.abs(rawAmt);
                type = rawAmt < 0 ? 'WITHDRAWAL' : 'DEPOSIT';
            }

            if (amount <= 0) {
                skippedCount++;
                continue;
            }

            // Check for duplicate transaction
            const dateObj = new Date(txDate);
            const formattedDate = !isNaN(dateObj.getTime()) ? dateObj.toISOString().slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ');

            const [existing] = await prisma.$queryRawUnsafe(`
                SELECT id FROM banktransaction 
                WHERE bankAccountId = ? AND date = ? AND amount = ? AND transactionType = ? AND referenceNumber = ?
                LIMIT 1
            `, parseInt(bankAccountId), formattedDate, amount, type, reference);

            if (existing) {
                skippedCount++;
                continue;
            }

            await prisma.$executeRawUnsafe(`
                INSERT INTO banktransaction (date, bankAccountId, transactionType, amount, description, referenceNumber, status, isCleared, isReconciled, companyId)
                VALUES (?, ?, ?, ?, ?, ?, 'UNMATCHED', FALSE, FALSE, ?)
            `, formattedDate, parseInt(bankAccountId), type, amount, description, reference, companyId);

            importedCount++;
            netBalanceChange += (type === 'DEPOSIT' ? amount : -amount);
        }

        // Update currentBalance of the bank account
        if (netBalanceChange !== 0) {
            await prisma.$executeRawUnsafe(`
                UPDATE bankaccount 
                SET currentBalance = currentBalance + ? 
                WHERE id = ? AND companyId = ?
            `, netBalanceChange, parseInt(bankAccountId), companyId);
        }

        return res.status(200).json({
            success: true,
            message: `Successfully imported ${importedCount} transactions (${skippedCount} duplicates/zero amounts skipped).`,
            importedCount,
            skippedCount
        });
    } catch (error) {
        console.error('importBankStatement error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// ===================================================
// 3. BANK FEEDS & TRANSACTION MATCHING INTERFACE
// ===================================================

const getBankTransactions = async (req, res) => {
    try {
        await ensureBankingTables();
        const companyId = parseInt(req.user?.companyId || req.query.companyId);
        const { bankAccountId, status, startDate, endDate, search } = req.query;

        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID required' });

        let query = `SELECT * FROM banktransaction WHERE companyId = ?`;
        const params = [companyId];

        if (bankAccountId) {
            query += ` AND bankAccountId = ?`;
            params.push(parseInt(bankAccountId));
        }

        if (status && status !== 'ALL') {
            if (status === 'FOR_REVIEW' || status === 'UNMATCHED') {
                query += ` AND (status = 'UNMATCHED' OR status = 'PENDING')`;
            } else {
                query += ` AND status = ?`;
                params.push(status);
            }
        }

        if (startDate) {
            query += ` AND date >= ?`;
            params.push(new Date(startDate).toISOString().slice(0, 10) + ' 00:00:00');
        }

        if (endDate) {
            query += ` AND date <= ?`;
            params.push(new Date(endDate).toISOString().slice(0, 10) + ' 23:59:59');
        }

        if (search) {
            query += ` AND (description LIKE ? OR referenceNumber LIKE ?)`;
            params.push(`%${search}%`, `%${search}%`);
        }

        query += ` ORDER BY date DESC, id DESC`;

        const transactions = await prisma.$queryRawUnsafe(query, ...params);
        return res.status(200).json({ success: true, data: transactions });
    } catch (error) {
        console.error('getBankTransactions error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Intelligent Match Finder:
 * Searches for system invoices, bills, receipts, payments, and expenses that closely match
 * the bank transaction's amount, date window (±14 days), and type.
 */
const findMatchesForTransaction = async (req, res) => {
    try {
        await ensureBankingTables();
        const companyId = parseInt(req.user?.companyId || req.query.companyId);
        const id = parseInt(req.params.id);

        const [tx] = await prisma.$queryRawUnsafe(`
            SELECT * FROM banktransaction WHERE id = ? AND companyId = ?
        `, id, companyId);

        if (!tx) return res.status(404).json({ success: false, message: 'Transaction not found' });

        const txDate = new Date(tx.date);
        const minDate = new Date(txDate.getTime() - 14 * 24 * 60 * 60 * 1000);
        const maxDate = new Date(txDate.getTime() + 14 * 24 * 60 * 60 * 1000);
        const targetAmount = parseFloat(tx.amount);

        const matches = [];

        if (tx.transactionType === 'DEPOSIT') {
            // 1. Check unpaid / partial Sales Invoices
            const openInvoices = await prisma.invoice.findMany({
                where: {
                    companyId,
                    balanceAmount: { gt: 0 }
                },
                include: { customer: { select: { name: true } } },
                take: 20
            });

            openInvoices.forEach(inv => {
                const balDiff = Math.abs(inv.balanceAmount - targetAmount);
                const totalDiff = Math.abs(inv.totalAmount - targetAmount);
                if (balDiff < 0.05 || totalDiff < 0.05) {
                    matches.push({
                        entityType: 'INVOICE',
                        entityId: inv.id,
                        reference: inv.invoiceNumber,
                        partyName: inv.customer?.name || 'Customer',
                        date: inv.date,
                        amount: inv.balanceAmount || inv.totalAmount,
                        confidence: balDiff < 0.01 ? 'HIGH' : 'MEDIUM'
                    });
                }
            });

            // 2. Check Customer Receipts
            const receipts = await prisma.receipt.findMany({
                where: {
                    companyId,
                    date: { gte: minDate, lte: maxDate }
                },
                include: { customer: { select: { name: true } } },
                take: 20
            });

            receipts.forEach(rec => {
                if (Math.abs(rec.amount - targetAmount) < 0.05) {
                    matches.push({
                        entityType: 'RECEIPT',
                        entityId: rec.id,
                        reference: rec.receiptNumber || `REC-${rec.id}`,
                        partyName: rec.customer?.name || 'Customer',
                        date: rec.date,
                        amount: rec.amount,
                        confidence: 'HIGH'
                    });
                }
            });
        } else {
            // WITHDRAWAL
            // 1. Check unpaid / partial Purchase Bills
            const openBills = await prisma.purchasebill.findMany({
                where: {
                    companyId,
                    balanceAmount: { gt: 0 }
                },
                include: { vendor: { select: { name: true } } },
                take: 20
            });

            openBills.forEach(bill => {
                const balDiff = Math.abs(bill.balanceAmount - targetAmount);
                const totalDiff = Math.abs(bill.totalAmount - targetAmount);
                if (balDiff < 0.05 || totalDiff < 0.05) {
                    matches.push({
                        entityType: 'PURCHASE_BILL',
                        entityId: bill.id,
                        reference: bill.billNumber,
                        partyName: bill.vendor?.name || 'Supplier',
                        date: bill.date,
                        amount: bill.balanceAmount || bill.totalAmount,
                        confidence: balDiff < 0.01 ? 'HIGH' : 'MEDIUM'
                    });
                }
            });

            // 2. Check Vendor Payments
            const payments = await prisma.payment.findMany({
                where: {
                    companyId,
                    date: { gte: minDate, lte: maxDate }
                },
                include: { vendor: { select: { name: true } } },
                take: 20
            });

            payments.forEach(pmt => {
                if (Math.abs(pmt.amount - targetAmount) < 0.05) {
                    matches.push({
                        entityType: 'PAYMENT',
                        entityId: pmt.id,
                        reference: pmt.paymentNumber || `PMT-${pmt.id}`,
                        partyName: pmt.vendor?.name || 'Supplier',
                        date: pmt.date,
                        amount: pmt.amount,
                        confidence: 'HIGH'
                    });
                }
            });

            // 3. Check Expense Vouchers
            const expenses = await prisma.transaction.findMany({
                where: {
                    companyId,
                    voucherType: 'EXPENSE',
                    date: { gte: minDate, lte: maxDate }
                },
                take: 20
            });

            expenses.forEach(exp => {
                if (Math.abs(exp.amount - targetAmount) < 0.05) {
                    matches.push({
                        entityType: 'EXPENSE',
                        entityId: exp.id,
                        reference: exp.voucherNumber,
                        partyName: exp.narration || 'Expense',
                        date: exp.date,
                        amount: exp.amount,
                        confidence: 'HIGH'
                    });
                }
            });
        }

        return res.status(200).json({ success: true, data: matches });
    } catch (error) {
        console.error('findMatchesForTransaction error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const matchTransaction = async (req, res) => {
    try {
        await ensureBankingTables();
        const companyId = parseInt(req.user?.companyId || req.body.companyId);
        const id = parseInt(req.params.id);
        const { entityType, entityId, reference = '' } = req.body;

        if (!entityType || !entityId) {
            return res.status(400).json({ success: false, message: 'Entity Type and Entity ID are required to match' });
        }

        await prisma.$executeRawUnsafe(`
            UPDATE banktransaction 
            SET status = 'MATCHED', matchedEntityType = ?, matchedEntityId = ?, isCleared = TRUE,
                referenceNumber = COALESCE(NULLIF(referenceNumber, ''), ?)
            WHERE id = ? AND companyId = ?
        `, entityType, parseInt(entityId), reference, id, companyId);

        return res.status(200).json({ success: true, message: `Transaction matched with ${entityType} #${reference || entityId}` });
    } catch (error) {
        console.error('matchTransaction error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const categorizeTransaction = async (req, res) => {
    try {
        await ensureBankingTables();
        const companyId = parseInt(req.user?.companyId || req.body.companyId);
        const id = parseInt(req.params.id);
        const { ledgerId, narration = '', payee = '' } = req.body;

        if (!ledgerId) {
            return res.status(400).json({ success: false, message: 'GL Ledger is required for categorization' });
        }

        const [tx] = await prisma.$queryRawUnsafe(`
            SELECT * FROM banktransaction WHERE id = ? AND companyId = ?
        `, id, companyId);

        if (!tx) return res.status(404).json({ success: false, message: 'Transaction not found' });

        // Fetch bank account's linked ledger
        const [bankAcc] = await prisma.$queryRawUnsafe(`
            SELECT * FROM bankaccount WHERE id = ?
        `, tx.bankAccountId);

        let bankLedgerId = bankAcc?.ledgerId;
        if (!bankLedgerId) {
            const l = await ensureBankLedger(companyId, bankAcc?.accountName || 'Bank', bankAcc?.bankName || 'Account');
            bankLedgerId = l.id;
        }

        const txAmount = parseFloat(tx.amount);
        const isWithdrawal = tx.transactionType === 'WITHDRAWAL';

        // Create formal accounting transaction
        const voucherType = isWithdrawal ? 'EXPENSE' : 'INCOME';
        const vchNo = `BANK-${Date.now().toString().slice(-6)}`;

        const createdVoucher = await prisma.transaction.create({
            data: {
                date: new Date(tx.date),
                voucherType,
                voucherNumber: vchNo,
                debitLedgerId: isWithdrawal ? parseInt(ledgerId) : parseInt(bankLedgerId),
                creditLedgerId: isWithdrawal ? parseInt(bankLedgerId) : parseInt(ledgerId),
                amount: txAmount,
                narration: narration || tx.description || `${voucherType} from Bank Feed`,
                companyId
            }
        });

        // Update target ledger balance
        await prisma.ledger.update({
            where: { id: parseInt(ledgerId) },
            data: {
                currentBalance: { increment: isWithdrawal ? txAmount : -txAmount }
            }
        });

        // Update bank transaction status to MATCHED
        await prisma.$executeRawUnsafe(`
            UPDATE banktransaction 
            SET status = 'MATCHED', matchedEntityType = ?, matchedEntityId = ?, isCleared = TRUE
            WHERE id = ? AND companyId = ?
        `, voucherType, createdVoucher.id, id, companyId);

        return res.status(200).json({
            success: true,
            message: `Categorized and posted as ${voucherType} Voucher #${vchNo}`
        });
    } catch (error) {
        console.error('categorizeTransaction error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const unmatchTransaction = async (req, res) => {
    try {
        await ensureBankingTables();
        const companyId = parseInt(req.user?.companyId || req.body.companyId);
        const id = parseInt(req.params.id);

        await prisma.$executeRawUnsafe(`
            UPDATE banktransaction 
            SET status = 'UNMATCHED', matchedEntityType = NULL, matchedEntityId = NULL, isCleared = FALSE
            WHERE id = ? AND companyId = ? AND isReconciled = FALSE
        `, id, companyId);

        return res.status(200).json({ success: true, message: 'Transaction un-matched successfully' });
    } catch (error) {
        console.error('unmatchTransaction error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// ===================================================
// 4. BANK RECONCILIATION ENGINE
// ===================================================

const getReconciliationData = async (req, res) => {
    try {
        await ensureBankingTables();
        const companyId = parseInt(req.user?.companyId || req.query.companyId);
        const { bankAccountId, statementDate, statementEndingBalance } = req.query;

        if (!companyId || !bankAccountId) {
            return res.status(400).json({ success: false, message: 'Bank Account ID is required' });
        }

        const bId = parseInt(bankAccountId);
        const targetEndingBal = statementEndingBalance !== undefined && statementEndingBalance !== '' ? parseFloat(statementEndingBalance) : 0;

        // 1. Fetch Beginning Balance (Ending balance of last completed reconciliation, or account opening balance)
        const [lastRec] = await prisma.$queryRawUnsafe(`
            SELECT statementEndingBalance, statementDate 
            FROM bank_reconciliation 
            WHERE bankAccountId = ? AND companyId = ? 
            ORDER BY statementDate DESC LIMIT 1
        `, bId, companyId);

        let beginningBalance = 0;
        if (lastRec) {
            beginningBalance = parseFloat(lastRec.statementEndingBalance) || 0;
        } else {
            const [acc] = await prisma.$queryRawUnsafe(`
                SELECT openingBalance FROM bankaccount WHERE id = ?
            `, bId);
            beginningBalance = parseFloat(acc?.openingBalance) || 0;
        }

        // 2. Fetch all unreconciled transactions for this account up to the statement date
        let dateFilter = '';
        const params = [bId, companyId];
        if (statementDate) {
            dateFilter = ` AND date <= ?`;
            params.push(new Date(statementDate).toISOString().slice(0, 10) + ' 23:59:59');
        }

        const transactions = await prisma.$queryRawUnsafe(`
            SELECT id, date, transactionType, amount, description, referenceNumber, status, isCleared, isReconciled 
            FROM banktransaction 
            WHERE bankAccountId = ? AND companyId = ? AND isReconciled = FALSE ${dateFilter}
            ORDER BY date ASC, id ASC
        `, ...params);

        // Compute Cleared Totals
        let clearedDepositsCount = 0;
        let clearedDepositsAmount = 0;
        let clearedWithdrawalsCount = 0;
        let clearedWithdrawalsAmount = 0;

        transactions.forEach(t => {
            const amt = parseFloat(t.amount) || 0;
            if (t.isCleared) {
                if (t.transactionType === 'DEPOSIT') {
                    clearedDepositsCount++;
                    clearedDepositsAmount += amt;
                } else {
                    clearedWithdrawalsCount++;
                    clearedWithdrawalsAmount += amt;
                }
            }
        });

        const clearedBalance = beginningBalance + clearedDepositsAmount - clearedWithdrawalsAmount;
        const difference = targetEndingBal - clearedBalance;

        return res.status(200).json({
            success: true,
            data: {
                beginningBalance: parseFloat(beginningBalance.toFixed(2)),
                statementEndingBalance: parseFloat(targetEndingBal.toFixed(2)),
                clearedBalance: parseFloat(clearedBalance.toFixed(2)),
                difference: parseFloat(difference.toFixed(2)),
                isBalanced: Math.abs(difference) < 0.01,
                clearedDepositsCount,
                clearedDepositsAmount: parseFloat(clearedDepositsAmount.toFixed(2)),
                clearedWithdrawalsCount,
                clearedWithdrawalsAmount: parseFloat(clearedWithdrawalsAmount.toFixed(2)),
                transactions
            }
        });
    } catch (error) {
        console.error('getReconciliationData error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const toggleClearTransaction = async (req, res) => {
    try {
        await ensureBankingTables();
        const companyId = parseInt(req.user?.companyId || req.body.companyId);
        const { transactionId, isCleared } = req.body;

        await prisma.$executeRawUnsafe(`
            UPDATE banktransaction 
            SET isCleared = ? 
            WHERE id = ? AND companyId = ? AND isReconciled = FALSE
        `, isCleared === true || isCleared === 'true', parseInt(transactionId), companyId);

        return res.status(200).json({ success: true, message: 'Cleared state updated' });
    } catch (error) {
        console.error('toggleClearTransaction error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const commitReconciliation = async (req, res) => {
    try {
        await ensureBankingTables();
        const companyId = parseInt(req.user?.companyId || req.body.companyId);
        const userId = req.user?.userId || null;
        const {
            bankAccountId,
            statementDate,
            statementEndingBalance,
            beginningBalance = 0,
            clearedBalance = 0,
            difference = 0,
            clearedDepositsCount = 0,
            clearedDepositsAmount = 0,
            clearedWithdrawalsCount = 0,
            clearedWithdrawalsAmount = 0,
            clearedTransactionIds = [],
            notes = ''
        } = req.body;

        if (!bankAccountId || !statementDate) {
            return res.status(400).json({ success: false, message: 'Bank Account and Statement Date are required' });
        }

        const bId = parseInt(bankAccountId);
        const diff = parseFloat(difference) || 0;

        if (Math.abs(diff) >= 0.01) {
            return res.status(400).json({
                success: false,
                message: `Cannot finish reconciliation with non-zero difference ($${diff.toFixed(2)}). Difference must be $0.00.`
            });
        }

        const dateObj = new Date(statementDate);
        const formattedDate = !isNaN(dateObj.getTime()) ? dateObj.toISOString().slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ');

        // Insert reconciliation record
        await prisma.$executeRawUnsafe(`
            INSERT INTO bank_reconciliation 
            (bankAccountId, statementDate, statementEndingBalance, beginningBalance, clearedBalance, difference,
             clearedDepositsCount, clearedDepositsAmount, clearedWithdrawalsCount, clearedWithdrawalsAmount,
             status, notes, companyId, reconciledByUserId)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?)
        `, bId, formattedDate, parseFloat(statementEndingBalance), parseFloat(beginningBalance),
           parseFloat(clearedBalance), diff, parseInt(clearedDepositsCount), parseFloat(clearedDepositsAmount),
           parseInt(clearedWithdrawalsCount), parseFloat(clearedWithdrawalsAmount), notes, companyId, userId);

        const [recRecord] = await prisma.$queryRawUnsafe(`
            SELECT id FROM bank_reconciliation WHERE bankAccountId = ? AND companyId = ? ORDER BY id DESC LIMIT 1
        `, bId, companyId);

        // Mark all cleared transactions as reconciled
        if (Array.isArray(clearedTransactionIds) && clearedTransactionIds.length > 0) {
            const idList = clearedTransactionIds.map(id => parseInt(id)).filter(id => !isNaN(id));
            if (idList.length > 0) {
                await prisma.$executeRawUnsafe(`
                    UPDATE banktransaction 
                    SET isReconciled = TRUE, isCleared = TRUE, status = 'RECONCILED', reconciliationId = ? 
                    WHERE id IN (${idList.join(',')}) AND companyId = ?
                `, recRecord.id, companyId);
            }
        }

        return res.status(200).json({
            success: true,
            message: 'Bank Reconciliation successfully completed and locked!',
            reconciliationId: recRecord.id
        });
    } catch (error) {
        console.error('commitReconciliation error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const getReconciliationHistory = async (req, res) => {
    try {
        await ensureBankingTables();
        const companyId = parseInt(req.user?.companyId || req.query.companyId);
        const { bankAccountId } = req.query;

        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID required' });

        let query = `
            SELECT br.*, ba.accountName, ba.bankName, ba.accountNumber 
            FROM bank_reconciliation br
            JOIN bankaccount ba ON br.bankAccountId = ba.id
            WHERE br.companyId = ?
        `;
        const params = [companyId];

        if (bankAccountId) {
            query += ` AND br.bankAccountId = ?`;
            params.push(parseInt(bankAccountId));
        }

        query += ` ORDER BY br.statementDate DESC, br.id DESC`;

        const history = await prisma.$queryRawUnsafe(query, ...params);
        return res.status(200).json({ success: true, data: history });
    } catch (error) {
        console.error('getReconciliationHistory error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    getBankAccounts,
    createBankAccount,
    updateBankAccount,
    deleteBankAccount,
    importBankStatement,
    getBankTransactions,
    findMatchesForTransaction,
    matchTransaction,
    categorizeTransaction,
    unmatchTransaction,
    getReconciliationData,
    toggleClearTransaction,
    commitReconciliation,
    getReconciliationHistory
};
