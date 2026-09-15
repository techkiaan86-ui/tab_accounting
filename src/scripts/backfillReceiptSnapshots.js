const prisma = require('../config/prisma');

const roundTo = (val, decimals = 2) => {
    const factor = Math.pow(10, decimals);
    return Math.round(val * factor) / factor;
};

async function backfillHistoricalSnapshots() {
    console.log('--- Starting Backfill for Historical Receipt Snapshots ---');

    // 1. Fetch all invoices with allocations
    const invoices = await prisma.invoice.findMany({
        where: {
            allocations: {
                some: {}
            }
        },
        include: {
            allocations: {
                include: {
                    receipt: true
                }
            }
        },
        orderBy: { id: 'asc' }
    });

    console.log(`Found ${invoices.length} invoices with allocations.`);

    let totalAllocationsUpdated = 0;
    let totalReceiptsUpdated = 0;

    for (const inv of invoices) {
        const total = parseFloat(inv.totalAmount) || 0;
        
        // Sort allocations chronologically: receipt.date -> receipt.createdAt -> alloc.id
        const sortedAllocs = [...inv.allocations].sort((a, b) => {
            const dateA = a.receipt?.date ? new Date(a.receipt.date).getTime() : 0;
            const dateB = b.receipt?.date ? new Date(b.receipt.date).getTime() : 0;
            if (dateA !== dateB) return dateA - dateB;

            const createdA = a.receipt?.createdAt ? new Date(a.receipt.createdAt).getTime() : 0;
            const createdB = b.receipt?.createdAt ? new Date(b.receipt.createdAt).getTime() : 0;
            if (createdA !== createdB) return createdA - createdB;

            return a.id - b.id;
        });

        let runningBalance = total;

        for (const alloc of sortedAllocs) {
            const allocAmt = parseFloat(alloc.amount) || 0;
            const balanceBefore = roundTo(runningBalance, 2);
            const balanceAfter = Math.max(0, roundTo(balanceBefore - allocAmt, 2));

            // Update allocation record
            await prisma.receiptinvoiceallocation.update({
                where: { id: alloc.id },
                data: {
                    balanceBeforePayment: balanceBefore,
                    balanceAfterPayment: balanceAfter
                }
            });
            totalAllocationsUpdated++;

            // Update receipt record if it's linked to this invoice or doesn't have a snapshot yet
            if (alloc.receiptId) {
                await prisma.receipt.update({
                    where: { id: alloc.receiptId },
                    data: {
                        balanceBeforePayment: balanceBefore,
                        balanceAfterPayment: balanceAfter
                    }
                });
                totalReceiptsUpdated++;
            }

            console.log(`Invoice #${inv.id} (${inv.invoiceNumber}) | Receipt #${alloc.receipt?.receiptNumber || alloc.receiptId} | Amount: €${allocAmt} | Before: €${balanceBefore} -> After: €${balanceAfter}`);

            runningBalance = balanceAfter;
        }
    }

    // 2. Also check single-invoice receipts without explicit allocations (legacy fallback)
    const directReceipts = await prisma.receipt.findMany({
        where: {
            invoiceId: { not: null },
            allocations: { none: {} }
        },
        include: {
            invoice: true
        }
    });

    for (const r of directReceipts) {
        if (r.invoice) {
            const invTotal = parseFloat(r.invoice.totalAmount) || 0;
            const amt = parseFloat(r.amount) || 0;
            const balAfter = Math.max(0, roundTo(invTotal - amt, 2));

            await prisma.receipt.update({
                where: { id: r.id },
                data: {
                    balanceBeforePayment: invTotal,
                    balanceAfterPayment: balAfter
                }
            });
            totalReceiptsUpdated++;
            console.log(`Direct Receipt #${r.receiptNumber} | Amount: €${amt} | Before: €${invTotal} -> After: €${balAfter}`);
        }
    }

    console.log(`\n✅ Backfill complete! Updated ${totalAllocationsUpdated} allocations and ${totalReceiptsUpdated} receipts.`);
    process.exit(0);
}

backfillHistoricalSnapshots().catch(err => {
    console.error('Backfill error:', err);
    process.exit(1);
});
