const prisma = require('../config/prisma');
const { getCompanyCurrency, getCompanyHistoricalCurrency, getConversionRate } = require('../utils/currencyConverter');

// Create Customer with Automatic Ledger Creation
const createCustomer = async (req, res) => {
    try {
        const companyId = req.user.companyId;
        const customerData = req.body;

        // Validate required fields
        if (!customerData.name) {
            return res.status(400).json({
                success: false,
                message: 'Customer name is required'
            });
        }

        // Find Accounts Receivable SubGroup
        const accountsReceivableSubGroup = await prisma.accountsubgroup.findFirst({
            where: {
                companyId: companyId,
                name: 'Accounts Receivable'
            },
            include: {
                accountgroup: true
            }
        });

        if (!accountsReceivableSubGroup) {
            return res.status(404).json({
                success: false,
                message: 'Accounts Receivable sub-group not found. Please initialize Chart of Accounts first.'
            });
        }

        // Check if customer with same name/email already exists in the same company
        const existingCustomer = await prisma.customer.findFirst({
            where: {
                companyId: companyId,
                OR: [
                    { name: customerData.name },
                    { email: customerData.email && customerData.email !== '' ? customerData.email : undefined }
                ].filter(Boolean)
            }
        });

        if (existingCustomer) {
            return res.status(409).json({
                success: false,
                message: 'A customer with this name or email already exists in this company.'
            });
        }

        // Check if a ledger with same name already exists in this company
        const existingLedger = await prisma.ledger.findFirst({
            where: {
                companyId: companyId,
                name: customerData.name
            }
        });

        if (existingLedger) {
            return res.status(409).json({
                success: false,
                message: 'A ledger with this name already exists. Please use a unique name.'
            });
        }

        // Create Customer and Ledger in a transaction
        const result = await prisma.$transaction(async (tx) => {
            const companyCurrency = await getCompanyCurrency(companyId);
            const histCurr = await getCompanyHistoricalCurrency(companyId);
            const writeRate = await getConversionRate(companyCurrency, histCurr);

            const ledgerName = customerData.name;
            const rawBalanceInput = parseFloat(customerData.accountBalance) || 0;
            const convertedRawBalance = rawBalanceInput * writeRate;
            const initialBalance = customerData.balanceType === 'Credit' ? -Math.abs(convertedRawBalance) : Math.abs(convertedRawBalance);

            // Create Customer with nested Ledger
            const customer = await tx.customer.create({
                data: {
                    name: customerData.name,
                    nameArabic: customerData.nameArabic,
                    companyName: customerData.companyName,
                    companyLocation: customerData.companyLocation,
                    profileImage: customerData.profileImage,
                    anyFile: customerData.anyFile,
                    accountType: customerData.accountType,
                    balanceType: customerData.balanceType || 'Debit',
                    accountName: ledgerName,
                    accountBalance: rawBalanceInput,
                    creationDate: customerData.creationDate ? new Date(customerData.creationDate) : new Date(),
                    bankAccountNumber: customerData.bankAccountNumber,
                    bankIFSC: customerData.bankIFSC,
                    bankNameBranch: customerData.bankNameBranch,
                    phone: customerData.phone,
                    email: customerData.email,
                    creditPeriod: customerData.creditPeriod ? parseInt(customerData.creditPeriod) : null,
                    gstNumber: customerData.gstNumber,
                    gstEnabled: customerData.gstEnabled || false,

                    // Billing Address
                    billingName: customerData.billingName,
                    billingPhone: customerData.billingPhone,
                    billingAddress: customerData.billingAddress,
                    billingCity: customerData.billingCity,
                    billingState: customerData.billingState,
                    billingCountry: customerData.billingCountry,
                    billingZipCode: customerData.billingZipCode,

                    // Shipping Address (Legacy fields)
                    shippingSameAsBilling: customerData.shippingSameAsBilling || false,
                    shippingName: customerData.shippingName,
                    shippingPhone: customerData.shippingPhone,
                    shippingAddress: customerData.shippingAddress,
                    shippingCity: customerData.shippingCity,
                    shippingState: customerData.shippingState,
                    shippingCountry: customerData.shippingCountry,
                    shippingZipCode: customerData.shippingZipCode,

                    companyId: companyId,

                    // Link Ledger via nested create
                    ledger: {
                        create: {
                            name: ledgerName,
                            groupId: accountsReceivableSubGroup.groupId,
                            subGroupId: accountsReceivableSubGroup.id,
                            companyId: companyId,
                            openingBalance: initialBalance,
                            currentBalance: initialBalance,
                            isControlAccount: false,
                            isEnabled: true,
                            description: `Customer Ledger for ${ledgerName}`
                        }
                    },

                    // Multiple Shipping Addresses
                    shippingaddress: {
                        create: (customerData.shippingAddresses && Array.isArray(customerData.shippingAddresses)) ? customerData.shippingAddresses.map(addr => ({
                            name: addr.name,
                            phone: addr.phone,
                            address: addr.address,
                            city: addr.city,
                            state: addr.state,
                            country: addr.country,
                            zipCode: addr.zipCode,
                            isDefault: addr.isDefault || false
                        })) : []
                    }
                },
                include: {
                    ledger: true
                }
            });

            // Update cross-references within the same transaction
            const ledgerId = customer.ledger.id;
            const customerId = customer.id;

            // Use direct SQL or faster non-circular updates if possible? 
            // In Prisma, we just do them sequentially but quickly.
            await tx.customer.update({
                where: { id: customerId },
                data: { ledgerId: ledgerId }
            });

            await tx.ledger.update({
                where: { id: ledgerId },
                data: { customerId: customerId }
            });

            return { customer: { ...customer, ledgerId }, ledger: { ...customer.ledger, customerId } };
        }, {
            timeout: 15000, // 15 seconds
            maxWait: 5000
        });

        const { logActivity } = require('../utils/auditLogger');
        logActivity(req, 'CREATE', 'Customer', result.customer.id, `Customer ${result.customer.name} created`);
        res.status(201).json({
            success: true,
            message: 'Customer created successfully with linked ledger',
            data: result
        });
    } catch (error) {
        console.error('Error creating customer:', error);
        if (error.code === 'P2002') {
            return res.status(409).json({
                success: false,
                message: 'Customer with this email already exists'
            });
        }
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to create customer'
        });
    }
};

// Get All Customers
const getAllCustomers = async (req, res) => {
    try {
        const rawCompanyId = req.user?.companyId || req.query.companyId;
        if (!rawCompanyId) {
            return res.status(400).json({
                success: false,
                message: 'Company ID is required'
            });
        }
        const companyId = parseInt(rawCompanyId);

        const customers = await prisma.customer.findMany({
            where: { companyId },
            include: {
                ledger: true,
                shippingaddress: true,
                invoice: {
                    select: {
                        id: true,
                        invoiceNumber: true,
                        totalAmount: true,
                        balanceAmount: true,
                        status: true
                    }
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        // Calculate dynamic ledger balances to ensure they align with the Chart of Accounts
        try {
            const chartOfAccountsService = require('../services/chartOfAccountsService');
            const inventoryValue = await chartOfAccountsService.calculateInventoryValue(companyId);
            const balanceMap = await chartOfAccountsService.calculateDynamicLedgerBalances(companyId, inventoryValue);

            customers.forEach(customer => {
                if (customer.ledgerId && customer.ledger) {
                    const entry = balanceMap.get(customer.ledgerId);
                    if (entry) {
                        customer.ledger.currentBalance = entry.dynamicBalance;
                        customer.ledger.balance = entry.dynamicBalance;
                    }
                }
            });
        } catch (dynamicErr) {
            console.error('Error calculating dynamic balances in getAllCustomers:', dynamicErr);
        }

        res.status(200).json({
            success: true,
            data: customers
        });
    } catch (error) {
        console.error('Error fetching customers:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch customers'
        });
    }
};

// Get Customer by ID
const getCustomerById = async (req, res) => {
    try {
        const rawCompanyId = req.user?.companyId || req.query.companyId;
        if (!rawCompanyId) {
            return res.status(400).json({
                success: false,
                message: 'Company ID is required'
            });
        }
        const companyId = parseInt(rawCompanyId);
        const { id } = req.params;

        const customer = await prisma.customer.findFirst({
            where: {
                id: parseInt(id),
                companyId: companyId
            },
            include: {
                ledger: true,
                salesquotation: true,
                salesorder: true,
                deliverychallan: true,
                invoice: {
                    include: {
                        invoiceitem: true,
                        receipt: true
                    }
                },
                receipt: true,
                salesreturn: {
                    include: {
                        salesreturnitem: {
                            include: {
                                product: true
                            }
                        }
                    }
                },
                shippingaddress: true
            }
        });

        if (!customer) {
            return res.status(404).json({
                success: false,
                message: 'Customer not found'
            });
        }

        // Calculate dynamic ledger balance to ensure it aligns with the Chart of Accounts
        try {
            if (customer.ledgerId && customer.ledger) {
                const chartOfAccountsService = require('../services/chartOfAccountsService');
                const inventoryValue = await chartOfAccountsService.calculateInventoryValue(companyId);
                const balanceMap = await chartOfAccountsService.calculateDynamicLedgerBalances(companyId, inventoryValue);
                const entry = balanceMap.get(customer.ledgerId);
                if (entry) {
                    customer.ledger.currentBalance = entry.dynamicBalance;
                }
            }
        } catch (dynamicErr) {
            console.error('Error calculating dynamic balance in getCustomerById:', dynamicErr);
        }

        res.status(200).json({
            success: true,
            data: customer
        });
    } catch (error) {
        console.error('Error fetching customer:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch customer'
        });
    }
};

// Update Customer
const updateCustomer = async (req, res) => {
    try {
        const companyId = req.user.companyId;
        const { id } = req.params;
        const customerData = req.body;

        // Check if customer exists
        const existingCustomer = await prisma.customer.findFirst({
            where: {
                id: parseInt(id),
                companyId: companyId
            },
            include: { ledger: true }
        });

        if (!existingCustomer) {
            return res.status(404).json({
                success: false,
                message: 'Customer not found'
            });
        }

        // Update in transaction
        const result = await prisma.$transaction(async (tx) => {
            const companyCurrency = await getCompanyCurrency(companyId);
            const histCurr = await getCompanyHistoricalCurrency(companyId);
            const writeRate = await getConversionRate(companyCurrency, histCurr);

            const rawBalanceInput = parseFloat(customerData.accountBalance) || 0;
            const convertedRawBalance = rawBalanceInput * writeRate;
            const targetBalance = customerData.balanceType === 'Credit' ? -Math.abs(convertedRawBalance) : Math.abs(convertedRawBalance);

            let transactionsNet = 0;

            if (existingCustomer.ledgerId) {
                // Fetch all transactions involving customer's ledger
                const transactions = await tx.transaction.findMany({
                    where: {
                        companyId: companyId,
                        OR: [
                            { debitLedgerId: existingCustomer.ledgerId },
                            { creditLedgerId: existingCustomer.ledgerId }
                        ]
                    }
                });

                for (const txn of transactions) {
                    if (txn.debitLedgerId === existingCustomer.ledgerId) {
                        transactionsNet += txn.amount;
                    } else {
                        transactionsNet -= txn.amount;
                    }
                }
            }

            const newCurrentBalance = targetBalance;
            const newOpeningBalance = targetBalance - transactionsNet;

            // Update Customer
            const customer = await tx.customer.update({
                where: { id: parseInt(id) },
                data: {
                    name: customerData.name,
                    nameArabic: customerData.nameArabic,
                    companyName: customerData.companyName,
                    companyLocation: customerData.companyLocation,
                    profileImage: customerData.profileImage,
                    anyFile: customerData.anyFile,
                    accountType: customerData.accountType,
                    balanceType: customerData.balanceType,
                    accountBalance: rawBalanceInput,
                    bankAccountNumber: customerData.bankAccountNumber,
                    bankIFSC: customerData.bankIFSC,
                    bankNameBranch: customerData.bankNameBranch,
                    phone: customerData.phone,
                    email: customerData.email,
                    creditPeriod: customerData.creditPeriod ? parseInt(customerData.creditPeriod) : null,
                    gstNumber: customerData.gstNumber,
                    gstEnabled: customerData.gstEnabled,

                    // Billing Address
                    billingName: customerData.billingName,
                    billingPhone: customerData.billingPhone,
                    billingAddress: customerData.billingAddress,
                    billingCity: customerData.billingCity,
                    billingState: customerData.billingState,
                    billingCountry: customerData.billingCountry,
                    billingZipCode: customerData.billingZipCode,

                    // Shipping Address
                    shippingSameAsBilling: customerData.shippingSameAsBilling,
                    shippingName: customerData.shippingName,
                    shippingPhone: customerData.shippingPhone,
                    shippingAddress: customerData.shippingAddress,
                    shippingCity: customerData.shippingCity,
                    shippingState: customerData.shippingState,
                    shippingCountry: customerData.shippingCountry,
                    shippingZipCode: customerData.shippingZipCode,

                    // Update Shipping Addresses
                    shippingaddress: {
                        deleteMany: {},
                        create: (customerData.shippingAddresses && Array.isArray(customerData.shippingAddresses)) ? customerData.shippingAddresses.map(addr => ({
                            name: addr.name,
                            phone: addr.phone,
                            address: addr.address,
                            city: addr.city,
                            state: addr.state,
                            country: addr.country,
                            zipCode: addr.zipCode,
                            isDefault: addr.isDefault || false
                        })) : []
                    }
                }
            });

            // Update Ledger name and balance if customer is edited
            if (existingCustomer.ledgerId) {
                const newLedgerName = customerData.name;
                await tx.ledger.update({
                    where: { id: existingCustomer.ledgerId },
                    data: {
                        name: newLedgerName,
                        description: `Customer Ledger for ${newLedgerName}`,
                        openingBalance: newOpeningBalance,
                        currentBalance: newCurrentBalance
                    }
                });
            }

            return customer;
        }, {
            maxWait: 5000,
            timeout: 15000
        });

        const { logActivity } = require('../utils/auditLogger');
        logActivity(req, 'UPDATE', 'Customer', result.id, `Customer ${result.name} updated`);
        res.status(200).json({
            success: true,
            message: 'Customer updated successfully',
            data: result
        });
    } catch (error) {
        console.error('Error updating customer:', error);
        if (error.code === 'P2002') {
            return res.status(409).json({
                success: false,
                message: 'Customer with this email already exists'
            });
        }
        res.status(500).json({
            success: false,
            message: 'Failed to update customer'
        });
    }
};

// Get Customer Statement (Ledger History)
const getCustomerStatement = async (req, res) => {
    try {
        const { id } = req.params;
        const { startDate, endDate, invoiceId } = req.query;
        const companyId = req.user.companyId;

        const customer = await prisma.customer.findFirst({
            where: { id: parseInt(id), companyId: companyId },
            include: { ledger: true }
        });

        if (!customer || !customer.ledgerId) {
            return res.status(404).json({ success: false, message: 'Customer or Ledger not found' });
        }

        const dateRange = {};
        if (startDate) dateRange.gte = new Date(startDate);
        if (endDate) dateRange.lte = new Date(endDate);

        const whereClause = {
            companyId: companyId,
            date: Object.keys(dateRange).length > 0 ? dateRange : undefined,
            OR: [
                { debitLedgerId: customer.ledgerId },
                { creditLedgerId: customer.ledgerId }
            ]
        };

        if (invoiceId) {
            whereClause.invoiceId = parseInt(invoiceId);
        }

        const transactions = await prisma.transaction.findMany({
            where: whereClause,
            include: {
                invoice: {
                    select: {
                        invoiceNumber: true, subtotal: true, totalAmount: true, paidAmount: true, balanceAmount: true, discountAmount: true, taxAmount: true, currency: true, exchangeRate: true, overallDiscount: true, overallDiscountType: true, customFields: true,
                        invoiceitem: { include: { product: { select: { name: true, sku: true, unit: true } }, service: { select: { name: true } } } }
                    }
                },
                receipt: { select: { receiptNumber: true, amount: true } },
                posinvoice: {
                    select: {
                        invoiceNumber: true, subtotal: true, totalAmount: true, paidAmount: true, balanceAmount: true, discountAmount: true, taxAmount: true, customFields: true,
                        posinvoiceitem: { include: { product: { select: { name: true, sku: true, unit: true } } } }
                    }
                },
                journalentry: true
            },
            orderBy: { date: 'asc' }
        });

        // Group transactions by voucher / doc key to combine multiple split postings (e.g. Sales + Discount + Other Charges) into 1 row
        const groupedMap = new Map();
        transactions.forEach(tx => {
            let key = `tx_${tx.id}`;
            if (tx.invoiceId) key = `inv_${tx.invoiceId}`;
            else if (tx.receiptId) key = `rec_${tx.receiptId}`;
            else if (tx.posInvoiceId) key = `pos_${tx.posInvoiceId}`;
            else if (tx.salesReturnId) key = `sret_${tx.salesReturnId}`;
            else if (tx.voucherNumber) key = `v_${tx.voucherType}_${tx.voucherNumber}_${new Date(tx.date).toISOString().split('T')[0]}`;

            if (!groupedMap.has(key)) {
                groupedMap.set(key, []);
            }
            groupedMap.get(key).push(tx);
        });

        // Calculate Statements with Running Balance per grouped voucher
        let runningBalance = invoiceId ? 0 : customer.ledger.openingBalance;
        const statement = [];

        for (const [key, txList] of groupedMap.entries()) {
            const primaryTx = txList[0];

            let debitSum = 0;
            let creditSum = 0;

            txList.forEach(tx => {
                const isDebit = tx.debitLedgerId === customer.ledgerId;
                if (isDebit) debitSum += parseFloat(tx.amount || 0);
                else creditSum += parseFloat(tx.amount || 0);
            });

            // Calculate Net Effect for Customer (Assets): Debit increases (+), Credit decreases (-)
            const netAmount = debitSum - creditSum;
            let debit = 0;
            let credit = 0;

            if (netAmount >= 0) {
                debit = netAmount;
                runningBalance += netAmount;
            } else {
                credit = Math.abs(netAmount);
                runningBalance -= Math.abs(netAmount);
            }

            // Extract items and breakdown for hover popup
            let items = [];
            let doc = primaryTx.invoice || primaryTx.posinvoice;
            if (primaryTx.invoice && primaryTx.invoice.invoiceitem) {
                items = primaryTx.invoice.invoiceitem.map(item => ({
                    name: item.product?.name || item.service?.name || item.description || 'Item',
                    qty: item.quantity,
                    rate: item.rate,
                    amount: item.amount
                }));
            } else if (primaryTx.posinvoice && primaryTx.posinvoice.posinvoiceitem) {
                items = primaryTx.posinvoice.posinvoiceitem.map(item => ({
                    name: item.product?.name || item.description || 'Item',
                    qty: item.quantity,
                    rate: item.rate,
                    amount: item.amount
                }));
            }

            const itemsSub = items.reduce((s, i) => s + (parseFloat(i.amount) || (parseFloat(i.rate || 0) * parseFloat(i.qty || 0))), 0);
            const subtotal = doc?.subtotal || itemsSub;

            let discountAmount = doc?.discountAmount || 0;
            if (!discountAmount && doc?.overallDiscount) {
                if (doc.overallDiscountType === 'percentage') {
                    discountAmount = (subtotal * parseFloat(doc.overallDiscount)) / 100;
                } else {
                    discountAmount = parseFloat(doc.overallDiscount) || 0;
                }
            }

            let taxAmount = doc?.taxAmount || 0;
            let otherCharges = doc?.otherCharges || 0;

            if (!otherCharges && doc?.customFields) {
                try {
                    const cf = typeof doc.customFields === 'string' ? JSON.parse(doc.customFields) : doc.customFields;
                    if (Array.isArray(cf?._otherCharges)) {
                        otherCharges = cf._otherCharges.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);
                    }
                } catch (e) {}
            }

            const totalAmount = doc?.totalAmount || primaryTx.receipt?.amount || (debit || credit) || 0;

            const netCalc = subtotal - discountAmount + taxAmount;
            if (!otherCharges && totalAmount > netCalc + 0.01) {
                otherCharges = totalAmount - netCalc;
            } else if (!discountAmount && netCalc > totalAmount + 0.01 && !taxAmount) {
                discountAmount = subtotal - totalAmount;
            }

            const paidAmount = doc?.paidAmount || 0;
            const balanceAmount = doc?.balanceAmount ?? Math.max(0, totalAmount - paidAmount);

            statement.push({
                id: primaryTx.id,
                date: primaryTx.date,
                voucherType: primaryTx.voucherType,
                voucherNumber: primaryTx.voucherNumber,
                narration: primaryTx.narration || `${primaryTx.voucherType} #${primaryTx.voucherNumber}`,
                debit,
                credit,
                balance: runningBalance,
                invoiceId: primaryTx.invoiceId || null,
                receiptId: primaryTx.receiptId || null,
                posInvoiceId: primaryTx.posInvoiceId || null,
                salesReturnId: primaryTx.salesReturnId || null,
                items,
                subtotal,
                totalAmount,
                paidAmount,
                balanceAmount,
                discountAmount,
                taxAmount,
                otherCharges
            });
        }

        res.status(200).json({
            success: true,
            data: {
                customer: {
                    name: customer.name,
                    ledgerName: customer.ledger.name,
                    openingBalance: customer.ledger.openingBalance
                },
                statement
            }
        });
    } catch (error) {
        console.error('Statement Error:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

// Delete Customer
const deleteCustomer = async (req, res) => {
    try {
        const companyId = req.user.companyId;
        const { id } = req.params;

        // Check if customer exists
        const customer = await prisma.customer.findFirst({
            where: {
                id: parseInt(id),
                companyId: companyId
            },
            include: {
                invoice: true,
                salesorder: true,
                salesquotation: true,
                receipt: true,
                deliverychallan: true,
                ledger: true
            }
        });

        if (!customer) {
            return res.status(404).json({
                success: false,
                message: 'Customer not found'
            });
        }

        // Check for dependencies
        const dependencies = [];
        if (customer.invoice && customer.invoice.length > 0) dependencies.push('invoices');
        if (customer.salesorder && customer.salesorder.length > 0) dependencies.push('sales orders');
        if (customer.salesquotation && customer.salesquotation.length > 0) dependencies.push('sales quotations');
        if (customer.receipt && customer.receipt.length > 0) dependencies.push('receipts');
        if (customer.deliverychallan && customer.deliverychallan.length > 0) dependencies.push('delivery challans');

        if (dependencies.length > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete customer with existing ${dependencies.join(', ')}. Please delete them first.`
            });
        }

        // Delete in transaction
        await prisma.$transaction(async (tx) => {
            let ledgerExists = false;
            if (customer.ledgerId) {
                const ledger = await tx.ledger.findUnique({
                    where: { id: customer.ledgerId }
                });
                if (ledger) {
                    ledgerExists = true;
                }
            }

            // 1. Nullify references to avoid FK constraints during deletion
            if (ledgerExists) {
                // Update customer to remove ledger reference
                await tx.customer.update({
                    where: { id: customer.id },
                    data: { ledgerId: null }
                });

                // Update ledger to remove customer reference
                await tx.ledger.update({
                    where: { id: customer.ledgerId },
                    data: { customerId: null }
                });
            }

            // 2. Delete Customer
            await tx.customer.delete({
                where: { id: customer.id }
            });

            // 3. Delete associated Ledger if exists
            if (ledgerExists) {
                await tx.ledger.delete({
                    where: { id: customer.ledgerId }
                });
            }
        }, {
            timeout: 15000,
            maxWait: 5000
        });

        const { logActivity } = require('../utils/auditLogger');
        logActivity(req, 'DELETE', 'Customer', customer.id, `Customer ${customer.name} deleted`);
        res.status(200).json({
            success: true,
            message: 'Customer deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting customer details:', error);
        res.status(500).json({
            success: false,
            message: `Failed to delete customer: ${error.message}`
        });
    }
};

// Recalculate Customer Ledger Balance
const recalculateBalance = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user.companyId;

        const customer = await prisma.customer.findFirst({
            where: { id: parseInt(id), companyId: companyId },
            include: { ledger: true }
        });

        if (!customer || !customer.ledgerId) {
            return res.status(404).json({ success: false, message: 'Customer or Ledger not found' });
        }

        const transactions = await prisma.transaction.findMany({
            where: {
                companyId: companyId,
                OR: [
                    { debitLedgerId: customer.ledgerId },
                    { creditLedgerId: customer.ledgerId }
                ]
            }
        });

        let newBalance = customer.ledger.openingBalance;
        for (const tx of transactions) {
            if (tx.debitLedgerId === customer.ledgerId) {
                newBalance += tx.amount;
            } else {
                newBalance -= tx.amount;
            }
        }

        // Update both Ledger and Customer model for consistency
        await prisma.ledger.update({
            where: { id: customer.ledgerId },
            data: { currentBalance: newBalance }
        });

        await prisma.customer.update({
            where: { id: customer.id },
            data: { accountBalance: newBalance }
        });

        res.status(200).json({
            success: true,
            message: 'Balance recalculated successfully',
            data: {
                oldBalance: customer.ledger.currentBalance,
                newBalance: newBalance
            }
        });
    } catch (error) {
        console.error('Recalculate Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Recalculate All Customers Ledger Balances
const recalculateAllBalances = async (req, res) => {
    try {
        const companyId = req.user.companyId;

        // Fetch all customers for this company, including their ledgers
        const customers = await prisma.customer.findMany({
            where: { companyId: companyId },
            include: { ledger: true }
        });

        const results = [];

        await prisma.$transaction(async (tx) => {
            for (const customer of customers) {
                if (!customer.ledgerId) continue;

                // Query all transactions involving the customer's ledger
                const transactions = await tx.transaction.findMany({
                    where: {
                        companyId: companyId,
                        OR: [
                            { debitLedgerId: customer.ledgerId },
                            { creditLedgerId: customer.ledgerId }
                        ]
                    }
                });

                let newBalance = customer.ledger.openingBalance || 0;
                for (const txn of transactions) {
                    if (txn.debitLedgerId === customer.ledgerId) {
                        newBalance += txn.amount;
                    } else {
                        newBalance -= txn.amount;
                    }
                }

                // Update ledger currentBalance
                await tx.ledger.update({
                    where: { id: customer.ledgerId },
                    data: { currentBalance: newBalance }
                });

                // Update customer accountBalance
                await tx.customer.update({
                    where: { id: customer.id },
                    data: { accountBalance: newBalance }
                });

                results.push({
                    customerId: customer.id,
                    customerName: customer.name,
                    oldBalance: customer.accountBalance,
                    newBalance: newBalance
                });
            }
        });

        res.status(200).json({
            success: true,
            message: 'All customer balances recalculated successfully',
            data: results
        });
    } catch (error) {
        console.error('Recalculate All Balances Error:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to recalculate balances' });
    }
};

module.exports = {
    createCustomer,
    getAllCustomers,
    getCustomerById,
    updateCustomer,
    deleteCustomer,
    getCustomerStatement,
    recalculateBalance,
    recalculateAllBalances
};
