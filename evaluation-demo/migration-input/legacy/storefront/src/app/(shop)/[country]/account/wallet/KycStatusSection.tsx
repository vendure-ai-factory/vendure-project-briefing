'use client';

import { useState } from 'react';
import KycFormModal from './KycFormModal';

interface Props {
    isDesigner: boolean;
    isKycVerified: boolean;
    annualSpentEur: number;
}

export default function KycStatusSection({ isDesigner, isKycVerified, annualSpentEur }: Props) {
    const [showModal, setShowModal] = useState(false);

    if (!isDesigner) return null;

    // Thresholds: 250€ single payout or 2000€ annual total
    const isLimitRisk = annualSpentEur >= 195000; // Warning at 1950€

    return (
        <div className="mb-8 p-6 border rounded-2xl bg-white dark:bg-gray-900 shadow-sm border-blue-100 dark:border-blue-900/30">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h3 className="text-lg font-bold flex items-center gap-2 font-noto">
                        {isKycVerified ? '✅ 身份验证状态：已通过' : '⚠️ 身份验证状态：未完成'}
                    </h3>
                    <p className="text-sm opacity-60 mt-1">
                        {isKycVerified 
                            ? '您的资料已哈希留档，符合欧盟 GoBD 税务合规要求。' 
                            : '由于税务合规要求，提现前必须完善您的法定身份信息。'}
                    </p>
                    {isLimitRisk && (
                        <div className="mt-2 inline-flex items-center gap-2 px-3 py-1 rounded-full bg-orange-100 text-orange-700 text-xs font-bold pulse">
                            🚩 年度额度预警: 已接近 2000€ 强验证红线
                        </div>
                    )}
                </div>

                {!isKycVerified && (
                    <button 
                        onClick={() => setShowModal(true)}
                        className="px-6 py-2 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/20 active:scale-95"
                    >
                        立即完善资料 →
                    </button>
                )}
            </div>

            {showModal && <KycFormModal onClose={() => setShowModal(false)} />}
        </div>
    );
}
