const prisma = require('../config/prisma');

/**
 * Ensures required database tables exist for advanced accounting modules
 */
let tablesInitialized = false;
const ensureTablesExist = async () => {
    if (tablesInitialized) return;
    try {
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS fixed_asset (
                id INT AUTO_INCREMENT PRIMARY KEY,
                assetName VARCHAR(255) NOT NULL,
                assetNumber VARCHAR(100) NULL,
                assetCategoryId INT NULL,
                purchaseDate DATETIME NOT NULL,
                purchaseCost DOUBLE NOT NULL,
                salvageValue DOUBLE DEFAULT 0,
                usefulLifeYears DOUBLE DEFAULT 5,
                depreciationMethod VARCHAR(50) DEFAULT 'STRAIGHT_LINE',
                assetLedgerId INT NULL,
                accumulatedDepLedgerId INT NULL,
                depExpenseLedgerId INT NULL,
                accumulatedDepreciation DOUBLE DEFAULT 0,
                currentBookValue DOUBLE NOT NULL,
                lastDepreciationDate DATETIME NULL,
                status VARCHAR(50) DEFAULT 'ACTIVE',
                companyId INT NOT NULL,
                notes TEXT NULL,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_fa_company (companyId)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS budget (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                fiscalYear INT NOT NULL,
                periodType VARCHAR(50) DEFAULT 'MONTHLY',
                startDate DATETIME NOT NULL,
                endDate DATETIME NOT NULL,
                totalBudgetAmount DOUBLE DEFAULT 0,
                companyId INT NOT NULL,
                notes TEXT NULL,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_budget_company (companyId)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS budget_item (
                id INT AUTO_INCREMENT PRIMARY KEY,
                budgetId INT NOT NULL,
                ledgerId INT NOT NULL,
                allocatedAmount DOUBLE DEFAULT 0,
                monthIndex INT DEFAULT 1,
                notes VARCHAR(255) NULL,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_bi_budget (budgetId),
                INDEX idx_bi_ledger (ledgerId)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS recurring_template (
                id INT AUTO_INCREMENT PRIMARY KEY,
                templateName VARCHAR(255) NOT NULL,
                transactionType VARCHAR(50) NOT NULL,
                frequency VARCHAR(50) DEFAULT 'MONTHLY',
                startDate DATETIME NOT NULL,
                endDate DATETIME NULL,
                nextRunDate DATETIME NOT NULL,
                lastRunDate DATETIME NULL,
                totalAmount DOUBLE DEFAULT 0,
                status VARCHAR(50) DEFAULT 'ACTIVE',
                templateData LONGTEXT NOT NULL,
                companyId INT NOT NULL,
                executionCount INT DEFAULT 0,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_rec_company (companyId),
                INDEX idx_rec_nextrun (nextRunDate)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS fiscal_year_close_log (
                id INT AUTO_INCREMENT PRIMARY KEY,
                fiscalYear INT NOT NULL,
                closeDate DATETIME NOT NULL,
                closedByUserId INT NULL,
                retainedEarningsLedgerId INT NULL,
                netProfitLossAmount DOUBLE NOT NULL,
                closingVoucherId INT NULL,
                companyId INT NOT NULL,
                status VARCHAR(50) DEFAULT 'LOCKED',
                details LONGTEXT NULL,
                createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_fyc_company (companyId)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        tablesInitialized = true;
    } catch (err) {
        console.error('Error ensuring advanced accounting tables exist:', err.message);
    }
};

// Auto-run table initialization
ensureTablesExist();

// Helper to find or create system ledgers
const getOrCreateSystemLedger = async (companyId, name, groupType, groupNameDefault) => {
    let ledger = await prisma.ledger.findFirst({
        where: { companyId, name: { equals: name } }
    });
    if (ledger) return ledger;

    let group = await prisma.accountgroup.findFirst({
        where: { companyId, type: groupType }
    });
    if (!group) {
        group = await prisma.accountgroup.create({
            data: {
                name: groupNameDefault || groupType,
                type: groupType,
                companyId
            }
        });
    }

    ledger = await prisma.ledger.create({
        data: {
            name,
            groupId: group.id,
            openingBalance: 0,
            currentBalance: 0,
            isEnabled: true,
            companyId
        }
    });
    return ledger;
};

// ==========================================
// 1. MULTI-CURRENCY REVALUATION ENGINE
// ==========================================

const getCurrencyRevaluationPreview = async (req, res) => {
    try {
        await ensureTablesExist();
        const companyId = req.user?.companyId || parseInt(req.query.companyId);
        const revaluationDate = req.query.date ? new Date(req.query.date) : new Date();

        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID required' });

        const company = await prisma.company.findUnique({ where: { id: companyId } });
        const baseCurrency = company?.currency || 'EUR';

        // 1. Open Foreign Receivables (Invoices)
        const openInvoices = await prisma.invoice.findMany({
            where: {
                companyId,
                status: { notIn: ['PAID', 'CANCELLED'] },
                balanceAmount: { gt: 0 },
                currency: { not: baseCurrency }
            },
            include: { customer: true }
        });

        // 2. Open Foreign Payables (Purchase Bills)
        const openBills = await prisma.purchasebill.findMany({
            where: {
                companyId,
                status: { notIn: ['PAID', 'CANCELLED'] },
                balanceAmount: { gt: 0 },
                currency: { not: baseCurrency }
            },
            include: { vendor: true }
        });

        const items = [];
        let totalUnrealizedGain = 0;
        let totalUnrealizedLoss = 0;

        const spotRates = req.body?.rates || {};

        for (const inv of openInvoices) {
            const currency = inv.currency || 'USD';
            const foreignBalance = inv.balanceAmount;
            const historicalRate = 1.0; 
            const spotRate = spotRates[currency] !== undefined ? parseFloat(spotRates[currency]) : 1.0;
            
            const bookedBase = foreignBalance * historicalRate;
            const revaluedBase = foreignBalance * spotRate;
            const diff = revaluedBase - bookedBase;

            const gainLoss = diff;
            if (gainLoss >= 0) totalUnrealizedGain += gainLoss;
            else totalUnrealizedLoss += Math.abs(gainLoss);

            items.push({
                type: 'RECEIVABLE',
                refNumber: inv.invoiceNumber,
                partyName: inv.customer?.name || 'Customer',
                currency,
                foreignBalance,
                historicalRate,
                spotRate,
                bookedBaseAmount: parseFloat(bookedBase.toFixed(2)),
                revaluedBaseAmount: parseFloat(revaluedBase.toFixed(2)),
                gainLoss: parseFloat(gainLoss.toFixed(2)),
                status: gainLoss >= 0 ? 'GAIN' : 'LOSS'
            });
        }

        for (const bill of openBills) {
            const currency = bill.currency || 'USD';
            const foreignBalance = bill.balanceAmount;
            const historicalRate = 1.0;
            const spotRate = spotRates[currency] !== undefined ? parseFloat(spotRates[currency]) : 1.0;
            
            const bookedBase = foreignBalance * historicalRate;
            const revaluedBase = foreignBalance * spotRate;
            const diff = bookedBase - revaluedBase;

            const gainLoss = diff;
            if (gainLoss >= 0) totalUnrealizedGain += gainLoss;
            else totalUnrealizedLoss += Math.abs(gainLoss);

            items.push({
                type: 'PAYABLE',
                refNumber: bill.billNumber,
                partyName: bill.vendor?.name || 'Vendor',
                currency,
                foreignBalance,
                historicalRate,
                spotRate,
                bookedBaseAmount: parseFloat(bookedBase.toFixed(2)),
                revaluedBaseAmount: parseFloat(revaluedBase.toFixed(2)),
                gainLoss: parseFloat(gainLoss.toFixed(2)),
                status: gainLoss >= 0 ? 'GAIN' : 'LOSS'
            });
        }

        const netGainLoss = totalUnrealizedGain - totalUnrealizedLoss;

        return res.status(200).json({
            success: true,
            data: {
                revaluationDate,
                baseCurrency,
                totalItems: items.length,
                totalUnrealizedGain: parseFloat(totalUnrealizedGain.toFixed(2)),
                totalUnrealizedLoss: parseFloat(totalUnrealizedLoss.toFixed(2)),
                netGainLoss: parseFloat(netGainLoss.toFixed(2)),
                items
            }
        });
    } catch (error) {
        console.error('Currency Revaluation Preview Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const postCurrencyRevaluationJournal = async (req, res) => {
    try {
        await ensureTablesExist();
        const companyId = req.user?.companyId || parseInt(req.body.companyId);
        const { date = new Date(), netGainLoss = 0, items = [], notes = 'Foreign Exchange Unrealized Gain/Loss Revaluation' } = req.body;

        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID required' });
        if (Math.abs(netGainLoss) < 0.01) {
            return res.status(400).json({ success: false, message: 'Net gain/loss is zero. No revaluation entry required.' });
        }

        const fxLedger = await getOrCreateSystemLedger(
            companyId, 
            netGainLoss >= 0 ? 'Foreign Exchange Gain' : 'Foreign Exchange Loss',
            netGainLoss >= 0 ? 'INCOME' : 'EXPENSES',
            netGainLoss >= 0 ? 'Other Income' : 'Other Expenses'
        );

        const controlLedger = await getOrCreateSystemLedger(
            companyId,
            'Currency Revaluation Reserve',
            'EQUITY',
            'Reserves & Surplus'
        );

        const voucherNumber = `FX-REV-${Date.now().toString().slice(-6)}`;
        const amount = Math.abs(parseFloat(netGainLoss));

        const voucher = await prisma.voucher.create({
            data: {
                voucherNumber,
                voucherType: 'JOURNAL',
                date: new Date(date),
                totalAmount: amount,
                notes: `${notes} (${items.length} positions revalued)`,
                companyId,
                voucheritem: {
                    create: [
                        {
                            ledgerId: netGainLoss >= 0 ? controlLedger.id : fxLedger.id,
                            ledgerName: netGainLoss >= 0 ? controlLedger.name : fxLedger.name,
                            debit: amount,
                            credit: 0,
                            amount: amount,
                            narration: `FX Revaluation Debit - ${items.length} items`
                        },
                        {
                            ledgerId: netGainLoss >= 0 ? fxLedger.id : controlLedger.id,
                            ledgerName: netGainLoss >= 0 ? fxLedger.name : controlLedger.name,
                            debit: 0,
                            credit: amount,
                            amount: amount,
                            narration: `FX Revaluation Credit - ${items.length} items`
                        }
                    ]
                }
            },
            include: { voucheritem: true }
        });

        await prisma.transaction.create({
            data: {
                date: new Date(date),
                debitLedgerId: netGainLoss >= 0 ? controlLedger.id : fxLedger.id,
                creditLedgerId: netGainLoss >= 0 ? fxLedger.id : controlLedger.id,
                amount: amount,
                voucherType: 'JOURNAL',
                voucherNumber: voucherNumber,
                narration: `FX Revaluation Journal #${voucherNumber}`,
                companyId
            }
        });

        await prisma.ledger.update({
            where: { id: fxLedger.id },
            data: { currentBalance: { increment: amount } }
        });
        await prisma.ledger.update({
            where: { id: controlLedger.id },
            data: { currentBalance: { increment: amount } }
        });

        return res.status(200).json({
            success: true,
            message: `Currency Revaluation Journal #${voucherNumber} posted successfully!`,
            data: voucher
        });
    } catch (error) {
        console.error('Post Currency Revaluation Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// ==========================================
// 2. FISCAL YEAR ROLLOVER & CLOSING ENGINE
// ==========================================

const getFiscalYearRolloverPreview = async (req, res) => {
    try {
        await ensureTablesExist();
        const companyId = req.user?.companyId || parseInt(req.query.companyId);
        const fiscalYear = parseInt(req.query.fiscalYear) || new Date().getFullYear();

        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID required' });

        const startDate = new Date(`${fiscalYear}-01-01T00:00:00.000Z`);
        const endDate = new Date(`${fiscalYear}-12-31T23:59:59.999Z`);

        const existingClose = await prisma.$queryRawUnsafe(`
            SELECT * FROM fiscal_year_close_log WHERE companyId = ? AND fiscalYear = ? LIMIT 1
        `, companyId, fiscalYear);

        const isAlreadyClosed = Array.isArray(existingClose) && existingClose.length > 0;

        const groups = await prisma.accountgroup.findMany({
            where: { companyId },
            include: { ledger: true }
        });

        let totalIncome = 0;
        let totalExpenses = 0;
        const incomeAccounts = [];
        const expenseAccounts = [];
        const balanceSheetAccounts = [];

        for (const group of groups) {
            for (const ledger of group.ledger) {
                const balance = Math.abs(ledger.currentBalance || 0);

                if (group.type === 'INCOME') {
                    totalIncome += balance;
                    incomeAccounts.push({ id: ledger.id, name: ledger.name, balance, group: group.name });
                } else if (group.type === 'EXPENSES') {
                    totalExpenses += balance;
                    expenseAccounts.push({ id: ledger.id, name: ledger.name, balance, group: group.name });
                } else {
                    balanceSheetAccounts.push({
                        id: ledger.id,
                        name: ledger.name,
                        type: group.type,
                        group: group.name,
                        closingBalance: ledger.currentBalance,
                        rollForwardOpening: ledger.currentBalance
                    });
                }
            }
        }

        const netProfitLoss = totalIncome - totalExpenses;

        return res.status(200).json({
            success: true,
            data: {
                fiscalYear,
                nextFiscalYear: fiscalYear + 1,
                startDate,
                endDate,
                isAlreadyClosed,
                totalIncome: parseFloat(totalIncome.toFixed(2)),
                totalExpenses: parseFloat(totalExpenses.toFixed(2)),
                netProfitLoss: parseFloat(netProfitLoss.toFixed(2)),
                netStatus: netProfitLoss >= 0 ? 'NET_PROFIT' : 'NET_LOSS',
                incomeAccounts,
                expenseAccounts,
                balanceSheetAccounts
            }
        });
    } catch (error) {
        console.error('Fiscal Year Rollover Preview Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const executeFiscalYearRollover = async (req, res) => {
    try {
        await ensureTablesExist();
        const companyId = req.user?.companyId || parseInt(req.body.companyId);
        const userId = req.user?.id || null;
        const fiscalYear = parseInt(req.body.fiscalYear) || new Date().getFullYear();

        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID required' });

        const retainedEarnings = await getOrCreateSystemLedger(
            companyId,
            'Retained Earnings',
            'EQUITY',
            'Reserves & Surplus'
        );

        const nominalGroups = await prisma.accountgroup.findMany({
            where: { companyId, type: { in: ['INCOME', 'EXPENSES'] } },
            include: { ledger: true }
        });

        let totalIncome = 0;
        let totalExpenses = 0;
        const voucherItems = [];

        for (const group of nominalGroups) {
            for (const ledger of group.ledger) {
                const bal = ledger.currentBalance || 0;
                if (Math.abs(bal) > 0.001) {
                    if (group.type === 'INCOME') {
                        totalIncome += bal;
                        voucherItems.push({
                            ledgerId: ledger.id,
                            ledgerName: ledger.name,
                            debit: Math.abs(bal),
                            credit: 0,
                            amount: Math.abs(bal),
                            narration: `Closing ${ledger.name} to Retained Earnings for FY${fiscalYear}`
                        });
                    } else {
                        totalExpenses += bal;
                        voucherItems.push({
                            ledgerId: ledger.id,
                            ledgerName: ledger.name,
                            debit: 0,
                            credit: Math.abs(bal),
                            amount: Math.abs(bal),
                            narration: `Closing ${ledger.name} to Retained Earnings for FY${fiscalYear}`
                        });
                    }

                    await prisma.ledger.update({
                        where: { id: ledger.id },
                        data: { currentBalance: 0, openingBalance: 0 }
                    });
                }
            }
        }

        const netProfitLoss = totalIncome - totalExpenses;

        if (netProfitLoss >= 0) {
            voucherItems.push({
                ledgerId: retainedEarnings.id,
                ledgerName: retainedEarnings.name,
                debit: 0,
                credit: Math.abs(netProfitLoss),
                amount: Math.abs(netProfitLoss),
                narration: `Net Profit transferred to Retained Earnings for FY${fiscalYear}`
            });
        } else {
            voucherItems.push({
                ledgerId: retainedEarnings.id,
                ledgerName: retainedEarnings.name,
                debit: Math.abs(netProfitLoss),
                credit: 0,
                amount: Math.abs(netProfitLoss),
                narration: `Net Loss transferred to Retained Earnings for FY${fiscalYear}`
            });
        }

        const voucherNumber = `YE-CLOSE-${fiscalYear}`;

        const voucher = await prisma.voucher.create({
            data: {
                voucherNumber,
                voucherType: 'JOURNAL',
                date: new Date(`${fiscalYear}-12-31T23:59:59.000Z`),
                totalAmount: Math.max(totalIncome, totalExpenses, Math.abs(netProfitLoss)),
                notes: `Fiscal Year ${fiscalYear} Closing Entry. Net ${netProfitLoss >= 0 ? 'Profit' : 'Loss'}: ${netProfitLoss.toFixed(2)} transferred to Retained Earnings.`,
                companyId,
                voucheritem: {
                    create: voucherItems
                }
            }
        });

        await prisma.ledger.update({
            where: { id: retainedEarnings.id },
            data: { currentBalance: { increment: netProfitLoss } }
        });

        const bsGroups = await prisma.accountgroup.findMany({
            where: { companyId, type: { in: ['ASSETS', 'LIABILITIES', 'EQUITY'] } },
            include: { ledger: true }
        });

        for (const grp of bsGroups) {
            for (const led of grp.ledger) {
                await prisma.ledger.update({
                    where: { id: led.id },
                    data: { openingBalance: led.currentBalance }
                });
            }
        }

        await prisma.$executeRawUnsafe(`
            INSERT INTO fiscal_year_close_log (fiscalYear, closeDate, closedByUserId, retainedEarningsLedgerId, netProfitLossAmount, closingVoucherId, companyId, status, details)
            VALUES (?, NOW(), ?, ?, ?, ?, ?, 'LOCKED', ?)
        `, fiscalYear, userId, retainedEarnings.id, netProfitLoss, voucher.id, companyId, JSON.stringify({ totalIncome, totalExpenses, netProfitLoss, voucherNumber }));

        return res.status(200).json({
            success: true,
            message: `Fiscal Year ${fiscalYear} successfully closed and rolled over into ${fiscalYear + 1}!`,
            data: {
                fiscalYear,
                nextFiscalYear: fiscalYear + 1,
                closingVoucherNumber: voucherNumber,
                netProfitLoss: parseFloat(netProfitLoss.toFixed(2)),
                retainedEarningsLedger: retainedEarnings.name
            }
        });
    } catch (error) {
        console.error('Execute Fiscal Year Rollover Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// ==========================================
// 3. FIXED ASSET REGISTER & DEPRECIATION
// ==========================================

const getFixedAssets = async (req, res) => {
    try {
        await ensureTablesExist();
        const companyId = req.user?.companyId || parseInt(req.query.companyId);
        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID required' });

        const assets = await prisma.$queryRawUnsafe(`
            SELECT * FROM fixed_asset WHERE companyId = ? ORDER BY createdAt DESC
        `, companyId);

        const ledgers = await prisma.ledger.findMany({ where: { companyId } });
        const ledgerMap = new Map(ledgers.map(l => [l.id, l.name]));

        const enrichedAssets = assets.map(asset => ({
            ...asset,
            assetLedgerName: ledgerMap.get(asset.assetLedgerId) || 'Asset Account',
            accumulatedDepLedgerName: ledgerMap.get(asset.accumulatedDepLedgerId) || 'Accumulated Depreciation',
            depExpenseLedgerName: ledgerMap.get(asset.depExpenseLedgerId) || 'Depreciation Expense'
        }));

        return res.status(200).json({ success: true, data: enrichedAssets });
    } catch (error) {
        console.error('Get Fixed Assets Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const createFixedAsset = async (req, res) => {
    try {
        await ensureTablesExist();
        const companyId = req.user?.companyId || parseInt(req.body.companyId);
        const {
            assetName,
            assetNumber = `FA-${Date.now().toString().slice(-4)}`,
            purchaseDate = new Date(),
            purchaseCost,
            salvageValue = 0,
            usefulLifeYears = 5,
            depreciationMethod = 'STRAIGHT_LINE',
            assetLedgerId,
            accumulatedDepLedgerId,
            depExpenseLedgerId,
            notes = ''
        } = req.body;

        if (!companyId || !assetName || !purchaseCost) {
            return res.status(400).json({ success: false, message: 'Asset name and purchase cost are required' });
        }

        const cost = parseFloat(purchaseCost);
        const salvage = parseFloat(salvageValue) || 0;
        const usefulYears = parseFloat(usefulLifeYears) || 5;
        const currentBookValue = cost;

        const assetLedger = assetLedgerId ? { id: parseInt(assetLedgerId) } : await getOrCreateSystemLedger(companyId, `${assetName} Account`, 'ASSETS', 'Fixed Assets');
        const accDepLedger = accumulatedDepLedgerId ? { id: parseInt(accumulatedDepLedgerId) } : await getOrCreateSystemLedger(companyId, `Accumulated Dep. - ${assetName}`, 'ASSETS', 'Fixed Assets');
        const depExpLedger = depExpenseLedgerId ? { id: parseInt(depExpenseLedgerId) } : await getOrCreateSystemLedger(companyId, 'Depreciation Expense', 'EXPENSES', 'Depreciation');

        await prisma.$executeRawUnsafe(`
            INSERT INTO fixed_asset (
                assetName, assetNumber, purchaseDate, purchaseCost, salvageValue, 
                usefulLifeYears, depreciationMethod, assetLedgerId, accumulatedDepLedgerId, 
                depExpenseLedgerId, accumulatedDepreciation, currentBookValue, status, companyId, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'ACTIVE', ?, ?)
        `, assetName, assetNumber, new Date(purchaseDate), cost, salvage, usefulYears, depreciationMethod, assetLedger.id, accDepLedger.id, depExpLedger.id, currentBookValue, companyId, notes);

        return res.status(201).json({
            success: true,
            message: `Fixed asset "${assetName}" registered successfully!`
        });
    } catch (error) {
        console.error('Create Fixed Asset Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const runDepreciation = async (req, res) => {
    try {
        await ensureTablesExist();
        const companyId = req.user?.companyId || parseInt(req.body.companyId);
        const { assetId, periodMonths = 1, depreciationDate = new Date() } = req.body;

        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID required' });

        let query = 'SELECT * FROM fixed_asset WHERE companyId = ? AND status = "ACTIVE"';
        const params = [companyId];
        if (assetId) {
            query += ' AND id = ?';
            params.push(parseInt(assetId));
        }

        const assets = await prisma.$queryRawUnsafe(query, ...params);
        if (!assets.length) {
            return res.status(400).json({ success: false, message: 'No active assets eligible for depreciation' });
        }

        const depreciationResults = [];

        for (const asset of assets) {
            const cost = asset.purchaseCost;
            const salvage = asset.salvageValue;
            const usefulYears = asset.usefulLifeYears;
            const currentBookValue = asset.currentBookValue;
            const maxDepreciable = cost - salvage;

            let monthlyDepreciation = 0;
            if (asset.depreciationMethod === 'STRAIGHT_LINE') {
                monthlyDepreciation = (maxDepreciable / (usefulYears * 12)) * periodMonths;
            } else {
                const annualRate = (1 / usefulYears) * 1.5;
                monthlyDepreciation = (currentBookValue * (annualRate / 12)) * periodMonths;
            }

            const remainingDepreciable = Math.max(0, currentBookValue - salvage);
            const actualDepreciation = Math.min(monthlyDepreciation, remainingDepreciable);

            if (actualDepreciation <= 0.01) {
                await prisma.$executeRawUnsafe(`UPDATE fixed_asset SET status = 'FULLY_DEPRECIATED' WHERE id = ?`, asset.id);
                continue;
            }

            const newAccDep = asset.accumulatedDepreciation + actualDepreciation;
            const newBookValue = cost - newAccDep;
            const newStatus = newBookValue <= salvage ? 'FULLY_DEPRECIATED' : 'ACTIVE';

            const voucherNumber = `DEP-${asset.id}-${Date.now().toString().slice(-4)}`;
            
            await prisma.voucher.create({
                data: {
                    voucherNumber,
                    voucherType: 'JOURNAL',
                    date: new Date(depreciationDate),
                    totalAmount: parseFloat(actualDepreciation.toFixed(2)),
                    notes: `Automated Depreciation for Asset: ${asset.assetName} (${asset.assetNumber})`,
                    companyId,
                    voucheritem: {
                        create: [
                            {
                                ledgerId: asset.depExpenseLedgerId,
                                debit: parseFloat(actualDepreciation.toFixed(2)),
                                credit: 0,
                                amount: parseFloat(actualDepreciation.toFixed(2)),
                                narration: `Depreciation Expense on ${asset.assetName}`
                            },
                            {
                                ledgerId: asset.accumulatedDepLedgerId,
                                debit: 0,
                                credit: parseFloat(actualDepreciation.toFixed(2)),
                                amount: parseFloat(actualDepreciation.toFixed(2)),
                                narration: `Accumulated Depreciation for ${asset.assetName}`
                            }
                        ]
                    }
                }
            });

            await prisma.transaction.create({
                data: {
                    date: new Date(depreciationDate),
                    debitLedgerId: asset.depExpenseLedgerId,
                    creditLedgerId: asset.accumulatedDepLedgerId,
                    amount: parseFloat(actualDepreciation.toFixed(2)),
                    voucherType: 'JOURNAL',
                    voucherNumber: voucherNumber,
                    narration: `Automated Depreciation for Asset: ${asset.assetName} (${asset.assetNumber})`,
                    companyId
                }
            });

            await prisma.$executeRawUnsafe(`
                UPDATE fixed_asset 
                SET accumulatedDepreciation = ?, currentBookValue = ?, lastDepreciationDate = ?, status = ?
                WHERE id = ?
            `, newAccDep, newBookValue, new Date(depreciationDate), newStatus, asset.id);

            depreciationResults.push({
                assetId: asset.id,
                assetName: asset.assetName,
                depreciationAmount: parseFloat(actualDepreciation.toFixed(2)),
                newBookValue: parseFloat(newBookValue.toFixed(2)),
                status: newStatus,
                voucherNumber
            });
        }

        return res.status(200).json({
            success: true,
            message: `Depreciation run complete for ${depreciationResults.length} asset(s)!`,
            data: depreciationResults
        });
    } catch (error) {
        console.error('Run Depreciation Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const deleteFixedAsset = async (req, res) => {
    try {
        await ensureTablesExist();
        const companyId = req.user?.companyId || parseInt(req.query.companyId);
        const assetId = parseInt(req.params.id);

        if (!companyId || !assetId) return res.status(400).json({ success: false, message: 'Invalid ID' });

        await prisma.$executeRawUnsafe(`DELETE FROM fixed_asset WHERE id = ? AND companyId = ?`, assetId, companyId);
        return res.status(200).json({ success: true, message: 'Asset deleted successfully' });
    } catch (error) {
        console.error('Delete Fixed Asset Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// ==========================================
// 4. FINANCIAL BUDGETING & CASH FLOW FORECAST
// ==========================================

const getBudgets = async (req, res) => {
    try {
        await ensureTablesExist();
        const companyId = req.user?.companyId || parseInt(req.query.companyId);
        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID required' });

        const budgets = await prisma.$queryRawUnsafe(`
            SELECT * FROM budget WHERE companyId = ? ORDER BY fiscalYear DESC
        `, companyId);

        return res.status(200).json({ success: true, data: budgets });
    } catch (error) {
        console.error('Get Budgets Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const createBudget = async (req, res) => {
    try {
        await ensureTablesExist();
        const companyId = req.user?.companyId || parseInt(req.body.companyId);
        const {
            name,
            fiscalYear = new Date().getFullYear(),
            periodType = 'MONTHLY',
            startDate = `${fiscalYear}-01-01`,
            endDate = `${fiscalYear}-12-31`,
            items = [],
            notes = ''
        } = req.body;

        if (!companyId || !name) {
            return res.status(400).json({ success: false, message: 'Budget name is required' });
        }

        const totalBudgetAmount = items.reduce((sum, it) => sum + (parseFloat(it.allocatedAmount) || 0), 0);

        await prisma.$executeRawUnsafe(`
            INSERT INTO budget (name, fiscalYear, periodType, startDate, endDate, totalBudgetAmount, companyId, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, name, parseInt(fiscalYear), periodType, new Date(startDate), new Date(endDate), totalBudgetAmount, companyId, notes);

        const newBudgets = await prisma.$queryRawUnsafe(`
            SELECT id FROM budget WHERE companyId = ? ORDER BY id DESC LIMIT 1
        `, companyId);
        const budgetId = newBudgets[0]?.id;

        if (budgetId && Array.isArray(items) && items.length > 0) {
            for (const item of items) {
                if (item.ledgerId) {
                    await prisma.$executeRawUnsafe(`
                        INSERT INTO budget_item (budgetId, ledgerId, allocatedAmount, monthIndex, notes)
                        VALUES (?, ?, ?, ?, ?)
                    `, budgetId, parseInt(item.ledgerId), parseFloat(item.allocatedAmount) || 0, parseInt(item.monthIndex) || 1, item.notes || '');
                }
            }
        }

        return res.status(201).json({
            success: true,
            message: `Budget "${name}" created successfully!`,
            data: { id: budgetId, totalBudgetAmount }
        });
    } catch (error) {
        console.error('Create Budget Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const getBudgetVarianceReport = async (req, res) => {
    try {
        await ensureTablesExist();
        const companyId = req.user?.companyId || parseInt(req.query.companyId);
        const budgetId = parseInt(req.params.id);

        if (!companyId || !budgetId) return res.status(400).json({ success: false, message: 'Invalid Budget ID' });

        const budgetRows = await prisma.$queryRawUnsafe(`SELECT * FROM budget WHERE id = ? AND companyId = ?`, budgetId, companyId);
        const budget = budgetRows[0];
        if (!budget) return res.status(404).json({ success: false, message: 'Budget not found' });

        const budgetItems = await prisma.$queryRawUnsafe(`SELECT * FROM budget_item WHERE budgetId = ?`, budgetId);
        const ledgers = await prisma.ledger.findMany({ where: { companyId }, include: { accountgroup: true } });
        const ledgerMap = new Map(ledgers.map(l => [l.id, l]));

        // Calculate actual movements within the budget date range using transactions
        const ledgerIds = budgetItems.map(b => b.ledgerId);
        const periodActualMap = new Map();

        try {
            const startDate = budget.startDate ? new Date(budget.startDate) : new Date(budget.fiscalYear, 0, 1);
            const endDate = budget.endDate ? new Date(budget.endDate) : new Date(budget.fiscalYear, 11, 31, 23, 59, 59);

            // 1. Query debit transactions (expense spending)
            const debitTx = await prisma.transaction.findMany({
                where: {
                    companyId,
                    debitLedgerId: { in: ledgerIds },
                    date: { gte: startDate, lte: endDate }
                },
                select: { debitLedgerId: true, amount: true }
            });

            debitTx.forEach(t => {
                const cur = periodActualMap.get(t.debitLedgerId) || 0;
                periodActualMap.set(t.debitLedgerId, cur + (parseFloat(t.amount) || 0));
            });

            // 2. Query credit transactions (expense refunds / reversals)
            const creditTx = await prisma.transaction.findMany({
                where: {
                    companyId,
                    creditLedgerId: { in: ledgerIds },
                    date: { gte: startDate, lte: endDate }
                },
                select: { creditLedgerId: true, amount: true }
            });

            creditTx.forEach(t => {
                const cur = periodActualMap.get(t.creditLedgerId) || 0;
                periodActualMap.set(t.creditLedgerId, cur - (parseFloat(t.amount) || 0));
            });

            // 3. Check direct expenseentry records if any exist outside standard transactions
            try {
                const expenseEntries = await prisma.expenseentry.findMany({
                    where: {
                        companyId,
                        ledgerId: { in: ledgerIds },
                        date: { gte: startDate, lte: endDate }
                    },
                    select: { ledgerId: true, amount: true }
                });

                expenseEntries.forEach(ee => {
                    // Only add if not already captured in debit transactions
                    if (!periodActualMap.has(ee.ledgerId)) {
                        const cur = periodActualMap.get(ee.ledgerId) || 0;
                        periodActualMap.set(ee.ledgerId, cur + (parseFloat(ee.amount) || 0));
                    }
                });
            } catch (eeErr) {
                // expenseentry table optional
            }

        } catch (e) {
            console.warn('Could not query transaction period actuals:', e.message);
        }

        const comparison = budgetItems.map(item => {
            const ledger = ledgerMap.get(item.ledgerId);
            const budgeted = item.allocatedAmount;
            const periodActual = periodActualMap.get(item.ledgerId);
            const actual = (periodActual !== undefined && periodActual !== null)
                ? Math.abs(periodActual)
                : Math.abs(ledger?.currentBalance || 0);
            const variance = budgeted - actual;
            const variancePercent = budgeted > 0 ? ((variance / budgeted) * 100).toFixed(1) : '0';
            const status = variance >= 0 ? 'UNDER_BUDGET' : 'OVER_BUDGET';

            return {
                ledgerId: item.ledgerId,
                ledgerName: ledger?.name || 'Account',
                groupName: ledger?.accountgroup?.name || '',
                groupType: ledger?.accountgroup?.type || 'EXPENSES',
                monthIndex: item.monthIndex,
                budgetedAmount: budgeted,
                actualAmount: actual,
                variance: parseFloat(variance.toFixed(2)),
                variancePercent: parseFloat(variancePercent),
                status
            };
        });

        const totalBudgeted = comparison.reduce((s, c) => s + c.budgetedAmount, 0);
        const totalActual = comparison.reduce((s, c) => s + c.actualAmount, 0);
        const netVariance = totalBudgeted - totalActual;

        return res.status(200).json({
            success: true,
            data: {
                budget,
                totalBudgeted: parseFloat(totalBudgeted.toFixed(2)),
                totalActual: parseFloat(totalActual.toFixed(2)),
                netVariance: parseFloat(netVariance.toFixed(2)),
                comparison
            }
        });
    } catch (error) {
        console.error('Budget Variance Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const getCashFlowForecast = async (req, res) => {
    try {
        await ensureTablesExist();
        const companyId = req.user?.companyId || parseInt(req.query.companyId);
        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID required' });

        const bankAccounts = await prisma.bankaccount.findMany({ where: { companyId } });
        const cashLedgers = await prisma.ledger.findMany({
            where: {
                companyId,
                name: { in: ['Cash', 'Cash Account', 'Petty Cash', 'Main Cash'] }
            }
        });

        const currentBankTotal = bankAccounts.reduce((sum, b) => sum + (b.currentBalance || 0), 0);
        const currentCashTotal = cashLedgers.reduce((sum, c) => sum + (c.currentBalance || 0), 0);
        const openingLiquidCash = currentBankTotal + currentCashTotal;

        const openInvoices = await prisma.invoice.findMany({
            where: {
                companyId,
                status: { notIn: ['PAID', 'CANCELLED'] },
                balanceAmount: { gt: 0 }
            },
            include: { customer: true }
        });

        const openBills = await prisma.purchasebill.findMany({
            where: {
                companyId,
                status: { notIn: ['PAID', 'CANCELLED'] },
                balanceAmount: { gt: 0 }
            },
            include: { vendor: true }
        });

        const now = new Date();
        const d30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        const d60 = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
        const d90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

        let inflow30 = 0, inflow60 = 0, inflow90 = 0, inflowOverdue = 0;
        let outflow30 = 0, outflow60 = 0, outflow90 = 0, outflowOverdue = 0;

        for (const inv of openInvoices) {
            const due = inv.dueDate ? new Date(inv.dueDate) : now;
            const amt = inv.balanceAmount;
            if (due < now) inflowOverdue += amt;
            else if (due <= d30) inflow30 += amt;
            else if (due <= d60) inflow60 += amt;
            else inflow90 += amt;
        }

        for (const bill of openBills) {
            const due = bill.dueDate ? new Date(bill.dueDate) : now;
            const amt = bill.balanceAmount;
            if (due < now) outflowOverdue += amt;
            else if (due <= d30) outflow30 += amt;
            else if (due <= d60) outflow60 += amt;
            else outflow90 += amt;
        }

        const totalProjectedInflows = inflowOverdue + inflow30 + inflow60 + inflow90;
        const totalProjectedOutflows = outflowOverdue + outflow30 + outflow60 + outflow90;
        const netProjectedCash30 = openingLiquidCash + (inflowOverdue + inflow30) - (outflowOverdue + outflow30);
        const netProjectedCash60 = netProjectedCash30 + inflow60 - outflow60;
        const netProjectedCash90 = netProjectedCash60 + inflow90 - outflow90;

        return res.status(200).json({
            success: true,
            data: {
                openingLiquidCash: parseFloat(openingLiquidCash.toFixed(2)),
                currentBankTotal: parseFloat(currentBankTotal.toFixed(2)),
                currentCashTotal: parseFloat(currentCashTotal.toFixed(2)),
                inflows: {
                    overdue: parseFloat(inflowOverdue.toFixed(2)),
                    next30Days: parseFloat(inflow30.toFixed(2)),
                    next60Days: parseFloat(inflow60.toFixed(2)),
                    next90Days: parseFloat(inflow90.toFixed(2)),
                    total: parseFloat(totalProjectedInflows.toFixed(2))
                },
                outflows: {
                    overdue: parseFloat(outflowOverdue.toFixed(2)),
                    next30Days: parseFloat(outflow30.toFixed(2)),
                    next60Days: parseFloat(outflow60.toFixed(2)),
                    next90Days: parseFloat(outflow90.toFixed(2)),
                    total: parseFloat(totalProjectedOutflows.toFixed(2))
                },
                projectedBalances: {
                    current: parseFloat(openingLiquidCash.toFixed(2)),
                    after30Days: parseFloat(netProjectedCash30.toFixed(2)),
                    after60Days: parseFloat(netProjectedCash60.toFixed(2)),
                    after90Days: parseFloat(netProjectedCash90.toFixed(2))
                }
            }
        });
    } catch (error) {
        console.error('Cash Flow Forecast Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// ==========================================
// 5. RECURRING TRANSACTIONS ENGINE
// ==========================================

const getRecurringTemplates = async (req, res) => {
    try {
        await ensureTablesExist();
        const companyId = req.user?.companyId || parseInt(req.query.companyId);
        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID required' });

        const templates = await prisma.$queryRawUnsafe(`
            SELECT * FROM recurring_template WHERE companyId = ? ORDER BY nextRunDate ASC
        `, companyId);

        const parsed = templates.map(t => {
            let data = {};
            try { data = JSON.parse(t.templateData); } catch (e) {}
            return { ...t, templateData: data };
        });

        return res.status(200).json({ success: true, data: parsed });
    } catch (error) {
        console.error('Get Recurring Templates Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const createRecurringTemplate = async (req, res) => {
    try {
        await ensureTablesExist();
        const companyId = req.user?.companyId || parseInt(req.body.companyId);
        const {
            templateName,
            transactionType = 'INVOICE',
            frequency = 'MONTHLY',
            startDate = new Date(),
            endDate = null,
            totalAmount = 0,
            templateData = {}
        } = req.body;

        if (!companyId || !templateName) {
            return res.status(400).json({ success: false, message: 'Template name is required' });
        }

        const nextRunDate = new Date(startDate);

        await prisma.$executeRawUnsafe(`
            INSERT INTO recurring_template (templateName, transactionType, frequency, startDate, endDate, nextRunDate, totalAmount, status, templateData, companyId, executionCount)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, 0)
        `, templateName, transactionType, frequency, new Date(startDate), endDate ? new Date(endDate) : null, nextRunDate, parseFloat(totalAmount) || 0, JSON.stringify(templateData), companyId);

        return res.status(201).json({
            success: true,
            message: `Recurring template "${templateName}" created successfully!`
        });
    } catch (error) {
        console.error('Create Recurring Template Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const executeSingleTemplate = async (t, companyId) => {
    const now = new Date();
    let data = {};
    try { data = typeof t.templateData === 'string' ? JSON.parse(t.templateData) : (t.templateData || {}); } catch (e) {}

    let generated = null;

    if (t.transactionType === 'INVOICE') {
        const invoiceNumber = `REC-INV-${Date.now().toString().slice(-5)}`;
        const customerId = data.customerId ? parseInt(data.customerId) : null;

        if (customerId) {
            await prisma.invoice.create({
                data: {
                    invoiceNumber,
                    date: now,
                    dueDate: new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000),
                    customerId,
                    subtotal: t.totalAmount,
                    taxAmount: 0,
                    totalAmount: t.totalAmount,
                    balanceAmount: t.totalAmount,
                    currency: data.currency || 'EUR',
                    notes: `Auto-generated from recurring template: ${t.templateName}`,
                    status: 'UNPAID',
                    companyId
                }
            });
            generated = { templateId: t.id, type: 'INVOICE', refNumber: invoiceNumber, amount: t.totalAmount };
        }
    } else if (t.transactionType === 'PURCHASE_BILL') {
        const billNumber = `REC-BILL-${Date.now().toString().slice(-5)}`;
        const vendorId = data.vendorId ? parseInt(data.vendorId) : null;

        if (vendorId) {
            await prisma.purchasebill.create({
                data: {
                    billNumber,
                    date: now,
                    dueDate: new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000),
                    vendorId,
                    subtotal: t.totalAmount,
                    taxAmount: 0,
                    totalAmount: t.totalAmount,
                    balanceAmount: t.totalAmount,
                    currency: data.currency || 'EUR',
                    notes: `Auto-generated from recurring template: ${t.templateName}`,
                    status: 'UNPAID',
                    companyId
                }
            });
            generated = { templateId: t.id, type: 'PURCHASE_BILL', refNumber: billNumber, amount: t.totalAmount };
        }
    } else if (t.transactionType === 'JOURNAL') {
        const voucherNumber = `REC-JV-${Date.now().toString().slice(-5)}`;
        const debitLedgerId = data.debitLedgerId ? parseInt(data.debitLedgerId) : null;
        const creditLedgerId = data.creditLedgerId ? parseInt(data.creditLedgerId) : null;

        if (debitLedgerId && creditLedgerId) {
            const debitLedger = await prisma.ledger.findUnique({ where: { id: debitLedgerId } });
            const creditLedger = await prisma.ledger.findUnique({ where: { id: creditLedgerId } });

            await prisma.voucher.create({
                data: {
                    voucherNumber,
                    voucherType: 'JOURNAL',
                    date: now,
                    totalAmount: t.totalAmount,
                    notes: data.narration || `Auto-generated from recurring template: ${t.templateName}`,
                    companyId,
                    voucheritem: {
                        create: [
                            {
                                ledgerId: debitLedgerId,
                                ledgerName: debitLedger?.name || 'Debit Account',
                                debit: t.totalAmount,
                                credit: 0,
                                amount: t.totalAmount,
                                narration: data.narration || `Recurring Journal: ${t.templateName}`
                            },
                            {
                                ledgerId: creditLedgerId,
                                ledgerName: creditLedger?.name || 'Credit Account',
                                debit: 0,
                                credit: t.totalAmount,
                                amount: t.totalAmount,
                                narration: data.narration || `Recurring Journal: ${t.templateName}`
                            }
                        ]
                    }
                }
            });

            await prisma.transaction.create({
                data: {
                    date: now,
                    debitLedgerId,
                    creditLedgerId,
                    amount: t.totalAmount,
                    voucherType: 'JOURNAL',
                    voucherNumber,
                    narration: data.narration || `Recurring Journal: ${t.templateName}`,
                    companyId
                }
            });

            await prisma.ledger.update({
                where: { id: debitLedgerId },
                data: { currentBalance: { increment: t.totalAmount } }
            });
            await prisma.ledger.update({
                where: { id: creditLedgerId },
                data: { currentBalance: { decrement: t.totalAmount } }
            });

            generated = { templateId: t.id, type: 'JOURNAL', refNumber: voucherNumber, amount: t.totalAmount };
        }
    }

    let nextDate = new Date(t.nextRunDate);
    if (t.frequency === 'WEEKLY') nextDate.setDate(nextDate.getDate() + 7);
    else if (t.frequency === 'BIWEEKLY') nextDate.setDate(nextDate.getDate() + 14);
    else if (t.frequency === 'MONTHLY') nextDate.setMonth(nextDate.getMonth() + 1);
    else if (t.frequency === 'QUARTERLY') nextDate.setMonth(nextDate.getMonth() + 3);
    else if (t.frequency === 'ANNUALLY') nextDate.setFullYear(nextDate.getFullYear() + 1);

    let newStatus = t.status;
    if (t.endDate && nextDate > new Date(t.endDate)) {
        newStatus = 'COMPLETED';
    }

    await prisma.$executeRawUnsafe(`
        UPDATE recurring_template 
        SET lastRunDate = NOW(), nextRunDate = ?, executionCount = executionCount + 1, status = ?
        WHERE id = ?
    `, nextDate, newStatus, t.id);

    return generated;
};

const runPendingRecurringTransactions = async (req, res) => {
    try {
        await ensureTablesExist();
        const companyId = req.user?.companyId || parseInt(req.body.companyId);
        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID required' });

        const templates = await prisma.$queryRawUnsafe(`
            SELECT * FROM recurring_template 
            WHERE companyId = ? AND status = 'ACTIVE' AND nextRunDate <= NOW()
        `, companyId);

        const generated = [];
        for (const t of templates) {
            const resItem = await executeSingleTemplate(t, companyId);
            if (resItem) generated.push(resItem);
        }

        return res.status(200).json({
            success: true,
            message: `Executed recurring run: ${generated.length} transaction(s) generated!`,
            data: generated
        });
    } catch (error) {
        console.error('Run Pending Recurring Transactions Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const runSingleRecurringTransaction = async (req, res) => {
    try {
        await ensureTablesExist();
        const companyId = req.user?.companyId || parseInt(req.body.companyId);
        const templateId = parseInt(req.params.id);

        if (!companyId || !templateId) return res.status(400).json({ success: false, message: 'Invalid ID' });

        const templates = await prisma.$queryRawUnsafe(`
            SELECT * FROM recurring_template WHERE id = ? AND companyId = ?
        `, templateId, companyId);

        if (!templates.length) return res.status(404).json({ success: false, message: 'Recurring template not found' });

        const generated = await executeSingleTemplate(templates[0], companyId);
        return res.status(200).json({
            success: true,
            message: `Successfully executed "${templates[0].templateName}"! Generated ${generated?.refNumber || 'transaction'}.`,
            data: generated
        });
    } catch (error) {
        console.error('Run Single Recurring Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const toggleRecurringTemplateStatus = async (req, res) => {
    try {
        await ensureTablesExist();
        const companyId = req.user?.companyId || parseInt(req.body.companyId);
        const templateId = parseInt(req.params.id);

        if (!companyId || !templateId) return res.status(400).json({ success: false, message: 'Invalid ID' });

        const templates = await prisma.$queryRawUnsafe(`
            SELECT * FROM recurring_template WHERE id = ? AND companyId = ?
        `, templateId, companyId);

        if (!templates.length) return res.status(404).json({ success: false, message: 'Recurring template not found' });

        const currentStatus = templates[0].status;
        const newStatus = currentStatus === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';

        await prisma.$executeRawUnsafe(`
            UPDATE recurring_template SET status = ? WHERE id = ?
        `, newStatus, templateId);

        return res.status(200).json({
            success: true,
            message: `Recurring template is now ${newStatus}`,
            data: { id: templateId, status: newStatus }
        });
    } catch (error) {
        console.error('Toggle Recurring Status Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const deleteRecurringTemplate = async (req, res) => {
    try {
        await ensureTablesExist();
        const companyId = req.user?.companyId || parseInt(req.query.companyId);
        const templateId = parseInt(req.params.id);

        if (!companyId || !templateId) return res.status(400).json({ success: false, message: 'Invalid ID' });

        await prisma.$executeRawUnsafe(`DELETE FROM recurring_template WHERE id = ? AND companyId = ?`, templateId, companyId);
        return res.status(200).json({ success: true, message: 'Recurring template deleted successfully' });
    } catch (error) {
        console.error('Delete Recurring Template Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// ==========================================
// 6. ASSET DEPRECIATION SCHEDULE GENERATOR
// ==========================================

const getAssetDepreciationSchedule = async (req, res) => {
    try {
        await ensureTablesExist();
        const companyId = req.user?.companyId || parseInt(req.query.companyId);
        const assetId = parseInt(req.params.id);

        if (!companyId || !assetId) return res.status(400).json({ success: false, message: 'Invalid Asset ID' });

        const assets = await prisma.$queryRawUnsafe(`SELECT * FROM fixed_asset WHERE id = ? AND companyId = ?`, assetId, companyId);
        const asset = assets[0];
        if (!asset) return res.status(404).json({ success: false, message: 'Fixed Asset not found' });

        const cost = asset.purchaseCost;
        const salvage = asset.salvageValue || 0;
        const usefulYears = asset.usefulLifeYears || 5;
        const method = asset.depreciationMethod || 'STRAIGHT_LINE';
        const purchaseDate = new Date(asset.purchaseDate);

        const schedule = [];
        let currentBookValue = cost;
        let accumulatedDep = 0;
        const totalYears = Math.ceil(usefulYears);

        for (let year = 1; year <= totalYears; year++) {
            const periodDate = new Date(purchaseDate);
            periodDate.setFullYear(purchaseDate.getFullYear() + year);

            let depAmount = 0;
            if (method === 'STRAIGHT_LINE') {
                const annualDep = (cost - salvage) / usefulYears;
                const remainingDep = Math.max(0, currentBookValue - salvage);
                depAmount = Math.min(annualDep, remainingDep);
            } else {
                const rate = (1 / usefulYears) * 1.5;
                const calculatedDep = currentBookValue * rate;
                const remainingDep = Math.max(0, currentBookValue - salvage);
                depAmount = Math.min(calculatedDep, remainingDep);
            }

            accumulatedDep += depAmount;
            const endingBookValue = Math.max(salvage, cost - accumulatedDep);

            schedule.push({
                periodIndex: year,
                periodYear: purchaseDate.getFullYear() + year - 1,
                date: periodDate.toISOString().split('T')[0],
                beginningBookValue: parseFloat(currentBookValue.toFixed(2)),
                depreciationAmount: parseFloat(depAmount.toFixed(2)),
                accumulatedDepreciation: parseFloat(accumulatedDep.toFixed(2)),
                endingBookValue: parseFloat(endingBookValue.toFixed(2))
            });

            currentBookValue = endingBookValue;
            if (currentBookValue <= salvage) break;
        }

        return res.status(200).json({
            success: true,
            data: {
                asset,
                schedule
            }
        });
    } catch (error) {
        console.error('Depreciation Schedule Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    // 1. Currency Revaluation
    getCurrencyRevaluationPreview,
    postCurrencyRevaluationJournal,

    // 2. Fiscal Year Rollover
    getFiscalYearRolloverPreview,
    executeFiscalYearRollover,

    // 3. Fixed Assets & Depreciation
    getFixedAssets,
    createFixedAsset,
    runDepreciation,
    deleteFixedAsset,
    getAssetDepreciationSchedule,

    // 4. Budgets & Forecasts
    getBudgets,
    createBudget,
    getBudgetVarianceReport,
    getCashFlowForecast,

    // 5. Recurring Transactions
    getRecurringTemplates,
    createRecurringTemplate,
    runPendingRecurringTransactions,
    runSingleRecurringTransaction,
    toggleRecurringTemplateStatus,
    deleteRecurringTemplate
};
