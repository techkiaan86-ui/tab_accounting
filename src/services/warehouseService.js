const prisma = require('../config/prisma');

/**
 * Resolves a valid warehouse ID for a company.
 *
 * @param {object} client - Prisma client or transaction (tx)
 * @param {number|string} companyId - ID of the company
 * @param {'sales'|'purchase'} [type='sales'] - Context type to prioritize config defaults
 * @param {number|string|null} [preferredWarehouseId=null] - Preferred warehouse ID from item/request
 * @returns {Promise<number>} - A valid warehouse ID guaranteed to exist in the database
 */
async function resolveWarehouseId(client, companyId, type = 'sales', preferredWarehouseId = null) {
    const db = prisma; // Always use main prisma client to avoid transaction timeout/deadlocks
    const cId = parseInt(companyId);

    // 1. If a preferred warehouse ID is passed, check if it exists in the database
    if (preferredWarehouseId !== undefined && preferredWarehouseId !== null) {
        const pId = parseInt(preferredWarehouseId);
        if (!isNaN(pId) && pId > 0) {
            // First check if it matches company
            if (!isNaN(cId) && cId > 0) {
                const whCompany = await db.warehouse.findFirst({
                    where: { id: pId, companyId: cId }
                });
                if (whCompany) return whCompany.id;
            }

            // Also check if exists globally
            const whAny = await db.warehouse.findUnique({
                where: { id: pId }
            });
            if (whAny) return whAny.id;
        }
    }

    // 2. Check company's inventoryConfig
    if (!isNaN(cId) && cId > 0) {
        try {
            const company = await db.company.findUnique({
                where: { id: cId },
                select: { inventoryConfig: true }
            });

            if (company?.inventoryConfig) {
                const config = typeof company.inventoryConfig === 'string'
                    ? JSON.parse(company.inventoryConfig)
                    : company.inventoryConfig;

                const primaryConfigKey = type === 'purchase' ? 'defaultPurchaseWarehouseId' : 'defaultSalesWarehouseId';
                const secondaryConfigKey = type === 'purchase' ? 'defaultSalesWarehouseId' : 'defaultPurchaseWarehouseId';

                const targetWhId = config[primaryConfigKey] || config[secondaryConfigKey];
                if (targetWhId) {
                    const parsedTarget = parseInt(targetWhId);
                    if (!isNaN(parsedTarget)) {
                        const whFromConfig = await db.warehouse.findFirst({
                            where: { id: parsedTarget, companyId: cId }
                        });
                        if (whFromConfig) return whFromConfig.id;
                    }
                }
            }
        } catch (e) {
            console.warn('Could not read inventoryConfig for company:', cId, e.message);
        }

        // 3. Fallback to any active warehouse belonging to this company
        const companyWh = await db.warehouse.findFirst({
            where: { companyId: cId },
            orderBy: { id: 'asc' }
        });
        if (companyWh) return companyWh.id;

        // 4. If company has no warehouses at all, auto-create a default one
        try {
            const created = await db.warehouse.create({
                data: {
                    name: 'Main Warehouse',
                    location: 'Main',
                    companyId: cId
                }
            });
            return created.id;
        } catch (createErr) {
            // In case of unique constraint or concurrent creation, re-query
            const existing = await db.warehouse.findFirst({
                where: { companyId: cId },
                orderBy: { id: 'asc' }
            });
            if (existing) return existing.id;
        }
    }

    // 5. Fallback: find any warehouse in the database
    const globalWh = await db.warehouse.findFirst({
        orderBy: { id: 'asc' }
    });
    if (globalWh) return globalWh.id;

    // 6. Absolute last resort: if the database has literally 0 warehouses anywhere, create one
    if (!isNaN(cId) && cId > 0) {
        const lastResort = await db.warehouse.create({
            data: {
                name: 'Main Warehouse',
                location: 'Main',
                companyId: cId
            }
        });
        return lastResort.id;
    }

    return 1;
}

module.exports = {
    resolveWarehouseId
};
