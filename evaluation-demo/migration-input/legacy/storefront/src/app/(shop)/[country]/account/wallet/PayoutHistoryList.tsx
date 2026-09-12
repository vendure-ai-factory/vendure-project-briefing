'use client';

import { formatPrice } from '@/lib/format';
import { format } from 'date-fns';

interface Payout {
    id: string;
    createdAt: string;
    amount: number;
    currencyCode: string;
    state: string;
    methodCode: string;
    errorMessage: string | null;
}

export default function PayoutHistoryList({ payouts }: { payouts: Payout[] }) {
    if (!payouts || payouts.length === 0) {
        return (
            <div className="bg-white dark:bg-gray-900 border border-dashed rounded-2xl p-12 text-center text-muted-foreground">
                <p className="text-xl mb-2">📜 暂无提现记录</p>
                <p className="text-xs opacity-60">当您成功发起提现后，详细的审计流水将显示在此处。</p>
            </div>
        );
    }

    const stateMap: Record<string, { label: string, color: string }> = {
        'Created': { label: '待处理', color: 'bg-yellow-100 text-yellow-700' },
        'Pending': { label: '银行处理中', color: 'bg-blue-100 text-blue-700' },
        'Settled': { label: '已到账', color: 'bg-green-100 text-green-700' },
        'Failed': { label: '失败', color: 'bg-red-100 text-red-700' },
        'Cancelled': { label: '已取消', color: 'bg-gray-100 text-gray-700' },
    };

    return (
        <div className="bg-white dark:bg-gray-900 border rounded-2xl overflow-hidden shadow-sm border-gray-100 dark:border-gray-800">
            <div className="bg-gray-50 dark:bg-gray-800 px-6 py-4 border-b dark:border-gray-700 flex justify-between items-center">
                <h2 className="text-lg font-bold flex items-center gap-2">
                    📑 提现历史流水 (Audit Trail)
                </h2>
                <span className="text-[10px] bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full font-bold">符合 GoBD 审计要求</span>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                    <thead className="bg-gray-50/50 dark:bg-gray-800/50 text-xs text-muted-foreground uppercase font-bold">
                        <tr>
                            <th className="px-6 py-4">申请时间</th>
                            <th className="px-6 py-4">金额</th>
                            <th className="px-6 py-4">渠道</th>
                            <th className="px-6 py-4">状态</th>
                            <th className="px-6 py-4 text-right">操作</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y dark:divide-gray-800">
                        {payouts.map((payout) => {
                            const state = stateMap[payout.state] || { label: payout.state, color: 'bg-gray-100 text-gray-600' };
                            return (
                                <tr key={payout.id} className="hover:bg-gray-50/50 dark:hover:bg-gray-800/30 transition-colors">
                                    <td className="px-6 py-4 whitespace-nowrap opacity-70">
                                        {format(new Date(payout.createdAt), 'yyyy-MM-dd HH:mm')}
                                    </td>
                                    <td className="px-6 py-4 font-bold font-noto">
                                        {formatPrice(payout.amount, payout.currencyCode)}
                                    </td>
                                    <td className="px-6 py-4 uppercase text-xs font-mono opacity-60">
                                        {payout.methodCode}
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className="flex flex-col gap-1">
                                            <span className={`w-fit px-2 py-1 rounded-lg text-[10px] font-bold ${state.color}`}>
                                                {state.label}
                                            </span>
                                            {payout.metadata && (payout.metadata as any).wfAccountId && (
                                                <span className="text-[10px] font-mono opacity-50 truncate max-w-[120px]">
                                                    ID: {(payout.metadata as any).wfAccountId}
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className="flex flex-wrap gap-1">
                                            <span className="px-1.5 py-0.5 bg-gray-100 text-[10px] font-black rounded border border-gray-200 uppercase">
                                                GoBD 📑
                                            </span>
                                            {payout.currencyCode === 'HUF' ? (
                                                <span className="px-1.5 py-0.5 bg-blue-50 text-blue-700 text-[10px] font-black rounded border border-blue-100">
                                                    3100 (HU)
                                                </span>
                                            ) : (
                                                <span className="px-1.5 py-0.5 bg-indigo-50 text-indigo-700 text-[10px] font-black rounded border border-indigo-100">
                                                    3100 (EU)
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 text-right">
                                        {payout.state === 'Settled' ? (
                                            <button className="text-blue-600 hover:underline text-xs font-bold">
                                                下载 Gutschrift
                                            </button>
                                        ) : (
                                            <span className="text-gray-300 text-xs cursor-default">不可用</span>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
