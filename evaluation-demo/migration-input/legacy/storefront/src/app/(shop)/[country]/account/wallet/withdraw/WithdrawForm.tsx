"use client";

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { requestPayoutAction } from '@/lib/wallet-actions';
import { formatPrice } from '@/lib/format';
import Link from 'next/link';
import KycFormModal from '../KycFormModal';

type WithdrawFormProps = {
    balance: number;
    currencyCode: string;
    country: string;
    kycForm: any;
    annualSpentEur: number;
};

export default function WithdrawForm({ balance, currencyCode, country, kycForm, annualSpentEur }: WithdrawFormProps) {
    const [state, formAction] = useActionState(requestPayoutAction, null);
    const [showKycModal, setShowKycModal] = useState(false);
    const [amount, setAmount] = useState<string>('');

    const isThresholdError = state?.message?.includes('Strong Identity Verification');
    
    // 实时计算是否触发限额
    const multiplier = (currencyCode === 'HUF') ? 1 : 100;
    const currentAmountCents = Math.round((parseFloat(amount) || 0) * multiplier);
    
    // 将当前金额转为 EUR Cents (粗略估计，后端有精确汇率，前端做 1:1 或固定比例参考)
    // 假设非 EUR 币种按 1:1 分计或简单汇率转换。
    // 为了极致体验，我们在这里做一个简单的汇率参考（实际上 HUF 是 1/400）
    const amountInEurCents = currencyCode === 'EUR' ? currentAmountCents : (currencyCode === 'HUF' ? currentAmountCents / 4 : currentAmountCents);
    
    const isSingleLimitTriggered = amountInEurCents >= 25000;
    const isAnnualLimitTriggered = (annualSpentEur + amountInEurCents) >= 200000;
    const isKycFullyVerified = kycForm?.source === 'VERIFIED';
    
    const showComplianceWarning = (isSingleLimitTriggered || isAnnualLimitTriggered) && !isKycFullyVerified;

    return (
        <div className="relative">
            <form action={formAction} className="space-y-6">
                <input type="hidden" name="country" value={country} />
                <input type="hidden" name="currencyCode" value={currencyCode} />

                <div className="space-y-4">
                    <h3 className="text-lg font-semibold border-b pb-2 flex items-center gap-2">
                        <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-600 text-xs">1</span> 
                        提现金额
                    </h3>
                    <div>
                        <label className="block text-sm font-medium mb-1 opacity-70">您要提取出的数额 ({currencyCode})</label>
                        <div className="relative">
                            <input
                                name="amount"
                                type="number"
                                step="0.01"
                                value={amount}
                                onChange={(e) => setAmount(e.target.value)}
                                min="10"
                                max={(balance / (currencyCode === 'HUF' ? 1 : 100)).toFixed(2)}
                                placeholder="0.00"
                                className={`w-full px-4 py-3 border rounded-xl focus:ring-2 outline-none bg-gray-50 dark:bg-gray-800 text-xl font-bold transition-all ${
                                    showComplianceWarning ? 'border-orange-400 focus:ring-orange-500 ring-2 ring-orange-100' : 'focus:ring-blue-500'
                                }`}
                                required
                            />
                            <span className="absolute right-4 top-3.5 text-sm text-muted-foreground font-mono font-bold">
                                {currencyCode}
                            </span>
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-2 px-1 flex justify-between">
                            <span>最低提现额度为 {formatPrice(1000, currencyCode)}</span>
                            {annualSpentEur > 0 && <span>本年度已累计提现: {formatPrice(annualSpentEur, 'EUR')}</span>}
                        </p>
                    </div>

                    {showComplianceWarning && (
                        <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 p-4 rounded-xl animate-in zoom-in duration-300">
                            <div className="flex gap-3 text-orange-800 dark:text-orange-200">
                                <span className="text-xl">⚠️</span>
                                <div className="text-xs">
                                    <p className="font-bold mb-1">合规提醒：即将触发强核验阈值</p>
                                    <p className="opacity-80">
                                        您的提现金额{isSingleLimitTriggered ? '单笔超过 €250' : '年度累计将超过 €2,000'}。
                                        根据欧盟监管要求，您必须完成证件扫描核验（Stripe Identity）后方可继续。
                                    </p>
                                    <button 
                                        type="button"
                                        onClick={() => setShowKycModal(true)}
                                        className="mt-2 text-blue-600 dark:text-blue-400 font-bold hover:underline underline-offset-4"
                                    >
                                        立即开启身份核验流程 →
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                <div className="space-y-4 pt-4">
                    <h3 className="text-lg font-semibold border-b pb-2 flex items-center gap-2">
                        <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-600 text-xs">2</span> 
                        收款账户 (WorldFirst Account)
                    </h3>
                    <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-xl border border-gray-100 dark:border-gray-700">
                        <label className="block text-sm font-medium mb-1 opacity-70">您的 WorldFirst 账号 (Account ID)</label>
                        <input
                            name="wfAccountId"
                            type="text"
                            placeholder="例如: WF88888888"
                            className="w-full px-4 py-2 border rounded-xl focus:ring-2 focus:ring-blue-500 outline-none bg-white dark:bg-gray-900 font-mono"
                            required
                        />
                        <p className="text-[10px] text-muted-foreground mt-2">
                            * 请从您的 WorldFirst 沙箱面板复制最新的收款账号。该账号将与您的 Gutschrift 永久关联。
                        </p>
                    </div>

                    <h3 className="text-lg font-semibold border-b pb-2 flex items-center gap-2 pt-4">
                        <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-600 text-xs">3</span> 
                        合规身份摘要 (用于生成 Gutschrift)
                    </h3>
                    
                    {kycForm ? (
                        <div className={`rounded-2xl p-5 border border-dashed transition-all ${
                            isKycFullyVerified 
                                ? 'bg-blue-50/50 border-blue-200 dark:bg-blue-900/10' 
                                : 'bg-gray-50 dark:bg-gray-800 border-gray-200'
                        }`}>
                            <div className="flex justify-between items-start mb-3">
                                <p className="text-xs font-bold uppercase tracking-widest opacity-40">Verified Identity</p>
                                {isKycFullyVerified ? (
                                    <span className="px-2 py-0.5 bg-green-100 text-green-700 text-[10px] font-black rounded-full border border-green-200 flex items-center gap-1">
                                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd"/></svg>
                                        ID VERIFIED (NO LIMIT)
                                    </span>
                                ) : (
                                    <span className="px-2 py-0.5 bg-yellow-100 text-yellow-700 text-[10px] font-black rounded-full border border-yellow-200">
                                        LIMITED (BASIC KYC)
                                    </span>
                                )}
                            </div>
                            <div className="grid grid-cols-2 gap-y-3 text-sm">
                                <p className="text-muted-foreground">法定姓名：</p>
                                <p className="font-bold">{kycForm.firstName} {kycForm.lastName}</p>
                                
                                <p className="text-muted-foreground">注册住址：</p>
                                <p className="text-xs leading-tight">
                                    {kycForm.street} {kycForm.houseNumber}<br/>
                                    {kycForm.zip} {kycForm.city}, {kycForm.country}
                                </p>
                                
                                <p className="text-muted-foreground">税务标识：</p>
                                <p className="font-mono text-xs">{kycForm.taxId || 'N/A'} {kycForm.vatId ? `(${kycForm.vatId})` : ''}</p>
                                
                                <p className="text-muted-foreground">企业属性：</p>
                                <p className="text-xs">{kycForm.isSmallBusiness ? '§ 19 UStG (小微免税)' : '标准纳税人'}</p>
                            </div>
                            
                            <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-700 flex justify-between items-center">
                                <span className="text-[10px] text-green-600 font-mono opacity-50"># HASH ORIGIN: {kycForm.hash.substring(0, 12)}...</span>
                                <button 
                                    type="button"
                                    onClick={() => setShowKycModal(true)}
                                    className="text-xs text-blue-600 hover:underline font-bold"
                                >
                                    修改身份信息 →
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-800 p-6 rounded-2xl flex flex-col items-center text-center">
                            <div className="w-12 h-12 bg-red-100 text-red-600 rounded-full flex items-center justify-center mb-3">
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                </svg>
                            </div>
                            <p className="text-sm font-bold text-red-700 mb-1">未检测到有效的 KYC 合规表单</p>
                            <p className="text-xs text-red-600/70 mb-4">根据反洗钱法要求，提现前必须完善您的法定身份信息。</p>
                            <button 
                                type="button"
                                onClick={() => setShowKycModal(true)}
                                className="px-6 py-2 bg-red-600 text-white rounded-xl text-xs font-bold hover:bg-red-700 transition-all shadow-lg shadow-red-600/20 active:scale-95"
                            >
                                立即完善身份信息 (欧盟合规) →
                            </button>
                        </div>
                    )}
                </div>

                {state && (
                    <div className={`p-5 rounded-2xl text-sm font-medium animate-in fade-in slide-in-from-top-4 duration-500 shadow-sm ${
                        state.success ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
                    }`}>
                        <div className="flex gap-3">
                            <span className="flex-shrink-0 text-xl">{state.success ? '✅' : '⚠️'}</span>
                            <div className="flex-1">
                                {state.state === 'AWAITING_KYC' && (
                                    <div className="mt-4 bg-blue-600 p-4 rounded-xl text-white shadow-lg animate-pulse">
                                        <div className="flex items-center gap-2 mb-2 font-black italic">
                                            <span>🎴 WORLD CARD ASYNC LOOP</span>
                                        </div>
                                        <p className="text-xs leading-relaxed opacity-90">
                                            您的申请已进入万汇里 API 全球 Pillar 异步流水。由于金额超过 €250，系统已为您在后台发起“全球发卡”流程。请保持手机畅通，待身份确认后，资金将自动释放至您的虚拟卡。
                                        </p>
                                    </div>
                                )}
                                {isFxError && (
                                    <div className="mt-4 bg-white/60 dark:bg-black/20 p-4 rounded-xl border border-red-200/50 backdrop-blur-sm">
                                        <div className="flex items-center gap-2 mb-2">
                                            <span className="text-lg">⚖️</span>
                                            <p className="text-sm font-black text-red-800 dark:text-red-300">汇率安全垫熔断 (FX Sentinel)</p>
                                        </div>
                                        <p className="text-xs opacity-90 leading-relaxed">
                                            检测到当前系统汇率与市场价偏差超过 2%。为了保护您的资金安全，请稍等汇率自动校准后再试，或联系财务专员。
                                        </p>
                                    </div>
                                )}
                                {isThresholdError && !state.state && (
                                    // ... existing logic for identity scan
                                    <div className="mt-4 bg-white/60 dark:bg-black/20 p-4 rounded-xl border border-red-200/50 backdrop-blur-sm">
                                        <p className="text-xs leading-relaxed">请完成证件扫描核验（Stripe Identity）后方可继续。</p>
                                        <button 
                                            type="button"
                                            onClick={() => setShowKycModal(true)}
                                            className="mt-2 px-4 py-2 bg-red-600 text-white rounded-lg text-xs font-bold"
                                        >
                                            立即核验身份
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                <SubmitButton disabled={!kycForm || (showComplianceWarning && !state)} />
            </form>

            {showKycModal && (
                <KycFormModal 
                    onClose={() => setShowKycModal(false)} 
                    mode={showComplianceWarning || isThresholdError ? 'VERIFY' : 'EDIT'}
                    country={country}
                />
            )}
        </div>
    );
}

function SubmitButton({ disabled }: { disabled: boolean }) {
    const { pending } = useFormStatus();

    return (
        <button
            type="submit"
            disabled={pending || disabled}
            className={`w-full font-bold py-5 rounded-2xl transition-all shadow-xl active:scale-[0.98] flex items-center justify-center gap-3 text-lg ${
                pending || disabled
                    ? 'bg-gray-400 cursor-not-allowed text-white/50' 
                    : 'bg-blue-600 hover:bg-blue-700 text-white hover:shadow-blue-600/20'
            }`}
        >
            {pending ? (
                <>
                    <svg className="animate-spin h-6 w-6 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span>正在加密存证并生成 Gutschrift...</span>
                </>
            ) : (
                <>
                    <span>🚀 立即申请提现</span>
                    <span className="text-sm font-normal opacity-60">| 生成法律 Gutschrift</span>
                </>
            )}
        </button>
    );
}
