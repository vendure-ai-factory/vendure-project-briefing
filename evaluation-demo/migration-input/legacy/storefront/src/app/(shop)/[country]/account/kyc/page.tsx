'use client';

import Link from 'next/link';
import { useState } from 'react';
import { verifyKycAction } from '@/lib/wallet-actions';
import { useRouter } from 'next/navigation';

export default function KYCPage({ params }: { params: { country: string } }) {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);
    const router = useRouter();

    const handleVerify = async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await verifyKycAction(params.country);
            if (res.success) {
                setSuccess(true);
                setTimeout(() => {
                    router.push(`/${params.country}/account/wallet/withdraw`);
                }, 2000);
            } else {
                setError(res.message);
            }
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="container mx-auto px-4 py-16 mt-16 max-w-2xl text-center">
            <div className="mb-8">
                <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-blue-100 text-blue-600 mb-4">
                    <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-7.618 3.04zM12 10a2 2 0 11-4 0 2 2 0 014 0z" />
                    </svg>
                </div>
                <h1 className="text-3xl font-bold mb-4">🛡️ 身份验证 (KYC)</h1>
                <p className="text-muted-foreground leading-relaxed text-sm">
                    为了符合欧盟反洗钱法 (AML) 及税收合规要求，<br/>
                    单笔提现超过 €250 或年度累计超过 €2,000 的用户必须完成身份核验。
                </p>
            </div>

            <div className="bg-white dark:bg-gray-900 border rounded-3xl p-8 shadow-xl mb-8">
                {success ? (
                    <div className="py-12 animate-in zoom-in duration-500">
                        <div className="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-6">
                            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" />
                            </svg>
                        </div>
                        <h2 className="text-2xl font-bold mb-2 text-green-700">验证完成！</h2>
                        <p className="text-muted-foreground italic text-sm">正在为您返回提现页面...</p>
                    </div>
                ) : (
                    <>
                        <div className="space-y-4 text-left">
                            <h2 className="text-lg font-bold mb-2">需提交的信息：</h2>
                            <div className="flex gap-4 p-4 border rounded-xl bg-gray-50/50">
                                <div className="flex-shrink-0 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-bold">1</div>
                                <div>
                                    <p className="text-sm font-bold">证件照片</p>
                                    <p className="text-[10px] text-muted-foreground">护照、身份证或驾照的正反面照片</p>
                                </div>
                            </div>
                            <div className="flex gap-4 p-4 border rounded-xl bg-gray-50/50">
                                <div className="flex-shrink-0 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-bold">2</div>
                                <div>
                                    <p className="text-sm font-bold">人脸识认识别</p>
                                    <p className="text-[10px] text-muted-foreground">通过手机摄像头进行 3D 活体监测</p>
                                </div>
                            </div>
                        </div>

                        {error && (
                            <div className="mt-6 p-4 bg-red-50 text-red-600 rounded-xl text-xs border border-red-100">
                                ❌ {error}
                            </div>
                        )}

                        <div className="mt-8">
                            <button 
                                onClick={handleVerify}
                                disabled={loading}
                                className="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl hover:bg-blue-700 shadow-lg shadow-blue-500/30 transition-all active:scale-95 disabled:bg-gray-400 flex items-center justify-center gap-2"
                            >
                                {loading && (
                                    <svg className="animate-spin h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                    </svg>
                                )}
                                {loading ? '正在连接安全核验系统...' : '立即开始验证 (Stripe Identity 仿真)'}
                            </button>
                            <p className="text-[10px] text-muted-foreground mt-4 text-center">
                                您的数据将经过 AES-256 加密处理，符合欧盟 GDPR 规范。
                            </p>
                        </div>
                    </>
                )}
            </div>

            {!success && (
                <Link href={`/${params?.country || 'de'}/account/wallet`} className="text-sm text-muted-foreground hover:underline">
                    暂时跳过，返回钱包
                </Link>
            )}
        </div>
    );
}
