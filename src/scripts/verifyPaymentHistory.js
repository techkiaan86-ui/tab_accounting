const prisma = require('../config/prisma');
const { getDeduplicatedInvoiceReceipts, adjustInvoiceWithReturns } = require('../controllers/salesInvoiceController');
const { syncInvoiceInDb } = require('../utils/invoiceSyncHelper');

async function testPaymentHistory() {
    console.log('=================================================================');
    console.log('TEST: Invoice-Specific Payment History & Historical Snapshots');
    console.log('=================================================================');

    const invoiceId = 153;

    // 1. Fetch Invoice 153 with all required relations
    const rawInvoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: {
            customer: true,
            invoiceitem: true,
            salesreturn: { include: { salesreturnitem: true } },
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

    if (!rawInvoice) {
        throw new Error(`Invoice #${invoiceId} not found in database.`);
    }

    const deduplicatedReceipts = getDeduplicatedInvoiceReceipts(rawInvoice);
    const formattedInvoice = adjustInvoiceWithReturns({
        ...rawInvoice,
        receipt: deduplicatedReceipts
    });

    console.log('\n--- INVOICE SUMMARY ---');
    console.log(`Invoice ID:        ${formattedInvoice.id} (${formattedInvoice.invoiceNumber})`);
    console.log(`Total Amount:      €${Number(formattedInvoice.totalAmount).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    console.log(`Total Paid:        €${Number(formattedInvoice.paidAmount).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    console.log(`Balance Due:       €${Number(formattedInvoice.balanceAmount).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    console.log(`Status:            ${formattedInvoice.status}`);

    console.log('\n--- PAYMENT HISTORY ---');
    const tableData = deduplicatedReceipts.map(r => {
        const d = new Date(r.date);
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        return {
            'Payment Date': `${day}/${month}/${year}`,
            'Receipt Number': r.receiptNumber,
            'Payment Amount': `€${Number(r.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
            'Payment Method': (r.paymentMode || 'BANK').toUpperCase(),
            'Balance After Payment': `€${Number(r.balanceAfterPayment).toLocaleString('en-US', { minimumFractionDigits: 2 })}`
        };
    });
    console.table(tableData);

    // Verify Requirements for 3 payments
    if (formattedInvoice.totalAmount !== 22221) {
        throw new Error(`Expected totalAmount 22221, got ${formattedInvoice.totalAmount}`);
    }
    if (formattedInvoice.paidAmount !== 6000) {
        throw new Error(`Expected paidAmount 6000, got ${formattedInvoice.paidAmount}`);
    }
    if (formattedInvoice.balanceAmount !== 16221) {
        throw new Error(`Expected balanceAmount 16221, got ${formattedInvoice.balanceAmount}`);
    }
    if (formattedInvoice.status !== 'PARTIALLY PAID' && formattedInvoice.status !== 'PARTIAL') {
        throw new Error(`Expected status PARTIALLY PAID or PARTIAL, got ${formattedInvoice.status}`);
    }
    if (deduplicatedReceipts.length !== 3) {
        throw new Error(`Expected exactly 3 payment records, got ${deduplicatedReceipts.length}`);
    }

    const [p1, p2, p3] = deduplicatedReceipts;
    if (p1.receiptNumber !== 'RCV-0030' || p1.amount !== 2000 || p1.balanceAfterPayment !== 20221) {
        throw new Error(`Record 1 mismatch: ${JSON.stringify(p1)}`);
    }
    if (p2.receiptNumber !== 'RCV-0033' || p2.amount !== 2000 || p2.balanceAfterPayment !== 18221) {
        throw new Error(`Record 2 mismatch: ${JSON.stringify(p2)}`);
    }
    if (p3.receiptNumber !== 'RCV-0034' || p3.amount !== 2000 || p3.balanceAfterPayment !== 16221) {
        throw new Error(`Record 3 mismatch: ${JSON.stringify(p3)}`);
    }

    console.log('\n✅ ALL 3 HISTORICAL PAYMENT RECORDS MATCH EXPECTED SNAPSHOTS:');
    console.log('   11/09/2026 | RCV-0030 | €2,000.00 | BANK | €20,221.00');
    console.log('   12/09/2026 | RCV-0033 | €2,000.00 | BANK | €18,221.00');
    console.log('   13/09/2026 | RCV-0034 | €2,000.00 | BANK | €16,221.00');

    // 2. Test Adding a 4th Payment & History Update
    console.log('\n--- TESTING NEW PAYMENT ADDITION (4th Payment of €2,000) ---');
    const testRcvNo = 'RCV-HIST-TEST4';
    await prisma.receiptinvoiceallocation.deleteMany({ where: { receipt: { receiptNumber: testRcvNo } } });
    await prisma.receipt.deleteMany({ where: { receiptNumber: testRcvNo } });

    const balanceBefore4 = formattedInvoice.balanceAmount; // 16221
    const pmt4Amount = 2000;
    const balanceAfter4 = balanceBefore4 - pmt4Amount; // 14221

    const newReceipt = await prisma.receipt.create({
        data: {
            receiptNumber: testRcvNo,
            date: new Date('2026-09-14T10:00:00.000Z'),
            customerId: rawInvoice.customerId,
            invoiceId: invoiceId,
            amount: pmt4Amount,
            paymentMode: 'BANK',
            companyId: rawInvoice.companyId,
            cashBankAccountId: 32,
            notes: '4th payment test',
            status: 'CLEARED',
            balanceBeforePayment: balanceBefore4,
            balanceAfterPayment: balanceAfter4,
            allocations: {
                create: {
                    invoiceId: invoiceId,
                    amount: pmt4Amount,
                    companyId: rawInvoice.companyId,
                    balanceBeforePayment: balanceBefore4,
                    balanceAfterPayment: balanceAfter4
                }
            }
        }
    });

    await syncInvoiceInDb(prisma, invoiceId);

    // Re-fetch after 4th payment
    const updatedInvoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: {
            customer: true,
            invoiceitem: true,
            salesreturn: { include: { salesreturnitem: true } },
            receipt: { include: { cashBankAccount: true, transaction: true } },
            allocations: { include: { receipt: { include: { cashBankAccount: true, transaction: true } } } }
        }
    });

    const updatedDeduplicated = getDeduplicatedInvoiceReceipts(updatedInvoice);
    const updatedFormatted = adjustInvoiceWithReturns({
        ...updatedInvoice,
        receipt: updatedDeduplicated
    });

    console.log(`Updated Invoice Balance: €${updatedFormatted.balanceAmount}`);
    console.log(`Updated Invoice Total Paid: €${updatedFormatted.paidAmount}`);
    console.log(`Updated Receipts Count: ${updatedDeduplicated.length}`);

    if (updatedDeduplicated.length !== 4) {
        throw new Error(`Expected 4 receipts after adding new payment, got ${updatedDeduplicated.length}`);
    }

    const rcv1 = updatedDeduplicated.find(r => r.receiptNumber === 'RCV-0030');
    const rcv2 = updatedDeduplicated.find(r => r.receiptNumber === 'RCV-0033');
    const rcv3 = updatedDeduplicated.find(r => r.receiptNumber === 'RCV-0034');
    const rcv4 = updatedDeduplicated.find(r => r.receiptNumber === testRcvNo);

    console.log(`RCV-0030 balanceAfterPayment: €${rcv1.balanceAfterPayment} (Must remain 20221) -> ${rcv1.balanceAfterPayment === 20221 ? 'PASS ✅' : 'FAIL ❌'}`);
    console.log(`RCV-0033 balanceAfterPayment: €${rcv2.balanceAfterPayment} (Must remain 18221) -> ${rcv2.balanceAfterPayment === 18221 ? 'PASS ✅' : 'FAIL ❌'}`);
    console.log(`RCV-0034 balanceAfterPayment: €${rcv3.balanceAfterPayment} (Must remain 16221) -> ${rcv3.balanceAfterPayment === 16221 ? 'PASS ✅' : 'FAIL ❌'}`);
    console.log(`RCV-HIST-TEST4 balanceAfterPayment: €${rcv4.balanceAfterPayment} (Must be 14221) -> ${rcv4.balanceAfterPayment === 14221 ? 'PASS ✅' : 'FAIL ❌'}`);

    if (rcv1.balanceAfterPayment !== 20221 || rcv2.balanceAfterPayment !== 18221 || rcv3.balanceAfterPayment !== 16221 || rcv4.balanceAfterPayment !== 14221) {
        throw new Error('Historical balances were corrupted or failed to preserve snapshots!');
    }

    // Clean up test 4th receipt
    console.log('\n--- CLEANING UP TEST 4th RECEIPT ---');
    await prisma.receiptinvoiceallocation.deleteMany({ where: { receipt: { receiptNumber: testRcvNo } } });
    await prisma.receipt.deleteMany({ where: { receiptNumber: testRcvNo } });
    await syncInvoiceInDb(prisma, invoiceId);

    // Verify restored state
    const restoredInvoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: {
            allocations: { include: { receipt: true } },
            receipt: true
        }
    });
    console.log(`Restored Total Paid: €${restoredInvoice.paidAmount}`);
    console.log(`Restored Balance Due: €${restoredInvoice.balanceAmount}`);
    console.log(`Restored Status: ${restoredInvoice.status}`);

    console.log('\n=================================================================');
    console.log('✅ ALL VERIFICATIONS PASSED SUCCESSFULLY!');
    console.log('=================================================================');
}

testPaymentHistory()
    .catch(err => {
        console.error('❌ Test failed:', err);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
