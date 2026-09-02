const prisma = require('../config/prisma');

/**
 * Bulk Import Products & Inventory Items
 */
const importProducts = async (req, res) => {
    try {
        const companyId = req.user?.companyId || parseInt(req.body.companyId);
        const { rows = [], duplicateStrategy = 'update' } = req.body; // 'update' or 'skip'

        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }

        if (!Array.isArray(rows) || rows.length === 0) {
            return res.status(400).json({ success: false, message: 'No product rows provided for import' });
        }

        const results = {
            total: rows.length,
            created: 0,
            updated: 0,
            skipped: 0,
            errors: []
        };

        // Cache existing categories, UOMs, warehouses to avoid redundant DB hits
        const existingCategories = await prisma.category.findMany({ where: { companyId } });
        const existingUoms = await prisma.uom.findMany({ where: { companyId } });
        const existingWarehouses = await prisma.warehouse.findMany({ where: { companyId } });

        const categoryMap = new Map(existingCategories.map(c => [c.name.toLowerCase().trim(), c.id]));
        const uomMap = new Map(existingUoms.map(u => [u.unitName.toLowerCase().trim(), u.id]));
        const warehouseMap = new Map(existingWarehouses.map(w => [w.name.toLowerCase().trim(), w.id]));

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const rowNum = i + 1;

            const name = (row.name || row['Product Name'] || '').trim();
            if (!name) {
                results.errors.push({ row: rowNum, error: 'Product Name is required' });
                results.skipped++;
                continue;
            }

            const sku = (row.sku || row['SKU / Code'] || row['SKU'] || '').trim();
            const purchasePrice = parseFloat(row.purchasePrice !== undefined ? row.purchasePrice : row['Purchase Price'] || 0) || 0;
            const salePrice = parseFloat(row.sellingPrice !== undefined ? row.sellingPrice : (row.salePrice || row['Selling Price'] || 0)) || 0;
            const taxRate = parseFloat(row.taxRate !== undefined ? row.taxRate : row['Tax Rate %'] || 0) || 0;
            const openingStock = parseFloat(row.openingStock !== undefined ? row.openingStock : row['Opening Stock Qty'] || 0) || 0;
            const categoryName = (row.categoryName || row['Category'] || '').trim();
            const uomName = (row.uomName || row['Unit of Measure'] || row['UOM'] || '').trim();
            const warehouseName = (row.warehouseName || row['Warehouse / Location'] || row['Warehouse'] || '').trim();
            const barcode = (row.barcode || row['Barcode'] || '').trim();
            const description = (row.description || row['Description'] || '').trim();

            try {
                // 1. Resolve or Create Category
                let categoryId = null;
                if (categoryName) {
                    const catKey = categoryName.toLowerCase();
                    if (categoryMap.has(catKey)) {
                        categoryId = categoryMap.get(catKey);
                    } else {
                        const newCat = await prisma.category.create({
                            data: { name: categoryName, companyId }
                        });
                        categoryId = newCat.id;
                        categoryMap.set(catKey, categoryId);
                    }
                }

                // 2. Resolve or Create UOM
                let uomId = null;
                if (uomName) {
                    const uomKey = uomName.toLowerCase();
                    if (uomMap.has(uomKey)) {
                        uomId = uomMap.get(uomKey);
                    } else {
                        const newUom = await prisma.uom.create({
                            data: { unitName: uomName, category: 'General', companyId }
                        });
                        uomId = newUom.id;
                        uomMap.set(uomKey, uomId);
                    }
                }

                // 3. Resolve Warehouse
                let warehouseId = null;
                if (warehouseName) {
                    const whKey = warehouseName.toLowerCase();
                    if (warehouseMap.has(whKey)) {
                        warehouseId = warehouseMap.get(whKey);
                    } else {
                        const newWh = await prisma.warehouse.create({
                            data: { name: warehouseName, location: warehouseName, companyId }
                        });
                        warehouseId = newWh.id;
                        warehouseMap.set(whKey, warehouseId);
                    }
                }

                // 4. Check for existing product (by SKU or by Name)
                const existingProduct = await prisma.product.findFirst({
                    where: {
                        companyId,
                        OR: [
                            { name: name },
                            ...(sku ? [{ sku: sku }] : [])
                        ]
                    }
                });

                if (existingProduct) {
                    if (duplicateStrategy === 'skip') {
                        results.skipped++;
                        continue;
                    }

                    // Update existing
                    await prisma.product.update({
                        where: { id: existingProduct.id },
                        data: {
                            sku: sku || existingProduct.sku,
                            purchasePrice,
                            salePrice,
                            categoryId: categoryId || existingProduct.categoryId,
                            uomId: uomId || existingProduct.uomId,
                            barcode: barcode || existingProduct.barcode,
                            description: description || existingProduct.description
                        }
                    });
                    results.updated++;
                } else {
                    // Create new
                    await prisma.product.create({
                        data: {
                            name,
                            sku: sku || null,
                            purchasePrice,
                            salePrice,
                            initialCost: purchasePrice,
                            totalQty: openingStock,
                            categoryId,
                            uomId,
                            barcode: barcode || null,
                            description: description || null,
                            companyId
                        }
                    });
                    results.created++;
                }
            } catch (err) {
                console.error(`Error importing product row ${rowNum}:`, err);
                results.errors.push({ row: rowNum, item: name, error: err.message });
                results.skipped++;
            }
        }

        return res.status(200).json({
            success: true,
            message: `Products Import Complete: ${results.created} created, ${results.updated} updated, ${results.skipped} skipped.`,
            data: results
        });
    } catch (error) {
        console.error('Bulk Import Products Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Bulk Import Customers
 */
const importCustomers = async (req, res) => {
    try {
        const companyId = req.user?.companyId || parseInt(req.body.companyId);
        const { rows = [], duplicateStrategy = 'update' } = req.body;

        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }

        if (!Array.isArray(rows) || rows.length === 0) {
            return res.status(400).json({ success: false, message: 'No customer rows provided for import' });
        }

        const results = {
            total: rows.length,
            created: 0,
            updated: 0,
            skipped: 0,
            errors: []
        };

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const rowNum = i + 1;

            const name = (row.name || row['Customer Name'] || '').trim();
            if (!name) {
                results.errors.push({ row: rowNum, error: 'Customer Name is required' });
                results.skipped++;
                continue;
            }

            const nameArabic = (row.nameArabic || row['Arabic Name'] || '').trim();
            const companyName = (row.companyName || row['Company / Business Name'] || '').trim();
            const email = (row.email || row['Email Address'] || row['Email'] || '').trim().toLowerCase();
            const phone = (row.phone || row['Phone Number'] || row['Phone'] || '').trim();
            const taxNumber = (row.taxNumber || row['TRN / VAT Number'] || row['VAT Number'] || row['GST Number'] || '').trim();
            const address = (row.address || row['Billing Address'] || row['Address'] || '').trim();
            const city = (row.city || row['City'] || '').trim();
            const state = (row.state || row['State / County'] || row['State'] || '').trim();
            const zipCode = (row.zipCode || row['Zip / Postal Code'] || row['Zip'] || '').trim();
            const country = (row.country || row['Country'] || '').trim();
            const creditPeriod = parseInt(row.creditPeriod !== undefined ? row.creditPeriod : row['Credit Period (Days)'] || 0) || 0;
            const openingBalance = parseFloat(row.openingBalance !== undefined ? row.openingBalance : row['Opening Balance'] || 0) || 0;
            const balanceType = (row.balanceType || row['Balance Type (Debit / Credit)'] || 'Debit').trim();

            try {
                // Check if customer already exists by email or name
                const existingCustomer = await prisma.customer.findFirst({
                    where: {
                        companyId,
                        OR: [
                            { name: name },
                            ...(email ? [{ email: email }] : [])
                        ]
                    }
                });

                if (existingCustomer) {
                    if (duplicateStrategy === 'skip') {
                        results.skipped++;
                        continue;
                    }

                    await prisma.customer.update({
                        where: { id: existingCustomer.id },
                        data: {
                            nameArabic: nameArabic || existingCustomer.nameArabic,
                            companyName: companyName || existingCustomer.companyName,
                            phone: phone || existingCustomer.phone,
                            gstNumber: taxNumber || existingCustomer.gstNumber,
                            billingAddress: address || existingCustomer.billingAddress,
                            billingCity: city || existingCustomer.billingCity,
                            billingState: state || existingCustomer.billingState,
                            billingZipCode: zipCode || existingCustomer.billingZipCode,
                            billingCountry: country || existingCustomer.billingCountry,
                            creditPeriod: creditPeriod || existingCustomer.creditPeriod
                        }
                    });
                    results.updated++;
                } else {
                    await prisma.customer.create({
                        data: {
                            name,
                            nameArabic: nameArabic || null,
                            companyName: companyName || null,
                            email: email || null,
                            phone: phone || null,
                            gstNumber: taxNumber || null,
                            gstEnabled: !!taxNumber,
                            billingAddress: address || null,
                            billingCity: city || null,
                            billingState: state || null,
                            billingZipCode: zipCode || null,
                            billingCountry: country || null,
                            creditPeriod: creditPeriod || 0,
                            accountBalance: openingBalance,
                            balanceType: balanceType === 'Credit' ? 'Credit' : 'Debit',
                            companyId
                        }
                    });
                    results.created++;
                }
            } catch (err) {
                console.error(`Error importing customer row ${rowNum}:`, err);
                results.errors.push({ row: rowNum, item: name, error: err.message });
                results.skipped++;
            }
        }

        return res.status(200).json({
            success: true,
            message: `Customers Import Complete: ${results.created} created, ${results.updated} updated, ${results.skipped} skipped.`,
            data: results
        });
    } catch (error) {
        console.error('Bulk Import Customers Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Bulk Import Vendors & Suppliers
 */
const importVendors = async (req, res) => {
    try {
        const companyId = req.user?.companyId || parseInt(req.body.companyId);
        const { rows = [], duplicateStrategy = 'update' } = req.body;

        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }

        if (!Array.isArray(rows) || rows.length === 0) {
            return res.status(400).json({ success: false, message: 'No vendor rows provided for import' });
        }

        const results = {
            total: rows.length,
            created: 0,
            updated: 0,
            skipped: 0,
            errors: []
        };

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const rowNum = i + 1;

            const name = (row.name || row['Vendor Name'] || '').trim();
            if (!name) {
                results.errors.push({ row: rowNum, error: 'Vendor Name is required' });
                results.skipped++;
                continue;
            }

            const nameArabic = (row.nameArabic || row['Arabic Name'] || '').trim();
            const companyName = (row.companyName || row['Company Name'] || '').trim();
            const email = (row.email || row['Email Address'] || row['Email'] || '').trim().toLowerCase();
            const phone = (row.phone || row['Phone Number'] || row['Phone'] || '').trim();
            const taxNumber = (row.taxNumber || row['TRN / VAT Number'] || row['VAT Number'] || '').trim();
            const address = (row.address || row['Address'] || '').trim();
            const city = (row.city || row['City'] || '').trim();
            const state = (row.state || row['State / County'] || row['State'] || '').trim();
            const zipCode = (row.zipCode || row['Zip / Postal Code'] || row['Zip'] || '').trim();
            const country = (row.country || row['Country'] || '').trim();
            const creditPeriod = parseInt(row.creditPeriod !== undefined ? row.creditPeriod : row['Payment Terms (Days)'] || 0) || 0;
            const openingBalance = parseFloat(row.openingBalance !== undefined ? row.openingBalance : row['Opening Balance'] || 0) || 0;
            const balanceType = (row.balanceType || row['Balance Type (Debit / Credit)'] || 'Credit').trim();

            try {
                const existingVendor = await prisma.vendor.findFirst({
                    where: {
                        companyId,
                        OR: [
                            { name: name },
                            ...(email ? [{ email: email }] : [])
                        ]
                    }
                });

                if (existingVendor) {
                    if (duplicateStrategy === 'skip') {
                        results.skipped++;
                        continue;
                    }

                    await prisma.vendor.update({
                        where: { id: existingVendor.id },
                        data: {
                            nameArabic: nameArabic || existingVendor.nameArabic,
                            companyName: companyName || existingVendor.companyName,
                            phone: phone || existingVendor.phone,
                            gstNumber: taxNumber || existingVendor.gstNumber,
                            billingAddress: address || existingVendor.billingAddress,
                            billingCity: city || existingVendor.billingCity,
                            billingState: state || existingVendor.billingState,
                            billingZipCode: zipCode || existingVendor.billingZipCode,
                            billingCountry: country || existingVendor.billingCountry,
                            creditPeriod: creditPeriod || existingVendor.creditPeriod
                        }
                    });
                    results.updated++;
                } else {
                    await prisma.vendor.create({
                        data: {
                            name,
                            nameArabic: nameArabic || null,
                            companyName: companyName || null,
                            email: email || null,
                            phone: phone || null,
                            gstNumber: taxNumber || null,
                            gstEnabled: !!taxNumber,
                            billingAddress: address || null,
                            billingCity: city || null,
                            billingState: state || null,
                            billingZipCode: zipCode || null,
                            billingCountry: country || null,
                            creditPeriod: creditPeriod || 0,
                            accountBalance: openingBalance,
                            balanceType: balanceType === 'Debit' ? 'Debit' : 'Credit',
                            companyId
                        }
                    });
                    results.created++;
                }
            } catch (err) {
                console.error(`Error importing vendor row ${rowNum}:`, err);
                results.errors.push({ row: rowNum, item: name, error: err.message });
                results.skipped++;
            }
        }

        return res.status(200).json({
            success: true,
            message: `Vendors Import Complete: ${results.created} created, ${results.updated} updated, ${results.skipped} skipped.`,
            data: results
        });
    } catch (error) {
        console.error('Bulk Import Vendors Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Bulk Import Chart of Accounts
 */
const importChartOfAccounts = async (req, res) => {
    try {
        const companyId = req.user?.companyId || parseInt(req.body.companyId);
        const { rows = [], duplicateStrategy = 'update' } = req.body;

        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }

        if (!Array.isArray(rows) || rows.length === 0) {
            return res.status(400).json({ success: false, message: 'No account rows provided for import' });
        }

        const results = {
            total: rows.length,
            created: 0,
            updated: 0,
            skipped: 0,
            errors: []
        };

        const existingGroups = await prisma.accountgroup.findMany({ where: { companyId } });
        const groupMap = new Map(existingGroups.map(g => [g.name.toLowerCase().trim(), g.id]));

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const rowNum = i + 1;

            const name = (row.name || row['Account Name'] || '').trim();
            if (!name) {
                results.errors.push({ row: rowNum, error: 'Account Name is required' });
                results.skipped++;
                continue;
            }

            const rawType = (row.accountType || row['Account Type (Asset / Liability / Equity / Income / Expense)'] || 'Asset').trim().toUpperCase();
            let mappedType = 'ASSETS';
            if (rawType.includes('LIAB')) mappedType = 'LIABILITIES';
            else if (rawType.includes('INCOME') || rawType.includes('REV')) mappedType = 'INCOME';
            else if (rawType.includes('EXP')) mappedType = 'EXPENSES';
            else if (rawType.includes('EQUITY')) mappedType = 'EQUITY';

            const openingBalance = parseFloat(row.openingBalance !== undefined ? row.openingBalance : row['Opening Balance'] || 0) || 0;
            const description = (row.description || row['Description'] || '').trim();

            try {
                // Ensure default group exists
                let groupId = null;
                const groupName = mappedType.charAt(0) + mappedType.slice(1).toLowerCase();
                const groupKey = groupName.toLowerCase();

                if (groupMap.has(groupKey)) {
                    groupId = groupMap.get(groupKey);
                } else {
                    const newGroup = await prisma.accountgroup.create({
                        data: {
                            name: groupName,
                            type: mappedType,
                            companyId
                        }
                    });
                    groupId = newGroup.id;
                    groupMap.set(groupKey, groupId);
                }

                // Check if ledger already exists
                const existingLedger = await prisma.ledger.findFirst({
                    where: { companyId, name }
                });

                if (existingLedger) {
                    if (duplicateStrategy === 'skip') {
                        results.skipped++;
                        continue;
                    }
                    await prisma.ledger.update({
                        where: { id: existingLedger.id },
                        data: {
                            groupId,
                            description: description || existingLedger.description
                        }
                    });
                    results.updated++;
                } else {
                    await prisma.ledger.create({
                        data: {
                            name,
                            groupId,
                            openingBalance,
                            currentBalance: openingBalance,
                            description: description || null,
                            companyId
                        }
                    });
                    results.created++;
                }
            } catch (err) {
                console.error(`Error importing account row ${rowNum}:`, err);
                results.errors.push({ row: rowNum, item: name, error: err.message });
                results.skipped++;
            }
        }

        return res.status(200).json({
            success: true,
            message: `Chart of Accounts Import Complete: ${results.created} created, ${results.updated} updated, ${results.skipped} skipped.`,
            data: results
        });
    } catch (error) {
        console.error('Bulk Import Chart of Accounts Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Bulk Import Sales Invoices
 */
const importSalesInvoices = async (req, res) => {
    try {
        const companyId = req.user?.companyId || parseInt(req.body.companyId);
        const { rows = [] } = req.body;

        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }

        if (!Array.isArray(rows) || rows.length === 0) {
            return res.status(400).json({ success: false, message: 'No invoice rows provided for import' });
        }

        // Group rows by invoiceNumber
        const invoiceGroups = {};
        for (const row of rows) {
            const invNum = (row.invoiceNumber || row['Invoice #'] || '').trim();
            if (!invNum) continue;
            if (!invoiceGroups[invNum]) invoiceGroups[invNum] = [];
            invoiceGroups[invNum].push(row);
        }

        const results = {
            totalInvoices: Object.keys(invoiceGroups).length,
            created: 0,
            skipped: 0,
            errors: []
        };

        for (const [invNum, itemRows] of Object.entries(invoiceGroups)) {
            try {
                const firstRow = itemRows[0];
                const custName = (firstRow.customerName || firstRow['Customer Name / Email'] || 'Walk-in Customer').trim();
                const invDate = firstRow.date || firstRow['Invoice Date (YYYY-MM-DD)'] ? new Date(firstRow.date || firstRow['Invoice Date (YYYY-MM-DD)']) : new Date();
                const dueDate = firstRow.dueDate || firstRow['Due Date (YYYY-MM-DD)'] ? new Date(firstRow.dueDate || firstRow['Due Date (YYYY-MM-DD)']) : null;
                const currency = firstRow.currency || firstRow['Currency'] || 'EUR';
                const notes = firstRow.notes || firstRow['Notes'] || '';

                // Resolve customer
                let customer = await prisma.customer.findFirst({
                    where: {
                        companyId,
                        OR: [
                            { name: custName },
                            { email: custName.toLowerCase() }
                        ]
                    }
                });

                if (!customer) {
                    customer = await prisma.customer.create({
                        data: { name: custName, companyId }
                    });
                }

                // Prepare items and totals
                let subtotal = 0;
                let taxAmount = 0;
                const itemsToCreate = [];

                for (const itemRow of itemRows) {
                    const prodName = (itemRow.productName || itemRow['Product Name / SKU'] || 'General Item').trim();
                    const qty = parseFloat(itemRow.quantity !== undefined ? itemRow.quantity : itemRow['Quantity'] || 1) || 1;
                    const rate = parseFloat(itemRow.unitRate !== undefined ? itemRow.unitRate : itemRow['Unit Rate'] || 0) || 0;
                    const disc = parseFloat(itemRow.discountPercent !== undefined ? itemRow.discountPercent : itemRow['Discount %'] || 0) || 0;
                    const taxRate = parseFloat(itemRow.taxRate !== undefined ? itemRow.taxRate : itemRow['Tax Rate %'] || 0) || 0;

                    // Resolve product
                    let product = await prisma.product.findFirst({
                        where: {
                            companyId,
                            OR: [
                                { name: prodName },
                                { sku: prodName }
                            ]
                        }
                    });

                    if (!product) {
                        product = await prisma.product.create({
                            data: { name: prodName, salePrice: rate, companyId }
                        });
                    }

                    const lineSub = qty * rate * (1 - disc / 100);
                    const lineTax = lineSub * (taxRate / 100);
                    const lineTotal = lineSub + lineTax;

                    subtotal += lineSub;
                    taxAmount += lineTax;

                    itemsToCreate.push({
                        productId: product.id,
                        description: prodName,
                        quantity: qty,
                        rate,
                        discount: disc,
                        taxRate,
                        amount: lineTotal
                    });
                }

                const totalAmount = subtotal + taxAmount;

                // Check if invoice # exists
                const existing = await prisma.invoice.findFirst({
                    where: { companyId, invoiceNumber: invNum }
                });

                if (existing) {
                    results.skipped++;
                    continue;
                }

                await prisma.invoice.create({
                    data: {
                        invoiceNumber: invNum,
                        date: invDate,
                        dueDate,
                        customerId: customer.id,
                        subtotal,
                        taxAmount,
                        totalAmount,
                        balanceAmount: totalAmount,
                        currency,
                        notes,
                        status: 'UNPAID',
                        companyId,
                        invoiceitem: {
                            create: itemsToCreate
                        }
                    }
                });

                results.created++;
            } catch (err) {
                console.error(`Error importing invoice ${invNum}:`, err);
                results.errors.push({ invoiceNumber: invNum, error: err.message });
                results.skipped++;
            }
        }

        return res.status(200).json({
            success: true,
            message: `Sales Invoices Import Complete: ${results.created} created, ${results.skipped} skipped.`,
            data: results
        });
    } catch (error) {
        console.error('Bulk Import Sales Invoices Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Bulk Import Purchase Bills
 */
const importPurchaseBills = async (req, res) => {
    try {
        const companyId = req.user?.companyId || parseInt(req.body.companyId);
        const { rows = [] } = req.body;

        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }

        if (!Array.isArray(rows) || rows.length === 0) {
            return res.status(400).json({ success: false, message: 'No bill rows provided for import' });
        }

        const billGroups = {};
        for (const row of rows) {
            const billNum = (row.billNumber || row['Bill / Ref #'] || row['Bill #'] || '').trim();
            if (!billNum) continue;
            if (!billGroups[billNum]) billGroups[billNum] = [];
            billGroups[billNum].push(row);
        }

        const results = {
            totalBills: Object.keys(billGroups).length,
            created: 0,
            skipped: 0,
            errors: []
        };

        for (const [billNum, itemRows] of Object.entries(billGroups)) {
            try {
                const firstRow = itemRows[0];
                const vendName = (firstRow.vendorName || firstRow['Vendor Name / Email'] || 'General Supplier').trim();
                const billDate = firstRow.date || firstRow['Bill Date (YYYY-MM-DD)'] ? new Date(firstRow.date || firstRow['Bill Date (YYYY-MM-DD)']) : new Date();
                const dueDate = firstRow.dueDate || firstRow['Due Date (YYYY-MM-DD)'] ? new Date(firstRow.dueDate || firstRow['Due Date (YYYY-MM-DD)']) : null;
                const currency = firstRow.currency || firstRow['Currency'] || 'EUR';
                const notes = firstRow.notes || firstRow['Notes'] || '';

                let vendor = await prisma.vendor.findFirst({
                    where: {
                        companyId,
                        OR: [
                            { name: vendName },
                            { email: vendName.toLowerCase() }
                        ]
                    }
                });

                if (!vendor) {
                    vendor = await prisma.vendor.create({
                        data: { name: vendName, companyId }
                    });
                }

                let subtotal = 0;
                let taxAmount = 0;
                const itemsToCreate = [];

                for (const itemRow of itemRows) {
                    const prodName = (itemRow.productName || itemRow['Product Name / SKU'] || 'General Item').trim();
                    const qty = parseFloat(itemRow.quantity !== undefined ? itemRow.quantity : itemRow['Quantity'] || 1) || 1;
                    const rate = parseFloat(itemRow.unitRate !== undefined ? itemRow.unitRate : itemRow['Unit Rate'] || 0) || 0;
                    const taxRate = parseFloat(itemRow.taxRate !== undefined ? itemRow.taxRate : itemRow['Tax Rate %'] || 0) || 0;

                    let product = await prisma.product.findFirst({
                        where: {
                            companyId,
                            OR: [
                                { name: prodName },
                                { sku: prodName }
                            ]
                        }
                    });

                    if (!product) {
                        product = await prisma.product.create({
                            data: { name: prodName, purchasePrice: rate, companyId }
                        });
                    }

                    const lineSub = qty * rate;
                    const lineTax = lineSub * (taxRate / 100);
                    const lineTotal = lineSub + lineTax;

                    subtotal += lineSub;
                    taxAmount += lineTax;

                    itemsToCreate.push({
                        productId: product.id,
                        description: prodName,
                        quantity: qty,
                        rate,
                        taxRate,
                        amount: lineTotal
                    });
                }

                const totalAmount = subtotal + taxAmount;

                const existing = await prisma.purchasebill.findFirst({
                    where: { companyId, billNumber: billNum }
                });

                if (existing) {
                    results.skipped++;
                    continue;
                }

                await prisma.purchasebill.create({
                    data: {
                        billNumber: billNum,
                        date: billDate,
                        dueDate,
                        vendorId: vendor.id,
                        subtotal,
                        taxAmount,
                        totalAmount,
                        balanceAmount: totalAmount,
                        currency,
                        notes,
                        status: 'UNPAID',
                        companyId,
                        purchasebillitem: {
                            create: itemsToCreate
                        }
                    }
                });

                results.created++;
            } catch (err) {
                console.error(`Error importing purchase bill ${billNum}:`, err);
                results.errors.push({ billNumber: billNum, error: err.message });
                results.skipped++;
            }
        }

        return res.status(200).json({
            success: true,
            message: `Purchase Bills Import Complete: ${results.created} created, ${results.skipped} skipped.`,
            data: results
        });
    } catch (error) {
        console.error('Bulk Import Purchase Bills Error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    importProducts,
    importCustomers,
    importVendors,
    importChartOfAccounts,
    importSalesInvoices,
    importPurchaseBills
};
