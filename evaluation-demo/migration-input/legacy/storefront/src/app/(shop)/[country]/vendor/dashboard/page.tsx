import { getVendorOverview } from "@/lib/vendure/vendor";
import Link from "next/link";
import { Suspense } from "react";
import { formatPrice } from "@/lib/format";
import { getActiveCustomer } from "@/lib/vendure/actions";

async function DashboardStats() {
    let stats = { totalSales: 0, activeProductCount: 0, pendingOrderCount: 0, currencyCode: 'EUR' };
    const customer = await getActiveCustomer().catch(() => null);
    try {
        const result = await getVendorOverview();
        if (result) {
            stats = result as any;
        }
    } catch (e) {
        console.error("Failed to fetch vendor overview:", e);
    }

    const currencyCode = stats.currencyCode || (customer?.customFields as any)?.countryCode === 'HU' ? 'HUF' : 'EUR';
    const balanceWithdrawable = (customer?.customFields as any)?.balanceWithdrawable || 0;

    return (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <div className="p-6 bg-card rounded-lg border shadow-sm">
                <h3 className="text-sm text-muted-foreground">累计销售额</h3>
                <p className="text-2xl font-bold mt-1">{formatPrice(stats.totalSales, currencyCode)}</p>
            </div>
            <div className="p-6 bg-card rounded-lg border shadow-sm">
                <h3 className="text-sm text-muted-foreground">在售设计</h3>
                <p className="text-2xl font-bold mt-1">{stats.activeProductCount} 件</p>
            </div>
            <div className="p-6 bg-card rounded-lg border shadow-sm">
                <h3 className="text-sm text-muted-foreground">待处理订单</h3>
                <p className="text-2xl font-bold mt-1">{stats.pendingOrderCount} 单</p>
            </div>
            <div className="p-6 bg-green-50 dark:bg-green-900/20 rounded-lg border shadow-sm">
                <h3 className="text-sm text-muted-foreground">可提现余额</h3>
                <p className="text-2xl font-bold mt-1 text-green-600">
                    {formatPrice(balanceWithdrawable, currencyCode)}
                </p>
                <Link href="/account/wallet" className="text-xs text-blue-600 hover:underline">
                    去提现 →
                </Link>
            </div>
        </div>
    );
}

export default function VendorDashboard() {
    // Mock data for static parts
    const mockData = {
        designerName: "设计师",
        recentOrders: [
            { id: 'ORD-001', product: '玫瑰花纹美甲', status: '待制作', date: '2026-02-09', designFee: 15.00 },
            { id: 'ORD-002', product: '星空渐变美甲', status: '已发货', date: '2026-02-08', designFee: 20.00 },
        ]
    };

    return (
        <div className="p-4">
            <div className="flex justify-between items-center mb-6">
                <div>
                    <h1 className="text-2xl font-bold">🎨 设计师中心</h1>
                    <p className="text-muted-foreground">欢迎回来</p>
                </div>
                <Link
                    href="/vendor/products/new"
                    className="bg-primary text-primary-foreground px-4 py-2 rounded-lg hover:opacity-90"
                >
                    + 发布新设计
                </Link>
            </div>

            <Suspense fallback={<div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8 h-24 bg-muted animate-pulse rounded-lg"></div>}>
                <DashboardStats />
            </Suspense>

            {/* 快捷操作 */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
                <Link href="/vendor/products" className="block p-4 border rounded-lg hover:bg-muted/50 transition-colors">
                    <p className="font-medium">📦 我的设计</p>
                    <p className="text-sm text-muted-foreground">管理已发布的设计作品</p>
                </Link>
                <Link href="/vendor/orders" className="block p-4 border rounded-lg hover:bg-muted/50 transition-colors">
                    <p className="font-medium">📋 订单管理</p>
                    <p className="text-sm text-muted-foreground">查看销售订单状态</p>
                </Link>
                <Link href="/account/wallet" className="block p-4 border rounded-lg hover:bg-muted/50 transition-colors">
                    <p className="font-medium">💰 收入明细</p>
                    <p className="text-sm text-muted-foreground">查看设计费收入和提现</p>
                </Link>
            </div>

            {/* 最近订单 */}
            <div>
                <div className="flex justify-between items-center mb-4">
                    <h2 className="font-semibold">最近订单</h2>
                    <Link href="/vendor/orders" className="text-sm text-blue-600 hover:underline">
                        查看全部 →
                    </Link>
                </div>
                <div className="border rounded-lg divide-y">
                    {mockData.recentOrders.map(order => (
                        <div key={order.id} className="p-4 flex justify-between items-center">
                            <div>
                                <p className="font-medium">{order.product}</p>
                                <p className="text-sm text-muted-foreground">{order.id} · {order.date}</p>
                            </div>
                            <div className="text-right">
                                <span className="text-sm px-2 py-1 rounded bg-yellow-100 text-yellow-800">
                                    {order.status}
                                </span>
                                <p className="text-sm text-green-600 mt-1">设计费 +€{order.designFee.toFixed(2)}</p>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    )
}


