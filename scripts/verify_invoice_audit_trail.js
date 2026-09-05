const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const salesInvoiceController = require('../src/controllers/salesInvoiceController');
const salesReceiptController = require('../src/controllers/salesReceiptController');

// Helper to simulate Express req / res
function createMockReqRes({ user, body = {}, params = {}, query = {} }) {
    const req = {
        user,
        body,
        params,
        query,
        ip: '127.0.0.1',
        headers: { 'user-agent': 'AuditTrailTestRunner/1.0' }
    };

    let responseData = null;
    let statusCode = 200;

    const res = {
        status: (code) => {
            statusCode = code;
            return res;
        },
        json: (data) => {
            responseData = data;
            return res;
        },
        send: (data) => {
            responseData = data;
            return res;
        }
    };

    return {
        req,
        res,
        getResponse: () => ({ statusCode, responseData })
    };
}

async function runAuditTrailTests() {
    console.log('========================================================================');
    console.log('STARTING INVOICE AUDIT TRAIL END-TO-END VERIFICATION');
    console.log('========================================================================\n');

    // Fetch test user and company
    const user = await prisma.user.findFirst({
        where: { companyId: 3 }
    });

    if (!user) {
        throw new Error('Test user for Company ID 3 not found');
    }

    const testUser = {
        id: user.id,
        name: user.name,
        email: user.email,
        companyId: 3,
        role: user.role || 'COMPANY_ADMIN'
    };

    console.log(`[SETUP] Authenticated User: ${testUser.name} (${testUser.email}), User ID: ${testUser.id}, Company ID: ${testUser.companyId}`);

    // Fetch customers
    const customers = await prisma.customer.findMany({
        where: { companyId: 3 },
        take: 2
    });
    if (customers.length < 2) {
        throw new Error('Need at least 2 customers in company 3 to test customer change');
    }
    const customerA = customers[0];
    const customerB = customers[1];
    console.log(`[SETUP] Test Customer A: ID ${customerA.id} (${customerA.name})`);
    console.log(`[SETUP] Test Customer B: ID ${customerB.id} (${customerB.name})`);

    // Fetch product
    const product = await prisma.product.findFirst({
        where: { companyId: 3 }
    });

    // Fetch bank/cash ledger for receipt
    const bankLedger = await prisma.ledger.findFirst({
        where: { companyId: 3 }
    });

    const uniqueSuffix = Date.now().toString().slice(-6);
    const invoiceNumber = `INV-AUDIT-${uniqueSuffix}`;

    let createdInvoiceId = null;

    try {
        // ---------------------------------------------------------------------
        // TEST 1: INVOICE CREATE
        // ---------------------------------------------------------------------
        console.log('\n------------------------------------------------------------------------');
        console.log(`[TEST 1] Testing Action: CREATE (Invoice #${invoiceNumber})`);
        console.log('------------------------------------------------------------------------');

        const createBody = {
            invoiceNumber: invoiceNumber,
            date: new Date().toISOString().split('T')[0],
            dueDate: new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0],
            customerId: customerA.id,
            items: [
                {
                    productId: product ? product.id : null,
                    description: 'Premium Consulting Service',
                    quantity: 2,
                    rate: 150.00,
                    discount: 10.00,
                    taxRate: 5.00
                }
            ],
            overallDiscount: 5,
            overallDiscountType: 'fixed',
            notes: 'Test invoice for audit trail verification'
        };

        const createMock = createMockReqRes({ user: testUser, body: createBody });
        await salesInvoiceController.createInvoice(createMock.req, createMock.res);
        const createResult = createMock.getResponse();

        if (createResult.statusCode !== 201 && createResult.statusCode !== 200) {
            console.error('Create invoice failed:', createResult.responseData);
            throw new Error(`Failed to create invoice: ${JSON.stringify(createResult.responseData)}`);
        }

        createdInvoiceId = createResult.responseData.data?.id || createResult.responseData.invoice?.id;
        console.log(`[SUCCESS] Invoice created successfully with ID: ${createdInvoiceId}`);

        // Small pause to allow async audit logging to persist
        await new Promise(r => setTimeout(r, 600));

        // Query audit log for CREATE
        const createAuditLogs = await prisma.auditlog.findMany({
            where: {
                companyId: 3,
                entity: 'Invoice',
                entityId: createdInvoiceId,
                action: 'CREATE'
            },
            orderBy: { id: 'desc' }
        });

        console.log(`[VERIFY 1] Found ${createAuditLogs.length} CREATE audit log record(s):`);
        createAuditLogs.forEach(log => {
            const details = typeof log.details === 'string' ? JSON.parse(log.details) : log.details;
            console.log(`- Audit Log ID: ${log.id}`);
            console.log(`  Action: ${log.action}`);
            console.log(`  User ID: ${log.userId}`);
            console.log(`  Company ID: ${log.companyId}`);
            console.log(`  Timestamp: ${log.createdAt}`);
            console.log(`  Summary: ${details.summary}`);
            console.log(`  Line Items Tracked: ${details.newValue?.items?.length || 0}`);
            console.log(`  New Value Snapshot:`, JSON.stringify(details.newValue, null, 2));
        });

        // ---------------------------------------------------------------------
        // TEST 2: INVOICE UPDATE (Customer, Quantity, Rate, Discount, Tax, Due Date)
        // ---------------------------------------------------------------------
        console.log('\n------------------------------------------------------------------------');
        console.log(`[TEST 2] Testing Action: UPDATE (Customer, Quantity, Rate, Discount, Tax, Due Date)`);
        console.log('------------------------------------------------------------------------');

        const newDueDate = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];
        const updateBody = {
            invoiceNumber: invoiceNumber,
            date: new Date().toISOString().split('T')[0],
            dueDate: newDueDate, // Changed due date
            customerId: customerB.id, // Changed customer A -> B
            items: [
                {
                    productId: product ? product.id : null,
                    description: 'Premium Consulting Service',
                    quantity: 4, // Changed quantity 2 -> 4
                    rate: 180.00, // Changed rate 150 -> 180
                    discount: 25.00, // Changed discount 10 -> 25
                    taxRate: 10.00 // Changed tax rate 5% -> 10%
                },
                {
                    productId: null,
                    description: 'Additional Implementation Fee', // Added line item
                    quantity: 1,
                    rate: 75.00,
                    discount: 0,
                    taxRate: 5.00
                }
            ],
            overallDiscount: 20, // Changed overall discount 5 -> 20
            overallDiscountType: 'fixed',
            notes: 'Updated notes'
        };

        const updateMock = createMockReqRes({
            user: testUser,
            params: { id: createdInvoiceId },
            body: updateBody
        });
        await salesInvoiceController.updateInvoice(updateMock.req, updateMock.res);
        const updateResult = updateMock.getResponse();

        if (updateResult.statusCode !== 200) {
            console.error('Update invoice failed:', updateResult.responseData);
            throw new Error(`Failed to update invoice: ${JSON.stringify(updateResult.responseData)}`);
        }

        console.log(`[SUCCESS] Invoice updated successfully`);
        await new Promise(r => setTimeout(r, 600));

        // Query audit log for UPDATE
        const updateAuditLogs = await prisma.auditlog.findMany({
            where: {
                companyId: 3,
                entity: 'Invoice',
                entityId: createdInvoiceId,
                action: 'UPDATE'
            },
            orderBy: { id: 'desc' }
        });

        console.log(`[VERIFY 2] Found ${updateAuditLogs.length} UPDATE audit log record(s):`);
        updateAuditLogs.forEach(log => {
            const details = typeof log.details === 'string' ? JSON.parse(log.details) : log.details;
            console.log(`- Audit Log ID: ${log.id}`);
            console.log(`  Action: ${log.action}`);
            console.log(`  Summary: ${details.summary}`);
            console.log(`  Changed Fields Tracked:`, details.changedFields);
            console.log(`  Field-by-Field Diff Changes (${details.changes?.length || 0} changes):`);
            (details.changes || []).forEach(ch => {
                console.log(`    * [${ch.fieldLabel || ch.field}]: "${ch.previousValue}" -> "${ch.newValue}"`);
            });
        });

        // ---------------------------------------------------------------------
        // TEST 3: PAYMENT RECORDED & CHANGED
        // ---------------------------------------------------------------------
        console.log('\n------------------------------------------------------------------------');
        console.log(`[TEST 3] Testing Action: PAYMENT (Add Payment Receipt)`);
        console.log('------------------------------------------------------------------------');

        const receiptNumber = `RCT-AUDIT-${uniqueSuffix}`;
        const paymentAmount = 100.00;

        const receiptBody = {
            receiptNumber: receiptNumber,
            date: new Date().toISOString().split('T')[0],
            customerId: customerB.id,
            amount: paymentAmount,
            paymentMode: 'BANK',
            referenceNumber: `TXN-${uniqueSuffix}`,
            cashBankAccountId: bankLedger.id,
            notes: 'Audit trail verification payment',
            allocations: [
                {
                    invoiceId: createdInvoiceId,
                    invoiceType: 'TAX_INVOICE',
                    amount: paymentAmount
                }
            ]
        };

        const receiptMock = createMockReqRes({ user: testUser, body: receiptBody });
        await salesReceiptController.createReceipt(receiptMock.req, receiptMock.res);
        const receiptResult = receiptMock.getResponse();

        if (receiptResult.statusCode !== 201 && receiptResult.statusCode !== 200) {
            console.error('Create receipt failed:', receiptResult.responseData);
            throw new Error(`Failed to record payment: ${JSON.stringify(receiptResult.responseData)}`);
        }

        console.log(`[SUCCESS] Payment receipt created with ID: ${receiptResult.responseData.receipt?.id || receiptResult.responseData.id}`);
        await new Promise(r => setTimeout(r, 600));

        // Query audit log for PAYMENT_ADD
        const paymentAuditLogs = await prisma.auditlog.findMany({
            where: {
                companyId: 3,
                entity: 'Invoice',
                entityId: createdInvoiceId,
                action: 'PAYMENT_ADD'
            },
            orderBy: { id: 'desc' }
        });

        console.log(`[VERIFY 3] Found ${paymentAuditLogs.length} PAYMENT_ADD audit log record(s):`);
        paymentAuditLogs.forEach(log => {
            const details = typeof log.details === 'string' ? JSON.parse(log.details) : log.details;
            console.log(`- Audit Log ID: ${log.id}`);
            console.log(`  Action: ${log.action}`);
            console.log(`  Summary: ${details.summary}`);
            console.log(`  Receipt Number: ${details.receiptNumber}`);
            console.log(`  Payment Mode: ${details.paymentMode}`);
            console.log(`  Allocated Amount: ${details.allocatedAmount}`);
            console.log(`  Previous Paid / Balance: ${details.previousPaidAmount} / ${details.previousBalance}`);
            console.log(`  New Paid / Balance: ${details.newPaidAmount} / ${details.newBalance}`);
            console.log(`  Status Transition: ${details.previousStatus} -> ${details.newStatus}`);
        });

        // ---------------------------------------------------------------------
        // TEST 4: INVOICE DELETE (And verification of audit trail preservation)
        // ---------------------------------------------------------------------
        console.log('\n------------------------------------------------------------------------');
        console.log(`[TEST 4] Testing Action: DELETE (Invoice #${invoiceNumber})`);
        console.log('------------------------------------------------------------------------');

        const deleteMock = createMockReqRes({
            user: testUser,
            params: { id: createdInvoiceId }
        });
        await salesInvoiceController.deleteInvoice(deleteMock.req, deleteMock.res);
        const deleteResult = deleteMock.getResponse();

        if (deleteResult.statusCode !== 200) {
            console.error('Delete invoice failed:', deleteResult.responseData);
            throw new Error(`Failed to delete invoice: ${JSON.stringify(deleteResult.responseData)}`);
        }

        console.log(`[SUCCESS] Invoice deleted successfully`);
        await new Promise(r => setTimeout(r, 600));

        // 1. Verify invoice row is deleted
        const invoiceCheck = await prisma.invoice.findUnique({
            where: { id: createdInvoiceId }
        });
        console.log(`[VERIFY 4a] Invoice row in database exists? ${invoiceCheck !== null ? 'YES (Error)' : 'NO (Successfully deleted)'}`);

        // 2. Query ALL audit log records for this invoice ID
        const allAuditLogs = await prisma.auditlog.findMany({
            where: {
                companyId: 3,
                entity: 'Invoice',
                entityId: createdInvoiceId
            },
            orderBy: { id: 'asc' }
        });

        console.log(`\n[VERIFY 4b] PRESERVATION CHECK: ALL Audit Log Records for Deleted Invoice ID ${createdInvoiceId}:`);
        console.log(`Total preserved audit records: ${allAuditLogs.length}`);

        const actionCounts = {};
        allAuditLogs.forEach((log, idx) => {
            actionCounts[log.action] = (actionCounts[log.action] || 0) + 1;
            const details = typeof log.details === 'string' ? JSON.parse(log.details) : log.details;
            console.log(`\n  Record #${idx + 1}:`);
            console.log(`    Log ID: ${log.id}`);
            console.log(`    Action: ${log.action}`);
            console.log(`    Timestamp: ${log.createdAt}`);
            console.log(`    User ID: ${log.userId}`);
            console.log(`    Company ID: ${log.companyId}`);
            console.log(`    Summary: ${details.summary || details.action}`);
        });

        console.log('\n========================================================================');
        console.log('FINAL AUDIT TRAIL VERIFICATION SUMMARY');
        console.log('========================================================================');
        console.log(`CREATE recorded:      ${actionCounts['CREATE'] ? 'PASS (' + actionCounts['CREATE'] + ')' : 'FAIL'}`);
        console.log(`UPDATE recorded:      ${actionCounts['UPDATE'] ? 'PASS (' + actionCounts['UPDATE'] + ')' : 'FAIL'}`);
        console.log(`PAYMENT recorded:     ${actionCounts['PAYMENT_ADD'] ? 'PASS (' + actionCounts['PAYMENT_ADD'] + ')' : 'FAIL'}`);
        console.log(`DELETE recorded:      ${actionCounts['DELETE'] ? 'PASS (' + actionCounts['DELETE'] + ')' : 'FAIL'}`);
        console.log(`Preserved Post-Delete: ${allAuditLogs.length >= 4 ? 'PASS (All records intact)' : 'FAIL'}`);
        console.log('========================================================================\n');

    } catch (err) {
        console.error('Audit verification encountered an error:', err);
    } finally {
        await prisma.$disconnect();
    }
}

runAuditTrailTests();
