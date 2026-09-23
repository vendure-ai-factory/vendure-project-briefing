import Link from 'next/link';
import { getActiveCustomer, getActiveKycForm } from '@/lib/vendure/actions';
import { formatPrice } from '@/lib/format';
import WithdrawForm from './WithdrawForm';

export default async function WithdrawPage({ params: paramsPromise }: { params: Promise<{ country: string }> }) {
    const params = await paramsPromise;
    const [customer, kycForm] = await Promise.all([
        getActiveCustomer().catch(() => null),
        getActiveKycForm().catch(() => null)
    ]);
    
    // Determine currency based on customer native country
    const CURRENCY_MAP: Record<string, string> = { 'HU': 'HUF', 'DE': 'EUR', 'AT': 'EUR', 'OTHER': 'EUR' };
    const customerCountry = (customer?.customFields as any)?.countryCode || 'DE';
    const currencyCode = CURRENCY_MAP[customerCountry] || 'EUR';
    const balanceWithdrawable = (customer?.customFields as any)?.balanceWithdrawable || 0;
    const isDesigner = (customer?.customFields as any)?.isDesigner || false;
    const annualSpentEur = (customer?.customFields as any)?.annualSpentEur || 0;

    if (!isDesigner) {
        return (
            <div className="container mx-auto px-4 py-8 mt-16 max-w-2xl text-center">
                <h1 className="text-2xl font-bold mb-4">权限不足</h1>
                <p className="mb-6">您尚未开通提现功能，请先在钱包页面完成申请。</p>
                <Link href={`/${params.country}/account/wallet`} className="text-blue-600 hover:underline">
                    返回钱包 →
                </Link>
            </div>
        );
    }

    return (
        <div className="container mx-auto px-4 py-8 mt-16 max-w-2xl">
            <Link href={`/${params.country}/account/wallet`} className="text-sm text-blue-600 hover:underline mb-4 inline-block">
                ← 返回钱包
            </Link>
            <h1 className="text-2xl font-bold mb-6">申请提现 (WorldFirst结算)</h1>

            <div className="border rounded-lg p-6 mb-8 bg-green-50 dark:bg-green-900/10 border-green-200">
                <p className="text-sm text-muted-foreground">当前可提现余额 (AUA)</p>
                <p className="text-4xl font-bold text-green-600">
                    {formatPrice(balanceWithdrawable, currencyCode)}
                </p>
                <p className="text-xs text-muted-foreground mt-2">
                    💡 提现将自动扣除对应的余额，并生成合规的自开票 (Gutschrift)。
                </p>
            </div>

            <div className="bg-white dark:bg-gray-900 border rounded-2xl shadow-sm overflow-hidden">
                <div className="bg-blue-600 px-6 py-4">
                    <h2 className="text-white font-bold flex items-center gap-2">
                        📑 财务结算信息与提现详情
                    </h2>
                </div>
                <div className="p-6">
                    <WithdrawForm 
                        balance={balanceWithdrawable} 
                        currencyCode={currencyCode} 
                        country={params.country}
                        kycForm={kycForm}
                        annualSpentEur={annualSpentEur}
                    />
                </div>
            </div>

            <div className="mt-8 border rounded-lg p-4 bg-blue-50 dark:bg-blue-900/10 border-blue-100">
                <h3 className="font-semibold mb-2">💡 结算说明</h3>
                <ul className="text-sm text-muted-foreground space-y-1">
                    <li>• <strong>结算货币</strong>：提现金额将根据您的账户币种 ({currencyCode}) 汇至您的 WorldFirst 钱包。</li>
                    <li>• <strong>税务合规</strong>：系统将根据您填写的身份信息生成 PDF Gutschrift，存储在服务端审计目录中。</li>
                    <li>• <strong>到账时效</strong>：通常在 T+1 个工作日内处理，具体视银行结算时间而定。</li>
                </ul>
            </div>
        </div>
    );
}
