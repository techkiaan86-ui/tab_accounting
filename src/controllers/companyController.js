const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const chartOfAccountsService = require('../services/chartOfAccountsService');
const numberingService = require('../services/numberingService');
const { isCloudinaryConfigured, uploadToCloudinaryOrBase64 } = require('../utils/cloudinaryConfig');

const createCompany = async (req, res) => {
    try {
        const { name, email, phone, address, startDate, endDate, planId, planType, password, currency } = req.body;

        let logoUrl = null;
        if (req.file) {
            logoUrl = await uploadToCloudinaryOrBase64(req.file, 'company_logos');
        }

        // Check if company or user already exists
        const existingCompany = await prisma.company.findUnique({ where: { email } });
        if (existingCompany) return res.status(400).json({ error: 'Company with this email already exists' });

        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) return res.status(400).json({ error: 'User with this email already exists' });

        // Hash password for the company admin
        if (!password) {
            return res.status(400).json({ error: 'Password is required for creating a company account' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create Company and Admin User in a transaction
        const result = await prisma.$transaction(async (tx) => {
            const company = await tx.company.create({
                data: {
                    name,
                    email,
                    phone,
                    address,
                    startDate: startDate ? new Date(startDate) : null,
                    endDate: endDate ? new Date(endDate) : null,
                    planId: planId ? parseInt(planId) : null,
                    planType,
                    logo: logoUrl,
                    currency: currency || 'USD',
                    originalCurrency: currency || 'USD'
                }
            });

            // Derive permissions from Plan Modules
            let modulesArray = [];
            try {
                if (planId) {
                    const plan = await tx.plan.findUnique({ where: { id: parseInt(planId) } });
                    if (plan && plan.modules) {
                        modulesArray = JSON.parse(plan.modules);
                    }
                }
            } catch (e) {
                console.error("Module parse error:", e);
            }

            const enabledModules = modulesArray.filter(m => m.enabled).map(m => (m.name || m.module_name || "").toLowerCase());

            // Base permissions (always included for company admin - requested default menus)
            let defaultPermissions = [
                "show dashboard",
                "manage voucher", "create voucher", "edit voucher", "delete voucher",
                "manage reports", "view reports",
                "manage user", "create user", "edit user", "delete user",
                "manage role", "create role", "edit role", "delete role",
                "manage settings", "edit settings", "view settings"
            ];

            // Module specific mapping (gated menus)
            const moduleMapping = {
                'account': ["manage accounts", "create accounts", "edit accounts", "delete accounts", "view accounts"],
                'accounts': ["manage accounts", "create accounts", "edit accounts", "delete accounts", "view accounts"],
                'inventory': ["manage inventory", "create inventory", "edit inventory", "delete inventory", "view inventory"],
                'sales': ["manage sales", "create sales", "edit sales", "delete sales", "show sales", "send sales", "view sales"],
                'purchase': ["manage purchases", "create purchases", "edit purchases", "delete purchases", "view purchases"],
                'purchases': ["manage purchases", "create purchases", "edit purchases", "delete purchases", "view purchases"],
                'pos': ["manage pos", "create pos", "edit pos", "delete pos", "view pos"]
            };

            enabledModules.forEach(modName => {
                for (const key in moduleMapping) {
                    if (modName.includes(key)) {
                        defaultPermissions = [...new Set([...defaultPermissions, ...moduleMapping[key]])];
                    }
                }
            });

            const role = await tx.role.create({
                data: {
                    name: 'COMPANY',
                    companyId: company.id,
                    permissions: JSON.stringify(defaultPermissions)
                }
            });

            const user = await tx.user.create({
                data: {
                    name,
                    email,
                    password: hashedPassword,
                    role: 'COMPANY',
                    roleId: role.id,
                    companyId: company.id
                }
            });

            return { company, user };
        }, {
            timeout: 15000
        });

        // Initialize Chart of Accounts for the new company
        try {
            await chartOfAccountsService.initializeChartOfAccounts(result.company.id);
        } catch (coaError) {
            console.error('COA Initialization Error (Skipping):', coaError);
        }

        res.status(201).json(result.company);
    } catch (error) {
        console.error('Create Company Error:', error);
        res.status(500).json({
            error: error.message || 'Internal Server Error'
        });
    }
};

const getCompanies = async (req, res) => {
    try {
        const companies = await prisma.company.findMany({
            include: {
                user: true,
                plan: true
            }
        });
        const companiesWithStorage = companies.map(company => {
            if (company.inventoryConfig) {
                try {
                    const config = JSON.parse(company.inventoryConfig);
                    company.storageCapacity = config.storageCapacity;
                } catch (e) { }
            }
            return company;
        });
        res.json(companiesWithStorage);
    } catch (error) {
        console.error('Get Companies Error:', error);
        res.status(500).json({ error: error.message });
    }
};

const getCompanyById = async (req, res) => {
    try {
        const company = await prisma.company.findUnique({
            where: { id: parseInt(req.params.id) },
            include: {
                user: true,
                plan: true
            }
        });

        logToFile(`📡 getCompanyById ID: ${req.params.id} | company.name: ${company?.name} | company.invoiceLabels: ${company?.invoiceLabels}`);

        if (company && company.inventoryConfig) {
            try {
                const config = JSON.parse(company.inventoryConfig);
                company.storageCapacity = config.storageCapacity;
            } catch (e) { }
        }
        res.json(company);
    } catch (error) {
        logToFile(`❌ getCompanyById error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
};

const fs = require('fs');
const path = require('path');
const logFilePath = path.join(__dirname, '../../debug_logs.txt');

const logToFile = (message) => {
    try {
        const timestamp = new Date().toISOString();
        fs.appendFileSync(logFilePath, `[${timestamp}] ${message}\n`);
    } catch (e) {
        console.error('Failed to log to file:', e);
    }
};

const updateCompany = async (req, res) => {
    try {
        logToFile(`📥 Received company update request for ID: ${req.params.id}`);
        logToFile(`Request body fields: ${Object.keys(req.body).join(', ')}`);
        logToFile(`invoiceLabels raw value: ${req.body.invoiceLabels}`);

        const {
            name, email, phone, website, address, city, state, zip, country, currency,
            startDate, endDate, planId, planType,
            invoiceTemplate, invoiceColor, showQrCode,
            bankName, accountHolder, accountName, accountNumber,
            iban, bic, sortCode, ifsc, vatNumber, gstNumber, defaultVatRateId, isVatRegistered,
            terms,
            termsInvoice,
            termsReceipt,
            termsPurchase,
            termsSalesOrder,
            termsQuotation,
            termsCreditNote,
            notes,
            inventoryConfig,
            storageCapacity,
            invoiceTableHeaders,
            invoiceLabels,
            receiptTemplate,
            receiptColor,
            receiptLabels,
            receiptTableHeaders,
            paymentTemplate,
            paymentColor,
            paymentLabels,
            paymentTableHeaders,
            customFieldsConfig,
            documentTitles
        } = req.body;

        // Fetch current company to get existing inventoryConfig
        const currentCompany = await prisma.company.findUnique({
            where: { id: parseInt(req.params.id) }
        });

        let finalInventoryConfig = currentCompany.inventoryConfig || '{}';
        try {
            let configObj = typeof finalInventoryConfig === 'string' ? JSON.parse(finalInventoryConfig) : finalInventoryConfig;
            if (storageCapacity !== undefined) {
                configObj.storageCapacity = storageCapacity;
            }
            if (inventoryConfig !== undefined) {
                // Merge other inventory config if provided
                const newConfig = typeof inventoryConfig === 'string' ? JSON.parse(inventoryConfig) : inventoryConfig;
                configObj = { ...configObj, ...newConfig };
            }
            finalInventoryConfig = JSON.stringify(configObj);
        } catch (e) {
            logToFile(`Error parsing inventoryConfig: ${e.message}`);
        }

        // if (currency && currentCompany.currency && currency !== currentCompany.currency) {
        //             try {
        //                 const { getConversionRate } = require('../utils/currencyConverter');
        //                 const rate = await getConversionRate(currentCompany.currency, currency);
        //                 if (rate && rate !== 1) {
        //                     const compId = parseInt(req.params.id);
        //                     const ledgers = await prisma.ledger.findMany({ where: { companyId: compId } });
        //                     for (const l of ledgers) {
        //                         if (l.openingBalance) {
        //                             await prisma.ledger.update({
        //                                 where: { id: l.id },
        //                                 data: { openingBalance: l.openingBalance * rate }
        //                             });
        //                         }
        //                     }
        //                     const customers = await prisma.customer.findMany({ where: { companyId: compId } });
        //                     for (const c of customers) {
        //                         if (c.accountBalance) {
        //                             await prisma.customer.update({
        //                                 where: { id: c.id },
        //                                 data: { accountBalance: c.accountBalance * rate }
        //                             });
        //                         }
        //                     }
        //                     const vendors = await prisma.vendor.findMany({ where: { companyId: compId } });
        //                     for (const v of vendors) {
        //                         if (v.accountBalance) {
        //                             await prisma.vendor.update({
        //                                 where: { id: v.id },
        //                                 data: { accountBalance: v.accountBalance * rate }
        //                             });
        //                         }
        //                     }
        //                 }
        //             } catch (conversionErr) {
        //                 console.error('Error converting company currency balances:', conversionErr);
        //             }
        //         }

        const updateData = {
            name,
            email,
            phone,
            website,
            address,
            city,
            state,
            zip,
            country,
            currency,
            originalCurrency: currentCompany.originalCurrency || currentCompany.currency || 'USD',
            startDate: startDate ? new Date(startDate) : undefined,
            endDate: endDate ? new Date(endDate) : undefined,
            planId: planId ? parseInt(planId) : undefined,
            planType: planType || undefined,
            invoiceTemplate,
            invoiceColor,
            showQrCode: showQrCode === 'true' || showQrCode === true,
            bankName,
            accountHolder,
            accountName,
            accountNumber,
            iban,
            bic,
            sortCode,
            ifsc,
            vatNumber,
            gstNumber,
            defaultVatRateId: defaultVatRateId ? parseInt(defaultVatRateId) : undefined,
            isVatRegistered: isVatRegistered !== undefined ? (isVatRegistered === true || isVatRegistered === 'true') : undefined,
            terms,
            termsInvoice,
            termsReceipt,
            termsPurchase,
            termsSalesOrder,
            termsQuotation,
            termsCreditNote,
            notes,
            inventoryConfig: finalInventoryConfig,
            invoiceTableHeaders: invoiceTableHeaders ? (typeof invoiceTableHeaders === 'string' ? invoiceTableHeaders : JSON.stringify(invoiceTableHeaders)) : undefined,
            invoiceLabels: invoiceLabels ? (typeof invoiceLabels === 'string' ? invoiceLabels : JSON.stringify(invoiceLabels)) : undefined,
            receiptTemplate: receiptTemplate || undefined,
            receiptColor: receiptColor || undefined,
            receiptLabels: receiptLabels ? (typeof receiptLabels === 'string' ? receiptLabels : JSON.stringify(receiptLabels)) : undefined,
            receiptTableHeaders: receiptTableHeaders ? (typeof receiptTableHeaders === 'string' ? receiptTableHeaders : JSON.stringify(receiptTableHeaders)) : undefined,
            paymentTemplate: paymentTemplate || undefined,
            paymentColor: paymentColor || undefined,
            paymentLabels: paymentLabels ? (typeof paymentLabels === 'string' ? paymentLabels : JSON.stringify(paymentLabels)) : undefined,
            paymentTableHeaders: paymentTableHeaders ? (typeof paymentTableHeaders === 'string' ? paymentTableHeaders : JSON.stringify(paymentTableHeaders)) : undefined,
            customFieldsConfig: customFieldsConfig !== undefined ? (typeof customFieldsConfig === 'string' ? customFieldsConfig : JSON.stringify(customFieldsConfig)) : undefined,
            documentTitles: documentTitles !== undefined ? (typeof documentTitles === 'string' ? documentTitles : JSON.stringify(documentTitles)) : undefined
        };

        if (req.files) {
            if (req.files.logo && req.files.logo[0]) {
                updateData.logo = await uploadToCloudinaryOrBase64(req.files.logo[0], 'company_logos');
            }
            if (req.files.invoiceLogo && req.files.invoiceLogo[0]) {
                updateData.invoiceLogo = await uploadToCloudinaryOrBase64(req.files.invoiceLogo[0], 'company_logos');
            }
        }

        logToFile(`💾 Updating company in DB with updateData: ${JSON.stringify(updateData)}`);

        const company = await prisma.company.update({
            where: { id: parseInt(req.params.id) },
            data: updateData,
            include: { plan: true }
        });

        logToFile(`✅ Company updated in DB. company.invoiceLabels value: ${company.invoiceLabels}`);

        // Add storageCapacity to the response object for frontend
        if (company.inventoryConfig) {
            try {
                const config = JSON.parse(company.inventoryConfig);
                company.storageCapacity = config.storageCapacity;
            } catch (e) { }
        }

        res.json(company);
    } catch (error) {
        logToFile(`❌ Update Company Error: ${error.message}`);
        res.status(500).json({
            error: error.message || 'Internal Server Error'
        });
    }
};

const deleteCompany = async (req, res) => {
    try {
        // Transaction to delete company and its users
        await prisma.$transaction(async (tx) => {
            await tx.user.deleteMany({ where: { companyId: parseInt(req.params.id) } });
            await tx.company.delete({ where: { id: parseInt(req.params.id) } });
        });
        res.json({ message: 'Company and its users deleted successfully' });
    } catch (error) {
        console.error('Delete Company Error:', error);
        res.status(500).json({ error: error.message });
    }
};

const getNumberingSettings = async (req, res) => {
    try {
        const companyId = parseInt(req.params.id || req.user?.companyId);
        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }

        // Use raw SQL helpers — works even if prisma client is not regenerated yet
        const existingConfigs = await numberingService.findAllConfigs(companyId);

        const configsMap = {};
        existingConfigs.forEach(cfg => {
            configsMap[cfg.transactionType] = cfg;
        });

        const allTypes = Object.keys(numberingService.TRANSACTION_TYPES);
        const results = await Promise.all(allTypes.map(async (type) => {
            if (configsMap[type]) return configsMap[type];
            const defInfo = numberingService.TRANSACTION_TYPES[type];
            return await numberingService.upsertConfig(companyId, type, {
                prefix: defInfo.defaultPrefix,
                currentNumber: 1,
                paddingLength: 4,
                pattern: 'numeric'
            });
        }));

        res.json({ success: true, data: results });
    } catch (error) {
        console.error('Get Numbering Settings Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

const updateNumberingSettings = async (req, res) => {
    try {
        const companyId = parseInt(req.params.id || req.user?.companyId);
        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }

        const { settings } = req.body;
        if (!Array.isArray(settings)) {
            return res.status(400).json({ success: false, message: 'Settings array is required' });
        }

        const results = [];
        for (const item of settings) {
            const { transactionType, prefix, currentNumber, paddingLength, pattern } = item;
            if (!transactionType) continue;

            const updated = await numberingService.upsertConfig(companyId, transactionType, {
                prefix: prefix !== undefined ? prefix : '',
                currentNumber: currentNumber !== undefined ? parseInt(currentNumber) : 1,
                paddingLength: paddingLength !== undefined ? parseInt(paddingLength) : 4,
                pattern: pattern || 'numeric'
            });
            results.push(updated);
        }

        res.json({ success: true, data: results });
    } catch (error) {
        console.error('Update Numbering Settings Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

const getNextNumberEndpoint = async (req, res) => {
    try {
        const companyId = parseInt(req.params.id || req.user?.companyId || req.query.companyId);
        const { type } = req.query;

        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }
        if (!type) {
            return res.status(400).json({ success: false, message: 'Transaction type is required' });
        }

        const result = await numberingService.getNextNumber(companyId, type);
        res.json({
            success: true,
            nextNumber: result.formattedNumber,
            nextManualReference: result.nextManualReference || '',
            details: result
        });
    } catch (error) {
        console.error('Get Next Number Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

const PERIOD_LOCK_FILE = path.join(__dirname, '../../period_lock_config.json');

const loadPeriodLocks = () => {
    try {
        if (fs.existsSync(PERIOD_LOCK_FILE)) {
            return JSON.parse(fs.readFileSync(PERIOD_LOCK_FILE, 'utf8'));
        }
    } catch (e) {
        console.warn('Error reading period lock config:', e.message);
    }
    return {};
};

const savePeriodLocks = (data) => {
    try {
        fs.writeFileSync(PERIOD_LOCK_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error('Error saving period lock config:', e.message);
    }
};

const getPeriodLockSettings = async (req, res) => {
    try {
        const companyId = parseInt(req.params.id || req.user?.companyId);
        const locks = loadPeriodLocks();
        const config = locks[companyId] || {
            isLocked: false,
            lockedUntilDate: null,
            reason: '',
            updatedAt: null,
            updatedBy: null
        };
        res.status(200).json({ success: true, data: config });
    } catch (err) {
        console.error('Error fetching period lock settings:', err);
        res.status(500).json({ success: false, message: err.message });
    }
};

const updatePeriodLockSettings = async (req, res) => {
    try {
        const companyId = parseInt(req.params.id || req.user?.companyId);
        const { isLocked, lockedUntilDate, reason } = req.body;
        const locks = loadPeriodLocks();

        locks[companyId] = {
            isLocked: !!isLocked,
            lockedUntilDate: isLocked && lockedUntilDate ? new Date(lockedUntilDate).toISOString().split('T')[0] : null,
            reason: reason || 'Year-End Closing / Accounting Audit Lock',
            updatedAt: new Date().toISOString(),
            updatedBy: req.user?.email || req.user?.name || 'Administrator'
        };

        savePeriodLocks(locks);

        const { logActivity } = require('../utils/auditLogger');
        logActivity(
            req, 
            isLocked ? 'LOCK_PERIOD' : 'UNLOCK_PERIOD', 
            'AccountingPeriod', 
            companyId, 
            isLocked ? `Locked accounting period up to ${locks[companyId].lockedUntilDate}` : 'Unlocked accounting period'
        );

        res.status(200).json({ 
            success: true, 
            message: isLocked ? `Accounting period successfully locked up to ${locks[companyId].lockedUntilDate}` : 'Accounting period unlocked',
            data: locks[companyId] 
        });
    } catch (err) {
        console.error('Error updating period lock settings:', err);
        res.status(500).json({ success: false, message: err.message });
    }
};

module.exports = {
    createCompany,
    getCompanies,
    getCompanyById,
    updateCompany,
    deleteCompany,
    getNumberingSettings,
    updateNumberingSettings,
    getNextNumberEndpoint,
    getPeriodLockSettings,
    updatePeriodLockSettings
};

