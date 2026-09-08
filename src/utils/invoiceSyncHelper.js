/**
 * invoiceSyncHelper.js
 * Centralized business logic for invoice payment synchronization, 
 * outstanding balance calculation, and status determination across TAB ACCOUNTS.
 */

// Helper to get currency decimal places
const getDecimalPlaces = (currency) => {
    const threeDecimalCurrencies = ['KWD', 'BHD', 'OMR', 'JOD', 'LYD', 'TND'];
    return threeDecimalCurrencies.includes(currency?.toUpperCase()) ? 3 : 2;
};

// Round value to specified decimal places
const roundTo = (val, decimals = 2) => {
    const factor = Math.pow(10, decimals);
    return Math.round((parseFloat(val) || 0) * factor) / factor;
};

/**
 * Checks if the invoice due date has passed.
 * Compares by start of calendar day: true if current day is strictly after due date day.
 */
const isDuePassed = (dueDate) => {
    if (!dueDate) return false;
    const due = new Date(dueDate);
    if (isNaN(due.getTime())) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const d = new Date(due);
    d.setHours(0, 0, 0, 0);
    return today.getTime() > d.getTime();
};

/**
 * Computes paid amount, outstanding balance, and status based on authoritative rules:
 * - Outstanding Balance = Invoice Total - Total Payments Received (>= 0)
 * - If balance <= tolerance -> PAID
 * - If balance remains AND due date has passed -> OVERDUE
 * - If balance remains AND partially paid (payments > tolerance) -> PARTIAL
 * - If balance remains AND no payment -> UNPAID
 */
const computeInvoiceStatusAndBalance = (invoice, paymentsReceived = null, tolerance = null) => {
    if (!invoice) return invoice;

    const decimals = getDecimalPlaces(invoice.currency);
    const tol = tolerance !== null ? tolerance : (decimals === 3 ? 0.001 : 0.01);

    const total = roundTo(invoice.totalAmount || 0, decimals);
    const paid = paymentsReceived !== null 
        ? roundTo(paymentsReceived, decimals) 
        : roundTo(invoice.paidAmount || 0, decimals);
    
    // Balance cannot be negative
    const balance = Math.max(0, roundTo(total - paid, decimals));

    const isPos = invoice.type === 'POS_INVOICE' || !!invoice.posinvoiceitem;

    let computedStatus;
    if (invoice.status === 'CANCELLED' || invoice.status === 'Cancelled') {
        computedStatus = isPos ? 'Cancelled' : 'CANCELLED';
    } else if (balance <= tol && (total > 0 || paid > 0)) {
        computedStatus = isPos ? 'Paid' : 'PAID';
    } else if (balance > tol && isDuePassed(invoice.dueDate)) {
        computedStatus = isPos ? 'Overdue' : 'OVERDUE';
    } else if (paid > tol && balance > tol) {
        computedStatus = isPos ? 'Partial' : 'PARTIAL';
    } else if (balance <= tol && total === 0 && paid === 0) {
        computedStatus = isPos ? 'Paid' : 'PAID';
    } else {
        computedStatus = isPos ? 'Due' : 'UNPAID';
    }

    return {
        paidAmount: paid,
        balanceAmount: balance,
        status: computedStatus
    };
};

/**
 * Syncs an invoice in the database:
 * Calculates total payments received from all allocations or applies delta,
 * calculates outstanding balance and status, and updates the database record.
 */
const syncInvoiceInDb = async (txOrPrisma, invoiceId, type = 'TAX_INVOICE', deltaPaid = null) => {
    if (type === 'POS_INVOICE') {
        const inv = await txOrPrisma.posinvoice.findUnique({ where: { id: parseInt(invoiceId) } });
        if (!inv) return null;

        const decimals = getDecimalPlaces(inv.currency);
        let paidAmount;
        if (deltaPaid !== null) {
            paidAmount = Math.max(0, roundTo((inv.paidAmount || 0) + deltaPaid, decimals));
        } else {
            paidAmount = roundTo(inv.paidAmount || 0, decimals);
        }

        const { balanceAmount, status } = computeInvoiceStatusAndBalance(
            inv,
            paidAmount,
            decimals === 3 ? 0.001 : 0.01
        );

        return await txOrPrisma.posinvoice.update({
            where: { id: parseInt(invoiceId) },
            data: {
                paidAmount,
                balanceAmount,
                status,
                manualStatus: false,
                updatedAt: new Date()
            }
        });
    } else {
        const parsedId = parseInt(invoiceId);
        if (isNaN(parsedId)) return null;

        const inv = await txOrPrisma.invoice.findUnique({
            where: { id: parsedId },
            include: {
                allocations: true
            }
        });
        if (!inv) return null;

        const decimals = getDecimalPlaces(inv.currency);
        let paidAmount;
        if (deltaPaid !== null) {
            paidAmount = Math.max(0, roundTo((inv.paidAmount || 0) + deltaPaid, decimals));
        } else {
            // Calculate directly from active allocations
            const totalAlloc = (inv.allocations || []).reduce((sum, a) => sum + parseFloat(a.amount || 0), 0);
            paidAmount = roundTo(totalAlloc, decimals);
        }

        const { balanceAmount, status } = computeInvoiceStatusAndBalance(
            inv,
            paidAmount,
            decimals === 3 ? 0.001 : 0.01
        );

        return await txOrPrisma.invoice.update({
            where: { id: parseInt(invoiceId) },
            data: {
                paidAmount,
                balanceAmount,
                status,
                manualStatus: false,
                updatedAt: new Date()
            }
        });
    }
};

module.exports = {
    getDecimalPlaces,
    roundTo,
    isDuePassed,
    computeInvoiceStatusAndBalance,
    syncInvoiceInDb
};
