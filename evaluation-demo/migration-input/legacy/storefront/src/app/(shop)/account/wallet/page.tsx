import Link from 'next/link';

// 简化版钱包页面 - 功能演示
export default async function WalletPage() {
    // TODO: 从后端获取真实余额数据
    const mockWalletData = {
        availableBalance: 125.50,  // 可提现余额
        lockedBalance: 50.00,      // 不可提现余额（站内消费用）
        currency: 'EUR',
        recentTransactions: [
            { id: '1', type: 'income', description: '设计作品销售收入 - 玫瑰花纹', amount: 15.00, date: '2026-02-09' },
            { id: '2', type: 'income', description: '推荐奖励 - 用户 Alice 注册', amount: 5.00, date: '2026-02-08' },
            { id: '3', type: 'expense', description: '购买商品 - 法式美甲套装', amount: -25.00, date: '2026-02-07' },
            { id: '4', type: 'income', description: '设计作品销售收入 - 星空渐变', amount: 20.00, date: '2026-02-05' },
        ]
    };

    return (
        <div className="container mx-auto px-4 py-8 mt-16">
            <h1 className="text-2xl font-bold mb-6">💰 我的钱包</h1>

            {/* 余额卡片 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
                <div className="border rounded-lg p-6 bg-green-50 dark:bg-green-900/20">
                    <p className="text-sm text-muted-foreground">可提现余额</p>
                    <p className="text-3xl font-bold text-green-600">€{mockWalletData.availableBalance.toFixed(2)}</p>
                    <Link href="/account/wallet/withdraw" className="text-sm text-blue-600 hover:underline mt-2 inline-block">
                        申请提现 →
                    </Link>
                </div>
                <div className="border rounded-lg p-6 bg-blue-50 dark:bg-blue-900/20">
                    <p className="text-sm text-muted-foreground">站内消费余额（不可提现）</p>
                    <p className="text-3xl font-bold text-blue-600">€{mockWalletData.lockedBalance.toFixed(2)}</p>
                    <p className="text-xs text-muted-foreground mt-2">可用于站内购物抵扣</p>
                </div>
            </div>

            {/* 功能说明 */}
            <div className="border rounded-lg p-4 mb-8 bg-muted/30">
                <h2 className="font-semibold mb-2">💡 钱包说明</h2>
                <ul className="text-sm text-muted-foreground space-y-1">
                    <li>• <strong>可提现余额</strong>：设计作品销售收入、推荐奖励等，可提现到银行账户</li>
                    <li>• <strong>站内消费余额</strong>：订阅费返还、优惠券兑换等，仅限站内购物使用</li>
                    <li>• 提现通过 Stripe Connect 处理，通常 2-3 个工作日到账</li>
                </ul>
            </div>

            {/* 最近交易记录 */}
            <div>
                <div className="flex justify-between items-center mb-4">
                    <h2 className="font-semibold">最近交易</h2>
                    <Link href="/account/wallet/history" className="text-sm text-blue-600 hover:underline">
                        查看全部 →
                    </Link>
                </div>
                <div className="border rounded-lg divide-y">
                    {mockWalletData.recentTransactions.map(tx => (
                        <div key={tx.id} className="p-4 flex justify-between items-center">
                            <div>
                                <p className="font-medium">{tx.description}</p>
                                <p className="text-sm text-muted-foreground">{tx.date}</p>
                            </div>
                            <p className={`font-bold ${tx.amount > 0 ? 'text-green-600' : 'text-red-600'}`}>
                                {tx.amount > 0 ? '+' : ''}€{tx.amount.toFixed(2)}
                            </p>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
