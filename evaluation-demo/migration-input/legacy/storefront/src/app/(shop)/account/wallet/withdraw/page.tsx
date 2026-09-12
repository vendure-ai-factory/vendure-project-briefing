import Link from 'next/link';

// 提现申请页面
export default function WithdrawPage() {
    return (
        <div className="container mx-auto px-4 py-8 mt-16 max-w-2xl">
            <Link href="/account/wallet" className="text-sm text-blue-600 hover:underline mb-4 inline-block">
                ← 返回钱包
            </Link>
            <h1 className="text-2xl font-bold mb-6">申请提现</h1>

            <div className="border rounded-lg p-6 mb-6 bg-green-50 dark:bg-green-900/20">
                <p className="text-sm text-muted-foreground">可提现余额</p>
                <p className="text-3xl font-bold text-green-600">€125.50</p>
            </div>

            <form className="space-y-4">
                <div>
                    <label className="block text-sm font-medium mb-1">提现金额 (EUR)</label>
                    <input
                        type="number"
                        className="w-full border rounded-lg p-3"
                        placeholder="输入提现金额"
                        min="10"
                        max="125.50"
                    />
                    <p className="text-xs text-muted-foreground mt-1">最低提现金额：€10.00</p>
                </div>

                <div className="border rounded-lg p-4 bg-muted/30">
                    <h3 className="font-semibold mb-2">Stripe Connect 账户</h3>
                    <p className="text-sm text-muted-foreground mb-2">
                        提现将转入您绑定的 Stripe Connect 账户
                    </p>
                    <p className="text-sm">
                        账户状态：<span className="text-green-600 font-medium">已绑定 ✓</span>
                    </p>
                    <p className="text-xs text-muted-foreground mt-2">
                        到账时间：通常 2-3 个工作日
                    </p>
                </div>

                <button
                    type="submit"
                    className="w-full bg-primary text-primary-foreground rounded-lg p-3 font-medium hover:opacity-90"
                >
                    确认提现
                </button>
            </form>

            <div className="mt-8 border rounded-lg p-4 bg-yellow-50 dark:bg-yellow-900/20">
                <h3 className="font-semibold mb-2">⚠️ 提现说明</h3>
                <ul className="text-sm text-muted-foreground space-y-1">
                    <li>• 首次提现需要完成 Stripe 身份验证</li>
                    <li>• 提现手续费由 Stripe 收取（约 0.25% + €0.25）</li>
                    <li>• 站内消费余额不可提现</li>
                </ul>
            </div>
        </div>
    );
}
