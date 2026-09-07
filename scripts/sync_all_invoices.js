/**
 * sync_all_invoices.js
 * Database alignment script that checks all existing Invoices and POS Invoices
 * and synchronizes their paidAmount, balanceAmount, and status according to
 * the business rules:
 * - Outstanding Balance = Invoice Total - Total Payments Received
 * - If balance <= tolerance -> PAID
 * - If balance remains AND due date has passed -> OVERDUE
 * - If balance remains AND partially paid -> PARTIAL
 * - If balance remains AND no payment -> UNPAID
 */

const prisma = require('../src/config/prisma');
const { computeInvoiceStatusAndBalance, getDecimalPlaces, roundTo } = require('../src/utils/invoiceSyncHelper');

async function syncAllInvoices() {
    console.log('--- Starting Invoice Synchronization ---');
    try {
        // 1. Sync Tax Invoices
        const invoices = await prisma.invoice.findMany({
            include: {
                allocations: true,
                salesreturn: true
            }
        });

        console.log(`Found ${invoices.length} tax invoices in database.`);
        let updatedCount = 0;

        for (const inv of invoices) {
            const decimals = getDecimalPlaces(inv.currency);
            const tol = decimals === 3 ? 0.001 : 0.01;

            // Total payments received from allocations
            const totalAlloc = (inv.allocations || []).reduce((sum, a) => sum + (parseFloat(a.amount) || 0), 0);
            
            // Factor in any advance applied if recorded and no allocations exist
            let effectivePaid = totalAlloc;
            if (totalAlloc === 0 && (inv.appliedAdvanceAmount || 0) > 0) {
                effectivePaid = parseFloat(inv.appliedAdvanceAmount);
            } else if (totalAlloc === 0 && (inv.paidAmount || 0) > 0 && inv.status === 'PAID') {
                // Keep recorded paid amount if explicitly recorded
                effectivePaid = parseFloat(inv.paidAmount);
            }

            effectivePaid = roundTo(effectivePaid, decimals);
            const total = roundTo(inv.totalAmount || 0, decimals);
            const expectedBalance = Math.max(0, roundTo(total - effectivePaid, decimals));

            const { status: expectedStatus } = computeInvoiceStatusAndBalance(
                inv,
                effectivePaid,
                tol
            );

            const isPaidChanged = Math.abs((inv.paidAmount || 0) - effectivePaid) > tol;
            const isBalanceChanged = Math.abs((inv.balanceAmount || 0) - expectedBalance) > tol;
            const isStatusChanged = inv.status !== expectedStatus && !inv.manualStatus;

            if (isPaidChanged || isBalanceChanged || isStatusChanged) {
                console.log(`Syncing Invoice #${inv.invoiceNumber} (ID ${inv.id}):`);
                console.log(`  Paid: ${inv.paidAmount} -> ${effectivePaid}`);
                console.log(`  Balance: ${inv.balanceAmount} -> ${expectedBalance}`);
                console.log(`  Status: ${inv.status} -> ${expectedStatus} (manual: ${inv.manualStatus}, dueDate: ${inv.dueDate ? inv.dueDate.toISOString().split('T')[0] : 'none'})`);

                await prisma.invoice.update({
                    where: { id: inv.id },
                    data: {
                        paidAmount: effectivePaid,
                        balanceAmount: expectedBalance,
                        status: expectedStatus
                    }
                });
                updatedCount++;
            }
        }

        console.log(`Synchronized ${updatedCount} tax invoices.`);

        // 2. Sync POS Invoices
        const posInvoices = await prisma.posinvoice.findMany();
        console.log(`Found ${posInvoices.length} POS invoices in database.`);
        let posUpdatedCount = 0;

        for (const pos of posInvoices) {
            const decimals = getDecimalPlaces(pos.currency);
            const tol = decimals === 3 ? 0.001 : 0.01;

            const paid = roundTo(pos.paidAmount || 0, decimals);
            const total = roundTo(pos.totalAmount || 0, decimals);
            const expectedBalance = Math.max(0, roundTo(total - paid, decimals));

            const { status: expectedStatus } = computeInvoiceStatusAndBalance(
                { ...pos, type: 'POS_INVOICE', dueDate: pos.dueDate || pos.date },
                paid,
                tol
            );

            const isBalanceChanged = Math.abs((pos.balanceAmount || 0) - expectedBalance) > tol;
            const isStatusChanged = pos.status !== expectedStatus && !pos.manualStatus;

            if (isBalanceChanged || isStatusChanged) {
                console.log(`Syncing POS Invoice #${pos.invoiceNumber} (ID ${pos.id}):`);
                console.log(`  Balance: ${pos.balanceAmount} -> ${expectedBalance}`);
                console.log(`  Status: ${pos.status} -> ${expectedStatus}`);

                await prisma.posinvoice.update({
                    where: { id: pos.id },
                    data: {
                        balanceAmount: expectedBalance,
                        status: expectedStatus
                    }
                });
                posUpdatedCount++;
            }
        }

        console.log(`Synchronized ${posUpdatedCount} POS invoices.`);
        console.log('--- Invoice Synchronization Complete ---');
    } catch (error) {
        console.error('Error during invoice synchronization:', error);
    } finally {
        await prisma.$disconnect();
    }
}

if (require.main === module) {
    syncAllInvoices();
}

module.exports = syncAllInvoices;
