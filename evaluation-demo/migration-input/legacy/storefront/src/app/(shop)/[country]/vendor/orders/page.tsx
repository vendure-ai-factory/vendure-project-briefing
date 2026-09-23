import Link from 'next/link';

// 设计师订单管理页面
export default function VendorOrdersPage() {
    // Mock data
    const orders = [
        {
            id: 'ORD-2026020901',
            product: '玫瑰花纹美甲',
            customer: '张小姐',
            status: 'pending',
            statusText: '待制作',
            date: '2026-02-09 14:30',
            designFee: 15.00,
            totalAmount: 45.00
        },
        {
            id: 'ORD-2026020801',
            product: '星空渐变美甲',
            customer: '李女士',
            status: 'shipped',
            statusText: '已发货',
            date: '2026-02-08 10:15',
            designFee: 20.00,
            totalAmount: 50.00
        },
        {
            id: 'ORD-2026020701',
            product: '法式简约美甲',
            customer: '王小姐',
            status: 'completed',
            statusText: '已完成',
            date: '2026-02-07 16:45',
            designFee: 12.00,
            totalAmount: 42.00
        },
        {
            id: 'ORD-2026020601',
            product: '玫瑰花纹美甲',
            customer: '陈女士',
            status: 'completed',
            statusText: '已完成',
            date: '2026-02-06 09:20',
            designFee: 15.00,
            totalAmount: 45.00
        },
    ];

    const statusColor = (status: string) => {
        switch (status) {
            case 'pending': return 'bg-yellow-100 text-yellow-800';
            case 'processing': return 'bg-blue-100 text-blue-800';
            case 'shipped': return 'bg-purple-100 text-purple-800';
            case 'completed': return 'bg-green-100 text-green-800';
            default: return 'bg-gray-100 text-gray-800';
        }
    };

    return (
        <div className="p-4">
            <h1 className="text-2xl font-bold mb-6">📋 销售订单</h1>

            {/* 筛选栏 */}
            <div className="flex gap-4 mb-6">
                <button className="px-4 py-2 border rounded-lg bg-primary text-primary-foreground">全部</button>
                <button className="px-4 py-2 border rounded-lg hover:bg-muted/50">待制作</button>
                <button className="px-4 py-2 border rounded-lg hover:bg-muted/50">制作中</button>
                <button className="px-4 py-2 border rounded-lg hover:bg-muted/50">已发货</button>
                <button className="px-4 py-2 border rounded-lg hover:bg-muted/50">已完成</button>
            </div>

            {/* 订单列表 */}
            <div className="border rounded-lg divide-y">
                {orders.map(order => (
                    <div key={order.id} className="p-4">
                        <div className="flex justify-between items-start mb-2">
                            <div>
                                <p className="font-medium">{order.product}</p>
                                <p className="text-sm text-muted-foreground">
                                    订单号：{order.id} · 客户：{order.customer}
                                </p>
                                <p className="text-xs text-muted-foreground">{order.date}</p>
                            </div>
                            <div className="text-right">
                                <span className={`px-2 py-1 rounded text-sm ${statusColor(order.status)}`}>
                                    {order.statusText}
                                </span>
                            </div>
                        </div>
                        <div className="flex justify-between items-center pt-2 border-t mt-2">
                            <div className="text-sm">
                                <span className="text-muted-foreground">订单金额：</span>
                                <span>€{order.totalAmount.toFixed(2)}</span>
                                <span className="mx-2">|</span>
                                <span className="text-green-600 font-medium">
                                    你的设计费：+€{order.designFee.toFixed(2)}
                                </span>
                            </div>
                            <Link
                                href={`/vendor/orders/${order.id}`}
                                className="text-sm text-blue-600 hover:underline"
                            >
                                查看详情 →
                            </Link>
                        </div>
                    </div>
                ))}
            </div>

            {/* 说明 */}
            <div className="mt-6 p-4 bg-muted/30 rounded-lg">
                <p className="text-sm text-muted-foreground">
                    <strong>说明：</strong>订单由平台统一处理制作和发货，你只需关注设计费收入。
                    订单完成后，设计费会自动进入你的钱包余额。
                </p>
            </div>
        </div>
    );
}
