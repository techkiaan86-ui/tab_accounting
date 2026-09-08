const prisma = require('../config/prisma');
const numberingService = require('../services/numberingService');
const {
    getInventoryConfig,
    consumeStock,
    reverseStockOut
} = require('../services/inventoryValuationService');
const { isDuePassed } = require('../utils/invoiceSyncHelper');

// Helper to dynamically adjust Sales Invoice quantities and amounts by associated returns
const adjustInvoiceWithReturns = (invoice) => {
    if (!invoice) return invoice;

    const returns = invoice.salesreturn || [];
    let returnedTotal = 0;
    const returnedItemsMap = {}; // productId -> { quantity, amount }

    for (const ret of returns) {
        returnedTotal += ret.totalAmount || 0;
        const retItems = ret.salesreturnitem || [];
        for (const item of retItems) {
            if (item.productId) {
                if (!returnedItemsMap[item.productId]) {
                    returnedItemsMap[item.productId] = { quantity: 0, amount: 0 };
                }
                returnedItemsMap[item.productId].quantity += item.quantity || 0;
                returnedItemsMap[item.productId].amount += item.amount || 0;
            }
        }
    }

    let newSubtotal = 0;
    let newTaxAmount = 0;
    let newTotalAmount = 0;
    let hasItems = false;

    // Use posinvoiceitem if it exists (for POS_INVOICE), otherwise invoiceitem
    const itemsKey = invoice.posinvoiceitem ? 'posinvoiceitem' : (invoice.invoiceitem ? 'invoiceitem' : null);
    const items = itemsKey ? invoice[itemsKey] : null;

    // Store original values if not already present
    invoice.originalTotalAmount = invoice.originalTotalAmount !== undefined ? invoice.originalTotalAmount : invoice.totalAmount;
    invoice.originalSubtotal = invoice.originalSubtotal !== undefined ? invoice.originalSubtotal : invoice.subtotal;
    invoice.originalTaxAmount = invoice.originalTaxAmount !== undefined ? invoice.originalTaxAmount : invoice.taxAmount;

    if (items) {
        hasItems = true;
        invoice[itemsKey] = items.map(item => {
            const ret = returnedItemsMap[item.productId];
            let adjustedQty = item.quantity;
            let adjustedAmt = item.amount;

            const originalQty = item.originalQuantity !== undefined ? item.originalQuantity : item.quantity;

            if (ret) {
                adjustedQty = Math.max(0, item.quantity - ret.quantity);
                const itemRate = parseFloat(item.rate) || 0;
                const itemDiscount = parseFloat(item.discount || 0) || 0;
                const itemTaxRate = parseFloat(item.taxRate) || 0;

                const lineGross = adjustedQty * itemRate;
                const lineTaxable = Math.max(0, lineGross - itemDiscount);
                const lineTax = (lineTaxable * itemTaxRate) / 100;
                adjustedAmt = lineTaxable + lineTax;
            }

            const itemRate = parseFloat(item.rate) || 0;
            const itemDiscount = parseFloat(item.discount || 0) || 0;
            const itemTaxRate = parseFloat(item.taxRate) || 0;

            const lineGross = adjustedQty * itemRate;
            newSubtotal += lineGross;

            const lineTaxable = Math.max(0, lineGross - itemDiscount);
            const lineTax = (lineTaxable * itemTaxRate) / 100;
            newTaxAmount += lineTax;
            newTotalAmount += (lineTaxable + lineTax);

            return {
                ...item,
                originalQuantity: originalQty,
                quantity: adjustedQty,
                amount: adjustedAmt
            };
        });
    }

    // Recalculate Other Charges from custom fields to add back
    let otherChargesTotal = 0;
    try {
        if (invoice.customFields) {
            const cf = typeof invoice.customFields === 'string'
                ? JSON.parse(invoice.customFields)
                : invoice.customFields;
            const parsedOtherCharges = cf?._otherCharges || [];
            otherChargesTotal = parsedOtherCharges.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);
        }
    } catch (e) {
        console.error('Error parsing custom fields for other charges in adjustInvoiceWithReturns:', e);
    }

    // Recalculate invoice total
    let adjustedTotal = invoice.totalAmount;
    let adjustedSubtotal = invoice.subtotal;
    let adjustedTaxAmount = invoice.taxAmount;

    const isPos = (invoice.type === 'POS_INVOICE' || !!invoice.posinvoiceitem);

    let totalDisc = parseFloat(invoice.discountAmount) || 0;
    if (hasItems) {
        adjustedSubtotal = newSubtotal;

        // Apply overall discounts if standard invoice, or model-level POS discount
        if (isPos) {
            const posDiscount = parseFloat(invoice.discountAmount) || 0;
            totalDisc = posDiscount;
            const discountedTaxable = Math.max(0, newSubtotal - posDiscount);
            // Recompute tax on discounted taxable
            const discRatio = newSubtotal > 0 ? (posDiscount / newSubtotal) : 0;
            adjustedTaxAmount = items.reduce((sum, item) => {
                const itemRate = parseFloat(item.rate) || 0;
                const adjustedQty = item.quantity || 0;
                const lineGross = adjustedQty * itemRate;
                const lineDiscountedTaxable = lineGross * (1 - discRatio);
                return sum + ((lineDiscountedTaxable * (parseFloat(item.taxRate) || 0)) / 100);
            }, 0);
            adjustedTotal = Math.max(0, discountedTaxable + adjustedTaxAmount);
        } else {
            const overallDiscount = parseFloat(invoice.overallDiscount) || 0;
            const overallDiscountType = invoice.overallDiscountType || 'percentage';
            const lineDiscountSum = (items || []).reduce((sum, item) => sum + (parseFloat(item.discount || 0) || 0), 0);
            const netBeforeOverall = Math.max(0, newSubtotal - lineDiscountSum);
            let ovDiscountAmt = 0;
            if (overallDiscount && overallDiscountType === 'percentage') {
                ovDiscountAmt = (netBeforeOverall * Math.min(100, Math.max(0, overallDiscount))) / 100;
            } else if (overallDiscount) {
                ovDiscountAmt = Math.min(netBeforeOverall, Math.max(0, overallDiscount));
            }

            totalDisc = lineDiscountSum + ovDiscountAmt;
            const discountedTaxable = Math.max(0, newSubtotal - totalDisc);
            const overallDiscountRatio = netBeforeOverall > 0 ? (ovDiscountAmt / netBeforeOverall) : 0;

            adjustedTaxAmount = items.reduce((sum, item) => {
                const itemRate = parseFloat(item.rate) || 0;
                const adjustedQty = item.quantity || 0;
                const itemDisc = parseFloat(item.discount || 0) || 0;
                const lineGross = adjustedQty * itemRate;
                const lineAfterItemDisc = Math.max(0, lineGross - itemDisc);
                const lineDiscountedTaxable = lineAfterItemDisc * (1 - overallDiscountRatio);
                return sum + ((lineDiscountedTaxable * (parseFloat(item.taxRate) || 0)) / 100);
            }, 0);

            adjustedTotal = Math.max(0, discountedTaxable + adjustedTaxAmount);
        }
        // Add other charges back to adjustedTotal
        adjustedTotal = adjustedTotal + otherChargesTotal;
    } else {
        adjustedTotal = Math.max(0, invoice.totalAmount - returnedTotal);
    }

    const originalPaidAmount = invoice.paidAmount || 0;
    // Cap paidAmount to adjustedTotal if there are returns
    const paidAmount = Math.min(originalPaidAmount, adjustedTotal);
    const adjustedBalance = Math.max(0, adjustedTotal - paidAmount);

    let adjustedStatus = invoice.status;
    if (invoice.manualStatus === true || invoice.manualStatus === 'true') {
        // Keep manually selected status
        adjustedStatus = invoice.status;
    } else if (returnedTotal > 0) {
        if (adjustedTotal <= 0) {
            adjustedStatus = isPos ? 'Returned' : 'RETURNED';
        } else {
            adjustedStatus = isPos ? 'Partially Returned' : 'PARTIALLY_RETURNED';
        }
    } else {
        const decimals = (invoice.currency && ['KWD', 'BHD', 'OMR', 'JOD', 'LYD', 'TND'].includes(invoice.currency.toUpperCase())) ? 3 : 2;
        const tol = decimals === 3 ? 0.001 : 0.01;
        if (adjustedBalance <= tol) {
            adjustedStatus = isPos ? 'Paid' : 'PAID';
        } else if (isDuePassed(invoice.dueDate)) {
            adjustedStatus = isPos ? 'Overdue' : 'OVERDUE';
        } else if (paidAmount > tol) {
            adjustedStatus = isPos ? 'Partial' : 'PARTIAL';
        } else {
            adjustedStatus = isPos ? 'Due' : 'UNPAID';
        }
    }

    return {
        ...invoice,
        subtotal: adjustedSubtotal,
        discountAmount: totalDisc,
        overallDiscount: parseFloat(invoice.overallDiscount) || 0,
        overallDiscountType: invoice.overallDiscountType || 'percentage',
        taxAmount: adjustedTaxAmount,
        totalAmount: adjustedTotal,
        paidAmount: paidAmount,
        balanceAmount: adjustedBalance,
        status: adjustedStatus
    };
};


// Create Sales Invoice
const createInvoice = async (req, res) => {
    try {
        const { invoiceNumber, manualReference, date, dueDate, customerId, salesOrderId, deliveryChallanId, items, notes, taxAmount, overallDiscount, overallDiscountType, billingName, billingAddress, billingCity, billingState, billingZipCode, billingCountry, shippingName, shippingAddress, shippingCity, shippingState, shippingZipCode, shippingCountry, currency, exchangeRate, manualStatus, status } = req.body;
        // Fallback to req.body.companyId if req.user is missing (custom frontend case)
        const companyId = req.user?.companyId || req.body.companyId;

        const docCurrency = currency || 'USD';
        const docExchangeRate = parseFloat(exchangeRate) || 1.0;

        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is missing' });
        }

        if (!invoiceNumber || !customerId || !items || items.length === 0) {
            return res.status(400).json({ success: false, message: 'Please provide all required fields' });
        }

        // Pre-flight: Check if this manual reference is already in use
        if (manualReference && req.query.allowDuplicate !== 'true') {
            const existingManual = await prisma.invoice.findFirst({
                where: { companyId: parseInt(companyId), manualReference }
            });
            if (existingManual) {
                let suffix = 1;
                let nextUniqueRef = `${manualReference}-${suffix}`;
                while (await prisma.invoice.findFirst({ where: { companyId: parseInt(companyId), manualReference: nextUniqueRef } })) {
                    suffix++;
                    nextUniqueRef = `${manualReference}-${suffix}`;
                }
                return res.status(400).json({
                    success: false,
                    isDuplicate: true,
                    nextUniqueRef,
                    message: `Manual Reference '${manualReference}' already exists.`
                });
            }
        }

        const existingJournal = await prisma.journalentry.findFirst({
            where: { companyId: parseInt(companyId), voucherNumber: invoiceNumber }
        });
        if (existingJournal) {
            return res.status(400).json({
                success: false,
                message: `Voucher number '${invoiceNumber}' is already used by another entry. Please use a unique invoice number.`
            });
        }

        // 1. Get Customer and its Ledger
        const customer = await prisma.customer.findUnique({
            where: { id: parseInt(customerId) },
            include: { ledger: true }
        });

        if (!customer) {
            return res.status(400).json({ success: false, message: 'Customer not found' });
        }

        // Date must not be before the customer's account creation date
        if (customer.creationDate && date) {
            const txDate = new Date(date);
            const accountDate = new Date(customer.creationDate);
            txDate.setHours(0, 0, 0, 0);
            accountDate.setHours(0, 0, 0, 0);
            if (txDate < accountDate) {
                return res.status(400).json({
                    success: false,
                    message: `Invoice date (${txDate.toDateString()}) cannot be before the customer's account creation date (${accountDate.toDateString()}).`
                });
            }
        }
        // customer.ledger will be null if the referenced ledger was deleted (orphaned ledgerId)
        // We'll auto-repair this inside the transaction if needed.


        // Ledger resolution happens INSIDE the transaction (see below) to avoid snapshot isolation FK violations


        const companyRec = await prisma.company.findUnique({
            where: { id: parseInt(companyId) },
            select: { state: true, inventoryConfig: true }
        });
        const compStateStr = (companyRec?.state || '').toLowerCase().trim();
        const custStateStr = (req.body.billingState || customer?.billingState || '').toLowerCase().trim();
        const isInterState = Boolean(compStateStr && custStateStr && compStateStr !== custStateStr);

        let defaultWhId = req.body.warehouseId ? parseInt(req.body.warehouseId) : null;
        if (!defaultWhId) {
            let cfg = {};
            try {
                cfg = typeof companyRec?.inventoryConfig === 'string' ? JSON.parse(companyRec.inventoryConfig) : (companyRec?.inventoryConfig || {});
            } catch (e) { }
            if (cfg.defaultSalesWarehouseId) defaultWhId = parseInt(cfg.defaultSalesWarehouseId);
        }
        if (!defaultWhId) {
            const firstWh = await prisma.warehouse.findFirst({ where: { companyId: parseInt(companyId) } });
            if (firstWh) defaultWhId = firstWh.id;
        }

        let subtotal = 0;
        let lineDiscountSum = 0;

        // 1. Calculate line gross and line-level discounts
        items.forEach(item => {
            const itemQty = parseFloat(item.quantity) || 0;
            const itemRate = parseFloat(item.rate) || 0;
            const itemDiscount = parseFloat(item.discount) || 0;
            const lineGross = itemQty * itemRate;

            subtotal += lineGross;
            lineDiscountSum += Math.min(lineGross, itemDiscount);
        });

        const netBeforeOverall = Math.max(0, subtotal - lineDiscountSum);

        // 2. Compute overall discount on pre-tax net taxable amount
        let overallDiscountAmt = 0;
        const ovVal = parseFloat(overallDiscount) || 0;
        if (overallDiscount && overallDiscountType === 'percentage') {
            overallDiscountAmt = (netBeforeOverall * Math.min(100, Math.max(0, ovVal))) / 100;
        } else if (overallDiscount) {
            overallDiscountAmt = Math.min(netBeforeOverall, Math.max(0, ovVal));
        }

        const totalDiscount = lineDiscountSum + overallDiscountAmt;
        const discountedTaxableAmount = Math.max(0, subtotal - totalDiscount);

        // 3. Proportionately calculate tax on discounted taxable amount per line
        const overallDiscountRatio = netBeforeOverall > 0 ? (overallDiscountAmt / netBeforeOverall) : 0;
        let lineTaxSum = 0;

        const invoiceItems = items.map(item => {
            const itemQty = parseFloat(item.quantity) || 0;
            const itemRate = parseFloat(item.rate) || 0;
            const itemDiscount = parseFloat(item.discount) || 0;
            const itemTaxRate = parseFloat(item.taxRate) || 0;

            const lineGross = itemQty * itemRate;
            const lineAfterItemDisc = Math.max(0, lineGross - itemDiscount);
            const lineDiscountedTaxable = lineAfterItemDisc * (1 - overallDiscountRatio);
            const lineTax = itemTaxRate > 0 ? (lineDiscountedTaxable * itemTaxRate) / 100 : 0;
            const lineDiscountedAmount = Number(lineDiscountedTaxable.toFixed(2));

            let cgstRate = 0, sgstRate = 0, igstRate = 0;
            let cgstAmount = 0, sgstAmount = 0, igstAmount = 0;
            if (itemTaxRate > 0) {
                if (isInterState) {
                    igstRate = itemTaxRate;
                    igstAmount = lineTax;
                } else {
                    cgstRate = itemTaxRate / 2;
                    sgstRate = itemTaxRate / 2;
                    cgstAmount = lineTax / 2;
                    sgstAmount = lineTax / 2;
                }
            }

            lineTaxSum += lineTax;

            return {
                productId: item.productId ? parseInt(item.productId) : null,
                serviceId: item.serviceId ? parseInt(item.serviceId) : null,
                description: item.description || 'Sales Item',
                quantity: itemQty,
                rate: itemRate,
                discount: itemDiscount,
                amount: lineDiscountedAmount,
                taxRate: itemTaxRate,
                cgstRate,
                sgstRate,
                igstRate,
                cgstAmount,
                sgstAmount,
                igstAmount,
                warehouseId: item.warehouseId ? parseInt(item.warehouseId) : defaultWhId,
                uomId: item.uomId ? parseInt(item.uomId) : null
            };
        });

        const finalTax = lineTaxSum;
        let totalAmount = discountedTaxableAmount + finalTax;

        // Calculate Other Charges and Round Off
        const otherChargesArr = Array.isArray(req.body.otherCharges) ? req.body.otherCharges : [];
        const otherChargesTotal = otherChargesArr.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);
        const roundOffVal = parseFloat(req.body.roundOffAmount || req.body.roundOff || 0);
        totalAmount = totalAmount + otherChargesTotal + roundOffVal;

        const result = await prisma.$transaction(async (tx) => {

            // Resolve Standard Ledgers inside tx to avoid snapshot isolation FK issues
            const resolveLedger = async (namePattern, type) => {
                let ledger = await tx.ledger.findFirst({
                    where: { companyId: parseInt(companyId), name: { contains: namePattern } }
                });
                if (!ledger) {
                    const group = await tx.accountgroup.findFirst({ where: { companyId: parseInt(companyId), type: type } });
                    if (group) {
                        ledger = await tx.ledger.create({
                            data: {
                                name: namePattern,
                                groupId: group.id,
                                companyId: parseInt(companyId),
                                isControlAccount: true
                            }
                        });
                    }
                }
                return ledger;
            };

            const salesLedger = await resolveLedger('Sales Income', 'INCOME');
            const cogsLedger = await resolveLedger('Cost of Goods Sold', 'EXPENSES');
            const inventoryLedger = await resolveLedger('Inventory Asset', 'ASSETS');
            const purchaseLedger = await resolveLedger('Purchases', 'EXPENSES') || await resolveLedger('Purchase', 'EXPENSES');
            const taxLedger = await resolveLedger('Tax', 'LIABILITIES');
            const discountAllowedLedger = await resolveLedger('Discount Allowed on Sale', 'EXPENSES');

            if (!salesLedger) throw new Error('Could not resolve or create Sales Income ledger');

            // A. Create Invoice
            const invoice = await tx.invoice.create({
                data: {
                    customFields: req.body.customFields ? (typeof req.body.customFields === 'string' ? req.body.customFields : JSON.stringify(req.body.customFields)) : null,
                    salespersonId: req.body.salespersonId ? parseInt(req.body.salespersonId) : null,
                    carNumber: req.body.carNumber || null,
                    invoiceNumber,
                    manualReference,
                    date: new Date(date),
                    dueDate: dueDate ? new Date(dueDate) : null,
                    customerId: parseInt(customerId),
                    companyId: parseInt(companyId),
                    salesOrderId: salesOrderId ? parseInt(salesOrderId) : null,
                    deliveryChallanId: deliveryChallanId ? parseInt(deliveryChallanId) : null,
                    subtotal,
                    discountAmount: totalDiscount,
                    taxAmount: finalTax,
                    roundOffAmount: roundOffVal,
                    totalAmount,
                    balanceAmount: totalAmount,
                    currency: docCurrency,
                    exchangeRate: docExchangeRate,
                    notes,
                    manualStatus: manualStatus === true || manualStatus === 'true',
                    status: (manualStatus === true || manualStatus === 'true') && status ? status : 'UNPAID',
                    overallDiscount: parseFloat(overallDiscount) || 0,
                    overallDiscountType: overallDiscountType || 'percentage',
                    billingName: req.body.billingName,
                    billingAddress: req.body.billingAddress,
                    billingCity: req.body.billingCity,
                    billingState: req.body.billingState,
                    billingZipCode: billingZipCode,
                    billingCountry: billingCountry,
                    shippingName: shippingName,
                    shippingAddress: shippingAddress,
                    shippingCity: shippingCity,
                    shippingState: shippingState,
                    shippingZipCode: shippingZipCode,
                    shippingCountry: shippingCountry,
                    invoiceitem: {
                        create: invoiceItems.map(i => ({
                            productId: i.productId,
                            serviceId: i.serviceId,
                            description: i.description,
                            quantity: i.quantity,
                            rate: i.rate,
                            discount: i.discount,
                            amount: i.amount,
                            taxRate: i.taxRate,
                            cgstRate: i.cgstRate,
                            sgstRate: i.sgstRate,
                            igstRate: i.igstRate,
                            cgstAmount: i.cgstAmount,
                            sgstAmount: i.sgstAmount,
                            igstAmount: i.igstAmount,
                            warehouseId: i.warehouseId,
                            uomId: i.uomId
                        }))
                    }
                }
            });

            // Process Advance Adjustments if provided
            let totalAdjustedAmount = 0;
            let totalAdvanceApplied = 0;

            let advanceReceiptsToProcess = [];
            if (req.body.adjustments && req.body.adjustments.length > 0) {
                advanceReceiptsToProcess = req.body.adjustments;
            } else if (req.body.applyAdvance === true || parseFloat(req.body.appliedAdvanceAmount) > 0) {
                const openReceipts = await tx.receipt.findMany({
                    where: {
                        customerId: parseInt(customerId),
                        companyId: parseInt(companyId),
                        advanceUnallocated: { gt: 0 }
                    },
                    orderBy: { date: 'asc' }
                });
                let reqAmt = parseFloat(req.body.appliedAdvanceAmount) || totalAmount;
                for (const r of openReceipts) {
                    if (reqAmt <= 0) break;
                    const alloc = Math.min(r.advanceUnallocated, reqAmt);
                    advanceReceiptsToProcess.push({ receiptId: r.id, amount: alloc });
                    reqAmt -= alloc;
                }
            }

            for (const adj of advanceReceiptsToProcess) {
                const receipt = await tx.receipt.findUnique({
                    where: { id: parseInt(adj.receiptId) }
                });
                if (receipt) {
                    const availableUnallocated = receipt.advanceUnallocated > 0
                        ? receipt.advanceUnallocated
                        : Math.max(0, receipt.amount - (await tx.receiptinvoiceallocation.aggregate({ _sum: { amount: true }, where: { receiptId: receipt.id } }))._sum.amount || 0);

                    const adjustAmt = Math.min(parseFloat(adj.amount), availableUnallocated, Math.max(0, totalAmount - totalAdjustedAmount));

                    if (adjustAmt > 0) {
                        // Create allocation record
                        await tx.receiptinvoiceallocation.create({
                            data: {
                                receiptId: receipt.id,
                                invoiceId: invoice.id,
                                amount: adjustAmt,
                                companyId: parseInt(companyId)
                            }
                        });
                        // Create advanceadjustment model record
                        await tx.advanceadjustment.create({
                            data: {
                                companyId: parseInt(companyId),
                                partyType: 'CUSTOMER',
                                partyId: parseInt(customerId),
                                receiptId: receipt.id,
                                invoiceId: invoice.id,
                                amount: adjustAmt
                            }
                        });
                        // Update receipt unallocated balance
                        await tx.receipt.update({
                            where: { id: receipt.id },
                            data: {
                                advanceUnallocated: Math.max(0, (receipt.advanceUnallocated || availableUnallocated) - adjustAmt)
                            }
                        });
                        totalAdjustedAmount += adjustAmt;
                        totalAdvanceApplied += adjustAmt;
                    }
                }
            }

            if (totalAdjustedAmount > 0) {
                const finalPaid = totalAdjustedAmount;
                const finalBalance = Math.max(0, totalAmount - finalPaid);
                const finalStatus = (manualStatus === true || manualStatus === 'true') && status
                    ? status
                    : (finalBalance <= 0.01 ? 'PAID' : (isDuePassed(dueDate) ? 'OVERDUE' : (finalPaid > 0 ? 'PARTIAL' : 'UNPAID')));
                await tx.invoice.update({
                    where: { id: invoice.id },
                    data: {
                        paidAmount: finalPaid,
                        appliedAdvanceAmount: totalAdvanceApplied,
                        balanceAmount: finalBalance,
                        status: finalStatus
                    }
                });
                invoice.paidAmount = finalPaid;
                invoice.appliedAdvanceAmount = totalAdvanceApplied;
                invoice.balanceAmount = finalBalance;
                invoice.status = finalStatus;
            }

            // B. Inventory OUT Logic
            const company = await tx.company.findUnique({ where: { id: parseInt(companyId) } });
            let config = {};
            try {
                config = company?.inventoryConfig
                    ? (typeof company.inventoryConfig === 'string' ? JSON.parse(company.inventoryConfig) : company.inventoryConfig)
                    : {};
            } catch (e) { config = {}; }

            const { convertToBaseQuantity } = require('../services/uomConversionService');

            if (deliveryChallanId) {
                // Invoiced from Challan
                const challan = await tx.deliverychallan.findUnique({
                    where: { id: parseInt(deliveryChallanId) },
                    include: { deliverychallanitem: true }
                });

                if (challan) {
                    await tx.deliverychallan.update({
                        where: { id: challan.id },
                        data: { status: 'DELIVERED' } // Marks as completed
                    });

                    // Create a map of challan items and their quantities (in base UOM)
                    const challanQtyMap = {};
                    for (const cItem of challan.deliverychallanitem) {
                        if (cItem.productId && cItem.warehouseId) {
                            const prod = await tx.product.findUnique({
                                where: { id: cItem.productId },
                                include: { uom: true }
                            });
                            const transUom = cItem.uomId ? await tx.uom.findUnique({ where: { id: cItem.uomId } }) : null;
                            const baseQty = convertToBaseQuantity(cItem.quantity, transUom, prod?.uom);
                            const key = `${cItem.productId}_${cItem.warehouseId}`;
                            challanQtyMap[key] = (challanQtyMap[key] || 0) + baseQty;
                        }
                    }

                    for (const item of invoiceItems) {
                        if (item.productId && item.warehouseId) {
                            const prod = await tx.product.findUnique({
                                where: { id: item.productId },
                                include: { uom: true }
                            });
                            const transUom = item.uomId ? await tx.uom.findUnique({ where: { id: item.uomId } }) : null;
                            const invBaseQty = convertToBaseQuantity(item.quantity, transUom, prod?.uom);

                            const key = `${item.productId}_${item.warehouseId}`;
                            const challanHandledQty = challanQtyMap[key] || 0;

                            if (config.challanAction === 'RESERVE') {
                                // Clear reservation for the portion that was in challan
                                const qtyToClear = Math.min(invBaseQty, challanHandledQty);
                                if (qtyToClear > 0) {
                                    await tx.stock.upsert({
                                        where: { warehouseId_productId: { warehouseId: item.warehouseId, productId: item.productId } },
                                        create: { warehouseId: item.warehouseId, productId: item.productId, reservedQuantity: -qtyToClear, quantity: -qtyToClear, initialQty: 0, minOrderQty: 0 },
                                        update: { reservedQuantity: { decrement: qtyToClear }, quantity: { decrement: qtyToClear } }
                                    });
                                }

                                // The remaining 'extra' quantity directly ISSUED (decremented) from stock
                                const extraQty = invBaseQty - qtyToClear;
                                if (extraQty > 0) {
                                    await tx.stock.upsert({
                                        where: { warehouseId_productId: { warehouseId: item.warehouseId, productId: item.productId } },
                                        create: { warehouseId: item.warehouseId, productId: item.productId, quantity: -extraQty, initialQty: 0, minOrderQty: 0 },
                                        update: { quantity: { decrement: extraQty } }
                                    });
                                }

                                challanQtyMap[key] -= qtyToClear;

                                await tx.inventorytransaction.create({
                                    data: {
                                        type: 'SALE', productId: item.productId, fromWarehouseId: item.warehouseId,
                                        quantity: invBaseQty, reason: `Invoice from Reserved Challan: ${invoiceNumber}`,
                                        companyId: parseInt(companyId), userId: req.user?.userId || null
                                    }
                                });
                            } else if (config.challanAction === 'ISSUE') {
                                // Issue only EXTRA stock
                                const extraQty = Math.max(0, invBaseQty - challanHandledQty);
                                if (extraQty > 0) {
                                    await tx.stock.upsert({
                                        where: { warehouseId_productId: { warehouseId: item.warehouseId, productId: item.productId } },
                                        create: { warehouseId: item.warehouseId, productId: item.productId, quantity: -extraQty, initialQty: 0, minOrderQty: 0 },
                                        update: { quantity: { decrement: extraQty } }
                                    });
                                    await tx.inventorytransaction.create({
                                        data: {
                                            type: 'SALE', productId: item.productId, fromWarehouseId: item.warehouseId,
                                            quantity: extraQty, reason: `Extra items in Invoice from Challan: ${invoiceNumber}`,
                                            companyId: parseInt(companyId), userId: req.user?.userId || null
                                        }
                                    });
                                }
                                challanQtyMap[key] = Math.max(0, challanHandledQty - invBaseQty);
                            }
                        }
                    }
                }
            } else if (salesOrderId) {
                // Invoiced from SO (Directly)
                const so = await tx.salesorder.findUnique({
                    where: { id: parseInt(salesOrderId) },
                    include: { salesorderitem: true }
                });

                if (so) {
                    await tx.salesorder.update({
                        where: { id: so.id },
                        data: { status: 'COMPLETED' }
                    });

                    for (const item of invoiceItems) {
                        if (item.productId && item.warehouseId) {
                            const prod = await tx.product.findUnique({
                                where: { id: item.productId },
                                include: { uom: true }
                            });
                            const transUom = item.uomId ? await tx.uom.findUnique({ where: { id: item.uomId } }) : null;
                            const baseQty = convertToBaseQuantity(item.quantity, transUom, prod?.uom);

                            // 1. Clear SO Reservation if it was active
                            if (config.reserveOnSO) {
                                await tx.stock.upsert({
                                    where: { warehouseId_productId: { warehouseId: item.warehouseId, productId: item.productId } },
                                    create: {
                                        warehouseId: item.warehouseId,
                                        productId: item.productId,
                                        reservedQuantity: -baseQty,
                                        quantity: 0,
                                        initialQty: 0,
                                        minOrderQty: 0
                                    },
                                    update: {
                                        reservedQuantity: { decrement: baseQty }
                                    }
                                });
                            }

                            // 2. Decrement Stock
                            await tx.stock.upsert({
                                where: { warehouseId_productId: { warehouseId: item.warehouseId, productId: item.productId } },
                                create: {
                                    warehouseId: item.warehouseId,
                                    productId: item.productId,
                                    quantity: -baseQty,
                                    initialQty: 0,
                                    minOrderQty: 0
                                },
                                update: {
                                    quantity: { decrement: baseQty }
                                }
                            });

                            // 3. Log Transaction
                            await tx.inventorytransaction.create({
                                data: {
                                    type: 'SALE',
                                    productId: item.productId,
                                    fromWarehouseId: item.warehouseId,
                                    quantity: baseQty,
                                    reason: `Invoice from SO: ${invoiceNumber}`,
                                    companyId: parseInt(companyId),
                                    userId: req.user?.userId || null
                                }
                            });
                        }
                    }
                }
            } else {
                // Direct Invoice
                for (const item of invoiceItems) {
                    const targetWh = item.warehouseId || defaultWhId;
                    if (item.productId && targetWh) {
                        const prod = await tx.product.findUnique({
                            where: { id: item.productId },
                            include: { uom: true }
                        });
                        const transUom = item.uomId ? await tx.uom.findUnique({ where: { id: item.uomId } }) : null;
                        const baseQty = convertToBaseQuantity(item.quantity, transUom, prod?.uom);

                        await tx.stock.upsert({
                            where: { warehouseId_productId: { warehouseId: targetWh, productId: item.productId } },
                            create: {
                                warehouseId: targetWh,
                                productId: item.productId,
                                quantity: -baseQty,
                                initialQty: 0,
                                minOrderQty: 0
                            },
                            update: {
                                quantity: { decrement: baseQty }
                            }
                        });

                        await tx.inventorytransaction.create({
                            data: {
                                type: 'SALE',
                                productId: item.productId,
                                fromWarehouseId: targetWh,
                                companyId: parseInt(companyId),
                                quantity: baseQty,
                                userId: req.user?.userId || null,
                                reason: `Direct Invoice: ${invoiceNumber}`
                            }
                        });
                    }
                }
            }

            // C. Accounting Entries (Double Entry)
            const ledgerTotalAmount = totalAmount * docExchangeRate;
            const ledgerSubtotal = subtotal * docExchangeRate;  // Gross before discount
            const ledgerTax = finalTax * docExchangeRate;
            const currentBaseTotal = (subtotal - totalDiscount) + finalTax;
            const overallDiscountAmt = overallDiscountType === 'percentage'
                ? (currentBaseTotal * (parseFloat(overallDiscount) || 0) / 100)
                : (parseFloat(overallDiscount) || 0);
            const ledgerDiscountAmount = (totalDiscount + overallDiscountAmt) * docExchangeRate;

            // Resolve customer's actual ledger ID inside the transaction
            // This self-heals orphaned ledgerId (ledger was deleted but customer still references old ID)
            let customerLedgerId = customer.ledgerId;
            if (customerLedgerId) {
                const existingLedger = await tx.ledger.findUnique({ where: { id: customerLedgerId } });
                if (!existingLedger) {
                    // Ledger was deleted — create a new one and re-link customer
                    const arGroup = await tx.accountgroup.findFirst({ where: { companyId: parseInt(companyId), type: 'ASSETS' } });
                    if (!arGroup) throw new Error('No ASSETS account group found. Please initialize Chart of Accounts first.');
                    const newLedger = await tx.ledger.create({
                        data: {
                            name: `${customer.name} (Receivable)`,
                            groupId: arGroup.id,
                            companyId: parseInt(companyId),
                            isControlAccount: false
                        }
                    });
                    customerLedgerId = newLedger.id;
                    await tx.customer.update({
                        where: { id: customer.id },
                        data: { ledgerId: customerLedgerId }
                    });
                }
            } else {
                // No ledgerId at all — create one now
                const arGroup = await tx.accountgroup.findFirst({ where: { companyId: parseInt(companyId), type: 'ASSETS' } });
                if (!arGroup) throw new Error('No ASSETS account group found. Please initialize Chart of Accounts first.');
                const newLedger = await tx.ledger.create({
                    data: {
                        name: `${customer.name} (Receivable)`,
                        groupId: arGroup.id,
                        companyId: parseInt(companyId),
                        isControlAccount: false
                    }
                });
                customerLedgerId = newLedger.id;
                await tx.customer.update({
                    where: { id: customer.id },
                    data: { ledgerId: customerLedgerId }
                });
            }

            // 1. DR Customer (Gross = subtotal + tax), CR Sales Income (gross subtotal)
            //    Then: DR Discount Allowed on Sale, CR Customer (net the discount)
            //    Net Customer Balance = totalAmount = subtotal - discount + tax
            const ledgerGrossCustomer = (subtotal + finalTax) * docExchangeRate; // full gross before discount

            const journal = await tx.journalentry.create({
                data: {
                    voucherNumber: invoiceNumber,
                    date: new Date(date),
                    narration: `Sales Invoice: ${invoiceNumber}`,
                    companyId: parseInt(companyId)
                }
            });

            // Entry 1: DR Customer, CR Sales Income (Revenue portion)
            await tx.transaction.create({
                data: {
                    date: new Date(date),
                    voucherType: 'SALES',
                    voucherNumber: invoiceNumber,
                    debitLedgerId: customerLedgerId,
                    creditLedgerId: salesLedger.id,
                    amount: ledgerSubtotal,
                    narration: `Sales to ${customer.name}`,
                    companyId: parseInt(companyId),
                    journalEntryId: journal.id,
                    invoiceId: invoice.id
                }
            });

            // Update Customer Ledger (Asset Increases with Debit - revenue portion)
            await tx.ledger.update({
                where: { id: customerLedgerId },
                data: { currentBalance: { increment: ledgerSubtotal } }
            });

            // Update Sales Ledger (Income Increases with Credit - revenue portion)
            await tx.ledger.update({
                where: { id: salesLedger.id },
                data: { currentBalance: { increment: ledgerSubtotal } }
            });

            // 2. Handle Tax (DR Customer, CR CGST/SGST/IGST Output or Tax Payable)
            if (finalTax > 0) {
                const totalCGST = invoiceItems.reduce((s, i) => s + (i.cgstAmount || 0), 0);
                const totalSGST = invoiceItems.reduce((s, i) => s + (i.sgstAmount || 0), 0);
                const totalIGST = invoiceItems.reduce((s, i) => s + (i.igstAmount || 0), 0);

                const cgstLedger = (totalCGST > 0) ? (await resolveLedger('CGST Output', 'LIABILITIES') || await resolveLedger('CGST Payable', 'LIABILITIES') || taxLedger) : null;
                const sgstLedger = (totalSGST > 0) ? (await resolveLedger('SGST Output', 'LIABILITIES') || await resolveLedger('SGST Payable', 'LIABILITIES') || taxLedger) : null;
                const igstLedger = (totalIGST > 0) ? (await resolveLedger('IGST Output', 'LIABILITIES') || await resolveLedger('IGST Payable', 'LIABILITIES') || taxLedger) : null;

                const postSalesTaxEntry = async (targetLedger, taxAmt, taxName) => {
                    const convertedTaxAmt = taxAmt * docExchangeRate;
                    if (convertedTaxAmt <= 0 || !targetLedger) return;
                    await tx.transaction.create({
                        data: {
                            date: new Date(date),
                            voucherType: 'SALES',
                            voucherNumber: invoiceNumber,
                            debitLedgerId: customerLedgerId,
                            creditLedgerId: targetLedger.id,
                            amount: convertedTaxAmt,
                            narration: `${taxName} on Sale: ${invoiceNumber}`,
                            companyId: parseInt(companyId),
                            journalEntryId: journal.id,
                            invoiceId: invoice.id
                        }
                    });

                    // Customer receivable increases by tax amount
                    await tx.ledger.update({
                        where: { id: customerLedgerId },
                        data: { currentBalance: { increment: convertedTaxAmt } }
                    });

                    // Tax Liability increases by tax amount
                    await tx.ledger.update({
                        where: { id: targetLedger.id },
                        data: { currentBalance: { increment: convertedTaxAmt } }
                    });
                };

                if (totalCGST > 0 || totalSGST > 0 || totalIGST > 0) {
                    if (totalCGST > 0) await postSalesTaxEntry(cgstLedger, totalCGST, 'CGST Output');
                    if (totalSGST > 0) await postSalesTaxEntry(sgstLedger, totalSGST, 'SGST Output');
                    if (totalIGST > 0) await postSalesTaxEntry(igstLedger, totalIGST, 'IGST Output');
                } else if (taxLedger) {
                    await postSalesTaxEntry(taxLedger, finalTax, 'Tax');
                }
            }

            // 3. Handle Discount Allowed on Sale
            //    DR Discount Allowed on Sale (Expense), CR Customer (reduces receivable)
            if (ledgerDiscountAmount > 0 && discountAllowedLedger) {
                await tx.transaction.create({
                    data: {
                        date: new Date(date),
                        voucherType: 'SALES',
                        voucherNumber: invoiceNumber,
                        debitLedgerId: discountAllowedLedger.id,   // Expense increases with Debit
                        creditLedgerId: customerLedgerId,           // Customer (receivable decreases with Credit)
                        amount: ledgerDiscountAmount,
                        narration: `Discount Allowed on Sale: ${invoiceNumber}`,
                        companyId: parseInt(companyId),
                        journalEntryId: journal.id,
                        invoiceId: invoice.id
                    }
                });

                // Discount Allowed Expense increases (Debit)
                await tx.ledger.update({
                    where: { id: discountAllowedLedger.id },
                    data: { currentBalance: { increment: ledgerDiscountAmount } }
                });

                // Customer receivable decreases (Credit reduces the gross debit)
                await tx.ledger.update({
                    where: { id: customerLedgerId },
                    data: { currentBalance: { decrement: ledgerDiscountAmount } }
                });
            }

            // 4. Handle Round Off Accounting Entry
            if (Math.abs(roundOffVal) > 0.001) {
                const roundOffLedger = await resolveLedger('Round Off', 'EXPENSES') || await resolveLedger('Round-off', 'EXPENSES') || await resolveLedger('Round Off', 'INCOME');
                if (roundOffLedger) {
                    const convertedRoundOff = Math.abs(roundOffVal) * docExchangeRate;
                    if (roundOffVal > 0) {
                        // Rounding Up (+): DR Customer (Receivable +), CR Round Off (Income +)
                        await tx.transaction.create({
                            data: {
                                date: new Date(date),
                                voucherType: 'SALES',
                                voucherNumber: invoiceNumber,
                                debitLedgerId: customerLedgerId,
                                creditLedgerId: roundOffLedger.id,
                                amount: convertedRoundOff,
                                narration: `Round-off on Sale: ${invoiceNumber}`,
                                companyId: parseInt(companyId),
                                journalEntryId: journal.id,
                                invoiceId: invoice.id
                            }
                        });
                        await tx.ledger.update({
                            where: { id: customerLedgerId },
                            data: { currentBalance: { increment: convertedRoundOff } }
                        });
                        await tx.ledger.update({
                            where: { id: roundOffLedger.id },
                            data: { currentBalance: { increment: convertedRoundOff } }
                        });
                    } else {
                        // Rounding Down (-): DR Round Off (Expense +), CR Customer (Receivable -)
                        await tx.transaction.create({
                            data: {
                                date: new Date(date),
                                voucherType: 'SALES',
                                voucherNumber: invoiceNumber,
                                debitLedgerId: roundOffLedger.id,
                                creditLedgerId: customerLedgerId,
                                amount: convertedRoundOff,
                                narration: `Round-off on Sale: ${invoiceNumber}`,
                                companyId: parseInt(companyId),
                                journalEntryId: journal.id,
                                invoiceId: invoice.id
                            }
                        });
                        await tx.ledger.update({
                            where: { id: roundOffLedger.id },
                            data: { currentBalance: { increment: convertedRoundOff } }
                        });
                        await tx.ledger.update({
                            where: { id: customerLedgerId },
                            data: { currentBalance: { decrement: convertedRoundOff } }
                        });
                    }
                }
            }

            // 3. COGS using Inventory Valuation Method (FIFO or WAC)
            const invConfig = await getInventoryConfig(companyId);
            const valuationMethod = invConfig.valuationMethod || 'WAC';
            const autoCogsEntry = invConfig.autoCogsEntry !== false; // default ON
            const negativeStockAllow = invConfig.negativeStockAllow !== false; // default ON

            let totalCOGS = 0;
            for (const item of invoiceItems) {
                if (item.productId) {
                    // Auto-resolve warehouse if not provided: find first warehouse with stock/batch for this product
                    let resolvedWarehouseId = item.warehouseId;
                    if (!resolvedWarehouseId) {
                        // Try FIFO batch first
                        const firstBatch = await tx.inventory_batch.findFirst({
                            where: { productId: parseInt(item.productId), qtyRemaining: { gt: 0 } },
                            orderBy: { createdAt: 'asc' },
                            select: { warehouseId: true }
                        });
                        if (firstBatch) {
                            resolvedWarehouseId = firstBatch.warehouseId;
                        } else {
                            // Fallback: try stock table
                            const firstStock = await tx.stock.findFirst({
                                where: { productId: parseInt(item.productId), quantity: { gt: 0 } },
                                orderBy: { quantity: 'desc' },
                                select: { warehouseId: true }
                            });
                            if (firstStock) {
                                resolvedWarehouseId = firstStock.warehouseId;
                            }
                        }
                    }

                    const prod = await tx.product.findUnique({
                        where: { id: item.productId },
                        include: { uom: true }
                    });
                    const transUom = item.uomId ? await tx.uom.findUnique({ where: { id: item.uomId } }) : null;
                    const baseQty = convertToBaseQuantity(item.quantity, transUom, prod?.uom);

                    if (resolvedWarehouseId) {
                        // Also update stock deduction if original warehouseId was missing
                        if (!item.warehouseId) {
                            await tx.stock.upsert({
                                where: { warehouseId_productId: { warehouseId: resolvedWarehouseId, productId: parseInt(item.productId) } },
                                create: {
                                    warehouseId: resolvedWarehouseId,
                                    productId: parseInt(item.productId),
                                    quantity: -baseQty,
                                    initialQty: 0,
                                    minOrderQty: 0
                                },
                                update: {
                                    quantity: { decrement: baseQty }
                                }
                            });
                        }

                        const itemCOGS = await consumeStock(tx, {
                            companyId,
                            productId: item.productId,
                            warehouseId: resolvedWarehouseId,
                            quantity: baseQty,
                            invoiceId: invoice.id,
                            method: valuationMethod,
                            negativeStockAllow
                        });
                        totalCOGS += itemCOGS;
                    } else {
                        // No warehouse at all: still calculate WAC COGS from product averageCost
                        const cost = parseFloat(prod?.averageCost || prod?.purchasePrice || prod?.initialCost || 0);
                        totalCOGS += cost * baseQty;
                    }
                }
            }

            const finalCreditLedger = inventoryLedger || purchaseLedger;
            if (autoCogsEntry && totalCOGS > 0 && cogsLedger && finalCreditLedger) {
                await tx.transaction.create({
                    data: {
                        date: new Date(date),
                        voucherType: 'JOURNAL',
                        voucherNumber: `COGS-${invoiceNumber}`,
                        debitLedgerId: cogsLedger.id,
                        creditLedgerId: finalCreditLedger.id,
                        amount: totalCOGS,
                        narration: `COGS for Invoice: ${invoiceNumber}`,
                        companyId: parseInt(companyId),
                        journalEntryId: journal.id,
                        invoiceId: invoice.id
                    }
                });

                await tx.ledger.update({ where: { id: cogsLedger.id }, data: { currentBalance: { increment: totalCOGS } } });
                await tx.ledger.update({ where: { id: finalCreditLedger.id }, data: { currentBalance: { decrement: totalCOGS } } });
            }


            // Update Sales Order status if fully invoiced (guarded to prevent duplicate writes)
            if (salesOrderId) {
                await syncSalesOrderStatus(tx, salesOrderId);
            }

            // D. Other Charges — double-entry per charge (DR Customer / CR selected ledger)
            if (otherChargesArr.length > 0) {
                for (const charge of otherChargesArr) {
                    const chargeAmount = parseFloat(charge.amount) || 0;
                    if (!charge.accountId || chargeAmount <= 0) continue;

                    const chargeLedger = await tx.ledger.findUnique({
                        where: { id: parseInt(charge.accountId) }
                    });

                    if (!chargeLedger) continue;

                    const chargeAmtConverted = chargeAmount * docExchangeRate;

                    await tx.transaction.create({
                        data: {
                            date: new Date(date),
                            voucherType: 'SALES',
                            voucherNumber: invoiceNumber,
                            debitLedgerId: customerLedgerId,
                            creditLedgerId: chargeLedger.id,
                            amount: chargeAmtConverted,
                            narration: `Other Charges (${chargeLedger.name}) on Invoice: ${invoiceNumber}`,
                            companyId: parseInt(companyId),
                            journalEntryId: journal.id,
                            invoiceId: invoice.id
                        }
                    });

                    // Customer receivable increases (DR)
                    await tx.ledger.update({
                        where: { id: customerLedgerId },
                        data: { currentBalance: { increment: chargeAmtConverted } }
                    });
                    // Selected account increases (CR)
                    await tx.ledger.update({
                        where: { id: chargeLedger.id },
                        data: { currentBalance: { increment: chargeAmtConverted } }
                    });
                }
            }

            return invoice;
        }, {
            timeout: 90000 // 90 seconds timeout
        });

        await numberingService.incrementNumber(companyId, 'invoice', invoiceNumber);
        const { logInvoiceCreated } = require('../utils/invoiceAuditHelper');
        await logInvoiceCreated(req, result, invoiceItems || items);
        res.status(201).json({ success: true, data: result });
    } catch (error) {
        console.error('Invoice Creation Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Get All Invoices
const getInvoices = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID Missing' });

        const [invoices, posInvoices, posReturns] = await Promise.all([
            prisma.invoice.findMany({
                where: { companyId: parseInt(companyId) },
                include: {
                    customer: true,
                    salesperson: true,
                    invoiceitem: {
                        include: {
                            product: true,
                            service: true,
                            warehouse: true,
                            uom: true
                        }
                    },
                    salesorder: true,
                    deliverychallan: true,
                    salesreturn: {
                        include: {
                            salesreturnitem: true
                        }
                    },
                    receipt: {
                        include: {
                            cashBankAccount: { select: { id: true, name: true } },
                            transaction: true
                        }
                    },
                    allocations: {
                        include: {
                            receipt: {
                                include: {
                                    cashBankAccount: { select: { id: true, name: true } },
                                    transaction: true
                                }
                            }
                        }
                    }
                },
                orderBy: { createdAt: 'desc' }
            }),
            prisma.posinvoice.findMany({
                where: { companyId: parseInt(companyId) },
                include: {
                    customer: true,
                    posinvoiceitem: {
                        include: { product: true, warehouse: true }
                    },
                    transaction: {
                        include: {
                            ledger_transaction_debitLedgerIdToledger: { select: { id: true, name: true } }
                        }
                    }
                },
                orderBy: { createdAt: 'desc' }
            }),
            prisma.salesreturn.findMany({
                where: { companyId: parseInt(companyId), invoiceId: null },
                include: { salesreturnitem: true }
            })
        ]);

        // Merge POS invoices into the unified list
        const unifiedInvoices = [
            ...invoices.map(inv => {
                // Map allocations to receipt list to maintain compatibility and show correct allocated amount
                const mappedReceipts = [
                    ...inv.receipt.map(r => {
                        const baseAmount = r.transaction?.filter(t => t.debitLedgerId === r.cashBankAccountId).reduce((sum, t) => sum + t.amount, 0) || r.amount;
                        return {
                            ...r,
                            baseAmount
                        };
                    }),
                    ...inv.allocations.map(alloc => {
                        const r = alloc.receipt;
                        const baseAmount = r.transaction?.filter(t => t.debitLedgerId === r.cashBankAccountId).reduce((sum, t) => sum + t.amount, 0) || r.amount;
                        const baseAllocAmount = r.amount > 0 ? alloc.amount * (baseAmount / r.amount) : alloc.amount;
                        return {
                            id: r.id,
                            receiptNumber: r.receiptNumber,
                            date: r.date,
                            amount: alloc.amount, // Only the allocated amount
                            baseAmount: baseAllocAmount,
                            paymentMode: r.paymentMode,
                            referenceNumber: r.referenceNumber,
                            cashBankAccount: r.cashBankAccount,
                            notes: r.notes
                        };
                    })
                ];

                const seenIds = new Set();
                const deduplicatedReceipts = [];
                for (const r of mappedReceipts) {
                    if (!seenIds.has(r.id)) {
                        seenIds.add(r.id);
                        deduplicatedReceipts.push(r);
                    }
                }

                return adjustInvoiceWithReturns({
                    ...inv,
                    type: 'TAX_INVOICE',
                    receipt: deduplicatedReceipts
                });
            }),
            ...posInvoices.map(pos => {
                const receiptTransactions = pos.transaction?.filter(t => t.voucherType === 'RECEIPT') || [];
                const mappedReceipts = receiptTransactions.map(t => ({
                    id: t.id,
                    receiptNumber: t.voucherNumber || '-',
                    date: t.date,
                    amount: t.amount,
                    cashBankAccount: t.ledger_transaction_debitLedgerIdToledger ? {
                        id: t.ledger_transaction_debitLedgerIdToledger.id,
                        name: t.ledger_transaction_debitLedgerIdToledger.name
                    } : null
                }));

                const associatedReturns = posReturns.filter(ret => {
                    if (ret.customFields) {
                        try {
                            const parsedCF = typeof ret.customFields === 'string'
                                ? JSON.parse(ret.customFields)
                                : ret.customFields;
                            return parsedCF && parseInt(parsedCF.posInvoiceId) === pos.id;
                        } catch (e) {
                            return false;
                        }
                    }
                    return false;
                });

                return adjustInvoiceWithReturns({
                    ...pos,
                    type: 'POS_INVOICE',
                    invoiceitem: pos.posinvoiceitem.map(item => ({
                        ...item,
                        productId: item.productId,
                        serviceId: null,
                        warehouseId: item.warehouseId,
                        uomId: item.uomId,
                        description: item.description || (item.product ? item.product.name : ''),
                        quantity: item.quantity,
                        rate: item.rate,
                        discount: 0,
                        amount: item.amount,
                        taxRate: item.taxRate,
                        product: item.product,
                        service: null,
                        warehouse: item.warehouse || null,
                        uom: item.uom || null
                    })),
                    salesreturn: associatedReturns,
                    dueDate: pos.date,
                    status: pos.balanceAmount <= 0.01 ? 'PAID' : (isDuePassed(pos.dueDate || pos.date) ? 'OVERDUE' : (pos.paidAmount > 0.01 ? 'PARTIAL' : 'UNPAID')),
                    receipt: mappedReceipts
                });
            })
        ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        res.status(200).json({ success: true, data: unifiedInvoices });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Get Invoice By ID
const getInvoiceById = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.query.companyId;

        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID Missing' });

        const rawId = String(id);
        const isCombined = rawId.toLowerCase().startsWith('combined-') || rawId.toLowerCase().includes('combined');

        if (isCombined) {
            let custId = req.query.customerId ? parseInt(req.query.customerId) : null;
            if (!custId && rawId.includes('CUST-')) {
                custId = parseInt(rawId.split('CUST-')[1]);
            } else if (!custId && rawId.includes('combined-')) {
                const afterPrefix = rawId.replace(/combined-/i, '');
                if (!isNaN(parseInt(afterPrefix))) {
                    custId = parseInt(afterPrefix);
                }
            }

            let customer = null;
            if (custId && !isNaN(custId)) {
                customer = await prisma.customer.findUnique({
                    where: { id: parseInt(custId) }
                });
            }

            const company = await prisma.company.findUnique({ where: { id: parseInt(companyId) } });

            let customerInvoices = [];
            if (custId && !isNaN(custId)) {
                customerInvoices = await prisma.invoice.findMany({
                    where: {
                        customerId: parseInt(custId),
                        companyId: parseInt(companyId)
                    },
                    include: {
                        invoiceitem: {
                            include: {
                                product: true,
                                service: true,
                                warehouse: true,
                                uom: true
                            }
                        }
                    }
                });
            }

            const totalAmount = customerInvoices.reduce((sum, inv) => sum + (parseFloat(inv.totalAmount) || 0), 0);
            const paidAmount = customerInvoices.reduce((sum, inv) => sum + (parseFloat(inv.paidAmount) || 0), 0);
            const balanceAmount = customerInvoices.reduce((sum, inv) => sum + (parseFloat(inv.balanceAmount) || 0), 0);

            const combinedItems = [];
            customerInvoices.forEach(inv => {
                (inv.invoiceitem || []).forEach(item => {
                    combinedItems.push({
                        ...item,
                        description: item.description || `Inv #${inv.invoiceNumber || inv.id}: ${item.product?.name || item.service?.name || ''}`
                    });
                });
            });

            const combinedInvoice = {
                id: rawId,
                invoiceNumber: rawId.toUpperCase(),
                date: new Date(),
                dueDate: null,
                totalAmount,
                paidAmount,
                balanceAmount,
                currency: customerInvoices[0]?.currency || company?.currency || 'EUR',
                customer: customer || { name: customer?.name || 'Customer' },
                isCombined: true,
                invoiceitem: combinedItems,
                items: combinedItems,
                invoices: customerInvoices,
                company
            };

            return res.status(200).json({ success: true, data: combinedInvoice });
        }

        const parsedId = parseInt(id);
        if (isNaN(parsedId)) {
            return res.status(400).json({ success: false, message: 'Invalid Invoice ID format' });
        }

        let invoice = await prisma.invoice.findFirst({
            where: { id: parsedId, companyId: parseInt(companyId) },
            include: {
                salesperson: true,
                invoiceitem: {
                    include: {
                        product: true,
                        service: true,
                        warehouse: true,
                        uom: true
                    }
                },
                customer: true,
                salesorder: true,
                deliverychallan: true,
                salesreturn: {
                    include: {
                        salesreturnitem: true
                    }
                },
                receipt: {
                    include: {
                        cashBankAccount: true,
                        transaction: true
                    }
                },
                allocations: {
                    include: {
                        receipt: {
                            include: {
                                cashBankAccount: true,
                                transaction: true
                            }
                        }
                    }
                }
            }
        });

        if (!invoice) {
            // Fallback: Check if it is a POS Invoice
            const pos = await prisma.posinvoice.findFirst({
                where: { id: parsedId, companyId: parseInt(companyId) },
                include: {
                    customer: true,
                    posinvoiceitem: {
                        include: {
                            product: true,
                            uom: true
                        }
                    },
                    transaction: {
                        include: {
                            ledger_transaction_debitLedgerIdToledger: { select: { id: true, name: true } }
                        }
                    }
                }
            });

            if (pos) {
                const receiptTransactions = pos.transaction?.filter(t => t.voucherType === 'RECEIPT') || [];
                const mappedReceipts = receiptTransactions.map(t => ({
                    id: t.id,
                    receiptNumber: t.voucherNumber || '-',
                    date: t.date,
                    amount: t.amount,
                    cashBankAccount: t.ledger_transaction_debitLedgerIdToledger ? {
                        id: t.ledger_transaction_debitLedgerIdToledger.id,
                        name: t.ledger_transaction_debitLedgerIdToledger.name
                    } : null
                }));

                // Fetch associated returns for this POS invoice
                const salesReturns = await prisma.salesreturn.findMany({
                    where: { companyId: parseInt(companyId), invoiceId: null },
                    include: { salesreturnitem: true }
                });

                const posReturns = salesReturns.filter(ret => {
                    if (ret.customFields) {
                        try {
                            const parsedCF = typeof ret.customFields === 'string'
                                ? JSON.parse(ret.customFields)
                                : ret.customFields;
                            return parsedCF && parseInt(parsedCF.posInvoiceId) === pos.id;
                        } catch (e) {
                            return false;
                        }
                    }
                    return false;
                });

                invoice = {
                    ...pos,
                    type: 'POS_INVOICE',
                    invoiceitem: pos.posinvoiceitem.map(item => ({
                        ...item,
                        productId: item.productId,
                        serviceId: null,
                        warehouseId: item.warehouseId,
                        uomId: item.uomId,
                        description: item.description || (item.product ? item.product.name : ''),
                        quantity: item.quantity,
                        rate: item.rate,
                        discount: 0,
                        amount: item.amount,
                        taxRate: item.taxRate,
                        product: item.product,
                        service: null,
                        warehouse: item.warehouse || null,
                        uom: item.uom || null
                    })),
                    salesreturn: posReturns,
                    dueDate: pos.date,
                    status: pos.balanceAmount <= 0.01 ? 'PAID' : (isDuePassed(pos.dueDate || pos.date) ? 'OVERDUE' : (pos.paidAmount > 0.01 ? 'PARTIAL' : 'UNPAID')),
                    receipt: mappedReceipts,
                    allocations: []
                };
            }
        }

        if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

        // Map allocations to receipt list to maintain compatibility and show correct allocated amount
        const mappedReceipts = [
            ...(invoice.receipt || []).map(r => {
                const baseAmount = r.transaction?.filter(t => t.debitLedgerId === r.cashBankAccountId).reduce((sum, t) => sum + t.amount, 0) || r.amount;
                return {
                    ...r,
                    baseAmount
                };
            }),
            ...(invoice.allocations || []).map(alloc => {
                const r = alloc.receipt;
                const baseAmount = r.transaction?.filter(t => t.debitLedgerId === r.cashBankAccountId).reduce((sum, t) => sum + t.amount, 0) || r.amount;
                const baseAllocAmount = r.amount > 0 ? alloc.amount * (baseAmount / r.amount) : alloc.amount;
                return {
                    id: r.id,
                    receiptNumber: r.receiptNumber,
                    date: r.date,
                    amount: alloc.amount, // Only the allocated amount
                    baseAmount: baseAllocAmount,
                    paymentMode: r.paymentMode,
                    referenceNumber: r.referenceNumber,
                    cashBankAccount: r.cashBankAccount,
                    notes: r.notes
                };
            })
        ];

        const seenIds = new Set();
        const deduplicatedReceipts = [];
        for (const r of mappedReceipts) {
            if (!seenIds.has(r.id)) {
                seenIds.add(r.id);
                deduplicatedReceipts.push(r);
            }
        }

        const mappedInvoice = adjustInvoiceWithReturns({
            ...invoice,
            receipt: deduplicatedReceipts
        });

        res.status(200).json({ success: true, data: mappedInvoice });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Update Invoice
const updateInvoice = async (req, res) => {
    try {
        const { id } = req.params;
        const { items, overallDiscount, overallDiscountType, billingName, billingAddress, billingCity, billingState, billingZipCode, billingCountry, shippingName, shippingAddress, shippingCity, shippingState, shippingZipCode, shippingCountry, currency, exchangeRate, manualStatus, status, onlyUpdateStatus, ...data } = req.body;
        const companyId = req.user?.companyId || req.body.companyId;

        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is missing' });
        }

        const rawId = String(id || '');
        const isCombined = rawId.toLowerCase().startsWith('combined-') || rawId.toLowerCase().includes('combined');

        if (isCombined) {
            let custId = req.query.customerId || req.body.customerId ? parseInt(req.query.customerId || req.body.customerId) : null;
            if (!custId && rawId.toUpperCase().includes('CUST-')) {
                custId = parseInt(rawId.toUpperCase().split('CUST-')[1]);
            } else if (!custId && rawId.toLowerCase().includes('combined-')) {
                const afterPrefix = rawId.toLowerCase().replace(/combined-/i, '');
                if (!isNaN(parseInt(afterPrefix))) {
                    custId = parseInt(afterPrefix);
                }
            }

            if (!custId || isNaN(custId)) {
                return res.status(400).json({ success: false, message: 'Invalid customer ID for combined invoice' });
            }

            if (onlyUpdateStatus === true || onlyUpdateStatus === 'true') {
                const childInvoices = await prisma.invoice.findMany({
                    where: { customerId: parseInt(custId), companyId: parseInt(companyId) },
                    include: { allocations: true }
                });

                if (!childInvoices.length) {
                    return res.status(404).json({ success: false, message: 'No invoices found for this combined view' });
                }

                const isManual = manualStatus === true || manualStatus === 'true';
                let targetStatus = status;

                const { computeInvoiceStatusAndBalance } = require('../utils/invoiceSyncHelper');
                const updatedList = [];

                for (const inv of childInvoices) {
                    let invTargetStatus = targetStatus;
                    if (!isManual || !targetStatus || targetStatus === 'AUTO') {
                        const allocSum = (inv.allocations || []).reduce((sum, a) => sum + (parseFloat(a.amount) || 0), 0);
                        const computed = computeInvoiceStatusAndBalance({ ...inv, manualStatus: false }, allocSum);
                        invTargetStatus = computed.status;
                    }
                    const up = await prisma.invoice.update({
                        where: { id: inv.id },
                        data: {
                            manualStatus: isManual && !!status && status !== 'AUTO',
                            status: invTargetStatus
                        }
                    });
                    updatedList.push(up);
                }

                const allPaid = updatedList.every(i => i.status === 'PAID');
                const allUnpaid = updatedList.every(i => i.status === 'UNPAID');
                const anyOverdue = updatedList.some(i => i.status === 'OVERDUE');
                const combinedStatus = (isManual && !!status && status !== 'AUTO')
                    ? status
                    : (allPaid ? 'PAID' : (anyOverdue ? 'OVERDUE' : (allUnpaid ? 'UNPAID' : 'PARTIAL')));

                return res.status(200).json({
                    success: true,
                    data: {
                        id: rawId,
                        isCombined: true,
                        status: combinedStatus,
                        manualStatus: isManual && !!status && status !== 'AUTO',
                        invoices: updatedList
                    }
                });
            }

            return res.status(400).json({
                success: false,
                message: 'Combined invoices are an aggregated view. Please edit individual invoices.'
            });
        }

        const parsedId = parseInt(id);
        if (isNaN(parsedId)) {
            return res.status(400).json({ success: false, message: 'Invalid Invoice ID format' });
        }

        if (onlyUpdateStatus === true || onlyUpdateStatus === 'true') {
            const oldInv = await prisma.invoice.findUnique({
                where: { id: parsedId },
                include: { allocations: true }
            });
            if (!oldInv) return res.status(404).json({ success: false, message: 'Invoice not found' });

            const isManual = manualStatus === true || manualStatus === 'true';
            let targetStatus = status;

            if (!isManual || !targetStatus || targetStatus === 'AUTO') {
                const { computeInvoiceStatusAndBalance } = require('../utils/invoiceSyncHelper');
                const allocSum = (oldInv.allocations || []).reduce((sum, a) => sum + (parseFloat(a.amount) || 0), 0);
                const computed = computeInvoiceStatusAndBalance({ ...oldInv, manualStatus: false }, allocSum);
                targetStatus = computed.status;
            }

            const updated = await prisma.invoice.update({
                where: { id: parsedId },
                data: {
                    manualStatus: isManual && !!status && status !== 'AUTO',
                    status: targetStatus
                }
            });
            const { logInvoiceStatusChanged } = require('../utils/invoiceAuditHelper');
            await logInvoiceStatusChanged(req, oldInv, oldInv?.status, targetStatus);
            return res.status(200).json({ success: true, data: updated });
        }

        // 1. Get existing invoice
        const existingInvoice = await prisma.invoice.findFirst({
            where: { id: parsedId, companyId: parseInt(companyId) },
            include: { invoiceitem: true }
        });

        if (!existingInvoice) {
            return res.status(404).json({ success: false, message: 'Invoice not found' });
        }

        if (existingInvoice.paidAmount > 0 || existingInvoice.status === 'PAID' || existingInvoice.status === 'PARTIAL') {
            return res.status(400).json({
                success: false,
                message: 'A paid or partially paid invoice cannot be edited. Please mark it as unpaid first.'
            });
        }

        // 2. Calculate new totals if items are provided
        let subtotal = existingInvoice.subtotal;
        let totalDiscount = existingInvoice.discountAmount;
        let taxAmount = existingInvoice.taxAmount;
        let totalAmount = existingInvoice.totalAmount;

        let invoiceItemsData = undefined;

        if (items) {
            let lineDiscountSum = 0;
            subtotal = 0;

            // 1. Line gross & line discounts
            items.forEach(item => {
                const itemQty = parseFloat(item.quantity) || 0;
                const itemRate = parseFloat(item.rate) || 0;
                const itemDiscount = parseFloat(item.discount) || 0;
                const lineGross = itemQty * itemRate;

                subtotal += lineGross;
                lineDiscountSum += Math.min(lineGross, itemDiscount);
            });

            const netBeforeOverall = Math.max(0, subtotal - lineDiscountSum);

            // 2. Overall discount
            let overallDiscountAmt = 0;
            const ovVal = parseFloat(overallDiscount) || 0;
            if (overallDiscount && overallDiscountType === 'percentage') {
                overallDiscountAmt = (netBeforeOverall * Math.min(100, Math.max(0, ovVal))) / 100;
            } else if (overallDiscount) {
                overallDiscountAmt = Math.min(netBeforeOverall, Math.max(0, ovVal));
            }

            totalDiscount = lineDiscountSum + overallDiscountAmt;
            const discountedTaxableAmount = Math.max(0, subtotal - totalDiscount);
            const overallDiscountRatio = netBeforeOverall > 0 ? (overallDiscountAmt / netBeforeOverall) : 0;
            let lineTaxSum = 0;

            invoiceItemsData = items.map(item => {
                const itemQty = parseFloat(item.quantity) || 0;
                const itemRate = parseFloat(item.rate) || 0;
                const itemDiscount = parseFloat(item.discount) || 0;
                const itemTaxRate = parseFloat(item.taxRate) || 0;

                const lineGross = itemQty * itemRate;
                const lineAfterItemDisc = Math.max(0, lineGross - itemDiscount);
                const lineDiscountedTaxable = lineAfterItemDisc * (1 - overallDiscountRatio);
                const lineTax = itemTaxRate > 0 ? (lineDiscountedTaxable * itemTaxRate) / 100 : 0;
                const lineDiscountedAmount = Number(lineDiscountedTaxable.toFixed(2));

                lineTaxSum += lineTax;

                return {
                    productId: item.productId ? parseInt(item.productId) : null,
                    serviceId: item.serviceId ? parseInt(item.serviceId) : null,
                    description: item.description || 'Sales Item',
                    quantity: itemQty,
                    rate: itemRate,
                    discount: itemDiscount,
                    amount: lineDiscountedAmount,
                    taxRate: itemTaxRate,
                    warehouseId: item.warehouseId ? parseInt(item.warehouseId) : null
                };
            });

            taxAmount = lineTaxSum;
            totalAmount = discountedTaxableAmount + taxAmount;
        } else {
            // Recalculate with overall discount if items didn't change but discount did
            const ovDiscount = overallDiscount !== undefined ? overallDiscount : existingInvoice.overallDiscount;
            const ovType = overallDiscountType !== undefined ? overallDiscountType : existingInvoice.overallDiscountType;
            const netBeforeOverall = Math.max(0, existingInvoice.subtotal - existingInvoice.discountAmount);
            let overallDiscountAmt = 0;
            const ovVal = parseFloat(ovDiscount) || 0;
            if (ovDiscount && ovType === 'percentage') {
                overallDiscountAmt = (netBeforeOverall * Math.min(100, Math.max(0, ovVal))) / 100;
            } else if (ovDiscount) {
                overallDiscountAmt = Math.min(netBeforeOverall, Math.max(0, ovVal));
            }

            const totalDisc = (existingInvoice.discountAmount || 0) + overallDiscountAmt;
            const discountedTaxable = Math.max(0, existingInvoice.subtotal - totalDisc);
            const discRatio = netBeforeOverall > 0 ? (overallDiscountAmt / netBeforeOverall) : 0;
            taxAmount = (existingInvoice.taxAmount || 0) * (1 - discRatio);
            totalAmount = discountedTaxable + taxAmount;
        }

        // Calculate Other Charges total and add to totalAmount
        const otherChargesArrUpdate = Array.isArray(req.body.otherCharges) ? req.body.otherCharges : [];
        const otherChargesTotalUpdate = otherChargesArrUpdate.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);
        totalAmount = totalAmount + otherChargesTotalUpdate;

        // 3. Update Invoice in a transaction to handle accounting adjustments
        const result = await prisma.$transaction(async (tx) => {
            // A. Revert old ledger balances
            const oldTransactions = await tx.transaction.findMany({
                where: { invoiceId: parseInt(id) }
            });

            for (const t of oldTransactions) {
                if (t.voucherNumber && t.voucherNumber.startsWith('COGS-')) {
                    await tx.ledger.update({
                        where: { id: t.debitLedgerId },
                        data: { currentBalance: { decrement: t.amount } }
                    });
                    await tx.ledger.update({
                        where: { id: t.creditLedgerId },
                        data: { currentBalance: { increment: t.amount } }
                    });
                } else {
                    await tx.ledger.update({
                        where: { id: t.debitLedgerId },
                        data: { currentBalance: { decrement: t.amount } }
                    });
                    await tx.ledger.update({
                        where: { id: t.creditLedgerId },
                        data: { currentBalance: { decrement: t.amount } }
                    });
                }
            }

            // B. Revert old stock + FIFO/WAC if items changed
            if (items) {
                // Also reverse old COGS inventory valuation (FIFO batches + WAC)
                await reverseStockOut(tx, {
                    invoiceId: parseInt(id),
                    invoiceItems: existingInvoice.invoiceitem.map(i => ({
                        productId: i.productId,
                        warehouseId: i.warehouseId,
                        quantity: i.quantity
                    }))
                });

                const company = await tx.company.findUnique({ where: { id: parseInt(companyId) } });
                const config = company.inventoryConfig || {};
                const challanAction = config.challanAction || 'ISSUE';

                if (!existingInvoice.deliveryChallanId || challanAction === 'RESERVE') {
                    for (const item of existingInvoice.invoiceitem) {
                        if (item.productId) {
                            // Find which warehouse was used (warehouseId may be in item or resolved earlier)
                            const wId = item.warehouseId;
                            if (wId) {
                                await tx.stock.upsert({
                                    where: { warehouseId_productId: { warehouseId: wId, productId: item.productId } },
                                    create: {
                                        warehouseId: wId,
                                        productId: item.productId,
                                        quantity: item.quantity,
                                        initialQty: 0,
                                        minOrderQty: 0
                                    },
                                    update: {
                                        quantity: { increment: item.quantity }
                                    }
                                });
                            }
                        }
                    }
                }
            }

            // C. Update Invoice record
            // PRESERVE receipt-linked allocations (these are from Payment Receipts and must not be deleted)
            // Only delete advance-adjustment allocations (where receipt.invoiceId points to a DIFFERENT invoice or null)
            const existingAllocations = await tx.receiptinvoiceallocation.findMany({
                where: { invoiceId: parseInt(id) },
                include: { receipt: true }
            });

            // Split allocations into preserved (receipt payments) vs advance adjustments
            const preservedAllocations = [];
            const advanceAllocations = [];
            for (const alloc of existingAllocations) {
                // If the receipt's primary invoiceId matches this invoice, it's a direct payment receipt - preserve it
                // If the receipt's primary invoiceId is null or different, it could be an advance adjustment
                if (alloc.receipt && alloc.receipt.invoiceId === parseInt(id)) {
                    preservedAllocations.push(alloc);
                } else {
                    advanceAllocations.push(alloc);
                }
            }

            // Delete ONLY the advance allocations, keep the receipt-linked ones
            if (advanceAllocations.length > 0) {
                await tx.receiptinvoiceallocation.deleteMany({
                    where: {
                        id: { in: advanceAllocations.map(a => a.id) }
                    }
                });
            }

            // Sum paidAmount from preserved receipt allocations (cash portion + discount portion)
            let totalPreservedPaid = 0;
            for (const alloc of preservedAllocations) {
                totalPreservedPaid += alloc.amount; // allocation.amount already includes cash + discount
            }

            // Process new adjustments (advance receipts applied to this invoice)
            let totalAdjustedAmount = totalPreservedPaid;
            if (req.body.adjustments && req.body.adjustments.length > 0) {
                for (const adj of req.body.adjustments) {
                    const receipt = await tx.receipt.findUnique({
                        where: { id: parseInt(adj.receiptId) },
                        include: { allocations: true }
                    });
                    if (receipt) {
                        const allocatedSum = receipt.allocations.reduce((sum, a) => sum + a.amount, 0);
                        const availableUnallocated = receipt.amount - allocatedSum;
                        const adjustAmt = Math.min(parseFloat(adj.amount), availableUnallocated);

                        if (adjustAmt > 0) {
                            await tx.receiptinvoiceallocation.create({
                                data: {
                                    receiptId: receipt.id,
                                    invoiceId: parseInt(id),
                                    amount: adjustAmt,
                                    companyId: parseInt(companyId)
                                }
                            });
                            totalAdjustedAmount += adjustAmt;
                        }
                    }
                }
            }

            const updatedInvoice = await tx.invoice.update({
                where: { id: parseInt(id) },
                data: {
                    customFields: req.body.customFields !== undefined ? (typeof req.body.customFields === 'string' ? req.body.customFields : JSON.stringify(req.body.customFields)) : undefined,
                    salespersonId: req.body.salespersonId !== undefined ? (req.body.salespersonId ? parseInt(req.body.salespersonId) : null) : undefined,
                    carNumber: req.body.carNumber !== undefined ? req.body.carNumber : undefined,
                    invoiceNumber: data.invoiceNumber,
                    manualReference: data.manualReference,
                    date: data.date ? new Date(data.date) : undefined,
                    dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
                    customerId: data.customerId ? parseInt(data.customerId) : undefined,
                    notes: data.notes,
                    subtotal,
                    discountAmount: totalDiscount,
                    taxAmount,
                    totalAmount,
                    paidAmount: totalAdjustedAmount,
                    balanceAmount: totalAmount - totalAdjustedAmount,
                    manualStatus: manualStatus === true || manualStatus === 'true',
                    status: (manualStatus === true || manualStatus === 'true') && status ? status : ((totalAmount - totalAdjustedAmount) <= 0.01 ? 'PAID' : (isDuePassed(data.dueDate || existingInvoice.dueDate) ? 'OVERDUE' : (totalAdjustedAmount > 0.01 ? 'PARTIAL' : 'UNPAID'))),
                    currency: currency !== undefined ? currency : undefined,
                    exchangeRate: exchangeRate !== undefined ? parseFloat(exchangeRate) : undefined,
                    overallDiscount: parseFloat(overallDiscount) || 0,
                    overallDiscountType: overallDiscountType || 'percentage',
                    billingName: billingName,
                    billingAddress: billingAddress,
                    billingCity: billingCity,
                    billingState: billingState,
                    billingZipCode: billingZipCode,
                    billingCountry: billingCountry,
                    shippingName: shippingName,
                    shippingAddress: shippingAddress,
                    shippingCity: shippingCity,
                    shippingState: shippingState,
                    shippingZipCode: shippingZipCode,
                    shippingCountry: shippingCountry,
                    invoiceitem: items ? {
                        deleteMany: {},
                        create: invoiceItemsData
                    } : undefined
                },
                include: {
                    customer: { include: { ledger: true } },
                    invoiceitem: {
                        include: {
                            product: true,
                            service: true,
                            warehouse: true,
                            uom: true
                        }
                    },
                    salesreturn: {
                        include: {
                            salesreturnitem: true
                        }
                    }
                }
            });

            // D. Apply new stock if items changed
            if (items) {
                const companyInfo = await tx.company.findUnique({ where: { id: parseInt(companyId) } });
                const inventoryConfigObj = companyInfo.inventoryConfig || {};
                const localChallanAction = inventoryConfigObj.challanAction || 'ISSUE';

                if (!existingInvoice.deliveryChallanId || localChallanAction === 'RESERVE') {
                    for (const item of (invoiceItemsData || [])) {
                        if (item.productId) {
                            // Auto-resolve warehouse if not provided
                            let resolvedWId = item.warehouseId;
                            if (!resolvedWId) {
                                const firstBatch = await tx.inventory_batch.findFirst({
                                    where: { productId: parseInt(item.productId), qtyRemaining: { gt: 0 } },
                                    orderBy: { createdAt: 'asc' },
                                    select: { warehouseId: true }
                                });
                                if (firstBatch) {
                                    resolvedWId = firstBatch.warehouseId;
                                } else {
                                    const firstStock = await tx.stock.findFirst({
                                        where: { productId: parseInt(item.productId), quantity: { gt: 0 } },
                                        orderBy: { quantity: 'desc' },
                                        select: { warehouseId: true }
                                    });
                                    if (firstStock) resolvedWId = firstStock.warehouseId;
                                }
                            }
                            if (resolvedWId) {
                                await tx.stock.upsert({
                                    where: { warehouseId_productId: { warehouseId: resolvedWId, productId: parseInt(item.productId) } },
                                    create: {
                                        warehouseId: resolvedWId,
                                        productId: parseInt(item.productId),
                                        quantity: -item.quantity,
                                        initialQty: 0,
                                        minOrderQty: 0
                                    },
                                    update: {
                                        quantity: { decrement: item.quantity }
                                    }
                                });
                            }
                        }
                    }
                }
            }

            // E. Update/Create new transactions
            // For simplicity, we delete old and create new
            const oldTxs = await tx.transaction.findMany({ where: { invoiceId: parseInt(id) } });
            const oldJournalIds = oldTxs.map(t => t.journalEntryId).filter(Boolean);

            await tx.transaction.deleteMany({ where: { invoiceId: parseInt(id) } });
            if (oldJournalIds.length > 0) {
                await tx.journalentry.deleteMany({ where: { id: { in: oldJournalIds } } });
            }

            const customer = updatedInvoice.customer;
            // Find Sales Income Ledger (same logic as create)
            let salesLedger = await tx.ledger.findFirst({
                where: { companyId: parseInt(companyId), name: { contains: 'Sales' }, accountgroup: { type: 'INCOME' } }
            });

            if (customer && customer.ledgerId && salesLedger) {
                const docExchangeRate = updatedInvoice.exchangeRate || 1.0;
                const ledgerSubtotal = subtotal * docExchangeRate;
                const ledgerTaxAmount = (parseFloat(taxAmount) || 0) * docExchangeRate;
                const currentBaseTotal = (subtotal - totalDiscount) + (parseFloat(taxAmount) || 0);
                const currentOverallDiscount = overallDiscount !== undefined ? overallDiscount : existingInvoice.overallDiscount;
                const currentOverallDiscountType = overallDiscountType !== undefined ? overallDiscountType : existingInvoice.overallDiscountType;
                const overallDiscountAmt = currentOverallDiscountType === 'percentage'
                    ? (currentBaseTotal * (parseFloat(currentOverallDiscount) || 0) / 100)
                    : (parseFloat(currentOverallDiscount) || 0);
                const ledgerDiscountAmount = (totalDiscount + overallDiscountAmt) * docExchangeRate;
                // Gross = subtotal + tax (before discount)
                const ledgerGrossCustomer = ledgerSubtotal + ledgerTaxAmount;

                // Create new journal entry for the updated invoice
                const journal = await tx.journalentry.create({
                    data: {
                        voucherNumber: updatedInvoice.invoiceNumber,
                        date: updatedInvoice.date,
                        narration: `Updated Sales Invoice: ${updatedInvoice.invoiceNumber}`,
                        companyId: parseInt(companyId)
                    }
                });

                // Entry 1: DR Customer, CR Sales Income (Revenue portion)
                await tx.transaction.create({
                    data: {
                        date: updatedInvoice.date,
                        voucherType: 'SALES',
                        voucherNumber: updatedInvoice.invoiceNumber,
                        debitLedgerId: customer.ledgerId,
                        creditLedgerId: salesLedger.id,
                        amount: ledgerSubtotal,
                        narration: `Updated Sales to ${customer.name}`,
                        companyId: parseInt(companyId),
                        invoiceId: updatedInvoice.id,
                        journalEntryId: journal.id
                    }
                });

                // Update Customer Ledger (Revenue portion)
                await tx.ledger.update({
                    where: { id: customer.ledgerId },
                    data: { currentBalance: { increment: ledgerSubtotal } }
                });
                // Update Sales Ledger (Revenue portion)
                await tx.ledger.update({
                    where: { id: salesLedger.id },
                    data: { currentBalance: { increment: ledgerSubtotal } }
                });

                // Entry 2: DR Customer, CR Tax (Tax portion)
                if (ledgerTaxAmount > 0) {
                    let taxLedger = await tx.ledger.findFirst({
                        where: { companyId: parseInt(companyId), name: { contains: 'Tax' } }
                    });
                    if (!taxLedger) {
                        const group = await tx.accountgroup.findFirst({ where: { companyId: parseInt(companyId), type: 'LIABILITIES' } });
                        if (group) {
                            taxLedger = await tx.ledger.create({
                                data: {
                                    name: 'Tax',
                                    groupId: group.id,
                                    companyId: parseInt(companyId),
                                    isControlAccount: true
                                }
                            });
                        }
                    }
                    if (taxLedger) {
                        await tx.transaction.create({
                            data: {
                                date: updatedInvoice.date,
                                voucherType: 'SALES',
                                voucherNumber: updatedInvoice.invoiceNumber,
                                debitLedgerId: customer.ledgerId,
                                creditLedgerId: taxLedger.id,
                                amount: ledgerTaxAmount,
                                narration: `Tax on Sale: ${updatedInvoice.invoiceNumber}`,
                                companyId: parseInt(companyId),
                                invoiceId: updatedInvoice.id,
                                journalEntryId: journal.id
                            }
                        });
                        await tx.ledger.update({
                            where: { id: customer.ledgerId },
                            data: { currentBalance: { increment: ledgerTaxAmount } }
                        });
                        await tx.ledger.update({
                            where: { id: taxLedger.id },
                            data: { currentBalance: { increment: ledgerTaxAmount } }
                        });
                    }
                }

                // Entry 2: DR Discount Allowed on Sale (Expense), CR Customer (reduces receivable)
                if (ledgerDiscountAmount > 0) {
                    const discountAllowedLedger = await tx.ledger.findFirst({
                        where: { companyId: parseInt(companyId), name: { contains: 'Discount Allowed on Sale' } }
                    });
                    if (discountAllowedLedger) {
                        await tx.transaction.create({
                            data: {
                                date: updatedInvoice.date,
                                voucherType: 'SALES',
                                voucherNumber: updatedInvoice.invoiceNumber,
                                debitLedgerId: discountAllowedLedger.id,
                                creditLedgerId: customer.ledgerId,
                                amount: ledgerDiscountAmount,
                                narration: `Discount Allowed on Sale: ${updatedInvoice.invoiceNumber}`,
                                companyId: parseInt(companyId),
                                invoiceId: updatedInvoice.id,
                                journalEntryId: journal.id
                            }
                        });
                        await tx.ledger.update({
                            where: { id: discountAllowedLedger.id },
                            data: { currentBalance: { increment: ledgerDiscountAmount } }
                        });
                        await tx.ledger.update({
                            where: { id: customer.ledgerId },
                            data: { currentBalance: { decrement: ledgerDiscountAmount } }
                        });
                    }
                }
            }

            // F. Re-post COGS entry (was completely missing from update flow!)
            if (items && invoiceItemsData) {
                const invConfig = await getInventoryConfig(companyId);
                const valuationMethod = invConfig.valuationMethod || 'WAC';
                const autoCogsEntry = invConfig.autoCogsEntry !== false;
                const negativeStockAllow = invConfig.negativeStockAllow !== false;

                // Resolve ledgers
                const cogsLedger = await tx.ledger.findFirst({
                    where: { companyId: parseInt(companyId), name: { contains: 'Cost of Goods Sold' } }
                }) || await tx.ledger.findFirst({
                    where: { companyId: parseInt(companyId), name: { contains: 'COGS' } }
                });
                const inventoryLedger = await tx.ledger.findFirst({
                    where: { companyId: parseInt(companyId), name: { contains: 'Inventory Asset' } }
                }) || await tx.ledger.findFirst({
                    where: { companyId: parseInt(companyId), name: { contains: 'Inventory' } }
                });
                const purchaseLedger = await tx.ledger.findFirst({
                    where: { companyId: parseInt(companyId), name: { contains: 'Purchases' } }
                }) || await tx.ledger.findFirst({
                    where: { companyId: parseInt(companyId), name: { contains: 'Purchase' } }
                });

                let totalCOGS = 0;
                for (const item of invoiceItemsData) {
                    if (item.productId) {
                        let resolvedWarehouseId = item.warehouseId;
                        if (!resolvedWarehouseId) {
                            const firstBatch = await tx.inventory_batch.findFirst({
                                where: { productId: parseInt(item.productId), qtyRemaining: { gt: 0 } },
                                orderBy: { createdAt: 'asc' },
                                select: { warehouseId: true }
                            });
                            if (firstBatch) {
                                resolvedWarehouseId = firstBatch.warehouseId;
                            } else {
                                const firstStock = await tx.stock.findFirst({
                                    where: { productId: parseInt(item.productId), quantity: { gt: 0 } },
                                    orderBy: { quantity: 'desc' },
                                    select: { warehouseId: true }
                                });
                                if (firstStock) resolvedWarehouseId = firstStock.warehouseId;
                            }
                        }

                        if (resolvedWarehouseId) {
                            const itemCOGS = await consumeStock(tx, {
                                companyId,
                                productId: item.productId,
                                warehouseId: resolvedWarehouseId,
                                quantity: item.quantity,
                                invoiceId: updatedInvoice.id,
                                method: valuationMethod,
                                negativeStockAllow
                            });
                            totalCOGS += itemCOGS;
                        } else {
                            // No warehouse: fallback to product cost
                            const prod = await tx.product.findUnique({
                                where: { id: parseInt(item.productId) },
                                select: { averageCost: true, purchasePrice: true, initialCost: true }
                            });
                            const cost = parseFloat(prod?.averageCost || prod?.purchasePrice || prod?.initialCost || 0);
                            totalCOGS += cost * item.quantity;
                        }
                    }
                }

                const finalCreditLedger = inventoryLedger || purchaseLedger;
                if (autoCogsEntry && totalCOGS > 0 && cogsLedger && finalCreditLedger) {
                    // Find the journal entry we just created for this invoice
                    const journalForCOGS = await tx.journalentry.findFirst({
                        where: { companyId: parseInt(companyId), voucherNumber: updatedInvoice.invoiceNumber }
                    });

                    await tx.transaction.create({
                        data: {
                            date: updatedInvoice.date,
                            voucherType: 'JOURNAL',
                            voucherNumber: `COGS-${updatedInvoice.invoiceNumber}`,
                            debitLedgerId: cogsLedger.id,
                            creditLedgerId: finalCreditLedger.id,
                            amount: totalCOGS,
                            narration: `COGS for Updated Invoice: ${updatedInvoice.invoiceNumber}`,
                            companyId: parseInt(companyId),
                            invoiceId: updatedInvoice.id,
                            journalEntryId: journalForCOGS?.id || null
                        }
                    });

                    await tx.ledger.update({ where: { id: cogsLedger.id }, data: { currentBalance: { increment: totalCOGS } } });
                    await tx.ledger.update({ where: { id: finalCreditLedger.id }, data: { currentBalance: { decrement: totalCOGS } } });
                }
            }

            // G. Other Charges — double-entry per charge on update (DR Customer / CR selected ledger)
            if (otherChargesArrUpdate.length > 0 && customer && customer.ledgerId) {
                const docExchangeRateUpdate = updatedInvoice.exchangeRate || 1.0;
                for (const charge of otherChargesArrUpdate) {
                    const chargeAmount = parseFloat(charge.amount) || 0;
                    if (!charge.accountId || chargeAmount <= 0) continue;

                    const chargeLedger = await tx.ledger.findUnique({
                        where: { id: parseInt(charge.accountId) }
                    });

                    if (!chargeLedger) continue;

                    const chargeAmtConverted = chargeAmount * docExchangeRateUpdate;

                    // Find the journal entry created for this invoice update
                    const journalForCharge = await tx.journalentry.findFirst({
                        where: { companyId: parseInt(companyId), voucherNumber: updatedInvoice.invoiceNumber }
                    });

                    await tx.transaction.create({
                        data: {
                            date: updatedInvoice.date,
                            voucherType: 'SALES',
                            voucherNumber: updatedInvoice.invoiceNumber,
                            debitLedgerId: customer.ledgerId,
                            creditLedgerId: chargeLedger.id,
                            amount: chargeAmtConverted,
                            narration: `Other Charges (${chargeLedger.name}) on Updated Invoice: ${updatedInvoice.invoiceNumber}`,
                            companyId: parseInt(companyId),
                            invoiceId: updatedInvoice.id,
                            journalEntryId: journalForCharge?.id || null
                        }
                    });

                    // Customer receivable increases (DR)
                    await tx.ledger.update({
                        where: { id: customer.ledgerId },
                        data: { currentBalance: { increment: chargeAmtConverted } }
                    });
                    // Selected account increases (CR)
                    await tx.ledger.update({
                        where: { id: chargeLedger.id },
                        data: { currentBalance: { increment: chargeAmtConverted } }
                    });
                }
            }

            return updatedInvoice;
        }, { timeout: 90000 });

        const adjustedResult = adjustInvoiceWithReturns(result);
        const { logInvoiceUpdated } = require('../utils/invoiceAuditHelper');
        await logInvoiceUpdated(req, existingInvoice, result, invoiceItemsData || items);
        res.status(200).json({ success: true, data: adjustedResult });
    } catch (error) {
        console.error('Invoice Update Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Delete Invoice
const deleteInvoice = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.query.companyId;

        const invoiceId = parseInt(id);
        if (isNaN(invoiceId)) {
            return res.status(400).json({ success: false, message: 'Invalid Invoice ID format' });
        }

        const invoice = await prisma.invoice.findUnique({
            where: { id: invoiceId },
            include: { invoiceitem: true, transaction: true }
        });

        if (!invoice) {
            return res.status(404).json({ success: false, message: 'Invoice not found' });
        }

        await prisma.$transaction(async (tx) => {
            const { deleteSalesReturnHelper } = require('./salesReturnController');
            const { deleteReceiptHelper } = require('./salesReceiptController');

            // Find and delete linked sales returns
            const linkedReturns = await tx.salesreturn.findMany({
                where: { invoiceId: invoice.id },
                include: { salesreturnitem: true }
            });
            for (const ret of linkedReturns) {
                await deleteSalesReturnHelper(tx, ret, companyId);
            }

            // Find and delete linked receipts
            const linkedReceipts = await tx.receipt.findMany({
                where: { invoiceId: invoice.id }
            });
            for (const rec of linkedReceipts) {
                await deleteReceiptHelper(tx, rec, companyId);
            }

            // Unlink any remaining receipts pointing to this invoice to prevent FK Restrict errors
            await tx.receipt.updateMany({
                where: { invoiceId: invoice.id },
                data: { invoiceId: null }
            });

            // 1. Revert Ledger Balances
            for (const t of invoice.transaction) {
                if (t.voucherNumber && t.voucherNumber.startsWith('COGS-')) {
                    await tx.ledger.update({
                        where: { id: t.debitLedgerId },
                        data: { currentBalance: { decrement: t.amount } }
                    });
                    await tx.ledger.update({
                        where: { id: t.creditLedgerId },
                        data: { currentBalance: { increment: t.amount } }
                    });
                } else {
                    const dLedger = await tx.ledger.findUnique({ where: { id: t.debitLedgerId }, include: { accountgroup: true } });
                    const cLedger = await tx.ledger.findUnique({ where: { id: t.creditLedgerId }, include: { accountgroup: true } });

                    const isDrDebitNormal = dLedger?.accountgroup ? ['ASSETS', 'EXPENSES'].includes(dLedger.accountgroup.type) : true;
                    const isCrDebitNormal = cLedger?.accountgroup ? ['ASSETS', 'EXPENSES'].includes(cLedger.accountgroup.type) : true;

                    await tx.ledger.update({
                        where: { id: t.debitLedgerId },
                        data: { currentBalance: isDrDebitNormal ? { decrement: t.amount } : { increment: t.amount } }
                    });
                    await tx.ledger.update({
                        where: { id: t.creditLedgerId },
                        data: { currentBalance: isCrDebitNormal ? { increment: t.amount } : { decrement: t.amount } }
                    });
                }
            }

            // 2. Revert Stock & Valuation Layers
            const { convertToBaseQuantity } = require('../services/uomConversionService');
            const baseItemsForReversal = [];

            for (const item of invoice.invoiceitem) {
                if (item.productId && item.warehouseId) {
                    const prod = await tx.product.findUnique({
                        where: { id: item.productId },
                        include: { uom: true }
                    });
                    const transUom = item.uomId ? await tx.uom.findUnique({ where: { id: item.uomId } }) : null;
                    const baseQty = convertToBaseQuantity(item.quantity, transUom, prod?.uom);

                    baseItemsForReversal.push({
                        productId: item.productId,
                        warehouseId: item.warehouseId,
                        quantity: baseQty
                    });

                    await tx.stock.upsert({
                        where: { warehouseId_productId: { warehouseId: item.warehouseId, productId: item.productId } },
                        create: {
                            warehouseId: item.warehouseId,
                            productId: item.productId,
                            quantity: baseQty,
                            initialQty: 0,
                            minOrderQty: 0
                        },
                        update: {
                            quantity: { increment: baseQty }
                        }
                    });
                }
            }

            // Call reverseStockOut to restore FIFO batches and update WAC cost
            await reverseStockOut(tx, {
                invoiceId: invoice.id,
                invoiceItems: baseItemsForReversal
            });

            // Delete original inventory transactions matching this invoice
            await tx.inventorytransaction.deleteMany({
                where: {
                    companyId: invoice.companyId,
                    reason: { contains: invoice.invoiceNumber }
                }
            });

            // 3. Delete Transactions, Journal Entries, and Invoice
            const journalEntryIds = [...new Set(invoice.transaction.map(t => t.journalEntryId).filter(Boolean))];

            await tx.transaction.deleteMany({ where: { invoiceId: invoice.id } });

            if (journalEntryIds.length > 0) {
                await tx.journalentry.deleteMany({ where: { id: { in: journalEntryIds } } });
            }

            // Also delete any orphaned journal entries with same voucherNumber (permanent delete guarantee)
            await tx.journalentry.deleteMany({
                where: {
                    companyId: invoice.companyId,
                    voucherNumber: invoice.invoiceNumber,
                    transaction: { none: {} }
                }
            });

            // Rollback status of linked Delivery Challan and Sales Order
            if (invoice.deliveryChallanId) {
                const otherInvoices = await tx.invoice.findMany({
                    where: { deliveryChallanId: invoice.deliveryChallanId, id: { not: invoice.id } }
                });
                if (otherInvoices.length === 0) {
                    await tx.deliverychallan.update({
                        where: { id: invoice.deliveryChallanId },
                        data: { status: 'APPROVED' }
                    });
                }
            }

            if (invoice.salesOrderId) {
                const otherInvoices = await tx.invoice.findMany({
                    where: { salesOrderId: invoice.salesOrderId, id: { not: invoice.id } }
                });
                const remainingChallans = await tx.deliverychallan.findMany({
                    where: { salesOrderId: invoice.salesOrderId, status: { notIn: ['CANCELLED', 'DRAFT'] } }
                });

                if (otherInvoices.length === 0 && remainingChallans.length === 0) {
                    await tx.salesorder.update({
                        where: { id: invoice.salesOrderId },
                        data: { status: 'CONFIRMED' }
                    });
                }
            }

            await tx.invoice.delete({ where: { id: invoice.id } });
        }, { timeout: 90000 });

        // Sync customer.accountBalance from ledger after deletion
        try {
            if (invoice.customerId) {
                const customer = await prisma.customer.findUnique({
                    where: { id: invoice.customerId },
                    select: { id: true, ledgerId: true }
                });
                if (customer && customer.ledgerId) {
                    const ledger = await prisma.ledger.findUnique({
                        where: { id: customer.ledgerId },
                        select: { currentBalance: true }
                    });
                    if (ledger) {
                        await prisma.customer.update({
                            where: { id: customer.id },
                            data: { accountBalance: ledger.currentBalance }
                        });
                    }
                }
            }
        } catch (syncErr) {
            console.error('Customer balance sync error after invoice delete:', syncErr);
        }

        const { logInvoiceDeleted } = require('../utils/invoiceAuditHelper');
        await logInvoiceDeleted(req, invoice);
        res.status(200).json({ success: true, message: 'Invoice deleted successfully' });
    } catch (error) {
        console.error('Invoice Delete Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Get Next Invoice Number
const getNextNumber = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID Missing' });

        const result = await numberingService.getNextNumber(companyId, 'invoice');
        res.status(200).json({
            success: true,
            nextNumber: result.formattedNumber,
            nextManualReference: result.nextManualReference || ''
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
const getPublicInvoiceById = async (req, res) => {
    try {
        const { id } = req.params;
        const rawId = String(id);
        const isCombined = rawId.toLowerCase().startsWith('combined-') || rawId.toLowerCase().includes('combined');

        if (isCombined) {
            let custId = req.query.customerId ? parseInt(req.query.customerId) : null;
            if (!custId && rawId.includes('CUST-')) {
                custId = parseInt(rawId.split('CUST-')[1]);
            } else if (!custId && rawId.includes('combined-')) {
                const afterPrefix = rawId.replace(/combined-/i, '');
                if (!isNaN(parseInt(afterPrefix))) {
                    custId = parseInt(afterPrefix);
                }
            }

            let customer = null;
            if (custId && !isNaN(custId)) {
                customer = await prisma.customer.findUnique({
                    where: { id: parseInt(custId) }
                });
            }

            let customerInvoices = [];
            if (custId && !isNaN(custId)) {
                customerInvoices = await prisma.invoice.findMany({
                    where: {
                        customerId: parseInt(custId)
                    },
                    include: {
                        invoiceitem: {
                            include: {
                                product: true,
                                service: true,
                                warehouse: true,
                                uom: true
                            }
                        },
                        company: true
                    }
                });
            }

            const totalAmount = customerInvoices.reduce((sum, inv) => sum + (parseFloat(inv.totalAmount) || 0), 0);
            const paidAmount = customerInvoices.reduce((sum, inv) => sum + (parseFloat(inv.paidAmount) || 0), 0);
            const balanceAmount = customerInvoices.reduce((sum, inv) => sum + (parseFloat(inv.balanceAmount) || 0), 0);

            const combinedItems = [];
            customerInvoices.forEach(inv => {
                (inv.invoiceitem || []).forEach(item => {
                    combinedItems.push({
                        ...item,
                        description: item.description || `Inv #${inv.invoiceNumber || inv.id}: ${item.product?.name || item.service?.name || ''}`
                    });
                });
            });

            const company = customerInvoices[0]?.company || null;

            const combinedInvoice = {
                id: rawId,
                invoiceNumber: rawId.toUpperCase(),
                date: new Date(),
                dueDate: null,
                totalAmount,
                paidAmount,
                balanceAmount,
                currency: customerInvoices[0]?.currency || company?.currency || 'EUR',
                customer: customer || { name: customer?.name || 'Customer' },
                isCombined: true,
                invoiceitem: combinedItems,
                items: combinedItems,
                invoices: customerInvoices,
                company
            };

            return res.status(200).json({ success: true, data: combinedInvoice });
        }

        const parsedId = parseInt(id);
        if (isNaN(parsedId)) {
            return res.status(400).json({ success: false, message: 'Invalid Invoice ID format' });
        }

        const invoice = await prisma.invoice.findUnique({
            where: { id: parsedId },
            include: {
                salesperson: true,
                invoiceitem: {
                    include: {
                        product: true,
                        service: true,
                        warehouse: true,
                        uom: true
                    }
                },
                customer: true,
                salesorder: true,
                company: true,
                receipt: {
                    include: {
                        cashBankAccount: true,
                        transaction: true
                    }
                },
                allocations: {
                    include: {
                        receipt: {
                            include: {
                                cashBankAccount: true,
                                transaction: true
                            }
                        }
                    }
                }
            }
        });

        if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

        const mappedReceipts = [
            ...(invoice.receipt || []).map(r => {
                const baseAmount = r.transaction?.filter(t => t.debitLedgerId === r.cashBankAccountId).reduce((sum, t) => sum + t.amount, 0) || r.amount;
                return {
                    ...r,
                    baseAmount
                };
            }),
            ...(invoice.allocations || []).map(alloc => {
                const r = alloc.receipt;
                const baseAmount = r.transaction?.filter(t => t.debitLedgerId === r.cashBankAccountId).reduce((sum, t) => sum + t.amount, 0) || r.amount;
                const baseAllocAmount = r.amount > 0 ? alloc.amount * (baseAmount / r.amount) : alloc.amount;
                return {
                    id: r.id,
                    receiptNumber: r.receiptNumber,
                    date: r.date,
                    amount: alloc.amount, // Only the allocated amount
                    baseAmount: baseAllocAmount,
                    paymentMode: r.paymentMode,
                    referenceNumber: r.referenceNumber,
                    cashBankAccount: r.cashBankAccount,
                    notes: r.notes
                };
            })
        ];

        const seenIds = new Set();
        const deduplicatedReceipts = [];
        for (const r of mappedReceipts) {
            if (!seenIds.has(r.id)) {
                seenIds.add(r.id);
                deduplicatedReceipts.push(r);
            }
        }

        const mappedInvoice = {
            ...invoice,
            receipt: deduplicatedReceipts
        };

        res.status(200).json({ success: true, data: mappedInvoice });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// One-time cleanup: remove orphaned journal entries (no linked transactions)
const cleanupOrphanedJournals = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        const whereClause = { transaction: { none: {} } };
        if (companyId) whereClause.companyId = parseInt(companyId);

        const orphaned = await prisma.journalentry.findMany({
            where: whereClause,
            select: { id: true, voucherNumber: true, narration: true }
        });

        if (orphaned.length === 0) {
            return res.status(200).json({
                success: true,
                message: 'No orphaned journal entries found. Database is already clean!',
                deletedCount: 0
            });
        }

        const result = await prisma.journalentry.deleteMany({ where: whereClause });

        return res.status(200).json({
            success: true,
            message: `Cleaned up ${result.count} orphaned journal entries.`,
            deletedCount: result.count,
            deleted: orphaned.map(j => ({ id: j.id, voucherNumber: j.voucherNumber }))
        });
    } catch (error) {
        console.error('Cleanup Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

const unpayInvoice = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.body.companyId;

        const invoiceId = parseInt(id);
        if (isNaN(invoiceId)) {
            return res.status(400).json({ success: false, message: 'Invalid Invoice ID format' });
        }

        const invoice = await prisma.invoice.findUnique({
            where: { id: invoiceId },
            include: { customer: true }
        });

        if (!invoice || invoice.companyId !== companyId) {
            return res.status(404).json({ success: false, message: 'Invoice not found' });
        }

        // Find all receipt allocations for this invoice
        const allocations = await prisma.receiptinvoiceallocation.findMany({
            where: { invoiceId: invoice.id }
        });

        // Run in a transaction
        await prisma.$transaction(async (tx) => {
            // For each allocation, delete the associated receipt (reverting all ledger / journal entries)
            for (const alloc of allocations) {
                const receipt = await tx.receipt.findUnique({
                    where: { id: alloc.receiptId }
                });

                if (receipt) {
                    const fullReceipt = await tx.receipt.findUnique({
                        where: { id: receipt.id },
                        include: { allocations: true }
                    });

                    if (fullReceipt) {
                        const oldDiscount = fullReceipt.discountAmount || 0;
                        for (let i = 0; i < fullReceipt.allocations.length; i++) {
                            const oldAlloc = fullReceipt.allocations[i];
                            const oldAllocDiscount = (i === 0) ? oldDiscount : 0;

                            // Revert invoice balances (paidAmount and balanceAmount)
                            const inv = await tx.invoice.findUnique({ where: { id: oldAlloc.invoiceId } });
                            if (inv) {
                                const deltaPaid = -(oldAlloc.amount + oldAllocDiscount);
                                const newPaid = Math.max(0, (inv.paidAmount || 0) + deltaPaid);
                                const newBalance = Math.max(0, (inv.totalAmount || 0) - newPaid);
                                await tx.invoice.update({
                                    where: { id: oldAlloc.invoiceId },
                                    data: {
                                        paidAmount: newPaid,
                                        balanceAmount: newBalance,
                                        status: newBalance <= 0.01 ? 'PAID' : (isDuePassed(inv.dueDate) ? 'OVERDUE' : (newPaid > 0.01 ? 'PARTIAL' : 'UNPAID'))
                                    }
                                });
                            }
                        }

                        // Revert ledger balances
                        const oldTransactions = await tx.transaction.findMany({
                            where: { receiptId: fullReceipt.id, voucherType: 'RECEIPT' }
                        });

                        const oldLedgerChanges = {};
                        for (const t of oldTransactions) {
                            oldLedgerChanges[t.debitLedgerId] = (oldLedgerChanges[t.debitLedgerId] || 0) - t.amount;
                            oldLedgerChanges[t.creditLedgerId] = (oldLedgerChanges[t.creditLedgerId] || 0) + t.amount;
                        }

                        for (const [ledgerId, change] of Object.entries(oldLedgerChanges)) {
                            if (change !== 0) {
                                await tx.ledger.update({
                                    where: { id: parseInt(ledgerId) },
                                    data: { currentBalance: { increment: change } }
                                });
                            }
                        }

                        // Delete allocations, transactions, journal entries and receipt
                        await tx.receiptinvoiceallocation.deleteMany({ where: { receiptId: fullReceipt.id } });
                        await tx.transaction.deleteMany({ where: { receiptId: fullReceipt.id } });

                        const oldJournalIds = [...new Set(oldTransactions.map(t => t.journalEntryId).filter(Boolean))];
                        if (oldJournalIds.length > 0) {
                            await tx.journalentry.deleteMany({ where: { id: { in: oldJournalIds } } });
                        }

                        await tx.receipt.delete({ where: { id: fullReceipt.id } });
                    }
                }
            }

            // Finally, make sure this specific invoice is fully UNPAID
            await tx.invoice.update({
                where: { id: invoice.id },
                data: {
                    paidAmount: 0,
                    balanceAmount: invoice.totalAmount,
                    status: 'UNPAID'
                }
            });

            // Re-sync customer account balance with their ledger
            const customerLedger = await tx.ledger.findFirst({
                where: { customerId: invoice.customerId }
            });
            if (customerLedger) {
                await tx.customer.update({
                    where: { id: invoice.customerId },
                    data: { accountBalance: customerLedger.currentBalance }
                });
            }
        });

        // Audit Logging
        const { logInvoicePaymentRemoved } = require('../utils/invoiceAuditHelper');
        await logInvoicePaymentRemoved(req, invoice, invoice.paidAmount, 'Invoice marked as UNPAID');

        res.status(200).json({ success: true, message: 'Invoice marked as unpaid and all associated payments reversed successfully' });
    } catch (error) {
        console.error('Error marking invoice as unpaid:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

const sendInvoiceEmail = async (req, res) => {
    try {
        const rawId = req.params.id;
        const companyId = req.user?.companyId || req.body.companyId;
        const isCombined = typeof rawId === 'string' && (rawId.startsWith('combined-') || isNaN(parseInt(rawId)));

        const {
            recipientEmail,
            subject,
            message,
            attachPdf = true,
            sendBcc = false,
            customerId: bodyCustomerId,
            invoiceNumber: bodyInvoiceNumber,
            pdfBase64
        } = req.body;

        let invoice = null;
        let company = null;
        let publicUrl = null;

        const emailService = require('../services/emailService');
        const hostHeader = req.get('host') || 'localhost:5173';
        const clientHost = hostHeader.includes(':8080') ? hostHeader.replace(':8080', ':5173') : hostHeader;

        if (isCombined) {
            let custId = bodyCustomerId;
            if (!custId && typeof rawId === 'string' && rawId.includes('CUST-')) {
                custId = parseInt(rawId.split('CUST-')[1]);
            }
            if (!custId && typeof rawId === 'string' && rawId.includes('combined-')) {
                custId = parseInt(rawId.replace('combined-', ''));
            }

            let customer = null;
            if (custId && !isNaN(custId)) {
                customer = await prisma.customer.findUnique({
                    where: { id: parseInt(custId) }
                });
            }

            company = companyId ? await prisma.company.findUnique({ where: { id: parseInt(companyId) } }) : null;

            let customerInvoices = [];
            if (custId && !isNaN(custId)) {
                customerInvoices = await prisma.invoice.findMany({
                    where: {
                        customerId: parseInt(custId),
                        ...(companyId ? { companyId: parseInt(companyId) } : {})
                    },
                    include: { invoiceitem: true }
                });
            }

            const totalAmount = customerInvoices.reduce((sum, inv) => sum + (parseFloat(inv.totalAmount) || 0), 0);
            const paidAmount = customerInvoices.reduce((sum, inv) => sum + (parseFloat(inv.paidAmount) || 0), 0);
            const balanceAmount = customerInvoices.reduce((sum, inv) => sum + (parseFloat(inv.balanceAmount) || 0), 0);

            invoice = {
                id: rawId,
                invoiceNumber: bodyInvoiceNumber || rawId.toUpperCase(),
                date: new Date(),
                dueDate: null,
                totalAmount,
                paidAmount,
                balanceAmount,
                currency: customerInvoices[0]?.currency || company?.currency || 'EUR',
                customer: customer || { name: customer?.name || 'Customer', email: recipientEmail },
                isCombined: true,
                invoices: customerInvoices
            };

            if (customerInvoices.length > 0) {
                publicUrl = `${req.protocol}://${clientHost}/public/invoice/${customerInvoices[0].id}`;
            }
        } else {
            const invoiceId = parseInt(rawId);
            if (!invoiceId || isNaN(invoiceId)) {
                return res.status(400).json({ success: false, message: 'Valid Invoice ID is required' });
            }

            invoice = await prisma.invoice.findUnique({
                where: { id: invoiceId },
                include: {
                    customer: true,
                    invoiceitem: {
                        include: { product: true }
                    },
                    company: true
                }
            });

            if (!invoice) {
                return res.status(404).json({ success: false, message: 'Invoice not found' });
            }

            company = invoice.company || (companyId ? await prisma.company.findUnique({ where: { id: parseInt(companyId) } }) : null);
            publicUrl = `${req.protocol}://${clientHost}/public/invoice/${invoice.id}`;
        }

        const toEmail = recipientEmail || invoice.customer?.email;
        if (!toEmail) {
            return res.status(400).json({ success: false, message: 'Recipient email address is required' });
        }

        const emailResult = await emailService.sendInvoiceEmail({
            invoice,
            company,
            recipientEmail: toEmail,
            subject,
            customMessage: message,
            publicUrl,
            attachPdf,
            pdfBase64,
            bccEmail: sendBcc ? (company?.email || req.user?.email) : null
        });

        res.status(200).json({
            success: true,
            message: `Invoice #${invoice.invoiceNumber} emailed successfully to ${toEmail}`,
            data: emailResult
        });

    } catch (error) {
        console.error('Error sending invoice email:', error);
        const isSmtpConfigError = error.message && (
            error.message.includes('SMTP not configured') ||
            error.message.includes('Incomplete SMTP') ||
            error.message.includes('Invalid SMTP')
        );
        const statusCode = isSmtpConfigError ? 400 : 500;
        res.status(statusCode).json({ success: false, message: error.message || 'Failed to send invoice email' });
    }
};

async function syncSalesOrderStatus(tx, salesOrderId) {
    if (!salesOrderId) return;
    const soId = parseInt(salesOrderId);
    if (isNaN(soId)) return;

    try {
        const so = await tx.salesorder.findUnique({
            where: { id: soId },
            select: { id: true, status: true, manualStatus: true }
        });

        if (!so || so.manualStatus === true) return;

        // Skip update if already in COMPLETED state
        if (so.status !== 'COMPLETED') {
            await tx.salesorder.update({
                where: { id: soId },
                data: { status: 'COMPLETED' }
            });
        }
    } catch (e) {
        console.warn('Could not update salesorder status:', e.message);
    }
}

// Get Audit Trail for a specific Invoice
const getInvoiceAuditTrail = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.query.companyId;

        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is missing' });
        }

        const parsedId = !isNaN(parseInt(id)) ? parseInt(id) : null;
        const invoice = parsedId ? await prisma.invoice.findFirst({
            where: { id: parsedId, companyId: parseInt(companyId) },
            select: { id: true, invoiceNumber: true }
        }) : null;

        const orConditions = [];
        if (parsedId) orConditions.push({ entityId: parsedId });
        if (invoice) {
            orConditions.push({ details: { contains: invoice.invoiceNumber } });
        } else if (typeof id === 'string' && id) {
            orConditions.push({ details: { contains: id } });
        }

        const logs = await prisma.auditlog.findMany({
            where: {
                companyId: parseInt(companyId),
                entity: 'Invoice',
                OR: orConditions
            },
            orderBy: { createdAt: 'desc' },
            include: {
                user: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        role: true
                    }
                }
            }
        });

        res.status(200).json({ success: true, data: logs });
    } catch (error) {
        console.error('Invoice Audit Trail Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    createInvoice,
    getInvoices,
    getInvoiceById,
    updateInvoice,
    deleteInvoice,
    getNextNumber,
    getPublicInvoiceById,
    cleanupOrphanedJournals,
    adjustInvoiceWithReturns,
    unpayInvoice,
    sendInvoiceEmail,
    getInvoiceAuditTrail
};