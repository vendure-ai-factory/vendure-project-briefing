import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { submitKycForm } from '@/lib/vendure/actions';
import { verifyKycAction } from '@/lib/wallet-actions';

type KycModalMode = 'EDIT' | 'VERIFY';

export default function KycFormModal({ onClose, mode = 'EDIT', country = 'DE' }: { onClose: () => void, mode?: KycModalMode, country?: string }) {
    const [loading, setLoading] = useState(false);
    const [simulationStep, setSimulationStep] = useState(0); // 0: Start, 1: Scanning, 2: Analyzing, 3: Success
    const [error, setError] = useState<string | null>(null);
    const router = useRouter();

    // 如果是 VERIFY 模式，启动仿真流程
    useEffect(() => {
        if (mode === 'VERIFY') {
            const steps = [
                { delay: 1000, step: 1 }, // Scanning
                { delay: 3000, step: 2 }, // Analyzing
                { delay: 5000, step: 3 }, // Success
            ];
            
            steps.forEach(({ delay, step }) => {
                setTimeout(() => setSimulationStep(step), delay);
            });
        }
    }, [mode]);

    const handleVerify = async () => {
        setLoading(true);
        try {
            const result = await verifyKycAction(country);
            if (result.success) {
                router.refresh();
                onClose();
            } else {
                setError(result.message);
            }
        } catch (err: any) {
            setError(err.message || 'Verification failed');
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        const formData = new FormData(e.currentTarget);
        // ... (rest of the submission logic)
        const firstName = (formData.get('firstName') as string)?.trim();
        const lastName = (formData.get('lastName') as string)?.trim();
        const taxId = (formData.get('taxId') as string)?.trim();

        if (!firstName || !lastName || !taxId) {
            setError('请填写所有必填字段（真实姓名及税务识别号）');
            setLoading(false);
            return;
        }

        const input = {
            firstName,
            lastName,
            street: (formData.get('street') as string)?.trim(),
            houseNumber: (formData.get('houseNumber') as string)?.trim(),
            zip: (formData.get('zip') as string)?.trim(),
            city: (formData.get('city') as string)?.trim(),
            country: (formData.get('country') as string)?.trim().toUpperCase(),
            taxId,
            vatId: (formData.get('vatId') as string)?.trim(),
            isSmallBusiness: formData.get('isSmallBusiness') === 'on',
            agbAccepted: formData.get('agbAccepted') === 'on',
        };

        try {
            const result = await submitKycForm(input);
            if (result) {
                router.refresh();
                onClose();
            } else {
                setError('提交失败，请检查输入或稍后再试。');
            }
        } catch (err: any) {
            setError(err.message || '提交过程中发生错误');
        } finally {
            setLoading(false);
        }
    };

    if (mode === 'VERIFY') {
        return (
            <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md z-50 flex items-center justify-center p-4 overflow-hidden">
                <div className="bg-white dark:bg-gray-900 rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden animate-in fade-in zoom-in duration-500 border border-white/10">
                    <div className="p-8 text-center space-y-6">
                        {simulationStep < 3 ? (
                            <>
                                <div className="relative w-32 h-32 mx-auto">
                                    <div className="absolute inset-0 rounded-full border-4 border-blue-100 dark:border-blue-900/30"></div>
                                    <div className={`absolute inset-0 rounded-full border-4 border-blue-600 border-t-transparent animate-spin`}></div>
                                    <div className="absolute inset-0 flex items-center justify-center text-4xl">
                                        {simulationStep === 0 && '📡'}
                                        {simulationStep === 1 && '📸'}
                                        {simulationStep === 2 && '🔍'}
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <h2 className="text-2xl font-black tracking-tight">
                                        {simulationStep === 0 && '正在连接身份验证服务器...'}
                                        {simulationStep === 1 && '正在扫描证件有效性...'}
                                        {simulationStep === 2 && 'AI 正在分析生物体征...'}
                                    </h2>
                                    <p className="text-muted-foreground text-sm px-8">
                                        由 <strong>Stripe Identity</strong> 提供技术支持。请按屏幕提示保持证件在光线充足的环境下。
                                    </p>
                                </div>
                                <div className="w-full bg-gray-100 dark:bg-gray-800 h-2 rounded-full overflow-hidden">
                                    <div 
                                        className="h-full bg-blue-600 transition-all duration-1000 ease-out"
                                        style={{ width: `${(simulationStep / 3) * 100}%` }}
                                    ></div>
                                </div>
                            </>
                        ) : (
                            <div className="animate-in slide-in-from-bottom-8 duration-700 space-y-6">
                                <div className="w-24 h-24 bg-green-100 dark:bg-green-900/30 text-green-600 rounded-full flex items-center justify-center mx-auto text-5xl shadow-inner">
                                    ✓
                                </div>
                                <div className="space-y-2">
                                    <h2 className="text-2xl font-black text-green-700 dark:text-green-400">身份核验成功！</h2>
                                    <p className="text-muted-foreground text-sm">
                                        您的证件已通过 AI 自动审核。提现限制已解除，您可以进行大额资金结算了。
                                    </p>
                                </div>
                                
                                {error && (
                                    <div className="p-3 bg-red-50 text-red-700 rounded-xl text-xs border border-red-100">
                                        ⚠️ {error}
                                    </div>
                                )}

                                <button 
                                    onClick={handleVerify}
                                    disabled={loading}
                                    className="w-full py-4 bg-green-600 hover:bg-green-700 text-white rounded-2xl font-black text-lg shadow-xl shadow-green-600/20 active:scale-95 transition-all flex items-center justify-center gap-2"
                                >
                                    {loading ? (
                                        <svg className="animate-spin h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                    ) : '立即解锁资金 🚀'}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden animate-in fade-in zoom-in duration-300">
                <div className="bg-blue-600 px-6 py-4 flex justify-between items-center text-white">
                    <h2 className="text-xl font-bold font-noto">📝 完善提现身份信息</h2>
                    <button onClick={onClose} className="hover:opacity-70 transition-opacity">✕</button>
                </div>
                
                <form onSubmit={handleSubmit} className="p-6 space-y-4 max-h-[80vh] overflow-y-auto">
                    <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 p-4 rounded-xl text-sm text-yellow-800 dark:text-yellow-200 mb-4">
                        <p className="font-bold mb-1">🏦 税务合规声明</p>
                        <p className="opacity-80">根据欧盟 GoBD 标准，所有结算提现必须对应真实身份。信息一经提交将产生存证哈希，用于审计。请务必填写您的法定真实资料。</p>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1">
                            <label className="text-xs font-bold uppercase tracking-wider opacity-60">真实名字 (First Name)</label>
                            <input name="firstName" required className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 bg-transparent text-foreground" />
                        </div>
                        <div className="space-y-1">
                            <label className="text-xs font-bold uppercase tracking-wider opacity-60">真实姓氏 (Last Name)</label>
                            <input name="lastName" required className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 bg-transparent text-foreground" />
                        </div>
                    </div>

                    <div className="grid grid-cols-3 gap-4">
                        <div className="col-span-2 space-y-1">
                            <label className="text-xs font-bold uppercase tracking-wider opacity-60">街道 (Street)</label>
                            <input name="street" required className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 bg-transparent text-foreground" />
                        </div>
                        <div className="space-y-1">
                            <label className="text-xs font-bold uppercase tracking-wider opacity-60">门牌号 (Nr.)</label>
                            <input name="houseNumber" required className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 bg-transparent text-foreground" />
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1">
                            <label className="text-xs font-bold uppercase tracking-wider opacity-60">邮编 (ZIP Code)</label>
                            <input name="zip" required className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 bg-transparent text-foreground" />
                        </div>
                        <div className="space-y-1">
                            <label className="text-xs font-bold uppercase tracking-wider opacity-60">城市 (City)</label>
                            <input name="city" required className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 bg-transparent text-foreground" />
                        </div>
                    </div>

                    <div className="space-y-1">
                        <label className="text-xs font-bold uppercase tracking-wider opacity-60">国家 (Country Code, e.g. DE)</label>
                        <input name="country" required maxLength={2} className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 bg-transparent uppercase text-foreground" defaultValue={country} />
                    </div>

                    <hr className="opacity-10" />

                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1">
                            <label className="text-xs font-bold uppercase tracking-wider opacity-60">税务识别号 (Tax ID / Steuernummer)</label>
                            <input name="taxId" required className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 bg-transparent text-foreground" />
                        </div>
                        <div className="space-y-1">
                            <label className="text-xs font-bold uppercase tracking-wider opacity-60">增值税号 (Optional VAT ID)</label>
                            <input name="vatId" className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 bg-transparent placeholder:opacity-30 text-foreground" placeholder="DE123456789" />
                        </div>
                    </div>

                    <label className="flex items-start gap-3 p-3 bg-blue-50 dark:bg-blue-900/10 rounded-xl cursor-pointer hover:bg-blue-100 dark:hover:bg-blue-900/20 transition-colors border border-blue-100 dark:border-blue-800">
                        <input type="checkbox" name="agbAccepted" required className="w-5 h-5 mt-0.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                        <div className="text-sm">
                            <p className="font-bold text-blue-800 dark:text-blue-300">我已阅读并同意《数字资产转让协议 (AGB)》</p>
                            <p className="text-xs opacity-60">我确认以上提现款项对应合规的数字劳务或推广服务，并授权平台代为开具合规凭证报送至万里汇。</p>
                        </div>
                    </label>

                    {error && (
                        <div className="p-3 bg-red-100 text-red-700 rounded-lg text-sm border border-red-200">
                            ⚠️ {error}
                        </div>
                    )}

                    <div className="flex gap-3 pt-4">
                        <button 
                            type="button" 
                            onClick={onClose} 
                            className="flex-1 px-6 py-3 rounded-xl border font-bold hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-foreground"
                        >
                            取消
                        </button>
                        <button 
                            type="submit" 
                            disabled={loading}
                            className="flex-[2] px-6 py-3 rounded-xl bg-blue-600 text-white font-bold hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-all shadow-lg shadow-blue-600/20"
                        >
                            {loading ? '正在哈希存证...' : '提交身份审核'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
