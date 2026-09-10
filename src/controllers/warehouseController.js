const prisma = require('../config/prisma');

// Create Warehouse
const createWarehouse = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId || req.body.companyId;
        let { name, location, addressLine1, addressLine2, city, state, postalCode, country } = req.body;

        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID is required' });
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, message: 'Warehouse name is required' });
        }
        name = name.trim();
        if (!location || !location.trim()) {
            location = name;
        } else {
            location = location.trim();
        }

        const existingWarehouse = await prisma.warehouse.findFirst({
            where: { companyId: parseInt(companyId), name }
        });

        if (existingWarehouse) {
            return res.status(400).json({ success: false, message: 'Warehouse with this name already exists' });
        }

        const warehouse = await prisma.warehouse.create({
            data: {
                name,
                location,
                addressLine1,
                addressLine2,
                city,
                state,
                postalCode,
                country,
                companyId: parseInt(companyId)
            }
        });

        res.status(201).json({ success: true, message: 'Warehouse created successfully', data: warehouse });

    } catch (error) {
        console.error('Error creating warehouse:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Get Warehouses
const getWarehouses = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId || req.body.companyId;

        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID is required' });

        const warehouses = await prisma.warehouse.findMany({
            where: { companyId: parseInt(companyId) },
            include: {
                stock: {
                    select: {
                        quantity: true
                    }
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        const formattedWarehouses = warehouses.map(w => {
            const totalStock = w.stock.reduce((sum, stock) => sum + (stock.quantity || 0), 0);
            const { stock, ...warehouseData } = w;
            return {
                ...warehouseData,
                totalStock
            };
        });

        res.status(200).json({ success: true, data: formattedWarehouses });

    } catch (error) {
        console.error('Error fetching warehouses:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Update Warehouse
const updateWarehouse = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.query.companyId || req.body.companyId;
        const { name, location, addressLine1, addressLine2, city, state, postalCode, country } = req.body;

        const warehouse = await prisma.warehouse.update({
            where: {
                id: parseInt(id),
                companyId: parseInt(companyId)
            },
            data: {
                name,
                location,
                addressLine1,
                addressLine2,
                city,
                state,
                postalCode,
                country
            }
        });

        res.status(200).json({ success: true, message: 'Warehouse updated successfully', data: warehouse });

    } catch (error) {
        console.error('Error updating warehouse:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Delete Warehouse
const deleteWarehouse = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.query.companyId || req.body.companyId;
        const warehouseId = parseInt(id);

        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }

        const parsedCompanyId = parseInt(companyId);

        // 1. Verify warehouse exists and belongs to the company
        const existingWarehouse = await prisma.warehouse.findFirst({
            where: {
                id: warehouseId,
                companyId: parsedCompanyId
            }
        });

        if (!existingWarehouse) {
            return res.status(404).json({ success: false, message: 'Warehouse not found' });
        }

        // 2. Ensure company has more than one warehouse
        const totalWarehouses = await prisma.warehouse.count({
            where: { companyId: parsedCompanyId }
        });

        if (totalWarehouses <= 1) {
            return res.status(400).json({
                success: false,
                message: 'Cannot delete the only remaining warehouse of the company. Please create or designate another warehouse first.'
            });
        }

        // 3. Find a fallback warehouse in the same company to safely reassign historical records and stock
        const fallbackWarehouse = await prisma.warehouse.findFirst({
            where: {
                companyId: parsedCompanyId,
                id: { not: warehouseId }
            },
            orderBy: { id: 'asc' }
        });

        if (!fallbackWarehouse) {
            return res.status(400).json({
                success: false,
                message: 'No fallback warehouse found to transfer existing records.'
            });
        }

        // 4. Perform atomic reassignments and deletion inside a Prisma transaction
        await prisma.$transaction(async (tx) => {
            // A. Reassign historical operational documents
            await tx.deliverychallanitem.updateMany({
                where: { warehouseId },
                data: { warehouseId: fallbackWarehouse.id }
            });

            await tx.goodsreceiptnoteitem.updateMany({
                where: { warehouseId },
                data: { warehouseId: fallbackWarehouse.id }
            });

            await tx.inventoryadjustment.updateMany({
                where: { warehouseId },
                data: { warehouseId: fallbackWarehouse.id }
            });

            await tx.inventoryadjustmentitem.updateMany({
                where: { warehouseId },
                data: { warehouseId: fallbackWarehouse.id }
            });

            await tx.purchasereturnitem.updateMany({
                where: { warehouseId },
                data: { warehouseId: fallbackWarehouse.id }
            });

            await tx.salesreturnitem.updateMany({
                where: { warehouseId },
                data: { warehouseId: fallbackWarehouse.id }
            });

            await tx.stocktransfer.updateMany({
                where: { toWarehouseId: warehouseId },
                data: { toWarehouseId: fallbackWarehouse.id }
            });

            await tx.stocktransferitem.updateMany({
                where: { fromWarehouseId: warehouseId },
                data: { fromWarehouseId: fallbackWarehouse.id }
            });

            // B. Reassign inventory transactions
            await tx.inventorytransaction.updateMany({
                where: { fromWarehouseId: warehouseId },
                data: { fromWarehouseId: fallbackWarehouse.id }
            });

            await tx.inventorytransaction.updateMany({
                where: { toWarehouseId: warehouseId },
                data: { toWarehouseId: fallbackWarehouse.id }
            });

            // C. Reassign sales and purchase lines
            await tx.invoiceitem.updateMany({
                where: { warehouseId },
                data: { warehouseId: fallbackWarehouse.id }
            });

            await tx.posinvoiceitem.updateMany({
                where: { warehouseId },
                data: { warehouseId: fallbackWarehouse.id }
            });

            await tx.purchasebillitem.updateMany({
                where: { warehouseId },
                data: { warehouseId: fallbackWarehouse.id }
            });

            await tx.purchaseorderitem.updateMany({
                where: { warehouseId },
                data: { warehouseId: fallbackWarehouse.id }
            });

            await tx.purchasequotationitem.updateMany({
                where: { warehouseId },
                data: { warehouseId: fallbackWarehouse.id }
            });

            await tx.salesorderitem.updateMany({
                where: { warehouseId },
                data: { warehouseId: fallbackWarehouse.id }
            });

            await tx.salesquotationitem.updateMany({
                where: { warehouseId },
                data: { warehouseId: fallbackWarehouse.id }
            });

            // D. Reassign inventory batches
            await tx.inventory_batch.updateMany({
                where: { warehouseId },
                data: { warehouseId: fallbackWarehouse.id }
            });

            // E. Safely merge stock records into fallback warehouse
            const stocks = await tx.stock.findMany({
                where: { warehouseId }
            });

            for (const s of stocks) {
                const fallbackStock = await tx.stock.findUnique({
                    where: {
                        warehouseId_productId: {
                            warehouseId: fallbackWarehouse.id,
                            productId: s.productId
                        }
                    }
                });

                if (fallbackStock) {
                    await tx.stock.update({
                        where: { id: fallbackStock.id },
                        data: {
                            quantity: (fallbackStock.quantity || 0) + (s.quantity || 0),
                            reservedQuantity: (fallbackStock.reservedQuantity || 0) + (s.reservedQuantity || 0)
                        }
                    });
                    await tx.stock.delete({
                        where: { id: s.id }
                    });
                } else {
                    await tx.stock.update({
                        where: { id: s.id },
                        data: {
                            warehouseId: fallbackWarehouse.id
                        }
                    });
                }
            }

            // F. Delete the warehouse
            await tx.warehouse.delete({
                where: {
                    id: warehouseId
                }
            });
        });

        res.status(200).json({
            success: true,
            message: `Warehouse deleted successfully. Any associated stock and transactions were safely reassigned to "${fallbackWarehouse.name}".`
        });

    } catch (error) {
        console.error('Error deleting warehouse:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

const getWarehouseById = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.query.companyId || req.body.companyId;

        const warehouse = await prisma.warehouse.findUnique({
            where: {
                id: parseInt(id),
                companyId: parseInt(companyId)
            },
            include: {
                stock: {
                    include: {
                        product: {
                            include: {
                                category: true
                            }
                        }
                    }
                }
            }
        });

        if (!warehouse) {
            return res.status(404).json({ success: false, message: 'Warehouse not found' });
        }

        // Calculate Stats
        const totalStockUnits = warehouse.stock.reduce((sum, stock) => sum + stock.quantity, 0);
        const categories = new Set(warehouse.stock.map(s => s.product?.categoryId).filter(Boolean));
        const totalCategories = categories.size;
        const totalProducts = warehouse.stock.length;

        // Find Highest and Lowest Stock Product
        let highestStockProduct = null;
        let lowestStockProduct = null;

        if (warehouse.stock.length > 0) {
            highestStockProduct = warehouse.stock.reduce((prev, current) => (prev.quantity > current.quantity) ? prev : current);
            lowestStockProduct = warehouse.stock.reduce((prev, current) => (prev.quantity < current.quantity) ? prev : current);
        }

        // Format Inventory List
        const inventoryList = (warehouse.stock || []).map(stock => ({
            id: stock.id,
            category: stock.product?.category?.name || 'Uncategorized',
            product: stock.product?.name,
            unit: stock.product?.unit || 'Units',
            quantity: stock.quantity
        }));

        const data = {
            ...warehouse,
            stats: {
                totalCategories,
                totalProducts,
                totalStockUnits,
                highestStockProduct: highestStockProduct ? `${highestStockProduct.product.name} (${highestStockProduct.quantity})` : '-',
                lowestStockProduct: lowestStockProduct ? `${lowestStockProduct.product.name} (${lowestStockProduct.quantity})` : '-'
            },
            inventory: inventoryList
        };

        res.status(200).json({ success: true, data });
    } catch (error) {
        console.error('Error fetching warehouse:', error);
        res.status(500).json({ success: false, message: error.message });
    }
}


module.exports = {
    createWarehouse,
    getWarehouses,
    updateWarehouse,
    deleteWarehouse,
    getWarehouseById
};
