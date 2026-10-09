import Link from 'next/link';
import { getActiveCustomer } from '@/lib/vendure/actions';
import { formatPrice } from '@/lib/format';
import { Suspense } from 'react';
import TransferForm from './TransferForm';
import ApplyPayoutButton from './ApplyPayoutButton';
import KycStatusSection from './KycStatusSection';
import PayoutHistoryList from './PayoutHistoryList';

export default async function WalletPage({ params: paramsPromise }: { params: Promise<{ country: string }> }) {
    const params = await paramsPromise;
    return (
        <div className="container mx-auto px-4 py-8 mt-16">
            <h1 className="text-2xl font-bold mb-6 flex items-center gap-2">💰 我的钱包 <span className="text-xs font-normal opacity-40 px-2 py-0.5 border rounded-full">AUDIT READY</span></h1>
            <Suspense fallback={<div className="py-8 text-center text-muted-foreground animate-pulse">正在获取加密钱包资产数据...</div>}>
                <WalletContent params={params} />
            </Suspense>
        </div>
    );
}

async function WalletContent({ params }: { params: { country: string } }) {
    const customer = await getActiveCustomer().catch(() => null);
    
    /**
     * [Logic 2] 钱包货币解耦
     * 钱包显示币种必须严格对照客户配置文件中的“默认国家 (countryCode)”，而非 URL 路径。
     */
    const CURRENCY_MAP: Record<string, string> = { 'HU': 'HUF', 'DE': 'EUR', 'AT': 'EUR', 'OTHER': 'EUR' };
    const customerCountry = (customer?.customFields as any)?.countryCode || (customer?.customFields as any)?.countrycode || 'DE';
    const currencyCode = CURRENCY_MAP[customerCountry.toUpperCase()] || 'EUR';

    // 数据库同步余额
    const balanceWithdrawable = (customer?.customFields as any)?.balanceWithdrawable || 0;
    const balanceBonus = (customer?.customFields as any)?.balanceBonus || 0;
    const balanceNonWithdrawable = (customer?.customFields as any)?.balanceNonWithdrawable || 0;
    const isDesigner = (customer?.customFields as any)?.isDesigner || false;
    const isKycVerified = (customer?.customFields as any)?.isKycVerified || false;
    const annualSpentEur = (customer?.customFields as any)?.annualSpentEur || 0;

    return (
        <>
            {/* [Logic 1] KYC 增强状态栏 */}
            <KycStatusSection 
                isDesigner={isDesigner} 
                isKycVerified={isKycVerified} 
                annualSpentEur={annualSpentEur}
            />

            {/* 余额卡片 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
                <div className="border rounded-2xl p-6 bg-gradient-to-br from-green-50 to-white dark:from-green-900/10 dark:to-transparent shadow-sm border-green-100 dark:border-green-800/30">
                    <p className="text-sm text-muted-foreground font-bold">可提现余额 (Payout Balance)</p>
                    <p className="text-4xl font-bold text-green-600 font-noto tracking-tight">
                        {formatPrice(balanceWithdrawable, currencyCode)}
                    </p>
                    <div className="flex gap-4 mt-6">
                        {isDesigner && isKycVerified ? (
                            <Link href={`/${params.country}/account/wallet/withdraw`} className="flex-1 text-center py-2 bg-blue-600 text-white rounded-xl text-sm font-bold hover:bg-blue-700 shadow-lg shadow-blue-500/20 active:scale-95 transition-all">
                                立即提现 (WorldFirst) →
                            </Link>
                        ) : isDesigner ? (
                            <div className="flex-1 text-center py-2 bg-gray-100 text-gray-400 rounded-xl text-sm font-bold cursor-not-allowed">
                                🔒 资料待完善 (解锁提现)
                            </div>
                        ) : (
                            <span className="text-sm text-gray-400">请申请开通提现功能</span>
                        )}
                        <Link href={`/${params.country}/account/wallet/transfer`} className="px-4 py-2 text-sm text-green-600 hover:bg-green-100 dark:hover:bg-green-900/30 rounded-xl font-bold transition-colors">
                            地址内转账 →
                        </Link>
                    </div>
                </div>
                <div className="border rounded-2xl p-6 bg-gradient-to-br from-blue-50 to-white dark:from-blue-900/10 dark:to-transparent shadow-sm border-blue-100 dark:border-blue-800/30">
                    <p className="text-sm text-muted-foreground font-bold">消费积分余额 (Bonus Balance)</p>
                    <p className="text-4xl font-bold text-blue-600 font-noto tracking-tight">
                        {formatPrice(balanceBonus, currencyCode)}
                    </p>
                    <p className="text-xs text-muted-foreground mt-4 opacity-60 italic">
                        该金额根据税务申报限制不可提现，仅限用于站内购物抵扣。
                    </p>
                </div>
            </div>

            {/* 提现历史流水 */}
            <div className="mb-8">
                <PayoutHistoryList payouts={customer?.payouts || []} />
            </div>

            {/* 提现功能申请逻辑 */}
            {!isDesigner && (
                <div className="mb-8">
                    <ApplyPayoutButton country={customerCountry.toLowerCase()} />
                </div>
            )}

            {/* 站内转账功能 (由 URL country 决定转账环境，但金额仍按钱包币种计算) */}
            <div className="mb-8">
                <div className="bg-white dark:bg-gray-900 border rounded-2xl overflow-hidden shadow-sm border-gray-100 dark:border-gray-800">
                    <div className="bg-gray-50 dark:bg-gray-800 px-6 py-4 border-b dark:border-gray-700">
                        <h2 className="text-lg font-bold flex items-center gap-2">
                            🤝 站内资产转账
                        </h2>
                    </div>
                    <div className="p-6">
                        <TransferForm 
                            initialBalance={balanceWithdrawable + balanceBonus + balanceNonWithdrawable}
                            currencyCode={currencyCode}
                            country={params.country}
                        />
                        
                        <div className="bg-yellow-50 dark:bg-yellow-900/10 border border-yellow-200 dark:border-yellow-800 rounded-xl p-4 mt-6">
                            <h3 className="text-sm font-bold text-yellow-800 dark:text-yellow-200 mb-2 font-noto">审计安全提示</h3>
                            <ul className="text-xs text-yellow-700 dark:text-yellow-300 space-y-1 opacity-80">
                                <li>• 转账操作将生成不可变审计流水，请核实目标账户邮箱。</li>
                                <li>• 跨币种转账将基于目标账户配置的默认国家进行汇率折算。</li>
                                <li>• 转账所得资产计入“消费余额”，不可二次申请提现。</li>
                            </ul>
                        </div>
                    </div>
                </div>
            </div>

            {/* 功能说明 */}
            <div className="border rounded-2xl p-6 mb-12 bg-muted/20 border-dashed">
                <h2 className="font-bold mb-4 flex items-center gap-2 text-lg">💡 设计师钱包合规手册</h2>
                <div className="grid md:grid-cols-2 gap-8 text-sm text-muted-foreground leading-relaxed">
                    <div className="space-y-2">
                        <p><strong>💶 提现与年度额度控制</strong></p>
                        <p>系统自动执行欧盟 DAC7 税务合规逻辑。当年度提现额度接近 2000 欧或单笔超过 250 欧时，系统将强制激活高级身份验证流程。</p>
                        <p><strong>📑 Gutschrift (自开票) 生成</strong></p>
                        <p>每次结算后后台将根据您提供的 KYC 哈希快照生成符合德国税务局审计要求的 Gutschrift 文档供留档。</p>
                    </div>
                    <div className="space-y-2">
                        <p><strong>🌍 货币汇率逻辑</strong></p>
                        <p>钱包货币始终与您的【默认国家】绑定。目前德国/奥地利使用 EUR，匈牙利使用 HUF。若进入非服务区（OTHER），系统将默认按欧元计价。</p>
                        <p><strong>🔄 提现处理时效</strong></p>
                        <p>所有提现通过 WorldFirst 处理，审核通过后 3-5 个工作日内到账。审核期间对应的提现余额将处于预锁定状态。</p>
                    </div>
                </div>
            </div>
        </>
    );
}
