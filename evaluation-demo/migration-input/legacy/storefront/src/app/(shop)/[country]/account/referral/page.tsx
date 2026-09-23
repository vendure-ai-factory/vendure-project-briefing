import Link from 'next/link';

// 推荐有奖页面
export default function ReferralPage() {
    // TODO: 从后端获取真实数据
    const mockData = {
        referralCode: 'REF-USER123',
        referralLink: 'https://example.com/register?ref=REF-USER123',
        totalEarnings: 45.00,
        referralCount: 9,
        rewards: [
            { id: '1', type: 'registration', user: 'Alice', amount: 5.00, date: '2026-02-08' },
            { id: '2', type: 'purchase', user: 'Bob', amount: 10.00, date: '2026-02-07', orderAmount: 200.00 },
            { id: '3', type: 'registration', user: 'Carol', amount: 5.00, date: '2026-02-05' },
        ]
    };

    return (
        <div className="container mx-auto px-4 py-8 mt-16">
            <h1 className="text-2xl font-bold mb-6">🎁 推荐有奖</h1>

            {/* 推荐码卡片 */}
            <div className="border rounded-lg p-6 mb-6 bg-gradient-to-r from-purple-50 to-pink-50 dark:from-purple-900/20 dark:to-pink-900/20">
                <p className="text-sm text-muted-foreground mb-2">你的专属推荐码</p>
                <div className="flex items-center gap-4">
                    <code className="text-2xl font-bold bg-white dark:bg-gray-800 px-4 py-2 rounded">
                        {mockData.referralCode}
                    </code>
                    <button className="bg-primary text-primary-foreground px-4 py-2 rounded hover:opacity-90">
                        复制链接
                    </button>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                    推荐链接：{mockData.referralLink}
                </p>
            </div>

            {/* 统计数据 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
                <div className="border rounded-lg p-6">
                    <p className="text-sm text-muted-foreground">累计奖励收入</p>
                    <p className="text-3xl font-bold text-green-600">€{mockData.totalEarnings.toFixed(2)}</p>
                </div>
                <div className="border rounded-lg p-6">
                    <p className="text-sm text-muted-foreground">成功推荐人数</p>
                    <p className="text-3xl font-bold">{mockData.referralCount} 人</p>
                </div>
            </div>

            {/* 奖励规则 */}
            <div className="border rounded-lg p-4 mb-8 bg-muted/30">
                <h2 className="font-semibold mb-3">🎯 奖励规则</h2>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                    <div className="border rounded p-3 bg-white dark:bg-gray-800">
                        <p className="font-medium">注册奖励</p>
                        <p className="text-muted-foreground">好友通过链接注册</p>
                        <p className="text-green-600 font-bold">你和好友各得 €5</p>
                    </div>
                    <div className="border rounded p-3 bg-white dark:bg-gray-800">
                        <p className="font-medium">消费提成</p>
                        <p className="text-muted-foreground">好友首次消费</p>
                        <p className="text-green-600 font-bold">你得 5% 提成</p>
                    </div>
                    <div className="border rounded p-3 bg-white dark:bg-gray-800">
                        <p className="font-medium">商家推荐</p>
                        <p className="text-muted-foreground">推荐商家成为订阅用户</p>
                        <p className="text-green-600 font-bold">你得 €50 奖金</p>
                    </div>
                </div>
            </div>

            {/* 奖励记录 */}
            <div>
                <div className="flex justify-between items-center mb-4">
                    <h2 className="font-semibold">最近奖励</h2>
                    <Link href="/account/referral/rewards" className="text-sm text-blue-600 hover:underline">
                        查看全部 →
                    </Link>
                </div>
                <div className="border rounded-lg divide-y">
                    {mockData.rewards.map(reward => (
                        <div key={reward.id} className="p-4 flex justify-between items-center">
                            <div>
                                <p className="font-medium">
                                    {reward.type === 'registration' ? '注册奖励' : '消费提成'}
                                    - 用户 {reward.user}
                                </p>
                                <p className="text-sm text-muted-foreground">{reward.date}</p>
                                {reward.orderAmount && (
                                    <p className="text-xs text-muted-foreground">订单金额：€{reward.orderAmount}</p>
                                )}
                            </div>
                            <p className="font-bold text-green-600">+€{reward.amount.toFixed(2)}</p>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
